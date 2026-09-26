/**
 * AEO / AI Citability Analysis — Orchestrator
 *
 * Reads crawled pages from DB, scores each for AI citability,
 * stores results, and optionally feeds low-scoring pages into the Intelligence Ledger.
 */

import { scorePage } from './scorer.js';
import { upsertInsights } from '../../db/db.js';

/**
 * Run AEO analysis for a project.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} opts - { includeCompetitors, log, aiAccessByDomain }
 *   aiAccessByDomain: optional Map<domain, verdict> from ai-access.js. Pure —
 *   this function never touches the network; callers fetch robots.txt and pass
 *   the verdicts in (preserves the "AEO runs on existing crawl data" contract).
 * @returns {object} { target: PageScore[], competitors: Map<domain, PageScore[]>, summary }
 */
export function runAeoAnalysis(db, project, opts = {}) {
  const log = opts.log || console.log;
  const includeCompetitors = opts.includeCompetitors ?? true;
  const aiAccessByDomain = opts.aiAccessByDomain || null;

  // ── Gather pages with body_text ─────────────────────────────────────────
  const roleFilter = includeCompetitors
    ? ''
    : `AND d.role IN ('target', 'owned')`;

  const pages = db.prepare(`
    SELECT
      p.id, p.url, p.title, p.body_text, p.word_count,
      p.published_date, p.modified_date,
      d.domain, d.role,
      e.primary_entities, e.search_intent, e.schema_types
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ?
      AND p.body_text IS NOT NULL AND p.body_text != ''
      AND p.is_indexable = 1
      ${roleFilter}
    ORDER BY d.role ASC, p.url ASC
  `).all(project);

  if (!pages.length) {
    return { target: [], competitors: new Map(), summary: null };
  }

  // ── Gather headings + schemas per page ──────────────────────────────────
  const headingsStmt = db.prepare(
    'SELECT level, text FROM headings WHERE page_id = ? ORDER BY id'
  );
  const schemasStmt = db.prepare(
    'SELECT schema_type, date_published, date_modified FROM page_schemas WHERE page_id = ?'
  );

  // ── Score each page ─────────────────────────────────────────────────────
  const targetResults = [];
  const competitorResults = new Map();
  let scored = 0;

  for (const page of pages) {
    const headings = headingsStmt.all(page.id);
    const pageSchemas = schemasStmt.all(page.id);
    const schemaTypes = pageSchemas.map(s => s.schema_type);

    // Also merge extraction schema_types if page_schemas is empty
    if (!schemaTypes.length && page.schema_types) {
      try {
        const ext = JSON.parse(page.schema_types);
        if (Array.isArray(ext)) schemaTypes.push(...ext);
      } catch { /* ignore */ }
    }

    let entities = [];
    try {
      entities = JSON.parse(page.primary_entities || '[]');
    } catch { /* ignore */ }

    const aiAccess = aiAccessByDomain
      ? (aiAccessByDomain.get(page.domain) || aiAccessByDomain.get(page.domain.replace(/^www\./, '')) || null)
      : null;

    const result = scorePage(
      page, headings, entities, schemaTypes, pageSchemas, page.search_intent, aiAccess
    );

    const pageScore = {
      pageId: page.id,
      url: page.url,
      title: page.title,
      domain: page.domain,
      role: page.role,
      wordCount: page.word_count,
      ...result,
    };

    if (page.role === 'target' || page.role === 'owned') {
      targetResults.push(pageScore);
    } else {
      if (!competitorResults.has(page.domain)) competitorResults.set(page.domain, []);
      competitorResults.get(page.domain).push(pageScore);
    }

    scored++;
  }

  // Sort by score ascending (worst first — actionable)
  targetResults.sort((a, b) => a.score - b.score);
  for (const [, arr] of competitorResults) arr.sort((a, b) => a.score - b.score);

  // ── Summary stats ────────────────────────────────────────────────────────
  const targetScores = targetResults.map(r => r.score);
  const avgTarget = targetScores.length
    ? Math.round(targetScores.reduce((a, b) => a + b, 0) / targetScores.length)
    : 0;

  const compScores = [...competitorResults.values()].flat().map(r => r.score);
  const avgComp = compScores.length
    ? Math.round(compScores.reduce((a, b) => a + b, 0) / compScores.length)
    : 0;

  const tierCounts = { excellent: 0, good: 0, needs_work: 0, poor: 0 };
  for (const r of targetResults) tierCounts[r.tier]++;

  // Domain-level AI-access rollup (one verdict per target/owned domain).
  //
  // Each entry carries `fetched`, and the summary says whether the check was
  // complete, because fetchAiAccess never throws: a network failure or a
  // timeout comes back as an "assume open" verdict with fetched: false, and
  // from the verdict alone that is indistinguishable from a robots.txt that
  // was read and allows every crawler. A caller that took "the Map exists" as
  // "robots.txt was checked" would let a failed fetch resolve a critical
  // "crawlers are blocked" row as no longer detected. aiAccessChecked is true
  // only when every target/owned domain in this run has a verdict that was
  // actually read; with no target domains at all nothing was checked.
  const aiAccess = [];
  let aiAccessChecked = false;
  if (aiAccessByDomain) {
    const seen = new Set();
    let unread = 0;
    for (const r of targetResults) {
      const key = r.domain.replace(/^www\./, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const v = aiAccessByDomain.get(r.domain) || aiAccessByDomain.get(key);
      if (!v) { unread++; continue; }
      const fetched = v.fetched !== false;
      if (!fetched) unread++;
      aiAccess.push({ domain: key, verdict: v.verdict, score: v.score, blocked: !!v.blocked, blockedBots: v.citationBlocked || [], detail: v.detail, fetched });
    }
    aiAccessChecked = seen.size > 0 && unread === 0;
  }
  const gatedPages = targetResults.filter(r => r.aiAccessGated).length;

  const summary = {
    totalScored: scored,
    targetPages: targetResults.length,
    competitorPages: compScores.length,
    avgTargetScore: avgTarget,
    avgCompetitorScore: avgComp,
    scoreDelta: avgTarget - avgComp,
    tierCounts,
    weakestSignals: getWeakestSignals(targetResults),
    aiAccess,
    aiAccessChecked,
    gatedPages,
  };

  log(`  Scored ${scored} pages (${targetResults.length} target, ${compScores.length} competitor)`);
  log(`  Target avg: ${avgTarget}/100 | Competitor avg: ${avgComp}/100 | Delta: ${summary.scoreDelta > 0 ? '+' : ''}${summary.scoreDelta}`);

  return { target: targetResults, competitors: competitorResults, summary };
}

/**
 * Persist AEO scores to citability_scores table.
 * Pass `project` to also append each measurement to citability_history —
 * citability_scores is latest-only (page_id UNIQUE), history never overwrites.
 */
export function persistAeoScores(db, results, project = null) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO citability_scores
      (page_id, score, entity_authority, structured_claims, answer_density,
       qa_proximity, freshness, schema_coverage, ai_intents, tier, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const allResults = [
    ...results.target,
    ...[...results.competitors.values()].flat(),
  ];

  db.exec('BEGIN');
  try {
    for (const r of allResults) {
      stmt.run(
        r.pageId, r.score,
        r.breakdown.entity_authority, r.breakdown.structured_claims,
        r.breakdown.answer_density, r.breakdown.qa_proximity,
        r.breakdown.freshness, r.breakdown.schema_coverage,
        JSON.stringify(r.aiIntents), r.tier, Date.now()
      );
    }
    if (project) {
      appendCitabilityHistory(db, project, allResults.map((r) => ({
        url: r.url, score: r.score, ...r.breakdown,
      })), 'audit');
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Append citability measurements to the history table (never overwrites).
 * Plain INSERTs — composes with or without a caller-held transaction.
 * @param {object} db
 * @param {string} project
 * @param {Array<{url: string, score: number, entity_authority?: number, structured_claims?: number, answer_density?: number, qa_proximity?: number, freshness?: number, schema_coverage?: number}>} rows
 * @param {'audit'|'rescore'} source
 */
export function appendCitabilityHistory(db, project, rows, source = 'audit') {
  const stmt = db.prepare(`
    INSERT INTO citability_history
      (project, url, score, entity_authority, structured_claims, answer_density,
       qa_proximity, freshness, schema_coverage, source, measured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const r of rows) {
    if (r.url == null || r.score == null) continue;
    stmt.run(
      project, r.url, r.score,
      r.entity_authority ?? null, r.structured_claims ?? null, r.answer_density ?? null,
      r.qa_proximity ?? null, r.freshness ?? null, r.schema_coverage ?? null,
      source, now
    );
  }
}

/**
 * Read measurement history, newest first — scoped to one URL (sparkline) or
 * the whole project (trend line).
 */
export function getCitabilityHistory(db, project, { url = null, limit = 500 } = {}) {
  const base = `
    SELECT url, score, entity_authority, structured_claims, answer_density,
           qa_proximity, freshness, schema_coverage, source, measured_at
    FROM citability_history
    WHERE project = ?`;
  if (url) {
    return db.prepare(`${base} AND url = ? ORDER BY measured_at DESC LIMIT ?`).all(project, url, limit);
  }
  return db.prepare(`${base} ORDER BY measured_at DESC LIMIT ?`).all(project, limit);
}

/**
 * Feed low-scoring pages into the Intelligence Ledger as citability_gap rows.
 *
 * Two families of finding share the type. Domain-level AI-access blocks
 * (fingerprint `ai-access::<domain>`) are the most severe: robots.txt locks
 * the answer-engine crawlers out, so nothing on the domain can be cited at
 * all. Page rows (fingerprint: the URL reduced to [a-z0-9/]) are pages scoring
 * under 60. The fingerprints and data shapes are the ones this table has held
 * since v1.2.0, so rows written by older versions dedupe against these.
 *
 * Both are a rule's output — the scorer is deterministic over the crawl — so
 * they go through upsertInsights and get rule provenance (source_kind 'rule',
 * rule_version, confidence 1, no expiry) and the shared re-emission rule: a row
 * the data had resolved comes back when detected again, one a person closed
 * stays closed. Before this the function ran its own INSERT, which left the
 * provenance columns NULL until the next boot-time backfill guessed them, and
 * never reopened a resolved row.
 *
 * `complete` is what lets a rule finding clear: an active citability_gap this
 * run did not emit is no longer detected and is resolved. Every target page is
 * always scored, so the page rows are always complete. The ai-access rows are
 * complete only when robots.txt was actually read for every domain, and that
 * is decided here, not by the caller: fetchAiAccess never throws, so a network
 * failure arrives as an "assume open" verdict with fetched: false, and a
 * caller that saw a Map of verdicts believed the check had run. Only a rollup
 * in which every entry was fetched, from a caller that says the check ran
 * (summary.aiAccessChecked), may resolve; anything less resolves nothing —
 * better a stale row than a critical "crawlers are blocked" marked no longer
 * detected because nobody looked.
 *
 * Best-effort like every Ledger writer: upsertInsights reports a failed write
 * and returns 0 rather than failing the audit.
 *
 * @param {object} db
 * @param {string} project
 * @param {Array} targetResults  every scored target/owned page
 * @param {Array|null} aiAccess  summary.aiAccess from runAeoAnalysis
 * @param {{ aiAccessChecked?: boolean }} [opts]  summary.aiAccessChecked; false when robots.txt was not fetched this run
 * @returns {number} rows written
 */
export function upsertCitabilityInsights(db, project, targetResults, aiAccess = null, { aiAccessChecked = true } = {}) {
  const items = [];

  // Domain-level AI-access blocks — the highest-severity citability gap: the
  // page can't be cited at all because robots.txt locks out the crawlers.
  if (Array.isArray(aiAccess)) {
    for (const a of aiAccess) {
      if (a.verdict === 'open') continue;
      items.push({
        fingerprint: `ai-access::${a.domain}`,
        data: {
          domain: a.domain,
          score: a.score,
          tier: a.blocked ? 'poor' : 'needs_work',
          verdict: a.verdict,
          blocked_crawlers: a.blockedBots,
          weakest_signals: ['ai access'],
          recommendation: a.blocked
            ? `robots.txt blocks AI answer-engine crawlers (${(a.blockedBots || []).slice(0, 5).join(', ')}). Allow ClaudeBot / GPTBot / PerplexityBot / Google-Extended so the assistants developers use can read and cite ${a.domain}.`
            : `${a.detail} Review robots.txt AI-crawler rules on ${a.domain}.`,
        },
      });
    }
  }

  for (const r of (Array.isArray(targetResults) ? targetResults : [])) {
    if (r.score >= 60) continue; // only flag pages that need work

    const weakest = Object.entries(r.breakdown)
      .sort(([, a], [, b]) => a - b)
      .slice(0, 2)
      .map(([k]) => k.replace(/_/g, ' '));

    items.push({
      fingerprint: r.url.toLowerCase().replace(/[^a-z0-9/]/g, '').trim(),
      data: {
        url: r.url,
        title: r.title,
        score: r.score,
        tier: r.tier,
        weakest_signals: weakest,
        ai_intents: r.aiIntents,
        recommendation: `Improve ${weakest.join(' and ')} to boost AI citability from ${r.score}/100`,
      },
    });
  }

  return upsertInsights(db, project, 'citability_gap', items, { complete: aiAccessChecked && aiAccessFetched(aiAccess) });
}

/**
 * Was robots.txt actually read for every domain in an AI-access rollup?
 *
 * A verdict with `fetched: false` is analyzeAiAccess's default when the fetch
 * failed or timed out — "assuming open" — not a measurement, so a rollup
 * containing one has not checked the site. No rollup at all means the check
 * was skipped. Pure; exported so the rule can be tested without a network.
 *
 * @param {Array|null} aiAccess  summary.aiAccess from runAeoAnalysis
 * @returns {boolean}
 */
export function aiAccessFetched(aiAccess) {
  return Array.isArray(aiAccess) && aiAccess.every(a => a && a.fetched !== false);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getWeakestSignals(targetResults) {
  if (!targetResults.length) return [];

  // Key-agnostic: ai_access only appears in the breakdown when robots data was
  // supplied, so build the accumulator from whatever signals are present.
  const signalTotals = {};
  for (const r of targetResults) {
    for (const [k, v] of Object.entries(r.breakdown)) {
      signalTotals[k] = (signalTotals[k] || 0) + v;
    }
  }

  return Object.entries(signalTotals)
    .map(([signal, total]) => ({
      signal: signal.replace(/_/g, ' '),
      avg: Math.round(total / targetResults.length),
    }))
    .sort((a, b) => a.avg - b.avg);
}

/**
 * Read stored citability scores for dashboard
 */
export function getCitabilityScores(db, project) {
  return db.prepare(`
    SELECT
      cs.*, p.url, p.title, p.word_count,
      d.domain, d.role
    FROM citability_scores cs
    JOIN pages p ON p.id = cs.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    ORDER BY d.role ASC, cs.score ASC
  `).all(project);
}
