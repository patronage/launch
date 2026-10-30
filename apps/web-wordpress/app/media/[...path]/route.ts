import { sourcePath, serveImage } from "@launch/images";
import { env } from "cloudflare:workers";

import { wordpressEnv } from "@/lib/wordpress/env";
import { wordpressFetch } from "@/lib/wordpress/fetch";
import { UPLOADS_PATH } from "@/lib/wordpress/sections";

interface Context {
  params: Promise<{ path: string[] }>;
}

/**
 * WordPress uploads, resized by the Cloudflare Images binding. Only paths
 * under wp-content/uploads are fetched, so this is not an open proxy.
 */
export const GET = async (request: Request, { params }: Context) => {
  const { path: segments } = await params;
  const path = sourcePath(segments);

  const original = path
    ? await wordpressFetch(`${wordpressEnv().origin}${UPLOADS_PATH}${path}`)
    : null;

  return serveImage(request, original, env.IMAGES);
};
