/**
 * froggo.js — Agent-facing API for SEO Intel
 *
 * Pure structured data, zero chalk, zero console.log.
 * Every function returns { status, data, meta } objects that agents can consume.
 *
 * Usage:
 *   import { aeo, gapIntel, crawl, extract } from 'seo-intel/froggo';
 *   const result = await aeo(db, project, config);
 */

// ── Analysis modules ─────────────────────────────────────────────────────

export { runAeoAnalysis as aeo } from './analyses/aeo/index.js';
export { runGapIntel as gapIntel } from './analyses/gap-intel/index.js';
export { gatherBlogDraftContext as blogDraftContext } from './analyses/blog-draft/index.js';
export { buildBlogDraftPrompt as blogDraftPrompt } from './analyses/blog-draft/index.js';

// ── Export modules (structured action lists) ─────────────────────────────

export { buildTechnicalActions as technicalActions } from './exports/technical.js';
export { buildCompetitiveActions as competitiveActions } from './exports/competitive.js';
export { buildSuggestiveActions as suggestiveActions } from './exports/suggestive.js';

// ── Crawler + Extractor ──────────────────────────────────────────────────

export { crawlDomain } from './crawler/index.js';

// ── Data layer ───────────────────────────────────────────────────────────

export { getDb, getActiveInsights, upsertInsightsFromKeywords } from './db/db.js';

// ── Reports ──────────────────────────────────────────────────────────────

export { generateMultiDashboard, generateHtmlDashboard } from './reports/generate-html.js';

// ── DB query helpers ─────────────────────────────────────────────────────

export {
  getProjectDomains,
  getTargetDomains,
  getCompetitorDomains,
} from './exports/queries.js';

// ── AEO scoring (pure function, zero deps) ───────────────────────────────

export { scorePageCitability } from './analyses/aeo/scorer.js';

// ── Template analysis ────────────────────────────────────────────────────

export { runTemplatesAnalysis as templates } from './analyses/templates/index.js';
