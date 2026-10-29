import { env } from "cloudflare:workers";

export function GET() {
  return Response.json({
    message: "Hello from vinext on Cloudflare Workers",
    // Plain-text binding declared in cloudflare.config.ts.
    upstreamUrl: env.UPSTREAM_URL ?? null,
    // Secrets are never echoed, only whether they are present.
    revalidateSecretSet: Boolean(env.REVALIDATE_SECRET),
    previewSecretSet: Boolean(env.PREVIEW_SECRET),
    // Bindings are also mirrored onto process.env under nodejs_compat.
    processEnvUpstreamUrl: process.env.UPSTREAM_URL ?? null,
  });
}
