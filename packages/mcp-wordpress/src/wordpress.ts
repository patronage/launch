import {
  UpstreamRequestError,
  assertSafeApiUrl,
  numericHeader,
  upstreamActorSchema,
  upstreamFetch,
} from "@patronage/mcp-core";
import type {
  AccessResult,
  JsonObject,
  JsonValue,
  UpstreamActor,
  UpstreamAuth,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamResponseInfo,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import type { WordPressEnv } from "./env";

const MAX_WORDPRESS_ERROR_CODE_LENGTH = 64;
const WORDPRESS_USER_ID_HEADER = "X-Access-WordPress-User-ID";
const WORDPRESS_USER_SLUG_HEADER = "X-Access-WordPress-User-Slug";

const jsonObjectSchema = z.record(z.string(), z.json());
const stringSchema = z.string();

export const resolveWpUrl = (apiUrl: string, path: string): URL => {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path) || path.startsWith("//")) {
    throw new UpstreamRequestError(
      "WordPress path must be a site-relative /wp-json/ path"
    );
  }

  if (!path.startsWith("/wp-json/")) {
    throw new UpstreamRequestError("WordPress path must start with /wp-json/");
  }

  const base = assertSafeApiUrl(apiUrl);
  const url = new URL(path, base);

  if (url.origin !== base.origin) {
    throw new UpstreamRequestError("WordPress path escaped origin");
  }

  if (!url.pathname.startsWith("/wp-json/")) {
    throw new UpstreamRequestError("WordPress path escaped /wp-json/");
  }

  return url;
};

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

const wordpressActor = (headers: Headers): UpstreamActor | undefined => {
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

  const parsed = upstreamActorSchema.safeParse({ id, slug });

  return parsed.success ? parsed.data : undefined;
};

// The `patronage-access` mu-plugin names the WordPress user it signed in, and
// WordPress reports errors as `{ code }` and paging as `X-WP-*` headers.
export const inspectWordPressResponse = (
  response: Response,
  json: JsonValue
): UpstreamResponseInfo => ({
  actor: wordpressActor(response.headers),
  errorCode: wordPressErrorCode(json),
  totalItems: numericHeader(response.headers, "X-WP-Total"),
  totalPages: numericHeader(response.headers, "X-WP-TotalPages"),
});

type VerifiedAccessResult = Extract<AccessResult, { ok: true }>;

export const createWordPressClient = (
  env: WordPressEnv,
  access: VerifiedAccessResult
): UpstreamClient => {
  const apiUrl = env.WORDPRESS_API_URL?.trim();

  if (!apiUrl) {
    throw new UpstreamRequestError("WORDPRESS_API_URL is not configured");
  }

  assertSafeApiUrl(apiUrl);

  const auth: UpstreamAuth = { kind: "access-jwt", token: access.token };
  const proofSecret = env.WORDPRESS_ACCESS_PROOF_SECRET?.trim();

  if (proofSecret) {
    auth.proofSecret = proofSecret;
  }

  const clientId = env.WORDPRESS_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.WORDPRESS_ACCESS_CLIENT_SECRET?.trim();

  if (clientId && clientSecret) {
    auth.serviceToken = { clientId, clientSecret };
  }

  return {
    apiUrl,
    auth,
    connector: "wp",
    inspect: inspectWordPressResponse,
    label: "WordPress",
  };
};

// The REST entry point: every path a caller supplies is resolved through
// `resolveWpUrl`, so nothing but a site-relative `/wp-json/` path reaches the
// network here.
export const wpFetch = async (
  client: UpstreamClient,
  path: string,
  telemetry: UpstreamTelemetry,
  init: RequestInit = {}
): Promise<UpstreamFetchResult> =>
  await upstreamFetch(
    client,
    resolveWpUrl(client.apiUrl, path),
    telemetry,
    init
  );

// WPGraphQL answers at the site root, not under `/wp-json/`, so it is a
// separate fixed URL rather than a path a caller can influence.
export const graphqlUrl = (apiUrl: string): URL =>
  new URL("/graphql", assertSafeApiUrl(apiUrl));

export const wpGraphql = async (
  client: UpstreamClient,
  query: string,
  variables: JsonObject | undefined,
  telemetry: UpstreamTelemetry
): Promise<JsonValue> => {
  const body = variables ? { query, variables } : { query };

  const result = await upstreamFetch(
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
    throw new UpstreamRequestError(
      wordPressErrorMessage(result.status, result.errorCode) ??
        "WPGraphQL request failed"
    );
  }

  // A GraphQL error travels in the 200 body as `{data, errors}`; the model
  // reads it and rewrites the query, so it is returned rather than thrown.
  return result.json;
};
