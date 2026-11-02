import {
  accessFetch,
  isAccessRejection,
  verifyAccessJwt,
} from "@patronage/access";
import { timeUpstream } from "@patronage/logging";

import { wordpressEnv } from "./env";

const accessWordPressFetch = async (
  input: string,
  init: RequestInit = {},
  previewJwt?: string | null
): Promise<Response> => {
  const config = wordpressEnv();

  if (new URL(input).origin !== new URL(config.origin).origin) {
    throw new Error("WordPress credentials cannot be sent to another origin.");
  }

  // Local WordPress runs without Access. A partial token fails closed.
  if (!(config.accessClientId || config.accessClientSecret)) {
    return fetch(input, init);
  }

  if (!(config.accessClientId && config.accessClientSecret)) {
    throw new Error("WordPress Access service token is incomplete.");
  }

  let forward;

  if (previewJwt !== undefined) {
    if (!config.accessProofSecret) {
      throw new Error(
        "WordPress previews need the Access gateway proof secret."
      );
    }

    const verified = await verifyAccessJwt(previewJwt, {
      audience: config.accessPreviewAudience,
      teamDomain: config.accessTeamDomain,
    });

    if (!verified.ok || verified.identity.kind !== "user" || !previewJwt) {
      throw new Error("WordPress previews require a verified Access user.");
    }

    forward = { jwt: previewJwt, proofSecret: config.accessProofSecret };
  }

  const response = await accessFetch(
    input,
    { ...init, redirect: "manual" },
    {
      forward,
      serviceToken: {
        clientId: config.accessClientId,
        clientSecret: config.accessClientSecret,
      },
    }
  );

  if (isAccessRejection(response)) {
    await response.body?.cancel();

    throw new Error("Cloudflare Access refused the WordPress request.");
  }

  return response;
};

/**
 * CMS reads share the Access transport, including original media requests.
 * Each one counts toward upstream.wordpress on the request's wide event.
 */
export const wordpressFetch = (
  input: string,
  init: RequestInit = {},
  previewJwt?: string | null
): Promise<Response> =>
  timeUpstream(
    "wordpress",
    () => accessWordPressFetch(input, init, previewJwt),
    // A 5xx is a failed read even though fetch resolved. Callers still check
    // the status themselves; this only counts it.
    (response) => response.status >= 500
  );
