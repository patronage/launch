# ADR 0025: npm Trusted Publishing for Launch's npm packages

## Status

Accepted, 2026-11-19. Supersedes [ADR 0004](0004-local-verification-and-workers-builds.md). Amended 2026-11-24 to publish every npm package through the workflow, not only the three `@patronage/launch-*` packages.

## Context

Launch verifies changes locally and deploys through Cloudflare Workers Builds. npm Trusted Publishing lets a specific GitHub Actions workflow publish with short-lived OpenID Connect (OIDC) credentials. Launch can use it for its npm packages without provisioning a publish token.

The first version of this decision covered only `@patronage/launch-images`, `@patronage/launch-logging` and `@patronage/launch-wpgraphql`, and kept Access and the MCP packages on interactive publishing from a maintainer's machine. A release that touched both groups then needed two routes and a hand-ordered sequence, and interactive publishing depends on one person's npm session and machine. The maintainers agreed to move every package to the workflow.

## Decision

- Run `pnpm verify` locally before opening a pull request. Workers Builds handles deploys and branch Previews where enabled.
- Allow one GitHub Actions workflow, `.github/workflows/npm-publish.yml`, for every published package: `@patronage/access`, `@patronage/launch-images`, `@patronage/launch-logging`, `@patronage/launch-wpgraphql`, `@patronage/mcp-core`, `@patronage/mcp-payload` and `@patronage/mcp-wordpress`. A maintainer dispatches it from `main` for one package and one exact version. It defaults to a dry run, and a real publish refuses a package whose `@patronage/*` dependencies are not on npm at the versions it names.
- Use GitHub-hosted runners. Verification and packing run without access to an OIDC token. The publish job uses the `npm-release` environment, restricted to `main` with a required reviewer, and receives `id-token: write` to publish the verified tarball with the npm CLI.
- Keep Changesets for versioning all npm packages. Keep the interactive publish path only for a package's first publish, since npm needs the package to exist before it can bind a Trusted Publisher. A maintainer pushes each release’s annotated Git tag after verifying the exact public version.

## Consequences

- GitHub Actions does not run PR checks or deploy Workers. The npm workflow uses no npm token or Cloudflare credentials.
- Each package has its own npm Trusted Publisher binding. Set it up just before its first intended OIDC release. npm expires a new binding after two days unless it completes a successful OIDC publish. See the [release guide](https://launch.patronage.com/references/mcp#releasing-the-npm-packages).
