// This module implements Node's callback API for an existing dependency.
/* oxlint-disable promise/prefer-await-to-callbacks, promise/no-callback-in-promise */
import crypto from "node:crypto";

import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

// BinaryLike is Node's public input contract; preserve the view's exact bytes.
const bytes = (value: Parameters<typeof crypto.pbkdf2>[0]) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  typeof value === "string"
    ? Buffer.from(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

// Workers caps native PBKDF2 at 100,000 iterations. Payload's current password
// scheme requires 600,000: keep its parameters and format with the portable
// implementation, rather than lowering the cost or modifying Node's global API.
export const pbkdf2: typeof crypto.pbkdf2 = (
  password,
  salt,
  iterations,
  keylen,
  digest,
  callback
) => {
  if (iterations <= 100_000 || digest.toLowerCase() !== "sha256") {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, callback);

    return;
  }

  const derive = async () => {
    let key;

    try {
      key = await pbkdf2Async(sha256, bytes(password), bytes(salt), {
        c: iterations,
        dkLen: keylen,
      });
    } catch (error) {
      callback(
        error instanceof Error ? error : new Error(String(error)),
        Buffer.alloc(0)
      );

      return;
    }

    callback(null, Buffer.from(key));
  };

  void derive();
};

export * from "node:crypto";

export default { ...crypto, pbkdf2 };
