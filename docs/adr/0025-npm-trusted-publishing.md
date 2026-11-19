# ADR 0025: npm Trusted Publishing for three Launch packages

## Status

Accepted, 2026-11-19. Supersedes [ADR 0004](0004-local-verification-and-workers-builds.md).

## Context

Launch verifies changes locally and deploys through Cloudflare Workers Builds. npm Trusted Publishing lets a specific GitHub Actions workflow publish with short-lived OpenID Connect (OIDC) credentials. Launch can use it for the three `@patronage/launch-*` npm packages without provisioning a publish token.

## Decision

- Run `pnpm verify` locally before opening a pull request. Workers Builds handles deploys and branch Previews where enabled.
- Allow one GitHub Actions workflow, `.github/workflows/npm-publish.yml`, for `@patronage/launch-images`, `@patronage/launch-logging` and `@patronage/launch-wpgraphql`. A maintainer dispatches it from `main` for one exact version. It defaults to a dry run.
- Use GitHub-hosted runners. Verification and packing run without access to an OIDC token. The publish job uses the `npm-release` environment, restricted to `main` with a required reviewer, and receives `id-token: write` to publish the verified tarball with the npm CLI.
- Keep Changesets for versioning all npm packages. Keep the interactive publish path for first publishes, Access and the MCP packages. A maintainer pushes each release’s annotated Git tag after verifying the exact public version.

## Consequences

- GitHub Actions does not run PR checks or deploy Workers. The npm workflow uses no npm token or Cloudflare credentials.
- Each package has its own npm Trusted Publisher binding. Set it up just before its first intended OIDC release. npm expires a new binding after two days unless it completes a successful OIDC publish. See the [release guide](https://launch.patronage.com/references/mcp#releasing-the-npm-packages).
