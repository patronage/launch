/** Header carrying the proof that a gateway Worker sent a forwarded JWT. */
export const GATEWAY_PROOF_HEADER = "X-Access-Gateway-Proof";

/** Accepted distance between the proof timestamp and the verifier's clock. */
export const PROOF_SKEW_SECONDS = 300;

export type GatewayProofFailure =
  | "malformed_proof"
  | "stale_proof"
  | "proof_signature";

const encoder = new TextEncoder();
const PROOF = /^t=(?<timestamp>[0-9]{1,20}),v1=(?<signature>[0-9a-f]{64})$/u;

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmacKey = (
  secret: string,
  usage: "sign" | "verify"
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage]
  );

const fromHex = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  );

/**
 * Bind a forwarded JWT to the gateway that sent it:
 * `t=<unix>,v1=<hex hmac_sha256(secret, "<t>." + sha256_hex(jwt))>`.
 * A captured JWT alone cannot be replayed against the CMS from outside the
 * gateway, and a captured proof matches only that token for ±300 seconds.
 * The format is shared with the WordPress verifier in
 * `wordpress-shared/patronage-access`.
 */
export const computeGatewayProof = async (
  secret: string,
  jwt: string,
  nowSeconds: number = nowInSeconds()
): Promise<string> => {
  const message = `${nowSeconds}.${await sha256Hex(jwt)}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(message)
  );

  return `t=${nowSeconds},v1=${hex(signature)}`;
};

/** Verify a gateway proof. Returns `true` or a bounded failure reason. */
export const verifyGatewayProof = async (
  proof: string,
  jwt: string,
  secret: string,
  nowSeconds: number = nowInSeconds()
): Promise<true | GatewayProofFailure> => {
  const groups = PROOF.exec(proof)?.groups;
  const timestamp = groups?.timestamp;
  const signature = groups?.signature;

  if (!timestamp || !signature) {
    return "malformed_proof";
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > PROOF_SKEW_SECONDS) {
    return "stale_proof";
  }

  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    fromHex(signature),
    encoder.encode(`${timestamp}.${await sha256Hex(jwt)}`)
  );

  return valid ? true : "proof_signature";
};
