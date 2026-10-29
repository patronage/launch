import { computeGatewayProof, GATEWAY_PROOF_HEADER } from "./gateway-proof.ts";
import { FORWARDED_JWT_HEADER } from "./jwt.ts";

export const CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export interface ServiceToken {
  clientId: string;
  clientSecret: string;
}

export interface ForwardedIdentity {
  /** The user's verified Access JWT, forwarded so the CMS acts as that user. */
  jwt: string;
  /** Shared secret for the gateway proof. Omit until the CMS requires one. */
  proofSecret?: string;
}

export interface AccessFetchOptions {
  serviceToken: ServiceToken;
  forward?: ForwardedIdentity;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const MANAGED_HEADERS = [
  CLIENT_ID_HEADER,
  CLIENT_SECRET_HEADER,
  FORWARDED_JWT_HEADER,
  GATEWAY_PROOF_HEADER,
];

/** Headers that get a service token past an Access application. */
export const serviceTokenHeaders = (token: ServiceToken): Headers => {
  if (!token.clientId || !token.clientSecret) {
    throw new Error("Access service token is not configured.");
  }

  return new Headers({
    [CLIENT_ID_HEADER]: token.clientId,
    [CLIENT_SECRET_HEADER]: token.clientSecret,
  });
};

/**
 * Build the headers for one request to an Access-protected origin: the
 * service token, and optionally a forwarded user JWT with its gateway proof.
 * Caller-supplied copies of these headers are always replaced, so a value
 * from an inbound request can never leak through.
 */
export const accessRequestHeaders = async (
  init: HeadersInit | undefined,
  options: Omit<AccessFetchOptions, "fetch">
): Promise<Headers> => {
  const headers = new Headers(init);

  for (const name of MANAGED_HEADERS) {
    headers.delete(name);
  }

  for (const [name, value] of serviceTokenHeaders(options.serviceToken)) {
    headers.set(name, value);
  }

  const { forward } = options;

  if (forward) {
    headers.set(FORWARDED_JWT_HEADER, forward.jwt);

    if (forward.proofSecret) {
      headers.set(
        GATEWAY_PROOF_HEADER,
        await computeGatewayProof(forward.proofSecret, forward.jwt)
      );
    }
  }

  return headers;
};

/**
 * `fetch` for an origin behind Cloudflare Access. Redirects are returned
 * rather than followed: Access answers a rejected service token with a
 * redirect to its login page, and following it would hide the failure.
 */
export const accessFetch = async (
  input: string | URL,
  init: RequestInit,
  options: AccessFetchOptions
): Promise<Response> => {
  const fetchImpl = options.fetch ?? fetch;
  const headers = await accessRequestHeaders(init.headers, options);

  return fetchImpl(input, { redirect: "manual", ...init, headers });
};

/** True when Access turned the request away instead of passing it to the origin. */
export const isAccessRejection = (response: Response): boolean => {
  if (response.status === 401 || response.status === 403) {
    return true;
  }

  const location = response.headers.get("Location") ?? "";

  return (
    response.status >= 300 &&
    response.status < 400 &&
    location.includes("/cdn-cgi/access/login")
  );
};
