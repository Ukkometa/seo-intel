/**
 * agent-harness.js — Agent-harness API for SEO Intel
 *
 * Single entry point any agent platform can "ride" (Hermes, MCP hosts, custom
 * orchestrators). Self-describing via `capabilities` + `pipeline`. Three usage levels:
 *
 * 1. Unified runner (recommended):
 *    import { run, capabilities } from 'seo-intel/agent-harness';
 *    const result = await run('aeo', 'myproject');
 *
 * 2. Direct function imports:
 *    import { aeo, gapIntel } from 'seo-intel/agent-harness';
 *
 * 3. Deep imports (tree-shakeable):
 *    import { runAeoAnalysis } from 'seo-intel/aeo';
 *
 * Back-compat: the legacy `seo-intel/froggo` export still resolves here.
 */

import { readFileSync } from 'fs';
import { getDb, getActiveInsights } from './db/db.js';
import { DEFAULTS as GSC_FETCH_DEFAULTS } from './analyses/gsc-fetch/index.js';
import { DEFAULTS as GSC_INSPECT_DEFAULTS } from './analyses/gsc-inspect/index.js';
import { DEFAULTS as DEMAND_DEFAULTS } from './analyses/demand/index.js';
import { URL_INSPECTION_QUOTA } from './lib/gsc-api.js';
import { DEFAULTS as BING_LINKS_DEFAULTS } from './analyses/bing-links/index.js';
import { BING_API } from './lib/bing-api.js';
import { readProjectConfig, listProjectConfigs } from './lib/project-config.js';
import { findFriction } from './lib/friction.js';
import { findShallowPages, findDecayingPages, auditCompetitorHeadings } from './analyses/competitor-pages/index.js';
import { findOrphanEntities, getEntityCoverage } from './analyses/entity-coverage/index.js';
import { getSchemaCoverage } from './analyses/schema-coverage/index.js';
import { getCrawlBrief, briefForHarness, getPublishingVelocity, velocityForHarness } from './analyses/history/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
//
// These three names have been part of this module's public surface since the
// harness carried its own copies of them. The copies are gone — cli.js, this
// file and the dashboard now share one implementation each — and the names
// stay as re-exports so an integrator importing them keeps working:
//   loadConfig(project)  → lib/project-config readProjectConfig: the parsed
//                          config, or null for a missing file, bad JSON or a
//                          name outside [a-z0-9_-]
//   listProjects()       → lib/project-config listProjectConfigs:
//                          [{ name, targetDomain, competitors }], sorted by name
//   isContentPage(url)   → lib/content-pages: false for app routes, auth pages
//                          and query-string URLs

export { readProjectConfig as loadConfig, listProjectConfigs as listProjects };
export { isContentPage } from './lib/content-pages.js';

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSIS MODULES (direct exports)
// ═══════════════════════════════════════════════════════════════════════════

export { runAeoAnalysis as aeo } from './analyses/aeo/index.js';
export { scorePage as scorePageCitability } from './analyses/aeo/scorer.js';
export { runGapIntel as gapIntel } from './analyses/gap-intel/index.js';
export { runWatch as watch, getWatchData } from './analyses/watch/index.js';
export { gatherBlogDraftContext as blogDraftContext } from './analyses/blog-draft/index.js';
export { buildBlogDraftPrompt as blogDraftPrompt } from './analyses/blog-draft/index.js';
export { runTemplatesAnalysis as templates } from './analyses/templates/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT MODULES (structured action lists)
// ═══════════════════════════════════════════════════════════════════════════

export { buildTechnicalActions as technicalActions } from './exports/technical.js';
export { buildCompetitiveActions as competitiveActions } from './exports/competitive.js';
export { buildSuggestiveActions as suggestiveActions } from './exports/suggestive.js';
export { getProjectDomains, getTargetDomains, getCompetitorDomains } from './exports/queries.js';

// ═══════════════════════════════════════════════════════════════════════════
// CRAWLER + DATA LAYER
// ═══════════════════════════════════════════════════════════════════════════

export { crawlDomain } from './crawler/index.js';
export { getDb, getActiveInsights } from './db/db.js';

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD (embeddable HTML)
// ═══════════════════════════════════════════════════════════════════════════

export { generateMultiDashboard, generateHtmlDashboard } from './reports/generate-html.js';

/**
 * Generate dashboard HTML as a string (for embedding in iframes/panels).
 * Does NOT write to disk — returns HTML directly.
 */
export async function getDashboardHtml(project) {
  const db = getDb();
  const config = readProjectConfig(project);
  if (!config) return { error: `Project "${project}" not found` };

  const { generateHtmlDashboard } = await import('./reports/generate-html.js');
  const filePath = generateHtmlDashboard(db, project, config);
  try {
    return { html: readFileSync(filePath, 'utf8'), project };
  } catch (e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPABILITIES MANIFEST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Machine-readable capability list. Agents can introspect what SEO Intel offers.
 */
export const capabilities = [
  {
    id: 'crawl',
    name: 'Site Crawler',
    description: 'Crawl a website and store page structure, content, metadata, and schemas in SQLite',
    requires: ['playwright'],
    inputs: { project: 'string', options: { stealth: 'boolean', maxPages: 'number', scope: 'string' } },
    outputs: { pages: 'number', domains: 'number', schemas: 'number' },
    phase: 'collect',
    tier: 'free',
  },
  {
    id: 'gsc-fetch',
    name: 'Search Console Fetch',
    description: `Pull your own Search Console rows from the API into the database with real dates — page×query daily (${GSC_FETCH_DEFAULTS.days} days), page daily and query daily (${GSC_FETCH_DEFAULTS.months} months). Incremental; page-contract reads it, and a page with no rows is measured absence, not missing data.`,
    requires: ['google-oauth'],
    inputs: { project: 'string', options: { days: 'number', months: 'number', dryRun: 'boolean' } },
    outputs: { property: 'string', grains: 'array<{grain, windows, rows, requests}>', coverage: 'object' },
    phase: 'collect',
    tier: 'free',
    dependsOn: [],
  },
  {
    id: 'gsc-inspect',
    name: 'URL Inspection',
    description: `Ask Google whether it has indexed your pages (URL Inspection API) and store each verdict — PASS/PARTIAL/FAIL/NEUTRAL, coverage state, chosen canonical. Demand-first within the ${URL_INSPECTION_QUOTA.perDay}/day quota: ${GSC_INSPECT_DEFAULTS.limit} URLs a run, skipping any inspected in the last ${GSC_INSPECT_DEFAULTS.maxAgeDays} days. NEUTRAL is often an intended noindex. Feeds list_problems (indexability) and the search review.`,
    requires: ['google-oauth'],
    inputs: { project: 'string', options: { urls: 'array<string>|string', limit: 'number', maxAgeDays: 'number', property: 'string', dryRun: 'boolean' } },
    outputs: { property: 'string', inspected: 'number', verdicts: 'object', results: 'array<{url, verdict, coverage_state, google_canonical}>', quota: 'object', stopped_reason: 'string|null' },
    phase: 'collect',
    tier: 'free',
    dependsOn: [],
  },
  {
    id: 'bing-links',
    name: 'Bing Webmaster Links',
    description: `Pull the inbound links Bing Webmaster Tools reports for your site into the backlinks table (origin bing), each with the page of yours it points at and its anchor text — what the Search Console export lacks, since that report has no API. The ${BING_LINKS_DEFAULTS.maxTargetPages} most-linked pages are walked within ${BING_LINKS_DEFAULTS.maxRequests} requests of a daily quota. A sample from Bing's own index, different from Google's and also capped: never a complete link profile. backlink-audit reads the rows. Needs ${BING_API.keyEnv}.`,
    requires: ['bing-api-key'],
    inputs: { project: 'string', options: { siteUrl: 'string', maxTargetPages: 'number', maxRequests: 'number', dryRun: 'boolean' } },
    outputs: { site: 'string', target_pages: 'array<{url, count, linking_pages_stored, complete}>', inserted: 'number', updated: 'number', linking_domains: 'number', truncated: 'boolean', stopped_reason: 'string|null', errors: 'array' },
    phase: 'collect',
    tier: 'free',
    dependsOn: [],
  },
  {
    id: 'demand',
    name: 'Search Demand',
    description: `Quick wins and long tails from your own Search Console rows (${DEMAND_DEFAULTS.windowDays}-day window): striking-distance queries with CTR under a heuristic baseline or on page two, and phrases with no page on page one. Rule-sourced; the review lists them under opportunities.`,
    requires: [],
    inputs: { project: 'string', options: { windowDays: 'number', minImpressions: 'number' } },
    outputs: { quick_wins: 'array<QuickWin>', long_tails: 'array<LongTail>', window: 'object', skipped_reason: 'string|null' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['gsc-fetch'],
  },
  {
    id: 'trends',
    name: 'Traffic Trends',
    description: `Page-level click decay and growth: the current ${DEMAND_DEFAULTS.windowDays}-day page-grain window against the same-length window before it, from a ${DEMAND_DEFAULTS.minTrendClicks}-click floor. Decays are filed as gsc_decay (scope history); skipped, nothing written, when the previous window is shorter.`,
    requires: [],
    inputs: { project: 'string', options: { windowDays: 'number' } },
    outputs: { decays: 'array<Trend>', growth: 'array<Trend>', previous_window: 'object|null', skipped_reason: 'string|null' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['gsc-fetch'],
  },
  {
    id: 'extract',
    name: 'Content Extractor',
    description: 'Extract SEO signals from crawled pages using local LLM (keywords, entities, intent, CTAs)',
    requires: ['ollama'],
    inputs: { project: 'string', options: { model: 'string' } },
    outputs: { keywords: 'array', entities: 'array', intent: 'string', cta: 'string' },
    modelHint: 'light-local',
    modelNote: 'Use gemma4:e2b (fast) or gemma4:e4b (balanced). Extraction is structured data work — heavy models waste resources.',
    phase: 'extract',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'aeo',
    name: 'AI Citability Audit',
    description: 'Score each page for AI citability (0-100) across 6 signals. Find pages search AI will ignore.',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { scores: 'array<PageScore>', summary: 'object', insights: 'array' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'rescore',
    name: 'Re-score a URL (close the loop)',
    description: "Re-check one URL's AI citability after a fix. Read-only re-measurement on the RAW-HTML (what-bots-see) lens — returns before/after/delta so an agent can verify its own change. If the fix is server-rendered the score moves; if JS-only, it correctly does not.",
    requires: [],
    inputs: { project: 'string', options: { url: 'string (required)' } },
    outputs: { url: 'string', before: 'number', after: 'number', delta: 'number', improved: 'boolean', signals: 'object', lens: 'string' },
    phase: 'verify',
    tier: 'free',
    dependsOn: ['aeo'],
  },
  {
    id: 'watch',
    name: 'Site Health Watch',
    description: 'Detect changes between crawl runs — new/removed pages, status changes, title/content changes, health score',
    requires: [],
    inputs: { project: 'string' },
    outputs: { snapshot: 'object', events: 'array<WatchEvent>', healthScore: 'number', trend: 'number' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'gap-intel',
    name: 'Gap Intelligence',
    description: 'Topic/content gap analysis — find what competitors cover that you don\'t',
    requires: ['ollama'],
    inputs: { project: 'string', options: { vs: 'string[]', type: 'string', limit: 'number', raw: 'boolean' } },
    outputs: { gaps: 'array<TopicGap>', matrix: 'object', report: 'string' },
    modelHint: 'light-local',
    modelNote: 'gemma4:e4b handles topic clustering well. Cloud models add minimal value here.',
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl', 'extract'],
  },
  {
    id: 'analyze',
    name: 'Competitor Analysis',
    description: 'Competitor gap analysis with a receipt per section. Keyword gaps and content-gap clusters are computed from the crawl, quick wins and long tails come from Search Console, technical gaps from the audit; a model is asked only narrow judgments (intent and priority of each gap, cluster naming, new pages, positioning), each validated against a closed schema. Writes the analyses row and the Ledger insights; provenance says which section came from a rule, Search Console, or the model.',
    requires: ['analysis-model'],
    inputs: { project: 'string', options: { provider: 'string', model: 'string', noModel: 'boolean' } },
    outputs: { analysis: 'object', provenance: 'object', analysisId: 'number', savedPath: 'string', judgmentsPath: 'string' },
    modelHint: 'cloud-medium',
    modelNote: 'Any provider with a key in .env — Anthropic, OpenAI, Gemini, DeepSeek — or local Ollama, or the Agent Harness gateway. ANALYSIS_PROVIDER / ANALYSIS_MODEL choose; options.provider / options.model override. Judgments are small (40 items at most, closed schema), so a capable local model works. noModel: true computes the sections and asks nothing.',
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'shallow',
    name: 'Shallow Champion Attack',
    description: 'Find competitor pages that are important but thin — easy to outwrite',
    requires: [],
    inputs: { project: 'string', options: { maxWords: 'number', maxDepth: 'number', format: 'json|brief' } },
    outputs: { targets: 'array<Page>', byDomain: 'object' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'decay',
    name: 'Content Decay Arbitrage',
    description: 'Find competitor pages decaying due to staleness — your freshness advantage',
    requires: [],
    inputs: { project: 'string', options: { months: 'number', format: 'json|brief' } },
    outputs: { confirmedStale: 'array<Page>', unknownFreshness: 'array<Page>' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'headings-audit',
    name: 'Heading Architecture Audit',
    description: 'Pull competitor heading structures — find topic gaps in H1-H3 hierarchy',
    requires: [],
    inputs: { project: 'string', options: { domain: 'string', depth: 'number', format: 'json|brief' } },
    outputs: { pages: 'array<{url, headings: Heading[]>}' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'orphans',
    name: 'Orphan Entity Attack',
    description: 'Find entities mentioned by competitors with no dedicated page — content opportunities',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { orphans: 'array<{entity, domains, suggestedUrl}>' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['extract'],
  },
  {
    id: 'entities',
    name: 'Entity Coverage Map',
    description: 'Semantic gap analysis at the entity level — concepts competitors mention that you don\'t',
    requires: [],
    inputs: { project: 'string', options: { minMentions: 'number', format: 'json|brief' } },
    outputs: { gaps: 'array', shared: 'array', unique: 'array', summary: 'object' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['extract'],
  },
  {
    id: 'schemas',
    name: 'Schema Intelligence',
    description: 'Structured data competitive analysis — ratings, pricing, rich results gaps',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { coverageMatrix: 'object', gaps: 'array', ratings: 'array', pricing: 'array', actions: 'array' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'friction',
    name: 'Intent & Friction Hijacking',
    description: 'Find competitor pages with intent/CTA mismatch — high friction you can undercut',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { targets: 'array<FrictionTarget>', totalAnalyzed: 'number' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['extract'],
  },
  {
    id: 'brief',
    name: 'Weekly Intel Brief',
    description: 'What changed this week — competitor moves, new gaps, wins, actions',
    requires: [],
    inputs: { project: 'string', options: { days: 'number', format: 'json|brief' } },
    outputs: { competitorMoves: 'array', keywordGaps: 'array', schemaGaps: 'array', actions: 'array' },
    phase: 'report',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'velocity',
    name: 'Content Velocity Tracker',
    description: 'Publishing rate comparison — who\'s producing content fastest',
    requires: [],
    inputs: { project: 'string', options: { days: 'number', format: 'json|brief' } },
    outputs: { velocities: 'array<DomainVelocity>', recentlyPublished: 'array', newPages: 'array' },
    phase: 'analyze',
    tier: 'pro',
    dependsOn: ['crawl'],
  },
  {
    id: 'js-delta',
    name: 'JS Rendering Delta',
    description: 'Compare raw HTML vs rendered DOM — find pages with hidden JS-only content',
    requires: ['playwright'],
    inputs: { project: 'string', options: { domain: 'string', maxPages: 'number', threshold: 'number', format: 'json|brief' } },
    outputs: { results: 'array<RenderDelta>', summary: 'object' },
    phase: 'analyze',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'export-actions',
    name: 'Technical Action Export',
    description: 'Generate prioritised technical SEO fix list from crawl data',
    requires: [],
    inputs: { project: 'string', options: { scope: 'string', format: 'json|brief' } },
    outputs: { actions: 'array<Action>' },
    phase: 'export',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'competitive-actions',
    name: 'Competitive Action Export',
    description: 'Generate competitive intelligence action list — what to build based on competitor analysis',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { actions: 'array<Action>' },
    phase: 'export',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'suggest-usecases',
    name: 'Use Case Suggestions',
    description: 'AI-suggested pages/features to build based on competitor patterns',
    requires: [],
    inputs: { project: 'string', options: { format: 'json|brief' } },
    outputs: { suggestions: 'array<Action>' },
    phase: 'export',
    tier: 'free',
    dependsOn: ['crawl'],
  },
  {
    id: 'blog-draft',
    name: 'AEO Blog Draft Generator',
    description: 'Generate AEO-optimised blog post drafts from Intelligence Ledger data',
    requires: ['cloud-llm'],
    inputs: { project: 'string', options: { topic: 'string', lang: 'string', model: 'string' } },
    outputs: { draft: 'string', context: 'object' },
    modelHint: 'cloud-medium',
    modelNote: 'Sonnet or equivalent — needs creative + strategic reasoning for quality drafts.',
    phase: 'create',
    tier: 'pro',
    dependsOn: ['crawl', 'extract', 'aeo'],
  },
];

/**
 * Dependency graph for agent orchestration.
 * Agents should follow this order: collect → extract → analyze → report → create
 */
export const pipeline = {
  phases: ['collect', 'extract', 'analyze', 'report', 'create'],
  graph: {
    crawl: [],
    'gsc-fetch': [],
    'gsc-inspect': [],
    'bing-links': [],
    demand: ['gsc-fetch'],
    trends: ['gsc-fetch'],
    extract: ['crawl'],
    aeo: ['crawl'],
    rescore: ['aeo'],
    watch: ['crawl'],
    'gap-intel': ['crawl', 'extract'],
    analyze: ['crawl'],
    shallow: ['crawl'],
    decay: ['crawl'],
    'headings-audit': ['crawl'],
    orphans: ['extract'],
    entities: ['extract'],
    schemas: ['crawl'],
    friction: ['extract'],
    brief: ['crawl'],
    velocity: ['crawl'],
    'js-delta': ['crawl'],
    'export-actions': ['crawl'],
    'competitive-actions': ['crawl'],
    'suggest-usecases': ['crawl'],
    'blog-draft': ['crawl', 'extract', 'aeo'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED RUNNER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run any SEO Intel command and get structured JSON back.
 *
 * @param {string} command - Command ID (e.g. 'aeo', 'shallow', 'gap-intel')
 * @param {string} project - Project name
 * @param {object} [opts={}] - Command-specific options
 * @returns {Promise<{ok: boolean, command: string, project: string, timestamp: string, data?: object, error?: string}>}
 *
 * Usage:
 *   const result = await run('aeo', 'carbium');
 *   const result = await run('gap-intel', 'carbium', { vs: ['helius.dev'] });
 *   const result = await run('shallow', 'carbium', { maxWords: 500 });
 */
export async function run(command, project, opts = {}) {
  const timestamp = new Date().toISOString();
  const wrap = (data) => ({ ok: true, command, project, timestamp, data });
  const fail = (error) => ({ ok: false, command, project, timestamp, error });

  try {
    const db = getDb();
    const config = readProjectConfig(project);
    if (!config && !['status'].includes(command)) {
      return fail(`Project "${project}" not configured. Available: ${listProjectConfigs().map(p => p.name).join(', ')}`);
    }

    switch (command) {
      // ── Analysis commands (return structured data) ──

      case 'aeo': {
        const { runAeoAnalysis } = await import('./analyses/aeo/index.js');
        const result = await runAeoAnalysis(db, project, {
          ...opts,
          log: opts.log || (() => {}),
        });
        return wrap(result);
      }

      case 'entity-audit': {
        const { runEntityAudit } = await import('./analyses/entity/index.js');
        return wrap(await runEntityAudit(db, project, {
          targetUrl: config?.target?.url || config?.context?.url,
          live: !!opts.live,
        }));
      }

      case 'triangulation': {
        const { runTriangulationScan } = await import('./analyses/triangulation/index.js');
        return wrap(await runTriangulationScan(db, project, {
          live: !!opts.live,
          videoMetadata: !!opts.videoMetadata,
        }));
      }

      case 'gsc-platform': {
        const { runPlatformGapAnalysis } = await import('./analyses/gsc-platform/index.js');
        return wrap(await runPlatformGapAnalysis(config, opts));
      }

      case 'geo': {
        const { runGeoAudit } = await import('./analyses/geo/index.js');
        return wrap(await runGeoAudit(db, project, { live: !!opts.live }));
      }

      case 'schema-audit': {
        const { runSchemaAudit } = await import('./analyses/schema-audit/index.js');
        return wrap(runSchemaAudit(db, project, {}));
      }

      case 'gsc-import': {
        const { importGscQueries } = await import('./lib/gsc-import.js');
        return wrap(importGscQueries(db, project));
      }

      case 'gsc-fetch': {
        const { runGscFetch } = await import('./analyses/gsc-fetch/index.js');
        const grains = Array.isArray(opts.grains) ? opts.grains : (opts.grains ? String(opts.grains).split(',') : undefined);
        try {
          return wrap(await runGscFetch(db, project, config, {
            days: opts.days, months: opts.months, grains,
            property: opts.property, dryRun: !!opts.dryRun,
          }));
        } catch (err) {
          // The transport's hint (reconnect, wait, enable the API) is the
          // actionable half of a GscApiError; keep it in the failure text.
          return fail(err.hint ? `${err.message} — ${err.hint}` : err.message);
        }
      }

      case 'gsc-inspect': {
        const { runGscInspect } = await import('./analyses/gsc-inspect/index.js');
        const urls = Array.isArray(opts.urls)
          ? opts.urls
          : (opts.urls ? String(opts.urls).split(',').map(s => s.trim()).filter(Boolean) : undefined);
        try {
          return wrap(await runGscInspect(db, project, config, {
            urls, limit: opts.limit, maxAgeDays: opts.maxAgeDays,
            property: opts.property, dryRun: !!opts.dryRun,
          }));
        } catch (err) {
          // Same as gsc-fetch: the transport's hint (reconnect, quota, enable
          // the API) is the actionable half of a GscApiError.
          return fail(err.hint ? `${err.message} — ${err.hint}` : err.message);
        }
      }

      case 'demand': {
        // Arithmetic over gsc_daily, no request: a project without rows comes
        // back ok with skipped_reason 'no_gsc_data' and a hint, not a failure.
        // Thresholds pass through opts; trends stay off — that is the paid half.
        const { runDemand } = await import('./analyses/demand/index.js');
        return wrap(runDemand(db, project, { ...opts, trends: false }));
      }

      case 'trends': {
        // The paid half of the same module (gsc_decay, scope 'history'). Like
        // brief and velocity, the harness itself does not gate: the manifest
        // says tier 'pro' and the MCP demand_trends tool enforces it. Only the
        // trends half is returned; quick wins and long tails are 'demand'.
        const { runDemand } = await import('./analyses/demand/index.js');
        const r = runDemand(db, project, { ...opts, trends: true });
        const t = r.trends;
        return wrap({
          project: r.project, property: r.property, search_type: r.search_type,
          window: r.window, previous_window: t?.previous_window ?? null,
          coverage: r.coverage?.page ?? null,
          decays: t?.decays ?? [], growth: t?.growth ?? [],
          counts: { decays: r.counts.decays, growth: r.counts.growth },
          skipped_reason: r.skipped_reason ?? t?.skipped_reason ?? null,
          hint: r.hint ?? null,
        });
      }

      case 'backlink-import': {
        const { importBacklinks } = await import('./lib/backlink-import.js');
        return wrap(importBacklinks(db, project, {}));
      }

      case 'bing-links': {
        const { runBingLinks } = await import('./analyses/bing-links/index.js');
        try {
          return wrap(await runBingLinks(db, project, config, {
            siteUrl: opts.siteUrl, maxTargetPages: opts.maxTargetPages, maxRequests: opts.maxRequests,
            dryRun: !!opts.dryRun, debugDir: opts.debugDir,
          }));
        } catch (err) {
          // Same as gsc-fetch: a BingApiError's hint (set or check the key,
          // wait for the daily quota, report a shape change) is the
          // actionable half; keep it in the failure text.
          return fail(err.hint ? `${err.message} — ${err.hint}` : err.message);
        }
      }

      case 'backlink-audit': {
        const { runBacklinkAudit } = await import('./analyses/backlinks/index.js');
        return wrap(await runBacklinkAudit(db, project, {
          live: !!opts.live, limit: opts.limit,
          brandTerms: opts.brandTerms || config?.brandTerms || [],
        }));
      }

      case 'page-contract': {
        if (!opts.url) return fail('page-contract requires opts.url (the page to decide on)');
        const { runPageContract } = await import('./analyses/page-contract/index.js');
        return wrap(runPageContract(db, project, opts.url, {
          brandTerms: opts.brandTerms || config?.brandTerms || config?.gsc?.brandTerms || [],
        }));
      }

      case 'rescore': {
        if (!opts.url) return fail('rescore requires opts.url (the page to re-check)');
        const { rescorePage } = await import('./analyses/aeo/rescore.js');
        const result = await rescorePage(db, project, opts.url, { log: opts.log });
        return wrap(result);
      }

      case 'watch': {
        const { runWatch } = await import('./analyses/watch/index.js');
        const result = runWatch(db, project, { log: opts.log || (() => {}) });
        return wrap(result);
      }

      case 'analyze': {
        // analysis/run-analysis.js: computed sections plus schema-checked
        // judgments through lib/providers.js. Nothing here touches a model
        // directly, and a ProviderError's hint rides along in the failure.
        const { runProjectAnalysis } = await import('./analysis/run-analysis.js');
        const { analysis, analysisId, provenance, savedPath, judgmentsPath } = await runProjectAnalysis(db, project, config, {
          provider: opts.provider,
          model: opts.model,
          noModel: !!opts.noModel,
          log: opts.log || (() => {}),
        });
        return wrap({ analysis, analysisId, provenance, savedPath, judgmentsPath });
      }

      case 'gap-intel': {
        const { runGapIntel } = await import('./analyses/gap-intel/index.js');
        const vs = Array.isArray(opts.vs) ? opts.vs : (opts.vs ? opts.vs.split(',') : []);
        const report = await runGapIntel(db, project, config, {
          vs,
          type: opts.type || 'all',
          limit: opts.limit || 100,
          raw: opts.raw || false,
          log: opts.log || (() => {}),
        });
        return wrap({ report });
      }

      // ── Competitor attacks ──
      //
      // Each of these computes through the same module the CLI command and
      // the dashboard card use, so an agent over MCP and a person at the
      // terminal get the same rows in the same order. The modules return a
      // superset (the CLI's byDomain, thresholds, cutoffs, example pages);
      // each case projects it to exactly the fields it has always returned,
      // because that shape is what the MCP tools promise.

      case 'shallow': {
        const { targets, totalTargets } = findShallowPages(db, project, opts);
        return wrap({ targets, totalTargets });
      }

      case 'decay': {
        const { confirmedStale, unknownFreshness, monthsThreshold } = findDecayingPages(db, project, opts);
        return wrap({ confirmedStale, unknownFreshness, monthsThreshold });
      }

      case 'orphans': {
        const { orphans, totalOrphans } = findOrphanEntities(db, project);
        return wrap({ orphans, totalOrphans });
      }

      case 'entities': {
        const { gaps, shared, unique, summary } = getEntityCoverage(db, project, { minMentions: opts.minMentions });
        return wrap({ gaps, shared, unique, summary });
      }

      case 'schemas': {
        // The CLI's JSON carries more per row (the schema name on ratings and
        // pricing, rating count and currency in the matrix) and the actions;
        // this case has always returned the narrower rows and no actions.
        const r = getSchemaCoverage(db, project, { config });
        return wrap({
          coverageMatrix: Object.fromEntries(Object.entries(r.coverageMatrix).map(([domain, list]) => [
            domain,
            list.map(({ type, url, name, rating, price }) => ({ type, url, name, rating, price })),
          ])),
          gaps: r.gaps,
          exclusives: r.exclusives,
          ratings: r.ratings.map(({ domain, url, rating, ratingCount }) => ({ domain, url, rating, ratingCount })),
          pricing: r.pricing.map(({ domain, url, price, currency }) => ({ domain, url, price, currency })),
          summary: r.summary,
        });
      }

      case 'friction':
        return wrap(findFriction(db, project, opts));

      case 'velocity':
        return wrap(velocityForHarness(getPublishingVelocity(db, project, opts)));

      case 'brief':
        return wrap(briefForHarness(getCrawlBrief(db, project, { ...opts, config })));

      // ── Export commands ──

      case 'export-actions': {
        const { buildTechnicalActions } = await import('./exports/technical.js');
        return wrap({ actions: buildTechnicalActions(db, project) });
      }

      case 'competitive-actions': {
        const { buildCompetitiveActions } = await import('./exports/competitive.js');
        return wrap({ actions: buildCompetitiveActions(db, project, opts) });
      }

      case 'suggest-usecases': {
        const { buildSuggestiveActions } = await import('./exports/suggestive.js');
        return wrap({ actions: buildSuggestiveActions(db, project, opts) });
      }

      // ── Blog draft ──

      case 'blog-draft': {
        const { gatherBlogDraftContext, buildBlogDraftPrompt } = await import('./analyses/blog-draft/index.js');
        const context = await gatherBlogDraftContext(db, project, opts.topic);
        const prompt = buildBlogDraftPrompt(context, { config, lang: opts.lang || 'en', topic: opts.topic });
        return wrap({ context, prompt });
      }

      // ── Intelligence Ledger ──

      case 'insights': {
        const insights = getActiveInsights(db, project);
        return wrap({ insights, totalActive: insights.length });
      }

      // ── Headings Audit ──

      case 'headings-audit': {
        const { pages, totalPages } = auditCompetitorHeadings(db, project, opts);
        return wrap({ pages, totalPages });
      }

      // ── JS Rendering Delta ──

      case 'js-delta': {
        // This requires Playwright — return instructions if called from agent
        return fail('js-delta requires Playwright browser automation. Use the CLI: seo-intel js-delta ' + project + ' --format json');
      }

      // ── Templates ──

      case 'templates': {
        const { runTemplatesAnalysis } = await import('./analyses/templates/index.js');
        const report = await runTemplatesAnalysis(project, {
          log: opts.log || (() => {}),
          minGroupSize: opts.minGroupSize || 10,
          sampleSize: opts.sampleSize || 20,
        });
        return wrap(report);
      }

      // ── Crawl ──

      case 'crawl': {
        const { crawlDomain } = await import('./crawler/index.js');
        const config_ = readProjectConfig(project);
        if (!config_) return fail(`Project "${project}" not configured`);

        const targetUrl = config_.target.url || `https://${config_.target.domain}`;
        const maxPages = opts.maxPages || 200;
        let pagesFound = 0;
        const pageSummary = [];

        for await (const page of crawlDomain(targetUrl, {
          maxPages,
          stealth: opts.stealth || false,
          ...opts,
        })) {
          pagesFound++;
          pageSummary.push({ url: page.url, status: page.statusCode, depth: page.depth, wordCount: page.wordCount || 0 });
          if (opts.onPage) opts.onPage(page);
        }

        return wrap({ pagesFound, pages: pageSummary.slice(0, 50), targetUrl });
      }

      // ── Extract ──

      case 'extract': {
        const { extractPage, pingOllamaHost } = await import('./extractor/qwen.js');
        const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const model = opts.model || process.env.OLLAMA_MODEL || 'gemma4:e4b';

        // Preflight check
        const ping = await pingOllamaHost(ollamaHost, model).catch(() => null);
        if (!ping) return fail(`Ollama not reachable at ${ollamaHost} or model "${model}" not available`);

        // Get pages needing extraction
        const pages = db.prepare(`
          SELECT p.id, p.url, p.title, p.meta_desc, p.body_text, p.published_date, p.modified_date
          FROM pages p JOIN domains d ON d.id = p.domain_id
          LEFT JOIN extractions e ON e.page_id = p.id
          WHERE d.project = ? AND p.status_code = 200 AND p.body_text IS NOT NULL AND p.body_text != ''
            AND e.id IS NULL
          ORDER BY p.click_depth ASC
          LIMIT ?
        `).all(project, opts.limit || 500);

        if (!pages.length) return wrap({ extracted: 0, message: 'All pages already extracted' });

        let extracted = 0, failed = 0;
        for (const page of pages) {
          try {
            const headings = db.prepare('SELECT level, text FROM headings WHERE page_id = ?').all(page.id);
            const schemas = db.prepare('SELECT schema_type FROM page_schemas WHERE page_id = ?').all(page.id);

            await extractPage({
              url: page.url,
              title: page.title,
              metaDesc: page.meta_desc,
              headings: headings.map(h => ({ level: h.level, text: h.text })),
              bodyText: page.body_text,
              schemaTypes: schemas.map(s => s.schema_type),
              publishedDate: page.published_date,
              modifiedDate: page.modified_date,
            });
            extracted++;
            if (opts.onExtract) opts.onExtract({ url: page.url, index: extracted });
          } catch {
            failed++;
          }
        }

        return wrap({ extracted, failed, totalPending: pages.length });
      }

      // ── Status ──

      case 'status': {
        const projects = listProjectConfigs();
        return wrap({ projects, totalProjects: projects.length });
      }

      default:
        return fail(`Unknown command: "${command}". Available: ${capabilities.map(c => c.id).join(', ')}`);
    }
  } catch (e) {
    // A ProviderError carries the fix (the env var to set, the gateway to
    // start); an agent relaying the failure should be able to say it.
    return fail(e.hint ? `${e.message} (${e.hint})` : e.message);
  }
}
