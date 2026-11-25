// The bindings the EmDash connector reads.
export interface EmDashEnv {
  // A Service binding to the EmDash Worker. Set, it is used instead of
  // EMDASH_API_URL, and requests never cross the Access edge.
  EMDASH?: Fetcher;
  // Service token for the Access application in front of /_emdash/*, with
  // EMDASH_API_URL.
  EMDASH_ACCESS_CLIENT_ID?: string;
  EMDASH_ACCESS_CLIENT_SECRET?: string;
  // Signs the gateway proof EmDash checks before it trusts a forwarded JWT
  // (ACCESS_GATEWAY_PROOF_SECRET on the EmDash Worker). Required.
  EMDASH_ACCESS_PROOF_SECRET?: string;
  // The site's public origin, for "open in EmDash admin" links.
  EMDASH_ADMIN_URL?: string;
  // The site's origin, without /_emdash. HTTPS outside localhost.
  EMDASH_API_URL?: string;
}
