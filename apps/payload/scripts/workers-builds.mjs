#!/usr/bin/env node
// Connect this Worker to Workers Builds through the Cloudflare API, so pushes
// to the repo build and deploy it with no GitHub Actions.
//
//   pnpm run builds:configure [--dry-run]
//
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, plus:
//   BUILD_TOKEN_UUID      from `cf builds tokens list`
//   GITHUB_OWNER_ID       numeric id of the GitHub org that owns the repo
//   GITHUB_REPO_ID        numeric id of the repo
// and optionally PAYLOAD_DB, HYPERDRIVE_ID and WORKER_DOMAIN,
// which become build variables.
// The Cloudflare GitHub app must already be installed on the repo (a one-time
// dashboard step). The Worker must exist, so run `pnpm run deploy` once first.
//
// Production builds run on PRODUCTION_BRANCH (default main). Every other
// branch gets a Worker Preview named after the branch. A build only starts
// when a file under this app, packages/ or the workspace lockfile changes.
import { readFileSync } from "node:fs";
import path from "node:path";

import { readWorkerConfig, root, run, secretNames } from "./worker-config.mjs";

const dryRun = process.argv.includes("--dry-run");
const previewsEnabled = process.env.WORKER_PREVIEWS === "true";

const required = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "BUILD_TOKEN_UUID",
  "GITHUB_OWNER_ID",
  "GITHUB_REPO_ID",
];

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")}.`);
  process.exit(1);
}

const { env } = process;
const repoRoot = path.resolve(root, "../..");
const appDir = path.relative(repoRoot, root);

const readRepoFile = (file) =>
  readFileSync(path.join(repoRoot, file), "utf-8").trim();

const appName = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf-8")
).name;

const [, pnpmVersion] = JSON.parse(
  readRepoFile("package.json")
).packageManager.split("@");

run("pnpm", ["exec", "vite", "build"]);

const workerConfig = readWorkerConfig();
const workerName = workerConfig.name;

// Enabling branch builds before setting the separate Preview base secrets
// produces Previews that upload successfully but cannot initialize Payload.
if (!dryRun && previewsEnabled) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/workers/${encodeURIComponent(workerName)}`,
    { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
  );

  const body = await response.json();
  const bindings = body.result?.previews_base_config?.env ?? {};

  const missingSecrets = secretNames(workerConfig).filter(
    (name) => bindings[name]?.type !== "secret_text"
  );

  if (!response.ok || body.success !== true || missingSecrets.length > 0) {
    console.error(
      "Set Preview base secrets with pnpm run secrets --preview-base before configuring Builds."
    );
    process.exit(1);
  }
}

const lookupScriptTag = async () => {
  if (dryRun) {
    return "<script-tag>";
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
    { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
  );

  const body = await res.json();
  const script = body.result?.find((item) => item.id === workerName);

  if (!script) {
    console.error(`Worker ${workerName} not found. Run pnpm run deploy first.`);
    process.exit(1);
  }

  return script.tag;
};

// The root directory has no lockfile, so the automatic install is skipped and
// the build step does a frozen install of the whole workspace with the repo's
// own pnpm and Node versions. It then lints the repo and typechecks and tests
// only this app and the packages it depends on: the full `pnpm verify` also
// runs the WordPress installs' PHP checks, and the build image has no PHP.
// Checks run in the build step so a failure stops the deploy. The deploy script does its own vite build, because Preview
// builds need CLOUDFLARE_PREVIEW_BUILD set at build time.
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
  // Database selection and the custom domain are read at build time.
  environment_variables: Object.fromEntries(
    Object.entries({
      NODE_VERSION: readRepoFile(".nvmrc"),
      PNPM_VERSION: pnpmVersion,
      SKIP_DEPENDENCY_INSTALL: "1",
      ...Object.fromEntries(
        [
          "PAYLOAD_DB",
          "HYPERDRIVE_ID",
          "WORKER_DOMAIN",
          "WORKER_LOGPUSH",
          "WORKER_TRACE_SAMPLING",
        ].flatMap((name) => (env[name] ? [[name, env[name]]] : []))
      ),
    }).map(([name, value]) => [name, { is_secret: false, value }])
  ),
  path_includes: [
    `${appDir}/*`,
    "packages/*",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ],
  root_directory: appDir,
};

const body = {
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
  previews_enabled: previewsEnabled,
  production_settings: { ...shared, deploy_command: "pnpm run deploy" },
  script_tag: await lookupScriptTag(),
};

run("pnpm", [
  "exec",
  "cf",
  "builds",
  "workers",
  "create",
  "--body",
  JSON.stringify(body),
  ...(dryRun ? ["--dry-run"] : []),
]);
