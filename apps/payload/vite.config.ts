import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    // Lets the bundler drop the database adapter that src/db.ts does not use.
    "process.env.PAYLOAD_DB": JSON.stringify(process.env.PAYLOAD_DB ?? "d1"),
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
    tailwindcss(),
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
