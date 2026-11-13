import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    // Lets the bundler drop the database adapter that src/db.ts does not use.
    "process.env.PAYLOAD_DB": JSON.stringify(process.env.PAYLOAD_DB ?? "d1"),
    // The demo's locales, for local trials only (src/demo-locales.ts).
    "process.env.PAYLOAD_DEMO_LOCALES": JSON.stringify(
      process.env.PAYLOAD_DEMO_LOCALES ?? ""
    ),
    // A PR preview's own Postgres schema (pr_<n>), fixed when its Worker is built.
    "process.env.PAYLOAD_DB_SCHEMA": JSON.stringify(
      process.env.PAYLOAD_DB_SCHEMA ?? ""
    ),
  },
  plugins: [
    {
      enforce: "pre",
      name: "payload-worker-password-crypto",
      transform(code, id) {
        if (
          !/\/payload\/dist\/auth\/strategies\/local\/(?:authenticate|generatePasswordSaltHash)\.js$/u.test(
            id
          )
        ) {
          return;
        }

        const original = "import crypto from 'crypto';";

        if (!code.includes(original)) {
          throw new Error(
            "Payload password crypto import changed; check the Workers adapter."
          );
        }

        // Native builtins are externalized before Vite's normal aliases apply.
        return {
          code: code.replace(
            original,
            `import crypto from ${JSON.stringify(fileURLToPath(new URL("src/lib/worker-crypto.ts", import.meta.url)))};`
          ),
          map: null,
        };
      },
    },
    {
      // The Worker cannot see who connected, so local sign-in
      // (src/lib/local-login.ts) reads miniflare's cf-connecting-ip. Miniflare
      // keeps a client-sent value, so a preview opened to the network with
      // --host would trust a forged 127.0.0.1. Put the real peer there instead.
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          const peer = req.socket.remoteAddress?.replace(/^::ffff:/u, "");

          if (peer && peer !== "127.0.0.1" && peer !== "::1") {
            req.headers["cf-connecting-ip"] = peer;
          }

          next();
        });
      },
      name: "launch-preview-peer-address",
    },
    tailwindcss(),
    vinext(),
    cloudflare({
      // With the demo's locales on, the local D1 and media live apart from
      // the ordinary ones, whose schema differs.
      persistState: process.env.PAYLOAD_DEMO_LOCALES
        ? { path: ".demo-locales/state" }
        : true,
      viteEnvironment: {
        childEnvironments: ["ssr"],
        name: "rsc",
      },
    }),
  ],
  preview: {
    // Lets a Cloudflare quick tunnel (`cloudflared tunnel --url
    // http://localhost:4173`) serve the local demo; Vite rejects other hosts.
    allowedHosts: [".trycloudflare.com"],
  },
  resolve: {
    alias: {
      // See src/og-stub.ts.
      "next/og.js": fileURLToPath(new URL("src/og-stub.ts", import.meta.url)),
    },
    // packages/* pin their own React for tests; the app must render with one copy.
    dedupe: ["react", "react-dom"],
  },
});
