"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { startStdioServer, textOf } = require("./helpers.js");

test("live: self_check reaches the upstream", { timeout: 180_000 }, async (t) => {
  const server = startStdioServer();
  t.after(() => server.stop());

  await server.initialize();
  const result = await server.request("tools/call", { name: "self_check", arguments: {} });
  const text = textOf(result);

  assert.match(text, /Self check — everything works/);
  assert.match(text, /- Entry: /);
  assert.match(text, /- PID: /);
  assert.match(text, /- Version: /);
});

test("live: station lookup resolves exact ids", { timeout: 180_000 }, async (t) => {
  const server = startStdioServer();
  t.after(() => server.stop());

  await server.initialize();
  const result = await server.request("tools/call", {
    name: "search_station",
    arguments: { name: "Vijapur" },
  });
  const text = textOf(result);

  assert.match(text, /Stations matching "Vijapur"/);
  assert.match(text, /\|\s*782\s*\|/);
});

test("live: find_buses returns a timetable", { timeout: 180_000 }, async (t) => {
  const server = startStdioServer();
  t.after(() => server.stop());

  await server.initialize();
  const result = await server.request("tools/call", {
    name: "find_buses",
    arguments: { from: "Gandhinagar", to: "Vijapur", time: "5:00 PM" },
  });
  const text = textOf(result);

  assert.match(text, /Gandhinagar → Vijapur/);
  assert.match(text, /Around 5:00 PM/);
  assert.match(text, /\| Depart/);
});
