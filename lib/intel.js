/**
 * lib/intel.js — Canonical "give me intelligence about this project" entry point.
 *
 * Single source of truth backing every agent-facing surface:
 *   - CLI:  `seo-intel intel <project>` (this file's first consumer)
 *   - MCP:  `seo-intel-mcp` server (v1.5.26 — wraps this same function)
 *   - HTTP: dashboard / future REST endpoint
 *
 * Slices:
 *   raw         (free)  — page/keyword/heading inventory, no analysis
 *   audit       (free)  — citability + technical + active insights (your own site)
 *   blog        (free)  — gaps + tone hints for drafting (your own site)
 *   competitor  (paid)  — competitor summary + schema landscape
 *
 * Monetization line (v1.5.41): analysis of YOUR OWN site is free — a smart
 * agent commoditizes one-shot analysis anyway. The paywall sits on the things
 * an agent structurally can't do for itself: competitors, automation, history.
 *
 * Output is a stable structured object — agents should be able to chain calls
 * without prompt gymnastics. Keep the schema additive across versions.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getActiveInsights, getCompetitorSummary, getKeywordMatrix } from '../db/db.js';
import { getCitabilityScores } from '../analyses/aeo/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;

export const INTEL_SLICES = ['raw', 'audit', 'blog', 'competitor'];
// Own-site slices are free; only the competitor slice (data the agent can't
// gather on its own) requires Solo.
export const FREE_SLICES = ['raw', 'audit', 'blog'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ for?: string }} [opts]
 * @returns {object} structured intel digest
 */
export function getIntel(db, project, opts = {}) {
  const slice = opts.for || 'raw';
  if (!INTEL_SLICES.includes(slice)) {
    throw new Error(`Unknown intel slice "${slice}". Available: ${INTEL_SLICES.join(', ')}`);
  }

  const envelope = {
    project,
    for: slice,
    tier: FREE_SLICES.includes(slice) ? 'free' : 'paid',
    generated_at: new Date().toISOString(),
    seo_intel_version: VERSION,
    data: {},
  };

  if (slice === 'raw')        envelope.data = collectRaw(db, project);
  if (slice === 'audit')      envelope.data = collectAudit(db, project);
  if (slice === 'blog')       envelope.data = collectBlog(db, project);
  if (slice === 'competitor') envelope.data = collectCompetitor(db, project);

  return envelope;
}

// ── Slice collectors ────────────────────────────────────────────────────────

function collectRaw(db, project) {
  const domains = db.prepare(
    `SELECT d.domain, d.role, d.last_crawled,
            COUNT(p.id) AS pages,
            SUM(CASE WHEN p.status_code = 200 THEN 1 ELSE 0 END) AS pages_ok
     FROM domains d
     LEFT JOIN pages p ON p.domain_id = d.id
     WHERE d.project = ?
     GROUP BY d.id
     ORDER BY d.role, d.domain`
  ).all(project);

  const totals = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM pages p JOIN domains d ON d.id=p.domain_id WHERE d.project=?)     AS pages,
       (SELECT COUNT(*) FROM keywords k JOIN pages p ON p.id=k.page_id JOIN domains d ON d.id=p.domain_id WHERE d.project=?) AS keywords,
       (SELECT COUNT(*) FROM headings h JOIN pages p ON p.id=h.page_id JOIN domains d ON d.id=p.domain_id WHERE d.project=?) AS headings,
       (SELECT COUNT(*) FROM page_schemas s JOIN pages p ON p.id=s.page_id JOIN domains d ON d.id=p.domain_id WHERE d.project=?) AS schemas,
       (SELECT COUNT(*) FROM sitemap_urls u JOIN domains d ON d.id=u.domain_id WHERE d.project=?) AS sitemap_urls`
  ).get(project, project, project, project, project) || {};

  const lastCrawl = domains.reduce((m, d) => Math.max(m, d.last_crawled || 0), 0);

  return {
    domains: domains.map(d => ({
      domain: d.domain,
      role: d.role,
      pages: d.pages,
      pages_ok: d.pages_ok,
      last_crawled: d.last_crawled ? new Date(d.last_crawled).toISOString() : null,
    })),
    totals: {
      pages: totals.pages || 0,
      keywords: totals.keywords || 0,
      headings: totals.headings || 0,
      schemas: totals.schemas || 0,
      sitemap_urls: totals.sitemap_urls || 0,
    },
    last_crawl: lastCrawl ? new Date(lastCrawl).toISOString() : null,
    note: 'Free tier — raw crawl inventory. Pipe into your own AI for analysis, or upgrade to Solo for citability/gap/competitor intel.',
  };
}

function collectAudit(db, project) {
  const insights = getActiveInsights(db, project);
  let citability = null;
  try { citability = getCitabilityScores(db, project); } catch { /* citability_scores table may not exist if AEO never run */ }
  return {
    citability,
    insights: {
      keyword_gaps: insights.keyword_gaps,
      content_gaps: insights.content_gaps,
      technical_gaps: insights.technical_gaps,
      quick_wins: insights.quick_wins,
      site_watch: insights.site_watch,
    },
    last_insight_at: insights.generated_at ? new Date(insights.generated_at).toISOString() : null,
  };
}

function collectBlog(db, project) {
  const insights = getActiveInsights(db, project);
  return {
    keyword_gaps: insights.keyword_gaps,
    long_tails: insights.long_tails,
    content_gaps: insights.content_gaps,
    keyword_inventor: insights.keyword_inventor,
    positioning: insights.positioning,
    drafting_hint: 'Each keyword_gap or long_tail is a candidate draft target. Pair with topic clusters from `seo-intel templates <project>` and citability gaps from `--for=audit` for AEO-aware drafts.',
  };
}

function collectCompetitor(db, project) {
  const summary = getCompetitorSummary(db, project);
  const matrix = getKeywordMatrix(db, project);
  const insights = getActiveInsights(db, project);
  return {
    summary,
    keyword_matrix: matrix,
    positioning: insights.positioning,
    new_pages: insights.new_pages,
  };
}

// ── Markdown formatter ──────────────────────────────────────────────────────

export function intelToMarkdown(envelope) {
  const { project, for: slice, tier, generated_at, data } = envelope;
  const lines = [
    `# SEO Intel — ${project}`,
    `> slice: \`${slice}\` · tier: \`${tier}\` · generated: ${generated_at}`,
    '',
  ];

  if (slice === 'raw') {
    lines.push('## Crawl inventory', '');
    lines.push(`- **Total pages:** ${data.totals.pages}`);
    lines.push(`- **Keywords:** ${data.totals.keywords}`);
    lines.push(`- **Headings:** ${data.totals.headings}`);
    lines.push(`- **Schemas:** ${data.totals.schemas}`);
    lines.push(`- **Sitemap URLs:** ${data.totals.sitemap_urls}`);
    lines.push(`- **Last crawl:** ${data.last_crawl || 'never'}`, '');
    lines.push('## Domains', '');
    lines.push('| Domain | Role | Pages (200) | Last crawled |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of data.domains) {
      lines.push(`| ${d.domain} | ${d.role} | ${d.pages_ok}/${d.pages} | ${d.last_crawled || '—'} |`);
    }
    lines.push('', `> ${data.note}`);
  } else {
    // Generic JSON-in-fence fallback for paid slices — agents can parse either way.
    lines.push(`## ${slice} (data)`, '', '```json', JSON.stringify(data, null, 2), '```');
  }

  return lines.join('\n');
}
