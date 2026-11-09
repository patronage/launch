import type { GatewayEnv } from "./env";

// Test-only. A binding faked with just the members the code under test calls.
// Any other member is missing at runtime, so a test that starts reaching for
// one fails with a TypeError rather than passing against a fake it never set.
export const fakeBinding = <T extends object>(members: {
  [K in keyof T]?: (...args: never[]) => object | string;
}): T =>
  // SAFETY: Callers list the members their test reaches; see above.
  members as T;

// A `GatewayEnv` for tests that only read its strings. Pass overrides for the
// bindings a test does use.
export const testGatewayEnv = (
  overrides: Partial<GatewayEnv> = {}
): GatewayEnv => ({
  ACCESS_AUD: "replace-me",
  ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  DEPLOYMENT_ENVIRONMENT: "test",
  GATEWAY_RUNTIME: fakeBinding<DurableObjectNamespace>({}),
  LOADER: fakeBinding<WorkerLoader>({}),
  ...overrides,
});
