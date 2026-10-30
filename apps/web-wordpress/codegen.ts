import type { CodegenConfig } from "@graphql-codegen/cli";

// Generates typed documents from schema.graphql, the committed snapshot of
// the WPGraphQL schema, so CI needs no running WordPress. Refresh the
// snapshot with `pnpm codegen:schema` after changing plugins or fields.
const config: CodegenConfig = {
  documents: [
    "app/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
    "components/**/*.{ts,tsx}",
    // The Page Builder fragment the adapter is typed against.
    "../../packages/adapter-wordpress/src/page-builder.graphql",
  ],
  generates: {
    "gql/": {
      config: {
        enumsAsTypes: true,
        useTypeImports: true,
      },
      preset: "client",
      presetConfig: {
        fragmentMasking: false,
        // Writes gql/persisted-documents.json and puts each operation's
        // SHA-256 in its document, so requests send only the query ID.
        persistedDocuments: { hashAlgorithm: "sha256" },
      },
    },
  },
  ignoreNoDocuments: true,
  schema: "schema.graphql",
};

export default config;
