#!/usr/bin/env bash
# Local tests for _build/deploy.sh and the Cloudways post-receive hook.
# Uses temporary repositories and a fake SSH server only; nothing touches a real server.
#   bash _build/tests/test_deploy.sh
#
# Sections:
#   1. unit checks (list parsing, remote transport, hook, verification, audit, packaging)
#   2. end-to-end deploys for every host (cloudways, wpengine, kinsta) and layout
#      (WordPress at the repo root, in wordpress/ with wordpress/_build, and in
#      wordpress/ with _build/ at the repo root, and two folders down in apps/site/)
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$BUILD_DIR/cloudways-hook-post-receive.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1 HOME="$WORK"
unset GIT_SSH_COMMAND GIT_SSH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git config --global init.defaultBranch main
git config --global advice.detachedHead false

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

write() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "${2:-content}" >"$1"
}

# Tools the WP Engine gateway has: no git. Used for remote sessions on *.ssh.wpengine.net.
# It has find, which the audit's .env scan uses.
NOGIT_BIN="$WORK/nogit-bin"
mkdir -p "$NOGIT_BIN"
for tool in bash sh cat wc cut sha1sum dirname rm rmdir ls sed tr head tail sort grep mkdir mv chmod tar gzip find; do
  if command -v "$tool" >/dev/null; then ln -s "$(command -v "$tool")" "$NOGIT_BIN/$tool"; fi
done
# The gateway has WP-CLI; a fake one reports plugin status and versions.
cat >"$NOGIT_BIN/wp" <<'WP'
#!/bin/sh
printf 'name,status,version\nreal,active,1.0\ncommitted-extra,active,1.4.2\nserver-only,inactive,2.0\nsite-mu,must-use,\n'
WP
chmod +x "$NOGIT_BIN/wp"
# Other fake servers have no WP-CLI. A stub that prints nothing keeps a WP-CLI
# installed on the developer's machine out of their results.
NOWP_BIN="$WORK/nowp-bin"
mkdir -p "$NOWP_BIN"
printf '#!/bin/sh\nexit 1\n' >"$NOWP_BIN/wp"
chmod +x "$NOWP_BIN/wp"

# --- 1. Unit checks ----------------------------------------------------------
# shellcheck source=../deploy.sh
source "$BUILD_DIR/deploy.sh"
set +e

version_line="$(sed -n 2p "$BUILD_DIR/deploy.sh")"
check "header line carries the script version" grep -q "^# wp-deploy $WP_DEPLOY_VERSION " <<<"$version_line"
check "the Version header, which pnpm wp:release reads, is the script version" grep -qx "# Version: $WP_DEPLOY_VERSION" <(sed -n 3p "$BUILD_DIR/deploy.sh")
check "--version prints the version" [ "$(bash "$BUILD_DIR/deploy.sh" --version)" = "wp-deploy $WP_DEPLOY_VERSION" ]
out="$(bash "$BUILD_DIR/deploy.sh" --help 2>&1)"
check "--help prints usage and targets" bash -c 'grep -q "^Usage" <<<"$1" && grep -q "^Targets:" <<<"$1"' _ "$out"

# Every setting deploy.sh reads is documented in deploy.env.sample.
sample="$BUILD_DIR/deploy.env.sample"
internal='^(DEPLOY_OK|DEPLOY_COMMIT|DEPLOY_TREE|DEPLOY_WEBROOT|DEPLOY_BRANCH|DEPLOY_WORDPRESS_FOLDER|DEPLOY_PROTECTED_REGEX)$'
missing=""
for name in $(grep -oE '[A-Z_]*(DEPLOY|COMPOSE)_[A-Z_]*(\$\{env\}|\$1)?[A-Z_]*' "$BUILD_DIR/deploy.sh" |
  sed -e 's/\${env}/PRODUCTION/' -e 's/\$1/PRODUCTION/' | grep -E '^(DEPLOY|COMPOSE)_' | grep -v '_$' | sort -u | grep -Ev "$internal"); do
  grep -Eq "^#? ?$name=" "$sample" || missing="$missing $name"
done
check "deploy.env.sample documents every setting${missing:+ (missing:$missing)}" [ -z "$missing" ]

printf 'first\n\n# comment\n  spaced  \r\nlast-without-newline' >"$WORK/list.txt"
got="$(read_list "$WORK/list.txt" | tr '\n' '|')"
check "read_list keeps the last line, skips blanks and comments" [ "$got" = "first|spaced|last-without-newline|" ]

# Remote scripts travel on stdin, so quotes survive gateways that strip them.
remote_shell() { PATH="$NOWP_BIN:$PATH" bash -s; }
got="$(printf 'one\ttwo\n' | remote_bash_input 'printf "[%s]" "$@"; cat' 'a b' "it's \"q\"")"
check "remote scripts get arguments and input intact" [ "$got" = "[a b][it's \"q\"]one	two" ]
got="$(remote_bash 'printf "[%s]" "$#"; cat')"
check "remote_bash sends no input" [ "$got" = "[0]" ]
write "$WORK/blob.txt" "blob content"
blob="$(PATH="$NOGIT_BIN" bash -c "$REMOTE_BLOB_HASH"'; blob_hash "$1"' _ "$WORK/blob.txt")"
check "blob hash without git matches git hash-object" [ "$blob" = "$(git hash-object "$WORK/blob.txt")" ]

# git's SSH transport gets the keepalives on top of the user's SSH command.
ssh_cmd_of() { git() { if [ "$1" = config ]; then command git "$@"; else printf '%s' "${GIT_SSH_COMMAND:-}"; fi; }; git_remote ls-remote x; }
got="$(GIT_SSH_COMMAND="ssh -i key" ssh_cmd_of)"
check "git transport keeps GIT_SSH_COMMAND and adds keepalives" [ "$got" = "ssh -i key -o ServerAliveInterval=15 -o ServerAliveCountMax=4" ]
got="$(unset GIT_SSH_COMMAND; GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0="ssh -F cfg" ssh_cmd_of)"
check "git transport keeps core.sshCommand and adds keepalives" [ "$got" = "ssh -F cfg -o ServerAliveInterval=15 -o ServerAliveCountMax=4" ]
got="$(unset GIT_SSH_COMMAND; ssh_cmd_of)"
check "git transport defaults to ssh with keepalives" [ "$got" = "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4" ]
got="$(unset GIT_SSH_COMMAND; GIT_SSH=/usr/local/bin/my-ssh ssh_cmd_of)"
check "git transport leaves a GIT_SSH program alone" [ -z "$got" ]
unset -f ssh_cmd_of

# The script's own SSH calls run GIT_SSH_COMMAND through the shell, as git does.
mkdir -p "$WORK/ssh dir"
printf '#!/bin/bash\nprintf "[%%s]" "$@"\n' >"$WORK/ssh dir/print-args"
chmod +x "$WORK/ssh dir/print-args"
# The checks above replace remote_shell, so read the real one from the script.
got="$(
  eval "$(sed -n '/^remote_shell() {/,/^}/p' "$BUILD_DIR/deploy.sh")"
  GIT_SSH_COMMAND="'$WORK/ssh dir/print-args' -i '/keys/my key'" SSH_HOST=host.invalid SSH_PORT="" remote_shell </dev/null
)"
check "remote SSH keeps quoted arguments in GIT_SSH_COMMAND" grep -q '^\[-i\]\[/keys/my key\]\[-o\]\[ConnectTimeout=15\]' <<<"$got"
check "remote SSH ends with the host and bash -s" grep -q '\[host.invalid\]\[bash\]\[-s\]$' <<<"$got"

# WP Engine's own mu-plugins count as server-managed; site mu-plugins don't.
unmatched=""
for path in wp-content/mu-plugins/mu-plugin.php wp-content/mu-plugins/slt-force-strong-passwords.php \
  wp-content/mu-plugins/force-strong-passwords/slt-force-strong-passwords.php wp-content/mu-plugins/wpengine-common/plugin.php \
  wp-content/mu-plugins/wpengine-security-auditor.php wp-content/mu-plugins/wpe-update-source-selector.php \
  wp-content/mu-plugins/wpe-cache-plugin.php wp-content/mu-plugins/wpe-cache-plugin/inc/cache.php \
  wp-content/mu-plugins/wpe-wp-sign-on-plugin.php wp-content/mu-plugins/wpe-wp-sign-on-plugin/sign-on.php; do
  grep -Eq "$(host_managed_regex wpe)" <<<"$path" || unmatched="$unmatched $path"
done
check "WP Engine mu-plugins are server-managed${unmatched:+ (unmatched:$unmatched)}" [ -z "$unmatched" ]
check "site mu-plugins are not WP Engine-managed" bash -c '! grep -Eq "$1" <<<"$2"' _ "$(host_managed_regex wpe)" "$(printf '%s\n' wp-content/mu-plugins/site-mu.php wp-content/mu-plugins/wpe-cache-plugin-extra.php wp-content/plugins/wpe-cache-plugin/x.php)"
check "Kinsta mu-plugins are server-managed" bash -c 'grep -Eq "$1" <<<wp-content/mu-plugins/kinsta-mu-plugins.php && grep -Eq "$1" <<<wp-content/mu-plugins/kinsta-mu-plugins/inc.php && ! grep -Eq "$1" <<<wp-content/mu-plugins/site-mu.php' _ "$(host_managed_regex kinsta)"
check "Cloudways adds no host-managed paths" [ -z "$(host_managed_regex cloudways)" ]
# install-hook writes FORBIDDEN_PAYLOAD_REGEX to Cloudways servers; the audit's .env check uses its .env part.
check "FORBIDDEN_PAYLOAD_REGEX is unchanged" [ "$FORBIDDEN_PAYLOAD_REGEX" = '(^|/)\.env(\.[^/]*)?$|(^|/)wp-config\.php$|^wp-content/uploads/' ]
check "ENV_FILE_REGEX is the .env part of FORBIDDEN_PAYLOAD_REGEX" [ "${FORBIDDEN_PAYLOAD_REGEX#"$ENV_FILE_REGEX|"}" = '(^|/)wp-config\.php$|^wp-content/uploads/' ]
# Host-provided file names appear only in deploy.sh's host-managed block.
stray="$(sed '/^# --- Host-managed paths/,/^# --- End of host-managed paths/d' "$BUILD_DIR/deploy.sh" | grep -nE 'kinsta-mu-plugins|wpengine-common|wpe-cache-plugin|_wpeprivate|mysql\\.sql|breeze-config' || true)"
check "host-managed lists live in one block of deploy.sh${stray:+ (found: $stray)}" [ -z "$stray" ]

# composer.json requirements, as composer_json_requires reads them.
got="$(composer_json_requires <<'JSON' | tr '\n' '|'
{
    "name": "example/site",
    "require": {
        "php": ">=8.1",
        "ext-json": "*",
        "composer/installers": "^2.0",
        "wpackagist-plugin/Mixed-Case": "^1.0",
        "wpackagist-plugin/nested": "{not a brace}"
    },
    "config": { "platform": { "php": "8.1" } },
    "require-dev": { "wpackagist-plugin/dev-tool": "*", "lib-icu": "*" },
    "extra": { "installer-paths": { "wp-content/plugins/{$name}/": ["type:wordpress-plugin"] } }
}
JSON
)"
check "composer.json requirements skip platform packages and other keys" [ "$got" = "composer/installers|wpackagist-plugin/dev-tool|wpackagist-plugin/mixed-case|wpackagist-plugin/nested|" ]
got="$(printf '{ "require": {}, "name": "x/y" }\n' | composer_json_requires)"
check "an empty require block has no requirements" [ -z "$got" ]

# Post-receive hook, pushed to directly.
SERVER="$WORK/server"
WEBROOT="$SERVER/public_html"
BARE="$SERVER/private_html/site.git"
mkdir -p "$WEBROOT"
git init -q --bare "$BARE"
cp "$HOOK" "$BARE/hooks/post-receive"
chmod +x "$BARE/hooks/post-receive"
printf 'DEPLOY_WEBROOT=%s\nDEPLOY_BRANCH=master\nDEPLOY_WORDPRESS_FOLDER=wordpress\n' "$WEBROOT" >"$BARE/deploy-hook.env"

write "$WEBROOT/wp-config.php" server-config
write "$WEBROOT/wp-content/uploads/2026/photo.jpg"
write "$WEBROOT/wp-content/plugins/server-only/server-only.php"
# Cloudways gives these folders to the application user, so the hook's SSH user
# can't change their mode. A mode the payload doesn't carry shows whether the hook
# touched it.
chmod 750 "$WEBROOT/wp-content/plugins"

SRC="$WORK/src"
git init -q "$SRC"
write "$SRC/README.md"
write "$SRC/wordpress/index-theme.php"
write "$SRC/wordpress/old-name.php"
write "$SRC/wordpress/.htaccess" repo-htaccess
write "$SRC/wordpress/wp-content/plugins/removed/removed.php"
write "$SRC/wordpress/wp-content/plugins/removed/inc/deep.php"
write "$SRC/wordpress/wp-content/plugins/kept/kept.php" v1
git -C "$SRC" add -A
git -C "$SRC" commit -qm one

out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1)"
rev="$(git -C "$SRC" rev-parse HEAD)"
check "hook: first push reports DEPLOY_OK" grep -q "DEPLOY_OK $rev" <<<"$out"
check "hook: first push extracts files" [ -f "$WEBROOT/wp-content/plugins/removed/inc/deep.php" ]
check "hook: first push keeps server wp-config.php" grep -q server-config "$WEBROOT/wp-config.php"
check "hook: existing folders keep their mode" [ "$(stat -c %a "$WEBROOT/wp-content/plugins" 2>/dev/null || stat -f %Lp "$WEBROOT/wp-content/plugins")" = 750 ]
check "hook: removes its temporary index" bash -c '! ls "$1"/deploy-index.* >/dev/null 2>&1' _ "$BARE"

git -C "$SRC" rm -q -r wordpress/wp-content/plugins/removed wordpress/.htaccess
git -C "$SRC" mv wordpress/old-name.php wordpress/new-name.php
write "$SRC/wordpress/wp-content/plugins/kept/kept.php" v2
git -C "$SRC" add -A
git -C "$SRC" commit -qm two

out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1)"
rev="$(git -C "$SRC" rev-parse HEAD)"
check "hook: second push reports DEPLOY_OK" grep -q "DEPLOY_OK $rev" <<<"$out"
check "hook: removed plugin files are deleted" [ ! -e "$WEBROOT/wp-content/plugins/removed" ]
check "hook: renamed file's old path is deleted" [ ! -e "$WEBROOT/old-name.php" ]
check "hook: renamed file's new path exists" [ -f "$WEBROOT/new-name.php" ]
check "hook: changed file is updated" grep -q v2 "$WEBROOT/wp-content/plugins/kept/kept.php"
check "hook: protected .htaccess survives deletion from repo" [ -f "$WEBROOT/.htaccess" ]
check "hook: uploads survive" [ -f "$WEBROOT/wp-content/uploads/2026/photo.jpg" ]
check "hook: server-only plugin survives" [ -f "$WEBROOT/wp-content/plugins/server-only/server-only.php" ]
check "hook: plugins directory survives" [ -d "$WEBROOT/wp-content/plugins" ]

# Post-deploy verification, with SSH replaced by a local shell.
rev2="$rev"
rev1="$(git -C "$SRC" rev-parse HEAD~1)"
REMOTE="$BARE"
REMOTE_GIT_DIR="$BARE"
REMOTE_WEBROOT="$WEBROOT"
TARGET_NAME=test
SSH_HOST=local
TMP_DIR="$WORK"
PLATFORM=cloudways
out="$(cd "$SRC/wordpress" && DEPLOY_COMMIT="$rev2" && PUSH_REF="$rev2" && verify_files "$rev1" 2>&1)" || true
check "verification passes after a good deploy" grep -q "Verified" <<<"$out"
write "$WEBROOT/wp-content/plugins/kept/kept.php" tampered
write "$WEBROOT/old-name.php"
out="$(cd "$SRC/wordpress" && DEPLOY_COMMIT="$rev2" && PUSH_REF="$rev2" && verify_files "$rev1" 2>&1)" || true
check "verification catches a mismatched file" grep -q "kept.php (server:" <<<"$out"
check "verification catches a deleted file left on the server" grep -q "old-name.php (deleted in repo" <<<"$out"
rm "$WEBROOT/old-name.php"
write "$WEBROOT/wp-content/plugins/kept/kept.php" v2

# Verification of a large changeset, run as the deploy runs it (set -e, pipefail).
# Regression: an early-exiting reader in a pipe raised SIGPIPE and killed the deploy.
big_prev="$(git -C "$SRC" rev-parse HEAD)"
mkdir -p "$SRC/wordpress/wp-content/plugins/big-plugin/includes/some/deeply/nested/directory"
for i in $(seq 1 1500); do
  echo "$i" >"$SRC/wordpress/wp-content/plugins/big-plugin/includes/some/deeply/nested/directory/file-with-a-long-name-$i.php"
done
git -C "$SRC" add -A
git -C "$SRC" commit -qm big
git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master >/dev/null 2>&1
big_rev="$(git -C "$SRC" rev-parse HEAD)"
verify_big() {
  (cd "$SRC/wordpress" && BIG_PREV="$big_prev" BIG_REV="$big_rev" WEBROOT="$WEBROOT" TMP="$WORK" bash -c '
    set -euo pipefail
    source "$1"
    remote_shell() { bash -s; }
    REMOTE_WEBROOT="$WEBROOT" TMP_DIR="$TMP" DEPLOY_COMMIT="$BIG_REV" PUSH_REF="$BIG_REV"
    verify_files "$BIG_PREV"
    echo VERIFY-FINISHED' _ "$BUILD_DIR/deploy.sh" 2>&1)
}
out="$(verify_big)" || true
check "verification of 1500 changed files completes" grep -q "Verified 1500 changed paths" <<<"$out"
check "verification of a large changeset returns to the caller" grep -q VERIFY-FINISHED <<<"$out"
echo tampered >"$WEBROOT/wp-content/plugins/big-plugin/includes/some/deeply/nested/directory/file-with-a-long-name-1499.php"
out="$(verify_big)" || true
check "large verification still catches a mismatch" grep -q "file-with-a-long-name-1499.php (server:" <<<"$out"
git -C "$SRC" reset -q --hard "$big_prev"
git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master >/dev/null 2>&1

# Split commits (as pushed to WP Engine and Kinsta) are rooted at the WordPress folder.
split1="$(git -C "$SRC" commit-tree "$rev1:wordpress" -m split1)"
split2="$(git -C "$SRC" commit-tree "$rev2:wordpress" -m split2)"
out="$(cd "$SRC/wordpress" && DEPLOY_COMMIT=unsplit && PUSH_REF="$split2" && verify_files "$split1" 2>&1)" || true
check "verification of split commits passes" grep -q "Verified" <<<"$out"
write "$WEBROOT/old-name.php"
out="$(cd "$SRC/wordpress" && DEPLOY_COMMIT=unsplit && PUSH_REF="$split2" && DEPLOY_VERIFY_ATTEMPTS=2 DEPLOY_VERIFY_WAIT=0 verify_files "$split1" 2>&1)" || true
check "split verification catches a deleted file left on the server" grep -q "old-name.php (deleted in repo" <<<"$out"
check "verification retries before failing" grep -q "checking again" <<<"$out"
# Stale-file removal (WP Engine leaves files a deploy deleted).
write "$WEBROOT/wp-content/plugins/removed/inc/deep.php"
out="$(cd "$SRC/wordpress" && DEPLOY_COMMIT=unsplit && PUSH_REF="$split2" && prepare_verify "$split1" && ! check_server_files && remove_stale_files && check_server_files && echo CLEAN 2>&1)" || true
check "stale files are listed for removal" grep -q "wp-content/plugins/removed/inc/deep.php" <<<"$out"
check "removing stale files makes verification pass" grep -q CLEAN <<<"$out"
check "stale files are removed" [ ! -e "$WEBROOT/old-name.php" ]
check "directories left empty are removed" [ ! -e "$WEBROOT/wp-content/plugins/removed" ]
check "the plugins directory is kept by stale removal" [ -d "$WEBROOT/wp-content/plugins" ]
check "server-only plugins are kept by stale removal" [ -f "$WEBROOT/wp-content/plugins/server-only/server-only.php" ]

# chain_onto_server builds on the server's deploy commit only when its history
# holds deploy commits alone; 2.0.0 to 2.2.2 deploy commits carried source history.
chain_count() { (cd "$SRC/wordpress" && DEPLOY_COMMIT="$1" && PUSH_REF="$1" && chain_onto_server "$2" >/dev/null && git rev-list --count "$PUSH_REF"); }
deploy_msg="$(printf 'Deploy x to test\n\nSource: %s\n%s 0.0.0' "$rev2" "$WP_DEPLOY_TRAILER")"
deploy1="$(git -C "$SRC" commit-tree "$rev1^{tree}" -m "$deploy_msg")"
deploy2="$(git -C "$SRC" commit-tree "$rev2^{tree}" -m "$deploy_msg")"
deploy_with_source="$(git -C "$SRC" commit-tree "$rev2^{tree}" -p "$rev2" -m "$deploy_msg")"
check "a deploy builds on a server history of deploy commits" [ "$(chain_count "$deploy2" "$deploy1")" = 2 ]
check "a deploy never builds on a server commit with source history" [ "$(chain_count "$deploy2" "$deploy_with_source")" = 1 ]
check "a deploy never builds on a server commit without the trailer" [ "$(chain_count "$deploy2" "$split1")" = 1 ]
check "a deploy with no server commit has no parent" [ "$(chain_count "$deploy2" "")" = 1 ]
check "DEPLOY_NEW_HISTORY=true starts a new history" [ "$(DEPLOY_NEW_HISTORY=true chain_count "$deploy2" "$deploy1")" = 1 ]
# A source commit whose message forges the trailer is still source history.
forged_repo="$WORK/forged"
git init -q "$forged_repo"
git -C "$forged_repo" commit -q --allow-empty -m "$deploy_msg"
forged_deploy="$(git -C "$forged_repo" commit-tree "HEAD^{tree}" -m "$deploy_msg")"
out="$(cd "$forged_repo" && DEPLOY_COMMIT="$forged_deploy" && PUSH_REF="$forged_deploy" && chain_onto_server "$(git rev-parse HEAD)" >/dev/null && git rev-list --count "$PUSH_REF")"
check "a deploy never builds on HEAD's history, even with the trailer" [ "$out" = 1 ]
old_deploy="$(git -C "$SRC" commit-tree "$rev2^{tree}" -p "$rev2" -m "Deploy x to test")"
check "the audit reads a deploy commit's source from its trailer" [ "$(cd "$SRC" && deploy_source "$deploy2")" = "$rev2" ]
check "the audit reads an older unsplit deploy commit's source from its parent" [ "$(cd "$SRC" && SPLIT_PUSH=false && deploy_source "$old_deploy")" = "$rev2" ]
# An older split commit's parent is the previous split commit, not the source.
old_split="$(git -C "$SRC" commit-tree "$rev2:wordpress" -p "$split1" -m "Deploy x to test")"
check "the audit names no source for an older split commit" [ -z "$(cd "$SRC" && SPLIT_PUSH=true && WP_PREFIX=wordpress && deploy_source "$old_split")" ]

# Stale-file removal of more than 20 files, run as the deploy runs it (set -e, pipefail).
# Regression: printing the list through `head -n 20` raised SIGPIPE in sed and aborted before deletion.
# remove_stale_files reads the stale list from verify.bad, so feed it 1500 entries directly.
# The list has to outgrow the pipe buffer (64 KB) for head's early exit to break sed's write.
: >"$WORK/verify.bad"
mkdir -p "$WEBROOT/wp-content/plugins/removed/includes/some/deeply/nested/directory"
for i in $(seq 1 1500); do
  echo "$i" >"$WEBROOT/wp-content/plugins/removed/includes/some/deeply/nested/directory/file-with-a-long-name-$i.php"
  printf 'stale\twp-content/plugins/removed/includes/some/deeply/nested/directory/file-with-a-long-name-%s.php\n' "$i" >>"$WORK/verify.bad"
done
remove_many() {
  (cd "$SRC/wordpress" && WEBROOT="$WEBROOT" TMP="$WORK" bash -c '
    set -euo pipefail
    source "$1"
    remote_shell() { bash -s; }
    REMOTE_WEBROOT="$WEBROOT" TMP_DIR="$TMP"
    remove_stale_files
    echo REMOVE-FINISHED' _ "$BUILD_DIR/deploy.sh" 2>&1)
}
out="$(remove_many)" || true
check "removal of more than 20 stale files lists the count" grep -q "Removing 1500 file(s)" <<<"$out"
check "removal of more than 20 stale files returns to the caller" grep -q REMOVE-FINISHED <<<"$out"
check "all of the many stale files are removed" [ ! -e "$WEBROOT/wp-content/plugins/removed/includes/some/deeply/nested/directory/file-with-a-long-name-1500.php" ]

# Audit against a fixture exclude list, so the result does not depend on a site's list.
write "$WEBROOT/wp-content/plugins/removed/removed.php"
git -C "$SRC" rm -q --cached -r wordpress/wp-content/plugins/kept >/dev/null
git -C "$SRC" commit -qm "stop tracking kept"
git -C "$SRC" add -A
git -C "$SRC" commit -qm "track kept again"
write "$WEBROOT/.env.sample"
write "$WEBROOT/composer.json"
# .env files: nested ones count, uploads are not scanned, .envrc is not a .env file.
write "$WEBROOT/wp-content/plugins/kept/.env"
write "$WEBROOT/wp-content/uploads/.env"
write "$WEBROOT/.envrc"
# A file deleted from the repo that the exclude list matches.
write "$WEBROOT/old-name.php"
REMOTE_BRANCH_NAME=master
WP_PREFIX=wordpress
printf '.env.sample\ncomposer.json\nold-name.php\n' >"$WORK/audit-exclude.txt"
EXCLUDE_FILE="$WORK/audit-exclude.txt"
(cd "$SRC/wordpress" && hook_config) >"$BARE/deploy-hook.env"
out="$(cd "$SRC/wordpress" && audit_server 2>&1)" || true
check "audit prints the script version" grep -q "^wp-deploy $WP_DEPLOY_VERSION$" <<<"$out"
check "audit reports excluded files on the server" grep -q "^  composer.json" <<<"$out"
check "audit reports deleted files still on the server" grep -q "wp-content/plugins/removed - 1 file(s); no longer in repo" <<<"$out"
check "audit reports server-only plugins" grep -q "wp-content/plugins/server-only" <<<"$out"
check "audit reports the hook matches" grep -q "Hook: matches" <<<"$out"
check "audit does not report files still in the repo" bash -c '! sed -n "/^## Files deleted/,/^## Plugins,/p" <<<"$1" | grep -q "plugins/kept"' _ "$out"
check "audit summary line" grep -q "^audit: 3 excluded path(s) on server, 1 deleted tracked file(s)" <<<"$out"
env_section="$(sed -n "/^## WARNING: .env files in the webroot/,/^## /p" <<<"$out")"
check "audit warns about .env files in the webroot" bash -c 'grep -qx "  wp-content/plugins/kept/.env" <<<"$1"' _ "$env_section"
check "audit .env warning skips example files" bash -c '! grep -qx "  .env.sample" <<<"$1"' _ "$env_section"
check "audit .env warning skips uploads and other dotfiles" bash -c '! grep -Eq "uploads|envrc" <<<"$1"' _ "$env_section"
check "audit .env warning comes before the other sections" bash -c '[ "$(grep -m1 "^## " <<<"$1")" = "## WARNING: .env files in the webroot" ]' _ "$out"
check "audit repeats the .env warning above the summary" grep -q "^WARNING: 1 .env file(s) in the webroot" <<<"$out"
deleted_section="$(sed -n "/^## Files deleted/,/^## Plugins,/p" <<<"$out")"
check "audit lists excluded deleted files once, under excluded paths" bash -c 'grep -qx "  old-name.php" <<<"$1" && ! grep -q old-name <<<"$2"' _ "$out" "$deleted_section"
check "audit says it left excluded files out of the deleted list" grep -q "1 file(s) matching the exclude list are left out: prune keeps them" <<<"$deleted_section"
check "audit inventory lists untracked plugins" grep -Eq "^  server-only +[a-z-]+ +untracked$" <<<"$out"
check "audit inventory lists tracked plugins" grep -Eq "^  kept +[a-z-]+ +tracked$" <<<"$out"
check "audit says when there is no composer.lock" grep -q "no composer.lock found" <<<"$out"
check "audit lists committed non-composer plugins" grep -Eq "^    wp-content/plugins/kept +[a-z-]+ +-$" <<<"$out"
check "audit lists server-only non-composer plugins" grep -Eq "^    wp-content/plugins/server-only +[a-z-]+ +-$" <<<"$out"
rm "$WEBROOT/.env.sample" "$WEBROOT/composer.json" "$WEBROOT/wp-content/plugins/removed/removed.php" "$WEBROOT/old-name.php"
rm "$WEBROOT/wp-content/plugins/kept/.env" "$WEBROOT/wp-content/uploads/.env" "$WEBROOT/.envrc"
git -C "$SRC" reset -q --hard "$rev2"

# A payload with wp-config.php is refused and the server copy is kept.
write "$SRC/wordpress/wp-config.php" repo-config
git -C "$SRC" add -A
git -C "$SRC" commit -qm config
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: payload with wp-config.php is refused" grep -q "protected paths" <<<"$out"
check "hook: refused payload does not report DEPLOY_OK" bash -c '! grep -q DEPLOY_OK <<<"$1"' _ "$out"
check "hook: server wp-config.php is untouched" grep -q server-config "$WEBROOT/wp-config.php"
git -C "$SRC" rm -q wordpress/wp-config.php
git -C "$SRC" commit -qm unconfig

# Payload paths that collide with the server's files are refused, and nothing is deleted.
mkdir -p "$WEBROOT/wp-content/plugins/kept/data"
write "$WEBROOT/wp-content/plugins/kept/data/keep.txt" server-data
write "$SRC/wordpress/wp-content/plugins/kept/data" repo-file
git -C "$SRC" add -A
git -C "$SRC" commit -qm collide-folder
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: a file over a server folder is refused" grep -q "wp-content/plugins/kept/data (a folder on the server)" <<<"$out"
check "hook: a refused collision does not report DEPLOY_OK" bash -c '! grep -q DEPLOY_OK <<<"$1"' _ "$out"
check "hook: a refused collision keeps the server folder's files" grep -q server-data "$WEBROOT/wp-content/plugins/kept/data/keep.txt"
git -C "$SRC" rm -q wordpress/wp-content/plugins/kept/data
write "$WEBROOT/wp-content/plugins/blocker" server-file
mkdir -p "$WORK/elsewhere"
ln -s "$WORK/elsewhere" "$WEBROOT/wp-content/plugins/linked"
write "$SRC/wordpress/wp-content/plugins/blocker/blocker.php"
write "$SRC/wordpress/wp-content/plugins/linked/linked.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm collide-parents
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: a folder over a server file is refused" grep -q "wp-content/plugins/blocker/ (a file or link on the server)" <<<"$out"
check "hook: a folder through a server link is refused" grep -q "wp-content/plugins/linked/ (a file or link on the server)" <<<"$out"
check "hook: a refused collision writes nothing through the link" [ ! -e "$WORK/elsewhere/linked.php" ]
check "hook: a refused collision keeps the server file" grep -q server-file "$WEBROOT/wp-content/plugins/blocker"
git -C "$SRC" rm -q -r wordpress/wp-content/plugins/blocker wordpress/wp-content/plugins/linked
git -C "$SRC" commit -qm uncollide
rm -rf "$WEBROOT/wp-content/plugins/blocker" "$WEBROOT/wp-content/plugins/linked" "$WEBROOT/wp-content/plugins/kept/data"

# A failed install must not report DEPLOY_OK.
write "$SRC/wordpress/third.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm three
out="$(DEPLOY_WEBROOT="$WORK/missing" git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: failed install reports failure" grep -q "Deployment failed" <<<"$out"
check "hook: failed install does not report DEPLOY_OK" bash -c '! grep -q DEPLOY_OK <<<"$1"' _ "$out"

# The hook takes its branch from deploy-hook.env and needs a webroot.
sed 's/^DEPLOY_BRANCH=.*/DEPLOY_BRANCH=main/' "$BARE/deploy-hook.env" >"$WORK/hook.env"
cp "$WORK/hook.env" "$BARE/deploy-hook.env"
write "$SRC/wordpress/fourth.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm four
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: ignores branches other than DEPLOY_BRANCH" grep -q "refs/heads/master received. Ignoring" <<<"$out"
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: installs DEPLOY_BRANCH" grep -q "DEPLOY_OK" <<<"$out"
check "hook: records the commit it installed" [ "$(cat "$BARE/deploy-installed-rev")" = "$(git -C "$SRC" rev-parse HEAD)" ]

# A push Git accepts but the hook refuses must not hide its deletions from the next push.
write "$SRC/wordpress/wp-content/plugins/gone/gone.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm with-gone
git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main >/dev/null 2>&1 || true
git -C "$SRC" rm -q -r wordpress/wp-content/plugins/gone
mkdir -p "$WEBROOT/wp-content/plugins/kept/data"
write "$SRC/wordpress/wp-content/plugins/kept/data" repo-file
git -C "$SRC" add -A
git -C "$SRC" commit -qm refused
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: a refused push leaves the last installed commit recorded" [ "$(cat "$BARE/deploy-installed-rev")" = "$(git -C "$SRC" rev-parse HEAD~1)" ]
rmdir "$WEBROOT/wp-content/plugins/kept/data"
git -C "$SRC" rm -q wordpress/wp-content/plugins/kept/data
git -C "$SRC" commit -qm retry
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: a retry after a refused push reports DEPLOY_OK" grep -q "DEPLOY_OK" <<<"$out"
check "hook: a retry removes what the refused push deleted" [ ! -e "$WEBROOT/wp-content/plugins/gone/gone.php" ]

# An install that stopped partway: the next full install also removes what it wrote.
write "$SRC/wordpress/wp-content/plugins/half/new.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm half
mv "$BARE/hooks/post-receive" "$WORK/post-receive.off"
git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main >/dev/null 2>&1
mv "$WORK/post-receive.off" "$BARE/hooks/post-receive"
git -C "$SRC" rev-parse HEAD >>"$BARE/deploy-attempted-revs"
write "$WEBROOT/wp-content/plugins/half/new.php"
git -C "$SRC" rm -q -r wordpress/wp-content/plugins/half
git -C "$SRC" commit -qm unhalf
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: the install after a partial one reports DEPLOY_OK" grep -q "DEPLOY_OK" <<<"$out"
check "hook: the install after a partial one removes the files it wrote" [ ! -e "$WEBROOT/wp-content/plugins/half/new.php" ]
check "hook: a full install clears the partial-install record" [ ! -e "$BARE/deploy-attempted-revs" ]

# The client reads the last full install without picking up its own log lines.
got="$(remote_bash() { printf 'abc123\n'; }; git() { if [ "$1" = cat-file ]; then return 0; fi; command git "$@"; }; installed_server_ref def456 2>/dev/null)"
check "installed_server_ref prints only the commit" [ "$got" = abc123 ]

# A hook whose commit is no longer the branch tip installs nothing.
older="$(git -C "$SRC" rev-parse HEAD)"
write "$SRC/wordpress/sixth.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm six
git --git-dir="$BARE" update-ref refs/heads/main "$(git -C "$SRC" rev-parse HEAD)" 2>/dev/null ||
  git -C "$SRC" push -q --no-verify "$BARE" HEAD:refs/heads/main >/dev/null 2>&1
out="$(printf '%s %s refs/heads/main\n' "$older" "$older" | GIT_DIR="$BARE" bash "$BARE/hooks/post-receive" 2>&1 || true)"
check "hook: a superseded commit is skipped" grep -q "Skipping $older" <<<"$out"
check "hook: a superseded commit does not report DEPLOY_OK" bash -c '! grep -q DEPLOY_OK <<<"$1"' _ "$out"

# A held deploy lock makes the hook wait, then give up.
if command -v flock >/dev/null; then
  exec 8>>"$BARE/deploy.lock"
  flock 8
  out="$(printf '%s %s refs/heads/main\n' "$older" "$(git -C "$SRC" rev-parse HEAD)" | DEPLOY_LOCK_WAIT=1 GIT_DIR="$BARE" bash "$BARE/hooks/post-receive" 2>&1 || true)"
  check "hook: waits for the deploy lock, then gives up" grep -q "Another deploy holds" <<<"$out"
  exec 8>&-
fi

# .env files in any folder, in any variant, are refused.
write "$SRC/wordpress/wp-content/plugins/kept/.env.production" SECRET=invented
git -C "$SRC" add -A
git -C "$SRC" commit -qm nested-env
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: a nested .env.production is refused" grep -q "wp-content/plugins/kept/.env.production" <<<"$out"
check "hook: a nested .env.production is not installed" [ ! -e "$WEBROOT/wp-content/plugins/kept/.env.production" ]
git -C "$SRC" rm -q wordpress/wp-content/plugins/kept/.env.production
git -C "$SRC" commit -qm unnested-env
write "$SRC/wordpress/wp-content/plugins/kept/.env.example" KEY=
git -C "$SRC" add -A
git -C "$SRC" commit -qm env-example
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/main 2>&1 || true)"
check "hook: a plugin's .env.example is installed" grep -q "DEPLOY_OK" <<<"$out"
git -C "$SRC" rm -q wordpress/wp-content/plugins/kept/.env.example
git -C "$SRC" commit -qm no-env-example
check "an example .env file under uploads is still forbidden" forbidden_payload_path wp-content/uploads/.env.example
allowed_payload_path() { ! forbidden_payload_path "$1"; }
check "an example .env file elsewhere is allowed" allowed_payload_path wp-content/plugins/x/.env.example
check "a nested .env.production is forbidden" forbidden_payload_path wp-content/plugins/x/.env.production
check "ENV_TEMPLATE_REGEX allows example .env files only" bash -c '[[ "a/.env.example" =~ $1 && ".env.sample" =~ $1 && ! "a/.env.production" =~ $1 && ! "a/.env" =~ $1 ]]' _ "$ENV_TEMPLATE_REGEX"
check "FORBIDDEN_PAYLOAD_REGEX matches .env variants in any folder" bash -c '[[ "a/b/.env.local" =~ $1 && ".env.production" =~ $1 && "a/.env" =~ $1 && ! "a/.envrc" =~ $1 && ! "a/.env.d/x" =~ $1 ]]' _ "$FORBIDDEN_PAYLOAD_REGEX"

rm "$BARE/deploy-hook.env"
write "$SRC/wordpress/fifth.php"
git -C "$SRC" add -A
git -C "$SRC" commit -qm five
out="$(git -C "$SRC" push -q --force "$BARE" HEAD:refs/heads/master 2>&1 || true)"
check "hook: without deploy-hook.env fails" grep -q "No DEPLOY_WEBROOT" <<<"$out"

# Packaging, settings and targets (dry runs only).
REPO="$WORK/repo"
git init -q "$REPO"
mkdir -p "$REPO/wordpress/_build"
cp "$BUILD_DIR/deploy.sh" "$HOOK" "$REPO/wordpress/_build/"
printf '.env\nwp-content/plugins/ignored-*/\n' >"$REPO/wordpress/.gitignore"
cat >"$REPO/wordpress/_build/deploy.env" <<'CONFIG'
DEPLOY_BUILD_TASK=echo BUILD-FROM-CONFIG
COMPOSE_CLOUDWAYS_STAGING_SSH_USER=config-user
COMPOSE_CLOUDWAYS_STAGING_SERVER_IP=192.0.2.2
COMPOSE_CLOUDWAYS_STAGING_GIT_PATH=/srv/staging/private_html
COMPOSE_CLOUDWAYS_STAGING_PROJECT_REPO=site
CONFIG
printf 'wp-content/plugins/ignored-*\n' >"$REPO/wordpress/_build/.deploy_include.txt"
printf '_build/\n\ncomposer.json\nwp-content/plugins/dev-only/*' >"$REPO/wordpress/_build/.deploy_exclude.txt"
write "$REPO/wordpress/composer.json"
write "$REPO/wordpress/wp-content/plugins/dev-only/dev.php"
write "$REPO/wordpress/wp-content/plugins/real/real.php"
write "$REPO/wordpress/wp-content/plugins/ignored-one/one.php"
write "$REPO/frontend/app.js"
git -C "$REPO" add -A
git -C "$REPO" commit -qm base
head_before="$(git -C "$REPO" rev-parse HEAD)"

export COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER=user COMPOSE_CLOUDWAYS_PRODUCTION_SERVER_IP=192.0.2.1
export COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH=/srv/app/private_html COMPOSE_CLOUDWAYS_PRODUCTION_PROJECT_REPO=site

out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production --dry-run 2>&1)"
commit="$(sed -n 's/^==> Deploy commit \([0-9a-f]*\).*/\1/p' <<<"$out")"
payload="$(git -C "$REPO/wordpress" ls-tree -r --name-only "$commit" -- . 2>/dev/null || true)"
check "dry run builds a deploy commit" [ -n "$commit" ]
check "last exclude entry (no trailing newline) is excluded" bash -c '! grep -q dev-only <<<"$1"' _ "$payload"
check "exclude entries are removed" bash -c '! grep -Eq "^(composer.json|_build/)" <<<"$1"' _ "$payload"
check "tracked files stay in the payload" grep -q '^wp-content/plugins/real/real.php$' <<<"$payload"
check "glob include entries add ignored files" grep -q '^wp-content/plugins/ignored-one/one.php$' <<<"$payload"
check "dry run leaves HEAD alone" [ "$(git -C "$REPO" rev-parse HEAD)" = "$head_before" ]
check "dry run leaves the working tree alone" [ -z "$(git -C "$REPO" status --porcelain)" ]
check "dry run leaves excluded files on disk" [ -f "$REPO/wordpress/wp-content/plugins/dev-only/dev.php" ]
check "dry run creates no branch" [ "$(git -C "$REPO" branch --format='%(refname:short)')" = main ]
check "dry run keeps the whole tree for Cloudways (the hook extracts the folder)" bash -c '! grep -q "Split commit" <<<"$1"' _ "$out"

write "$REPO/wordpress/wp-content/plugins/real/real.php" edited
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production --dry-run 2>&1 || true)"
check "dirty tree is refused" grep -q "uncommitted changes" <<<"$out"
check "dirty tree is left as it was" grep -q edited "$REPO/wordpress/wp-content/plugins/real/real.php"
check "dirty tree is not stashed" [ -z "$(git -C "$REPO" stash list)" ]
git -C "$REPO" checkout -q -- .

# Settings precedence: environment, then .env, then _build/deploy.env.
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-staging --dry-run 2>&1 || true)"
check "deploy.env supplies site settings" grep -q "Deploy commit" <<<"$out"
check "deploy.env supplies the build task" grep -q "BUILD-FROM-CONFIG" <<<"$out"
printf 'DEPLOY_BUILD_TASK=echo BUILD-FROM-DOTENV\n' >"$REPO/wordpress/.env"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-staging --dry-run 2>&1 || true)"
check ".env overrides deploy.env" grep -q "BUILD-FROM-DOTENV" <<<"$out"
out="$(cd "$REPO/wordpress" && DEPLOY_BUILD_TASK="echo BUILD-FROM-ENV" bash _build/deploy.sh cloudways-staging --dry-run 2>&1 || true)"
check "the environment overrides .env" grep -q "BUILD-FROM-ENV" <<<"$out"
out="$(cd "$REPO" && DEPLOY_BUILD_DIR=.. DEPLOY_BUILD_TASK='test -d frontend && echo BUILT-AT-ROOT' bash wordpress/_build/deploy.sh cloudways-staging --dry-run 2>&1 || true)"
check "DEPLOY_BUILD_DIR sets the build folder" grep -q "BUILT-AT-ROOT" <<<"$out"
write "$REPO/frontend/app.js" dirty
out="$(cd "$REPO" && DEPLOY_BUILD_DIR=.. bash wordpress/_build/deploy.sh cloudways-staging --dry-run 2>&1 || true)"
check "a dirty build folder is refused" grep -q "uncommitted changes under .*/repo\. Commit" <<<"$out"
git -C "$REPO" checkout -q -- frontend
rm "$REPO/wordpress/.env"

write "$REPO/wordpress/.env" SECRET=1
git -C "$REPO" add -f wordpress/.env
git -C "$REPO" commit -qm env
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production --dry-run 2>&1 || true)"
check "a tracked .env is refused" grep -q "must never be deployed" <<<"$out"
git -C "$REPO" rm -q --cached wordpress/.env
git -C "$REPO" commit -qm unenv
rm "$REPO/wordpress/.env"

out="$(cd "$REPO/wordpress" && bash _build/deploy.sh nowhere 2>&1 || true)"
check "unknown target is refused" grep -q "unknown target" <<<"$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh staging --dry-run 2>&1 || true)"
check "a bare target without DEPLOY_HOST is refused" grep -q "needs DEPLOY_HOST" <<<"$out"
# With the settings, a WP Engine dry run reads the server's commit; an unreachable remote doesn't fail it.
out="$(cd "$REPO/wordpress" && GIT_SSH_COMMAND=false DEPLOY_HOST=wpengine COMPOSE_WPE_STAGING=examplestg bash _build/deploy.sh staging --dry-run 2>&1)" && status=0 || status=$?
check "DEPLOY_HOST=wpengine deploys staging to WP Engine" grep -q ": staging on wpe," <<<"$out"
check "WP Engine dry run splits the WordPress folder" grep -q "Split commit" <<<"$out"
check "WP Engine dry run survives an unreachable remote" bash -c '[ "$1" = 0 ] && grep -q "Could not read git@git.wpengine.com:examplestg.git" <<<"$2"' _ "$status" "$out"
out="$(cd "$REPO/wordpress" && DEPLOY_HOST=nowhere bash _build/deploy.sh staging --dry-run 2>&1 || true)"
check "an unknown DEPLOY_HOST is refused" grep -q "unknown DEPLOY_HOST" <<<"$out"
out="$(cd "$REPO/wordpress" && DEPLOY_HOST=cloudways bash _build/deploy.sh development --dry-run 2>&1 || true)"
check "Cloudways has no development target" grep -q "no development target" <<<"$out"
out="$(cd "$REPO/wordpress" && COMPOSE_WPE_STAGING=examplestg bash _build/deploy.sh install-hook wpe-staging 2>&1 || true)"
check "install-hook refuses non-Cloudways targets" grep -q "only supports Cloudways" <<<"$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh install-hook cloudways-staging --dry-run 2>&1 || true)"
check "install-hook refuses --dry-run" grep -q "install-hook has no dry run" <<<"$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production --delete 2>&1 || true)"
check "--delete is refused outside prune" grep -q "only applies to prune" <<<"$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh prune cloudways-production --dry-run --delete 2>&1 || true)"
check "prune refuses --dry-run with --delete" grep -q "dry run unless you pass --delete" <<<"$out"
# composer.json vs composer.lock, end to end through the plugins report. The lock
# is indented differently from composer's own output, and "require" appears
# outside the root object's require map.
CREPO_C="$WORK/composer-repo"
git init -q "$CREPO_C"
mkdir -p "$CREPO_C/_build"
cp "$BUILD_DIR/deploy.sh" "$CREPO_C/_build/"
write "$CREPO_C/wp-content/plugins/real/real.php" "<?php
/* Plugin Name: Real */"
printf '{\n  "packages": [\n    {\n      "name": "vendor/real",\n      "require": {"vendor/dep": "*"},\n      "type": "wordpress-plugin"\n    }\n  ],\n  "packages-dev": []\n}\n' >"$CREPO_C/composer.lock"
composer_report() {
  printf '%s\n' "$1" >"$CREPO_C/composer.json"
  git -C "$CREPO_C" add -A
  git -C "$CREPO_C" commit -qm "$2"
  (cd "$CREPO_C" && bash _build/deploy.sh plugins 2>&1)
}
out="$(composer_report '{
  "repositories": [{
    "type": "package",
    "package": {
      "name": "vendor/unused",
      "version": "1.0",
      "require": {"vendor/not-selected": "*"}
    }
  }],
  "require": {"vendor/real": "*"}
}' repository-package)"
check "a package repository's require is not a project requirement" bash -c 'grep -q "^composer.json requirements missing from composer.lock: 0$" <<<"$1" && ! grep -q not-selected <<<"$1"' _ "$out"
out="$(composer_report '{
  "require":
  {
    "vendor/missing": "*",
    "vendor/real": "*"
  }
}' brace-on-next-line)"
check "a require brace on its own line is still read" bash -c 'grep -qx "  vendor/missing" <<<"$1" && grep -q "^composer.json requirements missing from composer.lock: 1$" <<<"$1"' _ "$out"
check "composer.lock is read whatever its indentation" bash -c '! grep -q "plugins/real" <<<"$1"' _ "$out"

unset COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER COMPOSE_CLOUDWAYS_PRODUCTION_SERVER_IP
unset COMPOSE_CLOUDWAYS_PRODUCTION_GIT_PATH COMPOSE_CLOUDWAYS_PRODUCTION_PROJECT_REPO

# A dry run needs no SSH or Git remote settings; a deploy and the SSH commands still do.
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production --dry-run 2>&1)" && status=0 || status=$?
check "Cloudways dry run works without remote settings" bash -c '[ "$1" = 0 ] && grep -q "Deploy commit" <<<"$2"' _ "$status" "$out"
check "the dry run names the settings a deploy needs" grep -q "a deploy to cloudways-production also needs: COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER" <<<"$out"
out="$(cd "$REPO/wordpress" && COMPOSE_CLOUDWAYS_STAGING_SSH_USER= bash _build/deploy.sh cloudways-staging --dry-run 2>&1)" && status=0 || status=$?
check "Cloudways dry run works without the SSH user" [ "$status" = 0 ]
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh kinsta-staging --dry-run 2>&1)" && status=0 || status=$?
check "Kinsta dry run works without remote settings" bash -c '[ "$1" = 0 ] && grep -q "Split commit" <<<"$2"' _ "$status" "$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh wpe-staging --dry-run 2>&1)" && status=0 || status=$?
check "WP Engine dry run works without remote settings" [ "$status" = 0 ]
check "WP Engine dry run without remote settings says it lists no removals" grep -q "Not listing files the deploy would remove" <<<"$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh cloudways-production 2>&1)" && status=0 || status=$?
check "a deploy still requires the remote settings" bash -c '[ "$1" != 0 ] && grep -q "missing settings for cloudways-production: COMPOSE_CLOUDWAYS_PRODUCTION_SSH_USER" <<<"$2"' _ "$status" "$out"
out="$(cd "$REPO/wordpress" && bash _build/deploy.sh audit cloudways-production --dry-run 2>&1)" && status=0 || status=$?
check "audit with --dry-run still requires the remote settings" bash -c '[ "$1" != 0 ] && grep -q "missing settings" <<<"$2"' _ "$status" "$out"
out="$(cd "$REPO/wordpress" && DEPLOY_HOST=cloudways bash _build/deploy.sh plugins 2>&1)" && status=0 || status=$?
check "plugins needs no remote settings" [ "$status" = 0 ]
unset -f remote_shell

# --- 2. End-to-end deploys: host x layout ------------------------------------
# A fake ssh runs remote commands locally. It maps Kinsta's /www/ and WP Engine's
# /home/wpe-user/ into $FAKE_ROOT (Cloudways paths are settings, so the test
# points them into $FAKE_ROOT directly), serves WP Engine's Git remote from
# $FAKE_ROOT/wpe-git, strips quotes like WP Engine's gateway, and runs gateway
# sessions without git.
FAKE_SSH="$WORK/bin/fake-ssh"
mkdir -p "$WORK/bin"
cat >"$FAKE_SSH" <<'FAKE'
#!/usr/bin/env bash
[ -z "${FAKE_SSH_LOG:-}" ] || printf '%s\n' "$*" >>"$FAKE_SSH_LOG"
while [ $# -gt 0 ]; do
  case "$1" in
    -o | -p) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
host="$1"
shift
cmd="$*"
# With FAKE_DOWN_AFTER_PUSH set to a file path, SSH shell sessions time out once a push has run.
if [ -n "${FAKE_DOWN_AFTER_PUSH:-}" ]; then
  case "$cmd" in
    git-receive-pack*) touch "$FAKE_DOWN_AFTER_PUSH" ;;
    "bash -s") [ ! -e "$FAKE_DOWN_AFTER_PUSH" ] || { echo "ssh: connect to host $host: Operation timed out" >&2; exit 255; } ;;
  esac
fi
# With FAKE_GIT_DOWN_AFTER_PUSH set to a file path, Git fetches and ls-remote time out once a push has run.
if [ -n "${FAKE_GIT_DOWN_AFTER_PUSH:-}" ]; then
  case "$cmd" in
    git-receive-pack*) touch "$FAKE_GIT_DOWN_AFTER_PUSH" ;;
    git-upload-pack*) [ ! -e "$FAKE_GIT_DOWN_AFTER_PUSH" ] || { echo "ssh: connect to host $host: Operation timed out" >&2; exit 255; } ;;
  esac
fi
map() { sed -e "s|/www/|$FAKE_ROOT/www/|g" -e "s|/home/wpe-user/|$FAKE_ROOT/home/wpe-user/|g"; }
case "$host" in
  git@git.wpengine.com)
    cd "$FAKE_ROOT/wpe-git" && exec bash -c "$cmd"
    ;;
  *.ssh.wpengine.net)
    [ -z "${FAKE_GATEWAY_DOWN:-}" ] || { echo "ssh: connect to host $host port 22: Operation timed out" >&2; exit 255; }
    cmd="$(printf '%s' "$cmd" | tr -d "'\"")"
    [ "$cmd" = "bash -s" ] || { echo "fake gateway: only bash -s is supported, got: $cmd" >&2; exit 1; }
    map | PATH="$NOGIT_BIN" "$BASH" -s
    ;;
  *)
    if [ "$cmd" = "bash -s" ]; then
      map | PATH="$NOWP_BIN:$PATH" bash -s
    else
      PATH="$NOWP_BIN:$PATH" exec bash -c "$(printf '%s' "$cmd" | map)"
    fi
    ;;
esac
FAKE
chmod +x "$FAKE_SSH"
export NOGIT_BIN NOWP_BIN GIT_SSH_COMMAND="$FAKE_SSH" GIT_SSH_VARIANT=ssh

matrix_cases=0
matrix_passed=0

# True when the server's repo holds none of the source repo's commits.
no_source_commits() {
  local rev
  for rev in $(git -C "$1" rev-list --all); do
    ! git --git-dir="$2" cat-file -e "$rev" 2>/dev/null || return 1
  done
}

# run_case <host> <layout>
#   layout root:      WordPress at the repo root, _build/ at the root
#   layout subfolder: WordPress in wordpress/, wordpress/_build/ (the template layout)
#   layout detached:  WordPress in wordpress/, _build/ at the repo root (DEPLOY_WORDPRESS_DIR)
#   layout nested:    WordPress two folders down, in apps/site/ with apps/site/_build (a monorepo app)
run_case() {
  local host="$1" layout="$2" name="$1/$2" before="$failures" case_dir repo wp build webroot branch target out status prefix env_extra=""
  echo "# case $name"
  matrix_cases=$((matrix_cases + 1))
  case_dir="$WORK/case-$host-$layout"
  export FAKE_ROOT="$case_dir/server"
  repo="$case_dir/repo"
  case "$layout" in
    root) wp="$repo" build="$repo/_build" prefix="" ;;
    subfolder) wp="$repo/wordpress" build="$repo/wordpress/_build" prefix="wordpress/" ;;
    detached) wp="$repo/wordpress" build="$repo/_build" prefix="wordpress/" env_extra="DEPLOY_WORDPRESS_DIR=wordpress" ;;
    nested) wp="$repo/apps/site" build="$repo/apps/site/_build" prefix="apps/site/" ;;
  esac
  branch=master
  [ "$layout" != root ] || branch=main

  # Server
  case "$host" in
    cloudways)
      webroot="$FAKE_ROOT/srv/app/public_html"
      mkdir -p "$webroot"
      ;;
    kinsta)
      webroot="$FAKE_ROOT/www/site_1/public"
      mkdir -p "$webroot"
      git init -q --bare "$FAKE_ROOT/www/site_1/private/site.git"
      printf '#!/bin/bash\nwhile read o n ref; do if [ "$ref" = refs/heads/%s ]; then git --work-tree="%s" --git-dir="%s" checkout -f %s; fi; done\n' \
        "$branch" "$webroot" "$FAKE_ROOT/www/site_1/private/site.git" "$branch" >"$FAKE_ROOT/www/site_1/private/site.git/hooks/post-receive"
      chmod +x "$FAKE_ROOT/www/site_1/private/site.git/hooks/post-receive"
      write "$webroot/wp-content/mu-plugins/kinsta-mu-plugins.php" host
      ;;
    wpengine)
      webroot="$FAKE_ROOT/home/wpe-user/sites/siteinstall"
      mkdir -p "$webroot" "$FAKE_ROOT/wpe-git"
      git init -q --bare "$FAKE_ROOT/wpe-git/siteinstall.git"
      # WP Engine installs every push but only adds and overwrites files.
      printf '#!/bin/bash\nwhile read o n ref; do git archive "$n" | tar -x -C "%s"; done\necho "git.wpengine.com: complete!"\n' \
        "$webroot" >"$FAKE_ROOT/wpe-git/siteinstall.git/hooks/post-receive"
      chmod +x "$FAKE_ROOT/wpe-git/siteinstall.git/hooks/post-receive"
      write "$webroot/_wpeprivate/config.json" host
      write "$webroot/wp-content/mu-plugins/wpengine-common/plugin.php" host
      for mu in wpe-cache-plugin.php wpe-cache-plugin/cache.php wpe-wp-sign-on-plugin.php wpe-wp-sign-on-plugin/sign-on.php \
        wpengine-security-auditor.php slt-force-strong-passwords.php force-strong-passwords/slt-force-strong-passwords.php; do
        write "$webroot/wp-content/mu-plugins/$mu" host
      done
      # A composer package whose zip nests the plugin one folder too deep: WP-CLI finds no plugin file.
      write "$webroot/wp-content/plugins/nested-pkg/nested-pkg/nested-pkg.php" "<?php
/* Plugin Name: Nested */"
      ;;
  esac
  write "$webroot/wp-config.php" server-config
  write "$webroot/wp-content/uploads/2026/photo.jpg"
  write "$webroot/wp-content/plugins/server-only/server-only.php"

  # Repo
  git init -q "$repo"
  mkdir -p "$build"
  cp "$BUILD_DIR/deploy.sh" "$HOOK" "$build/"
  {
    echo "DEPLOY_HOST=$host"
    [ -z "$env_extra" ] || echo "$env_extra"
    echo "DEPLOY_REMOTE_BRANCH=$branch"
    echo "DEPLOY_BUILD_TASK=mkdir -p wp-content/themes/t/dist && echo built >wp-content/themes/t/dist/app.js"
    [ "$layout" != detached ] || echo "DEPLOY_BUILD_DIR=wordpress"
    case "$host" in
      cloudways)
        echo "COMPOSE_CLOUDWAYS_STAGING_SERVER_IP=192.0.2.10"
        echo "COMPOSE_CLOUDWAYS_STAGING_GIT_PATH=$FAKE_ROOT/srv/app/private_html"
        echo "COMPOSE_CLOUDWAYS_STAGING_PROJECT_REPO=site"
        ;;
      kinsta)
        echo "COMPOSE_KINSTA_PROJECT_FOLDER=site_1"
        echo "COMPOSE_KINSTA_PROJECT_REPO=site"
        echo "COMPOSE_KINSTA_STAGING=user@kinsta.invalid"
        echo "COMPOSE_KINSTA_STAGING_PORT=2222"
        ;;
      wpengine) echo "COMPOSE_WPE_STAGING=siteinstall" ;;
    esac
  } >"$build/deploy.env"
  # The SSH user is personal: it lives in the gitignored .env.
  [ "$host" != cloudways ] || printf 'COMPOSE_CLOUDWAYS_STAGING_SSH_USER=master\n' >"$(dirname "$build")/.env"
  printf 'wp-content/themes/t/dist\n' >"$build/.deploy_include.txt"
  printf '_build/\n.env\ncomposer.json\ncomposer.lock\nwp-content/plugins/dev-only/*\n' >"$build/.deploy_exclude.txt"
  printf '.env\n%swp-content/themes/t/dist/\n' "$prefix" >"$repo/.gitignore"
  write "$wp/index.php"
  # composer.json requires one package that composer.lock is missing.
  printf '{\n    "require": {\n        "php": ">=8.1",\n        "wpackagist-plugin/real": "^1.0",\n        "wpackagist-plugin/nested-pkg": "^1.0",\n        "wpackagist-plugin/not-locked": "^2.0"\n    }\n}\n' >"$wp/composer.json"
  write "$wp/wp-content/themes/t/style.css"
  write "$wp/wp-content/plugins/real/real.php" v1
  write "$wp/wp-content/plugins/removable/removable.php"
  write "$wp/wp-content/plugins/removable/inc/deep.php"
  write "$wp/wp-content/plugins/dev-only/dev.php"
  # composer.lock installs "real"; the other plugins below are outside composer.
  printf '{\n    "packages": [\n        {\n            "name": "wpackagist-plugin/real",\n            "version": "1.0",\n            "type": "wordpress-plugin"\n        },\n        {\n            "name": "wpackagist-plugin/nested-pkg",\n            "version": "1.0",\n            "type": "wordpress-plugin"\n        }\n    ]\n}\n' >"$wp/composer.lock"
  write "$wp/wp-content/plugins/committed-extra/committed-extra.php" "<?php
/**
 * Plugin Name: Extra
 * Version: 1.4.2
 */"
  write "$wp/wp-content/mu-plugins/site-mu.php" "<?php
/* Plugin Name: Site MU
   Version: 0.3 */"
  printf '<?php\n// Plugin Name: Server Only\n// Version: 2.0\n' >"$webroot/wp-content/plugins/server-only/server-only.php"
  [ "$layout" = root ] || write "$repo/frontend/app.js"
  # An older version of a deployed file, standing in for a secret in the repo's history.
  write "$wp/wp-content/themes/t/style.css" history-only-secret
  git -C "$repo" add -A
  git -C "$repo" commit -qm "older version"
  write "$wp/wp-content/themes/t/style.css"
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  deploy() { (cd "$repo" && bash "${build#"$repo"/}/deploy.sh" "$@" 2>&1); }

  out="$(deploy staging --dry-run)" && status=0 || status=$?
  check "$name: dry run succeeds" [ "$status" = 0 ]
  check "$name: dry run leaves the tree clean" [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ]
  if [ "$host" != cloudways ] && [ -n "$prefix" ]; then
    check "$name: dry run splits the WordPress folder" grep -q "Split commit" <<<"$out"
  else
    check "$name: dry run pushes the whole packaged tree" bash -c '! grep -q "Split commit" <<<"$1"' _ "$out"
  fi

  case "$host" in
    cloudways)
      out="$(deploy staging)" && status=0 || status=$?
      check "$name: deploy refuses a server without the hook" grep -q "differs from the repo" <<<"$out"
      out="$(deploy install-hook staging)" && status=0 || status=$?
      check "$name: install-hook creates the repo and installs the hook" bash -c '[ "$1" = 0 ] && grep -q "Hook installed" <<<"$2"' _ "$status" "$out"
      check "$name: install-hook writes the WordPress folder" grep -qx "DEPLOY_WORDPRESS_FOLDER=${prefix%/}" "$FAKE_ROOT/srv/app/private_html/site.git/deploy-hook.env"
      ;;
    wpengine)
      out="$(deploy staging)" && status=0 || status=$?
      check "$name: first deploy prepares the remote" bash -c '[ "$1" = 0 ] && grep -q "Run the deploy again" <<<"$2"' _ "$status" "$out"
      ;;
  esac

  out="$(deploy staging)" && status=0 || status=$?
  check "$name: first deploy succeeds" [ "$status" = 0 ]
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  check "$name: first deploy reports complete" grep -q "Deploy to staging complete" <<<"$out"
  [ "$host" = wpengine ] || check "$name: first deploy verifies every file" grep -q "Verified [0-9]* changed paths" <<<"$out"
  check "$name: WordPress files land at the webroot" bash -c '[ -f "$1/wp-content/plugins/real/real.php" ] && [ -f "$1/index.php" ]' _ "$webroot"
  check "$name: build output is deployed" [ -f "$webroot/wp-content/themes/t/dist/app.js" ]
  check "$name: no nested wordpress/ folder" [ ! -e "$webroot/wordpress" ]
  case "$host" in
    cloudways) server_git="$FAKE_ROOT/srv/app/private_html/site.git" ;;
    kinsta) server_git="$FAKE_ROOT/www/site_1/private/site.git" ;;
    wpengine) server_git="$FAKE_ROOT/wpe-git/siteinstall.git" ;;
  esac
  first_deploy="$(git --git-dir="$server_git" rev-parse "$branch" 2>/dev/null || true)"
  pushed_path=""
  [ "$host" = cloudways ] || pushed_path="${prefix%/}"
  check "$name: repo-root and excluded files stay off the server" bash -c '[ ! -e "$1/frontend" ] && [ ! -e "$1/_build" ] && [ ! -e "$1/composer.json" ] && [ ! -e "$1/wp-content/plugins/dev-only" ]' _ "$webroot"

  git -C "$repo" rm -q -r "${prefix}wp-content/plugins/removable"
  write "$wp/wp-content/plugins/real/real.php" v2
  git -C "$repo" commit -qam "remove a plugin"
  if [ "$host" = wpengine ]; then
    out="$(deploy staging --dry-run)" && status=0 || status=$?
    check "$name: dry run lists the files the deploy would remove" bash -c '[ "$1" = 0 ] && grep -q "would remove from the server, .*: 2$" <<<"$2" &&
      grep -qx "    wp-content/plugins/removable/removable.php" <<<"$2" && grep -qx "    wp-content/plugins/removable/inc/deep.php" <<<"$2"' _ "$status" "$out"
    check "$name: dry run removes nothing" [ -f "$webroot/wp-content/plugins/removable/inc/deep.php" ]
  fi
  out="$(deploy staging)" && status=0 || status=$?
  check "$name: second deploy succeeds" [ "$status" = 0 ]
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  check "$name: second deploy verifies the changed files" grep -q "Verified 3 changed paths" <<<"$out"
  check "$name: changed file is updated" grep -q v2 "$webroot/wp-content/plugins/real/real.php"
  # The host gets the payload and none of the repo's history (2.0.0 to 2.2.2 pushed it).
  # The second deploy builds on the first, so the push sends only changed objects.
  deploy_commit="$(sed -n 's/^==> Deploy commit \([0-9a-f]*\).*/\1/p' <<<"$out")"
  # On WP Engine the first deploy builds on the placeholder commit, which is a deploy commit too.
  pushed_commits=2
  [ "$host" != wpengine ] || pushed_commits=3
  check "$name: the second deploy builds on the first" bash -c '[ "$(git --git-dir="$1" rev-list --count "$2")" = "$4" ] && [ "$(git --git-dir="$1" rev-parse "$2^")" = "$3" ]' _ "$server_git" "$branch" "$first_deploy" "$pushed_commits"
  check "$name: every pushed commit is a deploy commit" [ "$(git --git-dir="$server_git" rev-list --count --grep="^Deployed-by: wp-deploy " "$branch")" = "$pushed_commits" ]
  check "$name: no source commit reaches the host" no_source_commits "$repo" "$server_git"
  check "$name: older file versions never reach the host" bash -c '! git --git-dir="$1" cat-file -e "$(printf "history-only-secret\n" | git hash-object --stdin)" 2>/dev/null' _ "$server_git"
  check "$name: the pushed tree is the payload" [ "$(git --git-dir="$server_git" rev-parse "$branch^{tree}")" = "$(git -C "$repo" rev-parse "$deploy_commit:$pushed_path")" ]
  check "$name: deleted plugin is removed from the server" [ ! -e "$webroot/wp-content/plugins/removable" ]
  [ "$host" != wpengine ] || check "$name: the script removes files WP Engine left" grep -q "Removing 2 file(s)" <<<"$out"
  check "$name: wp-config.php, uploads and server-only plugins are kept" bash -c 'grep -q server-config "$1/wp-config.php" && [ -f "$1/wp-content/uploads/2026/photo.jpg" ] && [ -f "$1/wp-content/plugins/server-only/server-only.php" ]' _ "$webroot"
  case "$host" in
    kinsta) check "$name: Kinsta mu-plugins are kept" [ -f "$webroot/wp-content/mu-plugins/kinsta-mu-plugins.php" ] ;;
    wpengine) check "$name: WP Engine platform files are kept" bash -c '[ -f "$1/_wpeprivate/config.json" ] && [ -f "$1/wp-content/mu-plugins/wpengine-common/plugin.php" ]' _ "$webroot" ;;
  esac

  out="$(deploy plugins)" && status=0 || status=$?
  check "$name: local plugin report runs without SSH" [ "$status" = 0 ]
  check "$name: local report lists committed non-composer plugins with versions" bash -c 'grep -Eq "^    wp-content/plugins/committed-extra +- +1\.4\.2$" <<<"$1" && grep -Eq "^    wp-content/mu-plugins/site-mu\.php +- +0\.3$" <<<"$1"' _ "$out"
  check "$name: local report marks excluded plugins" grep -Eq "^    wp-content/plugins/dev-only +- +- +\(excluded from deploys\)$" <<<"$out"
  check "$name: local report skips composer plugins" bash -c '! grep -q "plugins/real" <<<"$1"' _ "$out"
  check "$name: local report summary" grep -q "^Not managed by composer: 3 committed to the repo$" <<<"$out"
  check "$name: local report lists composer.json requirements missing from composer.lock" bash -c 'sed -n "/^## composer.json requirements missing/,\$p" <<<"$1" | grep -qx "  wpackagist-plugin/not-locked" && grep -q "^composer.json requirements missing from composer.lock: 1$" <<<"$1"' _ "$out"

  write "$webroot/composer.json"
  out="$(deploy audit staging)" && status=0 || status=$?
  check "$name: audit succeeds" [ "$status" = 0 ]
  check "$name: audit names the server deploy commit's source" grep -qx "Server deploy commit's source: $(git -C "$repo" rev-parse HEAD)" <<<"$out"
  check "$name: audit has no .env warning without .env files" bash -c '! grep -q "WARNING" <<<"$1"' _ "$out"
  check "$name: audit reports excluded files on the server" grep -q "^  composer.json" <<<"$out"
  check "$name: audit reports server-only plugins" grep -Eq "^  server-only +[a-z-]+ +untracked$" <<<"$out"
  check "$name: audit summary line" grep -q "^audit: 1 excluded path(s) on server, 0 deleted tracked file(s).*, 3 plugin(s) not managed by composer$" <<<"$out"
  check "$name: audit lists committed non-composer plugins" bash -c 'grep -Eq "^    wp-content/plugins/committed-extra +[a-z-]+ +1\.4\.2$" <<<"$1" && grep -Eq "^    wp-content/mu-plugins/site-mu\.php +[a-z-]+ +0\.3$" <<<"$1"' _ "$out"
  check "$name: audit lists server-only non-composer plugins" grep -Eq "^    wp-content/plugins/server-only +[a-z-]+ +2\.0$" <<<"$out"
  check "$name: audit skips composer plugins and host mu-plugins" bash -c '! sed -n "/^## Not managed by composer/,\$p" <<<"$1" | grep -Eq "plugins/(real|nested-pkg)|kinsta-mu|wpengine|wpe-|force-strong"' _ "$out"
  check "$name: audit leaves host mu-plugins out of never-in-git" bash -c '! sed -n "/^## Plugins, themes and mu-plugins on the server/,/^## Plugins on the server/p" <<<"$1" | grep -Eq "kinsta-mu|wpengine|wpe-|force-strong"' _ "$out"
  check "$name: audit lists composer.json requirements missing from composer.lock" grep -q "^composer.json requirements missing from composer.lock: 1$" <<<"$out"
  if [ "$host" = wpengine ]; then
    check "$name: audit warns about a composer package with no plugin file" grep -q "^  Warning: composer package(s) with no plugin file: nested-pkg\.$" <<<"$out"
  else
    check "$name: audit has no no-plugin-file warning without WP-CLI" bash -c '! grep -q "no plugin file" <<<"$1"' _ "$out"
  fi
  check "$name: audit composer summary" grep -q "^Not managed by composer: 2 committed to the repo, 1 on the server only$" <<<"$out"
  [ "$host" != wpengine ] || check "$name: audit shows WP-CLI status" bash -c 'grep -Eq "^    wp-content/plugins/server-only +inactive +2\.0$" <<<"$1" && grep -Eq "^    wp-content/plugins/committed-extra +active +1\.4\.2$" <<<"$1"' _ "$out"
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  rm "$webroot/composer.json"

  # prune: files deleted from the repo that older deploys left on the server.
  # Commit fixtures, delete them, and deploy that (it installs pending.php).
  for f in wp-content/plugins/real/old-version.php vendor/old-lib/lib.php wp-content/plugins/gone/gone.php \
    wp-content/languages/old.mo wp-content/plugins/dev-only/old.php wp-content/uploads/2020/old.jpg; do
    write "$wp/$f" fixture
  done
  write "$wp/wp-content/plugins/real/pending.php" pending
  git -C "$repo" add -A
  git -C "$repo" commit -qm "prune fixtures"
  git -C "$repo" rm -q -r "${prefix}vendor" "${prefix}wp-content/plugins/gone" "${prefix}wp-content/languages" "${prefix}wp-content/uploads" \
    "${prefix}wp-content/plugins/real/old-version.php" "${prefix}wp-content/plugins/dev-only/old.php"
  git -C "$repo" commit -qm "remove prune fixtures"
  out="$(deploy staging)" && status=0 || status=$?
  check "$name: deploy before prune succeeds" [ "$status" = 0 ]
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  # HEAD deletes pending.php, but the server's deploy commit still has it.
  git -C "$repo" rm -q "${prefix}wp-content/plugins/real/pending.php"
  git -C "$repo" commit -qm "remove pending, not deployed"
  for f in wp-content/plugins/real/old-version.php vendor/old-lib/lib.php wp-content/plugins/gone/gone.php \
    wp-content/languages/old.mo wp-content/plugins/dev-only/old.php wp-content/uploads/2020/old.jpg; do
    write "$webroot/$f" leftover
  done
  kept_by_prune() {
    [ -f "$webroot/wp-content/plugins/real/pending.php" ] && [ -f "$webroot/wp-content/plugins/gone/gone.php" ] &&
      [ -f "$webroot/wp-content/languages/old.mo" ] && [ -f "$webroot/wp-content/plugins/dev-only/old.php" ] &&
      [ -f "$webroot/wp-content/uploads/2020/old.jpg" ] && [ -f "$webroot/wp-content/uploads/2026/photo.jpg" ] &&
      grep -q server-config "$webroot/wp-config.php" && [ -f "$webroot/wp-content/plugins/server-only/server-only.php" ]
  }

  out="$(deploy prune staging)" && status=0 || status=$?
  check "$name: prune dry run succeeds" [ "$status" = 0 ]
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  check "$name: prune dry run removes nothing" bash -c '[ -f "$1/wp-content/plugins/real/old-version.php" ] && [ -f "$1/vendor/old-lib/lib.php" ]' _ "$webroot"
  check "$name: prune counts files to remove and keep" grep -q "^prune: 2 file(s) to remove, 4 kept$" <<<"$out"
  check "$name: prune groups older plugin files" bash -c 'sed -n "/^## Files to remove/,/^## Files kept/p" <<<"$1" | grep -Eq "^    wp-content/plugins/real/ +1 file\(s\)$"' _ "$out"
  check "$name: prune groups other files by folder" grep -Eq "^    vendor/ +1 file\(s\)$" <<<"$out"
  check "$name: prune keeps files the server's deploy commit has" bash -c 'sed -n "/In the server.s deploy commit/,/^  [A-Z]/p" <<<"$1" | grep -q "wp-content/plugins/real/"' _ "$out"
  check "$name: prune keeps plugins no longer in the repo or composer" grep -q "no longer in the repo or composer.lock (.*): 1$" <<<"$out"
  check "$name: prune keeps other wp-content content" grep -Eq "^    wp-content/languages/ +1 file\(s\)$" <<<"$out"
  check "$name: prune keeps excluded paths" grep -q "Matched by the include or exclude list: 1$" <<<"$out"
  check "$name: prune never lists uploads" bash -c '! grep -q "uploads/2020" <<<"$1"' _ "$out"
  check "$name: prune dry run says how to delete" grep -q "prune staging --delete" <<<"$out"
  out="$(deploy prune staging --verbose)" || true
  check "$name: prune --verbose lists every file" grep -qx "    wp-content/plugins/real/old-version.php" <<<"$out"

  out="$(DEPLOY_PRUNE_BACKUP_DIR="$case_dir/backups" deploy prune staging --delete)" && status=0 || status=$?
  check "$name: prune --delete succeeds" [ "$status" = 0 ]
  [ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
  check "$name: prune --delete removes the stale files" bash -c '[ ! -e "$1/wp-content/plugins/real/old-version.php" ] && [ ! -e "$1/vendor" ]' _ "$webroot"
  check "$name: prune --delete keeps everything else" kept_by_prune
  check "$name: prune --delete keeps the plugin folder" [ -f "$webroot/wp-content/plugins/real/real.php" ]
  backup="$(ls "$case_dir"/backups/*-staging-*.tar.gz 2>/dev/null | head -n 1)"
  check "$name: prune --delete backs the files up first" bash -c '[ -n "$1" ] && [ "$(tar -tzf "$1" | grep -v "/$" | sort | tr "\n" " ")" = "vendor/old-lib/lib.php wp-content/plugins/real/old-version.php " ] && [ "$(tar -xOzf "$1" vendor/old-lib/lib.php)" = leftover ]' _ "$backup"
  check "$name: prune --delete reports the backup" grep -q "Removed 2 file(s). Backup: $case_dir/backups/" <<<"$out"
  check "$name: prune --delete runs the audit afterwards" grep -q "^audit: .*, 3 deleted tracked file(s) on server," <<<"$(sed -n '/^==> Removed/,$p' <<<"$out")"
  check "$name: the audit leaves excluded files out of the deleted list" bash -c 'sed -n "/^==> Removed/,\$p" <<<"$1" | sed -n "/^## Files deleted/,/^## Plugins,/p" | grep -q "^  (1 file(s) matching the exclude list" && ! sed -n "/^==> Removed/,\$p" <<<"$1" | sed -n "/^## Files deleted/,/^## Plugins,/p" | grep -q dev-only' _ "$out"
  out="$(DEPLOY_PRUNE_BACKUP_DIR="$case_dir/backups" deploy prune staging --delete)" && status=0 || status=$?
  check "$name: a second prune has nothing to remove" bash -c '[ "$1" = 0 ] && grep -q "Nothing to remove" <<<"$2"' _ "$status" "$out"
  unset -f kept_by_prune

  if [ "$failures" = "$before" ]; then matrix_passed=$((matrix_passed + 1)); fi
  unset -f deploy
}

for host in cloudways wpengine kinsta; do
  for layout in root subfolder; do
    run_case "$host" "$layout"
  done
done
run_case kinsta detached
run_case cloudways detached
for host in cloudways wpengine kinsta; do
  run_case "$host" nested
done

# Kinsta failure modes: a push the hook ignores, a bad remote, a rejected push.
export FAKE_ROOT="$WORK/case-kinsta-subfolder/server"
KREPO="$WORK/case-kinsta-subfolder/repo"
KWEB="$FAKE_ROOT/www/site_1/public"
KGIT="$FAKE_ROOT/www/site_1/private/site.git"
kdeploy() { (cd "$KREPO" && bash wordpress/_build/deploy.sh "$@" 2>&1); }
write "$KREPO/wordpress/wp-content/plugins/real/real.php" v3
git -C "$KREPO" commit -qam v3
out="$(DEPLOY_REMOTE_BRANCH=other kdeploy staging)" && status=0 || status=$?
check "kinsta: push to a branch the hook ignores fails" [ "$status" != 0 ]
check "kinsta: ignored push explains the checkout mismatch" grep -q "checkout does not match the push" <<<"$out"
check "kinsta: ignored push does not report complete" bash -c '! grep -q "complete" <<<"$1"' _ "$out"
out="$(COMPOSE_KINSTA_PROJECT_REPO=missing kdeploy staging)" && status=0 || status=$?
check "kinsta: push to a bad remote fails" [ "$status" != 0 ]
printf '#!/bin/sh\necho "rejected by test"\nexit 1\n' >"$KGIT/hooks/pre-receive"
chmod +x "$KGIT/hooks/pre-receive"
out="$(kdeploy staging)" && status=0 || status=$?
check "kinsta: rejected push fails" [ "$status" != 0 ]
check "kinsta: rejected push says the push failed" grep -q "git push to staging failed" <<<"$out"
rm "$KGIT/hooks/pre-receive"
write "$KWEB/wp-content/plugins/real/real.php" hotfix
out="$(kdeploy audit staging)" || true
check "kinsta: audit reports a deployed file changed on the server" grep -q "M wp-content/plugins/real/real.php" <<<"$out"
out="$(kdeploy staging)" && status=0 || status=$?
check "kinsta: redeploy after failures succeeds" [ "$status" = 0 ]
check "kinsta: redeploy installs the latest commit" grep -q v3 "$KWEB/wp-content/plugins/real/real.php"
# The push lands, then SSH drops before the checkout is read: the install is not proven, so exit 1, naming verify.
write "$KREPO/wordpress/wp-content/plugins/real/real.php" v4
git -C "$KREPO" commit -qam v4
kprev="$(git --git-dir="$KGIT" rev-parse master)"
out="$(FAKE_DOWN_AFTER_PUSH="$WORK/kinsta-down" kdeploy staging)" && status=0 || status=$?
rm -f "$WORK/kinsta-down"
check "kinsta: an SSH failure reading the checkout after the push exits 1" bash -c '[ "$1" = 1 ] && grep -q "^deploy: could not read the server.s checkout" <<<"$2" && ! grep -q "deploy completed" <<<"$2"' _ "$status" "$out"
check "kinsta: it names the verify command with the previous commit" grep -qF "bash _build/deploy.sh verify staging --from $kprev" <<<"$out"
out="$(kdeploy verify staging --from "$kprev")" && status=0 || status=$?
check "kinsta: verify checks the deploy once SSH is back" bash -c '[ "$1" = 0 ] && grep -q "Server checkout matches" <<<"$2" && grep -q "^==> Verified 1 changed paths" <<<"$2"' _ "$status" "$out"
# A first deploy (the server's branch was empty) cut off the same way names verify without --from,
# and verify checks every file of a commit with no parent.
write "$KREPO/wordpress/wp-content/plugins/real/real.php" v5
git -C "$KREPO" commit -qam v5
git --git-dir="$KGIT" update-ref -d refs/heads/master
out="$(FAKE_DOWN_AFTER_PUSH="$WORK/kinsta-down" kdeploy staging)" && status=0 || status=$?
rm -f "$WORK/kinsta-down"
check "kinsta: a cut-off first deploy names verify without --from" bash -c '[ "$1" = 1 ] && grep -qx "deploy: to rerun the checks without pushing: bash _build/deploy.sh verify staging" <<<"$2"' _ "$status" "$out"
out="$(kdeploy verify staging)" && status=0 || status=$?
check "kinsta: verify after a first deploy checks every file" bash -c '[ "$1" = 0 ] && grep -q "has no parent, so verify checks every file in it and removes none" <<<"$2" && grep -q "^==> Verified [0-9]* changed paths" <<<"$2" && grep -q "Verify of staging complete" <<<"$2"' _ "$status" "$out"

# WP Engine: the server's commit is WP Engine's own snapshot of the webroot (it
# commits one when it upgrades WordPress), not a deploy commit. Against it, every
# core file looks deleted by the deploy, so the deploy must remove nothing.
export FAKE_ROOT="$WORK/case-wpengine-subfolder/server"
WREPO="$WORK/case-wpengine-subfolder/repo"
WWEB="$FAKE_ROOT/home/wpe-user/sites/siteinstall"
WGIT="$FAKE_ROOT/wpe-git/siteinstall.git"
wdeploy() { (cd "$WREPO" && bash wordpress/_build/deploy.sh "$@" 2>&1); }
snapshot="$WORK/wpe-snapshot"
git clone -q --branch master "$WGIT" "$snapshot"
write "$snapshot/wp-includes/version.php" "<?php \$wp_version = '6.5';"
write "$snapshot/wp-login.php" core
git -C "$snapshot" add -A
git -C "$snapshot" commit -qm "Upgraded WordPress from 6.4 to 6.5"
git -C "$snapshot" push -q origin master 2>/dev/null
foreign="$(git -C "$snapshot" rev-parse --short HEAD)"
check "wpengine: the snapshot is installed" [ -f "$WWEB/wp-includes/version.php" ]
git -C "$WREPO" rm -q -r wordpress/wp-content/plugins/committed-extra
write "$WREPO/wordpress/wp-content/plugins/real/real.php" v4
git -C "$WREPO" commit -qam "remove committed-extra"
out="$(wdeploy staging --dry-run)" && status=0 || status=$?
check "wpengine: dry run over a snapshot succeeds" [ "$status" = 0 ]
check "wpengine: dry run names the snapshot commit" grep -q "server's commit $foreign \"Upgraded WordPress from 6.4 to 6.5\" is not a wp-deploy commit" <<<"$out"
check "wpengine: dry run lists the files it leaves" bash -c 'grep -qx "    wp-includes/version.php" <<<"$1" && grep -qx "    wp-login.php" <<<"$1"' _ "$out"
out="$(wdeploy staging)" && status=0 || status=$?
check "wpengine: deploy over a snapshot succeeds" bash -c '[ "$1" = 0 ] && grep -q "Deploy to staging complete" <<<"$2"' _ "$status" "$out"
[ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
check "wpengine: deploy over a snapshot warns and names the commit" grep -q "WARNING: the server's commit $foreign \"Upgraded WordPress from 6.4 to 6.5\" is not a wp-deploy commit" <<<"$out"
check "wpengine: the warning suggests audit and prune" grep -q "deploy.sh audit staging, then bash _build/deploy.sh prune staging" <<<"$out"
check "wpengine: deploy over a snapshot removes nothing" bash -c '! grep -q "^==> Removing" <<<"$1"' _ "$out"
check "wpengine: core files from the snapshot are kept" bash -c '[ -f "$1/wp-includes/version.php" ] && [ -f "$1/wp-login.php" ]' _ "$WWEB"
check "wpengine: files the deploy deleted are left too" [ -f "$WWEB/wp-content/plugins/committed-extra/committed-extra.php" ]
check "wpengine: changed files are still installed and verified" bash -c 'grep -q v4 "$1/wp-content/plugins/real/real.php" && grep -q "^==> Verified" <<<"$2"' _ "$WWEB" "$out"
check "wpengine: a deploy over a snapshot does not build on it" [ "$(git --git-dir="$WGIT" rev-list --count master)" = 1 ]
# The next deploy follows a deploy commit, so it removes what it deletes again.
git -C "$WREPO" rm -q wordpress/wp-content/mu-plugins/site-mu.php
git -C "$WREPO" commit -qm "remove site-mu"
out="$(wdeploy staging)" && status=0 || status=$?
check "wpengine: the deploy after a snapshot removes deleted files" bash -c '[ "$1" = 0 ] && grep -q "Removing 1 file(s)" <<<"$2" && [ ! -e "$3/wp-content/mu-plugins/site-mu.php" ]' _ "$status" "$out" "$WWEB"
check "wpengine: it still keeps the snapshot's core files" [ -f "$WWEB/wp-includes/version.php" ]

# verify reruns a deploy's checks and stale-file removal without pushing.
server_head="$(git --git-dir="$WGIT" rev-parse master)"
write "$WWEB/wp-content/mu-plugins/site-mu.php" stale
out="$(wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify removes a file the deploy deleted but left" bash -c '[ "$1" = 0 ] && grep -q "Removing 1 file(s)" <<<"$2" && [ ! -e "$3/wp-content/mu-plugins/site-mu.php" ]' _ "$status" "$out" "$WWEB"
[ "$status" = 0 ] || printf '%s\n' "$out" | sed 's/^/    | /'
check "wpengine: verify defaults --from to the server commit's parent" grep -q "Checking the files changed since $(git --git-dir="$WGIT" rev-parse master^)" <<<"$out"
check "wpengine: verify reports complete" grep -q "Verify of staging complete" <<<"$out"
check "wpengine: verify pushes nothing" [ "$(git --git-dir="$WGIT" rev-parse master)" = "$server_head" ]
# On WP Engine only the file check proves the install. SSH failing before it is a deploy failure that names verify.
write "$WREPO/wordpress/wp-content/plugins/real/real.php" v5
git -C "$WREPO" commit -qam v5
rm -f "$WORK/ssh.log"
out="$(FAKE_GATEWAY_DOWN=1 FAKE_SSH_LOG="$WORK/ssh.log" wdeploy staging)" && status=0 || status=$?
check "wpengine: an SSH failure after the push, before the file check, exits 1" [ "$status" = 1 ]
check "wpengine: it reports a deploy failure, not a completed deploy" bash -c 'grep -q "^deploy: could not read files on the server" <<<"$1" && ! grep -q "deploy completed" <<<"$1"' _ "$out"
check "wpengine: it names the verify command with the previous commit" grep -qF "bash _build/deploy.sh verify staging --from $server_head" <<<"$out"
check "wpengine: it does not report the deploy complete" bash -c '! grep -q "Deploy to staging complete" <<<"$1"' _ "$out"
check "wpengine: SSH sessions set keepalives" grep -q -- "-o ServerAliveInterval=15 -o ServerAliveCountMax=4" "$WORK/ssh.log"
check "wpengine: git pushes and ls-remote set keepalives" bash -c 'grep "git-receive-pack" "$1" | grep -q -- "-o ServerAliveInterval=15 -o ServerAliveCountMax=4" && grep "git-upload-pack" "$1" | grep -q -- "-o ServerAliveInterval=15 -o ServerAliveCountMax=4"' _ "$WORK/ssh.log"
server_head="$(git --git-dir="$WGIT" rev-parse master)"
out="$(wdeploy verify staging --from "$(git --git-dir="$WGIT" rev-parse master^)")" && status=0 || status=$?
check "wpengine: verify --from checks the deploy once SSH is back" bash -c '[ "$1" = 0 ] && grep -q "^==> Verified 1 changed paths" <<<"$2"' _ "$status" "$out"
check "wpengine: verify --from pushes nothing" [ "$(git --git-dir="$WGIT" rev-parse master)" = "$server_head" ]
write "$WWEB/wp-content/plugins/real/real.php" hotfix
out="$(wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify fails when a changed file differs on the server" bash -c '[ "$1" = 1 ] && grep -q "server files do not match the deploy" <<<"$2"' _ "$status" "$out"
check "wpengine: a failed verify does not claim a deploy" bash -c '! grep -q "deploy completed" <<<"$1"' _ "$out"
write "$WWEB/wp-content/plugins/real/real.php" v5
out="$(wdeploy verify staging --from nosuchref)" && status=0 || status=$?
check "wpengine: verify rejects an unknown --from" bash -c '[ "$1" = 1 ] && grep -q -- "--from nosuchref is not a commit" <<<"$2"' _ "$status" "$out"
out="$(wdeploy verify staging --from)" && status=0 || status=$?
check "wpengine: verify --from needs a value" bash -c '[ "$1" = 1 ] && grep -q -- "--from needs" <<<"$2"' _ "$status" "$out"
out="$(wdeploy staging --from HEAD)" && status=0 || status=$?
check "wpengine: --from only applies to verify" bash -c '[ "$1" = 1 ] && grep -q -- "--from only applies to verify" <<<"$2"' _ "$status" "$out"
out="$(wdeploy verify staging --dry-run)" && status=0 || status=$?
check "wpengine: verify takes no --dry-run" bash -c '[ "$1" = 1 ] && grep -q "verify pushes nothing" <<<"$2"' _ "$status" "$out"
check "wpengine: rejected verify options push nothing" [ "$(git --git-dir="$WGIT" rev-parse master)" = "$server_head" ]
# WP Engine accepts a push but never installs it: the files never match, so the deploy exits 1 and names verify.
mv "$WGIT/hooks/post-receive" "$WORK/wpe-post-receive"
write "$WREPO/wordpress/wp-content/plugins/real/real.php" v6
git -C "$WREPO" commit -qam v6
out="$(DEPLOY_VERIFY_ATTEMPTS=2 DEPLOY_VERIFY_WAIT=0 wdeploy staging)" && status=0 || status=$?
mv "$WORK/wpe-post-receive" "$WGIT/hooks/post-receive"
check "wpengine: files that never match after the push fail the deploy with exit 1" bash -c '[ "$1" = 1 ] && grep -q "^deploy: server files do not match the deploy" <<<"$2" && ! grep -q "deploy completed" <<<"$2"' _ "$status" "$out"
check "wpengine: an uninstalled push names the verify command" grep -qF "bash _build/deploy.sh verify staging --from $server_head" <<<"$out"
git --git-dir="$WGIT" archive master | tar -x -C "$WWEB"
out="$(wdeploy verify staging --from "$server_head")" && status=0 || status=$?
check "wpengine: verify passes once WP Engine installs the push" bash -c '[ "$1" = 0 ] && grep -q "^==> Verified 1 changed paths" <<<"$2"' _ "$status" "$out"
# verify removes files only against the server commit's parent: an older deploy ref, or another
# target's, would remove files the deploys since then left alone, such as a reinstalled site-mu.php.
write "$WWEB/wp-content/mu-plugins/site-mu.php" reinstalled
out="$(wdeploy verify staging --from "$(git --git-dir="$WGIT" rev-parse master~3)")" && status=0 || status=$?
check "wpengine: verify --from an older ref removes nothing" bash -c '[ "$1" = 0 ] && grep -q "so verify removes no files" <<<"$2" && ! grep -q "^==> Removing" <<<"$2" && [ -f "$3/wp-content/mu-plugins/site-mu.php" ]' _ "$status" "$out" "$WWEB"
check "wpengine: verify --from an older ref still checks the changed files" grep -q "^==> Verified 1 changed paths" <<<"$out"
rm "$WWEB/wp-content/mu-plugins/site-mu.php"
# A server commit that can't be fetched is reported as a fetch failure, not as a foreign commit.
server_head="$(git --git-dir="$WGIT" rev-parse master)"
unfetched="$(git --git-dir="$WGIT" commit-tree "master^{tree}" -p master -m "Deploy from another clone" -m "$WP_DEPLOY_TRAILER $WP_DEPLOY_VERSION")"
git --git-dir="$WGIT" update-ref refs/heads/master "$unfetched"
mkdir -p "$WORK/nofetch-bin"
printf '#!/bin/sh\n[ "$1" != fetch ] || { echo "fatal: Could not read from remote repository." >&2; exit 128; }\nexec %s "$@"\n' "$(command -v git)" >"$WORK/nofetch-bin/git"
chmod +x "$WORK/nofetch-bin/git"
out="$(PATH="$WORK/nofetch-bin:$PATH" wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify reports a failed fetch as a fetch failure" bash -c '[ "$1" = 1 ] && grep -q "could not fetch the server.s commit $2" <<<"$3" && ! grep -q "not a wp-deploy commit" <<<"$3"' _ "$status" "$unfetched" "$out"
out="$(wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify fetches a server commit made from another clone" bash -c '[ "$1" = 0 ] && grep -q "Verify of staging complete" <<<"$2"' _ "$status" "$out"
git --git-dir="$WGIT" update-ref refs/heads/master "$server_head"
# The push lands, then the Git remote can't be read to confirm it: exit 1 with a message and the verify command.
write "$WREPO/wordpress/wp-content/plugins/real/real.php" v7
git -C "$WREPO" commit -qam v7
out="$(FAKE_GIT_DOWN_AFTER_PUSH="$WORK/wpe-git-down" wdeploy staging)" && status=0 || status=$?
rm -f "$WORK/wpe-git-down"
check "wpengine: an unreadable remote after the push fails the deploy with exit 1" bash -c '[ "$1" = 1 ] && grep -q "^deploy: could not read .* after the push, so the push is unconfirmed" <<<"$2" && ! grep -q "deploy completed" <<<"$2"' _ "$status" "$out"
check "wpengine: an unreadable remote after the push names the verify command" grep -qF "bash _build/deploy.sh verify staging --from $server_head" <<<"$out"
out="$(wdeploy verify staging --from "$server_head")" && status=0 || status=$?
check "wpengine: verify confirms the push once the remote is back" bash -c '[ "$1" = 0 ] && grep -q "^==> Verified 1 changed paths" <<<"$2"' _ "$status" "$out"
server_head="$(git --git-dir="$WGIT" rev-parse master)"
# DEPLOY_NEW_HISTORY pushes a commit with no parent; its Replaces trailer lets verify remove files
# against the commit it replaced, the one the deploy's hint names.
write "$WREPO/wordpress/wp-content/plugins/real/extra.php" extra
git -C "$WREPO" add -A
git -C "$WREPO" commit -qm "add extra"
out="$(wdeploy staging)" && status=0 || status=$?
check "wpengine: a deploy that adds a file succeeds" [ "$status" = 0 ]
server_head="$(git --git-dir="$WGIT" rev-parse master)"
git -C "$WREPO" rm -q wordpress/wp-content/plugins/real/extra.php
git -C "$WREPO" commit -qm "remove extra"
out="$(DEPLOY_NEW_HISTORY=true FAKE_GATEWAY_DOWN=1 wdeploy staging)" && status=0 || status=$?
check "wpengine: a cut-off new-history deploy names verify with the commit it replaced" bash -c '[ "$1" = 1 ] && grep -qF "bash _build/deploy.sh verify staging --from $2" <<<"$3"' _ "$status" "$server_head" "$out"
check "wpengine: the new-history commit has no parent and names what it replaced" bash -c '! git --git-dir="$1" rev-parse -q --verify master^ >/dev/null && git --git-dir="$1" log -1 --format=%B master | grep -qx "Replaces: $2"' _ "$WGIT" "$server_head"
out="$(wdeploy verify staging --from "$server_head")" && status=0 || status=$?
check "wpengine: verify --from the replaced commit removes what the deploy deleted" bash -c '[ "$1" = 0 ] && grep -q "Removing 1 file(s)" <<<"$2" && [ ! -e "$3/wp-content/plugins/real/extra.php" ]' _ "$status" "$out" "$WWEB"
out="$(wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify defaults --from to the commit a parentless deploy replaced" bash -c '[ "$1" = 0 ] && grep -q "Checking the files changed since $2" <<<"$3"' _ "$status" "$server_head" "$out"
server_head="$(git --git-dir="$WGIT" rev-parse master)"
# verify refuses a server commit without the trailer, which deploy commits carry from 2.2.3.
untrailed="$(git --git-dir="$WGIT" commit-tree "master^{tree}" -p master -m "Upgraded WordPress")"
git --git-dir="$WGIT" update-ref refs/heads/master "$untrailed"
out="$(wdeploy verify staging)" && status=0 || status=$?
check "wpengine: verify refuses a server commit without the trailer" bash -c '[ "$1" = 1 ] && grep -q "is not a wp-deploy commit from 2.2.3 or later" <<<"$2"' _ "$status" "$out"
git --git-dir="$WGIT" update-ref refs/heads/master "$server_head"
unset -f wdeploy

# Cloudways: a changed hook setting blocks deploys until install-hook runs again.
export FAKE_ROOT="$WORK/case-cloudways-subfolder/server"
CREPO="$WORK/case-cloudways-subfolder/repo"
CGIT="$FAKE_ROOT/srv/app/private_html/site.git"
# The hook reports DEPLOY_OK, but the branch then moves: the deploy is not proven, so it exits 1.
write "$CREPO/wordpress/wp-content/plugins/real/real.php" cw3
git -C "$CREPO" commit -qam cw3
printf '#!/bin/sh\ngit update-ref refs/heads/master "$(git rev-parse refs/heads/master^)"\n' >"$CGIT/hooks/post-update"
chmod +x "$CGIT/hooks/post-update"
out="$(cd "$CREPO" && bash wordpress/_build/deploy.sh staging 2>&1)" && status=0 || status=$?
check "cloudways: a branch that moved after DEPLOY_OK fails the deploy with exit 1" bash -c '[ "$1" = 1 ] && grep -q "staging master is .*, expected" <<<"$2" && ! grep -q "deploy completed" <<<"$2"' _ "$status" "$out"
rm "$CGIT/hooks/post-update"
out="$(cd "$CREPO" && DEPLOY_REMOTE_BRANCH=main bash wordpress/_build/deploy.sh staging 2>&1)" && status=0 || status=$?
check "cloudways: a changed hook setting blocks the deploy" bash -c '[ "$1" != 0 ] && grep -q "install-hook staging" <<<"$2"' _ "$status" "$out"
unset GIT_SSH_COMMAND GIT_SSH_VARIANT

echo
echo "host x layout cases: $matrix_passed of $matrix_cases passed"
if [ "$failures" -gt 0 ]; then
  echo "$failures of $((passes + failures)) test(s) failed"
  exit 1
fi
echo "all $passes tests passed"
