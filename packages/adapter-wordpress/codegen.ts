import type { CodegenConfig } from "@graphql-codegen/cli";

// Types the Page Builder fragments (and the fixture's query) from the
// committed WPGraphQL schema snapshot, which apps/web-wordpress owns. Refresh
// it with `pnpm --filter web-wordpress codegen:schema` after changing fields,
// then run `pnpm codegen` here. The output is committed so packages that
// import this one from source need no build step; `pnpm test` checks it.
const config: CodegenConfig = {
  documents: ["src/**/*.graphql", "fixtures/**/*.graphql"],
  generates: {
    "src/gql/": {
      config: {
        enumsAsTypes: true,
        useTypeImports: true,
      },
      preset: "client",
      presetConfig: { fragmentMasking: false },
    },
  },
  schema: "../../apps/web-wordpress/schema.graphql",
};

export default config;
