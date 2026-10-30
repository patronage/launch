import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// This regression deliberately runs outside the Vite/Vitest worker runtime.
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

const moduleUrl = new URL("../src/lib/payload-config.ts", import.meta.url);

// oxlint-disable-next-line vitest/prefer-importing-vitest-globals
test("route registration does not load Payload configuration or request bindings", () => {
  const source = `
    import assert from 'node:assert/strict';
    const { payloadRoute } = await import(${JSON.stringify(moduleUrl.href)});
    let initialized = false;
    const handler = payloadRoute(() => {
      initialized = true;
      return () => new Response('ok');
    });
    assert.equal(initialized, false);
    assert.equal(typeof handler, 'function');
  `;

  // No Vite alias or cloudflare:workers shim exists in this process. An eager
  // config import fails, just as a remote startup with no request bindings does.
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: "" },
    }
  );

  assert.equal(result.status, 0, result.stderr);
});

// oxlint-disable-next-line vitest/prefer-importing-vitest-globals
test("portable password hashing matches Node at Payload's production cost", async () => {
  const { pbkdf2: native } = await import("node:crypto");
  const { promisify } = await import("node:util");
  const { pbkdf2: portable } = await import("../src/lib/worker-crypto.ts");

  const expected = await promisify(native)(
    "invented-password",
    "invented-salt",
    600_000,
    32,
    "sha256"
  );

  const actual = await promisify(portable)(
    "invented-password",
    "invented-salt",
    600_000,
    32,
    "sha256"
  );

  assert.deepEqual(actual, expected);
});
