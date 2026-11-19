import { withRequestLog } from "@patronage/logging";
import { describe, expect, it, vi } from "vitest";

import { createWordPressFetch } from "./transport.ts";

const ORIGIN = "https://cms.example.org";

const recorder = (
  response: () => Response = () => Response.json({ data: {} })
) =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    () => Promise.resolve(response())
  );

describe(createWordPressFetch, () => {
  it("sends public reads without Access headers when no token is set", async () => {
    const fetch = recorder();

    const wordpressFetch = createWordPressFetch({
      fetch,
      origin: `${ORIGIN}/`,
    });

    await wordpressFetch(`${ORIGIN}/graphql`, { method: "POST" });

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);

    expect(headers.has("CF-Access-Client-Id")).toBeFalsy();
  });

  it("adds the service token and refuses to follow redirects", async () => {
    const fetch = recorder();

    const wordpressFetch = createWordPressFetch({
      accessClientId: "id",
      accessClientSecret: "secret",
      fetch,
      origin: ORIGIN,
    });

    await wordpressFetch(`${ORIGIN}/graphql`, {
      headers: { "CF-Access-Client-Id": "from-the-request" },
      method: "POST",
    });

    const init = fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);

    expect(headers.get("CF-Access-Client-Id")).toBe("id");
    expect(headers.get("CF-Access-Client-Secret")).toBe("secret");
    expect(init?.redirect).toBe("manual");
  });

  it("refuses another origin", async () => {
    const fetch = recorder();
    const wordpressFetch = createWordPressFetch({ fetch, origin: ORIGIN });

    await expect(
      wordpressFetch("https://elsewhere.example/graphql")
    ).rejects.toThrow("another origin");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on half a service token", async () => {
    const wordpressFetch = createWordPressFetch({
      accessClientId: "id",
      fetch: recorder(),
      origin: ORIGIN,
    });

    await expect(wordpressFetch(`${ORIGIN}/graphql`)).rejects.toThrow(
      "incomplete"
    );
  });

  it("turns an Access login redirect into an error", async () => {
    const wordpressFetch = createWordPressFetch({
      accessClientId: "id",
      accessClientSecret: "secret",
      fetch: recorder(
        () =>
          new Response(null, {
            headers: {
              location:
                "https://team.cloudflareaccess.com/cdn-cgi/access/login",
            },
            status: 302,
          })
      ),
      origin: ORIGIN,
    });

    await expect(wordpressFetch(`${ORIGIN}/graphql`)).rejects.toThrow(
      "Access refused"
    );
  });

  it("needs the proof secret for a preview read", async () => {
    const wordpressFetch = createWordPressFetch({
      accessClientId: "id",
      accessClientSecret: "secret",
      fetch: recorder(),
      origin: ORIGIN,
    });

    await expect(
      wordpressFetch(`${ORIGIN}/graphql`, {}, "jwt")
    ).rejects.toThrow("proof secret");
  });

  it("counts reads, and 5xx answers as errors, on the wide event", async () => {
    const lines: unknown[] = [];

    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(...args);
      });
    }

    const wordpressFetch = createWordPressFetch({
      fetch: recorder(() => new Response("down", { status: 503 })),
      origin: ORIGIN,
    });

    const entry = withRequestLog(
      {
        fetch: async () => {
          await wordpressFetch(`${ORIGIN}/graphql`);
          await wordpressFetch(`${ORIGIN}/graphql`);

          return new Response("ok");
        },
      },
      { service: "test" }
    );

    await entry.fetch(
      new Request("https://www.example.org/about"),
      {},
      {
        waitUntil: () => {},
      }
    );
    vi.restoreAllMocks();

    const event = lines.find(
      (line): line is { upstream: { wordpress?: unknown } } =>
        typeof line === "object" && line !== null && "upstream" in line
    );

    expect(event?.upstream?.wordpress).toMatchObject({ calls: 2, errors: 2 });
  });
});
