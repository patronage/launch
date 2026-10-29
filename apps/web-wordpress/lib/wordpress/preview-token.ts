/**
 * Verifies the preview tokens the patronage-headless theme puts in WordPress's
 * Preview links: base64url("<postId>.<expires>") "." base64url(HMAC-SHA256),
 * signed with HEADLESS_SECRET. Web Crypto only, so it runs on Workers.
 */

const PAYLOAD = /^(?<postId>\d+)\.(?<expires>\d+)$/u;

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};

/** The post ID the token was issued for, or null when it is forged, malformed or expired. */
export const verifyPreviewToken = async (
  token: string,
  secret: string,
  now = Date.now()
): Promise<number | null> => {
  const [payloadPart, signaturePart] = token.split(".");

  if (!(secret && payloadPart && signaturePart)) {
    return null;
  }

  let payload: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;

  try {
    payload = fromBase64Url(payloadPart);
    signature = fromBase64Url(signaturePart);
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"]
  );

  // subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, signature, payload))) {
    return null;
  }

  const groups = PAYLOAD.exec(new TextDecoder().decode(payload))?.groups;

  if (!groups) {
    return null;
  }

  return Number(groups.expires) * 1000 > now ? Number(groups.postId) : null;
};
