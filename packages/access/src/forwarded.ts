import { GATEWAY_PROOF_HEADER, verifyGatewayProof } from "./gateway-proof.ts";
import type { GatewayProofFailure } from "./gateway-proof.ts";
import { FORWARDED_JWT_HEADER, verifyAccessJwt } from "./jwt.ts";
import type { AccessFailureReason, AccessJwtConfig } from "./jwt.ts";

export interface ForwardedUserConfig extends AccessJwtConfig {
  /** The secret the gateway signs its proof with. Empty refuses every request. */
  proofSecret: string;
}

export type ForwardedUserFailure =
  | AccessFailureReason
  | GatewayProofFailure
  | "missing_proof"
  | "service_token";

export type ForwardedUserResult =
  | { ok: true; email: string; subject: string; token: string }
  | { ok: false; reason: ForwardedUserFailure };

/** Whether a request says it carries a JWT forwarded by a gateway. */
export const hasForwardedJwt = (headers: Headers): boolean =>
  headers.has(FORWARDED_JWT_HEADER);

/**
 * The editor behind a request an MCP gateway made on their behalf: the
 * editor's Access JWT for the gateway's own Access application in
 * `X-Access-User-Jwt`, trusted only beside a valid gateway proof signed over
 * that token. Over a Service binding the request never crossed Access, so the
 * proof is what makes the JWT trustworthy. A service token's JWT names no
 * person and is refused.
 */
export const verifyForwardedUser = async (
  headers: Headers,
  config: ForwardedUserConfig
): Promise<ForwardedUserResult> => {
  const token = headers.get(FORWARDED_JWT_HEADER);

  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  if (!config.proofSecret) {
    return { ok: false, reason: "not_configured" };
  }

  const proof = headers.get(GATEWAY_PROOF_HEADER);

  if (!proof) {
    return { ok: false, reason: "missing_proof" };
  }

  const proven = await verifyGatewayProof(proof, token, config.proofSecret);

  if (proven !== true) {
    return { ok: false, reason: proven };
  }

  const result = await verifyAccessJwt(token, config);

  if (!result.ok) {
    return result;
  }

  if (result.identity.kind !== "user") {
    return { ok: false, reason: "service_token" };
  }

  return {
    email: result.identity.email.toLowerCase(),
    ok: true,
    subject: result.identity.subject,
    token,
  };
};
