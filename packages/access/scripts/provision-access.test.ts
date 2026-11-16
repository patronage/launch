// Runs the provisioning script end to end against an in-memory Cloudflare
// Access API: the global fetch is replaced, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the script sends: a token, policy or application body. */
interface SentBody {
  domain?: string;
  name?: string;
}

interface Resource extends SentBody {
  id: string;
}

interface StoredToken {
  client_id: string;
  client_secret?: string;
  expires_at: string;
  id: string;
  name: string;
}

interface Write {
  method: string;
  path: string;
}

const API_PREFIX = "/client/v4/accounts/acct";

const ok = <Result>(result: Result) => Response.json({ result, success: true });

const notFound = (method: string, path: string) =>
  Response.json(
    {
      errors: [{ code: 404, message: `no route ${method} ${path}` }],
      success: false,
    },
    { status: 404 }
  );

const audLine = (text: string) => /^ACCESS_AUD=.*$/mu.exec(text)?.[0];

/** A stateful fake of the Access endpoints the script uses. */
const fakeAccess = () => {
  const tokens: StoredToken[] = [];
  const policies: Resource[] = [];
  const apps: Resource[] = [];
  const writes: Write[] = [];
  let nextId = 1;

  const newId = (prefix: string) => {
    const id = `${prefix}-${nextId}`;
    nextId += 1;

    return id;
  };

  const save = (store: Resource[], id: string, body: SentBody) => {
    const found = store.find((item) => item.id === id);

    if (found) {
      Object.assign(found, body);

      return found;
    }

    const created = { ...body, id: newId("id") };
    store.push(created);

    return created;
  };

  const serviceTokens = (url: URL, method: string, body: SentBody) => {
    if (method === "GET") {
      const name = url.searchParams.get("name");

      // Cloudflare never returns a secret for a token that already exists.
      return ok(
        tokens.flatMap(({ client_secret: _secret, ...token }) =>
          token.name === name ? [token] : []
        )
      );
    }

    const id = newId("tok");

    const token = {
      client_id: `${id}.access`,
      client_secret: `secret-${id}`,
      expires_at: "2027-11-16T00:00:00Z",
      id,
      name: body.name ?? "",
    };

    tokens.push(token);

    return ok(token);
  };

  const answer = (url: URL, method: string, body: SentBody) => {
    const path = url.pathname.replace(API_PREFIX, "");

    if (path === "/access/organizations") {
      return ok({ auth_domain: "demo.cloudflareaccess.com" });
    }

    if (path === "/access/service_tokens") {
      return serviceTokens(url, method, body);
    }

    for (const [prefix, store] of [
      ["/access/policies", policies],
      ["/access/apps", apps],
    ] as const) {
      if (path === prefix && method === "GET") {
        return ok(store);
      }

      if (path.startsWith(prefix) && method !== "GET") {
        const saved = save(store, path.slice(prefix.length + 1), body);

        return ok({ aud: `aud-${saved.id}`, id: saved.id });
      }
    }

    return notFound(method, path);
  };

  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    // SAFETY: the client only ever sends JSON-encoded request bodies.
    const body: SentBody = init?.body ? JSON.parse(String(init.body)) : {};

    if (method !== "GET") {
      writes.push({ method, path: url.pathname.replace(API_PREFIX, "") });
    }

    return Promise.resolve(answer(url, method, body));
  };

  vi.stubGlobal("fetch", fetchImpl);

  return { apps, policies, tokens, writes };
};

const BASE_ARGS = [
  "--name",
  "Demo WordPress",
  "--destination",
  "cms.example.org",
  "--allow-email-domain",
  "example.org",
  "--service-token",
  "demo web worker",
];

describe("provision-access script", () => {
  let printed: string[] = [];
  let warned: string[] = [];
  const originalArgv = process.argv;

  /** Import the script fresh, as `node scripts/provision-access.ts ...args` would run it. */
  const runScript = async (args: string[]) => {
    printed = [];
    warned = [];
    process.argv = ["node", "provision-access.ts", ...args];
    vi.resetModules();

    await import("./provision-access.ts");

    return { output: printed.join("\n"), warnings: warned.join("\n") };
  };

  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      printed.push(line);
    });
    vi.spyOn(console, "warn").mockImplementation((line: string) => {
      warned.push(line);
    });
    vi.useFakeTimers({
      now: new Date("2026-11-16T00:00:00Z"),
      toFake: ["Date"],
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates one service token, both policies and the application", async () => {
    const api = fakeAccess();

    await runScript(BASE_ARGS);

    expect(api.tokens.map((token) => token.name)).toStrictEqual([
      "demo web worker",
    ]);
    expect(api.policies.map((policy) => policy.name).toSorted()).toStrictEqual([
      "Demo WordPress editors",
      "Demo WordPress service tokens",
    ]);
    expect(api.apps).toMatchObject([
      { domain: "cms.example.org", name: "Demo WordPress" },
    ]);
  });

  it("prints the new token's secret and the Worker's Access settings", async () => {
    const api = fakeAccess();

    const { output } = await runScript(BASE_ARGS);

    const [token] = api.tokens;
    expect(output).toContain(`ACCESS_CLIENT_ID=${token?.client_id}`);
    expect(output).toContain(
      `ACCESS_CLIENT_SECRET=${token?.client_secret}  # shown once; save it now`
    );
    expect(output).toContain(
      "ACCESS_TEAM_DOMAIN=https://demo.cloudflareaccess.com"
    );
    expect(output).toContain(`ACCESS_AUD=aud-${api.apps[0]?.id}`);
  });

  it("creates nothing on a second run and keeps the same application", async () => {
    const api = fakeAccess();

    const first = await runScript(BASE_ARGS);
    api.writes.length = 0;
    const second = await runScript(BASE_ARGS);

    expect(api.writes.filter((write) => write.method === "POST")).toStrictEqual(
      []
    );
    expect(
      [api.tokens, api.policies, api.apps].map((store) => store.length)
    ).toStrictEqual([1, 2, 1]);
    expect(audLine(second.output)).toBe(audLine(first.output));
  });

  it("says on a second run that the existing token's secret cannot be shown again", async () => {
    fakeAccess();

    await runScript(BASE_ARGS);
    const second = await runScript(BASE_ARGS);

    expect(second.output).toContain(
      "# token already existed; its secret is not retrievable"
    );
    expect(second.output).not.toContain("ACCESS_CLIENT_SECRET=");
  });

  it("sends no writes on a dry run", async () => {
    const api = fakeAccess();

    const { output } = await runScript([...BASE_ARGS, "--dry-run"]);

    expect(api.writes).toStrictEqual([]);
    expect(output).toContain("[dry run] POST /accounts/acct/access/apps");
  });

  it("warns when an existing service token expires within 30 days", async () => {
    const api = fakeAccess();
    api.tokens.push({
      client_id: "old.access",
      expires_at: "2026-11-26T00:00:00Z",
      id: "tok-old",
      name: "demo web worker",
    });

    const { output, warnings } = await runScript(BASE_ARGS);

    expect(output).toContain("# expires 2026-11-26T00:00:00Z");
    expect(warnings).toContain(
      'service token "demo web worker" expires in 10 days'
    );
  });

  it("warns that an existing service token has expired", async () => {
    const api = fakeAccess();
    api.tokens.push({
      client_id: "old.access",
      expires_at: "2026-11-01T00:00:00Z",
      id: "tok-old",
      name: "demo web worker",
    });

    const { warnings } = await runScript(BASE_ARGS);

    expect(warnings).toContain('service token "demo web worker" has expired');
  });

  it("refuses to run without Cloudflare credentials", async () => {
    const api = fakeAccess();
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");

    await expect(runScript(BASE_ARGS)).rejects.toThrow(
      "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."
    );
    expect(api.writes).toStrictEqual([]);
  });

  it("refuses to run without a destination", async () => {
    const api = fakeAccess();

    await expect(
      runScript(["--name", "Demo WordPress", "--service-token", "w"])
    ).rejects.toThrow("Pass --name and at least one --destination.");
    expect(api.writes).toStrictEqual([]);
  });
});
