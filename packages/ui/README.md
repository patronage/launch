# @launch/ui

Shared front-end UI for the vinext sites: [shadcn/ui](https://ui.shadcn.com) components on Tailwind 4, Patronage's `Section`, `Container` and `Typography` primitives, and one component per content-model block. Components take plain props and know nothing about WordPress or Payload; each CMS adapter maps its data to `@launch/content-model` and passes rendered rich text in as children.

## Use it in an app

1. Add `@tailwindcss/vite` to the app's Vite plugins.
2. Give the app one stylesheet that imports this package's styles and points Tailwind at the app's own files, and import it from the root layout:

   ```css
   @import "@launch/ui/styles.css";

   @source "../app";
   ```

3. Render `<FontLinks />` in the document head (or set `--typeface-*` to your own fonts), and wrap pages in `SiteHeader` and `SiteFooter`.

`PageSections` renders a content-model page. For anything else, build with the primitives:

```tsx
<Section paddingTop="lg" skin="dark">
  <Container width="narrow">
    <Typography variant="eyebrow">News</Typography>
    <Typography as="h1" variant="h2">
      A heading
    </Typography>
  </Container>
</Section>
```

## Files

| File | What it is |
| --- | --- |
| `src/tokens.css` | Plain CSS variables: palette, shadcn colour names, the `--section-*` layer and the `light`, `dark` and `accent` skins. No Tailwind, so the Timber install can load it on its own. |
| `src/styles.css` | Tailwind entry: maps the tokens into the theme, adds `@tailwindcss/typography` for rich text (`.prose-section`) and scans this package. |
| `src/components/section.tsx` | Full-width band. `skin` sets `data-skin`, which remaps the colour variables, so buttons, cards and type inside follow it. `paddingTop` and `paddingBottom` take the content model's spacing steps. |
| `src/components/container.tsx` | Centred max width with the site gutter. Widths follow the content model (`narrow`, `default`, `wide`, `full`) plus `content`. |
| `src/components/typography.tsx` | The type scale by role (`d1`, `h1` to `h4`, `lead`, `body-*`, `eyebrow`, `quote`). Pick the look with `variant` and the element with `as`. |
| `src/components/button.tsx`, `card.tsx` | shadcn/ui components. Style a link as a button with `buttonVariants`. |
| `src/blocks.tsx`, `src/sections.tsx` | The content-model blocks and `PageSections`. |

## Adding shadcn components

`components.json` is set up for this package. From `packages/ui`, run `pnpm dlx shadcn@latest add <component>`, then export the new file from `src/index.ts`. Generated imports of `@launch/ui/utils` resolve through the package's exports.
