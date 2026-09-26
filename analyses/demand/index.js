/**
 * analyses/demand — quick wins, long tails and traffic decay, computed from the
 * site's own Search Console rows.
 *
 * Ahrefs and Semrush sell keyword volume: an estimate of how often the world
 * searches a phrase, modelled from clickstream panels, at a monthly price most
 * single-operator sites never recover from search. Search Console gives the
 * site's own share of that demand for free — every query it was shown for,
 * how often, at what position, and how many clicks that earned — and it is a
 * measurement, not a model. gsc-fetch already puts those rows in gsc_daily.
 * This module turns them into three kinds of finding by arithmetic alone: a
 * quick win is a row, a long tail is a row, a decay is two rows subtracted.
 * Nothing here asks a model for anything, so nothing here can be invented,
 * and the findings are stamped rule-sourced so the review hands them to an
 * agent as facts to weigh rather than hypotheses to verify.
 *
 * What a quick win is. A query the property already ranks for within striking
 * distance of the top (positions 4-20 by default) with enough impressions to
 * matter, where either the click-through rate is far below what that position
 * normally earns — the snippet is losing clicks the ranking has already paid
 * for, and a title or description rewrite recovers them without ranking any
 * higher — or the page sits on page two, where internal links and depth are
 * the lever. What it is not: a phrase nobody searches for, a query the site
 * has never been shown for (that is the model's territory, see keyword_gap in
 * the registry), or a branded query at position 1 whose CTR nothing will move.
 * The impressions floor keeps a row with 3 impressions and 0 clicks from
 * reading as a 100% CTR gap.
 *
 * What a long tail is. A phrase of several words the property is shown for
 * without any page reaching page one: the query grain's average position is
 * poor AND no page×query row places a page at 10 or better. Both checks are
 * needed because the query-grain position is an impression-weighted average
 * over every page shown for the query, so a page ranking 5th can hide behind
 * a second page ranking 40th. The finding names the page with most impressions
 * for the query when there is one (strengthen it) and says so when there is
 * none (a page is missing).
 *
 * The CTR curve. EXPECTED_CTR is a heuristic industry baseline with the shape
 * every published CTR study agrees on — steep at the top, flat past position
 * 10 — and round numbers chosen so nobody mistakes it for this site's own
 * measurement. It exists to rank rows against each other and to size an
 * estimate ("about N clicks"), never to be reported as what a position is
 * worth: a query's real CTR depends on SERP features, intent and the brand,
 * none of which a table knows. Replace it with the property's own curve once
 * enough history exists; the shape of the finding does not change.
 *
 * Decay is the paid one. Two same-length windows of the page grain, the
 * previous ending the day before the current begins: a page whose clicks fell
 * by decayPct from a floor of minTrendClicks is decaying, one whose clicks
 * rose by growthPct from that floor is growing. The floor keeps a page going
 * from 3 clicks to 1 off the list — that is noise, not a trend. Trends compare
 * history, which only accumulated fetches can supply, so gsc_decay carries
 * scope 'history' and the caller gates it (opts.trends) the way every other
 * Solo feature is gated; quick wins and long tails are own-site findings and
 * free.
 *
 * Why { complete: true } is honest here. A rule finding clears only when a
 * complete run stops emitting it. Every run here reads the whole property for
 * one window — every page the API reported, not a sample — so a quick win
 * absent from this run is absent because the position moved or the CTR
 * recovered, and marking it resolved is the truth rather than a guess. The
 * one read that is not the whole property is a walk that hit its row cap
 * (lib/gsc-import.js, coverage 'partial'): the rows it dropped are the
 * low-click ones a quick win tends to be, so under partial coverage the run
 * writes what it found and resolves nothing.
 */

import { upsertInsights } from '../../db/db.js';
import { getWindowRows } from '../../lib/gsc-import.js';

/**
 * windowDays              days of gsc_daily each window aggregates
 * minImpressions          a quick win needs this many impressions in the window
 * minLongTailImpressions  a long tail needs this many; lower, because a phrase
 *                         of several words is rarer by nature
 * strikingMin/Max         the positions a quick win may hold. Above 4 the CTR
 *                         curve is too steep for a gap to be a snippet problem;
 *                         past 20 a page-one landing is not one change away
 * longTailMinPosition     the property's average position for the phrase must
 *                         be at least this poor
 * longTailMinWords        words in the phrase
 * cap                     findings kept per kind, best first
 * decayPct/growthPct      click change, in percent of the previous window
 * minTrendClicks          previous-window clicks below which a change is noise
 */
export const DEFAULTS = Object.freeze({
  windowDays: 28,
  minImpressions: 50,
  minLongTailImpressions: 20,
  strikingMin: 4,
  strikingMax: 20,
  longTailMinPosition: 10.5,
  longTailMinWords: 3,
  cap: 50,
  decayPct: 40,
  growthPct: 40,
  minTrendClicks: 10,
});

/**
 * Position → click-through rate, as fractions. A baseline, not a measurement:
 * see the header. Positions 11-20 share one value because page two is flat in
 * every study and the difference between 13th and 17th is inside the noise.
 */
export const EXPECTED_CTR = Object.freeze({
  1: 0.28, 2: 0.15, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.03, 9: 0.025, 10: 0.02,
  11: 0.01, 12: 0.01, 13: 0.01, 14: 0.01, 15: 0.01, 16: 0.01, 17: 0.01, 18: 0.01, 19: 0.01, 20: 0.01,
});

// A CTR below this share of the baseline is a gap worth a snippet rewrite. A
// row a little under the curve is normal variance; at 60% something in the
// snippet is turning people away.
const CTR_GAP_RATIO = 0.6;
// Position 10 or better is page one; a landing from page two is sized at the
// bottom of page one, not at the top.
const PAGE_ONE_POSITION = 10;
const LANDING_POSITION = 8;

/**
 * The baseline CTR for a position: the nearest bucket, clamped to the table's
 * ends. No interpolation — a curve this coarse does not support pretending to
 * know the difference between 6.3 and 6.7. null for a position that is not a
 * number, which is what a row with no impressions carries.
 */
export function expectedCtr(position) {
  const n = numOrNull(position);
  if (n === null) return null;
  const bucket = Math.min(20, Math.max(1, Math.round(n)));
  return EXPECTED_CTR[bucket];
}

/**
 * A finite number, or null. Number(null) is 0, which would read a row with no
 * position as position 1 — the top of the curve — so absence is checked first.
 */
function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Thresholds from opts over DEFAULTS; a non-numeric or negative value keeps the default. */
function settings(opts) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const v = Number(opts?.[key]);
    if (opts?.[key] !== undefined && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

const pct = fraction => +(fraction * 100).toFixed(2);
const round1 = n => +Number(n).toFixed(1);
const ctrOf = (clicks, impressions) => (impressions ? clicks / impressions : 0);
const wordCount = q => String(q || '').trim().split(/\s+/).filter(Boolean).length;
/** The API lower-cases queries already; this only guards a hand-loaded row. */
const queryKey = q => String(q).trim().toLowerCase();

/** YYYY-MM-DD arithmetic in UTC, so a window never shifts with the host's zone. */
function shiftIsoDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const spanOf = w => `${w.start}..${w.end}`;

// ── Quick wins ──────────────────────────────────────────────────────────────

function quickWinRecommendation(w) {
  const q = `"${w.query}"`;
  switch (w.kind) {
    case 'ctr_gap':
      return `Rewrite the title and meta description of ${w.page_url} for ${q}: it ranks ${w.position} with ${w.ctr}% CTR against a ${w.expected_ctr}% baseline, so the snippet is losing clicks the position has already earned.`;
    case 'page_two':
      return `Add internal links to ${w.page_url} for ${q} and deepen the section that answers it: at position ${w.position} a page-one landing is worth about ${w.potential_clicks} more clicks per window.`;
    default:
      return `Move ${w.page_url} onto page one for ${q} with internal links and depth, and rewrite its snippet: at position ${w.position} with ${w.ctr}% CTR both the ranking and the snippet are leaving clicks behind.`;
  }
}

/**
 * Quick wins over window-aggregated page×query rows. PURE.
 *
 * potential_clicks sizes the win in clicks per window: for a CTR gap the
 * clicks the baseline says the position should already earn; for a page-two
 * row the clicks a landing at position 8 would earn; for both, the larger.
 * Never negative — a page-two row with a CTR above the landing baseline is
 * still a page-two row, just not one worth many clicks.
 *
 * @param {{ page_url: string, query: string, clicks: number, impressions: number, position: number|null }[]} rows
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
export function computeQuickWins(rows, opts = {}) {
  const s = settings(opts);
  const landingCtr = expectedCtr(LANDING_POSITION);
  const out = [];
  for (const r of rows || []) {
    if (!r?.page_url || !r?.query) continue;
    const impressions = Number(r.impressions) || 0;
    const position = numOrNull(r.position);
    if (impressions < s.minImpressions || position === null) continue;
    if (position < s.strikingMin || position > s.strikingMax) continue;
    const clicks = Number(r.clicks) || 0;
    const actual = ctrOf(clicks, impressions);
    const expected = expectedCtr(position);
    const ctrGap = actual < CTR_GAP_RATIO * expected;
    const pageTwo = position > PAGE_ONE_POSITION;
    if (!ctrGap && !pageTwo) continue;
    const kind = ctrGap && pageTwo ? 'both' : ctrGap ? 'ctr_gap' : 'page_two';
    const gapClicks = Math.round(impressions * Math.max(expected - actual, 0));
    const landingClicks = Math.round(impressions * Math.max(landingCtr - actual, 0));
    const potential = kind === 'both' ? Math.max(gapClicks, landingClicks) : kind === 'ctr_gap' ? gapClicks : landingClicks;
    const win = {
      page_url: r.page_url,
      query: r.query,
      impressions,
      clicks,
      position: round1(position),
      ctr: pct(actual),
      expected_ctr: pct(expected),
      kind,
      potential_clicks: potential,
    };
    win.recommendation = quickWinRecommendation(win);
    out.push(win);
  }
  // Ties broken deterministically so two runs over the same rows agree.
  out.sort((a, b) => b.potential_clicks - a.potential_clicks
    || b.impressions - a.impressions
    || a.query.localeCompare(b.query)
    || a.page_url.localeCompare(b.page_url));
  return out.slice(0, s.cap);
}

// ── Long tails ──────────────────────────────────────────────────────────────

function longTailRecommendation(t) {
  const q = `"${t.query}"`;
  return t.best_page
    ? `Strengthen ${t.best_page} for ${q}: it is the page most shown for the phrase (position ${t.best_position}) yet nothing ranks on page one — answer the phrase under its own heading and link to it from related pages.`
    : `Create a page for ${q}: the property is shown ${t.impressions} times at position ${t.position} without any page ranking for it.`;
}

/**
 * Long tails over property-wide query rows, with page×query rows saying which
 * pages already cover each phrase. PURE.
 *
 * @param {{ query: string, clicks: number, impressions: number, position: number|null }[]} queryRows
 * @param {{ page_url: string, query: string, clicks: number, impressions: number, position: number|null }[]} pageQueryRows
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
export function computeLongTails(queryRows, pageQueryRows, opts = {}) {
  const s = settings(opts);
  // Per phrase: whether any page is on page one, and the page most shown for it.
  const coverage = new Map();
  for (const r of pageQueryRows || []) {
    if (!r?.query || !r?.page_url) continue;
    const key = queryKey(r.query);
    const c = coverage.get(key) || { pageOne: false, best: null };
    const position = numOrNull(r.position);
    if (position !== null && position <= PAGE_ONE_POSITION) c.pageOne = true;
    const impressions = Number(r.impressions) || 0;
    if (!c.best || impressions > c.best.impressions) c.best = { page_url: r.page_url, impressions, position };
    coverage.set(key, c);
  }

  const out = [];
  for (const r of queryRows || []) {
    if (!r?.query) continue;
    const impressions = Number(r.impressions) || 0;
    const position = numOrNull(r.position);
    if (impressions < s.minLongTailImpressions || position === null || position < s.longTailMinPosition) continue;
    const words = wordCount(r.query);
    if (words < s.longTailMinWords) continue;
    const c = coverage.get(queryKey(r.query));
    if (c?.pageOne) continue;
    const bestPosition = numOrNull(c?.best?.position);
    const tail = {
      query: r.query,
      impressions,
      clicks: Number(r.clicks) || 0,
      position: round1(position),
      best_page: c?.best?.page_url ?? null,
      best_position: bestPosition === null ? null : round1(bestPosition),
      words,
    };
    tail.recommendation = longTailRecommendation(tail);
    out.push(tail);
  }
  out.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
  return out.slice(0, s.cap);
}

// ── Trends ──────────────────────────────────────────────────────────────────

/**
 * Which lever a decay points at is readable from the two windows: a page that
 * vanished, a position that slipped, demand that fell with the position held,
 * or a snippet converting less while both held. Each gets its own sentence
 * rather than a generic "look into it".
 */
function decayRecommendation(d, decayPct) {
  const drop = `clicks fell ${Math.abs(d.delta_pct)}% (${d.previous_clicks} → ${d.clicks})`;
  if (d.clicks === 0 && d.impressions === 0) {
    return `Check ${d.page_url} is still live and indexed: it earned ${d.previous_clicks} clicks in the previous window and was not shown at all in this one.`;
  }
  const slipped = d.position !== null && d.previous_position !== null && d.position - d.previous_position >= 1;
  if (slipped) {
    return `Recover the ranking of ${d.page_url}: ${drop} as position slipped ${d.previous_position} → ${d.position}; refresh the content, restore internal links to it, and check what now ranks above it.`;
  }
  const demandFell = d.previous_impressions > 0
    && (d.previous_impressions - d.impressions) / d.previous_impressions * 100 >= decayPct;
  if (demandFell) {
    return `Check demand for ${d.page_url}: ${drop} with position steady at ${d.position} because impressions fell ${d.previous_impressions} → ${d.impressions}; the queries may be seasonal, or the page may have lost some of them.`;
  }
  return `Rewrite the snippet of ${d.page_url}: ${drop} while impressions (${d.previous_impressions} → ${d.impressions}) and position (${d.previous_position} → ${d.position}) held, so fewer of the people who see it are choosing it.`;
}

function growthRecommendation(g) {
  return `Build on ${g.page_url}: clicks rose ${g.delta_pct}% (${g.previous_clicks} → ${g.clicks}); deepen the sections behind the queries that grew and link to it from related pages.`;
}

/**
 * Decays and growth between two page-grain window aggregates of the same
 * length. PURE. A page present in one window only is compared against zero
 * for the other, which is what happened; the minTrendClicks floor is on the
 * previous window, so a page that appeared from nothing is never "growth" and
 * a page that vanished from a real click count is a decay.
 *
 * @param {{ page_url: string, clicks: number, impressions: number, position: number|null }[]} currentRows
 * @param {{ page_url: string, clicks: number, impressions: number, position: number|null }[]} previousRows
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {{ decays: object[], growth: object[] }}
 */
export function computeTrends(currentRows, previousRows, opts = {}) {
  const s = settings(opts);
  const byPage = new Map();
  const fold = (rows, side) => {
    for (const r of rows || []) {
      if (!r?.page_url) continue;
      const e = byPage.get(r.page_url) || { page_url: r.page_url, current: null, previous: null };
      const position = numOrNull(r.position);
      e[side] = {
        clicks: Number(r.clicks) || 0,
        impressions: Number(r.impressions) || 0,
        position: position === null ? null : round1(position),
      };
      byPage.set(r.page_url, e);
    }
  };
  fold(currentRows, 'current');
  fold(previousRows, 'previous');

  const none = { clicks: 0, impressions: 0, position: null };
  const decays = [];
  const growth = [];
  for (const e of byPage.values()) {
    const prev = e.previous || none;
    const cur = e.current || none;
    if (prev.clicks < s.minTrendClicks || prev.clicks <= 0) continue;
    // The threshold is applied to the exact ratio; delta_pct is rounded for
    // display only. Rounding first would file 2503 → 1503 (−39.95%) as a 40%
    // decay because it prints as −40.0.
    const ratio = (cur.clicks - prev.clicks) / prev.clicks * 100;
    const item = {
      page_url: e.page_url,
      clicks: cur.clicks,
      previous_clicks: prev.clicks,
      delta_pct: round1(ratio),
      impressions: cur.impressions,
      previous_impressions: prev.impressions,
      position: cur.position,
      previous_position: prev.position,
    };
    if (ratio <= -s.decayPct) {
      item.recommendation = decayRecommendation(item, s.decayPct);
      decays.push(item);
    } else if (ratio >= s.growthPct) {
      item.recommendation = growthRecommendation(item);
      growth.push(item);
    }
  }
  const byAbsChange = (a, b) => Math.abs(b.clicks - b.previous_clicks) - Math.abs(a.clicks - a.previous_clicks)
    || a.page_url.localeCompare(b.page_url);
  decays.sort(byAbsChange);
  growth.sort(byAbsChange);
  return { decays, growth };
}

/**
 * The current page-grain window against the one before it. The previous
 * window must be the same length: a shorter one (history that does not yet
 * reach back two windows) would make every page look like growth, so the
 * comparison is reported as skipped rather than made. The same reason covers
 * a previous window that does not exist at all: getWindowRows answers null
 * when the day before the current window was never fetched — a gap between
 * two fetch walks — because the run before the gap would not touch the
 * current window, and a window padded across the gap would compare 28 days
 * against 12 fetched ones and call flat traffic growth. Nothing is written to
 * the Ledger for a skipped comparison, and a decay found earlier stays until
 * a run can re-check it.
 */
function windowTrends(db, project, current, s) {
  const empty = { previous_window: null, decays: [], growth: [] };
  if (!current) return { trends: { ...empty, skipped_reason: 'no_page_grain' }, complete: false };
  const previous = getWindowRows(db, project, 'page', {
    windowDays: current.window.days,
    endDate: shiftIsoDate(current.window.start, -1),
  });
  if (!previous || previous.window.days !== current.window.days) {
    return {
      trends: { ...empty, previous_window: previous?.window ?? null, skipped_reason: 'previous_window_short' },
      complete: false,
    };
  }
  const { decays, growth } = computeTrends(current.rows, previous.rows, s);
  const stamp = t => ({ ...t, window: spanOf(current.window), previous_window: spanOf(previous.window) });
  return {
    trends: { previous_window: previous.window, decays: decays.map(stamp), growth: growth.map(stamp), skipped_reason: null },
    complete: current.coverage === 'complete' && previous.coverage === 'complete',
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Compute every demand finding for a project from gsc_daily and record the
 * findings in the Ledger.
 *
 * Grains: page_query feeds quick wins and the coverage side of long tails,
 * query feeds long tails, page feeds trends. Each finding kind is written
 * only when the grain it needs was fetched — a project whose query grain was
 * never pulled has no long tails to resolve, and an empty complete write
 * would say otherwise. Long tails need both their grains: without page×query
 * rows the "no page on page one" clause could not be checked, and a finding
 * that skipped its own definition is not one.
 *
 * `complete` follows coverage, as the header explains: a window a capped walk
 * touched is written without resolving anything.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {Partial<typeof DEFAULTS> & { trends?: boolean, skipLedger?: boolean }} opts
 *   trends      compare against the previous window and write gsc_decay. Paid
 *               (scope 'history'); the caller decides.
 *   skipLedger  compute only.
 * @returns {{ project: string, property: string|null, search_type: string|null,
 *   window: { start: string, end: string, days: number, requested_days: number } | null,
 *   coverage: { page_query: 'complete'|'partial'|null, query: 'complete'|'partial'|null, page: 'complete'|'partial'|null } | null,
 *   quick_wins: object[], long_tails: object[],
 *   trends: null | { previous_window: object|null, decays: object[], growth: object[], skipped_reason: string|null },
 *   counts: { quick_wins: number, long_tails: number, decays: number, growth: number },
 *   skipped_reason: null | 'no_gsc_data', hint?: string }}
 */
export function runDemand(db, project, opts = {}) {
  const s = settings(opts);
  const windowDays = s.windowDays;
  const pq = getWindowRows(db, project, 'page_query', { windowDays });
  const q = getWindowRows(db, project, 'query', { windowDays });
  const pg = getWindowRows(db, project, 'page', { windowDays });

  if (!pq && !q && !pg) {
    return {
      project,
      property: null,
      search_type: null,
      window: null,
      coverage: null,
      quick_wins: [],
      long_tails: [],
      trends: null,
      counts: { quick_wins: 0, long_tails: 0, decays: 0, growth: 0 },
      skipped_reason: 'no_gsc_data',
      hint: `No Search Console rows for ${project}. Run: seo-intel gsc-fetch ${project}`,
    };
  }

  // The window reported is the one the free findings were read from; the
  // grains are fetched together, so in practice all three agree.
  const primary = pq || pg || q;
  const coverage = { page_query: pq?.coverage ?? null, query: q?.coverage ?? null, page: pg?.coverage ?? null };

  const quick_wins = pq ? computeQuickWins(pq.rows, s) : [];
  const long_tails = q && pq ? computeLongTails(q.rows, pq.rows, s) : [];
  const trendRun = opts.trends ? windowTrends(db, project, pg, s) : null;
  const trends = trendRun ? trendRun.trends : null;

  // Fingerprints carry the page URL exactly as Search Console reported it.
  // The API's page dimension is Google's canonical, so https://acme.io/a,
  // https://acme.io/a/ and http://acme.io/a?ref=x are three pages to Google
  // and three rows here, each with its own impressions and position; a
  // fingerprint that normalised them (lib/gsc-import.js normalizeUrlKey drops
  // scheme, www, the trailing slash and the query string) collapsed three
  // findings into one Ledger row holding whichever variant was written last,
  // so counts.quick_wins said 3 while the Ledger held 1 — and the weakest.
  if (!opts.skipLedger) {
    if (pq) {
      upsertInsights(db, project, 'gsc_quick_win',
        quick_wins.map(w => ({ fingerprint: `${w.page_url}|${w.query}`, data: w })),
        { complete: pq.coverage === 'complete' });
    }
    if (q && pq) {
      upsertInsights(db, project, 'gsc_long_tail',
        long_tails.map(t => ({ fingerprint: queryKey(t.query), data: t })),
        { complete: q.coverage === 'complete' && pq.coverage === 'complete' });
    }
    if (trends && !trends.skipped_reason) {
      upsertInsights(db, project, 'gsc_decay',
        trends.decays.map(d => ({ fingerprint: d.page_url, data: d })),
        { complete: trendRun.complete });
    }
  }

  return {
    project,
    property: primary.property,
    search_type: primary.search_type,
    window: primary.window,
    coverage,
    quick_wins,
    long_tails,
    trends,
    counts: {
      quick_wins: quick_wins.length,
      long_tails: long_tails.length,
      decays: trends?.decays.length ?? 0,
      growth: trends?.growth.length ?? 0,
    },
    skipped_reason: null,
  };
}
