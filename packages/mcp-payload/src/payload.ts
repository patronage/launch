import {
  UpstreamRequestError,
  assertSafeApiUrl,
  upstreamFetch,
  upstreamFetchBytes,
} from "@patronage/mcp-core";
import type {
  AccessResult,
  JsonObject,
  JsonValue,
  UpstreamAuth,
  UpstreamBytesResult,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import type { PayloadEnv } from "./env";

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
export const payloadConfigured = (env: PayloadEnv): boolean =>
  Boolean(env.PAYLOAD || env.PAYLOAD_API_URL?.trim());

// The same request shape as WordPress: the editor's Access JWT in
// `X-Access-User-Jwt`, the gateway proof beside it, and a service token when
// Payload is reached through its Access application. Payload's
// `cloudflare-access-gateway` strategy checks the proof before it trusts the
// JWT, so the proof secret is required here, not optional.
export const createPayloadClient = (
  env: PayloadEnv,
  access: VerifiedAccessResult
): UpstreamClient => {
  const proofSecret = env.PAYLOAD_ACCESS_PROOF_SECRET?.trim();

  if (!proofSecret) {
    throw new UpstreamRequestError(
      "PAYLOAD_ACCESS_PROOF_SECRET is not configured"
    );
  }

  const auth: UpstreamAuth = {
    kind: "access-jwt",
    proofSecret,
    token: access.token,
  };

  if (env.PAYLOAD) {
    return {
      apiUrl: PAYLOAD_BINDING_ORIGIN,
      auth,
      connector: "payload",
      fetcher: env.PAYLOAD,
      label: "Payload",
    };
  }

  const apiUrl = env.PAYLOAD_API_URL?.trim();

  if (!apiUrl) {
    throw new UpstreamRequestError("Payload is not configured");
  }

  assertSafeApiUrl(apiUrl);
  const clientId = env.PAYLOAD_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.PAYLOAD_ACCESS_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    auth.serviceToken = { clientId, clientSecret };
  }

  return { apiUrl, auth, connector: "payload", label: "Payload" };
};

// Only fixed, site-relative REST paths built in this module reach Payload.
const payloadUrl = (client: UpstreamClient, path: string): URL => {
  const base = assertSafeApiUrl(client.apiUrl);
  const url = new URL(path, base);

  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
    throw new UpstreamRequestError("Payload path escaped /api/");
  }

  return url;
};

// Payload answers an error as `{ errors: [{ message }] }`. Its messages are
// written for editors ("You are not allowed to perform this action."), so the
// first one is passed on, bounded.
export const payloadErrorMessage = (result: UpstreamFetchResult): string => {
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
  client: UpstreamClient,
  path: string,
  telemetry: UpstreamTelemetry,
  init: RequestInit = {}
): Promise<UpstreamFetchResult> =>
  upstreamFetch(client, payloadUrl(client, path), telemetry, init);

// A file Payload serves, read as the editor: the `url` of an upload
// document. Only its path is used, so wherever Payload says its public
// origin is, the read goes to the Payload this gateway is bound to.
export const payloadFile = async (
  client: UpstreamClient,
  link: string,
  telemetry: UpstreamTelemetry,
  maxBytes: number
): Promise<UpstreamBytesResult> => {
  const base = assertSafeApiUrl(client.apiUrl);
  let path = "";

  try {
    const url = new URL(link, base);

    path = `${url.pathname}${url.search}`;
  } catch {
    throw new UpstreamRequestError("Payload returned an unreadable file URL");
  }

  return await upstreamFetchBytes(
    client,
    payloadUrl(client, path),
    telemetry,
    maxBytes
  );
};

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
  client: UpstreamClient,
  method: "tools/call" | "tools/list",
  params: JsonObject,
  telemetry: UpstreamTelemetry
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
    throw new UpstreamRequestError(payloadErrorMessage(result));
  }

  const rpc = rpcResponseSchema.safeParse(result.json);

  if (!rpc.success) {
    throw new UpstreamRequestError("Payload returned an invalid MCP response");
  }

  if (rpc.data.error) {
    throw new UpstreamRequestError(
      `Payload: ${rpc.data.error.message.slice(0, 200)}`
    );
  }

  return rpc.data.result ?? null;
};

export const toPayloadToolResult = (value: JsonValue): PayloadToolResult => {
  const parsed = toolResultSchema.safeParse(value);

  if (!parsed.success) {
    throw new UpstreamRequestError("Payload returned an invalid tool result");
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

const publicOrigin = (env: PayloadEnv): URL | undefined => {
  const origin = env.PAYLOAD_ADMIN_URL?.trim() || env.PAYLOAD_API_URL?.trim();

  if (!origin) {
    return undefined;
  }

  try {
    return assertSafeApiUrl(origin);
  } catch {
    return undefined;
  }
};

// A link Payload made to its own site, such as a draft preview path, as an
// absolute URL. Payload usually answers with a path; an absolute URL is kept
// only when it stays on the site's own origin, so nothing Payload returns can
// send an approver somewhere else.
export const payloadSiteUrl = (env: PayloadEnv, link: string): string => {
  const origin = publicOrigin(env);

  if (!(origin && link)) {
    return "";
  }

  try {
    const url = new URL(link, origin);

    return url.origin === origin.origin ? url.toString() : "";
  } catch {
    return "";
  }
};

// The admin link the approval page offers. Over a Service binding the
// gateway knows no public origin, so the link comes from PAYLOAD_ADMIN_URL
// and is left out when that is unset.
export const payloadAdminUrl = (
  env: PayloadEnv,
  collection: string,
  id: number | string
): string => {
  const origin = publicOrigin(env);

  return origin
    ? new URL(
        `/admin/collections/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`,
        origin
      ).toString()
    : "";
};
