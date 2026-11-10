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

import { boundedPath } from "./logging";
import type {
  McpRequestLogger,
  UpstreamActor,
  UpstreamRequestEvent,
  UpstreamRequestLog,
} from "./logging";

// The one HTTP path from the gateway to a CMS. Every connector builds an
// `UpstreamClient` and calls `upstreamFetch`, which forwards the editor's
// Access JWT with a gateway proof, bounds the response, and records the
// request for the wide event. What a response means (the acting user, an
// error code, paging totals) is the connector's to read, through `inspect`.

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// How many per-request records one telemetry keeps. A script can loop, so the
// collection a Durable Object RPC hands back has to be bounded before it
// reaches the wide event; anything past the cap is counted, never kept.
export const MAX_LOGGED_UPSTREAM_REQUESTS = 50;

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;

export type JsonObject = z.infer<typeof jsonObjectSchema>;

export interface UpstreamRequestMeasurement {
  errorCode?: string;
  method: string;
  path: string;
  status: number;
  outcome: "error" | "ok";
  durationMs: number;
}

export interface UpstreamAuth {
  kind: "access-jwt";
  token: string;
  proofSecret?: string;
  // Gets the request through the Access application in front of the CMS.
  // Absent when the CMS is not behind Access, as in local development.
  serviceToken?: ServiceToken;
}

// What a connector reads off one response. Each field is optional: a CMS that
// reports no acting user or no paging simply leaves it out.
export interface UpstreamResponseInfo {
  actor?: UpstreamActor | undefined;
  errorCode?: string | undefined;
  totalItems?: number | undefined;
  totalPages?: number | undefined;
}

export interface UpstreamClient {
  apiUrl: string;
  // The connector's sandbox global (`wp`, `payload`), recorded on each request
  // in the wide event so a gateway with two CMSs can tell their traffic apart.
  connector?: string;
  auth: UpstreamAuth;
  inspect?: (response: Response, json: JsonValue) => UpstreamResponseInfo;
  // Names the CMS in error messages ("Payload returned invalid JSON").
  label?: string;
  // A Service binding to the CMS Worker. Requests then go Worker to Worker
  // and never cross the Access edge, so the CMS checks the gateway proof.
  // Absent, requests go to `apiUrl` over the internet.
  fetcher?: Fetcher;
}

export interface UpstreamTelemetry {
  log?: McpRequestLogger;
  requests: UpstreamRequestMeasurement[];
  // The bounded, wide-event-shaped record of the same requests. The Durable
  // Object returns this on every RPC because it, not the Worker, is the side
  // that talks to the CMS. Undefined until the first request is made.
  upstream?: UpstreamRequestLog;
}

export class UpstreamRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

export const createUpstreamTelemetry = (
  log?: McpRequestLogger
): UpstreamTelemetry => (log ? { log, requests: [] } : { requests: [] });

export const assertSafeApiUrl = (apiUrl: string): URL => {
  let parsed: URL;

  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new UpstreamRequestError("The CMS API URL is not a valid URL");
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

  throw new UpstreamRequestError(
    "The CMS API URL must be HTTPS outside localhost"
  );
};

export const numericHeader = (
  headers: Headers,
  name: string
): number | undefined => {
  const value = headers.get(name);

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

export const upstreamAuthHeaders = (
  auth: UpstreamAuth,
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

export interface UpstreamFetchResult {
  errorCode?: string;
  status: number;
  path: string;
  json: JsonValue;
  totalItems?: number;
  totalPages?: number;
}

const readBodyChunks = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  totalBytes: number,
  label: string
): Promise<number> => {
  const { done, value } = await reader.read();

  if (done) {
    return totalBytes;
  }

  const nextTotal = totalBytes + value.byteLength;

  if (nextTotal > MAX_BODY_BYTES) {
    await reader.cancel();
    throw new UpstreamRequestError(`${label} response exceeded the size limit`);
  }

  chunks.push(value);

  return readBodyChunks(reader, chunks, nextTotal, label);
};

const readBoundedJson = async (
  response: Response,
  label: string
): Promise<JsonValue> => {
  const contentLength = response.headers.get("Content-Length");

  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_BODY_BYTES
  ) {
    throw new UpstreamRequestError(`${label} response exceeded the size limit`);
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const totalBytes = await readBodyChunks(reader, chunks, 0, label);

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
    throw new UpstreamRequestError(`${label} returned invalid JSON`);
  }
};

const boundedMethod = (
  method: string | undefined
): UpstreamRequestEvent["method"] => {
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
// script that loops never holds more than `MAX_LOGGED_UPSTREAM_REQUESTS`
// records in memory either.
const collectUpstreamEvent = (
  telemetry: UpstreamTelemetry,
  auth: UpstreamAuth["kind"],
  target: string,
  event: UpstreamRequestEvent,
  actor?: UpstreamActor
): void => {
  const collected: UpstreamRequestLog = telemetry.upstream ?? {
    auth,
    requests: [],
    target,
  };

  if (actor && !collected.actor) {
    collected.actor = actor;
  }

  if (collected.requests.length < MAX_LOGGED_UPSTREAM_REQUESTS) {
    collected.requests.push(event);
  } else {
    collected.truncated = (collected.truncated ?? 0) + 1;
  }

  telemetry.upstream = collected;
};

const recordUpstreamRequest = (
  telemetry: UpstreamTelemetry,
  url: URL,
  client: UpstreamClient,
  request: UpstreamRequestMeasurement,
  actor?: UpstreamActor
): void => {
  telemetry.requests.push(request);
  const auth = client.auth.kind;

  const event: UpstreamRequestEvent = {
    durationMs: request.durationMs,
    method: boundedMethod(request.method),
    outcome: request.outcome === "ok" ? "success" : "error",
    path: request.path,
    status: request.status,
  };

  if (request.errorCode) {
    event.errorCode = request.errorCode;
  }

  if (client.connector) {
    event.connector = client.connector;
  }

  collectUpstreamEvent(telemetry, auth, url.hostname, event, actor);

  const upstream: UpstreamRequestLog = {
    auth,
    requests: [event],
    target: url.hostname,
  };

  if (actor) {
    upstream.actor = actor;
  }

  telemetry.log?.set({ upstream });
};

export const upstreamFetch = async (
  client: UpstreamClient,
  url: URL,
  telemetry: UpstreamTelemetry,
  init: RequestInit = {}
): Promise<UpstreamFetchResult> => {
  const startedAt = Date.now();
  const label = client.label ?? "Upstream";
  const method = (init.method ?? "GET").toUpperCase();
  const loggedPath = boundedPath(url);

  const gatewayProof = client.auth.proofSecret
    ? await computeGatewayProof(client.auth.proofSecret, client.auth.token)
    : undefined;

  const headers = upstreamAuthHeaders(client.auth, init.headers, gatewayProof);

  let status = 0;

  try {
    const requestInit: RequestInit = { ...init, headers, redirect: "manual" };

    const response = await (client.fetcher
      ? client.fetcher.fetch(url, requestInit)
      : fetch(url, requestInit));

    const { status: responseStatus } = response;
    status = responseStatus;
    const json = await readBoundedJson(response, label);
    const info = client.inspect?.(response, json) ?? {};
    const { actor } = info;
    const errorCode = response.ok ? undefined : info.errorCode;

    const measurement: UpstreamRequestMeasurement = {
      durationMs: Date.now() - startedAt,
      method,
      outcome: response.ok ? "ok" : "error",
      path: loggedPath,
      status,
    };

    if (errorCode) {
      measurement.errorCode = errorCode;
    }

    recordUpstreamRequest(telemetry, url, client, measurement, actor);
    const { totalItems, totalPages } = info;

    const result: UpstreamFetchResult = {
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
    recordUpstreamRequest(telemetry, url, client, {
      durationMs: Date.now() - startedAt,
      method,
      outcome: "error",
      path: loggedPath,
      status,
    });

    if (error instanceof UpstreamRequestError) {
      throw error;
    }

    throw new UpstreamRequestError(`${label} request failed`);
  }
};
