import {
  UpstreamRequestError,
  assertSafeApiUrl,
  upstreamFetch,
} from "@patronage/mcp-core";
import type {
  AccessResult,
  JsonValue,
  UpstreamAuth,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import type { EmDashEnv } from "./env";

// The origin requests carry when they go over the Service binding. The
// binding ignores it; it only has to be a valid HTTPS URL.
export const EMDASH_BINDING_ORIGIN = "https://emdash.internal";

export const EMDASH_API_PREFIX = "/_emdash/api/";

type VerifiedAccessResult = Pick<
  Extract<AccessResult, { ok: true }>,
  "subjectOpaque" | "token"
>;

// Whether this deployment has an EmDash site at all. Without one the
// `emdash` connector is left out of the runtime entirely.
export const emdashConfigured = (env: EmDashEnv): boolean =>
  Boolean(env.EMDASH || env.EMDASH_API_URL?.trim());

// The same request shape as WordPress and Payload: the editor's Access JWT in
// `X-Access-User-Jwt`, the gateway proof beside it, and a service token when
// EmDash is reached through its Access application. EmDash's gateway auth
// provider (apps/emdash/src/auth/gateway-access.ts) refuses the JWT without
// a valid proof, so the proof secret is required here.
export const createEmDashClient = (
  env: EmDashEnv,
  access: VerifiedAccessResult
): UpstreamClient => {
  const proofSecret = env.EMDASH_ACCESS_PROOF_SECRET?.trim();

  if (!proofSecret) {
    throw new UpstreamRequestError(
      "EMDASH_ACCESS_PROOF_SECRET is not configured"
    );
  }

  const auth: UpstreamAuth = {
    kind: "access-jwt",
    proofSecret,
    token: access.token,
  };

  if (env.EMDASH) {
    return {
      apiUrl: EMDASH_BINDING_ORIGIN,
      auth,
      connector: "emdash",
      fetcher: env.EMDASH,
      label: "EmDash",
    };
  }

  const apiUrl = env.EMDASH_API_URL?.trim();

  if (!apiUrl) {
    throw new UpstreamRequestError("EmDash is not configured");
  }

  assertSafeApiUrl(apiUrl);
  const clientId = env.EMDASH_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.EMDASH_ACCESS_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    auth.serviceToken = { clientId, clientSecret };
  }

  return { apiUrl, auth, connector: "emdash", label: "EmDash" };
};

// Only site-relative paths under /_emdash/api/ reach EmDash.
export const emdashUrl = (client: UpstreamClient, path: string): URL => {
  const base = assertSafeApiUrl(client.apiUrl);
  const url = new URL(path, base);

  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(EMDASH_API_PREFIX)
  ) {
    throw new UpstreamRequestError("EmDash path escaped /_emdash/api/");
  }

  return url;
};

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const successSchema = z.object({ data: z.json(), success: z.literal(true) });

// EmDash's own error code, such as CONFLICT or FORBIDDEN, when it sent one.
export const emdashErrorCode = (
  result: UpstreamFetchResult
): string | undefined => {
  const parsed = errorSchema.safeParse(result.json);

  return parsed.success ? parsed.data.error.code : undefined;
};

// EmDash answers an error as `{ error: { code, message } }`. Its messages are
// written for editors, so the first one is passed on, bounded, with its code.
export const emdashErrorMessage = (result: UpstreamFetchResult): string => {
  const parsed = errorSchema.safeParse(result.json);

  if (parsed.success) {
    return `EmDash ${parsed.data.error.code}: ${parsed.data.error.message.slice(0, 200)}`;
  }

  if (result.status === 401 || result.status === 403) {
    return "EmDash did not accept the request's authentication.";
  }

  return `EmDash returned HTTP ${result.status}`;
};

// Every API request says it came from a script, as EmDash's own client does:
// the middleware refuses an unsafe method without it.
export const emdashRest = (
  client: UpstreamClient,
  path: string,
  telemetry: UpstreamTelemetry,
  init: RequestInit = {}
): Promise<UpstreamFetchResult> => {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-EmDash-Request", "1");

  return upstreamFetch(client, emdashUrl(client, path), telemetry, {
    ...init,
    headers,
  });
};

// A successful response's `data`, or the EmDash error as a thrown message.
export const emdashData = async (
  client: UpstreamClient,
  path: string,
  telemetry: UpstreamTelemetry,
  init: RequestInit = {}
): Promise<JsonValue> => {
  const result = await emdashRest(client, path, telemetry, init);

  if (result.status < 200 || result.status >= 300) {
    throw new UpstreamRequestError(emdashErrorMessage(result));
  }

  const parsed = successSchema.safeParse(result.json);

  if (!parsed.success) {
    throw new UpstreamRequestError("EmDash returned an unexpected response");
  }

  return parsed.data.data;
};

const publicOrigin = (env: EmDashEnv): URL | undefined => {
  const origin = env.EMDASH_ADMIN_URL?.trim() || env.EMDASH_API_URL?.trim();

  if (!origin) {
    return undefined;
  }

  try {
    return assertSafeApiUrl(origin);
  } catch {
    return undefined;
  }
};

// The public origin a preview path is joined to, or "" when unknown.
export const emdashSiteUrl = (env: EmDashEnv): string =>
  publicOrigin(env)?.origin ?? "";

// An entry's page in the EmDash admin. Over a Service binding the gateway
// knows no public origin, so the link comes from EMDASH_ADMIN_URL and is left
// out when that is unset.
export const emdashAdminUrl = (
  env: EmDashEnv,
  collection: string,
  id: string
): string => {
  const origin = publicOrigin(env);

  return origin
    ? new URL(
        `/_emdash/admin/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
        origin
      ).toString()
    : "";
};
