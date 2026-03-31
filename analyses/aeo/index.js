/**
 * AEO / AI Citability Analysis — Orchestrator
 *
 * Reads crawled pages from DB, scores each for AI citability,
 * stores results, and optionally feeds low-scoring pages into the Intelligence Ledger.
 */

import { scorePage } from './scorer.js';

/**
 * Run AEO analysis for a project.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} opts - { includeCompetitors: boolean, log: function }
 * @returns {object} { target: PageScore[], competitors: Map<domain, PageScore[]>, summary }
 */
export function runAeoAnalysis(db, project, opts = {}) {
  const log = opts.log || console.log;
  const includeCompetitors = opts.includeCompetitors ?? true;

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

    const result = scorePage(
      page, headings, entities, schemaTypes, pageSchemas, page.search_intent
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

  const summary = {
    totalScored: scored,
    targetPages: targetResults.length,
    competitorPages: compScores.length,
    avgTargetScore: avgTarget,
    avgCompetitorScore: avgComp,
    scoreDelta: avgTarget - avgComp,
    tierCounts,
    weakestSignals: getWeakestSignals(targetResults),
  };

  log(`  Scored ${scored} pages (${targetResults.length} target, ${compScores.length} competitor)`);
  log(`  Target avg: ${avgTarget}/100 | Competitor avg: ${avgComp}/100 | Delta: ${summary.scoreDelta > 0 ? '+' : ''}${summary.scoreDelta}`);

  return { target: targetResults, competitors: competitorResults, summary };
}

/**
 * Persist AEO scores to citability_scores table
 */
export function persistAeoScores(db, results) {
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Feed low-scoring pages into Intelligence Ledger as citability_gap insights
 */
export function upsertCitabilityInsights(db, project, targetResults) {
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data)
    VALUES (?, 'citability_gap', 'active', ?, ?, ?, NULL, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `);

  const ts = Date.now();
  db.exec('BEGIN');
  try {
    for (const r of targetResults) {
      if (r.score >= 60) continue; // only flag pages that need work

      const fp = r.url.toLowerCase().replace(/[^a-z0-9/]/g, '').trim();
      const weakest = Object.entries(r.breakdown)
        .sort(([, a], [, b]) => a - b)
        .slice(0, 2)
        .map(([k]) => k.replace(/_/g, ' '));

      const data = {
        url: r.url,
        title: r.title,
        score: r.score,
        tier: r.tier,
        weakest_signals: weakest,
        ai_intents: r.aiIntents,
        recommendation: `Improve ${weakest.join(' and ')} to boost AI citability from ${r.score}/100`,
      };

      upsertStmt.run(project, fp, ts, ts, JSON.stringify(data));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[aeo] insight upsert failed:', e.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getWeakestSignals(targetResults) {
  if (!targetResults.length) return [];

  const signalTotals = {
    entity_authority: 0, structured_claims: 0, answer_density: 0,
    qa_proximity: 0, freshness: 0, schema_coverage: 0,
  };

  for (const r of targetResults) {
    for (const [k, v] of Object.entries(r.breakdown)) {
      signalTotals[k] += v;
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
