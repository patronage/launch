import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { access, d1, r2 } from "@emdash-cms/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

// With ACCESS_TEAM_DOMAIN set at build time, EmDash signs editors in with the
// Cloudflare Access application in front of /_emdash/* (ADR 0011) and reads
// its audience tag from the ACCESS_AUD binding at runtime. Without it (local
// dev), EmDash uses its own passkey sign-in; scripts/deploy.mjs refuses that.
const teamDomain = process.env.ACCESS_TEAM_DOMAIN;

// One Worker serves the site (src/pages, rendered with @launch/ui's shared
// sections), the EmDash admin (/_emdash/admin), its REST API (/_emdash/api)
// and MCP (/_emdash/api/mcp). Worker settings live in cloudflare.config.ts.
/** @type {Parameters<typeof emdash>[0]} */
const cms = {
  database: d1({ binding: "DB", session: "auto" }),
  storage: r2({ binding: "MEDIA" }),
};

if (teamDomain) {
  cms.auth = access({ audienceEnvVar: "ACCESS_AUD", teamDomain });
}

export default defineConfig({
  adapter: cloudflare(),
  devToolbar: { enabled: false },
  integrations: [
    // @launch/ui's components render on the server; the EmDash admin is a React app.
    react(),
    emdash(cms),
  ],
  output: "server",
  vite: { plugins: [tailwindcss()] },
});
