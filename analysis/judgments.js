/**
 * analysis/judgments.js — the narrow model calls that replace the mega-prompt.
 *
 * analysis/prompt-builder.js asked one model to do seven things in one
 * answer: count keyword gaps, invent long tails, cluster content gaps, find
 * quick wins, propose pages, audit schema, and write positioning — over the
 * whole keyword matrix, in a single JSON document with no schema enforced.
 * That prompt failed in a way that was hard to see and impossible to fix by
 * rewording. Asked to classify sixty keywords and also to write strategy, the
 * model classified forty and wrote strategy. Asked for covered_by domains it
 * had not been shown, it supplied some. Asked for JSON, it sometimes wrapped
 * it in prose, and the regex that fished the object out took whichever
 * braces it found first. None of that is a bad model; it is one call carrying
 * seven tasks' worth of instructions, of which the last few always lose.
 *
 * So each judgment here is one task with a closed schema, given only the
 * data it needs, and told four things every time — one task, this data only,
 * no invented domains or URLs, JSON only. The counting that used to share the
 * prompt is done first by analysis/deterministic.js; the model receives the
 * results as facts to label, not rows to count, and where an item echoes an
 * input key (keyword, key_term) the prompt says to copy it exactly so the
 * caller can merge the deterministic fields back by that key without fuzzy
 * matching.
 *
 * Output item shapes are the ones prompt-builder produced, because every
 * consumer — exports/competitive.js, lib/scan-export.js,
 * reports/generate-html.js, analyses/blog-draft, db/db.js _insightFingerprint
 * — reads those fields. A judgment may add fields; it never renames one.
 *
 * Schemas follow the convention every structured-output provider accepts:
 * a JSON Schema draft-07 subset with an object at the root, every object
 * closed (additionalProperties: false) and listing every property in
 * required, enums for closed vocabularies, arrays with items, no $ref, no
 * recursion, and no min/max/length keywords in the schema itself. Where a
 * judgment has a size rule (at most 8 pages, 20-30 phrases) it lives in the
 * separate `limits` object — a map from a dotted property path to
 * { minItems, maxItems, maxLength }, with array indices left out, so
 * "items" is the array itself and "items.placement" is the placement list of
 * every item (the convention lib/schema-check.js validate() resolves) — for
 * the client to enforce, because the providers disagree on which of those
 * keywords they honour. A path the validator cannot resolve is silently
 * never checked, which is why the tests walk every path against its schema.
 *
 * runJudgment is the one entry point. It builds the two prompt halves,
 * hands them to a callModel-shaped function (lib/providers.js by default,
 * injected in tests), unwraps whatever the provider returned into the
 * output object, and stamps provenance — judgment name, prompt version,
 * provider, model, attempts, elapsed — so the Ledger can say which
 * instructions produced a row. Batching is the caller's job; runJudgment
 * only refuses a batch larger than the judgment allows, because a provider
 * silently truncating item forty-one is exactly the failure this file exists
 * to end.
 *
 * JUDGMENT_VERSION is stamped on every row these prompts produce
 * (insights.prompt_version). BUMP IT WHENEVER ANY PROMPT TEXT HERE CHANGES,
 * for the reason prompt-builder gives: two runs of the same prompt
 * disagreeing is the model; two runs of different prompts disagreeing is us.
 */

export const JUDGMENT_VERSION = '2026-09-26.1';

// ── Vocabularies (shared with prompt-builder's output schema) ───────────────

const INTENTS = ['informational', 'commercial', 'navigational', 'transactional'];
const LEVELS = ['high', 'medium', 'low'];
const DIFFICULTIES = ['low', 'medium', 'high'];
const ACTIONS = ['add_to_existing', 'new_page'];
const CONTENT_FORMATS = ['blog', 'comparison', 'use_case', 'glossary', 'how_to', 'landing'];
const PAGE_TYPES = ['blog', 'landing', 'doc', 'faq', 'comparison', 'glossary'];
const PROPERTIES = ['main', 'blog', 'docs'];
const FUNNEL_STAGES = ['awareness', 'consideration', 'decision'];
const KEYWORD_TYPES = ['traditional', 'perplexity', 'agent'];

// ── Schema helpers ──────────────────────────────────────────────────────────

const str = () => ({ type: 'string' });
const nullableStr = () => ({ type: ['string', 'null'] });
const int = () => ({ type: 'integer' });
const oneOf = values => ({ type: 'string', enum: values });
const strList = () => ({ type: 'array', items: str() });
const list = items => ({ type: 'array', items });

/** A closed object: every property required, nothing else allowed. */
function obj(properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

// ── The rules every prompt repeats ──────────────────────────────────────────

/**
 * Stated in the system half and again at the end of each task prompt. The
 * repetition is deliberate: the mega-prompt stated its rules once, at the
 * top, two thousand tokens before the output schema, and they did not hold.
 */
export const DISCIPLINE = Object.freeze([
  'One task per call: do only what this prompt asks, nothing more.',
  'Use only the data in this prompt. Never invent a domain, URL, page, competitor, keyword or metric that is not given here.',
  'Respond with a single JSON object matching the schema exactly: no prose before or after it, no markdown fences, no comments.',
]);

const bullets = lines => lines.map(l => `- ${l}`).join('\n');
const json = value => JSON.stringify(value ?? null, null, 1);

/**
 * The project context block. Tolerates a missing or partial context: a
 * project set up without one still gets a usable prompt.
 */
function contextBlock(context) {
  const c = context || {};
  const lines = [];
  if (c.siteName || c.url) lines.push(`Site: ${[c.siteName, c.url ? `(${c.url})` : null].filter(Boolean).join(' ')}`);
  if (c.industry) lines.push(`Industry: ${c.industry}`);
  if (c.audience) lines.push(`Audience: ${c.audience}`);
  if (c.goal) lines.push(`Business goal: ${c.goal}`);
  if (c.maturity) lines.push(`SEO maturity: ${c.maturity}`);
  return lines.length ? lines.join('\n') : '(no project context configured)';
}

function systemFor(role, context) {
  return [
    `You are ${role}. You work from crawl and Search Console data supplied in the prompt and from nothing else.`,
    '',
    'Rules:',
    bullets(DISCIPLINE),
    '',
    'Project context:',
    contextBlock(context),
  ].join('\n');
}

const closing = () => ['', 'Rules, again:', bullets(DISCIPLINE)].join('\n');

/**
 * Publishing properties, when the project configured them (site_architecture
 * in config/<project>.json). Without them a placement can only be the main
 * property, and the prompt says so rather than letting the model invent a
 * blog subdomain.
 */
function propertiesBlock(context) {
  const arch = context?.site_architecture;
  if (!arch?.properties?.length) {
    return 'Publishing properties: none configured. Use property "main" with a path starting with "/" for every placement, and rank only that one.';
  }
  const lines = arch.properties.map(p =>
    `- ${p.id} (${p.url}${p.platform ? `, ${p.platform}` : ''}): best for ${p.best_for || 'unspecified'}; difficulty ${p.difficulty || 'unspecified'}${p.seo_note ? `; note: ${p.seo_note}` : ''}`);
  return [
    `Publishing properties (rank ALL of them per page, 1 = best fit; use only these ids and URLs):`,
    arch.note ? arch.note : null,
    ...lines,
  ].filter(Boolean).join('\n');
}

const urlList = urls => (urls?.length ? bullets(urls) : '- (no target pages crawled)');

// ── The judgments ───────────────────────────────────────────────────────────

const keywordGaps = {
  name: 'keyword_gaps',
  version: JUDGMENT_VERSION,
  effort: 'medium',
  maxTokens: 6000,
  batchSize: 40,
  batchField: 'gaps',
  buildSystem: context => systemFor('an SEO analyst classifying keyword gaps', context),
  /**
   * @param {{ gaps: { keyword: string, competitor_count: number, covered_by: string[] }[], target_pages: string[], context?: object }} input
   */
  buildPrompt({ gaps = [], target_pages = [] } = {}) {
    const n = gaps.length;
    return [
      `Task: classify the ${n} keyword gap(s) below. Each is a keyword that appears on competitor sites and nowhere on the target site; competitor_count and covered_by are measured from the crawl and are facts, not estimates.`,
      '',
      'For this task:',
      bullets([
        `Classify ONLY the ${n} keyword(s) listed. Return exactly ${n} items, one per keyword, with "keyword" copied character for character. Never add a keyword, never drop one, never merge or rephrase one.`,
        'intent: the search intent behind the keyword as a query.',
        'difficulty: low when one or two competitors cover it and it is specific; high when every competitor covers it or it is a broad head term; medium otherwise.',
        'suggested_action: add_to_existing when one of the target pages listed could carry the keyword; new_page when none can.',
        'suggested_page: for add_to_existing, one of the target pages below, copied exactly. For new_page, a proposed path starting with "/" on the target site. Never any other URL.',
        'priority: weigh commercial value against difficulty; a specific commercial phrase several competitors cover is high.',
        'rationale: one sentence grounded in the data given.',
      ]),
      '',
      'Target pages (the only existing URLs you may name):',
      urlList(target_pages.slice(0, 60)),
      '',
      'Keyword gaps:',
      json(gaps.map(g => ({ keyword: g.keyword, competitor_count: g.competitor_count, covered_by: g.covered_by }))),
      closing(),
    ].join('\n');
  },
  schema: obj({
    items: list(obj({
      keyword: str(),
      intent: oneOf(INTENTS),
      difficulty: oneOf(DIFFICULTIES),
      suggested_action: oneOf(ACTIONS),
      suggested_page: str(),
      priority: oneOf(LEVELS),
      rationale: str(),
    })),
  }),
  limits: { items: { maxItems: 40 } },
};

const contentGaps = {
  name: 'content_gaps',
  version: JUDGMENT_VERSION,
  effort: 'medium',
  maxTokens: 4000,
  buildSystem: context => systemFor('an SEO content strategist naming topic gaps', context),
  /**
   * @param {{ clusters: { key_term: string, sample_headings: string[], covered_by: string[], heading_count: number }[], context?: object }} input
   */
  buildPrompt({ clusters = [] } = {}) {
    const n = clusters.length;
    return [
      `Task: name and qualify the ${n} content gap cluster(s) below. Each cluster is a group of competitor H1/H2 headings whose subject the target site's headings do not cover; key_term, sample_headings, covered_by and heading_count come from the crawl and are facts.`,
      '',
      'For this task:',
      bullets([
        `Return exactly ${n} items, one per cluster, in the order given, with "key_term" copied character for character so the caller can match them. Never add a cluster or drop one.`,
        'topic: name the cluster in two to five words, as a reader would say it, based on the sample headings.',
        'covered_by: the cluster\'s covered_by list, copied as given. Never a domain that is not in it.',
        'format: the content format that would close the gap for this audience.',
        'why_it_matters: one or two sentences on what the target loses by not covering it, grounded in the headings shown.',
        'suggested_title: a working title for the piece.',
      ]),
      '',
      'Clusters:',
      json(clusters.map(c => ({
        key_term: c.key_term,
        sample_headings: (c.sample_headings || []).slice(0, 5),
        covered_by: c.covered_by,
        heading_count: c.heading_count,
      }))),
      closing(),
    ].join('\n');
  },
  schema: obj({
    items: list(obj({
      key_term: str(),
      topic: str(),
      covered_by: strList(),
      format: oneOf(CONTENT_FORMATS),
      why_it_matters: str(),
      suggested_title: str(),
    })),
  }),
};

const placementSchema = list(obj({
  rank: int(),
  property: oneOf(PROPERTIES),
  url: str(),
  reason: str(),
}));

const newPages = {
  name: 'new_pages',
  version: JUDGMENT_VERSION,
  effort: 'medium',
  maxTokens: 4000,
  buildSystem: context => systemFor('an SEO strategist proposing pages to create', context),
  /**
   * @param {{ content_gaps: object[], long_tails: object[], target_pages: string[], context?: object }} input
   */
  buildPrompt({ content_gaps = [], long_tails = [], target_pages = [], context } = {}) {
    return [
      'Task: propose the new pages the target site should create, from the content gaps and long-tail phrases below and nothing else.',
      '',
      'For this task:',
      bullets([
        'Propose at most 8 pages, best opportunity first. Fewer is fine; eight is the ceiling.',
        'target_keyword: a phrase taken from a long tail below or from a gap\'s topic or headings. Never a phrase that appears in neither.',
        'Do not propose a page that duplicates one of the existing target pages listed; those already exist.',
        'why: one or two sentences citing the gap or phrase that motivates the page.',
        'placement: rank the publishing properties for this page, one entry per property, rank starting at 1. url is the full URL or path the page would live at on that property.',
      ]),
      '',
      propertiesBlock(context),
      '',
      'Existing target pages (do not duplicate):',
      urlList(target_pages.slice(0, 60)),
      '',
      'Content gaps:',
      json(content_gaps.map(g => ({
        topic: g.topic,
        format: g.format,
        why_it_matters: g.why_it_matters,
        suggested_title: g.suggested_title,
        covered_by: g.covered_by,
      }))),
      '',
      'Long-tail phrases:',
      json(long_tails.slice(0, 15).map(t => ({
        phrase: t.phrase,
        intent: t.intent ?? null,
        page_type: t.page_type ?? null,
        priority: t.priority,
        source: t.source ?? 'model',
      }))),
      closing(),
    ].join('\n');
  },
  schema: obj({
    items: list(obj({
      title: str(),
      target_keyword: str(),
      content_angle: str(),
      why: str(),
      priority: oneOf(LEVELS),
      placement: placementSchema,
    })),
  }),
  limits: { items: { maxItems: 8 }, 'items.placement': { maxItems: 3 } },
};

const longTailsFallback = {
  name: 'long_tails_fallback',
  version: JUDGMENT_VERSION,
  effort: 'medium',
  maxTokens: 4000,
  buildSystem: context => systemFor('an SEO analyst proposing long-tail phrases to research', context),
  /**
   * Used only when the Ledger holds no gsc_long_tail rows: Search Console
   * measures what the site is shown for, and a model can only guess at it.
   * The prompt says so, and every item says so in its notes, so a reader
   * never mistakes an invented phrase for a measured one.
   *
   * @param {{ seed_keywords: (string | { keyword: string })[], context?: object }} input
   */
  buildPrompt({ seed_keywords = [] } = {}) {
    const seeds = seed_keywords.slice(0, 40).map(s => (typeof s === 'string' ? s : s?.keyword)).filter(Boolean);
    return [
      'Task: propose long-tail search phrases for the target site to research.',
      '',
      'No Search Console data exists for this site, so nothing here is measured: every phrase you return is MODEL-INVENTED, a hypothesis to check against real demand, not a finding. Say so.',
      '',
      'For this task:',
      bullets([
        'Return between 20 and 30 phrases of three to six words each, built from the seed keywords below and the project context. Question forms (how to, what is), comparison forms (X vs Y) and feature or use-case forms are all welcome.',
        'Weight toward commercial intent, and toward phrases specific enough that a single page could own them.',
        'page_type: the page that would answer the phrase.',
        'notes: begin every notes value with "model-invented:" and then say in one sentence why the phrase fits this site.',
        'Do not include a phrase that names a competitor or a domain.',
      ]),
      '',
      'Seed keywords (from the crawl):',
      seeds.length ? bullets(seeds) : '- (no seed keywords; use the project context alone)',
      closing(),
    ].join('\n');
  },
  schema: obj({
    items: list(obj({
      phrase: str(),
      intent: oneOf(INTENTS),
      page_type: oneOf(PAGE_TYPES),
      priority: oneOf(LEVELS),
      notes: str(),
    })),
  }),
  limits: { items: { minItems: 20, maxItems: 30 } },
};

const positioning = {
  name: 'positioning',
  version: JUDGMENT_VERSION,
  effort: 'high',
  maxTokens: 1500,
  buildSystem: context => systemFor('a positioning strategist reading crawl summaries', context),
  /**
   * @param {{ target_summary: object, competitor_summaries: object[], context?: object }} input
   */
  buildPrompt({ target_summary = {}, competitor_summaries = [] } = {}) {
    const hasCompetitors = Array.isArray(competitor_summaries) && competitor_summaries.length > 0;
    const summaryOf = s => ({
      domain: s.domain,
      pages_crawled: s.page_count ?? s.pageCount ?? 0,
      avg_word_count: Math.round(Number(s.avg_word_count) || 0),
      product_types: s.product_types ?? null,
      pricing_tiers: s.pricing_tiers ?? null,
      primary_ctas: s.ctas ?? null,
    });
    return [
      'Task: describe the market position the target site should own, from the crawl summaries below.',
      '',
      'For this task:',
      bullets([
        'market_context: two or three sentences on the landscape as the data shows it, in the industry named in the project context.',
        'open_angle: the positioning no site in the data owns yet, that the target could.',
        'target_differentiator: the target\'s clearest differentiator, from its own product types, pricing and calls to action as crawled.',
        hasCompetitors
          ? 'competitor_map: two or three sentences on how each competitor below positions itself, naming only the domains listed.'
          : 'competitor_map: null. There is NO competitor data in this prompt. Do not name, guess at or imply any competitor; base open_angle on the target\'s own content and the industry in the project context, and say that it rests on industry knowledge rather than measured competitors.',
      ]),
      '',
      'Target summary:',
      json(summaryOf(target_summary)),
      '',
      hasCompetitors
        ? `Competitor summaries (${competitor_summaries.length}):\n${json(competitor_summaries.map(summaryOf))}`
        : 'Competitor summaries: none. No competitor data was collected for this project.',
      closing(),
    ].join('\n');
  },
  schema: obj({
    market_context: str(),
    open_angle: str(),
    target_differentiator: str(),
    competitor_map: nullableStr(),
  }),
};

const keywordInventor = {
  name: 'keyword_inventor',
  version: JUDGMENT_VERSION,
  effort: 'medium',
  maxTokens: 12000,
  buildSystem: context => systemFor('an SEO strategist generating keyword opportunities', context),
  /**
   * The keywords command's task (cli.js), with the same three keyword types
   * and the same output, minus the freedom to invent domains.
   *
   * @param {{ target_domain: string, competitor_domains: string[], top_keywords: (string | { keyword: string, competitor_count?: number })[], count: number, intent_instruction: string, industry: string }} input
   */
  buildPrompt({ target_domain = '', competitor_domains = [], top_keywords = [], count = 120, intent_instruction = '', industry = '' } = {}) {
    const signals = (top_keywords || []).slice(0, 60).map(k => (typeof k === 'string'
      ? k
      : `${k.keyword}${k.competitor_count != null ? ` (${k.competitor_count} competitors)` : ''}`));
    const total = Number(count) || 120;
    return [
      `Task: generate keyword opportunities for ${target_domain} organised into clusters.`,
      '',
      `Target site: ${target_domain}`,
      `Competitors: ${competitor_domains.length ? competitor_domains.join(', ') : '(none configured — do not name any)'}`,
      `Industry context: ${industry || `the industry of ${target_domain}`}`,
      '',
      'Competitor keyword signals (crawled data):',
      signals.length ? bullets(signals) : '- (no crawl data yet — use the industry context alone)',
      '',
      `Generate exactly ${total} keyword phrases organised into clusters. ${intent_instruction || 'Include a mix of informational, commercial, transactional and navigational intents.'}`,
      '',
      'Three keyword types to generate:',
      bullets([
        'traditional — how people search Google (3-5 words, keyword-style).',
        'perplexity — how people ask Perplexity or ChatGPT (complete, question-style).',
        'agent — how an AI agent researches on behalf of a person (technical, complete, spec-like queries with requirements and constraints). LLMs cite structured, factual content, so these are the phrases that earn citations.',
      ]),
      `Distribute the ${total} phrases roughly as 40% traditional, 35% perplexity, 25% agent.`,
      '',
      'For this task:',
      bullets([
        'Every phrase must be relevant to the target site and the signals above; never name a competitor domain inside a phrase.',
        `notes: one sentence on why the phrase is a good target for ${target_domain}.`,
        'quick_targets: five phrases from the clusters the site could rank for soonest.',
        'agent_queries: full questions an AI agent would ask to find this product.',
        `summary: two or three sentences on the keyword opportunity for ${target_domain}.`,
      ]),
      closing(),
    ].join('\n');
  },
  schema: obj({
    keyword_clusters: list(obj({
      topic: str(),
      funnel_stage: oneOf(FUNNEL_STAGES),
      competition: oneOf(DIFFICULTIES),
      keywords: list(obj({
        phrase: str(),
        type: oneOf(KEYWORD_TYPES),
        intent: oneOf(INTENTS),
        priority: oneOf(LEVELS),
        notes: str(),
      })),
    })),
    quick_targets: strList(),
    agent_queries: strList(),
    summary: str(),
  }),
};

export const JUDGMENTS = Object.freeze({
  keyword_gaps: keywordGaps,
  content_gaps: contentGaps,
  new_pages: newPages,
  long_tails_fallback: longTailsFallback,
  positioning,
  keyword_inventor: keywordInventor,
});

// ── Running one ─────────────────────────────────────────────────────────────

/**
 * The first JSON object in a string, for a provider (or a fake) that answers
 * with text. A fenced block is unwrapped first so its braces are not mistaken
 * for the object's.
 */
function parseJsonText(text) {
  const s = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch { /* fall through to the brace scan */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('model answer holds no JSON object');
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * The output object out of whatever the call returned: a string, an
 * envelope with the parsed output under `output` (or `json`, `data`), a text
 * envelope, or the bare object.
 */
function unwrapOutput(result) {
  if (result == null) throw new Error('model call returned nothing');
  if (typeof result === 'string') return parseJsonText(result);
  if (typeof result !== 'object') throw new Error(`model call returned a ${typeof result}`);
  for (const key of ['output', 'json', 'data']) {
    if (key in result) return typeof result[key] === 'string' ? parseJsonText(result[key]) : result[key];
  }
  for (const key of ['text', 'content']) {
    if (typeof result[key] === 'string') return parseJsonText(result[key]);
  }
  return result;
}

/**
 * The root of the answer against the judgment's schema: an object, with
 * every required key present and every array-typed key an array. Not a full
 * schema check — lib/schema-check.js does that with the limits — but enough
 * that a caller reading output.items never reads undefined.
 */
function checkRoot(judgment, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`${judgment.name}: model answer is not a JSON object`);
  }
  const { properties = {}, required = [] } = judgment.schema || {};
  const missing = required.filter(k => !(k in output));
  if (missing.length) throw new Error(`${judgment.name}: model answer is missing ${missing.join(', ')}`);
  for (const [key, spec] of Object.entries(properties)) {
    if (spec.type === 'array' && !Array.isArray(output[key])) {
      throw new Error(`${judgment.name}: model answer's ${key} is not an array`);
    }
  }
}

/**
 * Run one judgment over one input.
 *
 * `call` is a callModel-shaped function: it receives one request object
 * { name, system, prompt, schema, limits, effort, maxTokens, provider, model }
 * and resolves to the parsed output, or to an envelope carrying it under
 * `output` along with provider / model / attempts / ms when it knows them.
 * lib/providers.js callModel is the default, imported lazily so a test with
 * a fake never loads a provider module.
 *
 * Batching is the caller's job. A judgment with batchSize refuses a larger
 * batch outright: the whole point of the split is that item forty-one is
 * never silently dropped.
 *
 * @returns {Promise<{ output: object, provenance: { name: string, prompt_version: string, provider: string|null, model: string|null, attempts: number, ms: number } }>}
 */
export async function runJudgment(judgment, input, { call, provider, model, log } = {}) {
  if (!judgment?.name || typeof judgment.buildPrompt !== 'function' || typeof judgment.buildSystem !== 'function') {
    throw new TypeError('runJudgment: judgment must be an entry of JUDGMENTS');
  }
  const data = input || {};

  if (judgment.batchSize) {
    const field = judgment.batchField || 'gaps';
    const batch = data[field];
    if (Array.isArray(batch) && batch.length > judgment.batchSize) {
      throw new RangeError(
        `${judgment.name}: ${batch.length} ${field} exceed the batch size of ${judgment.batchSize}; split the input before calling runJudgment`,
      );
    }
  }

  const callFn = call || (await import('../lib/providers.js')).callModel;
  if (typeof callFn !== 'function') throw new TypeError('runJudgment: no callable model function');

  const system = judgment.buildSystem(data.context);
  const prompt = judgment.buildPrompt(data);
  const started = Date.now();
  log?.(`[judgment] ${judgment.name} ${judgment.version} → ${provider || 'default provider'}${model ? ` (${model})` : ''}`);

  const result = await callFn({
    name: judgment.name,
    system,
    prompt,
    schema: judgment.schema,
    limits: judgment.limits || null,
    effort: judgment.effort,
    maxTokens: judgment.maxTokens,
    provider,
    model,
  });

  const output = unwrapOutput(result);
  checkRoot(judgment, output);

  const envelope = result && typeof result === 'object' && result !== output ? result : {};
  return {
    output,
    provenance: {
      name: judgment.name,
      prompt_version: judgment.version,
      provider: envelope.provider ?? provider ?? null,
      model: envelope.model ?? model ?? null,
      attempts: Number.isInteger(envelope.attempts) && envelope.attempts > 0 ? envelope.attempts : 1,
      ms: Number.isFinite(envelope.ms) ? envelope.ms : Date.now() - started,
    },
  };
}
