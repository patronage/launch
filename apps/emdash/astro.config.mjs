import { fileURLToPath } from "node:url";

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

// The MCP gateway signs editors in too, over a Service binding, with the
// editor's JWT for the gateway's own Access application and a proof signed
// with a secret the two Workers share (ADR 0027). src/auth/gateway-access.ts
// hands every other request to the stock Access provider unchanged. Set
// ACCESS_GATEWAY_AUD at build time to turn it on; it needs the
// ACCESS_GATEWAY_PROOF_SECRET secret beside it.
const gatewayAud = process.env.ACCESS_GATEWAY_AUD;

if (teamDomain) {
  cms.auth = access({ audienceEnvVar: "ACCESS_AUD", teamDomain });

  if (gatewayAud) {
    cms.auth = {
      ...cms.auth,
      config: {
        ...cms.auth.config,
        gatewayAudienceEnvVar: "ACCESS_GATEWAY_AUD",
        gatewayProofSecretEnvVar: "ACCESS_GATEWAY_PROOF_SECRET",
      },
      entrypoint: fileURLToPath(
        new URL("src/auth/gateway-access.ts", import.meta.url)
      ),
    };
  }
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
