import { createPayloadAdapter } from "@launch/adapter-payload";
import {
  payloadGetInvolvedFixture,
  payloadGuideFixture,
  payloadHomeFixture,
} from "@launch/adapter-payload/fixtures";
import { createWordPressAdapter } from "@launch/adapter-wordpress";
import {
  wordpressGetInvolvedFixture,
  wordpressGuideFixture,
  wordpressHomeFixture,
} from "@launch/adapter-wordpress/fixtures";
import type { RichTextBlock as RichTextBlockModel } from "@launch/content-model";
import { RichTextBlock } from "@launch/ui";

/**
 * Both CMSs store the same invented images under different URLs. A front-end
 * would route both through one image loader; here the loader keys on the file
 * name and returns an inline SVG placeholder so the preview works offline.
 */
export const placeholderImage = (src: string): string => {
  const name =
    src
      .split("/")
      .at(-1)
      ?.replace(/\.\w+$/u, "")
      // Payload 4 stores each upload as <name>-original.<ext>.
      .replace(/-original$/u, "") ?? "image";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="#9fb59a"/><text x="150" y="108" font-family="sans-serif" font-size="18" text-anchor="middle" fill="#1f2b1d">${name}</text></svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const renderRichTextBlock = (block: RichTextBlockModel) => (
  <RichTextBlock block={block} />
);

/** The recorded pages, the same seeded page from each CMS. */
export const FIXTURES = {
  "get-involved": {
    payload: payloadGetInvolvedFixture,
    wordpress: wordpressGetInvolvedFixture,
  },
  guide: { payload: payloadGuideFixture, wordpress: wordpressGuideFixture },
  home: { payload: payloadHomeFixture, wordpress: wordpressHomeFixture },
} as const;

export type FixtureName = keyof typeof FIXTURES;

export const FIXTURE_NAMES = [
  "home",
  "guide",
  "get-involved",
] as const satisfies FixtureName[];

export const wordpressPage = (name: FixtureName = "home") => {
  const page = createWordPressAdapter({
    cmsOrigin: "https://cms.example.com",
    imageUrl: placeholderImage,
    renderRichTextBlock,
  }).toPage(FIXTURES[name].wordpress);

  if (!page) {
    throw new Error(`WordPress fixture ${name} has no page`);
  }

  return page;
};

export const payloadPage = (name: FixtureName = "home") =>
  createPayloadAdapter({
    imageUrl: placeholderImage,
    renderRichTextBlock,
    serverUrl: "https://cms.example.com",
  }).toPage(FIXTURES[name].payload);
