"use strict";

/**
 * Rendering layer. Every tool returns a finished, user-facing block of text —
 * never raw JSON — so the model can relay it unchanged.
 */

const { TIME_ZONE } = require("./config.js");

/* ------------------------------------------------------------------- clock */

/** "17:00", "5:00 PM", "5:00PM" -> minutes past midnight. */
function parseClock(value) {
  if (value === null || value === undefined) return null;
  const match = String(value)
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const suffix = match[3] ? match[3].toUpperCase() : "";

  if (suffix === "PM" && hours < 12) hours += 12;
  if (suffix === "AM" && hours === 12) hours = 0;

  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** minutes past midnight -> "5:00 PM". */
function formatClock(minutes) {
  if (minutes === null) return "—";
  const total = ((minutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(total / 60);
  const mins = total % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

/** "01:35:00" -> 95. */
function parseDuration(value) {
  if (value === null || value === undefined) return null;
  const match = String(value)
    .trim()
    .match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return hours * 60 + minutes + (seconds >= 30 ? 1 : 0);
}

function formatDuration(minutes) {
  if (minutes === null || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function formatKm(value) {
  const n = Number.parseFloat(String(value === undefined || value === null ? "" : value));
  if (!Number.isFinite(n) || n <= 0) return "";
  const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} km`;
}

/* -------------------------------------------------------------------- dates */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Current date (YYYY-MM-DD) and minutes past midnight in the configured zone.
 * Render runs in UTC, so the process clock cannot be trusted for IST dates.
 */
const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nowInZone() {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function todayStr() {
  return nowInZone().date;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !Number.isNaN(Date.parse(`${dateStr}T00:00:00`));
}

/** "2026-11-01" -> "Sun, 01 Nov 2026". */
function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(date.getTime())) return dateStr;
  return `${WEEKDAYS[date.getDay()]}, ${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/* ------------------------------------------------------------------- table */

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] || "").length), 1),
  );

  const line = (cells) => `| ${cells.map((cell, index) => (cell || "").padEnd(widths[index])).join(" | ")} |`;

  const divider = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;

  return [line(headers), divider, ...rows.map((row) => line(row))].join("\n");
}

/* ---------------------------------------------------------------- bus rows */

function dedupeBuses(rows) {
  const seen = new Set();
  const unique = [];

  for (const row of rows) {
    const key = String(row.TripId || row.RawId || `${row.BusNo}|${row.ETATime}`);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  return unique;
}

function readFare(row) {
  const raw = row.Fare;
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text && text.toUpperCase() !== "N/A" && Number.parseFloat(text) > 0) return `₹${text}`;

  const total = Number(row.AdultTotalFare);
  if (Number.isFinite(total) && total > 0) return `₹${total}`;
  return "";
}

function toBusView(row) {
  const depart = parseClock(row.ArrivalTime) !== null ? parseClock(row.ArrivalTime) : parseClock(row.ETATime);
  const durationMinutes = parseDuration(row.SchDuration);
  const arrive = depart !== null && durationMinutes !== null ? depart + durationMinutes : null;

  const text = (value, fallback) => {
    const cleaned = String(value === undefined || value === null ? "" : value).trim();
    return cleaned || fallback;
  };

  return {
    depart,
    arrive,
    busNo: text(row.BusNo, "—"),
    type: text(row.BusServiceType || row.ServiceType, "—"),
    route: text(row.RouteName, "—"),
    status: text(row.BusRunningStatus, "—"),
    duration: formatDuration(durationMinutes),
    distance: formatKm(row.Distance),
    fare: readFare(row),
  };
}

function sortByDeparture(views) {
  return [...views].sort((a, b) => (a.depart === null ? 9999 : a.depart) - (b.depart === null ? 9999 : b.depart));
}

function withinWindow(views, target, windowMinutes) {
  return views.filter((view) => view.depart !== null && Math.abs(view.depart - target) <= windowMinutes);
}

function nearest(views, target, count) {
  return [...views]
    .filter((view) => view.depart !== null)
    .sort((a, b) => Math.abs(a.depart - target) - Math.abs(b.depart - target))
    .slice(0, count)
    .sort((a, b) => a.depart - b.depart);
}

function busTable(views) {
  const showFare = views.some((view) => view.fare);
  const headers = ["Depart", "Arrive", "Bus No", "Type", "Route", "Status", "Travel"];
  if (showFare) headers.push("Fare");

  const rows = views.map((view) => {
    const travel = [view.duration, view.distance].filter(Boolean).join(" · ") || "—";
    const cells = [
      formatClock(view.depart),
      formatClock(view.arrive),
      view.busNo,
      view.type,
      view.route,
      view.status,
      travel,
    ];
    if (showFare) cells.push(view.fare || "—");
    return cells;
  });

  return renderTable(headers, rows);
}

/* ------------------------------------------------------------ bus list text */

const busWord = (count) => (count === 1 ? "1 bus" : `${count} buses`);

function formatBusList(options) {
  const fromLabel = options.fromLabel;
  const toLabel = options.toLabel;
  const date = options.date;
  const views = options.views;
  const target = options.target === undefined ? null : options.target;
  const windowMinutes = options.windowMinutes === undefined ? 60 : options.windowMinutes;
  const limit = options.limit;
  const notes = options.notes || [];

  const lines = [];
  const total = views.length;

  lines.push(`🚌 **${fromLabel} → ${toLabel}** · ${prettyDate(date)} · ${busWord(total)}`);

  for (const note of notes) lines.push(note);

  if (total === 0) {
    lines.push("");
    lines.push("No buses found on this route for that date.");
    return lines.join("\n");
  }

  if (target !== null) {
    const matched = withinWindow(views, target, windowMinutes);
    if (matched.length === 0) {
      lines.push("");
      lines.push(`No bus around ${formatClock(target)} (±${windowMinutes} min).`);
      lines.push("");
      lines.push("**Nearest departures**");
      lines.push("");
      lines.push(busTable(nearest(views, target, 2)));
      return lines.join("\n");
    }

    lines.push(`Around ${formatClock(target)} (±${windowMinutes} min) — ${busWord(matched.length)}`);
    lines.push("");
    lines.push(busTable(matched.slice(0, limit)));
    if (matched.length > limit) {
      lines.push("");
      lines.push(`_Showing ${limit} of ${matched.length} — raise \`limit\` to see more._`);
    }
    return lines.join("\n");
  }

  lines.push("");
  lines.push(busTable(views.slice(0, limit)));
  if (views.length > limit) {
    lines.push("");
    lines.push(`_Showing ${limit} of ${views.length} — raise \`limit\` to see more._`);
  }
  if (!views.some((view) => view.fare)) {
    lines.push("");
    lines.push("_Fares are not published for these services._");
  }
  lines.push("");
  lines.push("_Depart/Arrive are GSRTC estimates._");

  return lines.join("\n");
}

/* ------------------------------------------------------------- other texts */

function formatStations(rows, query) {
  if (rows.length === 0) {
    return `🚏 No station matches "${query}". Try a shorter spelling or a nearby city name.`;
  }

  const table = renderTable(
    ["ID", "Station", "City"],
    rows.map((row) => [
      String(row.StationId || "—"),
      String(row.StationName || "—").trim(),
      String(row.CityName || "—").trim(),
    ]),
  );

  return [
    `🚏 Stations matching "${query}" — ${rows.length} found`,
    "",
    table,
    "",
    "_Pass the exact station name to `find_buses`, or the ID to `get_bus_list`._",
  ].join("\n");
}

function formatStationPicker(rows, query) {
  const table = renderTable(
    ["ID", "Station", "City"],
    rows.map((row) => [
      String(row.StationId || "—"),
      String(row.StationName || "—").trim(),
      String(row.CityName || "—").trim(),
    ]),
  );

  return [
    `❓ "${query}" matches ${rows.length} stations — which one did you mean?`,
    "",
    table,
    "",
    "_Ask again with the exact station name, or pass the ID directly._",
  ].join("\n");
}

function formatServiceTypes(rows) {
  if (rows.length === 0) return "🎫 No service types returned by the API.";

  const table = renderTable(
    ["ID", "Service type"],
    rows.map((row) => [String(row.ServiceTypeID || "—"), String(row.ServiceTypeName || "—").trim()]),
  );

  return [`🎫 GSRTC service types — ${rows.length}`, "", table].join("\n");
}

function formatDepots(rows, lat, lng) {
  if (rows.length === 0) {
    return `🏭 No depots found near ${lat}, ${lng}.`;
  }

  const table = renderTable(
    ["ID", "Station", "Distance"],
    rows.map((row) => [
      String(row.StationId || "—"),
      String(row.StationName || "—").trim(),
      formatKm(row.Distance) || "—",
    ]),
  );

  return [
    `🏭 Depots near ${lat}, ${lng} — ${rows.length}`,
    "",
    table,
    "",
    "_Use the ID with `get_depot_bus_list`._",
  ].join("\n");
}

function formatDepotBusList(options) {
  return formatBusList(options).replace(/^🚌/, "🏭");
}

function formatHealth(health) {
  const base = String(health.base || "—");
  const bearer = health.bearerCached ? "yes" : "no";
  const ms = typeof health.ms === "number" ? `${health.ms} ms` : "—";

  const lines = [
    "✅ GSRTC data source reachable",
    "",
    `- Mode: ${String(health.mode || "direct")}`,
    `- Endpoint: ${base}`,
  ];

  if (health.platform) lines.push(`- Platform: ${health.platform} · node ${health.node || "—"}`);
  if (health.curl) lines.push(`- curl: ${health.curl}`);
  if (health.curlExtra && health.curlExtra !== "none") lines.push(`- curl extra: ${health.curlExtra}`);

  lines.push(`- Bearer cached: ${bearer}`);
  lines.push(`- Nonce round-trip: ${ms}`);

  return lines.join("\n");
}

function formatSelfCheck(info) {
  const ok = info.ok !== false;
  const lines = [
    ok ? "🩺 Self check — everything works" : "⚠️ Self check — something failed",
    "",
  ];

  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`- ${label}: ${value}`);
  };

  add("Mode", info.mode);
  add("Version", info.version);
  add("Entry", info.file);
  add("Entry mtime", info.mtime);
  add("PID", info.pid);
  add("CWD", info.cwd);
  add("Platform", info.platform);
  add("Node", info.node);
  add("curl", info.curl);
  add("curl extra", info.curlExtra === "none" ? undefined : info.curlExtra);
  add("Upstream", info.base);
  add("Nonce", info.nonce);
  add("Bearer", info.bearerCached === undefined ? undefined : info.bearerCached ? "cached" : "not cached");
  add("Sample query", info.sampleStations === undefined ? undefined : `${info.sampleStations} stations`);
  add("Total time", typeof info.ms === "number" ? `${info.ms} ms` : undefined);

  if (info.error) {
    lines.push("");
    lines.push(String(info.error));
  }

  if (info.hint) {
    lines.push("");
    lines.push(String(info.hint));
  }

  if (!ok) {
    lines.push("");
    lines.push("_The server is running, but it cannot reach GSRTC from this host._");
  }

  return lines.join("\n");
}

function formatUpstreamDown(error) {
  return [
    "⚠️ Cannot reach the GSRTC bus data source.",
    "",
    error.message,
    error.hint ? `\n${error.hint}` : "",
    "",
    "_The MCP server is fine — the upstream GSRTC call failed._",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

module.exports = {
  parseClock,
  formatClock,
  parseDuration,
  formatDuration,
  formatKm,
  nowInZone,
  todayStr,
  addDays,
  isValidDate,
  prettyDate,
  dedupeBuses,
  toBusView,
  sortByDeparture,
  withinWindow,
  nearest,
  formatBusList,
  formatStations,
  formatStationPicker,
  formatServiceTypes,
  formatDepots,
  formatDepotBusList,
  formatHealth,
  formatSelfCheck,
  formatUpstreamDown,
};
