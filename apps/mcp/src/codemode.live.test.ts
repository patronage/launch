import { describe, expect, it } from "vitest";
import { z } from "zod";

import { preflightOperations } from "./apply";
import { buildSiteDescription } from "./describe";
import type { WriteOperation } from "./operations";
import { createWordPressTelemetry, wpGraphql } from "./wordpress";
import type { WordPressClient } from "./wordpress";

// The one check that talks to a real WordPress site. It runs as an Access
// user: get the assertion with `cloudflared access login https://<mcp-host>`,
// then run it from the repository root as
//
//   WORDPRESS_LIVE_ACCESS_JWT="$(cloudflared access token -app=https://<mcp-host>)" \
//   WORDPRESS_API_URL="https://<wordpress-origin>" \
//   WORDPRESS_LIVE_REST_BASE=pages WORDPRESS_LIVE_POST_ID=<post-id> \
//   pnpm --dir worker exec vitest run src/codemode.live.test.ts
//
// Without WORDPRESS_LIVE_ACCESS_JWT and WORDPRESS_API_URL the suite skips
// rather than fails, so `pnpm test` stays green with no site in reach; the two
// target variables are optional and only the preflight check needs them.
//
// It reads and never writes. The preflight check proves that itself by
// asserting that every upstream request it made was a GET. It also imports
// nothing but the pure and transport modules — never `runtime.ts` or
// `worker.ts` — so node vitest never has to load `cloudflare:workers`.
const liveConfigSchema = z.object({
  WORDPRESS_ACCESS_PROOF_SECRET: z.string().min(1).optional(),
  WORDPRESS_API_URL: z.url(),
  WORDPRESS_LIVE_ACCESS_JWT: z.string().min(1),
  WORDPRESS_LIVE_POST_ID: z.coerce.number().int().positive().optional(),
  WORDPRESS_LIVE_REST_BASE: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9_-]+$/u)
    .optional(),
});

type LiveConfig = z.infer<typeof liveConfigSchema>;

// Requested by the preflight and never sent: `preflightOperations` reads the
// post and renders this as the "after" side of the preview.
const PROBE_TITLE = "unchanged-live-preflight-probe";
const MODIFIED_GMT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u;

// The gateway proof is optional and `exactOptionalPropertyTypes` forbids
// spelling it as `proofSecret: undefined`, so the two auth shapes are built
// apart, exactly as `createWordPressClient` builds them in the Worker.
const liveWordPressClient = (config: LiveConfig): WordPressClient => {
  const proofSecret = config.WORDPRESS_ACCESS_PROOF_SECRET;

  return {
    apiUrl: config.WORDPRESS_API_URL,
    auth: proofSecret
      ? {
          kind: "access-jwt",
          proofSecret,
          token: config.WORDPRESS_LIVE_ACCESS_JWT,
        }
      : { kind: "access-jwt", token: config.WORDPRESS_LIVE_ACCESS_JWT },
  };
};

const liveConfig = liveConfigSchema.safeParse(process.env);

const liveClient = liveConfig.success
  ? liveWordPressClient(liveConfig.data)
  : undefined;

const liveTarget =
  liveConfig.success &&
  liveConfig.data.WORDPRESS_LIVE_POST_ID !== undefined &&
  liveConfig.data.WORDPRESS_LIVE_REST_BASE !== undefined
    ? {
        id: liveConfig.data.WORDPRESS_LIVE_POST_ID,
        restBase: liveConfig.data.WORDPRESS_LIVE_REST_BASE,
      }
    : undefined;

// `skipIf` still runs the suite factory, so nothing below may assume the
// environment is present; the skip is what guarantees a test body only ever
// reads a value that exists. The message names the missing variables and never
// their values: the Access assertion must not reach a test report.
const configured = <T>(value: T | undefined, variables: string): T => {
  if (value === undefined) {
    throw new Error(`The live suite ran without ${variables}`);
  }

  return value;
};

describe.skipIf(!liveClient)("code mode against a live WordPress site", () => {
  it("describes the site with post types and content types", async () => {
    const description = await buildSiteDescription(
      configured(liveClient, "WORDPRESS_LIVE_ACCESS_JWT and WORDPRESS_API_URL"),
      createWordPressTelemetry()
    );

    expect(description.site.name.length).toBeGreaterThan(0);
    expect(description.postTypes.length).toBeGreaterThan(0);
    // WPGraphQL is a prerequisite and a failing schema query throws, so an
    // empty content model here is a real finding, not a tolerated one.
    expect(description.contentTypes.length).toBeGreaterThan(0);
  }, 30_000);

  it("answers an authenticated WPGraphQL query", async () => {
    const response = await wpGraphql(
      configured(liveClient, "WORDPRESS_LIVE_ACCESS_JWT and WORDPRESS_API_URL"),
      "{ generalSettings { title } }",
      undefined,
      createWordPressTelemetry()
    );

    expect(response).toMatchObject({
      data: { generalSettings: { title: expect.any(String) } },
    });
  }, 30_000);

  it.skipIf(!liveTarget)(
    "preflights a real post without writing to it",
    async () => {
      const target = configured(
        liveTarget,
        "WORDPRESS_LIVE_REST_BASE and WORDPRESS_LIVE_POST_ID"
      );

      const operation: WriteOperation = {
        fields: { title: PROBE_TITLE },
        id: target.id,
        kind: "update_post",
        rest_base: target.restBase,
      };

      const telemetry = createWordPressTelemetry();

      const preflight = await preflightOperations(
        configured(
          liveClient,
          "WORDPRESS_LIVE_ACCESS_JWT and WORDPRESS_API_URL"
        ),
        "Live preflight smoke test",
        [operation],
        telemetry
      );

      expect(preflight.operations[0]?.modifiedGmt).toMatch(MODIFIED_GMT);
      expect(preflight.operations[0]?.fields[0]?.path).toBe("title");
      // The suite's own no-write proof: one read of the post, nothing else.
      expect(telemetry.requests.map((request) => request.method)).toStrictEqual(
        ["GET"]
      );
    },
    30_000
  );
});
