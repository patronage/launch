import type { GlobalConfig } from "payload";

import { demoLocalized } from "../demo-locales";

export const SiteSettings: GlobalConfig = {
  access: {
    read: () => true,
  },
  fields: [
    { defaultValue: "Launch", name: "siteName", required: true, type: "text" },
    { ...demoLocalized, name: "tagline", type: "text" },
  ],
  slug: "site-settings",
};
