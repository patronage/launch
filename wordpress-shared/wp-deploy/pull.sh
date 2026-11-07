#!/usr/bin/env bash
# wp-deploy 2.7.0 (patronage/launch: wordpress-shared/wp-deploy/pull.sh)
# Pull a WordPress site's database and uploads down from its host, for local work.
# Sites vendor this file unchanged, next to deploy.sh. Put site settings in _build/deploy.env.
#
# Usage, from anywhere in the repo:
#   bash _build/pull.sh export <target>             dump the server's database over SSH into
#                                                   _data/<time>.sql.gz, skipping PULL_EXCLUDED_TABLES
#   bash _build/pull.sh import [<file>] [--yes]     load the newest dump in _data/ (or <file>) into the
#                                                   local Docker database, after asking
#   bash _build/pull.sh media <target> [--all]      copy wp-content/uploads/ down with rsync, without
#                                                   WordPress's generated thumbnails (--all keeps them)
#   bash _build/pull.sh --version                   print the kit version
#
# Targets: production|prod, staging|stage on DEPLOY_HOST=cloudways, or
#          cloudways-production|cloudways-prod, cloudways-staging|cloudways-stage
#
# Nothing here writes to a server. export and media only read from it; import
# writes only to the local Docker database.
#
# On Cloudways, the SSH user is often the server's master user, which can read
# every application on the server. pull.sh therefore never searches for
# WordPress: the webroot is COMPOSE_CLOUDWAYS_<ENV>_WEBROOT when set, otherwise
# the app's own COMPOSE_CLOUDWAYS_<ENV>_GIT_PATH with private_html replaced by
# public_html. Without either it stops.
#
# Settings are read like deploy.sh's, highest precedence first, from:
#   1. the environment
#   2. .env next to _build/ (gitignored): personal and secret values, e.g. SSH users and server IPs
#   3. _build/deploy.env (committed): the site's non-secret settings
# _build/deploy.env.sample documents every setting.
#
# Docs and changelog: wordpress-shared/wp-deploy/README.md in patronage/launch.

set -euo pipefail

WP_DEPLOY_VERSION="2.7.0"

BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$BUILD_DIR")"
CONFIG_FILE="$BUILD_DIR/deploy.env"

# The SSH preflight looks for this line, wherever it is in the output: OpenSSH
# 10.2 and later can print a post-quantum key exchange warning first.
SSH_OK_MARKER="wp-deploy-ssh-ok"
SSH_OPTIONS=(-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# Names of WordPress's generated image sizes, such as photo-300x200.jpg or
# photo-300x200.jpg.webp. Originals (photo.jpg) and big-image copies
# (photo-scaled.jpg) don't match.
THUMBNAIL_REGEX='-[0-9]+x[0-9]+(@[0-9]x)?\.[A-Za-z0-9]+(\.(webp|avif))?$'

TARGET_NAME=""
SSH_HOST=""
REMOTE_WEBROOT=""
TMP_DIR=""

die() {
  printf 'pull: %b\n' "$*" >&2
  exit 1
}

log() {
  printf '==> %s\n' "$*"
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

# Load KEY=VALUE lines from a file without evaluating them. Values that are
# already set are kept, so load higher-precedence files first.
# The same function as deploy.sh's; the tests check that they match.
load_env_file() {
  local line key value
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | '#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    [ "$key" != "$line" ] || continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -z "${!key+x}" ] || continue
    value="${line#*=}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  done <"$1"
}

load_settings() {
  cd "$PROJECT_DIR"
  load_env_file .env
  load_env_file "$CONFIG_FILE"
  WP_DIR="$PROJECT_DIR"
  if [ -n "${DEPLOY_WORDPRESS_DIR:-}" ]; then
    WP_DIR="$(cd "$PROJECT_DIR/$DEPLOY_WORDPRESS_DIR" 2>/dev/null && pwd)" ||
      die "DEPLOY_WORDPRESS_DIR '$DEPLOY_WORDPRESS_DIR' is not a folder under $PROJECT_DIR"
  fi
  DATA_DIR="$PROJECT_DIR/${PULL_DATA_DIR:-_data}"
}

# A webroot pull.sh can name on the remote command line and in rsync's remote
# path: absolute, with no spaces, glob characters or . and .. segments.
check_webroot() {
  local name="$1" path="$2"
  case "$path" in
    /*) ;;
    *) die "$name must be an absolute path on the server (got '$path')" ;;
  esac
  case "$path" in
    *[[:space:]]* | *[\*\?\[\]]*) die "$name must not contain spaces or glob characters (got '$path')" ;;
  esac
  case "$path/" in
    */./* | */../*) die "$name must not contain . or .. segments (got '$path')" ;;
  esac
}

# The app's webroot, from this target's settings only. The master user can
# read every app on the server, so searching the applications folder for a
# wp-config.php can find another app's WordPress.
cloudways_webroot() {
  local webroot_var="COMPOSE_CLOUDWAYS_${1}_WEBROOT" git_var="COMPOSE_CLOUDWAYS_${1}_GIT_PATH" git_path
  if [ -n "${!webroot_var:-}" ]; then
    REMOTE_WEBROOT="${!webroot_var%/}"
    check_webroot "$webroot_var" "$REMOTE_WEBROOT"
    return 0
  fi
  git_path="${!git_var:-}"
  [ -n "$git_path" ] ||
    die "$git_var is not set. pull.sh finds this app's webroot from its own private_html folder and never searches the server, so set $git_var (or $webroot_var) in .env, as for deploy.sh"
  git_path="${git_path%/}"
  case "$git_path" in
    */private_html) ;;
    *) die "$git_var must end in /private_html (got '$git_path'). Set $webroot_var to name the webroot instead" ;;
  esac
  REMOTE_WEBROOT="${git_path%/private_html}/public_html"
  check_webroot "$git_var" "$REMOTE_WEBROOT"
}

set_cloudways() {
  local env="$1" user="COMPOSE_CLOUDWAYS_${1}_SSH_USER" ip="COMPOSE_CLOUDWAYS_${1}_SERVER_IP" name missing=""
  for name in "$user" "$ip"; do
    [ -n "${!name:-}" ] || missing="$missing $name"
  done
  [ -z "$missing" ] || die "missing settings for $TARGET_NAME:$missing (set them in .env next to _build/, as for deploy.sh)"
  SSH_HOST="${!user}@${!ip}"
  cloudways_webroot "$env"
}

host_target() {
  case "${DEPLOY_HOST:-}" in
    cloudways) set_cloudways "$1" ;;
    '') die "target '$TARGET_NAME' needs DEPLOY_HOST=cloudways in _build/deploy.env, or use cloudways-$TARGET_NAME" ;;
    *) die "pull.sh supports Cloudways only so far; this site's DEPLOY_HOST is '$DEPLOY_HOST'" ;;
  esac
}

resolve_target() {
  TARGET_NAME="$1"
  case "$1" in
    production | prod) host_target PRODUCTION ;;
    staging | stage) host_target STAGING ;;
    cloudways-production | cloudways-prod) set_cloudways PRODUCTION ;;
    cloudways-staging | cloudways-stage) set_cloudways STAGING ;;
    development | dev) die "Cloudways has no development target" ;;
    *) die "unknown target '$1'. Use one of: production, staging (on DEPLOY_HOST), cloudways-production, cloudways-staging" ;;
  esac
}

# ssh with the kit's options. Uses GIT_SSH_COMMAND when set, through the shell
# as git does, so pull.sh and deploy.sh share one SSH setup. A jump host
# belongs in the caller's ssh config (a Host block with ProxyJump).
ssh_run() {
  sh -c "${GIT_SSH_COMMAND:-ssh}"' "$@"' ssh "${SSH_OPTIONS[@]}" "$@"
}

# Check that SSH logs in without a prompt before doing any work, and explain
# the two common failures.
ssh_preflight() {
  local out
  out="$(ssh_run -o BatchMode=yes "$SSH_HOST" echo "$SSH_OK_MARKER" </dev/null 2>&1)" || true
  if printf '%s\n' "$out" | grep -qx "$SSH_OK_MARKER"; then
    return 0
  fi
  case "$out" in
    *"Host key verification failed"* | *"REMOTE HOST IDENTIFICATION HAS CHANGED"*)
      die "the host key for $SSH_HOST is not verified. Run 'ssh $SSH_HOST' once, check the fingerprint with the server's, accept it, then retry.\nssh said: $out" ;;
    *"Permission denied"*)
      die "SSH refused your key for $SSH_HOST: the key is not added for that user, or not loaded (ssh-add). If your ssh config reaches the server through a jump host (ProxyJump), the host named in ssh's output below is the one that refused. Add your public key there, then retry.\nssh said: $out" ;;
    *) die "could not connect to $SSH_HOST over SSH. Check the server IP and SSH user in .env, and your ssh config if the server is reached through a jump host.\nssh said: $out" ;;
  esac
}

# Run a bash script on the server. The script and its arguments travel on
# stdin to `bash -s`, so no remote shell re-parses them. Output passes through.
remote_bash() {
  local script="$1"
  shift
  {
    printf 'set --'
    [ $# -eq 0 ] || printf ' %q' "$@"
    printf '\n%s\n' "$script"
  } | ssh_run "$SSH_HOST" bash -s
}

# Remote check, shared by export and media: $1 is a WordPress webroot.
# shellcheck disable=SC2016
REMOTE_WEBROOT_CHECK='
if ! cd -- "$1" 2>/dev/null; then
  echo "pull: no folder $1 on the server. Check the app'\''s GIT_PATH or WEBROOT setting." >&2
  exit 3
fi
if [ ! -f wp-config.php ]; then
  echo "pull: $1 holds no wp-config.php, so it is not this app'\''s WordPress webroot." >&2
  exit 3
fi'

# shellcheck disable=SC2016
REMOTE_EXPORT="$REMOTE_WEBROOT_CHECK"'
if ! command -v wp >/dev/null; then
  echo "pull: WP-CLI (wp) is not installed on the server." >&2
  exit 3
fi
set -- db export --path="$1" --add-drop-table ${2:+"--exclude_tables=$2"} -
exec wp "$@"'

# shellcheck disable=SC2016
REMOTE_THUMBNAILS="$REMOTE_WEBROOT_CHECK"'
[ -d wp-content/uploads ] || exit 0
cd wp-content/uploads && find . -type f | sed "s|^\./||" | grep -E -- "$2" || true'

# Fail unless git ignores files in $1, a folder under the project folder. A
# database dump or uploads committed to a public repo would publish the site's data.
require_ignored() {
  local rel="${1#"$PROJECT_DIR"/}"
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  git -C "$PROJECT_DIR" check-ignore -q -- "$rel/wp-deploy-pull-probe" ||
    die "$rel/ is not gitignored. Add it to the site's .gitignore first, so what pull.sh writes there can't be committed."
}

excluded_tables() {
  local tables="${PULL_EXCLUDED_TABLES:-${SQL_EXCLUDED_TABLES:-}}"
  tables="${tables// /}"
  [[ "$tables" =~ ^[A-Za-z0-9_$,]*$ ]] || die "PULL_EXCLUDED_TABLES must be a comma-separated list of table names (got '$tables')"
  printf '%s' "$tables"
}

db_export() {
  local tables stamp file partial
  tables="$(excluded_tables)"
  stamp="$(date +%Y-%m-%d-%H-%M-%S)"
  file="$DATA_DIR/$stamp.sql.gz"
  partial="$DATA_DIR/.$stamp.sql.gz.partial"
  require_ignored "$DATA_DIR"
  log "pull.sh $WP_DEPLOY_VERSION: database of $TARGET_NAME, WordPress at $SSH_HOST:$REMOTE_WEBROOT"
  ssh_preflight
  mkdir -p "$DATA_DIR"
  log "Exporting${tables:+ without $tables}"
  if ! remote_bash "$REMOTE_EXPORT" "$REMOTE_WEBROOT" "$tables" | gzip >"$partial"; then
    rm -f "$partial"
    die "the export failed; nothing was saved"
  fi
  # mysqldump and mariadb-dump end a complete dump with this comment.
  if ! gzip -dc "$partial" | tail -n 3 | grep -q '^-- Dump completed'; then
    rm -f "$partial"
    die "the export ended early (no '-- Dump completed' line); nothing was saved"
  fi
  mv "$partial" "$file"
  log "Saved ${file#"$PROJECT_DIR"/} ($(wc -c <"$file" | tr -d ' ') bytes)"
}

# The newest dump in the data folder, by modification time. _data/local.sql
# holds local changes applied after each import, so it is never the dump.
newest_dump() {
  local f newest=""
  for f in "$DATA_DIR"/*.sql.gz "$DATA_DIR"/*.sql; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" != local.sql ] || continue
    if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
  done
  printf '%s' "$newest"
}

# Import writes only to a database on this machine. A Docker context or
# DOCKER_HOST that points elsewhere could be a shared or remote server.
require_local_docker() {
  local host
  command -v docker >/dev/null || die "docker is not installed; import loads the dump into the site's local Docker database"
  host="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
  case "$host" in
    '' | unix://* | npipe://*) ;;
    *) die "Docker points at $host, not this machine. import writes only to a local database; unset DOCKER_HOST or switch the Docker context." ;;
  esac
}

db_import() {
  local file="$1" yes="$2" compose_dir service db_name db_user answer
  if [ -z "$file" ]; then
    file="$(newest_dump)"
    [ -n "$file" ] || die "no dump in ${DATA_DIR#"$PROJECT_DIR"/}/. Run 'bash _build/pull.sh export <target>' first."
  fi
  [ -f "$file" ] || die "no file $file"
  case "$file" in
    *.sql.gz | *.sql) ;;
    *) die "$file is not a .sql or .sql.gz dump" ;;
  esac
  compose_dir="$(cd "$PROJECT_DIR/${PULL_COMPOSE_DIR:-.}" 2>/dev/null && pwd)" ||
    die "PULL_COMPOSE_DIR '${PULL_COMPOSE_DIR:-}' is not a folder under $PROJECT_DIR"
  service="${PULL_DB_SERVICE:-db}"
  db_name="${PULL_DB_NAME:-wordpress}"
  db_user="${PULL_DB_USER:-wordpress}"
  require_local_docker
  (cd "$compose_dir" && docker compose ps --status running --services 2>/dev/null) | grep -qx "$service" ||
    die "the '$service' service in $compose_dir is not running. Start the site's Docker containers, then retry."

  log "Import $file"
  log "into database '$db_name' of the local Docker Compose service '$service' in $compose_dir"
  log "It replaces every table the dump holds."
  if [ "$yes" != true ]; then
    [ -t 0 ] || die "import asks before it replaces the local database. Run it in a terminal, or pass --yes."
    read -r -p "Continue? [y/N] " answer
    case "$answer" in
      y | Y | yes | YES) ;;
      *) die "import cancelled; nothing was changed" ;;
    esac
  fi

  import_sql "$compose_dir" "$service" "$db_name" "$db_user" "$file"
  if [ -f "$DATA_DIR/local.sql" ]; then
    log "Applying ${DATA_DIR#"$PROJECT_DIR"/}/local.sql"
    import_sql "$compose_dir" "$service" "$db_name" "$db_user" "$DATA_DIR/local.sql"
  fi
  if [ -n "${PULL_IMPORT_TASK:-}" ]; then
    log "After import: $PULL_IMPORT_TASK"
    (cd "$PROJECT_DIR" && bash -c "$PULL_IMPORT_TASK") || die "PULL_IMPORT_TASK failed; the dump itself was imported"
  fi
  log "Import complete"
}

# Pipe a dump into the database container's own client (mariadb, else mysql).
# The password travels in MYSQL_PWD, not on the client's command line.
import_sql() {
  local compose_dir="$1" service="$2" db_name="$3" db_user="$4" file="$5"
  # shellcheck disable=SC2016
  local client='if command -v mariadb >/dev/null; then exec mariadb "$@"; fi; exec mysql "$@"'
  case "$file" in
    *.gz) gzip -dc "$file" ;;
    *) cat "$file" ;;
  esac | (cd "$compose_dir" && docker compose exec -T -e MYSQL_PWD="${PULL_DB_PASSWORD:-wordpress}" "$service" \
    sh -c "$client" sh "--user=$db_user" "$db_name") || die "importing $file failed"
}

# rsync exclude patterns for exact paths: anchored, with glob characters escaped.
exact_patterns() {
  sed -e 's/[][\\*?]/\\&/g' -e 's|^|/|'
}

media_pull() {
  local all="$1" uploads dest exclude rsync_ssh count
  uploads="${PULL_UPLOADS_DIR:-wp-content/uploads}"
  dest="$WP_DIR/${uploads%/}"
  require_ignored "$dest"
  command -v rsync >/dev/null || die "rsync is not installed"
  log "pull.sh $WP_DEPLOY_VERSION: uploads of $TARGET_NAME, from $SSH_HOST:$REMOTE_WEBROOT/wp-content/uploads/"
  ssh_preflight
  mkdir -p "$dest"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wp-pull.XXXXXX")"
  trap cleanup EXIT
  exclude="$TMP_DIR/exclude"
  : >"$exclude"
  if [ "$all" != true ]; then
    remote_bash "$REMOTE_THUMBNAILS" "$REMOTE_WEBROOT" "$THUMBNAIL_REGEX" | exact_patterns >"$exclude" ||
      die "listing the server's thumbnails failed"
    count="$(wc -l <"$exclude" | tr -d ' ')"
    log "Skipping $count generated thumbnails (--all copies them too)"
  fi
  rsync_ssh="${GIT_SSH_COMMAND:-ssh} ${SSH_OPTIONS[*]}"
  rsync -rltvz --exclude-from="$exclude" -e "$rsync_ssh" \
    "$SSH_HOST:$REMOTE_WEBROOT/wp-content/uploads/" "$dest/" || die "rsync failed"
  # On Linux, a bind-mounted uploads folder keeps the host user's ownership, and
  # WordPress in Docker runs as another user, so it couldn't add files (new
  # uploads, edited images) to the folders rsync created. Docker Desktop maps it.
  if [ "$(uname -s)" = Linux ]; then
    find "$dest" -type d -exec chmod a+rwx {} + || log "Note: could not make the uploads folders writable"
  fi
  log "Uploads copied to ${dest#"$PROJECT_DIR"/}/"
}

usage() {
  echo "wp-deploy $WP_DEPLOY_VERSION (pull.sh)"
  sed -n '/^# Usage/,/^# Nothing here/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 1
}

main() {
  local command="${1:-}" target="" file="" yes=false all=false
  case "$command" in
    --version)
      echo "wp-deploy $WP_DEPLOY_VERSION"
      return 0
      ;;
    export | media)
      [ $# -ge 2 ] || die "$command needs a target, e.g. 'bash _build/pull.sh $command production'"
      target="$2"
      shift 2
      ;;
    import) shift ;;
    '' | -h | --help) usage ;;
    *) die "unknown command '$command'. Use export, import or media (see --help)" ;;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) [ "$command" = import ] || die "--yes only applies to import"; yes=true ;;
      --all) [ "$command" = media ] || die "--all only applies to media"; all=true ;;
      -*) die "unknown option '$1'" ;;
      *)
        [ "$command" = import ] && [ -z "$file" ] || die "unexpected argument '$1'"
        file="$1"
        ;;
    esac
    shift
  done
  # A relative file is relative to where the command was run.
  if [ -n "$file" ] && [ "${file#/}" = "$file" ]; then file="$PWD/$file"; fi

  load_settings
  case "$command" in
    export)
      resolve_target "$target"
      db_export
      ;;
    media)
      resolve_target "$target"
      media_pull "$all"
      ;;
    import) db_import "$file" "$yes" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
