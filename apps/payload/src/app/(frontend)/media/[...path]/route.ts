import { serveImage, sourcePath } from "@launch/images";
import config from "@payload-config";
import { REST_GET } from "@payloadcms/next/routes";
import { env } from "cloudflare:workers";

interface Context {
  params: Promise<{ path: string[] }>;
}

const payloadRest = REST_GET(config);

/**
 * Media resized by the Cloudflare Images binding. The original comes from
 * Payload's own file endpoint, called in-process and without the visitor's
 * cookies, so R2 keys (Payload 4 prefixes each file) and media access rules
 * stay Payload's business.
 */
export const GET = async (request: Request, { params }: Context) => {
  const { path: segments } = await params;
  const path = sourcePath(segments);

  const original = path
    ? await payloadRest(
        new Request(new URL(`/api/media/file/${path}`, request.url)),
        { params: Promise.resolve({ slug: ["media", "file", ...segments] }) }
      )
    : null;

  return serveImage(request, original, env.IMAGES);
};
