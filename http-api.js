"use strict";

/**
 * Optional fallback path: talk to the local mobsf-offline api.js wrapper
 * (GSRTC_MODE=http). Kept for debugging and for comparing answers against
 * the direct path.
 */

const { API_URL, API_TIMEOUT_MS } = require("./config.js");
const { GsrtcError, START_HINT } = require("./errors.js");

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GsrtcError(
        `The GSRTC API did not answer within ${Math.round(API_TIMEOUT_MS / 1000)}s.`,
        START_HINT,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new GsrtcError(`Cannot reach the GSRTC API at ${API_URL} (${detail}).`, START_HINT);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = (parsed && parsed.message) || raw.slice(0, 200) || "no response body";
    throw new GsrtcError(`GSRTC API returned HTTP ${response.status}: ${detail}`);
  }

  if (parsed && typeof parsed === "object") return parsed;
  return { success: false, message: raw.slice(0, 200) };
}

function toResult(body) {
  const rows = Array.isArray(body.data)
    ? body.data
    : body.data && typeof body.data === "object"
      ? [body.data]
      : [];

  return {
    rows,
    count: rows.length,
    message: typeof body.message === "string" && body.message ? body.message : undefined,
  };
}

async function getHealth() {
  return request("/health", { method: "GET" });
}

async function getStationList(name) {
  return toResult(
    await request("/stationName", { method: "POST", body: JSON.stringify({ StationName: name }) }),
  );
}

async function getBusList(query) {
  return toResult(
    await request("/busList", {
      method: "POST",
      body: JSON.stringify({
        from: query.from,
        to: query.to,
        date: query.date,
        serviceTypeId: query.serviceTypeId || 0,
        journeyTime: query.journeyTime || "",
        pageSize: query.pageSize || 300,
        page: query.page || 1,
      }),
    }),
  );
}

async function getDepotBusList(query) {
  return toResult(
    await request("/depotBusList", {
      method: "POST",
      body: JSON.stringify({
        locationId: query.locationId,
        date: query.date,
        pageSize: query.pageSize || 50,
        page: query.page || 1,
      }),
    }),
  );
}

async function getServiceTypes() {
  return toResult(await request("/serviceTypes", { method: "POST", body: "{}" }));
}

async function getNearbyDepots(lat, lng) {
  return toResult(
    await request("/nearbyDepots", { method: "POST", body: JSON.stringify({ lat, lng }) }),
  );
}

module.exports = {
  getHealth,
  getStationList,
  getBusList,
  getDepotBusList,
  getServiceTypes,
  getNearbyDepots,
};
