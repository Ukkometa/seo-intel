/**
 * analyses/history — the two commands that read the crawl as a timeline: the
 * crawl change brief (`brief`) and publishing velocity (`velocity`).
 *
 * Every other attack reads one snapshot of a competitor's site. These two read
 * what moved between crawls, which only accumulated crawls can supply, so they
 * are the Solo "history" line (lib/gate.js) and the caller gates them; nothing
 * here checks a licence.
 *
 * Why one module. Both commands were written twice, inline in cli.js and again
 * in agent-harness.js run() — and the CLI's brief was written twice on its own,
 * a JSON fast path and a text path, which had already drifted from each other.
 * The copies agreed on the WHERE clauses and disagreed on everything around
 * them. The CLI's text path ordered new pages newest first and re-crawled pages
 * most recent first; its JSON path and the harness did not order at all, so
 * "the first ten new pages" that feed the keyword and schema gaps were the ten
 * newest in the terminal and whichever ten SQLite scanned first everywhere
 * else. Velocity differed in substance: the CLI rates a domain on the larger of
 * two signals (pages first seen in the window, pages whose published_date falls
 * in it) and lists domains by role then name; the harness rated on first-seen
 * alone and listed by name. Row selection now lives here once and the CLI's
 * version won each time: it is the surface people read and pay for, and none
 * of the harness's differences was a fix. Where the CLI's own two paths
 * disagreed, the text path won, because it is the one printed: `brief
 * --format json` and the MCP brief now list new pages newest first and
 * re-crawled pages most recent first, and the JSON's keyword and schema gaps
 * come from each competitor's ten newest new pages, as the terminal's always
 * did. The one thing the harness did better is kept — a config without
 * competitors is an empty brief, not a TypeError. The harness still returns
 * the shape it always has (briefForHarness, velocityForHarness below), because
 * that shape is what the MCP tools promise. Equal timestamps fall back to
 * insertion order (p.id), which is what the copies' index scans returned
 * anyway, now written down so it cannot change with a query plan.
 *
 * The brief's own-site list (Your Site) only ever existed in the CLI's text
 * path, and its query had no ORDER BY: SQLite reads it through
 * idx_pages_domain, so it came back in insertion order — oldest first, as a
 * rule — and the three paths printed under each domain were the first three
 * the crawler ever stored, not the newest. That order is written down here as
 * ORDER BY p.id rather than quietly turned into newest first. Newest first is
 * the better list and the obvious next change; it changes what the brief
 * prints, so it belongs in a change of its own with its own before/after.
 *
 * What "new" means. upsertPage stamps first_seen_at once, on the INSERT, and
 * never updates it, so a URL whose first_seen_at is after the cutoff was not in
 * any earlier crawl. That is discovery, not publication: the first crawl of a
 * domain finds every page at once, and all of it reads as new. Nothing here
 * pretends otherwise — it is why velocity also counts published_date, and why
 * the numbers settle after the second crawl.
 *
 * What "changed" means, honestly. A page counts as changed when it was crawled
 * inside the window and first seen before it. That is "re-crawled", not
 * "edited": pages keeps only the latest content_hash, so there is no earlier
 * hash to compare against, and on a weekly schedule every competitor page a
 * crawl reaches is in this list. The field keeps the name the brief has always
 * used (changedPages, "N updated") because renaming it is a contract change;
 * the day the crawler keeps the previous hash, the test belongs in that query.
 * Both bounds are strict, as in every copy: a page first seen exactly at the
 * cutoff millisecond is neither new nor changed.
 *
 * What is counted. Only is_indexable = 1 pages (a noindex page ranks for
 * nothing, so its arrival is not a move) and only content pages
 * (lib/content-pages.js: a login wall, an app route or a ?ref= variant is not a
 * topic). Only the project's own domain rows, and for the brief only the
 * competitors, target and owned domains the config lists, in config order —
 * a competitor dropped from the config stops appearing even while its rows
 * remain. Two counts deliberately do NOT apply the filters, because the CLI
 * never did and the numbers are printed: the brief's targetNewPages (every URL
 * of the target first seen in the window, noindex and login pages included —
 * the "vs your N" in the publishing-rate action, which can therefore differ
 * from the Your Site section's content count) and velocity's total (every
 * indexable page of the domain, app routes included).
 *
 * Gaps. For each competitor the ten newest new pages are read for keywords and
 * schema types. A keyword is a gap when no target or owned page carries it,
 * compared exactly as both CLI paths compared it: the competitor's keyword
 * lowercased and trimmed in JS (normalizeKeyword), the own side lowercased in
 * SQL and not trimmed. That comparison has two known false positives, kept
 * because fixing them removes lines from the brief and belongs in its own
 * change with its own before/after:
 *   - insertKeywords lowercases but does not trim, so an own keyword the
 *     extractor returned as " zk compression" does not match a competitor's
 *     "zk compression", and the brief reports a gap the target already covers;
 *   - SQLite's LOWER folds ASCII only, so an own "ÖLJA" written by anything
 *     but insertKeywords (which lowercases in JS) is "Ölja" and misses "ölja".
 * The fix for both is normalizeKeyword on the own side too. Keywords under
 * three characters (after the trim) are noise. Gaps are ranked by how many
 * competitors carry them, first found first on a tie, and the top ten kept.
 * A schema type is a gap when no target or owned extraction lists it; every
 * one found is kept, in the order found.
 *
 * Velocity. Per domain: pages first seen in the window (newCount), content
 * pages whose published_date sorts after the cutoff date (pubCount), and a
 * rate of max(newCount, pubCount) per week to one decimal. The larger signal
 * wins because each misses what the other sees: a site without datePublished
 * markup has only discovery, and a site crawled for the first time has only
 * dates worth trusting. published_date is whatever the page's JSON-LD said, so
 * it compares as text against YYYY-MM-DD: an ISO timestamp on the cutoff day
 * sorts after it and counts, a bare date equal to it does not, and a future
 * date counts. So does a date in the cutoff's year written with slashes
 * (2026/01/05 sorts after 2026-08-30, since '/' > '-'); the CLI has always
 * compared this way, and normalising dates belongs at the crawler, where they
 * are stored. Domains come competitor, owned, target (role order), then by
 * name; a domain with no indexable page has no row.
 *
 * The clock. opts.now (ms or Date) fixes "now", opts.days sets the window; the
 * cutoff is now minus days × 24 h. days accepts a commander string or an MCP
 * number, and anything that is not a positive integer takes the default — the
 * copies' `parseInt(x) || 7` already turned 0 and garbage into the default.
 * A negative window is the one input read differently: the copies kept it, put
 * the cutoff in the future and printed an empty report ("last -3 days"; for
 * velocity, only pages dated in the future), and it now takes the default too.
 */

import { isContentPage } from '../../lib/content-pages.js';
import { readProjectConfig } from '../../lib/project-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lookback windows in days: brief is the weekly report, velocity a month. */
export const DEFAULTS = Object.freeze({
  briefDays: 7,
  velocityDays: 30,
});

/** The brief's fixed bounds. None is an option on any surface today. */
export const BOUNDS = Object.freeze({
  gapPagesPerCompetitor: 10,  // newest new pages per competitor read for keyword and schema gaps
  keywordGapLimit: 10,        // keyword gaps kept, most competitors first
  minKeywordLength: 3,        // shorter (after trim) is noise
});

/**
 * A lookback window in days: a positive integer, or the fallback. parseInt so
 * '14' from commander and 14 from MCP read the same. Always base 10: both
 * copies' bare parseInt read '0x10' as 16 days, which is now 0 and so the
 * default.
 */
export function windowDays(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** opts.now as epoch ms: a number or a Date, anything else is the real clock. */
function nowMs(value) {
  const t = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * A competitor keyword as the gap comparison reads it. Only the competitor
 * side: the own side is SQL LOWER, untrimmed (see the header's Gaps).
 */
export function normalizeKeyword(keyword) {
  return String(keyword).toLowerCase().trim();
}

/**
 * Pages per week over a window of `days`, to one decimal, as a number. 0 for
 * an empty or non-positive window rather than Infinity or NaN.
 */
export function ratePerWeek(count, days) {
  if (!(days > 0)) return 0;
  return parseFloat((count / (days / 7)).toFixed(1)) || 0;
}

/** schema_types is a JSON array of type names; anything else carries none. */
function schemaTypes(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function addDomain(map, key, domain) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(domain);
}

const pageRef = r => ({ url: r.url, wordCount: r.word_count });

/**
 * The brief's action list, in the order the CLI prints it: the top keyword
 * gap, the first schema gap, then the publishing-rate comparison when the
 * fastest competitor (most new content pages; config order on a tie) found
 * more than targetNewPages. Two standing suggestions when none applies.
 */
export function briefActions({ keywordGaps, schemaGaps, competitorMoves, targetNewPages }) {
  const actions = [];
  if (keywordGaps.length > 0) {
    const g = keywordGaps[0];
    actions.push(`Write content covering "${g.keyword}" — ${g.count} competitor(s) rank for it`);
  }
  if (schemaGaps.length > 0) {
    const s = schemaGaps[0];
    actions.push(`Add ${s.schema} schema markup to relevant pages (${s.domains[0]} already has it)`);
  }
  let fastest = null;
  for (const m of competitorMoves) {
    if (!fastest || m.newPages.length > fastest.rate) fastest = { domain: m.domain, rate: m.newPages.length };
  }
  if (fastest && fastest.rate > targetNewPages) {
    actions.push(`Increase publishing rate — ${fastest.domain} published ${fastest.rate} pages vs your ${targetNewPages}`);
  }
  if (actions.length === 0) {
    actions.push('Re-crawl competitors to detect new content');
    actions.push('Review dashboard for technical SEO fixes');
  }
  return actions;
}

/**
 * Crawl change brief. Returns
 *   period           { days, cutoff: YYYY-MM-DD, weekOf: YYYY-MM-DD }
 *   targetDomain     config target, or null
 *   competitorMoves  [{ domain, newPages: [{ url, wordCount }], changedPages: [{ url, wordCount }] }]
 *                    one per configured competitor, config order, empty lists included;
 *                    newPages newest first, changedPages most recently crawled first
 *   ownMoves         [{ domain, newPages: [{ url, wordCount }] }], target then owned;
 *                    newPages in insertion order (p.id), as the CLI printed them
 *   keywordGaps      [{ keyword, domains, count }], at most BOUNDS.keywordGapLimit
 *   schemaGaps       [{ schema, domains }]
 *   targetNewPages   unfiltered count of the target's URLs first seen in the window
 *   actions          [string], see briefActions
 * The harness contract is briefForHarness(result); the CLI's JSON is every
 * field but targetDomain and ownMoves.
 *
 * opts.config (the parsed project config; read from config/<project>.json when
 * absent), opts.days (default 7), opts.now (ms or Date; default Date.now()).
 */
export function getCrawlBrief(db, project, opts = {}) {
  const config = opts.config ?? readProjectConfig(project);
  const days = windowDays(opts.days, DEFAULTS.briefDays);
  const now = nowMs(opts.now);
  const cutoff = now - days * DAY_MS;

  const targetDomain = config?.target?.domain || null;
  const competitorDomains = (config?.competitors || []).map(c => c.domain).filter(Boolean);
  const ownDomains = [targetDomain, ...(config?.owned || []).map(o => o.domain)].filter(Boolean);

  const newStmt = db.prepare(`
    SELECT p.id, p.url, p.word_count
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
    ORDER BY p.first_seen_at DESC, p.id ASC
  `);
  const changedStmt = db.prepare(`
    SELECT p.id, p.url, p.word_count
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.domain = ? AND d.project = ?
      AND p.crawled_at > ? AND p.first_seen_at < ?
      AND p.is_indexable = 1
    ORDER BY p.crawled_at DESC, p.id ASC
  `);
  // Your Site: the same rows as a competitor's new pages, in the order the CLI
  // has always printed them — insertion order, not newest first (see header).
  const ownNewStmt = db.prepare(`
    SELECT p.id, p.url, p.word_count
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
    ORDER BY p.id ASC
  `);
  const contentRows = (stmt, ...params) => stmt.all(...params).filter(r => isContentPage(r.url));

  const moves = competitorDomains.map(domain => ({
    domain,
    newRows: contentRows(newStmt, domain, project, cutoff),
    changedRows: contentRows(changedStmt, domain, project, cutoff, cutoff),
  }));

  // What the target and owned sites already have, to subtract from what the
  // competitors just added. LOWER in SQL and no trim, as the CLI read it (the
  // header's Gaps names the two misses this leaves).
  const ownKeywords = new Set(db.prepare(`
    SELECT DISTINCT LOWER(k.keyword) AS keyword
    FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
  `).all(project).map(r => r.keyword));

  const ownSchema = new Set();
  const ownSchemaRows = db.prepare(`
    SELECT DISTINCT e.schema_types
    FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
      AND e.schema_types IS NOT NULL AND e.schema_types != '[]'
  `).all(project);
  for (const row of ownSchemaRows) for (const t of schemaTypes(row.schema_types)) ownSchema.add(t);

  const keywordsOf = db.prepare('SELECT keyword FROM keywords WHERE page_id = ? ORDER BY id');
  const schemaOf = db.prepare('SELECT schema_types FROM extractions WHERE page_id = ?');
  const gapKeywords = new Map();
  const gapSchema = new Map();
  for (const m of moves) {
    for (const row of m.newRows.slice(0, BOUNDS.gapPagesPerCompetitor)) {
      for (const { keyword } of keywordsOf.all(row.id)) {
        const key = normalizeKeyword(keyword);
        if (key.length < BOUNDS.minKeywordLength || ownKeywords.has(key)) continue;
        addDomain(gapKeywords, key, m.domain);
      }
      for (const type of schemaTypes(schemaOf.get(row.id)?.schema_types)) {
        if (!ownSchema.has(type)) addDomain(gapSchema, type, m.domain);
      }
    }
  }

  const keywordGaps = [...gapKeywords]
    .map(([keyword, domains]) => ({ keyword, domains: [...domains], count: domains.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, BOUNDS.keywordGapLimit);
  const schemaGaps = [...gapSchema].map(([schema, domains]) => ({ schema, domains: [...domains] }));

  const targetNewPages = targetDomain
    ? db.prepare(`
        SELECT COUNT(*) AS c FROM pages p JOIN domains d ON d.id = p.domain_id
        WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ?
      `).get(targetDomain, project, cutoff)?.c || 0
    : 0;

  const competitorMoves = moves.map(m => ({
    domain: m.domain,
    newPages: m.newRows.map(pageRef),
    changedPages: m.changedRows.map(pageRef),
  }));
  const ownMoves = ownDomains.map(domain => ({
    domain,
    newPages: contentRows(ownNewStmt, domain, project, cutoff).map(pageRef),
  }));

  return {
    period: { days, cutoff: isoDate(cutoff), weekOf: isoDate(now) },
    targetDomain,
    competitorMoves,
    ownMoves,
    keywordGaps,
    schemaGaps,
    targetNewPages,
    actions: briefActions({ keywordGaps, schemaGaps, competitorMoves, targetNewPages }),
  };
}

/** What run('brief') has always returned: the moves and the window, nothing derived. */
export function briefForHarness(result) {
  return {
    competitorMoves: result.competitorMoves,
    period: { days: result.period.days, weekOf: result.period.weekOf },
  };
}

/**
 * Publishing velocity. Returns
 *   period             { days, cutoff: ISO timestamp }
 *   velocities         [{ domain, role, total, newCount, pubCount, ratePerWeek }],
 *                      competitor, owned, target, then by domain
 *   recentlyPublished  [{ url, domain, role, publishedDate, wordCount }], latest date first
 *   newPages           [{ url, domain, role, firstSeen, wordCount }], newest first
 *   leader             the competitor entry with the highest rate (first by
 *                      domain on a tie), or null
 *   target             the target's entry, or null
 * The harness contract is velocityForHarness(result); the CLI's JSON is every
 * field but leader and target.
 *
 * opts.days (default 30), opts.now (ms or Date; default Date.now()).
 */
export function getPublishingVelocity(db, project, opts = {}) {
  const days = windowDays(opts.days, DEFAULTS.velocityDays);
  const now = nowMs(opts.now);
  const cutoff = now - days * DAY_MS;

  const newRows = db.prepare(`
    SELECT d.domain, d.role, p.url, p.first_seen_at, p.word_count
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
    ORDER BY p.first_seen_at DESC, p.id ASC
  `).all(project, cutoff).filter(r => isContentPage(r.url));

  const publishedRows = db.prepare(`
    SELECT d.domain, d.role, p.url, p.published_date, p.word_count
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.published_date IS NOT NULL AND p.published_date > ?
      AND p.is_indexable = 1
    ORDER BY p.published_date DESC, p.id ASC
  `).all(project, isoDate(cutoff)).filter(r => isContentPage(r.url));

  const totals = db.prepare(`
    SELECT d.domain, d.role, COUNT(*) AS total_pages
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.is_indexable = 1
    GROUP BY d.domain
    ORDER BY d.role, d.domain
  `).all(project);

  const countByDomain = rows => {
    const counts = new Map();
    for (const r of rows) counts.set(r.domain, (counts.get(r.domain) || 0) + 1);
    return counts;
  };
  const newCounts = countByDomain(newRows);
  const pubCounts = countByDomain(publishedRows);

  const velocities = totals.map(t => {
    const newCount = newCounts.get(t.domain) || 0;
    const pubCount = pubCounts.get(t.domain) || 0;
    return {
      domain: t.domain, role: t.role, total: t.total_pages, newCount, pubCount,
      ratePerWeek: ratePerWeek(Math.max(newCount, pubCount), days),
    };
  });

  let leader = null;
  for (const v of velocities) {
    if (v.role === 'competitor' && (!leader || v.ratePerWeek > leader.ratePerWeek)) leader = v;
  }

  return {
    period: { days, cutoff: new Date(cutoff).toISOString() },
    velocities,
    recentlyPublished: publishedRows.map(r => ({
      url: r.url, domain: r.domain, role: r.role, publishedDate: r.published_date, wordCount: r.word_count,
    })),
    newPages: newRows.map(r => ({
      url: r.url, domain: r.domain, role: r.role, firstSeen: r.first_seen_at, wordCount: r.word_count,
    })),
    leader,
    target: velocities.find(v => v.role === 'target') || null,
  };
}

/**
 * What run('velocity') has always returned: per-domain totals under the
 * harness's field names (totalPages, newPages as a count) and the window.
 * The rate and the order are the CLI's.
 */
export function velocityForHarness(result) {
  return {
    velocities: result.velocities.map(v => ({
      domain: v.domain, role: v.role, totalPages: v.total, newPages: v.newCount, ratePerWeek: v.ratePerWeek,
    })),
    period: result.period,
  };
}
