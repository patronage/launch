import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { prepareReviewContext } from "./context.mjs";
import { prepareSnapshot } from "./snapshot.mjs";

const workspace = path.resolve(import.meta.dirname, "..");
const root = path.resolve(workspace, "..");
const [action, argument, fileList, ...unexpected] = process.argv.slice(2);

const actions = new Set([
  "start",
  "login",
  "status",
  "process",
  "revalidate",
  "export",
  "stop",
]);

if (
  !actions.has(action) ||
  unexpected.length > 0 ||
  (fileList && action !== "process")
) {
  throw new Error(
    "Usage: pnpm security:subscription start [commit] | <login|status|process|revalidate|export|stop> <run-directory>"
  );
}

// The CONNECT allowlist does not enforce TLS SNI/HTTP authority inside the
// tunnel. Shared upstream IPs can reach other origins, so this route must not
// create a runner, inspect credentials or resume a guest until it is repaired.
// Keep stop available to remove sessions created by earlier versions.
if (action !== "stop") {
  throw new Error(
    "Model-backed review is disabled: the subscription proxy does not enforce the TLS upstream-name boundary. Only security:subscription stop <run-directory> is available for cleanup. Use security:scan for candidate discovery."
  );
}

const docker = (args, options = {}) =>
  execFileSync("docker", args, { encoding: "utf-8", ...options });

const inspect = (id) => JSON.parse(docker(["inspect", id]))[0];

// Resolve paths in the guest's filesystem, never through guest-controlled
// symlinks on the host's writable data mount.
const writeGuestFiles = (runner, files) =>
  docker(
    [
      "exec",
      "--interactive",
      runner,
      "node",
      "--input-type=module",
      "--eval",
      `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
for (const [relative, content] of Object.entries(JSON.parse(readFileSync(0, "utf-8")))) {
  const file = path.join("/scanner/data", relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}`,
    ],
    { input: JSON.stringify(files) }
  );

const uid = process.getuid();
const gid = process.getgid();

assert.notEqual(uid, 0, "Run as a non-root user.");

const safeOptions = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit=256",
  "--memory=8g",
  "--cpus=4",
  "--user",
  `${uid}:${gid}`,
];

const save = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const verifySource = (run) => {
  const manifest = JSON.parse(
    readFileSync(path.join(run, "manifest.json"), "utf-8")
  );

  const source = path.join(run, "source");

  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);

      return entry.isDirectory() ? walk(file) : [path.relative(source, file)];
    });

  assert.deepEqual(
    walk(source).toSorted(),
    manifest.files.map((entry) => entry.path).toSorted()
  );

  for (const entry of manifest.files) {
    const file = path.join(source, entry.path);
    assert.equal(lstatSync(file).isSymbolicLink(), entry.mode === "120000");

    const bytes =
      entry.mode === "120000"
        ? Buffer.from(readlinkSync(file))
        : readFileSync(file);

    assert.equal(
      createHash(manifest.algorithm)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
      entry.hash,
      entry.path
    );
  }

  return manifest;
};

const attest = (run, state) => {
  const runner = inspect(state.runner);
  const proxy = inspect(state.proxy);
  assert.equal(runner.Image, state.image);
  assert.equal(proxy.Image, state.image);

  for (const container of [runner, proxy]) {
    assert.equal(container.Config.User, `${uid}:${gid}`);
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.HostConfig.Privileged, false);
    assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
    assert.ok(
      container.HostConfig.SecurityOpt.includes("no-new-privileges:true")
    );
    assert.equal(container.State.Running, true);
    assert.ok(
      !container.Config.Env.some((value) =>
        /(?:API_KEY|AUTH_TOKEN|VERCEL_TOKEN)=/u.test(value)
      )
    );
  }

  assert.deepEqual(Object.keys(runner.NetworkSettings.Networks), [
    state.scanNetwork,
  ]);
  assert.deepEqual(
    Object.keys(proxy.NetworkSettings.Networks).toSorted(),
    [state.scanNetwork, state.outboundNetwork].toSorted()
  );

  const [network] = JSON.parse(
    docker(["network", "inspect", state.scanNetwork])
  );

  assert.equal(network.Internal, true);
  assert.equal(proxy.Mounts.length, 0);
  assert.equal(runner.Mounts.length, 2);

  for (const [destination, source, writable] of [
    ["/repo", path.join(run, "source"), false],
    ["/scanner/data", path.join(run, "data"), true],
  ]) {
    const mount = runner.Mounts.find(
      (entry) => entry.Destination === destination
    );

    assert.equal(mount?.Type, "bind");
    assert.equal(mount.Source, source);
    assert.equal(mount.RW, writable);
  }

  assert.ok(runner.HostConfig.Tmpfs["/session"].includes("mode=0700"));
  assert.ok(runner.Config.Env.includes("CODEX_HOME=/session"));
  assert.ok(
    runner.Config.Env.includes(
      "NODE_OPTIONS=--import=/scanner/runner/proxy-env.mjs"
    )
  );
  verifySource(run);
  save(path.join(run, "subscription-containment.json"), { proxy, runner });
};

const teardown = (state) => {
  const failures = [];

  for (const container of [state.runner, state.proxy].filter(Boolean)) {
    const result = spawnSync("docker", ["rm", "--force", container], {
      stdio: "ignore",
    });

    if (result.error || result.status !== 0) {
      failures.push(`container ${container}`);
    }
  }

  for (const network of [state.scanNetwork, state.outboundNetwork].filter(
    Boolean
  )) {
    const result = spawnSync("docker", ["network", "rm", network], {
      stdio: "ignore",
    });

    if (result.error || result.status !== 0) {
      failures.push(`network ${network}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    `Cleanup could not remove: ${failures.join(", ")}. Inspect Docker before considering the session removed.`
  );
};

if (action === "start") {
  if (argument?.startsWith("-")) {
    throw new Error("Expected a commit, not an option.");
  }

  const run = path.join(
    workspace,
    "runs",
    `subscription-${new Date().toISOString().replaceAll(":", "-")}`
  );

  mkdirSync(run, { recursive: true });
  const manifest = prepareSnapshot(root, run, argument);
  mkdirSync(path.join(run, "data"));
  prepareReviewContext(run);
  docker(
    ["build", "--pull", "--iidfile", path.join(run, "image-id"), workspace],
    { stdio: "inherit" }
  );

  const image = inspect(
    readFileSync(path.join(run, "image-id"), "utf-8").trim()
  ).Id;

  const name = `launch-deepsec-${createHash("sha256").update(run).digest("hex").slice(0, 12)}`;

  const state = {
    commit: manifest.commit,
    image,
    outboundNetwork: `${name}-outbound`,
    scanNetwork: `${name}-scan`,
  };

  try {
    docker(["network", "create", "--internal", state.scanNetwork]);
    docker(["network", "create", state.outboundNetwork]);
    state.proxy = docker([
      "create",
      ...safeOptions,
      "--network",
      state.outboundNetwork,
      "--entrypoint",
      "node",
      image,
      "/scanner/runner/egress.mjs",
    ]).trim();
    docker([
      "network",
      "connect",
      "--alias",
      "model-egress",
      state.scanNetwork,
      state.proxy,
    ]);
    docker(["start", state.proxy]);
    state.runner = docker([
      "run",
      "--detach",
      ...safeOptions,
      "--network",
      state.scanNetwork,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev",
      "--tmpfs",
      `/session:rw,noexec,nosuid,nodev,mode=0700,uid=${uid},gid=${gid}`,
      "--env",
      "CODEX_HOME=/session",
      "--env",
      "HOME=/session",
      "--env",
      "NODE_OPTIONS=--import=/scanner/runner/proxy-env.mjs",
      "--env",
      "DEEPSEC_INSIDE_SANDBOX=1",
      "--mount",
      `type=bind,source=${path.join(run, "source")},target=/repo,readonly`,
      "--mount",
      `type=bind,source=${path.join(run, "data")},target=/scanner/data`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "setInterval(() => {}, 60000)",
    ]).trim();
    attest(run, state);
    save(path.join(run, "subscription.json"), state);
    docker(
      [
        "exec",
        state.runner,
        "node",
        "/scanner/node_modules/deepsec/dist/cli.mjs",
        "scan",
        "--project-id",
        "launch",
        "--root",
        "/repo",
      ],
      { stdio: "inherit" }
    );
    console.log(
      `Subscription runner ready for ${manifest.commit}.\nRun: ${run}\nNext: pnpm security:subscription login ${run}`
    );
  } catch (error) {
    teardown(state);
    throw error;
  }
} else {
  assert.ok(argument, "A run directory is required.");
  const run = path.resolve(argument);
  assert.equal(path.dirname(run), path.join(workspace, "runs"));

  const state = JSON.parse(
    readFileSync(path.join(run, "subscription.json"), "utf-8")
  );

  if (action === "stop") {
    try {
      docker(
        [
          "exec",
          state.runner,
          "node",
          "/scanner/node_modules/@openai/codex/bin/codex.js",
          "logout",
        ],
        { stdio: "inherit" }
      );
    } finally {
      teardown(state);
    }

    console.log(
      "Disposable login and containers removed; findings remain in data/."
    );
  } else {
    attest(run, state);
    const codex = "/scanner/node_modules/@openai/codex/bin/codex.js";

    if (action === "login" || action === "status") {
      docker(
        [
          "exec",
          "--interactive",
          state.runner,
          "node",
          codex,
          "login",
          ...(action === "login" ? ["--device-auth"] : ["status"]),
        ],
        { stdio: "inherit" }
      );
    } else {
      prepareReviewContext(run, (files) =>
        writeGuestFiles(state.runner, files)
      );

      // Send only the reviewed, credential-free launcher code to the guest.
      // This also permits fixing the launcher without replacing a live device login.
      const preload = readFileSync(
        path.join(workspace, "runner/proxy-env.mjs")
      );

      writeFileSync(path.join(run, "proxy-env.mjs"), preload);

      const args = [
        "exec",
        "--env",
        `NODE_OPTIONS=--import=data:text/javascript;base64,${preload.toString("base64")}`,
        state.runner,
        "node",
        "/scanner/node_modules/deepsec/dist/cli.mjs",
        action,
        "--project-id",
        "launch",
      ];

      if (action === "export") {
        args.push(
          "--format",
          "md-dir",
          "--include-resolved",
          "--out",
          "/scanner/data/exported-findings"
        );
      } else {
        const authStatus = spawnSync(
          "docker",
          ["exec", state.runner, "node", codex, "login", "status"],
          { encoding: "utf-8" }
        );

        assert.equal(
          authStatus.status,
          0,
          "Sign in to the disposable subscription runner first."
        );
        assert.match(
          `${authStatus.stdout}${authStatus.stderr}`,
          /Logged in using ChatGPT/u,
          "A ChatGPT subscription login is required; API-key authentication is refused."
        );

        if (fileList) {
          const listPath = path.resolve(fileList);
          assert.equal(
            path.dirname(listPath),
            run,
            "The review manifest must live directly in the run directory, outside guest-writable data."
          );
          assert.ok(
            lstatSync(listPath).isFile(),
            "The review manifest must be a regular file."
          );
          const files = JSON.parse(readFileSync(listPath, "utf-8"));
          assert.ok(
            Array.isArray(files) && files.length > 0 && files.length <= 4,
            "Direct review accepts one to four files."
          );

          const tracked = new Set(
            verifySource(run).files.map((entry) => entry.path)
          );

          for (const file of files) {
            assert.ok(
              tracked.has(file),
              "Every selected file must belong to the verified source snapshot."
            );
          }

          assert.equal(
            new Set(files).size,
            files.length,
            "Repeated review paths are not allowed."
          );
          const content = `${files.join("\n")}\n`;
          const name = `review-${createHash("sha256").update(content).digest("hex")}.txt`;
          writeGuestFiles(state.runner, { [name]: content });
          args.push("--files-from", `/scanner/data/${name}`);
        }

        args.push(
          "--root",
          "/repo",
          "--agent",
          "codex",
          "--model",
          "gpt-6-astra",
          "--thinking-level",
          "xhigh",
          "--concurrency",
          "1",
          "--batch-size",
          "4",
          "--limit",
          "4",
          "--max-turns",
          "30"
        );
      }

      docker(args, { stdio: "inherit" });
    }
  }
}
