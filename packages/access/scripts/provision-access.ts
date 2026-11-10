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
import type {
  LockdownSpec,
  ServiceTokenResult,
} from "../src/cloudflare-api.ts";

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

// Service tokens Cloudflare stops accepting within this many days are flagged.
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

// Each token is printed the moment it exists: a new token's secret is shown
// only once, and a later step that fails must not take it with it.
const printToken = (token: ServiceTokenResult): void => {
  console.log(`# service token "${token.name}"`);
  console.log(`ACCESS_CLIENT_ID=${token.clientId}`);
  console.log(
    token.clientSecret
      ? `ACCESS_CLIENT_SECRET=${token.clientSecret}  # shown once; save it now`
      : "# token already existed; its secret is not retrievable (rotate it to get a new one)"
  );

  if (!token.expiresAt) {
    return;
  }

  const daysLeft = Math.floor(
    (Date.parse(token.expiresAt) - Date.now()) / DAY_MS
  );

  console.log(`# expires ${token.expiresAt}`);

  if (daysLeft < EXPIRY_WARNING_DAYS) {
    console.warn(
      daysLeft < 0
        ? `# WARNING: service token "${token.name}" has expired; rotate it in Zero Trust and update the Workers that use it`
        : `# WARNING: service token "${token.name}" expires in ${daysLeft} days; rotate it in Zero Trust before then`
    );
  }
};

const result = await provisionLockdown(
  cloudflareClient({
    accountId,
    apiToken,
    dryRun: values["dry-run"] ?? false,
  }),
  spec,
  { onServiceToken: printToken }
);

console.log(`ACCESS_TEAM_DOMAIN=${result.teamDomain}`);

console.log(`ACCESS_AUD=${result.aud}`);
