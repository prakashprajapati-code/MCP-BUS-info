"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * Configuration comes from the environment only. `.env` fills the gaps for
 * local runs; real environment variables always win, so Render's dashboard
 * values override any local file. The path is anchored to this directory
 * because MCP clients spawn the server from arbitrary working directories.
 */
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`[gsrtc] ${name} is not set. Add it to .env (local) or the Render environment.`);
  }
  return value;
}

/** Extra curl flags, e.g. GSRTC_CURL_EXTRA="--http1.1 --tls-max 1.2". */
function curlExtra() {
  const raw = String(process.env.GSRTC_CURL_EXTRA || "").trim();
  if (!raw) return [];

  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) args.push(value);
  }
  return args;
}

const MODE = (process.env.GSRTC_MODE || "direct").toLowerCase() === "http" ? "http" : "direct";

const BASE_URL = required("GSRTC_BASE_URL").replace(/\/+$/, "");

const DATA_URL = `${BASE_URL}/TransistService/`;

const UA = required("GSRTC_USER_AGENT");
const ANDROID_ID = required("GSRTC_ANDROID_ID");

/** IANA zone used for "today" and "has this time passed" (Render runs UTC). */
function timeZone() {
  const name = (process.env.GSRTC_TZ || "Asia/Kolkata").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    throw new Error(`[gsrtc] GSRTC_TZ "${name}" is not a valid IANA timezone (e.g. Asia/Kolkata).`);
  }
}

const TIME_ZONE = timeZone();

const TIMEOUT_SEC =
  Number(process.env.GSRTC_TIMEOUT_SEC) > 0 ? Number(process.env.GSRTC_TIMEOUT_SEC) : 30;

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * curl binary. On Linux, prefer the bundled Chrome-impersonating build when
 * postinstall managed to fetch it: the plain OpenSSL curl gets a 403 from the
 * upstream edge. An explicit GSRTC_CURL (anything but bare "curl") still wins.
 */
const SYSTEM_CURL = process.platform === "win32" ? "curl.exe" : "curl";
const IMPERSONATE = path.join(__dirname, ".curl-impersonate", "curl_chrome116");

function defaultCurl() {
  if (process.platform === "win32") return SYSTEM_CURL;
  try {
    if (fs.existsSync(IMPERSONATE)) return IMPERSONATE;
  } catch {
    /* fall through */
  }
  return SYSTEM_CURL;
}

function curlBinary() {
  const configured = String(process.env.GSRTC_CURL || "").trim();
  if (configured && configured !== "curl" && configured !== "curl.exe") return configured;
  return defaultCurl();
}

const CURL = curlBinary();

const CURL_EXTRA = curlExtra();

const API_TIMEOUT_MS =
  Number(process.env.GSRTC_API_TIMEOUT_MS) > 0 ? Number(process.env.GSRTC_API_TIMEOUT_MS) : 90_000;

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

module.exports = {
  MODE,
  BASE_URL,
  DATA_URL,
  UA,
  ANDROID_ID,
  TIME_ZONE,
  TIMEOUT_SEC,
  MAX_BUFFER,
  CURL,
  CURL_EXTRA,
  API_TIMEOUT_MS,
  PORT,
  HOST,
  AUTH_TOKEN,
};
