import { Kind, OperationTypeNode, parse } from "graphql";
import type { DocumentNode } from "graphql";
import { z } from "zod";

import { applyOperations } from "./apply";
import type { ApplyPreflight, BatchReceipt } from "./apply";
import type { CallerContext, CallerScope } from "./caller";
import { MAX_OPERATIONS, parseApplyInput } from "./operations";
import {
  createWordPressClient,
  wordPressErrorMessage,
  WordPressRequestError,
  wpFetch,
  wpGraphql,
} from "./wordpress";
import type {
  JsonValue,
  WordPressClient,
  WordPressTelemetry,
} from "./wordpress";

// This module is deliberately package-free: it names no codemode import and no
// `cloudflare:workers` binding, so the tool definitions stay testable with a
// stubbed `fetch` alone. The Durable Object adapts them into a connector.
export const WP_CONNECTOR_INSTRUCTIONS = [
  "WordPress site reached as the signed-in Cloudflare Access user.",
  "Reads: wp.graphql({query, variables?}) runs WPGraphQL (introspection allowed);",
  "wp.get({path, query?}) GETs any /wp-json/ path and throws on a non-2xx response.",
  "Writes: wp.apply({intent, operations}) is the only write path and pauses for human approval.",
  `Send 1-${MAX_OPERATIONS} update_post operations per call and set expected_modified_gmt when you read the post first.`,
].join(" ");

// `wp.graphql` is a read. A mutation would run at once as the requester,
// skipping the preview, the approval and the receipt, so only documents whose
// every operation is a query are forwarded. A document that does not parse is
// refused too, rather than left for WordPress to read differently.
const assertQueryOnly = (query: string): void => {
  let document: DocumentNode;

  try {
    document = parse(query);
  } catch {
    throw new WordPressRequestError(
      "wp.graphql could not parse the query; send one valid GraphQL document"
    );
  }

  const writes = document.definitions.some(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation !== OperationTypeNode.QUERY
  );

  if (writes) {
    throw new WordPressRequestError(
      "wp.graphql runs queries only; make changes with wp.apply, which pauses for approval"
    );
  }
};

// WordPress reads `_method` from the query string, even on a GET, and runs the
// request as that method, so `?_method=DELETE` would turn a read into a delete.
// PHP also rewrites spaces, dots and `[` in parameter names to underscores, so
// any key naming `method` is refused rather than chasing its spellings.
const METHOD_OVERRIDE_KEY = /method/iu;

const graphqlArgsSchema = z.object({
  query: z.string().trim().min(1),
  variables: z.record(z.string(), z.json()).optional(),
});

// REST query values are rendered with `String(value)`, so only scalars are
// accepted: a nested object would arrive at WordPress as "[object Object]".
const restQuerySchema = z.record(
  z.string(),
  z.union([z.boolean(), z.number(), z.string()])
);

type RestQuery = z.infer<typeof restQuerySchema>;

const getArgsSchema = z.object({
  path: z.string().min(1),
  query: restQuerySchema.optional(),
});

// The JSON Schema subset these tools declare. Written out rather than borrowed
// from the codemode package so the module stays import-free, and structurally
// assignable to that package's `JSONSchema7` input schema.
export interface ConnectorInputSchema {
  items?: ConnectorInputSchema;
  properties?: Record<string, ConnectorInputSchema>;
  required?: string[];
  type:
    | "array"
    | "boolean"
    | "integer"
    | "null"
    | "number"
    | "object"
    | "string";
}

export interface ToolCallContext {
  executionId?: string;
}

export type ConnectorToolResult = BatchReceipt | JsonValue;

export interface ConnectorToolDefinition {
  description: string;
  // Arguments arrive as JSON from the codemode durable log; the unconstrained
  // generic is the repo's stand-in for the banned `unknown` parameter, and it
  // keeps the definition assignable to the codemode package's own tool type.
  execute: <T>(args: T, ctx?: ToolCallContext) => Promise<ConnectorToolResult>;
  inputSchema: ConnectorInputSchema;
  requiresApproval?: boolean;
}

export type ConnectorToolMap = Record<string, ConnectorToolDefinition>;

export interface RuntimeStore {
  readPreflight: (executionId: string) => Promise<ApplyPreflight | undefined>;
  readRequester: (executionId: string) => Promise<string | undefined>;
  writePreflight: (
    executionId: string,
    preflight: ApplyPreflight
  ) => Promise<void>;
}

export interface WordPressToolDeps {
  env: Env;
  scope: CallerScope;
  store: RuntimeStore;
  // The telemetry for the RPC these tools are running under. A getter rather
  // than a value so the Durable Object can build the tools once per call and
  // still hand every request in that call to the same collector — the Worker
  // reads it back off the RPC result and puts it on the wide event.
  telemetry: () => WordPressTelemetry;
}

const callerClient = (env: Env, caller: CallerContext): WordPressClient =>
  createWordPressClient(env, {
    ok: true,
    subjectOpaque: caller.subjectOpaque,
    token: caller.token,
  });

const queryString = (query: RestQuery | undefined): string => {
  if (query === undefined) {
    return "";
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }

  const encoded = params.toString();

  return encoded ? `?${encoded}` : "";
};

// The return type is inferred and validated with `satisfies` rather than
// annotated: an explicit `ConnectorToolMap` annotation would discard the three
// tool names the callers rely on, which the anti-slop widening rule rejects.
export const createWordPressTools = (deps: WordPressToolDeps) =>
  ({
    apply: {
      description: `Apply 1-${MAX_OPERATIONS} update_post operations to WordPress. Give the work a concise, one-sentence intent for the human approval card. Pauses for human approval; returns one receipt per operation.`,
      execute: async (args, ctx) => {
        // Validation runs before anything else so a malformed batch — a batch
        // addressing one post twice included — fails as a typed error rather
        // than as a half-applied write.
        const input = parseApplyInput(args);
        const caller = deps.scope.require();
        // The runtime supplies the execution id per call; the approval replay
        // carries it on the caller instead.
        const executionId = ctx?.executionId ?? caller.executionId;

        if (executionId === undefined) {
          throw new WordPressRequestError(
            "wp.apply requires an execution id from the codemode runtime"
          );
        }

        // Only the preview a human approved authorises a write. With none
        // stored, every operation reports `missing_preflight` and nothing
        // reaches WordPress — computing a fresh preview here would apply a
        // batch nobody ever saw.
        const preflight: ApplyPreflight = caller.preflight ??
          (await deps.store.readPreflight(executionId)) ?? {
            intent: input.intent,
            operations: [],
          };

        return await applyOperations({
          approverOpaque: caller.subjectOpaque,
          client: callerClient(deps.env, caller),
          executionId,
          operations: input.operations,
          preflight,
          requesterOpaque:
            (await deps.store.readRequester(executionId)) ?? "unknown",
          telemetry: deps.telemetry(),
        });
      },
      inputSchema: {
        properties: {
          intent: { type: "string" },
          operations: { items: { type: "object" }, type: "array" },
        },
        required: ["intent", "operations"],
        type: "object",
      },
      requiresApproval: true,
    },
    get: {
      description:
        "GET a WordPress REST path. The path must start with /wp-json/. Returns parsed JSON, or throws if WordPress responds with a non-2xx status.",
      execute: async (args) => {
        const parsed = getArgsSchema.safeParse(args);

        if (!parsed.success) {
          throw new WordPressRequestError(
            "wp.get requires a string path and scalar query values"
          );
        }

        // A path with its own query string would be appended to, not replaced
        // by, `query` — two `?` in one URL, and WordPress reading whichever it
        // parsed first. Naming the parameter is what the model needs to hear.
        if (parsed.data.path.includes("?")) {
          throw new WordPressRequestError(
            "wp.get path must not contain a query string; pass parameters in the query argument"
          );
        }

        if (
          Object.keys(parsed.data.query ?? {}).some((key) =>
            METHOD_OVERRIDE_KEY.test(key)
          )
        ) {
          throw new WordPressRequestError(
            "wp.get is a read and takes no method override; make changes with wp.apply"
          );
        }

        const result = await wpFetch(
          callerClient(deps.env, deps.scope.require()),
          `${parsed.data.path}${queryString(parsed.data.query)}`,
          deps.telemetry()
        );

        // Mirrors wpGraphql: a non-2xx WordPress response is a failure, not a
        // read result. Without this check the model would see a WordPress
        // error body (e.g. an expired-token 401 or a rest_forbidden 403) as
        // if it were successfully fetched data.
        if (result.status < 200 || result.status >= 300) {
          throw new WordPressRequestError(
            wordPressErrorMessage(result.status, result.errorCode) ??
              `WordPress returned HTTP ${result.status}`
          );
        }

        return result.json;
      },
      inputSchema: {
        properties: {
          path: { type: "string" },
          query: { type: "object" },
        },
        required: ["path"],
        type: "object",
      },
    },
    graphql: {
      description:
        "Run a WPGraphQL query against the site. Introspection works. Returns the full {data, errors?} response.",
      execute: async (args) => {
        const parsed = graphqlArgsSchema.safeParse(args);

        if (!parsed.success) {
          throw new WordPressRequestError("wp.graphql requires a string query");
        }

        assertQueryOnly(parsed.data.query);

        return await wpGraphql(
          callerClient(deps.env, deps.scope.require()),
          parsed.data.query,
          parsed.data.variables,
          deps.telemetry()
        );
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
          variables: { type: "object" },
        },
        required: ["query"],
        type: "object",
      },
    },
  }) satisfies ConnectorToolMap;
