import type { CollectionConfig } from "payload";

export const Pages: CollectionConfig = {
  access: {
    // Anonymous readers only see published pages.
    read: ({ req }) => (req.user ? true : { _status: { equals: "published" } }),
  },
  admin: {
    useAsTitle: "title",
  },
  fields: [
    { name: "title", required: true, type: "text" },
    { index: true, name: "slug", required: true, type: "text", unique: true },
    { name: "hero", relationTo: "media", type: "upload" },
    { name: "content", type: "richText" },
  ],
  slug: "pages",
  versions: {
    drafts: true,
  },
};
