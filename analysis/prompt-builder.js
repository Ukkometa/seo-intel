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
  const isSolo = !competitors || competitors.length === 0;
  return isSolo
    ? buildSoloPrompt({ target, keywordMatrix, headingStructure, context })
    : buildCompetitivePrompt({ target, competitors, keywordMatrix, headingStructure, context });
}

// ── Solo audit prompt (no competitors) ─────────────────────────────────────

function buildSoloPrompt({ target, keywordMatrix, headingStructure, context }) {
  return `
# SEO Site Audit — ${context.siteName}

You are an expert SEO strategist performing a solo site audit. You have ONLY the crawled site data below — no competitor data.

**CRITICAL RULES:**
- You have ZERO competitor data. Do NOT invent, hallucinate, or reference any competitor domains.
- Never fill "covered_by" with domain names you were not given.
- Base keyword and content recommendations on: (1) the crawled site data, (2) your knowledge of the "${context.industry}" industry and what audiences search for.
- Label all industry-knowledge suggestions as "industry research" — not "data-driven".
- Every URL slug you suggest must be a real path (e.g. "/blog/how-to-x"), never "/undefined".

---

## CONTEXT

**Site:** ${context.siteName} (${context.url})
**Industry:** ${context.industry}
**Target audience:** ${context.audience}
**Business goal:** ${context.goal}
**Current SEO maturity:** ${context.maturity || 'early stage'}

### Site Architecture
${context.site_architecture ? `
${context.site_architecture.note}

Available publishing properties:
${context.site_architecture.properties.map(p =>
  `- **${p.id}** (${p.url}, platform: ${p.platform})\n  Best for: ${p.best_for}\n  Difficulty: ${p.difficulty}${p.seo_note ? `\n  SEO note: ${p.seo_note}` : ''}`
).join('\n')}
` : 'No site architecture configured — recommend generic URL slugs.'}

---

## SITE DATA

${formatSiteSummary(target)}

### Pages crawled: ${target.page_count || target.pageCount || 0}
### Keyword coverage:
${formatKeywordTable(keywordMatrix, target.domain)}

### Heading structure:
${formatHeadings(headingStructure, target.domain)}

---

## ANALYSIS TASKS

### 1. KEYWORD OPPORTUNITIES
- Based on the site's existing content and the "${context.industry}" industry, identify 5-10 keyword phrases the site should target
- For each: search intent, estimated search demand (low/medium/high), difficulty, and whether to add to an existing page or create a new one
- Focus on keywords that match the site's actual product/service — no speculative gaps

### 2. LONG-TAIL OPPORTUNITIES
- Generate 10-20 specific long-tail phrases (3-6 words) from the site's content themes
- Focus on: question queries, feature queries, use-case queries
- For each: intent, page type, priority
- Weight toward commercial intent

### 3. CONTENT EXPANSION
- Topic areas the site should cover based on industry norms and audience needs
- Do NOT reference competitor domains — use "industry standard" or "common in ${context.industry}" instead
- For each: why it matters for this audience, suggested format, suggested title

### 4. QUICK WINS (existing pages to improve)
- Pages with thin content, missing structure, or weak metadata
- Only reference pages that appear in the crawled data above
- For each: specific fix, estimated impact

### 5. NEW PAGE SUGGESTIONS
- Specific new pages to create based on keyword opportunities
- For each: URL slug (real path like /blog/topic), title, target keyword, content angle

### 6. TECHNICAL SEO AUDIT
- Schema markup opportunities (FAQ, HowTo, Product, etc.)
- Meta description quality assessment
- H1/heading structure recommendations
- Do NOT compare to competitors — assess against SEO best practices

### 7. MARKET POSITIONING
- Based on the site's content and industry, what positioning should this site own?
- What audience need is underserved in this space?
- What is the site's clearest differentiator from its current content?

---

## OUTPUT SCHEMA

Respond ONLY with valid JSON in this exact structure:

{
  "keyword_gaps": [
    {
      "keyword": "string — 2-4 word SEO phrase",
      "intent": "informational|commercial|navigational|transactional",
      "search_demand": "low|medium|high",
      "difficulty": "low|medium|high",
      "suggested_action": "add_to_existing|new_page",
      "suggested_page": "string — URL path like /blog/topic or existing page URL",
      "priority": "high|medium|low",
      "source": "site_content|industry_research"
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
      "why_it_matters": "string",
      "format": "blog|comparison|use_case|glossary|how_to|landing",
      "suggested_title": "string"
    }
  ],
  "quick_wins": [
    {
      "page": "string — URL from crawled data",
      "issue": "string",
      "fix": "string",
      "impact": "high|medium|low"
    }
  ],
  "new_pages": [
    {
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
      "fix": "string"
    }
  ],
  "positioning": {
    "market_context": "string — 2-3 sentences on the industry landscape",
    "open_angle": "string — what positioning this site should own",
    "target_differentiator": "string — clearest differentiator from current content"
  }
}
`.trim();
}

// ── Competitive prompt (with competitors) ──────────────────────────────────

function buildCompetitivePrompt({ target, competitors, keywordMatrix, headingStructure, context }) {
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

### Site Architecture
${context.site_architecture ? `
${context.site_architecture.note}

Available publishing properties (use these when recommending where to place content):
${context.site_architecture.properties.map(p =>
  `- **${p.id}** (${p.url}, platform: ${p.platform})\n  Best for: ${p.best_for}\n  Difficulty: ${p.difficulty}${p.seo_note ? `\n  SEO note: ${p.seo_note}` : ''}`
).join('\n')}

For each content recommendation, rank ALL available properties as placement options (1st = best fit, 2nd = acceptable, 3rd = fallback). Consider: SEO impact, publishing difficulty, content type fit, and the subdomain authority caveat above.
` : 'No site architecture configured — recommend generic URL slugs.'}

---

## TARGET SITE DATA

${formatSiteSummary(target)}

### Pages crawled: ${target.page_count || target.pageCount || 0}
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
      "keyword": "string — 2-4 word SEO keyword phrase (NOT single words, e.g. 'solana rpc provider', 'blockchain data api')",
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
      "notes": "string",
      "placement": [
        { "rank": 1, "property": "main|blog|docs", "url": "string — full suggested URL or path", "reason": "string" },
        { "rank": 2, "property": "main|blog|docs", "url": "string", "reason": "string" },
        { "rank": 3, "property": "main|blog|docs", "url": "string", "reason": "string" }
      ]
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
      "title": "string",
      "target_keyword": "string",
      "content_angle": "string",
      "why": "string",
      "priority": "high|medium|low",
      "placement": [
        { "rank": 1, "property": "main|blog|docs", "url": "string — full suggested URL e.g. blog.carbium.io/helius-alternative", "reason": "string — why this is the best fit" },
        { "rank": 2, "property": "main|blog|docs", "url": "string", "reason": "string" },
        { "rank": 3, "property": "main|blog|docs", "url": "string", "reason": "string" }
      ]
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
- Pages crawled: ${site.page_count || site.pageCount || 0}
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
