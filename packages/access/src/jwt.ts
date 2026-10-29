import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { z } from "zod";

/** Header Cloudflare Access sets on every request it lets through to an origin. */
export const ACCESS_ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Header a gateway uses to forward a user's Access JWT past a second Access
 * edge. Cloudflare owns the `Cf-Access-*` family and overwrites the assertion
 * header when the origin is itself behind Access, so the user's token travels
 * under this name instead.
 */
export const FORWARDED_JWT_HEADER = "X-Access-User-Jwt";

/** Clock skew accepted on `exp` and `nbf`, matching the WordPress verifier. */
export const LEEWAY_SECONDS = 60;

export interface AccessJwtConfig {
  /** Team domain, e.g. `https://team.cloudflareaccess.com`. Used as the exact issuer. */
  teamDomain: string;
  /** Application audience tag (AUD). Several during a migration between applications. */
  audience: string | readonly string[];
  /** Override key resolution; defaults to the team's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export type AccessFailureReason =
  | "missing_token"
  | "not_configured"
  | "invalid_token"
  | "expired";

/**
 * A verified Access identity. A user login carries `email`; a service token
 * carries `commonName` (its client ID) and no email.
 */
export type AccessIdentity =
  | { kind: "user"; email: string; subject: string; claims: JWTPayload }
  | { kind: "service"; commonName: string; claims: JWTPayload };

export type AccessVerifyResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: AccessFailureReason };

const userClaims = z.object({
  email: z.email(),
  sub: z.string().catch(""),
});

const serviceClaims = z.object({
  common_name: z.string().trim().min(1),
});

/** Normalize a team domain to the exact issuer Access puts in `iss`. */
export const accessIssuer = (teamDomain: string): string =>
  teamDomain.trim().replace(/\/+$/u, "");

/** URL of the team's signing keys (served as both JWKS and PEM certificates). */
export const accessJwksUrl = (teamDomain: string): URL =>
  new URL(`${accessIssuer(teamDomain)}/cdn-cgi/access/certs`);

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

const remoteKeySet = (teamDomain: string): JWTVerifyGetKey => {
  const issuer = accessIssuer(teamDomain);
  const cached = remoteKeySets.get(issuer);

  if (cached) {
    return cached;
  }

  const keySet = createRemoteJWKSet(accessJwksUrl(issuer));
  remoteKeySets.set(issuer, keySet);

  return keySet;
};

const identityFrom = (payload: JWTPayload): AccessIdentity | null => {
  const user = userClaims.safeParse(payload);

  if (user.success) {
    return {
      claims: payload,
      email: user.data.email,
      kind: "user",
      subject: user.data.sub,
    };
  }

  const service = serviceClaims.safeParse(payload);

  if (service.success) {
    return {
      claims: payload,
      commonName: service.data.common_name,
      kind: "service",
    };
  }

  return null;
};

/**
 * Verify a Cloudflare Access JWT: RS256 only, exact issuer, accepted audience,
 * `exp` and `nbf` with a 60 second leeway, and an identity claim (an email for
 * a user, `common_name` for a service token).
 */
export const verifyAccessJwt = async (
  token: string | null | undefined,
  config: AccessJwtConfig
): Promise<AccessVerifyResult> => {
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  const audience = [config.audience].flat();

  if (!config.teamDomain || audience.length === 0 || audience.includes("")) {
    return { ok: false, reason: "not_configured" };
  }

  try {
    const { payload } = await jwtVerify(
      token,
      config.getKey ?? remoteKeySet(config.teamDomain),
      {
        algorithms: ["RS256"],
        audience,
        clockTolerance: LEEWAY_SECONDS,
        issuer: accessIssuer(config.teamDomain),
        requiredClaims: ["exp"],
      }
    );

    const identity = identityFrom(payload);

    return identity
      ? { identity, ok: true }
      : { ok: false, reason: "invalid_token" };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }

    return { ok: false, reason: "invalid_token" };
  }
};

/** Verify the assertion Access attached to an incoming request. */
export const verifyAccessRequest = (
  request: Request,
  config: AccessJwtConfig,
  header: string = ACCESS_ASSERTION_HEADER
): Promise<AccessVerifyResult> =>
  verifyAccessJwt(request.headers.get(header), config);
