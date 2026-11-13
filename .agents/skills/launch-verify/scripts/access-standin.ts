#!/usr/bin/env node
// A stand-in for a Cloudflare Access team domain, for local runs only. It
// makes a signing key when it starts, serves the public half where Access
// serves its keys (`/cdn-cgi/access/certs`), and keeps the private half in a
// file beside its receipt so a drive can sign a JWT for a synthetic editor.
//
// It listens on 127.0.0.1 only, and a token it signs is trusted only by local
// servers started with this origin as their ACCESS_TEAM_DOMAIN.
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

interface StoredKey {
  jwk: JsonWebKey;
  /** New on every start, so verifiers that cached the last key fetch again. */
  kid: string;
}

/** The audience tag local servers are given for the gateway's application. */
export const STANDIN_AUDIENCE = "launch-verify-gateway";

/** The origin local servers use as their ACCESS_TEAM_DOMAIN. */
export const standinIssuer = (port: number): string =>
  `http://127.0.0.1:${port}`;

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString("base64url");

/**
 * Signs an Access-shaped JWT for one synthetic editor with the stand-in's
 * current key. A restarted stand-in has a new key, so sign per run.
 */
export const mintAccessJwt = (options: {
  email: string;
  keyFile: string;
  port: number;
}): string => {
  const stored: StoredKey = JSON.parse(readFileSync(options.keyFile, "utf-8"));
  const key = createPrivateKey({ format: "jwk", key: stored.jwk });
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(
    JSON.stringify({ alg: "RS256", kid: stored.kid, typ: "JWT" })
  );

  const claims = base64url(
    JSON.stringify({
      aud: [STANDIN_AUDIENCE],
      email: options.email,
      exp: now + 3600,
      iat: now,
      iss: standinIssuer(options.port),
      nonce: randomUUID(),
      sub: `launch-verify:${options.email}`,
      type: "app",
    })
  );

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(key);

  return `${header}.${claims}.${base64url(signature)}`;
};

const serve = (port: number, keyFile: string): void => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const stored: StoredKey = {
    jwk: privateKey.export({ format: "jwk" }),
    kid: `launch-verify-${randomUUID()}`,
  };

  writeFileSync(keyFile, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(keyFile, 0o600);

  const keys = JSON.stringify({
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        alg: "RS256",
        kid: stored.kid,
        use: "sig",
      },
    ],
  });

  // Loopback only, on both families: Workers fetch 127.0.0.1 and Doctor
  // probes localhost, which may resolve to ::1.
  for (const host of ["127.0.0.1", "::1"]) {
    createServer((request, response) => {
      if (request.method === "GET" && request.url === "/cdn-cgi/access/certs") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(keys);

        return;
      }

      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    })
      .once("error", (error) => {
        console.error(`Access stand-in could not listen on ${host}:`, error);
      })
      .listen(port, host, () => {
        console.log(`Access stand-in serving keys on ${host}:${port}`);
      });
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [portArgument, keyFile] = process.argv.slice(2);
  const port = Number(portArgument);

  if (Number.isInteger(port) && port > 0 && keyFile) {
    serve(port, keyFile);
  } else {
    console.error("Usage: access-standin.ts <port> <key-file>");
    process.exitCode = 2;
  }
}
