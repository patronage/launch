import { z } from "zod";

import type { AccessResult } from "./access";
import {
  assertSafeApiUrl,
  WordPressRequestError,
  wpFetchUrl,
} from "./wordpress";
import type {
  JsonObject,
  JsonValue,
  WordPressAuth,
  WordPressClient,
  WordPressTelemetry,
  WpFetchResult,
} from "./wordpress";

// The origin requests carry when they go over the Service binding. The
// binding ignores it; it only has to be a valid HTTPS URL.
export const PAYLOAD_BINDING_ORIGIN = "https://payload.internal";

const MCP_PATH = "/api/mcp";

const recordSchema = z.record(z.string(), z.json());
const textBlockSchema = z.object({ text: z.string(), type: z.literal("text") });

const toolResultSchema = z.object({
  content: z.array(z.json()).optional(),
  isError: z.boolean().optional(),
  structuredContent: recordSchema.optional(),
});

const rpcResponseSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  result: z.json().optional(),
});

const payloadErrorsSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).min(1),
});

type VerifiedAccessResult = Pick<
  Extract<AccessResult, { ok: true }>,
  "subjectOpaque" | "token"
>;

// Whether this deployment has a Payload site at all. Without one the
// `payload` connector is left out of the runtime entirely.
export const payloadConfigured = (env: Env): boolean =>
  Boolean(env.PAYLOAD || env.PAYLOAD_API_URL?.trim());

// The same request shape as WordPress: the editor's Access JWT in
// `X-Access-User-Jwt`, the gateway proof beside it, and a service token when
// Payload is reached through its Access application. Payload's
// `cloudflare-access-gateway` strategy checks the proof before it trusts the
// JWT, so the proof secret is required here, not optional.
export const createPayloadClient = (
  env: Env,
  access: VerifiedAccessResult
): WordPressClient => {
  const proofSecret = env.PAYLOAD_ACCESS_PROOF_SECRET?.trim();

  if (!proofSecret) {
    throw new WordPressRequestError(
      "PAYLOAD_ACCESS_PROOF_SECRET is not configured"
    );
  }

  const auth: WordPressAuth = {
    kind: "access-jwt",
    proofSecret,
    token: access.token,
  };

  if (env.PAYLOAD) {
    return { apiUrl: PAYLOAD_BINDING_ORIGIN, auth, fetcher: env.PAYLOAD };
  }

  const apiUrl = env.PAYLOAD_API_URL?.trim();

  if (!apiUrl) {
    throw new WordPressRequestError("Payload is not configured");
  }

  assertSafeApiUrl(apiUrl);
  const clientId = env.PAYLOAD_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.PAYLOAD_ACCESS_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    auth.serviceToken = { clientId, clientSecret };
  }

  return { apiUrl, auth };
};

// Only fixed, site-relative REST paths built in this module reach Payload.
const payloadUrl = (client: WordPressClient, path: string): URL => {
  const base = assertSafeApiUrl(client.apiUrl);
  const url = new URL(path, base);

  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
    throw new WordPressRequestError("Payload path escaped /api/");
  }

  return url;
};

// Payload answers an error as `{ errors: [{ message }] }`. Its messages are
// written for editors ("You are not allowed to perform this action."), so the
// first one is passed on, bounded.
export const payloadErrorMessage = (result: WpFetchResult): string => {
  const parsed = payloadErrorsSchema.safeParse(result.json);
  const message = parsed.success ? parsed.data.errors[0]?.message : undefined;

  if (message) {
    return `Payload: ${message.slice(0, 200)}`;
  }

  if (result.status === 401 || result.status === 403) {
    return "Payload did not accept the request's authentication.";
  }

  return `Payload returned HTTP ${result.status}`;
};

export const payloadRest = (
  client: WordPressClient,
  path: string,
  telemetry: WordPressTelemetry,
  init: RequestInit = {}
): Promise<WpFetchResult> =>
  wpFetchUrl(client, payloadUrl(client, path), telemetry, init);

export interface PayloadToolResult {
  isError: boolean;
  // Present when the tool returned structured content.
  structured?: JsonObject;
  // The tool's text blocks, joined. Payload's built-in tools put the
  // documents here as JSON after a one-line heading.
  text: string;
}

// One `tools/call` against Payload's own MCP server. It is stateless JSON
// over Streamable HTTP, so a single POST is the whole exchange.
export const payloadMcpRequest = async (
  client: WordPressClient,
  method: "tools/call" | "tools/list",
  params: JsonObject,
  telemetry: WordPressTelemetry
): Promise<JsonValue> => {
  const result = await payloadRest(client, MCP_PATH, telemetry, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (result.status < 200 || result.status >= 300) {
    throw new WordPressRequestError(payloadErrorMessage(result));
  }

  const rpc = rpcResponseSchema.safeParse(result.json);

  if (!rpc.success) {
    throw new WordPressRequestError("Payload returned an invalid MCP response");
  }

  if (rpc.data.error) {
    throw new WordPressRequestError(
      `Payload: ${rpc.data.error.message.slice(0, 200)}`
    );
  }

  return rpc.data.result ?? null;
};

export const toPayloadToolResult = (value: JsonValue): PayloadToolResult => {
  const parsed = toolResultSchema.safeParse(value);

  if (!parsed.success) {
    throw new WordPressRequestError("Payload returned an invalid tool result");
  }

  const text = (parsed.data.content ?? [])
    .map((block) => textBlockSchema.safeParse(block))
    .filter((block) => block.success)
    .map((block) => block.data.text)
    .join("\n");

  const result: PayloadToolResult = {
    isError: parsed.data.isError ?? false,
    text,
  };

  if (parsed.data.structuredContent) {
    result.structured = parsed.data.structuredContent;
  }

  return result;
};

// The admin link the approval page offers. Over a Service binding the
// gateway knows no public origin, so the link comes from PAYLOAD_ADMIN_URL
// and is left out when that is unset.
export const payloadAdminUrl = (
  env: Env,
  collection: string,
  id: number | string
): string => {
  const origin = env.PAYLOAD_ADMIN_URL?.trim() || env.PAYLOAD_API_URL?.trim();

  if (!origin) {
    return "";
  }

  try {
    return new URL(
      `/admin/collections/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`,
      assertSafeApiUrl(origin)
    ).toString();
  } catch {
    return "";
  }
};
