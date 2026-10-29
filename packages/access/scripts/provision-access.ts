// Provision a Cloudflare Access lockdown for a CMS through the API.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   pnpm --filter @patronage/access access:provision -- \
//     --name "Demo WordPress" \
//     --destination cms.example.org \
//     --allow-email-domain example.org \
//     --service-token "demo web worker" \
//     [--dry-run]
//
// For Payload, lock only the admin and API paths and leave public pages open:
//     --destination cms.example.org/admin --destination cms.example.org/api
//
// The token needs Access: Apps and Policies Edit, and Access: Service Tokens Edit.
import { parseArgs } from "node:util";

import { cloudflareClient, provisionLockdown } from "../src/cloudflare-api.ts";
import type { LockdownSpec } from "../src/cloudflare-api.ts";

const { values } = parseArgs({
  options: {
    "allow-email": { multiple: true, type: "string" },
    "allow-email-domain": { multiple: true, type: "string" },
    destination: { multiple: true, type: "string" },
    "dry-run": { type: "boolean" },
    name: { type: "string" },
    "service-token": { multiple: true, type: "string" },
    "session-duration": { type: "string" },
  },
});

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!apiToken || !accountId) {
  throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
}

if (!values.name || !values.destination?.length) {
  throw new Error("Pass --name and at least one --destination.");
}

const spec: LockdownSpec = {
  allowEmailDomains: values["allow-email-domain"] ?? [],
  allowEmails: values["allow-email"] ?? [],
  destinations: values.destination,
  name: values.name,
  serviceTokens: values["service-token"] ?? [],
};

if (values["session-duration"]) {
  spec.sessionDuration = values["session-duration"];
}

const result = await provisionLockdown(
  cloudflareClient({
    accountId,
    apiToken,
    dryRun: values["dry-run"] ?? false,
  }),
  spec
);

console.log(`ACCESS_TEAM_DOMAIN=${result.teamDomain}`);

console.log(`ACCESS_AUD=${result.aud}`);

for (const token of result.serviceTokens) {
  console.log(`# service token "${token.name}"`);
  console.log(`ACCESS_CLIENT_ID=${token.clientId}`);
  console.log(
    token.clientSecret
      ? `ACCESS_CLIENT_SECRET=${token.clientSecret}  # shown once; store it with \`wrangler secret put\` now`
      : "# token already existed; its secret is not retrievable (rotate it to get a new one)"
  );
}
