#!/usr/bin/env bash
# Seeds invented demo content (wordpress-shared/patronage-fields/seed, mounted
# at /seed). Skips pages that exist.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose run --rm -T cli wp eval-file /seed/seed.php
# Posts live under /news/ so they do not collide with pages.
docker compose run --rm -T cli wp rewrite structure '/news/%postname%/'
