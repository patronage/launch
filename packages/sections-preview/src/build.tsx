import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@launch/content-model";
import { PageSections } from "@launch/ui";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { payloadPage, wordpressPage } from "./pages";

const out = path.join(import.meta.dirname, "..", "dist");

// Compiled by the Tailwind CLI in the build script, before this runs.
const css = readFileSync(path.join(out, "styles.css"), "utf-8");

const htmlDocument = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${css}</style></head><body>${body}</body></html>`;

const renderPage = (page: Page<ReactNode>, source: string): string =>
  htmlDocument(
    `${page.title} (${source})`,
    renderToStaticMarkup(<PageSections page={page} />)
  );

mkdirSync(out, { recursive: true });

writeFileSync(
  path.join(out, "wordpress.html"),
  renderPage(wordpressPage(), "WordPress")
);

writeFileSync(
  path.join(out, "payload.html"),
  renderPage(payloadPage(), "Payload")
);

writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sections preview</title><style>
body{font-family:system-ui,sans-serif;margin:0}main{display:grid;grid-template-columns:1fr 1fr;height:100vh}
section{display:flex;flex-direction:column;border-inline-end:1px solid #ccc}h1{font-size:14px;margin:0;padding:8px 12px;background:#f2f2f2}
iframe{border:0;flex:1;width:100%}</style></head><body><main>
<section><h1>WordPress (ACF flexible content via WPGraphQL)</h1><iframe src="wordpress.html" title="WordPress"></iframe></section>
<section><h1>Payload (blocks field, Lexical)</h1><iframe src="payload.html" title="Payload"></iframe></section>
</main></body></html>`
);

console.log(`Wrote ${out}/index.html`);
