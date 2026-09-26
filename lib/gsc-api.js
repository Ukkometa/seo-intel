/**
 * lib/gsc-api.js — the one place that knows Search Console endpoints.
 *
 * Search Console data reaches seo-intel two ways: CSV exports a person clicked
 * through the UI to download (lib/gsc-import.js), and the Search Analytics API.
 * The API path used to live inside one analysis (gsc-platform) with its own
 * endpoint string, its own token resolution and its own error text. Each new
 * API consumer would have copied that, and every copy would have drifted:
 * a different rowLimit here, a different 401 message there, and nobody able
 * to answer "which property did we actually fetch from?".
 *
 * So the transport lives here and nowhere else. This module knows:
 *   - the endpoint URLs (GSC_ENDPOINTS)
 *   - how to turn an HTTP failure into something a person can act on
 *     (GscApiError: 401 means reconnect, 403 means the property or the Cloud
 *     project, 429 means wait)
 *   - which Bearer token to send (resolveAccessToken), in the same order the
 *     gsc-platform analysis always used
 *   - how to pick the account property that stands for a configured domain
 *     (matchProperty) — a domain property, a URL-prefix property, or a
 *     configured override — without guessing when nothing fits
 *   - how to page a Search Analytics query and reshape its rows into the
 *     gsc_daily table (searchAnalyticsAll, rowsToDaily)
 *
 * It knows nothing about the database or about analyses. Every network call
 * takes an injectable fetch so tests never touch the real API, and every
 * transformation is a pure function so it can be tested on fixtures.
 *
 * The API's own units are kept as they arrive: ctr is a fraction (0-1), and
 * the page key is the canonical URL Google chose, which can differ from the
 * crawled spelling in scheme, www and trailing slash. Reconciling that with
 * crawled pages is a consumer's job (see normalizeUrlKey in gsc-import.js).
 * Low-volume queries are anonymised and omitted by the API, so query-grain
 * totals sum to less than the property total; that is Google's contract,
 * not a bug here.
 *
 * URL Inspection is the other API this module speaks (inspectUrl, with
 * urlBelongsToProperty to refuse a URL the property cannot answer for, and
 * inspectionToRow to flatten Google's verdict into the gsc_inspections
 * shape). It is a different animal from Search Analytics: one request per
 * URL, 2,000 per property per day (URL_INSPECTION_QUOTA), and the answer is
 * Google's own index verdict rather than traffic. Which URLs deserve one of
 * those 2,000 requests is an analysis decision (analyses/gsc-inspect); this
 * module only makes the call and shapes the answer.
 *
 * The Links report has no API endpoint at all.
 */

import { getAccessToken, isConnected } from './oauth.js';

export const GSC_ENDPOINTS = {
  sites: 'https://www.googleapis.com/webmasters/v3/sites',
  searchAnalytics: (siteUrl) => `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
  urlInspection: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
};

/** The API's hard ceiling on rows per request. */
export const MAX_ROW_LIMIT = 25_000;

/**
 * URL Inspection quota, per property. The day is the binding one: a site
 * with more URLs than this cannot be inspected in full in one day, whatever
 * the concurrency, so callers must choose which URLs to spend it on.
 */
export const URL_INSPECTION_QUOTA = { perDay: 2000, perMinute: 600 };

const RECONNECT_HINT = 'Token rejected. Reconnect with: seo-intel auth google';

/**
 * The fix for an HTTP status, phrased for the person at the terminal. The
 * status codes carry meaning the API's own message does not: a 403 says
 * "insufficient permission" whether the account lacks the property or the
 * Cloud project never enabled the API, and both fixes are outside this tool.
 */
export function hintForStatus(status, apiMessage = '') {
  switch (Number(status)) {
    case 401:
      return RECONNECT_HINT;
    case 403:
      return 'No permission on this property, or the Search Console API is not enabled in the Google Cloud '
        + 'project that owns the OAuth client. Check the property\'s users in Search Console, and enable '
        + '"Google Search Console API" in the Cloud console for the project behind GOOGLE_CLIENT_ID.';
    case 429:
      return 'Search Console API quota exhausted. Wait a while and retry; narrow the date range or fetch fewer dimensions to use fewer requests.';
    default:
      return apiMessage || '';
  }
}

export class GscApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, hint?: string }} [details]
   */
  constructor(message, { status, hint } = {}) {
    super(message);
    this.name = 'GscApiError';
    this.status = status ?? null;
    this.hint = hint ?? hintForStatus(status, message);
  }
}

/**
 * Read a failed response body without assuming it is JSON. Google answers
 * with { error: { code, message, status } }, but a proxy or a quota page can
 * answer with HTML, and the body can only be read once.
 */
async function readErrorBody(res) {
  let text = '';
  try {
    if (typeof res.text === 'function') text = await res.text();
    else if (typeof res.json === 'function') text = JSON.stringify(await res.json());
  } catch { /* unreadable body: the status still tells the story */ }
  let apiMessage = '';
  try {
    const parsed = JSON.parse(text);
    apiMessage = parsed?.error?.message || parsed?.error?.status || '';
  } catch { /* not JSON */ }
  return apiMessage || String(text || '').slice(0, 300);
}

/**
 * `hints` lets an endpoint override the fix for a status where the generic
 * one would mislead: a Search Analytics 429 is answered by a narrower query,
 * a URL Inspection 429 is not.
 */
async function throwForResponse(res, context, hints = {}) {
  const apiMessage = await readErrorBody(res);
  const message = `Search Console API ${res.status} for ${context}${apiMessage ? `: ${apiMessage}` : ''}`;
  const hint = hints[res.status] ?? hintForStatus(res.status, apiMessage);
  throw new GscApiError(message, { status: res.status, hint });
}

const defaultOauth = { getAccessToken, isConnected };

/**
 * Resolve the Bearer token for the Search Console API, in order:
 *   1. opts.accessToken      explicit, for programmatic callers and tests
 *   2. GSC_ACCESS_TOKEN      env override for CI and hand-issued short-lived tokens
 *   3. lib/oauth.js          the account connected with "seo-intel auth google",
 *                            auto-refreshed by getAccessToken()
 * The connected-account path is only consulted when the explicit and env
 * overrides are absent so a CI token never triggers a refresh. The OAuth
 * module is injectable (opts.oauth) so tests can simulate "not connected"
 * without touching the real token store.
 */
export async function resolveAccessToken(opts = {}) {
  if (opts.accessToken) return opts.accessToken;
  if (process.env.GSC_ACCESS_TOKEN) return process.env.GSC_ACCESS_TOKEN;
  const oauth = opts.oauth || defaultOauth;
  if (oauth.isConnected('google')) return oauth.getAccessToken('google');
  throw new Error(
    'No Google Search Console credentials. Run "seo-intel auth google" to connect your Google account, '
    + 'or set GSC_ACCESS_TOKEN with a short-lived OAuth token, before fetching from the Search Console API.',
  );
}

/**
 * Every property the token's account can see.
 * @returns {Promise<Array<{ siteUrl: string, permissionLevel: string }>>}
 */
export async function listSites({ accessToken, fetch: fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(GSC_ENDPOINTS.sites, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await throwForResponse(res, 'sites list');
  const data = await res.json();
  return (Array.isArray(data?.siteEntry) ? data.siteEntry : [])
    .map(s => ({ siteUrl: String(s.siteUrl || ''), permissionLevel: String(s.permissionLevel || '') }))
    .filter(s => s.siteUrl);
}

/**
 * The registrable part of a host: docs.example.com → example.com. Two labels,
 * no public-suffix list, so example.co.uk collapses to co.uk. That is
 * acceptable here because this only feeds the second-ranked sc-domain
 * candidate; an exact sc-domain:<domain> match always wins first.
 */
export function registrableDomain(host) {
  const labels = String(host || '').toLowerCase().trim().replace(/^www\./, '').split('.').filter(Boolean);
  return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.');
}

/** Accept "example.com", "www.example.com" or a full URL; return a lowercase host. */
function hostOf(domain) {
  const raw = String(domain || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0];
  }
}

/**
 * Pick the account property that stands for a configured domain. PURE.
 *
 * A configured property is trusted when there is no site list to check it
 * against (offline callers, tests) or when the account has it. A configured
 * property the account cannot see is refused with the list of what it can,
 * because fetching from a property the token lacks fails on every request.
 *
 * Without a configured property, candidates rank: the domain property for
 * the exact domain, then for its registrable domain, then URL-prefix
 * properties on the domain or its www/bare variant: https before http, the
 * exact host before its variant, shorter (closer to the root) before longer.
 * The host outranks length because a URL-prefix property covers only URLs
 * under its exact prefix: for a site canonical on www, https://example.com/
 * holds no rows at all, so choosing it over https://www.example.com/ would
 * store nothing and read back as measured absence for every page. https
 * still outranks the host because a migrated site leaves its old http
 * property behind, with no new rows in it. Unverified entries never qualify —
 * Search Console returns no data for them.
 *
 * @param {Array<{ siteUrl: string, permissionLevel?: string }>|null} sites
 * @param {{ domain?: string, configured?: string }} wanted
 * @returns {{ property: string|null, reason: string, available?: string[] }}
 */
export function matchProperty(sites, { domain, configured } = {}) {
  const all = Array.isArray(sites) ? sites.filter(s => s && s.siteUrl) : [];
  const verified = all.filter(s => s.permissionLevel !== 'siteUnverifiedUser');
  const available = all.map(s => s.siteUrl);

  if (configured) {
    const wanted = String(configured).trim();
    if (!all.length) return { property: wanted, reason: 'configured' };
    if (verified.some(s => s.siteUrl === wanted)) return { property: wanted, reason: 'configured' };
    if (all.some(s => s.siteUrl === wanted)) {
      return { property: null, reason: 'configured property is unverified in this account', available };
    }
    return { property: null, reason: 'configured property not in the account', available };
  }

  const host = hostOf(domain);
  if (!host) return { property: null, reason: 'no domain to match', available };
  const bare = host.replace(/^www\./, '');
  const registrable = registrableDomain(host);
  const urls = new Set(verified.map(s => s.siteUrl));

  if (urls.has(`sc-domain:${host}`)) return { property: `sc-domain:${host}`, reason: 'domain property' };
  if (urls.has(`sc-domain:${bare}`)) return { property: `sc-domain:${bare}`, reason: 'domain property' };
  if (registrable && registrable !== bare && urls.has(`sc-domain:${registrable}`)) {
    return { property: `sc-domain:${registrable}`, reason: 'domain property of the registrable domain' };
  }

  const hosts = new Set([host, bare, `www.${bare}`]);
  const prefixes = [];
  for (const siteUrl of urls) {
    if (siteUrl.startsWith('sc-domain:')) continue;
    let u;
    try { u = new URL(siteUrl); } catch { continue; }
    const hostname = u.hostname.toLowerCase();
    if (!hosts.has(hostname)) continue;
    prefixes.push({
      siteUrl,
      https: u.protocol === 'https:' ? 0 : 1,
      exact: hostname === host ? 0 : 1,
      len: siteUrl.length,
    });
  }
  prefixes.sort((a, b) => a.https - b.https || a.exact - b.exact || a.len - b.len || a.siteUrl.localeCompare(b.siteUrl));
  if (prefixes.length) return { property: prefixes[0].siteUrl, reason: 'url-prefix property' };

  return { property: null, reason: `no property matches ${host}`, available };
}

/**
 * One Search Analytics request. Returns { rows } with rows defaulting to []
 * because the API omits the field entirely when a window has no data.
 * dataState is only sent when given so the API's own default ("final") stays
 * the default here too.
 */
export async function searchAnalytics({
  siteUrl,
  accessToken,
  fetch: fetchImpl = globalThis.fetch,
  startDate,
  endDate,
  dimensions,
  rowLimit = MAX_ROW_LIMIT,
  startRow = 0,
  searchType = 'web',
  dataState,
} = {}) {
  if (!siteUrl) throw new Error('searchAnalytics: siteUrl is required');
  if (!startDate || !endDate) throw new Error('searchAnalytics: startDate and endDate (YYYY-MM-DD) are required');
  const limit = Math.min(Math.max(1, Number(rowLimit) | 0), MAX_ROW_LIMIT);
  const body = {
    startDate,
    endDate,
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    type: searchType || 'web',
    rowLimit: limit,
    startRow: Math.max(0, Number(startRow) | 0),
  };
  if (dataState) body.dataState = dataState;

  const res = await fetchImpl(GSC_ENDPOINTS.searchAnalytics(siteUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwForResponse(res, siteUrl);
  const data = await res.json();
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return { rows, responseAggregationType: data?.responseAggregationType ?? null };
}

/**
 * Page through a Search Analytics query. The API has no "next page" token:
 * you advance startRow by rowLimit until a page comes back short. maxRows
 * bounds the total so a page×query grain on a large property cannot run
 * away; when the bound stops the walk, truncated is true and the caller
 * should say so rather than present a partial as the whole.
 *
 * @returns {Promise<{ rows: object[], requests: number, truncated: boolean }>}
 */
export async function searchAnalyticsAll(params = {}) {
  const rowLimit = Math.min(Math.max(1, Number(params.rowLimit ?? MAX_ROW_LIMIT) | 0), MAX_ROW_LIMIT);
  const maxRows = Math.max(1, Number(params.maxRows ?? 250_000) | 0);
  let startRow = Math.max(0, Number(params.startRow ?? 0) | 0);
  const rows = [];
  let requests = 0;
  let truncated = false;

  for (;;) {
    const page = await searchAnalytics({ ...params, rowLimit, startRow });
    requests++;
    for (const r of page.rows) rows.push(r);
    const full = page.rows.length >= rowLimit;
    if (rows.length >= maxRows) {
      truncated = full || rows.length > maxRows;
      if (rows.length > maxRows) rows.length = maxRows;
      break;
    }
    if (!full) break;
    startRow += rowLimit;
  }
  return { rows, requests, truncated };
}

const DIMENSION_COLUMNS = { date: 'date', page: 'page_url', query: 'query' };

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map API rows to gsc_daily row objects. PURE.
 *
 * keys[] comes back in the order dimensions[] was requested, so the mapping
 * is positional: 'date' → date, 'page' → page_url, 'query' → query. A
 * dimension that was not requested stays null; country, device and
 * searchAppearance have no column and are ignored. The gsc_daily.date column
 * is NOT NULL, so a caller that wants to store rows must request 'date'.
 */
export function rowsToDaily({ rows, dimensions, project, property, grain, searchType = 'web', fetchedAt } = {}) {
  const dims = Array.isArray(dimensions) ? dimensions : [];
  const ts = fetchedAt ?? Date.now();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const keys = Array.isArray(row?.keys) ? row.keys : [];
    const daily = {
      project,
      property,
      grain,
      search_type: searchType || 'web',
      date: null,
      page_url: null,
      query: null,
      clicks: numberOrNull(row?.clicks) ?? 0,
      impressions: numberOrNull(row?.impressions) ?? 0,
      ctr: numberOrNull(row?.ctr),
      position: numberOrNull(row?.position),
      fetched_at: ts,
    };
    dims.forEach((dim, i) => {
      const col = DIMENSION_COLUMNS[dim];
      if (col && keys[i] !== undefined) daily[col] = keys[i] === null ? null : String(keys[i]);
    });
    out.push(daily);
  }
  return out;
}

// ── URL Inspection ──────────────────────────────────────────────────────────

const SC_DOMAIN_PREFIX = 'sc-domain:';

/**
 * Whether a property can answer for a URL. PURE.
 *
 * The API rejects an inspectionUrl outside the property with a 400, and
 * that 400 still costs a request against a 2,000-a-day quota, so the check
 * is made here first. The rule is Google's: a domain property covers every
 * host on the domain and its subdomains; a URL-prefix property covers URLs
 * that start with the prefix, where scheme and host compare case-insensitively
 * (they are not case-sensitive on the wire) and the path compares exactly
 * (it is). Only http(s) URLs qualify: nothing else is a page Google indexes.
 * Anything unparseable is out, not an exception.
 */
export function urlBelongsToProperty(url, siteUrl) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const site = String(siteUrl ?? '').trim();
  if (!site) return false;

  if (site.toLowerCase().startsWith(SC_DOMAIN_PREFIX)) {
    const domain = site.slice(SC_DOMAIN_PREFIX.length).trim().toLowerCase().replace(/\.$/, '');
    if (!domain) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return host === domain || host.endsWith(`.${domain}`);
  }

  let prefix;
  try { prefix = new URL(site); } catch { return false; }
  // The URL parser lower-cases scheme and host on both sides; the path it
  // leaves alone, which is exactly the comparison wanted.
  if (u.protocol !== prefix.protocol || u.host !== prefix.host) return false;
  return u.pathname.startsWith(prefix.pathname);
}

const INSPECTION_HINTS = {
  429: `URL Inspection quota exhausted (${URL_INSPECTION_QUOTA.perDay} inspections per property per day, `
    + `${URL_INSPECTION_QUOTA.perMinute} per minute). What was stored is kept; run again tomorrow, or with a smaller --limit.`,
};

/**
 * One URL Inspection request. Returns the inspectionResult object, or {}
 * when the API omitted it, so callers can read fields off it without a null
 * check; every field inside may still be absent. An HTTP failure is a
 * GscApiError whose `status` the caller can branch on (429: the quota is
 * spent, stop; 400: the URL is outside the property, skip).
 */
export async function inspectUrl({
  siteUrl,
  inspectionUrl,
  accessToken,
  fetch: fetchImpl = globalThis.fetch,
  languageCode = 'en-US',
} = {}) {
  if (!siteUrl) throw new Error('inspectUrl: siteUrl is required');
  if (!inspectionUrl) throw new Error('inspectUrl: inspectionUrl is required');
  const body = { inspectionUrl, siteUrl };
  if (languageCode) body.languageCode = languageCode;

  const res = await fetchImpl(GSC_ENDPOINTS.urlInspection, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwForResponse(res, inspectionUrl, INSPECTION_HINTS);
  const data = await res.json();
  const result = data?.inspectionResult;
  return result && typeof result === 'object' ? result : {};
}

function stringOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter(v => v !== null && v !== undefined).map(String) : [];
}

/**
 * Flatten an inspectionResult into a gsc_inspections row. PURE.
 *
 * indexStatusResult carries the verdict and everything the table has a
 * column for; richResultsResult contributes only its verdict. Absent fields
 * are null and absent lists are '[]', so a row never has to be read
 * defensively. The whole result is kept in `raw` because Google's prose in
 * coverageState changes wording over time and the deprecated
 * mobileUsabilityResult, when present, has nowhere else to live.
 *
 * @param {{ project: string, property: string, url: string, result: object, inspectedAt?: number }} args
 */
export function inspectionToRow({ project, property, url, result, inspectedAt } = {}) {
  const res = result && typeof result === 'object' ? result : {};
  const idx = res.indexStatusResult && typeof res.indexStatusResult === 'object' ? res.indexStatusResult : {};
  const rich = res.richResultsResult && typeof res.richResultsResult === 'object' ? res.richResultsResult : {};
  return {
    project,
    property,
    url,
    inspected_at: inspectedAt ?? Date.now(),
    verdict: stringOrNull(idx.verdict),
    coverage_state: stringOrNull(idx.coverageState),
    robots_txt_state: stringOrNull(idx.robotsTxtState),
    indexing_state: stringOrNull(idx.indexingState),
    page_fetch_state: stringOrNull(idx.pageFetchState),
    last_crawl_time: stringOrNull(idx.lastCrawlTime),
    crawled_as: stringOrNull(idx.crawledAs),
    google_canonical: stringOrNull(idx.googleCanonical),
    user_canonical: stringOrNull(idx.userCanonical),
    sitemaps: JSON.stringify(stringArray(idx.sitemap)),
    referring_urls: JSON.stringify(stringArray(idx.referringUrls)),
    rich_results_verdict: stringOrNull(rich.verdict),
    raw: JSON.stringify(res),
  };
}
