/** A ScriptContext for tests: records commands and output, fakes the API. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScriptContext, SpawnOptions, SpawnResult } from "./script.ts";
import { BUILT_WORKER_CONFIG } from "./worker-config.ts";
import type { WorkerConfig } from "./worker-config.ts";

export interface SpawnCall extends SpawnOptions {
  args: readonly string[];
  command: string;
}

export interface FetchCall {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface TestContext extends ScriptContext {
  fetchCalls: FetchCall[];
  logs: string[];
  spawnCalls: SpawnCall[];
  warnings: string[];
}

export interface TestContextOptions {
  argv?: string[];
  env?: Record<string, string>;
  /** Answers each API call in turn; a thrown error is a network failure. */
  responses?: (() => Response)[];
  root?: string;
  /** Exit status for each command, matched by its text. Default 0. */
  status?: (call: SpawnCall) => SpawnResult;
}

/** A Cloudflare API response envelope. */
export interface ApiEnvelope {
  errors?: { code: number; message?: string }[];
  result?: unknown;
  success: boolean;
}

export const jsonResponse = (body: ApiEnvelope, status = 200) =>
  Response.json(body, { status });

export const testContext = ({
  argv = [],
  env = {},
  responses = [],
  root = "/repo/apps/site",
  status = () => ({ status: 0 }),
}: TestContextOptions = {}): TestContext => {
  const fetchCalls: FetchCall[] = [];
  const logs: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const warnings: string[] = [];
  const queue = [...responses];

  return {
    argv,
    env,
    fetch: (input, init) => {
      fetchCalls.push({
        body: init?.body?.toString(),
        headers: Object.fromEntries(new Headers(init?.headers)),
        method: init?.method ?? "GET",
        url: String(input),
      });

      const next = queue.shift();

      if (!next) {
        return Promise.reject(new Error("Unexpected API call"));
      }

      try {
        return Promise.resolve(next());
      } catch (error) {
        return Promise.reject(error);
      }
    },
    fetchCalls,
    log: (line) => logs.push(line),
    logs,
    root,
    spawn: (command, args, options) => {
      const call = { ...options, args, command };
      spawnCalls.push(call);

      return status(call);
    },
    spawnCalls,
    warn: (line) => warnings.push(line),
    warnings,
  };
};

/**
 * A repo in a temp folder with one app whose Build Output declares `config`,
 * as `vite build` would leave it.
 */
export const fakeRepo = (config: WorkerConfig) => {
  const repo = mkdtempSync(path.join(tmpdir(), "worker-scripts-"));
  const app = path.join(repo, "apps", "site");
  const built = path.join(app, BUILT_WORKER_CONFIG);

  mkdirSync(path.dirname(built), { recursive: true });
  writeFileSync(built, JSON.stringify(config));
  writeFileSync(path.join(app, "package.json"), '{"name":"@launch/site"}');
  writeFileSync(
    path.join(repo, "package.json"),
    '{"packageManager":"pnpm@12.16.1"}'
  );
  writeFileSync(path.join(repo, ".nvmrc"), "24\n");

  return app;
};
