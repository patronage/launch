# @launch/adapter-emdash

Maps an EmDash `pages` entry's `data`, as `getEmDashEntry` or the REST API returns it, to the Content model in `@launch/content-model`, and renders EmDash's Portable Text rich text to React. Field names follow `apps/emdash/seed/build.ts`.

```ts
import { createEmDashAdapter } from "@launch/adapter-emdash";
import { getEmDashEntry } from "emdash";

const { entry } = await getEmDashEntry("pages", slug);
const page = entry && createEmDashAdapter().toPage({ data: entry.data, slug });
```

- Images in R2 resolve to `{serverUrl}/_emdash/api/media/file/{storageKey}` (`serverUrl` defaults to the same origin); `imageUrl` and `imageSrcset` rewrite them, as in the other adapters.
- Portable Text covers paragraphs, headings (capped at `h2`), quotes, lists, decorators and links with safe schemes. Images go to `renderRichTextBlock`; other blocks are dropped.
- Unknown block types and sections missing a required field are skipped.

## Fixtures

`fixtures/` holds the `data` of the seeded home, get-involved and guide pages, recorded from a local EmDash 1.5. To record them again, run the app and `setup` (see `apps/emdash`), mint an API token with `content:read` in the admin, then save the `data` of each response:

```sh
curl -s -H "Authorization: Bearer $EMDASH_READ_TOKEN" http://localhost:4321/_emdash/api/content/pages/home
```

These fixtures are not in `@launch/sections-preview`'s parity test: the EmDash seed leaves out forms, pull quotes and embeds, so its pages do not match the WordPress and Payload ones section for section.
