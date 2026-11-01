#!/usr/bin/env node
"use strict";

/**
 * stdio entry point — for opencode, Claude Desktop, and anything that can
 * spawn a child process. For HTTP hosting use `server.js` instead.
 */

const { serveStdio } = require("@modelcontextprotocol/server/stdio");

const { createServer } = require("./app.js");
const { MODE, BASE_URL } = require("./config.js");
const { version: VERSION } = require("./package.json");

process.stderr.write(`[gsrtc] ${VERSION} · ${__filename} · pid ${process.pid}\n`);
process.stderr.write(`[gsrtc] mode: ${MODE}\n`);
serveStdio(createServer);
