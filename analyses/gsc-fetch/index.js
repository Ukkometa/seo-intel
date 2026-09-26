/**
 * analyses/gsc-fetch — pull Search Console rows for the target property into
 * gsc_daily, so page-level demand evidence exists for every page at once.
 *
 * Until now the only page-level Search Console evidence seo-intel could hold
 * came from a CSV a person exported by hand: open Search Console, filter by
 * one page, download, drop the folder under gsc/<project>-<label>/. That
 * starved the page contract. It could reason about the two or three pages
 * somebody had bothered to export and had to answer "no data" for the rest,
 * which is not the same as "no demand", and it had no way to tell the two
 * apart. One Search Analytics pull grouped by date × page × query gives the
 * same evidence for every page the property reported, and a page absent from
 * that pull is known to have earned no reportable impressions.
 *
 * Three grains, three jobs:
 *
 *   page_query   date × page × query. What the page contract reads (28- and
 *                90-day windows). It is also the bulky one — a busy property
 *                produces thousands of rows a day — so it defaults to the last
 *                90 days.
 *   page         date × page. Small, and gives each URL a 16-month series.
 *   query        date × query. Small, property-wide demand over 16 months.
 *                Low-volume queries are anonymised by the API, so this sums
 *                to less than the page grain does; that is Google's contract.
 *
 * Trends over those series are a later (Solo) feature. The rows are collected
 * now so the history exists when that ships: the API reaches 16 months back
 * and no further, so a month not fetched today is a month lost.
 *
 * Windows are planned per grain from what gsc_daily already holds and split
 * at calendar-month boundaries. A month is a natural unit for a walk that can
 * hit the row cap, it keeps each transaction small, and it means a run that
 * dies on a 429 leaves whole months committed: the next run resumes from the
 * last date stored rather than from the beginning. The last revisionDays of
 * existing coverage are always re-fetched, because Google keeps revising
 * recent days for a while after first publishing them, and the upsert
 * replaces those rows in place. Nothing fresher than today - lagDays is
 * requested at all: it is not final yet.
 *
 * Only the target property is fetched. Owned subdomains with properties of
 * their own (config.owned) are a follow-up; gsc_daily and its coverage
 * helpers already key by property, so that needs no schema change.
 */

import {
  listSites,
  matchProperty,
  resolveAccessToken,
  rowsToDaily,
  searchAnalyticsAll,
} from '../../lib/gsc-api.js';
import { getGscCoverage, recordGscFetch, upsertGscDaily } from '../../db/db.js';

/** Grain name → the Search Analytics dimensions, in the order keys come back. */
export const GRAINS = {
  page_query: ['date', 'page', 'query'],
  page: ['date', 'page'],
  query: ['date', 'query'],
};

/**
 * days          page_query lookback, in days
 * months        page and query lookback, in months of 30 days
 * lagDays       final data lags 2-3 days; nothing fresher than this is asked for
 * revisionDays  recent days are revised for a couple of days after publishing;
 *               this many days of existing coverage are re-fetched every run
 * maxMonths     the API keeps 16 calendar months; this is 16 × 30 days, a
 *               week or so inside that, so no grain ever asks for a day the
 *               API cannot serve. The oldest few days it could still serve
 *               are never requested; the same 30-day month as `months`, so
 *               the two units agree
 */
export const DEFAULTS = { days: 90, months: 16, lagDays: 3, revisionDays: 3, maxMonths: 16 };

const DAY_MS = 86_400_000;
const SEARCH_TYPE = 'web';

function intAtLeast(value, min, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

// ── UTC calendar arithmetic ────────────────────────────────────────────────
// Everything below works on UTC midnight in milliseconds, so a window never
// shifts with the host's time zone and a test computes the same dates on
// every machine. The API's own dates are calendar days in the property's
// time zone; we only ever hand them back the strings it gave us.

/** A calendar day as UTC midnight in ms. Accepts a Date or 'YYYY-MM-DD'. */
export function utcDay(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('utcDay: invalid Date');
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!m) throw new Error(`utcDay: not a date: ${value}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC ms → 'YYYY-MM-DD'. */
export function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function lastDayOfMonth(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
}

/**
 * Split an inclusive [start, end] span (UTC ms) at calendar-month ends.
 * PURE. Each chunk ends on the last day of its month, or on `end`.
 * @returns {{ start: string, end: string }[]}
 */
export function monthChunks(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const chunkEnd = Math.min(lastDayOfMonth(cursor), endMs);
    out.push({ start: isoDate(cursor), end: isoDate(chunkEnd) });
    cursor = chunkEnd + DAY_MS;
  }
  return out;
}

/**
 * The date windows one grain still needs, as inclusive YYYY-MM-DD pairs. PURE.
 *
 *   end    = today - lagDays
 *   start  = end - (days - 1)            for page_query
 *            end - (months * 30 - 1)     for page and query
 *            never earlier than maxMonths × 30 days back, just inside the
 *            API's 16-calendar-month horizon
 *   with coverage: start = max(start, coverage.max_date - revisionDays), so a
 *   run extends what is stored and re-fetches the days Google may still
 *   revise. start > end means there is nothing to ask for.
 *
 * @param {{ today?: Date|string, coverage?: { max_date?: string }|null, grain: string,
 *           days?: number, months?: number, lagDays?: number, revisionDays?: number }} plan
 * @returns {{ start: string, end: string }[]} calendar-month chunks, oldest first
 */
export function planWindows({ today, coverage, grain, days, months, lagDays, revisionDays } = {}) {
  const todayMs = utcDay(today ?? new Date());
  const lag = intAtLeast(lagDays, 0, DEFAULTS.lagDays);
  const revision = intAtLeast(revisionDays, 0, DEFAULTS.revisionDays);
  const span = grain === 'page_query'
    ? intAtLeast(days, 1, DEFAULTS.days)
    : intAtLeast(months, 1, DEFAULTS.months) * 30;

  const end = todayMs - lag * DAY_MS;
  const horizon = end - (DEFAULTS.maxMonths * 30 - 1) * DAY_MS;
  let start = Math.max(end - (span - 1) * DAY_MS, horizon);
  if (coverage?.max_date) start = Math.max(start, utcDay(coverage.max_date) - revision * DAY_MS);
  if (start > end) return [];
  return monthChunks(start, end);
}

function resolveGrains(wanted) {
  const list = Array.isArray(wanted) && wanted.length ? wanted : Object.keys(GRAINS);
  for (const g of list) {
    if (!GRAINS[g]) throw new Error(`Unknown Search Console grain "${g}". Expected one of: ${Object.keys(GRAINS).join(', ')}`);
  }
  return [...new Set(list)];
}

/**
 * Decide which property to fetch. A configured one (opts.property, then
 * config.gsc.property) is taken as given; otherwise the account's site list
 * is matched against the target domain and a miss names what the account
 * does have, so the fix is a config line rather than a guess.
 */
export async function resolveProperty({ configured, config, accessToken, fetchImpl }) {
  if (configured) return { property: String(configured).trim(), reason: 'configured' };
  const domain = config?.target?.domain;
  if (!domain) {
    throw new Error('No Search Console property to fetch: set target.domain or gsc.property in the project config.');
  }
  const sites = await listSites({ accessToken, fetch: fetchImpl });
  const match = matchProperty(sites, { domain, configured: undefined });
  if (!match.property) {
    const available = match.available?.length ? match.available.join(', ') : '(none)';
    throw new Error(
      `No Search Console property matches ${domain} (${match.reason}). `
      + `Properties in this account: ${available}. Set gsc.property in the project config to pick one.`,
    );
  }
  return { property: match.property, reason: match.reason };
}

/**
 * Fetch every window each grain still needs and store the rows.
 *
 * Each window is one paged Search Analytics walk, one upsert transaction and
 * one gsc_fetches record, in that order, oldest window first; a failure
 * propagates as the transport's GscApiError (its `hint` says what to do)
 * with every earlier window already committed. No transaction is left open:
 * upsertGscDaily commits or rolls back on its own.
 *
 * With dryRun the plan is computed and returned without a single Search
 * Analytics request. When the property is also known, no credentials are
 * needed at all, so a plan can be shown before the account is connected.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} config           the project config (target.domain, gsc.property)
 * @param {object} [opts]
 * @param {string}   [opts.accessToken]   explicit token; see resolveAccessToken for precedence
 * @param {object}   [opts.oauth]         injectable OAuth module (tests)
 * @param {function} [opts.fetch]         injectable fetch (tests)
 * @param {number}   [opts.days]          page_query lookback (DEFAULTS.days)
 * @param {number}   [opts.months]        page/query lookback (DEFAULTS.months)
 * @param {number}   [opts.lagDays]       (DEFAULTS.lagDays)
 * @param {number}   [opts.revisionDays]  (DEFAULTS.revisionDays)
 * @param {string[]} [opts.grains]        subset of GRAINS keys; default all three
 * @param {string}   [opts.property]      override the property; else config.gsc.property, else matched
 * @param {boolean}  [opts.dryRun]        plan only
 * @param {Date|string} [opts.today]      the planning anchor (tests)
 * @param {number}   [opts.rowLimit]      rows per request (tests; default the API ceiling)
 * @param {number}   [opts.maxRows]       row cap per window walk
 * @param {function} [opts.onProgress]    ({ grain, window, rows, requests, truncated }) after each window
 * @returns {Promise<{ project: string, property: string, property_reason: string, dry_run: boolean,
 *   grains: { grain: string, windows: { start: string, end: string, rows?: number, requests?: number, truncated?: boolean }[], rows: number, requests: number }[],
 *   coverage: Record<string, object|null>, fetched_at: number }>}
 */
export async function runGscFetch(db, project, config, opts = {}) {
  const grains = resolveGrains(opts.grains);
  const dryRun = Boolean(opts.dryRun);
  const configured = opts.property || config?.gsc?.property || null;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const today = opts.today ?? new Date();
  const fetchedAt = Date.now();

  // A dry run with a known property has nothing to ask the API, so it must
  // not fail for want of a token. Everything else needs one, if only to list
  // the account's properties.
  const accessToken = dryRun && configured ? null : await resolveAccessToken(opts);
  const { property, reason } = await resolveProperty({ configured, config, accessToken, fetchImpl });

  const planning = { days: opts.days, months: opts.months, lagDays: opts.lagDays, revisionDays: opts.revisionDays };
  const results = [];
  for (const grain of grains) {
    const dimensions = GRAINS[grain];
    const coverage = getGscCoverage(db, project, { grain, property });
    const windows = planWindows({ today, coverage, grain, ...planning });
    const entry = { grain, windows: [], rows: 0, requests: 0 };

    for (const { start, end } of windows) {
      if (dryRun) {
        entry.windows.push({ start, end });
        continue;
      }
      const { rows, requests, truncated } = await searchAnalyticsAll({
        siteUrl: property,
        accessToken,
        fetch: fetchImpl,
        startDate: start,
        endDate: end,
        dimensions,
        searchType: SEARCH_TYPE,
        rowLimit: opts.rowLimit,
        maxRows: opts.maxRows,
      });
      const daily = rowsToDaily({ rows, dimensions, project, property, grain, searchType: SEARCH_TYPE, fetchedAt });
      const written = upsertGscDaily(db, daily);
      recordGscFetch(db, {
        project, property, grain, searchType: SEARCH_TYPE,
        startDate: start, endDate: end, rows: written, requests, truncated, fetchedAt,
      });
      entry.windows.push({ start, end, rows: written, requests, truncated });
      entry.rows += written;
      entry.requests += requests;
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ grain, window: { start, end }, rows: written, requests, truncated });
      }
    }
    results.push(entry);
  }

  const coverage = {};
  for (const grain of Object.keys(GRAINS)) coverage[grain] = getGscCoverage(db, project, { grain, property });

  return {
    project,
    property,
    property_reason: reason,
    dry_run: dryRun,
    grains: results,
    coverage,
    fetched_at: fetchedAt,
  };
}
