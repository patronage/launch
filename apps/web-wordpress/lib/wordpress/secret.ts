/**
 * Compares a presented shared secret with the configured one without leaking
 * timing: both are run through HMAC under the configured secret, and
 * `subtle.verify` compares the two MACs in constant time.
 */
export const secretMatches = async (
  presented: string | null,
  secret: string
): Promise<boolean> => {
  if (!(presented && secret)) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );

  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(secret)
  );

  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(presented));
};
