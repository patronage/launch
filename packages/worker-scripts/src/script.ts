/**
 * What every Worker script runs on: the app folder, its arguments and
 * environment, and the commands and API calls it makes. Scripts take this as
 * a parameter so tests can run them without a shell or the network.
 */
import { spawnSync } from "node:child_process";

import type { z } from "zod";

/** A failure the script reports in one line before exiting with `exitCode`. */
export class ScriptError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ScriptError";
    this.exitCode = exitCode;
  }
}

export interface SpawnOptions {
  /**
   * Capture stdout and return it instead of printing it. Errors still go to
   * the terminal.
   */
  capture?: boolean;
  cwd: string;
  /** Added to the script's own environment. */
  env?: Record<string, string>;
  /**
   * Sent to the command's stdin. The command's output is then captured and
   * dropped instead of printed, because it can echo what it was sent.
   */
  input?: string;
}

export interface SpawnResult {
  error?: Error | undefined;
  status: number | null;
  /** The command's output, when it was run with `capture`. */
  stdout?: string;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => SpawnResult;

export interface ScriptContext {
  /** Command-line arguments after the script name. */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  log: (line: string) => void;
  /** The app folder, such as apps/payload. */
  root: string;
  spawn: Spawn;
  warn: (line: string) => void;
}

const spawnCommand: Spawn = (command, args, { capture, cwd, env, input }) => {
  if (capture) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });

    return {
      error: result.error,
      status: result.status,
      stdout: result.stdout,
    };
  }

  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    ...(input === undefined
      ? { stdio: "inherit" as const }
      : { encoding: "utf-8" as const, input }),
  });

  return { error: result.error, status: result.status };
};

export const nodeContext = (root: string): ScriptContext => ({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
  log: (line) => console.log(line),
  root,
  spawn: spawnCommand,
  warn: (line) => console.warn(line),
});

/** The command and its subcommands, without long or JSON arguments. */
const describe = (command: string, args: readonly string[]) =>
  [command, ...args.slice(0, 4).filter((arg) => !arg.startsWith("{"))].join(
    " "
  );

/**
 * Run a command with its output shown, and throw if it fails. The command
 * prints its own errors, so the thrown message only names it.
 */
export const run = (
  ctx: ScriptContext,
  command: string,
  args: readonly string[],
  env: Record<string, string> = {}
) => {
  const result = ctx.spawn(command, args, { cwd: ctx.root, env });

  if (result.error) {
    throw new ScriptError(
      `Could not run ${command}: ${result.error.message}`,
      1
    );
  }

  if (result.status !== 0) {
    throw new ScriptError(
      `${describe(command, args)} failed (exit ${result.status ?? "unknown"}).`,
      result.status ?? 1
    );
  }
};

/**
 * Run a command that prints JSON, such as a `cf` read, and return its output
 * parsed with `schema`. `what` names the step for the error message.
 */
export const runJson = <T>(
  ctx: ScriptContext,
  what: string,
  command: string,
  args: readonly string[],
  schema: z.ZodType<T>
): T => {
  const result = ctx.spawn(command, args, { capture: true, cwd: ctx.root });

  if (result.error || result.status !== 0) {
    throw new ScriptError(
      `${what} failed (exit ${result.status ?? "unknown"}).`,
      result.status || 1
    );
  }

  let output: unknown;

  try {
    output = JSON.parse(result.stdout ?? "");
  } catch {
    throw new ScriptError(`${what} did not return JSON.`);
  }

  const parsed = schema.safeParse(output);

  if (!parsed.success) {
    throw new ScriptError(`${what} returned an unexpected result.`);
  }

  return parsed.data;
};

/**
 * Run a command that receives secret values on stdin. Nothing it prints is
 * shown, including API errors that can echo the values; on failure the thrown
 * message has only `what` and the exit status.
 */
export const runWithSecrets = (
  ctx: ScriptContext,
  what: string,
  command: string,
  args: readonly string[],
  input: string
) => {
  const result = ctx.spawn(command, args, { cwd: ctx.root, input });

  if (result.error || result.status !== 0) {
    throw new ScriptError(
      `${what} failed (exit ${result.status ?? "unknown"}).`,
      result.status || 1
    );
  }
};

/**
 * Entry point for an app's script: run it with the real process, print a
 * ScriptError's message and exit with its code.
 */
export const main = async (
  root: string,
  script: (ctx: ScriptContext) => Promise<void> | void
) => {
  try {
    await script(nodeContext(root));
  } catch (error) {
    if (error instanceof ScriptError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }

    throw error;
  }
};
