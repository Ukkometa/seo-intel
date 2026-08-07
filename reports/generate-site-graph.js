/**
 * SEO Intel — Site Graph Visualization Generator
 *
 * Generates an Obsidian-style force-directed graph of internal links.
 * Self-contained HTML file with D3.js inlined.
 *
 * Usage:
 *   import { generateSiteGraphHtml } from './generate-site-graph.js';
 *   const outPath = await generateSiteGraphHtml(db, project, config);
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pageKey, canonicalizePages, isNavigable } from '../lib/url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const D3_CACHE = join(__dirname, 'd3.v7.min.js');
const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';

// ── Data Queries ────────────────────────────────────────────────────────────

function querySiteGraphData(db, project, maxDepth = 99) {
  // Query 1: Nodes — pages with extraction data and keyword counts
  const nodes = db.prepare(`
    SELECT
      p.id,
      p.url,
      p.status_code,
      p.word_count,
      p.is_indexable,
      p.click_depth,
      d.domain,
      d.role,
      e.title,
      e.meta_desc,
      e.h1,
      e.search_intent,
      e.primary_entities,
      COUNT(DISTINCT k.id) AS keyword_count
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    LEFT JOIN extractions e ON e.page_id = p.id
    LEFT JOIN keywords k ON k.page_id = p.id
    WHERE d.project = ?
      AND d.role IN ('target', 'owned')
      AND (? >= 99 OR p.click_depth <= ?)
    GROUP BY p.id
    ORDER BY p.click_depth ASC, p.word_count DESC
    LIMIT 500
  `).all(project, maxDepth, maxDepth);

  // Collapse www / index.html / #anchor variants of one real page into a
  // single node. Without this each variant draws its own node, the inbound
  // links land on whichever variant a link happened to be written against,
  // and the rest are reported as orphans. See lib/url.js.
  const { merged, idToCanonical, keyToId } = canonicalizePages(nodes, (winner, loser) => {
    if (!winner.title && loser.title) winner.title = loser.title;
    if (!winner.h1 && loser.h1) winner.h1 = loser.h1;
    if (!winner.meta_desc && loser.meta_desc) winner.meta_desc = loser.meta_desc;
    if (!winner.word_count && loser.word_count) winner.word_count = loser.word_count;
    winner.keyword_count = Math.max(winner.keyword_count || 0, loser.keyword_count || 0);
  });

  // Query 2: Edges — internal links between crawled pages in this project
  const rawEdges = db.prepare(`
    SELECT
      l.source_id,
      l.target_url,
      l.anchor_text
    FROM links l
    JOIN pages p_src ON p_src.id = l.source_id
    JOIN domains d ON d.id = p_src.domain_id
    WHERE l.is_internal = 1
      AND d.project = ?
      AND d.role IN ('target', 'owned')
  `).all(project);

  // Resolve each link onto canonical nodes, then dedupe.
  const links = [];
  const seen = new Set();
  const inboundMap = new Map();
  for (const e of rawEdges) {
    const sourceNode = idToCanonical.get(e.source_id);
    if (!sourceNode) continue;
    const targetId = keyToId.get(pageKey(e.target_url));
    if (!targetId) continue;
    // After canonicalization a nav link like `/#pricing` points back at the
    // page it sits on. Real, but not inbound authority.
    if (targetId === sourceNode.id) continue;

    const key = `${sourceNode.id}-${targetId}`;
    if (seen.has(key)) continue; // deduplicate
    seen.add(key);

    links.push({
      source: sourceNode.id,
      target: targetId,
      anchor: e.anchor_text || '',
    });
    // Inbound is counted off the deduped edges, so it means "how many distinct
    // pages link here" and always agrees with what the graph draws. The old
    // query counted raw link rows via an exact URL join, so the number in the
    // sidebar could not be reconciled with the edges on screen.
    inboundMap.set(targetId, (inboundMap.get(targetId) || 0) + 1);
  }

  return { nodes: merged, links, inboundMap };
}

// ── Node Enrichment ─────────────────────────────────────────────────────────

function enrichNodes(nodes, inboundMap) {
  let issues = 0;
  let opportunities = 0;
  let noindex = 0;
  let orphans = 0;

  for (const n of nodes) {
    n.inbound_count = inboundMap.get(n.id) || 0;

    // Compute URL path + subdomain group for display + clustering
    try {
      const u = new URL(n.url);
      n.path = u.pathname;
      n.hostname = u.hostname;
      // Group: subdomain + first path segment (e.g. "docs.example.com/docs")
      const segs = u.pathname.split('/').filter(Boolean);
      n.subdomain = u.hostname.split('.').length > 2 ? u.hostname.split('.')[0] : 'www';
      n.pathGroup = segs[0] || '(root)';
      n.clusterKey = n.subdomain + '/' + n.pathGroup;
    } catch {
      n.path = n.url;
      n.hostname = '';
      n.subdomain = 'www';
      n.pathGroup = '(root)';
      n.clusterKey = 'unknown';
    }

    // Parse entities if string
    if (typeof n.primary_entities === 'string') {
      try { n.primary_entities = JSON.parse(n.primary_entities); } catch { n.primary_entities = []; }
    }
    if (!Array.isArray(n.primary_entities)) n.primary_entities = [];

    // Detect issues
    n.issues = [];
    if (!n.title) n.issues.push('Missing title');
    if (!n.h1) n.issues.push('Missing H1');
    if (!n.meta_desc) n.issues.push('Missing meta description');
    if (n.status_code && n.status_code >= 400) n.issues.push(`HTTP ${n.status_code}`);
    if (n.word_count !== null && n.word_count < 100) n.issues.push('Thin content');

    // Categorize
    if (!n.is_indexable) {
      n.color_category = 'noindex';
      noindex++;
    } else if (n.issues.length > 0) {
      n.color_category = 'issue';
      issues++;
    } else if (n.keyword_count > 3 && n.inbound_count < 2) {
      n.color_category = 'opportunity';
      opportunities++;
    } else {
      n.color_category = 'normal';
    }

    // Machine-readable endpoints (llms.txt, skill.md, feeds) are never linked
    // from nav by design, so counting them as orphans is a false instruction.
    if (n.inbound_count === 0 && n.click_depth > 0 && isNavigable(n.url)) {
      orphans++;
    }

    // Radius: sqrt(inbound + 1) * 4, clamped 4–24
    n.radius = Math.max(4, Math.min(24, Math.sqrt(n.inbound_count + 1) * 4));
  }

  return {
    stats: {
      total_nodes: nodes.length,
      total_edges: 0, // filled in caller
      issues,
      opportunities,
      noindex,
      orphans,
    },
  };
}

// ── D3 Bundle ───────────────────────────────────────────────────────────────

async function fetchOrReadD3() {
  if (existsSync(D3_CACHE)) {
    return readFileSync(D3_CACHE, 'utf8');
  }

  console.log('  Downloading D3.js v7 (one-time, ~280KB)...');
  const res = await fetch(D3_CDN);
  if (!res.ok) throw new Error(`Failed to download D3: ${res.status}`);
  const src = await res.text();
  writeFileSync(D3_CACHE, src, 'utf8');
  return src;
}

// ── HTML Template ───────────────────────────────────────────────────────────

function buildSiteGraphHtml(data, d3src) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Site Graph — ${data.project}</title>
<script>
  // Stamp the stored theme before first paint to avoid a flash. Shares the
  // seoIntelTheme key with the main dashboard, so the two stay in agreement.
  (function () {
    try {
      var t = localStorage.getItem('seoIntelTheme');
      if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    } catch (e) { /* blocked storage — light default is fine */ }
  })();
</script>
<style>
  /* THEME TOKENS — light default, dark via [data-theme="dark"].
     Matches the dashboard's approach (reports/generate-html.js) and
     ukkometa.fi's light rotation. Node/edge/cluster colors are darkened for
     light because they sit on a near-white canvas; the dark values are the
     original palette, unchanged. */
  :root {
    color-scheme: light;
    --bg-primary: #fafaf8;
    --bg-card: #ffffff;
    --bg-elevated: #f3f2ec;
    --border-card: #e3e1da;
    --text-primary: #1a1a1a;
    --text-muted: #75726a;
    --text-dim: #8a877f;
    --accent-gold: #8a6f2f;
    --color-normal: #2c6e8f;
    --color-opportunity: #2f7d4f;
    --color-issue: #b3352f;
    --color-noindex: #a8a59d;
    --color-orphan: #a35a2b;
    --edge-stroke: #a8a49a;
    --node-stroke: rgba(0, 0, 0, 0.28);
    --node-stroke-selected: #1a1a1a;
    --label-fill: #55524a;
    --label-opacity: 0.85;
    --edge-opacity: 0.75;
    --badge-bg: #eceae4;
    --badge-target-bg: #e2efe6;
    --badge-comp-bg: #f6e4e2;
    --sidebar-width: 340px;
    /* Subdomain cluster ring colors */
    --cluster-www: #2c6e8f;
    --cluster-docs: #6b4f9e;
    --cluster-blog: #2f7d4f;
    --cluster-app: #a35a2b;
    --cluster-api: #a8306a;
    --cluster-other: #75726a;
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg-primary: #0a0a0a;
    --bg-card: #111111;
    --bg-elevated: #161616;
    --border-card: #262626;
    --text-primary: #e8e8e8;
    --text-muted: #888888;
    --text-dim: #666666;
    --accent-gold: #e8d5a3;
    --color-normal: #6ba3c7;
    --color-opportunity: #8ecba8;
    --color-issue: #d98e8e;
    --color-noindex: #444444;
    --color-orphan: #c79b6b;
    --edge-stroke: #1e1e1e;
    --node-stroke: #000000;
    --node-stroke-selected: #ffffff;
    --label-fill: #666666;
    --label-opacity: 0.55;
    --edge-opacity: 0.6;
    --badge-bg: #1a1a2a;
    --badge-target-bg: #1a3a2a;
    --badge-comp-bg: #3a1a1a;
    --cluster-www: #6ba3c7;
    --cluster-docs: #a78bfa;
    --cluster-blog: #8ecba8;
    --cluster-app: #f59e0b;
    --cluster-api: #ec4899;
    --cluster-other: #888;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    height: 100vh;
  }

  /* ── Toolbar ── */
  .toolbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 48px;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border-card);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 12px;
    z-index: 100;
  }

  .toolbar .project-label {
    font-weight: 600;
    font-size: 14px;
    color: var(--accent-gold);
    white-space: nowrap;
  }

  .toolbar .divider {
    width: 1px;
    height: 24px;
    background: var(--border-card);
  }

  .filter-pills {
    display: flex;
    gap: 6px;
  }

  .pill {
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--border-card);
    background: transparent;
    color: var(--text-muted);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .pill:hover { border-color: var(--text-dim); color: var(--text-primary); }
  .pill.active { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--text-dim); }
  .pill .count { opacity: 0.5; margin-left: 3px; }

  .search-box {
    margin-left: auto;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--border-card);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    width: 180px;
    outline: none;
  }
  .search-box:focus { border-color: var(--accent-gold); }
  .search-box::placeholder { color: var(--text-dim); }

  .theme-toggle {
    margin-left: 12px;
    padding: 5px 12px;
    border-radius: 100px;
    border: 1px solid var(--border-card);
    background: var(--bg-card);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .theme-toggle:hover { border-color: var(--text-dim); color: var(--text-primary); }
  .theme-toggle:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }

  .depth-control {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .depth-control input[type="range"] {
    width: 60px;
    accent-color: var(--accent-gold);
  }

  .stats-bar {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── SVG Canvas ── */
  .graph-container {
    position: fixed;
    top: 48px; left: 0; right: 0; bottom: 0;
  }

  svg {
    width: 100%;
    height: 100%;
    cursor: grab;
  }
  svg:active { cursor: grabbing; }

  .link {
    stroke: var(--edge-stroke);
    stroke-width: 0.5;
    stroke-opacity: var(--edge-opacity);
  }
  .link.highlighted {
    stroke: var(--accent-gold);
    stroke-width: 1.5;
    stroke-opacity: 1;
  }
  .link.dimmed { stroke-opacity: 0.08; }

  .node {
    cursor: pointer;
    stroke: var(--node-stroke);
    stroke-width: 0.5;
    transition: opacity 0.2s;
  }
  .node:hover {
    stroke: var(--accent-gold);
    stroke-width: 2;
  }
  .node.selected {
    stroke: var(--node-stroke-selected);
    stroke-width: 2.5;
  }
  .node.dimmed { opacity: 0.1; }
  .node.filtered-out { opacity: 0.05; pointer-events: none; }

  .node-ring {
    fill: none;
    stroke-width: 1.5;
    stroke-opacity: 0.4;
    pointer-events: none;
  }

  .node-label {
    font-size: 10px;
    fill: var(--label-fill);
    pointer-events: none;
    text-anchor: middle;
    dominant-baseline: central;
    opacity: var(--label-opacity);
    transition: opacity 0.3s;
    font-weight: 400;
  }
  .node-label.zoomed-far { opacity: 0; font-size: 10px; }
  .node-label.zoomed-mid { opacity: calc(var(--label-opacity) * 0.8); font-size: 10px; }
  .node-label.zoomed-close { opacity: calc(var(--label-opacity) * 1.15); font-size: 10px; }
  .node-label.hub-label { font-weight: 600; opacity: calc(var(--label-opacity) * 1.1); }

  /* ── Sidebar ── */
  .sidebar {
    position: fixed;
    top: 48px;
    right: 0;
    bottom: 0;
    width: var(--sidebar-width);
    background: var(--bg-card);
    border-left: 1px solid var(--border-card);
    transform: translateX(100%);
    transition: transform 0.2s ease;
    overflow-y: auto;
    z-index: 50;
    padding: 20px 16px;
  }
  .sidebar.open { transform: translateX(0); }

  .sidebar .close-btn {
    position: absolute;
    top: 12px; right: 12px;
    background: none; border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 18px;
  }

  .sidebar h3 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
    word-break: break-all;
  }

  .sidebar .url-display {
    font-size: 11px;
    color: var(--text-muted);
    word-break: break-all;
    margin-bottom: 12px;
  }

  .sidebar .role-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .role-badge.target { background: var(--badge-target-bg); color: var(--color-opportunity); }
  .role-badge.competitor { background: var(--badge-comp-bg); color: var(--color-issue); }

  .sidebar .section {
    border-top: 1px solid var(--border-card);
    padding: 10px 0;
  }

  .sidebar .meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    font-size: 11px;
  }
  .meta-grid .label { color: var(--text-muted); }
  .meta-grid .value { color: var(--text-primary); }

  .sidebar .entity-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .entity-tag {
    padding: 2px 8px;
    background: var(--badge-bg);
    border-radius: 6px;
    font-size: 10px;
    color: var(--color-normal);
  }

  .sidebar .issue-list {
    list-style: none;
    padding: 0;
  }
  .issue-list li {
    padding: 3px 0;
    font-size: 11px;
    color: var(--color-issue);
  }
  .issue-list li::before { content: '\\26A0 '; }

  .sidebar .open-link {
    display: inline-block;
    margin-top: 8px;
    color: var(--accent-gold);
    font-size: 11px;
    text-decoration: none;
  }

  /* ── Legend ── */
  .legend {
    position: fixed;
    bottom: 16px;
    left: 16px;
    display: flex;
    gap: 14px;
    font-size: 10px;
    color: var(--text-muted);
    z-index: 10;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  /* ── Empty state ── */
  .empty-state {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }
  .empty-state h2 { font-size: 18px; margin-bottom: 8px; color: var(--text-primary); }
</style>
</head>
<body>

<div class="toolbar">
  <span class="project-label">${data.project}</span>
  <div class="divider"></div>
  <div class="filter-pills">
    <button class="pill active" data-filter="all">All <span class="count">${data.stats.total_nodes}</span></button>
    <button class="pill" data-filter="issue" style="border-color: var(--color-issue)">Issues <span class="count">${data.stats.issues}</span></button>
    <button class="pill" data-filter="opportunity" style="border-color: var(--color-opportunity)">Opportunities <span class="count">${data.stats.opportunities}</span></button>
    <button class="pill" data-filter="noindex">No-index <span class="count">${data.stats.noindex}</span></button>
    <button class="pill" data-filter="orphan" style="border-color: var(--color-orphan)">Orphans <span class="count">${data.stats.orphans}</span></button>
  </div>
  <div class="depth-control">
    <label>Depth</label>
    <input type="range" id="depthSlider" min="0" max="8" value="8">
    <span id="depthValue">all</span>
  </div>
  <input class="search-box" type="text" placeholder="Search pages..." id="searchBox">
  <div class="stats-bar">
    <span id="visibleCount">${data.stats.total_nodes}</span> nodes · <span id="edgeCount">${data.stats.total_edges}</span> edges
  </div>
  <button id="themeToggle" class="theme-toggle" type="button" onclick="toggleTheme()"
          aria-pressed="false" title="Switch between light and dark">Dark</button>
</div>

<div class="graph-container">
  <svg id="graph"></svg>
</div>

<div class="sidebar" id="sidebar">
  <button class="close-btn" onclick="closeSidebar()">&times;</button>
  <div id="sidebarContent"></div>
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:var(--color-normal)"></div> Normal</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--color-opportunity)"></div> Opportunity</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--color-issue)"></div> Issue</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--color-noindex)"></div> No-index</div>
  <span style="color:var(--text-dim);margin:0 6px">│</span>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cluster-www);opacity:0.5;border:1.5px solid var(--cluster-www)"></div> www</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cluster-docs);opacity:0.5;border:1.5px solid var(--cluster-docs)"></div> docs</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cluster-blog);opacity:0.5;border:1.5px solid var(--cluster-blog)"></div> blog</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cluster-app);opacity:0.5;border:1.5px solid var(--cluster-app)"></div> app</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cluster-api);opacity:0.5;border:1.5px solid var(--cluster-api)"></div> api</div>
</div>

${data.stats.total_edges === 0 ? `
<div class="empty-state">
  <h2>No internal links found</h2>
  <p>Run a crawl with link extraction first:<br><code>seo-intel crawl ${data.project}</code></p>
</div>
` : ''}

<script>
// ── D3.js v7 (inlined) ──
${d3src}
</script>

<script>
// ── Graph Data ──
const GRAPH_DATA = ${JSON.stringify(data)};

// ── Color Map ──
// Read from the CSS tokens at runtime, not baked at generate time: SVG
// presentation attributes set via d3 .attr() do not resolve var(), so the
// palette has to be resolved in JS and re-applied when the theme flips.
const readCssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

let COLOR_MAP = {};
let CLUSTER_COLORS = {};
function readGraphColors() {
  COLOR_MAP = {
    normal:      readCssVar('--color-normal', '#6ba3c7'),
    opportunity: readCssVar('--color-opportunity', '#8ecba8'),
    issue:       readCssVar('--color-issue', '#d98e8e'),
    noindex:     readCssVar('--color-noindex', '#444444'),
  };
  // Subdomain cluster ring colors. Module scope on purpose — selectNode()
  // renders these in the sidebar and previously could not see them, because
  // clusterColor was declared inside initGraph().
  CLUSTER_COLORS = {
    www:  readCssVar('--cluster-www', '#6ba3c7'),
    docs: readCssVar('--cluster-docs', '#a78bfa'),
    blog: readCssVar('--cluster-blog', '#8ecba8'),
    app:  readCssVar('--cluster-app', '#f59e0b'),
    api:  readCssVar('--cluster-api', '#ec4899'),
    other: readCssVar('--cluster-other', '#888888'),
  };
}
function clusterColor(subdomain) {
  return CLUSTER_COLORS[subdomain] || CLUSTER_COLORS.other;
}
readGraphColors();

// ── State ──
let currentFilter = 'all';
let currentSearch = '';
let currentDepth = 99;
let selectedNodeId = null;
let simulation, svgG, nodeEls, linkEls, labelEls;

// ── Init ──
function initGraph() {
  const svg = d3.select('#graph');
  const container = document.querySelector('.graph-container');
  const width = container.clientWidth;
  const height = container.clientHeight;

  const nodes = GRAPH_DATA.nodes.map(d => ({ ...d }));
  const links = GRAPH_DATA.links.map(d => ({ ...d }));

  if (nodes.length === 0) return;

  // Compute cluster centers for subdomain grouping
  const clusterKeys = [...new Set(nodes.map(n => n.subdomain))];
  const clusterCenters = {};
  const angleStep = (2 * Math.PI) / Math.max(clusterKeys.length, 1);
  const clusterRadius = Math.min(width, height) * 0.2;
  clusterKeys.forEach((k, i) => {
    clusterCenters[k] = {
      x: width / 2 + Math.cos(angleStep * i) * clusterRadius,
      y: height / 2 + Math.sin(angleStep * i) * clusterRadius,
    };
  });

  // Zoom — Obsidian-style: labels appear progressively
  let currentZoomK = 1;
  const zoom = d3.zoom()
    .scaleExtent([0.05, 12])
    .on('zoom', (event) => {
      svgG.attr('transform', event.transform);
      currentZoomK = event.transform.k;

      // Progressive label visibility based on zoom + node importance
      labelEls
        .classed('zoomed-far', currentZoomK < 0.5)
        .classed('zoomed-mid', currentZoomK >= 0.5 && currentZoomK < 1.5)
        .classed('zoomed-close', currentZoomK >= 1.5);

      // Hub labels (high link count) visible earlier
      labelEls.classed('hub-label', d => d.inbound >= 5 || d.radius >= 8);

      // Scale label font inversely so they stay readable at any zoom
      const labelScale = Math.max(0.6, Math.min(2.0, 1.0 / currentZoomK));
      labelEls.style('font-size', (10 * labelScale) + 'px');
    });
  svg.call(zoom);

  svgG = svg.append('g');

  // Links
  linkEls = svgG.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('class', 'link');

  // Subdomain rings (outer ring showing cluster membership)
  const ringEls = svgG.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('class', 'node-ring')
    .attr('r', d => d.radius + 3)
    .attr('stroke', d => clusterColor(d.subdomain));

  // Nodes
  nodeEls = svgG.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('class', 'node')
    .attr('r', d => d.radius)
    .attr('fill', d => COLOR_MAP[d.color_category] || COLOR_MAP.normal)
    .call(drag())
    .on('click', (event, d) => selectNode(d));

  // Labels — show short title or path slug, Obsidian-style
  function nodeLabel(d) {
    // Prefer a short title if extracted
    if (d.title && d.title.length > 0) {
      const t = d.title.split('|')[0].split('—')[0].split('-')[0].trim();
      return t.length > 30 ? t.slice(0, 28) + '…' : t;
    }
    // Fall back to last path segment
    const slug = d.path.replace(/\\/$/, '').split('/').pop() || d.path;
    return slug.length > 25 ? slug.slice(0, 23) + '…' : slug;
  }
  labelEls = svgG.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .attr('class', 'node-label')
    .text(d => nodeLabel(d));

  // Simulation — heavy nodes, subdomain clustering, settles fast
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90).strength(0.08))
    .force('charge', d3.forceManyBody().strength(-180).distanceMax(500))
    .force('center', d3.forceCenter(width / 2, height / 2).strength(0.08))
    .force('collide', d3.forceCollide().radius(d => d.radius + 12).strength(0.8).iterations(2))
    // Cluster pull: nodes drift toward their subdomain's center
    .force('clusterX', d3.forceX(d => clusterCenters[d.subdomain]?.x || width / 2).strength(0.04))
    .force('clusterY', d3.forceY(d => clusterCenters[d.subdomain]?.y || height / 2).strength(0.04))
    .alphaDecay(0.04)
    .velocityDecay(0.78)
    .on('tick', () => {
      linkEls
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      nodeEls.attr('cx', d => d.x).attr('cy', d => d.y);
      ringEls.attr('cx', d => d.x).attr('cy', d => d.y);
      labelEls.attr('x', d => d.x).attr('y', d => d.y - d.radius - 6);
    });

  // Initial zoom to fit — wait for simulation to settle
  setTimeout(() => {
    const bounds = svgG.node().getBBox();
    if (bounds.width === 0) return;
    const pad = 80;
    const scale = Math.min(
      width / (bounds.width + pad * 2),
      height / (bounds.height + pad * 2),
      1.2
    );
    const tx = (width - bounds.width * scale) / 2 - bounds.x * scale;
    const ty = (height - bounds.height * scale) / 2 - bounds.y * scale;
    svg.transition().duration(1200).ease(d3.easeCubicOut)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }, 1500);
}

// ── Drag — gentle reheat so neighbors don't go flying ──
function drag() {
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) simulation.alphaTarget(0.08).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x; d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    });
}

// ── Node Selection ──
function selectNode(node) {
  selectedNodeId = node.id;

  // Highlight
  nodeEls.classed('selected', d => d.id === node.id);
  nodeEls.classed('dimmed', d => {
    if (d.id === node.id) return false;
    const connected = GRAPH_DATA.links.some(l =>
      (l.source === node.id && l.target === d.id) ||
      (l.target === node.id && l.source === d.id) ||
      (l.source.id === node.id && l.target.id === d.id) ||
      (l.target.id === node.id && l.source.id === d.id)
    );
    return !connected;
  });
  linkEls.classed('highlighted', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return sid === node.id || tid === node.id;
  });
  linkEls.classed('dimmed', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return sid !== node.id && tid !== node.id;
  });

  // Sidebar
  const sb = document.getElementById('sidebarContent');
  const roleClass = node.role === 'target' ? 'target' : 'competitor';
  const entities = (node.primary_entities || []).map(e =>
    '<span class="entity-tag">' + esc(e) + '</span>'
  ).join('');
  const issues = (node.issues || []).map(i =>
    '<li>' + esc(i) + '</li>'
  ).join('');

  sb.innerHTML = \`
    <h3>\${esc(node.title || node.path)}</h3>
    <div class="url-display">\${esc(node.url)}</div>
    <span class="role-badge \${roleClass}">\${node.role}</span>
    <span class="role-badge" style="background:var(--badge-bg);color:var(--color-normal);margin-left:4px">depth \${node.click_depth}</span>
    <span class="role-badge" style="background:var(--badge-bg);color:\${clusterColor(node.subdomain)};margin-left:4px">\${node.hostname || '—'}</span>

    <div class="section">
      <div class="meta-grid">
        <span class="label">Status</span><span class="value">\${node.status_code || '—'}</span>
        <span class="label">Words</span><span class="value">\${node.word_count || '—'}</span>
        <span class="label">Links in</span><span class="value">\${node.inbound_count}</span>
        <span class="label">Keywords</span><span class="value">\${node.keyword_count}</span>
        <span class="label">Indexable</span><span class="value">\${node.is_indexable ? 'Yes' : 'No'}</span>
        <span class="label">Intent</span><span class="value">\${node.search_intent || '—'}</span>
        <span class="label">Subdomain</span><span class="value" style="color:\${clusterColor(node.subdomain)}">\${node.subdomain || '—'}</span>
        <span class="label">Path group</span><span class="value">\${node.pathGroup || '—'}</span>
      </div>
    </div>

    \${node.h1 ? '<div class="section"><div class="label" style="font-size:10px;color:var(--text-muted);margin-bottom:2px">H1</div><div style="font-size:12px">' + esc(node.h1) + '</div></div>' : ''}
    \${node.meta_desc ? '<div class="section"><div class="label" style="font-size:10px;color:var(--text-muted);margin-bottom:2px">Meta</div><div style="font-size:11px;color:var(--text-muted)">' + esc(node.meta_desc.slice(0, 160)) + '</div></div>' : ''}

    \${entities ? '<div class="section"><div class="label" style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Entities</div><div class="entity-tags">' + entities + '</div></div>' : ''}

    \${issues ? '<div class="section"><div class="label" style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Issues</div><ul class="issue-list">' + issues + '</ul></div>' : ''}

    <a class="open-link" href="\${esc(node.url)}" target="_blank">Open in browser &rarr;</a>
  \`;

  document.getElementById('sidebar').classList.add('open');
}

function closeSidebar() {
  selectedNodeId = null;
  document.getElementById('sidebar').classList.remove('open');
  nodeEls.classed('selected', false).classed('dimmed', false);
  linkEls.classed('highlighted', false).classed('dimmed', false);
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Filters ──
document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.filter;
    applyFilters();
  });
});

document.getElementById('searchBox').addEventListener('input', (e) => {
  currentSearch = e.target.value.toLowerCase();
  applyFilters();
});

document.getElementById('depthSlider').addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  currentDepth = val >= 8 ? 99 : val;
  document.getElementById('depthValue').textContent = val >= 8 ? 'all' : val;
  applyFilters();
});

function applyFilters() {
  let visible = 0;

  nodeEls.classed('filtered-out', d => {
    let show = true;

    // Category filter
    if (currentFilter !== 'all') {
      if (currentFilter === 'orphan') {
        show = d.inbound_count === 0 && d.click_depth > 0;
      } else {
        show = d.color_category === currentFilter;
      }
    }

    // Depth filter
    if (show && currentDepth < 99) {
      show = d.click_depth <= currentDepth;
    }

    // Search filter
    if (show && currentSearch) {
      const hay = (d.path + ' ' + (d.title || '') + ' ' + (d.h1 || '')).toLowerCase();
      show = hay.includes(currentSearch);
    }

    if (show) visible++;
    return !show;
  });

  // Dim links whose source or target is filtered out
  const visibleIds = new Set();
  nodeEls.each(function(d) {
    if (!d3.select(this).classed('filtered-out')) visibleIds.add(d.id);
  });
  linkEls.attr('stroke-opacity', d => {
    const sid = typeof d.source === 'object' ? d.source.id : d.source;
    const tid = typeof d.target === 'object' ? d.target.id : d.target;
    return visibleIds.has(sid) && visibleIds.has(tid) ? 0.6 : 0.02;
  });

  document.getElementById('visibleCount').textContent = visible;
}

// ── Theme toggle ──
// CSS handles the chrome. The SVG does not: node fills and cluster rings are
// set as presentation attributes, which do not resolve var(), so they are
// re-read and re-applied here rather than by re-running the whole simulation
// (which would throw away the current layout).
function syncThemeControl(theme) {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  var isDark = theme === 'dark';
  btn.textContent = isDark ? 'Light' : 'Dark';
  btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  btn.title = isDark ? 'Switch to light' : 'Switch to dark';
}

function toggleTheme() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var theme = isDark ? 'light' : 'dark';

  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('seoIntelTheme', theme); } catch (e) { /* blocked storage */ }

  syncThemeControl(theme);
  readGraphColors();

  if (nodeEls) nodeEls.attr('fill', d => COLOR_MAP[d.color_category] || COLOR_MAP.normal);
  if (svgG) svgG.selectAll('.node-ring').attr('stroke', d => clusterColor(d.subdomain));

  // Re-render an open sidebar so its inline colors match the new theme.
  if (selectedNodeId != null) {
    var node = GRAPH_DATA.nodes.find(n => n.id === selectedNodeId);
    if (node) selectNode(node);
  }
}

// ── Start ──
syncThemeControl(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
if (GRAPH_DATA.nodes.length > 0) initGraph();
</script>
</body>
</html>`;
}

function cssVar(name, fallback) { return fallback; }

// ── Main Export ─────────────────────────────────────────────────────────────

export async function generateSiteGraphHtml(db, project, config = {}) {
  const maxDepth = config.maxDepth || 99;

  // Query data
  const { nodes, links, inboundMap } = querySiteGraphData(db, project, maxDepth);
  const { stats } = enrichNodes(nodes, inboundMap);
  stats.total_edges = links.length;

  // Get D3
  const d3src = await fetchOrReadD3();

  // Build HTML
  const data = {
    project,
    generated: Date.now(),
    nodes,
    links,
    stats,
  };

  const html = buildSiteGraphHtml(data, d3src);

  // Write file
  const outPath = join(__dirname, `${project}-site-graph.html`);
  writeFileSync(outPath, html, 'utf8');

  return outPath;
}
