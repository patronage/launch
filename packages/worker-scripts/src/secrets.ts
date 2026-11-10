/**
 * Set a Worker's secrets from the environment, without deploying.
 *
 *   pnpm run secrets [--preview-base] [--dry-run]
 *
 * Sends the values of the secrets cloudflare.config.ts declares that are set
 * in the environment, through stdin: no values in files, command arguments or
 * logs. `--preview-base` sets them in the Worker's Previews Base instead,
 * which every Preview reads.
 */
import { z } from "zod";

import { cloudflareApi, credentials } from "./cloudflare-api.ts";
import { run, runWithSecrets, ScriptError } from "./script.ts";
import type { ScriptContext } from "./script.ts";
import { readBuiltWorkerConfig, secretNames } from "./worker-config.ts";

export const setSecrets = async (ctx: ScriptContext) => {
  const args = new Set(ctx.argv);

  run(ctx, "pnpm", ["run", "build"]);

  const worker = readBuiltWorkerConfig(ctx.root);

  const secrets = Object.fromEntries(
    secretNames(worker).flatMap((name) => {
      const text = ctx.env[name];

      return text ? [[name, { text, type: "secret_text" }]] : [];
    })
  );

  const names = Object.keys(secrets);

  if (names.length === 0) {
    throw new ScriptError("No secret values found in the environment.");
  }

  if (args.has("--dry-run")) {
    ctx.log(`Would set: ${names.join(", ")}`);

    return;
  }

  if (args.has("--preview-base")) {
    // The same merge-patch endpoint Cloudflare's Preview base secret CLI
    // uses. Bindings left out are kept.
    await cloudflareApi(
      ctx,
      credentials(ctx),
      {
        action: "Preview base secret upload",
        body: { previews_base_config: { env: secrets } },
        contentType: "application/merge-patch+json",
        method: "PATCH",
        path: `/workers/workers/${encodeURIComponent(worker.name)}`,
      },
      z.unknown()
    );

    ctx.log(`Set in Previews Base: ${names.join(", ")}`);

    return;
  }

  runWithSecrets(
    ctx,
    "Secret upload",
    "pnpm",
    [
      "exec",
      "cf",
      "workers",
      "secrets",
      "bulk",
      "--worker",
      worker.name,
      "--secrets",
      "@/dev/stdin",
    ],
    JSON.stringify(secrets)
  );

  ctx.log(`Set: ${names.join(", ")}`);
};
