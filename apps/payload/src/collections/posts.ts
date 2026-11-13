import type { CollectionConfig } from "payload";

import { demoLocalized } from "../demo-locales";
import { postPath } from "../lib/posts";
import { previewable } from "../lib/preview";

const preview = previewable(postPath);

/** News posts, listed newest first at /news. */
export const Posts: CollectionConfig = {
  access: {
    // Anonymous readers only see published posts.
    read: ({ req }) => (req.user ? true : { _status: { equals: "published" } }),
  },
  admin: {
    ...preview.admin,
    defaultColumns: ["title", "publishedAt", "_status"],
    group: "News",
    useAsTitle: "title",
  },
  defaultSort: "-publishedAt",
  fields: [
    { ...demoLocalized, name: "title", required: true, type: "text" },
    {
      admin: { description: "The post's address: /news/<slug>." },
      index: true,
      name: "slug",
      required: true,
      type: "text",
      unique: true,
    },
    {
      admin: {
        description: "One or two sentences for the listing and link previews.",
      },
      ...demoLocalized,
      name: "excerpt",
      type: "textarea",
    },
    { name: "hero", relationTo: "media", type: "upload" },
    { ...demoLocalized, name: "content", type: "richText" },
    {
      admin: {
        date: { pickerAppearance: "dayOnly" },
        position: "sidebar",
      },
      defaultValue: () => new Date().toISOString(),
      index: true,
      name: "publishedAt",
      required: true,
      type: "date",
    },
    {
      admin: { position: "sidebar" },
      hasMany: true,
      name: "authors",
      relationTo: "authors",
      type: "relationship",
    },
    {
      admin: { position: "sidebar" },
      hasMany: true,
      name: "categories",
      relationTo: "categories",
      type: "relationship",
    },
    {
      admin: {
        description: "Featured posts lead the news listing.",
        position: "sidebar",
      },
      defaultValue: false,
      name: "featured",
      type: "checkbox",
    },
  ],
  slug: "posts",
  // Deleting in the admin moves a document to the trash, where it can be
  // restored, instead of removing it and its versions.
  trash: true,
  versions: preview.versions,
};
