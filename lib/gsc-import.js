/**
 * lib/gsc-import.js — persist Search Console exports, and serve demand evidence
 * from whichever source the project has: API rows first, CSV exports second.
 *
 * Until now GSC CSVs were parsed at dashboard-render time and thrown away, so
 * nothing downstream could reason about demand: an agent asking "what does this
 * page need?" could only be told about structure, which is why its answers kept
 * drifting toward schema regardless of the question.
 *
 * Two sources feed the same evidence functions, and they are not equivalent:
 *
 *   gsc_daily    rows fetched from the Search Console API (seo-intel gsc-fetch).
 *                A page_query fetch covers EVERY page the property reported, so
 *                a URL with no rows in the window got no reportable impressions.
 *                Absence is measured, and is evidence in its own right — with
 *                one exception, below.
 *   gsc_queries  rows imported from CSV exports under gsc/<project>*. Each
 *                export covers whatever its own Filters.csv declares. A page
 *                with no rows here may simply never have been exported, so
 *                absence is a gap in the inputs, not a fact about the page.
 *
 * That is why the evidence carries a `coverage` field: 'complete' lets the page
 * contract say "no demand", 'export' only lets it say "no data". The API path
 * is tried first whenever the project has any page_query rows at all — even a
 * URL with zero rows gets the API answer, because that zero means something.
 *
 * The exception is a walk that hit its row cap. lib/gsc-api.js searchAnalyticsAll
 * stops at maxRows and db.js recordGscFetch stores truncated=1 for that window,
 * and the API hands rows back in click order, so what a capped walk drops is
 * exactly the low-click pages — the pages a "no demand" verdict would be about.
 * A window touched by a truncated walk is served with coverage 'partial': its
 * rows are a floor, and a URL with none is a gap, not a measurement. For such a
 * URL a page-filtered export, if one was imported, is read instead of the gap.
 *
 * Two more things the API path guards, because the table allows them:
 *
 *   - gsc_daily keys rows by property and search_type. A project that switched
 *     property (a URL-prefix property to sc-domain, say) keeps both sets of
 *     rows, and summing them would credit one day twice. Every read here is
 *     scoped to ONE property and search type — the most recently fetched pair
 *     for the grain, the same choice db.js getGscCoverage makes.
 *   - The window is anchored at the latest fetched day and runs windowDays
 *     back, but never further back than what was fetched: after
 *     `gsc-fetch --days 7` the window is 7 days long, whatever was asked for,
 *     and it says so (window.days against window.requested_days) rather than
 *     naming 21 days nobody requested. The fetch records vouch for a day that
 *     was requested and came back empty; without them the rows themselves do.
 *
 * A page-filtered export becomes page-level evidence; an unfiltered one is
 * property-wide and is explicitly NOT treated as evidence about any page.
 * Two overlapping exports for one page (say "Last 28 days" and "Last 3 months")
 * must never be summed: the CSV path serves rows from one window only, the
 * freshest declared, so that a page is not credited with the same impressions
 * twice.
 *
 * Units: gsc_daily stores ctr as the API's 0-1 fraction; gsc_queries stores the
 * export's percent. Every row this module hands out carries PERCENT, so callers
 * never need to know which table it came from.
 */

import { loadGscData, listGscExports } from '../reports/gsc-loader.js';

/** Default evidence window over API rows, anchored at the latest fetched date. */
export const EVIDENCE_WINDOW_DAYS = 28;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @returns {{ imported: number, exports: {folder:string,scope:string,pageFilter:string|null,dateRange:string|null,rows:number}[] }}
 */
export function importGscQueries(db, project) {
  const folders = listGscExports(project);
  const summary = [];
  let imported = 0;

  let stmt;
  try {
    stmt = db.prepare(`
      INSERT INTO gsc_queries (project, page_url, query, clicks, impressions, ctr, position, date_range, source, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, COALESCE(page_url, ''), query, date_range) DO UPDATE SET
        clicks = excluded.clicks, impressions = excluded.impressions,
        ctr = excluded.ctr, position = excluded.position,
        source = excluded.source, imported_at = excluded.imported_at
    `);
  } catch { return { imported: 0, exports: [] }; }

  const ts = Date.now();
  for (const { name } of folders) {
    const data = loadGscData(project, { folder: name });
    if (!data?.queries?.length) continue;
    const pageUrl = data.pageFilter || null;
    const range = data.dateRange || 'unknown';
    try {
      db.exec('BEGIN');
      for (const q of data.queries) {
        if (!q.query) continue;
        stmt.run(project, pageUrl, q.query, q.clicks | 0, q.impressions | 0, q.ctr ?? null, q.position ?? null, range, name, ts);
        imported++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`[gsc] import of ${name} failed:`, e.message);
      continue;
    }
    summary.push({ folder: name, scope: data.scope, pageFilter: pageUrl, dateRange: range, rows: data.queries.length });
  }
  return { imported, exports: summary };
}

/** Normalize a URL for comparison: scheme-agnostic, www-agnostic, no trailing slash. */
export function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./i, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

// ── CSV export windows ──────────────────────────────────────────────────────

/**
 * GSC writes its window as prose ("Last 28 days"). Rank by the span it covers,
 * shortest first, so the freshest window wins deterministically.
 */
export function rangeSpanDays(range) {
  const m = /last\s+(\d+)\s+(day|week|month|year)/i.exec(String(range || ''));
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * ({ day: 1, week: 7, month: 30, year: 365 }[unit] || 1);
}

export function pickFreshestRange(ranges) {
  const uniq = [...new Set((ranges || []).filter(Boolean))];
  if (!uniq.length) return null;
  return uniq.sort((a, b) => rangeSpanDays(a) - rangeSpanDays(b) || a.localeCompare(b))[0];
}

// ── API rows (gsc_daily) ────────────────────────────────────────────────────

/** YYYY-MM-DD arithmetic in UTC, so a window never shifts with the host's zone. */
function shiftIsoDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive count of calendar days from start to end, both YYYY-MM-DD. */
function daysInclusive(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** clicks/impressions as a percent with two decimals — the units gsc_queries uses. */
function ctrPercent(clicks, impressions) {
  return impressions ? +(clicks / impressions * 100).toFixed(2) : 0;
}

function windowDaysOf(opts) {
  const n = Number(opts?.windowDays);
  return Number.isInteger(n) && n >= 1 ? n : EVIDENCE_WINDOW_DAYS;
}

/**
 * The earliest date from which every day up to `latest` was asked of the API,
 * read from one property's fetch records for one grain. PURE.
 *
 * Fetch walks are month chunks; merged, they form runs of contiguous days. The
 * run that contains the latest stored day is what a window may claim: a day
 * inside it with no rows was requested and came back empty, which is a
 * measurement. null when no record covers `latest` — rows that arrived without
 * a record can only be vouched for by the rows themselves.
 *
 * @param {{start_date:string,end_date:string}[]} records  any order
 * @param {string} latest  YYYY-MM-DD, the newest day gsc_daily holds
 * @returns {string|null}
 */
export function coveredStart(records, latest) {
  const sorted = [...(records || [])].sort((a, b) => a.start_date.localeCompare(b.start_date));
  let run = null;
  for (const r of sorted) {
    if (run && r.start_date <= shiftIsoDate(run.end, 1)) {
      if (r.end_date > run.end) run.end = r.end_date;
    } else {
      run = { start: r.start_date, end: r.end_date };
    }
    // Later records sort after this one, so they can only extend the run's
    // end: once `latest` is inside, its start is final.
    if (run.start <= latest && latest <= run.end) return run.start;
  }
  return null;
}

/**
 * Whether any walk overlapping the window stopped at its row cap. PURE.
 * One truncated month is enough: the rows it dropped are the low-click ones,
 * and nothing says which pages they belonged to.
 *
 * @param {{start_date:string,end_date:string,truncated:number|boolean}[]} records
 * @param {{start:string,end:string}} window
 */
export function truncatedWithin(records, window) {
  return (records || []).some(r =>
    Boolean(Number(r.truncated)) && r.start_date <= window.end && r.end_date >= window.start);
}

/**
 * The fetch records behind one property's rows of one grain. A database that
 * predates gsc_fetches answers with none, and the rows then vouch for
 * themselves: nothing is claimed beyond the days they cover.
 */
function fetchRecords(db, { project, property, grain, searchType }) {
  try {
    return db.prepare(`
      SELECT start_date, end_date, truncated FROM gsc_fetches
      WHERE project = ? AND property = ? AND grain = ? AND search_type = ?
    `).all(project, property, grain, searchType);
  } catch {
    return [];
  }
}

/**
 * Rows of one grain, from one property and search type, aggregated over the
 * window that ends on the latest fetched date and reaches back windowDays or
 * to the start of what was fetched, whichever is nearer. The API reports one
 * row per (page, query, day); summing the window gives the same totals Search
 * Console shows for that range, with position weighted by impressions the way
 * the UI weights it.
 *
 * An older database has no gsc_daily table at all. That is the same state as
 * "nothing fetched yet", so the missing table answers null rather than throwing.
 *
 * @returns {{ property: string, search_type: string,
 *   window: { start: string, end: string, days: number, requested_days: number },
 *   rows: object[], truncated: boolean, coverage: 'complete'|'partial' } | null}
 */
function windowRows(db, project, grain, windowDays) {
  try {
    // One property, one search type. The pair fetched most recently is the
    // one a new fetch would extend (db.js getGscCoverage picks the same way);
    // rows a project left behind under an earlier property stay out of the sum.
    const src = db.prepare(`
      SELECT property, search_type FROM gsc_daily WHERE project = ? AND grain = ?
      ORDER BY fetched_at DESC, id DESC LIMIT 1
    `).get(project, grain);
    if (!src) return null;
    const property = src.property;
    const searchType = src.search_type || 'web';

    const span = db.prepare(`
      SELECT MIN(date) AS first, MAX(date) AS latest FROM gsc_daily
      WHERE project = ? AND grain = ? AND property = ? AND search_type = ?
    `).get(project, grain, property, searchType);
    if (!span?.latest) return null;

    // The window may not reach back past what was fetched. ISO dates compare
    // as strings, so the later of the two starts is simply the greater.
    const records = fetchRecords(db, { project, property, grain, searchType });
    const fetchedStart = coveredStart(records, span.latest) ?? span.first;
    const askedStart = shiftIsoDate(span.latest, -(windowDays - 1));
    const start = fetchedStart > askedStart ? fetchedStart : askedStart;
    const window = { start, end: span.latest, days: daysInclusive(start, span.latest), requested_days: windowDays };
    const truncated = truncatedWithin(records, window);

    const rows = db.prepare(`
      SELECT page_url, query,
             SUM(clicks) AS clicks,
             SUM(impressions) AS impressions,
             CASE WHEN SUM(impressions) > 0
                  THEN SUM(position * impressions) / SUM(impressions) END AS position
      FROM gsc_daily
      WHERE project = ? AND grain = ? AND property = ? AND search_type = ? AND date BETWEEN ? AND ?
      GROUP BY page_url, query
      ORDER BY impressions DESC
    `).all(project, grain, property, searchType, window.start, window.end);
    return { property, search_type: searchType, window, rows, truncated, coverage: truncated ? 'partial' : 'complete' };
  } catch {
    return null;
  }
}

/**
 * Page-level evidence from API rows. null when the project has no page_query
 * rows at all; otherwise the rows for this URL over the window — possibly
 * none. Under coverage 'complete' that "none" is a measurement; under
 * 'partial' (a walk in the window hit its row cap) it is not, and the rows
 * that are present are a floor (see the header).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string} url
 * @param {{ windowDays?: number }} opts
 * @returns {{ rows: {page_url:string,query:string,clicks:number,impressions:number,ctr:number,position:number|null}[],
 *   window: {start:string,end:string,days:number,requested_days:number}, coverage: 'complete'|'partial',
 *   truncated: boolean, property: string, search_type: string } | null}
 */
export function getApiPageQueryEvidence(db, project, url, opts = {}) {
  const agg = windowRows(db, project, 'page_query', windowDaysOf(opts));
  if (!agg) return null;
  const key = normalizeUrlKey(url);
  const rows = agg.rows
    .filter(r => normalizeUrlKey(r.page_url) === key)
    .map(r => ({
      page_url: r.page_url,
      query: r.query,
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: ctrPercent(r.clicks || 0, r.impressions || 0),
      position: r.position ?? null,
    }));
  return {
    rows,
    window: agg.window,
    coverage: agg.coverage,
    truncated: agg.truncated,
    property: agg.property,
    search_type: agg.search_type,
  };
}

/** The API answer in getPageQueryEvidence's shape. */
function evidenceFromApi(api) {
  return {
    rows: api.rows,
    hasPageScopedExports: true,
    dateRanges: [`${api.window.start}..${api.window.end}`],
    source: 'api',
    window: api.window,
    coverage: api.coverage,
    truncated: api.truncated,
    property: api.property,
  };
}

/** Page-filtered export rows for one URL, from the freshest window declared. */
function evidenceFromCsv(db, project, url) {
  const none = { rows: [], hasPageScopedExports: false, dateRanges: [], source: null, window: null, coverage: null, truncated: false, property: null };
  const key = normalizeUrlKey(url);
  let rows = [];
  let anyPageScoped = 0;
  try {
    rows = db.prepare(
      'SELECT * FROM gsc_queries WHERE project = ? AND page_url IS NOT NULL ORDER BY impressions DESC'
    ).all(project).filter(r => normalizeUrlKey(r.page_url) === key);
    anyPageScoped = db.prepare(
      'SELECT COUNT(*) c FROM gsc_queries WHERE project = ? AND page_url IS NOT NULL'
    ).get(project).c;
  } catch {
    return none;
  }
  const chosen = pickFreshestRange(rows.map(r => r.date_range));
  const hasPageScopedExports = anyPageScoped > 0;
  return {
    ...none,
    rows: chosen ? rows.filter(r => r.date_range === chosen) : [],
    hasPageScopedExports,
    dateRanges: chosen ? [chosen] : [],
    source: hasPageScopedExports ? 'csv' : null,
    coverage: hasPageScopedExports ? 'export' : null,
  };
}

/**
 * Query rows recorded for one page, plus where they came from and how much of
 * the property that source covers.
 *
 * API first: any page_query data for the project answers for every URL in it,
 * because the fetch covered them all — rows for the URL answer outright, and
 * so does complete coverage with none, since that zero is measured. A
 * truncated walk with no rows for this URL is neither: the rows may have
 * fallen below the cap. There a page-filtered export, if one was imported, is
 * better evidence than the gap and is served instead; otherwise the gap is
 * reported as coverage 'partial'. Only a project with no API data at all falls
 * back to CSV exports outright, and there the rows come from ONE window — the
 * freshest declared — so overlapping exports cannot double count.
 *
 * The distinction between the states matters downstream: no rows because
 * nobody exported page-filtered data, no rows because the walk was cut short,
 * and no rows because the page genuinely gets no impressions are three
 * different findings.
 *
 * @returns {{ rows: object[], hasPageScopedExports: boolean, dateRanges: string[], source: 'api'|'csv'|null,
 *   window: {start:string,end:string,days:number,requested_days:number}|null,
 *   coverage: 'complete'|'partial'|'export'|null, truncated: boolean, property: string|null }}
 */
export function getPageQueryEvidence(db, project, url, opts = {}) {
  const api = getApiPageQueryEvidence(db, project, url, opts);
  if (api && (api.rows.length || api.coverage === 'complete')) return evidenceFromApi(api);
  const csv = evidenceFromCsv(db, project, url);
  if (!api) return csv;
  return csv.rows.length ? csv : evidenceFromApi(api);
}

/**
 * Property-wide query totals from API rows, over the same latest-anchored
 * window. Context for a page contract, never evidence about one page: a
 * query-grain row says the property ranked, not which URL did.
 *
 * @returns {{ rows: {query:string,clicks:number,impressions:number,ctr:number,position:number|null}[], date_range: string,
 *   window: {start:string,end:string,days:number,requested_days:number}, source: 'api',
 *   coverage: 'complete'|'partial', truncated: boolean, property: string } | null}
 */
export function getPropertyQueryContext(db, project, opts = {}) {
  const agg = windowRows(db, project, 'query', windowDaysOf(opts));
  if (!agg) return null;
  const rows = agg.rows.map(r => ({
    query: r.query,
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: ctrPercent(r.clicks || 0, r.impressions || 0),
    position: r.position ?? null,
  }));
  return {
    rows,
    date_range: `${agg.window.start}..${agg.window.end}`,
    window: agg.window,
    source: 'api',
    coverage: agg.coverage,
    truncated: agg.truncated,
    property: agg.property,
  };
}
