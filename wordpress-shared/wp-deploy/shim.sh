#!/usr/bin/env bash
# wp-deploy shim, for a site that installs the kit with Composer
# (composer require --dev patronage/launch-wp-deploy). Copy this file into the
# site's _build/ folder twice, as deploy.sh and as pull.sh, and commit both.
# Each runs the installed kit's script of the same name with this folder's
# settings: deploy.env, the include and exclude lists, and .env above it.
# If Composer's vendor folder isn't next to _build/, change kit= below.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
kit="${WP_DEPLOY_KIT_DIR:-$here/../vendor/patronage/launch-wp-deploy}"
script="$kit/$(basename "${BASH_SOURCE[0]}")"
if [ ! -f "$script" ]; then
  echo "wp-deploy: $script is missing. Run composer install (the kit is patronage/launch-wp-deploy), or set kit= in $here/$(basename "${BASH_SOURCE[0]}")." >&2
  exit 1
fi
WP_DEPLOY_BUILD_DIR="$here" exec bash "$script" "$@"
