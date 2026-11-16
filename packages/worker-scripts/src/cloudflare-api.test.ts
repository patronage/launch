import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cloudflareApi, credentials } from "./cloudflare-api.ts";
import { ScriptError } from "./script.ts";
import { jsonResponse, testContext } from "./test-context.ts";

const creds = { accountId: "acct/1", apiToken: "api-token" };

const workersSchema = z.array(z.object({ id: z.string() }));

describe(credentials, () => {
  it("reads the account id and API token from the environment", () => {
    const ctx = testContext({
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" },
    });

    expect(credentials(ctx)).toStrictEqual({
      accountId: "acct",
      apiToken: "token",
    });
  });

  it("fails with a ScriptError when either value is missing", () => {
    const ctx = testContext({ env: { CLOUDFLARE_ACCOUNT_ID: "acct" } });

    expect(() => credentials(ctx)).toThrow(ScriptError);
    expect(() => credentials(ctx)).toThrow(
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
    );
  });
});

describe(cloudflareApi, () => {
  it("sends an account-scoped GET with the token and returns the parsed result", async () => {
    const ctx = testContext({
      responses: [
        () => jsonResponse({ result: [{ id: "site" }], success: true }),
      ],
    });

    await expect(
      cloudflareApi(
        ctx,
        creds,
        { action: "Listing Workers", path: "/workers/scripts" },
        workersSchema
      )
    ).resolves.toStrictEqual([{ id: "site" }]);

    expect(ctx.fetchCalls).toStrictEqual([
      {
        body: undefined,
        headers: { authorization: "Bearer api-token" },
        method: "GET",
        url: "https://api.cloudflare.com/client/v4/accounts/acct%2F1/workers/scripts",
      },
    ]);
  });

  it("sends a body as JSON with the given method and content type", async () => {
    const ctx = testContext({
      responses: [() => jsonResponse({ result: null, success: true })],
    });

    await cloudflareApi(
      ctx,
      creds,
      {
        action: "Updating settings",
        body: { logpush: true },
        contentType: "application/merge-patch+json",
        method: "PATCH",
        path: "/workers/scripts/site/settings",
      },
      z.null()
    );

    expect(ctx.fetchCalls[0]).toMatchObject({
      body: '{"logpush":true}',
      headers: {
        authorization: "Bearer api-token",
        "content-type": "application/merge-patch+json",
      },
      method: "PATCH",
    });
  });

  it("reports the HTTP status and Cloudflare error codes but never the response body", async () => {
    const ctx = testContext({
      responses: [
        () =>
          jsonResponse(
            {
              errors: [{ code: 10_000, message: "echoed secret-value" }],
              success: false,
            },
            403
          ),
      ],
    });

    const call = cloudflareApi(
      ctx,
      creds,
      { action: "Listing Workers", path: "/workers/scripts" },
      workersSchema
    );

    await expect(call).rejects.toThrow(
      new ScriptError(
        "Listing Workers failed (HTTP 403, Cloudflare error 10000)."
      )
    );
    await expect(call).rejects.not.toThrow(/secret-value/u);
  });

  it("fails when an HTTP 200 response says success is false", async () => {
    const ctx = testContext({
      responses: [() => jsonResponse({ errors: [], success: false })],
    });

    await expect(
      cloudflareApi(
        ctx,
        creds,
        { action: "Listing Workers", path: "/workers/scripts" },
        workersSchema
      )
    ).rejects.toThrow("Listing Workers failed (HTTP 200).");
  });

  it("fails with the status alone when the response is not JSON", async () => {
    const ctx = testContext({
      responses: [
        () => new Response("<html>bad gateway</html>", { status: 502 }),
      ],
    });

    await expect(
      cloudflareApi(
        ctx,
        creds,
        { action: "Listing Workers", path: "/workers/scripts" },
        workersSchema
      )
    ).rejects.toThrow("Listing Workers failed (HTTP 502).");
  });

  it("fails when the API cannot be reached", async () => {
    const ctx = testContext({
      responses: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });

    await expect(
      cloudflareApi(
        ctx,
        creds,
        { action: "Listing Workers", path: "/workers/scripts" },
        workersSchema
      )
    ).rejects.toThrow(
      "Listing Workers failed: the Cloudflare API was unreachable."
    );
  });

  it("fails when a successful result does not match the schema", async () => {
    const ctx = testContext({
      responses: [() => jsonResponse({ result: { id: 1 }, success: true })],
    });

    await expect(
      cloudflareApi(
        ctx,
        creds,
        { action: "Listing Workers", path: "/workers/scripts" },
        workersSchema
      )
    ).rejects.toThrow("Listing Workers returned an unexpected result.");
  });
});
