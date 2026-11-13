# Launch feature map

What a visitor, an editor or an editor's agent can do on Launch's local front ends and MCP gateway, and how to prove each one. Start each run with Launch and Doctor from [SKILL.md](../SKILL.md). Each file lists the user's entry points, then the commands and observable results that prove them.

| Feature | Surfaces | Scripted drive |
| --- | --- | --- |
| [Public pages](public-pages.md) | payload, web-wordpress | `drive <surface> pages` |
| [Forms](forms.md) | payload (web-wordpress by hand) | `drive payload apply-form` |
| [News](news.md) | payload, web-wordpress | `capture` |
| [Payload admin](payload-admin.md) | payload | by hand, after `apply-form` signs in |
| [SEO and redirects](seo.md) | payload | `drive payload seo` |
| [MCP gateway](mcp-gateway.md) | mcp (with payload and the Access stand-in) | `drive mcp payload-draft`, `drive mcp payload-upload` |

A proof covers the entry points its feature file lists. Driving only the most convenient one leaves the rest unverified, so say which you skipped.
