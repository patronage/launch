# plugin-release

`pnpm wp:release`, which publishes the Composer packages in `wordpress-shared/` through `https://launch.patronage.com/composer` ([ADR 0017](../../docs/adr/0017-wordpress-plugins-through-composer.md)).

| Command | When | What it does |
| --- | --- | --- |
| `pnpm wp:release <folder>` | In the PR, after bumping the `Version:` header | Adds the version and its zip's sha1 to `apps/docs-site/public/composer/packages.json`, and its download redirect to `apps/docs-site/composer-redirects.txt` |
| `pnpm wp:release --check` | `pnpm test` | Fails if a package's files or `composer.json` metadata differ from its released version, or the two files disagree |
| `pnpm wp:release --publish [--dry-run]` | On `main`, after merge | Creates each missing GitHub release, `<package>-v<version>`, with its zip, through `gh` |

A zip is the package folder's files, minus its `.gitattributes` `export-ignore` paths, plus the repo's `LICENSE`, stored uncompressed with fixed timestamps and modes. The same files always make the same bytes, so the checksum can be committed before the zip exists. The docs site's `scripts/build-output.mjs` appends `composer-redirects.txt` to the `_redirects` Blume writes.

`node --test tests/*.test.ts` runs the tests against a throwaway repository.
