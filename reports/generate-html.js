/**
 * SEO Intel HTML Dashboard Generator v2
 * Generates a self-contained HTML dashboard with Chart.js visualizations
 *
 * SECTIONS:
 * 1. Header Bar - Project info, status badges
 * 2. Competitive Radar - 6-axis comparison chart
 * 3. Content Volume Bar Chart - Horizontal bars by word count
 * 4. Keyword Gap Heatmap - Colored dot matrix
 * 5. Technical SEO Scorecard - Per-domain score cards
 * 6. Internal Link Graph - Top linked pages + orphan stats
 * 7. Top Keywords Table - With competitor presence
 * 8. AI Insights Panel - Recommendations cards
 */

import { writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadGscData } from './gsc-loader.js';
import { isPro } from '../lib/license.js';
import { getActiveInsights } from '../db/db.js';
import { getCitabilityScores } from '../analyses/aeo/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate HTML dashboard from database
 * @param {import('node:sqlite').DatabaseSync} db - SQLite database
 * @param {string} project - Project name (e.g., 'mysite')
 * @param {object} config - Project config
 * @returns {string} Path to generated HTML file
 */
/**
 * Gather all dashboard data for a single project
 */
function gatherProjectData(db, project, config) {
  const targetDomain = config.target.domain;
  const competitorDomains = config.competitors.map(c => c.domain);
  const allDomains = [targetDomain, ...competitorDomains];

  // Domain architecture needs the raw owned domains, so gather BEFORE merge
  const domainArch = getDomainArchitecture(db, project, config);

  // Merge owned subdomains (blog.x, docs.x) into target at the SQL level.
  // Uses a savepoint so changes are rolled back after report generation —
  // the actual DB stays intact, but ALL downstream queries see unified data.
  // Include BOTH config-owned domains AND DB role='owned' domains.
  const configOwned = (config.owned || []).map(o => o.domain);
  const dbOwned = db.prepare(
    `SELECT domain FROM domains WHERE project = ? AND role = 'owned'`
  ).all(project).map(r => r.domain);
  const ownedDomains = [...new Set([...configOwned, ...dbOwned])];
  const hasOwned = ownedDomains.length > 0;
  if (hasOwned) {
    db.prepare('SAVEPOINT owned_merge').run();
    const targetDomainId = db.prepare(
      `SELECT id FROM domains WHERE project = ? AND domain = ?`
    ).get(project, targetDomain)?.id;
    if (targetDomainId) {
      for (const ownedDomain of ownedDomains) {
        const ownedRow = db.prepare(`SELECT id FROM domains WHERE project = ? AND domain = ?`).get(project, ownedDomain);
        if (ownedRow && ownedRow.id !== targetDomainId) {
          db.prepare(`UPDATE pages SET domain_id = ? WHERE domain_id = ?`).run(targetDomainId, ownedRow.id);
          db.prepare(`DELETE FROM domains WHERE id = ?`).run(ownedRow.id);
        }
      }
    }
  }

  // Gather all data (latestAnalysis first — heatmap depends on it)
  const domains = getDomainStats(db, project, config);
  const keywords = getTopKeywords(db, project);
  const keywordGaps = getKeywordGaps(db, project);
  const latestAnalysis = getActiveInsights(db, project);
  const keywordHeatmap = getKeywordHeatmapData(db, project, allDomains, latestAnalysis);
  const technicalScores = getTechnicalScores(db, project, config);
  const internalLinks = getInternalLinkStats(db, project);
  const crawlStats = getCrawlStats(db, project);

  // Attack strategy data
  const shallowChampions = getShallowChampions(db, project);
  const decayTargets = getDecayTargets(db, project);
  const orphanEntities = getOrphanEntities(db, project);
  const frictionTargets = getFrictionTargets(db, project);

  // Extended intelligence data
  const pricingTierMap = getPricingTierMap(db, project);
  const techStackMatrix = getTechStackMatrix(db, project);
  const ctaLandscape = getCtaLandscape(db, project);
  const entityTopicMap = getEntityTopicMap(db, project);
  const schemaBreakdown = getSchemaBreakdown(db, project);

  // Advanced visualization data
  const gravityMap = getGravityMapData(db, project, config);
  const contentTerrain = getContentTerrainData(db, project);
  const keywordVenn = getKeywordVennData(db, project);
  const performanceBubbles = getPerformanceBubbleData(db, project);
  const headingFlow = getHeadingFlowData(db, project, config);
  const territoryTreemap = getTerritoryTreemapData(db, project, config);
  const topicClusters = getTopicClusterData(project); // from topic-cluster-mapper output
  const linkDna = getLinkDnaData(db, project, config);
  const linkRadarPulse = getLinkRadarPulseData(db, project, config);

  // Keyword Inventor data
  const keywordsReport = getLatestKeywordsReport(project);

  // AEO / AI Citability scores
  let citabilityData = null;
  try { citabilityData = getCitabilityScores(db, project); } catch { /* table may not exist yet */ }

  // Extraction status
  const extractionStatus = getExtractionStatus(db, project, config);

  // Google Search Console data
  const gscData = loadGscData(project);

  // GSC cross-insights (data-driven)
  const gscInsights = getGscInsights(gscData, db, project);

  // Build chart data
  const radarData = buildRadarData(domains, targetDomain, technicalScores, db, project);
  const contentVolumeData = buildContentVolumeData(domains, targetDomain);

  const result = {
    project, targetDomain, competitorDomains, allDomains,
    domains, keywords, keywordGaps, keywordHeatmap,
    technicalScores, internalLinks, latestAnalysis, crawlStats,
    radarData, contentVolumeData,
    shallowChampions, decayTargets, orphanEntities, frictionTargets,
    pricingTierMap, techStackMatrix,
    ctaLandscape, entityTopicMap, schemaBreakdown,
    gravityMap, contentTerrain, keywordVenn, performanceBubbles,
    headingFlow, territoryTreemap, topicClusters, linkDna, linkRadarPulse,
    keywordsReport, extractionStatus, gscData, domainArch, gscInsights, citabilityData,
  };

  // Rollback the owned→target merge so the actual DB is unchanged
  if (hasOwned) {
    db.prepare('ROLLBACK TO owned_merge').run();
    db.prepare('RELEASE owned_merge').run();
  }

  return result;
}

/**
 * Generate dashboard for a single project.
 * Uses the same multi-project template — just with one project (no switcher).
 */
export function generateHtmlDashboard(db, project, config) {
  // Normalise config.project — it may be absent when a new config is created
  // programmatically (e.g. by the smoke-test or setup wizard) without the field.
  // We always trust the explicit `project` argument over whatever is in config.
  const normalisedConfig = config.project === project
    ? config
    : { ...config, project };
  return generateMultiDashboard(db, [normalisedConfig]);
}

/**
 * Generate dashboard with one or more projects.
 * 1 project: no dropdown switcher. 2+: project switcher shown.
 * Always writes to all-projects-dashboard.html (single entry point).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} configs - Array of project configs
 * @returns {string} Path to generated HTML file
 */
export function generateMultiDashboard(db, configs) {
  const allProjectData = configs.map(config =>
    gatherProjectData(db, config.project, config)
  );

  const html = buildMultiHtmlTemplate(allProjectData);
  const outPath = join(__dirname, 'all-projects-dashboard.html');
  writeFileSync(outPath, html, 'utf8');
  return outPath;
}

// ─── HTML Template Builder ───────────────────────────────────────────────────

function buildHtmlTemplate(data, opts = {}) {
  const suffix = opts.suffix || '';  // '' for single-project, '-projectname' for multi
  const panelOnly = opts.panelOnly || false; // true = return body panel only (no html/head)
  const pro = isPro();

  const {
    project, targetDomain, competitorDomains, allDomains,
    domains, keywords, keywordGaps, keywordHeatmap,
    technicalScores, internalLinks, latestAnalysis, crawlStats,
    radarData, contentVolumeData,
    shallowChampions, decayTargets, orphanEntities, frictionTargets,
    pricingTierMap, techStackMatrix,
    ctaLandscape, entityTopicMap, schemaBreakdown,
    gravityMap, contentTerrain, keywordVenn, performanceBubbles,
    headingFlow, territoryTreemap, topicClusters, linkDna, linkRadarPulse,
    keywordsReport, extractionStatus, gscData, domainArch, gscInsights, citabilityData,
  } = data;

  const totalPages = domains.reduce((sum, d) => sum + d.page_count, 0);
  const lastCrawl = crawlStats.lastCrawl || 'Never';
  const analysisAge = latestAnalysis ? getRelativeTime(latestAnalysis.generated_at) : 'No analysis';

  // ── Head HTML (CSS + CDN) ──
  const headHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEO Intel ${pro ? 'Dashboard' : 'Preview'} — ${project.toUpperCase()}</title>
  <link rel="icon" type="image/png" href="/favicon.png?v=${Date.now()}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    /* ═══════════════════════════════════════════════════════════════════════
       DESIGN SYSTEM - Edit these values to customize the dashboard
       ═══════════════════════════════════════════════════════════════════════ */
    :root {
      /* Grey scale */
      --bg-primary: #0a0a0a;
      --bg-card: #111111;
      --bg-elevated: #161616;

      /* Border colors */
      --border-card: #222222;
      --border-subtle: #262626;

      /* Accent colors — warm gold + muted purple */
      --accent-gold: #e8d5a3;
      --accent-purple: #7c6deb;
      --color-success: #8ecba8;
      --color-danger: #d98e8e;
      --color-info: #8bbdd9;
      --color-warning: #d9c78b;

      /* Text colors — soft greys */
      --text-primary: #f0f0f0;
      --text-secondary: #b8b8b8;
      --text-muted: #555555;
      --text-subtle: #888888;
      --text-dark: #0a0a0a;

      /* Typography */
      --font-display: 'Syne', sans-serif;
      --font-body: 'Inter', system-ui, -apple-system, sans-serif;

      /* Spacing */
      --radius: 6px;
      --max-width: 1200px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-body);
      background: var(--bg-primary);
      color: var(--text-secondary);
      padding: 32px 24px;
      min-height: 100vh;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      font-weight: 400;
    }

    /* ─── Header Bar ─────────────────────────────────────────────────────── */
    .update-banner {
      padding: 10px 20px;
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.78rem;
      margin-bottom: 12px;
    }
    .update-banner.update-normal {
      background: rgba(232,213,163,0.06);
      border: 1px solid rgba(232,213,163,0.2);
      color: var(--accent-gold);
    }
    .update-banner.update-security {
      background: rgba(220,80,80,0.08);
      border: 1px solid rgba(220,80,80,0.25);
      color: #ff6b6b;
    }
    .update-banner .update-version { font-family: var(--font-mono); font-weight: 600; }
    .update-banner .update-changelog { font-size: 0.68rem; color: var(--text-muted); flex:1; }
    .update-banner .update-btn {
      padding: 5px 14px;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 600;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .update-banner .update-btn:hover { background: rgba(255,255,255,0.06); }
    .update-banner .update-dismiss {
      cursor: pointer; opacity: 0.5; font-size: 0.7rem;
    }
    .update-banner .update-dismiss:hover { opacity: 1; }

    .header-bar {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: var(--radius);
      padding: 24px 28px;
      margin-bottom: 32px;
      max-width: var(--max-width);
      margin-left: auto;
      margin-right: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 20px;
    }
    .header-left h1 {
      font-family: var(--font-display);
      color: var(--text-primary);
      font-size: 1.4rem;
      font-weight: 700;
      margin-bottom: 4px;
      letter-spacing: -0.02em;
    }
    .header-left .subtitle {
      color: var(--text-muted);
      font-size: 0.8rem;
      font-weight: 300;
    }
    .header-stats {
      display: flex;
      gap: 28px;
      flex-wrap: wrap;
    }
    .header-stat {
      text-align: center;
    }
    .header-stat .value {
      font-family: var(--font-display);
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--text-primary);
    }
    .header-stat .label {
      font-size: 0.65rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 500;
    }
    .header-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: var(--radius);
      font-size: 0.7rem;
      font-weight: 500;
      border: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      color: var(--text-subtle);
    }
    .status-badge.gold { border-color: rgba(232,213,163,0.3); color: var(--accent-gold); }
    .status-badge.purple { border-color: rgba(124,109,235,0.3); color: var(--accent-purple); }
    .status-badge.success { border-color: rgba(142,203,168,0.3); color: var(--color-success); }
    .status-badge.info { border-color: rgba(139,189,217,0.3); color: var(--color-info); }

    /* ─── Dashboard Grid ─────────────────────────────────────────────────── */
    .dashboard {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      max-width: var(--max-width);
      margin: 0 auto;
    }

    /* ─── Cards ──────────────────────────────────────────────────────────── */
    .card {
      background: var(--bg-card);
      border-radius: var(--radius);
      padding: 22px;
      border: 1px solid var(--border-card);
      min-width: 0;
      overflow: hidden;
    }
    .card h2 {
      font-family: var(--font-display);
      color: var(--text-primary);
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: -0.01em;
    }
    .card h2 .icon {
      font-size: 0.85rem;
      color: var(--text-muted);
      width: 1.2em;
      text-align: center;
    }
    .card.full-width {
      grid-column: 1 / -1;
    }

    /* ─── Extraction Status Bar ─────────────────────────────────────────── */
    .extraction-status {
      max-width: var(--max-width);
      margin: 0 auto 16px;
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: var(--radius);
      padding: 14px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 0.78rem;
    }
    .extraction-status.is-running {
      border-color: rgba(232,213,163,0.3);
    }
    .es-top-row {
      display: flex; align-items: center; gap: 16px; width: 100%;
    }
    .es-indicator {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--font-display); font-weight: 700;
      font-size: 0.8rem; white-space: nowrap;
      flex-shrink: 0;
    }
    .es-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--color-success);
      flex-shrink: 0;
    }
    .es-dot.running {
      background: var(--accent-gold);
      animation: pulse-dot 1.5s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(232,213,163,0.4); }
      50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(232,213,163,0); }
    }
    .es-domains {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 6px 20px;
      flex: 1;
    }
    .es-domain {
      display: flex; align-items: center; gap: 6px;
    }
    .es-domain-name {
      color: var(--text-secondary); font-size: 0.72rem;
      white-space: nowrap;
      width: 68px; min-width: 68px; flex-shrink: 0;
      overflow: hidden; text-overflow: ellipsis;
    }
    .es-domain-name.is-target { color: var(--accent-gold); }
    .es-bar-wrap {
      flex: 1; height: 5px; background: var(--border-subtle);
      border-radius: 2.5px; overflow: hidden;
    }
    .es-bar-fill {
      height: 100%; border-radius: 2.5px;
      background: var(--color-success);
      transition: width 0.3s;
    }
    .es-bar-fill.partial { background: var(--accent-gold); }
    .es-bar-fill.low { background: var(--color-danger); }
    .es-pct {
      font-size: 0.68rem; color: var(--text-muted);
      width: 32px; min-width: 32px; text-align: right; flex-shrink: 0;
    }
    .es-live {
      font-size: 0.7rem; color: var(--accent-gold);
      margin-left: auto; white-space: nowrap;
    }
    .extraction-status.is-crashed {
      border-color: rgba(239,68,68,0.3);
    }
    .es-dot.crashed {
      background: var(--color-danger);
      animation: pulse-dot 2s ease-in-out infinite;
    }
    .es-bottom-row {
      display: flex; align-items: center; gap: 12px; width: 100%;
      padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
    }
    .es-meta {
      display: flex; gap: 12px; align-items: center;
      white-space: nowrap; font-size: 0.7rem;
    }
    .es-meta-item { color: var(--text-muted); }
    .es-meta-item i { margin-right: 3px; font-size: 0.62rem; }
    .es-meta-item.skipped { color: var(--accent-blue, #7dd3e8); }
    .es-meta-item.blocked { color: var(--color-danger); }
    .es-domain.is-blocked .es-domain-name { color: var(--color-danger); text-decoration: line-through; }
    .es-domain.is-blocked .es-bar-fill { background: var(--color-danger); }

    /* ─── Extraction Controls (server mode) ──────────────────────────────── */
    .es-controls {
      display: flex; align-items: center; gap: 10px;
      margin-left: auto;
    }
    .es-controls.hidden { display: none; }
    .es-btn {
      background: var(--bg-elevated);
      border: 1px solid var(--border-card);
      color: var(--text-secondary);
      padding: 5px 14px;
      border-radius: var(--radius);
      font-family: var(--font-display);
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .es-btn:hover { border-color: var(--accent-gold); color: var(--accent-gold); }
    .es-btn-stop { border-color: var(--border-card); color: var(--text-muted); }
    .es-btn-stop:hover { border-color: var(--text-secondary); color: var(--text-secondary); }
    .es-btn-stop.active { border-color: rgba(220,80,80,0.5); color: #dc5050; animation: stopPulse 2s ease-in-out infinite; }
    .es-btn-stop.active:hover { border-color: #dc5050; color: #ff6b6b; background: rgba(220,80,80,0.08); }
    @keyframes stopPulse { 0%,100% { border-color: rgba(220,80,80,0.3); } 50% { border-color: rgba(220,80,80,0.7); } }
    .es-btn-restart { border-color: rgba(100,160,220,0.3); color: #6ca0dc; }
    .es-btn-restart:hover { border-color: #6ca0dc; color: #8fc0f0; background: rgba(100,160,220,0.08); }
    .es-btn:disabled {
      opacity: 0.4; cursor: not-allowed;
      border-color: var(--border-card);
      color: var(--text-muted);
    }
    .es-btn:disabled:hover { border-color: var(--border-card); color: var(--text-muted); }
    .es-btn.running { border-color: var(--accent-gold); color: var(--accent-gold); }
    .es-btn .fa-spinner { margin-right: 4px; }
    .es-stealth-toggle {
      display: flex; align-items: center; gap: 5px;
      font-size: 0.68rem; color: var(--text-muted);
      cursor: pointer; user-select: none;
    }
    .es-stealth-toggle input[type="checkbox"] {
      accent-color: var(--accent-purple, #7c6deb);
      width: 14px; height: 14px;
      cursor: pointer;
    }
    .es-server-note {
      font-size: 0.65rem; color: var(--text-muted);
      font-style: italic;
    }
    .es-server-note code {
      background: var(--bg-elevated);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.62rem;
    }

    /* ─── Canvas Visualizations ──────────────────────────────────────────── */
    canvas { display: block; width: 100%; height: auto; }

    /* ─── Chart Containers ───────────────────────────────────────────────── */
    .chart-container {
      position: relative;
      height: 300px;
    }
    .chart-container.tall {
      height: 340px;
    }

    /* ─── Tables ─────────────────────────────────────────────────────────── */
    .table-wrapper {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    th, td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border-card);
    }
    th {
      color: var(--text-subtle);
      font-weight: 500;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--bg-elevated);
      position: sticky;
      top: 0;
    }
    th:first-child { border-radius: var(--radius) 0 0 0; }
    th:last-child { border-radius: 0 var(--radius) 0 0; }
    tr:hover td {
      background: rgba(255,255,255,0.02);
    }
    td {
      color: var(--text-secondary);
    }

    /* ─── Badges ─────────────────────────────────────────────────────────── */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 0.65rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-high { background: rgba(217,142,142,0.15); color: var(--color-danger); }
    .badge-medium { background: rgba(232,213,163,0.12); color: var(--accent-gold); }
    .badge-low { background: rgba(142,203,168,0.12); color: var(--color-success); }
    .badge-target { background: rgba(232,213,163,0.15); color: var(--accent-gold); }
    .badge-competitor { background: rgba(124,109,235,0.15); color: var(--accent-purple); }

    /* ─── Insight Actions (Intelligence Ledger) ──────────────────────────── */
    .insight-action { display: flex; gap: 4px; }
    .insight-btn {
      width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border-card);
      background: transparent; color: var(--text-muted); cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 0.6rem;
      transition: all 0.2s ease; padding: 0;
    }
    .insight-btn:hover { border-color: var(--accent-gold); color: var(--accent-gold); }
    .insight-btn.btn-done:hover { border-color: var(--color-success); color: var(--color-success); }
    .insight-btn.btn-dismiss:hover { border-color: var(--color-danger); color: var(--color-danger); }
    tr.insight-done { opacity: 0.3; text-decoration: line-through; }
    .new-page-card.insight-done, .positioning-card.insight-done { opacity: 0.3; }
    .insight-age { font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; }

    /* ─── Heatmap Dots ───────────────────────────────────────────────────── */
    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot.present { background: var(--color-success); }
    .dot.partial { background: var(--accent-gold); }
    .dot.missing { background: rgba(217,142,142,0.5); }
    .dot.na { background: var(--border-subtle); }

    /* ─── Scorecard Grid ─────────────────────────────────────────────────── */
    .scorecard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .score-card {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 16px;
      border: 1px solid var(--border-card);
    }
    .score-card .domain-name {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .score-card .score {
      font-family: var(--font-display);
      font-size: 1.6rem;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .score-card .score.green { color: var(--color-success); }
    .score-card .score.yellow { color: var(--accent-gold); }
    .score-card .score.red { color: var(--color-danger); }
    .score-card .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      font-size: 0.7rem;
    }
    .score-card .metric {
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
    }
    .score-card .metric .val { color: var(--text-secondary); }

    /* ─── Stats Grid ─────────────────────────────────────────────────────── */
    .stat-row {
      display: flex;
      gap: 12px;
      margin-bottom: 14px;
    }
    .stat-box {
      flex: 1;
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 14px;
      text-align: center;
    }
    .stat-box .value {
      font-family: var(--font-display);
      font-size: 1.4rem;
      font-weight: 700;
      color: var(--text-primary);
    }
    .stat-box .label {
      font-size: 0.65rem;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    /* ─── AI Insights Cards ──────────────────────────────────────────────── */
    .insights-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .insight-card {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 16px;
      border-left: 3px solid var(--border-subtle);
    }
    .insight-card.high { border-left-color: var(--color-danger); }
    .insight-card.medium { border-left-color: var(--accent-gold); }
    .insight-card.low { border-left-color: var(--color-success); }
    .insight-card .insight-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .insight-card .insight-icon {
      font-size: 1.1rem;
    }
    .insight-card .insight-title {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 0.88rem;
      flex: 1;
    }
    .insight-card .insight-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* ─── Positioning ───────────────────────────────────────────────────── */
    .positioning-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .positioning-block {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 16px;
      border-left: 3px solid var(--border-subtle);
    }
    .positioning-block.highlight {
      border-left-color: var(--accent-gold);
      background: rgba(232,213,163,0.03);
    }
    .positioning-block.full {
      grid-column: 1 / -1;
      border-left-color: var(--border-subtle);
    }
    .positioning-label {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .positioning-text {
      font-size: 0.88rem;
      color: var(--text-primary);
      line-height: 1.6;
    }
    .positioning-text.muted { color: var(--text-secondary); font-size: 0.82rem; }

    /* ─── Analysis Tables ────────────────────────────────────────────────── */
    .analysis-table-wrap { overflow-x: auto; }
    .analysis-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.78rem;
    }
    .analysis-table th {
      text-align: left;
      padding: 8px 10px;
      background: var(--bg-elevated);
      color: var(--text-muted);
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 500;
      border-bottom: 1px solid var(--border-subtle);
    }
    .analysis-table td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-card);
      color: var(--text-secondary);
      vertical-align: top;
    }
    .analysis-table tr:last-child td { border-bottom: none; }
    .analysis-table tr:hover td { background: rgba(255,255,255,0.015); }
    .analysis-table .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.72rem; color: var(--accent-gold); }
    .phrase-cell { color: var(--text-primary); font-style: italic; min-width: 200px; }
    .placement-cell { min-width: 140px; }
    .placement-url { font-family: 'SF Mono', monospace; font-size: 0.68rem; color: var(--text-muted); display: block; margin-top: 2px; }

    /* ─── Property Tags ──────────────────────────────────────────────────── */
    .prop-tag {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 3px;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .prop-main  { background: rgba(232,213,163,0.1); color: var(--accent-gold); }
    .prop-blog  { background: rgba(124,109,235,0.1); color: var(--accent-purple); }
    .prop-docs  { background: rgba(139,189,217,0.1); color: var(--color-info); }
    .type-tag {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--bg-elevated);
      color: var(--text-muted);
      font-size: 0.65rem;
    }
    .comp-tag {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(255,255,255,0.04);
      color: var(--text-secondary);
      font-size: 0.65rem;
      margin-right: 3px;
    }

    /* ─── New Pages Grid ─────────────────────────────────────────────────── */
    .new-pages-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .new-page-card {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 16px;
      border-top: 2px solid var(--border-subtle);
    }
    .new-page-card.priority-high   { border-top-color: var(--color-danger); }
    .new-page-card.priority-medium { border-top-color: var(--accent-gold); }
    .new-page-card.priority-low    { border-top-color: var(--color-success); }
    .new-page-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
    }
    .new-page-title {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 0.88rem;
      flex: 1;
    }
    .new-page-keyword {
      font-size: 0.75rem;
      color: var(--accent-gold);
      margin-bottom: 6px;
    }
    .new-page-angle {
      font-size: 0.78rem;
      color: var(--text-secondary);
      line-height: 1.6;
      margin-bottom: 10px;
    }
    .placement-ranks { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; border-top: 1px solid var(--border-card); padding-top: 10px; }
    .placement-rank {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 0.72rem;
    }
    .rank-num { flex-shrink: 0; }
    .rank-url { font-family: 'SF Mono', monospace; color: var(--text-primary); flex-shrink: 0; font-size: 0.7rem; }
    .rank-reason { color: var(--text-muted); font-size: 0.68rem; line-height: 1.4; }

    /* ─── Content Gap extras ─────────────────────────────────────────────── */
    .covered-by { margin-top: 6px; font-size: 0.68rem; color: var(--text-muted); }
    .suggested-title {
      margin-top: 6px;
      font-size: 0.75rem;
      color: var(--color-info);
      font-style: italic;
    }

    /* ─── Empty States ───────────────────────────────────────────────────── */
    .empty-state {
      text-align: center;
      color: var(--text-muted);
      padding: 32px 16px;
      font-size: 0.82rem;
    }

    /* ─── Footer ─────────────────────────────────────────────────────────── */
    .timestamp {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.68rem;
      margin-top: 40px;
      padding: 16px;
      max-width: var(--max-width);
      margin-left: auto;
      margin-right: auto;
    }

    /* ─── Attack Strategy Cards ───────────────────────────────────────────── */
    .attack-desc {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 12px;
      line-height: 1.6;
    }
    .attack-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 7px;
      border-radius: 11px;
      background: rgba(124,109,235,0.15);
      color: var(--accent-purple);
      font-size: 0.65rem;
      font-weight: 600;
    }
    .attack-table-wrap { max-height: 320px; overflow-y: auto; }
    .empty-hint { color: var(--text-muted); font-size: 0.75rem; font-style: italic; padding: 10px 0; }

    .orphan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .orphan-card {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 12px;
      border-left: 2px solid var(--accent-purple);
    }
    .orphan-entity { font-weight: 500; color: var(--text-primary); font-size: 0.82rem; margin-bottom: 5px; text-transform: capitalize; }
    .orphan-domains { margin-bottom: 6px; }
    .orphan-suggestion { font-family: 'SF Mono', monospace; font-size: 0.7rem; color: var(--accent-gold); }

    /* ─── Button Tile Grid (shared: intent, perf, health) ──────────────── */
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .btn-tile {
      background: var(--bg-elevated);
      border-radius: var(--radius);
      padding: 12px;
      border: 1px solid var(--border-card);
    }
    .btn-tile.is-target { border-color: rgba(232,213,163,0.2); }
    .btn-tile-head {
      display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
    }
    .btn-tile-name {
      font-size: 0.75rem; font-weight: 500; color: var(--text-primary);
    }
    .btn-tile-meta {
      font-size: 0.6rem; color: var(--text-muted); margin-top: 4px;
    }

    /* ─── Search Intent (inside btn-tile) ─────────────────────────────── */
    .intent-bars { display: flex; height: 16px; border-radius: 3px; overflow: hidden; gap: 1px; }
    .intent-bar {
      display: flex; align-items: center; justify-content: center;
      font-size: 0.52rem; font-weight: 500; color: var(--text-dark);
    }
    .intent-informational { background: var(--color-info); }
    .intent-commercial { background: var(--accent-gold); }
    .intent-transactional { background: var(--color-success); }
    .intent-navigational { background: var(--accent-purple); color: var(--text-primary); }
    .intent-label { font-size: 0.55rem; color: var(--text-muted); margin-right: 6px; }
    .intent-label.intent-informational { color: var(--color-info); }
    .intent-label.intent-commercial { color: var(--accent-gold); }
    .intent-label.intent-transactional { color: var(--color-success); }
    .intent-label.intent-navigational { color: var(--accent-purple); }

    /* ─── Pricing Tier Map ────────────────────────────────────────────────── */
    .tier-grid { display: flex; flex-direction: column; gap: 12px; }
    .tier-domain-name { font-size: 0.78rem; color: var(--text-primary); font-weight: 500; margin-bottom: 6px; }
    .tier-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .tier-tag {
      display: inline-block; padding: 3px 10px; border-radius: 3px;
      font-size: 0.68rem; font-weight: 500; text-transform: capitalize;
    }
    .tier-tag small { opacity: 0.7; margin-left: 3px; }
    .tier-free       { background: rgba(142,203,168,0.12); color: var(--color-success); }
    .tier-freemium   { background: rgba(139,189,217,0.12); color: var(--color-info); }
    .tier-paid       { background: rgba(232,213,163,0.12); color: var(--accent-gold); }
    .tier-enterprise { background: rgba(217,142,142,0.12); color: var(--color-danger); }

    /* ─── Page Performance (inside btn-tile) ──────────────────────────── */
    .perf-avg { font-family: var(--font-display); font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
    .perf-unit { font-size: 0.6rem; font-weight: 400; color: var(--text-muted); margin-left: 2px; }
    .perf-bars { display: flex; height: 10px; border-radius: 3px; overflow: hidden; gap: 1px; margin: 5px 0 2px; }
    .perf-segment {
      display: flex; align-items: center; justify-content: center;
      font-size: 0.5rem; color: var(--text-dark); font-weight: 500;
      min-width: 0;
    }
    .perf-fast { background: var(--color-success); }
    .perf-mid  { background: var(--accent-gold); }
    .perf-slow { background: var(--color-danger); }

    /* ─── Site Health (inside btn-tile) ───────────────────────────────── */
    .health-stats { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 5px; }
    .health-stat {
      font-family: var(--font-display); font-size: 0.82rem; font-weight: 600;
    }
    .health-stat small { font-size: 0.52rem; font-weight: 400; font-family: var(--font-body); margin-left: 1px; }
    .health-ok { color: var(--color-success); }
    .health-redirect { color: var(--accent-gold); }
    .health-error { color: var(--color-danger); }
    .health-noindex { color: var(--text-muted); }
    .health-bar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; gap: 1px; }
    .health-seg { min-width: 0; }
    .health-seg.health-ok { background: var(--color-success); }
    .health-seg.health-redirect { background: var(--accent-gold); }
    .health-seg.health-error { background: var(--color-danger); }

    /* ─── Entity Topic Map ────────────────────────────────────────────────── */
    .entity-map-grid { display: flex; flex-direction: column; gap: 16px; }
    .entity-map-name { font-size: 0.78rem; color: var(--text-primary); font-weight: 500; margin-bottom: 6px; }
    .entity-tags { display: flex; flex-wrap: wrap; gap: 5px; }
    .entity-tag {
      display: inline-block; padding: 2px 8px; border-radius: 3px;
      font-size: 0.65rem; text-transform: capitalize;
    }
    .entity-tag.shared { background: rgba(124,109,235,0.12); color: var(--accent-purple); }
    .entity-tag.unique { background: rgba(255,255,255,0.04); color: var(--text-muted); }

    /* ═══ GOOGLE SEARCH CONSOLE ═══ */
    .gsc-stat-bar {
      display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;
    }
    .gsc-stat {
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: var(--radius); padding: 0.75rem 1.25rem;
      display: flex; flex-direction: column; align-items: center; min-width: 120px; flex: 1;
    }
    .gsc-stat-number {
      font-size: 1.6rem; font-weight: 700; font-family: var(--font-display); color: var(--accent-gold);
    }
    .gsc-stat-label {
      font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.15rem;
    }
    .gsc-stat-number.clicks { color: var(--color-info); }
    .gsc-stat-number.impressions { color: var(--accent-purple); }
    .gsc-stat-number.ctr { color: var(--color-success); }
    .gsc-stat-number.position { color: var(--accent-gold); }
    .gsc-date-range {
      font-size: 0.72rem; color: var(--text-muted); margin-bottom: 0.5rem; text-align: right;
    }
    .gsc-query-bar {
      display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
    }
    .gsc-query-bar-fill {
      height: 5px; border-radius: 3px; min-width: 2px; transition: width 0.3s;
    }
    .gsc-query-bar-fill.imp { background: var(--accent-purple); opacity: 0.6; }
    .gsc-query-bar-fill.clk { background: var(--color-info); }
    .gsc-pos-badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.68rem;
      font-weight: 600; font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .gsc-pos-top3 { background: rgba(142,203,168,0.15); color: var(--color-success); }
    .gsc-pos-top10 { background: rgba(139,189,217,0.15); color: var(--color-info); }
    .gsc-pos-top20 { background: rgba(217,199,139,0.15); color: var(--color-warning); }
    .gsc-pos-deep { background: rgba(217,142,142,0.12); color: var(--color-danger); }
    .gsc-device-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
    }
    .gsc-device-card {
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: var(--radius); padding: 1rem; text-align: center;
    }
    .gsc-device-icon { font-size: 1.4rem; margin-bottom: 0.5rem; color: var(--text-muted); }
    .gsc-device-name { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }
    .gsc-device-clicks { font-size: 1.3rem; font-weight: 700; font-family: var(--font-display); color: var(--color-info); }
    .gsc-device-imp { font-size: 0.78rem; color: var(--text-muted); }
    .gsc-device-ctr { font-size: 0.75rem; color: var(--color-success); margin-top: 0.2rem; }
    .gsc-page-url {
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.7rem; color: var(--accent-gold);
      max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .gsc-country-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .gsc-country-name { font-size: 0.78rem; color: var(--text-secondary); min-width: 120px; }
    .gsc-country-bar-wrap { flex: 1; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .gsc-country-bar { height: 100%; border-radius: 3px; background: var(--accent-purple); opacity: 0.7; }
    .gsc-country-val { font-size: 0.7rem; color: var(--text-muted); min-width: 48px; text-align: right; font-family: 'SF Mono', 'Fira Code', monospace; }
    .gsc-notice {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; border-radius: var(--radius);
      background: var(--bg-elevated); border: 1px dashed var(--border-subtle);
      font-size: 0.78rem; color: var(--text-muted);
    }
    .gsc-notice i.fa-chart-line { color: var(--text-muted); font-size: 0.85rem; }
    .gsc-notice-info {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%;
      background: var(--border-subtle); color: var(--text-subtle);
      font-size: 0.65rem; cursor: pointer; flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .gsc-notice-info:hover { background: var(--accent-gold); color: var(--text-dark); }
    .gsc-notice-tooltip {
      display: none; position: absolute; left: -20px; top: 130%;
      width: 280px; padding: 12px 14px;
      background: var(--bg-card); border: 1px solid var(--border-card);
      border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-size: 0.72rem; color: var(--text-secondary); line-height: 1.6;
      z-index: 100; text-align: left;
    }
    .gsc-notice-tooltip::after {
      content: ''; position: absolute; left: 28px; bottom: 100%;
      border: 6px solid transparent;
      border-bottom-color: var(--border-card);
    }
    .gsc-notice-info:hover .gsc-notice-tooltip { display: block; }
    .gsc-notice-tooltip code {
      background: var(--bg-elevated); padding: 1px 5px; border-radius: 3px;
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.68rem;
    }
    .gsc-update-tooltip {
      display: none; position: absolute; right: 0; top: 130%;
      width: 320px; padding: 14px 16px;
      background: var(--bg-card); border: 1px solid var(--border-card);
      border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-size: 0.72rem; color: var(--text-secondary); line-height: 1.7;
      z-index: 100; text-align: left;
    }
    .gsc-update-tooltip::after {
      content: ''; position: absolute; right: 20px; bottom: 100%;
      border: 6px solid transparent;
      border-bottom-color: var(--border-card);
    }
    .gsc-update-wrap.open .gsc-update-tooltip { display: block; }

    /* ═══ DOMAIN ARCHITECTURE ═══ */
    .da-domains-row {
      display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 1.2rem;
    }
    .da-domain-chip {
      display: flex; align-items: center; gap: 8px;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: var(--radius); padding: 8px 14px;
      font-size: 0.78rem; flex: 1; min-width: 160px;
    }
    .da-domain-chip.is-target { border-color: var(--accent-gold); }
    .da-domain-chip .da-role {
      font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 1px 6px; border-radius: 3px;
    }
    .da-domain-chip.is-target .da-role { background: rgba(232,213,163,0.15); color: var(--accent-gold); }
    .da-domain-chip.is-owned .da-role { background: rgba(139,189,217,0.12); color: var(--color-info); }
    .da-domain-name { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; color: var(--text-primary); }
    .da-domain-meta { font-size: 0.68rem; color: var(--text-muted); margin-left: auto; white-space: nowrap; }
    .da-combined-bar {
      display: flex; gap: 1rem; margin-bottom: 1.2rem; flex-wrap: wrap;
    }
    .da-combined-stat {
      display: flex; flex-direction: column; align-items: center;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: var(--radius); padding: 0.6rem 1rem; min-width: 100px; flex: 1;
    }
    .da-combined-num { font-size: 1.2rem; font-weight: 700; font-family: var(--font-display); color: var(--accent-gold); }
    .da-combined-label { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .da-warning {
      display: flex; gap: 10px; padding: 10px 14px; border-radius: var(--radius);
      margin-bottom: 8px; font-size: 0.78rem; line-height: 1.55;
      border-left: 3px solid;
    }
    .da-warning.severity-high { background: rgba(217,142,142,0.06); border-left-color: var(--color-danger); }
    .da-warning.severity-medium { background: rgba(217,199,139,0.06); border-left-color: var(--color-warning); }
    .da-warning.severity-low { background: rgba(139,189,217,0.06); border-left-color: var(--color-info); }
    .da-warning-icon { flex-shrink: 0; margin-top: 2px; }
    .da-warning.severity-high .da-warning-icon { color: var(--color-danger); }
    .da-warning.severity-medium .da-warning-icon { color: var(--color-warning); }
    .da-warning.severity-low .da-warning-icon { color: var(--color-info); }
    .da-warning-title { font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
    .da-warning-detail { color: var(--text-secondary); font-size: 0.75rem; }
    .da-warning-fix {
      margin-top: 4px; font-size: 0.72rem; color: var(--text-muted);
      padding-left: 14px; border-left: 2px solid var(--border-subtle);
    }
    .da-warning-fix strong { color: var(--text-subtle); font-weight: 600; }

    /* ═══ GSC INSIGHTS ═══ */
    .gsc-insight-block {
      margin-bottom: 16px; padding: 14px 16px;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: var(--radius); border-left: 3px solid;
    }
    .gsc-insight-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
    }
    .gsc-insight-header i { font-size: 0.8rem; }
    .gsc-insight-title { font-size: 0.82rem; font-weight: 600; color: var(--text-primary); }
    .gsc-insight-summary { font-size: 0.75rem; color: var(--text-secondary); line-height: 1.55; margin-bottom: 8px; }
    .gsc-insight-items { display: flex; flex-direction: column; gap: 4px; }
    .gsc-insight-item {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 4px 10px; border-radius: 3px; background: rgba(255,255,255,0.015);
      font-size: 0.73rem;
    }
    .gsc-insight-item-label {
      color: var(--text-primary); font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%;
    }
    .gsc-insight-item-detail {
      color: var(--text-muted); font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.68rem; white-space: nowrap;
    }
    .gsc-insight-item.severity-high { border-left: 2px solid var(--color-danger); }
    .gsc-insight-item.severity-medium { border-left: 2px solid var(--color-warning); }

    /* ═══ SECTION DIVIDERS ═══ */
    .section-divider {
      grid-column: 1 / -1;
      display: flex; align-items: center; gap: 14px;
      padding: 28px 0 8px;
    }
    .section-divider-line {
      flex: 1; height: 1px;
      background: linear-gradient(90deg, var(--border-subtle) 0%, transparent 100%);
    }
    .section-divider-line.right {
      background: linear-gradient(90deg, transparent 0%, var(--border-subtle) 100%);
    }
    .section-divider-label {
      display: flex; align-items: center; gap: 7px;
      font-family: var(--font-display); font-size: 0.62rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: var(--text-muted); white-space: nowrap;
    }
    .section-divider-label i {
      font-size: 0.55rem; opacity: 0.6;
    }

    /* ─── Responsive ─────────────────────────────────────────────────────── */
    @media (max-width: 900px) {
      .dashboard {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      body { padding: 16px 12px; }
      .header-bar {
        flex-direction: column;
        text-align: center;
      }
      .header-stats {
        justify-content: center;
      }
      .positioning-grid {
        grid-template-columns: 1fr;
      }
    }

    /* ═══ KEYWORD INVENTOR ═══ */
    .ki-stat-bar {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .ki-stat {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 0.75rem 1.25rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 110px;
    }
    .ki-stat-number {
      font-size: 1.75rem;
      font-weight: 700;
      font-family: var(--font-display);
      color: var(--accent-gold);
    }
    .ki-stat-label {
      font-size: 0.72rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 0.2rem;
    }
    .ki-summary-box {
      background: var(--bg-elevated);
      border-left: 3px solid var(--accent-gold);
      border-radius: 0 var(--radius) var(--radius) 0;
      padding: 1rem 1.25rem;
      color: var(--text-secondary);
      font-size: 0.9rem;
      margin-bottom: 1.5rem;
      line-height: 1.6;
    }
    .ki-agent-block {
      background: #1a0a2e;
      border: 2px solid #e8d5a3;
      border-radius: var(--radius);
      padding: 1.25rem 1.5rem;
      margin-bottom: 1.5rem;
    }
    .ki-agent-block h3 {
      font-family: var(--font-display);
      color: #e8d5a3;
      font-size: 1rem;
      margin-bottom: 0.5rem;
    }
    .ki-agent-note {
      font-size: 0.8rem;
      color: #a78bcc;
      margin-bottom: 1rem;
      font-style: italic;
    }
    .ki-agent-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .ki-agent-list li {
      background: rgba(124, 109, 235, 0.15);
      border: 1px solid rgba(124, 109, 235, 0.3);
      border-radius: 4px;
      padding: 0.5rem 0.85rem;
      color: #d0c0f0;
      font-size: 0.88rem;
      font-style: italic;
    }
    .ki-quick-targets {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .ki-pill {
      background: rgba(232, 213, 163, 0.12);
      border: 1px solid rgba(232, 213, 163, 0.3);
      color: var(--accent-gold);
      border-radius: 999px;
      padding: 0.3rem 0.85rem;
      font-size: 0.82rem;
    }
    .ki-filter-bar {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 0.75rem;
    }
    .ki-filter-btn {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      border-radius: var(--radius);
      padding: 0.3rem 0.85rem;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ki-filter-btn:hover,
    .ki-filter-btn.active {
      background: var(--accent-purple);
      border-color: var(--accent-purple);
      color: #fff;
    }
    .ki-type-badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .ki-type-traditional { background: #2a2a2a; color: #aaa; }
    .ki-type-perplexity  { background: #0d2d3d; color: #7dd3e8; }
    .ki-type-agent       { background: #2a0a3e; color: #cc77ff; }
    .ki-priority-high   { color: var(--color-success); font-weight: 600; }
    .ki-priority-medium { color: var(--color-warning); }
    .ki-priority-low    { color: var(--text-muted); }


    /* ─── Integrated terminal ────────────────────────────────────────── */
    .term-btn {
      font-size: 0.6rem; font-family: var(--font-body);
      background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle);
      color: var(--text-muted); padding: 3px 10px; border-radius: 4px;
      cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    .term-btn:hover { border-color: var(--accent-gold); color: var(--accent-gold); }
    .term-btn:active { background: rgba(232,213,163,0.1); }
    .term-btn i { margin-right: 3px; font-size: 0.55rem; }

    /* ─── Terminal + Export split layout ───────────────────────────────── */
    .term-split {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 0;
      max-width: var(--max-width);
      margin: 12px auto;
    }
    .term-split .terminal-main {
      min-width: 0;
    }
    .term-split .export-sidebar {
      background: #0e0e0e;
      border: 1px solid var(--border-card);
      border-left: none;
      border-radius: 0 var(--radius) var(--radius) 0;
      display: flex;
      flex-direction: column;
    }
    .term-split .terminal-main > div {
      border-radius: var(--radius) 0 0 var(--radius);
    }
    .export-sidebar-header {
      padding: 6px 12px;
      background: #161616;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 0.6rem;
      color: var(--text-muted);
      font-family: var(--font-body);
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .export-sidebar-btns {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .export-btn {
      background: #1a1a1a;
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 8px 10px;
      font-size: 0.68rem;
      cursor: pointer;
      transition: all 0.15s;
      text-align: left;
      font-family: var(--font-body);
    }
    .export-btn:hover { border-color: var(--accent-gold); color: var(--accent-gold); }
    .export-btn i { margin-right: 5px; font-size: 0.6rem; }
    .export-btn.active { border-color: var(--accent-gold); color: var(--accent-gold); background: rgba(232,213,163,0.06); }
    .export-viewer {
      flex: 1;
      padding: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.66rem;
      line-height: 1.7;
      color: var(--text-muted);
      overflow-y: auto;
      max-height: 400px;
    }
    .export-viewer h1, .export-viewer h2, .export-viewer h3 { color: var(--text-primary); margin: 12px 0 6px; font-family: var(--font-display); font-size: 0.8rem; }
    .export-viewer h2 { font-size: 0.75rem; }
    .export-viewer h3 { font-size: 0.7rem; }
    .export-viewer ul { margin: 0 0 8px 14px; }
    .export-viewer li { margin-bottom: 4px; color: var(--text-secondary); }
    .export-viewer pre { background: #0c0c0c; border: 1px solid var(--border-subtle); padding: 8px; border-radius: 4px; overflow: auto; font-size: 0.62rem; }
    .export-viewer code { color: var(--accent-gold); }
    .export-viewer p { margin-bottom: 8px; color: var(--text-secondary); }
    @media (max-width: 960px) {
      .term-split { grid-template-columns: 1fr; }
      .term-split .terminal-main > div { border-radius: var(--radius) var(--radius) 0 0; }
      .export-sidebar { border-left: 1px solid var(--border-card); border-top: none; border-radius: 0 0 var(--radius) var(--radius); }
    }

    /* Action exports integrated into terminal panel — CSS cleaned up */

  </style>
</head>`;

  // ── Free tier: structural audit dashboard (crawl data only, no extractions/analysis) ──
  if (!pro) {
    // All queries use only: pages, technical, links, headings, page_schemas
    // No joins to extractions or analyses tables.

    const targetPages = (() => {
      try {
        return db.prepare(`
          SELECT p.url, p.status_code, p.word_count, p.load_ms, p.click_depth, p.is_indexable,
                 h.text as h1,
                 t.has_canonical, t.has_og_tags, t.has_schema
          FROM pages p
          JOIN domains d ON d.id = p.domain_id
          LEFT JOIN (
            SELECT page_id, MIN(text) as text FROM headings WHERE level = 1 GROUP BY page_id
          ) h ON h.page_id = p.id
          LEFT JOIN technical t ON t.page_id = p.id
          WHERE d.project = ? AND d.role = 'target'
          ORDER BY p.click_depth, p.url LIMIT 100
        `).all(project);
      } catch { return []; }
    })();

    const techCoverage = (() => {
      try {
        return db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(t.has_canonical) as canonical,
            SUM(t.has_og_tags) as og,
            SUM(t.has_schema) as schema,
            SUM(t.has_robots) as robots
          FROM technical t
          JOIN pages p ON p.id = t.page_id
          JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'target'
        `).get(project) || {};
      } catch { return {}; }
    })();

    const h1Stats = (() => {
      try {
        const total = db.prepare(`
          SELECT COUNT(*) as c FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'target' AND p.is_indexable = 1
        `).get(project)?.c || 0;
        const withH1 = db.prepare(`
          SELECT COUNT(DISTINCT p.id) as c FROM pages p
          JOIN domains d ON d.id = p.domain_id
          JOIN headings h ON h.page_id = p.id AND h.level = 1
          WHERE d.project = ? AND d.role = 'target' AND p.is_indexable = 1
        `).get(project)?.c || 0;
        return { total, withH1, withoutH1: total - withH1 };
      } catch { return { total: 0, withH1: 0, withoutH1: 0 }; }
    })();

    const topLinkedPages = (() => {
      try {
        return db.prepare(`
          SELECT l.target_url, COUNT(*) as inbound
          FROM links l
          WHERE l.is_internal = 1
            AND l.source_id IN (
              SELECT p.id FROM pages p JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ? AND d.role = 'target'
            )
          GROUP BY l.target_url
          ORDER BY inbound DESC LIMIT 15
        `).all(project);
      } catch { return []; }
    })();

    const orphanPages = (() => {
      try {
        return db.prepare(`
          SELECT p.url FROM pages p
          JOIN domains d ON d.id = p.domain_id
          LEFT JOIN links l ON l.target_url = p.url AND l.is_internal = 1
          WHERE d.project = ? AND d.role = 'target' AND p.is_indexable = 1 AND l.id IS NULL
          LIMIT 30
        `).all(project);
      } catch { return []; }
    })();

    const schemaTypes = (() => {
      try {
        return db.prepare(`
          SELECT ps.schema_type, COUNT(*) as count FROM page_schemas ps
          JOIN pages p ON ps.page_id = p.id
          JOIN domains d ON d.id = p.domain_id
          WHERE d.project = ? AND d.role = 'target'
          GROUP BY ps.schema_type ORDER BY count DESC
        `).all(project);
      } catch { return []; }
    })();

    const allTargetPages = targetPages;
    const indexedPages = allTargetPages.filter(p => p.is_indexable).length;
    const errorPages = allTargetPages.filter(p => (p.status_code || 0) >= 400).length;
    const deepPages = allTargetPages.filter(p => (p.click_depth || 0) > 3).length;
    const missingCanonical = techCoverage.total
      ? techCoverage.total - (techCoverage.canonical || 0) : 0;
    const avgWordCount = allTargetPages.length
      ? Math.round(allTargetPages.reduce((s, p) => s + (p.word_count || 0), 0) / allTargetPages.length)
      : 0;
    const avgLoad = allTargetPages.length
      ? Math.round(allTargetPages.reduce((s, p) => s + (p.load_ms || 0), 0) / allTargetPages.length)
      : 0;

    const issues = errorPages + h1Stats.withoutH1 + (missingCanonical > (techCoverage.total || 1) * 0.2 ? 1 : 0) + deepPages;

    const HIGH_VALUE_SCHEMA = [
      { type: 'FAQPage', label: 'FAQPage', benefit: 'SERP accordion eligibility' },
      { type: 'BreadcrumbList', label: 'BreadcrumbList', benefit: 'Breadcrumb rich results' },
      { type: 'Organization', label: 'Organization', benefit: 'Knowledge panel' },
      { type: 'Product', label: 'Product', benefit: 'Price/rating in search results' },
      { type: 'Article', label: 'Article', benefit: 'News/blog rich results' },
    ];
    const foundSchemaTypes = new Set(schemaTypes.map(s => s.schema_type));

    const panelHtml = `
    <div class="project-panel" data-project="${project}">
    <div style="max-width:var(--max-width);margin:0 auto;">

      <!-- HEADER -->
      <div class="header-bar" id="header">
        <div class="header-left">
          <h1>SEO Intel <span style="font-size:0.5em;color:var(--text-muted);font-weight:400;vertical-align:middle;">Structural Audit</span></h1>
          <div class="subtitle">Project: ${project.toUpperCase()} | Target: ${targetDomain}</div>
        </div>
        <div class="header-badges">
          <span class="status-badge" style="background:rgba(139,189,217,0.12);color:var(--color-info);border:1px solid rgba(139,189,217,0.2);">Free Tier</span>
          <span class="status-badge gold">Last Crawl: ${lastCrawl}</span>
        </div>
      </div>

      <!-- SUMMARY CARDS -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:16px 0;">
        <div style="background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);padding:16px 12px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:1.4rem;color:var(--text-primary);">${indexedPages}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);">Pages Indexed</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);padding:16px 12px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:1.4rem;color:${errorPages > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">${errorPages}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);">Error Pages</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);padding:16px 12px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:1.4rem;color:${h1Stats.withoutH1 > 0 ? 'var(--color-warning)' : 'var(--color-success)'};">${h1Stats.withoutH1}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);">Missing H1</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);padding:16px 12px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:1.4rem;color:${avgWordCount < 300 ? 'var(--color-danger)' : avgWordCount < 800 ? 'var(--color-warning)' : 'var(--color-success)'};">${avgWordCount}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);">Avg Words</div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);padding:16px 12px;text-align:center;">
          <div style="font-family:var(--font-display);font-size:1.4rem;color:${issues > 3 ? 'var(--color-danger)' : issues > 0 ? 'var(--color-warning)' : 'var(--color-success)'};">${issues}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);">Issues Found</div>
        </div>
      </div>

      ${issues > 0 ? `
      <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:20px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);">
        <i class="fa-solid fa-circle-info" style="color:var(--color-info);margin-right:6px;"></i>
        Crawled <strong>${totalPages}</strong> pages — found <strong>${issues} structural issue${issues !== 1 ? 's' : ''}</strong> worth reviewing.
        ${errorPages > 0 ? `<span style="margin-left:10px;color:var(--color-danger);">● ${errorPages} error page${errorPages !== 1 ? 's' : ''}</span>` : ''}
        ${h1Stats.withoutH1 > 0 ? `<span style="margin-left:10px;color:var(--color-warning);">● ${h1Stats.withoutH1} missing H1</span>` : ''}
        ${deepPages > 0 ? `<span style="margin-left:10px;color:var(--color-warning);">● ${deepPages} buried deep (4+ clicks)</span>` : ''}
      </div>` : `
      <div style="font-size:0.75rem;color:var(--color-success);margin-bottom:20px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border-card);border-radius:var(--radius);">
        <i class="fa-solid fa-check-circle" style="margin-right:6px;"></i>
        Crawled <strong>${totalPages}</strong> pages — no major structural issues detected.
      </div>`}

      <!-- PAGE INVENTORY -->
      <div class="card" style="margin-bottom:16px;">
        <h2><span class="icon"><i class="fa-solid fa-table-list"></i></span> Page Inventory — ${targetDomain}</h2>
        <div class="table-wrapper" style="max-height:480px;overflow-y:auto;">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>H1</th>
                <th style="text-align:center;">Status</th>
                <th style="text-align:center;">Indexed</th>
                <th style="text-align:right;">Depth</th>
                <th style="text-align:right;">Words</th>
                <th style="text-align:center;">Canonical</th>
                <th style="text-align:center;">OG</th>
              </tr>
            </thead>
            <tbody>
              ${targetPages.map(p => {
                const shortUrl = p.url.replace(/^https?:\/\/[^/]+/, '') || '/';
                const statusColor = (p.status_code || 0) >= 400 ? 'var(--color-danger)' : (p.status_code || 0) >= 300 ? 'var(--color-warning)' : 'var(--color-success)';
                const depthColor = (p.click_depth || 0) <= 2 ? 'var(--color-success)' : (p.click_depth || 0) === 3 ? 'var(--color-warning)' : 'var(--color-danger)';
                const h1Text = p.h1 ? escapeHtml(p.h1.slice(0, 50)) + (p.h1.length > 50 ? '…' : '') : '<span style="color:var(--color-warning);">missing</span>';
                return `<tr>
                  <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.72rem;" title="${escapeHtml(p.url)}">${escapeHtml(shortUrl)}</td>
                  <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.7rem;color:var(--text-secondary);">${h1Text}</td>
                  <td style="text-align:center;color:${statusColor};font-size:0.72rem;">${p.status_code || '—'}</td>
                  <td style="text-align:center;font-size:0.72rem;">${p.is_indexable ? '<span style="color:var(--color-success);">✓</span>' : '<span style="color:var(--color-danger);">✗</span>'}</td>
                  <td style="text-align:right;font-size:0.72rem;color:${depthColor};">${p.click_depth ?? '—'}</td>
                  <td style="text-align:right;font-size:0.72rem;color:var(--text-muted);">${p.word_count ? p.word_count.toLocaleString() : '—'}</td>
                  <td style="text-align:center;font-size:0.72rem;">${p.has_canonical ? '<span style="color:var(--color-success);">✓</span>' : '<span style="color:var(--text-muted);">—</span>'}</td>
                  <td style="text-align:center;font-size:0.72rem;">${p.has_og_tags ? '<span style="color:var(--color-success);">✓</span>' : '<span style="color:var(--text-muted);">—</span>'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${targetPages.length >= 100 ? '<div style="font-size:0.65rem;color:var(--text-muted);margin-top:6px;">Showing first 100 pages. Run <code>seo-intel export ' + project + '</code> for full CSV export.</div>' : ''}
      </div>

      <!-- INTERNAL LINK STRUCTURE -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div class="card">
          <h2><span class="icon"><i class="fa-solid fa-arrow-trend-up"></i></span> Most Linked Pages</h2>
          ${topLinkedPages.length > 0 ? `
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${topLinkedPages.map((p, i) => {
              const label = p.target_url.replace(/^https?:\/\/[^/]+/, '').slice(0, 45) || '/';
              const maxInbound = topLinkedPages[0].inbound || 1;
              const barPct = Math.round((p.inbound / maxInbound) * 100);
              return `<div style="font-size:0.7rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                  <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%;" title="${escapeHtml(p.target_url)}">${escapeHtml(label)}</span>
                  <span style="color:var(--text-muted);flex-shrink:0;margin-left:8px;">${p.inbound}</span>
                </div>
                <div style="height:3px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;">
                  <div style="height:100%;width:${barPct}%;background:var(--accent-gold);border-radius:2px;opacity:0.6;"></div>
                </div>
              </div>`;
            }).join('')}
          </div>` : `
          <div style="font-size:0.72rem;color:var(--text-muted);">
            ${internalLinks.topPages.slice(0, 8).map(p => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);">
              <span style="color:var(--accent-gold);font-family:var(--font-display);min-width:20px;">${p.count}</span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.label)}</span>
            </div>`).join('')}
          </div>`}
        </div>

        <div class="card">
          <h2><span class="icon"><i class="fa-solid fa-triangle-exclamation"></i></span> Orphaned Pages</h2>
          ${orphanPages.length === 0 ? `
          <div style="font-size:0.8rem;color:var(--color-success);padding:12px 0;">
            <i class="fa-solid fa-check-circle" style="margin-right:6px;"></i>No orphaned pages found.
          </div>` : `
          <div style="font-size:0.65rem;color:var(--color-warning);margin-bottom:8px;">
            <i class="fa-solid fa-warning" style="margin-right:4px;"></i>
            ${orphanPages.length} indexed page${orphanPages.length !== 1 ? 's' : ''} with no inbound internal links
          </div>
          <div style="max-height:200px;overflow-y:auto;">
            ${orphanPages.map(p => {
              const label = p.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 55) || '/';
              return `<div style="font-size:0.68rem;color:var(--text-secondary);padding:3px 0;border-bottom:1px solid var(--border-subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.url)}">${escapeHtml(label)}</div>`;
            }).join('')}
          </div>`}
        </div>
      </div>

      <!-- SCHEMA COVERAGE + TECHNICAL SIGNALS -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div class="card">
          <h2><span class="icon"><i class="fa-solid fa-code"></i></span> Schema.org Coverage</h2>
          ${schemaTypes.length > 0 ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:8px;">Found on your site:</div>
            ${schemaTypes.map(s => {
              const isHighValue = HIGH_VALUE_SCHEMA.some(h => h.type === s.schema_type);
              return `<div style="display:flex;justify-content:space-between;font-size:0.7rem;padding:3px 0;">
                <span style="color:${isHighValue ? 'var(--color-success)' : 'var(--text-secondary)'};">
                  ${isHighValue ? '✅' : '⚪'} ${escapeHtml(s.schema_type)}
                </span>
                <span style="color:var(--text-muted);">${s.count} page${s.count !== 1 ? 's' : ''}</span>
              </div>`;
            }).join('')}
          </div>` : `
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:14px;">No structured data detected.</div>`}
          <div style="border-top:1px solid var(--border-subtle);padding-top:10px;">
            <div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:8px;">High-value types to add:</div>
            ${HIGH_VALUE_SCHEMA.map(h => {
              const present = foundSchemaTypes.has(h.type);
              return `<div style="display:flex;align-items:flex-start;gap:6px;font-size:0.68rem;padding:3px 0;">
                <span style="flex-shrink:0;">${present ? '✅' : '⚠️'}</span>
                <span>
                  <span style="color:${present ? 'var(--color-success)' : 'var(--text-secondary)'};">${h.label}</span>
                  ${!present ? `<span style="color:var(--text-muted);display:block;font-size:0.62rem;">${h.benefit}</span>` : ''}
                </span>
              </div>`;
            }).join('')}
          </div>
        </div>

        <div class="card">
          <h2><span class="icon"><i class="fa-solid fa-gear"></i></span> Technical Signals</h2>
          ${techCoverage.total ? (() => {
            const pct = (n) => techCoverage.total ? Math.round(((n || 0) / techCoverage.total) * 100) : 0;
            const bar = (label, n) => {
              const p = pct(n);
              const color = p >= 90 ? 'var(--color-success)' : p >= 60 ? 'var(--color-warning)' : 'var(--color-danger)';
              return `<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:3px;"><span style="color:var(--text-secondary);">${label}</span><span style="color:${color};">${p}% <span style="color:var(--text-muted);font-size:0.62rem;">(${n || 0}/${techCoverage.total})</span></span></div><div style="height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${p}%;background:${color};border-radius:2px;"></div></div></div>`;
            };
            return bar('Canonical Tag', techCoverage.canonical) +
                   bar('Open Graph Tags', techCoverage.og) +
                   bar('Schema Markup', techCoverage.schema) +
                   bar('Robots Meta', techCoverage.robots) +
                   (avgLoad > 0 ? `<div style="font-size:0.65rem;color:var(--text-muted);margin-top:8px;">
                     Avg load: <span style="color:${avgLoad > 3000 ? 'var(--color-danger)' : avgLoad > 1500 ? 'var(--color-warning)' : 'var(--color-success)'};">${avgLoad > 1000 ? (avgLoad/1000).toFixed(1) + 's' : avgLoad + 'ms'}</span>
                   </div>` : '');
          })() : '<div style="font-size:0.72rem;color:var(--text-muted);">No technical data yet. Run a crawl first.</div>'}
        </div>
      </div>


      <!-- Action exports available via CLI terminal panel -->

      <!-- UPGRADE CTA -->
      <div style="text-align:center;padding:36px 24px;margin-bottom:16px;background:var(--bg-card);border:1px solid rgba(232,213,163,0.12);border-radius:var(--radius);">
        <i class="fa-solid fa-chart-column" style="font-size:1.2rem;color:var(--accent-gold);margin-bottom:10px;display:block;"></i>
        <h3 style="font-size:0.9rem;color:var(--text-primary);margin-bottom:6px;">See the Full Picture</h3>
        <p style="font-size:0.72rem;color:var(--text-muted);max-width:440px;margin:0 auto 14px;line-height:1.6;">
          This is your site's structure. To see how you compare to competitors —
          keyword gaps, content opportunities, pages you can outrank — upgrade to SEO Intel Solo.
        </p>
        <a href="https://ukkometa.fi/en/seo-intel/" target="_blank"
           style="display:inline-block;padding:10px 24px;background:var(--accent-gold);color:var(--text-dark);border-radius:var(--radius);font-size:0.8rem;font-weight:500;text-decoration:none;">
          Upgrade to Solo — €19.99/mo →
        </a>
        <div style="font-size:0.62rem;color:var(--text-muted);margin-top:8px;">
          €199/yr saves ~17%
        </div>
        <div style="font-size:0.62rem;color:var(--text-muted);margin-top:10px;padding-top:10px;border-top:1px solid var(--border-subtle);">
          Data crawled: ${lastCrawl} · Export raw CSV: <code style="background:var(--bg-elevated);padding:1px 5px;border-radius:3px;">seo-intel export ${project}</code>
        </div>
      </div>

    </div>
    </div>`;

    if (panelOnly) return panelHtml;

    const freeScriptHtml = `<script>
      document.querySelectorAll('.header-bar').forEach(el => {
        el.style.maxWidth = 'var(--max-width)';
        el.style.margin = '0 auto';
      });
    </script>`;

    return headHtml + '\n<body>\n' + panelHtml + '\n' + freeScriptHtml + '\n</body>\n</html>';
  }

  // ── Panel HTML (project-specific body content) ──
  const panelHtml = `
  <div class="project-panel" data-project="${project}">
  <!-- UPDATE BANNER (populated by JS if update available) -->
  <div id="updateBanner${suffix}" style="display:none;"></div>
  <!-- HEADER BAR -->
  <div class="header-bar" id="header">
    <div class="header-left">
      <h1>SEO Intel Dashboard</h1>
      <div class="subtitle">Project: ${project.toUpperCase()} | Target: ${targetDomain}</div>
    </div>
    <div class="header-stats">
      <div class="header-stat">
        <div class="value">${totalPages}</div>
        <div class="label">Pages Crawled</div>
      </div>
      <div class="header-stat">
        <div class="value">${competitorDomains.length}</div>
        <div class="label">Competitors</div>
      </div>
      <div class="header-stat">
        <div class="value">${crawlStats.extractedPages || 0}</div>
        <div class="label">Extracted</div>
      </div>
    </div>
    <div class="header-badges">
      <span class="status-badge gold">Last Crawl: ${lastCrawl}</span>
      <span class="status-badge ${latestAnalysis ? 'success' : 'purple'}">Analysis: ${analysisAge}</span>
    </div>
  </div>

  <!-- ═══ EXTRACTION STATUS BAR ═══ -->
  <div class="extraction-status ${
    extractionStatus.liveProgress?.status === 'running' ? 'is-running' :
    extractionStatus.liveProgress?.status === 'crashed' ? 'is-crashed' : ''
  }">
    <!-- Row 1: Status indicator + domain coverage bars (full width) -->
    <div class="es-top-row">
      <div class="es-indicator">
        <span class="es-dot ${
          extractionStatus.liveProgress?.status === 'running' ? 'running' :
          extractionStatus.liveProgress?.status === 'crashed' ? 'crashed' : ''
        }"></span>
        ${extractionStatus.liveProgress?.status === 'running'
          ? `<span style="color:var(--accent-gold);">Extracting</span>`
          : extractionStatus.liveProgress?.status === 'crashed'
            ? `<span style="color:var(--color-danger);">Crashed</span>`
            : `<span style="color:var(--text-muted);">${extractionStatus.overallPct === 100 ? 'Fully Extracted' : extractionStatus.overallPct + '% Extracted'}</span>`
        }
      </div>
      <div class="es-domains">
        ${extractionStatus.coverage.map(c => {
          const pct = c.total_pages > 0 ? Math.round((c.extracted_pages / c.total_pages) * 100) : 0;
          const barClass = pct === 100 ? '' : pct > 50 ? 'partial' : 'low';
          return `
          <div class="es-domain">
            <span class="es-domain-name ${c.role === 'target' ? 'is-target' : ''}">${getDomainShortName(c.domain)}</span>
            <div class="es-bar-wrap"><div class="es-bar-fill ${barClass}" style="width:${pct}%;"></div></div>
            <span class="es-pct">${pct}%</span>
          </div>`;
        }).join('')}
      </div>
    </div>
    <!-- Row 2: Meta info + controls -->
    <div class="es-bottom-row">
      <div class="es-meta">
        ${extractionStatus.liveProgress?.status === 'running' ? `
          <span class="es-meta-item" style="color:var(--accent-gold);">
            <i class="fa-solid fa-spinner fa-spin"></i>
            ${extractionStatus.liveProgress.current_url ? extractionStatus.liveProgress.current_url.replace(/https?:\/\/[^/]+/, '').slice(0, 30) : ''}
            ${extractionStatus.liveProgress.total ? ` · ${extractionStatus.liveProgress.page_index}/${extractionStatus.liveProgress.total}` : ''}
          </span>
        ` : ''}
        ${extractionStatus.liveProgress?.status === 'crashed' ? `
          <span class="es-meta-item blocked">
            <i class="fa-solid fa-skull"></i> PID ${extractionStatus.liveProgress.pid} dead
          </span>
        ` : ''}
        ${extractionStatus.liveProgress?.skipped > 0 ? `
          <span class="es-meta-item skipped">
            <i class="fa-solid fa-forward"></i> ${extractionStatus.liveProgress.skipped} skipped
          </span>
        ` : ''}
        ${extractionStatus.hashedPages > 0 ? `
          <span class="es-meta-item">
            <i class="fa-solid fa-fingerprint"></i> ${extractionStatus.hashedPages} hashed
          </span>
        ` : ''}
      </div>
      <div class="es-controls" id="esControls${suffix}">
      <button class="es-btn es-btn-stop${extractionStatus.liveProgress?.status === 'running' ? ' active' : ''}" id="btnStop${suffix}" onclick="stopJob()">
        <i class="fa-solid fa-stop"></i> Stop
      </button>
      <button class="es-btn es-btn-restart" id="btnRestart${suffix}" onclick="restartServer()">
        <i class="fa-solid fa-rotate-right"></i> Restart
      </button>
      <label class="es-stealth-toggle">
        <input type="checkbox" id="stealthToggle${suffix}"${extractionStatus.liveProgress?.stealth ? ' checked' : ''}>
        <i class="fa-solid fa-user-ninja"></i> Stealth
      </label>
    </div>
    </div>
  </div>

  <!-- ═══ INTEGRATED TERMINAL + EXPORT SIDEBAR ═══ -->
  <div class="term-split">
    <!-- LEFT: Terminal -->
    <div class="terminal-main">
      <div class="terminal-panel" style="background:#0c0c0c;border:1px solid var(--border-card);border-radius:var(--radius) 0 0 var(--radius);overflow:hidden;">
        <!-- Terminal title bar -->
        <div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:#161616;border-bottom:1px solid var(--border-subtle);">
          <span style="width:10px;height:10px;border-radius:50%;background:#ff5f57;"></span>
          <span style="width:10px;height:10px;border-radius:50%;background:#febc2e;"></span>
          <span style="width:10px;height:10px;border-radius:50%;background:#28c840;"></span>
          <span style="flex:1;text-align:center;font-size:0.6rem;color:var(--text-muted);font-family:var(--font-body);">seo-intel — ${project}</span>
          <span id="termStatus${suffix}" style="font-size:0.55rem;color:var(--text-muted);font-family:var(--font-body);"></span>
        </div>
        <!-- Command buttons -->
        <div style="padding:8px 12px;background:#111;border-bottom:1px solid var(--border-subtle);display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <span style="font-size:0.6rem;color:var(--text-muted);margin-right:4px;"><i class="fa-solid fa-play" style="margin-right:3px;"></i>Run:</span>
          <button class="term-btn" data-cmd="crawl" data-project="${project}"><i class="fa-solid fa-spider"></i> Crawl</button>
          ${pro ? `<button class="term-btn" data-cmd="extract" data-project="${project}"><i class="fa-solid fa-brain"></i> Extract</button>
          <button class="term-btn" data-cmd="analyze" data-project="${project}"><i class="fa-solid fa-chart-column"></i> Analyze</button>
          <button class="term-btn" data-cmd="brief" data-project="${project}"><i class="fa-solid fa-file-lines"></i> Brief</button>
          <button class="term-btn" data-cmd="keywords" data-project="${project}"><i class="fa-solid fa-key"></i> Keywords</button>
          <button class="term-btn" data-cmd="templates" data-project="${project}"><i class="fa-solid fa-clone"></i> Templates</button>` : ''}
          <button class="term-btn" data-cmd="status" data-project=""><i class="fa-solid fa-circle-info"></i> Status</button>
          <button class="term-btn" data-cmd="guide" data-project="${project}"><i class="fa-solid fa-map"></i> Guide</button>
          <button class="term-btn" data-cmd="setup" data-project="" style="margin-left:auto;border-color:rgba(232,213,163,0.25);"><i class="fa-solid fa-gear"></i> Setup</button>
          ${!pro ? `<span style="font-size:0.55rem;color:var(--text-muted);margin-left:auto;"><i class="fa-solid fa-lock" style="color:var(--accent-gold);margin-right:3px;"></i><a href="https://ukkometa.fi/en/seo-intel/" target="_blank" style="color:var(--accent-gold);text-decoration:none;">Solo</a> for extract, analyze, exports</span>` : ''}
        </div>
        <!-- Terminal output -->
        <div id="termOutput${suffix}" style="padding:12px 16px;font-family:'SF Mono','Fira Code','Cascadia Code',monospace;font-size:0.68rem;line-height:1.7;color:var(--text-muted);max-height:400px;overflow-y:auto;min-height:60px;">
          <div style="color:#555;">Ready. Click a command above or type below.</div>
          <div style="color:#555;">Requires <span style="color:var(--text-secondary);">seo-intel serve</span> for live execution.</div>
        </div>
        <!-- Input line -->
        <div style="display:flex;align-items:center;padding:4px 12px 8px;background:#0c0c0c;border-top:1px solid var(--border-subtle);gap:6px;">
          <span style="color:var(--color-success);font-family:'SF Mono',monospace;font-size:0.72rem;">$</span>
          <input id="termInput${suffix}" type="text" placeholder="seo-intel crawl ${project}" style="flex:1;background:none;border:none;color:var(--text-secondary);font-family:'SF Mono','Fira Code','Cascadia Code',monospace;font-size:0.68rem;outline:none;" />
        </div>
      </div>
    </div>
    <!-- RIGHT: Export Sidebar -->
    <div class="export-sidebar">
      <div class="export-sidebar-header">
        <i class="fa-solid fa-file-export"></i> Exports
      </div>
      ${pro ? `
      <div class="export-sidebar-btns">
        <button class="export-btn" data-export-cmd="export-actions" data-export-project="${project}" data-export-scope="technical"><i class="fa-solid fa-wrench"></i> Technical Audit</button>
        <button class="export-btn" data-export-cmd="export-actions" data-export-project="${project}" data-export-scope="competitive"><i class="fa-solid fa-users"></i> Competitive Gaps</button>
        <button class="export-btn" data-export-cmd="suggest-usecases" data-export-project="${project}"><i class="fa-solid fa-lightbulb"></i> Suggest What to Build</button>
      </div>
      <div id="exportViewer${suffix}" class="export-viewer">
        <div style="color:#444;padding:20px 0;text-align:center;">
          <i class="fa-solid fa-file-export" style="font-size:1.2rem;margin-bottom:8px;display:block;"></i>
          Click an export to generate an<br/>implementation-ready action brief.
        </div>
      </div>
      ` : `
      <div style="padding:20px 14px;text-align:center;">
        <i class="fa-solid fa-lock" style="font-size:1rem;color:var(--accent-gold);margin-bottom:8px;display:block;"></i>
        <p style="font-size:0.68rem;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">Agentic exports turn your crawl data into implementation briefs.</p>
        <a href="https://ukkometa.fi/en/seo-intel/" target="_blank" style="display:inline-block;padding:6px 14px;background:var(--accent-gold);color:var(--text-dark);border-radius:var(--radius);font-size:0.68rem;font-weight:500;text-decoration:none;">Unlock with Solo</a>
      </div>
      `}
    </div>
  </div>

  <script>
  (function() {
    const suffix = ${JSON.stringify(suffix)};
    const project = ${JSON.stringify(project)};
    const output = document.getElementById('termOutput' + suffix);
    const input = document.getElementById('termInput' + suffix);
    const status = document.getElementById('termStatus' + suffix);
    const isServed = window.location.protocol.startsWith('http');
    let running = false;
    let eventSource = null;

    function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function appendLine(text, type) {
      const line = document.createElement('div');
      if (type === 'stderr') line.style.color = 'var(--color-warning)';
      else if (type === 'cmd') { line.style.color = 'var(--color-success)'; line.style.marginTop = '8px'; }
      else if (type === 'exit-ok') line.style.color = 'var(--color-success)';
      else if (type === 'exit-err') line.style.color = 'var(--color-danger)';
      else if (type === 'error') line.style.color = 'var(--color-danger)';
      else line.style.color = 'var(--text-secondary)';
      line.innerHTML = escHtml(text);
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }

    function runCommand(command, proj, extra) {
      // Setup always works — even during a running crawl
      if (command === 'setup') {
        if (isServed) {
          window.open('/setup', '_blank');
        } else {
          window.open('http://localhost:3000/setup', '_blank');
          appendLine('Opening setup wizard at localhost:3000/setup', 'stdout');
          appendLine('If it does not open, run: seo-intel setup', 'cmd');
        }
        return;
      }

      if (!isServed) {
        appendLine('', 'cmd');
        appendLine('Not connected to server. Run in your terminal:', 'error');
        appendLine('  seo-intel ' + command + (proj ? ' ' + proj : '') + (extra?.scope ? ' --scope ' + extra.scope : ''), 'cmd');
        appendLine('', 'cmd');
        appendLine('Or start the server: seo-intel serve', 'error');
        return;
      }

      running = true;
      status.textContent = 'running...';
      status.style.color = 'var(--color-warning)';

      const params = new URLSearchParams({ command });
      if (proj) params.set('project', proj);
      if (extra?.scope) params.set('scope', extra.scope);
      if (extra?.stealth) params.set('stealth', 'true');
      if (extra?.format) params.set('format', extra.format);

      var stealthFlag = extra?.stealth ? ' --stealth' : '';
      appendLine('$ seo-intel ' + command + (proj ? ' ' + proj : '') + stealthFlag + (extra?.scope ? ' --scope ' + extra.scope : ''), 'cmd');

      var isCrawlOrExtract = (command === 'crawl' || command === 'extract');

      eventSource = new EventSource('/api/terminal?' + params.toString());
      eventSource.onmessage = function(e) {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'stdout') appendLine(msg.data, 'stdout');
          else if (msg.type === 'stderr') appendLine(msg.data, 'stderr');
          else if (msg.type === 'error') { appendLine('Error: ' + msg.data, 'error'); }
          else if (msg.type === 'exit') {
            const code = msg.data?.code ?? msg.data;
            appendLine(code === 0 ? 'Done.' : 'Exited with code ' + code, code === 0 ? 'exit-ok' : 'exit-err');
            running = false;
            status.textContent = code === 0 ? 'done' : 'failed';
            status.style.color = code === 0 ? 'var(--color-success)' : 'var(--color-danger)';
            eventSource.close();
            eventSource = null;
            // Update status bar when crawl/extract finishes
            if (isCrawlOrExtract && window._setButtonsState) window._setButtonsState(false, null);
          }
        } catch (_) {}
      };
      eventSource.onerror = function() {
        if (running) {
          // SSE disconnected but crawl/extract continues server-side
          if (isCrawlOrExtract) {
            appendLine('Terminal disconnected — job continues in background.', 'stderr');
          } else {
            appendLine('Connection lost.', 'error');
          }
          running = false;
          status.textContent = isCrawlOrExtract ? 'backgrounded' : 'disconnected';
          status.style.color = isCrawlOrExtract ? 'var(--text-muted)' : 'var(--color-danger)';
        }
        eventSource?.close();
        eventSource = null;
      };
    }

    // Expose terminal for status bar buttons
    window._terminalRun = function(cmd, proj, extra) { runCommand(cmd, proj, extra); };
    window._terminalStop = function() {
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (running) {
        appendLine('Stopped.', 'exit-err');
        running = false;
        status.textContent = 'stopped';
        status.style.color = 'var(--color-warning)';
      }
    };

    // Button clicks — crawl/extract read stealth toggle
    document.querySelectorAll('.terminal-panel .term-btn').forEach(function(btn) {
      if (btn.closest('.terminal-panel') !== output.closest('.terminal-panel')) return;
      btn.addEventListener('click', function() {
        const cmd = btn.getAttribute('data-cmd');
        const proj = btn.getAttribute('data-project');
        const scope = btn.getAttribute('data-scope');
        var extra = scope ? { scope: scope } : {};
        // Crawl/extract: read stealth toggle + update status bar
        if (cmd === 'crawl' || cmd === 'extract') {
          var stealthEl = btn.closest('.project-panel')?.querySelector('[id^="stealthToggle"]') || document.getElementById('stealthToggle' + suffix);
          if (stealthEl?.checked) extra.stealth = true;
          if (window._setButtonsState) window._setButtonsState(true, cmd);
          if (window._startPolling) window._startPolling();
        }
        runCommand(cmd, proj, extra);
      });
    });

    // Export sidebar buttons
    const exportViewer = document.getElementById('exportViewer' + suffix);
    document.querySelectorAll('.export-btn').forEach(function(btn) {
      const sidebar = btn.closest('.export-sidebar');
      if (!sidebar || !sidebar.closest('.term-split')?.querySelector('#termOutput' + suffix)) return;
      btn.addEventListener('click', function() {
        if (running) return;
        const cmd = btn.getAttribute('data-export-cmd');
        const proj = btn.getAttribute('data-export-project');
        const scope = btn.getAttribute('data-export-scope');

        // Highlight active
        sidebar.querySelectorAll('.export-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (!isServed) {
          if (exportViewer) {
            exportViewer.innerHTML = '<div style="color:var(--color-danger);padding:12px;">Not connected. Run in terminal:<br/><code style="color:var(--accent-gold);">seo-intel ' + cmd + ' ' + proj + (scope ? ' --scope ' + scope : '') + '</code></div>';
          }
          return;
        }

        // Show loading
        if (exportViewer) exportViewer.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Generating...</div>';

        const params = new URLSearchParams({ command: cmd });
        if (proj) params.set('project', proj);
        if (scope) params.set('scope', scope);
        params.set('format', 'markdown');

        let mdContent = '';
        const es = new EventSource('/api/terminal?' + params.toString());
        running = true;
        status.textContent = 'exporting...';
        status.style.color = 'var(--color-warning)';

        es.onmessage = function(e) {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'stdout') mdContent += msg.data + '\\n';
            else if (msg.type === 'exit') {
              running = false;
              status.textContent = 'done';
              status.style.color = 'var(--color-success)';
              es.close();
              if (exportViewer) {
                // Simple markdown to HTML
                var bt = String.fromCharCode(96);
                var codeRe = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
                let html = mdContent
                  .replace(/^### (.*$)/gm, '<h3>$1</h3>')
                  .replace(/^## (.*$)/gm, '<h2>$1</h2>')
                  .replace(/^# (.*$)/gm, '<h1>$1</h1>')
                  .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
                  .replace(/^- (.*$)/gm, '<li>$1</li>')
                  .replace(/(<li>.*<\\/li>)/s, '<ul>$1</ul>')
                  .replace(codeRe, '<code>$1</code>')
                  .replace(/\\n/g, '<br/>');
                exportViewer.innerHTML = html || '<div style="color:var(--text-muted);">No output.</div>';
                exportViewer.scrollTop = 0;
              }
            }
          } catch (_) {}
        };
        es.onerror = function() {
          running = false;
          status.textContent = 'error';
          status.style.color = 'var(--color-danger)';
          es.close();
          if (exportViewer) exportViewer.innerHTML = '<div style="color:var(--color-danger);">Connection failed.</div>';
        };
      });
    });

    // Input enter
    input.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      const val = input.value.trim();
      if (!val) return;
      input.value = '';

      // Parse: "seo-intel crawl mysite --stealth" or just "crawl mysite"
      const parts = val.replace(/^seo-intel\\s+/i, '').split(/\\s+/);
      const cmd = parts[0];
      const proj = parts[1] && !parts[1].startsWith('-') ? parts[1] : project;
      const extra = {};
      if (parts.includes('--stealth')) extra.stealth = true;
      const scopeIdx = parts.indexOf('--scope');
      if (scopeIdx > -1 && parts[scopeIdx + 1]) extra.scope = parts[scopeIdx + 1];
      runCommand(cmd, proj, extra);
    });

    // Autorun: if URL has ?autorun=setup-classic, fire seo-intel setup --classic via SSE
    (function() {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('autorun') === 'setup-classic') {
        // Remove the param so it doesn't re-trigger on refresh
        window.history.replaceState({}, '', window.location.pathname);
        // Wait a tick for the panel to be ready, then stream the command
        setTimeout(function() {
          if (!isServed) {
            appendLine('Not connected to server. Cannot run setup --classic automatically.', 'error');
            return;
          }
          running = true;
          status.textContent = 'running...';
          status.style.color = 'var(--color-warning)';
          appendLine('$ seo-intel setup --classic', 'cmd');
          const params = new URLSearchParams({ command: 'setup', classic: 'true' });
          eventSource = new EventSource('/api/terminal?' + params.toString());
          eventSource.onmessage = function(e) {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'stdout') appendLine(msg.data, 'stdout');
              else if (msg.type === 'stderr') appendLine(msg.data, 'stderr');
              else if (msg.type === 'error') { appendLine('Error: ' + msg.data, 'error'); }
              else if (msg.type === 'exit') {
                const code = msg.data?.code ?? msg.data;
                appendLine(code === 0 ? 'Done.' : 'Exited with code ' + code, code === 0 ? 'exit-ok' : 'exit-err');
                running = false;
                status.textContent = code === 0 ? 'done' : 'failed';
                status.style.color = code === 0 ? 'var(--color-success)' : 'var(--color-danger)';
                eventSource.close();
                eventSource = null;
              }
            } catch (_) {}
          };
          eventSource.onerror = function() {
            if (running) { appendLine('Connection lost.', 'error'); }
            running = false;
            status.textContent = 'disconnected';
            status.style.color = 'var(--color-danger)';
            eventSource?.close();
            eventSource = null;
          };
        }, 300);
      }
    })();
  })();
  </script>

  <div class="dashboard">

    <!-- ═══ GSC PERFORMANCE TREND ═══ -->
    ${gscData ? (() => {
      const s = gscData.summary;
      // Calculate data age from end date in dateRange (format: "YYYY-MM-DD → YYYY-MM-DD")
      const endDateStr = s.dateRange.split('→').pop()?.trim();
      const endDate = endDateStr ? new Date(endDateStr) : null;
      const ageDays = endDate ? Math.floor((Date.now() - endDate.getTime()) / 86400000) : null;
      const ageLabel = ageDays === null ? '' : ageDays <= 1 ? 'up to date' : ageDays <= 7 ? ageDays + 'd old' : ageDays <= 30 ? Math.floor(ageDays / 7) + 'w old' : Math.floor(ageDays / 30) + 'mo old';
      const ageColor = ageDays === null ? '' : ageDays <= 7 ? 'var(--color-success)' : ageDays <= 30 ? 'var(--color-warning)' : 'var(--color-danger)';
      return `
    <div class="card full-width" id="gsc-trend">
      <h2><span class="icon"><i class="fa-solid fa-chart-line"></i></span> Google Search Console</h2>
      <div class="gsc-date-range" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span><i class="fa-regular fa-calendar"></i> ${escapeHtml(s.dateRange)}</span>
        ${ageLabel ? `<span style="font-size:0.65rem;padding:2px 8px;border-radius:3px;background:rgba(0,0,0,0.3);color:${ageColor};">${ageLabel}</span>` : ''}
        <span class="gsc-update-wrap" style="margin-left:auto;position:relative;">
          <button onclick="this.parentElement.classList.toggle('open')" style="font-size:0.62rem;color:var(--text-muted);background:none;border:none;cursor:pointer;border-bottom:1px solid var(--border-subtle);padding:0;font-family:inherit;"><i class="fa-solid fa-arrows-rotate" style="margin-right:3px;"></i>Update GSC data</button>
          <div class="gsc-update-tooltip">
            <strong>How to update GSC data</strong><br><br>
            1. Go to <a href="https://search.google.com/search-console/performance" target="_blank" style="color:var(--accent-gold);">Google Search Console &rarr; Performance</a><br>
            2. Set date range to <strong>last 3&ndash;6 months</strong> for best results<br>
            3. Click <strong>Export &rarr; Download CSV</strong><br>
            4. Unzip and place the folder in:<br>
            <code style="display:block;margin:6px 0;padding:4px 8px;background:rgba(0,0,0,0.3);border-radius:3px;font-size:0.7rem;">seo-intel/gsc/${project}-*/</code>
            5. Run <code>seo-intel html</code> to regenerate<br><br>
            <span style="color:var(--text-muted);font-size:0.6rem;"><i class="fa-solid fa-circle-info" style="margin-right:3px;"></i>Use daily (not hourly) export with 3&ndash;6 months for meaningful trend charts.</span>
          </div>
        </span>
      </div>
      <div class="gsc-stat-bar">
        <div class="gsc-stat"><span class="gsc-stat-number clicks">${s.totalClicks.toLocaleString()}</span><span class="gsc-stat-label">Clicks</span></div>
        <div class="gsc-stat"><span class="gsc-stat-number impressions">${s.totalImpressions.toLocaleString()}</span><span class="gsc-stat-label">Impressions</span></div>
        <div class="gsc-stat"><span class="gsc-stat-number ctr">${s.avgCtr}%</span><span class="gsc-stat-label">Avg CTR</span></div>
        <div class="gsc-stat"><span class="gsc-stat-number position">${s.avgPosition}</span><span class="gsc-stat-label">Avg Position</span></div>
      </div>
      <div class="chart-container tall">
        <canvas id="gscTrendChart${suffix}"></canvas>
      </div>
    </div>`;
    })() : `
    <div class="card full-width" id="gsc-missing" style="padding:0;overflow:visible;">
      <div class="gsc-notice">
        <i class="fa-solid fa-chart-line"></i>
        <span>Google Search Console data not exported</span>
        <span class="gsc-notice-info">
          <i class="fa-solid fa-info"></i>
          <div class="gsc-notice-tooltip">
            Export your GSC data from <strong>Google Search Console → Performance</strong> and place the folder in:<br><br>
            <code>seo-intel/gsc/${project}-*/</code><br><br>
            The export should contain <code>Chart.csv</code>, <code>Queries.csv</code>, <code>Pages.csv</code>, <code>Countries.csv</code>, and <code>Devices.csv</code>. Regenerate the dashboard after adding the files.
          </div>
        </span>
      </div>
    </div>`}

    <!-- ═══ GSC TOP QUERIES ═══ -->
    ${gscData && gscData.queries.length ? (() => {
      const top25 = gscData.queries.slice(0, 25);
      const maxImp = Math.max(...top25.map(q => q.impressions), 1);
      const rows = top25.map((q, i) => {
        const posClass = q.position <= 3 ? 'gsc-pos-top3' : q.position <= 10 ? 'gsc-pos-top10' : q.position <= 20 ? 'gsc-pos-top20' : 'gsc-pos-deep';
        const impPct = (q.impressions / maxImp * 100).toFixed(0);
        const clkPct = maxImp > 0 ? (q.clicks / maxImp * 100).toFixed(0) : 0;
        return `<tr>
          <td style="font-size:0.78rem;color:var(--text-primary)">${escapeHtml(q.query)}</td>
          <td style="text-align:right;font-family:'SF Mono','Fira Code',monospace;font-size:0.72rem;color:var(--color-info)">${q.clicks}</td>
          <td>
            <div class="gsc-query-bar">
              <div class="gsc-query-bar-fill imp" style="width:${impPct}%"></div>
            </div>
            <span style="font-family:'SF Mono','Fira Code',monospace;font-size:0.68rem;color:var(--text-muted)">${q.impressions.toLocaleString()}</span>
          </td>
          <td style="text-align:right;font-size:0.72rem;color:var(--color-success)">${q.ctr.toFixed(1)}%</td>
          <td style="text-align:center"><span class="gsc-pos-badge ${posClass}">${q.position.toFixed(1)}</span></td>
        </tr>`;
      }).join('');
      return `
    <div class="card full-width" id="gsc-queries">
      <h2><span class="icon"><i class="fa-solid fa-magnifying-glass"></i></span> Top Search Queries</h2>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Query</th><th style="text-align:right">Clicks</th><th>Impressions</th><th style="text-align:right">CTR</th><th style="text-align:center">Pos</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
    })() : ''}

    <!-- ═══ GSC TOP PAGES ═══ -->
    ${gscData && gscData.pages.length ? (() => {
      const top20 = gscData.pages.slice(0, 20);
      const maxImp = Math.max(...top20.map(p => p.impressions), 1);
      const rows = top20.map(p => {
        const posClass = p.position <= 3 ? 'gsc-pos-top3' : p.position <= 10 ? 'gsc-pos-top10' : p.position <= 20 ? 'gsc-pos-top20' : 'gsc-pos-deep';
        const shortUrl = p.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const impPct = (p.impressions / maxImp * 100).toFixed(0);
        return `<tr>
          <td><div class="gsc-page-url" title="${escapeHtml(p.url)}">${escapeHtml(shortUrl)}</div></td>
          <td style="text-align:right;font-family:'SF Mono','Fira Code',monospace;font-size:0.72rem;color:var(--color-info)">${p.clicks}</td>
          <td>
            <div class="gsc-query-bar">
              <div class="gsc-query-bar-fill imp" style="width:${impPct}%"></div>
            </div>
            <span style="font-family:'SF Mono','Fira Code',monospace;font-size:0.68rem;color:var(--text-muted)">${p.impressions.toLocaleString()}</span>
          </td>
          <td style="text-align:right;font-size:0.72rem;color:var(--color-success)">${p.ctr.toFixed(2)}%</td>
          <td style="text-align:center"><span class="gsc-pos-badge ${posClass}">${p.position.toFixed(1)}</span></td>
        </tr>`;
      }).join('');
      return `
    <div class="card full-width" id="gsc-pages">
      <h2><span class="icon"><i class="fa-solid fa-file-lines"></i></span> Top Pages by Impressions</h2>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Page</th><th style="text-align:right">Clicks</th><th>Impressions</th><th style="text-align:right">CTR</th><th style="text-align:center">Pos</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
    })() : ''}

    <!-- ═══ GSC GEO DISTRIBUTION ═══ -->
    ${gscData && gscData.countries.length ? (() => {
      const top15 = gscData.countries.slice(0, 15);
      const maxImp = Math.max(...top15.map(c => c.impressions), 1);
      const rows = top15.map(c => {
        const pct = (c.impressions / maxImp * 100).toFixed(0);
        return `<div class="gsc-country-row">
          <span class="gsc-country-name">${escapeHtml(c.country)}</span>
          <div class="gsc-country-bar-wrap"><div class="gsc-country-bar" style="width:${pct}%"></div></div>
          <span class="gsc-country-val">${c.impressions.toLocaleString()}</span>
          <span class="gsc-country-val" style="color:var(--color-info)">${c.clicks}</span>
        </div>`;
      }).join('');
      return `
    <div class="card" id="gsc-geo">
      <h2><span class="icon"><i class="fa-solid fa-earth-americas"></i></span> Geo Distribution</h2>
      <div style="display:flex;gap:12px;margin-bottom:8px;font-size:0.65rem;color:var(--text-muted);justify-content:flex-end;">
        <span><span style="display:inline-block;width:8px;height:8px;background:var(--accent-purple);border-radius:2px;opacity:0.7;margin-right:3px;"></span>Impressions</span>
        <span><span style="display:inline-block;width:8px;height:8px;background:var(--color-info);border-radius:2px;margin-right:3px;"></span>Clicks</span>
      </div>
      ${rows}
    </div>`;
    })() : ''}

    <!-- ═══ GSC DEVICES ═══ -->
    ${gscData && gscData.devices.length ? (() => {
      const iconMap = { desktop: 'fa-desktop', mobile: 'fa-mobile-screen', tablet: 'fa-tablet-screen-button' };
      const cards = gscData.devices.map(d => {
        const icon = iconMap[d.device.toLowerCase()] || 'fa-globe';
        return `<div class="gsc-device-card">
          <div class="gsc-device-icon"><i class="fa-solid ${icon}"></i></div>
          <div class="gsc-device-name">${escapeHtml(d.device)}</div>
          <div class="gsc-device-clicks">${d.clicks}</div>
          <div class="gsc-device-imp">${d.impressions.toLocaleString()} imp</div>
          <div class="gsc-device-ctr">${d.ctr.toFixed(2)}% CTR</div>
        </div>`;
      }).join('');
      return `
    <div class="card" id="gsc-devices">
      <h2><span class="icon"><i class="fa-solid fa-laptop-mobile"></i></span> Devices</h2>
      <div class="gsc-device-grid">${cards}</div>
    </div>`;
    })() : ''}

    <!-- ═══ GSC INSIGHTS ═══ -->
    ${pro && gscInsights ? (() => {
      const blocks = gscInsights.map(insight => {
        const itemsHtml = insight.items.length ? `
          <div class="gsc-insight-items">
            ${insight.items.map(it => `
              <div class="gsc-insight-item severity-${it.severity}">
                <span class="gsc-insight-item-label">${escapeHtml(it.label)}</span>
                <span class="gsc-insight-item-detail">${escapeHtml(it.detail)}</span>
              </div>`).join('')}
          </div>` : '';
        return `
          <div class="gsc-insight-block" style="border-left-color:${insight.color};">
            <div class="gsc-insight-header">
              <i class="fa-solid ${insight.icon}" style="color:${insight.color}"></i>
              <span class="gsc-insight-title">${escapeHtml(insight.title)}</span>
            </div>
            <div class="gsc-insight-summary">${escapeHtml(insight.summary)}</div>
            ${itemsHtml}
          </div>`;
      }).join('');
      return `
    <div class="card full-width" id="gsc-insights">
      <h2><span class="icon"><i class="fa-solid fa-lightbulb"></i></span> Search Insights</h2>
      ${blocks}
    </div>`;
    })() : ''}

    <div class="section-divider">
      <div class="section-divider-line right"></div>
      <span class="section-divider-label"><i class="fa-solid fa-radar"></i> Competitive Landscape</span>
      <div class="section-divider-line"></div>
    </div>

    <!-- ═══ KEYWORD VENN BATTLEFIELD ═══ -->
    ${pro && keywordVenn.hasData ? `
    <div class="card" id="keyword-venn">
      <h2><span class="icon"><i class="fa-solid fa-crosshairs"></i></span> Keyword Venn Battlefield</h2>
      <canvas id="vennCanvas${suffix}" width="540" height="400"></canvas>
    </div>
    ` : ''}

    <!-- ═══ COMPETITIVE RADAR ═══ -->
    <div class="card" id="competitive-radar">
      <h2><span class="icon"><i class="fa-solid fa-chart-pie"></i></span> Competitive Radar</h2>
      <div class="chart-container tall">
        <canvas id="radarChart${suffix}"></canvas>
      </div>
    </div>

    <!-- ═══ COMPETITIVE GRAVITY MAP ═══ -->
    ${pro ? `
    <div class="card" id="gravity-map">
      <h2><span class="icon"><i class="fa-solid fa-diagram-project"></i></span> Competitive Gravity Map</h2>
      <canvas id="gravityCanvas${suffix}" width="540" height="440"></canvas>
    </div>
    ` : ''}

    <!-- ═══ CONTENT TERRAIN ═══ -->
    <div class="card" id="content-terrain">
      <h2><span class="icon"><i class="fa-solid fa-mountain"></i></span> Content Terrain</h2>
      <canvas id="terrainCanvas${suffix}" width="540" height="420"></canvas>
      <div style="font-size: 0.6rem; color: var(--text-muted); margin-top: 6px;">X: Click Depth · Y: Word Count · Each dot = one page</div>
    </div>

    <!-- ═══ PERFORMANCE BUBBLES ═══ -->
    <div class="card full-width" id="perf-bubbles">
      <h2><span class="icon"><i class="fa-solid fa-gauge-high"></i></span> Performance Bubbles</h2>
      <canvas id="bubbleCanvas${suffix}" width="1100" height="420"></canvas>
      <div style="font-size: 0.6rem; color: var(--text-muted); margin-top: 6px;">X: Click Depth · Y: Load Time (ms) · Size: Word Count</div>
    </div>

    <!-- ═══ CONTENT VOLUME ═══ -->
    <div class="card full-width" id="content-volume">
      <h2><span class="icon"><i class="fa-solid fa-pen-to-square"></i></span> Content Volume</h2>
      <div class="chart-container tall">
        <canvas id="contentVolumeChart${suffix}"></canvas>
      </div>
    </div>

    <!-- ═══ HEADING DEPTH FLOW ═══ -->
    <div class="card full-width" id="heading-flow">
      <h2><span class="icon"><i class="fa-solid fa-water"></i></span> Heading Depth Flow</h2>
      <canvas id="headingFlowCanvas${suffix}" width="1100" height="320"></canvas>
    </div>

    <!-- ═══ TERRITORY CONTROL MAP ═══ -->
    ${pro ? `
    <div class="card full-width" id="territory-map">
      <h2><span class="icon"><i class="fa-solid fa-chess-rook"></i></span> Territory Control Map</h2>
      <canvas id="treemapCanvas${suffix}" width="1100" height="400"></canvas>
    </div>

    <!-- ═══ LINK DNA STRAND ═══ -->
    <div class="card" id="link-dna">
      <h2><span class="icon"><i class="fa-solid fa-dna"></i></span> Link DNA</h2>
      <canvas id="dnaCanvas${suffix}" width="540" height="400"></canvas>
    </div>

    <!-- ═══ LINK RADAR PULSE ═══ -->
    <div class="card" id="link-radar">
      <h2><span class="icon"><i class="fa-solid fa-satellite-dish"></i></span> Link Radar Pulse</h2>
      <canvas id="linkRadarCanvas${suffix}" width="540" height="400"></canvas>
    </div>
    ` : ''}

    <!-- ═══ ENTITY TOPIC MAP ═══ -->
    ${pro && entityTopicMap.hasData ? `
    <div class="card full-width" id="entity-map">
      <h2><span class="icon"><i class="fa-solid fa-map"></i></span> Entity Topic Map</h2>
      <div class="entity-map-grid">
        ${Object.entries(entityTopicMap.domainEntities).map(([domain, data]) => `
        <div class="entity-map-domain">
          <div class="entity-map-name">${getDomainShortName(domain)} ${data.role === 'target' ? '<span class="badge badge-target">target</span>' : ''}</div>
          <div class="entity-tags">
            ${data.entities.map(e => {
              const shared = entityTopicMap.entities.find(x => x.entity.toLowerCase() === e.toLowerCase());
              const isShared = shared && shared.count >= 2;
              return `<span class="entity-tag ${isShared ? 'shared' : 'unique'}">${escapeHtml(e)}</span>`;
            }).join('')}
          </div>
        </div>`).join('')}
      </div>
      <div style="margin-top: 10px; font-size: 0.65rem; color: var(--text-muted);">
        <span class="entity-tag shared" style="font-size:0.6rem;">Shared</span> = 2+ domains cover this topic &nbsp;
        <span class="entity-tag unique" style="font-size:0.6rem;">Unique</span> = only this domain
      </div>
    </div>
    ` : ''}

    <!-- ═══ KEYWORD BATTLEGROUND ═══ -->
    ${pro ? `
    <div class="card full-width" id="keyword-heatmap">
      <h2><span class="icon"><i class="fa-solid fa-shield-halved"></i></span> Keyword Battleground</h2>
      ${keywordHeatmap.keywords.length ? `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Keyword</th>
              ${allDomains.map(d => `<th>${getDomainShortName(d)}</th>`).join('')}
              <th>Gap</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            ${keywordHeatmap.keywords.slice(0, 30).map(kw => `
            <tr>
              <td><strong>${escapeHtml(kw.keyword)}</strong></td>
              ${allDomains.map(d => {
                const status = kw.presence[d] || 'missing';
                return `<td><span class="dot ${status}" title="${status}"></span></td>`;
              }).join('')}
              <td><span class="badge badge-${kw.priority}">${kw.gapScore}</span></td>
              <td><span class="type-tag">${kw.source}</span></td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top: 12px; font-size: 0.75rem; color: var(--text-muted);">
        <span class="dot present"></span> Present &nbsp;
        <span class="dot partial"></span> Partial &nbsp;
        <span class="dot missing"></span> Missing
      </div>
      ` : '<div class="empty-state">No keyword data available — run analysis first</div>'}
    </div>
    ` : ''}

    <div class="section-divider">
      <div class="section-divider-line right"></div>
      <span class="section-divider-label"><i class="fa-solid fa-gear"></i> Technical Foundation</span>
      <div class="section-divider-line"></div>
    </div>

    <!-- ═══ TECHNICAL SEO SCORECARD ═══ -->
    <div class="card full-width" id="technical-seo">
      <h2><span class="icon"><i class="fa-solid fa-gear"></i></span> Technical SEO Scorecard</h2>
      <div class="scorecard-grid">
        ${technicalScores.map(ts => {
          const scoreClass = ts.score >= 80 ? 'green' : ts.score >= 60 ? 'yellow' : 'red';
          return `
          <div class="score-card">
            <div class="domain-name">
              ${getDomainShortName(ts.domain)}
              <span class="badge ${ts.isTarget ? 'badge-target' : 'badge-competitor'}">${ts.isTarget ? 'Target' : 'Comp'}</span>
            </div>
            <div class="score ${scoreClass}">${ts.score}<span style="font-size: 1rem; color: var(--text-muted);">/100</span></div>
            <div class="metrics">
              <div class="metric"><span>H1</span><span class="val">${ts.h1Pct}%</span></div>
              <div class="metric"><span>Meta</span><span class="val">${ts.metaPct}%</span></div>
              <div class="metric"><span>Schema</span><span class="val">${ts.schemaPct}%</span></div>
              <div class="metric"><span>Title</span><span class="val">${ts.titlePct}%</span></div>
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- ═══ DOMAIN ARCHITECTURE ═══ -->
    ${domainArch ? (() => {
      const da = domainArch;
      const sortedDomains = [...da.domainStats].sort((a, b) => a.domain === da.targetDomain ? -1 : b.domain === da.targetDomain ? 1 : 0);
      const chips = sortedDomains.map(d => {
        const isTarget = d.domain === da.targetDomain;
        const links = da.linkStats.find(l => l.domain === d.domain) || { internal: 0, external: 0 };
        const cross = da.crossLinkMap[d.domain] || 0;
        return `<div class="da-domain-chip ${isTarget ? 'is-target' : 'is-owned'}">
          <span class="da-role">${isTarget ? 'main' : 'sub'}</span>
          <span class="da-domain-name">${escapeHtml(d.domain)}</span>
          <span class="da-domain-meta">${d.pages} pg · ${Math.round(d.words / 1000)}k w</span>
        </div>`;
      }).join('');

      const c = da.combined;
      const warningHtml = da.warnings.map(w => {
        const icon = w.severity === 'high' ? 'fa-triangle-exclamation' : w.severity === 'medium' ? 'fa-circle-exclamation' : 'fa-circle-info';
        return `<div class="da-warning severity-${w.severity}">
          <div class="da-warning-icon"><i class="fa-solid ${icon}"></i></div>
          <div>
            <div class="da-warning-title">${escapeHtml(w.title)}</div>
            <div class="da-warning-detail">${escapeHtml(w.detail)}</div>
            <div class="da-warning-fix"><strong>Fix:</strong> ${escapeHtml(w.fix)}</div>
          </div>
        </div>`;
      }).join('');

      return `
    <div class="card full-width" id="domain-architecture">
      <h2><span class="icon"><i class="fa-solid fa-sitemap"></i></span> Domain Architecture</h2>
      <div class="da-domains-row">${chips}</div>
      <div class="da-combined-bar">
        <div class="da-combined-stat"><span class="da-combined-num">${c.totalPages}</span><span class="da-combined-label">Combined Pages</span></div>
        <div class="da-combined-stat"><span class="da-combined-num">${Math.round(c.totalWords / 1000)}k</span><span class="da-combined-label">Combined Words</span></div>
        <div class="da-combined-stat"><span class="da-combined-num" style="color:var(--color-info)">${da.crossFlow.fromMain.toLocaleString()}</span><span class="da-combined-label">Main → Subs</span></div>
        <div class="da-combined-stat"><span class="da-combined-num" style="color:${da.crossFlow.toMain < 50 ? 'var(--color-danger)' : 'var(--color-success)'}">${da.crossFlow.toMain.toLocaleString()}</span><span class="da-combined-label">Subs → Main</span></div>
      </div>
      ${warningHtml || '<div style="font-size:0.78rem;color:var(--color-success);"><i class="fa-solid fa-check-circle" style="margin-right:4px;"></i> No architecture warnings detected</div>'}
    </div>`;
    })() : ''}

    <!-- ═══ TECHNICAL SEO GAPS ═══ -->
    ${pro && latestAnalysis?.technical_gaps?.length ? `
    <div class="card full-width" id="technical-gaps">
      <h2><span class="icon"><i class="fa-solid fa-wrench"></i></span> Technical SEO Gaps</h2>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Gap</th><th>Competitors with it</th><th>Fix</th><th></th></tr></thead>
          <tbody>
            ${(latestAnalysis.technical_gaps).map(tg => `
            <tr data-insight-id="${tg._insight_id || ''}">
              <td><strong>${escapeHtml(tg.gap || '—')}</strong></td>
              <td>${(tg.competitors_with_it || []).map(d => `<span class="comp-tag">${escapeHtml(d)}</span>`).join(' ') || '—'}</td>
              <td>${escapeHtml(tg.fix || '—')}</td>
              <td class="insight-action">${tg._insight_id ? `<button class="insight-btn btn-done" onclick="insightAction(this,'done')" title="Mark done"><i class="fa-solid fa-check"></i></button><button class="insight-btn btn-dismiss" onclick="insightAction(this,'dismissed')" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    ${pro ? `
    <div class="section-divider">
      <div class="section-divider-line right"></div>
      <span class="section-divider-label"><i class="fa-solid fa-bolt"></i> Strategy & Actions</span>
      <div class="section-divider-line"></div>
    </div>` : ''}

    <!-- ═══ QUICK WINS ═══ -->
    ${pro && latestAnalysis?.quick_wins?.length ? `
    <div class="card" id="quick-wins">
      <h2><span class="icon"><i class="fa-solid fa-bolt"></i></span> Quick Wins</h2>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Page</th><th>Issue</th><th>Fix</th><th>Impact</th><th></th></tr></thead>
          <tbody>
            ${(latestAnalysis.quick_wins).map(w => `
            <tr data-insight-id="${w._insight_id || ''}">
              <td class="mono">${escapeHtml(w.page || '—')}</td>
              <td>${escapeHtml(w.issue || '—')}</td>
              <td>${escapeHtml(w.fix || '—')}</td>
              <td><span class="badge badge-${w.impact || 'medium'}">${w.impact || '—'}</span></td>
              <td class="insight-action">${w._insight_id ? `<button class="insight-btn btn-done" onclick="insightAction(this,'done')" title="Mark done"><i class="fa-solid fa-check"></i></button><button class="insight-btn btn-dismiss" onclick="insightAction(this,'dismissed')" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- ═══ NEW PAGES TO CREATE ═══ -->
    ${pro && latestAnalysis?.new_pages?.length ? `
    <div class="card" id="new-pages">
      <h2><span class="icon"><i class="fa-solid fa-file-circle-plus"></i></span> New Pages to Create</h2>
      <div class="new-pages-grid" style="grid-template-columns: 1fr;">
        ${(latestAnalysis.new_pages).map(np => `
        <div class="new-page-card priority-${np.priority || 'medium'}" data-insight-id="${np._insight_id || ''}">
          <div class="new-page-header">
            <span class="new-page-title">${escapeHtml(np.title || np.slug || 'Untitled')}</span>
            <span class="badge badge-${np.priority || 'medium'}">${np.priority || '—'}</span>
            ${np._insight_id ? `<span class="insight-action" style="margin-left:auto;"><button class="insight-btn btn-done" onclick="insightAction(this,'done')" title="Mark done"><i class="fa-solid fa-check"></i></button><button class="insight-btn btn-dismiss" onclick="insightAction(this,'dismissed')" title="Dismiss"><i class="fa-solid fa-xmark"></i></button></span>` : ''}
          </div>
          <div class="new-page-keyword"><i class="fa-solid fa-key" style="font-size:0.7rem;opacity:0.5;margin-right:4px;"></i>${escapeHtml(np.target_keyword || '—')}</div>
          <div class="new-page-angle">${escapeHtml(np.content_angle || np.why || '—')}</div>
          ${np.placement?.length ? `
          <div class="placement-ranks">
            ${np.placement.slice(0, 3).map(p => `
            <div class="placement-rank rank-${p.rank}">
              <span class="rank-num" style="font-weight:700;font-size:0.75rem;">${p.rank === 1 ? '<i class="fa-solid fa-medal" style="color:#e8d5a3;"></i>' : p.rank === 2 ? '<i class="fa-solid fa-medal" style="color:#b8b8b8;"></i>' : '<i class="fa-solid fa-medal" style="color:#c9916e;"></i>'}</span>
              <span class="rank-url">${escapeHtml(p.url || p.property || '—')}</span>
              <span class="rank-reason">${escapeHtml(p.reason || '')}</span>
            </div>`).join('')}
          </div>` : ''}
        </div>`).join('')}
      </div>
    </div>
    ` : ''}

    <!-- ═══ POSITIONING STRATEGY ═══ -->
    ${pro && latestAnalysis?.positioning ? `
    <div class="card full-width" id="positioning">
      <h2><span class="icon"><i class="fa-solid fa-crosshairs"></i></span> Positioning Strategy</h2>
      <div class="positioning-grid">
        ${latestAnalysis.positioning.open_angle ? `
        <div class="positioning-block highlight">
          <div class="positioning-label">Open Angle to Own</div>
          <div class="positioning-text">${escapeHtml(latestAnalysis.positioning.open_angle)}</div>
        </div>` : ''}
        ${latestAnalysis.positioning.target_differentiator ? `
        <div class="positioning-block">
          <div class="positioning-label">Your Differentiator</div>
          <div class="positioning-text">${escapeHtml(latestAnalysis.positioning.target_differentiator)}</div>
        </div>` : ''}
        ${latestAnalysis.positioning.competitor_map ? `
        <div class="positioning-block full">
          <div class="positioning-label">Competitor Landscape</div>
          <div class="positioning-text muted">${escapeHtml(latestAnalysis.positioning.competitor_map)}</div>
        </div>` : ''}
      </div>
    </div>
    ` : ''}

    <!-- ═══ CONTENT GAPS ═══ -->
    ${pro && latestAnalysis?.content_gaps?.length ? `
    <div class="card full-width" id="content-gaps">
      <h2><span class="icon"><i class="fa-solid fa-magnifying-glass-minus"></i></span> Content Gaps</h2>
      <div class="insights-grid">
        ${(latestAnalysis.content_gaps).map(gap => `
        <div class="insight-card medium" data-insight-id="${gap._insight_id || ''}">
          <div class="insight-header">
            <span class="insight-icon"><i class="fa-solid fa-clipboard" style="font-size:0.8rem;"></i></span>
            <span class="insight-title">${escapeHtml(gap.topic || gap.suggested_title || 'Gap')}</span>
            <span class="badge badge-medium">${gap.format || 'content'}</span>
            ${gap._insight_id ? `<span class="insight-action" style="margin-left:auto;"><button class="insight-btn btn-done" onclick="insightAction(this,'done')" title="Done"><i class="fa-solid fa-check"></i></button><button class="insight-btn btn-dismiss" onclick="insightAction(this,'dismissed')" title="Dismiss"><i class="fa-solid fa-xmark"></i></button></span>` : ''}
          </div>
          <div class="insight-desc">${escapeHtml(gap.why_it_matters || '')}</div>
          ${gap.covered_by?.length ? `<div class="covered-by">Covered by: ${gap.covered_by.map(d => `<span class="comp-tag">${escapeHtml(d)}</span>`).join(' ')}</div>` : ''}
          ${gap.suggested_title ? `<div class="suggested-title"><i class="fa-regular fa-lightbulb" style="color:var(--accent-gold);margin-right:4px;"></i>"${escapeHtml(gap.suggested_title)}"</div>` : ''}
        </div>`).join('')}
      </div>
    </div>
    ` : ''}

    <!-- ═══ TOPIC CLUSTER GAPS ═══ -->
    ${pro && topicClusters ? `
    <div class="card full-width" id="topic-cluster-gaps">
      <h2><span class="icon"><i class="fa-solid fa-diagram-project"></i></span> Topic Cluster Coverage</h2>
      <p class="attack-desc">Semantic topic clusters — pages grouped by theme. Red = gap vs competitors. Green = target is competitive.</p>
      <div class="attack-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Cluster</th><th>Target Pages</th><th>Competitor Pages</th><th>Gap</th><th>Top Competitor</th><th>Avg Words</th></tr></thead>
          <tbody>
            ${topicClusters.map(c => {
              const gap = c.competitor_pages - (c.target_pages * 2);
              const topComp = Object.entries(c.domains || {})
                .filter(([d]) => d !== '${targetDomain}')
                .sort((a, b) => b[1] - a[1])[0];
              return `<tr>
                <td><strong>${escapeHtml(c.cluster)}</strong></td>
                <td style="color:var(--accent-green);">${c.target_pages}</td>
                <td>${c.competitor_pages}</td>
                <td style="color:${gap > 0 ? 'var(--color-danger)' : 'var(--accent-green)'}; font-weight:bold;">${gap > 0 ? '🔴 +' + gap : '✅ ' + Math.abs(gap)}</td>
                <td class="mono" style="font-size:0.78rem;">${topComp ? escapeHtml(topComp[0]) + ' (' + topComp[1] + ')' : '—'}</td>
                <td>${c.avg_word_count || '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- ═══ SHALLOW CHAMPIONS ═══ -->
    ${pro ? `
    <div class="card" id="shallow-champions">
      <h2><span class="icon"><i class="fa-solid fa-trophy"></i></span> Shallow Champions <span class="attack-count">${shallowChampions.total}</span></h2>
      <p class="attack-desc">Competitor pages at depth 1-2 with under 700 words — validated topics, thin content. Out-invest them.</p>
      ${shallowChampions.total > 0 ? `
      <div class="attack-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Domain</th><th>Path</th><th>Words</th><th>Depth</th></tr></thead>
          <tbody>
            ${Object.entries(shallowChampions.byDomain).flatMap(([domain, pages]) =>
              pages.slice(0, 8).map(p => `
            <tr>
              <td class="mono">${escapeHtml(getDomainShortName(domain))}</td>
              <td style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(p.url.replace(/https?:\/\/[^/]+/, '') || '/')}</td>
              <td style="color: ${p.word_count < 300 ? 'var(--color-danger)' : 'var(--accent-gold)'};">${p.word_count}</td>
              <td>${p.click_depth}</td>
            </tr>`)
            ).join('')}
          </tbody>
        </table>
      </div>` : '<p class="empty-hint">No shallow targets found.</p>'}
    </div>

    <!-- ═══ CONTENT DECAY ═══ -->
    <div class="card" id="content-decay">
      <h2><span class="icon"><i class="fa-solid fa-arrow-trend-down"></i></span> Content Decay <span class="attack-count">${decayTargets.total}</span></h2>
      <p class="attack-desc">Competitor pages with stale dates or no date metadata. Publish updated versions for freshness advantage.</p>
      ${decayTargets.staleKnown.length || decayTargets.staleUnknown.length ? `
      <div class="attack-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Domain</th><th>Path</th><th>Words</th><th>Status</th></tr></thead>
          <tbody>
            ${decayTargets.staleKnown.slice(0, 10).map(r => `
            <tr>
              <td class="mono">${escapeHtml(getDomainShortName(r.domain))}</td>
              <td style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(r.url.replace(/https?:\/\/[^/]+/, '') || '/')}</td>
              <td>${r.word_count}</td>
              <td><span class="badge badge-high">Stale: ${escapeHtml(r.modified_date || '?')}</span></td>
            </tr>`).join('')}
            ${decayTargets.staleUnknown.slice(0, 10).map(r => `
            <tr>
              <td class="mono">${escapeHtml(getDomainShortName(r.domain))}</td>
              <td style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(r.url.replace(/https?:\/\/[^/]+/, '') || '/')}</td>
              <td>${r.word_count}</td>
              <td><span class="badge badge-medium">No date</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="empty-hint">No decay targets found.</p>'}
    </div>

    <!-- ═══ ORPHAN ENTITIES ═══ -->
    <div class="card" id="orphan-entities">
      <h2><span class="icon"><i class="fa-solid fa-ghost"></i></span> Orphan Entities <span class="attack-count">${orphanEntities.orphans.length}</span></h2>
      <p class="attack-desc">Concepts mentioned by 2+ competitors with no dedicated page. Build pillar pages to own them.</p>
      ${orphanEntities.hasData && orphanEntities.orphans.length > 0 ? `
      <div class="orphan-grid">
        ${orphanEntities.orphans.slice(0, 12).map(o => `
        <div class="orphan-card">
          <div class="orphan-entity">${escapeHtml(o.entity)}</div>
          <div class="orphan-domains">${o.domains.map(d => `<span class="comp-tag">${escapeHtml(getDomainShortName(d))}</span>`).join(' ')}</div>
          <div class="orphan-suggestion">/solutions/${o.entity.replace(/\s+/g, '-').toLowerCase()}</div>
        </div>`).join('')}
      </div>` : `<p class="empty-hint">${orphanEntities.hasData ? 'No orphan entities found — competitors have dedicated pages for all major entities.' : 'Needs Qwen extraction. Run: node cli.js extract'}</p>`}
    </div>

    <!-- ═══ INTENT FRICTION ═══ -->
    <div class="card" id="intent-friction">
      <h2><span class="icon"><i class="fa-solid fa-bullseye"></i></span> Intent Friction <span class="attack-count">${frictionTargets.targets.length}</span></h2>
      <p class="attack-desc">Competitor pages where search intent is informational/commercial but CTA demands enterprise action. Build low-friction alternatives.</p>
      ${frictionTargets.hasData && frictionTargets.targets.length > 0 ? `
      <div class="attack-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Domain</th><th>Path</th><th>Intent</th><th>CTA</th></tr></thead>
          <tbody>
            ${frictionTargets.targets.slice(0, 15).map(t => `
            <tr>
              <td class="mono">${escapeHtml(getDomainShortName(t.domain))}</td>
              <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.url.replace(/https?:\/\/[^/]+/, '') || '/')}</td>
              <td><span class="badge badge-medium">${escapeHtml(t.search_intent)}</span></td>
              <td style="color: var(--color-danger);">${escapeHtml(t.cta_primary)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<p class="empty-hint">${frictionTargets.hasData ? 'No high-friction mismatches found.' : 'Needs Qwen extraction. Run: node cli.js extract'}</p>`}
    </div>

    <!-- (removed) Search Intent Mix -->

    <!-- ═══ PRICING TIER MAP ═══ -->
    <div class="card full-width" id="pricing-tiers">
      <h2><span class="icon"><i class="fa-solid fa-coins"></i></span> Pricing Tier Map</h2>
      ${pricingTierMap.hasData ? `
      <div class="tier-grid">
        ${pricingTierMap.domains.map(d => {
          const tiers = ['free', 'freemium', 'paid', 'enterprise'];
          return `
        <div class="tier-domain">
          <div class="tier-domain-name">${getDomainShortName(d.domain)} ${d.role === 'target' ? '<span class="badge badge-target">target</span>' : ''}</div>
          <div class="tier-tags">
            ${tiers.map(t => d.tiers[t] ? `<span class="tier-tag tier-${t}">${t} <small>${d.tiers[t]}</small></span>` : '').join('')}
          </div>
        </div>`;
        }).join('')}
      </div>
      ` : '<p class="empty-hint">Needs Qwen extraction. Run: node cli.js extract</p>'}
    </div>

    <!-- ═══ TECH STACK MATRIX ═══ -->
    ${techStackMatrix.hasData ? `
    <div class="card full-width" id="tech-stack">
      <h2><span class="icon"><i class="fa-solid fa-screwdriver-wrench"></i></span> Tech Stack Matrix</h2>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Technology</th>
              ${Object.keys(techStackMatrix.stacks).map(d => `<th>${getDomainShortName(d)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${techStackMatrix.allTechs.map(tech => `
            <tr>
              <td><strong>${escapeHtml(tech)}</strong></td>
              ${Object.entries(techStackMatrix.stacks).map(([domain, data]) =>
                `<td><span class="dot ${data.techs.includes(tech) ? 'present' : 'missing'}"></span></td>`
              ).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    ` : ''}

    <!-- ═══ CTA LANDSCAPE ═══ -->
    ${pro && ctaLandscape.hasData ? `
    <div class="card" id="cta-landscape">
      <h2><span class="icon"><i class="fa-solid fa-bullhorn"></i></span> CTA Landscape</h2>
      <div class="attack-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>CTA Text</th><th>Used By</th><th>Intent</th><th>Freq</th></tr></thead>
          <tbody>
            ${ctaLandscape.ctas.map(c => `
            <tr>
              <td><strong>${escapeHtml(c.cta)}</strong></td>
              <td>${c.domains.map(d => `<span class="comp-tag">${escapeHtml(getDomainShortName(d))}</span>`).join(' ')}</td>
              <td>${c.intents.map(i => `<span class="type-tag">${escapeHtml(i)}</span>`).join(' ')}</td>
              <td>${c.count}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- ═══ SCHEMA TYPE BREAKDOWN ═══ -->
    ${schemaBreakdown.hasData ? `
    <div class="card" id="schema-breakdown">
      <h2><span class="icon"><i class="fa-solid fa-code"></i></span> Schema Markup Breakdown</h2>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Schema Type</th>
              ${Object.keys(schemaBreakdown.schemas).map(d => `<th>${getDomainShortName(d)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${schemaBreakdown.allTypes.map(type => `
            <tr>
              <td><strong>${escapeHtml(type)}</strong></td>
              ${Object.entries(schemaBreakdown.schemas).map(([domain, data]) =>
                `<td><span class="dot ${data.types.includes(type) ? 'present' : 'missing'}"></span></td>`
              ).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- ═══ TOP KEYWORDS ═══ -->
    ${pro ? `
    <div class="card" id="top-keywords">
      <h2><span class="icon"><i class="fa-solid fa-key"></i></span> Top Keywords (${targetDomain})</h2>
      ${keywords.length ? `
      <div class="table-wrapper" style="max-height: 400px; overflow-y: auto;">
        <table>
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Location</th>
              <th>Freq</th>
              <th>Competitors</th>
            </tr>
          </thead>
          <tbody>
            ${keywords.slice(0, 20).map(k => `
            <tr>
              <td><strong>${escapeHtml(k.keyword)}</strong></td>
              <td style="color: var(--text-muted);">${k.location}</td>
              <td>${k.freq}</td>
              <td>
                ${k.competitorCount > 0
                  ? `<span style="color: var(--color-success);">${k.competitorCount}/${competitorDomains.length}</span>`
                  : `<span style="color: var(--color-danger);">Unique</span>`
                }
              </td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ` : '<div class="empty-state">No keyword data available</div>'}
    </div>
    ` : ''}

    <!-- ═══ INTERNAL LINK ANALYSIS ═══ -->
    <div class="card" id="internal-links">
      <h2><span class="icon"><i class="fa-solid fa-link"></i></span> Internal Link Analysis</h2>
      <div class="stat-row">
        <div class="stat-box">
          <div class="value">${internalLinks.totalLinks}</div>
          <div class="label">Total Links</div>
        </div>
        <div class="stat-box">
          <div class="value" style="color: ${internalLinks.orphanCount > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">${internalLinks.orphanCount}</div>
          <div class="label">Orphan Pages</div>
        </div>
      </div>
      <div class="chart-container" style="height: 280px;">
        <canvas id="internalLinksChart${suffix}"></canvas>
      </div>
    </div>

    ${!pro ? `
    <div class="card full-width" style="text-align:center; padding:40px 24px;">
      <i class="fa-solid fa-lock" style="font-size:1.5rem; color:var(--accent-gold); margin-bottom:12px;"></i>
      <h3 style="font-size:0.9rem; color:var(--text-primary); margin-bottom:8px;">Unlock AI Analysis, Keywords & Strategy</h3>
      <p style="font-size:0.75rem; color:var(--text-muted); max-width:400px; margin:0 auto 16px;">
        Upgrade to Solo for keyword battleground, competitive gaps, AI-powered quick wins, content audits, and 15+ advanced visualizations.
      </p>
      <a href="https://ukkometa.fi/en/seo-intel/" target="_blank"
         style="display:inline-block; padding:8px 20px; background:var(--accent-gold); color:var(--text-dark); border-radius:var(--radius); font-size:0.78rem; font-weight:500; text-decoration:none;">
        Upgrade to Solo — €19.99/mo →
      </a>
    </div>
    ` : ''}

    ${pro ? `
    <div class="section-divider">
      <div class="section-divider-line right"></div>
      <span class="section-divider-label"><i class="fa-solid fa-flask"></i> Research</span>
      <div class="section-divider-line"></div>
    </div>` : ''}

    <!-- ═══ AEO / AI CITABILITY AUDIT ═══ -->
    ${pro && citabilityData?.length ? buildAeoCard(citabilityData, escapeHtml) : ''}

    <!-- ═══ LONG-TAIL OPPORTUNITIES ═══ -->
    ${pro && latestAnalysis?.long_tails?.length ? `
    <div class="card full-width" id="long-tails">
      <h2><span class="icon"><i class="fa-solid fa-binoculars"></i></span> Long-tail Opportunities</h2>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Phrase</th><th>Intent</th><th>Type</th><th>Best Placement</th><th>2nd</th><th>Priority</th><th></th></tr></thead>
          <tbody>
            ${(latestAnalysis.long_tails).map(lt => {
              const p1 = lt.placement?.[0];
              const p2 = lt.placement?.[1];
              return `
            <tr data-insight-id="${lt._insight_id || ''}">
              <td class="phrase-cell">"${escapeHtml(lt.phrase || '—')}"</td>
              <td>${escapeHtml(lt.intent || '—')}</td>
              <td><span class="type-tag">${escapeHtml(lt.page_type || '—')}</span></td>
              <td class="placement-cell">${p1 ? `<span class="prop-tag prop-${p1.property}">${escapeHtml(p1.property)}</span> <span class="placement-url">${escapeHtml(p1.url || '')}</span>` : '—'}</td>
              <td class="placement-cell">${p2 ? `<span class="prop-tag prop-${p2.property}">${escapeHtml(p2.property)}</span>` : '—'}</td>
              <td><span class="badge badge-${lt.priority || 'medium'}">${lt.priority || '—'}</span></td>
              <td class="insight-action">${lt._insight_id ? `<button class="insight-btn btn-done" onclick="insightAction(this,'done')" title="Mark done"><i class="fa-solid fa-check"></i></button><button class="insight-btn btn-dismiss" onclick="insightAction(this,'dismissed')" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>` : ''}</td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- ═══ KEYWORD INVENTOR ═══ -->
    ${pro && keywordsReport ? (() => {
      const allClusters = keywordsReport.keyword_clusters || [];
      const allKws = allClusters.flatMap(c => (c.keywords || []).map(k => ({ ...k, cluster: c.topic })));
      const totalPhrases = allKws.length;
      const tradCount = allKws.filter(k => k.type === 'traditional').length;
      const perpCount = allKws.filter(k => k.type === 'perplexity').length;
      const agentCount = allKws.filter(k => k.type === 'agent').length;
      const highCount = allKws.filter(k => k.priority === 'high').length;

      const kwRows = allKws.map((k, i) => `
        <tr class="ki-row" data-type="${escapeHtml(k.type || 'traditional')}" data-priority="${escapeHtml(k.priority || 'medium')}">
          <td class="phrase-cell">"${escapeHtml(k.phrase || '—')}"</td>
          <td><span class="ki-type-badge ki-type-${escapeHtml(k.type || 'traditional')}">${escapeHtml(k.type || 'traditional')}</span></td>
          <td>${escapeHtml(k.intent || '—')}</td>
          <td class="ki-priority-${escapeHtml(k.priority || 'medium')}">${escapeHtml(k.priority || '—')}</td>
          <td>${escapeHtml(k.cluster || '—')}</td>
          <td style="max-width:260px;font-size:0.8rem;color:var(--text-muted)">${escapeHtml(k.notes || '')}</td>
        </tr>`).join('');

      const agentRows = (keywordsReport.agent_queries || []).map(q =>
        `<li>${escapeHtml(q)}</li>`).join('');

      const quickPills = (keywordsReport.quick_targets || []).map(p =>
        `<span class="ki-pill">${escapeHtml(p)}</span>`).join('');

      return `
    <div class="card full-width" id="keyword-inventor">
      <h2><span class="icon"><i class="fa-solid fa-robot"></i></span> Keyword Inventor</h2>

      <div class="ki-stat-bar">
        <div class="ki-stat"><span class="ki-stat-number">${totalPhrases}</span><span class="ki-stat-label">Total Phrases</span></div>
        <div class="ki-stat"><span class="ki-stat-number">${tradCount}</span><span class="ki-stat-label">Traditional</span></div>
        <div class="ki-stat"><span class="ki-stat-number">${perpCount}</span><span class="ki-stat-label">Perplexity</span></div>
        <div class="ki-stat"><span class="ki-stat-number">${agentCount}</span><span class="ki-stat-label">Agent</span></div>
        <div class="ki-stat"><span class="ki-stat-number">${highCount}</span><span class="ki-stat-label">High Priority</span></div>
      </div>

      ${keywordsReport.summary ? `<div class="ki-summary-box">${escapeHtml(keywordsReport.summary)}</div>` : ''}

      ${agentRows ? `
      <div class="ki-agent-block">
        <h3><i class="fa-solid fa-robot" style="font-size:0.8rem;margin-right:4px;color:var(--text-muted);"></i> AI Citation Gold</h3>
        <div class="ki-agent-note">These are how AI assistants research on behalf of users. Rank for these = get cited by ChatGPT, Perplexity, Claude.</div>
        <ul class="ki-agent-list">${agentRows}</ul>
      </div>` : ''}

      ${quickPills ? `
      <h3 style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem;"><i class="fa-solid fa-bolt" style="font-size:0.7rem;margin-right:3px;"></i> Quick Targets</h3>
      <div class="ki-quick-targets">${quickPills}</div>` : ''}

      <h3 style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem;margin-top:1.5rem;"><i class="fa-solid fa-clipboard-list" style="font-size:0.7rem;margin-right:3px;"></i> All Keywords</h3>
      <div class="ki-filter-bar">
        <button class="ki-filter-btn active" onclick="kiFilter(this,'all','${suffix}')">All</button>
        <button class="ki-filter-btn" onclick="kiFilter(this,'traditional','${suffix}')">Traditional</button>
        <button class="ki-filter-btn" onclick="kiFilter(this,'perplexity','${suffix}')">Perplexity</button>
        <button class="ki-filter-btn" onclick="kiFilter(this,'agent','${suffix}')">Agent</button>
        <button class="ki-filter-btn" onclick="kiFilter(this,'high','${suffix}')">High Priority</button>
      </div>
      <div class="analysis-table-wrap">
        <table class="analysis-table" id="ki-table${suffix}">
          <thead><tr><th>Phrase</th><th>Type</th><th>Intent</th><th>Priority</th><th>Cluster</th><th>Notes</th></tr></thead>
          <tbody>${kwRows}</tbody>
        </table>
      </div>
    </div>
    <script>
      function kiFilter(btn, filter, sfx) {
        sfx = sfx || '';
        const panel = btn.closest('.project-panel') || document;
        panel.querySelectorAll('.ki-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('#ki-table' + sfx + ' .ki-row').forEach(row => {
          if (filter === 'all') {
            row.style.display = '';
          } else if (filter === 'high') {
            row.style.display = row.dataset.priority === 'high' ? '' : 'none';
          } else {
            row.style.display = row.dataset.type === filter ? '' : 'none';
          }
        });
      }
    </script>`;
    })() : ''}

    ${!latestAnalysis ? `
    <div class="card full-width">
      <h2><span class="icon"><i class="fa-solid fa-brain"></i></span> AI Analysis</h2>
      <div class="empty-state">Run <code>node cli.js analyze ${project}</code> to generate recommendations</div>
    </div>` : ''}
  </div>

  <div class="timestamp">Generated: ${new Date().toISOString()} | SEO Intel Dashboard v3</div>
  <script>
    async function insightAction(btn, status) {
      const row = btn.closest('[data-insight-id]');
      const id = row?.dataset?.insightId;
      if (!id) return;
      try {
        const res = await fetch('/api/insights/' + id + '/status', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ status })
        });
        if (res.ok) {
          row.classList.add('insight-done');
          setTimeout(() => { row.style.display = 'none'; }, 600);
        }
      } catch(e) { console.warn('Insight update failed:', e); }
    }
  </script>
  </div><!-- /.project-panel -->`;

  // ── panelOnly mode: return just the project panel (for multi-project) ──
  if (panelOnly) return panelHtml;

  // ── Script HTML (Chart.js + custom canvas renderers) ──
  const scriptHtml = `
  <script>
    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIG OBJECT - Edit this section to update all chart data
    // ═══════════════════════════════════════════════════════════════════════════

    // Color palette — soft pastels
    const COLORS = {
      gold: '#e8d5a3',
      purple: '#7c6deb',
      success: '#8ecba8',
      danger: '#d98e8e',
      info: '#8bbdd9',
      textPrimary: '#f0f0f0',
      textMuted: '#555555',
      gridLines: '#222222',
      // Competitor colors — muted pastels
      competitors: ['#7c6deb', '#8bbdd9', '#8ecba8', '#d9a88e', '#b89ed9', '#8bbdb8', '#d9c78b', '#a3b8d9', '#c9a3d9']
    };

    // Edit this to update the radar chart
    const radarData = ${JSON.stringify(radarData)};

    // Edit this to update the content volume chart
    const contentVolumeData = ${JSON.stringify(contentVolumeData)};

    // Edit this to update the internal links chart
    const internalLinksData = ${JSON.stringify(internalLinks.topPages)};

    // ═══════════════════════════════════════════════════════════════════════════
    // GSC PERFORMANCE TREND (Dual-axis line chart)
    // ═══════════════════════════════════════════════════════════════════════════
    ${gscData ? `(function() {
      const gscEl = document.getElementById('gscTrendChart${suffix}');
      if (!gscEl) return;
      const gscChart = ${JSON.stringify(gscData.chart)};
      const labels = gscChart.map(d => {
        const dt = new Date(d.date);
        return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });

      new Chart(gscEl, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Clicks',
              data: gscChart.map(d => d.clicks),
              borderColor: '#8bbdd9',
              backgroundColor: 'rgba(139,189,217,0.08)',
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHoverBackgroundColor: '#8bbdd9',
              tension: 0.3,
              fill: true,
              yAxisID: 'y'
            },
            {
              label: 'Impressions',
              data: gscChart.map(d => d.impressions),
              borderColor: '#7c6deb',
              backgroundColor: 'rgba(124,109,235,0.05)',
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHoverBackgroundColor: '#7c6deb',
              tension: 0.3,
              fill: true,
              yAxisID: 'y1'
            },
            {
              label: 'Avg Position',
              data: gscChart.map(d => d.position),
              borderColor: '#e8d5a3',
              borderWidth: 1.5,
              borderDash: [4, 3],
              pointRadius: 0,
              pointHoverRadius: 3,
              pointHoverBackgroundColor: '#e8d5a3',
              tension: 0.3,
              fill: false,
              yAxisID: 'y2'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              grid: { color: '#222222', drawBorder: false },
              ticks: { color: '#555555', font: { size: 10 }, maxRotation: 45, maxTicksLimit: 15 }
            },
            y: {
              type: 'linear', position: 'left',
              title: { display: true, text: 'Clicks', color: '#8bbdd9', font: { size: 10 } },
              grid: { color: '#222222' },
              ticks: { color: '#8bbdd9', font: { size: 10 } },
              beginAtZero: true
            },
            y1: {
              type: 'linear', position: 'right',
              title: { display: true, text: 'Impressions', color: '#7c6deb', font: { size: 10 } },
              grid: { drawOnChartArea: false },
              ticks: { color: '#7c6deb', font: { size: 10 } },
              beginAtZero: true
            },
            y2: {
              type: 'linear', position: 'right',
              title: { display: false },
              grid: { drawOnChartArea: false },
              ticks: { display: false },
              reverse: true,
              beginAtZero: false
            }
          },
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#f0f0f0', usePointStyle: true, padding: 20, font: { size: 11 } }
            },
            tooltip: {
              backgroundColor: '#161616', titleColor: '#e8d5a3', bodyColor: '#f0f0f0',
              borderColor: '#222222', borderWidth: 1, cornerRadius: 4, padding: 12,
              callbacks: {
                label: function(ctx) {
                  if (ctx.dataset.label === 'Avg Position') return 'Pos: ' + ctx.parsed.y.toFixed(1);
                  return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString();
                }
              }
            }
          }
        }
      });
    })();` : ''}

    // ═══════════════════════════════════════════════════════════════════════════
    // CHART 1: COMPETITIVE RADAR
    // 6 axes comparing all domains
    // ═══════════════════════════════════════════════════════════════════════════
    new Chart(document.getElementById('radarChart${suffix}'), {
      type: 'radar',
      data: {
        labels: radarData.labels,
        datasets: radarData.datasets.map((ds, i) => ({
          ...ds,
          borderColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
          backgroundColor: ds.isTarget ? 'rgba(232, 213, 163, 0.1)' : \`\${COLORS.competitors[i % COLORS.competitors.length]}18\`,
          borderWidth: ds.isTarget ? 3 : 2,
          pointBackgroundColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
          pointBorderColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
          pointRadius: ds.isTarget ? 5 : 3,
          pointHoverRadius: 7,
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            grid: { color: COLORS.gridLines },
            angleLines: { color: COLORS.gridLines },
            ticks: {
              color: COLORS.textMuted,
              backdropColor: 'transparent',
              stepSize: 20
            },
            pointLabels: {
              color: COLORS.textPrimary,
              font: { size: 11, weight: '500' }
            }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: COLORS.textPrimary,
              usePointStyle: true,
              padding: 20,
              font: { size: 11 }
            }
          },
          tooltip: {
            backgroundColor: '#161616',
            titleColor: COLORS.gold,
            bodyColor: COLORS.textPrimary,
            borderColor: COLORS.gridLines,
            borderWidth: 1,
            cornerRadius: 4,
            padding: 12
          }
        }
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CHART 2: CONTENT VOLUME (Horizontal Bar)
    // Total word count per domain, sorted descending
    // ═══════════════════════════════════════════════════════════════════════════
    new Chart(document.getElementById('contentVolumeChart${suffix}'), {
      type: 'bar',
      data: {
        labels: contentVolumeData.labels,
        datasets: [{
          label: 'Total Word Count',
          data: contentVolumeData.values,
          backgroundColor: contentVolumeData.colors,
          borderColor: contentVolumeData.colors,
          borderWidth: 0,
          borderRadius: 6,
          barThickness: 24
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: COLORS.gridLines },
            ticks: { color: COLORS.textMuted }
          },
          y: {
            grid: { display: false },
            ticks: {
              color: COLORS.textPrimary,
              font: { weight: '500' }
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161616',
            titleColor: COLORS.gold,
            bodyColor: COLORS.textPrimary,
            borderColor: COLORS.gridLines,
            borderWidth: 1,
            cornerRadius: 4,
            callbacks: {
              label: ctx => \` \${ctx.parsed.x.toLocaleString()} words\`
            }
          }
        }
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CHART 3: INTERNAL LINKS (Horizontal Bar)
    // Top 10 most-linked-to pages
    // ═══════════════════════════════════════════════════════════════════════════
    if (internalLinksData.length > 0) {
      new Chart(document.getElementById('internalLinksChart${suffix}'), {
        type: 'bar',
        data: {
          labels: internalLinksData.map(p => p.label),
          datasets: [{
            label: 'Inbound Links',
            data: internalLinksData.map(p => p.count),
            backgroundColor: COLORS.info,
            borderRadius: 4,
            barThickness: 18
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { color: COLORS.gridLines },
              ticks: { color: COLORS.textMuted }
            },
            y: {
              grid: { display: false },
              ticks: {
                color: COLORS.textPrimary,
                font: { size: 10 }
              }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#161616',
              titleColor: COLORS.gold,
              bodyColor: COLORS.textPrimary,
              borderColor: COLORS.gridLines,
              borderWidth: 1,
              cornerRadius: 8
            }
          }
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADVANCED VISUALIZATIONS — Custom Canvas Renderers
    // ═══════════════════════════════════════════════════════════════════════════

    const VIZ_COLORS = {
      target: '#e8d5a3',
      comps: ['#7c6deb','#8bbdd9','#8ecba8','#d9a88e','#b89ed9','#8bbdb8','#d9c78b','#a3b8d9','#c9a3d9'],
      bg: '#111111', grid: '#222222', text: '#b8b8b8', muted: '#555555'
    };

    // ═══ UPDATE CHECK ═══
    (function() {
      if (!window.location.protocol.startsWith('http')) return;
      fetch('/api/update-check').then(r => r.json()).then(function(info) {
        if (!info.hasUpdate) return;
        var banner = document.getElementById('updateBanner${suffix}');
        if (!banner) return;
        var cls = info.security ? 'update-security' : 'update-normal';
        var icon = info.security ? 'fa-shield-halved' : 'fa-arrow-up';
        var changelogHtml = info.changelog ? '<span class="update-changelog">' + info.changelog.split('\\n')[0] + '</span>' : '';
        banner.style.display = 'block';
        banner.innerHTML = '<div class="update-banner ' + cls + '">' +
          '<i class="fa-solid ' + icon + '"></i>' +
          '<span class="update-version">' + info.current + ' → ' + info.latest + '</span>' +
          changelogHtml +
          '<button class="update-btn" onclick="navigator.clipboard.writeText(\\'npm update -g seo-intel\\');this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\'Update\\',2000)">Update</button>' +
          '<span class="update-dismiss" onclick="this.closest(\\'.update-banner\\').style.display=\\'none\\'"><i class="fa-solid fa-xmark"></i></span>' +
          '</div>';
      }).catch(function() {});
    })();

    // ═══ LIVE DASHBOARD CONTROLS ═══
    (function() {
      const isServed = window.location.protocol.startsWith('http');
      const sfx = '${suffix}';
      const controlsEl = document.getElementById('esControls' + sfx);
      if (!controlsEl) return;

      if (!isServed) {
        controlsEl.innerHTML = '<span class="es-server-note"><i class="fa-solid fa-plug"></i> Run <code>node cli.js serve</code> for live controls</span>';
        return;
      }

      let pollTimer = null;

      window.startJob = function(command, proj) {
        var stealth = document.getElementById('stealthToggle' + sfx)?.checked || false;
        var extra = {};
        if (stealth) extra.stealth = true;

        // Route through terminal for visible output
        if (window._terminalRun) {
          window._terminalRun(command, proj, extra);
        }
        setButtonsState(true, command);
        startPolling();
      };

      window.stopJob = function() {
        // Close terminal SSE (server detaches crawl/extract, so we also hit /api/stop)
        if (window._terminalStop) window._terminalStop();
        fetch('/api/stop', { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function() { setButtonsState(false, null); })
          .catch(function() { setButtonsState(false, null); });
      };

      window.restartServer = function() {
        if (!confirm('Restart SEO Intel? This will stop any running jobs and refresh the dashboard.')) return;
        var btnR = document.getElementById('btnRestart' + sfx);
        if (btnR) { btnR.disabled = true; btnR.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Restarting\u2026'; }
        // Stop terminal SSE
        if (window._terminalStop) window._terminalStop();
        fetch('/api/restart', { method: 'POST' })
          .then(function() {
            // Server is restarting — wait a moment then reload
            setTimeout(function() { window.location.reload(); }, 2000);
          })
          .catch(function() {
            // Server might already be dead — try reloading anyway
            setTimeout(function() { window.location.reload(); }, 2000);
          });
      };

      // Expose for terminal IIFE to call back
      window._setButtonsState = setButtonsState;
      window._startPolling = startPolling;

      function setButtonsState(isRunning, activeCmd) {
        var btnC = document.getElementById('btnCrawl' + sfx);
        var btnE = document.getElementById('btnExtract' + sfx);
        var btnS = document.getElementById('btnStop' + sfx);
        if (btnC) {
          btnC.disabled = isRunning;
          if (isRunning && activeCmd === 'crawl') {
            btnC.classList.add('running');
            btnC.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Crawling\u2026';
          } else {
            btnC.classList.remove('running');
            btnC.innerHTML = '<i class="fa-solid fa-spider"></i> Crawl';
          }
        }
        if (btnE) {
          btnE.disabled = isRunning;
          if (isRunning && activeCmd === 'extract') {
            btnE.classList.add('running');
            btnE.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting\u2026';
          } else {
            btnE.classList.remove('running');
            btnE.innerHTML = '<i class="fa-solid fa-brain"></i> Extract';
          }
        }
        if (btnS) {
          // Stop button always visible — turns red+pulsing when something is running
          if (isRunning) {
            btnS.classList.add('active');
          } else {
            btnS.classList.remove('active');
          }
        }
      }

      function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(pollProgress, 2000);
        pollProgress();
      }

      function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }

      function pollProgress() {
        fetch('/api/progress')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            updateStatusBar(data);
            if (data.status !== 'running') {
              stopPolling();
              setButtonsState(false, null);
            }
          })
          .catch(function() { stopPolling(); setButtonsState(false, null); });
      }

      function updateStatusBar(data) {
        var panel = controlsEl.closest('.extraction-status') || document.querySelector('.extraction-status');
        if (!panel) return;
        var dot = panel.querySelector('.es-dot');
        var label = panel.querySelector('.es-indicator span:last-child');
        if (!dot || !label) return;

        if (data.status === 'running') {
          panel.classList.add('is-running');
          panel.classList.remove('is-crashed');
          dot.className = 'es-dot running';
          label.style.color = 'var(--accent-gold)';
          var url = data.current_url ? data.current_url.replace(/https?:\\/\\/[^/]+/, '').slice(0, 30) : '';
          var progress = data.total ? ' ' + data.page_index + '/' + data.total : '';
          label.textContent = (data.command === 'crawl' ? 'Crawling' : 'Extracting') + progress + (url ? ' \\u00b7 ' + url : '');
        } else if (data.status === 'completed') {
          panel.classList.remove('is-running', 'is-crashed');
          dot.className = 'es-dot';
          label.style.color = 'var(--color-success)';
          label.textContent = 'Completed (' + (data.extracted || 0) + ' extracted' + (data.failed ? ', ' + data.failed + ' failed' : '') + ')';
        } else if (data.status === 'stopped') {
          panel.classList.remove('is-running', 'is-crashed');
          dot.className = 'es-dot';
          label.style.color = 'var(--accent-gold)';
          label.textContent = 'Stopped' + (data.extracted ? ' (' + data.extracted + ' extracted)' : '');
        } else if (data.status === 'crashed') {
          panel.classList.remove('is-running');
          panel.classList.add('is-crashed');
          dot.className = 'es-dot crashed';
          label.style.color = 'var(--color-danger)';
          label.textContent = 'Crashed (PID ' + data.pid + ')';
        }
      }

      // On page load: check if a job is already running
      fetch('/api/progress')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          // Sync stealth toggle with progress state
          var stealthEl = document.getElementById('stealthToggle' + sfx);
          if (stealthEl && data.stealth !== undefined) {
            stealthEl.checked = !!data.stealth;
          }
          if (data.status === 'running') {
            setButtonsState(true, data.command);
            startPolling();
          }
        })
        .catch(function() {});
    })();

    // ═══ KEYWORD VENN BATTLEFIELD ═══
    ${keywordVenn.hasData ? `(function() {
      const c = document.getElementById('vennCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const data = ${JSON.stringify(keywordVenn)};
      const cx = W / 2, cy = H / 2, R = 120;

      // Three circle positions
      const circles = [
        { x: cx, y: cy - 50, r: R, color: VIZ_COLORS.target, label: data.sets[0].label, total: data.sets[0].total },
        { x: cx - 70, y: cy + 40, r: R * 0.9, color: VIZ_COLORS.comps[0], label: data.sets[1].label, total: data.sets[1].total },
        { x: cx + 70, y: cy + 40, r: R * 0.85, color: VIZ_COLORS.comps[1], label: data.sets[2].label, total: data.sets[2].total }
      ];

      circles.forEach(circle => {
        ctx.beginPath();
        ctx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
        ctx.fillStyle = circle.color + '18';
        ctx.fill();
        ctx.strokeStyle = circle.color + '60';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // Labels
      ctx.font = '600 13px Syne, sans-serif';
      ctx.textAlign = 'center';
      circles.forEach((circle, i) => {
        const offY = i === 0 ? -circle.r - 14 : circle.r + 18;
        ctx.fillStyle = circle.color;
        ctx.fillText(circle.label + ' (' + circle.total + ')', circle.x, circle.y + offY);
      });

      // Zone numbers
      ctx.font = '700 16px Syne, sans-serif';
      const z = data.zones;
      // Unique zones
      ctx.fillStyle = VIZ_COLORS.target + 'cc'; ctx.fillText(z.t_only, cx, cy - 90);
      ctx.fillStyle = VIZ_COLORS.comps[0] + 'cc'; ctx.fillText(z.c1_only, cx - 100, cy + 70);
      ctx.fillStyle = VIZ_COLORS.comps[1] + 'cc'; ctx.fillText(z.c2_only, cx + 100, cy + 70);
      // Overlaps
      ctx.font = '700 14px Syne, sans-serif';
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.t_c1, cx - 40, cy - 8);
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.t_c2, cx + 40, cy - 8);
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.c1_c2, cx, cy + 55);
      // Center (all 3)
      ctx.font = '800 18px Syne, sans-serif';
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.all3, cx, cy + 18);
      ctx.font = '400 9px Inter, sans-serif';
      ctx.fillStyle = VIZ_COLORS.muted; ctx.fillText('shared by all', cx, cy + 32);
    })();` : ''}

    // ═══ COMPETITIVE GRAVITY MAP ═══
    (function() {
      const c = document.getElementById('gravityCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const data = ${JSON.stringify(gravityMap)};

      // Simple force layout — position nodes
      const nodes = data.nodes.map((n, i) => {
        const angle = (i / data.nodes.length) * Math.PI * 2;
        const dist = n.role === 'target' ? 0 : 140;
        return { ...n, x: W/2 + Math.cos(angle) * dist, y: H/2 + Math.sin(angle) * dist, vx: 0, vy: 0 };
      });

      // Simple force simulation (50 iterations)
      const edges = data.edges;
      const maxWeight = Math.max(...edges.map(e => e.weight), 1);
      for (let iter = 0; iter < 80; iter++) {
        // Repulsion between all nodes
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x;
            const dy = nodes[j].y - nodes[i].y;
            const dist = Math.max(Math.sqrt(dx*dx + dy*dy), 1);
            const force = 3000 / (dist * dist);
            nodes[i].vx -= (dx / dist) * force;
            nodes[i].vy -= (dy / dist) * force;
            nodes[j].vx += (dx / dist) * force;
            nodes[j].vy += (dy / dist) * force;
          }
        }
        // Attraction along edges
        for (const e of edges) {
          const a = nodes.find(n => n.id === e.source);
          const b = nodes.find(n => n.id === e.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx*dx + dy*dy), 1);
          const strength = (e.weight / maxWeight) * 0.15;
          a.vx += dx * strength; a.vy += dy * strength;
          b.vx -= dx * strength; b.vy -= dy * strength;
        }
        // Center gravity
        for (const n of nodes) {
          n.vx += (W/2 - n.x) * 0.01;
          n.vy += (H/2 - n.y) * 0.01;
          n.x += n.vx * 0.3; n.y += n.vy * 0.3;
          n.vx *= 0.8; n.vy *= 0.8;
          n.x = Math.max(50, Math.min(W - 50, n.x));
          n.y = Math.max(50, Math.min(H - 50, n.y));
        }
      }

      // Draw edges
      for (const e of edges) {
        const a = nodes.find(n => n.id === e.source);
        const b = nodes.find(n => n.id === e.target);
        if (!a || !b) continue;
        const alpha = Math.min(0.6, (e.weight / maxWeight) * 0.8 + 0.1);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = 'rgba(124,109,235,' + alpha + ')';
        ctx.lineWidth = Math.max(1, (e.weight / maxWeight) * 4);
        ctx.stroke();
        // Weight label
        if (e.weight > maxWeight * 0.3) {
          ctx.font = '400 9px Inter, sans-serif';
          ctx.fillStyle = VIZ_COLORS.muted;
          ctx.textAlign = 'center';
          ctx.fillText(e.weight, (a.x + b.x) / 2, (a.y + b.y) / 2 - 4);
        }
      }

      // Draw nodes
      const maxSize = Math.max(...nodes.map(n => n.size), 1);
      for (const n of nodes) {
        const r = 12 + (n.size / maxSize) * 24;
        const color = n.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[nodes.indexOf(n) % VIZ_COLORS.comps.length];
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color + '30';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = n.role === 'target' ? 3 : 1.5;
        ctx.stroke();

        ctx.font = '600 11px Syne, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y - r - 6);
        ctx.font = '400 9px Inter, sans-serif';
        ctx.fillStyle = VIZ_COLORS.muted;
        ctx.fillText(n.size + ' kw', n.x, n.y + 4);
      }
    })();

    // ═══ CONTENT TERRAIN ═══
    (function() {
      const c = document.getElementById('terrainCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const pages = ${JSON.stringify(contentTerrain)};
      const pad = { l: 50, r: 20, t: 20, b: 30 };

      const maxWc = Math.min(5000, Math.max(...pages.map(p => p.word_count)));
      const maxDepth = Math.max(...pages.map(p => p.click_depth), 3);

      // Grid
      ctx.strokeStyle = VIZ_COLORS.grid;
      ctx.lineWidth = 0.5;
      for (let d = 0; d <= maxDepth; d++) {
        const x = pad.l + (d / maxDepth) * (W - pad.l - pad.r);
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
        ctx.fillText('d' + d, x, H - pad.b + 14);
      }
      for (let wc = 0; wc <= maxWc; wc += 1000) {
        const y = H - pad.b - (wc / maxWc) * (H - pad.t - pad.b);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'right';
        ctx.fillText(wc >= 1000 ? (wc / 1000) + 'k' : wc, pad.l - 6, y + 3);
      }

      // Plot pages
      const domainColors = {};
      let ci = 0;
      pages.forEach(p => {
        if (!domainColors[p.domain]) {
          domainColors[p.domain] = p.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        }
        const x = pad.l + (p.click_depth / maxDepth) * (W - pad.l - pad.r) + (Math.random() - 0.5) * 20;
        const y = H - pad.b - (Math.min(p.word_count, maxWc) / maxWc) * (H - pad.t - pad.b);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = domainColors[p.domain] + '70';
        ctx.fill();
      });

      // Legend
      let lx = pad.l;
      Object.entries(domainColors).forEach(([domain, color]) => {
        ctx.fillStyle = color; ctx.fillRect(lx, 6, 8, 8);
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'left';
        const label = domain.replace(/^www\\./, '').split('.')[0];
        ctx.fillText(label, lx + 11, 14);
        lx += ctx.measureText(label).width + 22;
      });
    })();

    // ═══ PERFORMANCE BUBBLES ═══
    (function() {
      const c = document.getElementById('bubbleCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const pages = ${JSON.stringify(performanceBubbles)};
      const pad = { l: 55, r: 20, t: 20, b: 30 };

      const maxMs = Math.min(4000, Math.max(...pages.map(p => p.load_ms)));
      const maxDepth = Math.max(...pages.map(p => p.click_depth), 3);
      const maxWc = Math.max(...pages.map(p => p.word_count), 1);

      // Grid
      ctx.strokeStyle = VIZ_COLORS.grid; ctx.lineWidth = 0.5;
      for (let d = 0; d <= maxDepth; d++) {
        const x = pad.l + (d / maxDepth) * (W - pad.l - pad.r);
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
        ctx.fillText('d' + d, x, H - pad.b + 14);
      }
      for (let ms = 0; ms <= maxMs; ms += 1000) {
        const y = H - pad.b - (ms / maxMs) * (H - pad.t - pad.b);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'right';
        ctx.fillText(ms + 'ms', pad.l - 6, y + 3);
      }

      // Bubbles
      const domainColors = {};
      let ci = 0;
      pages.forEach(p => {
        if (!domainColors[p.domain]) {
          domainColors[p.domain] = p.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        }
        const x = pad.l + (p.click_depth / maxDepth) * (W - pad.l - pad.r) + (Math.random() - 0.5) * 16;
        const y = H - pad.b - (Math.min(p.load_ms, maxMs) / maxMs) * (H - pad.t - pad.b);
        const r = 3 + (p.word_count / maxWc) * 16;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = domainColors[p.domain] + '40';
        ctx.fill();
        ctx.strokeStyle = domainColors[p.domain] + '80';
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Legend
      let lx = pad.l;
      Object.entries(domainColors).forEach(([domain, color]) => {
        ctx.fillStyle = color; ctx.fillRect(lx, 6, 8, 8);
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'left';
        const label = domain.replace(/^www\\./, '').split('.')[0];
        ctx.fillText(label, lx + 11, 14);
        lx += ctx.measureText(label).width + 22;
      });
    })();

    // ═══ HEADING DEPTH FLOW (Sankey-style) ═══
    (function() {
      const c = document.getElementById('headingFlowCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const data = ${JSON.stringify(headingFlow)};
      const domains = Object.entries(data);
      if (!domains.length) return;

      const pad = { l: 80, r: 30, t: 40, b: 20 };
      const colW = (W - pad.l - pad.r) / 3;
      const levels = ['h1', 'h2', 'h3'];
      const maxTotal = Math.max(...domains.map(([, d]) => d.h1 + d.h2 + d.h3), 1);
      const rowH = (H - pad.t - pad.b) / domains.length;

      // Column headers
      ctx.font = '600 11px Syne'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'center';
      ['H1', 'H2', 'H3'].forEach((label, i) => {
        ctx.fillText(label, pad.l + colW * i + colW / 2, pad.t - 10);
      });

      let ci = 0;
      domains.forEach(([domain, d], di) => {
        const color = d.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const y = pad.t + di * rowH + rowH / 2;

        // Domain label
        ctx.font = '500 10px Inter'; ctx.fillStyle = color; ctx.textAlign = 'right';
        ctx.fillText(domain.replace(/^www\\./, '').split('.')[0], pad.l - 10, y + 4);

        // Draw flow bars per level
        levels.forEach((level, li) => {
          const val = d[level] || 0;
          const barW = (val / maxTotal) * colW * 0.85;
          const x = pad.l + colW * li + (colW - barW) / 2;
          const barH = Math.max(rowH * 0.5, 8);

          ctx.fillStyle = color + '35';
          ctx.fillRect(x, y - barH / 2, barW, barH);
          ctx.strokeStyle = color + '60';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y - barH / 2, barW, barH);

          if (val > 0) {
            ctx.font = '600 9px Inter'; ctx.fillStyle = color; ctx.textAlign = 'center';
            ctx.fillText(val, x + barW / 2, y + 4);
          }
        });

        // Flow connections between levels
        for (let li = 0; li < 2; li++) {
          const val1 = d[levels[li]] || 0;
          const val2 = d[levels[li + 1]] || 0;
          if (val1 === 0 || val2 === 0) continue;
          const w1 = (val1 / maxTotal) * colW * 0.85;
          const w2 = (val2 / maxTotal) * colW * 0.85;
          const x1 = pad.l + colW * li + (colW + w1) / 2;
          const x2 = pad.l + colW * (li + 1) + (colW - w2) / 2;
          ctx.beginPath();
          ctx.moveTo(x1, y); ctx.lineTo(x2, y);
          ctx.strokeStyle = color + '25';
          ctx.lineWidth = Math.max(2, Math.min(val1, val2) / maxTotal * 20);
          ctx.stroke();
        }
      });
    })();

    // ═══ TERRITORY CONTROL TREEMAP ═══
    (function() {
      const c = document.getElementById('treemapCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      // Prefer topic cluster mapper output (semantic clusters) over keyword-first-word grouping
      const data = ${JSON.stringify(topicClusters || null)} || ${JSON.stringify(territoryTreemap)};
      if (!data || !data.length) return;

      // Simple squarified treemap layout
      const totalArea = data.reduce((s, d) => s + d.totalFreq, 0);
      let x = 4, y = 4, remainW = W - 8, remainH = H - 8;

      const domainColorMap = {};
      let ci = 0;

      data.forEach((cluster, i) => {
        const area = (cluster.totalFreq / totalArea) * (W - 8) * (H - 8);
        let rw, rh;

        if (remainW > remainH) {
          rw = Math.min(area / remainH, remainW);
          rh = remainH;
          if (i === data.length - 1) rw = remainW;
        } else {
          rh = Math.min(area / remainW, remainH);
          rw = remainW;
          if (i === data.length - 1) rh = remainH;
        }
        rw = Math.max(rw, 2); rh = Math.max(rh, 2);

        // Determine dominant domain color
        let color = VIZ_COLORS.muted;
        if (cluster.dominant) {
          const dom = cluster.dominant.domain;
          if (!domainColorMap[dom]) {
            const role = Object.values(data).find(d => d.dominant?.domain === dom);
            domainColorMap[dom] = dom === '${targetDomain}' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
          }
          color = domainColorMap[dom] || VIZ_COLORS.muted;
        }

        ctx.fillStyle = color + '25';
        ctx.fillRect(x, y, rw - 2, rh - 2);
        ctx.strokeStyle = color + '50';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, rw - 2, rh - 2);

        // Label — clip text to cell bounds so it never overlaps neighbors
        if (rw > 40 && rh > 24) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, rw - 2, rh - 2);
          ctx.clip();
          ctx.font = '600 11px Syne'; ctx.fillStyle = color;
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          ctx.fillText(cluster.cluster, x + 5, y + 5, rw - 12);
          ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted;
          ctx.fillText(cluster.keywords + ' kw · ' + cluster.totalFreq + ' freq', x + 5, y + 20, rw - 12);
          ctx.restore();
        }

        if (remainW > remainH) {
          x += rw; remainW -= rw;
        } else {
          y += rh; remainH -= rh;
        }
      });
      ctx.textBaseline = 'alphabetic';
    })();

    // ═══ LINK DNA STRAND ═══
    (function() {
      const c = document.getElementById('dnaCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const data = ${JSON.stringify(linkDna)};
      if (!data.length) return;

      const maxLinks = Math.max(...data.map(d => d.total_links), 1);
      const barH = 30;
      const gap = Math.min(50, (H - 40) / data.length);
      const startY = (H - data.length * gap) / 2;
      const centerX = W / 2;

      let ci = 0;
      data.forEach((d, i) => {
        const color = d.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const y = startY + i * gap;
        const intW = (d.internal_links / maxLinks) * (centerX - 80);
        const extW = (d.external_links / maxLinks) * (centerX - 80);

        // Internal bar (left from center)
        ctx.fillStyle = color + '40';
        ctx.fillRect(centerX - intW, y - barH / 4, intW, barH / 2);
        ctx.strokeStyle = color + '80';
        ctx.lineWidth = 1;
        ctx.strokeRect(centerX - intW, y - barH / 4, intW, barH / 2);

        // External bar (right from center)
        ctx.fillStyle = color + '25';
        ctx.fillRect(centerX, y - barH / 4, extW, barH / 2);
        ctx.strokeStyle = color + '50';
        ctx.strokeRect(centerX, y - barH / 4, extW, barH / 2);

        // Helix connecting curves
        const helixR = barH / 3;
        ctx.beginPath();
        ctx.ellipse(centerX, y, 6, helixR, 0, 0, Math.PI * 2);
        ctx.fillStyle = color + '30';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Labels
        ctx.font = '500 10px Inter'; ctx.fillStyle = color; ctx.textAlign = 'left';
        ctx.fillText(d.domain.replace(/^www\\./, '').split('.')[0], 8, y + 4);

        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted;
        ctx.textAlign = 'right';
        ctx.fillText(d.internal_links.toLocaleString() + ' int', centerX - intW - 6, y + 3);
        ctx.textAlign = 'left';
        ctx.fillText(d.external_links.toLocaleString() + ' ext', centerX + extW + 6, y + 3);
      });

      // Center line + labels
      ctx.strokeStyle = VIZ_COLORS.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(centerX, 10); ctx.lineTo(centerX, H - 10); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 9px Syne'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
      ctx.fillText('← INTERNAL', centerX - 60, H - 4);
      ctx.fillText('EXTERNAL →', centerX + 60, H - 4);
    })();

    // ═══ LINK RADAR PULSE ═══
    (function() {
      const c = document.getElementById('linkRadarCanvas${suffix}');
      if (!c) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      const data = ${JSON.stringify(linkRadarPulse)};
      const domains = Object.entries(data);
      if (!domains.length) return;

      const cx = W / 2, cy = H / 2;
      const maxR = Math.min(cx, cy) - 40;
      const rings = 4; // depth 0-3

      // Draw rings
      for (let r = 1; r <= rings; r++) {
        const radius = (r / rings) * maxR;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = VIZ_COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.font = '400 8px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'left';
        ctx.fillText('d' + (r - 1), cx + radius + 4, cy);
      }

      // Each domain gets a slice of the circle
      const sliceAngle = (Math.PI * 2) / domains.length;
      let ci = 0;

      domains.forEach(([domain, d], di) => {
        const color = d.role === 'target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const angle = di * sliceAngle - Math.PI / 2;
        const maxLinks = Math.max(...d.depths.map(dp => dp.internal + dp.external), 1);

        // Draw sector for each depth level
        d.depths.forEach(dp => {
          const ring = dp.depth + 1;
          const innerR = ((ring - 1) / rings) * maxR;
          const outerR = (ring / rings) * maxR;
          const intensity = (dp.internal + dp.external) / maxLinks;
          const arcWidth = sliceAngle * 0.8;

          ctx.beginPath();
          ctx.arc(cx, cy, innerR + (outerR - innerR) * intensity, angle - arcWidth / 2, angle + arcWidth / 2);
          ctx.arc(cx, cy, innerR, angle + arcWidth / 2, angle - arcWidth / 2, true);
          ctx.closePath();
          ctx.fillStyle = color + Math.round(intensity * 60 + 15).toString(16).padStart(2, '0');
          ctx.fill();
          ctx.strokeStyle = color + '40';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        });

        // Domain label at outer edge
        const labelR = maxR + 18;
        const lx = cx + Math.cos(angle) * labelR;
        const ly = cy + Math.sin(angle) * labelR;
        ctx.font = '600 9px Syne'; ctx.fillStyle = color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(domain.replace(/^www\\./, '').split('.')[0], lx, ly);
      });
      ctx.textBaseline = 'alphabetic';

      // Center dot
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = VIZ_COLORS.target; ctx.fill();
    })();

  </script>`;

  // ── Compose full HTML ──
  return headHtml + '\n<body>\n' + panelHtml + '\n' + scriptHtml + '\n</body>\n</html>';
}

// ─── Multi-Project Dashboard Builder ──────────────────────────────────────────

function buildMultiHtmlTemplate(allProjectData) {
  const firstProject = allProjectData[0].project;

  // Get headHtml from the first project (CSS is shared — project-agnostic)
  const firstFull = buildHtmlTemplate(allProjectData[0], { suffix: '-' + firstProject });
  // Extract just the <head> section from the full HTML
  const headEnd = firstFull.indexOf('</head>');
  let headHtml = firstFull.slice(0, headEnd);

  // Inject multi-project CSS BEFORE the closing </style> tag
  const styleCloseIdx = headHtml.lastIndexOf('</style>');
  const multiCss = `
    /* ─── Multi-Project Switcher ─── */
    .project-switcher {
      max-width: var(--max-width);
      margin: 0 auto 16px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .project-switcher label {
      font-family: var(--font-display);
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .project-switcher select {
      background: var(--bg-card);
      color: var(--text-primary);
      border: 1px solid var(--border-card);
      border-radius: var(--radius);
      padding: 8px 36px 8px 14px;
      font-family: var(--font-body);
      font-size: 0.9rem;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      transition: border-color 0.2s;
    }
    .project-switcher select:hover { border-color: var(--text-muted); }
    .project-switcher select:focus { outline: none; border-color: var(--accent-gold); }
    .project-switcher .project-count {
      font-family: var(--font-body);
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .project-panel[data-project] { transition: opacity 0.15s ease; }
  `;
  headHtml = headHtml.slice(0, styleCloseIdx) + multiCss + headHtml.slice(styleCloseIdx) + '\n</head>';

  // Build panel HTML for each project
  const panels = allProjectData.map((data, i) => {
    const panel = buildHtmlTemplate(data, { suffix: '-' + data.project, panelOnly: true });
    // Hide all panels except the first
    if (i === 0) return panel;
    return panel.replace(
      `<div class="project-panel" data-project="${data.project}">`,
      `<div class="project-panel" data-project="${data.project}" style="display:none;">`
    );
  });

  // Build the chart data store for all projects
  const allChartData = {};
  for (const data of allProjectData) {
    allChartData[data.project] = {
      radarData: data.radarData,
      contentVolumeData: data.contentVolumeData,
      internalLinksTopPages: data.internalLinks.topPages,
      keywordVenn: data.keywordVenn,
      gravityMap: data.gravityMap,
      contentTerrain: data.contentTerrain,
      performanceBubbles: data.performanceBubbles,
      headingFlow: data.headingFlow,
      territoryTreemap: data.territoryTreemap || data.topicClusters,
      topicClusters: data.topicClusters,
      linkDna: data.linkDna,
      linkRadarPulse: data.linkRadarPulse,
      targetDomain: data.targetDomain,
      gscChart: data.gscData ? data.gscData.chart : null,
    };
  }

  // Title from all project names
  const projectNames = allProjectData.map(d => d.project.toUpperCase()).join(' · ');

  return `${headHtml}
<body>

  <!-- PROJECT SWITCHER (hidden for single project) -->
  ${allProjectData.length > 1 ? `
  <div class="project-switcher">
    <label for="projectSelect"><i class="fa-solid fa-layer-group" style="margin-right:6px;"></i> Project</label>
    <select id="projectSelect" onchange="switchProject(this.value)">
      ${allProjectData.map((d, i) =>
        `<option value="${d.project}" ${i === 0 ? 'selected' : ''}>${d.project.toUpperCase()} — ${d.targetDomain}</option>`
      ).join('\n      ')}
    </select>
    <span class="project-count">${allProjectData.length} projects</span>
  </div>` : ''}

  <!-- PROJECT PANELS -->
  ${panels.join('\n')}

  <script>
    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-PROJECT DASHBOARD — Chart Init + Project Switching
    // ═══════════════════════════════════════════════════════════════════════════

    const COLORS = {
      gold: '#e8d5a3', purple: '#7c6deb', success: '#8ecba8', danger: '#d98e8e',
      info: '#8bbdd9', textPrimary: '#f0f0f0', textMuted: '#555555', gridLines: '#222222',
      competitors: ['#7c6deb','#8bbdd9','#8ecba8','#d9a88e','#b89ed9','#8bbdb8','#d9c78b','#a3b8d9','#c9a3d9']
    };
    const VIZ_COLORS = {
      target: '#e8d5a3',
      comps: ['#7c6deb','#8bbdd9','#8ecba8','#d9a88e','#b89ed9','#8bbdb8','#d9c78b','#a3b8d9','#c9a3d9'],
      bg: '#111111', grid: '#222222', text: '#b8b8b8', muted: '#555555'
    };

    const ALL_DATA = ${JSON.stringify(allChartData)};

    // Track Chart.js instances per project for destroy/recreate
    const chartInstances = {};
    let currentProject = '${firstProject}';

    // ── CHART.JS INITIALIZER ──
    function initCharts(project) {
      const sfx = '-' + project;
      const d = ALL_DATA[project];
      if (!d) return;

      // Destroy existing
      if (chartInstances[project]) {
        chartInstances[project].forEach(c => c.destroy());
      }
      chartInstances[project] = [];

      // Radar
      const radarEl = document.getElementById('radarChart' + sfx);
      if (radarEl && d.radarData?.datasets?.length) {
        chartInstances[project].push(new Chart(radarEl, {
          type: 'radar',
          data: {
            labels: d.radarData.labels,
            datasets: d.radarData.datasets.map((ds, i) => ({
              ...ds,
              borderColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
              backgroundColor: ds.isTarget ? 'rgba(232,213,163,0.1)' : COLORS.competitors[i % COLORS.competitors.length] + '18',
              borderWidth: ds.isTarget ? 3 : 2,
              pointBackgroundColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
              pointBorderColor: ds.isTarget ? COLORS.gold : COLORS.competitors[i % COLORS.competitors.length],
              pointRadius: ds.isTarget ? 5 : 3, pointHoverRadius: 7,
            }))
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { r: { beginAtZero: true, max: 100, grid: { color: COLORS.gridLines }, angleLines: { color: COLORS.gridLines }, ticks: { color: COLORS.textMuted, backdropColor: 'transparent', stepSize: 20 }, pointLabels: { color: COLORS.textPrimary, font: { size: 11, weight: '500' } } } },
            plugins: { legend: { position: 'bottom', labels: { color: COLORS.textPrimary, usePointStyle: true, padding: 20, font: { size: 11 } } }, tooltip: { backgroundColor: '#161616', titleColor: COLORS.gold, bodyColor: COLORS.textPrimary, borderColor: COLORS.gridLines, borderWidth: 1, cornerRadius: 4, padding: 12 } }
          }
        }));
      }

      // Content Volume
      const volEl = document.getElementById('contentVolumeChart' + sfx);
      if (volEl && d.contentVolumeData?.labels?.length) {
        chartInstances[project].push(new Chart(volEl, {
          type: 'bar',
          data: { labels: d.contentVolumeData.labels, datasets: [{ label: 'Total Word Count', data: d.contentVolumeData.values, backgroundColor: d.contentVolumeData.colors, borderColor: d.contentVolumeData.colors, borderWidth: 0, borderRadius: 6, barThickness: 24 }] },
          options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { grid: { color: COLORS.gridLines }, ticks: { color: COLORS.textMuted } }, y: { grid: { display: false }, ticks: { color: COLORS.textPrimary, font: { weight: '500' } } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#161616', titleColor: COLORS.gold, bodyColor: COLORS.textPrimary, borderColor: COLORS.gridLines, borderWidth: 1, cornerRadius: 4, callbacks: { label: ctx => ' ' + ctx.parsed.x.toLocaleString() + ' words' } } } }
        }));
      }

      // Internal Links
      const linksEl = document.getElementById('internalLinksChart' + sfx);
      if (linksEl && d.internalLinksTopPages?.length) {
        chartInstances[project].push(new Chart(linksEl, {
          type: 'bar',
          data: { labels: d.internalLinksTopPages.map(p => p.label), datasets: [{ label: 'Inbound Links', data: d.internalLinksTopPages.map(p => p.count), backgroundColor: COLORS.info, borderRadius: 4, barThickness: 18 }] },
          options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { grid: { color: COLORS.gridLines }, ticks: { color: COLORS.textMuted } }, y: { grid: { display: false }, ticks: { color: COLORS.textPrimary, font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#161616', titleColor: COLORS.gold, bodyColor: COLORS.textPrimary, borderColor: COLORS.gridLines, borderWidth: 1, cornerRadius: 8 } } }
        }));
      }

      // GSC Performance Trend
      const gscEl = document.getElementById('gscTrendChart' + sfx);
      if (gscEl && d.gscChart?.length) {
        const labels = d.gscChart.map(r => { const dt = new Date(r.date); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); });
        chartInstances[project].push(new Chart(gscEl, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'Clicks', data: d.gscChart.map(r => r.clicks), borderColor: '#8bbdd9', backgroundColor: 'rgba(139,189,217,0.08)', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#8bbdd9', tension: 0.3, fill: true, yAxisID: 'y' },
              { label: 'Impressions', data: d.gscChart.map(r => r.impressions), borderColor: '#7c6deb', backgroundColor: 'rgba(124,109,235,0.05)', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#7c6deb', tension: 0.3, fill: true, yAxisID: 'y1' },
              { label: 'Avg Position', data: d.gscChart.map(r => r.position), borderColor: '#e8d5a3', borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, pointHoverRadius: 3, pointHoverBackgroundColor: '#e8d5a3', tension: 0.3, fill: false, yAxisID: 'y2' }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
              x: { grid: { color: '#222222', drawBorder: false }, ticks: { color: '#555555', font: { size: 10 }, maxRotation: 45, maxTicksLimit: 15 } },
              y: { type: 'linear', position: 'left', title: { display: true, text: 'Clicks', color: '#8bbdd9', font: { size: 10 } }, grid: { color: '#222222' }, ticks: { color: '#8bbdd9', font: { size: 10 } }, beginAtZero: true },
              y1: { type: 'linear', position: 'right', title: { display: true, text: 'Impressions', color: '#7c6deb', font: { size: 10 } }, grid: { drawOnChartArea: false }, ticks: { color: '#7c6deb', font: { size: 10 } }, beginAtZero: true },
              y2: { type: 'linear', position: 'right', title: { display: false }, grid: { drawOnChartArea: false }, ticks: { display: false }, reverse: true, beginAtZero: false }
            },
            plugins: {
              legend: { position: 'bottom', labels: { color: '#f0f0f0', usePointStyle: true, padding: 20, font: { size: 11 } } },
              tooltip: { backgroundColor: '#161616', titleColor: '#e8d5a3', bodyColor: '#f0f0f0', borderColor: '#222222', borderWidth: 1, cornerRadius: 4, padding: 12, callbacks: { label: function(ctx) { if (ctx.dataset.label === 'Avg Position') return 'Pos: ' + ctx.parsed.y.toFixed(1); return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString(); } } }
            }
          }
        }));
      }
    }

    // ── CUSTOM CANVAS RENDERERS ──
    function drawAllCanvases(project) {
      const sfx = '-' + project;
      const d = ALL_DATA[project];
      if (!d) return;

      drawVenn(d.keywordVenn, sfx);
      drawGravity(d.gravityMap, sfx);
      drawTerrain(d.contentTerrain, sfx);
      drawBubbles(d.performanceBubbles, sfx);
      drawHeadingFlow(d.headingFlow, sfx);
      drawTreemap(d.topicClusters || d.territoryTreemap, sfx, d.targetDomain);
      drawDna(d.linkDna, sfx);
      drawLinkRadar(d.linkRadarPulse, sfx);
    }

    function drawVenn(data, sfx) {
      if (!data?.hasData) return;
      const c = document.getElementById('vennCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height, cx = W/2, cy = H/2, R = 120;
      const circles = [
        { x: cx, y: cy-50, r: R, color: VIZ_COLORS.target, label: data.sets[0].label, total: data.sets[0].total },
        { x: cx-70, y: cy+40, r: R*0.9, color: VIZ_COLORS.comps[0], label: data.sets[1].label, total: data.sets[1].total },
        { x: cx+70, y: cy+40, r: R*0.85, color: VIZ_COLORS.comps[1], label: data.sets[2].label, total: data.sets[2].total }
      ];
      circles.forEach(ci => { ctx.beginPath(); ctx.arc(ci.x, ci.y, ci.r, 0, Math.PI*2); ctx.fillStyle = ci.color+'18'; ctx.fill(); ctx.strokeStyle = ci.color+'60'; ctx.lineWidth = 2; ctx.stroke(); });
      ctx.font = '600 13px Syne, sans-serif'; ctx.textAlign = 'center';
      circles.forEach((ci, i) => { const offY = i===0 ? -ci.r-14 : ci.r+18; ctx.fillStyle = ci.color; ctx.fillText(ci.label+' ('+ci.total+')', ci.x, ci.y+offY); });
      const z = data.zones;
      ctx.font = '700 16px Syne, sans-serif';
      ctx.fillStyle = VIZ_COLORS.target+'cc'; ctx.fillText(z.t_only, cx, cy-90);
      ctx.fillStyle = VIZ_COLORS.comps[0]+'cc'; ctx.fillText(z.c1_only, cx-100, cy+70);
      ctx.fillStyle = VIZ_COLORS.comps[1]+'cc'; ctx.fillText(z.c2_only, cx+100, cy+70);
      ctx.font = '700 14px Syne, sans-serif';
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.t_c1, cx-40, cy-8);
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.t_c2, cx+40, cy-8);
      ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.c1_c2, cx, cy+55);
      ctx.font = '800 18px Syne, sans-serif'; ctx.fillStyle = '#f0f0f0'; ctx.fillText(z.all3, cx, cy+18);
      ctx.font = '400 9px Inter, sans-serif'; ctx.fillStyle = VIZ_COLORS.muted; ctx.fillText('shared by all', cx, cy+32);
    }

    function drawGravity(data, sfx) {
      const c = document.getElementById('gravityCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      const margin = 70;
      const nodes = data.nodes.map((n, i) => { const angle = (i/data.nodes.length)*Math.PI*2; const dist = n.role==='target' ? 0 : 170; return {...n, x: W/2+Math.cos(angle)*dist, y: H/2+Math.sin(angle)*dist, vx: 0, vy: 0}; });
      const edges = data.edges; const maxWeight = Math.max(...edges.map(e => e.weight), 1);
      for (let iter = 0; iter < 80; iter++) {
        for (let i = 0; i < nodes.length; i++) { for (let j = i+1; j < nodes.length; j++) { const dx = nodes[j].x-nodes[i].x; const dy = nodes[j].y-nodes[i].y; const dist = Math.max(Math.sqrt(dx*dx+dy*dy), 1); const force = 4000/(dist*dist); nodes[i].vx -= (dx/dist)*force; nodes[i].vy -= (dy/dist)*force; nodes[j].vx += (dx/dist)*force; nodes[j].vy += (dy/dist)*force; } }
        for (const e of edges) { const a = nodes.find(n => n.id===e.source); const b = nodes.find(n => n.id===e.target); if (!a||!b) continue; const dx = b.x-a.x; const dy = b.y-a.y; const dist = Math.max(Math.sqrt(dx*dx+dy*dy), 1); const strength = (e.weight/maxWeight)*0.12; a.vx += dx*strength; a.vy += dy*strength; b.vx -= dx*strength; b.vy -= dy*strength; }
        nodes.forEach(n => { n.vx += (W/2-n.x)*0.01; n.vy += (H/2-n.y)*0.01; n.x += n.vx*0.3; n.y += n.vy*0.3; n.vx *= 0.8; n.vy *= 0.8; n.x = Math.max(margin, Math.min(W-margin, n.x)); n.y = Math.max(margin, Math.min(H-margin, n.y)); });
      }
      edges.forEach(e => { const a = nodes.find(n => n.id===e.source); const b = nodes.find(n => n.id===e.target); if (!a||!b) return; const alpha = Math.min(0.6, (e.weight/maxWeight)*0.8+0.1); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = 'rgba(124,109,235,'+alpha+')'; ctx.lineWidth = Math.max(1, (e.weight/maxWeight)*4); ctx.stroke(); if (e.weight > maxWeight*0.3) { ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center'; ctx.fillText(e.weight, (a.x+b.x)/2, (a.y+b.y)/2-6); } });
      const maxSize = Math.max(...nodes.map(n => n.size), 1);
      nodes.forEach(n => { const r = 14+(n.size/maxSize)*26; const color = n.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[nodes.indexOf(n) % VIZ_COLORS.comps.length]; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2); ctx.fillStyle = color+'30'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = n.role==='target' ? 3 : 1.5; ctx.stroke(); ctx.font = '600 12px Syne'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(n.label, n.x, n.y-r-8); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.fillText(n.size+' kw', n.x, n.y+4); });
    }

    function drawTerrain(pages, sfx) {
      const c = document.getElementById('terrainCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      if (!pages?.length) return;
      const pad = { l: 62, r: 25, t: 32, b: 48 };
      const maxWc = Math.min(5000, Math.max(...pages.map(p => p.word_count)));
      const maxDepth = Math.max(...pages.map(p => p.click_depth), 3);
      // Grid
      ctx.strokeStyle = VIZ_COLORS.grid; ctx.lineWidth = 0.5;
      for (let d = 0; d <= maxDepth; d++) { const x = pad.l+(d/maxDepth)*(W-pad.l-pad.r); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H-pad.b); ctx.stroke(); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center'; ctx.fillText('d'+d, x, H-pad.b+16); }
      for (let wc = 0; wc <= maxWc; wc += 1000) { const y = H-pad.b-(wc/maxWc)*(H-pad.t-pad.b); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W-pad.r, y); ctx.stroke(); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'right'; ctx.fillText(wc >= 1000 ? (wc/1000)+'k' : wc, pad.l-8, y+3); }
      // Axis titles
      ctx.font = '600 10px Syne'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
      ctx.fillText('Click Depth', pad.l+(W-pad.l-pad.r)/2, H-4);
      ctx.save(); ctx.translate(14, pad.t+(H-pad.t-pad.b)/2); ctx.rotate(-Math.PI/2); ctx.fillText('Word Count', 0, 0); ctx.restore();
      // Plot pages
      const domainColors = {}; let ci = 0;
      pages.forEach(p => {
        if (!domainColors[p.domain]) { domainColors[p.domain] = p.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length]; }
        const x = pad.l+(p.click_depth/maxDepth)*(W-pad.l-pad.r)+(Math.random()-0.5)*24;
        const y = H-pad.b-(Math.min(p.word_count, maxWc)/maxWc)*(H-pad.t-pad.b);
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI*2); ctx.fillStyle = domainColors[p.domain]+'70'; ctx.fill();
      });
      // Legend
      let lx = pad.l;
      Object.entries(domainColors).forEach(([domain, color]) => { ctx.fillStyle = color; ctx.fillRect(lx, 8, 10, 10); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'left'; const label = domain.replace(/^www\\./, '').split('.')[0]; ctx.fillText(label, lx+13, 17); lx += ctx.measureText(label).width+26; });
    }

    function drawBubbles(pages, sfx) {
      if (!pages?.length) return;
      const c = document.getElementById('bubbleCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      const pad = { l: 65, r: 25, t: 32, b: 48 };
      const maxMs = Math.min(4000, Math.max(...pages.map(p => p.load_ms)));
      const maxDepth = Math.max(...pages.map(p => p.click_depth), 3);
      const maxWc = Math.max(...pages.map(p => p.word_count), 1);
      // Grid
      ctx.strokeStyle = VIZ_COLORS.grid; ctx.lineWidth = 0.5;
      for (let d = 0; d <= maxDepth; d++) { const x = pad.l+(d/maxDepth)*(W-pad.l-pad.r); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H-pad.b); ctx.stroke(); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center'; ctx.fillText('d'+d, x, H-pad.b+16); }
      for (let ms = 0; ms <= maxMs; ms += 1000) { const y = H-pad.b-(ms/maxMs)*(H-pad.t-pad.b); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W-pad.r, y); ctx.stroke(); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'right'; ctx.fillText(ms+'ms', pad.l-8, y+3); }
      // Axis titles
      ctx.font = '600 10px Syne'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
      ctx.fillText('Click Depth', pad.l+(W-pad.l-pad.r)/2, H-4);
      ctx.save(); ctx.translate(14, pad.t+(H-pad.t-pad.b)/2); ctx.rotate(-Math.PI/2); ctx.fillText('Load Time (ms)', 0, 0); ctx.restore();
      // Bubbles
      const domainColors = {}; let ci = 0;
      pages.forEach(p => {
        if (!domainColors[p.domain]) { domainColors[p.domain] = p.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length]; }
        const x = pad.l+(p.click_depth/maxDepth)*(W-pad.l-pad.r)+(Math.random()-0.5)*20;
        const y = H-pad.b-(Math.min(p.load_ms, maxMs)/maxMs)*(H-pad.t-pad.b);
        const r = 4+(p.word_count/maxWc)*18;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fillStyle = domainColors[p.domain]+'40'; ctx.fill(); ctx.strokeStyle = domainColors[p.domain]+'80'; ctx.lineWidth = 1; ctx.stroke();
      });
      // Legend
      let lx = pad.l;
      Object.entries(domainColors).forEach(([domain, color]) => { ctx.fillStyle = color; ctx.fillRect(lx, 8, 10, 10); ctx.font = '400 10px Inter'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'left'; const label = domain.replace(/^www\\./, '').split('.')[0]; ctx.fillText(label, lx+13, 17); lx += ctx.measureText(label).width+26; });
    }

    function drawHeadingFlow(data, sfx) {
      const domains = Object.entries(data || {});
      if (!domains.length) return;
      const c = document.getElementById('headingFlowCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      const pad = { l: 80, r: 30, t: 40, b: 20 };
      const colW = (W-pad.l-pad.r)/3;
      const levels = ['h1','h2','h3'];
      const maxTotal = Math.max(...domains.map(([,d]) => d.h1+d.h2+d.h3), 1);
      const rowH = (H-pad.t-pad.b)/domains.length;
      // Column headers
      ctx.font = '600 11px Syne'; ctx.fillStyle = VIZ_COLORS.text; ctx.textAlign = 'center';
      ['H1','H2','H3'].forEach((label, i) => { ctx.fillText(label, pad.l+colW*i+colW/2, pad.t-10); });
      let ci = 0;
      domains.forEach(([domain, d], di) => {
        const color = d.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const y = pad.t+di*rowH+rowH/2;
        // Domain label
        ctx.font = '500 10px Inter'; ctx.fillStyle = color; ctx.textAlign = 'right';
        ctx.fillText(domain.replace(/^www\\./, '').split('.')[0], pad.l-10, y+4);
        // Bars per level
        levels.forEach((level, li) => {
          const val = d[level] || 0;
          const barW = (val/maxTotal)*colW*0.85;
          const x = pad.l+colW*li+(colW-barW)/2;
          const barH = Math.max(rowH*0.5, 8);
          ctx.fillStyle = color+'35'; ctx.fillRect(x, y-barH/2, barW, barH);
          ctx.strokeStyle = color+'60'; ctx.lineWidth = 1; ctx.strokeRect(x, y-barH/2, barW, barH);
          if (val > 0) { ctx.font = '600 9px Inter'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(val, x+barW/2, y+4); }
        });
        // Flow connections
        for (let li = 0; li < 2; li++) {
          const val1 = d[levels[li]] || 0; const val2 = d[levels[li+1]] || 0;
          if (val1===0 || val2===0) continue;
          const w1 = (val1/maxTotal)*colW*0.85; const w2 = (val2/maxTotal)*colW*0.85;
          const x1 = pad.l+colW*li+(colW+w1)/2; const x2 = pad.l+colW*(li+1)+(colW-w2)/2;
          ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y);
          ctx.strokeStyle = color+'25'; ctx.lineWidth = Math.max(2, Math.min(val1, val2)/maxTotal*20); ctx.stroke();
        }
      });
    }

    function drawTreemap(data, sfx, targetDomain) {
      if (!data?.length) return;
      const c = document.getElementById('treemapCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      // Squarified treemap layout (matches single-project)
      const totalArea = data.reduce((s, d) => s+d.totalFreq, 0);
      let x = 4, y = 4, remainW = W-8, remainH = H-8;
      const domainColorMap = {}; let ci = 0;
      data.forEach((cluster, i) => {
        const area = (cluster.totalFreq/totalArea)*(W-8)*(H-8);
        let rw, rh;
        if (remainW > remainH) { rw = Math.min(area/remainH, remainW); rh = remainH; if (i===data.length-1) rw = remainW; } else { rh = Math.min(area/remainW, remainH); rw = remainW; if (i===data.length-1) rh = remainH; }
        rw = Math.max(rw, 2); rh = Math.max(rh, 2);
        // Color by dominant domain
        let color = VIZ_COLORS.muted;
        if (cluster.dominant) { const dom = cluster.dominant.domain; if (!domainColorMap[dom]) { domainColorMap[dom] = dom === targetDomain ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length]; } color = domainColorMap[dom] || VIZ_COLORS.muted; }
        ctx.fillStyle = color+'25'; ctx.fillRect(x, y, rw-2, rh-2);
        ctx.strokeStyle = color+'50'; ctx.lineWidth = 1; ctx.strokeRect(x, y, rw-2, rh-2);
        // Label — clip text to cell bounds so it never overlaps neighbors
        if (rw > 40 && rh > 24) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, rw-2, rh-2); ctx.clip(); ctx.font = '600 11px Syne'; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(cluster.cluster, x+5, y+5, rw-12); ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.fillText(cluster.keywords+' kw \u00b7 '+cluster.totalFreq+' freq', x+5, y+20, rw-12); ctx.restore(); }
        if (remainW > remainH) { x += rw; remainW -= rw; } else { y += rh; remainH -= rh; }
      });
      ctx.textBaseline = 'alphabetic';
    }

    function drawDna(data, sfx) {
      if (!data?.length) return;
      const c = document.getElementById('dnaCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      const maxLinks = Math.max(...data.map(d => d.total_links), 1);
      const barH = 30;
      const gap = Math.min(50, (H-40)/data.length);
      const startY = (H-data.length*gap)/2;
      const centerX = W/2;
      let ci = 0;
      data.forEach((d, i) => {
        const color = d.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const y = startY+i*gap;
        const intW = (d.internal_links/maxLinks)*(centerX-80);
        const extW = (d.external_links/maxLinks)*(centerX-80);
        // Internal bar (left from center)
        ctx.fillStyle = color+'40'; ctx.fillRect(centerX-intW, y-barH/4, intW, barH/2);
        ctx.strokeStyle = color+'80'; ctx.lineWidth = 1; ctx.strokeRect(centerX-intW, y-barH/4, intW, barH/2);
        // External bar (right from center)
        ctx.fillStyle = color+'25'; ctx.fillRect(centerX, y-barH/4, extW, barH/2);
        ctx.strokeStyle = color+'50'; ctx.strokeRect(centerX, y-barH/4, extW, barH/2);
        // Helix
        const helixR = barH/3; ctx.beginPath(); ctx.ellipse(centerX, y, 6, helixR, 0, 0, Math.PI*2); ctx.fillStyle = color+'30'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        // Labels
        ctx.font = '500 10px Inter'; ctx.fillStyle = color; ctx.textAlign = 'left';
        ctx.fillText(d.domain.replace(/^www\\./, '').split('.')[0], 8, y+4);
        ctx.font = '400 9px Inter'; ctx.fillStyle = VIZ_COLORS.muted;
        ctx.textAlign = 'right'; ctx.fillText(d.internal_links.toLocaleString()+' int', centerX-intW-6, y+3);
        ctx.textAlign = 'left'; ctx.fillText(d.external_links.toLocaleString()+' ext', centerX+extW+6, y+3);
      });
      // Center line + labels
      ctx.strokeStyle = VIZ_COLORS.grid; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(centerX, 10); ctx.lineTo(centerX, H-10); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 9px Syne'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'center';
      ctx.fillText('\u2190 INTERNAL', centerX-60, H-4); ctx.fillText('EXTERNAL \u2192', centerX+60, H-4);
    }

    function drawLinkRadar(data, sfx) {
      const domains = Object.entries(data || {});
      if (!domains.length) return;
      const c = document.getElementById('linkRadarCanvas' + sfx); if (!c) return;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      const W = c.width, H = c.height;
      const cx = W/2, cy = H/2;
      const maxR = Math.min(cx, cy)-40;
      const rings = 4;
      // Draw rings
      for (let r = 1; r <= rings; r++) { const radius = (r/rings)*maxR; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI*2); ctx.strokeStyle = VIZ_COLORS.grid; ctx.lineWidth = 0.5; ctx.stroke(); ctx.font = '400 8px Inter'; ctx.fillStyle = VIZ_COLORS.muted; ctx.textAlign = 'left'; ctx.fillText('d'+(r-1), cx+radius+4, cy); }
      // Each domain gets a slice
      const sliceAngle = (Math.PI*2)/domains.length;
      let ci = 0;
      domains.forEach(([domain, d], di) => {
        const color = d.role==='target' ? VIZ_COLORS.target : VIZ_COLORS.comps[ci++ % VIZ_COLORS.comps.length];
        const angle = di*sliceAngle-Math.PI/2;
        const maxLinks = Math.max(...d.depths.map(dp => dp.internal+dp.external), 1);
        // Draw sector for each depth
        d.depths.forEach(dp => {
          const ring = dp.depth+1;
          const innerR = ((ring-1)/rings)*maxR; const outerR = (ring/rings)*maxR;
          const intensity = (dp.internal+dp.external)/maxLinks;
          const arcWidth = sliceAngle*0.8;
          ctx.beginPath(); ctx.arc(cx, cy, innerR+(outerR-innerR)*intensity, angle-arcWidth/2, angle+arcWidth/2);
          ctx.arc(cx, cy, innerR, angle+arcWidth/2, angle-arcWidth/2, true); ctx.closePath();
          ctx.fillStyle = color+Math.round(intensity*60+15).toString(16).padStart(2,'0'); ctx.fill();
          ctx.strokeStyle = color+'40'; ctx.lineWidth = 0.5; ctx.stroke();
        });
        // Domain label
        const labelR = maxR+18; const lx = cx+Math.cos(angle)*labelR; const ly = cy+Math.sin(angle)*labelR;
        ctx.font = '600 9px Syne'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(domain.replace(/^www\\./, '').split('.')[0], lx, ly);
      });
      ctx.textBaseline = 'alphabetic';
      // Center dot
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fillStyle = VIZ_COLORS.target; ctx.fill();
    }

    // ── PROJECT SWITCHING ──
    function switchProject(newProject) {
      if (newProject === currentProject) return;

      // Hide current
      const cur = document.querySelector('.project-panel[data-project="' + currentProject + '"]');
      if (cur) cur.style.display = 'none';

      // Destroy current Chart.js instances
      if (chartInstances[currentProject]) {
        chartInstances[currentProject].forEach(c => c.destroy());
        chartInstances[currentProject] = [];
      }

      // Show new
      const next = document.querySelector('.project-panel[data-project="' + newProject + '"]');
      if (next) next.style.display = '';

      currentProject = newProject;

      // Init charts + canvases for visible panel
      setTimeout(() => {
        initCharts(newProject);
        drawAllCanvases(newProject);
      }, 50); // small delay to let DOM paint
    }

    // ── LIVE CONTROLS (multi-project) ──
    (function() {
      var isServed = window.location.protocol.startsWith('http');
      document.querySelectorAll('.es-controls').forEach(function(el) {
        if (!isServed) {
          el.innerHTML = '<span class="es-server-note"><i class="fa-solid fa-plug"></i> <code>node cli.js serve</code></span>';
        }
      });
      if (!isServed) return;

      var pollTimer = null;

      window.startJob = function(command, proj) {
        var sfx = '-' + proj;
        var stealth = document.getElementById('stealthToggle' + sfx)?.checked || false;
        var extra = {};
        if (stealth) extra.stealth = true;

        // Route through terminal for visible output
        if (window._terminalRun) {
          window._terminalRun(command, proj, extra);
        }
        setButtonsState(true, command);
        startPolling();
      };

      window.stopJob = function() {
        if (window._terminalStop) window._terminalStop();
        fetch('/api/stop', { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function() { setButtonsState(false, null); })
          .catch(function() { setButtonsState(false, null); });
      };

      window.restartServer = function() {
        if (!confirm('Restart SEO Intel? This will stop any running jobs and refresh the dashboard.')) return;
        if (window._terminalStop) window._terminalStop();
        fetch('/api/restart', { method: 'POST' })
          .then(function() { setTimeout(function() { window.location.reload(); }, 2000); })
          .catch(function() { setTimeout(function() { window.location.reload(); }, 2000); });
      };

      window._setButtonsState = setButtonsState;
      window._startPolling = startPolling;

      function setButtonsState(isRunning, activeCmd) {
        var sfx = '-' + currentProject;
        var btnC = document.getElementById('btnCrawl' + sfx);
        var btnE = document.getElementById('btnExtract' + sfx);
        var btnS = document.getElementById('btnStop' + sfx);
        if (btnC) {
          btnC.disabled = isRunning;
          btnC.classList.toggle('running', isRunning && activeCmd === 'crawl');
          btnC.innerHTML = isRunning && activeCmd === 'crawl'
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Crawling\u2026'
            : '<i class="fa-solid fa-spider"></i> Crawl';
        }
        if (btnE) {
          btnE.disabled = isRunning;
          btnE.classList.toggle('running', isRunning && activeCmd === 'extract');
          btnE.innerHTML = isRunning && activeCmd === 'extract'
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Extracting\u2026'
            : '<i class="fa-solid fa-brain"></i> Extract';
        }
        if (btnS) {
          if (isRunning) { btnS.classList.add('active'); } else { btnS.classList.remove('active'); }
        }
      }

      function startPolling() { if (!pollTimer) { pollTimer = setInterval(pollProgress, 2000); pollProgress(); } }
      function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

      function pollProgress() {
        fetch('/api/progress').then(function(r) { return r.json(); }).then(function(data) {
          updateStatusBar(data);
          if (data.status !== 'running') { stopPolling(); setButtonsState(false, null); }
        }).catch(function() { stopPolling(); setButtonsState(false, null); });
      }

      function updateStatusBar(data) {
        var panel = document.querySelector('.project-panel[data-project="' + currentProject + '"] .extraction-status');
        if (!panel) return;
        var dot = panel.querySelector('.es-dot');
        var label = panel.querySelector('.es-indicator span:last-child');
        if (!dot || !label) return;
        if (data.status === 'running') {
          panel.classList.add('is-running'); panel.classList.remove('is-crashed');
          dot.className = 'es-dot running'; label.style.color = 'var(--accent-gold)';
          var url = data.current_url ? data.current_url.replace(/https?:\\/\\/[^/]+/, '').slice(0, 30) : '';
          var prog = data.total ? ' ' + data.page_index + '/' + data.total : '';
          label.textContent = (data.command === 'crawl' ? 'Crawling' : 'Extracting') + prog + (url ? ' \\u00b7 ' + url : '');
        } else if (data.status === 'completed') {
          panel.classList.remove('is-running', 'is-crashed');
          dot.className = 'es-dot'; label.style.color = 'var(--color-success)';
          label.textContent = 'Completed (' + (data.extracted || 0) + ' extracted)';
        } else if (data.status === 'stopped') {
          panel.classList.remove('is-running', 'is-crashed');
          dot.className = 'es-dot'; label.style.color = 'var(--accent-gold)';
          label.textContent = 'Stopped' + (data.extracted ? ' (' + data.extracted + ' extracted)' : '');
        } else if (data.status === 'crashed') {
          panel.classList.remove('is-running'); panel.classList.add('is-crashed');
          dot.className = 'es-dot crashed'; label.style.color = 'var(--color-danger)';
          label.textContent = 'Crashed (PID ' + data.pid + ')';
        }
      }

      fetch('/api/progress').then(function(r) { return r.json(); }).then(function(data) {
        if (data.status === 'running') { setButtonsState(true, data.command); startPolling(); }
      }).catch(function() {});
    })();

    // ── INIT FIRST PROJECT ──
    initCharts('${firstProject}');
    drawAllCanvases('${firstProject}');

  </script>
</body>
</html>`;
}

// ─── AEO Card Builder ────────────────────────────────────────────────────────

function buildAeoCard(citabilityData, escapeHtml) {
  const targetScores = citabilityData.filter(s => s.role === 'target' || s.role === 'owned');
  const compScores = citabilityData.filter(s => s.role === 'competitor');
  if (!targetScores.length) return '';

  const avgTarget = Math.round(targetScores.reduce((a, s) => a + s.score, 0) / targetScores.length);
  const avgComp = compScores.length ? Math.round(compScores.reduce((a, s) => a + s.score, 0) / compScores.length) : null;
  const delta = avgComp !== null ? avgTarget - avgComp : null;

  const tierCounts = { excellent: 0, good: 0, needs_work: 0, poor: 0 };
  for (const s of targetScores) tierCounts[s.tier]++;

  const signals = ['entity_authority', 'structured_claims', 'answer_density', 'qa_proximity', 'freshness', 'schema_coverage'];
  const signalAvgs = signals.map(sig => ({
    label: sig.replace(/_/g, ' '),
    avg: Math.round(targetScores.reduce((a, s) => a + (s[sig] || 0), 0) / targetScores.length),
  }));

  const scoreColor = (s) => s >= 75 ? '#4ade80' : s >= 55 ? '#facc15' : s >= 35 ? '#ff8c00' : '#ef4444';

  // Page rows (worst first, limit 25)
  const pageRows = targetScores
    .sort((a, b) => a.score - b.score)
    .slice(0, 25)
    .map(s => {
      let path;
      try { path = new URL(s.url).pathname; } catch { path = s.url; }
      let intents = [];
      try { intents = JSON.parse(s.ai_intents || '[]'); } catch { /* ok */ }
      const weakest = signals
        .map(sig => ({ sig: sig.replace(/_/g, ' '), val: s[sig] || 0 }))
        .sort((a, b) => a.val - b.val)
        .slice(0, 2);
      const tierBadge = s.tier === 'excellent' ? 'high' : s.tier === 'poor' ? 'low' : 'medium';
      return `
          <tr>
            <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${scoreColor(s.score)};margin-right:6px;"></span><strong>${s.score}</strong></td>
            <td class="phrase-cell" title="${escapeHtml(s.url)}">${escapeHtml(path.slice(0, 55))}</td>
            <td>${escapeHtml((s.title || '').slice(0, 40) || '—')}</td>
            <td><span class="badge badge-${tierBadge}">${s.tier.replace('_', ' ')}</span></td>
            <td style="font-size:0.75rem;color:var(--text-muted)">${intents.map(i => i.replace('_', ' ')).join(', ')}</td>
            <td style="font-size:0.75rem;color:var(--text-muted)">${weakest.map(w => w.sig).join(', ')}</td>
          </tr>`;
    }).join('');

  const signalBars = signalAvgs.map(s => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="width:130px;font-size:0.78rem;color:var(--text-secondary);text-transform:capitalize;">${s.label}</span>
            <div style="flex:1;background:var(--card-bg);border-radius:4px;height:14px;overflow:hidden;">
              <div style="width:${s.avg}%;height:100%;background:${scoreColor(s.avg)};border-radius:4px;transition:width .5s;"></div>
            </div>
            <span style="font-size:0.75rem;color:var(--text-muted);width:35px;text-align:right;">${s.avg}</span>
          </div>`).join('');

  let compStatHtml = '';
  if (avgComp !== null) {
    compStatHtml += `<div class="ki-stat"><span class="ki-stat-number" style="color:${scoreColor(avgComp)}">${avgComp}</span><span class="ki-stat-label">Competitor Avg</span></div>`;
  }
  if (delta !== null) {
    compStatHtml += `<div class="ki-stat"><span class="ki-stat-number" style="color:${delta >= 0 ? '#4ade80' : '#ef4444'}">${delta > 0 ? '+' : ''}${delta}</span><span class="ki-stat-label">Delta</span></div>`;
  }

  return `
    <div class="card full-width" id="aeo-citability">
      <h2><span class="icon"><i class="fa-solid fa-robot"></i></span> AI Citability Audit</h2>
      <div class="ki-stat-bar">
        <div class="ki-stat"><span class="ki-stat-number" style="color:${scoreColor(avgTarget)}">${avgTarget}</span><span class="ki-stat-label">Target Avg</span></div>
        ${compStatHtml}
        <div class="ki-stat"><span class="ki-stat-number" style="color:#4ade80">${tierCounts.excellent}</span><span class="ki-stat-label">Excellent</span></div>
        <div class="ki-stat"><span class="ki-stat-number" style="color:#facc15">${tierCounts.good}</span><span class="ki-stat-label">Good</span></div>
        <div class="ki-stat"><span class="ki-stat-number" style="color:#ff8c00">${tierCounts.needs_work}</span><span class="ki-stat-label">Needs Work</span></div>
        <div class="ki-stat"><span class="ki-stat-number" style="color:#ef4444">${tierCounts.poor}</span><span class="ki-stat-label">Poor</span></div>
      </div>

      <div style="display:flex;gap:2rem;margin:1.5rem 0;flex-wrap:wrap;">
        <div style="flex:1;min-width:300px;">
          <h3 style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.8rem;">
            <i class="fa-solid fa-signal" style="font-size:0.7rem;margin-right:3px;"></i> Signal Strength
          </h3>
          ${signalBars}
        </div>
      </div>

      <h3 style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem;margin-top:1rem;">
        <i class="fa-solid fa-list-ol" style="font-size:0.7rem;margin-right:3px;"></i> Page Scores (worst first)
      </h3>
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr><th>Score</th><th>Page</th><th>Title</th><th>Tier</th><th>AI Intent</th><th>Weakest</th></tr></thead>
          <tbody>${pageRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ─── Data Gathering Functions ────────────────────────────────────────────────

function getLatestKeywordsReport(project) {
  try {
    const reportsDir = join(__dirname, '.');  // generate-html.js is already in reports/
    const files = readdirSync(reportsDir)
      .filter(f => f.startsWith(`${project}-keywords-`) && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(reportsDir, files[0]), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Merge owned domain rows (blog.x, docs.x) into the target domain row.
 * Works on any array of objects with { domain, role, ...numeric fields }.
 * Numeric fields are summed; role is set to 'target'.
 */

/**
 * Build a domain resolver closure. Returns a function that maps
 * any (domain, role) pair to the resolved domain name.
 * Owned domains (by config OR by DB role) resolve to the target domain.
 */
function buildDomainResolver(config) {
  const targetDomain = config?.target?.domain;
  const ownedSet = new Set((config?.owned || []).map(o => o.domain));
  return function(domain, role) {
    if (!targetDomain) return domain;
    if (domain === targetDomain) return targetDomain;
    if (ownedSet.has(domain) || role === 'owned') return targetDomain;
    return domain;
  };
}

function mergeOwnedDomains(rows, config) {
  if (!config?.target?.domain) return rows;

  const targetDomain = config.target.domain;
  const ownedSet = new Set((config.owned || []).map(o => o.domain));
  const merged = [];
  let targetRow = null;

  for (const row of rows) {
    // Merge if: in config owned list, OR has role 'owned' in DB, OR is the target itself
    const isOwned = ownedSet.has(row.domain) || row.role === 'owned';
    const isTarget = row.domain === targetDomain;

    if (isOwned || isTarget) {
      if (!targetRow) {
        targetRow = { ...row, domain: targetDomain, role: 'target' };
      } else {
        // Sum all numeric fields
        for (const [key, val] of Object.entries(row)) {
          if (typeof val === 'number' && key !== 'role') {
            targetRow[key] = (targetRow[key] || 0) + val;
          }
        }
      }
    } else {
      merged.push(row);
    }
  }

  if (targetRow) merged.unshift(targetRow);

  return merged;
}

function getDomainStats(db, project, config) {
  const raw = db.prepare(`
    SELECT
      d.domain,
      d.role,
      COUNT(DISTINCT p.id) as page_count,
      COALESCE(SUM(p.word_count), 0) as total_word_count,
      COALESCE(SUM(p.load_ms), 0) as total_load_ms
    FROM domains d
    LEFT JOIN pages p ON p.domain_id = d.id
    WHERE d.project = ?
    GROUP BY d.domain, d.role
  `).all(project);

  // Merge owned domains into target, then compute averages
  const merged = mergeOwnedDomains(raw, config);
  return merged.map(d => ({
    ...d,
    avg_word_count: d.page_count > 0 ? Math.round(d.total_word_count / d.page_count) : 0,
    avg_load_ms: d.page_count > 0 ? Math.round(d.total_load_ms / d.page_count) : 0,
  }));
}

function getTopKeywords(db, project) {
  // Get target keywords with competitor presence count
  const targetKeywords = db.prepare(`
    SELECT
      k.keyword,
      k.location,
      COUNT(*) as freq
    FROM keywords k
    JOIN pages p ON p.id = k.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'target'
    GROUP BY k.keyword
    ORDER BY freq DESC
    LIMIT 50
  `).all(project);

  // Get competitor keyword set
  const competitorKeywordCounts = {};
  db.prepare(`
    SELECT k.keyword, COUNT(DISTINCT d.domain) as domain_count
    FROM keywords k
    JOIN pages p ON p.id = k.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
    GROUP BY k.keyword
  `).all(project).forEach(row => {
    competitorKeywordCounts[row.keyword] = row.domain_count;
  });

  return targetKeywords.map(k => ({
    ...k,
    competitorCount: competitorKeywordCounts[k.keyword] || 0
  }));
}

function getKeywordGaps(db, project) {
  const competitorKeywords = db.prepare(`
    SELECT
      k.keyword,
      COUNT(DISTINCT d.domain) as competitor_count
    FROM keywords k
    JOIN pages p ON p.id = k.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
    GROUP BY k.keyword
    HAVING competitor_count >= 1
    ORDER BY competitor_count DESC
    LIMIT 200
  `).all(project);

  const targetKeywords = new Set(
    db.prepare(`
      SELECT DISTINCT k.keyword
      FROM keywords k
      JOIN pages p ON p.id = k.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'target'
    `).all(project).map(r => r.keyword)
  );

  return competitorKeywords.map(ck => ({
    keyword: ck.keyword,
    competitor_count: ck.competitor_count,
    target_has: targetKeywords.has(ck.keyword),
    priority: !targetKeywords.has(ck.keyword) && ck.competitor_count >= 3 ? 'high' :
              !targetKeywords.has(ck.keyword) && ck.competitor_count >= 2 ? 'medium' : 'low'
  })).filter(g => !g.target_has).slice(0, 50);
}

function getKeywordHeatmapData(db, project, allDomains, latestAnalysis) {
  const heatmapKeywords = [];
  const targetDomain = allDomains[0];

  // Helper: check if a keyword phrase appears in a domain's content
  const checkPresence = (kw, domain) => {
    const kwLower = kw.toLowerCase();
    const kwMatch = db.prepare(`
      SELECT COUNT(*) as cnt FROM keywords k
      JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
      WHERE d.domain = ? AND d.project = ? AND LOWER(k.keyword) LIKE ?
    `).get(domain, project, `%${kwLower}%`)?.cnt || 0;

    const headingMatch = db.prepare(`
      SELECT COUNT(*) as cnt FROM headings h
      JOIN pages p ON p.id = h.page_id JOIN domains d ON d.id = p.domain_id
      WHERE d.domain = ? AND d.project = ? AND LOWER(h.text) LIKE ?
    `).get(domain, project, `%${kwLower}%`)?.cnt || 0;

    const total = kwMatch + headingMatch;
    return total > 2 ? 'present' : total > 0 ? 'partial' : 'missing';
  };

  // SOURCE 1: LLM keyword_gaps (curated, meaningful terms from Gemini)
  const llmGaps = latestAnalysis?.keyword_gaps || [];
  for (const gap of llmGaps) {
    const kw = gap.keyword;
    if (!kw || kw.length < 2) continue;

    const presence = {};
    for (const domain of allDomains) {
      presence[domain] = checkPresence(kw, domain);
    }

    const targetHas = presence[targetDomain] !== 'missing';
    const competitorPresent = allDomains.slice(1).filter(d => presence[d] === 'present').length;

    heatmapKeywords.push({
      keyword: kw, presence,
      gapScore: targetHas ? 0 : competitorPresent,
      priority: gap.priority || (competitorPresent >= 3 ? 'high' : competitorPresent >= 2 ? 'medium' : 'low'),
      source: 'llm'
    });
  }

  // SOURCE 2: Multi-word phrases from keywords table (2+ words, freq > 1)
  const multiWordTerms = db.prepare(`
    SELECT k.keyword, d.domain, COUNT(*) as freq
    FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND k.keyword LIKE '% %'
    GROUP BY k.keyword, d.domain
    HAVING freq > 1
  `).all(project);

  const mwMap = {};
  for (const row of multiWordTerms) {
    if (!mwMap[row.keyword]) mwMap[row.keyword] = {};
    mwMap[row.keyword][row.domain] = row.freq;
  }

  const existingKeywords = new Set(heatmapKeywords.map(h => h.keyword.toLowerCase()));
  for (const [kw, domainFreqs] of Object.entries(mwMap)) {
    if (existingKeywords.has(kw.toLowerCase())) continue;

    const presence = {};
    for (const domain of allDomains) {
      const freq = domainFreqs[domain] || 0;
      presence[domain] = freq > 2 ? 'present' : freq > 0 ? 'partial' : 'missing';
    }

    const targetHas = presence[targetDomain] !== 'missing';
    const competitorPresent = allDomains.slice(1).filter(d => presence[d] === 'present').length;
    if (!targetHas && competitorPresent >= 1) {
      heatmapKeywords.push({
        keyword: kw, presence,
        gapScore: competitorPresent,
        priority: competitorPresent >= 3 ? 'high' : competitorPresent >= 2 ? 'medium' : 'low',
        source: 'crawl'
      });
    }
  }

  // Sort: highest gap score first, LLM source prioritized within same score
  heatmapKeywords.sort((a, b) => {
    if (b.gapScore !== a.gapScore) return b.gapScore - a.gapScore;
    return a.source === 'llm' ? -1 : 1;
  });

  return { keywords: heatmapKeywords };
}

function getTechnicalScores(db, project, config) {
  const domains = db.prepare(`
    SELECT d.id, d.domain, d.role,
      COUNT(DISTINCT p.id) as page_count
    FROM domains d
    LEFT JOIN pages p ON p.domain_id = d.id
    WHERE d.project = ?
    GROUP BY d.id
  `).all(project);

  // Resolve owned domains → target for merging
  const targetDomain = config?.target?.domain;
  const ownedDomains = new Set((config?.owned || []).map(o => o.domain));

  // Compute raw stats per domain (including sub-queries by d.id)
  const rawScores = domains.map(d => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN e.h1 IS NOT NULL AND e.h1 != '' THEN 1 ELSE 0 END) as has_h1,
        SUM(CASE WHEN e.meta_desc IS NOT NULL AND e.meta_desc != '' THEN 1 ELSE 0 END) as has_meta,
        SUM(CASE WHEN e.schema_types IS NOT NULL AND e.schema_types != '[]' AND e.schema_types != '' THEN 1 ELSE 0 END) as has_schema,
        SUM(CASE WHEN e.title IS NOT NULL AND e.title != '' THEN 1 ELSE 0 END) as has_title
      FROM pages p
      LEFT JOIN extractions e ON e.page_id = p.id
      WHERE p.domain_id = ?
    `).get(d.id);

    return {
      domain: d.domain,
      role: d.role,
      total: stats.total || 0,
      has_h1: stats.has_h1 || 0,
      has_meta: stats.has_meta || 0,
      has_schema: stats.has_schema || 0,
      has_title: stats.has_title || 0,
    };
  });

  // Merge owned domains into target (sum raw counts, recompute percentages)
  const merged = [];
  let targetRow = null;

  for (const row of rawScores) {
    const isOwned = ownedDomains.has(row.domain) || row.role === 'owned';
    const isTarget = row.domain === targetDomain;

    if (isOwned || isTarget) {
      if (!targetRow) {
        targetRow = { ...row, domain: targetDomain, role: 'target' };
      } else {
        targetRow.total += row.total;
        targetRow.has_h1 += row.has_h1;
        targetRow.has_meta += row.has_meta;
        targetRow.has_schema += row.has_schema;
        targetRow.has_title += row.has_title;
      }
    } else {
      merged.push(row);
    }
  }
  if (targetRow) merged.unshift(targetRow);

  // Compute percentages and scores from merged raw counts
  return merged.map(d => {
    const total = d.total || 1;
    const h1Pct = Math.round((d.has_h1 / total) * 100);
    const metaPct = Math.round((d.has_meta / total) * 100);
    const schemaPct = Math.round((d.has_schema / total) * 100);
    const titlePct = Math.round((d.has_title / total) * 100);

    // Weighted score (H1 25%, Meta 30%, Schema 25%, Title 20%)
    const score = Math.round((h1Pct * 0.25) + (metaPct * 0.30) + (schemaPct * 0.25) + (titlePct * 0.20));

    return {
      domain: d.domain,
      isTarget: d.role === 'target',
      h1Pct,
      metaPct,
      schemaPct,
      titlePct,
      score
    };
  }).sort((a, b) => b.score - a.score);
}

function getInternalLinkStats(db, project) {
  // Get target domain pages with click depth as a proxy for link structure
  const targetPages = db.prepare(`
    SELECT p.id, p.url, p.click_depth
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'target'
  `).all(project);

  // Use click_depth to infer link structure
  // Pages at depth 0 are most linked (homepage), depth 1 second most linked, etc.
  const depthCounts = {};
  targetPages.forEach(p => {
    const depth = p.click_depth || 0;
    depthCounts[depth] = (depthCounts[depth] || 0) + 1;
  });

  // Estimate orphan pages as those with very high click depth or null
  const orphanCount = targetPages.filter(p => (p.click_depth || 0) > 3).length;

  // Top pages by lowest click depth (most accessible)
  const topPages = targetPages
    .sort((a, b) => (a.click_depth || 0) - (b.click_depth || 0))
    .slice(0, 10)
    .map(p => ({
      label: p.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || '/',
      url: p.url,
      count: Math.max(1, 5 - (p.click_depth || 0)) // Estimated link count based on depth
    }));

  // Estimate total internal links based on page count
  const totalLinks = targetPages.length * 3; // Avg ~3 internal links per page

  return {
    totalLinks,
    orphanCount,
    topPages
  };
}

function getCrawlStats(db, project) {
  const lastCrawl = db.prepare(`
    SELECT MAX(crawled_at) as last_crawl
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
  `).get(project);

  const extractedPages = db.prepare(`
    SELECT COUNT(*) as count
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
  `).get(project);

  return {
    lastCrawl: lastCrawl?.last_crawl ? formatDate(lastCrawl.last_crawl) : null,
    extractedPages: extractedPages?.count || 0
  };
}

function getLatestAnalysis(db, project) {
  const row = db.prepare(`
    SELECT * FROM analyses
    WHERE project = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(project);

  if (!row) return null;

  return {
    generated_at: row.generated_at,
    positioning: safeJsonParse(row.positioning),
    keyword_gaps: safeJsonParse(row.keyword_gaps),
    long_tails: safeJsonParse(row.long_tails),
    content_gaps: safeJsonParse(row.content_gaps),
    quick_wins: safeJsonParse(row.quick_wins),
    new_pages: safeJsonParse(row.new_pages),
    technical_gaps: safeJsonParse(row.technical_gaps),
  };
}

// ─── Chart Data Builders ─────────────────────────────────────────────────────

function buildRadarData(domains, targetDomain, technicalScores, db, project) {
  const labels = [
    'Page Count',
    'Avg Word Count',
    'Keyword Coverage',
    'Schema %',
    'Internal Links',
    'Technical Score'
  ];

  const raw = domains.map(d => {
    const kwCount = db.prepare(`
      SELECT COUNT(DISTINCT k.keyword) as cnt
      FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains dom ON dom.id = p.domain_id
      WHERE dom.domain = ? AND dom.project = ?
    `).get(d.domain, project)?.cnt || 0;

    const linkCount = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM links l JOIN pages p ON p.id = l.source_id JOIN domains dom ON dom.id = p.domain_id
      WHERE dom.domain = ? AND dom.project = ? AND l.is_internal = 1
    `).get(d.domain, project)?.cnt || 0;

    const tech = technicalScores.find(ts => ts.domain === d.domain);

    return {
      label: getDomainShortName(d.domain), isTarget: d.role === 'target',
      pageCount: d.page_count, avgWordCount: d.avg_word_count,
      kwCount, schemaPct: tech?.schemaPct || 0,
      linkCount, techScore: tech?.score || 0
    };
  });

  const maxPages = Math.max(...raw.map(d => d.pageCount)) || 1;
  const maxWords = Math.max(...raw.map(d => d.avgWordCount)) || 1;
  const maxKw = Math.max(...raw.map(d => d.kwCount)) || 1;
  const maxLinks = Math.max(...raw.map(d => d.linkCount)) || 1;

  const datasets = raw.map(d => ({
    label: d.label, isTarget: d.isTarget,
    data: [
      Math.round((d.pageCount / maxPages) * 100),
      Math.round((d.avgWordCount / maxWords) * 100),
      Math.round((d.kwCount / maxKw) * 100),
      d.schemaPct,
      Math.round((d.linkCount / maxLinks) * 100),
      d.techScore
    ]
  }));

  datasets.sort((a, b) => (b.isTarget ? 1 : 0) - (a.isTarget ? 1 : 0));
  return { labels, datasets };
}

function buildContentVolumeData(domains, targetDomain) {
  // Sort by total word count descending
  const sorted = [...domains].sort((a, b) => b.total_word_count - a.total_word_count);

  return {
    labels: sorted.map(d => getDomainShortName(d.domain)),
    values: sorted.map(d => d.total_word_count),
    colors: sorted.map(d => d.role === 'target' ? '#e8d5a3' : '#7c6deb')
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getDomainShortName(domain) {
  const d = String(domain || '').replace(/^www\./, '');
  if (d === 'web3.okx.com') return 'OKX';
  return d.split('.')[0];
}

function formatDate(isoString) {
  if (!isoString) return 'Never';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getRelativeTime(isoString) {
  if (!isoString) return 'Never';
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(isoString);
}

// ─── Content Page Filter ────────────────────────────────────────────────────

function isContentPage(url) {
  if (url.includes('?')) return false;
  const appPaths = ['/signup', '/login', '/register', '/onboarding', '/dashboard',
    '/app/', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults'];
  const appSubdomains = ['dashboard.', 'app.', 'customers.', 'console.'];
  if (appPaths.some(p => url.includes(p))) return false;
  if (appSubdomains.some(s => url.includes(s))) return false;
  return true;
}

// ─── Attack Strategy Data Functions ─────────────────────────────────────────

function getShallowChampions(db, project, maxDepth = 2, maxWords = 700) {
  const rows = db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= ? AND p.word_count <= ? AND p.word_count > 80
      AND p.is_indexable = 1
    ORDER BY p.click_depth ASC, p.word_count ASC
  `).all(project, maxDepth, maxWords).filter(r => isContentPage(r.url));

  const byDomain = {};
  for (const r of rows) {
    if (!byDomain[r.domain]) byDomain[r.domain] = [];
    byDomain[r.domain].push(r);
  }
  return { total: rows.length, byDomain };
}

function getDecayTargets(db, project, monthsAgo = 18) {
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
    ORDER BY p.click_depth ASC, p.modified_date ASC
  `).all(project, cutoff).filter(r => isContentPage(r.url));

  const staleUnknown = db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, d.domain
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND p.click_depth <= 2 AND p.word_count BETWEEN 300 AND 1500
      AND p.modified_date IS NULL AND p.published_date IS NULL
      AND p.is_indexable = 1
    ORDER BY p.click_depth ASC, p.word_count ASC
    LIMIT 20
  `).all(project).filter(r => isContentPage(r.url));

  return { staleKnown, staleUnknown, total: staleKnown.length + staleUnknown.length };
}

function getOrphanEntities(db, project) {
  const extractions = db.prepare(`
    SELECT e.primary_entities, p.url, d.domain
    FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND e.primary_entities IS NOT NULL AND e.primary_entities != '' AND e.primary_entities != '[]'
  `).all(project);

  if (!extractions.length) return { orphans: [], hasData: false };

  const entityMap = new Map();
  for (const row of extractions) {
    let entities = [];
    try { entities = JSON.parse(row.primary_entities); } catch {}
    for (const entity of entities) {
      const key = entity.toLowerCase().trim();
      if (!key || key.length < 2) continue;
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
    const hasDedicatedPage = allUrls.some(u => u.includes(slug) || u.includes(entity.replace(/\s+/g, '/')));
    if (!hasDedicatedPage) {
      orphans.push({ entity, domains: [...domains], domainCount: domains.size });
    }
  }

  orphans.sort((a, b) => b.domainCount - a.domainCount);
  return { orphans, hasData: true };
}

function getFrictionTargets(db, project) {
  const rows = db.prepare(`
    SELECT e.search_intent, e.cta_primary, p.url, p.word_count, d.domain
    FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND e.search_intent IS NOT NULL AND e.search_intent != ''
      AND e.cta_primary IS NOT NULL AND e.cta_primary != ''
    ORDER BY d.domain, p.click_depth ASC
  `).all(project).filter(r => isContentPage(r.url));

  if (!rows.length) return { targets: [], hasData: false };

  const highFrictionCTAs = ['enterprise', 'sales', 'contact', 'book a demo', 'request', 'talk to'];
  const targets = rows.filter(r => {
    const cta = (r.cta_primary || '').toLowerCase();
    const intent = (r.search_intent || '').toLowerCase();
    return highFrictionCTAs.some(f => cta.includes(f)) &&
           (intent.includes('informational') || intent.includes('commercial'));
  });

  return { targets, hasData: true };
}

// ─── Extended Intelligence Data Functions ────────────────────────────────────

function getSearchIntentMix(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.search_intent, COUNT(*) as cnt
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.search_intent IS NOT NULL AND e.search_intent != ''
    GROUP BY d.domain, e.search_intent
    ORDER BY d.role DESC, d.domain
  `).all(project);

  if (!rows.length) return { domains: [], hasData: false };

  const map = {};
  for (const r of rows) {
    if (!map[r.domain]) map[r.domain] = { domain: r.domain, role: r.role, intents: {} };
    map[r.domain].intents[r.search_intent] = r.cnt;
  }
  return { domains: Object.values(map), hasData: true };
}

function getPricingTierMap(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.pricing_tier, COUNT(*) as cnt
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.pricing_tier IS NOT NULL AND e.pricing_tier != '' AND e.pricing_tier != 'none'
    GROUP BY d.domain, e.pricing_tier
    ORDER BY d.role DESC, d.domain
  `).all(project);

  if (!rows.length) return { domains: [], hasData: false };

  const map = {};
  for (const r of rows) {
    if (!map[r.domain]) map[r.domain] = { domain: r.domain, role: r.role, tiers: {} };
    map[r.domain].tiers[r.pricing_tier] = r.cnt;
  }
  return { domains: Object.values(map), hasData: true };
}

function getTechStackMatrix(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.tech_stack
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.tech_stack IS NOT NULL AND e.tech_stack != '' AND e.tech_stack != '[]'
  `).all(project);

  if (!rows.length) return { stacks: {}, allTechs: [], hasData: false };

  const stacks = {};
  const techCount = {};
  for (const r of rows) {
    let techs = [];
    try { techs = JSON.parse(r.tech_stack); } catch {}
    if (!stacks[r.domain]) stacks[r.domain] = { role: r.role, techs: new Set() };
    for (const t of techs) {
      const key = t.trim();
      if (key.length < 2 || key.length > 40) continue;
      stacks[r.domain].techs.add(key);
      techCount[key] = (techCount[key] || 0) + 1;
    }
  }

  // Convert Sets and sort techs by frequency
  const allTechs = Object.entries(techCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([t]) => t);

  const result = {};
  for (const [domain, data] of Object.entries(stacks)) {
    result[domain] = { role: data.role, techs: [...data.techs] };
  }
  return { stacks: result, allTechs, hasData: true };
}

function getPagePerformance(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role,
      COUNT(*) as total,
      ROUND(AVG(p.load_ms)) as avg_ms,
      ROUND(MIN(p.load_ms)) as min_ms,
      ROUND(MAX(p.load_ms)) as max_ms,
      SUM(CASE WHEN p.load_ms < 1000 THEN 1 ELSE 0 END) as fast,
      SUM(CASE WHEN p.load_ms BETWEEN 1000 AND 3000 THEN 1 ELSE 0 END) as mid,
      SUM(CASE WHEN p.load_ms > 3000 THEN 1 ELSE 0 END) as slow
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.load_ms IS NOT NULL AND p.load_ms > 0
    GROUP BY d.domain
    ORDER BY d.role DESC, avg_ms ASC
  `).all(project);

  return { domains: rows, hasData: rows.length > 0 };
}

function getCtaLandscape(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.cta_primary, e.search_intent, p.url
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.cta_primary IS NOT NULL AND e.cta_primary != ''
    ORDER BY d.role DESC, d.domain
  `).all(project).filter(r => isContentPage(r.url));

  if (!rows.length) return { ctas: [], hasData: false };

  // Group CTAs and count frequency
  const ctaMap = {};
  for (const r of rows) {
    const cta = r.cta_primary.trim();
    const key = cta.toLowerCase();
    if (!ctaMap[key]) ctaMap[key] = { cta, domains: new Set(), intents: new Set(), count: 0 };
    ctaMap[key].domains.add(r.domain);
    if (r.search_intent) ctaMap[key].intents.add(r.search_intent);
    ctaMap[key].count++;
  }

  const ctas = Object.values(ctaMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(c => ({ cta: c.cta, domains: [...c.domains], intents: [...c.intents], count: c.count }));

  return { ctas, hasData: true };
}

function getEntityTopicMap(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.primary_entities
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.primary_entities IS NOT NULL AND e.primary_entities != '' AND e.primary_entities != '[]'
  `).all(project);

  if (!rows.length) return { entities: [], domainEntities: {}, hasData: false };

  const entityDomains = new Map();
  const domainEntities = {};
  for (const r of rows) {
    let entities = [];
    try { entities = JSON.parse(r.primary_entities); } catch {}
    if (!domainEntities[r.domain]) domainEntities[r.domain] = { role: r.role, entities: new Set() };
    for (const e of entities) {
      const key = e.trim().toLowerCase();
      if (key.length < 2) continue;
      domainEntities[r.domain].entities.add(e.trim());
      if (!entityDomains.has(key)) entityDomains.set(key, { name: e.trim(), domains: new Set() });
      entityDomains.get(key).domains.add(r.domain);
    }
  }

  const entities = [...entityDomains.values()]
    .sort((a, b) => b.domains.size - a.domains.size)
    .slice(0, 30)
    .map(e => ({ entity: e.name, domains: [...e.domains], count: e.domains.size }));

  // Sort: target first, then competitors by entity count descending
  const sortedDomains = Object.entries(domainEntities)
    .sort((a, b) => {
      if (a[1].role === 'target' && b[1].role !== 'target') return -1;
      if (b[1].role === 'target' && a[1].role !== 'target') return 1;
      return b[1].entities.size - a[1].entities.size;
    });

  const result = {};
  for (const [domain, data] of sortedDomains) {
    result[domain] = { role: data.role, entities: [...data.entities].slice(0, 20) };
  }

  return { entities, domainEntities: result, hasData: true };
}

function getSiteHealth(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role,
      COUNT(*) as total,
      SUM(CASE WHEN p.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) as ok_2xx,
      SUM(CASE WHEN p.status_code BETWEEN 300 AND 399 THEN 1 ELSE 0 END) as redirect_3xx,
      SUM(CASE WHEN p.status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) as client_4xx,
      SUM(CASE WHEN p.status_code >= 500 THEN 1 ELSE 0 END) as server_5xx,
      SUM(CASE WHEN p.is_indexable = 0 THEN 1 ELSE 0 END) as noindex
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    GROUP BY d.domain
    ORDER BY d.role DESC, d.domain
  `).all(project);

  return { domains: rows, hasData: rows.length > 0 };
}

function getSchemaBreakdown(db, project) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, e.schema_types
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.schema_types IS NOT NULL AND e.schema_types != '' AND e.schema_types != '[]'
  `).all(project);

  if (!rows.length) return { schemas: {}, allTypes: [], hasData: false };

  const schemas = {};
  const typeCount = {};
  for (const r of rows) {
    let types = [];
    try { types = JSON.parse(r.schema_types); } catch {}
    if (!schemas[r.domain]) schemas[r.domain] = { role: r.role, types: new Set() };
    for (const t of types) {
      const key = t.trim();
      if (key.length < 2) continue;
      schemas[r.domain].types.add(key);
      typeCount[key] = (typeCount[key] || 0) + 1;
    }
  }

  const allTypes = Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => t);

  const result = {};
  for (const [domain, data] of Object.entries(schemas)) {
    result[domain] = { role: data.role, types: [...data.types] };
  }
  return { schemas: result, allTypes, hasData: true };
}

// ─── Advanced Visualization Data Functions ───────────────────────────────────

function getGravityMapData(db, project, config) {
  // Get keyword sets per domain for overlap calculation
  const rows = db.prepare(`
    SELECT DISTINCT d.domain, d.role, k.keyword
    FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND k.keyword LIKE '% %'
  `).all(project);

  const resolve = buildDomainResolver(config);
  const domainKws = {};
  for (const r of rows) {
    const domain = resolve(r.domain, r.role);
    const role = domain === config?.target?.domain ? 'target' : r.role;
    if (!domainKws[domain]) domainKws[domain] = { role, keywords: new Set() };
    domainKws[domain].keywords.add(r.keyword.toLowerCase());
  }

  // Build nodes
  const nodes = Object.entries(domainKws).map(([domain, data]) => ({
    id: domain, label: getDomainShortName(domain),
    role: data.role, size: data.keywords.size
  }));

  // Build edges (shared keyword count between each pair)
  const edges = [];
  const domainList = Object.keys(domainKws);
  for (let i = 0; i < domainList.length; i++) {
    for (let j = i + 1; j < domainList.length; j++) {
      const a = domainKws[domainList[i]].keywords;
      const b = domainKws[domainList[j]].keywords;
      let shared = 0;
      for (const kw of a) { if (b.has(kw)) shared++; }
      if (shared > 0) {
        edges.push({ source: domainList[i], target: domainList[j], weight: shared });
      }
    }
  }
  return { nodes, edges };
}

function getContentTerrainData(db, project) {
  return db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, p.load_ms, d.domain, d.role
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.word_count > 0
  `).all(project);
}

function getKeywordVennData(db, project) {
  const rows = db.prepare(`
    SELECT DISTINCT d.domain, d.role, LOWER(k.keyword) as keyword
    FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND k.keyword LIKE '% %'
  `).all(project);

  const domainKws = {};
  for (const r of rows) {
    if (!domainKws[r.domain]) domainKws[r.domain] = { role: r.role, keywords: new Set() };
    domainKws[r.domain].keywords.add(r.keyword);
  }

  // Find target and top 2 competitors by keyword count
  const target = Object.entries(domainKws).find(([, d]) => d.role === 'target');
  const competitors = Object.entries(domainKws)
    .filter(([, d]) => d.role === 'competitor')
    .sort((a, b) => b[1].keywords.size - a[1].keywords.size)
    .slice(0, 2);

  if (!target || competitors.length < 2) return { sets: [], hasData: false };

  const [tDomain, tData] = target;
  const [c1Domain, c1Data] = competitors[0];
  const [c2Domain, c2Data] = competitors[1];

  const t = tData.keywords, c1 = c1Data.keywords, c2 = c2Data.keywords;
  let t_only = 0, c1_only = 0, c2_only = 0;
  let t_c1 = 0, t_c2 = 0, c1_c2 = 0, all3 = 0;

  const allKws = new Set([...t, ...c1, ...c2]);
  for (const kw of allKws) {
    const inT = t.has(kw), inC1 = c1.has(kw), inC2 = c2.has(kw);
    if (inT && inC1 && inC2) all3++;
    else if (inT && inC1) t_c1++;
    else if (inT && inC2) t_c2++;
    else if (inC1 && inC2) c1_c2++;
    else if (inT) t_only++;
    else if (inC1) c1_only++;
    else if (inC2) c2_only++;
  }

  return {
    sets: [
      { label: getDomainShortName(tDomain), role: 'target', total: t.size },
      { label: getDomainShortName(c1Domain), role: 'competitor', total: c1.size },
      { label: getDomainShortName(c2Domain), role: 'competitor', total: c2.size }
    ],
    zones: { t_only, c1_only, c2_only, t_c1, t_c2, c1_c2, all3 },
    hasData: true
  };
}

function getPerformanceBubbleData(db, project) {
  return db.prepare(`
    SELECT p.url, p.click_depth, p.word_count, p.load_ms, d.domain, d.role
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.load_ms > 0 AND p.word_count > 0
  `).all(project);
}

function getHeadingFlowData(db, project, config) {
  const rows = db.prepare(`
    SELECT d.domain, d.role, h.level, COUNT(*) as cnt
    FROM headings h JOIN pages p ON p.id = h.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND h.level <= 3
    GROUP BY d.domain, h.level
    ORDER BY d.role DESC, d.domain, h.level
  `).all(project);

  // Resolve owned → target
  const targetDomain = config?.target?.domain;
  const ownedDomains = new Set((config?.owned || []).map(o => o.domain));
  const resolve = (d, role) => (ownedDomains.has(d) || role === 'owned') ? targetDomain : d;

  const domains = {};
  for (const r of rows) {
    const domain = resolve(r.domain, r.role);
    const role = domain === targetDomain ? 'target' : r.role;
    if (!domains[domain]) domains[domain] = { role, h1: 0, h2: 0, h3: 0 };
    domains[domain][`h${r.level}`] += r.cnt;
  }
  return domains;
}

function getTerritoryTreemapData(db, project, config) {
  // Group multi-word keywords by first word as "territory clusters"
  const rows = db.prepare(`
    SELECT LOWER(k.keyword) as keyword, d.domain, d.role, COUNT(*) as freq
    FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND k.keyword LIKE '% %'
    GROUP BY LOWER(k.keyword), d.domain
  `).all(project);

  // Merge owned domains (blog.x, docs.x) → target domain
  const targetDomain = config?.target?.domain;
  const ownedDomains = (config?.owned || []).map(o => o.domain);
  const resolveOwned = (domain) => ownedDomains.includes(domain) ? targetDomain : domain;

  const kwDomains = {};
  for (const r of rows) {
    const domain = resolveOwned(r.domain);
    const role = domain === targetDomain ? 'target' : r.role;
    if (!kwDomains[r.keyword]) kwDomains[r.keyword] = { domains: {}, total: 0 };
    if (kwDomains[r.keyword].domains[domain]) {
      kwDomains[r.keyword].domains[domain].freq += r.freq;
    } else {
      kwDomains[r.keyword].domains[domain] = { role, freq: r.freq };
    }
    kwDomains[r.keyword].total += r.freq;
  }

  // Cluster by first word
  const clusters = {};
  for (const [kw, data] of Object.entries(kwDomains)) {
    const firstWord = kw.split(' ')[0];
    if (firstWord.length < 3) continue;
    if (!clusters[firstWord]) clusters[firstWord] = { keywords: [], totalFreq: 0 };
    clusters[firstWord].keywords.push({ keyword: kw, ...data });
    clusters[firstWord].totalFreq += data.total;
  }

  // Take top 20 clusters, determine dominant domain per cluster
  return Object.entries(clusters)
    .sort((a, b) => b[1].totalFreq - a[1].totalFreq)
    .slice(0, 20)
    .map(([cluster, data]) => {
      const domFreq = {};
      for (const kw of data.keywords) {
        for (const [dom, info] of Object.entries(kw.domains)) {
          domFreq[dom] = (domFreq[dom] || 0) + info.freq;
        }
      }
      const dominant = Object.entries(domFreq).sort((a, b) => b[1] - a[1])[0];
      return {
        cluster, keywords: data.keywords.length, totalFreq: data.totalFreq,
        dominant: dominant ? { domain: dominant[0], freq: dominant[1] } : null,
        domains: domFreq
      };
    });
}

function getTopicClusterData(project) {
  // Load from topic-cluster-mapper.js output — try project-specific file first, then generic
  const candidates = [
    join(__dirname, `topic-clusters-${project}.json`),
    join(__dirname, 'topic-clusters.json'),
  ];

  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        // Verify this data is for the right project (if it has a project field)
        if (raw.project && raw.project !== project) continue;
        const data = raw.dashboard_data || null;
        if (data) console.log(`  📊 Topic clusters loaded: ${data.length} clusters from ${path.split('/').pop()}`);
        return data;
      }
    } catch (e) {
      console.log(`  ⚠️  ${path.split('/').pop()} error: ${e.message}`);
    }
  }

  console.log(`  ⚠️  No topic-clusters file found for project: ${project}`);
  return null;
}

function getLinkDnaData(db, project, config) {
  const raw = db.prepare(`
    SELECT d.domain, d.role,
      SUM(CASE WHEN l.is_internal = 1 THEN 1 ELSE 0 END) as internal_links,
      SUM(CASE WHEN l.is_internal = 0 THEN 1 ELSE 0 END) as external_links,
      COUNT(*) as total_links
    FROM links l JOIN pages p ON p.id = l.source_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    GROUP BY d.domain
    ORDER BY d.role DESC, total_links DESC
  `).all(project);

  return mergeOwnedDomains(raw, config);
}

function getLinkRadarPulseData(db, project, config) {
  // Get link counts per depth level per domain
  const rows = db.prepare(`
    SELECT d.domain, d.role, p.click_depth,
      SUM(CASE WHEN l.is_internal = 1 THEN 1 ELSE 0 END) as internal_links,
      SUM(CASE WHEN l.is_internal = 0 THEN 1 ELSE 0 END) as external_links
    FROM links l JOIN pages p ON p.id = l.source_id JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    GROUP BY d.domain, p.click_depth
    ORDER BY d.domain, p.click_depth
  `).all(project);

  // Resolve owned domains → target
  const targetDomain = config?.target?.domain;
  const ownedDomains = new Set((config?.owned || []).map(o => o.domain));
  const resolveDomain = (d, role) => (ownedDomains.has(d) || role === 'owned') ? targetDomain : d;

  const domains = {};
  for (const r of rows) {
    const domain = resolveDomain(r.domain, r.role);
    const role = domain === targetDomain ? 'target' : r.role;
    if (!domains[domain]) domains[domain] = { role, depths: [] };

    // Merge into existing depth entry or add new
    const existing = domains[domain].depths.find(d => d.depth === r.click_depth);
    if (existing) {
      existing.internal += r.internal_links;
      existing.external += r.external_links;
    } else {
      domains[domain].depths.push({
        depth: r.click_depth, internal: r.internal_links, external: r.external_links
      });
    }
  }
  // Sort depths
  for (const d of Object.values(domains)) d.depths.sort((a, b) => a.depth - b.depth);
  return domains;
}

// ─── Extraction Status ─────────────────────────────────────────────────────
function getExtractionStatus(db, project, config) {
  // Per-domain coverage
  const rawCoverage = db.prepare(`
    SELECT d.domain, d.role, d.last_crawled,
           COUNT(p.id) as total_pages,
           COUNT(e.id) as extracted_pages
    FROM domains d
    LEFT JOIN pages p ON p.domain_id = d.id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ?
    GROUP BY d.id
    ORDER BY d.role DESC, d.domain
  `).all(project);

  // Merge owned domains (blog.x, docs.x) into target row
  const targetDomain = config?.target?.domain;
  const ownedDomains = new Set((config?.owned || []).map(o => o.domain));
  const coverage = [];
  let targetRow = null;

  for (const row of rawCoverage) {
    if ((ownedDomains.has(row.domain) || row.role === 'owned') && targetDomain) {
      // Merge into target
      if (!targetRow) {
        targetRow = { ...row, domain: targetDomain, role: 'target' };
      } else {
        targetRow.total_pages += row.total_pages;
        targetRow.extracted_pages += row.extracted_pages;
      }
    } else if (row.domain === targetDomain) {
      if (!targetRow) {
        targetRow = { ...row };
      } else {
        targetRow.total_pages += row.total_pages;
        targetRow.extracted_pages += row.extracted_pages;
      }
    } else {
      coverage.push(row);
    }
  }
  if (targetRow) coverage.unshift(targetRow);

  // Live progress file with PID liveness check
  let liveProgress = null;
  try {
    const progressPath = join(__dirname, '..', '.extraction-progress.json');
    if (existsSync(progressPath)) {
      liveProgress = JSON.parse(readFileSync(progressPath, 'utf8'));
      // Only show if same project and recent (within 1h)
      if (liveProgress.project !== project || (Date.now() - liveProgress.updated_at) > 3600000) {
        liveProgress = null;
      }
      // PID liveness: verify the extraction process is actually alive
      if (liveProgress && liveProgress.status === 'running' && liveProgress.pid) {
        try { process.kill(liveProgress.pid, 0); } catch (e) {
          if (e.code === 'ESRCH') liveProgress.status = 'crashed'; // PID is dead
          // EPERM = process exists, just can't signal → alive
        }
      }
    }
  } catch { liveProgress = null; }

  const totalPages = coverage.reduce((s, c) => s + c.total_pages, 0);
  const totalExtracted = coverage.reduce((s, c) => s + c.extracted_pages, 0);
  const overallPct = totalPages > 0 ? Math.round((totalExtracted / totalPages) * 100) : 0;

  // Incremental crawl stats: how many pages have content_hash
  const hashStats = db.prepare(`
    SELECT COUNT(*) as hashed,
           COUNT(DISTINCT p.content_hash) as unique_hashes
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND p.content_hash IS NOT NULL
  `).get(project);

  return {
    coverage, liveProgress, totalPages, totalExtracted, overallPct,
    hashedPages: hashStats?.hashed || 0,
    uniqueHashes: hashStats?.unique_hashes || 0,
  };
}

// ─── Domain Architecture Analysis ─────────────────────────────────────────────
function getDomainArchitecture(db, project, config) {
  const targetDomain = config.target.domain;
  const ownedDomains = (config.owned || []).map(o => o.domain);
  if (!ownedDomains.length) return null; // no subdomains → nothing to show

  const allOwned = [targetDomain, ...ownedDomains];

  // Per-domain stats for target + owned
  const domainStats = db.prepare(`
    SELECT d.domain, d.role,
      COUNT(DISTINCT p.id) as pages,
      COALESCE(SUM(p.word_count), 0) as words
    FROM domains d
    LEFT JOIN pages p ON p.domain_id = d.id
    WHERE d.project = ? AND d.domain IN (${allOwned.map(() => '?').join(',')})
    GROUP BY d.domain
  `).all(project, ...allOwned);

  // Total internal + external links per owned domain
  const linkStats = allOwned.map(domain => {
    const row = db.prepare(`
      SELECT
        COUNT(CASE WHEN l.is_internal = 1 THEN 1 END) as internal_links,
        COUNT(CASE WHEN l.is_internal = 0 THEN 1 END) as external_links
      FROM links l
      JOIN pages p ON p.id = l.source_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.domain = ?
    `).get(project, domain);
    return { domain, internal: row?.internal_links || 0, external: row?.external_links || 0 };
  });

  // Cross-subdomain links: directional counts
  // fromMain = links from target → subdomains, toMain = links from subdomains → target
  const crossLinkMap = {};
  let totalCrossLinks = 0;
  let linksFromMain = 0;
  let linksToMain = 0;

  for (const srcDomain of allOwned) {
    const otherDomains = allOwned.filter(d => d !== srcDomain);
    if (!otherDomains.length) continue;
    const patterns = otherDomains.map(d => `l.target_url LIKE 'https://${d.replace(/'/g, "''")}%' OR l.target_url LIKE 'http://${d.replace(/'/g, "''")}%'`);
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM links l
      JOIN pages p ON p.id = l.source_id
      JOIN domains d_src ON d_src.id = p.domain_id
      WHERE d_src.project = ? AND d_src.domain = ?
        AND (${patterns.join(' OR ')})
    `).get(project, srcDomain);
    const cnt = row?.cnt || 0;
    crossLinkMap[srcDomain] = cnt;
    totalCrossLinks += cnt;
    if (srcDomain === targetDomain) linksFromMain = cnt;
  }

  // Links specifically from subdomains → main domain
  const mainPatterns = `l.target_url LIKE 'https://${targetDomain.replace(/'/g, "''")}%' OR l.target_url LIKE 'http://${targetDomain.replace(/'/g, "''")}%'`;
  for (const subDomain of ownedDomains) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM links l
      JOIN pages p ON p.id = l.source_id
      JOIN domains d_src ON d_src.id = p.domain_id
      WHERE d_src.project = ? AND d_src.domain = ? AND (${mainPatterns})
    `).get(project, subDomain);
    linksToMain += row?.cnt || 0;
  }

  // Canonical tag coverage per owned domain
  const canonicalStats = allOwned.map(domain => {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN t.has_canonical = 1 THEN 1 ELSE 0 END) as with_canonical
      FROM technical t
      JOIN pages p ON p.id = t.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.domain = ?
    `).get(project, domain);
    return { domain, total: row?.total || 0, withCanonical: row?.with_canonical || 0 };
  });

  // Combined totals
  const totalPages = domainStats.reduce((s, d) => s + d.pages, 0);
  const totalWords = domainStats.reduce((s, d) => s + d.words, 0);
  const totalInternal = linkStats.reduce((s, d) => s + d.internal, 0);
  const totalExternal = linkStats.reduce((s, d) => s + d.external, 0);
  const totalCross = totalCrossLinks;

  // Directional link data for the card
  const crossFlow = { fromMain: linksFromMain, toMain: linksToMain, total: totalCrossLinks };

  // Build warnings
  const warnings = [];

  // 1. Link juice fragmentation
  const targetStats = domainStats.find(d => d.domain === targetDomain);
  const ownedStats = domainStats.filter(d => d.domain !== targetDomain);
  const ownedPagePct = totalPages > 0 ? Math.round((totalPages - (targetStats?.pages || 0)) / totalPages * 100) : 0;
  if (ownedPagePct > 30) {
    warnings.push({
      severity: 'high',
      title: 'Link equity fragmentation',
      detail: `${ownedPagePct}% of your pages (${totalPages - (targetStats?.pages || 0)}/${totalPages}) live on subdomains. Google treats each subdomain as a separate site — backlinks to blog.${targetDomain.split('.').slice(-2).join('.')} do NOT boost ${targetDomain}.`,
      fix: 'Consider migrating subdomains to subfolders (e.g. /blog, /docs) to consolidate domain authority. This is the single highest-impact structural SEO change.'
    });
  } else if (ownedStats.length) {
    warnings.push({
      severity: 'medium',
      title: 'Subdomain link equity split',
      detail: `${ownedStats.length} subdomain${ownedStats.length > 1 ? 's' : ''} splitting link equity from ${targetDomain}. Backlinks to subdomains don't strengthen the main domain.`,
      fix: 'Long-term: migrate to subfolders. Short-term: ensure canonical tags and strong cross-linking back to the main domain.'
    });
  }

  // 2. Cross-linking imbalance check
  if (ownedStats.length > 0) {
    if (linksToMain < 10) {
      warnings.push({
        severity: 'high',
        title: 'Subdomains barely link back to main site',
        detail: `Main domain links OUT to subdomains ${linksFromMain.toLocaleString()} times, but subdomains link BACK only ${linksToMain} times. This is a one-way link juice leak — authority flows out but doesn't return.`,
        fix: 'Add persistent nav links, breadcrumbs, and contextual links from blog/docs back to main domain landing pages. Every subdomain page should link to the main site.'
      });
    } else if (linksFromMain > 0 && linksToMain / linksFromMain < 0.1) {
      warnings.push({
        severity: 'medium',
        title: 'Cross-linking imbalance',
        detail: `Main → subdomains: ${linksFromMain.toLocaleString()} links. Subdomains → main: ${linksToMain.toLocaleString()} links. Ratio is heavily skewed — subdomains should link back more aggressively.`,
        fix: 'Add breadcrumb navigation, "Back to main site" links, and contextual links in blog posts pointing to product pages.'
      });
    }
  }

  // 3. Canonical tag coverage
  const lowCanonical = canonicalStats.filter(c => c.total > 0 && (c.withCanonical / c.total) < 0.5);
  if (lowCanonical.length) {
    warnings.push({
      severity: 'low',
      title: 'Missing canonical tags',
      detail: `${lowCanonical.map(c => c.domain).join(', ')} — low canonical tag coverage. This can cause duplicate content signals across subdomains.`,
      fix: 'Add <link rel="canonical"> to all pages. For shared content, point canonicals to the preferred domain version.'
    });
  }

  return {
    targetDomain,
    ownedDomains,
    domainStats,
    linkStats,
    crossLinkMap,
    canonicalStats,
    combined: { totalPages, totalWords, totalInternal, totalExternal, totalCross },
    crossFlow,
    warnings,
  };
}

// ─── GSC Cross-Insights (data-driven, no LLM) ────────────────────────────────
function getGscInsights(gscData, db, project) {
  if (!gscData || !gscData.queries.length) return null;

  const insights = [];

  // 1. High impressions, zero/low clicks — title/meta need work
  const wastedImpressions = gscData.queries
    .filter(q => q.impressions >= 30 && q.clicks === 0)
    .slice(0, 8);
  if (wastedImpressions.length) {
    insights.push({
      type: 'wasted_impressions',
      icon: 'fa-eye-slash',
      color: 'var(--color-danger)',
      title: 'Wasted impressions',
      summary: `${wastedImpressions.length} queries get impressions but zero clicks — your titles and meta descriptions aren't compelling enough to earn the click.`,
      items: wastedImpressions.map(q => ({
        label: q.query,
        detail: `${q.impressions} imp · pos ${q.position.toFixed(1)}`,
        severity: q.impressions > 50 ? 'high' : 'medium'
      }))
    });
  }

  // 2. CTR below expected for position
  // Expected CTR by position: pos 1 ~28%, pos 2 ~15%, pos 3 ~11%, pos 5 ~5%, pos 10 ~2.5%
  const expectedCtr = (pos) => {
    if (pos <= 1) return 28; if (pos <= 2) return 15; if (pos <= 3) return 11;
    if (pos <= 5) return 5; if (pos <= 10) return 2.5; return 1;
  };
  const underperformingCtr = gscData.queries
    .filter(q => q.impressions >= 20 && q.clicks >= 1 && q.position <= 10)
    .filter(q => q.ctr < expectedCtr(q.position) * 0.5) // less than half expected CTR
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 6);
  if (underperformingCtr.length) {
    insights.push({
      type: 'low_ctr',
      icon: 'fa-arrow-down',
      color: 'var(--color-warning)',
      title: 'CTR below expected',
      summary: `${underperformingCtr.length} queries rank well but click-through is way below average — meta titles/descriptions need optimization.`,
      items: underperformingCtr.map(q => ({
        label: q.query,
        detail: `pos ${q.position.toFixed(1)} · ${q.ctr.toFixed(1)}% CTR (expected ~${expectedCtr(q.position).toFixed(0)}%)`,
        severity: 'medium'
      }))
    });
  }

  // 3. GSC queries not found in keyword extractions — ranking for terms you don't explicitly target
  try {
    const targetKeywords = new Set();
    db.prepare(`
      SELECT LOWER(k.keyword) as kw
      FROM keywords k
      JOIN pages p ON p.id = k.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
    `).all(project).forEach(r => targetKeywords.add(r.kw));

    const untargetedQueries = gscData.queries
      .filter(q => q.impressions >= 15 && !targetKeywords.has(q.query.toLowerCase()))
      .slice(0, 8);
    if (untargetedQueries.length) {
      insights.push({
        type: 'untargeted',
        icon: 'fa-ghost',
        color: 'var(--accent-purple)',
        title: 'Ranking without targeting',
        summary: `You appear in search for ${untargetedQueries.length} queries that aren't in your extracted keywords — these are opportunities to create dedicated content.`,
        items: untargetedQueries.map(q => ({
          label: q.query,
          detail: `${q.impressions} imp · ${q.clicks} clicks · pos ${q.position.toFixed(1)}`,
          severity: q.clicks > 0 ? 'high' : 'medium'
        }))
      });
    }
  } catch (e) { /* keywords table may not exist */ }

  // 4. Mobile vs Desktop gap
  if (gscData.devices.length >= 2) {
    const desktop = gscData.devices.find(d => d.device.toLowerCase() === 'desktop');
    const mobile = gscData.devices.find(d => d.device.toLowerCase() === 'mobile');
    if (desktop && mobile && desktop.impressions > 0 && mobile.impressions > 0) {
      const desktopCtr = desktop.clicks / desktop.impressions * 100;
      const mobileCtr = mobile.clicks / mobile.impressions * 100;
      const gap = Math.abs(desktopCtr - mobileCtr);
      if (gap > 1.5) {
        const worse = desktopCtr < mobileCtr ? 'desktop' : 'mobile';
        const worseCtr = worse === 'desktop' ? desktopCtr : mobileCtr;
        const betterCtr = worse === 'desktop' ? mobileCtr : desktopCtr;
        insights.push({
          type: 'device_gap',
          icon: worse === 'mobile' ? 'fa-mobile-screen' : 'fa-desktop',
          color: 'var(--color-info)',
          title: `${worse.charAt(0).toUpperCase() + worse.slice(1)} CTR lagging`,
          summary: `${worse} CTR is ${worseCtr.toFixed(2)}% vs ${(worse === 'desktop' ? 'mobile' : 'desktop')} ${betterCtr.toFixed(2)}% — a ${gap.toFixed(1)}pp gap. Check ${worse} snippets and page experience.`,
          items: []
        });
      }
    }
  }

  // 5. Pages with high impressions but deep click depth (orphan-like content that's ranking)
  try {
    const gscPages = gscData.pages.filter(p => p.impressions >= 50);
    const deepRankers = [];
    for (const gp of gscPages) {
      const urlPattern = gp.url.replace(/\/$/, '');
      const row = db.prepare(`
        SELECT p.click_depth FROM pages p
        JOIN domains d ON d.id = p.domain_id
        WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
          AND (p.url = ? OR p.url = ?)
      `).get(project, urlPattern, urlPattern + '/');
      if (row && row.click_depth >= 3) {
        deepRankers.push({ url: gp.url, impressions: gp.impressions, clicks: gp.clicks, depth: row.click_depth });
      }
    }
    if (deepRankers.length) {
      insights.push({
        type: 'deep_rankers',
        icon: 'fa-link-slash',
        color: 'var(--color-warning)',
        title: 'Ranking pages buried in site',
        summary: `${deepRankers.length} pages get search impressions but are ${deepRankers[0].depth}+ clicks deep — promote them with better internal linking.`,
        items: deepRankers.slice(0, 5).map(p => ({
          label: p.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
          detail: `${p.impressions} imp · ${p.clicks} clicks · depth ${p.depth}`,
          severity: 'medium'
        }))
      });
    }
  } catch (e) { /* pages table may not exist */ }

  return insights.length ? insights : null;
}
