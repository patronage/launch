import type { CollectionConfig } from "payload";

/** People credited on posts. Bylines, not admin accounts. */
export const Authors: CollectionConfig = {
  access: {
    read: () => true,
  },
  admin: {
    defaultColumns: ["name", "role"],
    group: "News",
    useAsTitle: "name",
  },
  fields: [
    { name: "name", required: true, type: "text" },
    {
      admin: { description: "Shown under the name, e.g. Garden lead." },
      name: "role",
      type: "text",
    },
    { name: "photo", relationTo: "media", type: "upload" },
    { name: "bio", type: "textarea" },
  ],
  slug: "authors",
};
