# Public pages

A visitor opens the home page and the pages it links to. Each page renders its hero and its Page Builder sections (content, content with media, media, card grid, blockquote, call to action, form) from the same `@launch/ui` components on both CMSs, so the same seeded Neighborhood Growers content should look the same on both.

## Sub-features

- `home`: the home page with every section type, plus one hidden section that must not render.
- `nested`: a child page at its nested path (`/programs/seed-library`).
- `heroes`: each hero variant (home, split, media, simple, free-form) on its seeded page.
- `not-found`: an unknown path shows the 404 page.

## How to get to it (user POV)

- Open `/`. The header links to the pages, and the cards under Programs link to the child pages.
- Type a page path directly, such as `/programs/seed-library`, `/guide` or `/about` (WordPress only).

## Driving it with verify.ts

Preconditions: the surface is launched, Doctor passes, and the demo content is seeded (`pnpm --filter payload seed`, or the WordPress setup).

- **Home and nested pages**: `node .agents/skills/launch-verify/scripts/verify.ts drive payload pages` (or `web-wordpress`). Each path returns 200 with its `h1` in `transcript.md`: "Grow food together" on `/`, then "Programs" and "Seed library".
- **One page in full**: `node .agents/skills/launch-verify/scripts/verify.ts capture payload /guide guide`. The screenshot shows the free-form hero and the rich-text blocks (button, image, pullquote, embeds).
- **Hidden section**: on `/`, the hidden section's heading is absent from `page.html` (compare it with the seed in `apps/payload/src/seed/content.ts` or `wordpress-shared/patronage-fields/seed/seed.php`).
- **Not found**: `capture <surface> /no-such-page not-found` records a 404 status and the not-found page.

## Gotchas

- Without the seed, Payload's `/` is a plain list of pages, not the home page.
- Images below the fold load lazily. `capture` scrolls before its full-page shot, but a hand-taken screenshot may show blank space where they belong.
- Payload pages are `no-store`, so their wide events carry `upstream.d1` but no `cache`. web-wordpress pages are ISR, so their events show `cache` (`MISS`, then `HIT` or `STALE`) and `upstream.wordpress` on a miss.
- Console errors about blocked external requests (fonts, embeds) come from the sandbox network, not the page. Judge them by their URL.
