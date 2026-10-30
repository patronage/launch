import type { SanitizedConfig } from "payload";

let config: Promise<SanitizedConfig> | undefined;

// Resource bindings are unavailable during the remote startup validation.
// Load the config on the first request, before Payload initializes its adapters.
export const getPayloadConfig = (): Promise<SanitizedConfig> => {
  config ??= import("@payload-config").then((module) => module.default);

  return config;
};

/** Register a route without evaluating Payload's config at module scope. */
export const payloadRoute =
  <Args extends unknown[], Result>(
    factory: (config: Promise<SanitizedConfig>) => (...args: Args) => Result
  ) =>
  (...args: Args): Result =>
    factory(getPayloadConfig())(...args);
