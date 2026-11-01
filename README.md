# gsrtc-mcp

MCP server for GSRTC (Gujarat) bus lists. Two entry points:

- `index.js` — stdio, for opencode, Claude Desktop, and any client that can spawn a process
- `server.js` — Streamable HTTP, for Render and other hosts

Plain JavaScript, no build step, Node 20+.

The server talks to the GSRTC upstream directly (`GSRTC_MODE=direct`, the default) using `curl`, because the Google edge in front of the API rejects Node's TLS fingerprint with a 403.

## Local setup

```sh
npm install
copy .env.example .env      # PowerShell; cp on Linux/macOS
```

Fill in the three required keys in `.env`, then:

```sh
node index.js        # stdio (waits for JSON-RPC on stdin)
npm start            # HTTP on http://localhost:3001/mcp
```

`.env` is loaded from this directory, not the current working directory, and it is gitignored. Real environment variables always win over `.env`, so a deployment can override any value without editing files.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GSRTC_BASE_URL` | **yes** | — | Upstream GSRTC host |
| `GSRTC_ANDROID_ID` | **yes** | — | Device id sent with the session handshake |
| `GSRTC_USER_AGENT` | **yes** | — | `User-Agent` used for upstream calls |
| `GSRTC_MODE` | no | `direct` | `direct` calls GSRTC; `http` talks to a local `api.js` wrapper |
| `GSRTC_TIMEOUT_SEC` | no | `30` | Per-request curl timeout |
| `GSRTC_TZ` | no | `Asia/Kolkata` | Timezone for "today" and past-time rollover |
| `GSRTC_CURL` | no | `curl.exe` / `curl` | curl binary |
| `GSRTC_CURL_EXTRA` | no | — | Extra curl flags, e.g. `--http1.1 --tls-max 1.2` |
| `PORT` / `HOST` | no | `3001` / `0.0.0.0` | HTTP bind |
| `MCP_AUTH_TOKEN` | no | unset | If set, `/mcp` and deep health require `Authorization: Bearer` or `?key=` |
| `GSRTC_API_TIMEOUT_MS` | no | `90000` | http mode only |

Missing required keys stop the server immediately with a message naming the variable.

## Connect to opencode

The repo ships an `opencode.json` that runs the local stdio server:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gsrtc": {
        "type": "local",
        "command": ["node", "index.js"],
        "cwd": "."
      }
    }
  }
}
```

- Check status: `opencode mcp list` shows the last known state; `/mcps` reconnects.
- Edits to `index.js` or any `.js` file are **not** hot-reloaded. Reconnect the server after changing code.
- Editing `opencode.json` reloads MCP servers automatically on save.

## Deploy to Render

`render.yaml` is a Blueprint: Node 22, `npm ci`, `npm start`, health check `/health`, Singapore, free plan.

1. Push the repo to GitHub.
2. Render → New → Blueprint → pick the repo.
3. In the dashboard set `GSRTC_BASE_URL` and `GSRTC_ANDROID_ID` (both are `sync: false` in `render.yaml`, so their values never live in the repo).
4. Optionally set `MCP_AUTH_TOKEN` to lock the endpoint.
5. URL: `https://<service-name>.onrender.com/mcp`

Health:

- `GET /health` — public liveness, no upstream call
- `GET /health?deep=1` — upstream nonce/bearer check; requires the token when `MCP_AUTH_TOKEN` is set

Free instances sleep after inactivity and cold-start in roughly 30–60 seconds, which can exceed an MCP client's startup timeout. Use a paid instance if that matters.

## Tools

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `find_buses` | `from`, `to`, `date?`, `time?`, `windowMinutes?`, `serviceType?`, `limit?` | Main entry point. Accepts station names. |
| `search_station` | `name` | Station ids and cities, for ambiguous names. |
| `get_bus_list` | `fromId`, `toId`, `date?`, `serviceTypeId?`, `page?`, `pageSize?` | Raw ids with paging. |
| `get_depot_bus_list` | `locationId`, `date?`, `page?`, `pageSize?` | Everything leaving one depot. |
| `get_service_types` | — | Express, Sleeper, Volvo 2x2, … with ids. |
| `get_nearby_depots` | `lat?`, `lng?` | Nearest depots to a coordinate. |
| `api_health` | — | Nonce round-trip, for diagnosing setup. |
| `self_check` | — | Platform, curl version, nonce, bearer, and the running file/pid/mtime. |

Every tool returns formatted Markdown, not JSON, and the descriptions tell the model to relay it verbatim.

## Behaviour worth knowing

- **Station names are resolved exactly first.** Exact `StationName`, then exact `CityName`, then a picker table.
- **Duplicate rows are removed.** Upstream repeats a bus once per stage.
- **`Depart` is `ArrivalTime`** (when the bus reaches your stop). `ETATime` runs a minute earlier and drifts.
- **`Arrive` is computed** as `Depart + SchDuration`.
- **`Route` is the whole trip** (`RouteName`), not your leg.
- **Fares are omitted** when GSRTC reports `N/A`.
- **Past times roll forward** to tomorrow, with a note, using `GSRTC_TZ`.
- **Times are estimates** and can shift a minute between requests.

## Testing

```sh
npm run check       # syntax-check every .js file
npm test            # protocol smoke test, no network
npm run test:http   # HTTP routes and token auth, no upstream calls
npm run test:live   # real GSRTC queries
npm run test:all    # check + test + test:http
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `GSRTC_BASE_URL is not set` | `copy .env.example .env` and fill the required keys |
| Tools missing in opencode | `/mcps` → reconnect; code changes are not hot-reloaded |
| `MCP server process exited` | Run `node index.js` by hand and read stderr |
| Wrong "today" or an early/late rollover | Check `GSRTC_TZ`; Render runs UTC by default |
| Upstream errors | Check `curl` is on `PATH`; `self_check` reports the curl version |
| `nonce request failed (HTTP 403)` | The upstream edge rejected this host. `self_check` shows the curl build and HTTP version. Try `GSRTC_CURL_EXTRA=--http1.1`, then `--tls-max 1.2`, then both. If every flag and every region still 403s, the edge blocks that datacenter IP — run the server on a residential/India host or a tunnel from one. |
