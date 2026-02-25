/**
 * Analysis Prompt Builder
 *
 * Builds the structured prompt for the cloud model (Gemini).
 * This is the core intelligence layer — the better the input structure,
 * the better the keyword gaps, long-tails, and recommendations.
 *
 * Design principles:
 * 1. Feed STRUCTURED data, not raw text — model reasons better over tables
 * 2. Separate target vs competitors clearly
 * 3. Ask for specific, actionable outputs with defined formats
 * 4. Include context about the industry / audience
 * 5. Request prioritization (not just lists, but ranked by impact)
 */

/**
 * Build the full analysis prompt for Gemini.
 *
 * @param {object} params
 * @param {string} params.project     - 'carbium' | 'ukkometa'
 * @param {object} params.target      - target site summary
 * @param {object[]} params.competitors - competitor summaries
 * @param {object} params.keywordMatrix - keyword coverage by domain
 * @param {object[]} params.headingStructure - heading patterns
 * @param {object} params.context     - project context (industry, audience, goals)
 */
export function buildAnalysisPrompt({ project, target, competitors, keywordMatrix, headingStructure, context }) {
  return `
# SEO Competitive Intelligence Analysis — ${context.siteName}

You are an expert SEO strategist analyzing competitive data to produce actionable recommendations.
Respond in structured JSON matching the output schema at the end of this prompt.

---

## CONTEXT

**Site:** ${context.siteName} (${context.url})
**Industry:** ${context.industry}
**Target audience:** ${context.audience}
**Business goal:** ${context.goal}
**Current SEO maturity:** ${context.maturity || 'early stage'}

---

## TARGET SITE DATA

${formatSiteSummary(target)}

### Pages crawled: ${target.pageCount}
### Keyword coverage:
${formatKeywordTable(keywordMatrix, target.domain)}

### Heading structure patterns:
${formatHeadings(headingStructure, target.domain)}

---

## COMPETITOR DATA

${competitors.map((c, i) => `
### Competitor ${i + 1}: ${c.domain} (${c.role})
${formatSiteSummary(c)}

Keyword coverage:
${formatKeywordTable(keywordMatrix, c.domain)}

Top headings:
${formatHeadings(headingStructure, c.domain)}
`).join('\n---\n')}

---

## KEYWORD GAP MATRIX

The following shows which keywords appear on competitor sites but NOT on the target site.
Format: keyword → how many competitor sites cover it → estimated intent

${formatKeywordGapMatrix(keywordMatrix, target.domain, competitors.map(c => c.domain))}

---

## ANALYSIS TASKS

Perform ALL of the following analyses. Be specific, data-driven, and prioritize by impact.

### 1. KEYWORD GAPS (highest priority)
- Keywords competitors rank for across 2+ sites that the target does NOT cover at all
- For each: estimate search intent (informational/commercial/navigational/transactional)
- Estimate difficulty: low/medium/high based on how many sites already cover it
- Suggest which existing page to add it to, OR if a new page is needed

### 2. LONG-TAIL OPPORTUNITIES
- Generate 25-40 specific long-tail keyword phrases (3-6 words) relevant to the target's product
- Use the competitor keyword patterns as a seed
- Focus on: question queries (how to, what is, why), comparison queries (X vs Y), feature queries
- For each: intent, suggested page type (blog/landing/doc/faq), priority (high/medium/low)
- Weight toward commercial intent and low competition

### 3. CONTENT GAPS (topic clusters missing)
- Entire topic areas competitors cover that the target has no pages about
- For each gap: what competitors cover it, why it matters, suggested content format
- Include: blog posts, comparison pages, use case pages, glossary terms, how-to guides

### 4. QUICK WINS (existing pages to improve)
- Target's existing pages that are thin (low word count, missing keywords competitors use)
- Pages missing H2/H3 structure vs competitors
- Pages with weak meta descriptions vs competitors
- For each: specific fix, estimated impact

### 5. NEW PAGE SUGGESTIONS
- Specific new pages to create, ranked by SEO opportunity
- For each: suggested URL slug, title, target keyword, content angle, why competitors win here

### 6. TECHNICAL SEO GAPS
- Schema markup types competitors use that target doesn't (FAQ, HowTo, Product, etc.)
- Meta description quality vs competitors
- H1/heading strategy differences

### 7. POSITIONING ANALYSIS
- How do competitors position themselves vs each other?
- What positioning angle is NOT yet owned by any competitor? (gap for target to own)
- What is the target's clearest differentiator based on their current content?

---

## OUTPUT SCHEMA

Respond ONLY with valid JSON in this exact structure:

{
  "keyword_gaps": [
    {
      "keyword": "string",
      "intent": "informational|commercial|navigational|transactional",
      "competitor_count": number,
      "difficulty": "low|medium|high",
      "suggested_action": "add_to_existing|new_page",
      "suggested_page": "string — URL slug or existing page path",
      "priority": "high|medium|low"
    }
  ],
  "long_tails": [
    {
      "phrase": "string",
      "intent": "string",
      "page_type": "blog|landing|doc|faq|comparison|glossary",
      "priority": "high|medium|low",
      "notes": "string"
    }
  ],
  "content_gaps": [
    {
      "topic": "string",
      "covered_by": ["domain1", "domain2"],
      "format": "blog|comparison|use_case|glossary|how_to|landing",
      "why_it_matters": "string",
      "suggested_title": "string"
    }
  ],
  "quick_wins": [
    {
      "page": "string — URL",
      "issue": "string",
      "fix": "string",
      "impact": "high|medium|low"
    }
  ],
  "new_pages": [
    {
      "slug": "string",
      "title": "string",
      "target_keyword": "string",
      "content_angle": "string",
      "why": "string",
      "priority": "high|medium|low"
    }
  ],
  "technical_gaps": [
    {
      "gap": "string",
      "competitors_with_it": ["domain1"],
      "fix": "string"
    }
  ],
  "positioning": {
    "competitor_map": "string — 2-3 sentences on how each competitor positions",
    "open_angle": "string — what positioning gap exists",
    "target_differentiator": "string — what target should own"
  }
}
`.trim();
}

// --- Formatters ---

function formatSiteSummary(site) {
  return `
- Domain: ${site.domain}
- Pages crawled: ${site.pageCount || 0}
- Avg word count: ${Math.round(site.avg_word_count || 0)}
- Product types detected: ${site.product_types || 'unknown'}
- Pricing model: ${site.pricing_tiers || 'unknown'}
- Primary CTAs: ${site.ctas || 'unknown'}
`.trim();
}

function formatKeywordTable(matrix, domain) {
  const rows = matrix
    .filter(r => r.domain === domain)
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 30);
  if (!rows.length) return '(no data)';
  return rows.map(r => `  ${r.keyword} [${r.location}] ×${r.freq}`).join('\n');
}

function formatHeadings(headings, domain) {
  const rows = headings
    .filter(h => h.domain === domain && h.level <= 2)
    .slice(0, 20);
  if (!rows.length) return '(no data)';
  return rows.map(h => `  ${'#'.repeat(h.level)} ${h.text}`).join('\n');
}

function formatKeywordGapMatrix(matrix, targetDomain, competitorDomains) {
  // Keywords on competitors but not on target
  const competitorKeywords = new Map();
  for (const row of matrix) {
    if (!competitorDomains.includes(row.domain)) continue;
    const key = row.keyword;
    if (!competitorKeywords.has(key)) competitorKeywords.set(key, new Set());
    competitorKeywords.get(key).add(row.domain);
  }

  const targetKeywords = new Set(
    matrix.filter(r => r.domain === targetDomain).map(r => r.keyword)
  );

  const gaps = [];
  for (const [kw, domains] of competitorKeywords.entries()) {
    if (!targetKeywords.has(kw)) {
      gaps.push({ keyword: kw, count: domains.size, domains: [...domains] });
    }
  }

  gaps.sort((a, b) => b.count - a.count);

  return gaps.slice(0, 60)
    .map(g => `  "${g.keyword}" — ${g.count} competitor(s): ${g.domains.join(', ')}`)
    .join('\n') || '(no gaps detected — more crawl data needed)';
}
