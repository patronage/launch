import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// Bundles the Worker that cloudflare.config.ts describes, as the other apps do.
export default defineConfig({
  plugins: [cloudflare()],
});
