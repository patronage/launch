# Launch

## What this codebase does

Launch is a public reference-site monorepo, not a multi-tenant service. Headless WordPress exposes WPGraphQL to a vinext Front-end on Cloudflare Workers. Payload 4 runs its CMS and public Front-end in one Worker, with D1 by default and optional Postgres through Hyperdrive. Shared React UI receives plain data from CMS Adapters. WordPress code is PHP; Workers and tooling are TypeScript, JavaScript and shell. `apps/cms-wordpress-timber` renders the public site through a Timber theme, and `apps/mcp` hosts the MCP gateway using the shared MCP packages. The four Composer-distributed mu-plugins also run on WordPress installs outside Launch; do not assume those installs inherit Launch's deployment or Access configuration.

## Auth shape

- `packages/access/src/jwt.ts`: `verifyAccessJwt` checks RS256, issuer, audience, expiry and identity. User identities and Service tokens differ.
- `accessAuthStrategy` maps a verified user email to an existing Payload user. A Service token must never become an editor or gain write access.
- `wordpress-shared/patronage-access` verifies Access assertions and forwarded user JWTs. Trace gateway proof and service identity before accepting headers.
- Access locks Payload `/admin` and `/api`; public routes and `/next` handlers require their own appropriate controls. WordPress has a separate CMS origin.
- Preview links/cookies, revalidation secrets and media proxying cross the public Front-end/CMS boundary. Verify them at the actual route handlers.

## Threat model

Prioritize anonymous or Service-token access to CMS writes, administrative sessions and unpublished content. Consider attacker-controlled URL paths, queries, headers, form submissions, uploads and CMS-authored rich text. A compromised editor must not gain server execution or expose server credentials. Treat documented Cloudflare protections as assumptions to trace through the provisioning and Worker code, not proof that a route is safe in production.

## Composer distribution and install boundary

`apps/docs-site/public/composer/packages.json` is the public package index at `https://launch.patronage.com/composer`. Its `dist.url` values lead through the static rules in `apps/docs-site/composer-redirects.txt` to GitHub release assets on `patronage/launch`. `apps/docs-site/scripts/build-output.mjs` appends those rules to Blume's `_redirects`; inspect `apps/docs-site/blume.config.ts` for overlapping routes, wildcard shadowing and redirect destinations. The index's SHA-1 `dist.shasum` binds the downloaded zip to the index entry, not to an independently authenticated publisher. An install using a committed Composer lockfile relies on the locked metadata; an update or install without a lockfile also trusts the current repository metadata.

Trust includes the maintainers who can merge index/build changes, operators who can change the docs Worker or Workers Builds deployment, and GitHub identities with release-write permission. Asset replacement alone should fail the recorded checksum; control of both metadata and assets crosses that boundary. Trace these as separate capabilities. Repository source cannot prove live branch protection, release permissions, Access policies or deployment configuration.

`wordpress-shared/plugin-release/release.ts` reads plugin `Version:` headers and `composer.json`, derives release tags and filenames, builds stored zips, and writes the index and redirects. Zip inputs are working-tree tracked files plus untracked files Git does not ignore, minus `.gitattributes` `export-ignore` paths, plus the root `LICENSE`. Investigate stray credentials, keys, backups, symlinks, path traversal, duplicate paths, zip size bounds and CRCs. `.gitignore`, export rules and `--publish`'s clean-tree check are different controls; none is a content secret scanner. Follow `execFileSync` argument arrays, `origin/main` verification and the checksum of the actual uploaded bytes before alleging shell injection or publication bypass.

Each package's `extra.installer-name` selects its `mu-plugins/<slug>/` folder. WordPress needs a top-level loader or an mu-plugin autoloader; inspect Access and Logging with those installation assumptions. Launch's current headless `composer.json` installs third-party plugins; `bin/build.sh` copies first-party mu-plugin source from Git HEAD, and `_build/.deploy_include.txt` ships that output. The moved Headless Revalidate code is in `wordpress-shared/patronage-headless-revalidate/`; the app's PHP file is now its loader. `docker-compose.yml` mounts the shared folder for local use. Trace the build, deploy include list and loader together rather than assuming the headless app already consumes our Composer packages.

## Fleet and revalidation boundaries

`wordpress-shared/patronage-fleet/patronage-fleet.php` sends outbound inventory only; it registers no public endpoint. Production configuration supplies a site identifier, a per-site Ed25519 seed and an Access Service token. The report includes the home URL, WordPress/PHP versions and plugin/theme versions, active states and available updates. It signs `<site>\n<timestamp>\n<body>` and posts to the configured Fleet URL with redirects disabled. The Service token reaches the receiver; the signature identifies the reporting site. Inspect configurable destinations, credential handling, signature inputs, response handling and mu-plugin folder/version discovery. Receiver-side key lookup, freshness/replay checks and report-path Access policy are external assumptions described by the plugin README, not code reviewed in this repository.

`wordpress-shared/patronage-headless-revalidate/` sends cache paths and tags to the Front-end with a shared secret and optional Access Service token. Check configured origins, redirect handling and both the queued PUT and WP-CLI verification GETs. Neither an Access Service token nor an arbitrary successful HTTP response proves that the Front-end authorized and performed cache invalidation.

## Project-specific patterns to flag

- Payload Local API `overrideAccess: true` reachable with untrusted input; distinguish internal identity lookup from public draft or secret disclosure.
- `/next/local-login` and `isLocalRequest`: prove remote callers and shared tunnels cannot obtain the first user's session by forging request headers.
- WordPress preview/revalidation handlers: verify signatures, expiry, authorization, redirect targets and cache invalidation scope.
- Media fetches and rich-text/link rendering: trace origin allowlists, URL resolution, redirects, escaping and credentials across Adapter boundaries.
- Deploy/provision scripts: trace shell arguments, archive paths and secret handling. Report deployment exposure separately from remotely reachable bugs.

## Known false-positive sources

- Seed content and `.env.example` contain invented demo values. They are not production credentials, but production paths must not rely on demo passwords.
- Public published Pages and Media reads are intentional. Drafts, Users, submissions and CMS mutations still need their own authorization checks.
- Tests contain forged JWTs, hostile URLs and bypass attempts as negative cases. Follow production call sites before reporting a test fixture as exploitable.
- Local login is intentional only on a developer's machine. Its stated intent is not an exemption: establish whether the localhost restriction holds.
- The WordPress adapter explicitly trusts editor-authored HTML (docs/spikes/03-cms-neutral-sections.md). Distinguish that documented trust decision from a lower-trust author gaining script execution; report the impact and prerequisites accurately.

## Verified platform context (2026-11-03)

Cloudflare Images binding billing counts each unique source-image/parameter combination once per calendar month. Repeated requests for the same transformation do not incur additional transformation usage. Query parameters ignored by Launch's image handlers do not change the binding's fixed width/quality or its three possible output formats. Missing caching can still increase processing work and origin traffic; evaluate those effects separately from a claim of unlimited per-request transformation billing. Source: [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/) (checked 2026-11-03).
