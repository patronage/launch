/**
 * Build and deploy a Worker with the cf CLI. No Wrangler, no wrangler.jsonc.
 *
 *   pnpm run deploy [--preview] [--dry-run]
 *
 * Production runs `cf deploy --prebuilt`, which creates the Worker on its
 * first run and updates it after that. `--preview` builds with
 * CLOUDFLARE_PREVIEW_BUILD=true and runs `cf previews deploy --prebuilt`,
 * which names the Preview after the current Git branch.
 *
 * The first production deploy needs the Worker's secrets in the environment;
 * later deploys keep the stored values unless every secret is set again.
 * Auth comes from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (Workers
 * Builds provides them) or a `cf auth login` session.
 */
import { run, runWithSecrets, ScriptError } from "./script.ts";
import type { ScriptContext } from "./script.ts";
import { readBuiltWorkerConfig, secretNames } from "./worker-config.ts";

export interface DeployStep {
  preview: boolean;
}

export interface DeployOptions {
  /**
   * Write Build Output to .cloudflare/output. The default is `pnpm run build`
   * with CLOUDFLARE_PREVIEW_BUILD set.
   */
  build?: (ctx: ScriptContext, step: DeployStep) => void;
  /** Checks after the build and before anything is uploaded. */
  beforeDeploy?: (ctx: ScriptContext, step: DeployStep) => void;
  /** Whether the Worker has Previews, so `--preview` is accepted. */
  previews: boolean;
  /**
   * Whether the Worker declares secrets in cloudflare.config.ts, to send from
   * the environment on a production deploy.
   */
  secrets: boolean;
}

const previewBuildEnv = (preview: boolean) => ({
  CLOUDFLARE_PREVIEW_BUILD: preview ? "true" : "false",
});

export const deploy = (ctx: ScriptContext, options: DeployOptions) => {
  const args = new Set(ctx.argv);
  const preview = args.has("--preview");
  const dryRun = args.has("--dry-run");

  // Without this, `--preview` would quietly deploy production.
  if (preview && !options.previews) {
    throw new ScriptError(
      "This Worker has no Previews; --preview is not supported."
    );
  }

  if (options.build) {
    options.build(ctx, { preview });
  } else {
    run(ctx, "pnpm", ["run", "build"], previewBuildEnv(preview));
  }

  options.beforeDeploy?.(ctx, { preview });

  const deployArgs = [
    "exec",
    "cf",
    ...(preview ? ["previews", "deploy"] : ["deploy"]),
    "--prebuilt",
    ...(dryRun ? ["--dry-run"] : []),
  ];

  // Previews use their base secrets. A dry run must never pass secret values
  // to cf, because cf can include them in its diagnostic output.
  if (!options.secrets || preview || dryRun) {
    run(ctx, "pnpm", deployArgs);

    return;
  }

  const config = readBuiltWorkerConfig(ctx.root);
  const names = secretNames(config);
  const missing = names.filter((name) => !ctx.env[name]);

  if (missing.length === names.length) {
    run(ctx, "pnpm", deployArgs);

    return;
  }

  // Send every declared secret or none, so a missing value is caught here.
  if (missing.length > 0) {
    throw new ScriptError(`Missing secret values: ${missing.join(", ")}`);
  }

  runWithSecrets(
    ctx,
    "Deployment",
    "pnpm",
    [...deployArgs, "--secrets-file", "/dev/stdin"],
    JSON.stringify(
      Object.fromEntries(names.map((name) => [name, ctx.env[name]]))
    )
  );

  ctx.log(`Deployed ${config.name}; set ${names.join(", ")}.`);
};
