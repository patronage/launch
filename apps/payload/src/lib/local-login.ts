import type { Payload, PayloadRequest } from "payload";

/**
 * One-click sign-in for the admin on a developer's own machine, like
 * Payload's `autoLogin` but limited to requests made there. Locally,
 * miniflare stamps every request with `cf-connecting-ip: 127.0.0.1` and an
 * `x-forwarded-host` of localhost. Cloudflare's edge, a quick tunnel
 * included, sends the visitor's own address and host instead, and adds
 * `cf-ray`, so deployed Workers and shared tunnels never qualify.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

/** Headers only a proxy in front of the Worker adds. */
const PROXY_HEADERS = ["cf-ray", "cf-visitor", "forwarded", "x-forwarded-for"];

const isLocalHost = (host: string | null): boolean =>
  host !== null &&
  URL.canParse(`http://${host}`) &&
  LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);

export const isLocalRequest = (headers: Headers): boolean => {
  const ip = headers.get("cf-connecting-ip");
  const forwardedHost = headers.get("x-forwarded-host");

  return (
    isLocalHost(headers.get("host")) &&
    (ip === null || LOOPBACK_IPS.has(ip)) &&
    (forwardedHost === null || isLocalHost(forwardedHost)) &&
    !PROXY_HEADERS.some((name) => headers.has(name))
  );
};

/** The admin user created first, which the demo seed makes the demo account. */
export const firstUser = async (payload: Payload, req?: PayloadRequest) => {
  const { docs } = await payload.find({
    collection: "users",
    depth: 0,
    limit: 1,
    // Payload 4's Local API applies access control by default; this lookup runs before anyone signs in.
    overrideAccess: true,
    pagination: false,
    req,
    showHiddenFields: true,
    sort: "createdAt",
  });

  return docs[0];
};

export const LOCAL_LOGIN_PATH = "/next/local-login";
