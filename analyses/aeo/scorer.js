/**
 * AEO Citability Scorer — pure function, zero I/O
 *
 * Scores a page for how well an AI assistant could cite it as a source.
 * All inputs are plain objects from the DB; output is a score breakdown.
 */

// ── Question patterns in headings ──────────────────────────────────────────
const QUESTION_RE = /^(what|how|why|when|where|which|who|can|does|is|are|should|do)\b/i;
const COMPARISON_RE = /\bvs\.?\b|\bversus\b|\bcompare[d]?\b|\bcomparison\b|\balternative/i;
const IMPL_RE = /\bhow to\b|\bstep[- ]by[- ]step\b|\btutorial\b|\bguide\b|\bsetup\b|\binstall/i;

// ── Freshness scoring ──────────────────────────────────────────────────────
function freshnessScore(page, schemas) {
  // Best signal: dateModified in schema
  const schemaDate = schemas.find(s => s.date_modified)?.date_modified
    || schemas.find(s => s.date_published)?.date_published;
  const pageDate = page.modified_date || page.published_date;
  const dateStr = schemaDate || pageDate;

  if (!dateStr) return 0;

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;

  const ageMs = Date.now() - d.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 90) return 100;   // < 3 months
  if (ageDays < 180) return 80;   // < 6 months
  if (ageDays < 365) return 60;   // < 1 year
  if (ageDays < 730) return 30;   // < 2 years
  return 10;                       // 2+ years
}

// ── Entity authority ───────────────────────────────────────────────────────
function entityAuthorityScore(entities, headings, wordCount) {
  if (!entities.length) return 0;

  let score = 0;

  // More entities = deeper coverage
  if (entities.length >= 5) score += 30;
  else if (entities.length >= 3) score += 20;
  else score += 10;

  // Entities appearing in headings = stronger authority signal
  const headingTexts = headings.map(h => h.text.toLowerCase());
  const entityInHeading = entities.filter(e =>
    headingTexts.some(ht => ht.includes(e.toLowerCase()))
  ).length;

  score += Math.min(entityInHeading * 15, 40);

  // Word count indicates depth of coverage
  if (wordCount >= 2000) score += 30;
  else if (wordCount >= 1000) score += 20;
  else if (wordCount >= 500) score += 10;

  return Math.min(score, 100);
}

// ── Structured claims ──────────────────────────────────────────────────────
function structuredClaimsScore(bodyText, headings) {
  if (!bodyText) return 0;

  let score = 0;
  const sentences = bodyText.split(/[.!?]+/).filter(s => s.trim().length > 20);
  if (!sentences.length) return 0;

  // "X is Y" definitional patterns — highly citable
  const definitional = sentences.filter(s =>
    /\b(?:is|are|means|refers to|defined as|consists of)\b/i.test(s)
  ).length;
  score += Math.min((definitional / sentences.length) * 200, 40);

  // Numbered/bulleted patterns in body (listicle structure)
  const listPatterns = (bodyText.match(/(?:^|\n)\s*(?:\d+[.)]\s|[-•]\s)/gm) || []).length;
  if (listPatterns >= 5) score += 25;
  else if (listPatterns >= 3) score += 15;

  // Comparison patterns
  if (COMPARISON_RE.test(bodyText)) score += 15;

  // Step-by-step / how-to patterns
  if (IMPL_RE.test(bodyText)) score += 20;

  return Math.min(score, 100);
}

// ── Answer density ─────────────────────────────────────────────────────────
function answerDensityScore(bodyText, wordCount) {
  if (!bodyText || wordCount < 100) return 0;

  let score = 0;

  // Short paragraphs = more scannable = better for AI extraction
  const paragraphs = bodyText.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  if (!paragraphs.length) return 10;

  const avgParaLength = wordCount / paragraphs.length;
  if (avgParaLength <= 80) score += 30;      // concise
  else if (avgParaLength <= 150) score += 20; // moderate
  else score += 5;                            // wall of text

  // First 200 words contain a direct answer? (inverted pyramid)
  const first200 = bodyText.split(/\s+/).slice(0, 200).join(' ');
  if (/\b(?:is|are|means|provides?|offers?|enables?|allows?)\b/i.test(first200)) {
    score += 25;
  }

  // Ratio of informational content (not just navigation/boilerplate)
  if (wordCount >= 300 && wordCount <= 3000) score += 25;
  else if (wordCount > 3000) score += 15; // very long can dilute
  else score += 10; // too short to cite well

  // Code blocks are highly citable for technical content
  const codeBlocks = (bodyText.match(/```[\s\S]*?```|`[^`]+`/g) || []).length;
  if (codeBlocks >= 3) score += 20;
  else if (codeBlocks >= 1) score += 10;

  return Math.min(score, 100);
}

// ── Q&A proximity ──────────────────────────────────────────────────────────
function qaProximityScore(headings, bodyText, schemaTypes) {
  if (!headings.length || !bodyText) return 0;

  const questionHeadings = headings.filter(h =>
    h.level >= 2 && h.level <= 3 && QUESTION_RE.test(h.text)
  );

  if (!questionHeadings.length) return 10; // no Q&A structure at all

  let score = 0;

  // More question headings = better Q&A structure
  const qRatio = questionHeadings.length / headings.filter(h => h.level >= 2).length;
  score += Math.min(qRatio * 60, 40);

  // FAQ schema present? Huge bonus — only award if schema actually exists
  if (Array.isArray(schemaTypes) && schemaTypes.includes('FAQPage')) score += 30;

  // Heading density (one H2/H3 per ~300 words is ideal)
  const h2h3Count = headings.filter(h => h.level >= 2 && h.level <= 3).length;
  const words = bodyText.split(/\s+/).length;
  const idealHeadings = Math.floor(words / 300);
  const headingRatio = idealHeadings > 0 ? Math.min(h2h3Count / idealHeadings, 2) : 0;
  if (headingRatio >= 0.7 && headingRatio <= 1.5) score += 30;
  else if (headingRatio >= 0.4) score += 15;

  return Math.min(score, 100);
}

// ── Schema coverage ────────────────────────────────────────────────────────
function schemaCoverageScore(schemaTypes) {
  if (!schemaTypes.length) return 0;

  let score = 0;

  // High-value schema types for AI citation
  const highValue = ['FAQPage', 'HowTo', 'Article', 'TechArticle', 'BlogPosting'];
  const medValue = ['Product', 'Review', 'SoftwareApplication', 'WebApplication'];
  const baseValue = ['Organization', 'WebSite', 'WebPage', 'BreadcrumbList'];

  for (const t of schemaTypes) {
    if (highValue.includes(t)) score += 30;
    else if (medValue.includes(t)) score += 15;
    else if (baseValue.includes(t)) score += 5;
  }

  // Multiple schema types = richer structured data
  if (schemaTypes.length >= 3) score += 20;

  return Math.min(score, 100);
}

// ── AI Query Intent Classification ─────────────────────────────────────────
function classifyAiIntent(headings, bodyText, searchIntent) {
  const allText = [
    ...headings.map(h => h.text),
    (bodyText || '').slice(0, 2000)
  ].join(' ').toLowerCase();

  const intents = [];

  if (COMPARISON_RE.test(allText)) intents.push('synthesis');
  if (/\bshould\b|\brecommend|\bbest\b.*\bfor\b|\bchoose\b/i.test(allText)) intents.push('decision_support');
  if (IMPL_RE.test(allText)) intents.push('implementation');
  if (/\bwhat (is|are)\b|\boverview\b|\bintroduc/i.test(allText)) intents.push('exploration');
  if (/\bbest practice|\bshould you\b|\bis it worth/i.test(allText)) intents.push('validation');

  // Fallback from extraction intent
  if (!intents.length) {
    if (searchIntent === 'Informational') intents.push('exploration');
    else if (searchIntent === 'Commercial') intents.push('decision_support');
    else if (searchIntent === 'Transactional') intents.push('implementation');
    else intents.push('exploration');
  }

  return intents;
}

// ── Main scorer ────────────────────────────────────────────────────────────

/**
 * Score a single page for AI citability.
 *
 * @param {object} page - { url, title, body_text, word_count, published_date, modified_date }
 * @param {object[]} headings - [{ level, text }]
 * @param {string[]} entities - primary_entities array
 * @param {string[]} schemaTypes - schema type strings present on page
 * @param {object[]} schemas - full page_schemas rows
 * @param {string} searchIntent - from extraction
 * @returns {object} { score, breakdown, aiIntents, tier }
 */
export function scorePage(page, headings, entities, schemaTypes, schemas, searchIntent) {
  const bodyText = page.body_text || '';
  const wordCount = page.word_count || bodyText.split(/\s+/).length;

  const breakdown = {
    entity_authority:   entityAuthorityScore(entities, headings, wordCount),
    structured_claims:  structuredClaimsScore(bodyText, headings),
    answer_density:     answerDensityScore(bodyText, wordCount),
    qa_proximity:       qaProximityScore(headings, bodyText, schemaTypes),
    freshness:          freshnessScore(page, schemas),
    schema_coverage:    schemaCoverageScore(schemaTypes),
  };

  // Weighted composite — entity authority and structured claims matter most for AI
  const weights = {
    entity_authority:   0.25,
    structured_claims:  0.20,
    answer_density:     0.20,
    qa_proximity:       0.15,
    freshness:          0.10,
    schema_coverage:    0.10,
  };

  const score = Math.round(
    Object.entries(weights).reduce((sum, [k, w]) => sum + breakdown[k] * w, 0)
  );

  const aiIntents = classifyAiIntent(headings, bodyText, searchIntent);

  // Tier classification
  let tier;
  if (score >= 75) tier = 'excellent';
  else if (score >= 55) tier = 'good';
  else if (score >= 35) tier = 'needs_work';
  else tier = 'poor';

  return { score, breakdown, aiIntents, tier };
}
