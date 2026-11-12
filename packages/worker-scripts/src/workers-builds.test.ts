import { describe, expect, it } from "vitest";

import type { SpawnResult } from "./script.ts";
import { fakeRepo, testContext } from "./test-context.ts";
import type { SpawnCall } from "./test-context.ts";
import { configureWorkersBuilds } from "./workers-builds.ts";

const worker = {
  env: { API_KEY: { type: "secret" } },
  name: "site",
};

const required = {
  BUILD_TOKEN_UUID: "build-token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  GITHUB_OWNER_ID: "1",
  GITHUB_REPO_ID: "2",
};

// `cf workers scripts search --name site` also returns partial matches.
const scripts = [
  { id: "other-tag", script_name: "site-old" },
  { id: "site-tag", script_name: "site" },
];

interface CfOutputs {
  /** What `cf workers get` prints. */
  get?: { previews_base_config: { env: Record<string, { type: string }> } };
  /** What `cf workers scripts search` prints, page by page. */
  search?: { id: string; script_name: string }[][];
}

/** Answers each cf read with its JSON output; any other command succeeds. */
const cf =
  (outputs: CfOutputs) =>
  (call: SpawnCall): SpawnResult => {
    if (!call.capture) {
      return { status: 0 };
    }

    const page = Number(call.args[call.args.indexOf("--page") + 1]);

    const output = call.args.includes("search")
      ? outputs.search?.[page - 1]
      : outputs.get;

    return output === undefined
      ? { status: 1 }
      : { status: 0, stdout: JSON.stringify(output) };
  };

/** The body passed to `cf builds workers create`. */
const createBody = (ctx: ReturnType<typeof testContext>) => {
  const create = ctx.spawnCalls.find((call) => call.args.includes("create"));
  const json = create?.args[create.args.indexOf("--body") + 1];

  return JSON.parse(json ?? "{}");
};

describe(configureWorkersBuilds, () => {
  it("lists every missing setting before doing anything", async () => {
    const ctx = testContext({
      env: { CLOUDFLARE_ACCOUNT_ID: "account" },
    });

    await expect(
      configureWorkersBuilds(ctx, { buildVariables: [], previews: false })
    ).rejects.toThrow("Set BUILD_TOKEN_UUID, GITHUB_OWNER_ID, GITHUB_REPO_ID.");
    expect(ctx.spawnCalls).toHaveLength(0);
  });

  it("needs the Preview variables only with Previews on", async () => {
    const ctx = testContext({ env: required });

    await expect(
      configureWorkersBuilds(ctx, {
        buildVariables: [],
        previewVariables: ["PREVIEW_DB"],
        previews: true,
      })
    ).rejects.toThrow("Set PREVIEW_DB.");
  });

  it("creates the configuration with the Worker's tag and the app's variables", async () => {
    const root = fakeRepo(worker);

    const ctx = testContext({
      env: { ...required, UNRELATED: "x", WORKER_DOMAIN: "example.com" },
      root,
      status: cf({ search: [scripts] }),
    });

    await configureWorkersBuilds(ctx, {
      buildVariables: ["WORKER_DOMAIN", "WORKER_NAME"],
      extraWatchPaths: ["docs/*"],
      previews: true,
    });

    expect(ctx.spawnCalls[0]?.args).toStrictEqual(["exec", "vite", "build"]);
    expect(createBody(ctx)).toMatchObject({
      git_repository: {
        branch: "main",
        provider_account_id: "1",
        provider_account_name: "patronage",
        provider_type: "github",
        repo_id: "2",
        repo_name: "launch",
      },
      previews_base_config: { deploy_command: "pnpm run deploy --preview" },
      previews_enabled: true,
      production_settings: {
        build_command: expect.stringContaining(
          'pnpm --filter "@launch/site..." --if-present run test'
        ),
        deploy_command: "pnpm run deploy",
        environment_variables: {
          NODE_VERSION: { is_secret: false, value: "24" },
          PNPM_VERSION: { is_secret: false, value: "12.16.1" },
          SKIP_DEPENDENCY_INSTALL: { is_secret: false, value: "1" },
          WORKER_DOMAIN: { is_secret: false, value: "example.com" },
        },
        path_includes: [
          "apps/site/*",
          "docs/*",
          "packages/*",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
        ],
        root_directory: "apps/site",
      },
      script_tag: "site-tag",
    });
    // Only the variables the app names are passed on.
    expect(
      Object.keys(createBody(ctx).production_settings.environment_variables)
    ).not.toContain("UNRELATED");
  });

  it("stops when the Worker cannot be looked up", async () => {
    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({}),
    });

    await expect(
      configureWorkersBuilds(ctx, { buildVariables: [], previews: false })
    ).rejects.toThrow("Looking up the Worker failed (exit 1).");
    expect(ctx.spawnCalls).toHaveLength(2);
  });

  it("uses the cf login, not an API token", async () => {
    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({ search: [scripts] }),
    });

    await configureWorkersBuilds(ctx, { buildVariables: [], previews: false });

    expect(ctx.fetchCalls).toHaveLength(0);
    expect(ctx.spawnCalls.find((call) => call.capture)?.args).toStrictEqual([
      "exec",
      "cf",
      "workers",
      "scripts",
      "search",
      "--name",
      "site",
      "--page",
      "1",
      "--per-page",
      "100",
    ]);
  });

  it("reads later pages until it finds the exact name", async () => {
    const partial = Array.from({ length: 100 }, (_, index) => ({
      id: `tag-${index}`,
      script_name: `site-${index}`,
    }));

    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({ search: [partial, scripts] }),
    });

    await configureWorkersBuilds(ctx, { buildVariables: [], previews: false });

    expect(createBody(ctx).script_tag).toBe("site-tag");
  });

  it("asks for a first deploy when the Worker does not exist", async () => {
    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({ search: [[{ id: "other-tag", script_name: "site-old" }]] }),
    });

    await expect(
      configureWorkersBuilds(ctx, { buildVariables: [], previews: false })
    ).rejects.toThrow("Worker site not found. Run pnpm run deploy first.");
  });

  it("refuses Previews until the Previews Base has every secret", async () => {
    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({ get: { previews_base_config: { env: {} } } }),
    });

    await expect(
      configureWorkersBuilds(ctx, {
        buildVariables: [],
        previews: true,
        previewsNeedBaseSecrets: true,
      })
    ).rejects.toThrow("Previews Base has no API_KEY.");
  });

  it("turns Previews on once the Previews Base has the secrets", async () => {
    const ctx = testContext({
      env: required,
      root: fakeRepo(worker),
      status: cf({
        get: {
          previews_base_config: { env: { API_KEY: { type: "secret_text" } } },
        },
        search: [scripts],
      }),
    });

    await configureWorkersBuilds(ctx, {
      buildVariables: [],
      previews: true,
      previewsNeedBaseSecrets: true,
    });

    expect(createBody(ctx).previews_enabled).toBeTruthy();
  });

  it("makes no Cloudflare reads on a dry run", async () => {
    const ctx = testContext({
      argv: ["--dry-run"],
      env: required,
      root: fakeRepo(worker),
    });

    await configureWorkersBuilds(ctx, {
      buildVariables: [],
      previews: true,
      previewsNeedBaseSecrets: true,
      resolveWorker: () => Promise.resolve({ name: "site", secretNames: [] }),
    });

    expect(ctx.fetchCalls).toHaveLength(0);
    expect(ctx.spawnCalls.map((call) => call.args.at(-1))).toStrictEqual([
      "--dry-run",
    ]);
    expect(createBody(ctx).script_tag).toBe("<script-tag>");
  });
});
