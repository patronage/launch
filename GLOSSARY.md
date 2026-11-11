# Launch

The domain language for Launch: reference sites that run a CMS behind Cloudflare Access with front-ends on Cloudflare Workers. Decisions behind these terms are in [docs/adr/](docs/adr/README.md).

## Language

**Reference site**: One complete, deployable pairing of a CMS and a front-end that renders the Demo site, such as headless WordPress with its vinext front-end. _Avoid_: Starter, template, example app

**Demo site**: The invented site every Reference site renders. Each CMS's Seed loads the same core pages; shared images live in `packages/demo-content`. _Avoid_: Sample site, test site, client site

**CMS**: The editing system behind a Reference site: WordPress (headless or Timber) or Payload. Its admin and API sit behind Cloudflare Access. _Avoid_: Backend, admin (for the whole system)

**Headless WordPress**: The WordPress install that serves content over WPGraphQL to a vinext Front-end and renders no public pages itself (`apps/cms-wordpress-headless`). _Avoid_: Decoupled WordPress, WP API

**Timber WordPress**: The separate, traditional WordPress install whose Timber theme renders the public site itself. It shares design tokens with the other Reference sites, not components. _Avoid_: Classic WordPress, monolith

**Front-end**: The vinext app on Cloudflare Workers that renders the public site from CMS content. _Avoid_: Web app, client, head

**Content model**: The CMS-neutral TypeScript types for pages and sections in `packages/content-model`. Every Adapter maps into it, and shared UI reads only from it. _Avoid_: Schema, CMS types

**Adapter**: The package that maps one CMS's data into the Content model and renders that CMS's rich text (`packages/adapter-wordpress`, `packages/adapter-payload`). _Avoid_: Connector, transformer, mapper

**Page**: A routable document with a title, a site-relative path, and an ordered list of Sections. _Avoid_: Post (for pages), entry

**Section**: One full-width band of a Page: a single Block plus the Section options that frame it. _Avoid_: Row, module, component

**Block**: The content inside a Section, one of a fixed set of types (content, content and media, media, card grid, blockquote, call to action). Add a Block to the Content model first, then to each CMS. _Avoid_: Layout, widget, component

**Section options**: The framing every Section carries: Skin, width, top and bottom padding, anchor, and hidden. _Avoid_: Settings, styles

**Skin**: A Section's colour treatment (`light`, `dark` or `accent`), mapped to `data-skin` in the UI tokens. _Avoid_: Theme, colour scheme

**Page Builder**: The CMS field that holds a Page's Sections: ACF flexible content in WordPress, a blocks field in Payload. _Avoid_: Flexible content (outside WordPress code), layout builder

**Design tokens**: The Tailwind-free CSS custom properties in `packages/ui/src/tokens.css` (font families, colours, Skins, spacing) that every Reference site can load, including Timber WordPress. The type scale is Tailwind classes in the UI package, not tokens. _Avoid_: Theme variables

**Access lockdown**: Putting a CMS's admin and API behind a Cloudflare Access application so only the public Front-end is open. _Avoid_: Auth wall, SSO (for the whole pattern)

**Service token**: The Cloudflare Access credential a Front-end or MCP Worker uses to read from a locked CMS. It never maps to a CMS user, so it can only read. _Avoid_: API key, bot user

**MCP gateway**: The one MCP Worker a site's team installs. It signs people in, lists the tools, applies writes as the signed-in person and logs every call. A site that needs it has the gateway hold writes for Approval. _Avoid_: MCP proxy, MCP plugin (for the Worker)

**Connector**: The object `execute` code calls to reach one backend (`wp`, `payload`) inside the MCP gateway's sandbox. _Avoid_: Backend plugin, adapter (that is the Content model mapping)

**Approval**: A person accepting or rejecting a write that the MCP gateway paused, on the inline card or the browser approval page. The write then runs as the approver. Off unless a site requires it; without it a write runs at once, as the person who asked. _Avoid_: Confirmation, permission prompt (that is the MCP client's own)

**Tool pack**: A set of typed MCP tools for one workflow that is not CMS content, kept in a site's own repository. _Avoid_: Extension, skill

**Preview**: An editor viewing unpublished content through the Front-end, started from the CMS's preview button with a short-lived signed link. _Avoid_: Draft mode (outside vinext code)

**Cache tag**: A label on a cached Front-end response (a node id, a list, or `path:<path>`) that the CMS purges when matching content changes. _Avoid_: Surrogate key, cache key

**Wide event**: One structured log record per request or job that carries everything known about it, emitted by evlog in Workers and by the logging mu-plugin in WordPress. _Avoid_: Log line, trace (for the record)

**Log bucket**: The one R2 bucket per site that Logpush jobs and the WordPress Basin stream write into. _Avoid_: Log store (in code), data lake

**Seed**: The command that loads the Demo site into a local or new CMS instance. _Avoid_: Fixture load, import

**Spike**: A time-boxed issue that tests one approach and records what worked in `docs/spikes/`. A Spike that settles a repo-wide choice also produces an ADR. _Avoid_: POC, experiment
