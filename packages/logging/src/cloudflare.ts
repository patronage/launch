/**
 * Provision a site's log store through the Cloudflare API, idempotently by
 * name: one R2 bucket, Logpush jobs that write Cloudflare's own logs into it,
 * and a Basin Pipelines stream that takes WordPress events over HTTP and
 * writes them to the same bucket. Nothing here runs unless someone runs the
 * provisioning script, so a site without logging has none of it.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface ApiClientOptions {
  accountId: string;
  apiToken: string;
  /** Log writes instead of sending them. Reads still go to the API. */
  dryRun?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export type Method = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/** A JSON request body. */
export type Json =
  | boolean
  | number
  | string
  | null
  | Json[]
  | { [key: string]: Json };

export interface RequestBody {
  [key: string]: Json;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly codes: number[];

  constructor(message: string, status: number, codes: number[]) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = codes;
  }
}

export interface ApiClient {
  accountId: string;
  dryRun: boolean;
  log: (line: string) => void;
  /** `path` is relative to `/accounts/{id}` unless it starts with `/zones/`. */
  request: <T>(
    method: Method,
    path: string,
    schema: z.ZodType<T>,
    body?: RequestBody
  ) => Promise<T>;
}

const envelopeSchema = z.object({
  errors: z
    .array(z.object({ code: z.number(), message: z.string() }))
    .catch([]),
  result: z.unknown().optional(),
  success: z.boolean(),
});

/** What a dry-run write pretends the API returned, by resource. */
const dryRunResult = (path: string) => {
  if (path.endsWith("/tokens")) {
    return { id: "dry-run-token", value: "dry-run" };
  }

  if (path.includes("/pipelines/")) {
    return {
      endpoint: "https://dry-run.ingest.cloudflare.com",
      id: "dry-run",
      name: "dry-run",
    };
  }

  return { id: 0, name: "dry-run" };
};

export const apiClient = (options: ApiClientOptions): ApiClient => {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const dryRun = options.dryRun ?? false;
  const accountPath = `/accounts/${encodeURIComponent(options.accountId)}`;

  return {
    accountId: options.accountId,
    dryRun,
    log,
    request: async (method, path, schema, body) => {
      const fullPath = path.startsWith("/zones/") ? path : accountPath + path;

      if (dryRun && method !== "GET") {
        log(`[dry run] ${method} ${fullPath}`);

        return schema.parse(dryRunResult(path));
      }

      const response = await fetchImpl(API_BASE + fullPath, {
        body: body === undefined ? null : JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          "Content-Type": "application/json",
        },
        method,
      });

      const parsed = envelopeSchema.safeParse(
        await response.json().catch(() => null)
      );

      if (!(parsed.success && parsed.data.success)) {
        const errors = parsed.success ? parsed.data.errors : [];

        const detail =
          errors.map((error) => `${error.code} ${error.message}`).join("; ") ||
          `HTTP ${response.status}`;

        throw new CloudflareApiError(
          `${method} ${fullPath} failed: ${detail}`,
          response.status,
          errors.map((error) => error.code)
        );
      }

      return schema.parse(parsed.data.result ?? null);
    },
  };
};

// R2

const bucketSchema = z.object({ name: z.string() }).loose();

export const ensureBucket = async (
  client: ApiClient,
  name: string
): Promise<"created" | "exists"> => {
  try {
    await client.request(
      "GET",
      `/r2/buckets/${encodeURIComponent(name)}`,
      bucketSchema
    );

    return "exists";
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) {
      throw error;
    }
  }

  await client.request("POST", "/r2/buckets", z.unknown(), { name });
  client.log(`Created R2 bucket ${name}`);

  return "created";
};

// API tokens

const permissionGroupSchema = z.array(
  z.object({ id: z.string(), name: z.string() }).loose()
);

const createdTokenSchema = z.object({ id: z.string(), value: z.string() });

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const findPermissionGroup = async (
  client: ApiClient,
  pattern: RegExp
): Promise<string> => {
  const groups = await client.request(
    "GET",
    "/tokens/permission_groups",
    permissionGroupSchema
  );

  const match = groups.find((group) => pattern.test(group.name));

  if (!match) {
    throw new Error(`No API token permission group matches ${pattern}.`);
  }

  return match.id;
};

/**
 * Create an account-owned token that can write objects to one bucket, and
 * derive its S3 credentials: the token id is the access key id and the
 * SHA-256 of its value is the secret. Logpush and the Basin sink use these.
 */
export const createBucketWriteCredentials = async (
  client: ApiClient,
  name: string,
  bucket: string
): Promise<S3Credentials> => {
  const groupId = await findPermissionGroup(
    client,
    /^Workers R2 Storage Bucket Item Write$/u
  );

  const token = await client.request("POST", "/tokens", createdTokenSchema, {
    name,
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: groupId }],
        resources: {
          [`com.cloudflare.edge.r2.bucket.${client.accountId}_default_${bucket}`]:
            "*",
        },
      },
    ],
  });

  return {
    accessKeyId: token.id,
    secretAccessKey: createHash("sha256").update(token.value).digest("hex"),
  };
};

/**
 * Create an account-owned token that can only send to Basin Pipelines
 * streams. A server that holds it can add events but never read or delete
 * what it already sent.
 */
export const createPipelinesSendToken = async (
  client: ApiClient,
  name: string
): Promise<string> => {
  const groupId = await findPermissionGroup(client, /pipelines.*send/iu);

  const token = await client.request("POST", "/tokens", createdTokenSchema, {
    name,
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: groupId }],
        resources: { [`com.cloudflare.api.account.${client.accountId}`]: "*" },
      },
    ],
  });

  return token.value;
};

// Logpush

export type LogpushScope = { account: true } | { zoneId: string };

export interface LogpushJobSpec {
  name: string;
  dataset: string;
  scope: LogpushScope;
  bucket: string;
  /** Folder in the bucket; `{DATE}` is appended for daily folders. */
  prefix: string;
  credentials: S3Credentials;
  /** A Logpush filter, as JSON text, such as the one `scriptFilter` builds. */
  filter?: string;
}

/** A Logpush filter that keeps only the named Workers' trace events. */
export const scriptFilter = (scripts: readonly string[]): string =>
  JSON.stringify({
    where: { key: "ScriptName", operator: "in", value: [...scripts] },
  });

const jobSchema = z
  .object({
    dataset: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    id: z.number(),
    name: z.string().nullable().optional(),
  })
  .loose();

const fieldsSchema = z.record(z.string(), z.unknown());

const scopePath = (scope: LogpushScope): string =>
  "zoneId" in scope ? `/zones/${encodeURIComponent(scope.zoneId)}` : "";

export const r2Destination = (
  accountId: string,
  bucket: string,
  prefix: string,
  credentials: S3Credentials
): string => {
  const query = new URLSearchParams({
    "access-key-id": credentials.accessKeyId,
    "account-id": accountId,
    "secret-access-key": credentials.secretAccessKey,
  });

  const folder = prefix.replaceAll(/^\/+|\/+$/gu, "");

  return `r2://${bucket}/${folder}/{DATE}?${query.toString()}`;
};

export const listLogpushJobs = (client: ApiClient, scope: LogpushScope) =>
  client.request("GET", `${scopePath(scope)}/logpush/jobs`, z.array(jobSchema));

/**
 * Create a Logpush job unless one with the same name exists. It sends every
 * field the dataset has, as NDJSON with RFC 3339 timestamps.
 */
export const ensureLogpushJob = async (
  client: ApiClient,
  spec: LogpushJobSpec
): Promise<"created" | "exists"> => {
  const base = scopePath(spec.scope);
  const jobs = await listLogpushJobs(client, spec.scope);

  if (jobs.some((job) => job.name === spec.name)) {
    return "exists";
  }

  const fields = await client.request(
    "GET",
    `${base}/logpush/datasets/${encodeURIComponent(spec.dataset)}/fields`,
    fieldsSchema
  );

  const body: RequestBody = {
    dataset: spec.dataset,
    destination_conf: r2Destination(
      client.accountId,
      spec.bucket,
      spec.prefix,
      spec.credentials
    ),
    enabled: true,
    name: spec.name,
    output_options: {
      field_names: Object.keys(fields).toSorted(),
      output_type: "ndjson",
      timestamp_format: "rfc3339",
    },
  };

  if (spec.filter !== undefined) {
    body.filter = spec.filter;
  }

  await client.request("POST", `${base}/logpush/jobs`, z.unknown(), body);
  client.log(`Created Logpush job ${spec.name} (${spec.dataset})`);

  return "created";
};

// Basin Pipelines

const namedSchema = z
  .object({
    endpoint: z.string().optional(),
    http_endpoint: z.string().optional(),
    id: z.string(),
    name: z.string(),
  })
  .loose();

const findByName = async (
  client: ApiClient,
  kind: "pipelines" | "sinks" | "streams",
  name: string
) => {
  const items = await client.request(
    "GET",
    `/pipelines/v1/${kind}?per_page=100`,
    z.array(namedSchema)
  );

  return items.find((item) => item.name === name);
};

export interface WordPressStreamSpec {
  /** Base name; the stream, sink and pipeline get `_stream`, `_sink`, `_pipeline`. */
  name: string;
  bucket: string;
  /** Folder in the bucket, such as `events/wordpress`. */
  path: string;
  credentials: S3Credentials;
}

export interface WordPressStream {
  streamId: string;
  /** The HTTP ingest URL the WordPress plugin posts to, when the API returned it. */
  endpoint?: string;
}

/**
 * A stream that accepts authenticated HTTP posts of free-form JSON, a sink
 * that writes gzipped JSON files to the bucket, and the pipeline joining them.
 */
export const ensureWordPressStream = async (
  client: ApiClient,
  spec: WordPressStreamSpec
): Promise<WordPressStream> => {
  const streamName = `${spec.name}_stream`;
  const sinkName = `${spec.name}_sink`;
  const pipelineName = `${spec.name}_pipeline`;

  let stream = await findByName(client, "streams", streamName);

  if (!stream) {
    stream = await client.request(
      "POST",
      "/pipelines/v1/streams",
      namedSchema,
      {
        format: { type: "json", unstructured: true },
        http: { authentication: true, enabled: true },
        name: streamName,
        worker_binding: { enabled: false },
      }
    );
    client.log(`Created Basin stream ${streamName}`);
  }

  if (!(await findByName(client, "sinks", sinkName))) {
    await client.request("POST", "/pipelines/v1/sinks", z.unknown(), {
      config: {
        account_id: client.accountId,
        bucket: spec.bucket,
        credentials: {
          access_key_id: spec.credentials.accessKeyId,
          secret_access_key: spec.credentials.secretAccessKey,
        },
        partitioning: { time_pattern: "year=%Y/month=%m/day=%d" },
        path: spec.path.replaceAll(/^\/+|\/+$/gu, ""),
        rolling_policy: { interval_seconds: 300 },
      },
      format: { compression: "gzip", type: "json" },
      name: sinkName,
      type: "r2",
    });
    client.log(`Created Basin sink ${sinkName}`);
  }

  if (!(await findByName(client, "pipelines", pipelineName))) {
    await client.request("POST", "/pipelines/v1/pipelines", z.unknown(), {
      name: pipelineName,
      sql: `INSERT INTO ${sinkName} SELECT * FROM ${streamName}`,
    });
    client.log(`Created Basin pipeline ${pipelineName}`);
  }

  const endpoint = stream.endpoint ?? stream.http_endpoint;

  return endpoint ? { endpoint, streamId: stream.id } : { streamId: stream.id };
};
