#!/usr/bin/env bash
# Installs plugins with Composer, builds the theme's CSS, starts WordPress,
# and installs and seeds it. Safe to rerun: it skips what is done.
set -euo pipefail
cd "$(dirname "$0")/.."

# docker compose reads .env (gitignored) for WP_PORT; create it once.
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
WP_URL="http://localhost:${WP_PORT:-8090}"

wp() { docker compose run --rm -T cli wp "$@"; }

# Composer runs in its official image, so the host needs only Docker and pnpm.
# COMPOSER_DOCKER_ARGS adds docker run flags, e.g. to mount a proxy's CA bundle.
# shellcheck disable=SC2086
docker run --rm -u "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer ${COMPOSER_DOCKER_ARGS:-} \
  -v "$PWD":/app -w /app composer:2 install --no-interaction --no-progress
pnpm build:css
docker compose up -d --wait wordpress

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$WP_URL" --title="Launch Timber" \
    --admin_user=admin --admin_password=admin --admin_email=admin@example.com --skip-email
fi

wp plugin activate secure-custom-fields
wp theme activate patronage-timber
wp plugin delete akismet hello 2>/dev/null || true

bin/seed.sh

echo
echo "Site:  ${WP_URL}/"
echo "Admin: ${WP_URL}/wp-admin/ (admin / admin)"
echo "Rebuild CSS while editing views with: pnpm --filter cms-wordpress-timber dev:css"
