import type { GlobalConfig } from "payload";

export const SiteSettings: GlobalConfig = {
  access: {
    read: () => true,
  },
  fields: [
    { defaultValue: "Launch", name: "siteName", required: true, type: "text" },
    { name: "tagline", type: "text" },
  ],
  slug: "site-settings",
};
