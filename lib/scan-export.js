/**
 * Scan Export — Deterministic markdown builder for the `scan` command.
 * Mirrors the dashboardToMarkdown logic from server.js but works standalone.
 */

function inferLongTailParent(phrase, keywordGaps) {
  const lower = phrase.toLowerCase();
  let best = null, bestScore = 0;
  for (const g of (keywordGaps || [])) {
    const kw = (g.keyword || '').toLowerCase();
    if (!kw || kw.length < 3) continue;
    const words = kw.split(/\s+/);
    const score = words.filter(w => lower.includes(w)).length / words.length;
    if (score > bestScore && score >= 0.5) { bestScore = score; best = g.keyword; }
  }
  return best;
}

function inferLongTailOpportunity(item) {
  const p = (item.phrase || '').toLowerCase();
  const intent = item.intent || '';
  const pageType = item.page_type || '';
  if (p.startsWith('how to ') || p.includes(' tutorial')) return `How-to ${pageType || 'guide'} — ${intent || 'informational'} intent`;
  if (p.includes(' vs ') || p.includes(' comparison')) return `Comparison ${pageType || 'article'} — captures decision-stage traffic`;
  if (p.includes('best ') || p.includes('top ')) return `Listicle / roundup — high commercial intent`;
  if (p.includes('what is ') || p.includes('explained')) return `Explainer ${pageType || 'page'} — top-of-funnel awareness`;
  if (p.includes(' api ') || p.includes(' sdk ')) return `Technical docs ${pageType || 'page'} — developer intent`;
  if (p.includes(' price') || p.includes(' cost') || p.includes(' pricing')) return `Pricing / comparison page — transactional intent`;
  if (intent) return `${pageType || 'Content'} page — ${intent} intent`;
  return pageType ? `${pageType} page` : '';
}

function inferPotential(item) {
  const p = (item.priority || '').toLowerCase();
  if (p === 'high' || p === 'critical') return 'High';
  if (p === 'medium') return 'Medium';
  if (p === 'low') return 'Low';
  const phrase = (item.phrase || '').toLowerCase();
  if (phrase.startsWith('how') || phrase.includes(' vs ') || phrase.includes('best ')) return 'High';
  if (item.type === 'question' || item.type === 'comparison') return 'High';
  if (item.type === 'ai_query') return 'Medium';
  return 'Medium';
}

export function buildScanMarkdown(dash, projectSlug, domain) {
  const date = new Date().toISOString().slice(0, 10);
  const a = dash.latestAnalysis || {};
  const s = {};

  // Map dashboard data to sections
  const target = dash.technicalScores?.find(d => d.isTarget);
  if (target) {
    s.technical = { score: target.score, h1_coverage: target.h1Pct + '%', meta_coverage: target.metaPct + '%', schema_coverage: target.schemaPct + '%', title_coverage: target.titlePct + '%' };
  }
  if (a.technical_gaps?.length) s.technical_gaps = a.technical_gaps;
  if (a.quick_wins?.length) s.quick_wins = a.quick_wins;
  if (a.keyword_gaps?.length) s.keyword_gaps = a.keyword_gaps;
  if (dash.keywordGaps?.length) s.top_keyword_gaps = dash.keywordGaps.slice(0, 50);
  if (a.long_tails?.length) s.long_tails = a.long_tails;
  if (a.new_pages?.length) s.new_pages = a.new_pages;
  if (a.content_gaps?.length) s.content_gaps = a.content_gaps;
  if (a.positioning) s.positioning = a.positioning;
  if (a.keyword_inventor?.length) s.keyword_inventor = a.keyword_inventor;
  if (dash.internalLinks) {
    s.internal_links = { total_links: dash.internalLinks.totalLinks, orphan_pages: dash.internalLinks.orphanCount, top_pages: dash.internalLinks.topPages };
  }
  if (dash.crawlStats) s.crawl_stats = dash.crawlStats;

  // Build markdown
  let md = `# SEO Scan Report — ${domain}\n\n- Date: ${date}\n- Mode: One-shot audit (no competitors)\n\n`;

  if (s.technical) {
    md += `## Technical Scorecard\n\n`;
    md += `- Overall: **${s.technical.score}/100**\n`;
    md += `- H1: ${s.technical.h1_coverage} | Meta: ${s.technical.meta_coverage} | Schema: ${s.technical.schema_coverage} | Title: ${s.technical.title_coverage}\n\n`;
  }

  if (s.technical_gaps?.length) {
    md += `## Technical Gaps (${s.technical_gaps.length})\n\n`;
    md += `> Implement these schema and markup fixes to qualify for rich results. Start with FAQ and HowTo schema.\n\n`;
    md += `| Issue | Affected | Fix |\n|-------|----------|-----|\n`;
    for (const g of s.technical_gaps) md += `| ${g.gap || g.issue || ''} | ${g.affected || g.pages || ''} | ${g.recommendation || g.fix || ''} |\n`;
    md += '\n';
  }

  if (s.quick_wins?.length) {
    const highCount = s.quick_wins.filter(w => w.impact === 'high').length;
    md += `## Quick Wins (${s.quick_wins.length})\n\n`;
    md += `> **${highCount} high-impact items.** Pick the top 3 and implement this week — each takes <30 min.\n\n`;
    md += `| Page | Issue | Fix | Impact |\n|------|-------|-----|--------|\n`;
    for (const w of s.quick_wins) md += `| ${w.page || ''} | ${w.issue || ''} | ${w.fix || ''} | ${w.impact || ''} |\n`;
    md += '\n';
  }

  if (s.internal_links) {
    md += `## Internal Links\n\n- Total links: ${s.internal_links.total_links}\n- Orphan pages: ${s.internal_links.orphan_pages}\n`;
    if (s.internal_links.top_pages?.length) {
      md += '\n| Page | Depth Score |\n|------|-------------|\n';
      for (const p of s.internal_links.top_pages) md += `| ${p.url || p.label} | ${p.count} |\n`;
    }
    md += '\n';
  }

  if (s.keyword_gaps?.length) {
    // Solo mode: show search demand + source; competitive mode: show competitor coverage
    const hasCoverage = s.keyword_gaps.some(g => g.competitor_count != null);
    md += `## Keyword ${hasCoverage ? 'Gaps' : 'Opportunities'} (${s.keyword_gaps.length})\n\n`;
    if (hasCoverage) {
      const highCount = s.keyword_gaps.filter(g => (g.competitor_count || 0) >= 4).length;
      md += `> **${highCount} high-priority gaps** (competitor coverage >= 4). Focus on gaps that match existing product features.\n\n`;
      md += `| Keyword | Your Coverage | Competitor Coverage |\n|---------|--------------|--------------------||\n`;
      for (const g of s.keyword_gaps) md += `| ${g.keyword || ''} | ${g.your_coverage || 'none'} | ${g.competitor_count || ''} |\n`;
    } else {
      md += `> Keywords identified from site content and industry research.\n\n`;
      md += `| Keyword | Search Demand | Source | Priority |\n|---------|---------------|--------|----------|\n`;
      for (const g of s.keyword_gaps) md += `| ${g.keyword || ''} | ${g.search_demand || 'medium'} | ${g.source || 'industry research'} | ${g.priority || ''} |\n`;
    }
    md += '\n';
  }

  if (s.top_keyword_gaps?.length) {
    md += `## Top Keyword Gaps\n\n`;
    md += `| Keyword | Frequency | Your Count | Gap |\n|---------|-----------|------------|-----|\n`;
    for (const g of s.top_keyword_gaps) {
      const freq = g.total || g.competitor_count || '';
      const tgt = g.target || 0;
      const gap = freq ? (Number(freq) - Number(tgt)) || freq : '';
      md += `| ${g.keyword || ''} | ${freq} | ${tgt} | ${gap} |\n`;
    }
    md += '\n';
  }

  if (s.long_tails?.length) {
    md += `## Long-tail Opportunities (${s.long_tails.length})\n\n`;
    md += `> Lower competition, higher conversion. Each maps to a parent cluster and content type.\n\n`;
    md += `| Phrase | Parent | Opportunity |\n|-------|--------|-------------|\n`;
    for (const l of s.long_tails) {
      const parent = l.parent || l.keyword || inferLongTailParent(l.phrase, s.keyword_gaps) || '';
      const opportunity = l.opportunity || l.rationale || inferLongTailOpportunity(l) || '';
      md += `| ${l.phrase || ''} | ${parent} | ${opportunity} |\n`;
    }
    md += '\n';
  }

  if (s.new_pages?.length) {
    md += `## New Pages to Create (${s.new_pages.length})\n\n`;
    md += `> Each targets a keyword gap. Create with proper H1, schema, and internal links.\n\n`;
    md += `| Title | Target Keyword | Rationale |\n|-------|----------------|----------|\n`;
    for (const p of s.new_pages) {
      md += `| ${p.title || ''} | ${p.target_keyword || ''} | ${p.rationale || p.why || p.content_angle || ''} |\n`;
    }
    md += '\n';
  }

  if (s.content_gaps?.length) {
    const hasCoveredBy = s.content_gaps.some(g => g.covered_by?.length);
    md += `## ${hasCoveredBy ? 'Content Gaps' : 'Content Expansion'} (${s.content_gaps.length})\n\n`;
    md += `> ${hasCoveredBy ? 'Topics your competitors cover that you don\'t. Prioritise gaps where multiple competitors have content.' : 'Topics you should cover based on industry norms and audience needs.'}\n\n`;
    md += `| Topic | ${hasCoveredBy ? 'Gap' : 'Why It Matters'} | Suggestion |\n|-------|${hasCoveredBy ? '-----|' : '----------------|'}------------|\n`;
    for (const g of s.content_gaps) {
      const gap = hasCoveredBy
        ? (g.gap || (g.covered_by?.length ? `Covered by ${g.covered_by.join(', ')}` : '') || g.why_it_matters || '')
        : (g.why_it_matters || g.gap || '');
      const suggestion = g.suggestion || g.suggested_title || (g.format ? `Create a ${g.format} covering this topic` : '') || '';
      md += `| ${g.topic || ''} | ${gap} | ${suggestion} |\n`;
    }
    md += '\n';
  }

  if (s.keyword_inventor?.length) {
    md += `## Keyword Ideas (${s.keyword_inventor.length})\n\n`;
    md += `| Phrase | Cluster | Potential |\n|-------|---------|----------|\n`;
    for (const k of s.keyword_inventor.slice(0, 50)) {
      md += `| ${k.phrase || ''} | ${k.cluster || ''} | ${k.potential || k.volume || inferPotential(k) || ''} |\n`;
    }
    if (s.keyword_inventor.length > 50) md += `\n_...and ${s.keyword_inventor.length - 50} more._\n`;
    md += '\n';
  }

  if (s.positioning) {
    md += `## Positioning Strategy\n\n`;
    if (s.positioning.open_angle) md += `**Open angle:** ${s.positioning.open_angle}\n\n`;
    if (s.positioning.target_differentiator) md += `**Differentiator:** ${s.positioning.target_differentiator}\n\n`;
    if (s.positioning.competitor_map) md += `**Competitor map:** ${s.positioning.competitor_map}\n\n`;
    if (s.positioning.market_context) md += `**Market context:** ${s.positioning.market_context}\n\n`;
  }

  if (s.crawl_stats) {
    md += `## Crawl Info\n\n- Last crawl: ${s.crawl_stats.lastCrawl || date}\n- Extracted pages: ${s.crawl_stats.extractedPages || 0}\n`;
  }

  return md;
}
