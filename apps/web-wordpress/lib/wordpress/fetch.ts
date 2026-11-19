import { createWordPressFetch } from "@patronage/launch-wpgraphql";

import { wordpressEnv } from "./env";

/**
 * CMS reads share the Access transport from @patronage/launch-wpgraphql, including
 * original media requests. Each one counts toward upstream.wordpress on the
 * request's wide event. Settings are read per call so Workers secrets work.
 */
export const wordpressFetch = (
  input: string,
  init: RequestInit = {},
  previewJwt?: string | null
): Promise<Response> => {
  const config = wordpressEnv();

  return createWordPressFetch({
    accessClientId: config.accessClientId,
    accessClientSecret: config.accessClientSecret,
    accessPreviewAudience: config.accessPreviewAudience,
    accessProofSecret: config.accessProofSecret,
    accessTeamDomain: config.accessTeamDomain,
    origin: config.origin,
  })(input, init, previewJwt);
};
