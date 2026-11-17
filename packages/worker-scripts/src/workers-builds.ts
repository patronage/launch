/**
 * Connect a Worker to Workers Builds through the Cloudflare API, so pushes to
 * the repo build and deploy it with no GitHub Actions.
 *
 *   pnpm run builds:configure [--dry-run]
 *
 * Every call goes through the cf CLI, so your own `cf auth login` is enough:
 * no API token. Needs CLOUDFLARE_ACCOUNT_ID, plus:
 *   BUILD_TOKEN_UUID      from `cf builds tokens list`
 *   GITHUB_OWNER_ID       numeric id of the GitHub org that owns the repo
 *   GITHUB_REPO_ID        numeric id of the repo
 * and the app's build variables when they are set. The Cloudflare GitHub app
 * must already be installed on the repo (a one-time dashboard step). The
 * Worker must exist, so run `pnpm run deploy` once first.
 *
 * Production builds run on PRODUCTION_BRANCH (default main). With Previews on,
 * every other branch gets a Worker Preview named after the branch. A build
 * only starts when a file under the app, packages/ or the workspace lockfile
 * changes.
 *
 * The build variables are copied onto the Builds trigger when it is created.
 * When an app later reads a new variable at build time, add it to the trigger
 * with `cf builds triggers environment-variables upsert <trigger-uuid>` (find
 * the trigger with `cf builds triggers list --external-script-id <tag>`), or
 * every Builds deploy sets it blank.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { run, runJson, ScriptError } from "./script.ts";
import type { ScriptContext } from "./script.ts";
import { readBuiltWorkerConfig, summarize } from "./worker-config.ts";
import type { WorkerSummary } from "./worker-config.ts";

export const REQUIRED_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "BUILD_TOKEN_UUID",
  "GITHUB_OWNER_ID",
  "GITHUB_REPO_ID",
] as const;

export interface WorkersBuildsOptions {
  /**
   * Settings the app reads at build time. Each one set in the environment is
   * passed on as a build variable, so later builds keep it.
   */
  buildVariables: readonly string[];
  /** Repo paths outside the app and packages/ whose changes start a build. */
  extraWatchPaths?: readonly string[];
  /** Whether branch builds deploy Worker Previews. */
  previews: boolean;
  /**
   * Refuse to turn Previews on until the Previews Base holds every secret the
   * Worker declares. Without them a Preview uploads but cannot start.
   */
  previewsNeedBaseSecrets?: boolean;
  /** Variables Previews cannot build without. Also passed on when set. */
  previewVariables?: readonly string[];
  /** Read the Worker's name and secrets. The default runs `vite build`. */
  resolveWorker?: (ctx: ScriptContext) => Promise<WorkerSummary>;
}

const viteWorker = (ctx: ScriptContext) => {
  run(ctx, "pnpm", ["exec", "vite", "build"]);

  return Promise.resolve(summarize(readBuiltWorkerConfig(ctx.root)));
};

const previewsBaseSchema = z.object({
  previews_base_config: z
    .object({
      env: z
        .record(z.string(), z.object({ type: z.string() }).loose())
        .catch({}),
    })
    .loose()
    .nullish(),
});

const checkPreviewBaseSecrets = (ctx: ScriptContext, worker: WorkerSummary) => {
  const result = runJson(
    ctx,
    "Reading the Worker's Previews Base",
    "pnpm",
    ["exec", "cf", "workers", "get", worker.name],
    previewsBaseSchema
  );

  const bindings = result.previews_base_config?.env ?? {};

  const missing = worker.secretNames.filter(
    (name) => bindings[name]?.type !== "secret_text"
  );

  if (missing.length > 0) {
    throw new ScriptError(
      `Previews Base has no ${missing.join(", ")}. Set them with pnpm run secrets --preview-base before configuring Builds.`
    );
  }
};

const scriptsSchema = z.array(
  z.object({ id: z.string(), script_name: z.string() }).loose()
);

const SEARCH_PAGE_SIZE = 100;

// The Builds API names a Worker by its tag, which `cf workers scripts search`
// returns as `id`. A name search also matches partial names, a page at a time,
// so read pages until the exact name turns up or the results run out.
const lookupScriptTag = (ctx: ScriptContext, workerName: string) => {
  for (let page = 1; ; page += 1) {
    const scripts = runJson(
      ctx,
      "Looking up the Worker",
      "pnpm",
      [
        "exec",
        "cf",
        "workers",
        "scripts",
        "search",
        "--name",
        workerName,
        "--page",
        String(page),
        "--per-page",
        String(SEARCH_PAGE_SIZE),
      ],
      scriptsSchema
    );

    const script = scripts.find((item) => item.script_name === workerName);

    if (script) {
      return script.id;
    }

    if (scripts.length < SEARCH_PAGE_SIZE) {
      throw new ScriptError(
        `Worker ${workerName} not found. Run pnpm run deploy first.`
      );
    }
  }
};

export interface BuildsBodyInput {
  /** The app folder relative to the repo root, such as apps/payload. */
  appDir: string;
  /** The app's package name, for the pnpm filter. */
  appName: string;
  env: Readonly<Record<string, string | undefined>>;
  nodeVersion: string;
  options: WorkersBuildsOptions;
  pnpmVersion: string;
  scriptTag: string;
}

/** The `cf builds workers create` body. Pure, so it can be tested. */
export const buildsBody = ({
  appDir,
  appName,
  env,
  nodeVersion,
  options,
  pnpmVersion,
  scriptTag,
}: BuildsBodyInput) => {
  const passedOn = [
    ...options.buildVariables,
    ...(options.previewVariables ?? []),
  ];

  // The root directory has no lockfile, so the automatic install is skipped
  // and the build step does a frozen install of the whole workspace with the
  // repo's own pnpm and Node versions. It then lints the repo and typechecks
  // and tests only this app and the packages it depends on: the full
  // `pnpm verify` also runs the WordPress installs' PHP checks, and the build
  // image has no PHP. Checks run in the build step so a failure stops the
  // deploy. The deploy command does its own build, because Preview builds
  // need CLOUDFLARE_PREVIEW_BUILD set at build time.
  const shared = {
    build_caching_enabled: true,
    build_command: [
      "pnpm -w run deps:verify",
      "pnpm -w run lint",
      `pnpm --filter "${appName}..." --if-present run typecheck`,
      `pnpm --filter "${appName}..." --if-present run test`,
    ].join(" && "),
    build_token_uuid: env.BUILD_TOKEN_UUID,
    // The API takes each variable as { value, is_secret }, not a bare string.
    environment_variables: Object.fromEntries(
      Object.entries({
        NODE_VERSION: nodeVersion,
        PNPM_VERSION: pnpmVersion,
        SKIP_DEPENDENCY_INSTALL: "1",
        ...Object.fromEntries(
          passedOn.flatMap((name) => {
            const value = env[name];

            return value ? [[name, value]] : [];
          })
        ),
      }).map(([name, value]) => [name, { is_secret: false, value }])
    ),
    path_includes: [
      `${appDir}/*`,
      ...(options.extraWatchPaths ?? []),
      "packages/*",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
    root_directory: appDir,
  };

  return {
    git_repository: {
      branch: env.PRODUCTION_BRANCH ?? "main",
      provider_account_id: env.GITHUB_OWNER_ID,
      provider_account_name: env.GITHUB_OWNER ?? "patronage",
      provider_type: "github",
      repo_id: env.GITHUB_REPO_ID,
      repo_name: env.GITHUB_REPO ?? "launch",
    },
    previews_base_config: {
      ...shared,
      deploy_command: "pnpm run deploy --preview",
    },
    previews_enabled: options.previews,
    production_settings: { ...shared, deploy_command: "pnpm run deploy" },
    script_tag: scriptTag,
  };
};

const appPackageSchema = z.object({ name: z.string() }).loose();

const rootPackageSchema = z
  .object({
    packageManager: z
      .string()
      .startsWith("pnpm@")
      .transform((value) => value.slice("pnpm@".length)),
  })
  .loose();

const readPackage = <T>(file: string, schema: z.ZodType<T>, what: string) => {
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf-8")));

  if (!parsed.success) {
    throw new ScriptError(`Could not read ${what} from ${file}.`);
  }

  return parsed.data;
};

export const configureWorkersBuilds = async (
  ctx: ScriptContext,
  options: WorkersBuildsOptions
) => {
  const dryRun = ctx.argv.includes("--dry-run");

  const missing = [
    ...REQUIRED_ENV,
    ...(options.previews ? (options.previewVariables ?? []) : []),
  ].filter((name) => !ctx.env[name]);

  if (missing.length > 0) {
    throw new ScriptError(`Set ${missing.join(", ")}.`);
  }

  const repoRoot = path.resolve(ctx.root, "../..");

  const { name: appName } = readPackage(
    path.join(ctx.root, "package.json"),
    appPackageSchema,
    "the app's name"
  );

  const { packageManager: pnpmVersion } = readPackage(
    path.join(repoRoot, "package.json"),
    rootPackageSchema,
    "the repo's pnpm version"
  );

  const worker = await (options.resolveWorker ?? viteWorker)(ctx);

  if (!dryRun && options.previews && options.previewsNeedBaseSecrets) {
    checkPreviewBaseSecrets(ctx, worker);
  }

  const body = buildsBody({
    appDir: path.relative(repoRoot, ctx.root),
    appName,
    env: ctx.env,
    nodeVersion: readFileSync(path.join(repoRoot, ".nvmrc"), "utf-8").trim(),
    options,
    pnpmVersion,
    scriptTag: dryRun ? "<script-tag>" : lookupScriptTag(ctx, worker.name),
  });

  run(ctx, "pnpm", [
    "exec",
    "cf",
    "builds",
    "workers",
    "create",
    "--body",
    JSON.stringify(body),
    ...(dryRun ? ["--dry-run"] : []),
  ]);
};
