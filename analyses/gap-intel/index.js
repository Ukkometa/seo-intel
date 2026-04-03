/**
 * Gap Intel — Topic/Content Gap Analysis
 *
 * Reads crawled pages for target + competitors from DB,
 * extracts topic clusters via local LLM, compares coverage,
 * and outputs a prioritised gap report.
 *
 * Zero network — reads from SQLite + Ollama only.
 */

import { getProjectDomains, getTargetDomains, getCompetitorDomains } from '../../exports/queries.js';

// ── Page type URL patterns ───────────────────────────────────────────────────

const PAGE_TYPE_PATTERNS = {
  docs: ['/docs/', '/guide', '/api/', '/reference', '/quickstart', '/tutorial', '/learn'],
  blog: ['/blog/', '/post/', '/article/', '/news/'],
  landing: ['/pricing', '/features', '/product', '/solutions', '/use-case', '/compare'],
};

function matchesPageType(url, type) {
  if (!type || type === 'all') return true;
  const patterns = PAGE_TYPE_PATTERNS[type];
  if (!patterns) return true;
  const lower = url.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

// ── Load pages from DB ───────────────────────────────────────────────────────

function loadPages(db, project, opts = {}) {
  const { type = 'all', limit = 100, vsDomains = [] } = opts;

  const domains = getProjectDomains(db, project);
  const targetDomains = getTargetDomains(domains);
  const competitorDomains = vsDomains.length
    ? domains.filter(d => d.role === 'competitor' && vsDomains.some(v => d.domain.includes(v)))
    : getCompetitorDomains(domains);

  if (!targetDomains.length) return { target: [], competitors: new Map(), targetDomain: null, competitorDomainNames: [] };

  const loadForDomains = (domainRows) => {
    const allPages = [];
    for (const d of domainRows) {
      const pages = db.prepare(`
        SELECT p.url, p.title, p.meta_desc, p.body_text, p.word_count
        FROM pages p
        WHERE p.domain_id = ?
          AND p.status_code = 200
          AND p.body_text IS NOT NULL AND p.body_text != ''
        ORDER BY p.word_count DESC
        LIMIT ?
      `).all(d.id, limit);
      allPages.push(...pages.filter(p => matchesPageType(p.url, type)).map(p => ({ ...p, domain: d.domain })));
    }
    return allPages;
  };

  const targetPages = loadForDomains(targetDomains);
  const compPages = new Map();
  for (const d of competitorDomains) {
    const pages = loadForDomains([d]);
    if (pages.length) compPages.set(d.domain, pages);
  }

  return {
    target: targetPages,
    competitors: compPages,
    targetDomain: targetDomains[0]?.domain,
    competitorDomainNames: competitorDomains.map(d => d.domain),
  };
}

// ── Extract topics from pages (LLM) ─────────────────────────────────────────

async function extractTopics(pages, domain, ollamaUrl, ollamaModel, log) {
  const batchSize = 25;
  const allTopics = new Set();

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const listing = batch.map((p, idx) => {
      const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
      return `${idx + 1}. ${p.title || path}\n   ${p.meta_desc || '(no description)'}`;
    }).join('\n');

    const prompt = `Given these ${batch.length} pages from ${domain}:\n\n${listing}\n\nExtract the main topics and capabilities this site covers.\nReturn ONLY a flat list of specific topic labels, one per line.\nBe specific: "RPC rate limits" not just "rate limits".\n"WebSocket subscription guide" not just "WebSockets".\nNo numbering, no bullets, no explanations — just topic labels.`;

    try {
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt,
          stream: false,
          options: { temperature: 0.2, num_ctx: 8192 },
        }),
      });

      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = await res.json();
      const lines = (data.response || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      for (const line of lines) {
        // Strip bullets, numbers, etc.
        const clean = line.replace(/^[-*•\d.)\s]+/, '').trim();
        if (clean.length > 2 && clean.length < 120) allTopics.add(clean);
      }
      log(`  ${domain}: batch ${Math.floor(i / batchSize) + 1} → ${lines.length} topics`);
    } catch (e) {
      log(`  ⚠️ ${domain} batch ${Math.floor(i / batchSize) + 1} failed: ${e.message}`);
    }
  }

  return [...allTopics];
}

// ── Compare topic coverage ───────────────────────────────────────────────────

function compareTopics(targetTopics, competitorTopicsMap) {
  const targetSet = new Set(targetTopics.map(t => t.toLowerCase()));

  const gaps = []; // topics competitors have, target doesn't
  const depthGaps = []; // topics target has but competitors go deeper

  for (const [domain, topics] of competitorTopicsMap) {
    for (const topic of topics) {
      const lower = topic.toLowerCase();
      // Fuzzy match — check if target covers this topic (substring match)
      const covered = [...targetSet].some(t =>
        t.includes(lower) || lower.includes(t) ||
        (lower.split(' ').length > 1 && t.split(' ').some(w => lower.includes(w) && w.length > 4))
      );

      if (!covered) {
        const existing = gaps.find(g => g.topic.toLowerCase() === lower);
        if (existing) {
          if (!existing.coveredBy.includes(domain)) existing.coveredBy.push(domain);
        } else {
          gaps.push({ topic, coveredBy: [domain] });
        }
      }
    }
  }

  return { gaps, depthGaps };
}

// ── LLM gap prioritisation ──────────────────────────────────────────────────

async function prioritiseGaps(gaps, targetDomain, context, ollamaUrl, ollamaModel, log) {
  if (!gaps.length) return [];

  const gapList = gaps.slice(0, 40).map(g =>
    `- ${g.topic} (covered by: ${g.coveredBy.join(', ')})`
  ).join('\n');

  const prompt = `Target site: ${targetDomain} (${context || 'business website'})
Topics competitors cover that the target project lacks:

${gapList}

For each gap, return a markdown table row with these columns:
| Topic | Covered by | Buyer Intent | Page Type | Why It Matters |

Buyer Intent: high, medium, or low
Page Type: guide, reference, landing, blog, or comparison
Why It Matters: one sentence on SEO or sales impact

Return ONLY the markdown table rows (no header, no explanation).
Sort by buyer intent (high first).`;

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = await res.json();
    return (data.response || '').split('\n').filter(l => l.trim().startsWith('|'));
  } catch (e) {
    log(`  ⚠️ LLM prioritisation failed: ${e.message}`);
    return null; // Fall back to raw output
  }
}

// ── Generate report ─────────────────────────────────────────────────────────

function generateReport(data) {
  const { targetDomain, competitorDomainNames, targetTopics, competitorTopicsMap, gaps, prioritisedRows, pageData } = data;
  const ts = new Date().toISOString().slice(0, 10);

  let md = `# Gap Intel Report — ${targetDomain} vs ${competitorDomainNames.join(', ')}\n`;
  md += `Generated: ${ts} | Pages analyzed: ${targetDomain}(${pageData.target.length})`;
  for (const [dom, pages] of pageData.competitors) {
    md += ` ${dom}(${pages.length})`;
  }
  md += '\n\n';

  // Prioritised gaps
  if (prioritisedRows && prioritisedRows.length) {
    const high = prioritisedRows.filter(r => r.toLowerCase().includes('high'));
    const medium = prioritisedRows.filter(r => r.toLowerCase().includes('medium'));
    const low = prioritisedRows.filter(r => !r.toLowerCase().includes('high') && !r.toLowerCase().includes('medium'));

    if (high.length) {
      md += `## 🔴 High Priority Gaps\n\n`;
      md += `| Topic | Covered by | Buyer Intent | Page Type | Why It Matters |\n`;
      md += `|-------|-----------|--------------|-----------|----------------|\n`;
      md += high.join('\n') + '\n\n';
    }
    if (medium.length) {
      md += `## 🟡 Medium Priority Gaps\n\n`;
      md += `| Topic | Covered by | Buyer Intent | Page Type | Why It Matters |\n`;
      md += `|-------|-----------|--------------|-----------|----------------|\n`;
      md += medium.join('\n') + '\n\n';
    }
    if (low.length) {
      md += `## 🟢 Lower Priority Gaps\n\n`;
      md += `| Topic | Covered by | Buyer Intent | Page Type | Why It Matters |\n`;
      md += `|-------|-----------|--------------|-----------|----------------|\n`;
      md += low.join('\n') + '\n\n';
    }
  } else {
    // Raw gaps (LLM failed or --raw mode)
    if (gaps.length) {
      md += `## Content Gaps\n\n`;
      md += `| Topic | Covered by |\n`;
      md += `|-------|-----------|\n`;
      for (const g of gaps) {
        md += `| ${g.topic} | ${g.coveredBy.join(', ')} |\n`;
      }
      md += '\n';
    } else {
      md += `> No significant gaps found — target covers all competitor topics.\n\n`;
    }
  }

  // Raw topic matrix
  md += `## Raw Topic Matrix\n\n`;
  md += `### ${targetDomain} (${targetTopics.length} topics)\n`;
  for (const t of targetTopics.slice(0, 50)) md += `- ${t}\n`;
  if (targetTopics.length > 50) md += `- ... and ${targetTopics.length - 50} more\n`;
  md += '\n';

  for (const [dom, topics] of competitorTopicsMap) {
    md += `### ${dom} (${topics.length} topics)\n`;
    for (const t of topics.slice(0, 50)) md += `- ${t}\n`;
    if (topics.length > 50) md += `- ... and ${topics.length - 50} more\n`;
    md += '\n';
  }

  return md;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run gap-intel analysis.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} config - project config with context
 * @param {object} opts
 * @param {string[]} [opts.vs] - competitor domains to compare (default: all from config)
 * @param {string} [opts.type] - page type filter: docs, blog, landing, all
 * @param {number} [opts.limit] - max pages per domain
 * @param {boolean} [opts.raw] - skip LLM prioritisation
 * @param {string} [opts.ollamaUrl] - Ollama host
 * @param {string} [opts.ollamaModel] - Ollama model
 * @param {function} [opts.log] - logger function
 * @returns {Promise<string>} markdown report
 */
export async function runGapIntel(db, project, config, opts = {}) {
  const log = opts.log || console.log;
  const ollamaUrl = opts.ollamaUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
  const ollamaModel = opts.ollamaModel || process.env.OLLAMA_MODEL || 'gemma4:e4b';
  const type = opts.type || 'all';
  const limit = opts.limit || 100;
  const raw = opts.raw || false;
  const vsDomains = opts.vs || [];

  log('  Loading pages from DB...');
  const pageData = loadPages(db, project, { type, limit, vsDomains });

  if (!pageData.target.length) {
    return `# Gap Intel — ${project}\n\n> ⚠️ No pages with body_text found for target.\n> Run: seo-intel crawl ${project}\n`;
  }

  if (!pageData.competitors.size) {
    return `# Gap Intel — ${project}\n\n> ⚠️ No competitor pages found in DB.\n> Check project config competitors and run: seo-intel crawl ${project}\n`;
  }

  log(`  Target: ${pageData.targetDomain} (${pageData.target.length} pages)`);
  for (const [dom, pages] of pageData.competitors) {
    log(`  Competitor: ${dom} (${pages.length} pages)`);
  }

  // Step 2 — Extract topics
  log('\n  Extracting topics via LLM...');
  const targetTopics = await extractTopics(pageData.target, pageData.targetDomain, ollamaUrl, ollamaModel, log);

  const competitorTopicsMap = new Map();
  for (const [dom, pages] of pageData.competitors) {
    const topics = await extractTopics(pages, dom, ollamaUrl, ollamaModel, log);
    competitorTopicsMap.set(dom, topics);
  }

  // Step 3 — Compare coverage
  log('\n  Comparing topic coverage...');
  const { gaps } = compareTopics(targetTopics, competitorTopicsMap);
  log(`  Found ${gaps.length} topic gaps`);

  // Step 4 — LLM prioritisation (unless --raw)
  let prioritisedRows = null;
  if (!raw && gaps.length) {
    log('\n  Prioritising gaps via LLM...');
    const context = config?.context?.industry || config?.context?.goal || '';
    prioritisedRows = await prioritiseGaps(gaps, pageData.targetDomain, context, ollamaUrl, ollamaModel, log);
  }

  // Step 5 — Generate report
  return generateReport({
    targetDomain: pageData.targetDomain,
    competitorDomainNames: [...pageData.competitors.keys()],
    targetTopics,
    competitorTopicsMap,
    gaps,
    prioritisedRows,
    pageData,
  });
}
