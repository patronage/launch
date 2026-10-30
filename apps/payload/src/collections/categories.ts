import type { CollectionConfig } from "payload";

export const Categories: CollectionConfig = {
  access: {
    read: () => true,
  },
  admin: {
    group: "News",
    useAsTitle: "title",
  },
  fields: [
    { name: "title", required: true, type: "text" },
    { index: true, name: "slug", required: true, type: "text", unique: true },
  ],
  slug: "categories",
};
