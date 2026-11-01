#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod");

const { version: VERSION } = require("./package.json");
const api = require("./gsrtc.js");
const {
  addDays,
  dedupeBuses,
  formatBusList,
  formatClock,
  formatDepotBusList,
  formatDepots,
  formatHealth,
  formatSelfCheck,
  formatServiceTypes,
  formatStationPicker,
  formatStations,
  formatUpstreamDown,
  isValidDate,
  nowInZone,
  parseClock,
  sortByDeparture,
  toBusView,
  todayStr,
} = require("./format.js");

/* --------------------------------------------------------------- plumbing */

const text = (body) => ({ content: [{ type: "text", text: body }] });
const fail = (body) => ({ content: [{ type: "text", text: body }], isError: true });

function handleError(error) {
  if (error instanceof api.GsrtcError) {
    return fail(formatUpstreamDown({ message: error.message, hint: error.hint }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail(`⚠️ Unexpected error: ${message}`);
}

const normalise = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** Identifies the code actually running, not the file on disk. */
function runtimeInfo() {
  const entry = (require.main && require.main.filename) || __filename;
  let mtime = "unknown";
  try {
    mtime = fs.statSync(entry).mtime.toISOString();
  } catch {
    /* entry may be virtualized */
  }

  return {
    version: VERSION,
    file: entry,
    mtime,
    pid: process.pid,
    cwd: process.cwd(),
  };
}

/**
 * Resolve a station name to an id.
 *
 * Deliberately does NOT trust the API's top-level StationId: api.js reports the
 * first match, so "Vijapur" comes back as 22131 (Vijapur-Shehera) instead of
 * 782 (Vijapur). Exact StationName wins, then exact CityName, then a picker.
 */
async function resolveStation(input) {
  const raw = input.trim();

  if (/^\d+$/.test(raw)) {
    return { kind: "ok", id: Number(raw), label: `Station ${raw}` };
  }

  const { rows } = await api.getStationList(raw);
  if (rows.length === 0) return { kind: "none" };

  const nameMatches = rows.filter((row) => normalise(String(row.StationName || "")) === normalise(raw));
  if (nameMatches.length === 1) {
    const row = nameMatches[0];
    return { kind: "ok", id: Number(row.StationId), label: String(row.StationName || raw).trim() };
  }

  const cityMatches = rows.filter((row) => normalise(String(row.CityName || "")) === normalise(raw));
  if (cityMatches.length === 1) {
    const row = cityMatches[0];
    return { kind: "ok", id: Number(row.StationId), label: String(row.StationName || raw).trim() };
  }

  if (rows.length === 1) {
    const row = rows[0];
    return { kind: "ok", id: Number(row.StationId), label: String(row.StationName || raw).trim() };
  }

  return { kind: "ambiguous", rows };
}

async function resolveServiceTypeId(input) {
  if (!input) return 0;

  const types = await api.serviceTypes();
  const wanted = normalise(input);
  const match =
    types.find((row) => normalise(String(row.ServiceTypeName || "")) === wanted) ||
    types.find((row) => String(row.ServiceTypeID || "") === wanted);

  if (!match) {
    throw new api.GsrtcError(`Unknown service type "${input}".\n\n${formatServiceTypes(types)}`);
  }

  return Number(match.ServiceTypeID) || 0;
}

const VERBATIM =
  "This response is already formatted for the user. Show it as-is — do not wrap it in JSON or code fences, and do not re-summarise it row by row.";

/* ------------------------------------------------------------------- tools */

function registerTools(server) {
  server.registerTool(
    "find_buses",
    {
      title: "Find GSRTC buses",
      description:
        "List GSRTC buses between two stations by name. Use this for questions like 'buses from Gandhinagar to Vijapur at 5 PM'. " +
        "Accepts station names (not just ids), resolves them to the right depot, and filters by departure time when asked. " +
        VERBATIM,
      inputSchema: z.object({
        from: z.string().min(1).describe("Origin station name, e.g. 'Gandhinagar'. A numeric station id also works."),
        to: z.string().min(1).describe("Destination station name, e.g. 'Vijapur'. A numeric station id also works."),
        date: z
          .string()
          .optional()
          .describe("Travel date as YYYY-MM-DD. Defaults to today, or tomorrow if the requested time already passed."),
        time: z.string().optional().describe("Desired departure time, e.g. '17:00' or '5:00 PM'. Omit to list the whole day."),
        windowMinutes: z
          .number()
          .int()
          .min(0)
          .max(720)
          .optional()
          .describe("Minutes either side of `time` to include. Default 60."),
        serviceType: z.string().optional().describe("Service type name or id, e.g. 'Express', 'Sleeper', 'Volvo 2x2'."),
        limit: z.number().int().min(1).max(300).optional().describe("Maximum rows to print. Default 50."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const origin = await resolveStation(input.from);
        if (origin.kind === "none") return text(`🚏 No station matches "${input.from}". Try a shorter spelling.`);
        if (origin.kind === "ambiguous") return text(formatStationPicker(origin.rows, input.from));

        const destination = await resolveStation(input.to);
        if (destination.kind === "none") return text(`🚏 No station matches "${input.to}". Try a shorter spelling.`);
        if (destination.kind === "ambiguous") return text(formatStationPicker(destination.rows, input.to));

        const target = input.time ? parseClock(input.time) : null;
        if (input.time && target === null) {
          return fail(`⚠️ Could not read time "${input.time}". Use "HH:MM" or "5:00 PM".`);
        }

        const notes = [];
        let date = input.date ? input.date.trim() : "";

        if (date) {
          if (!isValidDate(date)) return fail(`⚠️ Invalid date "${date}". Use YYYY-MM-DD.`);
        } else {
          const now = nowInZone();
          date = now.date;
          const nowMinutes = now.minutes;

          if (target !== null && target < nowMinutes) {
            date = addDays(date, 1);
            notes.push(`_${formatClock(target)} has passed today — showing tomorrow._`);
          }
        }

        const serviceTypeId = await resolveServiceTypeId(input.serviceType);

        const result = await api.getBusList({
          from: origin.id,
          to: destination.id,
          date,
          serviceTypeId,
          pageSize: 300,
        });

        const unique = dedupeBuses(result.rows);
        const views = sortByDeparture(unique.map(toBusView));

        const fromLabel =
          origin.label.startsWith("Station ") && unique[0] && unique[0].FromStationName
            ? String(unique[0].FromStationName).trim()
            : origin.label;

        if (views.length === 0 && result.message) notes.push(`_${result.message}_`);

        return text(
          formatBusList({
            fromLabel,
            toLabel: destination.label,
            date,
            views,
            target,
            windowMinutes: input.windowMinutes === undefined ? 60 : input.windowMinutes,
            limit: input.limit === undefined ? 50 : input.limit,
            notes,
          }),
        );
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "search_station",
    {
      title: "Search GSRTC station",
      description:
        "Look up GSRTC station ids by name. Use it when a station name is ambiguous (several towns share a name) " +
        "or when you need the numeric id for `get_bus_list`. " +
        VERBATIM,
      inputSchema: z.object({
        name: z.string().min(1).describe("Station or city name, e.g. 'Vijapur'."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const result = await api.getStationList(name);
        return text(formatStations(result.rows, name));
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "get_bus_list",
    {
      title: "Bus list by station ids",
      description:
        "Raw bus list between two numeric station ids, with paging. Use `search_station` first to find ids, " +
        "or prefer `find_buses` when you only have names. " +
        VERBATIM,
      inputSchema: z.object({
        fromId: z.number().int().positive().describe("Origin station id, e.g. 438."),
        toId: z.number().int().positive().describe("Destination station id, e.g. 782."),
        date: z.string().optional().describe("Travel date as YYYY-MM-DD. Defaults to today."),
        serviceTypeId: z.number().int().min(0).optional().describe("Service type id; 0 means all."),
        page: z.number().int().min(1).optional().describe("Page number. Default 1."),
        pageSize: z.number().int().min(1).max(500).optional().describe("Rows per page. Default 300."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const date = input.date ? input.date.trim() : todayStr();
        if (!isValidDate(date)) return fail(`⚠️ Invalid date "${date}". Use YYYY-MM-DD.`);

        const result = await api.getBusList({
          from: input.fromId,
          to: input.toId,
          date,
          serviceTypeId: input.serviceTypeId === undefined ? 0 : input.serviceTypeId,
          page: input.page === undefined ? 1 : input.page,
          pageSize: input.pageSize === undefined ? 300 : input.pageSize,
        });

        const unique = dedupeBuses(result.rows);
        const views = sortByDeparture(unique.map(toBusView));
        const fromLabel = String((unique[0] && unique[0].FromStationName) || `Station ${input.fromId}`).trim();

        return text(
          formatBusList({
            fromLabel,
            toLabel: `Station ${input.toId}`,
            date,
            views,
            limit: 100,
          }),
        );
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "get_depot_bus_list",
    {
      title: "Depot departures",
      description:
        "Buses departing from one depot/station on a date, with paging. Use `search_station` or " +
        "`get_nearby_depots` to find the location id. " +
        VERBATIM,
      inputSchema: z.object({
        locationId: z.number().int().positive().describe("Depot/station id, e.g. 464."),
        date: z.string().optional().describe("Travel date as YYYY-MM-DD. Defaults to today."),
        page: z.number().int().min(1).optional().describe("Page number. Default 1."),
        pageSize: z.number().int().min(1).max(200).optional().describe("Rows per page. Default 50."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const date = input.date ? input.date.trim() : todayStr();
        if (!isValidDate(date)) return fail(`⚠️ Invalid date "${date}". Use YYYY-MM-DD.`);

        const page = input.page === undefined ? 1 : input.page;
        const pageSize = input.pageSize === undefined ? 50 : input.pageSize;

        const result = await api.getDepotBusList({
          locationId: input.locationId,
          date,
          page,
          pageSize,
        });

        const unique = dedupeBuses(result.rows);
        const views = sortByDeparture(unique.map(toBusView));
        const fromLabel = String((unique[0] && unique[0].FromStationName) || `Depot ${input.locationId}`).trim();

        return text(
          formatDepotBusList({
            fromLabel,
            toLabel: "all destinations",
            date,
            views,
            limit: 100,
            notes: [`_Page ${page} · ${pageSize} rows per page._`],
          }),
        );
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "get_service_types",
    {
      title: "Service types",
      description:
        "List GSRTC bus service types (Express, Sleeper, Volvo 2x2, ...) with the ids used for filtering. " + VERBATIM,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(formatServiceTypes(await api.serviceTypes()));
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "get_nearby_depots",
    {
      title: "Nearby depots",
      description: "Find GSRTC depots/stations near a coordinate, nearest first. Defaults to Ahmedabad. " + VERBATIM,
      inputSchema: z.object({
        lat: z.number().min(-90).max(90).optional().describe("Latitude. Default 23.0225 (Ahmedabad)."),
        lng: z.number().min(-180).max(180).optional().describe("Longitude. Default 72.5714 (Ahmedabad)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ lat, lng }) => {
      try {
        const latitude = lat === undefined ? 23.0225 : lat;
        const longitude = lng === undefined ? 72.5714 : lng;
        const result = await api.getNearbyDepots(latitude, longitude);
        return text(formatDepots(result.rows, latitude, longitude));
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "api_health",
    {
      title: "API health",
      description:
        "Check that the local GSRTC API wrapper is running and can mint a Bearer token. Use it when another tool fails. " +
        VERBATIM,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(formatHealth(await api.getHealth()));
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "self_check",
    {
      title: "Self check",
      description:
        "Prove that this server can reach GSRTC from the host it is running on: reports platform, curl version, " +
        "nonce round-trip, Bearer cache state, and a sample query. Use it right after deploying or when any other tool fails. " +
        VERBATIM,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(formatSelfCheck({ ...(await api.getHealth()), ...runtimeInfo() }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          formatSelfCheck({
            ok: false,
            mode: api.MODE,
            error: message,
            hint: error instanceof Error ? error.hint : undefined,
            // Health failed before it could collect these, yet they are the
            // whole point of a failed self check: which host, which curl build.
            platform: `${process.platform} ${process.arch}`,
            node: process.version,
            curl: await api.curlVersion(),
            curlExtra: api.CURL_EXTRA.length ? api.CURL_EXTRA.join(" ") : "none",
            ...runtimeInfo(),
          }),
        );
      }
    },
  );
}

/* ------------------------------------------------------------------ server */

function createServer() {
  const server = new McpServer(
    { name: "gsrtc", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "GSRTC (Gujarat state bus) data. Use `find_buses` for natural-language origin/destination questions. " +
        "Tool responses are already formatted for the user: relay them as-is instead of converting to JSON.",
    },
  );

  registerTools(server);
  return server;
}

module.exports = { createServer };
