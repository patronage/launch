#!/usr/bin/env bash
# Syntax-checks the PHP this app commits (the theme, the mu-plugin loaders and
# the wp-config sample). Composer's plugins are not ours to lint, and the
# shared mu-plugins the loaders require are linted in wordpress-shared.
set -euo pipefail
cd "$(dirname "$0")/.."

find wp-content/themes/patronage-headless _build -name '*.php' -print0 |
  xargs -0 -n1 php -l >/dev/null
find wp-content/mu-plugins -maxdepth 1 -name '*.php' -print0 |
  xargs -0 -n1 php -l >/dev/null
