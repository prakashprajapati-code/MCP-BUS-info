#!/usr/bin/env node
"use strict";

/**
 * HTTP entry point (Streamable HTTP MCP) for hosts like Render.
 *
 *   GET  /            -> plain-text index of endpoints
 *   GET  /health      -> liveness only (no upstream call)
 *   GET  /health?deep=1 -> also runs the upstream self check
 *   *    /mcp         -> MCP endpoint (POST for JSON-RPC, GET for SSE)
 *
 * Local:  http://localhost:3001/mcp
 * Render: https://<service-name>.onrender.com/mcp
 *
 * Auth is optional. When MCP_AUTH_TOKEN is set, requests must carry either
 *   Authorization: Bearer <token>      (opencode, Claude Desktop, curl)
 *   ?key=<token>                       (clients that only accept a URL)
 * /health stays public so platform health checks keep working.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const { createMcpHandler } = require("@modelcontextprotocol/server");

const { createServer } = require("./app.js");
const { PORT, HOST, AUTH_TOKEN, MODE, BASE_URL } = require("./config.js");
const api = require("./gsrtc.js");

const log = (line) => process.stderr.write(`[gsrtc] ${line}\n`);

const handler = createMcpHandler(createServer, {
  // Broad client compatibility: 2025-era (stateless) and 2026 traffic both work.
  legacy: "stateless",
  onerror: (error) => log(`handler error: ${error.message}`),
});

/* ------------------------------------------------------------------ helpers */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendJson(res, status, body) {
  send(res, status, body, "application/json; charset=utf-8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function bearerFrom(req, url) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  if (match) return match[1].trim();

  const key = url.searchParams.get("key");
  return key ? key.trim() : "";
}

function authorised(req, url) {
  if (!AUTH_TOKEN) return true;

  const provided = bearerFrom(req, url);
  if (!provided) return false;

  const given = Buffer.from(provided);
  const expected = Buffer.from(AUTH_TOKEN);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (url.pathname === "/") {
      send(
        res,
        200,
        [
          "gsrtc-mcp is running.",
          "",
          `MCP endpoint:  ${url.origin}/mcp`,
          "Health:        /health  (/health?deep=1 for an upstream check)",
          `Mode:          ${MODE}`,
          `Auth:          ${AUTH_TOKEN ? "required (Bearer or ?key=)" : "open"}`,
        ].join("\n"),
      );
      return;
    }

    if (url.pathname === "/health") {
      if (url.searchParams.get("deep") !== "1") {
        sendJson(res, 200, {
          ok: true,
          mode: MODE,
          auth: Boolean(AUTH_TOKEN),
          uptimeSec: Math.round(process.uptime()),
        });
        return;
      }

      if (!authorised(req, url)) {
        sendJson(res, 401, {
          ok: false,
          error: "Deep health requires Authorization: Bearer <token> or ?key=<token>.",
        });
        return;
      }

      try {
        sendJson(res, 200, { ok: true, ...(await api.getHealth()) });
      } catch (error) {
        sendJson(res, 503, {
          ok: false,
          mode: MODE,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      if (!authorised(req, url)) {
        sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Send Authorization: Bearer <token> or ?key=<token>.",
        });
        return;
      }

      const init = { method: req.method, headers: req.headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await readBody(req);
      }

      const response = await handler.fetch(new Request(url, init), {
        authInfo: AUTH_TOKEN ? { token: bearerFrom(req, url), scheme: "bearer" } : undefined,
      });

      res.writeHead(response.status, {
        ...CORS,
        ...Object.fromEntries(response.headers),
      });

      if (response.body) {
        Readable.fromWeb(response.body).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: `No route for ${req.method} ${url.pathname}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`request failed (${req.method} ${req.url}): ${message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: message });
    else res.end();
  } finally {
    log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms`);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, HOST, () => {
  log(`mode: ${MODE}`);
  log(`listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  log(`auth: ${AUTH_TOKEN ? "bearer token required" : "open (set MCP_AUTH_TOKEN to lock it down)"}`);
});

/* ----------------------------------------------------------------- shutdown */

let closing = false;

function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`${signal} received - shutting down`);

  server.close(() => {
    Promise.resolve(handler.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });

  setTimeout(() => process.exit(0), 8_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
