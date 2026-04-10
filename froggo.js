/**
 * froggo.js — Agent-facing API for SEO Intel
 *
 * Single entry point for agentic platforms. Three usage levels:
 *
 * 1. Unified runner (recommended):
 *    import { run, capabilities } from 'seo-intel/froggo';
 *    const result = await run('aeo', 'myproject');
 *
 * 2. Direct function imports:
 *    import { aeo, gapIntel } from 'seo-intel/froggo';
 *
 * 3. Deep imports (tree-shakeable):
 *    import { runAeoAnalysis } from 'seo-intel/aeo';
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, getActiveInsights, getSchemasByProject } from './db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS (extracted from cli.js for agent use)
// ═══════════════════════════════════════════════════════════════════════════

/** Load project config by name. Returns null if not found. */
export function loadConfig(project) {
  if (!project || !/^[a-z0-9_-]+$/i.test(project)) return null;
  const path = join(__dirname, 'config', `${project}.json`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

/** List all configured projects. */
export function listProjects() {
  const dir = join(__dirname, 'config');
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'example.json')
      .map(f => {
        const name = f.replace('.json', '');
        const config = loadConfig(name);
        return {
          name,
          targetDomain: config?.target?.domain || null,
          competitors: (config?.competitors || []).map(c => c.domain),
        };
      });
  } catch { return []; }
}

/** Filter content pages (exclude app/dashboard URLs). */
export function isContentPage(url) {
  if (url.includes('?')) return false;
  const appPaths = ['/signup', '/login', '/register', '/onboarding', '/dashboard',
    '/app/', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults'];
  const appSubdomains = ['dashboard.', 'app.', 'customers.', 'console.'];
  if (appPaths.some(p => url.includes(p))) return false;
  if (appSubdomains.some(s => url.includes(s))) return false;
  return true;
}

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
  const config = loadConfig(project);
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
    tier: 'pro',
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
    tier: 'pro',
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
    extract: ['crawl'],
    aeo: ['crawl'],
    watch: ['crawl'],
    'gap-intel': ['crawl', 'extract'],
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
    const config = loadConfig(project);
    if (!config && !['status'].includes(command)) {
      return fail(`Project "${project}" not configured. Available: ${listProjects().map(p => p.name).join(', ')}`);
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

      case 'watch': {
        const { runWatch } = await import('./analyses/watch/index.js');
        const result = runWatch(db, project, { log: opts.log || (() => {}) });
        return wrap(result);
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

      case 'shallow': {
        const maxWords = parseInt(opts.maxWords) || 700;
        const maxDepth = parseInt(opts.maxDepth) || 2;
        const rows = db.prepare(`
          SELECT p.url, p.click_depth, p.word_count, d.domain
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND p.click_depth <= ? AND p.word_count <= ? AND p.word_count > 80
            AND p.is_indexable = 1
          ORDER BY p.click_depth ASC, p.word_count ASC
        `).all(project, maxDepth, maxWords).filter(r => isContentPage(r.url));

        return wrap({
          targets: rows.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, clickDepth: r.click_depth })),
          totalTargets: rows.length,
        });
      }

      case 'decay': {
        const monthsAgo = parseInt(opts.months) || 18;
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - monthsAgo);
        const cutoff = cutoffDate.toISOString().split('T')[0];

        const staleKnown = db.prepare(`
          SELECT p.url, p.click_depth, p.word_count, p.modified_date, d.domain
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND p.click_depth <= 2 AND p.word_count > 100
            AND p.modified_date IS NOT NULL AND p.modified_date < ?
            AND p.is_indexable = 1
          ORDER BY p.modified_date ASC
        `).all(project, cutoff).filter(r => isContentPage(r.url));

        const staleUnknown = db.prepare(`
          SELECT p.url, p.click_depth, p.word_count, d.domain
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND p.click_depth <= 2 AND p.word_count BETWEEN 300 AND 1500
            AND p.modified_date IS NULL AND p.published_date IS NULL
            AND p.is_indexable = 1
          ORDER BY p.word_count ASC LIMIT 20
        `).all(project).filter(r => isContentPage(r.url));

        return wrap({
          confirmedStale: staleKnown.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, modifiedDate: r.modified_date, clickDepth: r.click_depth })),
          unknownFreshness: staleUnknown.map(r => ({ url: r.url, domain: r.domain, wordCount: r.word_count, clickDepth: r.click_depth })),
          monthsThreshold: monthsAgo,
        });
      }

      case 'orphans': {
        const extractions = db.prepare(`
          SELECT e.primary_entities, p.url, d.domain
          FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND e.primary_entities IS NOT NULL AND e.primary_entities != ''
        `).all(project);

        const entityMap = new Map();
        for (const row of extractions) {
          let entities = [];
          try { entities = JSON.parse(row.primary_entities); } catch {}
          for (const entity of entities) {
            const key = entity.toLowerCase().trim();
            if (!entityMap.has(key)) entityMap.set(key, new Set());
            entityMap.get(key).add(row.domain);
          }
        }

        const allUrls = db.prepare(`
          SELECT p.url FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
        `).all(project).map(r => r.url.toLowerCase());

        const orphans = [];
        for (const [entity, domains] of entityMap.entries()) {
          if (domains.size < 2) continue;
          const slug = entity.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const hasDedicatedPage = allUrls.some(u => u.includes(slug));
          if (!hasDedicatedPage) {
            orphans.push({ entity, domains: [...domains], domainCount: domains.size, suggestedUrl: '/solutions/' + slug });
          }
        }
        orphans.sort((a, b) => b.domainCount - a.domainCount);

        return wrap({ orphans, totalOrphans: orphans.length });
      }

      case 'entities': {
        const minMentions = parseInt(opts.minMentions) || 2;
        const allExtractions = db.prepare(`
          SELECT e.primary_entities, d.domain, d.role, p.url
          FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]' AND e.primary_entities != ''
        `).all(project);

        const entityMap = new Map();
        for (const row of allExtractions) {
          let entities = [];
          try { entities = JSON.parse(row.primary_entities); } catch { continue; }
          for (const entity of entities) {
            const key = entity.toLowerCase().trim();
            if (key.length < 2) continue;
            if (!entityMap.has(key)) entityMap.set(key, { target: new Set(), competitor: new Set(), owned: new Set() });
            const e = entityMap.get(key);
            if (row.role === 'target') e.target.add(row.domain);
            else if (row.role === 'owned') e.owned.add(row.domain);
            else e.competitor.add(row.domain);
          }
        }

        const gaps = [], shared = [], unique = [];
        for (const [entity, data] of entityMap) {
          const compCount = data.competitor.size;
          const hasTarget = data.target.size > 0 || data.owned.size > 0;
          if (compCount >= minMentions && !hasTarget) gaps.push({ entity, competitorCount: compCount, domains: [...data.competitor] });
          else if (compCount > 0 && hasTarget) shared.push({ entity, competitorCount: compCount, targetDomains: [...data.target, ...data.owned], competitorDomains: [...data.competitor] });
          else if (compCount === 0 && hasTarget) unique.push({ entity, targetDomains: [...data.target, ...data.owned] });
        }
        gaps.sort((a, b) => b.competitorCount - a.competitorCount);

        return wrap({ gaps, shared, unique, summary: { totalEntities: entityMap.size, gapCount: gaps.length, sharedCount: shared.length, uniqueCount: unique.length } });
      }

      case 'schemas': {
        const rows = getSchemasByProject(db, project);
        const byDomain = new Map();
        for (const row of rows) {
          if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
          byDomain.get(row.domain).push(row);
        }
        const allTypes = [...new Set(rows.map(r => r.schema_type))].sort();

        let targetDomain = null;
        try { targetDomain = config?.target?.domain; } catch {}
        const targetTypes = new Set((byDomain.get(targetDomain) || []).map(s => s.schema_type));
        const compTypes = new Set(rows.filter(r => r.domain !== targetDomain).map(r => r.schema_type));
        const schemaGaps = [...compTypes].filter(t => !targetTypes.has(t));
        const exclusives = [...targetTypes].filter(t => !compTypes.has(t));

        return wrap({
          coverageMatrix: Object.fromEntries([...byDomain.entries()].map(([dom, schemas]) => [dom, schemas.map(s => ({ type: s.schema_type, url: s.url, name: s.name, rating: s.rating, price: s.price }))])),
          gaps: schemaGaps,
          exclusives,
          ratings: rows.filter(r => r.rating !== null).map(r => ({ domain: r.domain, url: r.url, rating: r.rating, ratingCount: r.rating_count })),
          pricing: rows.filter(r => r.price !== null).map(r => ({ domain: r.domain, url: r.url, price: r.price, currency: r.currency })),
          summary: { totalSchemas: rows.length, uniqueTypes: allTypes.length, domainsWithSchemas: byDomain.size, gapCount: schemaGaps.length },
        });
      }

      case 'friction': {
        const rows = db.prepare(`
          SELECT e.search_intent, e.cta_primary, e.pricing_tier, p.url, p.word_count, d.domain
          FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND e.search_intent IS NOT NULL AND e.cta_primary IS NOT NULL
          ORDER BY d.domain
        `).all(project).filter(r => isContentPage(r.url));

        const highFrictionCTAs = ['enterprise', 'sales', 'contact', 'book a demo', 'request', 'talk to'];
        const targets = rows.filter(r => {
          const cta = (r.cta_primary || '').toLowerCase();
          const intent = (r.search_intent || '').toLowerCase();
          return highFrictionCTAs.some(f => cta.includes(f)) && (intent.includes('informational') || intent.includes('commercial'));
        });

        return wrap({
          targets: targets.map(t => ({ url: t.url, domain: t.domain, searchIntent: t.search_intent, ctaPrimary: t.cta_primary, pricingTier: t.pricing_tier, wordCount: t.word_count })),
          totalAnalyzed: rows.length,
          totalHighFriction: targets.length,
        });
      }

      case 'velocity': {
        const days = parseInt(opts.days) || 30;
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

        const newPages = db.prepare(`
          SELECT d.domain, d.role, p.url, p.first_seen_at, p.published_date, p.word_count
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
          ORDER BY p.first_seen_at DESC
        `).all(project, cutoff).filter(r => isContentPage(r.url));

        const totals = db.prepare(`
          SELECT d.domain, d.role, COUNT(*) as total_pages
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND p.is_indexable = 1
          GROUP BY d.domain
        `).all(project);

        const domainNewMap = {};
        for (const np of newPages) {
          if (!domainNewMap[np.domain]) domainNewMap[np.domain] = [];
          domainNewMap[np.domain].push(np);
        }

        const velocities = totals.map(t => {
          const newCount = (domainNewMap[t.domain] || []).length;
          const ratePerWeek = days > 0 ? +(newCount / (days / 7)).toFixed(1) : 0;
          return { domain: t.domain, role: t.role, totalPages: t.total_pages, newPages: newCount, ratePerWeek };
        });

        return wrap({ velocities, period: { days, cutoff: new Date(cutoff).toISOString() } });
      }

      case 'brief': {
        const days = parseInt(opts.days) || 7;
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const compDomains = (config?.competitors || []).map(c => c.domain);

        const competitorMoves = [];
        for (const comp of compDomains) {
          const newPages = db.prepare(`
            SELECT p.url, p.word_count FROM pages p JOIN domains d ON d.id = p.domain_id
            WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
          `).all(comp, project, cutoff).filter(r => isContentPage(r.url));

          const changedPages = db.prepare(`
            SELECT p.url, p.word_count FROM pages p JOIN domains d ON d.id = p.domain_id
            WHERE d.domain = ? AND d.project = ? AND p.crawled_at > ? AND p.first_seen_at < ? AND p.is_indexable = 1
          `).all(comp, project, cutoff, cutoff).filter(r => isContentPage(r.url));

          competitorMoves.push({
            domain: comp,
            newPages: newPages.map(p => ({ url: p.url, wordCount: p.word_count })),
            changedPages: changedPages.map(p => ({ url: p.url, wordCount: p.word_count })),
          });
        }

        return wrap({ competitorMoves, period: { days, weekOf: new Date().toISOString().slice(0, 10) } });
      }

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
        const maxDepth = parseInt(opts.depth) || 2;
        const domainFilter = opts.domain ? 'AND d.domain = ?' : '';
        const params = opts.domain ? [project, maxDepth, opts.domain] : [project, maxDepth];

        const pages = db.prepare(`
          SELECT p.id, p.url, p.word_count, p.click_depth, d.domain
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'competitor'
            AND p.click_depth <= ? AND p.word_count > 200 ${domainFilter}
            AND p.is_indexable = 1
          ORDER BY d.domain, p.click_depth ASC
        `).all(...params).filter(r => isContentPage(r.url));

        const results = [];
        for (const page of pages.slice(0, 30)) {
          const headings = db.prepare('SELECT level, text FROM headings WHERE page_id = ? ORDER BY rowid ASC').all(page.id);
          if (!headings.length) continue;
          results.push({ url: page.url, domain: page.domain, wordCount: page.word_count, clickDepth: page.click_depth, headings: headings.map(h => ({ level: h.level, text: h.text })) });
        }
        return wrap({ pages: results, totalPages: results.length });
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
        const config_ = loadConfig(project);
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
        const projects = listProjects();
        return wrap({ projects, totalProjects: projects.length });
      }

      default:
        return fail(`Unknown command: "${command}". Available: ${capabilities.map(c => c.id).join(', ')}`);
    }
  } catch (e) {
    return fail(e.message);
  }
}
