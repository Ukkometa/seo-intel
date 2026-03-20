/**
 * topic-cluster-mapper.js
 *
 * Reads keywords, headings, and extractions from the DB.
 * Groups pages into topic clusters by keyword theme.
 * Outputs:
 *   - reports/topic-clusters.json   → full cluster data
 *   - reports/topic-clusters.md     → human-readable summary
 *   - Console: dashboard-ready data snippet
 *
 * No LLM needed — pure text analysis.
 *
 * Usage:
 *   node analysis/topic-cluster-mapper.js [--project carbium|ukkometa] [--role target|competitor|all]
 */

import { getDb } from '../db/db.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '../reports');

// ─── Config ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const PROJECT = getArg('--project', 'carbium');
const ROLE_FILTER = getArg('--role', 'all'); // target | competitor | all

// ─── Topic cluster definitions ─────────────────────────────────────────────
// Each cluster has: id, label, seeds (exact or partial keyword matches)
// A page scores points for each seed match — highest scorer wins.

const TOPIC_CLUSTERS = [
  {
    id: 'rpc',
    label: 'RPC & Node Infrastructure',
    seeds: ['rpc', 'node', 'endpoint', 'rpc node', 'rpc endpoint', 'json-rpc', 'jsonrpc',
            'websocket', 'wss', 'connection', 'latency', 'uptime', 'reliability'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'dex',
    label: 'DEX & Swap',
    seeds: ['dex', 'swap', 'quote', 'amm', 'liquidity', 'pool', 'routing', 'slippage',
            'token swap', 'dex api', 'swap api', 'jupiter', 'raydium', 'orca', 'gasless'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'data',
    label: 'Blockchain Data & Analytics',
    seeds: ['data', 'analytics', 'historical', 'indexer', 'index', 'stream', 'webhook',
            'transaction data', 'on-chain', 'onchain', 'real-time', 'realtime', 'archive'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'validator',
    label: 'Validator & Staking',
    seeds: ['validator', 'staking', 'stake', 'spdr', 'vote', 'consensus', 'rewards',
            'delegat', 'epoch', 'apy', 'commission'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'api',
    label: 'API & Developer Tools',
    seeds: ['api', 'sdk', 'developer', 'integration', 'documentation', 'docs', 'quickstart',
            'tutorial', 'example', 'code', 'library', 'client', 'getting started'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'trading',
    label: 'Trading & DeFi',
    seeds: ['trading', 'trade', 'defi', 'mev', 'arbitrage', 'bot', 'perp', 'perpetual',
            'leverage', 'margin', 'order book', 'market maker', 'mempool', 'bundle', 'jito'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'pricing',
    label: 'Pricing & Plans',
    seeds: ['pricing', 'price', 'plan', 'tier', 'free', 'enterprise', 'credits',
            'rate limit', 'quota', 'subscription', 'billing'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'solana_ecosystem',
    label: 'Solana Ecosystem',
    seeds: ['solana', 'sol', 'spl', 'token', 'wallet', 'nft', 'program', 'anchor',
            'sealevel', 'mainnet', 'devnet', 'testnet', 'cluster'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure & Ops',
    seeds: ['infrastructure', 'performance', 'scalability', 'redundancy', 'failover',
            'geo', 'region', 'cloud', 'bare metal', 'dedicated', 'private', 'enterprise',
            'compliance', 'sla', 'uptime'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'education',
    label: 'Education & Learning',
    seeds: ['what is', 'how to', 'guide', 'tutorial', 'learn', 'beginner', 'introduction',
            'explained', 'overview', 'glossary', 'faq', 'understand'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'ai',
    label: 'AI & Agents',
    seeds: ['ai', 'artificial intelligence', 'agent', 'llm', 'gpt', 'ml', 'machine learning',
            'ai coding', 'copilot', 'automation'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  },
  {
    id: 'comparison',
    label: 'Comparisons & Alternatives',
    seeds: ['vs', 'versus', 'alternative', 'compare', 'comparison', 'better than',
            'helius alternative', 'quicknode alternative', 'switch', 'migrate'],
    weight: { title: 5, h1: 4, h2: 3, meta: 2, body: 1 }
  }
];

// ─── Scoring ────────────────────────────────────────────────────────────────

function scorePageForClusters(keywords, headingTexts, title, metaDesc) {
  const scores = {};
  for (const cluster of TOPIC_CLUSTERS) {
    scores[cluster.id] = 0;
  }

  // Score from keywords table
  for (const { keyword, location } of keywords) {
    const kw = keyword.toLowerCase().trim();
    for (const cluster of TOPIC_CLUSTERS) {
      const w = cluster.weight[location] || 1;
      for (const seed of cluster.seeds) {
        if (kw.includes(seed) || seed.includes(kw)) {
          scores[cluster.id] += w;
          break;
        }
      }
    }
  }

  // Score from headings (H2/H3 text)
  for (const text of headingTexts) {
    const t = text.toLowerCase();
    for (const cluster of TOPIC_CLUSTERS) {
      for (const seed of cluster.seeds) {
        if (t.includes(seed)) {
          scores[cluster.id] += 3;
          break;
        }
      }
    }
  }

  return scores;
}

function getTopClusters(scores, n = 3) {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, s]) => s > 0)
    .slice(0, n)
    .map(([id, score]) => ({ id, score }));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const db = getDb();

  console.log(`\n🔶 Topic Cluster Mapper — project: ${PROJECT}, role: ${ROLE_FILTER}\n`);

  // 1. Load pages
  let roleClause = ROLE_FILTER === 'all' ? '' : `AND d.role = '${ROLE_FILTER}'`;
  const pages = db.prepare(`
    SELECT p.id, p.url, p.word_count, p.click_depth,
           d.domain, d.role,
           e.title, e.meta_desc, e.h1, e.primary_entities, e.search_intent
    FROM pages p
    JOIN domains d ON p.domain_id = d.id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ? ${roleClause}
    AND p.status_code = 200
    ORDER BY d.domain, p.click_depth
  `).all(PROJECT);

  console.log(`  Pages loaded: ${pages.length}`);

  // 2. Load keywords per page
  const keywordsByPage = new Map();
  const allKeywords = db.prepare(`
    SELECT k.page_id, k.keyword, k.location
    FROM keywords k
    JOIN pages p ON k.page_id = p.id
    JOIN domains d ON p.domain_id = d.id
    WHERE d.project = ?
  `).all(PROJECT);

  for (const row of allKeywords) {
    if (!keywordsByPage.has(row.page_id)) keywordsByPage.set(row.page_id, []);
    keywordsByPage.get(row.page_id).push(row);
  }

  // 3. Load headings per page
  const headingsByPage = new Map();
  const allHeadings = db.prepare(`
    SELECT h.page_id, h.level, h.text
    FROM headings h
    JOIN pages p ON h.page_id = p.id
    JOIN domains d ON p.domain_id = d.id
    WHERE d.project = ? AND h.level <= 3
  `).all(PROJECT);

  for (const row of allHeadings) {
    if (!headingsByPage.has(row.page_id)) headingsByPage.set(row.page_id, []);
    headingsByPage.get(row.page_id).push(row.text);
  }

  // 4. Score each page
  const pageClusters = [];
  for (const page of pages) {
    const keywords = keywordsByPage.get(page.id) || [];
    const headings = headingsByPage.get(page.id) || [];
    const scores = scorePageForClusters(keywords, headings, page.title, page.meta_desc);
    const topClusters = getTopClusters(scores, 3);
    const primaryCluster = topClusters[0]?.id || 'uncategorized';

    pageClusters.push({
      url: page.url,
      domain: page.domain,
      role: page.role,
      word_count: page.word_count,
      click_depth: page.click_depth,
      title: page.title || '',
      h1: page.h1 || '',
      primary_cluster: primaryCluster,
      secondary_cluster: topClusters[1]?.id || null,
      all_scores: scores,
      top_clusters: topClusters
    });
  }

  // 5. Build cluster summaries
  const clusterSummaries = {};
  for (const cluster of TOPIC_CLUSTERS) {
    clusterSummaries[cluster.id] = {
      id: cluster.id,
      label: cluster.label,
      pages: [],
      byDomain: {},
      pageCount: 0,
      avgWordCount: 0,
      targetPages: [],
      competitorPages: []
    };
  }
  clusterSummaries['uncategorized'] = {
    id: 'uncategorized',
    label: 'Uncategorized',
    pages: [],
    byDomain: {},
    pageCount: 0,
    avgWordCount: 0,
    targetPages: [],
    competitorPages: []
  };

  for (const pc of pageClusters) {
    const c = clusterSummaries[pc.primary_cluster];
    if (!c) continue;
    c.pages.push(pc);
    c.pageCount++;
    if (!c.byDomain[pc.domain]) c.byDomain[pc.domain] = { count: 0, urls: [] };
    c.byDomain[pc.domain].count++;
    c.byDomain[pc.domain].urls.push(pc.url);
    if (pc.role === 'target') c.targetPages.push(pc);
    else c.competitorPages.push(pc);
  }

  // Avg word count
  for (const c of Object.values(clusterSummaries)) {
    if (c.pageCount > 0) {
      const wcs = c.pages.map(p => p.word_count || 0).filter(Boolean);
      c.avgWordCount = wcs.length ? Math.round(wcs.reduce((a, b) => a + b, 0) / wcs.length) : 0;
    }
  }

  // 6. Build gap analysis — clusters competitors cover but target has few/no pages
  const gapAnalysis = [];
  for (const cluster of TOPIC_CLUSTERS) {
    const c = clusterSummaries[cluster.id];
    const targetCount = c.targetPages.length;
    const competitorCount = c.competitorPages.length;
    const topCompetitors = Object.entries(c.byDomain)
      .filter(([d]) => {
        const p = pageClusters.find(pc => pc.domain === d);
        return p && p.role === 'competitor';
      })
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([d, info]) => ({ domain: d, count: info.count }));

    gapAnalysis.push({
      cluster_id: cluster.id,
      label: cluster.label,
      target_pages: targetCount,
      competitor_pages: competitorCount,
      gap_score: competitorCount - targetCount * 2, // positive = gap
      top_competitors: topCompetitors
    });
  }
  gapAnalysis.sort((a, b) => b.gap_score - a.gap_score);

  // 7. Dashboard data format (matches carbium-dashboard.html's `data` array)
  const dashboardData = TOPIC_CLUSTERS.map(cluster => {
    const c = clusterSummaries[cluster.id];
    const domainCounts = {};
    for (const [domain, info] of Object.entries(c.byDomain)) {
      domainCounts[domain] = info.count;
    }
    const dominant = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      cluster: cluster.label,
      cluster_id: cluster.id,
      keywords: c.pageCount,
      totalFreq: c.pageCount,
      dominant: dominant ? { domain: dominant[0], freq: dominant[1] } : null,
      domains: domainCounts,
      target_pages: c.targetPages.length,
      competitor_pages: c.competitorPages.length,
      avg_word_count: c.avgWordCount
    };
  }).filter(d => d.keywords > 0)
    .sort((a, b) => b.totalFreq - a.totalFreq);

  // 8. Output
  const output = {
    generated_at: new Date().toISOString(),
    project: PROJECT,
    role_filter: ROLE_FILTER,
    total_pages: pageClusters.length,
    cluster_definitions: TOPIC_CLUSTERS.map(c => ({ id: c.id, label: c.label })),
    page_clusters: pageClusters,
    cluster_summaries: clusterSummaries,
    gap_analysis: gapAnalysis,
    dashboard_data: dashboardData
  };

  // Write project-specific file (and generic fallback for backwards compat)
  const projectOutPath = join(REPORTS_DIR, `topic-clusters-${PROJECT}.json`);
  const genericOutPath = join(REPORTS_DIR, 'topic-clusters.json');
  writeFileSync(projectOutPath, JSON.stringify(output, null, 2));
  writeFileSync(genericOutPath, JSON.stringify(output, null, 2));
  console.log(`  ✅ Written: reports/topic-clusters-${PROJECT}.json`);

  // 9. Markdown summary
  const lines = [
    `# Topic Cluster Map — ${PROJECT}`,
    `Generated: ${new Date().toISOString()}`,
    `Pages analyzed: ${pageClusters.length}`,
    '',
    '## 📊 Cluster Overview',
    '',
    '| Cluster | Target Pages | Competitor Pages | Gap Score | Top Competitor |',
    '|---------|-------------|-----------------|-----------|----------------|',
    ...gapAnalysis.map(g =>
      `| **${g.label}** | ${g.target_pages} | ${g.competitor_pages} | ${g.gap_score > 0 ? '🔴' : '✅'} ${g.gap_score} | ${g.top_competitors[0]?.domain || '—'} (${g.top_competitors[0]?.count || 0}p) |`
    ),
    '',
    '## 🔴 Biggest Gaps (clusters competitors dominate, target is thin)',
    '',
    ...gapAnalysis
      .filter(g => g.gap_score > 0)
      .map(g => [
        `### ${g.label}`,
        `- Target pages: **${g.target_pages}**`,
        `- Competitor pages: **${g.competitor_pages}**`,
        `- Top competitors: ${g.top_competitors.map(c => `${c.domain} (${c.count})`).join(', ')}`,
        ''
      ].join('\n')),
    '## ✅ Clusters Target Covers Well',
    '',
    ...gapAnalysis
      .filter(g => g.gap_score <= 0 && g.target_pages > 0)
      .map(g => `- **${g.label}**: ${g.target_pages} target pages vs ${g.competitor_pages} competitor pages`)
      .join('\n') + '\n',
    '',
    '## 📄 Page Assignments (Target Only)',
    '',
    ...pageClusters
      .filter(p => p.role === 'target')
      .map(p => `- [${p.primary_cluster}] ${p.url.replace('https://', '')} (${p.word_count || 0}w)`)
  ];

  const mdPath = join(REPORTS_DIR, 'topic-clusters.md');
  writeFileSync(mdPath, lines.join('\n'));
  console.log(`  ✅ Written: reports/topic-clusters.md`);

  // 10. Print dashboard data snippet for copy-paste into HTML
  console.log('\n📋 Dashboard data (paste into carbium-dashboard.html):');
  console.log('const clusterData = ' + JSON.stringify(dashboardData, null, 2).slice(0, 500) + '...\n');

  // 11. Print gap summary
  console.log('🔴 Top Content Gaps:');
  gapAnalysis.filter(g => g.gap_score > 0).slice(0, 6).forEach(g => {
    console.log(`  ${g.label}: ${g.target_pages} target vs ${g.competitor_pages} competitor pages (gap: ${g.gap_score})`);
  });

  console.log('\n✅ Clusters Target Covers Well:');
  gapAnalysis.filter(g => g.gap_score <= 0 && g.target_pages > 0).forEach(g => {
    console.log(`  ${g.label}: ${g.target_pages} pages`);
  });

  console.log('\n🎉 Done!');
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
