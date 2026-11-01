"use strict";

/**
 * Direct GSRTC client — the upstream protocol lives in GSRTC_BASE_URL.
 *
 * WHY curl INSTEAD OF fetch:
 *   The Google edge in front of the upstream host blocks Node/OpenSSL TLS
 *   fingerprints with a 403 page (verified: node fetch -> 403, curl -> 200).
 *   Do not "simplify" this to fetch/https - it will always be 403.
 *
 *   Some hosts still get a 403 (verified on Render's Linux curl). Failures
 *   therefore report curl version + negotiated HTTP version, and
 *   GSRTC_CURL_EXTRA can try alternatives without a code change:
 *     GSRTC_CURL_EXTRA="--http1.1"
 *     GSRTC_CURL_EXTRA="--tls-max 1.2"
 *     GSRTC_CURL_EXTRA="--http1.1 --tls-max 1.2"
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
const { randomBytes } = require("node:crypto");

const {
  BASE_URL,
  DATA_URL,
  UA,
  ANDROID_ID,
  TIMEOUT_SEC,
  MAX_BUFFER,
  CURL,
  CURL_EXTRA,
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

/** "HTTP/2" or "HTTP/1.1" from curl's -D header dump. */
function httpVersionOf(headers) {
  const match = String(headers || "").match(/^HTTP\/([\d.]+)/m);
  return match ? `HTTP/${match[1]}` : "HTTP version unknown";
}

/**
 * Facts that separate a TLS-fingerprint block from an IP block: negotiated
 * HTTP version, the curl build (Schannel vs OpenSSL), and any extra flags.
 */
async function describeTransport(res) {
  const parts = [httpVersionOf(res.headers), await curlVersion()];
  if (CURL_EXTRA.length) parts.push(`extra: ${CURL_EXTRA.join(" ")}`);
  return parts.join(" · ");
}

/** Builds the error for a non-200 upstream reply and logs the breakdown. */
async function upstreamFailure(label, res, parsed) {
  const diag = await describeTransport(res);
  log(`[gsrtc] ${label} failed: HTTP ${res.status} (${diag})`);

  return new GsrtcError(
    `${label} failed (HTTP ${res.status})`,
    `${String(parsed.text || res.body).trim().slice(0, DETAIL_CHARS)}\n${diag}`,
  );
}

/**
 * One curl call. The body is written to a temp file and sent with
 * --data-binary @file (Windows argument quoting mangles inline JSON).
 */
async function runCurl(method, url, headers, body, extraArgs = []) {
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

    // Escape hatch for hosts the edge rejects: --http1.1, --tls-max 1.2, ...
    if (CURL_EXTRA.length) args.push(...CURL_EXTRA);
    if (extraArgs.length) args.push(...extraArgs);

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
    throw await upstreamFailure("nonce request", res, parsed);
  }
  return nonce;
}

async function fetchSession() {
  const tokenIn = randomBytes(32).toString("hex");
  const res = await runCurl(
    "POST",
    `${BASE_URL}/api/integrity/session`,
    {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Integrity-Token": tokenIn,
      "X-Android-Id": ANDROID_ID,
    },
    "probe",
  );

  const parsed = parseBody(res.body);
  const token = parsed.json && parsed.json.token;

  if (res.status !== 200 || !token) {
    throw await upstreamFailure("session request", res, parsed);
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
    throw await upstreamFailure(`${endpoint} request`, res, parsed);
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

/* ------------------------------------------------------------------ probe */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Which transport shapes does this host get through with? One curl call per
 * variant against the nonce endpoint, plus a Node fetch baseline.
 * Used by GET /health?probe=1 to separate a TLS-fingerprint block from an
 * IP block without redeploying for every flag.
 */
const PROBE_VARIANTS = [
  { label: "default", args: [] },
  { label: "--http1.1", args: ["--http1.1"] },
  { label: "--tls-max 1.2", args: ["--tls-max", "1.2"] },
  { label: "--http1.1 --tls-max 1.2", args: ["--http1.1", "--tls-max", "1.2"] },
  { label: "--http1.1 + browser UA", args: ["--http1.1"], ua: BROWSER_UA },
  { label: "--http1.1 + no UA", args: ["--http1.1"], omitUa: true },
];

async function probeTransport() {
  const url = `${BASE_URL}/api/integrity/nonce`;
  const results = [];

  for (const variant of PROBE_VARIANTS) {
    const started = Date.now();
    const headers = variant.omitUa ? {} : { "User-Agent": variant.ua || UA };

    try {
      const res = await runCurl("GET", url, headers, undefined, variant.args);
      const parsed = parseBody(res.body);
      results.push({
        variant: variant.label,
        status: res.status,
        http: httpVersionOf(res.headers),
        nonce: Boolean(parsed.json && parsed.json.nonce),
        ms: Date.now() - started,
      });
    } catch (error) {
      results.push({
        variant: variant.label,
        status: 0,
        error: String(error && error.message).slice(0, 160),
        ms: Date.now() - started,
      });
    }
  }

  // Baseline: the Node runtime the upstream is supposed to block.
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    results.push({ variant: "node fetch", status: res.status, ms: Date.now() - started });
  } catch (error) {
    results.push({
      variant: "node fetch",
      status: 0,
      error: String(error && error.message).slice(0, 160),
      ms: Date.now() - started,
    });
  }

  return {
    host: BASE_URL,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    curl: await curlVersion(),
    curlExtra: CURL_EXTRA.join(" ") || "none",
    results,
  };
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
    curlExtra: CURL_EXTRA.length ? CURL_EXTRA.join(" ") : "none",
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
  curlVersion,
  probeTransport,
};
