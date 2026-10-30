# Launch

Reference sites from [Patronage](https://www.patronage.org) for running a CMS behind Cloudflare Access with fast front-ends on Cloudflare Workers.

Each reference renders the same demo site:

| Reference | CMS | Front-end |
| --- | --- | --- |
| Headless WordPress | WordPress + WPGraphQL | vinext on Workers |
| Payload | Payload 4 (beta), one app on the Local API | vinext on Workers |
| Traditional WordPress | WordPress + Timber theme | The theme itself |

In every case the CMS admin and API sit behind Cloudflare Access, and only the public site is open.

> Status: early. The first spikes are tracked in [issues](https://github.com/patronage/launch/issues).

## Layout

```
apps/       Deployable apps: CMS installs, vinext front-ends, MCP Worker, docs-site
packages/   Shared libraries: content model, UI, Access helpers, MCP core and backends
docs/       Engineering docs: decisions in docs/adr/, spike findings in docs/spikes/
```

## Getting started

Requires Node 24.22+ (Payload 4's minimum) and pnpm 12.

```bash
pnpm install
pnpm verify
```

Contributor and agent rules are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
