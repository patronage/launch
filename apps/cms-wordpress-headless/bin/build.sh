#!/usr/bin/env bash
# Builds the files a deploy adds to git's: the production plugins and libraries
# from composer.lock, and the shared Access and fields mu-plugins.
# _build/deploy.sh runs it as DEPLOY_BUILD_TASK, and _build/.deploy_include.txt adds its output.
set -euo pipefail
cd "$(dirname "$0")/.."

# Use the host's Composer if there is one, else its official image, as setup.sh does.
args=(install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader)
if command -v composer >/dev/null 2>&1; then
  composer "${args[@]}"
else
  # shellcheck disable=SC2086
  docker run --rm -u "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer ${COMPOSER_DOCKER_ARGS:-} \
    -v "$PWD":/app -w /app composer:2 "${args[@]}"
fi

# The include list ships all of wp-content/plugins, so refuse anything there that
# composer.lock doesn't install, such as a plugin added by hand for local testing.
node --input-type=module -e '
  import { readFileSync, readdirSync } from "node:fs";
  const lock = JSON.parse(readFileSync("composer.lock", "utf8"));
  const plugins = lock.packages.filter((pkg) => pkg.type === "wordpress-plugin").map((pkg) => pkg.name.split("/")[1]);
  const found = readdirSync("wp-content/plugins");
  const extra = found.filter((name) => !["composer-libs", "index.php", ...plugins].includes(name));
  const missing = plugins.filter((name) => !found.includes(name));
  if (extra.length > 0) {
    console.error(`build: wp-content/plugins has entries composer.lock does not install: ${extra.join(", ")}`);
    console.error("build: remove them, or deploy from a fresh clone.");
    process.exit(1);
  }
  // Composer disables composer/installers when it runs as root without
  // COMPOSER_ALLOW_SUPERUSER, and the plugins land in composer-libs instead.
  if (missing.length > 0) {
    console.error(`build: Composer did not install these plugins into wp-content/plugins: ${missing.join(", ")}`);
    process.exit(1);
  }
'

# A package Composer cloned from source has its own .git, which git would add as
# an empty gitlink, so the deploy would ship the package without its files.
nested_git="$(find wp-content/plugins -name .git -print -quit)"
if [[ -n "$nested_git" ]]; then
  echo "build: $nested_git: Composer installed a package from source; rerun once dist downloads work" >&2
  exit 1
fi

# WordPress loads only top-level mu-plugin files, so copy the shared plugin in.
# Read it from HEAD: the deploy's clean-tree check covers only this folder, and
# the deploy commit names HEAD as its source.
git show HEAD:./../../wordpress-shared/patronage-access/patronage-access.php >wp-content/mu-plugins/patronage-access.php

# The shared field groups and post types, minus their seed. The committed
# mu-plugins/patronage-fields.php loads them from this folder.
rm -rf wp-content/mu-plugins/patronage-fields
mkdir -p wp-content/mu-plugins/patronage-fields
git -C "$(git rev-parse --show-toplevel)" archive HEAD:wordpress-shared/patronage-fields patronage-fields.php post-types.php fields |
  tar -x -C wp-content/mu-plugins/patronage-fields
