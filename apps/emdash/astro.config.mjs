import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { access, d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

import { newsRules } from "./src/plugins/news-rules.ts";

// With ACCESS_TEAM_DOMAIN set at build time, EmDash signs editors in with the
// Cloudflare Access application in front of /_emdash/* (ADR 0011) and reads
// its audience tag from the ACCESS_AUD binding at runtime. Without it (local
// dev), EmDash uses its own passkey sign-in; scripts/deploy.mjs refuses that.
const teamDomain = process.env.ACCESS_TEAM_DOMAIN;

// With EMAIL_FROM set at build time, EmDash sends form notifications, magic
// links and invites through Cloudflare Email Sending (the EMAIL binding in
// cloudflare.config.ts). The address's domain must be onboarded for Email
// Sending. Without it, forms still save submissions but send no email.
const emailFrom = process.env.EMAIL_FROM;

// One Worker serves the site (src/pages, rendered with @launch/ui's shared
// sections), the EmDash admin (/_emdash/admin), its REST API (/_emdash/api)
// and MCP (/_emdash/api/mcp). Worker settings live in cloudflare.config.ts.
/** @type {Parameters<typeof emdash>[0]} */
const cms = {
  database: d1({ binding: "DB", session: "auto" }),
  // Forms built in the admin, placed on pages with the `form` section, and
  // the rule that a news story goes live with exactly one category.
  plugins: [formsPlugin(), newsRules()],
  storage: r2({ binding: "MEDIA" }),
};

if (emailFrom) {
  cms.plugins.push(
    cloudflareEmail({ from: { email: emailFrom, name: "Launch" } })
  );
}

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
