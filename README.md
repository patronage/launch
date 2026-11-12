# Launch

Reference sites from [Patronage](https://www.patronage.org) for running a CMS behind Cloudflare Access with fast front-ends on Cloudflare Workers.

**Documentation: [launch.patronage.com](https://launch.patronage.com).** It is the authoritative guide to setting up, running and deploying every reference, and the decisions behind them. This README is a short summary.

Each reference renders the same demo site:

| Reference | CMS | Front-end |
| --- | --- | --- |
| Headless WordPress | WordPress + WPGraphQL | vinext on Workers |
| Payload | Payload 4 (beta), one app on the Local API | vinext on Workers |
| Traditional WordPress | WordPress + Timber theme | The theme itself |

In every case the CMS admin and API sit behind Cloudflare Access, and only the public site is open.

> Status: in active development. The references run locally and deploy to Workers, and the published `@patronage` packages are pre-1.0, so their APIs can change between minor versions. Work is tracked in [issues](https://github.com/patronage/launch/issues).

## Layout

```
apps/       Deployable apps: CMS installs, vinext front-ends, MCP Worker, docs-site
packages/   Shared libraries: content model, UI, Access helpers, MCP core and backends
docs/       Engineering docs: decisions in docs/adr/, spike findings in docs/spikes/
```

How the pieces fit together is in [Architecture](https://launch.patronage.com/architecture).

## Getting started

You need Node 24.22.1 or later, pnpm 12, Git, Bash, and PHP 8.1 or later with OpenSSL on the command line. Docker is needed only to run the WordPress references. The full list and how to run each reference are in [Getting started](https://launch.patronage.com/getting-started).

```bash
pnpm install
pnpm verify
```

Contributor and agent rules are in [AGENTS.md](AGENTS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

For an isolated DeepSec candidate scan, run `pnpm security:scan`. Model-backed review is unavailable. See the [security review workflow](.deepsec/README.md) for coverage limits and private handling of findings.

## License

[MIT](LICENSE)
