import type { GatewayConnector } from "@patronage/mcp-core";

import { buildSiteDescription } from "./describe";
import type { WordPressEnv } from "./env";
import { createWordPressClient } from "./wordpress";
import { preflightOperations } from "./wp-apply";
import { operationSentence, parseApplyInput } from "./wp-operations";
import { createWordPressTools, WP_CONNECTOR_INSTRUCTIONS } from "./wp-tools";

const WP_EXECUTE_DESCRIPTION = [
  "The wp global reaches WordPress.",
  "Reads: await wp.graphql({ query, variables? }); or await wp.get({ path, query? }), where path starts /wp-json/, contains no ?, and query values are scalars.",
  'Writes: await wp.apply({ intent, operations }), with 1-20 operations shaped { kind: "update_post", rest_base, id, expected_modified_gmt?, fields?, acf? }; fields may contain title, content, excerpt, slug, or status. Put all changes for one post in one operation. Read with context: "edit" first and copy modified_gmt to expected_modified_gmt.',
  'Read example: async () => await wp.get({ path: "/wp-json/wp/v2/posts/123", query: { context: "edit" } }).',
  'Write example: async () => { const post = await wp.get({ path: "/wp-json/wp/v2/posts/123", query: { context: "edit" } }); return await wp.apply({ intent: "Fix the title.", operations: [{ kind: "update_post", rest_base: "posts", id: post.id, expected_modified_gmt: post.modified_gmt, fields: { title: "Correct title" } }] }); }',
].join(" ");

// The WordPress connector: WPGraphQL and REST reads, and `update_post`
// writes through the approval step.
export const wordpressConnector: GatewayConnector<WordPressEnv> = {
  configured: (env) => Boolean(env.WORDPRESS_API_URL?.trim()),
  describe: (env, caller, telemetry) =>
    buildSiteDescription(
      createWordPressClient(env, { ok: true, ...caller }),
      telemetry
    ),
  executeDescription: WP_EXECUTE_DESCRIPTION,
  instructions: WP_CONNECTOR_INSTRUCTIONS,
  name: "wp",
  parseApply: (args) => {
    const input = parseApplyInput(args);

    return {
      intent: input.intent,
      sentences: input.operations.map((operation) =>
        operationSentence(operation)
      ),
    };
  },
  preflight: (env, caller, args, telemetry) => {
    const input = parseApplyInput(args);

    return preflightOperations(
      createWordPressClient(env, { ok: true, ...caller }),
      input.intent,
      input.operations,
      telemetry
    );
  },
  tools: createWordPressTools,
};
