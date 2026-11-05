/**
 * Minimal Cloudflare API client for Zero Trust Access: applications, reusable
 * policies and service tokens. Wrangler has no Access commands, so the repo
 * provisions Access through the API, idempotently by name.
 */
import { z } from "zod";

const API_BASE = "https://api.cloudflare.com/client/v4";

export type PolicyRule =
  | { email: { email: string } }
  | { email_domain: { domain: string } }
  | { service_token: { token_id: string } };

export interface PolicyBody {
  name: string;
  /** `allow` for people who log in; `non_identity` for service tokens. */
  decision: "allow" | "non_identity";
  include: PolicyRule[];
  exclude: PolicyRule[];
  require: PolicyRule[];
}

export interface ApplicationBody {
  name: string;
  type: "self_hosted";
  domain: string;
  destinations: { type: "public"; uri: string }[];
  policies: { id: string; precedence: number }[];
  session_duration: string;
  app_launcher_visible: boolean;
}

export interface ServiceTokenBody {
  name: string;
  duration: string;
}

export type RequestBody = PolicyBody | ApplicationBody | ServiceTokenBody;

export interface CloudflareClientOptions {
  accountId: string;
  apiToken: string;
  /** Log writes instead of sending them. Reads still go to the API. */
  dryRun?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface CloudflareClient {
  request: <T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    schema: z.ZodType<T>,
    body?: RequestBody
  ) => Promise<T>;
  /** Every item of a paginated list endpoint, page by page. */
  list: <T>(path: string, schema: z.ZodType<T>) => Promise<T[]>;
}

/** Items asked for per page of a list endpoint. */
export const LIST_PAGE_SIZE = 50;

const envelopeSchema = z.object({
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .catch([]),
  result: z.unknown().optional(),
  result_info: z
    .object({
      page: z.number(),
      per_page: z.number(),
      total_count: z.number(),
      total_pages: z.number(),
    })
    .partial()
    .optional()
    .catch(undefined),
  success: z.boolean(),
});

/**
 * Whether a list has pages after `page`, by `total_pages`, else
 * `total_count`, else a full page. Without result_info the list is whole.
 */
const hasMorePages = (
  info: z.infer<typeof envelopeSchema>["result_info"],
  page: number,
  seen: number,
  pageItems: readonly unknown[]
): boolean => {
  if (!info || pageItems.length === 0) {
    return false;
  }

  if (info.total_pages !== undefined) {
    return page < info.total_pages;
  }

  if (info.total_count !== undefined) {
    return seen < info.total_count;
  }

  return pageItems.length >= (info.per_page ?? LIST_PAGE_SIZE);
};

/** What a dry-run write pretends the API returned. */
const DRY_RUN_RESULT = {
  aud: "dry-run-aud",
  client_id: "dry-run",
  id: "dry-run",
};

export const cloudflareClient = (
  options: CloudflareClientOptions
): CloudflareClient => {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const accountPath = `/accounts/${encodeURIComponent(options.accountId)}`;

  const send = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: RequestBody
  ) => {
    const response = await fetchImpl(`${API_BASE}${accountPath}${path}`, {
      body: body ? JSON.stringify(body) : null,
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "application/json",
      },
      method,
    });

    const envelope = envelopeSchema.parse(await response.json());

    if (!(response.ok && envelope.success)) {
      const detail = envelope.errors
        .map((error) => `${error.code} ${error.message}`)
        .join("; ");

      throw new Error(
        `Cloudflare API ${method} ${path} failed: ${detail || response.status}`
      );
    }

    return envelope;
  };

  const request: CloudflareClient["request"] = async (
    method,
    path,
    schema,
    body
  ) => {
    if (options.dryRun && method !== "GET") {
      log(`[dry run] ${method} ${accountPath}${path} ${JSON.stringify(body)}`);

      return schema.parse(DRY_RUN_RESULT);
    }

    const envelope = await send(method, path, body);

    return schema.parse(envelope.result);
  };

  // Lists page until result_info says there are no more pages. A response
  // without result_info is the whole list.
  const list: CloudflareClient["list"] = async (path, schema) => {
    const items = [];
    const separator = path.includes("?") ? "&" : "?";

    for (let page = 1; ; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page needs the previous one's result_info.
      const envelope = await send(
        "GET",
        `${path}${separator}page=${page}&per_page=${LIST_PAGE_SIZE}`
      );

      const pageItems = z.array(schema).parse(envelope.result);

      items.push(...pageItems);

      if (!hasMorePages(envelope.result_info, page, items.length, pageItems)) {
        return items;
      }
    }
  };

  return { list, request };
};

const organizationSchema = z.object({ auth_domain: z.string() });
const namedSchema = z.object({ id: z.string(), name: z.string() });
const idSchema = z.object({ id: z.string() });
const applicationSchema = z.object({ aud: z.string(), id: z.string() });

const serviceTokenSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  id: z.string(),
  name: z.string().optional(),
});

/** Team domain (`https://<team>.cloudflareaccess.com`), the JWT issuer. */
export const teamDomain = async (client: CloudflareClient): Promise<string> => {
  const organization = await client.request(
    "GET",
    "/access/organizations",
    organizationSchema
  );

  return `https://${organization.auth_domain}`;
};

export interface ServiceTokenResult {
  id: string;
  name: string;
  clientId: string;
  /** Only present when the token was created by this call; Cloudflare never returns it again. */
  clientSecret?: string;
}

/** Find a service token by name, or create it. */
export const ensureServiceToken = async (
  client: CloudflareClient,
  name: string,
  duration = "8760h"
): Promise<ServiceTokenResult> => {
  const existing = await client.request(
    "GET",
    `/access/service_tokens?name=${encodeURIComponent(name)}`,
    z.array(serviceTokenSchema)
  );

  const found = existing.find((token) => token.name === name);

  if (found) {
    return { clientId: found.client_id, id: found.id, name };
  }

  const created = await client.request(
    "POST",
    "/access/service_tokens",
    serviceTokenSchema,
    { duration, name }
  );

  const result: ServiceTokenResult = {
    clientId: created.client_id,
    id: created.id,
    name,
  };

  if (created.client_secret) {
    result.clientSecret = created.client_secret;
  }

  return result;
};

export interface PolicySpec {
  name: string;
  decision: PolicyBody["decision"];
  include: PolicyRule[];
}

/** Create or update a reusable Access policy, matched by name. */
export const ensurePolicy = async (
  client: CloudflareClient,
  spec: PolicySpec
): Promise<string> => {
  const policies = await client.list("/access/policies", namedSchema);

  const found = policies.find((policy) => policy.name === spec.name);
  const body: PolicyBody = { ...spec, exclude: [], require: [] };

  const saved = found
    ? await client.request(
        "PUT",
        `/access/policies/${found.id}`,
        idSchema,
        body
      )
    : await client.request("POST", "/access/policies", idSchema, body);

  return saved.id;
};

export interface ApplicationSpec {
  name: string;
  /** Hostnames with optional paths, e.g. `cms.example.org` or `cms.example.org/admin`. */
  destinations: string[];
  sessionDuration?: string;
}

export const applicationBody = (
  spec: ApplicationSpec,
  policyIds: string[]
): ApplicationBody => {
  const [primary] = spec.destinations;

  if (!primary) {
    throw new Error(
      `Access application "${spec.name}" needs at least one destination.`
    );
  }

  return {
    app_launcher_visible: false,
    destinations: spec.destinations.map((uri) => ({ type: "public", uri })),
    domain: primary,
    name: spec.name,
    policies: policyIds.map((id, index) => ({ id, precedence: index + 1 })),
    session_duration: spec.sessionDuration ?? "24h",
    type: "self_hosted",
  };
};

/** Create or update a self-hosted Access application, matched by name. Returns its AUD tag. */
export const ensureApplication = async (
  client: CloudflareClient,
  spec: ApplicationSpec,
  policyIds: string[]
): Promise<{ id: string; aud: string }> => {
  const apps = await client.list("/access/apps", namedSchema);

  const found = apps.find((app) => app.name === spec.name);
  const body = applicationBody(spec, policyIds);

  return found
    ? client.request("PUT", `/access/apps/${found.id}`, applicationSchema, body)
    : client.request("POST", "/access/apps", applicationSchema, body);
};

export interface LockdownSpec extends ApplicationSpec {
  /** People allowed to sign in, by exact email. */
  allowEmails?: string[];
  /** People allowed to sign in, by email domain. */
  allowEmailDomains?: string[];
  /** Service tokens allowed through without a login (one per calling Worker). */
  serviceTokens?: string[];
}

export interface LockdownResult {
  teamDomain: string;
  aud: string;
  applicationId: string;
  serviceTokens: ServiceTokenResult[];
}

/**
 * Lock a CMS behind Access: one application over the given destinations, an
 * `allow` policy for editors and a `non_identity` policy for service tokens.
 */
export const provisionLockdown = async (
  client: CloudflareClient,
  spec: LockdownSpec
): Promise<LockdownResult> => {
  const serviceTokens = await Promise.all(
    (spec.serviceTokens ?? []).map((name) => ensureServiceToken(client, name))
  );

  const people: PolicyRule[] = [
    ...(spec.allowEmails ?? []).map((email) => ({ email: { email } })),
    ...(spec.allowEmailDomains ?? []).map((domain) => ({
      email_domain: { domain },
    })),
  ];

  const policies: PolicySpec[] = [];

  if (people.length > 0) {
    policies.push({
      decision: "allow",
      include: people,
      name: `${spec.name} editors`,
    });
  }

  if (serviceTokens.length > 0) {
    policies.push({
      decision: "non_identity",
      include: serviceTokens.map((token) => ({
        service_token: { token_id: token.id },
      })),
      name: `${spec.name} service tokens`,
    });
  }

  if (policies.length === 0) {
    throw new Error(
      "A lockdown needs at least one allowed email, email domain or service token."
    );
  }

  const policyIds = await Promise.all(
    policies.map((policy) => ensurePolicy(client, policy))
  );

  const app = await ensureApplication(client, spec, policyIds);

  return {
    applicationId: app.id,
    aud: app.aud,
    serviceTokens,
    teamDomain: await teamDomain(client),
  };
};
