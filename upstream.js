"use strict";

/**
 * Direct GSRTC client — the upstream protocol lives in GSRTC_BASE_URL.
 *
 * WHY curl INSTEAD OF fetch:
 *   The Google edge in front of the upstream host blocks Node/OpenSSL TLS
 *   fingerprints with a 403 page (verified: node fetch -> 403, curl -> 200).
 *   curl.exe on Windows and curl on Linux both get through. Do not "simplify"
 *   this to fetch/https - it will always be 403.
 *
 * AUTH FLOW:
 *   GET  /api/integrity/nonce                      (no headers needed)
 *   POST /api/integrity/session  X-Integrity-Token: dummy + X-Android-Id
 *        -> { token, expiresAtUtc }                (token lives 30 minutes)
 *   POST /TransistService/<Endpoint>  Authorization: Bearer <token>
 *
 * The Bearer is minted once, cached until 60s before its JWT expiry, and
 * re-minted automatically on a 401.
 */

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BASE_URL,
  DATA_URL,
  UA,
  ANDROID_ID,
  TIMEOUT_SEC,
  MAX_BUFFER,
  CURL,
} = require("./config.js");
const { GsrtcError } = require("./errors.js");

const run = promisify(execFile);
const DETAIL_CHARS = 300;

const log = (line) => process.stderr.write(`${line}\n`);

/* -------------------------------------------------------------- transport */

let tmpSeq = 0;

function tmpFile(tag) {
  tmpSeq += 1;
  return path.join(os.tmpdir(), `gsrtc-${process.pid}-${Date.now()}-${tmpSeq}-${tag}.tmp`);
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function transportError(message, detail) {
  const suffix = detail ? ` ${String(detail).trim().slice(0, DETAIL_CHARS)}` : "";
  return new GsrtcError(
    `${message}${suffix}`,
    `Is curl installed? Set GSRTC_CURL if it lives elsewhere (tried "${CURL}").`,
  );
}

/**
 * One curl call. The body is written to a temp file and sent with
 * --data-binary @file (Windows argument quoting mangles inline JSON).
 */
async function runCurl(method, url, headers, body) {
  const files = [];
  const add = (tag) => {
    const file = tmpFile(tag);
    files.push(file);
    return file;
  };

  const outFile = add("out");
  const hdrFile = add("hdr");

  try {
    const args = [
      "-sS",
      "-m",
      String(TIMEOUT_SEC),
      "-X",
      method,
      url,
      "-o",
      outFile,
      "-D",
      hdrFile,
      "-w",
      "%{http_code}",
    ];

    // Schannel-only flag; harmless on Linux, needed on Windows.
    if (process.platform === "win32") args.push("--ssl-no-revoke");

    for (const [key, value] of Object.entries(headers || {})) {
      args.push("-H", `${key}: ${value}`);
    }

    if (body !== undefined && body !== null) {
      const bodyFile = add("body");
      fs.writeFileSync(bodyFile, String(body), "utf8");
      args.push("--data-binary", `@${bodyFile}`);
    }

    const { stdout } = await run(CURL, args, { maxBuffer: MAX_BUFFER, windowsHide: true });

    return {
      status: Number.parseInt(String(stdout).trim(), 10) || 0,
      body: safeRead(outFile),
      headers: safeRead(hdrFile),
    };
  } catch (error) {
    throw transportError(
      `curl failed: ${error.code ? `exit ${error.code}` : "error"}`,
      error.stderr || error.message,
    );
  } finally {
    for (const file of files) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
  }
}

/** JSON when the body looks like JSON, plain text otherwise (NO DATA FOUND). */
function parseBody(raw) {
  const text = String(raw || "").trim();
  if (!text) return { json: null, text: "", isJson: false };

  if (text[0] === "[" || text[0] === "{") {
    try {
      return { json: JSON.parse(text), text, isJson: true };
    } catch {
      /* fall through to text */
    }
  }
  return { json: null, text, isJson: false };
}

/* ------------------------------------------------------------------- auth */

const bearer = { token: null, exp: 0, inflight: null, nonceAt: 0 };

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"),
    );
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    /* not a JWT - fall back to the default TTL */
  }
  return 0;
}

async function fetchNonce() {
  const res = await runCurl("GET", `${BASE_URL}/api/integrity/nonce`, { "User-Agent": UA });
  const parsed = parseBody(res.body);
  const nonce = parsed.json && parsed.json.nonce;

  if (res.status !== 200 || !nonce) {
    throw new GsrtcError(
      `nonce request failed (HTTP ${res.status})`,
      String(parsed.text || res.body).trim().slice(0, DETAIL_CHARS),
    );
  }
  return nonce;
}

async function fetchSession() {
  const res = await runCurl(
    "POST",
    `${BASE_URL}/api/integrity/session`,
    {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Integrity-Token": "dummy",
      "X-Android-Id": ANDROID_ID,
    },
    "probe",
  );

  const parsed = parseBody(res.body);
  const token = parsed.json && parsed.json.token;

  if (res.status !== 200 || !token) {
    throw new GsrtcError(
      `session request failed (HTTP ${res.status})`,
      String(parsed.text || res.body).trim().slice(0, DETAIL_CHARS),
    );
  }

  let exp = jwtExpiryMs(token);
  if (!exp) {
    const expiresAt = parsed.json.expiresAtUtc ? Date.parse(parsed.json.expiresAtUtc) : NaN;
    exp = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 25 * 60 * 1000;
  }

  return { token, exp };
}

function invalidateBearer() {
  bearer.token = null;
  bearer.exp = 0;
}

/** Concurrent callers share one in-flight mint. */
async function ensureBearer() {
  if (bearer.token && Date.now() < bearer.exp - 60_000) {
    return { token: bearer.token, source: "cached" };
  }

  if (bearer.inflight) {
    return { token: await bearer.inflight, source: "shared" };
  }

  bearer.inflight = (async () => {
    await fetchNonce(); // parity with the app flow + proves the host is reachable
    bearer.nonceAt = Date.now();
    const session = await fetchSession();
    bearer.token = session.token;
    bearer.exp = session.exp;
    return session.token;
  })();

  try {
    return { token: await bearer.inflight, source: "new" };
  } finally {
    bearer.inflight = null;
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * POST to a TransistService endpoint with the Bearer, retrying once after a
 * 401 (expired token). Normalises plain-text answers to an empty row list.
 */
async function callData(endpoint, payload) {
  const started = Date.now();
  let authSource = "new";
  let res = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const auth = await ensureBearer();
    authSource = attempt === 0 ? auth.source : "refreshed";

    res = await runCurl(
      "POST",
      `${DATA_URL}${endpoint}`,
      {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Authorization: `Bearer ${auth.token}`,
      },
      JSON.stringify(payload === undefined ? {} : payload),
    );

    if (res.status === 401 && attempt === 0) {
      log(`[auth] 401 on ${endpoint} - refreshing bearer`);
      invalidateBearer();
      continue;
    }
    break;
  }

  const parsed = parseBody(res.body);
  const rows = Array.isArray(parsed.json)
    ? parsed.json
    : parsed.json && typeof parsed.json === "object"
      ? [parsed.json]
      : [];

  log(
    `[${endpoint.padEnd(42)}] HTTP ${res.status} rows=${String(rows.length).padEnd(4)} ` +
      `${Date.now() - started}ms auth=${authSource}`,
  );

  if (res.status !== 200) {
    throw new GsrtcError(
      `upstream HTTP ${res.status} on ${endpoint}`,
      String(parsed.text || res.body).trim().slice(0, DETAIL_CHARS),
    );
  }

  return { rows, json: parsed.json, text: parsed.text, isJson: parsed.isJson };
}

function toResult(body) {
  return {
    rows: body.rows,
    count: body.rows.length,
    message:
      body.rows.length === 0
        ? body.text || (body.isJson ? undefined : "NO DATA FOUND")
        : undefined,
  };
}

/* ------------------------------------------------------------- endpoints */

async function getStationList(name) {
  return toResult(await callData("GetStationList_V1", { StationName: name }));
}

async function getBusList(query) {
  return toResult(
    await callData("Page_GetSourceDestinationWiseBusList_V1", {
      FromLocId: query.from,
      ToLocId: query.to,
      BusServiceTypeId: query.serviceTypeId || 0,
      ScheduleDate: query.date,
      JourneyTime: query.journeyTime || "",
      PageSize: query.pageSize || 300,
      PageNumber: query.page || 1,
    }),
  );
}

async function getDepotBusList(query) {
  return toResult(
    await callData("Page_GetDepotWiseBusList", {
      LocationId: query.locationId,
      ScheduleDate: query.date,
      PageSize: query.pageSize || 50,
      PageNumber: query.page || 1,
    }),
  );
}

async function getServiceTypes() {
  return toResult(
    await callData("GetBusServiceTypeList", {
      IMEINo: ANDROID_ID,
      column1: ANDROID_ID,
      column2: ANDROID_ID,
      column3: ANDROID_ID,
    }),
  );
}

async function getNearbyDepots(lat, lng) {
  return toResult(
    await callData("GetNearByDepotList_V1", {
      Lattitude: String(lat),
      Longitude: String(lng),
      IMEINo: "",
      column1: "",
      column2: "",
      column3: "",
    }),
  );
}

/* ----------------------------------------------------------------- health */

async function curlVersion() {
  try {
    const { stdout } = await run(CURL, ["--version"], { maxBuffer: 64 * 1024, windowsHide: true });
    return String(stdout).split("\n")[0].trim();
  } catch (error) {
    return `unavailable (${error.code || "error"})`;
  }
}

/** Proves the host can still reach the upstream without minting a token. */
async function ensureReachable() {
  if (Date.now() - bearer.nonceAt < 30_000) return;
  await fetchNonce();
  bearer.nonceAt = Date.now();
}

async function getHealth() {
  const started = Date.now();

  // Mint/refresh the bearer so we know auth works, but do NOT run a sample
  // data query here: opencode calls this during its startup probe and a slow
  // upstream call makes it kill the process (exit 255).
  await ensureBearer();
  // A fresh mint already did the nonce round-trip; only pay for another one
  // when the bearer came from cache.
  await ensureReachable();

  return {
    ok: true,
    mode: "direct",
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    curl: await curlVersion(),
    base: BASE_URL,
    nonce: "ok",
    bearerCached: Boolean(bearer.token && Date.now() < bearer.exp - 60_000),
    ms: Date.now() - started,
  };
}

module.exports = {
  getStationList,
  getBusList,
  getDepotBusList,
  getServiceTypes,
  getNearbyDepots,
  getHealth,
};
