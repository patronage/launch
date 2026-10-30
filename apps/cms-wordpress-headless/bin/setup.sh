#!/usr/bin/env bash
# Installs plugins with Composer, starts WordPress, installs and seeds it, and
# writes the front-end's .env.local. Safe to rerun: it skips what is done.
set -euo pipefail
cd "$(dirname "$0")/.."

FRONTEND_ENV="../web-wordpress/.env.local"

# docker compose reads .env (gitignored). Create it once with a fresh secret.
if [[ ! -f .env ]]; then
  sed "s/^HEADLESS_SECRET=.*/HEADLESS_SECRET=$(openssl rand -hex 24)/" .env.example >.env
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
WP_URL="http://localhost:${WP_PORT:-8080}"

wp() { docker compose run --rm -T cli wp "$@"; }

# Composer runs in its official image, so the host needs only Docker.
# COMPOSER_DOCKER_ARGS adds docker run flags, e.g. to mount a proxy's CA bundle.
# shellcheck disable=SC2086
docker run --rm -u "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer ${COMPOSER_DOCKER_ARGS:-} \
  -v "$PWD":/app -w /app composer:2 install --no-interaction --no-progress
docker compose up -d --wait wordpress

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$WP_URL" --title="Launch Headless" \
    --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email
fi

wp plugin activate wp-graphql secure-custom-fields wp-graphql-acf wp-graphql-smart-cache formidable
wp theme activate patronage-headless
wp plugin delete akismet hello 2>/dev/null || true

bin/seed.sh

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

echo
echo "WordPress: ${WP_URL}/wp-admin/ (admin / admin)"
echo "GraphQL:   ${WP_URL}/graphql"
echo "Wrote ${FRONTEND_ENV}. Start the front-end with: pnpm --filter web-wordpress dev"
