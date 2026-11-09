# Contributing to Launch

Launch is Patronage's public monorepo of reference sites. Issues and pull requests are welcome.

The documentation at [launch.patronage.com](https://launch.patronage.com) is the authoritative guide to setting up, running and deploying Launch. Start there; this file covers only how to contribute.

## Before you start

- Open an [issue](https://github.com/patronage/launch/issues) before a large change, so we can agree on the approach first.
- To report a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- Read the decision records in [`docs/adr/`](docs/adr/) and the terms in [`GLOSSARY.md`](GLOSSARY.md). A change that goes against a decision needs a new record that supersedes it.

## Set up

Install the prerequisites and run the checks as described in [Getting started](https://launch.patronage.com/getting-started): Node 24.22.1 or later, pnpm 12, Git, Bash, PHP 8.1 or later with OpenSSL, and Docker for the WordPress references.

```bash
pnpm install
pnpm verify
```

## Rules

The repo is public, so everything in it, including issues, pull requests and commit messages, must be fit to publish. [AGENTS.md](AGENTS.md) has the full list; the ones that most often come up:

- **No vendor code.** Depend on npm packages and install WordPress plugins and themes through Composer. Only Patronage's own `patronage-*` WordPress code is committed.
- **No client references.** No client names, hostnames, ids, content, screenshots or credentials anywhere. Demo content is invented.
- **No Wrangler config files and no GitHub Actions.** Cloudflare resources are created by the scripts in the repo.
- **Shared UI takes plain props.** `packages/ui` knows nothing about WordPress or Payload; each CMS has an adapter.
- **Pin exact versions.** New dependencies must be older than the `minimumReleaseAge` in `pnpm-workspace.yaml`. Update them with the `deps:*` scripts.

## Pull requests

1. Keep a pull request to one change, and explain why it is needed.
2. Run `pnpm verify` and make it pass. Workers Builds only runs part of it, so passing it locally is the author's job.
3. If the change affects pages, sections, forms or the admin, check it in a browser. The `launch-verify` skill in `.agents/skills/` drives the Payload app and the headless WordPress front end and keeps screenshots.
4. If the change affects what a reader of the docs site would run, deploy, configure or decide, update the pages under `apps/docs-site/docs` in the same pull request, and run `pnpm --filter docs-site test`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
