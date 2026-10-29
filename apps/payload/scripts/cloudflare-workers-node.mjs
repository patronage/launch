// Stands in for the `cloudflare:workers` module when Payload's CLI runs in Node
// (migrations, type and import map generation). Bindings come from Miniflare and
// share local state with `vite dev` and `vite preview`.
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  resourcePersistencePath: ".cloudflare/state/v3",
  workers: [
    {
      config: {
        compatibilityDate: "2026-10-29",
        compatibilityFlags: ["nodejs_compat"],
        env: {
          D1: { name: "launch-payload", type: "d1" },
          R2: { name: "launch-payload-media", type: "r2" },
        },
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": { contents: "export default {}", type: "esm" },
          },
        },
        name: "launch-payload",
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
