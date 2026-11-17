// Self-test for the launch-verify helper. Starts nothing but stub processes:
//   node --test .agents/skills/launch-verify/scripts/verify.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
// The helper's self-test runs without vitest, on Node's own runner.
/* oxlint-disable vitest/no-import-node-test, vitest/prefer-importing-vitest-globals */
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  mintAccessJwt,
  STANDIN_AUDIENCE,
  standinIssuer,
} from "./access-standin.ts";
import {
  cleanup,
  isLocalUrl,
  launch,
  parseEnvFile,
  parseReceipt,
  portInUse,
  probe,
  secretFileNames,
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

describe("gateway environment safety", () => {
  const secrets = new Map([
    ["APPROVAL_CSRF_SECRET", "a"],
    ["PAYLOAD_ACCESS_PROOF_SECRET", "b"],
  ]);

  it("needs both secrets in the gateway's active secret file", () => {
    assert.deepEqual(unsafeEnvironment("mcp", [secrets], {}, secrets), []);
    assert.equal(unsafeEnvironment("mcp", [], {}).length, 2);
    // A secret in the shell or in a file the Worker doesn't read doesn't
    // count: a local Worker reads secrets from its one active file only.
    assert.equal(
      unsafeEnvironment("mcp", [secrets], {
        APPROVAL_CSRF_SECRET: "a",
        PAYLOAD_ACCESS_PROOF_SECRET: "b",
      }).length,
      2
    );
  });

  it("reads the mode's secret file before .dev.vars", () => {
    assert.deepEqual(secretFileNames("mcp"), [
      ".dev.vars.development",
      ".dev.vars",
    ]);
    assert.deepEqual(secretFileNames("payload"), [
      ".dev.vars.production",
      ".dev.vars",
    ]);
  });

  it("refuses a hosted Payload, WordPress or Access team", () => {
    for (const name of [
      "ACCESS_TEAM_DOMAIN",
      "PAYLOAD_ADMIN_URL",
      "PAYLOAD_API_URL",
      "WORDPRESS_API_URL",
    ]) {
      assert.equal(
        unsafeEnvironment(
          "mcp",
          [secrets],
          { [name]: "https://cms.example.org" },
          secrets
        ).length,
        1,
        name
      );
      assert.equal(
        unsafeEnvironment(
          "mcp",
          [secrets, new Map([[name, "https://cms.example.org"]])],
          {},
          secrets
        ).length,
        1,
        name
      );
    }
  });

  it("refuses service tokens and a Worker binding to Payload", () => {
    for (const name of [
      "PAYLOAD_ACCESS_CLIENT_ID",
      "PAYLOAD_ACCESS_CLIENT_SECRET",
      "PAYLOAD_WORKER",
      "WORDPRESS_ACCESS_CLIENT_ID",
      "WORDPRESS_ACCESS_CLIENT_SECRET",
    ]) {
      assert.equal(
        unsafeEnvironment("mcp", [secrets], { [name]: "x" }, secrets).length,
        1,
        name
      );
    }
  });
});

const decodeJwtPart = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));

describe("Access stand-in", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-verify-access-"));
  const keyFile = path.join(dir, "key.json");
  let port = 0;
  let child: ReturnType<typeof spawn> | undefined;

  const certs = async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/cdn-cgi/access/certs`
    );

    return response;
  };

  before(async () => {
    const probeServer = createServer();

    probeServer.listen(0, "127.0.0.1");
    await once(probeServer, "listening");
    // SAFETY: a server listening on TCP reports an AddressInfo, never a pipe name.
    ({ port } = probeServer.address() as AddressInfo);
    probeServer.close();
    await once(probeServer, "close");

    child = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "access-standin.ts"),
        String(port),
        keyFile,
      ],
      { stdio: "ignore" }
    );

    /* oxlint-disable no-await-in-loop -- one attempt at a time, until it listens. */
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await certs();

        if (response.ok) {
          return;
        }
      } catch {
        // Not listening yet.
      }

      await sleep(100);
    }
    /* oxlint-enable no-await-in-loop */

    throw new Error("The Access stand-in never served its keys.");
  });

  after(() => {
    child?.kill("SIGKILL");
    rmSync(dir, { force: true, recursive: true });
  });

  it("signs a JWT its served key verifies", async () => {
    const token = mintAccessJwt({
      email: "editor@example.test",
      keyFile,
      port,
    });

    const [header = "", claims = "", signature = ""] = token.split(".");
    const response = await certs();
    const { keys } = await response.json();
    const [jwk] = keys;

    assert.equal(keys.length, 1);
    assert.equal(decodeJwtPart(header).kid, jwk.kid);
    assert.equal(decodeJwtPart(header).alg, "RS256");
    assert.ok(!("d" in jwk), "the served key has no private half");

    assert.ok(
      createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(
          createPublicKey({ format: "jwk", key: jwk }),
          Buffer.from(signature, "base64url")
        )
    );

    const payload = decodeJwtPart(claims);

    assert.deepEqual(payload.aud, [STANDIN_AUDIENCE]);
    assert.equal(payload.email, "editor@example.test");
    assert.equal(payload.iss, standinIssuer(port));
    assert.ok(payload.exp > Date.now() / 1000);
  });

  it("serves nothing else", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);

    assert.equal(response.status, 404);
  });
});

describe("receipts", () => {
  it("keeps the Access issuer a server was started against", () => {
    const receipt: Receipt = {
      accessIssuer: "http://127.0.0.1:8799",
      appDir: "/tmp/app",
      command: ["pnpm", "dev"],
      log: "/tmp/app/server.log",
      pid: 1,
      port: 8787,
      startedAt: new Date().toISOString(),
      surface: "mcp",
      token: "t",
    };

    assert.equal(
      parseReceipt(JSON.stringify(receipt))?.accessIssuer,
      "http://127.0.0.1:8799"
    );
  });

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
