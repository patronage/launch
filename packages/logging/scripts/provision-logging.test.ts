// Runs the provisioning script end to end against an in-memory Cloudflare
// API: the global fetch is replaced, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The fields of a request body the fake reads or the tests check. */
interface SentBody {
  dataset?: string;
  destination_conf?: string;
  filter?: string;
  name?: string;
}

interface Job extends SentBody {
  id: number;
}

interface Named {
  endpoint?: string;
  id: string;
  name: string;
}

type BasinKind = "pipelines" | "sinks" | "streams";

interface Write {
  method: string;
  path: string;
}

interface FakeOptions {
  /** Logpush datasets the account's plan refuses. */
  refuse?: string[];
}

const API_PREFIX = "/client/v4";
const ACCOUNT = "/accounts/acct";

const ok = <Result>(result: Result) =>
  Response.json({ errors: [], result, success: true });

const fail = (status: number, code: number, message: string) =>
  Response.json({ errors: [{ code, message }], success: false }, { status });

const isBasinKind = (kind: string | undefined): kind is BasinKind =>
  kind === "pipelines" || kind === "sinks" || kind === "streams";

/** A stateful fake of the R2, token, Logpush and Pipelines endpoints. */
const fakeCloudflare = ({ refuse = [] }: FakeOptions = {}) => {
  const buckets = new Set<string>();
  const jobs = new Map<string, Job[]>();

  const basin = new Map<BasinKind, Named[]>([
    ["pipelines", []],
    ["sinks", []],
    ["streams", []],
  ]);

  const tokens: string[] = [];
  const writes: Write[] = [];

  let nextId = 1;

  const newId = () => {
    const id = nextId;
    nextId += 1;

    return id;
  };

  const r2AndTokens = (method: string, path: string, body: SentBody) => {
    if (method === "GET" && path.startsWith(`${ACCOUNT}/r2/buckets/`)) {
      const name = decodeURIComponent(path.split("/").at(-1) ?? "");

      return buckets.has(name)
        ? ok({ name })
        : fail(404, 10_006, "bucket not found");
    }

    if (method === "POST" && path === `${ACCOUNT}/r2/buckets`) {
      buckets.add(body.name ?? "");

      return ok({});
    }

    if (path === `${ACCOUNT}/tokens/permission_groups`) {
      return ok([
        { id: "pg-r2", name: "Workers R2 Storage Bucket Item Write" },
        { id: "pg-send", name: "Pipelines Send" },
      ]);
    }

    if (method === "POST" && path === `${ACCOUNT}/tokens`) {
      tokens.push(body.name ?? "");
      const id = `token-${newId()}`;

      return ok({ id, value: `value-${id}` });
    }

    return null;
  };

  const logpush = (method: string, path: string, body: SentBody) => {
    const match = /^(?<scope>.*)\/logpush\/(?<rest>.*)$/u.exec(path)?.groups;

    if (!match) {
      return null;
    }

    const { rest = "", scope = "" } = match;
    const list = jobs.get(scope) ?? [];
    jobs.set(scope, list);

    if (rest.endsWith("/fields")) {
      return ok({ EventTimestampMs: "int", Outcome: "string" });
    }

    if (method === "GET") {
      return ok(list);
    }

    if (refuse.includes(body.dataset ?? "")) {
      return fail(403, 1004, "dataset not allowed on this plan");
    }

    list.push({ ...body, id: newId() });

    return ok({});
  };

  const pipelines = (method: string, path: string, body: SentBody) => {
    const kind = /^\/accounts\/acct\/pipelines\/v1\/(?<kind>\w+)$/u.exec(path)
      ?.groups?.kind;

    if (!isBasinKind(kind)) {
      return null;
    }

    const items = basin.get(kind) ?? [];

    if (method === "GET") {
      return ok(items);
    }

    const item: Named = { id: `${kind}-${newId()}`, name: body.name ?? "" };

    if (kind === "streams") {
      item.endpoint = "https://stream.ingest.example.com";
    }

    items.push(item);

    return ok(item);
  };

  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.replace(API_PREFIX, "");

    // SAFETY: the client only ever sends JSON-encoded request bodies.
    const body: SentBody = init?.body ? JSON.parse(String(init.body)) : {};

    if (method !== "GET") {
      writes.push({ method, path });
    }

    return Promise.resolve(
      r2AndTokens(method, path, body) ??
        logpush(method, path, body) ??
        pipelines(method, path, body) ??
        fail(404, 7003, `no route ${method} ${path}`)
    );
  };

  vi.stubGlobal("fetch", fetchImpl);

  const jobNames = () => [...jobs.values()].flat().map((job) => job.name);

  const names = (kind: BasinKind) =>
    (basin.get(kind) ?? []).map((item) => item.name);

  return { buckets, jobNames, jobs, names, tokens, writes };
};

describe("provision-logging script", () => {
  let printed: string[] = [];
  let errors: string[] = [];
  const originalArgv = process.argv;

  /** Import the script fresh, as `node scripts/provision-logging.ts ...args` would run it. */
  const runScript = async (args: string[]) => {
    printed = [];
    errors = [];
    process.exitCode = undefined;
    process.argv = ["node", "provision-logging.ts", ...args];
    vi.resetModules();

    await import("./provision-logging.ts");

    return {
      errors: errors.join("\n"),
      exitCode: process.exitCode,
      output: printed.join("\n"),
    };
  };

  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("LOGS_R2_ACCESS_KEY_ID", "");
    vi.stubEnv("LOGS_R2_SECRET_ACCESS_KEY", "");
    vi.stubEnv("LOGS_PIPELINES_SEND_TOKEN", undefined);
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      printed.push(line);
    });
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates the bucket and the account and zone Logpush jobs", async () => {
    const api = fakeCloudflare();

    const result = await runScript(["--name", "demo", "--zone", "zone-1"]);

    expect([...api.buckets]).toStrictEqual(["demo-logs"]);
    expect(api.jobNames()).toStrictEqual([
      "demo-workers-trace-events",
      "demo-audit-logs-v2",
      "demo-access-requests",
      "demo-http-requests",
      "demo-firewall-events",
    ]);
    expect(api.jobs.get("/zones/zone-1")?.[0]).toMatchObject({
      dataset: "http_requests",
    });
    expect(result.exitCode).toBeUndefined();
  });

  it("mints one bucket write token for all the jobs it creates and prints the pair", async () => {
    const api = fakeCloudflare();

    const result = await runScript(["--name", "demo", "--zone", "zone-1"]);

    expect(api.tokens).toStrictEqual(["demo logs writer"]);
    expect(result.output).toContain("LOGS_R2_ACCESS_KEY_ID=token-");
  });

  it("creates nothing on a second run", async () => {
    const api = fakeCloudflare();
    const args = ["--name", "demo", "--zone", "zone-1", "--wordpress"];
    vi.stubEnv("LOGS_PIPELINES_SEND_TOKEN", "send-token");

    await runScript(args);
    api.writes.length = 0;
    const second = await runScript(args);

    expect(api.writes).toStrictEqual([]);
    expect(second.output).toContain("R2 bucket demo-logs: exists");
    expect(second.output).toContain(
      "Logpush demo-workers-trace-events: exists"
    );
    expect(second.output).not.toContain("Created a bucket write token");
    expect(second.exitCode).toBeUndefined();
  });

  it("creates the WordPress stream, sink and pipeline", async () => {
    const api = fakeCloudflare();

    await runScript(["--name", "demo-site", "--wordpress"]);

    expect(api.names("streams")).toStrictEqual(["demo_site_wordpress_stream"]);
    expect(api.names("sinks")).toStrictEqual(["demo_site_wordpress_sink"]);
    expect(api.names("pipelines")).toStrictEqual([
      "demo_site_wordpress_pipeline",
    ]);
  });

  it("prints the WordPress endpoint and a new send-only token", async () => {
    const api = fakeCloudflare();

    const { output } = await runScript(["--name", "demo-site", "--wordpress"]);

    expect(api.tokens).toStrictEqual([
      "demo-site logs writer",
      "demo-site WordPress log sender",
    ]);
    expect(output).toContain(
      "PATRONAGE_LOGGING_ENDPOINT=https://stream.ingest.example.com"
    );
    expect(output).toMatch(/PATRONAGE_LOGGING_TOKEN=value-token-\d+/u);
  });

  it("uses a supplied R2 key pair instead of minting a token", async () => {
    const api = fakeCloudflare();
    vi.stubEnv("LOGS_R2_ACCESS_KEY_ID", "supplied-key");
    vi.stubEnv("LOGS_R2_SECRET_ACCESS_KEY", "supplied-secret");

    await runScript(["--name", "demo"]);

    expect(api.tokens).toStrictEqual([]);
    expect(api.jobs.get(ACCOUNT)?.[0]?.destination_conf).toContain(
      "access-key-id=supplied-key"
    );
  });

  it("keeps only the named Workers and skips account-wide logs on a shared account", async () => {
    const api = fakeCloudflare();

    await runScript([
      "--name",
      "demo",
      "--no-account-logs",
      "--script",
      "demo-web",
      "--script",
      "demo-cms",
    ]);

    const accountJobs = api.jobs.get(ACCOUNT) ?? [];
    expect(accountJobs.map((job) => job.name)).toStrictEqual([
      "demo-workers-trace-events",
    ]);
    expect(JSON.parse(accountJobs[0]?.filter ?? "null")).toStrictEqual({
      where: {
        key: "ScriptName",
        operator: "in",
        value: ["demo-web", "demo-cms"],
      },
    });
  });

  it("reports a job the plan refuses, still runs the rest and exits with an error", async () => {
    const api = fakeCloudflare({ refuse: ["audit_logs_v2"] });

    const result = await runScript(["--name", "demo"]);

    expect(api.jobNames()).toStrictEqual([
      "demo-workers-trace-events",
      "demo-access-requests",
    ]);
    expect(result.errors).toContain("Logpush demo-audit-logs-v2: skipped");
    expect(result.errors).toContain("1 step(s) skipped:");
    expect(result.exitCode).toBe(1);
  });

  it("sends no writes on a dry run", async () => {
    const api = fakeCloudflare();

    await runScript(["--name", "demo", "--wordpress", "--dry-run"]);

    expect(api.writes).toStrictEqual([]);
  });

  it("refuses a name that is not lowercase letters, digits and hyphens", async () => {
    const api = fakeCloudflare();

    await expect(runScript(["--name", "Demo Site"])).rejects.toThrow(
      "Pass --name: lowercase letters, digits and hyphens."
    );
    expect(api.writes).toStrictEqual([]);
  });
});
