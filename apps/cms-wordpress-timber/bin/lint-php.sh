#!/usr/bin/env bash
# Syntax-checks the PHP this app commits (the theme, the mu-plugin loader and
# the wp-config sample). Composer's plugins are not ours to lint.
set -euo pipefail
cd "$(dirname "$0")/.."

find wp-content/themes/patronage-timber wp-content/mu-plugins/patronage-fields.php _build -name '*.php' -print0 |
  xargs -0 -n1 php -l >/dev/null
