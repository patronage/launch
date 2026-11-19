import {
  accessFetch,
  isAccessRejection,
  verifyAccessJwt,
} from "@patronage/access";
import type { AccessFetchOptions } from "@patronage/access";
import { timeUpstream } from "@patronage/logging";

/** Where WordPress is and how to get past Cloudflare Access to reach it. */
export interface WordPressTransportConfig {
  /** The WordPress origin, such as `https://cms.example.org`. */
  origin: string;
  /**
   * The Access service token. Leave both empty for a WordPress without
   * Access (local Docker); setting only one fails closed.
   */
  accessClientId?: string;
  accessClientSecret?: string;
  /** Previews only: the secret that binds a forwarded editor JWT to this front-end. */
  accessProofSecret?: string;
  /** Previews only: the Access team domain and the preview application's AUD. */
  accessTeamDomain?: string;
  accessPreviewAudience?: string;
  /** The `upstream.<name>` the reads count toward on the wide event. */
  upstreamName?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * A fetch to WordPress: `previewJwt` is the editor's Access JWT, forwarded
 * with a gateway proof for preview reads. Pass undefined for public reads.
 */
export type WordPressFetch = (
  input: string,
  init?: RequestInit,
  previewJwt?: string | null
) => Promise<Response>;

const TRAILING_SLASH = /\/+$/u;

/**
 * Builds the one transport a front-end uses for every WordPress request:
 * GraphQL reads and original media alike.
 *
 * - Refuses URLs on any other origin, so credentials can't leak.
 * - Sends the Access service token when one is configured, and turns an
 *   Access login redirect into an error instead of following it.
 * - For previews, verifies the editor's Access JWT and forwards it with a
 *   gateway proof (the patronage-access mu-plugin's contract).
 * - Counts each request toward `upstream.<name>` (default `wordpress`) on
 *   the request's wide event from `@patronage/logging`. A 5xx counts as an
 *   error; callers still check the status themselves.
 */
export const createWordPressFetch = (
  config: WordPressTransportConfig
): WordPressFetch => {
  const { origin } = new URL(config.origin.replace(TRAILING_SLASH, ""));
  const clientId = config.accessClientId ?? "";
  const clientSecret = config.accessClientSecret ?? "";
  const transport = config.fetch ?? ((input, init) => fetch(input, init));

  const send = async (
    input: string,
    init: RequestInit,
    previewJwt: string | null | undefined
  ): Promise<Response> => {
    if (new URL(input).origin !== origin) {
      throw new Error(
        "WordPress credentials cannot be sent to another origin."
      );
    }

    if (!(clientId || clientSecret)) {
      return transport(input, init);
    }

    if (!(clientId && clientSecret)) {
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
        audience: config.accessPreviewAudience ?? "",
        teamDomain: config.accessTeamDomain ?? "",
      });

      if (!verified.ok || verified.identity.kind !== "user" || !previewJwt) {
        throw new Error("WordPress previews require a verified Access user.");
      }

      forward = { jwt: previewJwt, proofSecret: config.accessProofSecret };
    }

    const options: AccessFetchOptions = {
      fetch: transport,
      serviceToken: { clientId, clientSecret },
    };

    if (forward) {
      options.forward = forward;
    }

    const response = await accessFetch(
      input,
      { ...init, redirect: "manual" },
      options
    );

    if (isAccessRejection(response)) {
      await response.body?.cancel();

      throw new Error("Cloudflare Access refused the WordPress request.");
    }

    return response;
  };

  return (input, init, previewJwt) =>
    timeUpstream(
      config.upstreamName ?? "wordpress",
      () => send(input, init ?? {}, previewJwt),
      (response) => response.status >= 500
    );
};
