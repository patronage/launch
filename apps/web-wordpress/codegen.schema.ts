import { existsSync } from "node:fs";

import type { CodegenConfig } from "@graphql-codegen/cli";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const { WORDPRESS_URL, WORDPRESS_PREVIEW_USER, WORDPRESS_PREVIEW_PASSWORD } =
  process.env;

if (!(WORDPRESS_URL && WORDPRESS_PREVIEW_USER && WORDPRESS_PREVIEW_PASSWORD)) {
  throw new Error(
    "Run apps/cms-wordpress-headless/bin/setup.sh first: it writes .env.local"
  );
}

// Introspects the local WordPress (apps/cms-wordpress-headless) into
// schema.graphql. WPGraphQL only allows introspection to signed-in users,
// so this uses the preview application password.
const config: CodegenConfig = {
  generates: {
    "schema.graphql": {
      plugins: ["schema-ast"],
    },
  },
  schema: {
    [`${WORDPRESS_URL}/graphql`]: {
      headers: {
        Authorization: `Basic ${btoa(`${WORDPRESS_PREVIEW_USER}:${WORDPRESS_PREVIEW_PASSWORD}`)}`,
      },
    },
  },
};

export default config;
