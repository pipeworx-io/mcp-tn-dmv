interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Tennessee DMV MCP — Department of Safety and Homeland Security: the 186 driver service
 * centers with their per-center service capabilities, and the state's impaired-driving crash
 * file. Keyless.
 *
 * One pack per state agency: Tennessee's grain is a per-counter capability matrix (does this
 * location do REAL ID? the CDL skills test? handgun permits? a vision test?) published on the
 * department's own ArcGIS, which has nothing in common with California's ZIP-level registration
 * snapshot. A union schema across states would leave most arguments ignored, so Tennessee gets
 * its own tools with its own arguments.
 *
 * Sources (verified live 2026-07-29):
 *   tnmap.tn.gov SAFETY/DriverServiceCenters/MapServer/0 — 186 locations (44 full service,
 *     93 self-service kiosks, 46 county clerk partners, 3 express) with address, county,
 *     hours, phone, X/Y coordinate columns and 21 Yes/No service flags.
 *   tnmap.tn.gov SAFETY/DUICrashesArrestsAgeGender/MapServer/0 — person-level records for
 *     injury and fatal crashes with alcohol or drug involvement, calendar year 2022.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-tn-dmv/1.0 (+https://pipeworx.io)';
const CENTER_LAYER = 'https://tnmap.tn.gov/arcgis/rest/services/SAFETY/DriverServiceCenters/MapServer/0';
const CRASH_LAYER = 'https://tnmap.tn.gov/arcgis/rest/services/SAFETY/DUICrashesArrestsAgeGender/MapServer/0';
const CRASH_YEAR = '2022';

/** The 21 Yes/No capability columns, in the order Tennessee groups them on its own site. */
const SERVICE_FLAGS: Record<string, string> = {
  USER_Real_ID: 'REAL ID',
  USER_New_Application: 'new application',
  USER_Photo_ID: 'photo ID',
  USER_Handgun: 'handgun permit',
  USER_Vision_Test: 'vision test',
  USER_Road_Motorcycle_Test: 'road or motorcycle test',
  USER_Knowledge_Test: 'knowledge test',
  USER_CDL_Skills_Test: 'CDL skills test',
  USER_Renewal: 'renewal',
  USER_Name_Change: 'name change',
  USER_Address_Change: 'address change',
  USER_GDL_Upgrades: 'graduated license upgrade',
  USER_Duplicate: 'duplicate license',
  USER_Motor_Vehicle_Report: 'motor vehicle report',
  USER_Setup_Payment_Plan: 'set up a payment plan',
  USER_Pay_Fees: 'pay reinstatement fees',
  USER_Submit_Documentation: 'submit reinstatement documentation',
  USER_Full_Service: 'full service',
  USER_Express: 'express service',
  USER_Third__Party: 'third-party testing',
  USER_Kiosk: 'self-service kiosk',
};

const SERVICE_LABELS = Object.values(SERVICE_FLAGS);

const CRASH_GROUPS: Record<string, string> = {
  age_group: 'AgeGroupTxt',
  gender: 'GenderTxt',
  severity: 'CrashTypeText',
  agency: 'AgencyNameTxt',
  substance: 'substance',
  month: 'month',
};

interface Center {
  state: string;
  name: string;
  office_type: string | null;
  station_code: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  phone: string | null;
  hours: string | null;
  latitude: number | null;
  longitude: number | null;
  services: string[];
  notes: string | null;
  url: string | null;
}

/**
 * Tennessee's USER_City column runs some names together ("OakRidge", "MtJuliet"), so both
 * sides are stripped to letters and digits before comparing. A caller typing "Oak Ridge"
 * should not be told the city does not exist.
 */
function loose(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looseMatch(hay: unknown, needle: string): boolean {
  const n = loose(needle);
  return n !== '' && loose(hay).includes(n);
}

function tidy(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

const CENTER_FIELDS = [
  'OBJECTID', 'USER_Station_Code', 'USER_Location_Name', 'USER_Address', 'USER_City',
  'USER_County', 'USER_ZIP', 'USER_Hours', 'USER_Listed_Phone', 'USER_Notes', 'Service_Type',
  'X', 'Y', ...Object.keys(SERVICE_FLAGS),
].join(',');

async function loadCenters(): Promise<Center[]> {
  // X and Y are attribute columns on this layer (X longitude, Y latitude), so no geometry
  // round-trip is needed. Fields are named explicitly to leave behind USER_Website_Name and
  // USER_Website_Services, two pre-rendered HTML blobs that between them roughly triple the
  // response size and duplicate columns already returned here — the full-layer fetch failed
  // outright with them included.
  const feats = await arcgisQuery(CENTER_LAYER, { limit: 500, outFields: CENTER_FIELDS, userAgent: UA });
  return feats.map(({ attributes: a }) => ({
    state: 'TN',
    name: String(a.USER_Location_Name ?? '').trim(),
    office_type: (a.Service_Type as string) ?? 'Driver service center',
    station_code: a.USER_Station_Code ? String(a.USER_Station_Code) : null,
    address: (a.USER_Address as string) ?? null,
    city: (a.USER_City as string) ?? null,
    county: (a.USER_County as string) ?? null,
    zip: a.USER_ZIP ? String(a.USER_ZIP) : null,
    phone: (a.USER_Listed_Phone as string) ?? null,
    hours: tidy(a.USER_Hours),
    latitude: govNumber(a.Y),
    longitude: govNumber(a.X),
    services: arcgisFlagLabels(a, SERVICE_FLAGS),
    notes: tidy(a.USER_Notes),
    url: null,
  }));
}

const tools: McpToolExport['tools'] = [
  {
    name: 'tn_dmv_driver_service_centers',
    description:
      'Find Tennessee driver service centers (Department of Safety and Homeland Security) with street address, county, hours, phone, coordinates, and exactly which services each of the 186 locations performs. Tennessee publishes a per-location capability matrix, so this answers questions a plain address list cannot: "which Tennessee driver service center issues a REAL ID", "where can I take the CDL skills test in Tennessee", "which Tennessee location does handgun permits", "where do I get a vision test near Knoxville", or "is there a driver services kiosk in Memphis". Locations split into full service centers, self-service kiosks, county clerk partners and express counters. Filter by city, county, ZIP, name or required service; call with no arguments for all 186.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Nashville", "Oak Ridge". Matched loosely, so spacing does not matter.' },
        county: { type: 'string', description: 'Tennessee county name, matched as a substring, e.g. "Davidson", "Shelby".' },
        zip: { type: 'string', description: 'Five-digit Tennessee ZIP code, or a prefix, e.g. "37830".' },
        name: { type: 'string', description: 'Location-name substring, e.g. "Oak Ridge", "Express".' },
        service: {
          type: 'string',
          description: `Require a service, matched as a substring. Published services: ${SERVICE_LABELS.join(', ')}.`,
        },
        limit: { type: ['number', 'string'], description: 'Max locations to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'tn_dmv_impaired_driving_crashes',
    description:
      `Count Tennessee injury and fatal traffic crashes involving alcohol or drugs, from the Department of Safety and Homeland Security crash file for calendar year ${CRASH_YEAR}. Each record is one person involved in an impaired-driving crash, carrying crash severity (fatal, suspected serious injury, suspected minor injury), the driver age group and gender, the investigating law-enforcement agency, date, time and coordinates. Answers "how many fatal DUI crashes in Tennessee", "which age group is involved in the most alcohol-related crashes in Tennessee", "drug-involved crashes by police agency", or "impaired driving crashes by month". Group results by age_group, gender, severity, agency, substance or month, and get a sample of the underlying records with latitude and longitude for mapping.`,
    inputSchema: {
      type: 'object',
      properties: {
        substance: { type: 'string', description: '"alcohol", "drugs", "both" (alcohol and drugs together), or "either" (default — any impairment).' },
        severity: { type: 'string', description: 'Crash severity substring: "fatal", "serious injury", "minor injury".' },
        age_group: { type: 'string', description: 'Age band substring as published, e.g. "21 to 24", "80 & Up", "16 to 17".' },
        gender: { type: 'string', description: 'Published as "M" or "F"; "male"/"female" are accepted.' },
        agency: { type: 'string', description: 'Investigating agency substring. State troopers are published as "THP District 3 - Nashville" and similar, so "THP" selects all of them; city forces read "METROPOLITAN NASHVILLE POLICE DEPT", "MEMPHIS POLICE DEPT"; counties read "SHERIFF".' },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(CRASH_GROUPS).join(', ')}. Defaults to age_group.` },
        limit: { type: ['number', 'string'], description: 'Max sample records returned alongside the counts (default 10, max 200).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

async function driverServiceCenters(args: Record<string, unknown>): Promise<unknown> {
  let list = await loadCenters();
  const statewide = list.length;
  if (!list.length) {
    return govNotFound(
      'upstream_empty',
      'Tennessee returned no driver service centers. Retry once — tnmap.tn.gov stalls occasionally and answers normally on the next call.',
    );
  }
  const city = govString(args, 'city');
  if (city) list = list.filter((o) => looseMatch(o.city, city) || looseMatch(o.name, city));
  const county = govString(args, 'county');
  if (county) list = list.filter((o) => govContains(o.county, county));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => (o.zip ?? '').startsWith(zip));
  const name = govString(args, 'name');
  if (name) list = list.filter((o) => looseMatch(o.name, name));
  const service = govString(args, 'service');
  if (service) list = list.filter((o) => o.services.some((s) => govContains(s, service)));
  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No Tennessee driver service center matched those filters. Drop the narrowest one — \`service\` and \`city\` are the usual culprits — or call with no arguments for all ${statewide} locations statewide. Tennessee publishes these service labels: ${SERVICE_LABELS.join(', ')}.`,
      { filters_applied: { city, county, zip, name, service }, available_services: SERVICE_LABELS, statewide_office_count: statewide },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'TN',
    source: 'TN Department of Safety and Homeland Security ArcGIS SAFETY/DriverServiceCenters — driver service centers',
    office_count: list.length,
    statewide_office_count: statewide,
    truncated: list.length > limit,
    offices: list.slice(0, limit),
    note: 'office_type distinguishes Full Service centers from Kiosk, County Clerk partner and Express locations; a kiosk performs only the services listed for it.',
  };
}

interface CrashRow {
  date: string | null;
  time: string | null;
  severity: string | null;
  age_group: string | null;
  gender: string | null;
  agency: string | null;
  alcohol: boolean;
  drugs: boolean;
  latitude: number | null;
  longitude: number | null;
  crash_id: string | null;
}

function substanceWhere(substance: string | undefined): string | null {
  switch ((substance ?? 'either').toLowerCase()) {
    case 'either':
    case 'any':
    case 'impaired':
      return "(Alcohol='Yes' OR Drugs='Yes')";
    case 'alcohol':
      return "Alcohol='Yes'";
    case 'drugs':
    case 'drug':
      return "Drugs='Yes'";
    case 'both':
      return "(Alcohol='Yes' AND Drugs='Yes')";
    default:
      return null;
  }
}

async function impairedDrivingCrashes(args: Record<string, unknown>): Promise<unknown> {
  const substance = govString(args, 'substance');
  const where = substanceWhere(substance);
  if (!where) {
    return govNotFound(
      'unsupported_substance',
      'Tennessee flags alcohol and drug involvement separately. Use substance="alcohol", "drugs", "both" or "either".',
      { requested_substance: substance, supported_substance: ['alcohol', 'drugs', 'both', 'either'] },
    );
  }
  const groupKey = (govString(args, 'group_by') ?? 'age_group').toLowerCase();
  if (!CRASH_GROUPS[groupKey]) {
    return govNotFound(
      'unsupported_group_by',
      `Tennessee supports group_by of ${Object.keys(CRASH_GROUPS).join(', ')}.`,
      { supported_group_by: Object.keys(CRASH_GROUPS) },
    );
  }

  // "either" is the widest filter and returns ~1,540 person records, comfortably inside the
  // layer's 2,000-record page, so one request holds the whole impaired-driving file.
  const feats = await arcgisQuery(CRASH_LAYER, {
    where,
    outFields:
      'MstrRecNbrTxt,CollisionDte,CollisionTimeTxt,GenderTxt,AgeGroupTxt,AgencyNameTxt,CrashTypeText,Alcohol,Drugs,LatDecimalNmb,LongDecimalNmb',
    limit: 2000,
    userAgent: UA,
  });
  let rows: CrashRow[] = feats.map(({ attributes: a }) => ({
    date: typeof a.CollisionDte === 'string' ? a.CollisionDte.slice(0, 10) : null,
    time: (a.CollisionTimeTxt as string) ?? null,
    severity: (a.CrashTypeText as string) ?? null,
    age_group: (a.AgeGroupTxt as string) ?? null,
    gender: (a.GenderTxt as string) ?? null,
    agency: (a.AgencyNameTxt as string) ?? null,
    alcohol: String(a.Alcohol ?? '') === 'Yes',
    drugs: String(a.Drugs ?? '') === 'Yes',
    latitude: govNumber(a.LatDecimalNmb),
    longitude: govNumber(a.LongDecimalNmb),
    crash_id: a.MstrRecNbrTxt ? String(a.MstrRecNbrTxt) : null,
  }));

  const severity = govString(args, 'severity');
  if (severity) rows = rows.filter((r) => govContains(r.severity, severity));
  const ageGroup = govString(args, 'age_group');
  if (ageGroup) rows = rows.filter((r) => govContains(r.age_group, ageGroup));
  const genderRaw = govString(args, 'gender');
  const gender = genderRaw ? genderRaw.trim().charAt(0).toUpperCase() : undefined;
  if (gender) rows = rows.filter((r) => (r.gender ?? '').toUpperCase() === gender);
  const agency = govString(args, 'agency');
  if (agency) rows = rows.filter((r) => govContains(r.agency, agency));

  if (!rows.length) {
    return govNotFound(
      'no_matching_crashes',
      `No Tennessee impaired-driving crash records matched those filters. Drop \`agency\` or \`age_group\` first — state troopers are published as "THP District 3 - Nashville" rather than "Highway Patrol", so use agency="THP" — or call with substance="either" and no other filters for every ${CRASH_YEAR} record.`,
      { filters_applied: { substance: substance ?? 'either', severity, age_group: ageGroup, gender, agency } },
    );
  }

  const bucketOf = (r: CrashRow): string => {
    switch (groupKey) {
      case 'gender': return r.gender ?? 'Unknown';
      case 'severity': return r.severity ?? 'Unknown';
      case 'agency': return r.agency ?? 'Unknown';
      case 'month': return r.date ? r.date.slice(0, 7) : 'Unknown';
      case 'substance':
        return r.alcohol && r.drugs ? 'alcohol and drugs' : r.alcohol ? 'alcohol only' : 'drugs only';
      default: return r.age_group ?? 'Unknown';
    }
  };
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(bucketOf(r), (counts.get(bucketOf(r)) ?? 0) + 1);

  const limit = govLimit(args.limit, 10, 200);
  return {
    state: 'TN',
    grain: `people involved in alcohol- or drug-related injury and fatal crashes, by ${groupKey}`,
    as_of: CRASH_YEAR,
    source: 'TN Department of Safety and Homeland Security ArcGIS SAFETY/DUICrashesArrestsAgeGender — impaired-driving crashes',
    person_records: rows.length,
    distinct_crashes: new Set(rows.map((r) => r.crash_id).filter(Boolean)).size,
    fatal_records: rows.filter((r) => govContains(r.severity, 'fatal')).length,
    alcohol_records: rows.filter((r) => r.alcohol).length,
    drug_records: rows.filter((r) => r.drugs).length,
    rows: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([bucket, n]) => ({ [groupKey]: bucket, person_records: n })),
    sample_crashes: rows.slice(0, limit),
    note: `Tennessee publishes one row per person involved, so person_records exceeds distinct_crashes — about 1,540 person records across roughly 600 crashes for the whole ${CRASH_YEAR} file. The layer covers ${CRASH_YEAR} only and includes injury and fatal crashes; property-damage-only crashes sit outside it. An "Unknown" age group is the agency's own value for records where age was never recorded.`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'tn_dmv_driver_service_centers': return await driverServiceCenters(args);
      case 'tn_dmv_impaired_driving_crashes': return await impairedDrivingCrashes(args);
      default:
        return govNotFound('unknown_tool', `tn-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `tn-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'tnmap.tn.gov stalled. Retry the identical call once; it usually answers in about a second.'
        : 'tnmap.tn.gov refused the request or changed shape. Retry once; if it persists the SAFETY layer may have been republished at a new path.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
