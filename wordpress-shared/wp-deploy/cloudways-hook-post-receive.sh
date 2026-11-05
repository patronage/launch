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
# Removes files deleted since the last commit this hook installed in full
# (recorded in <git dir>/deploy-installed-rev), except protected paths, so a
# push Git accepted but the hook refused doesn't hide its deletions from the
# next one. Hooks take <git dir>/deploy.lock in turn, and one whose commit is no
# longer the branch tip by then installs nothing.
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
FORBIDDEN_REGEX="${DEPLOY_FORBIDDEN_PAYLOAD_REGEX:-(^|/)\.env(\.[^/]*)?$|(^|/)wp-config\.php$|^wp-content/uploads/}"
# Example .env files that hold no values (a plugin's .env.example) are allowed.
ENV_TEMPLATE_REGEX='(^|/)\.env\.(example|sample|dist|template)$'
INSTALLED_FILE="$GIT_DIR/deploy-installed-rev"
ATTEMPTED_FILE="$GIT_DIR/deploy-attempted-revs"
LOCK_FILE="$GIT_DIR/deploy.lock"
LOCK_WAIT="${DEPLOY_LOCK_WAIT:-600}"

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
      if [[ "$rel" =~ $FORBIDDEN_REGEX && ! "$rel" =~ $ENV_TEMPLATE_REGEX ]]; then echo "$rel"; fi
    done)"
  if [ -n "$forbidden" ]; then
    echo "Refusing to install: the payload contains protected paths:"
    echo "$forbidden"
    return 1
  fi

  # Write the WordPress folder's files into the webroot with git itself, from a
  # temporary index of that folder's own tree, so they land at the webroot however
  # many folders deep it sits in the repo. On Cloudways, wp-content and its plugins
  # and themes folders belong to the application user, not the SSH user this hook
  # runs as. tar sets the mode of every folder in the archive, which only a folder's
  # owner may do, so it failed after writing every file. checkout-index only creates
  # folders that are missing and leaves existing ones alone.
  index="$GIT_DIR/deploy-index.$$"
  rm -f "$index" "$index.dirs" "$index.bad"
  if ! GIT_INDEX_FILE="$index" git --git-dir="$GIT_DIR" read-tree "$newrev${prefix:+:$WORDPRESS_FOLDER}"; then
    rm -f "$index"
    echo "Reading $newrev failed"
    return 1
  fi

  # checkout-index -f replaces whatever is in a file's way, deleting a folder of
  # server-only files with it. Refuse the install when a payload file would land on
  # a folder, or a payload folder on a file or a link.
  while IFS= read -r -d '' path; do
    if [ -d "$TARGET/$path" ] && [ ! -L "$TARGET/$path" ]; then
      printf '    %s (a folder on the server)\n' "$path" >>"$index.bad"
    fi
    rel="$path"
    while [ "${rel%/*}" != "$rel" ]; do
      rel="${rel%/*}"
      printf '%s\n' "$rel"
    done >>"$index.dirs"
  done < <(GIT_INDEX_FILE="$index" git --git-dir="$GIT_DIR" ls-files -z)
  if [ -s "$index.dirs" ]; then
    sort -u "$index.dirs" | while IFS= read -r rel; do
      if [ -L "$TARGET/$rel" ] || { [ -e "$TARGET/$rel" ] && [ ! -d "$TARGET/$rel" ]; }; then
        printf '    %s/ (a file or link on the server)\n' "$rel"
      fi
    done >>"$index.bad"
  fi
  if [ -s "$index.bad" ]; then
    echo "Refusing to install: payload paths collide with the server's files:"
    cat "$index.bad"
    rm -f "$index" "$index.dirs" "$index.bad"
    return 1
  fi

  # From here on the webroot changes. Note the commit, so that if this install
  # stops partway the next one also removes the files it wrote.
  if ! printf '%s\n' "$newrev" >>"$ATTEMPTED_FILE"; then
    rm -f "$index" "$index.dirs" "$index.bad"
    echo "Writing $ATTEMPTED_FILE failed"
    return 1
  fi
  if ! GIT_INDEX_FILE="$index" git --git-dir="$GIT_DIR" --work-tree="$TARGET" checkout-index -a -f; then
    rm -f "$index" "$index.dirs" "$index.bad"
    echo "Extracting $newrev failed"
    return 1
  fi
  rm -f "$index" "$index.dirs" "$index.bad"

  # Deleted since the last full install, plus anything an install that stopped
  # partway since then wrote and this commit doesn't have.
  deleted="$(
    for rev in ${oldrev:+"$oldrev"} $(attempted_revs); do
      [ "$rev" != "$newrev" ] || continue
      git --git-dir="$GIT_DIR" diff --name-only --no-renames --diff-filter=D "$rev" "$newrev" -- "${prefix:-.}" || exit 1
    done | sort -u
  )" || { echo "Listing deleted files failed"; return 1; }
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

# Hold the deploy lock until the hook exits: flock where the server has it,
# else a lock folder. deploy.sh prune takes the same lock to delete files.
take_lock() {
  local waited=0 pid
  if command -v flock >/dev/null; then
    exec 9>>"$LOCK_FILE" || return 1
    flock -w "$LOCK_WAIT" 9
    return
  fi
  until mkdir "$LOCK_FILE.d" 2>/dev/null; do
    # A holder that died without cleaning up (killed, server restart) left its pid.
    pid="$(cat "$LOCK_FILE.d/pid" 2>/dev/null)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Removing a stale deploy lock left by process $pid"
      rm -f "$LOCK_FILE.d/pid"
      rmdir "$LOCK_FILE.d" 2>/dev/null
      continue
    fi
    [ "$waited" -lt "$LOCK_WAIT" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
  echo "$$" >"$LOCK_FILE.d/pid"
  trap 'rm -f "$LOCK_FILE.d/pid"; rmdir "$LOCK_FILE.d" 2>/dev/null' EXIT
}

# The commit this hook last installed in full, if Git still has it.
installed_rev() {
  local rev
  [ -f "$INSTALLED_FILE" ] || return 0
  rev="$(tr -d '[:space:]' <"$INSTALLED_FILE")"
  if [ -n "$rev" ] && git --git-dir="$GIT_DIR" cat-file -e "$rev^{commit}" 2>/dev/null; then
    printf '%s' "$rev"
  fi
}

# Commits whose install started writing the webroot since the last full
# install, if Git still has them.
attempted_revs() {
  local rev
  [ -f "$ATTEMPTED_FILE" ] || return 0
  sort -u "$ATTEMPTED_FILE" | while IFS= read -r rev; do
    if [ -n "$rev" ] && git --git-dir="$GIT_DIR" cat-file -e "$rev^{commit}" 2>/dev/null; then
      printf '%s\n' "$rev"
    fi
  done
}

record_installed() {
  printf '%s\n' "$1" >"$INSTALLED_FILE.$$" && mv -f "$INSTALLED_FILE.$$" "$INSTALLED_FILE" &&
    rm -f "$ATTEMPTED_FILE"
}

echo "Post-receive: triggered at $(date)"
status=0
locked=false
while read -r oldrev newrev ref; do
  if [ "$ref" != "refs/heads/$BRANCH" ] || [ "$newrev" = "$ZERO_REV" ]; then
    echo "Ref $ref received. Ignoring."
    continue
  fi
  if [ "$locked" = false ]; then
    take_lock || { echo "Another deploy holds $LOCK_FILE; gave up after ${LOCK_WAIT}s"; echo "Deployment failed"; status=1; continue; }
    locked=true
  fi
  tip="$(git --git-dir="$GIT_DIR" rev-parse -q --verify "refs/heads/$BRANCH")"
  if [ "$tip" != "$newrev" ]; then
    echo "Skipping $newrev: $BRANCH is now $tip, which its own push installs"
    echo "Deployment failed"
    status=1
    continue
  fi
  base="$(installed_rev)"
  if [ -n "$base" ] && [ "$base" != "$oldrev" ]; then
    echo "Comparing against $base, the last commit installed in full"
  fi
  echo "Ref $ref received. Deploying $BRANCH to $TARGET..."
  if (deploy "${base:-$oldrev}" "$newrev") && record_installed "$newrev"; then
    echo "Deployment successful"
    echo "DEPLOY_OK $newrev"
  else
    echo "Deployment failed"
    status=1
  fi
done
exit "$status"
