"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const TOKEN = "test-token";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status) return response;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not start at ${url}`);
}

test("http: routes and auth", { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_AUTH_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/health`);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /gsrtc-mcp is running/);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const deep = await fetch(`${base}/health?deep=1`);
  assert.equal(deep.status, 401);

  const unauthorized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(unauthorized.status, 401, stderr);

  const authorized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(authorized.status, 200, stderr);
});
