/**
 * analyses/competitor-pages — the three attacks that read a competitor's own
 * pages and nothing else: shallow champions, content decay, and the heading
 * architecture audit.
 *
 * Why one module. Each of these used to be written three times: inline in
 * cli.js, again in agent-harness.js run() (which is what the MCP tools
 * find_shallow_competitor_pages, find_decaying_competitor_pages and
 * audit_competitor_headings call), and again in reports/generate-html.js for
 * the dashboard cards. The copies drifted the way copies do: the harness
 * dropped the click-depth sort key from both decay lists and the word-count
 * tiebreak from the headings audit, so the terminal and an agent asking "the
 * same" question over MCP got the same rows in a different order — and with a
 * LIMIT 20 or a cap of 30 downstream of that order, sometimes different rows.
 * The harness also read a depth of 0 as "use the default" (parseInt(0) || 2),
 * which the MCP schema explicitly allows and the CLI honours. Row selection
 * now lives here once; the CLI renders the result, the harness returns a
 * projection of it, the dashboard reads the same lists. Where the copies
 * differed, the CLI's selection won: it is the surface people read and pay
 * for, and no harness ordering was a fix. The one thing the harness did
 * better is kept — a missing or garbled number takes the default, where the
 * CLI bound NaN (an empty list, or a RangeError from the decay cutoff) — but
 * without its side effect on 0.
 *
 * What every attack shares. Only domains with role 'competitor' — the target's
 * own pages are never an attack surface here. Only is_indexable = 1: a noindex
 * page is not in the index, so it ranks for nothing and there is nothing to
 * displace. Only content pages (lib/content-pages.js): a login wall, an app
 * route or a query-string URL is not a topic anyone can outwrite. And click
 * depth as the proxy for importance: a page the competitor links from its
 * homepage, or one hop further, is a page its own navigation says matters.
 * NULL word counts, depths and flags fail every comparison below and so drop
 * out, which is right — a page the crawler could not measure is not a finding.
 *
 * Shallow champions. Near the homepage (click_depth <= maxDepth) and thin
 * (word_count <= maxWords): the topic is validated — the competitor put it in
 * its navigation — but the page ranks on the domain's authority rather than on
 * substance, which makes it the cheapest page in the market to beat with a
 * thorough one. The floor of 80 words (exclusive) keeps nav stubs, cookie
 * walls and redirect shells out; nothing ranks on 60 words of boilerplate.
 * Shallowest first, then thinnest, because depth is the stronger signal.
 *
 * Content decay. Two lists, both within two clicks of the homepage.
 * confirmedStale: a modified date older than `months` before now, on a page
 * with more than 100 words. unknownFreshness: no date at all (neither modified
 * nor published) on a mid-length page, 300-1500 words — long enough to have
 * been written as content, short enough to be a page written once and left.
 * The second list is suspicion, not evidence, so it is capped at 20. The cap is
 * applied in SQL before the content-page filter, so it can return fewer than 20
 * when app routes sat among the first 20; every copy did this, and it stays.
 * Dates compare as ISO text: the cutoff is YYYY-MM-DD and modified_date is
 * whatever ISO string the crawler stored, so a timestamp on the cutoff day
 * sorts after it and is not stale. The cutoff subtracts calendar months in
 * local time (Date#setMonth) as both copies did; opts.now makes it testable.
 *
 * Heading audit. Competitor pages above 200 words (enough prose that the
 * outline is an argument, not a menu) within `depth` clicks, optionally one
 * domain, ordered by domain, then shallowest, then longest — so each domain's
 * most important substantial pages come first. The first 30 candidates are
 * read and those with no headings are dropped after the cap, so fewer than 30
 * can come back even when more pages exist; the CLI has always done it this
 * way and the MCP tool promises "up to 30". Headings come back in document
 * order (rowid, the order the crawler inserted them), all six levels; which
 * levels to show is the renderer's call.
 *
 * Options keep the CLI's names (maxWords, maxDepth, months, depth, domain) and
 * accept strings (commander) or numbers (MCP). A value that is not an integer
 * falls back to the default; 0 is an integer and is kept.
 */

import { isContentPage } from '../../lib/content-pages.js';

/**
 * maxWords  shallow: word-count ceiling for "thin", inclusive
 * maxDepth  shallow: click-depth ceiling, inclusive
 * months    decay: a page modified before now minus this many months is stale
 * depth     headings-audit: click-depth ceiling, inclusive
 */
export const DEFAULTS = Object.freeze({
  maxWords: 700,
  maxDepth: 2,
  months: 18,
  depth: 2,
});

/**
 * The fixed bounds, named so the header's reasoning has something to point at.
 * None is an option on any surface today; all are exclusive floors or
 * inclusive ranges exactly as the SQL reads them.
 */
export const BOUNDS = Object.freeze({
  shallowMinWords: 80,        // exclusive: at or below is boilerplate
  decayMaxDepth: 2,           // inclusive, both decay lists
  staleMinWords: 100,         // exclusive, confirmedStale
  undatedMinWords: 300,       // inclusive, unknownFreshness
  undatedMaxWords: 1500,      // inclusive, unknownFreshness
  undatedLimit: 20,           // unknownFreshness rows read, before the content-page filter
  headingsMinWords: 200,      // exclusive
  headingsPageCap: 30,        // candidates read for headings, before the no-headings drop
});

/**
 * An integer option, or the fallback. parseInt so '700' from commander and 700
 * from MCP read the same; Number.isFinite so 0 survives (the harness's
 * `parseInt(x) || 2` turned a requested depth of 0 into 2) and so a missing or
 * garbled value takes the default instead of binding NaN into the query.
 * Always base 10: both copies' bare parseInt read '0x10' as 16, which is now 0.
 */
export function intOpt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The decay cutoff as YYYY-MM-DD: `now` minus `months` calendar months, in
 * local time, then read back as a UTC date — the arithmetic both copies used,
 * kept so the cutoff does not move by a day for anyone. Month-end overflow is
 * Date's (31 Aug minus 18 months is 3 Mar), also as before.
 */
export function decayCutoff(now, months) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0];
}

/**
 * Shallow champions. Returns
 *   targets       [{ url, domain, wordCount, clickDepth }], shallowest then thinnest
 *   totalTargets  targets.length
 *   byDomain      { domain: [{ url, wordCount, clickDepth }] }, same order within each
 *   maxWords, maxDepth  the thresholds used, for the renderer's summary line
 * The harness contract is { targets, totalTargets }; the CLI's JSON adds byDomain.
 */
export function findShallowPages(db, project, opts = {}) {
  const maxWords = intOpt(opts.maxWords, DEFAULTS.maxWords);
  const maxDepth = intOpt(opts.maxDepth, DEFAULTS.maxDepth);

  const rows = db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, d.domain
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= ? AND p.word_count <= ? AND p.word_count > ?
      AND p.is_indexable = 1
    ORDER BY p.click_depth ASC, p.word_count ASC
  `).all(project, maxDepth, maxWords, BOUNDS.shallowMinWords).filter(r => isContentPage(r.url));

  const targets = rows.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, clickDepth: r.click_depth }));
  const byDomain = {};
  for (const t of targets) {
    if (!byDomain[t.domain]) byDomain[t.domain] = [];
    byDomain[t.domain].push({ url: t.url, wordCount: t.wordCount, clickDepth: t.clickDepth });
  }

  return { targets, totalTargets: targets.length, byDomain, maxWords, maxDepth };
}

/**
 * Content decay. Returns
 *   confirmedStale    [{ url, domain, wordCount, modifiedDate, clickDepth }],
 *                     shallowest first, then oldest modified_date
 *   unknownFreshness  [{ url, domain, wordCount, clickDepth }], shallowest then shortest
 *   monthsThreshold   the months used
 *   cutoff            YYYY-MM-DD; modified_date strictly before it is stale
 * The harness contract is { confirmedStale, unknownFreshness, monthsThreshold }.
 * opts.now (ms or Date) fixes the clock; default Date.now().
 */
export function findDecayingPages(db, project, opts = {}) {
  const months = intOpt(opts.months, DEFAULTS.months);
  const cutoff = decayCutoff(opts.now ?? Date.now(), months);

  const staleKnown = db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, p.modified_date, d.domain
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= ? AND p.word_count > ?
      AND p.modified_date IS NOT NULL AND p.modified_date < ?
      AND p.is_indexable = 1
    ORDER BY p.click_depth ASC, p.modified_date ASC
  `).all(project, BOUNDS.decayMaxDepth, BOUNDS.staleMinWords, cutoff).filter(r => isContentPage(r.url));

  const staleUnknown = db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, d.domain
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= ? AND p.word_count BETWEEN ? AND ?
      AND p.modified_date IS NULL AND p.published_date IS NULL
      AND p.is_indexable = 1
    ORDER BY p.click_depth ASC, p.word_count ASC
    LIMIT ?
  `).all(project, BOUNDS.decayMaxDepth, BOUNDS.undatedMinWords, BOUNDS.undatedMaxWords, BOUNDS.undatedLimit)
    .filter(r => isContentPage(r.url));

  return {
    confirmedStale: staleKnown.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, modifiedDate: r.modified_date, clickDepth: r.click_depth })),
    unknownFreshness: staleUnknown.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, clickDepth: r.click_depth })),
    monthsThreshold: months,
    cutoff,
  };
}

/**
 * Heading architecture audit. Returns
 *   pages           [{ url, domain, wordCount, clickDepth, headings: [{ level, text }] }]
 *   totalPages      pages.length
 *   candidateCount  content pages that matched before the cap and the
 *                   no-headings drop; the CLI says "no pages found" only when
 *                   this is 0, and otherwise writes a report even if empty
 *   maxDepth        the depth used
 *   domain          the domain filter, or null
 * The harness contract is { pages, totalPages }.
 */
export function auditCompetitorHeadings(db, project, opts = {}) {
  const maxDepth = intOpt(opts.depth, DEFAULTS.depth);
  const domain = opts.domain || null;

  const domainFilter = domain ? 'AND d.domain = ?' : '';
  const params = domain
    ? [project, maxDepth, BOUNDS.headingsMinWords, domain]
    : [project, maxDepth, BOUNDS.headingsMinWords];

  const candidates = db.prepare(`
    SELECT p.id, p.url, p.word_count, p.click_depth, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= ? AND p.word_count > ?
      ${domainFilter}
      AND p.is_indexable = 1
    ORDER BY d.domain, p.click_depth ASC, p.word_count DESC
  `).all(...params).filter(r => isContentPage(r.url));

  const headingsOf = db.prepare('SELECT level, text FROM headings WHERE page_id = ? ORDER BY rowid ASC');
  const pages = [];
  for (const page of candidates.slice(0, BOUNDS.headingsPageCap)) {
    const headings = headingsOf.all(page.id);
    if (!headings.length) continue;
    pages.push({
      url: page.url, domain: page.domain, wordCount: page.word_count, clickDepth: page.click_depth,
      headings: headings.map(h => ({ level: h.level, text: h.text })),
    });
  }

  return { pages, totalPages: pages.length, candidateCount: candidates.length, maxDepth, domain };
}
