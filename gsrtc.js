"use strict";

/**
 * Data-source facade.
 *
 *   GSRTC_MODE=direct (default) -> upstream.js   (call GSRTC ourselves)
 *   GSRTC_MODE=http             -> http-api.js   (call local api.js wrapper)
 *
 * Both paths expose the same functions, so the MCP layer never knows which
 * one is in use.
 */

const { MODE } = require("./config.js");
const { GsrtcError } = require("./errors.js");

const impl = MODE === "http" ? require("./http-api.js") : require("./upstream.js");

/* ------------------------------------------------------------ service types */

let serviceTypeCache = null;
const SERVICE_TYPE_TTL_MS = 10 * 60 * 1000;

async function serviceTypes() {
  if (serviceTypeCache && Date.now() - serviceTypeCache.at < SERVICE_TYPE_TTL_MS) {
    return serviceTypeCache.rows;
  }
  const result = await impl.getServiceTypes();
  serviceTypeCache = { at: Date.now(), rows: result.rows };
  return result.rows;
}

module.exports = {
  MODE,
  GsrtcError,
  serviceTypes,
  getHealth: impl.getHealth,
  getStationList: impl.getStationList,
  getBusList: impl.getBusList,
  getDepotBusList: impl.getDepotBusList,
  getNearbyDepots: impl.getNearbyDepots,
};
