#!/usr/bin/env bash
# wp-deploy shim, for a site that installs the kit with Composer
# (composer require --dev patronage/launch-wp-deploy). Copy this file into the
# site's _build/ folder twice, as deploy.sh and as pull.sh, and commit both.
# Each runs the installed kit's script of the same name with this folder's
# settings: deploy.env, the include and exclude lists, and .env above it.
# If Composer's vendor folder isn't next to _build/, change kit= below.
#
# The kit runs from a temporary copy: a deploy's build step usually runs
# `composer install --no-dev`, which deletes dev dependencies such as the kit
# while the deploy still needs its files. Run `composer install` again after a
# deploy to get the kit (and your other dev tools) back.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
kit="${WP_DEPLOY_KIT_DIR:-$here/../vendor/patronage/launch-wp-deploy}"
name="$(basename "${BASH_SOURCE[0]}")"
if [ ! -f "$kit/$name" ]; then
  echo "wp-deploy: $kit/$name is missing. Run composer install (the kit is patronage/launch-wp-deploy, a dev dependency), or set kit= in $here/$name." >&2
  exit 1
fi
copy="$(mktemp -d "${TMPDIR:-/tmp}/wp-deploy-kit.XXXXXX")"
trap 'rm -rf "$copy"' EXIT
cp "$kit"/*.sh "$copy/"
status=0
WP_DEPLOY_BUILD_DIR="$here" bash "$copy/$name" "$@" || status=$?
exit "$status"
