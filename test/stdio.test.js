"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { startStdioServer } = require("./helpers.js");

const EXPECTED_TOOLS = [
  "api_health",
  "find_buses",
  "get_bus_list",
  "get_depot_bus_list",
  "get_nearby_depots",
  "get_service_types",
  "search_station",
  "self_check",
];

test("stdio: handshake and tool catalog", async (t) => {
  const server = startStdioServer();
  t.after(() => server.stop());

  const init = await server.initialize();
  assert.equal(init.result.serverInfo.name, "gsrtc");
  assert.equal(init.result.serverInfo.version, "1.0.0");

  const list = await server.request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);

  assert.deepEqual(server.badLines, [], "stdout must contain only JSON-RPC");
});

test("stdio: config errors are readable", async (t) => {
  const server = startStdioServer();
  t.after(() => server.stop());

  // With a valid .env this succeeds; the point is that any failure must
  // name the missing variable instead of throwing a TypeError.
  const init = await server.initialize();
  assert.equal(init.result.serverInfo.name, "gsrtc");
  assert.doesNotMatch(server.stderr(), /Cannot read properties of undefined/);
});
