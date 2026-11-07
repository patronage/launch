#!/usr/bin/env bash
# Gives the front-end's preview editor a fresh application password and writes
# apps/web-wordpress/.env.local. Run by bin/setup.sh, and after a database pull
# (bin/after-import.sh), which replaces the local users.
set -euo pipefail
cd "$(dirname "$0")/.."

FRONTEND_ENV="../web-wordpress/.env.local"
set -a
# shellcheck disable=SC1091
source .env
set +a
WP_URL="http://localhost:${WP_PORT:-8080}"

wp() { docker compose run --rm -T cli wp "$@"; }

# The front-end reads drafts with an application password for a dedicated editor.
if ! wp user get previewer >/dev/null 2>&1; then
  wp user create previewer previewer@example.com --role=editor --user_pass="$(openssl rand -hex 16)"
fi
wp user application-password delete previewer --all >/dev/null 2>&1 || true
APP_PASSWORD="$(wp user application-password create previewer web-wordpress --porcelain)"

cat >"$FRONTEND_ENV" <<ENV
WORDPRESS_URL=${WP_URL}
HEADLESS_SECRET=${HEADLESS_SECRET}
WORDPRESS_PREVIEW_USER=previewer
WORDPRESS_PREVIEW_PASSWORD=${APP_PASSWORD}
ENV
echo "Wrote ${FRONTEND_ENV}"
