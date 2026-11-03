import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const proxyEnvironment = {
  ALL_PROXY: "http://model-egress:8080",
  HTTPS_PROXY: "http://model-egress:8080",
  HTTP_PROXY: "http://model-egress:8080",
  NO_PROXY: "",
};

Object.assign(process.env, proxyEnvironment);

// DeepSec filters the environment and the SDK launches a native binary directly.
// Restore the fixed proxy on that handoff without editing installed vendor code.
const originalSpawn = childProcess.spawn;

childProcess.spawn = (command, args, options) =>
  originalSpawn(command, args, {
    ...options,
    env: { ...(options?.env ?? process.env), ...proxyEnvironment },
  });

syncBuiltinESMExports();
