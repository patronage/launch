#!/usr/bin/env bash
# Run by `pnpm run pull import` (PULL_IMPORT_TASK in _build/deploy.env) after it
# loads a server's database: points the site's URLs at local Docker and gives
# the front-end's preview editor a new application password, since the import
# replaced the local users.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a
WP_URL="http://localhost:${WP_PORT:-8080}"

wp() { docker compose run --rm -T cli wp "$@"; }

for option in siteurl home; do
  url="$(wp option get "$option" | tr -d '\r')"
  if [[ -n "$url" && "$url" != "$WP_URL" ]]; then
    echo "Replacing $url with $WP_URL"
    wp search-replace "$url" "$WP_URL" --all-tables-with-prefix --skip-columns=guid --report-changed-only
  fi
done

bin/previewer.sh
