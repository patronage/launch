import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";

export const TEAM_DOMAIN = "https://team.cloudflareaccess.com";
export const AUD = "application-aud";

export const testKeys = async (kid = "primary") => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid };

  return { getKey: createLocalJWKSet({ keys: [jwk] }), privateKey };
};

export const signToken = (
  privateKey: CryptoKey,
  claims: JWTPayload = {},
  expiresIn: string | number = "5m"
): Promise<string> =>
  new SignJWT({ email: "editor@example.com", sub: "access-subject", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "primary" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer(TEAM_DOMAIN)
    .setAudience(AUD)
    .sign(privateKey);
