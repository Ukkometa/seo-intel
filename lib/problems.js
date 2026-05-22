/**
 * lib/problems.js — Unified Problems list.
 *
 * Aggregates problem-shaped findings from every source in the DB (technical
 * audit, citability scores, orphan analysis, schema gaps, intelligence
 * ledger) into a single severity-sorted list with everything an AI coding
 * agent needs to fix it: affected_urls, fix_template, verification.
 *
 * This is the canonical "what should I work on?" surface — backs both the
 * MCP `list_problems` tool and the upcoming dashboard Problems tab.
 *
 * Each problem returns:
 *   {
 *     id, severity, category, tier, title, description, affected_urls,
 *     evidence, fix_template, verification, first_seen, last_seen,
 *     fix_difficulty
 *   }
 */

import crypto from 'node:crypto';

export const PROBLEM_CATEGORIES = ['tech', 'indexability', 'links', 'schema', 'citability', 'content', 'keyword', 'positioning'];
export const FREE_CATEGORIES = ['tech', 'indexability', 'links', 'schema'];
export const PAID_CATEGORIES = ['citability', 'content', 'keyword', 'positioning'];

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };

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
    });
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
  }));
}

// 5. PAID — low-citability pages (AEO score < 40 in citability_scores table)
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
  }));
}

// 6. PAID — Intelligence Ledger insights mapped to problems
function collectInsightProblems(db, project) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, type, fingerprint, first_seen, last_seen, data, source
      FROM insights
      WHERE project = ? AND status = 'active'
        AND type IN ('content_gap', 'keyword_gap', 'technical_gap', 'positioning')
      ORDER BY last_seen DESC
      LIMIT 100
    `).all(project);
  } catch { return []; }
  return rows.map(r => {
    const data = safeParse(r.data);
    const typeMeta = INSIGHT_TYPE_MAP[r.type] || { category: 'content', severity: 'info' };
    const titleHint = data?.keyword || data?.topic || data?.gap || data?.phrase || `Insight ${r.id}`;
    return {
      id: makeId(typeMeta.category, r.type, r.fingerprint),
      severity: typeMeta.severity,
      category: typeMeta.category,
      tier: 'paid',
      title: `${typeMeta.label}: ${titleHint}`,
      description: data?.why || data?.description || `Active insight in the Intelligence Ledger (type=${r.type}).`,
      affected_urls: data?.url ? [data.url] : (data?.pages || []),
      evidence: { insight_id: r.id, source: r.source, ...data },
      fix_template: data?.suggestion || data?.fix || `Address this ${r.type} via blog draft, page update, or content fix. Use \`draft_blog_prompt(${project}, topic='${titleHint}')\` for an AEO-aware draft prompt.`,
      verification: `After the fix, call \`mark_problem_status('${makeId(typeMeta.category, r.type, r.fingerprint)}', 'fixed')\` (coming in v1.5.35) or wait for the next analyze run to clear it.`,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      fix_difficulty: typeMeta.difficulty,
    };
  });
}

const INSIGHT_TYPE_MAP = {
  content_gap:   { category: 'content',  severity: 'warn',  label: 'Content gap',   difficulty: 4 },
  keyword_gap:   { category: 'keyword',  severity: 'warn',  label: 'Keyword gap',   difficulty: 3 },
  technical_gap: { category: 'tech',     severity: 'warn',  label: 'Technical gap', difficulty: 3 },
  positioning:   { category: 'positioning', severity: 'info', label: 'Positioning', difficulty: 5 },
};

// ── Aggregator ─────────────────────────────────────────────────────────────

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ severity?: string, category?: string, limit?: number, includePaid?: boolean, maxFixDifficulty?: number }} opts
 * @returns {object[]}
 */
export function getProblems(db, project, opts = {}) {
  const all = [
    ...collectHttpErrors(db, project),
    ...collectIndexabilityIssues(db, project),
    ...collectOrphans(db, project),
    ...collectSchemaGaps(db, project),
  ];
  if (opts.includePaid) {
    all.push(...collectCitabilityGaps(db, project));
    all.push(...collectInsightProblems(db, project));
  }
  let filtered = all;
  if (opts.severity) filtered = filtered.filter(p => p.severity === opts.severity);
  if (opts.category) filtered = filtered.filter(p => p.category === opts.category);
  if (opts.maxFixDifficulty) filtered = filtered.filter(p => p.fix_difficulty <= opts.maxFixDifficulty);
  filtered.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
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
