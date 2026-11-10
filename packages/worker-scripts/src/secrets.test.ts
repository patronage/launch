import { describe, expect, it } from "vitest";

import { ScriptError } from "./script.ts";
import { setSecrets } from "./secrets.ts";
import { fakeRepo, jsonResponse, testContext } from "./test-context.ts";

const worker = {
  env: { API_KEY: { type: "secret" }, TOKEN: { type: "secret" } },
  name: "site",
};

const credentials = {
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_API_TOKEN: "api-token",
};

describe(setSecrets, () => {
  it("sends the set values to cf workers secrets bulk through stdin", async () => {
    const ctx = testContext({
      env: { API_KEY: "key-value" },
      root: fakeRepo(worker),
    });

    await setSecrets(ctx);

    const [, upload] = ctx.spawnCalls;
    expect(upload?.args).toStrictEqual([
      "exec",
      "cf",
      "workers",
      "secrets",
      "bulk",
      "--worker",
      "site",
      "--secrets",
      "@/dev/stdin",
    ]);
    expect(JSON.parse(upload?.input ?? "")).toStrictEqual({
      API_KEY: { text: "key-value", type: "secret_text" },
    });
    expect(ctx.logs).toStrictEqual(["Set: API_KEY"]);
  });

  it("fails when no values are set", async () => {
    const ctx = testContext({ root: fakeRepo(worker) });

    await expect(setSecrets(ctx)).rejects.toThrow(
      "No secret values found in the environment."
    );
  });

  it("names the secrets on a dry run and sends nothing", async () => {
    const ctx = testContext({
      argv: ["--dry-run", "--preview-base"],
      env: { ...credentials, TOKEN: "token-value" },
      root: fakeRepo(worker),
    });

    await setSecrets(ctx);

    expect(ctx.logs).toStrictEqual(["Would set: TOKEN"]);
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.fetchCalls).toHaveLength(0);
  });

  it("merge-patches the Previews Base", async () => {
    const ctx = testContext({
      argv: ["--preview-base"],
      env: { ...credentials, TOKEN: "token-value" },
      responses: [() => jsonResponse({ result: {}, success: true })],
      root: fakeRepo(worker),
    });

    await setSecrets(ctx);

    expect(ctx.fetchCalls).toStrictEqual([
      {
        body: JSON.stringify({
          previews_base_config: {
            env: { TOKEN: { text: "token-value", type: "secret_text" } },
          },
        }),
        headers: {
          authorization: "Bearer api-token",
          "content-type": "application/merge-patch+json",
        },
        method: "PATCH",
        url: "https://api.cloudflare.com/client/v4/accounts/account/workers/workers/site",
      },
    ]);
    expect(ctx.logs).toStrictEqual(["Set in Previews Base: TOKEN"]);
  });

  it("needs Cloudflare credentials for the Previews Base", async () => {
    const ctx = testContext({
      argv: ["--preview-base"],
      env: { TOKEN: "token-value" },
      root: fakeRepo(worker),
    });

    await expect(setSecrets(ctx)).rejects.toThrow(
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
    );
  });

  it.each([
    [
      "an HTTP error",
      () =>
        jsonResponse(
          {
            errors: [{ code: 10_000, message: "token-value" }],
            success: false,
          },
          403
        ),
      "Preview base secret upload failed (HTTP 403, Cloudflare error 10000).",
    ],
    [
      "success: false with HTTP 200",
      () => jsonResponse({ errors: [], success: false }),
      "Preview base secret upload failed (HTTP 200).",
    ],
    [
      "a body that is not JSON",
      () => new Response("<html>token-value</html>", { status: 502 }),
      "Preview base secret upload failed (HTTP 502).",
    ],
    [
      "a network failure",
      () => {
        throw new Error("token-value");
      },
      "Preview base secret upload failed: the Cloudflare API was unreachable.",
    ],
  ])("reports %s without the response body", async (_, response, message) => {
    const ctx = testContext({
      argv: ["--preview-base"],
      env: { ...credentials, TOKEN: "token-value" },
      responses: [response],
      root: fakeRepo(worker),
    });

    await expect(setSecrets(ctx)).rejects.toThrow(new ScriptError(message));
    expect(ctx.logs).toStrictEqual([]);
  });
});
