"use strict";

require("dotenv/config")

const MODE = (process.env.GSRTC_MODE || "direct").toLowerCase() === "http" ? "http" : "direct";

const BASE_URL = (
  process.env.GSRTC_BASE_URL).replace(/\/+$/, "");

const DATA_URL = `${BASE_URL}/TransistService/`;

const UA = process.env.GSRTC_USER_AGENT
const ANDROID_ID = process.env.GSRTC_ANDROID_ID

const TIMEOUT_SEC =
  Number(process.env.GSRTC_TIMEOUT_SEC) > 0 ? Number(process.env.GSRTC_TIMEOUT_SEC) : 30;

const MAX_BUFFER = 10 * 1024 * 1024;

const CURL = process.env.GSRTC_CURL || (process.platform === "win32" ? "curl.exe" : "curl");

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
  TIMEOUT_SEC,
  MAX_BUFFER,
  CURL,
  API_TIMEOUT_MS,
  PORT,
  HOST,
  AUTH_TOKEN,
};
