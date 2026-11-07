import { defineConfig } from "blume";

// WORKER_DOMAIN is the custom domain cloudflare.config.ts attaches. Blume
// needs an absolute origin for the sitemap, canonical URLs and Open Graph
// cards; without one it builds without them.
const domain = process.env.WORKER_DOMAIN;

export default defineConfig({
  content: { root: "docs" },
  deployment: domain ? { site: `https://${domain}` } : {},
  description:
    "Reference sites from Patronage for running a CMS behind Cloudflare Access, with fast front-ends on Cloudflare Workers.",
  footer: {
    copyright: `© ${new Date().getFullYear()} Patronage`,
    links: [{ href: "https://www.patronage.org", label: "Patronage" }],
  },
  github: { dir: "apps/docs-site", owner: "patronage", repo: "launch" },
  // The Patronage mark; its currentColor half follows the light and dark theme.
  logo: { image: "/logo.svg", text: "Launch" },
  poweredBy: false,
  // The standard Patronage Blume theme, shared with the other Patronage docs
  // sites. theme.css adds the shell and header treatment.
  // PR #59 briefly published each ADR at /decisions/<slug>; send those to the
  // summary page, which links every record on GitHub.
  redirects: [
    { from: "/decisions/cloudflare-config-through-cf-cli", to: "/decisions" },
    { from: "/decisions/cms-behind-cloudflare-access", to: "/decisions" },
    { from: "/decisions/cms-neutral-content-model", to: "/decisions" },
    {
      from: "/decisions/local-verification-and-workers-builds",
      to: "/decisions",
    },
    { from: "/decisions/logs-to-r2-through-logpush", to: "/decisions" },
    { from: "/decisions/mcp-gateway-worker", to: "/decisions" },
    { from: "/decisions/one-mcp-worker", to: "/decisions" },
    { from: "/decisions/payload-single-app-on-d1", to: "/decisions" },
    { from: "/decisions/plain-pnpm-workspaces", to: "/decisions" },
    { from: "/decisions/public-reference-monorepo", to: "/decisions" },
    { from: "/decisions/separate-wordpress-installs", to: "/decisions" },
    { from: "/decisions/shadcn-ui-package", to: "/decisions" },
    { from: "/decisions/shared-wordpress-fields", to: "/decisions" },
    { from: "/decisions/vinext-front-ends-on-workers", to: "/decisions" },
    { from: "/decisions/wordpress-deploy-kit", to: "/decisions" },
    { from: "/decisions/wordpress-fields-in-php", to: "/decisions" },
  ],
  theme: {
    accent: {
      dark: "oklch(0.832 0.1167 218.69)",
      light: "oklch(0.52 0.13 226.89)",
    },
    action: "oklch(0.59 0.19 359.82)",
    background: {
      dark: "oklch(0.1706 0.0284 267.36)",
      light: "oklch(1 0 89.88)",
    },
    fonts: {
      body: "open-sans",
      display: "space-grotesk",
      mono: "jetbrains-mono",
    },
    mode: "system",
    radius: "sm",
  },
  title: "Launch",
});
