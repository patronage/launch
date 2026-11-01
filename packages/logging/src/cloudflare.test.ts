import { describe, expect, it } from "vitest";

import {
  apiClient,
  ensureBucket,
  ensureLogpushJob,
  ensureWordPressStream,
  r2Destination,
} from "./cloudflare.ts";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

type Route = (call: Call) => { status?: number; result?: unknown } | undefined;

const fakeApi = (route: Route) => {
  const calls: Call[] = [];

  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/client/v4", "") + url.search,
    };

    if (init?.body !== undefined && init.body !== null) {
      call.body = JSON.parse(String(init.body));
    }

    calls.push(call);
    const answer = route(call) ?? { result: null };
    const status = answer.status ?? 200;

    return Promise.resolve(
      Response.json(
        status < 400
          ? { errors: [], result: answer.result, success: true }
          : {
              errors: [{ code: 10_006, message: "not found" }],
              success: false,
            },
        { status }
      )
    );
  };

  return {
    calls,
    client: apiClient({
      accountId: "acct",
      apiToken: "token",
      fetch: fetchImpl,
      log: () => {},
    }),
  };
};

const credentials = { accessKeyId: "key", secretAccessKey: "secret" };

describe(ensureBucket, () => {
  it("creates the bucket when it is missing", async () => {
    const { calls, client } = fakeApi((call) =>
      call.method === "GET" ? { status: 404 } : { result: {} }
    );

    await expect(ensureBucket(client, "demo-logs")).resolves.toBe("created");
    expect(calls.at(-1)).toStrictEqual({
      body: { name: "demo-logs" },
      method: "POST",
      path: "/accounts/acct/r2/buckets",
    });
  });

  it("leaves an existing bucket alone", async () => {
    const { calls, client } = fakeApi(() => ({
      result: { name: "demo-logs" },
    }));

    await expect(ensureBucket(client, "demo-logs")).resolves.toBe("exists");
    expect(calls).toHaveLength(1);
  });
});

describe(ensureLogpushJob, () => {
  const spec = {
    bucket: "demo-logs",
    credentials,
    dataset: "audit_logs_v2",
    name: "demo-audit-logs-v2",
    prefix: "logpush/audit_logs_v2",
    scope: { account: true } as const,
  };

  it("creates a job with every field, as NDJSON into R2", async () => {
    const { calls, client } = fakeApi((call) => {
      if (call.path.endsWith("/logpush/jobs") && call.method === "GET") {
        return { result: [] };
      }

      if (call.path.endsWith("/fields")) {
        return { result: { ActorEmail: "", When: "" } };
      }

      return { result: {} };
    });

    await expect(ensureLogpushJob(client, spec)).resolves.toBe("created");
    const create = calls.at(-1);
    expect(create?.method).toBe("POST");
    expect(create?.path).toBe("/accounts/acct/logpush/jobs");
    expect(create?.body).toMatchObject({
      dataset: "audit_logs_v2",
      destination_conf: r2Destination(
        "acct",
        "demo-logs",
        spec.prefix,
        credentials
      ),
      enabled: true,
      output_options: {
        field_names: ["ActorEmail", "When"],
        output_type: "ndjson",
      },
    });
  });

  it("skips a job that already exists by name", async () => {
    const { calls, client } = fakeApi(() => ({
      result: [{ id: 1, name: "demo-audit-logs-v2" }],
    }));

    await expect(ensureLogpushJob(client, spec)).resolves.toBe("exists");
    expect(calls).toHaveLength(1);
  });

  it("uses the zone path for zone datasets", async () => {
    const { calls, client } = fakeApi((call) =>
      call.method === "GET" && call.path.endsWith("/jobs")
        ? { result: [] }
        : { result: {} }
    );

    await ensureLogpushJob(client, {
      ...spec,
      dataset: "http_requests",
      scope: { zoneId: "zone1" },
    });

    expect(
      calls.every((call) => call.path.startsWith("/zones/zone1/"))
    ).toBeTruthy();
  });
});

describe(r2Destination, () => {
  it("builds a daily R2 destination with the credentials", () => {
    expect(r2Destination("acct", "b", "/logpush/x/", credentials)).toBe(
      "r2://b/logpush/x/{DATE}?access-key-id=key&account-id=acct&secret-access-key=secret"
    );
  });
});

describe(ensureWordPressStream, () => {
  it("creates the stream, sink and pipeline and returns the endpoint", async () => {
    const { calls, client } = fakeApi((call) => {
      if (call.method === "GET") {
        return { result: [] };
      }

      if (call.path.includes("/streams")) {
        return {
          result: {
            endpoint: "https://abc.ingest.cloudflare.com",
            id: "abc",
            name: "demo_wordpress_stream",
          },
        };
      }

      return { result: {} };
    });

    const stream = await ensureWordPressStream(client, {
      bucket: "demo-logs",
      credentials,
      name: "demo_wordpress",
      path: "events/wordpress",
    });

    expect(stream).toStrictEqual({
      endpoint: "https://abc.ingest.cloudflare.com",
      streamId: "abc",
    });
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.path)).toStrictEqual([
      "/accounts/acct/pipelines/v1/streams",
      "/accounts/acct/pipelines/v1/sinks",
      "/accounts/acct/pipelines/v1/pipelines",
    ]);
    expect(posts[0]?.body).toMatchObject({
      http: { authentication: true, enabled: true },
    });
    expect(posts[2]?.body).toMatchObject({
      sql: "INSERT INTO demo_wordpress_sink SELECT * FROM demo_wordpress_stream",
    });
  });
});

describe("dry run", () => {
  it("sends no writes", async () => {
    const calls: string[] = [];

    const client = apiClient({
      accountId: "acct",
      apiToken: "token",
      dryRun: true,
      fetch: (_input, init) => {
        calls.push(init?.method ?? "GET");

        return Promise.resolve(
          Response.json(
            { errors: [{ code: 1, message: "missing" }], success: false },
            { status: 404 }
          )
        );
      },
      log: () => {},
    });

    await ensureBucket(client, "demo-logs");

    expect(calls).toStrictEqual(["GET"]);
  });
});
