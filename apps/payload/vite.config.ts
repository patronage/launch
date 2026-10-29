import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    // Lets the bundler drop the database adapter that src/db.ts does not use.
    "process.env.PAYLOAD_DB": JSON.stringify(process.env.PAYLOAD_DB ?? "d1"),
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        childEnvironments: ["ssr"],
        name: "rsc",
      },
    }),
  ],
  resolve: {
    alias: {
      // See src/og-stub.ts.
      "next/og.js": fileURLToPath(new URL("src/og-stub.ts", import.meta.url)),
    },
    // packages/* pin their own React for tests; the app must render with one copy.
    dedupe: ["react", "react-dom"],
  },
});
