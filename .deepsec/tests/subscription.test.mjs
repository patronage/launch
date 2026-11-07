// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

const fixture = (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "launch-subscription-"))
  );

  t.after(() => rmSync(root, { force: true, recursive: true }));
  const scripts = path.join(root, ".deepsec/scripts");
  const run = path.join(root, ".deepsec/runs/existing");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.jsonl");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(run, { recursive: true });
  mkdirSync(bin);

  for (const file of ["subscription.mjs", "context.mjs", "snapshot.mjs"]) {
    copyFileSync(
      new URL(`../scripts/${file}`, import.meta.url),
      path.join(scripts, file)
    );
  }

  // Any execution is a local stub: neither these tests nor a regressed guard
  // can reach a real Docker engine or Git repository.
  for (const command of ["docker", "git"]) {
    writeFileSync(
      path.join(bin, command),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
process.exit(args[0] === "exec" ? Number(process.env.LOGOUT_EXIT || 0) : 0);
`,
      { mode: 0o755 }
    );
  }

  const denyEffects = path.join(root, "deny-effects.mjs");
  writeFileSync(
    denyEffects,
    `import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const sources = new Set(${JSON.stringify(["subscription.mjs", "context.mjs", "snapshot.mjs"].map((file) => path.join(scripts, file)))});
for (const [module, methods] of [
  [fs, ["readFileSync", "readdirSync", "readlinkSync", "lstatSync", "mkdirSync", "writeFileSync"]],
  [childProcess, ["execFileSync", "spawnSync"]],
]) {
  for (const method of methods) {
    const original = module[method];
    module[method] = (...args) => {
      const file = args[0] instanceof URL ? fileURLToPath(args[0]) : args[0];
      // The ESM loader must read these three source modules. All state,
      // credential, manifest and snapshot reads remain forbidden.
      if (method === "readFileSync" && sources.has(file)) return original(...args);
      throw new Error("Unexpected side effect: " + method);
    };
  }
}
syncBuiltinESMExports();
`
  );

  const execute = (args, { deny = false, logoutExit = 0 } = {}) =>
    spawnSync(
      process.execPath,
      [
        ...(deny ? ["--import", denyEffects] : []),
        path.join(scripts, "subscription.mjs"),
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf-8",
        env: { COMMAND_LOG: log, LOGOUT_EXIT: String(logoutExit), PATH: bin },
      }
    );

  return { execute, log, run };
};

test("disabled subscription actions fail before filesystem, credentials or external commands", (t) => {
  const { execute, log, run } = fixture(t);
  const manifest = path.join(run, "files.json");
  writeFileSync(
    path.join(run, "subscription.json"),
    "invalid state must not be read"
  );
  writeFileSync(manifest, "invalid manifest must not be read");

  for (const args of [
    ["start"],
    ["start", "HEAD"],
    ...["login", "status", "process", "revalidate", "export"].map((action) => [
      action,
      run,
    ]),
    ["process", run, manifest],
  ]) {
    const result = execute(args, { deny: true });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /Model-backed review is disabled/u);
    assert.match(result.stderr, /TLS upstream-name boundary/u);
    assert.doesNotMatch(result.stderr, /Unexpected side effect/u);
    assert.equal(result.stdout, "");
  }

  assert.equal(existsSync(log), false);
});

test("argument validation still rejects unsupported subscription actions before effects", (t) => {
  const { execute } = fixture(t);

  for (const args of [
    [],
    ["unknown"],
    ["stop", "run", "extra"],
    ["process", "run", "files", "extra"],
  ]) {
    const result = execute(args, { deny: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: pnpm security:subscription/u);
    assert.doesNotMatch(
      result.stderr,
      /Unexpected side effect|Model-backed review is disabled/u
    );
  }
});

test("stop retains container and network cleanup whether logout succeeds or fails", (t) => {
  for (const logoutExit of [0, 1]) {
    const { execute, log, run } = fixture(t);
    writeFileSync(
      path.join(run, "subscription.json"),
      JSON.stringify({
        outboundNetwork: "fixture-outbound",
        proxy: "fixture-proxy",
        runner: "fixture-runner",
        scanNetwork: "fixture-scan",
      })
    );
    const result = execute(["stop", run], { logoutExit });
    assert.equal(result.status, logoutExit, result.stderr);
    assert.doesNotMatch(result.stderr, /Model-backed review is disabled/u);
    assert.deepEqual(
      readFileSync(log, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        [
          "exec",
          "fixture-runner",
          "node",
          "/scanner/node_modules/@openai/codex/bin/codex.js",
          "logout",
        ],
        ["rm", "--force", "fixture-runner"],
        ["rm", "--force", "fixture-proxy"],
        ["network", "rm", "fixture-scan"],
        ["network", "rm", "fixture-outbound"],
      ]
    );
  }
});
