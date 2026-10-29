import path from "node:path";
import { fileURLToPath } from "node:url";

import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { r2Storage } from "@payloadcms/storage-r2";
import { env } from "cloudflare:workers";
import { buildConfig } from "payload";

import { Media } from "./collections/media";
import { Pages } from "./collections/pages";
import { Users } from "./collections/users";
import { database } from "./db";
import { SiteSettings } from "./globals/site-settings";

// import.meta.dirname is undefined in workerd, so derive it from the URL.
// oxlint-disable-next-line unicorn/prefer-import-meta-properties
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default buildConfig({
  admin: {
    importMap: {
      baseDir: path.resolve(dirname),
    },
    user: Users.slug,
  },
  collections: [Users, Pages, Media],
  db: await database(),
  editor: lexicalEditor(),
  globals: [SiteSettings],
  secret: env.PAYLOAD_SECRET || "",
  storage: [
    r2Storage({
      bucket: env.R2,
      collections: { media: true },
    }),
  ],
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
});
