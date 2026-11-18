# ADR 0024: EmDash's own SEO and redirects, and its forms plugin

## Status

Accepted, 2026-11-18. Adds to [ADR 0022](0022-emdash-renders-the-site-in-astro.md).

## Context

The EmDash site should have working redirects, SEO and forms, as the WordPress and Payload sites do. EmDash ships redirects (admin, patterns, slug-change 301s, a 404 log), per-entry SEO, `<EmDashHead>`, sitemaps and `robots.txt`. Forms come from the first-party `@emdash-cms/plugin-forms`. Third-party SEO plugins add schema, audits and imports on top.

## Decision

- Use EmDash's built-in redirects and SEO. No SEO plugin.
- The layout renders `<EmDashHead>`, `<EmDashBodyStart>` and `<EmDashBodyEnd>` with a page context naming the entry, so the SEO panel and plugin contributions apply. The canonical URL is the site URL (or the request origin) plus the path, never the query string.
- Forms use `@emdash-cms/plugin-forms`. A `form` section places a form by slug, and the plugin renders it, with its validation, spam protection and submission handling, inside the shared section frame. The content model's form block is not used for EmDash, because the plugin owns rendering and submission.
- The seed holds example redirects. The demo form can't be seeded, so `setup` creates it through the plugin's admin API.

## Consequences

- Form styling comes from the plugin's stylesheet with the shared UI's tokens, so forms look close to, not identical to, the other sites' forms.
- A page with form sections renders in runs. Section padding doesn't collapse across a form section.
- Redirect patterns are Astro route patterns; regex rules from other systems must be rewritten.
- Email notifications need an email provider configured in EmDash before deploy.
