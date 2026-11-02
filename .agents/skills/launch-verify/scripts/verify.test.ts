// Self-test for the launch-verify helper. Starts nothing but stub processes:
//   node --test .agents/skills/launch-verify/scripts/verify.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// The helper's self-test runs without vitest, on Node's own runner.
/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals */
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  cleanup,
  isLocalUrl,
  launch,
  parseEnvFile,
  parseReceipt,
  portInUse,
  probe,
  unsafeEnvironment,
} from "./verify.ts";
import type { Receipt } from "./verify.ts";

const state = mkdtempSync(path.join(tmpdir(), "launch-verify-test-"));

process.env.VERIFY_STATE_DIR = state;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const writeReceipt = (receipt: Receipt) => {
  mkdirSync(path.join(state, receipt.surface), { recursive: true });
  writeFileSync(
    path.join(state, receipt.surface, "run.json"),
    JSON.stringify(receipt)
  );
};

describe("environment safety", () => {
  it("reads KEY=value files", () => {
    const values = parseEnvFile(
      'A=1\n# comment\nWORDPRESS_URL="http://localhost:8080"\nEMPTY=\n'
    );

    assert.equal(values.get("A"), "1");
    assert.equal(values.get("WORDPRESS_URL"), "http://localhost:8080");
    assert.equal(values.get("EMPTY"), "");
  });

  it("only treats loopback and the Docker host as local", () => {
    assert.ok(isLocalUrl("http://localhost:8080"));
    assert.ok(isLocalUrl("http://host.docker.internal:3000"));
    assert.ok(!isLocalUrl("https://cms.example.org"));
    assert.ok(!isLocalUrl("not a url"));
  });

  it("refuses a hosted WordPress and Access credentials", () => {
    const files = new Map([["WORDPRESS_URL", "http://localhost:8080"]]);

    assert.deepEqual(unsafeEnvironment("web-wordpress", [files], {}), []);
    assert.equal(
      unsafeEnvironment("web-wordpress", [files], {
        WORDPRESS_URL: "https://cms.example.org",
      }).length,
      1
    );
    // A hosted URL in any env file counts, even when another file is local.
    assert.equal(
      unsafeEnvironment(
        "web-wordpress",
        [files, new Map([["WORDPRESS_URL", "https://cms.example.org"]])],
        {}
      ).length,
      1
    );
    assert.equal(
      unsafeEnvironment("web-wordpress", [files], {
        WORDPRESS_ACCESS_CLIENT_ID: "id",
      }).length,
      1
    );
  });

  it("refuses Postgres and an empty Payload secret", () => {
    assert.equal(unsafeEnvironment("payload", [], {}).length, 1);
    assert.deepEqual(
      unsafeEnvironment("payload", [new Map([["PAYLOAD_SECRET", "x"]])], {}),
      []
    );
    assert.equal(
      unsafeEnvironment("payload", [new Map([["PAYLOAD_SECRET", "x"]])], {
        PAYLOAD_DB: "postgres",
      }).length,
      1
    );
  });
});

describe("receipts", () => {
  it("rejects malformed or foreign-surface receipts", () => {
    assert.equal(parseReceipt("not json"), null);
    assert.equal(
      parseReceipt(JSON.stringify({ pid: 1, surface: "other" })),
      null
    );
  });
});

describe("probe", () => {
  let origin = "";

  const server = createServer((request, response) => {
    if (request.url === "/hop") {
      response.writeHead(302, { location: "/done" }).end();
    } else if (request.url === "/away") {
      response.writeHead(302, { location: "https://example.org/" }).end();
    } else {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    }
  });

  const port = () => {
    // SAFETY: a server listening on TCP reports an AddressInfo, never a pipe name.
    const address = server.address() as AddressInfo;

    return address.port;
  };

  before(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${port()}`;
  });

  after(() => server.close());

  it("follows same-origin redirects", async () => {
    const result = await probe(origin, "/hop");

    assert.equal(result.status, 200);
    assert.equal(new URL(result.finalUrl).pathname, "/done");
  });

  it("refuses a protocol-relative path before fetching it", async () => {
    await assert.rejects(probe(origin, "//example.org/"), /not a path/u);
  });

  it("refuses a redirect off the local origin", async () => {
    await assert.rejects(probe(origin, "/away"), /off the local origin/u);
  });

  it("refuses to launch onto a port it didn't start", async () => {
    assert.ok(await portInUse(port()));
    await assert.rejects(launch("payload", port()), /taken|missing|Refusing/u);
  });
});

describe("cleanup", () => {
  it("stops the process group in its receipt", async () => {
    const dir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "launch-verify-app-"))
    );

    const child = spawn("sleep", ["60"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
    });

    child.unref();
    writeReceipt({
      appDir: dir,
      command: ["sleep", "60"],
      log: path.join(dir, "server.log"),
      pid: child.pid ?? 0,
      port: 1,
      startedAt: new Date().toISOString(),
      surface: "payload",
      token: "t",
    });
    writeFileSync(path.join(dir, "server.log"), "");

    await cleanup("payload");
    await sleep(200);
    assert.ok(!isAlive(child.pid ?? 0));
  });

  it("refuses a pid that runs somewhere else", async () => {
    const elsewhere = realpathSync(
      mkdtempSync(path.join(tmpdir(), "launch-verify-other-"))
    );

    const child = spawn("sleep", ["60"], {
      cwd: elsewhere,
      detached: true,
      stdio: "ignore",
    });

    child.unref();
    writeReceipt({
      appDir: path.join(elsewhere, "not-the-app"),
      command: ["sleep", "60"],
      log: path.join(elsewhere, "server.log"),
      pid: child.pid ?? 0,
      port: 1,
      startedAt: new Date().toISOString(),
      surface: "web-wordpress",
      token: "t",
    });

    try {
      await assert.rejects(cleanup("web-wordpress"), /refusing to signal/u);
      assert.ok(isAlive(child.pid ?? 0));
    } finally {
      process.kill(-(child.pid ?? 0), "SIGKILL");
    }
  });
});
