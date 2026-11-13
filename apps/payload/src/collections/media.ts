import type { CollectionConfig } from "payload";

export const Media: CollectionConfig = {
  access: {
    read: () => true,
  },
  fields: [
    {
      name: "alt",
      required: true,
      type: "text",
    },
    {
      name: "caption",
      type: "text",
    },
  ],
  slug: "media",
  upload: {
    // These are not supported on Workers yet due to lack of sharp
    crop: false,
    focalPoint: false,
    // Pictures only. An SVG can carry script, so it is left out.
    mimeTypes: [
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
  },
};
