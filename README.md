# @pipeworx/tn-dmv

Tennessee Department of Safety and Homeland Security: the 186 driver service centers with their
per-location service capabilities, plus the state's impaired-driving crash file. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Why Tennessee gets its own pack

This came out of splitting a single multiplexed `us-dmv` tool into one pack per state agency.
Tennessee's grain is a **per-counter capability matrix** — REAL ID, CDL skills test, handgun
permit, vision test — published on the department's own ArcGIS, which has nothing in common
with California's ZIP-level registration snapshot. A union schema across states leaves most
arguments ignored on every call, so Tennessee's arguments are Tennessee's.

## Tools

| Tool | What it returns |
|---|---|
| `tn_dmv_driver_service_centers` | Address, county, hours, phone, coordinates and the 21 service capabilities each location publishes |
| `tn_dmv_impaired_driving_crashes` | Alcohol- and drug-involved injury and fatal crashes for 2022, grouped by age, gender, severity, agency, substance or month, with a mappable sample |

`tn_dmv_driver_service_centers` filters: `city`, `county`, `zip` (prefix), `name`, `service`, `limit`.
`tn_dmv_impaired_driving_crashes` filters: `substance`, `severity`, `age_group`, `gender`,
`agency`, `group_by`, `limit`.

## The distinctive fields

REAL ID, **CDL skills test** (only 4 of 186 locations do it), **handgun permit** (47 locations)
and **vision test** are the filters worth knowing about — they are the questions a plain address
list cannot answer. `office_type` separates the 44 full-service centers from 93 self-service
kiosks, 46 county-clerk partners and 3 express counters, which matters because a kiosk performs
only a handful of the listed services.

## Auth

None. `tnmap.tn.gov` is a public state ArcGIS host.

## Gotchas worth knowing

- **City names run together.** `USER_City` is published as `OakRidge`, `MtJuliet` and similar,
  so `city` is matched after stripping both sides to letters and digits — a caller typing
  "Oak Ridge" gets the Oak Ridge center rather than a not-found.
- **`X` is longitude and `Y` is latitude**, both as attribute columns, so no geometry
  round-trip is needed.
- **Two HTML blob columns had to be excluded.** `USER_Website_Name` and `USER_Website_Services`
  are pre-rendered `<br>`-separated markup that duplicates columns already returned and roughly
  triples the payload; with them included the full-layer fetch failed outright rather than
  merely running slowly. The query names its fields explicitly to leave them behind.
- **The crash layer is person-level, and 2022 only.** `SAFETY/DUICrashesArrestsAgeGender`
  layer 0 holds one row per person involved: ~1,543 person records across ~603 distinct crashes.
  Both numbers are reported (`person_records`, `distinct_crashes`) because quoting the row count
  as a crash count would overstate it by 2.5×. It covers injury and fatal crashes; property-damage-only
  crashes sit outside it. The whole file is calendar year 2022, reported as `as_of`.
- **State troopers are not called "Highway Patrol" in the data.** They appear as
  `THP District 3 - Nashville` and seven other districts, so `agency: "THP"` selects all of
  them; `agency: "HIGHWAY PATROL"` matches nothing.
- **"Unknown" is a real age group**, the agency's own value for records where age was never
  recorded, and it is the largest bucket (386 of 1,543). It is left in rather than silently
  dropped.
- The wider `SAFETY/` ArcGIS folder also carries `DeerCrashes2019to2023` and `I24_CrashHotspots`.
  Both are cartographic multi-layer map services (severity-split display layers, basemap
  boundaries, a weighted-likelihood raster) rather than one queryable table, so they are left
  out; the DUI layer was the one that returned real, aggregatable records.

## Data sources

- [TN SAFETY ArcGIS `DriverServiceCenters/MapServer/0`](https://tnmap.tn.gov/arcgis/rest/services/SAFETY/DriverServiceCenters/MapServer/0)
- [TN SAFETY ArcGIS `DUICrashesArrestsAgeGender/MapServer/0`](https://tnmap.tn.gov/arcgis/rest/services/SAFETY/DUICrashesArrestsAgeGender/MapServer/0)

Both verified live 2026-07-30.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tn-dmv": {
      "url": "https://gateway.pipeworx.io/tn-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/tn-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/tn_dmv_driver_service_centers \
  -H 'Content-Type: application/json' \
  -d '{"service":"CDL skills test"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/tn_dmv_driver_service_centers`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "tn-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-tn-dmv"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-tn-dmv
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Tn Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
