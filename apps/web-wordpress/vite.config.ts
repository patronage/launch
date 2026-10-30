import { cloudflare } from "@cloudflare/vite-plugin";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import vinext from "vinext";
import { defineConfig } from "vite";

// Docker WordPress calls the revalidate route at this host (HEADLESS_FRONTEND_INTERNAL_URL).
const allowedHosts = ["host.docker.internal"];

export default defineConfig({
  plugins: [
    vinext({
      // Pages (ISR) and data (fetch) both live in KV, so the revalidate
      // route's revalidateTag() and revalidatePath() clear them in one place.
      cache: { data: kvDataAdapter() },
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      viteEnvironment: {
        childEnvironments: ["ssr"],
        name: "rsc",
      },
    }),
  ],
  preview: { allowedHosts },
  // packages/* pin their own React for tests; the app must render with one copy.
  resolve: { dedupe: ["react", "react-dom"] },
  server: { allowedHosts },
});
