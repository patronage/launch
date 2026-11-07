#!/usr/bin/env bash
# wp-deploy 2.6.1 (patronage/launch: wordpress-shared/wp-deploy/deploy.sh)
# Deploy WordPress by pushing a packaged commit to the host's Git remote.
# Sites vendor this file unchanged. Put site settings in _build/deploy.env.
#
# Usage, from anywhere in the repo:
#   bash _build/deploy.sh <target>                    package HEAD and deploy it
#   bash _build/deploy.sh <target> --dry-run          package HEAD and show the payload; pushes nothing,
#                                                     and no SSH or Git remote settings needed. On WP Engine
#                                                     with the settings, it reads the server's commit to list
#                                                     the files the deploy would remove
#   bash _build/deploy.sh verify <target> [--from <ref>]  after a deploy that pushed but whose checks
#                                                     failed or were cut off: check the server's deploy commit
#                                                     against <ref>, the server's commit before it (default:
#                                                     its parent), and on WP Engine remove the files it
#                                                     deleted. Pushes nothing
#   bash _build/deploy.sh audit <target> [--verbose]  read-only server audit over SSH
#   bash _build/deploy.sh prune <target> [--verbose]  list files deleted from the repo that are
#                                                     still on the server and safe to remove; no changes
#   bash _build/deploy.sh prune <target> --delete     back them up to a local tarball, remove them,
#                                                     then run the audit
#   bash _build/deploy.sh install-hook <cloudways-target>  install the post-receive hook and its settings
#   bash _build/deploy.sh plugins                     list committed plugins composer doesn't manage
#                                                     and composer.json drift from composer.lock; no network
#   bash _build/deploy.sh --version                   print the script version
#
# Targets: production|prod, staging|stage, development|dev on the site's DEPLOY_HOST,
#          or a host-prefixed name: wpe-production|wpe-prod, wpe-staging|wpe-stage,
#          wpe-development|wpe-dev, kinsta-production|kinsta-prod, kinsta-staging|kinsta-stage,
#          cloudways-production|cloudways-prod, cloudways-staging|cloudways-stage
#
# The deploy commit is built from HEAD in a temporary index. It never has a
# source commit as parent, so the host receives the current files and none of
# the repo's history; it builds on the server's previous deploy commit when that
# history holds only deploy commits. The script never changes the working tree,
# branches, remotes, or stash.
#
# Settings are read, highest precedence first, from:
#   1. the environment
#   2. .env next to _build/ (gitignored on most sites): personal and secret values, e.g. SSH users
#   3. _build/deploy.env (committed): the site's non-secret settings
# _build/deploy.env.sample documents every setting.
#
# Layout: the WordPress folder is DEPLOY_WORDPRESS_DIR (default: the folder above
# _build/). When it is a subfolder of the Git repo, WP Engine and Kinsta receive
# a commit holding only that folder, and the Cloudways hook extracts only that
# folder. When it is the repo root, the whole packaged tree is pushed.
#
# Hosts: Cloudways installs pushes with the repo's post-receive hook, which
# reads deploy-hook.env (both written by install-hook). Kinsta installs them with
# its own `git checkout -f` hook. WP Engine installs them itself but leaves files a
# deploy deletes, so this script removes them, but only when the server's previous
# commit is a deploy commit from this script. After every push the script
# checks the changed files in the webroot over SSH.
#
# Docs and changelog: wordpress-shared/wp-deploy/README.md in patronage/launch.

set -euo pipefail

WP_DEPLOY_VERSION="2.6.1"

BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$BUILD_DIR")"
WP_DIR="$PROJECT_DIR"
BUILD_RUN_DIR="$PROJECT_DIR"
CONFIG_FILE="$BUILD_DIR/deploy.env"
HOOK_FILE="$BUILD_DIR/cloudways-hook-post-receive.sh"
HOOK_CONFIG_NAME="deploy-hook.env"
KINSTA_HOOK_FILE="$BUILD_DIR/kinsta-hook-post-receive.sh"

# Defaults; apply_settings replaces them with configured values.
REMOTE_BRANCH_NAME="master"
INCLUDE_FILE="$BUILD_DIR/.deploy_include.txt"
EXCLUDE_FILE="$BUILD_DIR/.deploy_exclude.txt"

# --- Host-managed paths ------------------------------------------------------
# Every list of host-provided files lives in this block. Paths are relative to
# the WordPress folder. host_managed_regex adds a host's list to
# SERVER_MANAGED_REGEX for its targets, unless DEPLOY_SERVER_MANAGED_REGEX is set.

# Paths that must never be in a deploy payload.
FORBIDDEN_PAYLOAD_REGEX='(^|/)\.env(\.[^/]*)?$|(^|/)wp-config\.php$|^wp-content/uploads/'
# Its .env part, .env and .env.<anything> in any folder. The audit warns when
# the webroot has a file matching it.
ENV_FILE_REGEX='(^|/)\.env(\.[^/]*)?$'
# Example files that hold no values, such as a plugin's .env.example, which
# the payload check and the audit allow. The Cloudways hook has the same list.
ENV_TEMPLATE_REGEX='(^|/)\.env\.(example|sample|dist|template)$'

# True when $1 must never be in a payload. An example .env file is exempt from
# the .env rule only: it is checked again under a neutral name in its folder,
# so the uploads rule and any custom rule on its folder still apply.
forbidden_payload_path() {
  local path="$1"
  [[ "$path" =~ $FORBIDDEN_PAYLOAD_REGEX ]] || return 1
  [[ "$path" =~ $ENV_TEMPLATE_REGEX ]] || return 0
  case "$path" in
    */*) path="${path%/*}/env-template" ;;
    *) path="env-template" ;;
  esac
  [[ "$path" =~ $FORBIDDEN_PAYLOAD_REGEX ]]
}

# Paths the server manages itself, on every host. Deploys never delete them, and
# seeing them on the server is expected. install-hook writes this text into the
# Cloudways server's deploy-hook.env, so changing it means reinstalling the hook.
SERVER_MANAGED_REGEX='^(wp-config\.php|\.htaccess|\.user\.ini|php\.ini|wp-salt\.php|wp-content/(object-cache|advanced-cache)\.php)$|^wp-content/(uploads|cache|upgrade|breeze-config)/'

# Kinsta: its mu-plugin loader file and folder.
KINSTA_MANAGED_REGEX='^wp-content/mu-plugins/kinsta-mu-plugins(\.php)?(/|$)'

# WP Engine mu-plugins, one name per line: a file (name.php), a folder, or both.
# slt-force-strong-passwords.php loads the force-strong-passwords/ folder.
WPE_MANAGED_MU_PLUGINS='
mu-plugin.php
slt-force-strong-passwords.php
force-strong-passwords
wpengine-common
wpengine-security-auditor.php
wpe-update-source-selector
wpe-cache-plugin
wpe-wp-sign-on-plugin
'
# WP Engine's other platform files: its private folder and database snapshot.
WPE_MANAGED_PATHS_REGEX='^_wpeprivate/|^wp-content/mysql\.sql$|^wp-content/(drop-ins|upgrade-temp-backup)/'

# A regex for the mu-plugins in a list: each name as a file, a .php file or a folder.
mu_plugins_regex() {
  local names
  names="$(printf '%s\n' "$1" | grep -v '^$' | sed 's/\./\\./g' | paste -sd '|' -)"
  printf '^wp-content/mu-plugins/(%s)(/|\\.php$|$)' "$names"
}

# The regex of paths a platform manages on top of SERVER_MANAGED_REGEX ("" for none).
host_managed_regex() {
  case "$1" in
    kinsta) printf '%s' "$KINSTA_MANAGED_REGEX" ;;
    wpe) printf '%s|%s' "$WPE_MANAGED_PATHS_REGEX" "$(mu_plugins_regex "$WPE_MANAGED_MU_PLUGINS")" ;;
  esac
}
# --- End of host-managed paths -----------------------------------------------

TMP_DIR=""
verbose=false
SSH_HOST=""
SSH_PORT=""
REMOTE_WEBROOT=""
REMOTE_GIT_DIR=""
# Trailer that marks this script's deploy commits, followed by the version.
WP_DEPLOY_TRAILER="Deployed-by: wp-deploy"
# Trailer of a deploy commit with no parent, followed by the server's commit it replaced.
WP_REPLACES_TRAILER="Replaces:"
# A deploy dry run reads no SSH or Git remote settings, so it doesn't require them.
REMOTE_SETTINGS_OPTIONAL=false
# Set when a dry run is missing remote settings.
REMOTE_SETTINGS_MISSING=false
# The WordPress folder's path inside the Git repo ("" when it is the repo root).
WP_PREFIX=""
# WP Engine and Kinsta receive only the WordPress folder (a split commit).
SPLIT_PUSH=false
# Set once the server's branch is the pushed commit; PUSHED_OVER is the server's commit it replaced.
PUSHED=false
PUSHED_OVER=""
# Set once the host has proven it installed the push.
PUSH_INSTALLED=false

# After a push, name the verify command that reruns the checks. Once the host
# has installed the push, a failure is in the checks, not the deploy: say so and
# exit 2.
die() {
  if [ "$PUSH_INSTALLED" = true ]; then
    printf 'deploy: deploy completed; verification failed: %b\n' "$*" >&2
  else
    printf 'deploy: %b\n' "$*" >&2
  fi
  if [ "$PUSHED" = true ]; then
    printf 'deploy: to rerun the checks without pushing: %s\n' "$(verify_command "$PUSHED_OVER")" >&2
  fi
  [ "$PUSH_INSTALLED" = false ] || exit 2
  exit 1
}

# The command that reruns a deploy's checks against $1, the server's commit before the deploy.
verify_command() {
  printf 'bash _build/deploy.sh verify %s%s' "$TARGET_NAME" "${1:+ --from $1}"
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

apply_settings() {
  REMOTE_BRANCH_NAME="${DEPLOY_REMOTE_BRANCH:-$REMOTE_BRANCH_NAME}"
  FORBIDDEN_PAYLOAD_REGEX="${DEPLOY_FORBIDDEN_PAYLOAD_REGEX:-$FORBIDDEN_PAYLOAD_REGEX}"
  SERVER_MANAGED_REGEX="${DEPLOY_SERVER_MANAGED_REGEX:-$SERVER_MANAGED_REGEX}"
  if [ -n "${DEPLOY_INCLUDE_FILE:-}" ]; then INCLUDE_FILE="$PROJECT_DIR/$DEPLOY_INCLUDE_FILE"; fi
  if [ -n "${DEPLOY_EXCLUDE_FILE:-}" ]; then EXCLUDE_FILE="$PROJECT_DIR/$DEPLOY_EXCLUDE_FILE"; fi
  if [ -n "${DEPLOY_WORDPRESS_DIR:-}" ]; then
    WP_DIR="$(cd "$PROJECT_DIR/$DEPLOY_WORDPRESS_DIR" 2>/dev/null && pwd)" ||
      die "DEPLOY_WORDPRESS_DIR '$DEPLOY_WORDPRESS_DIR' is not a folder under $PROJECT_DIR"
  fi
  BUILD_RUN_DIR="$(cd "$PROJECT_DIR/${DEPLOY_BUILD_DIR:-.}" 2>/dev/null && pwd)" ||
    die "DEPLOY_BUILD_DIR '${DEPLOY_BUILD_DIR:-}' is not a folder under $PROJECT_DIR"
}

# Print the entries of an include/exclude list: trimmed, skipping blank lines
# and comments, including a last line with no trailing newline.
read_list() {
  local line
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in '' | '#'*) continue ;; esac
    printf '%s\n' "$line"
  done <"$1"
}

# Die if any of the named settings is empty. A dry run only notes them.
require_vars() {
  local name missing=""
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing="$missing $name"
  done
  [ -n "$missing" ] || return 0
  if [ "$REMOTE_SETTINGS_OPTIONAL" = true ]; then
    REMOTE_SETTINGS_MISSING=true
    log "Note: a deploy to $TARGET_NAME also needs:$missing"
    return 0
  fi
  die "missing settings for $TARGET_NAME:$missing (set them in _build/deploy.env, or .env for personal values)"
}

set_cloudways() {
  local env="$1" user ip path repo webroot git_path
  user="COMPOSE_CLOUDWAYS_${env}_SSH_USER"
  webroot="COMPOSE_CLOUDWAYS_${env}_WEBROOT"
  ip="COMPOSE_CLOUDWAYS_${env}_SERVER_IP"
  path="COMPOSE_CLOUDWAYS_${env}_GIT_PATH"
  repo="COMPOSE_CLOUDWAYS_${env}_PROJECT_REPO"
  require_vars "$user" "$ip" "$path" "$repo"
  PLATFORM=cloudways
  git_path="${!path:-}"
  git_path="${git_path%/}"
  SSH_HOST="${!user:-}@${!ip:-}"
  REMOTE_GIT_DIR="$git_path/${!repo:-}.git"
  REMOTE_WEBROOT="${!webroot:-$(dirname "$git_path")/public_html}"
  REMOTE="ssh://${SSH_HOST}:22${REMOTE_GIT_DIR}"
  [ -f "$HOOK_FILE" ] || die "no hook file at $HOOK_FILE"
}

# COMPOSE_KINSTA_<ENV> is the SSH login, user@host, from MyKinsta's SFTP/SSH panel.
# Kinsta installs pushes with its own post-receive hook (git checkout -f into the webroot).
set_kinsta() {
  local env="$1" user port webroot
  user="COMPOSE_KINSTA_${env}"
  port="COMPOSE_KINSTA_${env}_PORT"
  webroot="COMPOSE_KINSTA_${env}_WEBROOT"
  require_vars "$user" "$port" COMPOSE_KINSTA_PROJECT_FOLDER COMPOSE_KINSTA_PROJECT_REPO
  PLATFORM=kinsta
  SPLIT_PUSH=true
  SSH_HOST="${!user:-}"
  SSH_PORT="${!port:-}"
  REMOTE_GIT_DIR="/www/${COMPOSE_KINSTA_PROJECT_FOLDER:-}/private/${COMPOSE_KINSTA_PROJECT_REPO:-}.git"
  REMOTE_WEBROOT="${!webroot:-/www/${COMPOSE_KINSTA_PROJECT_FOLDER:-}/public}"
  REMOTE="ssh://${SSH_HOST}:${SSH_PORT}${REMOTE_GIT_DIR}"
}

# WP Engine installs pushes itself. "<install>.git" and "production/<install>.git"
# name the same repository; the SSH gateway reaches the install's webroot.
set_wpe() {
  local install="COMPOSE_WPE_$1" webroot="COMPOSE_WPE_$1_WEBROOT"
  require_vars "$install"
  PLATFORM=wpe
  SPLIT_PUSH=true
  SSH_HOST="${!install:-}@${!install:-}.ssh.wpengine.net"
  REMOTE_WEBROOT="${!webroot:-/home/wpe-user/sites/${!install:-}}"
  REMOTE="git@git.wpengine.com:${!install:-}.git"
}

# production/staging/development on the site's DEPLOY_HOST.
host_target() {
  local env="$1"
  if [ "${DEPLOY_HOST:-}" = cloudways ] && [ "$env" = DEVELOPMENT ]; then
    die "Cloudways has no development target"
  fi
  case "${DEPLOY_HOST:-}" in
    cloudways) set_cloudways "$env" ;;
    kinsta) set_kinsta "$env" ;;
    wpengine | wpe) set_wpe "$env" ;;
    '') die "target '$TARGET_NAME' needs DEPLOY_HOST (cloudways, kinsta or wpengine) in _build/deploy.env, or use a host-prefixed target such as wpe-$TARGET_NAME" ;;
    *) die "unknown DEPLOY_HOST '$DEPLOY_HOST'. Use cloudways, kinsta or wpengine" ;;
  esac
}

resolve_target() {
  local host_managed
  TARGET_NAME="$1"
  case "$1" in
    production | prod) host_target PRODUCTION ;;
    staging | stage) host_target STAGING ;;
    development | dev) host_target DEVELOPMENT ;;
    wpe-production | wpe-prod) set_wpe PRODUCTION ;;
    wpe-staging | wpe-stage) set_wpe STAGING ;;
    wpe-development | wpe-dev) set_wpe DEVELOPMENT ;;
    kinsta-production | kinsta-prod) set_kinsta PRODUCTION ;;
    kinsta-staging | kinsta-stage) set_kinsta STAGING ;;
    cloudways-production | cloudways-prod) set_cloudways PRODUCTION ;;
    cloudways-staging | cloudways-stage) set_cloudways STAGING ;;
    *) die "unknown target '$1'. Use one of: production, staging, development (on DEPLOY_HOST), wpe-production, wpe-staging, wpe-development, kinsta-production, kinsta-staging, cloudways-production, cloudways-staging" ;;
  esac
  host_managed="$(host_managed_regex "$PLATFORM")"
  if [ -z "${DEPLOY_SERVER_MANAGED_REGEX:-}" ] && [ -n "$host_managed" ]; then
    SERVER_MANAGED_REGEX="$SERVER_MANAGED_REGEX|$host_managed"
  fi
}

require_cloudways() {
  [ "$PLATFORM" = cloudways ] || die "$1 only supports Cloudways targets"
}

# Run a bash script on the server over SSH. Arguments are passed as $1...
# remote_bash_input also forwards stdin (text) to the script.
remote_bash() {
  remote_program "$@" </dev/null | remote_shell
}

remote_bash_input() {
  remote_program "$@" | remote_shell
}

# SSH options that end a session whose connection dropped, after about a minute.
SSH_KEEPALIVE=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# The script, its arguments and its input all travel on stdin to `bash -s`,
# never in the SSH command: WP Engine's SSH gateway strips quotes from commands.
# Uses GIT_SSH_COMMAND when set, so git and these calls share one SSH setup.
# Like git, it runs the command through the shell, so quoted arguments in it survive.
remote_shell() {
  sh -c "${GIT_SSH_COMMAND:-ssh}"' "$@"' ssh -o ConnectTimeout=15 "${SSH_KEEPALIVE[@]}" \
    ${SSH_PORT:+-p "$SSH_PORT"} "$SSH_HOST" bash -s
}

# Run git with the keepalives added to its SSH command: GIT_SSH_COMMAND, else
# core.sshCommand, else ssh. A GIT_SSH program takes no options, so it is kept as is.
git_remote() {
  local ssh_cmd
  if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -n "${GIT_SSH:-}" ]; then
    git "$@"
    return
  fi
  ssh_cmd="${GIT_SSH_COMMAND:-$(git config core.sshCommand || echo ssh)}"
  GIT_SSH_COMMAND="$ssh_cmd ${SSH_KEEPALIVE[*]}" git "$@"
}

# Print a bash program that runs the script with the arguments, with this
# function's stdin as the script's stdin (a here-document).
remote_program() {
  local script="$1" input eof="__DEPLOY_INPUT_${RANDOM}${RANDOM}__"
  shift
  input="$(cat)"
  printf 'set --'
  [ $# -eq 0 ] || printf ' %q' "$@"
  printf '\nremote_main() {\n%s\n}\n' "$script"
  printf "remote_main \"\$@\" <<'%s'\n" "$eof"
  [ -z "$input" ] || printf '%s\n' "$input"
  printf '%s\n' "$eof"
}

# Shell function for remote scripts: print a file's Git blob id. WP Engine's
# gateway has no git, so hash "blob <size>\0<content>" with sha1sum.
# shellcheck disable=SC2016
REMOTE_BLOB_HASH='blob_hash() {
  if command -v git >/dev/null; then git hash-object -- "$1"; return; fi
  { printf "blob %d\0" "$(($(wc -c <"$1")))"; cat -- "$1"; } | sha1sum | cut -c1-40
}'

remote_ref() {
  git_remote ls-remote "$REMOTE" "refs/heads/$REMOTE_BRANCH_NAME" | cut -f1
}

# Settings the Cloudways hook reads from deploy-hook.env in the server's Git directory.
hook_config() {
  printf 'DEPLOY_WEBROOT=%s\n' "$REMOTE_WEBROOT"
  printf 'DEPLOY_BRANCH=%s\n' "$REMOTE_BRANCH_NAME"
  printf 'DEPLOY_WORDPRESS_FOLDER=%s\n' "$WP_PREFIX"
  printf 'DEPLOY_PROTECTED_REGEX=%s\n' "$SERVER_MANAGED_REGEX"
  printf 'DEPLOY_FORBIDDEN_PAYLOAD_REGEX=%s\n' "$FORBIDDEN_PAYLOAD_REGEX"
}

# "<hook hash> <config hash>" as installed on the server, and as the repo expects.
installed_hook_state() {
  remote_bash '
    for f in "$1/hooks/post-receive" "$1/$2"; do
      git hash-object "$f" 2>/dev/null || echo missing
    done | tr "\n" " " | sed "s/ $//"' "$REMOTE_GIT_DIR" "$HOOK_CONFIG_NAME"
}

expected_hook_state() {
  printf '%s %s' "$(git hash-object "$HOOK_FILE")" "$(hook_config | git hash-object --stdin)"
}

# Hash of Kinsta's post-receive hook, or "missing".
kinsta_hook_state() {
  remote_bash 'git hash-object "$1/hooks/post-receive" 2>/dev/null || echo missing' "$REMOTE_GIT_DIR"
}

# Folders whose uncommitted changes would change the deploy: the folder above
# _build/, the WordPress folder and the build folder.
check_dirs() {
  printf '%s\n' "$PROJECT_DIR" "$WP_DIR" "$BUILD_RUN_DIR"
}

check_clean_tree() {
  local dir
  while IFS= read -r dir; do
    [ -z "$(git -C "$dir" status --porcelain -- .)" ] ||
      die "uncommitted changes under $dir. Commit them (the deploy uses HEAD), then retry. Nothing was changed."
  done < <(check_dirs)
}

run_build() {
  local dir
  if [ -z "${DEPLOY_BUILD_TASK:-}" ]; then
    log "No build step (DEPLOY_BUILD_TASK is empty): deploying committed files plus the include list"
    return 0
  fi
  log "Build: $DEPLOY_BUILD_TASK"
  (cd "$BUILD_RUN_DIR" && bash -c "$DEPLOY_BUILD_TASK") || die "build failed"
  while IFS= read -r dir; do
    [ -z "$(git -C "$dir" status --porcelain --untracked-files=no -- .)" ] ||
      die "the build changed tracked files. Commit them, then retry."
  done < <(check_dirs)
}

# Build the deploy commit from HEAD in a temporary index: add the include list,
# remove the exclude list, and check the payload. Sets DEPLOY_COMMIT and PUSH_REF.
package() {
  local entry leftover forbidden head
  head="$(git rev-parse HEAD)"
  export GIT_INDEX_FILE="$TMP_DIR/index"
  git read-tree HEAD

  while IFS= read -r entry; do
    case "$entry" in
      *[\*\?\[]*) ;;
      *) [ -e "$entry" ] || die "include entry '$entry' does not exist (did the build run?)" ;;
    esac
    log "Including $entry"
    git add -f -- "$entry" || die "include entry '$entry' matched nothing (did the build run?)"
  done < <(read_list "$INCLUDE_FILE")

  while IFS= read -r entry; do
    git rm -r -q -f --cached --ignore-unmatch -- "$entry" >/dev/null
    leftover="$(git ls-files -- "$entry")"
    [ -z "$leftover" ] || die "exclude entry '$entry' is still in the payload:\n$leftover"
  done < <(read_list "$EXCLUDE_FILE")

  forbidden="$(git ls-files -- . | while IFS= read -r path; do
    if forbidden_payload_path "$path"; then printf '%s\n' "$path"; fi
  done)"
  [ -z "$forbidden" ] || die "payload contains files that must never be deployed:\n$forbidden\nAdd them to $(basename "$EXCLUDE_FILE")."

  DEPLOY_TREE="$(git write-tree)"
  unset GIT_INDEX_FILE
  # No source parent: it would push every past version of the repo, old secrets included.
  DEPLOY_COMMIT="$(git commit-tree "$DEPLOY_TREE" -m "Deploy $(git rev-parse --short "$head") to $TARGET_NAME" \
    -m "Source: $head
$WP_DEPLOY_TRAILER $WP_DEPLOY_VERSION")"
  log "Deploy commit $DEPLOY_COMMIT (source $head, $(git ls-tree -r --name-only "$DEPLOY_TREE" -- . | wc -l | tr -d ' ') files)"
  split_deploy_commit
}

# Sets PUSH_REF: the deploy commit, or on WP Engine and Kinsta a commit holding
# only the WordPress folder, so the host installs it at the webroot. Like the
# deploy commit, the split commit has no parent until chain_onto_server.
split_deploy_commit() {
  PUSH_REF="$DEPLOY_COMMIT"
  [ "$SPLIT_PUSH" = true ] && [ -n "$WP_PREFIX" ] || return 0
  log "Splitting $WP_PREFIX/ into a commit of its own"
  PUSH_REF="$(git commit-tree "$DEPLOY_COMMIT:$WP_PREFIX" -m "$(git log -1 --format=%B "$DEPLOY_COMMIT")")" ||
    die "could not commit $WP_PREFIX/ of the deploy commit (is the payload empty?)"
  [ "$(git rev-parse "$PUSH_REF^{tree}")" = "$(git rev-parse "$DEPLOY_COMMIT:$WP_PREFIX")" ] ||
    die "split commit $PUSH_REF does not match $WP_PREFIX/ of the deploy commit"
  log "Split commit $PUSH_REF"
}

show_payload() {
  log "Payload differences from HEAD (D = excluded, A = included), grouped by plugin/theme:"
  git diff --relative --name-status --no-renames HEAD "$DEPLOY_COMMIT" -- . |
    awk -F'\t' '{
      key = $2
      if (key ~ /^wp-content\/(plugins|themes|mu-plugins)\/[^\/]+\//) { split(key, p, "/"); key = p[1] "/" p[2] "/" p[3] "/" }
      else if (key ~ /^_build\//) key = "_build/"
      k = $1 "\t" key
      if (!(k in n)) order[++count] = k
      n[k]++
    } END { for (i = 1; i <= count; i++) { k = order[i]; printf "    %s%s\n", k, (n[k] > 1 ? " (" n[k] " files)" : "") } }'
}

# Paths in a pushed ref, as the server sees them. Split refs are rooted at the
# WordPress folder; full deploy commits are read relative to it.
pushed_diff() {
  if [ "$PUSH_REF" = "$DEPLOY_COMMIT" ]; then
    git -c core.quotePath=false diff --relative --no-renames --name-status "$1" "$2" -- .
  else
    git -c core.quotePath=false diff --no-renames --name-status "$1" "$2"
  fi
}

pushed_ls_tree() {
  if [ "$PUSH_REF" = "$DEPLOY_COMMIT" ]; then
    git ls-tree -r "$1" -- .
  else
    git ls-tree -r --full-tree "$1"
  fi
}

# True when every commit in a server deploy commit's history is a deploy commit
# from this script and none is in HEAD's history: building on it pushes no source
# history. False for 2.0.0 to 2.2.2 deploys, which carried source history.
deploy_only_history() {
  local total
  git cat-file -e "$1^{commit}" 2>/dev/null || return 1
  total="$(git rev-list --count "$1")"
  [ "$(git rev-list --count --grep="^$WP_DEPLOY_TRAILER " "$1")" = "$total" ] &&
    [ "$(git rev-list --count "$1" --not HEAD)" = "$total" ]
}

# Make PUSH_REF a child of the server's deploy commit $1 when that history holds
# only deploy commits. Git then sends only the objects that changed; a commit
# unrelated to the server's makes it send the whole payload. A commit with no
# parent names $1 in a Replaces trailer instead, so verify knows what it replaced.
chain_onto_server() {
  local chained message
  [ "${DEPLOY_NEW_HISTORY:-}" != true ] || log "DEPLOY_NEW_HISTORY: pushing a commit with no parent"
  [ -n "$1" ] || return 0
  message="$(git log -1 --format=%B "$PUSH_REF")"
  if [ "${DEPLOY_NEW_HISTORY:-}" != true ] && deploy_only_history "$1"; then
    chained="$(git commit-tree "$PUSH_REF^{tree}" -p "$1" -m "$message")" ||
      die "could not build on the server's deploy commit $1"
    log "Building on the server's deploy commit $1: $chained"
  else
    chained="$(git commit-tree "$PUSH_REF^{tree}" -m "$message
$WP_REPLACES_TRAILER $1")" || die "could not record the server's commit $1 in the deploy commit"
  fi
  [ "$PUSH_REF" != "$DEPLOY_COMMIT" ] || DEPLOY_COMMIT="$chained"
  PUSH_REF="$chained"
}

# Push PUSH_REF, built on the server's deploy commit $1 when that is safe.
push_ref() {
  chain_onto_server "${1:-}"
  log "Pushing to $TARGET_NAME ($REMOTE), branch $REMOTE_BRANCH_NAME"
  git_remote push --force "$REMOTE" "$PUSH_REF:refs/heads/$REMOTE_BRANCH_NAME" 2>&1 | tee "$TMP_DIR/push.log" ||
    die "git push to $TARGET_NAME failed"
}

# The server's branch is the pushed commit, which replaced the server's commit $1.
mark_pushed() {
  PUSHED=true
  PUSHED_OVER="$1"
}

# The host has installed the push: later failures are verification failures.
# Does nothing under verify, which pushes nothing.
mark_installed() {
  [ "$PUSHED" = false ] || PUSH_INSTALLED=true
}

# Check that the server's branch is the pushed commit, which replaced the server's commit $1.
verify_remote_ref() {
  local got
  got="$(remote_ref)" ||
    die "could not read $REMOTE after the push, so the push is unconfirmed. Once it is reachable, check the deploy without pushing: $(verify_command "$1")"
  [ "$got" = "$PUSH_REF" ] || die "$TARGET_NAME $REMOTE_BRANCH_NAME is ${got:-missing}, expected $PUSH_REF"
  log "Remote $REMOTE_BRANCH_NAME is $PUSH_REF"
}

# Fetch the server's current deploy ref if it is not local, so the deploy can be verified against it.
fetch_remote_rev() {
  if [ -n "$1" ] && ! git cat-file -e "$1^{commit}" 2>/dev/null; then
    git_remote fetch -q --no-tags "$REMOTE" "refs/heads/$REMOTE_BRANCH_NAME" || true
  fi
}

previous_server_ref() {
  local prev
  prev="$(remote_ref)" || die "could not reach $REMOTE"
  fetch_remote_rev "$prev"
  printf '%s' "$prev"
}

# True when commit $1 is a deploy commit from this script (it has the trailer).
# WP Engine's own commits, such as its "Upgraded WordPress" snapshots, are not.
wp_deploy_commit() {
  git cat-file -e "$1^{commit}" 2>/dev/null &&
    grep -q "^$WP_DEPLOY_TRAILER " <<<"$(git log -1 --format=%B "$1")"
}

# Paths the deploy deletes (prev..PUSH_REF), without server-managed paths.
deploy_deletions() {
  pushed_diff "$1" "$PUSH_REF" |
    SERVER_MANAGED_REGEX="$SERVER_MANAGED_REGEX" awk -F'\t' '$1 == "D" && $2 !~ ENVIRON["SERVER_MANAGED_REGEX"] { print $2 }'
}

# Removing what the deploy deletes is safe only against our own deploy commit:
# against a host snapshot of the webroot it would remove WordPress core.
warn_foreign_predecessor() {
  local prev="$1" name count
  name="$(git log -1 --format='%h "%s"' "$prev" 2>/dev/null || printf '%s' "$prev")"
  log "WARNING: the server's commit $name is not a wp-deploy commit (no $WP_DEPLOY_TRAILER trailer). This deploy removes no files from the server."
  if git cat-file -e "$prev^{commit}" 2>/dev/null; then
    deploy_deletions "$prev" >"$TMP_DIR/foreign.deletions"
    count="$(wc -l <"$TMP_DIR/foreign.deletions" | tr -d ' ')"
    if [ "$count" -gt 0 ]; then
      log "It has $count file(s) the deploy doesn't, left on the server:"
      head -n 20 "$TMP_DIR/foreign.deletions" | sed 's/^/    /'
      [ "$count" -le 20 ] || echo "    ... and $((count - 20)) more"
    fi
  fi
  log "To review old files on the server: bash _build/deploy.sh audit $TARGET_NAME, then bash _build/deploy.sh prune $TARGET_NAME"
}

# List the files the deploy changed (prev..PUSH_REF) and their expected blobs,
# for check_server_files. With $2 = false, leave deletions out: they are not
# checked or removed. Returns 1 when there is nothing to check.
prepare_verify() {
  local prev="$1" deletions="${2:-true}"
  if [ -z "$prev" ] || ! git cat-file -e "$prev^{tree}" 2>/dev/null; then
    log "Previous server revision not available locally; skipping file verification"
    return 1
  fi
  pushed_diff "$prev" "$PUSH_REF" |
    SERVER_MANAGED_REGEX="$SERVER_MANAGED_REGEX" DELETIONS="$deletions" awk -F'\t' '
      !($1 == "D" && (ENVIRON["DELETIONS"] != "true" || $2 ~ ENVIRON["SERVER_MANAGED_REGEX"]))' >"$TMP_DIR/verify.changes"
  if [ ! -s "$TMP_DIR/verify.changes" ]; then
    log "No file changes to verify"
    return 1
  fi
  pushed_ls_tree "$PUSH_REF" >"$TMP_DIR/verify.expected"
}

# Compare the prepared changes with the server's webroot. Writes one line per
# problem to $TMP_DIR/verify.bad: "stale<TAB>path" (deleted by the deploy, still on
# the server) or "differs<TAB>path<TAB>server blob". Returns 1 if there are any.
check_server_files() {
  local result
  # Each line: <status>\t<path>. Expect deletions to be gone and other paths to match the deploy blob.
  result="$(remote_bash_input "$REMOTE_BLOB_HASH"'
    cd "$1" || exit 1
    while IFS=$'"'"'\t'"'"' read -r status path; do
      if [ "$status" = D ]; then
        [ -e "$path" ] && printf "present\t%s\n" "$path"
      elif [ -f "$path" ]; then
        printf "%s\t%s\n" "$(blob_hash "$path")" "$path"
      else
        printf "missing\t%s\n" "$path"
      fi
    done
    exit 0' "$REMOTE_WEBROOT" <"$TMP_DIR/verify.changes")" || die "could not read files on the server to verify the deploy"

  # Compare in one awk pass over files; piping large strings into a reader that
  # exits early (awk ... exit) raises SIGPIPE, which set -e turns into a silent exit.
  printf '%s\n' "$result" >"$TMP_DIR/verify.server"
  awk -F'\t' '
    FILENAME == ARGV[1] { split($1, meta, " "); want[$2] = meta[3]; next }
    FILENAME == ARGV[2] { if ($1 == "present") print "stale\t" $2; else got[$2] = $1; next }
    $1 != "D" && $2 != "" && got[$2] != want[$2] {
      print "differs\t" $2 "\t" (($2 in got) ? got[$2] : "unknown")
    }' "$TMP_DIR/verify.expected" "$TMP_DIR/verify.server" "$TMP_DIR/verify.changes" >"$TMP_DIR/verify.bad"
  [ ! -s "$TMP_DIR/verify.bad" ]
}

fail_verification() {
  die "server files do not match the deploy ($(wc -l <"$TMP_DIR/verify.bad" | tr -d ' ') path(s)):\n$(head -n 50 "$TMP_DIR/verify.bad" |
    awk -F'\t' '{ print "    " $2 ($1 == "stale" ? " (deleted in repo, still on server)" : " (server: " $3 ")") }')"
}

verified() {
  log "Verified $(wc -l <"$TMP_DIR/verify.changes" | tr -d ' ') changed paths on the server"
}

# Check the files a deploy changed on the server, retrying DEPLOY_VERIFY_ATTEMPTS times.
verify_files() {
  local attempts="${DEPLOY_VERIFY_ATTEMPTS:-1}" try
  prepare_verify "$1" || return 0
  for ((try = 1; try <= attempts; try++)); do
    if check_server_files; then
      verified
      return 0
    fi
    [ "$try" -lt "$attempts" ] || break
    log "Server files do not match yet; checking again in ${DEPLOY_VERIFY_WAIT:-10}s ($((try + 1))/$attempts)"
    sleep "${DEPLOY_VERIFY_WAIT:-10}"
  done
  fail_verification
}

# Delete the files listed as stale in verify.bad from the webroot, then any
# directories they leave empty. Mirrors the Cloudways hook's deletion rules.
# $1, optional, says why the files are removed.
remove_stale_files() {
  local status=0
  awk -F'\t' '$1 == "stale" { print $2 }' "$TMP_DIR/verify.bad" >"$TMP_DIR/verify.stale"
  log "Removing $(wc -l <"$TMP_DIR/verify.stale" | tr -d ' ') file(s) ${1:-the deploy deleted but the host left on the server}"
  # head reads the file first so nothing upstream gets SIGPIPE under pipefail.
  head -n 20 "$TMP_DIR/verify.stale" | sed 's/^/    /'
  # With PRUNE_LOCK_REV set (prune on Cloudways), take the post-receive hook's
  # deploy lock in the server's Git folder and remove nothing (exit 3) unless the
  # branch is still that commit, so a deploy can't run between check and delete.
  remote_bash_input '
    cd "$1" || exit 1
    if [ -n "$4" ]; then
      if command -v flock >/dev/null; then
        exec 9>>"$2/deploy.lock" && flock -w 600 9 || exit 4
      else
        waited=0
        until mkdir "$2/deploy.lock.d" 2>/dev/null; do
          pid="$(cat "$2/deploy.lock.d/pid" 2>/dev/null)"
          if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$2/deploy.lock.d/pid"
            rmdir "$2/deploy.lock.d" 2>/dev/null
            continue
          fi
          [ "$waited" -lt 600 ] || exit 4
          sleep 1
          waited=$((waited + 1))
        done
        echo "$$" >"$2/deploy.lock.d/pid"
        trap "rm -f \"$2/deploy.lock.d/pid\"; rmdir \"$2/deploy.lock.d\" 2>/dev/null" EXIT
      fi
      [ "$(git --git-dir="$2" rev-parse -q --verify "refs/heads/$3")" = "$4" ] || exit 3
    fi
    keep() {
      case "$1" in
        . | /* | *..* | wp-content | wp-content/plugins | wp-content/themes | wp-content/mu-plugins) return 0 ;;
      esac
      return 1
    }
    while IFS= read -r path; do
      keep "$path" && continue
      if [ -d "$path" ] && [ ! -L "$path" ]; then
        echo "Keeping $path (now a directory)"
        continue
      fi
      rm -f -- "$path" || exit 1
      dir="$(dirname -- "$path")"
      while ! keep "$dir"; do
        rmdir -- "$dir" 2>/dev/null || break
        dir="$(dirname -- "$dir")"
      done
    done
    exit 0' "$REMOTE_WEBROOT" "${REMOTE_GIT_DIR:-}" "$REMOTE_BRANCH_NAME" "${PRUNE_LOCK_REV:-}" <"$TMP_DIR/verify.stale" || status=$?
  case "$status" in
    0) ;;
    3) die "$TARGET_NAME's $REMOTE_BRANCH_NAME changed before the files were removed. Nothing was removed; run prune again." ;;
    4) die "another deploy held the server's deploy lock for 10 minutes. Nothing was removed." ;;
    *) die "removing deleted files on the server failed" ;;
  esac
}

deploy_cloudways() {
  local want have prev installed
  want="$(expected_hook_state)"
  have="$(installed_hook_state)" || die "could not reach $SSH_HOST"
  [ "$want" = "$have" ] ||
    die "the server's post-receive hook or $HOOK_CONFIG_NAME differs from the repo.\nReview $(basename "$HOOK_FILE") and the settings, then run: bash _build/deploy.sh install-hook $TARGET_NAME"

  prev="$(previous_server_ref)"
  installed="$(installed_server_ref "$prev")"
  push_ref "$prev"
  grep -q "DEPLOY_OK $PUSH_REF" "$TMP_DIR/push.log" ||
    die "git accepted the push but the server hook did not report a successful install. Check the output above."
  verify_remote_ref "$prev"
  mark_pushed "$prev"
  mark_installed
  # Checked against the commit the hook last installed in full, which the hook
  # diffed against too. A first deploy is checked against the empty tree.
  verify_files "${installed:-$(git hash-object -t tree /dev/null)}"
}

# The commit the Cloudways hook last installed in full (deploy-installed-rev),
# when it is known locally; else $1, the server's branch. A push Git accepted
# but the hook refused moves the branch without installing it.
installed_server_ref() {
  local installed
  installed="$(remote_bash 'cat "$1/deploy-installed-rev" 2>/dev/null; exit 0' "$REMOTE_GIT_DIR" | tr -d '[:space:]')" ||
    die "could not reach $SSH_HOST"
  if [ -z "$installed" ] || [ "$installed" = "$1" ]; then
    printf '%s' "$1"
  elif git cat-file -e "$installed^{commit}" 2>/dev/null; then
    log "The server's branch is $1, but the last commit installed in full is $installed" >&2
    printf '%s' "$installed"
  else
    log "WARNING: the last commit installed in full, $installed, is not in this repo; checking against the server's branch $1" >&2
    printf '%s' "$1"
  fi
}

# Kinsta's hook is the host's `checkout -f` and reports nothing, so success is
# judged by the server's checkout and the changed files, not by the push.
deploy_kinsta() {
  local hook prev
  hook="$(kinsta_hook_state)" || die "could not reach $SSH_HOST on port $SSH_PORT"
  if [ "$hook" = missing ]; then
    die "no post-receive hook in $REMOTE_GIT_DIR: a push would not install anything"
  fi
  if [ -f "$KINSTA_HOOK_FILE" ] && [ "$hook" != "$(git hash-object "$KINSTA_HOOK_FILE")" ]; then
    log "Note: the server's post-receive hook differs from $(basename "$KINSTA_HOOK_FILE"); verifying files after the push"
  fi

  prev="$(previous_server_ref)"
  push_ref "$prev"
  verify_remote_ref "$prev"
  mark_pushed "$prev"
  verify_kinsta_checkout
  mark_installed
  # A first deploy is checked against the empty tree: every file in it.
  verify_files "${prev:-$(git hash-object -t tree /dev/null)}"
}

# The hook checks out with the server repo's index, so after a successful
# install the index matches the pushed tree. Read-only; works without a previous ref.
verify_kinsta_checkout() {
  local diff
  diff="$(remote_bash 'GIT_OPTIONAL_LOCKS=0 git --git-dir="$1" diff-index --cached --name-status "$2"' \
    "$REMOTE_GIT_DIR" "$PUSH_REF")" || die "could not read the server's checkout to verify the deploy"
  [ -z "$diff" ] ||
    die "the server's checkout does not match the push: the hook did not install $PUSH_REF (does it deploy $REMOTE_BRANCH_NAME?). Differences:\n$(printf '%s\n' "$diff" | sed -n '1,20s/^/    /p')"
  log "Server checkout matches $PUSH_REF"
}

# WP Engine installs the push but never deletes files, so the script removes
# the files the deploy deleted over SSH, when the server's commit is its own.
# A matching branch only means WP Engine accepted the push: the file check is
# the proof that it installed it.
deploy_wpe() {
  local prev removals=true
  prev="$(remote_ref)" || die "could not read $REMOTE (WP Engine grants Git Push access separately from SSH)"
  if [ -z "$prev" ]; then
    log "First deploy: preparing the WP Engine remote with a placeholder commit"
    (
      mkdir "$TMP_DIR/init" && cd "$TMP_DIR/init" &&
        git init -q && echo 'Hello, world.' >tmp.txt && git add tmp.txt &&
        git commit -q --no-verify -m "Initial commit" -m "$WP_DEPLOY_TRAILER $WP_DEPLOY_VERSION" &&
        git_remote push -f "$REMOTE" "HEAD:refs/heads/$REMOTE_BRANCH_NAME"
    ) || die "could not prepare the WP Engine remote"
    log "Remote ready. Run the deploy again to populate it."
    return 0
  fi
  fetch_remote_rev "$prev"

  if ! wp_deploy_commit "$prev"; then
    removals=false
    warn_foreign_predecessor "$prev"
  fi

  push_ref "$prev"
  verify_remote_ref "$prev"
  mark_pushed "$prev"
  wpe_verify_files "$prev" "$removals" "${DEPLOY_VERIFY_ATTEMPTS:-6}"
}

# WP Engine may finish installing after git push returns: check the files
# changed since $1 up to $3 times until they match, which proves the install,
# then, unless $2 is false, delete the files the deploy removed if WP Engine
# left them.
wpe_verify_files() {
  local prev="$1" removals="$2" attempts="$3" try
  prepare_verify "$prev" "$removals" || return 0
  for ((try = 1; try <= attempts; try++)); do
    if check_server_files; then
      mark_installed
      verified
      return 0
    fi
    grep -q '^differs' "$TMP_DIR/verify.bad" || break
    [ "$try" -lt "$attempts" ] || fail_verification
    log "Server files do not match yet; checking again in ${DEPLOY_VERIFY_WAIT:-10}s ($((try + 1))/$attempts)"
    sleep "${DEPLOY_VERIFY_WAIT:-10}"
  done
  mark_installed
  [ "$removals" = false ] || remove_stale_files
  check_server_files || fail_verification
  verified
}

# Rerun a deploy's checks without pushing, for a deploy whose push the host
# installed but whose checks failed or were cut off. Checks the server's deploy
# commit against $1, the server's commit before it (default: the commit it
# replaced: its parent, or the Replaces trailer of a commit with no parent), and
# on WP Engine removes the files the deploy deleted, but only against the commit
# it replaced: an older deploy commit, or another target's, would remove files
# that changed since.
verify_deploy() {
  local prev="$1" replaced removals=true
  echo "wp-deploy $WP_DEPLOY_VERSION"
  log "Verify of $TARGET_NAME ($SSH_HOST:$REMOTE_WEBROOT). Pushes nothing."
  PUSH_REF="$(remote_ref)" || die "could not read $REMOTE"
  [ -n "$PUSH_REF" ] || die "$TARGET_NAME has no $REMOTE_BRANCH_NAME branch. Deploy first."
  fetch_remote_rev "$PUSH_REF"
  git cat-file -e "$PUSH_REF^{commit}" 2>/dev/null || die "could not fetch the server's commit $PUSH_REF from $REMOTE"
  wp_deploy_commit "$PUSH_REF" ||
    die "the server's commit $PUSH_REF is not a wp-deploy commit from 2.2.3 or later, so verify can't check it"
  # pushed_diff reads a full deploy commit relative to the WordPress folder.
  if [ "$SPLIT_PUSH" = true ] && [ -n "$WP_PREFIX" ]; then DEPLOY_COMMIT=""; else DEPLOY_COMMIT="$PUSH_REF"; fi
  log "Remote $REMOTE_BRANCH_NAME is $PUSH_REF"
  replaced="$(git rev-parse -q --verify "$PUSH_REF^" || true)"
  if [ -z "$replaced" ]; then
    replaced="$(git log -1 --format="%(trailers:key=${WP_REPLACES_TRAILER%:},valueonly)" "$PUSH_REF")"
  fi
  if [ -n "$prev" ]; then
    git cat-file -e "$prev^{commit}" 2>/dev/null || die "--from $prev is not a commit in this repo"
    prev="$(git rev-parse "$prev^{commit}")"
    log "Checking the files changed since $prev"
  elif [ -n "$replaced" ]; then
    git cat-file -e "$replaced^{commit}" 2>/dev/null ||
      die "the server's commit replaced $replaced, which is not in this repo. Run verify from the clone that deployed it, or pass --from <ref>"
    prev="$replaced"
    log "Checking the files changed since $prev"
  else
    # As after a first deploy: compare with the empty tree.
    removals=false
    prev="$(git hash-object -t tree /dev/null)"
    log "$PUSH_REF has no parent, so verify checks every file in it and removes none"
  fi
  case "$PLATFORM" in
    cloudways) verify_files "$prev" ;;
    kinsta)
      verify_kinsta_checkout
      verify_files "$prev"
      ;;
    wpe)
      if [ "$removals" = false ]; then
        :
      elif [ -z "$replaced" ]; then
        removals=false
        log "WARNING: the server's commit has no parent and no $WP_REPLACES_TRAILER trailer, so verify can't tell what it replaced and removes no files; it checks the files the deploy added or changed"
      elif [ "$prev" != "$replaced" ]; then
        removals=false
        log "WARNING: --from $prev is not $replaced, the commit the server's commit replaced, so verify removes no files; it checks the files the deploy added or changed"
      elif ! wp_deploy_commit "$prev"; then
        removals=false
        warn_foreign_predecessor "$prev"
      fi
      wpe_verify_files "$prev" "$removals" "${DEPLOY_VERIFY_ATTEMPTS:-1}"
      ;;
  esac
  log "Verify of $TARGET_NAME complete"
}

# Dry run on WP Engine: list the files the deploy would remove from the server.
# Reads the server's commit over Git when the settings allow; never fails the dry run.
show_removals() {
  local prev
  if [ "$REMOTE_SETTINGS_MISSING" = true ]; then
    log "Not listing files the deploy would remove from the server: that needs the Git remote settings"
    return 0
  fi
  if ! prev="$(remote_ref 2>/dev/null)"; then
    log "Could not read $REMOTE, so not listing files the deploy would remove from the server"
    return 0
  fi
  if [ -z "$prev" ]; then
    log "The server has no commit yet: the first deploy pushes a placeholder and removes nothing"
    return 0
  fi
  fetch_remote_rev "$prev" 2>/dev/null
  if ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
    log "Could not fetch the server's commit $prev, so not listing files the deploy would remove"
    return 0
  fi
  if ! wp_deploy_commit "$prev"; then
    warn_foreign_predecessor "$prev"
    return 0
  fi
  deploy_deletions "$prev" >"$TMP_DIR/dry-run.removals"
  log "Files the deploy would remove from the server, against its deploy commit $(git rev-parse --short "$prev"): $(wc -l <"$TMP_DIR/dry-run.removals" | tr -d ' ')"
  sed 's/^/    /' "$TMP_DIR/dry-run.removals"
}

# Files deleted somewhere in HEAD's history and not tracked at HEAD, relative to
# the WordPress folder. Files that were never committed are never listed.
history_deleted_paths() {
  comm -23 \
    <(git -c core.quotePath=false log --format= --name-only --no-renames --diff-filter=D --relative HEAD -- . | grep -v '^$' | sort -u) \
    <(git -c core.quotePath=false ls-files -- . | sort -u)
}

# Those of them that are on the server, without server-managed paths.
# With "files", directories are left out.
server_orphans() {
  history_deleted_paths | grep -v '^$' | remote_bash_input '
    cd "$1" || exit 1
    while IFS= read -r path; do
      [ -e "$path" ] || [ -L "$path" ] || continue
      if [ "$2" = files ] && [ -d "$path" ] && [ ! -L "$path" ]; then continue; fi
      printf "%s\n" "$path"
    done
    exit 0' "$REMOTE_WEBROOT" "${1:-all}" | grep -Ev "$SERVER_MANAGED_REGEX" || true
}

# Print "listed<TAB>path" or "-<TAB>path" for each path on stdin: whether it is an
# entry of the include/exclude lists given as arguments, or a path under one.
mark_listed() {
  local list path pattern listed
  local -a patterns=()
  while IFS= read -r pattern; do
    pattern="${pattern%/\*}"
    pattern="${pattern%/}"
    [ -z "$pattern" ] || patterns+=("$pattern")
  done < <(for list in "$@"; do read_list "$list"; done)
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    listed=-
    for pattern in ${patterns[@]+"${patterns[@]}"}; do
      # shellcheck disable=SC2053 # the list entries are globs
      if [[ $path == $pattern || $path == $pattern/* ]]; then
        listed=listed
        break
      fi
    done
    printf '%s\t%s\n' "$listed" "$path"
  done
}

# .env files in the webroot, outside wp-content/uploads/: the files ENV_FILE_REGEX matches.
server_env_files() {
  remote_bash '
    cd "$1" || exit 1
    if command -v find >/dev/null; then
      find . -path ./wp-content/uploads -prune -o -name ".env*" ! -type d -print | sed "s|^\./||"
    else
      for f in .env*; do [ -e "$f" ] && [ ! -d "$f" ] && printf "%s\n" "$f"; done
    fi
    exit 0' "$REMOTE_WEBROOT" | grep -E "$ENV_FILE_REGEX" | grep -Ev "$ENV_TEMPLATE_REGEX" | sort -u || true
}

# The source commit of a deploy commit: its Source trailer, or the parent of an
# unsplit 2.0.0 to 2.2.2 deploy commit, which has no trailer. Empty when unknown.
deploy_source() {
  local rev
  rev="$(git log -1 --format='%(trailers:key=Source,valueonly)' "$1")"
  if [ -z "$rev" ] && { [ "$SPLIT_PUSH" != true ] || [ -z "$WP_PREFIX" ]; }; then
    rev="$(git rev-parse -q --verify "$1^" || true)"
  fi
  printf '%s' "$rev"
}

# Read-only: compare the server's webroot with the repo.
audit_server() {
  local server_rev want have excluded orphans managed_entries tracked_entries plugin_status never_tracked inventory inactive drift=""
  local plugin_entries plugin_versions unmanaged no_plugin_file env_files marked excluded_orphans source_rev
  echo "wp-deploy $WP_DEPLOY_VERSION"
  log "Audit of $TARGET_NAME ($SSH_HOST:$REMOTE_WEBROOT). Read-only."
  remote_bash 'cd "$1"' "$REMOTE_WEBROOT" || die "could not reach $SSH_HOST:$REMOTE_WEBROOT"

  # The Git remote can refuse a key that the SSH login accepts (WP Engine grants them separately).
  if server_rev="$(remote_ref 2>/dev/null)"; then
    echo "Server $REMOTE_BRANCH_NAME: ${server_rev:-missing}"
  else
    server_rev=""
    echo "Server $REMOTE_BRANCH_NAME: unreadable (git ls-remote failed; SSH works)"
  fi
  echo "Local HEAD: $(git rev-parse HEAD)"
  if [ -n "$server_rev" ] && git cat-file -e "$server_rev^{commit}" 2>/dev/null; then
    echo "Server deploy commit: $(git log -1 --format='%ci %s' "$server_rev")"
    source_rev="$(deploy_source "$server_rev")"
    [ -z "$source_rev" ] || echo "Server deploy commit's source: $source_rev"
  fi

  case "$PLATFORM" in
    cloudways)
      want="$(expected_hook_state)"
      have="$(installed_hook_state)"
      if [ "$want" = "$have" ]; then
        echo "Hook: matches $(basename "$HOOK_FILE") and $HOOK_CONFIG_NAME"
      else
        echo "Hook: DIFFERS from $(basename "$HOOK_FILE") or $HOOK_CONFIG_NAME (server $have, repo $want). Install with: bash _build/deploy.sh install-hook $TARGET_NAME"
      fi
      ;;
    kinsta)
      have="$(kinsta_hook_state)"
      if [ "$have" = missing ]; then
        echo "Hook: MISSING from $REMOTE_GIT_DIR/hooks; pushes will not install anything"
      elif [ -f "$KINSTA_HOOK_FILE" ] && [ "$have" = "$(git hash-object "$KINSTA_HOOK_FILE")" ]; then
        echo "Hook: matches $(basename "$KINSTA_HOOK_FILE")"
      else
        echo "Hook: server hook $have differs from $(basename "$KINSTA_HOOK_FILE") or there is no repo copy (Kinsta hooks are host-managed; deploys verify files instead)"
      fi
      ;;
    wpe) echo "Hook: managed by WP Engine" ;;
  esac

  env_files="$(server_env_files)"
  if [ -n "$env_files" ]; then
    echo
    echo "## WARNING: .env files in the webroot"
    echo "  They usually hold secrets, and the web server may serve them to anyone. Check with"
    echo "  curl -I https://<site>/<path>, and move them out of the webroot. Deploys and prune never remove them."
    print_list "$env_files"
  fi

  plugin_status="$(remote_bash '
    cd "$1" || exit 0
    command -v wp >/dev/null || exit 0
    wp plugin list --fields=name,status,version --format=csv --skip-plugins --skip-themes 2>/dev/null | tail -n +2
    exit 0' "$REMOTE_WEBROOT" || true)"
  echo
  echo "## Excluded paths present on the server"
  excluded="$(read_list "$EXCLUDE_FILE" | remote_bash_input '
    cd "$1" || exit 1
    shopt -s nullglob dotglob
    while IFS= read -r pattern; do
      pattern="${pattern%/\*}"
      pattern="${pattern%/}"
      for match in $pattern; do
        [ -e "$match" ] && printf "%s\n" "$match"
      done
    done
    exit 0' "$REMOTE_WEBROOT" | sort -u)"
  print_list "$(annotate_plugins "$(printf '%s\n' "$excluded" | grep -Ev "$SERVER_MANAGED_REGEX" || true)" "$plugin_status")"
  if printf '%s\n' "$excluded" | grep -Eq "$SERVER_MANAGED_REGEX"; then
    echo "  (server-managed, expected: $(printf '%s\n' "$excluded" | grep -E "$SERVER_MANAGED_REGEX" | tr '\n' ' '))"
  fi

  # Exclude-list matches are already listed above, and prune keeps them.
  marked="$(server_orphans | mark_listed "$EXCLUDE_FILE")"
  orphans="$(printf '%s\n' "$marked" | awk -F'\t' '$1 == "-" { print $2 }')"
  excluded_orphans="$(printf '%s\n' "$marked" | awk -F'\t' '$1 == "listed" { print $2 }')"

  managed_entries="$(remote_bash '
    cd "$1" || exit 1
    for dir in wp-content/plugins wp-content/themes wp-content/mu-plugins; do
      [ -d "$dir" ] && ls -1A "$dir" | sed "s|^|$dir/|"
    done
    exit 0' "$REMOTE_WEBROOT" | sort -u)"
  tracked_entries="$(git log --format= --name-only --no-renames --relative HEAD -- wp-content/plugins wp-content/themes wp-content/mu-plugins |
    grep -v '^$' | cut -d/ -f1-3 | sort -u)"
  never_tracked="$(comm -23 <(printf '%s\n' "$managed_entries") <(printf '%s\n' "$tracked_entries") |
    grep -Ev '/index\.php$' | grep -Ev "$SERVER_MANAGED_REGEX" || true)"

  echo
  echo "## Files deleted from the repo that are still on the server"
  echo "  Deploys remove the files they delete, but not files left by older deploys or copied by hand."
  echo "  To review and remove them: bash _build/deploy.sh prune $TARGET_NAME"
  if [ "$verbose" = true ]; then
    print_list "$orphans"
  else
    print_list "$(group_orphans "$orphans" "$plugin_status")"
    echo "  (run with --verbose to list every file)"
  fi
  if [ -n "$excluded_orphans" ]; then
    echo "  ($(count_lines "$excluded_orphans") file(s) matching the exclude list are left out: prune keeps them)"
  fi

  if [ "$PLATFORM" = kinsta ]; then
    # Kinsta's hook checks out into the webroot with the server repo's index, so
    # git can show deployed files changed on the server. No optional locks: read-only.
    drift="$(remote_bash '
      GIT_OPTIONAL_LOCKS=0 git --git-dir="$1" --work-tree="$2" status --porcelain --untracked-files=no 2>/dev/null
      exit 0' "$REMOTE_GIT_DIR" "$REMOTE_WEBROOT" || true)"
    echo
    echo "## Deployed files changed or removed on the server since the last deploy"
    echo "  From the server repo's index. The next deploy overwrites changed files and restores removed ones."
    print_list "$drift"
  fi

  echo
  echo "## Plugins, themes and mu-plugins on the server that were never in git"
  echo "  Review only: these may be installed on purpose (paid, host or admin-managed plugins). Deploys never remove them."
  print_list "$(annotate_plugins "$never_tracked" "$plugin_status")"

  echo
  echo "## Plugins on the server"
  echo "  status from WP-CLI (unknown if WP-CLI is missing); source: composer (composer.lock), tracked (in git), excluded (in git, never deployed) or untracked"
  inventory="$(plugin_inventory "$managed_entries" "$plugin_status")"
  printf '%s\n' "$inventory" | sed 's/^/  /'
  inactive="$(printf '%s\n' "$inventory" | awk '$2 == "inactive" { print $1 }')"
  echo "  Inactive: $(count_lines "$inactive")${inactive:+ ($(printf '%s\n' "$inactive" | tr '\n' ' ' | sed 's/ $//'))}"
  # Composer packages WP-CLI found no plugin file in.
  no_plugin_file="$(printf '%s\n' "$inventory" |
    awk '$2 == "no-plugin-file" && $3 ~ /^composer/ { print $1 }' | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$no_plugin_file" ]; then
    echo "  Warning: composer package(s) with no plugin file: $no_plugin_file."
    echo "  WordPress doesn't load them. The package may nest the plugin one folder too deep."
  fi

  plugin_entries="$(printf '%s\n' "$managed_entries" | plugin_entries_only | grep -Ev "$SERVER_MANAGED_REGEX" || true)"
  plugin_versions="$(printf '%s\n' "$plugin_entries" | grep -v '^$' | remote_bash_input "$PLUGIN_VERSION_SCRIPT" "$REMOTE_WEBROOT" || true)"
  unmanaged="$(unmanaged_plugins "$plugin_entries" "$plugin_status" "$plugin_versions")"
  echo
  print_unmanaged "$unmanaged" server
  print_composer_drift

  echo
  if [ -n "$env_files" ]; then
    echo "WARNING: $(count_lines "$env_files") .env file(s) in the webroot (see above)"
  fi
  printf 'audit: %s excluded path(s) on server, %s deleted tracked file(s) on server, %s never-tracked plugin/theme entries, %s inactive plugin(s)%s, %s plugin(s) not managed by composer\n' \
    "$(count_lines "$(printf '%s\n' "$excluded" | grep -Ev "$SERVER_MANAGED_REGEX" || true)")" \
    "$(count_lines "$orphans")" "$(count_lines "$never_tracked")" "$(count_lines "$inactive")" \
    "$([ "$PLATFORM" = kinsta ] && printf ', %s deployed file(s) changed on server' "$(count_lines "$drift")")" \
    "$(count_lines "$unmanaged")"
}

# --- Prune -------------------------------------------------------------------
# prune removes files that were deleted from the repo but are still on the
# server, which deploys never remove once they have been missed. It starts from
# the audit's list (so it never touches files that were never committed) and
# keeps anything that might still be in use.

# Paths prune never removes, whatever the settings say.
PRUNE_PROTECTED_REGEX='(^|/)(\.env[^/]*|wp-config\.php|\.htaccess|\.user\.ini|php\.ini)$|^wp-content/uploads/'

# Paths, relative to the WordPress folder, in a deploy ref as the server received it.
deployed_paths() {
  if [ "$SPLIT_PUSH" = true ] && [ -n "$WP_PREFIX" ]; then
    git -c core.quotePath=false ls-tree -r --name-only --full-tree "$1"
  else
    git -c core.quotePath=false ls-tree -r --name-only "$1" -- .
  fi
}

# Sort prune.orphans into prune.classified: "<category>\t<path>" per file.
# Removed: old-version (under a plugin, theme or mu-plugin still at HEAD or in
# composer.lock) and site-file (outside wp-content/). Everything else is kept.
prune_classify() {
  mark_listed "$INCLUDE_FILE" "$EXCLUDE_FILE" <"$TMP_DIR/prune.orphans" >"$TMP_DIR/prune.listed"

  git -c core.quotePath=false ls-tree --name-only HEAD -- wp-content/plugins/ wp-content/themes/ wp-content/mu-plugins/ >"$TMP_DIR/prune.entries"
  composer_lock_entries |
    awk -F'\t' '$2 ~ /^wordpress-(plugin|muplugin|theme)$/ { sub(/.*\//, "", $1); print tolower($1) }' >"$TMP_DIR/prune.composer"
  PROTECTED="$PRUNE_PROTECTED_REGEX|$FORBIDDEN_PAYLOAD_REGEX" awk -F'\t' '
    FILENAME == ARGV[1] { deployed[$0] = 1; next }
    FILENAME == ARGV[2] { entries[$0] = 1; next }
    FILENAME == ARGV[3] { composer[$0] = 1; next }
    {
      path = $2
      if (path ~ /^[-\/]/ || index(path, "..")) category = "unsafe"
      else if (path ~ ENVIRON["PROTECTED"]) category = "protected"
      else if (path in deployed) category = "deployed"
      else if ($1 == "listed") category = "listed"
      else if (path ~ /^wp-content\/(plugins|themes|mu-plugins)\/[^\/]+\//) {
        split(path, p, "/")
        entry = p[1] "/" p[2] "/" p[3]
        name = tolower(p[3])
        sub(/\.php$/, "", name)
        category = ((entry in entries) || (name in composer)) ? "old-version" : "removed-entry"
      }
      else if (path ~ /^wp-content\//) category = (path ~ /^wp-content\/(plugins|themes|mu-plugins)\/[^\/]+$/) ? "removed-entry" : "wp-content-data"
      else category = "site-file"
      print category "\t" path
    }' "$TMP_DIR/prune.deployed" "$TMP_DIR/prune.entries" "$TMP_DIR/prune.composer" "$TMP_DIR/prune.listed" >"$TMP_DIR/prune.classified"
  awk -F'\t' '$1 == "old-version" || $1 == "site-file" { print $2 }' "$TMP_DIR/prune.classified" >"$TMP_DIR/prune.remove"
}

# "<category>|<label>" for the categories prune removes (remove) or keeps (keep).
prune_categories() {
  if [ "$1" = remove ]; then
    echo "old-version|Older files of plugins, themes and mu-plugins still in the repo or composer.lock"
    echo "site-file|Other files deleted from the repo, outside wp-content/"
  else
    echo "deployed|In the server's deploy commit (deploys still install them)"
    echo "listed|Matched by the include or exclude list"
    echo "removed-entry|In plugins, themes or mu-plugins no longer in the repo or composer.lock (they may be installed on the server; remove them in WordPress)"
    echo "wp-content-data|Other wp-content/ content (uploads, languages, caches, plugin data)"
    echo "protected|Secrets and server configuration"
    echo "unsafe|Paths the removal refuses (absolute, containing .., or starting with -)"
  fi
}

# Print the classified files: each category with its count, grouped by plugin,
# theme or top-level folder, or every file with --verbose.
prune_report() {
  local section category label count
  for section in remove keep; do
    echo
    if [ "$section" = remove ]; then
      echo "## Files to remove: $(wc -l <"$TMP_DIR/prune.remove" | tr -d ' ')"
    else
      echo "## Files kept: $(awk -F'\t' '$1 != "old-version" && $1 != "site-file"' "$TMP_DIR/prune.classified" | wc -l | tr -d ' ')"
    fi
    while IFS='|' read -r category label; do
      count="$(awk -F'\t' -v c="$category" '$1 == c' "$TMP_DIR/prune.classified" | wc -l | tr -d ' ')"
      [ "$count" -gt 0 ] || continue
      echo "  $label: $count"
      awk -F'\t' -v c="$category" -v verbose="$verbose" '
        $1 != c { next }
        verbose == "true" { print "    " $2; next }
        {
          key = $2
          if (key ~ /^wp-content\/(plugins|themes|mu-plugins)\/[^\/]+\//) { split(key, p, "/"); key = p[1] "/" p[2] "/" p[3] "/" }
          else if (key ~ /^wp-content\/[^\/]+\//) { split(key, p, "/"); key = p[1] "/" p[2] "/" }
          else if (key ~ /\//) key = substr(key, 1, index(key, "/"))
          if (!(key in n)) order[++count] = key
          n[key]++
        }
        END { for (i = 1; i <= count; i++) { k = order[i]; printf "    %s%s\n", k, (n[k] > 1 || k ~ /\/$/ ? "  " n[k] " file(s)" : "") } }' "$TMP_DIR/prune.classified"
    done < <(prune_categories "$section")
  done
}

# Stream the files to remove from the server into a local tarball, and check it
# holds every one of them. Sets PRUNE_BACKUP.
prune_backup() {
  local dir="${DEPLOY_PRUNE_BACKUP_DIR:-${HOME:?}/wp-deploy-backups}"
  case "$dir" in /*) ;; *) dir="$PROJECT_DIR/$dir" ;; esac
  mkdir -p "$dir" || die "could not create the backup folder $dir"
  PRUNE_BACKUP="$dir/$(basename "$(git rev-parse --show-toplevel)")-$TARGET_NAME-$(date +%Y%m%d-%H%M%S).tar.gz"
  log "Backing up $(wc -l <"$TMP_DIR/prune.remove" | tr -d ' ') file(s) to $PRUNE_BACKUP"
  remote_bash_input 'cd "$1" && tar -czf - -T -' "$REMOTE_WEBROOT" <"$TMP_DIR/prune.remove" >"$PRUNE_BACKUP" ||
    die "backing up the files failed. Nothing was removed."
  tar -tzf "$PRUNE_BACKUP" | grep -v '/$' | sort >"$TMP_DIR/prune.backed-up" || true
  sort "$TMP_DIR/prune.remove" | cmp -s - "$TMP_DIR/prune.backed-up" ||
    die "the backup $PRUNE_BACKUP does not hold every file to remove. Nothing was removed."
}

# List old files on the server; with --delete, back them up, remove them and audit.
prune_server() {
  local delete="$1" server_rev left
  echo "wp-deploy $WP_DEPLOY_VERSION"
  if [ "$delete" = true ]; then
    log "Prune of $TARGET_NAME ($SSH_HOST:$REMOTE_WEBROOT). Removes the files listed below, after a backup."
  else
    log "Prune of $TARGET_NAME ($SSH_HOST:$REMOTE_WEBROOT). Dry run: nothing is removed."
  fi
  remote_bash 'cd "$1"' "$REMOTE_WEBROOT" || die "could not reach $SSH_HOST:$REMOTE_WEBROOT"
  # Files the last deploy installed are never stale; without its commit, prune can't tell which they are.
  server_rev="$(remote_ref)" || die "could not read $REMOTE. prune needs the server's deploy commit (on WP Engine, Git Push access)."
  [ -n "$server_rev" ] || die "$TARGET_NAME has no $REMOTE_BRANCH_NAME branch. Deploy first."
  fetch_remote_rev "$server_rev"
  git cat-file -e "$server_rev^{commit}" 2>/dev/null || die "could not fetch the server's deploy commit $server_rev"
  echo "Server $REMOTE_BRANCH_NAME: $server_rev"
  deployed_paths "$server_rev" >"$TMP_DIR/prune.deployed"
  server_orphans files >"$TMP_DIR/prune.orphans"
  prune_classify
  prune_report
  echo
  printf 'prune: %s file(s) to remove, %s kept\n' "$(wc -l <"$TMP_DIR/prune.remove" | tr -d ' ')" \
    "$(($(wc -l <"$TMP_DIR/prune.classified") - $(wc -l <"$TMP_DIR/prune.remove")))"

  if [ ! -s "$TMP_DIR/prune.remove" ]; then
    log "Nothing to remove"
    return 0
  fi
  if [ "$delete" != true ]; then
    log "Dry run: nothing removed. To back up and remove them, run: bash _build/deploy.sh prune $TARGET_NAME --delete"
    return 0
  fi

  prune_backup
  # A deploy since the check may have installed one of these files again.
  [ "$(remote_ref)" = "$server_rev" ] ||
    die "$TARGET_NAME's $REMOTE_BRANCH_NAME changed while prune ran. Nothing was removed; run prune again. Backup: $PRUNE_BACKUP"
  awk '{ print "stale\t" $0 }' "$TMP_DIR/prune.remove" >"$TMP_DIR/verify.bad"
  if [ "$PLATFORM" = cloudways ]; then
    # Under the hook's deploy lock, and only while the branch is still the commit checked.
    PRUNE_LOCK_REV="$server_rev" remove_stale_files "deleted from the repo but still on the server"
  else
    remove_stale_files "deleted from the repo but still on the server"
  fi
  left="$(remote_bash_input '
    cd "$1" || exit 1
    while IFS= read -r path; do
      if [ -e "$path" ] || [ -L "$path" ]; then printf "%s\n" "$path"; fi
    done
    exit 0' "$REMOTE_WEBROOT" <"$TMP_DIR/prune.remove")" || die "could not check the server after removing files. Backup: $PRUNE_BACKUP"
  [ -z "$left" ] || die "$(count_lines "$left") file(s) are still on the server:\n$(head -n 20 <<<"$left" | sed 's/^/    /')\nBackup: $PRUNE_BACKUP"
  log "Removed $(wc -l <"$TMP_DIR/prune.remove" | tr -d ' ') file(s). Backup: $PRUNE_BACKUP"
  echo
  audit_server
}

# --- Composer checks ---------------------------------------------------------

# The folder holding composer.lock at HEAD, as a HEAD: path prefix: next to
# WordPress, then next to _build/, then at the repo root. Returns 1 when there is none.
composer_dir() {
  local dir
  for dir in ./ "$(git -C "$PROJECT_DIR" rev-parse --show-prefix)" ""; do
    if git cat-file -e "HEAD:${dir}composer.lock" 2>/dev/null; then
      printf '%s' "$dir"
      return 0
    fi
  done
  return 1
}

composer_lock() {
  local dir
  dir="$(composer_dir)" || return 0
  git show "HEAD:${dir}composer.lock"
}

# composer.json next to composer.lock.
composer_json() {
  local dir
  dir="$(composer_dir)" || return 0
  git show "HEAD:${dir}composer.json" 2>/dev/null || true
}

# awk program: read a JSON document on stdin and print what `mode` asks for.
#   mode=requires  the keys of the root "require" and "require-dev" objects
#   mode=packages  "<name>\t<type>" for each package in the root "packages"
#                  and "packages-dev" arrays (composer.lock)
# A small tokenizer: it tracks nesting, strings and escapes across lines, so
# formatting doesn't matter and nested "require" objects are ignored.
# shellcheck disable=SC2016
COMPOSER_JSON_AWK='
  { text = text $0 "\n" }
  END {
    n = length(text); depth = 0; collect = 0; pkg = 0
    for (i = 1; i <= n; i++) {
      c = substr(text, i, 1)
      if (c == "\"") {
        str = ""
        for (i++; i <= n; i++) {
          c = substr(text, i, 1)
          if (c == "\\") { i++; c = substr(text, i, 1); if (c != "/") str = str "\\"; str = str c; continue }
          if (c == "\"") break
          str = str c
        }
        if (kind[depth] == "{" && want_key[depth]) {
          key[depth] = str; want_key[depth] = 0
          if (depth == collect) print str
        } else if (depth == pkg && key[depth] == "name") {
          pkg_name = str
        } else if (depth == pkg && key[depth] == "type") {
          pkg_type = str
        }
      } else if (c == "{" || c == "[") {
        depth++; kind[depth] = c; want_key[depth] = (c == "{"); key[depth] = ""
        if (mode == "requires" && depth == 2 && c == "{" && kind[1] == "{" &&
            (key[1] == "require" || key[1] == "require-dev")) collect = depth
        if (mode == "packages" && depth == 3 && c == "{" && kind[2] == "[" &&
            (key[1] == "packages" || key[1] == "packages-dev")) { pkg = depth; pkg_name = ""; pkg_type = "" }
      } else if (c == "}" || c == "]") {
        if (depth == collect) collect = 0
        if (depth == pkg) { if (pkg_name != "") print pkg_name "\t" pkg_type; pkg = 0 }
        depth--
      } else if (c == ",") {
        if (kind[depth] == "{") want_key[depth] = 1
      }
    }
  }'

# Package names that composer.json requires (require and require-dev), without
# platform requirements such as php and ext-*. Reads JSON on stdin.
composer_json_requires() {
  awk -v mode=requires "$COMPOSER_JSON_AWK" | tr 'A-Z' 'a-z' |
    grep -Ev '^(php(-.*)?|hhvm|ext-.*|lib-.*|composer(-plugin-api|-runtime-api)?)$' | sort -u || true
}

# "<name>\t<type>" for each package in composer.lock (packages and packages-dev).
composer_lock_entries() {
  composer_lock | awk -v mode=packages "$COMPOSER_JSON_AWK"
}

# Package names in composer.lock, lowercased.
composer_lock_packages() {
  composer_lock_entries | cut -f1 | tr 'A-Z' 'a-z' | sort -u
}

# The section listing composer.json requirements that composer.lock lacks.
# Prints nothing when either file is missing.
print_composer_drift() {
  local json missing
  json="$(composer_json)"
  [ -n "$json" ] || return 0
  missing="$(comm -23 <(printf '%s\n' "$json" | composer_json_requires) <(composer_lock_packages) |
    grep -v '^$' || true)"
  echo
  echo "## composer.json requirements missing from composer.lock"
  echo "  composer install installs only what composer.lock lists."
  echo "  Run composer update <package> and commit composer.lock."
  print_list "$missing"
  echo "composer.json requirements missing from composer.lock: $(count_lines "$missing")"
}

# Plugin and mu-plugin names that composer.lock installs into wp-content/plugins or mu-plugins.
composer_plugins() {
  composer_lock_entries |
    awk -F'\t' '$2 ~ /^wordpress-(plugin|muplugin)$/ { sub(/.*\//, "", $1); print $1 }' | sort -u
}

# --- Plugin reports ----------------------------------------------------------

# Keep plugin and mu-plugin entries (folders and .php files) from a list of wp-content paths.
plugin_entries_only() {
  grep -E '^wp-content/(plugins|mu-plugins)/[^/]+$' | grep -Ev '/(\.[^/]*|index\.php)$' | grep -E '(\.php|/[^.]+)$' || true
}

# Remote (or local) script: for each plugin entry on stdin, print "<entry>\t<version>"
# from its plugin header ("-" when there is none). Needs no git or WP-CLI.
# shellcheck disable=SC2016
PLUGIN_VERSION_SCRIPT='
  cd "$1" || exit 1
  header_version() {
    head -n 60 -- "$1" 2>/dev/null | grep -iE "^[[:space:]/*#@]*version:" | head -n 1 |
      sed -E "s/^[^:]*:[[:space:]]*//; s/[[:space:]*\/]*$//"
  }
  while IFS= read -r entry; do
    version=""
    if [ -f "$entry" ]; then
      version="$(header_version "$entry")"
    elif [ -d "$entry" ]; then
      for file in "$entry"/*.php; do
        [ -f "$file" ] || continue
        if head -n 60 -- "$file" | grep -qiE "^[[:space:]/*#@]*plugin name:"; then
          version="$(header_version "$file")"
          break
        fi
      done
    fi
    printf "%s\t%s\n" "$entry" "${version:--}"
  done
  exit 0'

# Plugins and mu-plugins that composer.lock doesn't install, one per line:
# <repo|server>\t<entry>\t<status>\t<version>\t<note>. "repo" entries are committed
# to the repo; "server" entries exist only on the server.
# Args: entries, WP-CLI csv (name,status,version; may be empty), "<entry>\t<version>" lines.
unmanaged_plugins() {
  local entries="$1" status_csv="$2" versions="$3" composer excludes entry name status version group note
  composer="$(composer_plugins)"
  excludes="$(read_list "$EXCLUDE_FILE")"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    name="$(basename "$entry")"
    name="${name%.php}"
    if printf '%s\n' "$composer" | grep -Fqx -- "$name"; then continue; fi
    if [ -n "$(git ls-files -- "$entry")" ]; then group=repo; else group=server; fi
    status="$(printf '%s\n' "$status_csv" | awk -F, -v n="$name" '$1 == n && !found { print $2; found = 1 }')"
    version="$(printf '%s\n' "$status_csv" | awk -F, -v n="$name" '$1 == n && !found { print $3; found = 1 }')"
    if [ -z "$version" ]; then
      version="$(printf '%s\n' "$versions" | awk -F'\t' -v e="$entry" '$1 == e && !found { print $2; found = 1 }')"
    fi
    note=""
    if printf '%s\n' "$excludes" | grep -Eqx "${entry//./\\.}(/|/\\*)?"; then note="excluded from deploys"; fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$group" "$entry" "${status:-unknown}" "${version:--}" "$note"
  done <<<"$entries"
}

# Print the "Not managed by composer" section. Mode "server" prints both groups;
# "repo" (the local report) prints only the committed group.
print_unmanaged() {
  local rows="$1" mode="$2" repo_rows server_rows
  repo_rows="$(printf '%s\n' "$rows" | awk -F'\t' '$1 == "repo"')"
  server_rows="$(printf '%s\n' "$rows" | awk -F'\t' '$1 == "server"')"
  echo "## Not managed by composer"
  echo "  Plugins and mu-plugins that composer.lock doesn't install. Informational: it shows what was added outside composer."
  [ -n "$(composer_lock)" ] || echo "  (no composer.lock found, so every plugin is listed)"
  echo "  (a) Committed to the repo:"
  print_unmanaged_rows "$repo_rows"
  if [ "$mode" = server ]; then
    echo "  (b) On the server only (added outside the repo):"
    print_unmanaged_rows "$server_rows"
    echo "Not managed by composer: $(count_lines "$repo_rows") committed to the repo, $(count_lines "$server_rows") on the server only"
  else
    echo "Not managed by composer: $(count_lines "$repo_rows") committed to the repo"
  fi
}

print_unmanaged_rows() {
  if [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; then
    echo "    none"
  else
    printf '%s\n' "$1" | awk -F'\t' '{ printf "%s\t%s\t%s%s\n", $2, $3, $4, ($5 == "" ? "" : "\t(" $5 ")") }' |
      align_columns tab | sed 's/[[:space:]]*$//; s/^/    /'
  fi
}

# Local report, no SSH: plugins and mu-plugins committed to the repo that composer doesn't manage.
local_plugin_report() {
  local entries versions
  entries="$(git ls-tree --name-only HEAD -- wp-content/plugins/ wp-content/mu-plugins/ | plugin_entries_only)"
  versions="$(printf '%s\n' "$entries" | grep -v '^$' | bash -c "$PLUGIN_VERSION_SCRIPT" _ "$WP_DIR" || true)"
  echo "wp-deploy $WP_DEPLOY_VERSION"
  log "Plugins in $WP_DIR at HEAD $(git rev-parse --short HEAD). Local only; status needs the server (run audit)."
  print_unmanaged "$(unmanaged_plugins "$entries" "" "$versions" | awk -F'\t' 'BEGIN { OFS = FS } { $3 = "-"; print }')" repo
  print_composer_drift
}

# One line per plugin on the server: <name> <status> <source>.
plugin_inventory() {
  local entries="$1" status_csv="$2" composer excludes entry name status source
  composer="$(composer_plugins)"
  excludes="$(read_list "$EXCLUDE_FILE")"
  while IFS= read -r entry; do
    case "$entry" in wp-content/plugins/*) ;; *) continue ;; esac
    name="${entry#wp-content/plugins/}"
    case "$name" in '' | .* | index.php) continue ;; *.php) ;; *.*) continue ;; esac
    name="${name%.php}"
    status="$(printf '%s\n' "$status_csv" | awk -F, -v n="$name" '$1 == n && !found { print $2; found = 1 }')"
    if printf '%s\n' "$composer" | grep -x "$name" >/dev/null; then
      source=composer
    elif [ -n "$(git ls-files -- "$entry")" ]; then
      source=tracked
    else
      source=untracked
    fi
    if printf '%s\n' "$excludes" | grep -Eqx "wp-content/plugins/$name(/|/\\*)?"; then
      source="$source,excluded"
    fi
    if [ -z "$status" ]; then
      # WP-CLI lists every directory with a plugin header; missing means no plugin file.
      if [ -n "$status_csv" ]; then status=no-plugin-file; else status=unknown; fi
    fi
    printf '%s %s %s\n' "$name" "$status" "$source"
  done <<<"$entries" | align_columns
}

# Align whitespace-separated columns, or tab-separated ones with "tab".
align_columns() {
  if ! command -v column >/dev/null; then
    tr '\t' ' '
  elif [ "${1:-}" = tab ]; then
    column -t -s "$(printf '\t')"
  else
    column -t
  fi
}

# Summarise orphaned files per plugin/theme directory.
group_orphans() {
  local orphans="$1" status_csv="$2" entry count note
  printf '%s\n' "$orphans" | grep -v '^$' |
    awk '{ if ($0 ~ /^wp-content\/(plugins|themes|mu-plugins)\/[^\/]+\//) { split($0, p, "/"); print p[1] "/" p[2] "/" p[3] "/" } else print }' |
    sort | uniq -c | while read -r count entry; do
      note=""
      case "$entry" in
        */)
          if [ -n "$(git ls-files -- "$entry")" ]; then
            note="$count stale file(s) from older versions; still in repo"
          else
            note="$count file(s); no longer in repo"
          fi
          ;;
      esac
      printf '%s\n' "$(annotate_plugins "${entry%/}" "$status_csv")${note:+ - $note}"
    done
}

annotate_plugins() {
  local entries="$1" status_csv="$2" entry name status
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    name="$(basename "$entry")"
    name="${name%.php}"
    status="$(printf '%s\n' "$status_csv" | awk -F, -v n="$name" '$1 == n && !found { print $2; found = 1 }')"
    printf '%s%s\n' "$entry" "${status:+ ($status)}"
  done <<<"$entries"
}

count_lines() {
  printf '%s\n' "$1" | grep -c -v '^$' || true
}

print_list() {
  if [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; then
    echo "  none"
  else
    printf '%s\n' "$1" | grep -v '^$' | sed 's/^/  /'
  fi
}

# Create the server's bare repo if needed, then write the hook and its settings.
install_hook() {
  remote_bash '
    git --git-dir="$1" rev-parse --git-dir >/dev/null 2>&1 && exit 0
    echo "Creating bare repository $1"
    mkdir -p "$1" && git init -q --bare "$1"' "$REMOTE_GIT_DIR" ||
    die "could not create $REMOTE_GIT_DIR"
  log "Writing $SSH_HOST:$REMOTE_GIT_DIR/$HOOK_CONFIG_NAME:"
  hook_config | sed 's/^/    /'
  hook_config | remote_bash_input 'cat >"$1.new" && mv "$1.new" "$1"' "$REMOTE_GIT_DIR/$HOOK_CONFIG_NAME" ||
    die "writing $HOOK_CONFIG_NAME failed"
  log "Installing $(basename "$HOOK_FILE") as $SSH_HOST:$REMOTE_GIT_DIR/hooks/post-receive"
  remote_bash_input 'cat >"$1.new" && chmod +x "$1.new" && mv "$1.new" "$1"' "$REMOTE_GIT_DIR/hooks/post-receive" <"$HOOK_FILE" ||
    die "hook install failed"
  [ "$(installed_hook_state)" = "$(expected_hook_state)" ] || die "installed hook does not match after install"
  log "Hook installed"
}

usage() {
  echo "wp-deploy $WP_DEPLOY_VERSION"
  sed -n '/^# Usage/,/^# The deploy commit/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 1
}

main() {
  local command="deploy" dry_run=false delete=false from="" target
  case "${1:-}" in
    audit | install-hook | prune | verify)
      command="$1"
      shift
      ;;
    --version)
      echo "wp-deploy $WP_DEPLOY_VERSION"
      return 0
      ;;
    plugins)
      [ $# -eq 1 ] || die "plugins takes no target: it reads only the local repo"
      cd "$PROJECT_DIR"
      load_env_file .env
      load_env_file "$CONFIG_FILE"
      apply_settings
      cd "$WP_DIR"
      local_plugin_report
      return 0
      ;;
    '' | -h | --help) usage ;;
  esac
  [ $# -ge 1 ] || usage
  target="$1"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      --verbose) verbose=true ;;
      --delete) delete=true ;;
      --from)
        [ -n "${2:-}" ] || die "--from needs the server's commit before the deploy"
        from="$2"
        shift
        ;;
      *) die "unknown option '$1'" ;;
    esac
    shift
  done
  [ -z "$from" ] || [ "$command" = verify ] || die "--from only applies to verify"
  [ "$command" != verify ] || [ "$dry_run" = false ] || die "verify pushes nothing; it takes no --dry-run"
  [ "$command" != install-hook ] || [ "$dry_run" = false ] || die "install-hook has no dry run; it writes the hook and its settings to the server"
  [ "$delete" = false ] || [ "$command" = prune ] || die "--delete only applies to prune"
  [ "$delete" = false ] || [ "$dry_run" = false ] || die "prune is a dry run unless you pass --delete; pass one or the other"

  cd "$PROJECT_DIR"
  load_env_file .env
  load_env_file "$CONFIG_FILE"
  apply_settings
  cd "$WP_DIR"
  WP_PREFIX="$(git rev-parse --show-prefix)" || die "$WP_DIR is not in a Git repository"
  WP_PREFIX="${WP_PREFIX%/}"
  if [ "$command" = deploy ] && [ "$dry_run" = true ]; then REMOTE_SETTINGS_OPTIONAL=true; fi
  resolve_target "$target"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wp-deploy.XXXXXX")"
  trap cleanup EXIT

  case "$command" in
    audit)
      audit_server
      return 0
      ;;
    install-hook)
      require_cloudways "install-hook"
      install_hook
      return 0
      ;;
    prune)
      prune_server "$delete"
      return 0
      ;;
    verify)
      verify_deploy "$from"
      return 0
      ;;
  esac

  log "wp-deploy $WP_DEPLOY_VERSION: $TARGET_NAME on $PLATFORM, WordPress at ${WP_PREFIX:-the repo root}"
  check_clean_tree
  run_build
  package
  show_payload
  if [ "$dry_run" = true ]; then
    [ "$PLATFORM" != wpe ] || show_removals
    log "Dry run: nothing pushed"
    return 0
  fi

  case "$PLATFORM" in
    cloudways) deploy_cloudways ;;
    kinsta) deploy_kinsta ;;
    wpe) deploy_wpe ;;
  esac
  log "Deploy to $TARGET_NAME complete"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
