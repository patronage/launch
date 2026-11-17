# Spike 2: CMS-neutral sections from fixtures

Issue: [#3](https://github.com/patronage/launch/issues/3)

**Question:** can one set of React components render the same page from WordPress-shaped and Payload-shaped data, through two small adapters?

**Answer:** yes. The same invented home page, stored once as an ACF flexible content response from WPGraphQL and once as a Payload page document with a blocks field, maps to equal `content-model` values and renders the same markup through `@launch/ui`. `packages/sections-preview/src/parity.test.tsx` asserts both. The only differences left are the two normalizations described under rich text below.

## What was built

| Package | What it holds |
| --- | --- |
| `packages/content-model` | Types for `SectionOptions`, `Link`, `Image`, `Media`, six blocks and `Page<R>`, plus coercion helpers (`oneOf`, `toSkin`, `toColumns`, `slugify`, `compact`). No runtime dependencies. |
| `packages/ui` | Props-only React components (`PageSections`, `Section`, `BlockRenderer`, one component per block) and two stylesheets: `tokens.css` (palette, skins, type scale, spacing, widths) and `sections.css`. Since rebuilt on shadcn/ui and Tailwind 4; see [`packages/ui`](../../packages/ui/README.md). |
| `packages/adapter-wordpress` | `createWordPressAdapter({ cmsOrigin })`, the WPGraphQL query (`fixtures/query.graphql`) and a recorded-style response fixture. |
| `packages/adapter-payload` | `createPayloadAdapter({ serverUrl })`, a small Lexical renderer, and a page document fixture at depth 1. |
| `packages/sections-preview` | The parity test and a static side-by-side page: `pnpm --filter @launch/sections-preview build`, then open `packages/sections-preview/dist/index.html`. |

The model is `Page<R>`, where `R` is whatever the adapter's rich text renders to (a React node here). That keeps `content-model` free of React and of either CMS.

### Section options

Every section is `{ options, block }`. Options are `skin` (`light`, `dark`, `accent`), `width` (`narrow`, `default`, `wide`, `full`), `paddingTop` and `paddingBottom` (`none`, `sm`, `md`, `lg`), `hidden`, and an optional `slug` for anchors. Hidden sections stay in the adapter output so a preview can show them; `visibleSections` drops them for rendering. Missing or unknown option values fall back to defaults rather than throwing, because editors remove choices from select fields after content exists.

### Blocks

`content`, `contentMedia`, `media`, `cardGrid`, `blockquote` and `callToAction`. Card text and quotes are plain text on purpose: they are short, and rich text in them tends to break the layout. Only `content`, `contentMedia` and `callToAction` take rich text.

The page decides heading levels, not the block: the first visible section's heading is the `<h1>` unless `firstHeadingIsTitle` is false, and later ones are `<h2>`. Rich-text headings from Lexical are capped at `<h2>`.

### Tokens

`tokens.css` defines a palette, then remaps it into `--skin-*` variables under `[data-skin]`. Components read only `--skin-*`, so any block takes the skin of the section around it. The type scale is five named roles (`--type-small`, `--type-body`, `--type-lead`, `--type-title`, `--type-display`), fluid with `clamp()`, and is not tied to heading levels. The Timber install can use `tokens.css` as is. (Later rebuilt: the skins now remap shadcn/ui's colour variables plus a `--section-*` layer, and the type scale moved into the `Typography` component.)

## What could not be shared

### Rich text (by design)

Each adapter renders its own rich text and passes the result in as `body`. Two things differ in the output:

- **WordPress returns an HTML string.** React can only mount it with `dangerouslySetInnerHTML` on an element, so the adapter wraps it in `<div class="l-rich-raw">`, which is `display: contents` in `sections.css`. wpautop also leaves newlines between block tags. The parity test strips the wrapper and inter-tag whitespace before comparing.
- **Payload returns Lexical JSON.** The adapter ships a renderer of about 160 lines for paragraphs, headings, lists, quotes, links, line breaks and text formats. Payload's own `@payloadcms/richtext-lexical/react` converter is fuller, but it pulls Payload packages into the front-end; the adapter accepts it through `renderRichText` if an app wants it.

The WordPress HTML is trusted, because only signed-in editors can write it. If that changes (comments, user submissions), sanitize in the adapter's `renderHtml`, not in the UI. Since this spike, WordPress filters rich-text fields itself: `wordpress-shared/patronage-fields/field-values.php` runs them through `wp_kses_post()` when they load.

### Internal links and paths

- WordPress stores internal links as absolute URLs on the CMS host with a trailing slash (`https://cms.example.com/guide/`). The adapter turns anything on `cmsOrigin` into a site path (`/guide`), both in link fields and in `href`s inside rich text (by regex on the HTML string).
- Payload stores references to documents. A path can only be built when the query ran at depth 1 or more, and hierarchical paths need the nested-docs plugin's breadcrumbs. At depth 0 the adapter gets an id, so the link or image is dropped. Front-end queries should always set depth.

### Media

The two CMSs serve the same image from different URLs (`/wp-content/uploads/2026/10/…` and `/api/media/file/…`). Both adapters take an `imageUrl` function so the front-end can route every image through one loader, such as Cloudflare Images. WordPress captions arrive as HTML and are stripped to text; the Payload fixture uses a plain text caption field (the Payload website template uses rich text there, which we should not copy).

### Ids

ACF flexible content rows have no stable id, so the WordPress adapter keys sections by layout and row index. Reordering sections remounts them, which only matters once sections hold client state. Payload blocks and array rows have ids.

### Field names and values

The same concept has different names in each CMS: `background` and `skin`, `buttons` and `links`, `imagePosition` and `mediaPosition`, the `PageBuilderSectionsCallToActionLayout` typename and the `cta` block slug. WPGraphQL for ACF returns select fields as one-item arrays. Payload's link `appearance` values (`default`, `outline`) need a mapping to our variants. All of this is absorbed in the adapters, and an unknown layout or block type is skipped rather than failing the page.

### Types

The WPGraphQL types are hand-written for the spike. The headless WordPress spike should generate them from the real schema with GraphQL Codegen, and the Payload app should use its generated `payload-types.ts`. Fixtures are cast once each in `fixtures/index.ts`, with the reason given.

## Recommendations

1. Adopt `content-model`, `ui` and the two adapters as the starting point for the vinext front-ends.
2. When the real CMS installs define their fields, name them after the content model (`skin`, `width`, `links`, `mediaPosition`) in both ACF and Payload. The adapters stay, but shrink to the parts that really differ: rich text, links and media.
3. Keep `PageSections` the only thing a route renders for flexible content. New blocks are added in `content-model` first; the exhaustive switch in `BlockRenderer` fails typecheck until there is a component.
4. Set Payload query depth to at least 1 for pages, and install nested-docs if pages are hierarchical.
5. Storybook is not needed yet. The static preview and the parity test cover this stage; revisit when there is a designer reviewing components.

## Open questions

- Should WordPress rich text be sanitized anyway, as defense in depth, at the cost of a sanitizer in the Worker bundle? (Answered in WordPress, not the Worker: the fields plugin filters rich-text fields when they load.)
- Do we want the adapter packages named `adapter-wordpress` and `adapter-payload`, or folded into the per-CMS packages (`mcp-wordpress` and the like) later?
