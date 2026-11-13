import type { CollectionConfig } from "payload";

import { sectionBlocks } from "../blocks";
import { hero } from "../fields/hero";
import { previewable } from "../lib/preview";
import { payloadAdapter } from "../lib/sections";
import type { Page } from "../payload-types";

const preview = previewable<Page>((doc) =>
  payloadAdapter.pagePath({ ...doc, id: doc.id ?? "" })
);

export const Pages: CollectionConfig = {
  access: {
    // Anonymous readers only see published pages.
    read: ({ req }) => (req.user ? true : { _status: { equals: "published" } }),
  },
  admin: {
    ...preview.admin,
    useAsTitle: "title",
  },
  fields: [
    { name: "title", required: true, type: "text" },
    { index: true, name: "slug", required: true, type: "text", unique: true },
    hero,
    { name: "content", type: "richText" },
    {
      admin: {
        description: "Page sections, rendered in order.",
      },
      blocks: sectionBlocks,
      label: "Sections",
      labels: { plural: "Sections", singular: "Section" },
      name: "layout",
      type: "blocks",
    },
  ],
  slug: "pages",
  // Deleting in the admin moves a document to the trash, where it can be
  // restored, instead of removing it and its versions.
  trash: true,
  versions: preview.versions,
};
