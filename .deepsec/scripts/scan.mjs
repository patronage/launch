import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { prepareReviewContext } from "./context.mjs";
import { prepareSnapshot } from "./snapshot.mjs";

const workspace = nodePath.resolve(import.meta.dirname, "..");
const root = nodePath.resolve(workspace, "..");
const args = process.argv.slice(2);

if (args.length > 1 || args[0]?.startsWith("-")) {
  throw new Error("Usage: pnpm security:scan [commit]");
}

const uid = process.getuid();
const gid = process.getgid();

assert.notEqual(uid, 0, "Run the scanner as a non-root user.");

const run = nodePath.join(
  workspace,
  "runs",
  new Date().toISOString().replaceAll(":", "-")
);

mkdirSync(run, { recursive: true });

const manifest = prepareSnapshot(root, run, args[0]);

console.log(
  `Reviewing ${manifest.commit}: ${manifest.files.length} committed files. Working-tree edits are excluded.`
);

const docker = (command, options = {}) =>
  execFileSync("docker", command, { encoding: "utf-8", ...options });

docker(
  ["build", "--pull", "--iidfile", nodePath.join(run, "image-id"), workspace],
  {
    stdio: "inherit",
  }
);

const image = readFileSync(nodePath.join(run, "image-id"), "utf-8").trim();
const data = nodePath.join(run, "data");

mkdirSync(data);

prepareReviewContext(run);

const source = nodePath.join(run, "source");

const container = docker([
  "create",
  "--network=none",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit=256",
  "--memory=8g",
  "--cpus=4",
  "--user",
  `${uid}:${gid}`,
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev",
  "--mount",
  `type=bind,source=${source},target=/repo,readonly`,
  "--mount",
  `type=bind,source=${data},target=/scanner/data`,
  image,
  "scan",
  "--project-id",
  "launch",
  "--root",
  "/repo",
]).trim();

try {
  const [inspection] = JSON.parse(docker(["inspect", container]));
  assert.equal(inspection.Config.User, `${uid}:${gid}`);
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert.equal(inspection.HostConfig.Privileged, false);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(
    inspection.HostConfig.SecurityOpt.includes("no-new-privileges:true")
  );
  assert.equal(inspection.Mounts.length, 2);

  for (const [target, path, writable] of [
    ["/repo", source, false],
    ["/scanner/data", data, true],
  ]) {
    const mount = inspection.Mounts.find((item) => item.Destination === target);
    assert.equal(mount?.Type, "bind");
    assert.equal(mount.Source, path);
    assert.equal(mount.RW, writable);
  }

  assert.ok(
    !inspection.Config.Env.some((value) =>
      /(?:TOKEN|SECRET|API_KEY|CREDENTIAL)=/u.test(value)
    )
  );
  writeFileSync(
    nodePath.join(run, "container.json"),
    `${JSON.stringify(inspection, null, 2)}\n`
  );

  let output;

  try {
    output = docker(["start", "--attach", container], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    writeFileSync(
      nodePath.join(run, "scan.log"),
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`
    );
    throw error;
  }

  writeFileSync(nodePath.join(run, "scan.log"), output);
  console.log(output);
  const state = JSON.parse(docker(["inspect", container]))[0].State;
  assert.equal(state.ExitCode, 0, "DeepSec scan failed; inspect scan.log.");
  writeFileSync(
    nodePath.join(run, "result.json"),
    `${JSON.stringify({ commit: manifest.commit, deepsec: "2.3.12", exitCode: state.ExitCode, image, modelAnalysis: false, phase: "scan" }, null, 2)}\n`
  );
  console.log(
    "Candidate discovery only: these are review leads, not findings. See .deepsec/README.md."
  );
} finally {
  docker(["rm", "--force", container]);
  console.log(`Evidence: ${run}`);
}
