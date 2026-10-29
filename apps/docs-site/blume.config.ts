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
  logo: { image: "/icon.svg", text: "Launch" },
  poweredBy: false,
  theme: {
    // Patronage cyan.
    accent: "#00baee",
    mode: "system",
  },
  title: "Launch",
});
