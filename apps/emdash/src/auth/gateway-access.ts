// EmDash's auth provider for Launch: Cloudflare Access, as `access()` from
// @emdash-cms/cloudflare configures it, plus the MCP gateway (ADR 0027).
//
// An editor in the admin arrives through the Access application in front of
// /_emdash/*, with Access's own assertion; that request goes to EmDash's
// stock provider unchanged. The gateway calls over a Service binding, which
// never crosses Access, on an editor's behalf: their JWT for the gateway's
// Access application in X-Access-User-Jwt, and a proof signed over it with
// the secret the two Workers share. Such a request is trusted only when the
// proof and the JWT both check out; any failure refuses it, never falls back.
import { authenticate as accessAuthenticate } from "@emdash-cms/cloudflare/auth";
import { hasForwardedJwt, verifyForwardedUser } from "@patronage/access";
import type { AuthProviderModule, AuthResult } from "emdash";
import { z } from "zod";

// What `access(...)` in astro.config.mjs passes, plus the names of the
// Worker bindings holding the gateway's Access audience and the proof
// secret. Both must be set for the gateway to be trusted.
const configSchema = z.object({
  defaultRole: z.number().optional(),
  gatewayAudienceEnvVar: z.string().default("ACCESS_GATEWAY_AUD"),
  gatewayProofSecretEnvVar: z.string().default("ACCESS_GATEWAY_PROOF_SECRET"),
  roleMapping: z.record(z.string(), z.number()).optional(),
  teamDomain: z.string().min(1),
});

type GatewayAccessConfig = z.infer<typeof configSchema>;

const groupsSchema = z.array(z.object({ name: z.string() })).optional();

const identitySchema = z.object({
  email: z.string(),
  groups: groupsSchema,
  idp: z.json().optional(),
  name: z.string().optional(),
});

const envValueSchema = z.string().trim().catch("");

// EmDash's stock provider takes a bare hostname; the issuer is https://<host>.
const issuerFor = (teamDomain: string): string =>
  `https://${teamDomain
    .trim()
    .replace(/^https:\/\//u, "")
    .replace(/\/+$/u, "")}`;

const readEnv = (name: string): string =>
  envValueSchema.parse(process.env[name]);

// The same Access identity lookup the stock provider makes, so an editor's
// name and groups are synced the same way whichever way they came in.
const accessIdentity = async (issuer: string, token: string) => {
  const response = await fetch(`${issuer}/cdn-cgi/access/get-identity`, {
    headers: { Cookie: `CF_Authorization=${token}` },
  });

  if (!response.ok) {
    throw new Error(`Access identity lookup failed: HTTP ${response.status}`);
  }

  const identity = identitySchema.safeParse(await response.json());

  if (!identity.success) {
    throw new Error("Access identity lookup returned no email");
  }

  return identity.data;
};

const roleFor = (
  groups: z.infer<typeof groupsSchema>,
  config: GatewayAccessConfig
): number => {
  for (const group of groups ?? []) {
    const role = config.roleMapping?.[group.name];

    if (role !== undefined) {
      return role;
    }
  }

  return config.defaultRole ?? 30;
};

const authenticateGateway = async (
  request: Request,
  config: GatewayAccessConfig
): Promise<AuthResult> => {
  const audience = readEnv(config.gatewayAudienceEnvVar);
  const proofSecret = readEnv(config.gatewayProofSecretEnvVar);

  if (!(audience && proofSecret)) {
    throw new Error("The MCP gateway is not configured on this site");
  }

  const issuer = issuerFor(config.teamDomain);

  const result = await verifyForwardedUser(request.headers, {
    audience,
    proofSecret,
    teamDomain: issuer,
  });

  if (!result.ok) {
    throw new Error(`Gateway request refused: ${result.reason}`);
  }

  const identity = await accessIdentity(issuer, result.token);

  if (identity.email.toLowerCase() !== result.email) {
    throw new Error("Gateway request refused: identity mismatch");
  }

  return {
    email: result.email,
    metadata: {
      groups: identity.groups,
      idp: identity.idp,
      via: "mcp-gateway",
    },
    name: identity.name ?? result.email.split("@")[0] ?? "Unknown",
    role: roleFor(identity.groups, config),
    subject: result.subject,
  };
};

export const authenticate: AuthProviderModule["authenticate"] = async (
  request,
  rawConfig
) => {
  if (!hasForwardedJwt(request.headers)) {
    return await accessAuthenticate(request, rawConfig);
  }

  const config = configSchema.safeParse(rawConfig);

  if (!config.success) {
    throw new Error("Invalid Access config: teamDomain is required");
  }

  return await authenticateGateway(request, config.data);
};
