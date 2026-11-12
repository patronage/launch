// Provision a site's log store through the Cloudflare API, by name.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   pnpm --filter @patronage/logging logging:provision \
//     --name demo \
//     [--script <worker name>]... [--no-account-logs] \
//     [--zone <zone id>] \
//     [--wordpress] \
//     [--dry-run]
//
// It creates, only where missing:
//   - the R2 bucket `<name>-logs`;
//   - account Logpush jobs for workers_trace_events, audit_logs_v2 and
//     access_requests, each writing NDJSON under logpush/<dataset>/;
//   - with --script (repeatable), the workers_trace_events job keeps only
//     those Workers, for an account that other sites share;
//   - with --no-account-logs, no audit_logs_v2 or access_requests jobs, so a
//     site on a shared account does not collect the whole account's logs;
//   - with --zone, zone Logpush jobs for http_requests and firewall_events;
//   - with --wordpress, a Basin Pipelines stream, sink and pipeline that write
//     WordPress events under events/wordpress/, plus a send-only token.
//
// A job a plan does not allow is reported and skipped; the rest still run.
// Each Worker turns its own Logpush on at deploy: set WORKER_LOGPUSH=true in
// its build environment (cloudflare.config.ts reads it).
//
// R2 credentials: set LOGS_R2_ACCESS_KEY_ID and LOGS_R2_SECRET_ACCESS_KEY to
// reuse a pair, or leave them unset and, when a job or sink has to be created,
// the script creates one bucket-scoped token and prints the pair once so you
// can store it. A run that finds everything in place creates no token.
//
// The API token needs: Account Settings Read, Logs Edit (account, and zone for
// --zone), Workers R2 Storage Edit,
// Pipelines Edit (for --wordpress), and API Tokens Edit (unless both the R2
// pair and, for --wordpress, a send token are supplied).
import { parseArgs } from "node:util";

import {
  apiClient,
  scriptFilter,
  createBucketWriteCredentials,
  createPipelinesSendToken,
  ensureBucket,
  ensureLogpushJob,
  ensureWordPressStream,
} from "../src/cloudflare.ts";
import type {
  LogpushJobSpec,
  S3Credentials,
  S3CredentialsSource,
} from "../src/cloudflare.ts";

const { values } = parseArgs({
  options: {
    bucket: { type: "string" },
    "dry-run": { type: "boolean" },
    name: { type: "string" },
    "no-account-logs": { type: "boolean" },
    script: { multiple: true, type: "string" },
    wordpress: { type: "boolean" },
    zone: { multiple: true, type: "string" },
  },
});

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!(apiToken && accountId)) {
  throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
}

if (!values.name || !/^[a-z0-9-]+$/u.test(values.name)) {
  throw new Error("Pass --name: lowercase letters, digits and hyphens.");
}

const { name } = values;
const bucket = values.bucket ?? `${name}-logs`;

const client = apiClient({
  accountId,
  apiToken,
  dryRun: values["dry-run"] ?? false,
});

const failures: string[] = [];

const attempt = async (label: string, step: () => Promise<string>) => {
  try {
    console.log(`${label}: ${await step()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    console.error(`${label}: skipped (${message})`);
  }
};

console.log(`R2 bucket ${bucket}: ${await ensureBucket(client, bucket)}`);

// A bucket write token is minted only when a job or sink is actually created,
// and at most once a run: a run that finds everything in place leaves the
// account's tokens alone. It is printed as soon as it exists, because its
// secret is never shown again.
let minted: Promise<S3Credentials> | undefined;

const mintCredentials = async (): Promise<S3Credentials> => {
  const pair = await createBucketWriteCredentials(
    client,
    `${name} logs writer`,
    bucket
  );

  console.log(
    [
      "Created a bucket write token. Store this pair and pass it next time as",
      "LOGS_R2_ACCESS_KEY_ID and LOGS_R2_SECRET_ACCESS_KEY:",
      `  LOGS_R2_ACCESS_KEY_ID=${pair.accessKeyId}`,
      `  LOGS_R2_SECRET_ACCESS_KEY=${pair.secretAccessKey}`,
    ].join("\n")
  );

  return pair;
};

const credentials: S3CredentialsSource =
  process.env.LOGS_R2_ACCESS_KEY_ID && process.env.LOGS_R2_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.LOGS_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.LOGS_R2_SECRET_ACCESS_KEY,
      }
    : () => {
        minted ??= mintCredentials();

        return minted;
      };

const accountDatasets = values["no-account-logs"]
  ? ["workers_trace_events"]
  : ["workers_trace_events", "audit_logs_v2", "access_requests"];

const scripts = values.script ?? [];

const jobs: LogpushJobSpec[] = accountDatasets.map((dataset) => {
  const job: LogpushJobSpec = {
    bucket,
    credentials,
    dataset,
    name: `${name}-${dataset.replaceAll("_", "-")}`,
    prefix: `logpush/${dataset}`,
    scope: { account: true },
  };

  if (dataset === "workers_trace_events" && scripts.length > 0) {
    job.filter = scriptFilter(scripts);
  }

  return job;
});

for (const zoneId of values.zone ?? []) {
  for (const dataset of ["http_requests", "firewall_events"]) {
    jobs.push({
      bucket,
      credentials,
      dataset,
      name: `${name}-${dataset.replaceAll("_", "-")}`,
      prefix: `logpush/${dataset}/zone=${zoneId}`,
      scope: { zoneId },
    });
  }
}

for (const job of jobs) {
  // oxlint-disable-next-line no-await-in-loop -- one job at a time, in order, so a refusal is easy to read.
  await attempt(`Logpush ${job.name}`, () => ensureLogpushJob(client, job));
}

if (values.wordpress) {
  await attempt("Basin stream for WordPress", async () => {
    const stream = await ensureWordPressStream(client, {
      bucket,
      credentials,
      name: `${name.replaceAll("-", "_")}_wordpress`,
      path: "events/wordpress",
    });

    const sendToken =
      process.env.LOGS_PIPELINES_SEND_TOKEN ??
      (await createPipelinesSendToken(client, `${name} WordPress log sender`));

    console.log(
      [
        "Set these in the WordPress install's wp-config (see",
        "wordpress-shared/patronage-logging/README.md):",
        `  PATRONAGE_LOGGING_ENDPOINT=${stream.endpoint ?? `<HTTP endpoint of stream ${stream.streamId}>`}`,
        `  PATRONAGE_LOGGING_TOKEN=${process.env.LOGS_PIPELINES_SEND_TOKEN ? "<the token you passed>" : sendToken}`,
      ].join("\n")
    );

    return "ready";
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} step(s) skipped:`);

  for (const failure of failures) {
    console.error(`  ${failure}`);
  }

  process.exitCode = 1;
}
