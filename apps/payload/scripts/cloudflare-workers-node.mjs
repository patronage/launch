// Stands in for the `cloudflare:workers` module when Payload's CLI runs in Node
// (migrations, seeding, type and import map generation). Bindings come from
// Miniflare and share local state with `vite dev` and `vite preview`.
import { Miniflare } from "miniflare";

import cloudflareConfig from "../cloudflare.config.ts";

// Miniflare keys local D1 state by database id, so the CLI takes the D1 and R2
// bindings from cloudflare.config.ts to read and write the same files as the
// preview. D1 is false when PAYLOAD_DB=postgres. The config is a function of
// the build; the CLI runs locally, never as a Preview.
const { worker } = await cloudflareConfig({ isPreview: false });
const { D1, R2 } = worker.env;
const bindings = { R2 };

if (D1) {
  bindings.D1 = D1;
}

// PAYLOAD_LOCAL_STATE moves the local state elsewhere, for tests that need a
// throwaway D1 (scripts/d1-to-postgres-e2e.test.mjs). The demo's locales
// (src/demo-locales.ts) keep theirs apart too, where vite.config.ts puts it.
const defaultState = process.env.PAYLOAD_DEMO_LOCALES
  ? ".demo-locales/state/v3"
  : ".cloudflare/state/v3";

const mf = new Miniflare({
  resourcePersistencePath: process.env.PAYLOAD_LOCAL_STATE ?? defaultState,
  workers: [
    {
      config: {
        compatibilityDate: worker.compatibilityDate,
        compatibilityFlags: worker.compatibilityFlags,
        env: bindings,
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": { contents: "export default {}", type: "esm" },
          },
        },
        name: worker.name,
      },
      dev: { rootPath: process.cwd() },
    },
  ],
});

export const env = {
  ...(await mf.getBindings()),
  // Outside workerd the Postgres adapter connects directly.
  HYPERDRIVE: { connectionString: process.env.POSTGRES_URL },
  PAYLOAD_SECRET: process.env.PAYLOAD_SECRET,
};
