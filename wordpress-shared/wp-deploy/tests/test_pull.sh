#!/usr/bin/env bash
# Local tests for _build/pull.sh. Stubbed ssh, rsync, wp and docker only;
# nothing touches a real server or database.
#   bash _build/tests/test_pull.sh
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The real path: macOS's TMPDIR is a symlinked /var/folders, and subprocesses report /private/var.
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pull-test.XXXXXX")" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 HOME="$WORK"
unset GIT_SSH_COMMAND GIT_SSH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE DOCKER_HOST
git config --global init.defaultBranch main

failures=0
passes=0
pass() {
  echo "ok - $1"
  passes=$((passes + 1))
}
fail() {
  echo "not ok - $1"
  failures=$((failures + 1))
}
check() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

# --- Fakes -------------------------------------------------------------------
# A fake Cloudways server: two apps under one master user. The fake ssh runs
# remote scripts locally, with the server's paths under $SERVER.
SERVER="$WORK/server"
APPS="$SERVER/home/master/applications"
for app in aaa-other bbb-site; do
  mkdir -p "$APPS/$app/public_html/wp-content/uploads/2026/01" "$APPS/$app/private_html"
  printf '<?php // %s\n' "$app" >"$APPS/$app/public_html/wp-config.php"
done
UPLOADS="$APPS/bbb-site/public_html/wp-content/uploads"
for f in photo.jpg photo-300x200.jpg photo-1024x683.jpg photo-150x150.jpg.webp photo-scaled.jpg \
  logo@2x.png report-2026.pdf; do
  printf '%s\n' "$f" >"$UPLOADS/2026/01/$f"
done

BIN="$WORK/bin"
SERVER_BIN="$WORK/server-bin"
mkdir -p "$BIN" "$SERVER_BIN"
export SSH_LOG="$WORK/ssh.log" RSYNC_LOG="$WORK/rsync.log" DOCKER_LOG="$WORK/docker.log"
export FAKE_SERVER_BIN="$SERVER_BIN" FAKE_SSH_MODE=ok

# ssh: skips options, logs the host and command, answers the preflight per
# FAKE_SSH_MODE (with OpenSSH 10.2's post-quantum warning first), and runs
# `bash -s` locally with the server's tools on PATH.
cat >"$BIN/ssh" <<'SSH'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -o | -p | -i | -F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host="$1"
shift
printf '%s|%s\n' "$host" "$*" >>"$SSH_LOG"
if [ "${1:-}" = echo ]; then
  echo "** WARNING: connection is not using a post-quantum key exchange algorithm." >&2
  case "$FAKE_SSH_MODE" in
    ok) echo "$2" ;;
    denied) echo "$host: Permission denied (publickey)." >&2; exit 255 ;;
    hostkey) echo "Host key verification failed." >&2; exit 255 ;;
    down) echo "ssh: connect to host port 22: Connection refused" >&2; exit 255 ;;
  esac
  exit 0
fi
[ "$*" = "bash -s" ] || { echo "fake ssh: unexpected command $*" >&2; exit 2; }
PATH="$FAKE_SERVER_BIN:$PATH" exec bash -s
SSH

# WP-CLI on the server: a dump that names the folder it ran in and its arguments.
cat >"$SERVER_BIN/wp" <<'WP'
#!/usr/bin/env bash
printf 'wp %s\n' "$*" >>"$SSH_LOG"
[ "${FAKE_WP_MODE:-ok}" != fail ] || { echo "Error: database connection failed" >&2; exit 1; }
printf -- '-- dump from %s\n' "$(pwd)"
printf -- '-- args: %s\n' "$*"
printf 'CREATE TABLE wp_options (x int);\n'
[ "${FAKE_WP_MODE:-ok}" = truncated ] || printf -- '-- Dump completed on 2026-11-07 12:00:00\n'
WP
# The server's paths live under $SERVER, so the fake maps them: cd and --path
# arguments are rewritten by a wrapper around the remote script (see fake ssh).
cat >"$BIN/rsync" <<'RSYNC'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$RSYNC_LOG"
exclude=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude-from=*) exclude="${1#*=}" ;;
    -e) shift ;;
    -*) ;;
    *) args+=("$1") ;;
  esac
  shift
done
src="${args[0]#*:}"
dest="${args[1]}"
src="$FAKE_ROOT$src"
(cd "$src" && find . -type f | sed 's|^\./||') | while IFS= read -r rel; do
  if [ -n "$exclude" ] && grep -qxF "/$rel" "$exclude"; then continue; fi
  mkdir -p "$dest/$(dirname "$rel")"
  cp "$src/$rel" "$dest/$rel"
done
RSYNC

# docker: context inspect, compose ps and compose exec into the db service.
cat >"$BIN/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "context inspect") echo "${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}" ;;
  "compose ps") [ "${FAKE_DB_DOWN:-}" = 1 ] || echo db ;;
  "compose exec")
    cat >>"$FAKE_IMPORTED"
    ;;
esac
DOCKER
chmod +x "$BIN"/* "$SERVER_BIN"/*
export FAKE_IMPORTED="$WORK/imported.sql" FAKE_ROOT="$SERVER"

# The fake server's absolute paths are $SERVER/home/...; the site's settings use
# /home/... as on Cloudways. A real-path wrapper for ssh adds $SERVER in front.
mv "$BIN/ssh" "$BIN/ssh-inner"
cat >"$BIN/ssh" <<'SSH'
#!/usr/bin/env bash
# Prefix remote paths with the fake server root before running the script.
if [ "${*: -2}" = "bash -s" ]; then
  script="$(cat)"
  script="${script//\/home\/master\//$FAKE_ROOT/home/master/}"
  printf '%s\n' "$script" | "$(dirname "$0")/ssh-inner" "$@"
else
  exec "$(dirname "$0")/ssh-inner" "$@"
fi
SSH
chmod +x "$BIN/ssh"
export PATH="$BIN:$PATH"

# A site: WordPress at the repo root, the kit in _build/ (pull.sh symlinked).
SITE="$WORK/site"
mkdir -p "$SITE/_build"
ln -s "$KIT_DIR/pull.sh" "$SITE/_build/pull.sh"
cp "$KIT_DIR/deploy.sh" "$SITE/_build/deploy.sh"
printf 'DEPLOY_HOST=cloudways\n' >"$SITE/_build/deploy.env"
cat >"$SITE/.env" <<'ENV'
COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER=master_user
COMPOSE_CLOUDWAYS_PRODUCTION_SERVER_IP=192.0.2.10
COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH=/home/master/applications/bbb-site/private_html
ENV
printf '.env\n_data/\nwp-content/uploads/\n' >"$SITE/.gitignore"
git -C "$SITE" init -q
git -C "$SITE" add -A
git -C "$SITE" commit -qm site

pull() { (cd "$SITE" && bash _build/pull.sh "$@"); }

# --- Unit checks ---------------------------------------------------------------
version_line="$(sed -n 2p "$KIT_DIR/pull.sh")"
deploy_version="$(bash "$KIT_DIR/deploy.sh" --version)"
check "header line carries the kit version" grep -q "^# ${deploy_version} (patronage/launch: wordpress-shared/wp-deploy/pull.sh)$" <<<"$version_line"
check "--version matches deploy.sh's" [ "$(bash "$KIT_DIR/pull.sh" --version)" = "$deploy_version" ]
out="$(bash "$KIT_DIR/pull.sh" --help 2>&1 || true)"
check "--help prints usage and targets" bash -c 'grep -q "^Usage" <<<"$1" && grep -q "^Targets:" <<<"$1"' _ "$out"

fn_of() { sed -n "/^$1() {/,/^}/p" "$2"; }
check "load_env_file is the same as deploy.sh's" [ "$(fn_of load_env_file "$KIT_DIR/pull.sh")" = "$(fn_of load_env_file "$KIT_DIR/deploy.sh")" ]

# Never search across apps: the master user sees every app on the server.
check "pull.sh has no glob over Cloudways applications" bash -c '! grep -nE "applications/\*|\*/public_html" "$1"' _ "$KIT_DIR/pull.sh"

# Every setting pull.sh reads is documented in deploy.env.sample.
missing=""
for name in $(grep -oE '[A-Z_]*(PULL|DEPLOY|COMPOSE|SQL)_[A-Z_]*(\$\{1\})?[A-Z_]*' "$KIT_DIR/pull.sh" | sed 's/\${1}/PRODUCTION/' |
  grep -E '^(PULL|DEPLOY|COMPOSE|SQL)_' | grep -v '_$' | sort -u); do
  grep -Eq "^#? ?$name=" "$KIT_DIR/deploy.env.sample" || missing="$missing $name"
done
check "deploy.env.sample documents every pull.sh setting${missing:+ (missing:$missing)}" [ -z "$missing" ]

# shellcheck source=../pull.sh
source "$KIT_DIR/pull.sh"
set +e
webroot_of() {
  (
    unset COMPOSE_CLOUDWAYS_PRODUCTION_WEBROOT COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH
    [ -z "$1" ] || export COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH="$1"
    [ -z "${2:-}" ] || export COMPOSE_CLOUDWAYS_PRODUCTION_WEBROOT="$2"
    cloudways_webroot PRODUCTION && printf '%s' "$REMOTE_WEBROOT"
  ) 2>&1
}
check "webroot comes from GIT_PATH" [ "$(webroot_of /home/master/applications/app1/private_html)" = /home/master/applications/app1/public_html ]
check "webroot comes from GIT_PATH with a trailing slash" [ "$(webroot_of /home/master/applications/app1/private_html/)" = /home/master/applications/app1/public_html ]
check "webroot comes from the cloudwaysapps.com form of GIT_PATH" [ "$(webroot_of /home/100001.cloudwaysapps.com/app1/private_html)" = /home/100001.cloudwaysapps.com/app1/public_html ]
check "WEBROOT wins over GIT_PATH" [ "$(webroot_of /home/master/applications/app1/private_html /srv/www/site/)" = /srv/www/site ]
got="$(webroot_of "")"
check "a missing GIT_PATH aborts" bash -c 'grep -q "COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH is not set" <<<"$1" && ! grep -q "^/" <<<"$1"' _ "$got"
got="$(webroot_of /home/master/applications/app1)"
check "a GIT_PATH not ending in private_html aborts" grep -q "must end in /private_html" <<<"$got"
got="$(webroot_of "/home/master/applications/*/private_html")"
check "a glob in GIT_PATH aborts" grep -q "glob characters" <<<"$got"
got="$(webroot_of "/home/master/applications/../x/private_html")"
check "a .. segment in GIT_PATH aborts" grep -q "segments" <<<"$got"
got="$(webroot_of "relative/private_html")"
check "a relative GIT_PATH aborts" grep -q "absolute path" <<<"$got"

got="$(printf '%s\n' 'a/b.jpg' 'odd[1]*?.jpg' | exact_patterns | tr '\n' '|')"
check "exclude patterns are anchored and escaped" [ "$got" = '/a/b.jpg|/odd\[1\]\*\?.jpg|' ]
thumbs="$(printf '%s\n' photo.jpg photo-300x200.jpg photo-150x150.jpg.webp logo@2x.png icon-32x32@2x.png photo-scaled.jpg report-2026.pdf | grep -E -- "$THUMBNAIL_REGEX" | tr '\n' '|')"
check "the thumbnail pattern matches generated sizes only" [ "$thumbs" = 'photo-300x200.jpg|photo-150x150.jpg.webp|icon-32x32@2x.png|' ]

# --- export ----------------------------------------------------------------------
: >"$SSH_LOG"
out="$(pull export production 2>&1)"
status=$?
dump="$(ls "$SITE/_data/"*.sql.gz 2>/dev/null | head -1)"
check "export exits 0 and saves _data/<timestamp>.sql.gz" bash -c '[ "$1" = 0 ] && [[ "$(basename "$2")" =~ ^[0-9]{4}(-[0-9]{2}){5}\.sql\.gz$ ]]' _ "$status" "$dump"
check "export dumps the app named by GIT_PATH, not the first app on the server" \
  bash -c 'gzip -dc "$1" | grep -qx -- "-- dump from $2"' _ "$dump" "$APPS/bbb-site/public_html"
check "export passes the webroot to WP-CLI as --path" grep -q "^wp db export --path=$APPS/bbb-site/public_html --add-drop-table -$" "$SSH_LOG"
check "export connects as the configured user and IP" grep -q '^master_user@192.0.2.10|echo wp-deploy-ssh-ok$' "$SSH_LOG"
check "export survives the post-quantum warning" grep -q 'Saved _data/' <<<"$out"
check "export leaves no partial file" bash -c '! ls -A "$1" | grep -q partial' _ "$SITE/_data"

rm -rf "$SITE/_data"
: >"$SSH_LOG"
out="$(PULL_EXCLUDED_TABLES="wp_actionscheduler_logs, wp_wfhits" pull export production 2>&1)"
check "export passes the excluded tables" grep -q -- "--exclude_tables=wp_actionscheduler_logs,wp_wfhits -$" "$SSH_LOG"
: >"$SSH_LOG"
out="$(SQL_EXCLUDED_TABLES=wp_old_logs pull export production 2>&1)"
check "export reads the older SQL_EXCLUDED_TABLES name" grep -q -- "--exclude_tables=wp_old_logs -$" "$SSH_LOG"
out="$(PULL_EXCLUDED_TABLES='wp_x;rm' pull export production 2>&1)"
check "export refuses a table list that isn't names" grep -q "comma-separated list" <<<"$out"

rm -rf "$SITE/_data"
out="$(FAKE_WP_MODE=truncated pull export production 2>&1)"
check "a dump without its last line is refused and removed" bash -c 'grep -q "ended early" <<<"$1" && [ -z "$(ls -A "$2")" ]' _ "$out" "$SITE/_data"
out="$(FAKE_WP_MODE=fail pull export production 2>&1)"
check "a failed export saves nothing" bash -c 'grep -q "export failed" <<<"$1" && [ -z "$(ls -A "$2")" ]' _ "$out" "$SITE/_data"

: >"$SSH_LOG"
out="$(COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH= pull export production 2>&1)"
check "export without GIT_PATH stops before connecting" bash -c 'grep -q "GIT_PATH is not set" <<<"$1" && [ ! -s "$2" ]' _ "$out" "$SSH_LOG"
out="$(COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH=/home/master/applications/missing/private_html pull export production 2>&1)"
check "export stops when the webroot isn't on the server" grep -q "no folder .*missing/public_html" <<<"$out"
rm "$APPS/aaa-other/public_html/wp-config.php"
out="$(COMPOSE_CLOUDWAYS_PRODUCTION_WEBROOT=/home/master/applications/aaa-other/public_html pull export production 2>&1)"
check "export stops when the webroot holds no wp-config.php" grep -q "holds no wp-config.php" <<<"$out"

out="$(FAKE_SSH_MODE=denied pull export production 2>&1)"
check "a refused key says the key is not added" grep -q "SSH refused your key for master_user@192.0.2.10" <<<"$out"
out="$(FAKE_SSH_MODE=hostkey pull export production 2>&1)"
check "an unknown host key says to verify it" grep -q "host key for master_user@192.0.2.10 is not verified" <<<"$out"
rm -rf "$SITE/_data"
out="$(FAKE_SSH_MODE=down pull export production 2>&1)"
check "a failed SSH check leaves no data folder" [ ! -e "$SITE/_data" ]
check "other SSH failures print ssh's output" grep -q "Connection refused" <<<"$out"

out="$(pull export development 2>&1)"
check "there is no development target" grep -q "no development target" <<<"$out"
out="$(DEPLOY_HOST=wpengine pull export production 2>&1)"
check "other hosts are refused" grep -q "Cloudways only" <<<"$out"
out="$(COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER= pull export production 2>&1)"
check "a missing SSH user is named" grep -q "missing settings for production: COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER" <<<"$out"

sed -i.bak '/^_data/d' "$SITE/.gitignore" && rm -f "$SITE/.gitignore.bak"
out="$(pull export production 2>&1)"
check "export refuses a data folder git doesn't ignore" grep -q "_data/.* is not gitignored" <<<"$out"
printf '_data/\n' >>"$SITE/.gitignore"

# --- import ----------------------------------------------------------------------
rm -rf "$SITE/_data"
mkdir -p "$SITE/_data"
printf -- '-- old\n' | gzip >"$SITE/_data/2026-01-01-00-00-00.sql.gz"
touch -t 202601010000 "$SITE/_data/2026-01-01-00-00-00.sql.gz"
printf -- '-- new\n' | gzip >"$SITE/_data/2026-02-01-00-00-00.sql.gz"
printf -- '-- local changes\n' >"$SITE/_data/local.sql"
touch -t 203001010000 "$SITE/_data/local.sql"

out="$(pull import </dev/null 2>&1)"
check "import without a terminal or --yes asks for --yes and changes nothing" bash -c 'grep -q "pass --yes" <<<"$1" && [ ! -e "$2" ]' _ "$out" "$FAKE_IMPORTED"
out="$(printf 'n\n' | script -qec "cd '$SITE' && bash _build/pull.sh import" /dev/null 2>&1 || true)"
if command -v script >/dev/null && grep -q "Continue?" <<<"$out"; then
  check "answering no cancels the import" bash -c 'grep -q "cancelled" <<<"$1" && [ ! -e "$2" ]' _ "$out" "$FAKE_IMPORTED"
fi

: >"$DOCKER_LOG"
out="$(pull import --yes 2>&1)"
check "import names the dump, database and service first" bash -c 'grep -q "Import .*2026-02-01-00-00-00.sql.gz" <<<"$1" && grep -q "database '"'"'wordpress'"'"' of the local Docker Compose service '"'"'db'"'"'" <<<"$1"' _ "$out"
check "import loads the newest dump, then local.sql" [ "$(cat "$FAKE_IMPORTED")" = "$(printf -- '-- new\n-- local changes')" ]
check "import runs the db service's client with the database name" grep -q "^compose exec -T -e MYSQL_PWD=wordpress db sh -c .* sh --user=wordpress wordpress$" "$DOCKER_LOG"
check "the password is not a client argument" bash -c '! grep "exec" "$1" | grep -q -- "-pwordpress"' _ "$DOCKER_LOG"

rm -f "$FAKE_IMPORTED"
out="$(cd "$SITE/_data" && bash ../_build/pull.sh import 2026-01-01-00-00-00.sql.gz --yes 2>&1)"
check "import takes a file, relative to where it runs" grep -q -- "-- old" "$FAKE_IMPORTED"

rm -f "$FAKE_IMPORTED"
out="$(PULL_DB_SERVICE=mariadb PULL_DB_NAME=site PULL_DB_USER=root PULL_DB_PASSWORD=secret FAKE_DB_DOWN=1 pull import --yes 2>&1)"
check "import stops when the database service isn't running" bash -c 'grep -q "'"'"'mariadb'"'"' service .* is not running" <<<"$1" && [ ! -e "$2" ]' _ "$out" "$FAKE_IMPORTED"
out="$(FAKE_DOCKER_ENDPOINT=tcp://db.example.com:2376 pull import --yes 2>&1)"
check "import refuses a Docker context on another machine" bash -c 'grep -q "not this machine" <<<"$1" && [ ! -e "$2" ]' _ "$out" "$FAKE_IMPORTED"
out="$(DOCKER_HOST=ssh://someone@example.com pull import --yes 2>&1)"
check "import refuses a remote DOCKER_HOST" grep -q "not this machine" <<<"$out"

out="$(PULL_IMPORT_TASK='echo task-ran-in-$PWD' pull import --yes 2>&1)"
check "import runs PULL_IMPORT_TASK from the project folder" grep -q "task-ran-in-$SITE" <<<"$out"
out="$(PULL_IMPORT_TASK='exit 3' pull import --yes 2>&1)"
check "a failed PULL_IMPORT_TASK fails the import" grep -q "PULL_IMPORT_TASK failed" <<<"$out"

rm -rf "$SITE/_data"
out="$(pull import --yes 2>&1)"
check "import without a dump says to export first" grep -q "no dump in _data/" <<<"$out"

# --- media -----------------------------------------------------------------------
: >"$RSYNC_LOG"
out="$(pull media production 2>&1)"
got="$(cd "$SITE/wp-content/uploads" && find . -type f | sort | tr '\n' ' ')"
check "media copies originals and skips generated thumbnails" \
  [ "$got" = "./2026/01/logo@2x.png ./2026/01/photo-scaled.jpg ./2026/01/photo.jpg ./2026/01/report-2026.pdf " ]
check "media reads from the app's own webroot" grep -q "master_user@192.0.2.10:/home/master/applications/bbb-site/public_html/wp-content/uploads/ $SITE/wp-content/uploads/$" "$RSYNC_LOG"
check "media never deletes local files" bash -c '! grep -q -- "--delete" "$1"' _ "$RSYNC_LOG"
if [ "$(uname -s)" = Linux ]; then
  check "media leaves the folders writable for WordPress in Docker" [ "$(stat -c %a "$SITE/wp-content/uploads/2026/01")" = 777 ]
fi

rm -rf "$SITE/wp-content/uploads"
out="$(pull media production --all 2>&1)"
got="$(cd "$SITE/wp-content/uploads" && find . -type f | wc -l | tr -d ' ')"
check "media --all copies thumbnails too" [ "$got" = 7 ]

out="$(COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH= pull media production 2>&1)"
check "media without GIT_PATH aborts" grep -q "GIT_PATH is not set" <<<"$out"
out="$(PULL_UPLOADS_DIR=uploads-copy pull media production 2>&1)"
check "media refuses an uploads folder git doesn't ignore" grep -q "uploads-copy/ is not gitignored" <<<"$out"

out="$(pull media 2>&1)"
check "media needs a target" grep -q "needs a target" <<<"$out"
out="$(pull export production --yes 2>&1)"
check "--yes only applies to import" grep -q "only applies to import" <<<"$out"

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
