import { env } from "cloudflare:workers";

export const GET = () =>
  Response.json({
    message: "Hello from vinext on Cloudflare Workers",
    // Secrets are never echoed, only whether they are present.
    previewSecretSet: Boolean(env.PREVIEW_SECRET),
    // Bindings are also mirrored onto process.env under nodejs_compat.
    processEnvUpstreamUrl: process.env.UPSTREAM_URL ?? null,
    revalidateSecretSet: Boolean(env.REVALIDATE_SECRET),
    // Plain-text binding declared in cloudflare.config.ts.
    upstreamUrl: env.UPSTREAM_URL ?? null,
  });
