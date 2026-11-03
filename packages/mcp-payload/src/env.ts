// The bindings the Payload connector reads.
export interface PayloadEnv {
  // A Service binding to the Payload Worker. Set, it is used instead of
  // PAYLOAD_API_URL.
  PAYLOAD?: Fetcher;
  // Service token for Payload's Access application, with PAYLOAD_API_URL.
  PAYLOAD_ACCESS_CLIENT_ID?: string;
  PAYLOAD_ACCESS_CLIENT_SECRET?: string;
  // Signs the gateway proof Payload's `cloudflare-access-gateway` strategy
  // checks. Required.
  PAYLOAD_ACCESS_PROOF_SECRET?: string;
  // The public origin for "open in Payload admin" links.
  PAYLOAD_ADMIN_URL?: string;
  PAYLOAD_API_URL?: string;
}
