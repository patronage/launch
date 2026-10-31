import { ACCESS_ASSERTION_HEADER, verifyAccessJwt } from "@patronage/access";
import type { AccessIdentity } from "@patronage/access";
import type { JWTVerifyGetKey } from "jose";

import { boundedPath, opaqueSubject } from "./logging";
import type { McpRequestLogger } from "./logging";

export type AccessFailureReason =
  | "missing_audience"
  | "missing_issuer"
  | "missing_token"
  | "invalid_token";

export type AccessResult =
  | { ok: true; subjectOpaque: string; token: string }
  | { ok: false; status: 403; reason: AccessFailureReason };

export interface AccessDeps {
  getKey?: JWTVerifyGetKey;
  log: McpRequestLogger;
}

const identityName = (identity: AccessIdentity): string => {
  if (identity.kind === "service") {
    return identity.commonName;
  }

  return identity.subject || identity.email;
};

const denyAccess = (
  request: Request,
  log: McpRequestLogger,
  reason: AccessFailureReason
): AccessResult => {
  const target = boundedPath(request.url);
  log.set({
    authentication: {
      actor: "unknown",
      outcome: "denied",
      reason,
    },
    mcp: { outcome: "error" },
  });
  log.setLevel("warn");
  log.audit.deny(reason, {
    action: "mcp.authorize",
    actor: { id: "unknown", type: "user" },
    target: { id: target, type: "route" },
  });

  return { ok: false, reason, status: 403 };
};

// No assertion header is the routine start of an Access sign-in, so it is
// logged at info with no audit record. A bad or expired assertion is a denial.
const challengeAccess = (log: McpRequestLogger): AccessResult => {
  log.set({
    authentication: {
      actor: "unknown",
      outcome: "challenged",
      reason: "missing_token",
    },
    mcp: { outcome: "error" },
  });
  log.setLevel("info");

  return { ok: false, reason: "missing_token", status: 403 };
};

export const verifyAccess = async (
  request: Request,
  env: Env,
  deps: AccessDeps
): Promise<AccessResult> => {
  const { log } = deps;

  if (!env.ACCESS_AUD) {
    return denyAccess(request, log, "missing_audience");
  }

  if (!env.ACCESS_TEAM_DOMAIN) {
    return denyAccess(request, log, "missing_issuer");
  }

  const token = request.headers.get(ACCESS_ASSERTION_HEADER);

  if (!token) {
    return challengeAccess(log);
  }

  const options: Parameters<typeof verifyAccessJwt>[1] = {
    audience: env.ACCESS_AUD,
    teamDomain: env.ACCESS_TEAM_DOMAIN,
  };

  if (deps.getKey) {
    options.getKey = deps.getKey;
  }

  const result = await verifyAccessJwt(token, options);

  if (!result.ok) {
    return denyAccess(request, log, "invalid_token");
  }

  const subjectOpaque = await opaqueSubject(identityName(result.identity));
  log.set({
    authentication: {
      actor: subjectOpaque,
      outcome: "allowed",
    },
  });

  return { ok: true, subjectOpaque, token };
};
