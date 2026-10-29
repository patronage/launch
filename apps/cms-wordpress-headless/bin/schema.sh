#!/usr/bin/env bash
# Prints WPGraphQL's schema into apps/web-wordpress/schema.graphql with WP-CLI.
# Unlike introspection over HTTP, this needs no sign-in and keeps deprecated
# arguments, so codegen sees exactly what WordPress accepts.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose run --rm -T cli sh -c \
  'wp graphql generate-static-schema --output=/tmp/schema.graphql >/dev/null 2>&1 && cat /tmp/schema.graphql' \
  >../web-wordpress/schema.graphql.tmp
mv ../web-wordpress/schema.graphql.tmp ../web-wordpress/schema.graphql
echo "Wrote apps/web-wordpress/schema.graphql"
