export {
  ACCESS_ASSERTION_HEADER,
  FORWARDED_JWT_HEADER,
  LEEWAY_SECONDS,
  accessIssuer,
  accessJwksUrl,
  verifyAccessJwt,
  verifyAccessRequest,
} from "./jwt.ts";

export type {
  AccessFailureReason,
  AccessIdentity,
  AccessJwtConfig,
  AccessVerifyResult,
} from "./jwt.ts";

export {
  GATEWAY_PROOF_HEADER,
  PROOF_SKEW_SECONDS,
  computeGatewayProof,
  verifyGatewayProof,
} from "./gateway-proof.ts";

export type { GatewayProofFailure } from "./gateway-proof.ts";

export {
  CLIENT_ID_HEADER,
  CLIENT_SECRET_HEADER,
  accessFetch,
  accessRequestHeaders,
  isAccessRejection,
  serviceTokenHeaders,
} from "./service-token.ts";

export type {
  AccessFetchOptions,
  ForwardedIdentity,
  ServiceToken,
} from "./service-token.ts";
