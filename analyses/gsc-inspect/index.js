/**
 * analyses/gsc-inspect — ask Google whether it has indexed a page, and store
 * the answer in gsc_inspections.
 *
 * Everything the crawl says about indexability is an inference. It reads the
 * robots meta, the X-Robots-Tag header and the canonical link, and concludes
 * "indexable". Google may disagree for reasons no crawl can see: it chose a
 * different canonical, it crawled the page and decided not to index it, it
 * discovered the URL and never crawled it, it saw a soft 404 where the crawl
 * saw a 200. The Search Review's working list draws a green tick from that
 * inference, and a green tick is the most dangerous thing on the review: it
 * stops someone looking. The URL Inspection API returns Google's own verdict,
 * which is the fact the inference was standing in for. Once a URL has a row
 * here, the review can show the fact instead.
 *
 * Quota discipline. Google allows 2,000 inspections per property per day and
 * 600 per minute (URL_INSPECTION_QUOTA), and a 429 means the day is spent.
 * Three rules follow:
 *
 *   - demand first: candidates are ordered by impressions over the last 28
 *     days (gsc_daily, page grain), then by presence in the sitemap, then by
 *     the crawl's own indexability, then by URL. A page people are already
 *     finding is the one whose index status matters most, and if the quota
 *     runs out before the tail, the tail is the least costly place to stop;
 *   - never re-ask what was asked recently: a URL with a row newer than
 *     maxAgeDays is skipped. Google's verdict moves slowly, and a week-old
 *     answer is worth more than a fresh answer for a different URL that would
 *     otherwise have none. maxAgeDays 0 forces a re-inspection;
 *   - stop cleanly at the wall: the run is capped to what the quota leaves
 *     today (what this table already holds for the property since UTC
 *     midnight), and a 429 stops further requests while keeping every row
 *     already stored. The next run resumes with the rest.
 *
 * Reading the verdicts. PASS is indexed. FAIL is an error that prevents
 * indexing. PARTIAL is indexed with issues. NEUTRAL is excluded — and that is
 * often the intended outcome: a noindex page, a URL canonicalised elsewhere,
 * a page deliberately kept out. NEUTRAL by itself is not a problem; whether it
 * matches intent is a question for whoever reads the row against the page's
 * own tags. A PASS whose google_canonical differs from the URL is indexed, but
 * under another address, which the page's own metrics will reflect.
 *
 * URLs outside the property are never sent: the API answers 400 and still
 * charges the request. They are reported as skipped instead.
 */

import { mapLimit } from '../../lib/concurrency.js';
import { GscApiError, URL_INSPECTION_QUOTA, inspectUrl, inspectionToRow, resolveAccessToken, urlBelongsToProperty } from '../../lib/gsc-api.js';
import { normalizeUrlKey } from '../../lib/gsc-import.js';
import { countInspectionsSince, upsertGscInspection } from '../../db/db.js';
import { resolveProperty } from '../gsc-fetch/index.js';

/**
 * limit        URLs per run. A hundred is a quarter of an hour's patience at
 *              the terminal and a twentieth of the day's quota, so a run can be
 *              repeated without thinking about the ceiling
 * maxAgeDays   a row younger than this is not re-asked for
 * concurrency  requests in flight; well under the per-minute quota at any
 *              realistic latency
 */
export const DEFAULTS = { limit: 100, maxAgeDays: 7, concurrency: 4 };

/** The demand window that orders candidates, in days of the page grain. */
export const DEMAND_WINDOW_DAYS = 28;

const DAY_MS = 86_400_000;
const VERDICTS = ['PASS', 'PARTIAL', 'FAIL', 'NEUTRAL'];

function intAtLeast(value, min, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** UTC midnight of the day containing `ms`: the start of the quota day used here. */
export function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function shiftIsoDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Impressions per normalised URL key over the last DEMAND_WINDOW_DAYS of the
 * page grain, from the property and search type fetched most recently (the
 * same choice lib/gsc-import.js makes, so a project that changed property is
 * not credited twice). The window ends on the latest fetched day, not today:
 * the API lags a few days and a window anchored on today would lose them.
 * No table, no rows, or no page grain → an empty map, which orders nothing.
 */
function demandByKey(db, project) {
  const byKey = new Map();
  try {
    // The pair is chosen first and on its own, as lib/gsc-import.js
    // windowRows() does. Folding MAX(date) into this SELECT would make it a
    // one-row aggregate whose property and search_type are those of whichever
    // row holds the latest date, with the ORDER BY deciding nothing — and a
    // project that moved to a domain property would then be ordered by the
    // traffic its abandoned URL-prefix property last reported.
    const src = db.prepare(`
      SELECT property, search_type FROM gsc_daily
      WHERE project = ? AND grain = 'page'
      ORDER BY fetched_at DESC, id DESC LIMIT 1
    `).get(project);
    if (!src) return byKey;
    const property = src.property;
    const searchType = src.search_type || 'web';
    const span = db.prepare(`
      SELECT MAX(date) AS latest FROM gsc_daily
      WHERE project = ? AND grain = 'page' AND property = ? AND search_type = ?
    `).get(project, property, searchType);
    if (!span?.latest) return byKey;
    const start = shiftIsoDate(span.latest, -(DEMAND_WINDOW_DAYS - 1));
    const rows = db.prepare(`
      SELECT page_url, SUM(impressions) AS impressions FROM gsc_daily
      WHERE project = ? AND grain = 'page' AND property = ? AND search_type = ? AND date BETWEEN ? AND ?
      GROUP BY page_url
    `).all(project, property, searchType, start, span.latest);
    for (const r of rows) {
      if (!r.page_url) continue;
      const key = normalizeUrlKey(r.page_url);
      byKey.set(key, (byKey.get(key) || 0) + (Number(r.impressions) || 0));
    }
  } catch { /* no gsc_daily: nothing to order by */ }
  return byKey;
}

/** Normalised keys of every URL the target's sitemaps declare. Missing table → none. */
function sitemapKeys(db, project) {
  const keys = new Set();
  try {
    const rows = db.prepare(`
      SELECT s.url FROM sitemap_urls s JOIN domains d ON d.id = s.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned')
    `).all(project);
    for (const r of rows) if (r.url) keys.add(normalizeUrlKey(r.url));
  } catch { /* no sitemap_urls: nothing is known to be listed */ }
  return keys;
}

/** URLs of this project inspected after `sinceMs`. Missing table → none. */
function recentlyInspected(db, project, sinceMs) {
  const urls = new Set();
  try {
    const rows = db.prepare(
      'SELECT url FROM gsc_inspections WHERE project = ? AND inspected_at > ?'
    ).all(project, sinceMs);
    for (const r of rows) urls.add(r.url);
  } catch { /* no gsc_inspections: nothing has been asked yet */ }
  return urls;
}

/** The property filter, or a pass-through when there is no property to check against. */
function partitionByProperty(urls, property) {
  const inside = [];
  const outside = [];
  for (const url of urls) {
    if (!property || urlBelongsToProperty(url, property)) inside.push(url);
    else outside.push(url);
  }
  return { inside, outside };
}

/**
 * The URLs to inspect this run, in priority order. PURE given the database.
 *
 * With `urls`, exactly those, minus the ones outside the property (returned
 * as skipped_out_of_property): a person naming URLs has already decided, so
 * neither the recency skip nor the limit applies. Without, the target's and
 * owned domains' pages that answered 200 to the crawl, minus those with a
 * row newer than now - maxAgeDays (counted in skipped_recent), ordered by
 * 28-day impressions, then sitemap presence, then the crawl's indexability,
 * then URL, cut at `limit`. Every gsc_* read treats a missing table as no
 * data.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ property?: string, limit?: number, maxAgeDays?: number, now?: number, urls?: string[] }} [opts]
 * @returns {{ urls: string[], skipped_recent: number, skipped_out_of_property: string[] }}
 */
export function selectCandidates(db, project, { property, limit, maxAgeDays, now, urls } = {}) {
  if (Array.isArray(urls)) {
    const wanted = [...new Set(urls.map(u => String(u ?? '').trim()).filter(Boolean))];
    const { inside, outside } = partitionByProperty(wanted, property);
    return { urls: inside, skipped_recent: 0, skipped_out_of_property: outside };
  }

  const cap = intAtLeast(limit, 1, DEFAULTS.limit);
  const maxAge = intAtLeast(maxAgeDays, 0, DEFAULTS.maxAgeDays);
  const at = Number.isFinite(now) ? now : Date.now();

  let pages = [];
  try {
    pages = db.prepare(`
      SELECT p.url, p.is_indexable FROM pages p JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned') AND p.status_code = 200
    `).all(project);
  } catch { /* no crawl: nothing to inspect */ }

  const { inside, outside } = partitionByProperty(pages.map(p => p.url), property);
  const insideSet = new Set(inside);
  const recent = recentlyInspected(db, project, at - maxAge * DAY_MS);
  const demand = demandByKey(db, project);
  const listed = sitemapKeys(db, project);

  const ranked = [];
  let skippedRecent = 0;
  for (const p of pages) {
    if (!insideSet.has(p.url)) continue;
    if (recent.has(p.url)) { skippedRecent++; continue; }
    const key = normalizeUrlKey(p.url);
    ranked.push({
      url: p.url,
      impressions: demand.get(key) || 0,
      in_sitemap: listed.has(key) ? 1 : 0,
      is_indexable: p.is_indexable ? 1 : 0,
    });
  }
  ranked.sort((a, b) =>
    b.impressions - a.impressions
    || b.in_sitemap - a.in_sitemap
    || b.is_indexable - a.is_indexable
    || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  return {
    urls: ranked.slice(0, cap).map(r => r.url),
    skipped_recent: skippedRecent,
    skipped_out_of_property: outside,
  };
}

/**
 * Inspect the selected URLs against the project's property and store each
 * verdict.
 *
 * Token and property resolve the way gsc-fetch does: a dry run with a
 * configured property needs no credentials, everything else needs a token if
 * only to list the account's properties. The candidates are then capped to
 * what the day's quota leaves, inspected `concurrency` at a time, and each
 * success is upserted as it arrives, so a run that dies keeps its progress.
 * A 429 sets a shared flag that every worker checks before its next request:
 * no more are sent, what was stored stays, and stopped_reason says why. A 401
 * is not about the URL either: the token is rejected, and every further
 * request would be too, so the same flag stops the workers, the requests
 * already in flight finish and store, and the error then propagates with its
 * reconnect hint the way gsc-fetch's does — a hundred planned URLs must not
 * become a hundred failing requests with the fix buried in errors[]. Any
 * other GscApiError (a 400 for a URL Google will not take, a 403) is recorded
 * against its URL and the run continues. A transport failure that is not an
 * API answer propagates, after the same flag has stopped the other workers,
 * so a dead connection is one failed request rather than a hundred.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} config           the project config (target.domain, gsc.property)
 * @param {object} [opts]
 * @param {string[]} [opts.urls]          inspect exactly these (see selectCandidates)
 * @param {number}   [opts.limit]         (DEFAULTS.limit)
 * @param {number}   [opts.maxAgeDays]    (DEFAULTS.maxAgeDays)
 * @param {string}   [opts.property]      override the property; else config.gsc.property, else matched
 * @param {string}   [opts.accessToken]   explicit token; see resolveAccessToken for precedence
 * @param {object}   [opts.oauth]         injectable OAuth module (tests)
 * @param {function} [opts.fetch]         injectable fetch (tests)
 * @param {number}   [opts.concurrency]   (DEFAULTS.concurrency)
 * @param {boolean}  [opts.dryRun]        select and report; send nothing
 * @param {number}   [opts.now]           the clock, in ms (tests)
 * @param {function} [opts.onProgress]    ({ url, verdict, coverage_state, done, total }) after each inspection
 * @returns {Promise<{ project: string, property: string, property_reason: string, dry_run: boolean,
 *   planned: string[], inspected: number, requests: number,
 *   verdicts: { PASS: number, PARTIAL: number, FAIL: number, NEUTRAL: number, other: number },
 *   skipped_recent: number, skipped_out_of_property: string[], quota_capped: number,
 *   quota: { per_day: number, used_today: number, remaining_after: number },
 *   errors: { url: string, status: number|null, error: string, hint: string }[],
 *   stopped_reason: null|'quota',
 *   results: { url: string, verdict: string|null, coverage_state: string|null, google_canonical: string|null }[],
 *   inspected_at: number }>}
 */
export async function runGscInspect(db, project, config, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const configured = opts.property || config?.gsc?.property || null;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const limit = intAtLeast(opts.limit, 1, DEFAULTS.limit);
  const maxAgeDays = intAtLeast(opts.maxAgeDays, 0, DEFAULTS.maxAgeDays);
  const concurrency = intAtLeast(opts.concurrency, 1, DEFAULTS.concurrency);

  const accessToken = dryRun && configured ? null : await resolveAccessToken(opts);
  const { property, reason } = await resolveProperty({ configured, config, accessToken, fetchImpl });

  const selection = selectCandidates(db, project, { property, limit, maxAgeDays, now, urls: opts.urls });
  const usedToday = countInspectionsSince(db, project, property, startOfUtcDay(now));
  const remaining = Math.max(0, URL_INSPECTION_QUOTA.perDay - usedToday);
  const quotaCapped = Math.max(0, selection.urls.length - remaining);
  const planned = selection.urls.slice(0, remaining);

  const verdicts = { PASS: 0, PARTIAL: 0, FAIL: 0, NEUTRAL: 0, other: 0 };
  const errors = [];
  const state = { stopped: false, requests: 0, done: 0, authError: null };
  let results = [];

  if (!dryRun && planned.length) {
    const rows = await mapLimit(planned, concurrency, async (url) => {
      if (state.stopped) return null;
      state.requests++;
      let result;
      try {
        result = await inspectUrl({ siteUrl: property, inspectionUrl: url, accessToken, fetch: fetchImpl });
      } catch (err) {
        if (!(err instanceof GscApiError)) {
          // Not an API answer: the network itself failed. mapLimit rejects at
          // once, so the caller already sees the failure; the flag keeps the
          // sibling workers from spending the rest of the plan on a
          // connection that is down.
          state.stopped = true;
          throw err;
        }
        if (err.status === 429) {
          state.stopped = true;
          return null;
        }
        if (err.status === 401) {
          // The token, not the URL. mapLimit does not cancel sibling workers
          // on a throw, so the flag stops them, and the error is kept to be
          // thrown once every request in flight has settled and stored.
          state.stopped = true;
          state.authError ??= err;
          return null;
        }
        errors.push({ url, status: err.status, error: err.message, hint: err.hint });
        return null;
      }
      const row = inspectionToRow({ project, property, url, result, inspectedAt: now });
      upsertGscInspection(db, row);
      state.done++;
      if (VERDICTS.includes(row.verdict)) verdicts[row.verdict]++;
      else verdicts.other++;
      const summary = { url, verdict: row.verdict, coverage_state: row.coverage_state, google_canonical: row.google_canonical };
      if (typeof opts.onProgress === 'function') {
        opts.onProgress({ ...summary, done: state.done, total: planned.length });
      }
      return summary;
    });
    // mapLimit keeps input order, so results read in priority order rather
    // than in the order the network happened to answer.
    results = rows.filter(Boolean);
  }
  if (state.authError) throw state.authError;

  return {
    project,
    property,
    property_reason: reason,
    dry_run: dryRun,
    planned,
    inspected: results.length,
    requests: state.requests,
    verdicts,
    skipped_recent: selection.skipped_recent,
    skipped_out_of_property: selection.skipped_out_of_property,
    quota_capped: quotaCapped,
    quota: {
      per_day: URL_INSPECTION_QUOTA.perDay,
      used_today: usedToday,
      remaining_after: Math.max(0, remaining - state.requests),
    },
    errors,
    stopped_reason: state.stopped ? 'quota' : null,
    results,
    inspected_at: now,
  };
}
