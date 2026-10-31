import {
  CLIENT_ID_HEADER,
  CLIENT_SECRET_HEADER,
  FORWARDED_JWT_HEADER,
  GATEWAY_PROOF_HEADER,
  computeGatewayProof,
  serviceTokenHeaders,
} from "@patronage/access";
import type { ServiceToken } from "@patronage/access";
import { z } from "zod";

import type { AccessResult } from "./access";
import { boundedPath, wordpressActorSchema } from "./logging";
import type {
  McpRequestLogger,
  WordPressActor,
  WordPressRequestEvent,
  WordPressRequestLog,
} from "./logging";

const MAX_WORDPRESS_BODY_BYTES = 10 * 1024 * 1024;
const MAX_WORDPRESS_ERROR_CODE_LENGTH = 64;
const WORDPRESS_USER_ID_HEADER = "X-Access-WordPress-User-ID";
const WORDPRESS_USER_SLUG_HEADER = "X-Access-WordPress-User-Slug";

// How many per-request records one telemetry keeps. A script can loop, so the
// collection a Durable Object RPC hands back has to be bounded before it
// reaches the wide event; anything past the cap is counted, never kept.
export const MAX_LOGGED_WORDPRESS_REQUESTS = 50;

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const stringSchema = z.string();

export type JsonValue = z.infer<typeof jsonValueSchema>;

export type JsonObject = z.infer<typeof jsonObjectSchema>;

export interface WordPressRequestMeasurement {
  errorCode?: string;
  method: string;
  path: string;
  status: number;
  outcome: "error" | "ok";
  durationMs: number;
}

export interface WordPressAuth {
  kind: "access-jwt";
  token: string;
  proofSecret?: string;
  // Gets the request through the Access application in front of WordPress.
  // Absent when WordPress is not behind Access, as in local development.
  serviceToken?: ServiceToken;
}

export interface WordPressClient {
  apiUrl: string;
  auth: WordPressAuth;
  // A Service binding to the CMS Worker. Requests then go Worker to Worker
  // and never cross the Access edge, so the CMS checks the gateway proof.
  // Absent, requests go to `apiUrl` over the internet.
  fetcher?: Fetcher;
}

export interface WordPressTelemetry {
  log?: McpRequestLogger;
  requests: WordPressRequestMeasurement[];
  // The bounded, wide-event-shaped record of the same requests. The Durable
  // Object returns this on every RPC because it, not the Worker, is the side
  // that talks to WordPress. Undefined until the first request is made.
  wordpress?: WordPressRequestLog;
}

export class WordPressRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordPressRequestError";
  }
}

export const createWordPressTelemetry = (
  log?: McpRequestLogger
): WordPressTelemetry => (log ? { log, requests: [] } : { requests: [] });

export const assertSafeApiUrl = (apiUrl: string): URL => {
  let parsed: URL;

  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new WordPressRequestError("WORDPRESS_API_URL is not a valid URL");
  }

  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";

  if (parsed.protocol === "https:") {
    return parsed;
  }

  if (parsed.protocol === "http:" && local) {
    return parsed;
  }

  throw new WordPressRequestError(
    "WORDPRESS_API_URL must be HTTPS outside localhost"
  );
};

type VerifiedAccessResult = Extract<AccessResult, { ok: true }>;

export const createWordPressClient = (
  env: Env,
  access: VerifiedAccessResult
): WordPressClient => {
  const apiUrl = env.WORDPRESS_API_URL?.trim();

  if (!apiUrl) {
    throw new WordPressRequestError("WORDPRESS_API_URL is not configured");
  }

  assertSafeApiUrl(apiUrl);

  const auth: WordPressAuth = { kind: "access-jwt", token: access.token };
  const proofSecret = env.WORDPRESS_ACCESS_PROOF_SECRET?.trim();

  if (proofSecret) {
    auth.proofSecret = proofSecret;
  }

  const clientId = env.WORDPRESS_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.WORDPRESS_ACCESS_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    auth.serviceToken = { clientId, clientSecret };
  }

  return { apiUrl, auth };
};

export const resolveWpUrl = (apiUrl: string, path: string): URL => {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path) || path.startsWith("//")) {
    throw new WordPressRequestError(
      "WordPress path must be a site-relative /wp-json/ path"
    );
  }

  if (!path.startsWith("/wp-json/")) {
    throw new WordPressRequestError("WordPress path must start with /wp-json/");
  }

  const base = assertSafeApiUrl(apiUrl);
  const url = new URL(path, base);

  if (url.origin !== base.origin) {
    throw new WordPressRequestError("WordPress path escaped origin");
  }

  if (!url.pathname.startsWith("/wp-json/")) {
    throw new WordPressRequestError("WordPress path escaped /wp-json/");
  }

  return url;
};

export const wordPressAuthHeaders = (
  auth: WordPressAuth,
  initialHeaders?: HeadersInit,
  gatewayProof?: string
): Headers => {
  const headers = new Headers(initialHeaders);
  headers.delete("Authorization");
  headers.delete(FORWARDED_JWT_HEADER);
  headers.delete(GATEWAY_PROOF_HEADER);
  headers.delete(CLIENT_ID_HEADER);
  headers.delete(CLIENT_SECRET_HEADER);

  if (auth.serviceToken) {
    for (const [name, value] of serviceTokenHeaders(auth.serviceToken)) {
      headers.set(name, value);
    }
  }

  headers.set(FORWARDED_JWT_HEADER, auth.token);

  if (gatewayProof) {
    headers.set(GATEWAY_PROOF_HEADER, gatewayProof);
  }

  // Payload's MCP endpoint needs the Streamable HTTP pair, so a caller's own
  // Accept stands.
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  return headers;
};

export interface WpFetchResult {
  errorCode?: string;
  status: number;
  path: string;
  json: JsonValue;
  totalItems?: number;
  totalPages?: number;
}

export const boundedWordPressErrorCode = (
  value: string
): string | undefined => {
  if (!/^[a-z0-9_]+$/u.test(value)) {
    return undefined;
  }

  return value.slice(0, MAX_WORDPRESS_ERROR_CODE_LENGTH);
};

const wordPressErrorCode = (json: JsonValue): string | undefined => {
  const object = jsonObjectSchema.safeParse(json);

  if (!object.success) {
    return undefined;
  }

  const code = stringSchema.safeParse(object.data.code);

  return code.success ? boundedWordPressErrorCode(code.data) : undefined;
};

export const wordPressErrorMessage = (
  status: number,
  errorCode?: string
): string | undefined => {
  switch (errorCode) {
    case "patronage_access_invalid_token": {
      return "WordPress rejected the Access token. Reconnect the MCP client and retry.";
    }

    case "patronage_access_no_email": {
      return "Service tokens cannot act as a WordPress user.";
    }

    case "patronage_access_missing_proof":
    case "patronage_access_invalid_proof": {
      return "WordPress rejected the gateway proof. The Worker and WordPress proof secrets are out of sync.";
    }

    case "patronage_access_no_user": {
      return "No WordPress account matches your Access login. Ask a site administrator to create one with the same email.";
    }

    case "patronage_access_not_configured": {
      return "The WordPress site's Access authentication plugin is not configured.";
    }

    case "rest_cannot_view":
    case "rest_forbidden":
    case "rest_forbidden_context":
    case "rest_forbidden_status": {
      return "Your WordPress account does not have permission for this content.";
    }

    default: {
      break;
    }
  }

  if (status === 401 || status === 403) {
    return "WordPress did not accept the request's authentication.";
  }

  return undefined;
};

const readBodyChunks = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  totalBytes: number
): Promise<number> => {
  const { done, value } = await reader.read();

  if (done) {
    return totalBytes;
  }

  const nextTotal = totalBytes + value.byteLength;

  if (nextTotal > MAX_WORDPRESS_BODY_BYTES) {
    await reader.cancel();
    throw new WordPressRequestError(
      "WordPress response exceeded the size limit"
    );
  }

  chunks.push(value);

  return readBodyChunks(reader, chunks, nextTotal);
};

const readBoundedJson = async (response: Response): Promise<JsonValue> => {
  const contentLength = response.headers.get("Content-Length");

  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_WORDPRESS_BODY_BYTES
  ) {
    throw new WordPressRequestError(
      "WordPress response exceeded the size limit"
    );
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const totalBytes = await readBodyChunks(reader, chunks, 0);

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (body.byteLength === 0) {
    return null;
  }

  try {
    return jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    throw new WordPressRequestError("WordPress returned invalid JSON");
  }
};

const numericHeader = (headers: Headers, name: string): number | undefined => {
  const value = headers.get(name);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const wordpressActor = (headers: Headers): WordPressActor | undefined => {
  const id = numericHeader(headers, WORDPRESS_USER_ID_HEADER);
  const encodedSlug = headers.get(WORDPRESS_USER_SLUG_HEADER);

  if (!(id && encodedSlug)) {
    return undefined;
  }

  let slug: string;

  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    return undefined;
  }

  const parsed = wordpressActorSchema.safeParse({ id, slug });

  return parsed.success ? parsed.data : undefined;
};

const boundedMethod = (
  method: string | undefined
): WordPressRequestEvent["method"] => {
  const normalized = (method ?? "GET").toUpperCase();

  if (
    normalized === "DELETE" ||
    normalized === "GET" ||
    normalized === "HEAD" ||
    normalized === "PATCH" ||
    normalized === "POST" ||
    normalized === "PUT"
  ) {
    return normalized;
  }

  return "OTHER";
};

// The cap is applied as records arrive rather than when they are read, so a
// script that loops never holds more than `MAX_LOGGED_WORDPRESS_REQUESTS`
// records in memory either.
const collectWordPressEvent = (
  telemetry: WordPressTelemetry,
  auth: WordPressAuth["kind"],
  target: string,
  event: WordPressRequestEvent,
  actor?: WordPressActor
): void => {
  const collected: WordPressRequestLog = telemetry.wordpress ?? {
    auth,
    requests: [],
    target,
  };

  if (actor && !collected.actor) {
    collected.actor = actor;
  }

  if (collected.requests.length < MAX_LOGGED_WORDPRESS_REQUESTS) {
    collected.requests.push(event);
  } else {
    collected.truncated = (collected.truncated ?? 0) + 1;
  }

  telemetry.wordpress = collected;
};

const recordWordPressRequest = (
  telemetry: WordPressTelemetry,
  url: URL,
  auth: WordPressAuth["kind"],
  request: WordPressRequestMeasurement,
  actor?: WordPressActor
): void => {
  telemetry.requests.push(request);

  const event: WordPressRequestEvent = {
    durationMs: request.durationMs,
    method: boundedMethod(request.method),
    outcome: request.outcome === "ok" ? "success" : "error",
    path: request.path,
    status: request.status,
  };

  if (request.errorCode) {
    event.errorCode = request.errorCode;
  }

  collectWordPressEvent(telemetry, auth, url.hostname, event, actor);

  const wordpress: WordPressRequestLog = {
    auth,
    requests: [event],
    target: url.hostname,
  };

  if (actor) {
    wordpress.actor = actor;
  }

  telemetry.log?.set({ wordpress });
};

export const wpFetchUrl = async (
  client: WordPressClient,
  url: URL,
  telemetry: WordPressTelemetry,
  init: RequestInit = {}
): Promise<WpFetchResult> => {
  const startedAt = Date.now();
  const method = (init.method ?? "GET").toUpperCase();
  const loggedPath = boundedPath(url);

  const gatewayProof = client.auth.proofSecret
    ? await computeGatewayProof(client.auth.proofSecret, client.auth.token)
    : undefined;

  const headers = wordPressAuthHeaders(client.auth, init.headers, gatewayProof);

  let status = 0;

  try {
    const requestInit: RequestInit = { ...init, headers, redirect: "manual" };

    const response = await (client.fetcher
      ? client.fetcher.fetch(url, requestInit)
      : fetch(url, requestInit));

    const { status: responseStatus } = response;
    status = responseStatus;
    const actor = wordpressActor(response.headers);
    const json = await readBoundedJson(response);
    const errorCode = response.ok ? undefined : wordPressErrorCode(json);

    const measurement: WordPressRequestMeasurement = {
      durationMs: Date.now() - startedAt,
      method,
      outcome: response.ok ? "ok" : "error",
      path: loggedPath,
      status,
    };

    if (errorCode) {
      measurement.errorCode = errorCode;
    }

    recordWordPressRequest(
      telemetry,
      url,
      client.auth.kind,
      measurement,
      actor
    );
    const totalItems = numericHeader(response.headers, "X-WP-Total");
    const totalPages = numericHeader(response.headers, "X-WP-TotalPages");

    const result: WpFetchResult = {
      json,
      path: loggedPath,
      status,
    };

    if (errorCode) {
      result.errorCode = errorCode;
    }

    if (totalItems !== undefined) {
      result.totalItems = totalItems;
    }

    if (totalPages !== undefined) {
      result.totalPages = totalPages;
    }

    return result;
  } catch (error) {
    recordWordPressRequest(telemetry, url, client.auth.kind, {
      durationMs: Date.now() - startedAt,
      method,
      outcome: "error",
      path: loggedPath,
      status,
    });

    if (error instanceof WordPressRequestError) {
      throw error;
    }

    throw new WordPressRequestError("WordPress request failed");
  }
};

// The REST entry point: every path a caller supplies is resolved through
// `resolveWpUrl`, so nothing but a site-relative `/wp-json/` path reaches the
// network here.
export const wpFetch = async (
  client: WordPressClient,
  path: string,
  telemetry: WordPressTelemetry,
  init: RequestInit = {}
): Promise<WpFetchResult> =>
  await wpFetchUrl(client, resolveWpUrl(client.apiUrl, path), telemetry, init);

// WPGraphQL answers at the site root, not under `/wp-json/`, so it is a
// separate fixed URL rather than a path a caller can influence.
export const graphqlUrl = (apiUrl: string): URL =>
  new URL("/graphql", assertSafeApiUrl(apiUrl));

export const wpGraphql = async (
  client: WordPressClient,
  query: string,
  variables: JsonObject | undefined,
  telemetry: WordPressTelemetry
): Promise<JsonValue> => {
  const body = variables ? { query, variables } : { query };

  const result = await wpFetchUrl(
    client,
    graphqlUrl(client.apiUrl),
    telemetry,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );

  if (result.status < 200 || result.status >= 300) {
    throw new WordPressRequestError(
      wordPressErrorMessage(result.status, result.errorCode) ??
        "WPGraphQL request failed"
    );
  }

  // A GraphQL error travels in the 200 body as `{data, errors}`; the model
  // reads it and rewrites the query, so it is returned rather than thrown.
  return result.json;
};
