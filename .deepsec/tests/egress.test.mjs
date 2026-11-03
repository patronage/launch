// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { allowedDestination, createEgressProxy } from "../runner/egress.mjs";

test("subscription egress permits only the two exact OpenAI HTTPS endpoints", () => {
  assert.ok(allowedDestination("chatgpt.com:443"));
  assert.ok(allowedDestination("auth.openai.com:443"));

  for (const destination of [
    "api.openai.com:443",
    "example.com:443",
    "chatgpt.com:80",
    "chatgpt.com.evil.test:443",
    "chatgpt.com:443@evil.test",
    "127.0.0.1:443",
    "auth.openai.com:443/path",
    undefined,
  ]) {
    assert.equal(allowedDestination(destination), false);
  }
});

test("the proxy rejects disallowed CONNECT requests", async (t) => {
  const server = createEgressProxy();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const request = http.request({
    host: "127.0.0.1",
    method: "CONNECT",
    path: "example.com:443",
    port: server.address().port,
  });

  request.end();
  const [response, socket] = await once(request, "connect");
  socket.destroy();
  const status = response.statusCode;
  assert.equal(status, 403);
});

test("the native SDK spawn receives the proxy after DeepSec filters its environment", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      new URL("../runner/proxy-env.mjs", import.meta.url).href,
      "--input-type=module",
      "--eval",
      "import { spawn } from 'node:child_process'; const child = spawn('/usr/bin/printenv', ['HTTPS_PROXY'], { env: {}, stdio: 'inherit' }); child.on('exit', code => process.exit(code));",
    ],
    { encoding: "utf-8" }
  );

  assert.equal(result.trim(), "http://model-egress:8080");
});
