import { describe, expect, it } from "vitest";

import { deploy } from "./deploy.ts";
import { ScriptError } from "./script.ts";
import { fakeRepo, testContext } from "./test-context.ts";

const worker = {
  env: {
    API_KEY: { type: "secret" },
    DB: { type: "d1" },
    TOKEN: { type: "secret" },
  },
  name: "site",
};

const withSecrets = { previews: true, secrets: true };

describe(deploy, () => {
  it("builds then runs cf deploy --prebuilt when no secrets are set", () => {
    const ctx = testContext({ root: fakeRepo(worker) });

    deploy(ctx, withSecrets);

    expect(
      ctx.spawnCalls.map((call) => [call.command, ...call.args])
    ).toStrictEqual([
      ["pnpm", "run", "build"],
      ["pnpm", "exec", "cf", "deploy", "--prebuilt"],
    ]);
    expect(ctx.spawnCalls[0]?.env).toStrictEqual({
      CLOUDFLARE_PREVIEW_BUILD: "false",
    });
  });

  it("sends every secret through stdin, never in arguments or output", () => {
    const ctx = testContext({
      env: { API_KEY: "key-value", TOKEN: "token-value" },
      root: fakeRepo(worker),
    });

    deploy(ctx, withSecrets);

    const [, upload] = ctx.spawnCalls;
    expect(upload?.args).toStrictEqual([
      "exec",
      "cf",
      "deploy",
      "--prebuilt",
      "--secrets-file",
      "/dev/stdin",
    ]);
    expect(JSON.parse(upload?.input ?? "")).toStrictEqual({
      API_KEY: "key-value",
      TOKEN: "token-value",
    });
    expect(ctx.logs).toStrictEqual(["Deployed site; set API_KEY, TOKEN."]);
  });

  it("refuses a partial set of secrets before uploading", () => {
    const ctx = testContext({
      env: { API_KEY: "key-value" },
      root: fakeRepo(worker),
    });

    expect(() => deploy(ctx, withSecrets)).toThrow(
      "Missing secret values: TOKEN"
    );
    expect(ctx.spawnCalls).toHaveLength(1);
  });

  it("deploys a Preview with its base secrets, not the environment's", () => {
    const ctx = testContext({
      argv: ["--preview"],
      env: { API_KEY: "key-value", TOKEN: "token-value" },
      root: fakeRepo(worker),
    });

    deploy(ctx, withSecrets);

    expect(ctx.spawnCalls[0]?.env).toStrictEqual({
      CLOUDFLARE_PREVIEW_BUILD: "true",
    });
    expect(ctx.spawnCalls[1]?.args).toStrictEqual([
      "exec",
      "cf",
      "previews",
      "deploy",
      "--prebuilt",
    ]);
    expect(ctx.spawnCalls[1]?.input).toBeUndefined();
  });

  it("never passes secrets on a dry run", () => {
    const ctx = testContext({
      argv: ["--dry-run"],
      env: { API_KEY: "key-value", TOKEN: "token-value" },
      root: fakeRepo(worker),
    });

    deploy(ctx, withSecrets);

    expect(ctx.spawnCalls[1]?.args).toStrictEqual([
      "exec",
      "cf",
      "deploy",
      "--prebuilt",
      "--dry-run",
    ]);
    expect(ctx.spawnCalls[1]?.input).toBeUndefined();
  });

  it("refuses --preview for a Worker without Previews instead of deploying production", () => {
    const ctx = testContext({ argv: ["--preview"] });

    expect(() => deploy(ctx, { previews: false, secrets: true })).toThrow(
      ScriptError
    );
    expect(ctx.spawnCalls).toHaveLength(0);
  });

  it("stops when the build fails, with its exit status", () => {
    const ctx = testContext({ status: () => ({ status: 2 }) });

    expect(() => deploy(ctx, withSecrets)).toThrow(
      expect.objectContaining({ exitCode: 2 })
    );
    expect(ctx.spawnCalls).toHaveLength(1);
  });

  it("reports a failed upload without the values cf may echo", () => {
    const ctx = testContext({
      env: { API_KEY: "key-value", TOKEN: "token-value" },
      root: fakeRepo(worker),
      status: (call) => ({ status: call.input === undefined ? 0 : 1 }),
    });

    expect(() => deploy(ctx, withSecrets)).toThrow(
      "Deployment failed (exit 1)."
    );
  });

  it("runs the app's own build and checks", () => {
    const steps: string[] = [];
    const ctx = testContext({ argv: ["--preview"] });

    deploy(ctx, {
      beforeDeploy: (_, { preview }) => steps.push(`check ${preview}`),
      build: (_, { preview }) => steps.push(`build ${preview}`),
      previews: true,
      secrets: false,
    });

    expect(steps).toStrictEqual(["build true", "check true"]);
    expect(ctx.spawnCalls.map((call) => call.args.join(" "))).toStrictEqual([
      "exec cf previews deploy --prebuilt",
    ]);
  });
});
