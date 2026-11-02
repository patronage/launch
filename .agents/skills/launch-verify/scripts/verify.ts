#!/usr/bin/env node
// launch-verify helper: start, check, capture and stop a local Launch front
// end that this run owns. Run from the repo root with Node 22.18 or later:
//
//   node .agents/skills/launch-verify/scripts/verify.ts --help
//
// It never deploys, never talks to a remote CMS, and only ever signals the
// process group it started itself, as recorded in its receipt.
//
// Steps run one after another on purpose (prepare, poll, probe, signal), so
// awaiting inside loops is the point here, not an accident.
/* oxlint-disable no-await-in-loop */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BrowserType } from "playwright";

import { DRIVES } from "./drive.ts";

export const SKILL_DIR = path.resolve(import.meta.dirname, "..");

export const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");

export type SurfaceName = "payload" | "web-wordpress";

export interface Surface {
  /** The app directory, relative to the repo root. */
  app: string;
  defaultPort: number;
  /** Commands run in the app directory before the server starts. */
  prepare: (port: number) => string[][];
  /** The long-running server command, run in the app directory. */
  start: (port: number) => string[];
  /** Read-only GETs that must answer 200 for Doctor to pass. */
  health: string[];
  /** Local files the surface needs, relative to the app directory. */
  requiredFiles: string[];
}

export const SURFACES: Record<SurfaceName, Surface> = {
  payload: {
    app: "apps/payload",
    defaultPort: 4173,
    health: ["/", "/news", "/admin"],
    // Migrations and the build both run every launch, so a stale build or an
    // unmigrated local D1 never gets verified by mistake. The seed is a
    // separate, explicit step (see SKILL.md).
    prepare: () => [
      ["pnpm", "payload", "migrate"],
      ["pnpm", "build"],
    ],
    requiredFiles: [".env", ".dev.vars"],
    start: (port) => [
      "pnpm",
      "preview",
      "--port",
      String(port),
      "--strictPort",
    ],
  },
  "web-wordpress": {
    app: "apps/web-wordpress",
    defaultPort: 3000,
    health: ["/", "/about"],
    prepare: () => [["pnpm", "codegen"]],
    requiredFiles: [".env.local"],
    start: (port) => [
      "pnpm",
      "exec",
      "vite",
      "dev",
      "--port",
      String(port),
      "--strictPort",
    ],
  },
};

export const isSurfaceName = (value: string): value is SurfaceName =>
  value === "payload" || value === "web-wordpress";

export interface Receipt {
  surface: SurfaceName;
  pid: number;
  port: number;
  /** The real path of the app directory the process runs in. */
  appDir: string;
  command: string[];
  token: string;
  startedAt: string;
  log: string;
}

export const stateDir = (surface: SurfaceName): string =>
  path.join(
    process.env.VERIFY_STATE_DIR ?? path.join(SKILL_DIR, ".state"),
    surface
  );

export const evidenceRoot = (): string =>
  process.env.VERIFY_EVIDENCE_DIR ?? path.join(SKILL_DIR, "evidence");

const receiptPath = (surface: SurfaceName): string =>
  path.join(stateDir(surface), "run.json");

// The receipt is this helper's own JSON file; this is its parse boundary.
/* oxlint-disable anti-slop/no-runtime-typeof */
export const parseReceipt = (text: string): Receipt | null => {
  try {
    const value: Partial<Receipt> = JSON.parse(text);

    if (
      typeof value.pid === "number" &&
      typeof value.port === "number" &&
      typeof value.appDir === "string" &&
      typeof value.token === "string" &&
      typeof value.log === "string" &&
      Array.isArray(value.command) &&
      typeof value.surface === "string" &&
      isSurfaceName(value.surface)
    ) {
      // SAFETY: every Receipt field was checked just above.
      return value as Receipt;
    }
  } catch {
    // An unreadable receipt is treated as no receipt, never as permission.
  }

  return null;
};
/* oxlint-enable anti-slop/no-runtime-typeof */

const readReceipt = (surface: SurfaceName): Receipt | null =>
  existsSync(receiptPath(surface))
    ? parseReceipt(readFileSync(receiptPath(surface), "utf-8"))
    : null;

// --- Environment safety -----------------------------------------------------

/** Reads KEY=value lines; enough for the repo's .env files. */
export const parseEnvFile = (text: string): Map<string, string> => {
  const values = new Map<string, string>();

  for (const line of text.split("\n")) {
    const match = /^\s*(?<key>[A-Z0-9_]+)\s*=\s*(?<value>.*?)\s*$/u.exec(line);

    if (match?.groups?.key) {
      values.set(
        match.groups.key,
        (match.groups.value ?? "").replaceAll(/^["']|["']$/gu, "")
      );
    }
  }

  return values;
};

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "host.docker.internal",
]);

export const isLocalUrl = (value: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

/**
 * Reasons to refuse a launch: anything that would point the local front end
 * at a hosted CMS or hand it production credentials.
 */
export const unsafeEnvironment = (
  surface: SurfaceName,
  files: Map<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] => {
  const problems: string[] = [];
  const value = (name: string) => inherited[name] || files.get(name) || "";

  if (surface === "web-wordpress") {
    const url = value("WORDPRESS_URL");

    if (!(url && isLocalUrl(url))) {
      problems.push(
        `WORDPRESS_URL must be a local WordPress, not ${url || "unset"}`
      );
    }

    for (const name of [
      "WORDPRESS_ACCESS_CLIENT_ID",
      "WORDPRESS_ACCESS_CLIENT_SECRET",
    ]) {
      if (value(name)) {
        problems.push(`${name} is set; local WordPress runs without Access`);
      }
    }
  }

  if (surface === "payload") {
    if (value("PAYLOAD_DB") === "postgres") {
      problems.push("PAYLOAD_DB=postgres is not covered; use the local D1");
    }

    if (!value("PAYLOAD_SECRET")) {
      problems.push("PAYLOAD_SECRET is empty in apps/payload/.env");
    }
  }

  return problems;
};

const readEnvFiles = (surface: SurfaceName): Map<string, string> => {
  const merged = new Map<string, string>();
  const appDir = path.join(REPO_ROOT, SURFACES[surface].app);

  for (const file of SURFACES[surface].requiredFiles) {
    const full = path.join(appDir, file);

    if (existsSync(full)) {
      for (const [key, value] of parseEnvFile(readFileSync(full, "utf-8"))) {
        merged.set(key, value);
      }
    }
  }

  return merged;
};

// --- Processes ---------------------------------------------------------------

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** The working directory of a process, or null when it can't be read. */
const processCwd = (pid: number): string | null => {
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  const result = spawnSync(
    "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    {
      encoding: "utf-8",
    }
  );

  const line = result.stdout.split("\n").find((entry) => entry.startsWith("n"));

  return line ? line.slice(1) : null;
};

/** True only when the receipt's process is alive and runs in its app dir. */
export const ownsProcess = (receipt: Receipt): boolean =>
  isAlive(receipt.pid) && processCwd(receipt.pid) === receipt.appDir;

const portOpen = (port: number, host: string): Promise<boolean> =>
  // A socket's connect, timeout and error events have no promise API.
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve) => {
    const socket = connect({ host, port });

    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });

export const portInUse = async (port: number): Promise<boolean> =>
  (await portOpen(port, "127.0.0.1")) || (await portOpen(port, "::1"));

// --- HTTP ----------------------------------------------------------------------

export interface Probe {
  path: string;
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * GET a path on the local origin, following at most five redirects that stay
 * on that origin. A redirect anywhere else stops the probe before it is sent.
 */
export const probe = async (
  origin: string,
  pathname: string
): Promise<Probe> => {
  let url = new URL(pathname, origin);

  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(url, {
      headers: { "accept-encoding": "identity" },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });

    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);

      if (next.origin !== new URL(origin).origin) {
        throw new Error(
          `${pathname} redirects off the local origin to ${next.origin}`
        );
      }

      await response.body?.cancel();
      url = next;
      continue;
    }

    return {
      body: await response.text(),
      finalUrl: url.toString(),
      headers: Object.fromEntries(response.headers),
      path: pathname,
      status: response.status,
    };
  }

  throw new Error(`${pathname} redirects more than five times`);
};

// --- Commands ------------------------------------------------------------------

const origin = (port: number) => `http://localhost:${port}`;

const log = (...parts: unknown[]) => console.log(...parts);

const runStep = (command: string[], cwd: string, logFile: string): void => {
  const [file, ...args] = command;
  const fd = openSync(logFile, "a");

  writeFileSync(fd, `\n$ ${command.join(" ")}\n`);

  const result = spawnSync(file ?? "", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", fd, fd],
  });

  closeSync(fd);

  if (result.status !== 0) {
    throw new Error(`\`${command.join(" ")}\` failed; see ${logFile}`);
  }
};

const waitForReady = async (port: number, pid: number): Promise<boolean> => {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return false;
    }

    if (await portInUse(port)) {
      return true;
    }

    await sleep(1000);
  }

  return false;
};

export const doctor = async (
  surface: SurfaceName,
  port?: number
): Promise<boolean> => {
  const receipt = readReceipt(surface);
  const target = port ?? receipt?.port ?? SURFACES[surface].defaultPort;
  const lines: string[] = [];
  let ok = true;

  const check = (pass: boolean, line: string) => {
    ok &&= pass;
    lines.push(`${pass ? "PASS" : "FAIL"} ${line}`);
  };

  const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).stdout.trim();

  lines.push(`surface ${surface} on ${origin(target)}, checkout ${revision}`);

  const problems = unsafeEnvironment(
    surface,
    readEnvFiles(surface),
    process.env
  );

  check(
    problems.length === 0,
    `environment${problems.length ? `: ${problems.join("; ")}` : " is local"}`
  );

  if (receipt && receipt.port === target) {
    check(
      ownsProcess(receipt),
      `process ${receipt.pid} is owned by this checkout's receipt`
    );
  } else {
    check(
      false,
      "no receipt for this port: launch it first (a foreign server is never driven)"
    );
  }

  if (surface === "web-wordpress") {
    const wordpress = readEnvFiles(surface).get("WORDPRESS_URL") ?? "";

    try {
      const response = await fetch(new URL("/graphql", wordpress), {
        signal: AbortSignal.timeout(10_000),
      });

      check(
        response.status < 500,
        `WordPress GraphQL at ${wordpress} answers ${response.status}`
      );
      await response.body?.cancel();
    } catch {
      check(
        false,
        `WordPress at ${wordpress || "(unset)"} is down: pnpm --filter cms-wordpress-headless run setup`
      );
    }
  }

  for (const pathname of SURFACES[surface].health) {
    try {
      const result = await probe(origin(target), pathname);

      check(
        result.status === 200,
        `GET ${pathname} -> ${result.status} at ${new URL(result.finalUrl).pathname}`
      );
    } catch (error) {
      check(
        false,
        `GET ${pathname}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  log(lines.join("\n"));
  log(
    ok
      ? "Doctor: PASS"
      : "Doctor: FAIL (fix the first FAIL line, then run doctor again)"
  );

  return ok;
};

export const launch = async (
  surface: SurfaceName,
  port: number
): Promise<void> => {
  const spec = SURFACES[surface];
  const appDir = realpathSync(path.join(REPO_ROOT, spec.app));
  const existing = readReceipt(surface);

  if (existing && ownsProcess(existing)) {
    if (existing.port !== port) {
      throw new Error(
        `This checkout already runs ${surface} on port ${existing.port}; clean it up first.`
      );
    }

    log(`Reusing the owned ${surface} server (pid ${existing.pid}).`);
    await doctor(surface, port);

    return;
  }

  for (const file of spec.requiredFiles) {
    if (!existsSync(path.join(appDir, file))) {
      throw new Error(
        `${spec.app}/${file} is missing; see the Launch section of SKILL.md.`
      );
    }
  }

  const problems = unsafeEnvironment(
    surface,
    readEnvFiles(surface),
    process.env
  );

  if (problems.length > 0) {
    throw new Error(`Refusing to launch: ${problems.join("; ")}`);
  }

  if (await portInUse(port)) {
    throw new Error(
      `Port ${port} is taken by a process this run did not start. Pick another with --port.`
    );
  }

  mkdirSync(stateDir(surface), { recursive: true });
  const logFile = path.join(stateDir(surface), "server.log");

  writeFileSync(logFile, "");

  for (const step of spec.prepare(port)) {
    log(`$ ${step.join(" ")}`);
    runStep(step, appDir, logFile);
  }

  const command = spec.start(port);
  const [file, ...args] = command;
  const fd = openSync(logFile, "a");

  const child = spawn(file ?? "", args, {
    cwd: appDir,
    detached: true,
    env: process.env,
    stdio: ["ignore", fd, fd],
  });

  closeSync(fd);

  if (!child.pid) {
    throw new Error(`\`${command.join(" ")}\` did not start; see ${logFile}`);
  }

  const receipt: Receipt = {
    appDir,
    command,
    log: logFile,
    pid: child.pid,
    port,
    startedAt: new Date().toISOString(),
    surface,
    token: randomUUID(),
  };

  writeFileSync(receiptPath(surface), `${JSON.stringify(receipt, null, 2)}\n`);
  child.unref();

  if (!(await waitForReady(port, child.pid))) {
    throw new Error(
      `The server did not come up on port ${port}; see ${logFile}, then run cleanup.`
    );
  }

  log(
    `Started ${surface} at ${origin(port)} (pid ${child.pid}, log ${logFile}).`
  );
  await doctor(surface, port);
};

const newEvidenceDir = (surface: SurfaceName, name: string): string => {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");

  const dir = path.join(
    evidenceRoot(),
    `${stamp}-${surface}-${name.replaceAll(/[^\w-]/gu, "-")}`
  );

  mkdirSync(dir, { recursive: true });

  return dir;
};

const screenshot = async (url: string, file: string): Promise<string> => {
  // The repo's own Playwright, the one apps/payload's smoke test uses.
  const require = createRequire(
    path.join(REPO_ROOT, "apps/payload/package.json")
  );

  try {
    const { chromium }: { chromium: BrowserType } = require("playwright");

    const browser = await chromium.launch({
      executablePath: process.env.VERIFY_CHROMIUM || undefined,
    });

    try {
      const page = await browser.newPage({
        viewport: { height: 900, width: 1280 },
      });

      await page.goto(url, { waitUntil: "networkidle" });
      // Scroll through once so lazy images load before the full-page shot.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await sleep(100);
        }

        window.scrollTo(0, 0);
      });
      await page.waitForLoadState("networkidle");
      await page.screenshot({ fullPage: true, path: file });

      return `screenshot ${path.basename(file)}`;
    } finally {
      await browser.close();
    }
  } catch (error) {
    return `no screenshot (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); install Chromium with \`pnpm --filter payload exec playwright install chromium\` or set VERIFY_CHROMIUM`;
  }
};

const readFrom = (file: string, offset: number): string => {
  const { size } = statSync(file);

  if (size <= offset) {
    return "";
  }

  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");

  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);

  return buffer.toString("utf-8");
};

export const capture = async (
  surface: SurfaceName,
  pathname: string,
  name: string
): Promise<string> => {
  const receipt = readReceipt(surface);

  if (!(receipt && ownsProcess(receipt))) {
    throw new Error(`No owned ${surface} server to capture; launch it first.`);
  }

  const dir = newEvidenceDir(surface, name);
  const offset = statSync(receipt.log).size;
  const result = await probe(origin(receipt.port), pathname);

  writeFileSync(path.join(dir, "page.html"), result.body);

  const shot = await screenshot(
    result.finalUrl,
    path.join(dir, "screenshot.png")
  );

  // Give the Worker a moment to print the request's wide event.
  await sleep(500);
  writeFileSync(
    path.join(dir, "server-log.txt"),
    readFrom(receipt.log, offset)
  );

  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).stdout.trim();

  const summary = {
    checkout: revision,
    finalUrl: result.finalUrl,
    headers: result.headers,
    path: pathname,
    pid: receipt.pid,
    screenshot: shot,
    status: result.status,
    surface,
  };

  writeFileSync(
    path.join(dir, "response.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  log(`GET ${pathname} -> ${result.status}; ${shot}; evidence in ${dir}`);

  return dir;
};

export const drive = async (
  surface: SurfaceName,
  feature: string
): Promise<string> => {
  const receipt = readReceipt(surface);
  const run = DRIVES.get(surface)?.get(feature);

  if (!run) {
    throw new Error(
      `No drive "${feature}" for ${surface}. Drives: ${[...(DRIVES.get(surface)?.keys() ?? [])].join(", ")}`
    );
  }

  if (!(receipt && ownsProcess(receipt))) {
    throw new Error(`No owned ${surface} server to drive; launch it first.`);
  }

  const dir = newEvidenceDir(surface, feature);
  const offset = statSync(receipt.log).size;
  let failure: Error | null = null;

  try {
    await run({ dir, origin: origin(receipt.port), repoRoot: REPO_ROOT });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  writeFileSync(
    path.join(dir, "server-log.txt"),
    readFrom(receipt.log, offset)
  );
  log(`${failure ? "FAIL" : "PASS"} ${surface} ${feature}; evidence in ${dir}`);

  if (failure) {
    throw failure;
  }

  return dir;
};

export const cleanup = async (surface: SurfaceName): Promise<void> => {
  const receipt = readReceipt(surface);

  if (!receipt) {
    log(`No ${surface} receipt; nothing to stop.`);

    return;
  }

  if (!isAlive(receipt.pid)) {
    rmSync(receiptPath(surface));
    log(
      `The ${surface} server (pid ${receipt.pid}) already exited; receipt removed.`
    );

    return;
  }

  if (!ownsProcess(receipt)) {
    throw new Error(
      `pid ${receipt.pid} no longer runs in ${receipt.appDir}; refusing to signal it. Remove ${receiptPath(surface)} by hand once you've checked.`
    );
  }

  process.kill(-receipt.pid, "SIGTERM");

  for (let waited = 0; waited < 20 && isAlive(receipt.pid); waited += 1) {
    await sleep(500);
  }

  if (isAlive(receipt.pid) && ownsProcess(receipt)) {
    process.kill(-receipt.pid, "SIGKILL");
  }

  rmSync(receiptPath(surface));
  log(
    `Stopped ${surface} (process group ${receipt.pid}). Evidence and ${receipt.log} are kept.`
  );
};

const HELP = `Usage: node .agents/skills/launch-verify/scripts/verify.ts <command> <surface> [options]

Surfaces: payload (apps/payload, port 4173), web-wordpress (apps/web-wordpress, port 3000)

Commands:
  launch <surface> [--port N]      Prepare and start a server this run owns, then run doctor
  doctor <surface> [--port N]      Read-only check: environment, ownership, CMS, health routes
  capture <surface> <path> <name>  Save status, headers, HTML, a screenshot and the server log lines
  drive <surface> <feature>        Run a scripted browser drive (payload: pages, apply-form; web-wordpress: pages)
  cleanup <surface>                Stop only the process group in this surface's receipt
  status                           Show each surface's receipt

Environment: VERIFY_STATE_DIR, VERIFY_EVIDENCE_DIR, VERIFY_CHROMIUM (a Chromium binary)`;

const status = (): number => {
  for (const name of Object.keys(SURFACES)) {
    if (isSurfaceName(name)) {
      const receipt = readReceipt(name);

      const running =
        receipt && ownsProcess(receipt) ? "running" : "not running";

      log(
        receipt
          ? `${name}: pid ${receipt.pid} on port ${receipt.port}, ${running}`
          : `${name}: no receipt`
      );
    }
  }

  return 0;
};

const parsePort = (rest: string[]): number | undefined => {
  const index = rest.indexOf("--port");

  if (index === -1) {
    return undefined;
  }

  const port = Number(rest[index + 1]);

  if (!(Number.isInteger(port) && port > 0 && port < 65_536)) {
    throw new Error("--port takes a port number");
  }

  return port;
};

type Command = (surface: SurfaceName, rest: string[]) => Promise<number>;

const COMMANDS = new Map<string, Command>([
  [
    "launch",
    async (surface, rest) => {
      await launch(surface, parsePort(rest) ?? SURFACES[surface].defaultPort);

      return 0;
    },
  ],
  [
    "doctor",
    async (surface, rest) => ((await doctor(surface, parsePort(rest))) ? 0 : 1),
  ],
  [
    "capture",
    async (surface, [pathname, name]) => {
      if (!(pathname?.startsWith("/") && name)) {
        throw new Error("capture takes a path starting with / and a name");
      }

      await capture(surface, pathname, name);

      return 0;
    },
  ],
  [
    "drive",
    async (surface, [feature]) => {
      await drive(surface, feature ?? "");

      return 0;
    },
  ],
  [
    "cleanup",
    async (surface) => {
      await cleanup(surface);

      return 0;
    },
  ],
]);

const main = async (argv: string[]): Promise<number> => {
  const [command, surfaceArg, ...rest] = argv;

  if (command === "status") {
    return status();
  }

  const run = command ? COMMANDS.get(command) : undefined;

  if (!(run && surfaceArg && isSurfaceName(surfaceArg))) {
    log(HELP);

    return command && command !== "--help" && command !== "help" ? 2 : 0;
  }

  return await run(surfaceArg, rest);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
