/**
 * lib/problems.js — Unified Problems list.
 *
 * Aggregates problem-shaped findings from every source in the DB (technical
 * audit, citability scores, orphan analysis, schema gaps, intelligence
 * ledger, Search Console URL Inspection verdicts) into a single
 * severity-sorted list with everything an AI coding agent needs to fix it:
 * affected_urls, fix_template, verification.
 *
 * This is the canonical "what should I work on?" surface — backs both the
 * MCP `list_problems` tool and the upcoming dashboard Problems tab.
 *
 * Each problem returns:
 *   {
 *     id, severity, category, tier, title, description, affected_urls,
 *     evidence, fix_template, verification, first_seen, last_seen,
 *     fix_difficulty,
 *     source: { kind, model, prompt_version, rule_version, confidence }
 *   }
 *
 * severity is always one of critical | warn | info, whatever the source used.
 *
 * source is provenance: who found this, and how far to trust it before acting.
 *   kind            'rule'  — a detector over crawl, extraction or Search
 *                             Console data. Deterministic: run it again on the
 *                             same data and it says the same thing.
 *                   'model' — an LLM synthesis (competitor gaps, positioning).
 *                   'agent' — written into the ledger by an agent.
 *   model           model id behind a model/agent finding, else null.
 *   prompt_version  version tag of the prompt (model findings), else null.
 *   rule_version    version tag of the detector (rule findings), else null.
 *   confidence      0..1. Rules write 1; models and agents write what they
 *                   were given, null when unknown.
 *
 * Every problem carries one, whatever produced it, because the review's
 * safe_now bucket admits rule findings only: a model's technical_gap with a
 * fix template reads exactly like a crawl finding until you ask where it came
 * from. Crawl-derived collectors write RULE_SOURCE; insight-derived problems
 * copy the ledger row's provenance columns and fall back to the type
 * registry's defaults where a column is NULL (rows older than the columns).
 */

import crypto from 'node:crypto';
import { PROBLEM_INSIGHT_TYPES, insightMeta } from './insight-types.js';
import { normalizeUrlKey } from './gsc-import.js';

export const PROBLEM_CATEGORIES = ['tech', 'indexability', 'links', 'schema', 'citability', 'content', 'keyword', 'positioning'];
export const FREE_CATEGORIES = ['tech', 'indexability', 'links', 'schema'];
export const PAID_CATEGORIES = ['citability', 'content', 'keyword', 'positioning'];
export const PROBLEM_STATUSES = ['fixed', 'wont_fix', 'snoozed'];

/**
 * Provenance of a problem a detector found in the data. Shared by every
 * crawl-derived collector below, and by anything else that computes a finding
 * deterministically. rule_version is the detectors' collective version tag:
 * bump it when a collector's logic changes in a way that should be told apart
 * from the previous one in stored findings.
 */
export const RULE_SOURCE = Object.freeze({ kind: 'rule', rule_version: '1', confidence: 1, model: null, prompt_version: null });

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };

/**
 * Map any severity onto the public vocabulary (critical | warn | info).
 *
 * The audits that feed the ledger speak 'error' | 'warning' | 'notice', and the
 * type registry once declared schema_specificity as 'error'. Copied straight
 * onto a problem, such a value has no rank: the sort comparator returned NaN
 * and the order of the whole list became unstable. 'error' is the one legacy
 * spelling with a clear meaning; anything else unknown is treated as 'warn'
 * so it is neither hidden nor promoted.
 */
export function normalizeSeverity(severity) {
  if (severity === 'error') return 'critical';
  return Object.hasOwn(SEVERITY_RANK, severity) ? severity : 'warn';
}

// Rank for sorting. Unknown severities rank as warn rather than undefined,
// which would turn the comparator's subtraction into NaN. Own keys only, so an
// inherited name such as 'constructor' cannot pass as a rank either.
const severityRank = s => Object.hasOwn(SEVERITY_RANK, s) ? SEVERITY_RANK[s] : SEVERITY_RANK.warn;

/**
 * Persist a problem-status mark. Same problem_id → upserts.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ problemId: string, project: string, status: string, markedBy?: string, note?: string, snoozeDays?: number }} args
 * @returns {{ ok: boolean, error?: string, status?: string, expires_at?: number }}
 */
export function markProblemStatus(db, { problemId, project, status, markedBy, note, snoozeDays }) {
  if (!PROBLEM_STATUSES.includes(status)) {
    return { ok: false, error: `Unknown status "${status}". Allowed: ${PROBLEM_STATUSES.join(', ')}` };
  }
  if (!problemId || !project) return { ok: false, error: 'problemId and project are required' };
  if (status === 'snoozed' && (!snoozeDays || snoozeDays <= 0)) {
    return { ok: false, error: 'snoozeDays (positive integer) is required when status=snoozed' };
  }
  const now = Date.now();
  const expiresAt = status === 'snoozed' ? now + snoozeDays * 86_400_000 : null;
  db.prepare(`
    INSERT INTO problem_status (problem_id, project, status, marked_at, marked_by, note, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(problem_id) DO UPDATE SET
      status = excluded.status,
      marked_at = excluded.marked_at,
      marked_by = excluded.marked_by,
      note = excluded.note,
      expires_at = excluded.expires_at
  `).run(problemId, project, status, now, markedBy || null, note || null, expiresAt);
  return { ok: true, status, marked_at: now, expires_at: expiresAt };
}

/**
 * Read all active status marks for a project. "Active" = not expired.
 * Used internally by getProblems to filter; also exposed via MCP for inspection.
 *
 * @returns {Map<string, { status, marked_at, marked_by, note, expires_at }>}
 */
export function getActiveStatusMap(db, project) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT problem_id, status, marked_at, marked_by, note, expires_at
    FROM problem_status
    WHERE project = ? AND (expires_at IS NULL OR expires_at > ?)
  `).all(project, now);
  return new Map(rows.map(r => [r.problem_id, r]));
}

function shortHash(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 10);
}

function makeId(category, kind, key) {
  return `${category}::${kind}::${shortHash(key)}`;
}

// ── Collectors (each returns Problem[]) ─────────────────────────────────────

// 1. HTTP errors on target/owned pages — broken pages, critical
function collectHttpErrors(db, project) {
  const rows = db.prepare(`
    SELECT p.url, p.status_code, p.crawled_at, p.first_seen_at, d.domain, d.role
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
      AND p.status_code >= 400 AND p.status_code < 600
    ORDER BY p.status_code, p.url
  `).all(project);
  return rows.map(r => ({
    id: makeId('tech', `http-${r.status_code}`, r.url),
    severity: 'critical',
    category: 'tech',
    tier: 'free',
    title: `${r.status_code} on ${shortPath(r.url)}`,
    description: `Page returns HTTP ${r.status_code}. Search engines and AI crawlers will drop this URL.`,
    affected_urls: [r.url],
    evidence: { status_code: r.status_code, domain: r.domain, role: r.role },
    fix_template: r.status_code === 404
      ? `Either restore the page at \`${r.url}\` or add a 301 redirect to its replacement. Check internal links pointing here via \`get_pages\` and update them.`
      : `Investigate why \`${r.url}\` returns ${r.status_code}. Server error, auth wall, or rate-limit. Restore 200 status or redirect.`,
    verification: `Re-crawl with \`run_crawl(${project})\`, then re-run \`list_problems\` — this entry should disappear.`,
    first_seen: r.first_seen_at || r.crawled_at,
    last_seen: r.crawled_at,
    fix_difficulty: r.status_code === 404 ? 2 : 4,
    source: RULE_SOURCE,
  }));
}

// 2. Indexability — pages marked noindex via x_robots_tag header but indexable=1 in meta (conflict)
//    OR pages explicitly noindex that have backlinks (wasted authority)
function collectIndexabilityIssues(db, project) {
  const xRobotsNoindex = db.prepare(`
    SELECT p.url, p.x_robots_tag, p.is_indexable, p.crawled_at, p.first_seen_at, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
      AND p.x_robots_tag IS NOT NULL
      AND lower(p.x_robots_tag) LIKE '%noindex%'
      AND p.is_indexable = 1
  `).all(project);

  const out = [];
  for (const r of xRobotsNoindex) {
    out.push({
      id: makeId('indexability', 'robots-conflict', r.url),
      severity: 'warn',
      category: 'indexability',
      tier: 'free',
      title: `Robots header conflict on ${shortPath(r.url)}`,
      description: `X-Robots-Tag header says noindex but the meta robots tag allows indexing. Search engines will follow the header — page won't be indexed.`,
      affected_urls: [r.url],
      evidence: { x_robots_tag: r.x_robots_tag, is_indexable_meta: !!r.is_indexable },
      fix_template: `Decide which is canonical. Either remove \`X-Robots-Tag: noindex\` from the server response, or set \`<meta name="robots" content="noindex">\` so both agree. Check Cloudflare/nginx config if the header is unexpected.`,
      verification: `Re-crawl and confirm \`x_robots_tag\` no longer contains noindex via \`get_pages\`.`,
      first_seen: r.first_seen_at || r.crawled_at,
      last_seen: r.crawled_at,
      fix_difficulty: 3,
      source: RULE_SOURCE,
    });
  }
  return out;
}

// 2b. Index status — Google's own verdict on target/owned pages, from the URL
//     Inspection rows `seo-intel gsc-inspect` stores in gsc_inspections.
//
// The crawl can only say whether a page LOOKS indexable; Search Console says
// whether Google indexed it. The two disagree in ways no crawl can see: a
// noindex added by a CDN or at render time, a canonical Google chose for
// itself, a page crawled and judged too thin to keep. Two findings come out:
//
//   not-indexed         verdict FAIL or NEUTRAL on a page the crawl calls
//                       indexable (crawlSaysIndexable: is_indexable = 1,
//                       status 200). On any other page the verdict is not
//                       Google's news but the crawl's own finding in Google's
//                       words: NEUTRAL or FAIL "Submitted URL marked 'noindex'"
//                       on a noindex page is the site's intent, which the
//                       review reports as a pass, and FAIL "Not found (404)"
//                       on a 404 is the entry collectHttpErrors already lists.
//                       Reporting those again as "a noindex the crawl did not
//                       see" would send an agent to fix what the site chose.
//                       Critical when the URL is in the sitemap — the site
//                       asked for indexing and did not get it.
//   canonical-mismatch  PASS or PARTIAL where Google's canonical is another
//                       URL: indexed, but under a different address.
//
// Verdicts a fix cannot change are not findings: VERDICT_UNSPECIFIED says the
// API had nothing to say, and PASS with the same canonical is the pass the
// review reports.

/**
 * Whether the crawl calls a page a live candidate for the index: status 200
 * and no noindex it could see. The one predicate both Search Console surfaces
 * share — the not-indexed finding here and the review's indexed_by_google pass
 * — so no page can count for one and not the other. The crawler writes
 * is_indexable as 0 or 1; a row without it (hand-inserted, or older than the
 * column) is not called indexable.
 */
export function crawlSaysIndexable(page) {
  return Number(page?.is_indexable) === 1 && page?.status_code === 200;
}

/**
 * URL Inspection rows joined to the crawled target/owned page each describes,
 * newest inspection first, one row per page. [] on a database that predates
 * gsc_inspections, which is the same state as "nothing inspected yet".
 *
 * The join runs in JS on normalizeUrlKey rather than by exact URL in SQL.
 * Google hands back its own spelling of a URL — the canonical it chose can
 * differ from the crawled one in scheme, www and trailing slash, the same
 * reconciliation gsc-import and page-contract already do for Search Analytics
 * rows — and a missed join here fails silently as "no problem", which is the
 * wrong direction to fail. An exact match is tried first so that two crawled
 * pages sharing a key (query-string variants) resolve to the right one. The
 * inspection set is bounded by Google's quota (2,000 a day), so holding both
 * sides in memory costs nothing the other collectors do not already pay.
 *
 * Only inspections of crawled pages come back. An inspected URL the crawl never
 * reached has no is_indexable or status to compare against, and is as likely
 * a stale sitemap entry Google is right to drop as a page that matters.
 *
 * @returns {Array<object & { page: { url, status_code, is_indexable, crawled_at }, in_sitemap: boolean }>}
 */
export function getInspectedPages(db, project) {
  let inspections = [];
  try {
    inspections = db.prepare(`
      SELECT url, inspected_at, verdict, coverage_state, robots_txt_state, indexing_state,
             page_fetch_state, last_crawl_time, crawled_as, google_canonical, user_canonical
      FROM gsc_inspections
      WHERE project = ?
      ORDER BY inspected_at DESC, id DESC
    `).all(project);
  } catch { return []; }
  if (!inspections.length) return [];

  const pages = db.prepare(`
    SELECT p.url, p.status_code, p.is_indexable, p.crawled_at
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
  `).all(project);
  const byUrl = new Map(pages.map(p => [p.url, p]));
  const byKey = new Map();
  for (const p of pages) {
    const k = normalizeUrlKey(p.url);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  const sitemap = sitemapKeys(db, project);

  const out = [];
  const seen = new Set();
  for (const r of inspections) {
    const page = byUrl.get(r.url) || byKey.get(normalizeUrlKey(r.url));
    // Two spellings of one page: the newer inspection supersedes, as the
    // table's own upsert does for one spelling.
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    out.push({
      ...r,
      page,
      in_sitemap: sitemap.has(normalizeUrlKey(r.url)) || sitemap.has(normalizeUrlKey(page.url)),
    });
  }
  return out;
}

/** Sitemap URLs of the target/owned domains as comparison keys; empty before v1.5.23's table. */
function sitemapKeys(db, project) {
  try {
    const rows = db.prepare(`
      SELECT s.url FROM sitemap_urls s JOIN domains d ON d.id = s.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned')
    `).all(project);
    return new Set(rows.map(r => normalizeUrlKey(r.url)));
  } catch { return new Set(); }
}

/**
 * Comparison key for a canonical decision: normalizeUrlKey plus the query
 * string. normalizeUrlKey folds scheme, www and the trailing slash, which is
 * right for joining Google's spelling of a URL to the crawled one — but it
 * folds the query string too, and `?sort=price` against the bare path is the
 * commonest canonical Google chooses: the sorted, faceted or UTM variant is
 * indexed under the plain URL. Compared on the join key alone, that read as
 * "no problem", which is the wrong direction to fail.
 */
function canonicalKey(url) {
  try { return normalizeUrlKey(url) + new URL(url).search; } catch { return normalizeUrlKey(url); }
}

/** Whether Google indexed the page under a different URL than the one inspected. */
function canonicalDiffers(row) {
  return Boolean(row.google_canonical) && canonicalKey(row.google_canonical) !== canonicalKey(row.url);
}

/**
 * The family a not-indexed verdict belongs to, which decides the fix. PURE.
 *
 * Google's coverageState is prose ("Crawled - currently not indexed"), so the
 * families match on case-insensitive substrings of it, backed by the enum
 * fields for the cases where the prose is less explicit than the state
 * (indexingState BLOCKED_BY_HTTP_HEADER, robotsTxtState DISALLOWED). The
 * mechanical causes are tested first: a page both blocked and thin is fixed
 * by unblocking it, and a page whose canonical Google moved is a duplicate
 * whatever the prose says.
 *
 * @returns {'noindex'|'robots'|'not_found'|'redirect'|'duplicate'|'discovered'|'crawled'|'unknown'}
 */
export function coverageFamily(row) {
  const state = String(row.coverage_state || '').toLowerCase();
  const says = (...needles) => needles.some(n => state.includes(n));
  if (says('noindex') || ['BLOCKED_BY_META_TAG', 'BLOCKED_BY_HTTP_HEADER'].includes(row.indexing_state)) return 'noindex';
  if (says('robots.txt') || row.robots_txt_state === 'DISALLOWED'
    || row.indexing_state === 'BLOCKED_BY_ROBOTS_TXT' || row.page_fetch_state === 'BLOCKED_ROBOTS_TXT') return 'robots';
  if (says('soft 404', 'not found') || ['SOFT_404', 'NOT_FOUND'].includes(row.page_fetch_state)) return 'not_found';
  if (says('redirect') || row.page_fetch_state === 'REDIRECT_ERROR') return 'redirect';
  if (says('duplicate', 'canonical') || canonicalDiffers(row)) return 'duplicate';
  if (says('discovered')) return 'discovered';
  if (says('crawled') && says('currently not indexed')) return 'crawled';
  return 'unknown';
}

// Fix per family. Difficulty follows the kind of work: a directive or a
// robots rule is a one-line change (2), a canonical decision touches several
// places (3), content Google judged too thin is a writing job (4).
const INDEX_STATUS_FIXES = {
  noindex: {
    difficulty: 2,
    fix: (url) => `A noindex reaches Google that the crawl did not see: an \`X-Robots-Tag\` header, a CDN or edge rule, or a robots meta tag added at render time. Fetch \`${url}\` as Googlebot, check the response headers and the rendered HTML, and remove the directive. If the page is meant to stay out of search, put noindex in the HTML too so the crawl and Google agree.`,
  },
  robots: {
    difficulty: 2,
    fix: (url) => `robots.txt disallows \`${url}\` for Googlebot. Allow the path in robots.txt — look for a broad \`Disallow\` that catches it — then request indexing.`,
  },
  not_found: {
    difficulty: 3,
    fix: (url) => `Google receives too little, or a 404, from \`${url}\` while the crawl saw a page. Fetch it as Googlebot and compare. Either restore the content Google is missing, or 301 the URL to the page that replaced it and drop it from the sitemap.`,
  },
  redirect: {
    difficulty: 3,
    fix: (url) => `Google sees a redirect at \`${url}\` where the crawl saw a 200 — often a redirect keyed on user agent, geography or cookies. Follow the chain as Googlebot, fix the redirect, and make rel=canonical and the sitemap point at the URL that actually serves the page.`,
  },
  duplicate: {
    difficulty: 3,
    fix: (url, row) => `Google treats \`${url}\` as a duplicate${row.google_canonical ? ` and indexes \`${row.google_canonical}\` instead` : ''}. Decide which URL is the canonical one, then make rel=canonical, internal links and the sitemap all agree on it. If this page should stand on its own, make its content distinct first.`,
  },
  discovered: {
    difficulty: 3,
    fix: (url) => `Google knows \`${url}\` exists but has not crawled it: a crawl-priority problem, not a content one. Link it from the homepage or a hub page so it sits within a click or two, and keep it in the sitemap.`,
  },
  crawled: {
    difficulty: 4,
    fix: (url) => `Google crawled \`${url}\` and chose not to keep it: the content reads as thin or duplicate to Google. Strengthen what is unique on the page (a direct answer, specifics no other page carries), add internal links to it from strong pages, then request indexing in Search Console.`,
  },
  unknown: {
    difficulty: 3,
    fix: (url) => `Inspect \`${url}\` in Search Console (URL Inspection) to see why Google has not indexed it, fix the cause, then request indexing.`,
  },
};

function inspectVerification(project, url) {
  return `Fix, then \`seo-intel gsc-inspect ${project} --url ${url}\` (or the MCP \`inspect_urls\` tool) and confirm verdict PASS; then re-run \`list_problems\`.`;
}

// Ids key on the crawled page's URL, not the inspection's spelling. Two
// inspections of one page can arrive under different spellings (the crawled
// one, then Google's canonical with www or a trailing slash); the newer wins
// the join, and an id that followed the spelling would change with it,
// orphaning any problem_status mark on the old one. affected_urls keeps the
// inspected spelling: that is the URL Google was asked about.
function collectIndexStatusIssues(db, project) {
  const out = [];
  for (const r of getInspectedPages(db, project)) {
    // On any other page the verdict restates what the crawl already found;
    // see the header above.
    if (!crawlSaysIndexable(r.page)) continue;
    if (r.verdict === 'FAIL' || r.verdict === 'NEUTRAL') {
      const family = coverageFamily(r);
      const template = INDEX_STATUS_FIXES[family];
      const state = r.coverage_state || r.verdict;
      out.push({
        id: makeId('indexability', 'not-indexed', r.page.url),
        severity: r.in_sitemap ? 'critical' : 'warn',
        category: 'indexability',
        tier: 'free',
        title: `Not indexed: ${shortPath(r.url)} — ${state}`,
        description: `Search Console reports "${state}" (verdict ${r.verdict}${r.last_crawl_time ? `, last crawled by Google ${r.last_crawl_time}` : ', never crawled by Google'}). The crawl sees an indexable page returning 200.${r.in_sitemap ? ' The URL is submitted in the sitemap, so the site asked for indexing and did not get it.' : ''}`,
        affected_urls: [r.url],
        evidence: {
          verdict: r.verdict,
          coverage_state: r.coverage_state ?? null,
          indexing_state: r.indexing_state ?? null,
          robots_txt_state: r.robots_txt_state ?? null,
          page_fetch_state: r.page_fetch_state ?? null,
          last_crawl_time: r.last_crawl_time ?? null,
          in_sitemap: r.in_sitemap,
        },
        fix_template: template.fix(r.url, r),
        verification: inspectVerification(project, r.url),
        first_seen: r.inspected_at,
        last_seen: r.inspected_at,
        fix_difficulty: template.difficulty,
        source: RULE_SOURCE,
      });
    } else if ((r.verdict === 'PASS' || r.verdict === 'PARTIAL') && canonicalDiffers(r)) {
      out.push({
        id: makeId('indexability', 'canonical-mismatch', r.page.url),
        severity: 'warn',
        category: 'indexability',
        tier: 'free',
        title: `Google chose a different canonical for ${shortPath(r.url)}`,
        description: `URL Inspection says this page is indexed, but under \`${r.google_canonical}\`: Google chose that URL as the canonical${r.user_canonical ? ` (the page declares \`${r.user_canonical}\`)` : ' (the page declares none)'}. Clicks and impressions for the content accrue to the canonical, not to this URL.`,
        affected_urls: [r.url],
        evidence: {
          verdict: r.verdict,
          coverage_state: r.coverage_state ?? null,
          google_canonical: r.google_canonical,
          user_canonical: r.user_canonical ?? null,
          last_crawl_time: r.last_crawl_time ?? null,
        },
        fix_template: `If \`${r.google_canonical}\` is the URL you want indexed, point this page's rel=canonical at it and stop linking to \`${r.url}\` internally. If it is not, make this page's content distinct, add a rel=canonical to \`${r.url}\` itself, and consolidate internal links on it so Google's choice follows yours.`,
        verification: inspectVerification(project, r.url),
        first_seen: r.inspected_at,
        last_seen: r.inspected_at,
        fix_difficulty: 3,
        source: RULE_SOURCE,
      });
    }
  }
  return out;
}

// 3. Orphan pages — target/owned pages on the site with no incoming internal links
function collectOrphans(db, project) {
  const rows = db.prepare(`
    SELECT p.url, p.crawled_at, p.first_seen_at, p.click_depth, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
      AND p.status_code = 200
      AND p.click_depth > 0
      AND p.url NOT IN (
        SELECT DISTINCT l.target_url FROM links l
        JOIN pages sp ON sp.id = l.source_id
        JOIN domains sd ON sd.id = sp.domain_id
        WHERE sd.project = ? AND l.is_internal = 1
      )
    ORDER BY p.click_depth, p.url
    LIMIT 200
  `).all(project, project);
  return rows.map(r => ({
    id: makeId('links', 'orphan', r.url),
    severity: 'warn',
    category: 'links',
    tier: 'free',
    title: `Orphan: ${shortPath(r.url)}`,
    description: `No internal links point to this page. Search engines can only find it via sitemap; AI agents won't surface it.`,
    affected_urls: [r.url],
    evidence: { click_depth: r.click_depth, domain: r.domain },
    fix_template: `Find 2–3 thematically related pages and add internal links to \`${r.url}\` from them. Use anchor text matching the page's primary keyword. Call \`get_pages(${project})\` to find candidates by topic, or \`list_keywords(${project})\` to find pages targeting overlapping keywords.`,
    verification: `Re-crawl, then re-run \`list_problems\` — the orphan entry should be gone once any incoming link exists.`,
    first_seen: r.first_seen_at || r.crawled_at,
    last_seen: r.crawled_at,
    fix_difficulty: 2,
    source: RULE_SOURCE,
  }));
}

// 4. Schema coverage gaps — target pages missing schema where competitors have it
function collectSchemaGaps(db, project) {
  // Per-page: target pages with no page_schemas entries
  const rows = db.prepare(`
    SELECT p.url, p.title, p.word_count, p.crawled_at, p.first_seen_at, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
      AND p.status_code = 200 AND p.word_count >= 300
      AND p.id NOT IN (SELECT DISTINCT page_id FROM page_schemas)
    ORDER BY p.word_count DESC
    LIMIT 50
  `).all(project);
  return rows.map(r => ({
    id: makeId('schema', 'missing', r.url),
    severity: 'info',
    category: 'schema',
    tier: 'free',
    title: `No schema on ${shortPath(r.url)}`,
    description: `Substantive page (${r.word_count} words) ships zero structured-data markup. AI engines and rich-results lose out.`,
    affected_urls: [r.url],
    evidence: { word_count: r.word_count, title: r.title },
    fix_template: `Add JSON-LD schema appropriate to the page type. Article / BlogPosting / Product / FAQPage / Organization are the common ones. Use \`get_headings(${project}, '${r.url}')\` to inspect the page structure first. Keep it short — 5–10 fields is enough.`,
    verification: `Re-crawl, then \`get_intel(${project}, for=raw)\` should show schema count increment.`,
    first_seen: r.first_seen_at || r.crawled_at,
    last_seen: r.crawled_at,
    fix_difficulty: 2,
    source: RULE_SOURCE,
  }));
}

// 5. PAID — low-citability pages (AEO score < 40 in citability_scores table)
//
// A citability score is a rule finding, not a model's opinion: the AEO scorer
// computes it from the crawl and the extraction (entity mentions, structured
// claims, answer density, schema) with fixed weights, so the same page scores
// the same twice. The number is a judgment of the page, but a mechanical one.
function collectCitabilityGaps(db, project) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT cs.url, cs.score, cs.tier, cs.entity_authority, cs.structured_claims,
             cs.answer_density, cs.qa_proximity, cs.freshness, cs.schema_coverage,
             cs.scored_at, p.title, p.word_count, d.role
      FROM citability_scores cs
      JOIN pages p ON p.id = cs.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned') AND cs.score < 60
      ORDER BY cs.score ASC
      LIMIT 100
    `).all(project);
  } catch { /* citability_scores may not exist if AEO never run */ }
  return rows.map(r => ({
    id: makeId('citability', 'low-score', r.url),
    severity: r.score < 30 ? 'critical' : r.score < 45 ? 'warn' : 'info',
    category: 'citability',
    tier: 'paid',
    title: `Citability ${r.score}/100 on ${shortPath(r.url)}`,
    description: `Page scores poorly for AI citability. Weak: ${weakestSignals(r)}.`,
    affected_urls: [r.url],
    evidence: {
      score: r.score, tier: r.tier,
      signals: {
        entity_authority: r.entity_authority,
        structured_claims: r.structured_claims,
        answer_density: r.answer_density,
        qa_proximity: r.qa_proximity,
        freshness: r.freshness,
        schema_coverage: r.schema_coverage,
      },
      word_count: r.word_count,
    },
    fix_template: citabilityFix(r),
    verification: `Re-crawl, run \`run_citability_audit(${project})\`, then \`list_problems\` — score should rise.`,
    first_seen: r.scored_at,
    last_seen: r.scored_at,
    fix_difficulty: 3,
    source: RULE_SOURCE,
  }));
}

// 6. Intelligence Ledger insights mapped to problems.
//
// Types come from the registry rather than a literal list, and each one carries
// its own tier: competitor synthesis stays paid, own-site findings (citability,
// entity, triangulation, retrieval, platform, schema) are free. The previous
// hardcoded IN clause named four types and marked every result paid, which is
// why own-site insights never reached an agent through list_problems.
//
// Two reads, because the provenance columns (source_kind, model, prompt_version,
// rule_version, confidence, expires_at) arrived after the table did. The wide
// read is tried first; on a database that predates the columns it throws, and
// the narrow read serves the same rows with provenance unknown, which
// insightSource resolves to the registry's defaults. Only the wide read can
// filter on expires_at: a model finding past its expiry is stale advice even
// while its status still says active — whatever flips it to 'expired' runs on
// its own schedule, and this list must not depend on that having happened.
function collectInsightProblems(db, project) {
  const placeholders = PROBLEM_INSIGHT_TYPES.map(() => '?').join(', ');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, type, fingerprint, first_seen, last_seen, data, source,
             source_kind, model, prompt_version, rule_version, confidence, expires_at
      FROM insights
      WHERE project = ? AND status = 'active'
        AND type IN (${placeholders})
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY last_seen DESC
      LIMIT 100
    `).all(project, ...PROBLEM_INSIGHT_TYPES, Date.now());
  } catch {
    try {
      rows = db.prepare(`
        SELECT id, type, fingerprint, first_seen, last_seen, data, source
        FROM insights
        WHERE project = ? AND status = 'active'
          AND type IN (${placeholders})
        ORDER BY last_seen DESC
        LIMIT 100
      `).all(project, ...PROBLEM_INSIGHT_TYPES);
    } catch { return []; }
  }
  return rows.map(r => {
    const data = safeParse(r.data);
    const typeMeta = insightMeta(r.type);
    const titleHint = typeMeta.title(data) || `Insight ${r.id}`;
    return {
      id: makeId(typeMeta.category, r.type, r.fingerprint),
      severity: normalizeSeverity(typeMeta.severity),
      category: typeMeta.category,
      tier: typeMeta.scope === 'own-site' ? 'free' : 'paid',
      title: `${typeMeta.label}: ${titleHint}`,
      description: typeMeta.detail(data) || `Active insight in the Intelligence Ledger (type=${r.type}).`,
      // `pages` is a URL list for some types and a page COUNT for others (backlink_gap),
      // so only an actual list may become affected_urls — the documented shape is an array.
      affected_urls: typeMeta.url(data) ? [typeMeta.url(data)] : (Array.isArray(data?.pages) ? data.pages : []),
      evidence: { insight_id: r.id, source: r.source, ...data },
      fix_template: typeMeta.fix(data) || `Address this ${r.type} via blog draft, page update, or content fix. Use \`draft_blog_prompt(${project}, topic='${titleHint}')\` for an AEO-aware draft prompt.`,
      verification: `After the fix, call \`mark_problem_status('${makeId(typeMeta.category, r.type, r.fingerprint)}', 'fixed')\` (coming in v1.5.35) or wait for the next analyze run to clear it.`,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      fix_difficulty: typeMeta.difficulty,
      source: insightSource(r, typeMeta),
    };
  });
}

/**
 * Provenance of an insight-derived problem. PURE.
 *
 * The row's columns win when present; the registry's per-type defaults fill
 * what is NULL. A NULL column means one of two things — a row written before
 * the columns existed, or the narrow read above on a table that lacks them —
 * and in both the type is the best remaining evidence of who found it: a
 * keyword_gap was always a model's, a schema_specificity always a detector's.
 * The registry may itself predate the sourceKind/ruleVersion fields, so those
 * carry the registry's own documented fallback ('rule', '1'). A rule that
 * cannot say its version is version 1; a model with no recorded confidence is
 * null, never 1 — a made-up certainty is what this whole field exists to
 * prevent.
 *
 * @param {{ source_kind?: string, model?: string, prompt_version?: string, rule_version?: string, confidence?: number }} row
 * @param {ReturnType<typeof insightMeta>} meta
 * @returns {{ kind: string, model: string|null, prompt_version: string|null, rule_version: string|null, confidence: number|null }}
 */
export function insightSource(row, meta) {
  const kind = row?.source_kind || meta?.sourceKind || 'rule';
  const isRule = kind === 'rule';
  return {
    kind,
    model: row?.model ?? null,
    prompt_version: row?.prompt_version ?? null,
    rule_version: row?.rule_version ?? (isRule ? (meta?.ruleVersion || '1') : null),
    confidence: row?.confidence ?? (isRule ? 1 : null),
  };
}

// ── Aggregator ─────────────────────────────────────────────────────────────

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ severity?: string, category?: string, limit?: number, includePaid?: boolean, maxFixDifficulty?: number, includeMarked?: boolean }} opts
 * @returns {object[]}
 */
export function getProblems(db, project, opts = {}) {
  const all = [
    ...collectHttpErrors(db, project),
    ...collectIndexabilityIssues(db, project),
    ...collectIndexStatusIssues(db, project),
    ...collectOrphans(db, project),
    ...collectSchemaGaps(db, project),
  ];
  // Own-site Ledger findings are free, matching the commands that produce them.
  // Competitor synthesis and history stay behind includePaid, as before — the
  // gate moved from "which collector runs" to "what tier the type declares".
  const insightProblems = collectInsightProblems(db, project);
  all.push(...insightProblems.filter(p => p.tier === 'free'));
  if (opts.includePaid) {
    all.push(...collectCitabilityGaps(db, project));
    all.push(...insightProblems.filter(p => p.tier !== 'free'));
  }
  // Filter out problems marked fixed/wont_fix/snoozed (unless caller asks to see them).
  const statusMap = getActiveStatusMap(db, project);
  let filtered = all.flatMap(p => {
    const mark = statusMap.get(p.id);
    if (mark && !opts.includeMarked) return [];   // hide by default
    return [{ ...p, status: mark ? mark.status : 'active', status_mark: mark || null }];
  });
  if (opts.severity) filtered = filtered.filter(p => p.severity === opts.severity);
  if (opts.category) filtered = filtered.filter(p => p.category === opts.category);
  if (opts.maxFixDifficulty) filtered = filtered.filter(p => p.fix_difficulty <= opts.maxFixDifficulty);
  filtered.sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    a.fix_difficulty - b.fix_difficulty ||
    b.last_seen - a.last_seen
  );
  if (opts.limit) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

/**
 * Counts only — used by list_projects nag to surface "5 critical pending".
 * Free tier sees free-only counts so we don't tease paid data.
 */
export function getProblemCounts(db, project, { includePaid = false } = {}) {
  const problems = getProblems(db, project, { includePaid });
  const counts = { critical: 0, warn: 0, info: 0, total: problems.length, by_category: {} };
  for (const p of problems) {
    counts[p.severity]++;
    counts.by_category[p.category] = (counts.by_category[p.category] || 0) + 1;
  }
  return counts;
}

/**
 * Where a problem's evidence was observed: 'crawl' | 'aeo' | 'gsc'. The review
 * labels each evidence row with this, and only this module knows which
 * collector produced an id — citability scores come from the AEO audit, the
 * index-status findings from Search Console's URL Inspection, everything else
 * from the crawl.
 */
export function evidenceSourceOf(problem) {
  if (problem.category === 'citability') return 'aeo';
  const id = String(problem.id || '');
  if (id.startsWith('indexability::not-indexed::') || id.startsWith('indexability::canonical-mismatch::')) return 'gsc';
  return 'crawl';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortPath(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname + u.search + u.hash).slice(0, 60);
    return `${u.hostname}${p}`;
  } catch { return url.slice(0, 60); }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function weakestSignals(r) {
  const signals = [
    ['entity authority', r.entity_authority],
    ['structured claims', r.structured_claims],
    ['answer density', r.answer_density],
    ['Q&A proximity', r.qa_proximity],
    ['freshness', r.freshness],
    ['schema coverage', r.schema_coverage],
  ];
  return signals.sort((a, b) => a[1] - b[1]).slice(0, 2).map(s => s[0]).join(' + ');
}

function citabilityFix(r) {
  const fixes = [];
  if (r.entity_authority < 4)   fixes.push('cite 2–3 named experts/authoritative sources');
  if (r.structured_claims < 4)  fixes.push('add concrete numbers, dates, or measurable claims (e.g. "47ms latency")');
  if (r.answer_density < 4)     fixes.push('shorten paragraphs; one answer per heading');
  if (r.qa_proximity < 4)       fixes.push('add an FAQ section with `FAQPage` schema');
  if (r.freshness < 4)          fixes.push('update the publish date and add a brief "last updated" note');
  if (r.schema_coverage < 4)    fixes.push('add JSON-LD schema appropriate to the page type');
  return fixes.length
    ? `To raise score: ${fixes.join('; ')}.`
    : `Page just under threshold — minor improvements suffice. Use \`prescore_draft\` on a revised version to confirm before publishing.`;
}
