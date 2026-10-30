#!/bin/bash
# Cloudways post-receive hook, shared by every site and environment. deploy.sh
# pushes a packaged commit; this installs its WordPress folder into the webroot.
#
# Install with `bash _build/deploy.sh install-hook <target>`, which copies this
# file to <git dir>/hooks/post-receive and writes its settings to
# <git dir>/deploy-hook.env:
#   DEPLOY_WEBROOT                  directory to install into (required)
#   DEPLOY_BRANCH                   branch to install (default master)
#   DEPLOY_WORDPRESS_FOLDER         folder in the repo holding WordPress ("" = repo root)
#   DEPLOY_PROTECTED_REGEX          paths never deleted
#   DEPLOY_FORBIDDEN_PAYLOAD_REGEX  paths that make the hook refuse the payload
# deploy.sh refuses to deploy when either installed file differs from the repo.
#
# Removes files the push deleted from the deployed tree, except protected paths.
# Files that were never deployed from git (plugins installed on the server,
# uploads, wp-config.php) are never touched.
# Prints "DEPLOY_OK <rev>" only when everything succeeded; deploy.sh checks for it.
set -uo pipefail

ZERO_REV="0000000000000000000000000000000000000000"
GIT_DIR="$(cd "${GIT_DIR:-.}" && pwd)"
CONFIG="$GIT_DIR/deploy-hook.env"

# Read KEY=VALUE settings without evaluating them; values already set win.
if [ -f "$CONFIG" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    case "$key" in DEPLOY_[A-Z_]*) ;; *) continue ;; esac
    [ -z "${!key+x}" ] || continue
    export "$key=${line#*=}"
  done <"$CONFIG"
fi

TARGET="${DEPLOY_WEBROOT:-}"
BRANCH="${DEPLOY_BRANCH:-master}"
WORDPRESS_FOLDER="${DEPLOY_WORDPRESS_FOLDER:-}"
PROTECTED_REGEX="${DEPLOY_PROTECTED_REGEX:-^(wp-config\.php|\.htaccess)$|^wp-content/uploads/}"
FORBIDDEN_REGEX="${DEPLOY_FORBIDDEN_PAYLOAD_REGEX:-(^|/)\.env$|(^|/)wp-config\.php$|^wp-content/uploads/}"

# Paths a deploy never deletes, even when the repo stops tracking them.
is_protected() {
  case "$1" in
    /* | *..*) return 0 ;;
    wp-content | wp-content/plugins | wp-content/themes | wp-content/mu-plugins) return 0 ;;
  esac
  [[ "$1" =~ $PROTECTED_REGEX || "$1/" =~ $PROTECTED_REGEX ]]
}

# Remove now-empty parent directories of a deleted file, stopping at protected ones.
prune_empty_dirs() {
  local dir="$1"
  while [ "$dir" != "." ] && ! is_protected "$dir"; do
    rmdir -- "$dir" 2>/dev/null || break
    dir="$(dirname "$dir")"
  done
}

deploy() {
  local oldrev="$1" newrev="$2" prefix="" deleted forbidden path rel
  [ -z "$WORDPRESS_FOLDER" ] || prefix="$WORDPRESS_FOLDER/"

  if [ -z "$TARGET" ]; then
    echo "No DEPLOY_WEBROOT in $CONFIG. Run: bash _build/deploy.sh install-hook <target>"
    return 1
  fi
  cd "$TARGET" || { echo "Cannot cd to $TARGET"; return 1; }
  echo "Current directory: $(pwd)"

  if [ "$oldrev" != "$ZERO_REV" ] && git --git-dir="$GIT_DIR" cat-file -e "$oldrev^{commit}" 2>/dev/null; then
    echo "Files changed:"
    git --git-dir="$GIT_DIR" diff --name-status --no-renames "$oldrev" "$newrev" -- "${prefix:-.}" || return 1
  else
    oldrev=""
    echo "No previous revision to compare; deploying all files and removing none"
  fi

  forbidden="$(git --git-dir="$GIT_DIR" ls-tree -r --name-only "$newrev" -- "${prefix:-.}" |
    while IFS= read -r path; do
      rel="${path#"$prefix"}"
      if [[ "$rel" =~ $FORBIDDEN_REGEX ]]; then echo "$rel"; fi
    done)"
  if [ -n "$forbidden" ]; then
    echo "Refusing to install: the payload contains protected paths:"
    echo "$forbidden"
    return 1
  fi

  # Archive the WordPress folder's own tree, so its files land at the webroot
  # however many folders deep it sits in the repo.
  git --git-dir="$GIT_DIR" archive "$newrev${prefix:+:$WORDPRESS_FOLDER}" | tar -x -f - ||
    { echo "Extracting $newrev failed"; return 1; }

  [ -n "$oldrev" ] || return 0
  deleted="$(git --git-dir="$GIT_DIR" diff --name-only --no-renames --diff-filter=D "$oldrev" "$newrev" -- "${prefix:-.}")" ||
    { echo "Listing deleted files failed"; return 1; }
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    rel="${path#"$prefix"}"
    if is_protected "$rel"; then
      echo "Keeping protected path $rel"
    elif [ -d "$rel" ] && [ ! -L "$rel" ]; then
      echo "Keeping $rel (now a directory)"
    elif [ -e "$rel" ] || [ -L "$rel" ]; then
      rm -f -- "$rel" || { echo "Removing $rel failed"; return 1; }
      echo "Removed $rel"
      prune_empty_dirs "$(dirname "$rel")"
    fi
  done <<<"$deleted"
}

echo "Post-receive: triggered at $(date)"
status=0
while read -r oldrev newrev ref; do
  if [ "$ref" != "refs/heads/$BRANCH" ] || [ "$newrev" = "$ZERO_REV" ]; then
    echo "Ref $ref received. Ignoring."
    continue
  fi
  echo "Ref $ref received. Deploying $BRANCH to $TARGET..."
  if (deploy "$oldrev" "$newrev"); then
    echo "Deployment successful"
    echo "DEPLOY_OK $newrev"
  else
    echo "Deployment failed"
    status=1
  fi
done
exit "$status"
