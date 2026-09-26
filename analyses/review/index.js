/**
 * analyses/review/index.js — Search Review.
 *
 * The `decide` phase. Everything else in the pipeline collects, extracts,
 * analyzes or verifies; nothing yet answers "so what do I do next?" in one
 * call. This does, by triaging existing findings into three buckets:
 *
 *   needs_input  — blocked on a human: missing evidence, or a judgment call
 *                  no detector can make. Never more than a handful.
 *   safe_now     — hygiene. Correctness, not investment. No judgment needed,
 *                  so an agent may act on these unattended.
 *   working      — checks that passed. The reassurance half of the review.
 *
 * This module owns no detection. It composes lib/problems.js (which already
 * calls itself the canonical "what should I work on?" surface) with
 * page-contract's per-URL decisions, and lifts that per-page
 * blocked/allowed split to the site level.
 *
 * One result, four renderers: the MCP `search_review` tool, the dashboard
 * card, `seo-intel review`, and the Hermes desktop pane (desktop/plugin.js
 * via dashboard/plugin_api.py).
 */

import { getProblems, getProblemCounts, FREE_CATEGORIES } from '../../lib/problems.js';
import { runPageContract } from '../page-contract/index.js';

// A crawl older than this is reported as stale: findings may describe a
// version of the page that no longer exists. Matches page-contract's caution.
const STALE_CRAWL_DAYS = 30;

// Categories whose fixes are mechanical — no human decision required.
const AUTONOMOUS_CATEGORIES = new Set(FREE_CATEGORIES);

// Growth bets, not hygiene. These are opportunities to weigh, never things
// "needing input" — filing 87 keyword gaps under needs_input destroys the one
// property that makes this surface worth having: that its top bucket is short.
const OPPORTUNITY_CATEGORIES = new Set(['keyword', 'content', 'positioning']);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ includePaid?: boolean, urls?: string[], limit?: number, windowDays?: number }} opts
 *   windowDays is handed through to each page contract's evidence window. It
 *   is a library option: `seo-intel review` and the search_review tool do not
 *   expose it yet, so nothing in the review text asks a caller to set it.
 */
export function runReview(db, project, opts = {}) {
  const { includePaid = false, urls = [], limit = 0, windowDays } = opts;

  const freshness = getFreshness(db, project);
  const problems = getProblems(db, project, { includePaid });

  const needs_input = [];
  const safe_now = [];
  const opportunities = [];

  for (const p of problems) {
    const item = toReviewItem(p, freshness);
    if (OPPORTUNITY_CATEGORIES.has(p.category)) opportunities.push(item);
    // Mechanical AND carries a fix_template: an agent may act unattended.
    else if (AUTONOMOUS_CATEGORIES.has(p.category) && p.fix_template) safe_now.push(item);
    // Hygiene with no template: correctness, but a person must choose the fix.
    else needs_input.push(item);
  }

  // Per-URL contracts contribute the evidence-gap half of needs_input: these
  // are blocks no crawl can clear, only Search Console data can.
  for (const url of urls) {
    const contract = runPageContract(db, project, url, { windowDays });
    for (const b of contract.blocked_recommendations) {
      needs_input.push({
        id: `contract::${b.action}::${url}`,
        title: `${url} — ${b.action.replace(/_/g, ' ')} is blocked`,
        severity: 'warn',
        category: 'evidence',
        decision: contract.decision,
        decision_basis: contract.decision_basis,
        safe_action: b.reason,
        blocked_by: b.unblocked_by,
        evidence: [{ source: 'gsc', url, observed: observedEvidence(contract.evidence) }],
      });
    }
    for (const a of contract.allowed_now) {
      if (!a.items.length) continue;
      safe_now.push({
        id: `contract::${a.action}::${url}`,
        title: `${url} — ${a.action.replace(/_/g, ' ')}`,
        severity: 'info', category: 'schema',
        decision: contract.decision, decision_basis: contract.decision_basis,
        safe_action: a.reason, blocked_by: null,
        evidence: a.items.map(i => ({ source: 'crawl', url, observed: i })),
      });
    }
  }

  return {
    project,
    scanned_at: Date.now(),
    freshness,
    needs_input: limit ? needs_input.slice(0, limit) : needs_input,
    safe_now: limit ? safe_now.slice(0, limit) : safe_now,
    opportunities: limit ? opportunities.slice(0, limit) : opportunities,
    working: getPassingChecks(db, project, freshness),
    counts: getProblemCounts(db, project, { includePaid }),
  };
}

/**
 * What Search Console showed for a contract's URL. "No rows" reads differently
 * by source and coverage: a complete API fetch covers every page, so its
 * silence is a measurement over the days it fetched; a fetch that stopped at
 * its row cap dropped the low-click pages, so its silence is a gap; an export
 * only covers what was exported, so its silence is a gap too. The window
 * printed is the fetched one — page-contract has already clamped it — so the
 * dates here never name a day nobody requested.
 */
function observedEvidence(evidence) {
  const w = evidence.window;
  const span = w ? `${w.start}..${w.end}` : '';
  const shortfall = w && w.days < w.requested_days ? ` (${w.days} of ${w.requested_days} days fetched)` : '';
  if (evidence.scope !== 'none') {
    return evidence.source === 'api' && evidence.truncated
      ? `Page-level evidence present (${evidence.scope} scope); totals are a floor — the fetch for ${span} hit its row cap.`
      : `Page-level evidence present (${evidence.scope} scope).`;
  }
  if (evidence.source === 'api' && w) {
    return evidence.coverage === 'complete'
      ? `Search Console reports no impressions for this URL in the ${span} window${shortfall}.`
      : `Search Console returned no rows for this URL in the ${span} window, but the fetch hit its row cap there and dropped the lowest-click pages, so this is a gap in the inputs, not a measurement.`;
  }
  return 'No page-filtered Search Console export covers this URL.';
}

/** Problem → ReviewItem. Keeps problems.js's own vocabulary; adds no new one. */
function toReviewItem(p, freshness) {
  const stale = freshness.state === 'stale'
    ? ` Crawl data is ${freshness.age_days} days old — re-crawl before acting.`
    : '';
  return {
    id: p.id,
    title: p.title,
    severity: p.severity,           // critical | warn | info
    category: p.category,
    decision: null,                 // problems are hygiene; contracts carry decisions
    decision_basis: [p.description + stale],
    safe_action: p.fix_template || p.description,
    blocked_by: null,
    verification: p.verification || null,
    fix_difficulty: p.fix_difficulty,
    status: p.status,
    evidence: (Array.isArray(p.affected_urls) ? p.affected_urls : []).map(url => ({
      source: p.category === 'citability' ? 'aeo' : 'crawl',
      url,
      observed: typeof p.evidence === 'object' ? JSON.stringify(p.evidence) : String(p.evidence ?? ''),
    })),
  };
}

function getFreshness(db, project) {
  const row = db.prepare(`
    SELECT MAX(p.crawled_at) AS crawled_at
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target','owned')
  `).get(project);
  if (!row?.crawled_at) return { state: 'missing', crawled_at: null, age_days: null };
  const age_days = Math.floor((Date.now() - row.crawled_at) / 86_400_000);
  return {
    state: age_days > STALE_CRAWL_DAYS ? 'stale' : 'fresh',
    crawled_at: row.crawled_at,
    age_days,
  };
}

/**
 * The "working well" list. Nothing else in the codebase emits pass records —
 * every detector is problem-shaped — so these are computed here, from the same
 * columns the problem collectors read.
 *
 * A pass is an assertion that something is fine, which makes it the most
 * dangerous thing on the review: a wrong green tick stops someone looking.
 * Observed in practice — a crawl predating a robots change still described
 * archived pages as indexable. So passes are withheld entirely on a stale or
 * missing crawl, and each check stays silent unless the data supports it.
 */
function getPassingChecks(db, project, freshness) {
  if (freshness.state !== 'fresh') return [];
  const checks = [];
  // A database that predates a table (sitemap_urls arrived in v1.5.23) must not
  // take the review down — a check whose data is absent simply stays silent.
  const q = (sql) => { try { return db.prepare(sql).get(project); } catch { return null; } };

  const rendered = q(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN p.word_count >= 200 THEN 1 ELSE 0 END) AS ok
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target','owned') AND p.status_code = 200
  `);
  if (rendered?.total > 0 && rendered.ok / rendered.total >= 0.9) {
    checks.push(pass('server_rendered', 'Search engines can read your server-rendered pages',
      `${rendered.ok} of ${rendered.total} pages carry readable body text in raw HTML.`));
  }

  const sitemap = q(`
    SELECT (SELECT COUNT(*) FROM sitemap_urls s JOIN domains d2 ON d2.id = s.domain_id
            WHERE d2.project = ? AND d2.role IN ('target','owned')) AS listed
  `);
  if (sitemap?.listed > 0) {
    checks.push(pass('sitemap', 'Public pages are in the sitemap',
      `${sitemap.listed} URLs declared in sitemap.xml.`));
  }

  const excluded = q(`
    SELECT COUNT(*) AS n FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target','owned') AND p.is_indexable = 0
  `);
  if (excluded?.n > 0) {
    checks.push(pass('noindex_intent', 'Private pages are excluded from search',
      `${excluded.n} pages carry a noindex directive.`));
  }

  return checks;
}

function pass(id, title, detail) {
  return { id, title, severity: 'ok', category: 'working', observed: detail };
}
