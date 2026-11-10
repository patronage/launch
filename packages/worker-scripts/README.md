# @launch/worker-scripts

The deploy, secrets and Workers Builds steps every Launch Worker shares. Each app keeps a thin `scripts/deploy.mjs`, `scripts/secrets.mjs` and `scripts/workers-builds.mjs` that passes only what differs, such as its build variables or whether it has Previews. Run them through the app's `pnpm run deploy`, `pnpm run secrets` and `pnpm run builds:configure`.

| Module | What it does |
| --- | --- |
| `deploy` | Builds, then `cf deploy --prebuilt` (or `cf previews deploy --prebuilt` with `--preview`). On a production deploy it sends the Worker's declared secrets from the environment through stdin, all or none. A Worker without Previews refuses `--preview` rather than deploying production. |
| `secrets` | Sets the declared secrets that are in the environment with `cf workers secrets bulk`, or in the Previews Base with `--preview-base`. |
| `workers-builds` | Creates the Workers Builds configuration with `cf builds workers create`, after checking the Worker exists and, where an app asks, that its Previews Base has every secret. |
| `worker-config` | Reads the Worker's name and declared secrets from the Build Output `vite build` writes, so nothing repeats `cloudflare.config.ts`. |
| `script` | The context the scripts run on (arguments, environment, commands, `fetch`), and `main`, which prints a failure in one line and exits with its code. |

Secret values only ever go to a command's stdin or a Cloudflare API body. When either fails, the error names the step, the exit status or HTTP status and Cloudflare's error codes, never the output or response body, which can echo the values. Every Cloudflare API call checks both the HTTP status and the response's `success` flag.

The scripts take their environment, commands and `fetch` as a parameter, so `pnpm --filter @launch/worker-scripts test` runs them with no shell, network or Cloudflare account.
