"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

/** Spawn the stdio server and expose a small JSON-RPC client. */
function startStdioServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  const badLines = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        badLines.push(line);
        continue;
      }

      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let nextId = 1;

  function send(message) {
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout on ${method}\n${stderr}`));
      }, 120_000);

      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });

      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize() {
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gsrtc-test", version: "1.0.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
  }

  return {
    child,
    request,
    initialize,
    badLines,
    stderr: () => stderr,
    stop: () => child.kill(),
  };
}

/** Collect the text blocks of a tool result. */
function textOf(response) {
  return (response.result && response.result.content ? response.result.content : [])
    .map((block) => block.text || "")
    .join("\n");
}

module.exports = { startStdioServer, textOf };
