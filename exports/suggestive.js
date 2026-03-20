import { collectTop, makeAction, sortActions } from './heuristics.js';
import { getEntityCoverage, getHeadingClusterDataset, getPagePatternDataset, getSchemaCoverage } from './queries.js';

function getUrlPath(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

function classifyPath(pathname) {
  const path = pathname.toLowerCase();
  if (path === '/' || !path) return 'homepage';
  if (/docs|documentation|api|reference/.test(path)) return 'docs';
  if (/pricing|security|status|sla|compliance|trust|rate-limit/.test(path)) return 'trust';
  if (/dashboard|studio|app|console|portal/.test(path)) return 'dashboards';
  if (/compare|alternative|vs-/.test(path)) return 'comparison';
  if (/guide|tutorial|how-to|learn|academy/.test(path)) return 'tutorials';
  if (/product|products|platform|solutions|use-cases|features/.test(path)) return 'product-pages';
  if (/onboarding|get-started|quickstart|start-here|sign-up|signup/.test(path)) return 'onboarding';
  return 'other';
}

function normalizeHeadingTopic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(what|why|how|when|where|best|your|with|for|the|and|from|into|using|guide|tutorial|overview|introduction)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEntitySets(rows) {
  const target = new Set();
  const competitors = new Map();
  for (const row of rows) {
    let values = [];
    try { values = JSON.parse(row.primary_entities || '[]'); } catch { values = []; }
    for (const entity of values) {
      const key = String(entity || '').trim();
      if (!key) continue;
      if (row.role === 'competitor') {
        if (!competitors.has(key)) competitors.set(key, new Set());
        competitors.get(key).add(row.domain);
      } else {
        target.add(key);
      }
    }
  }
  return { target, competitors };
}

export function buildSuggestiveActions(db, project, options = {}) {
  const { vsDomain = null, scope = 'all' } = options;
  const actions = [];
  const pages = getPagePatternDataset(db, project, vsDomain);
  const headings = getHeadingClusterDataset(db, project, vsDomain);
  const schemas = getSchemaCoverage(db, project, vsDomain);
  const entities = buildEntitySets(getEntityCoverage(db, project, vsDomain));

  const targetCategories = new Set();
  const competitorCategories = new Map();
  const targetPaths = new Set();

  for (const page of pages) {
    const path = getUrlPath(page.url);
    const category = classifyPath(path);
    if (page.role === 'competitor') {
      if (!competitorCategories.has(category)) competitorCategories.set(category, []);
      competitorCategories.get(category).push(page);
    } else {
      targetCategories.add(category);
      targetPaths.add(path.toLowerCase());
    }
  }

  const categoryScopeMap = {
    docs: new Set(['docs', 'tutorials']),
    'product-pages': new Set(['product-pages', 'comparison', 'trust']),
    dashboards: new Set(['dashboards']),
    onboarding: new Set(['onboarding', 'trust']),
    all: null,
  };
  const allowedCategories = categoryScopeMap[scope] || null;

  for (const [category, compPages] of competitorCategories.entries()) {
    if (category === 'homepage' || category === 'other') continue;
    if (allowedCategories && !allowedCategories.has(category)) continue;
    if (targetCategories.has(category)) continue;

    const samplePaths = compPages.slice(0, 4).map(p => `${p.domain}${getUrlPath(p.url)}`);
    const titleMap = {
      docs: 'Create documentation/reference pages competitors already use',
      trust: 'Publish trust pages competitors rely on for conversion',
      comparison: 'Launch competitor comparison pages',
      tutorials: 'Build tutorial and guide content clusters',
      'product-pages': 'Add dedicated product or solution landing pages',
      dashboards: 'Expose dashboards/console entry pages to capture tool intent',
      onboarding: 'Create onboarding and quickstart paths',
    };

    actions.push(makeAction({
      id: `suggestive-category-${category}`,
      type: 'new_page',
      priority: compPages.length >= 5 ? 'high' : 'medium',
      area: 'structure',
      title: titleMap[category] || `Add ${category} page type coverage`,
      why: `Competitors have ${compPages.length} ${category} pages while the target domain set has none in this pattern.`,
      evidence: collectTop(samplePaths, 6),
      implementationHints: [
        'Start with the highest commercial-intent template competitors repeat most often.',
        'Link the new section from navigation, footer, and relevant hub pages so it becomes crawlable fast.',
      ],
    }));
  }

  const competitorTopics = new Map();
  const targetTopics = new Set();
  for (const row of headings) {
    const topic = normalizeHeadingTopic(row.text);
    if (!topic || topic.length < 10) continue;
    if (row.role === 'competitor') {
      if (!competitorTopics.has(topic)) competitorTopics.set(topic, { domains: new Set(), pages: [] });
      competitorTopics.get(topic).domains.add(row.domain);
      competitorTopics.get(topic).pages.push(`${row.domain}${getUrlPath(row.url)}`);
    } else {
      targetTopics.add(topic);
    }
  }

  for (const [topic, info] of [...competitorTopics.entries()].sort((a, b) => b[1].domains.size - a[1].domains.size).slice(0, 10)) {
    if (targetTopics.has(topic)) continue;
    actions.push(makeAction({
      id: `suggestive-topic-${topic.replace(/[^a-z0-9]+/g, '-')}`,
      type: 'new_page',
      priority: info.domains.size >= 3 ? 'high' : 'medium',
      area: 'content',
      title: `Cover missing topic cluster: ${topic}`,
      why: 'Competitors repeatedly organize content around this heading cluster and the target site does not.',
      evidence: collectTop([
        `Competitors: ${[...info.domains].join(', ')}`,
        ...info.pages.slice(0, 4),
      ], 5),
      implementationHints: [
        'Turn this topic into a guide, docs page, or landing page depending on user intent.',
        'Reuse the subtopics competitors surface in H2/H3 structure, but add stronger proof and differentiation.',
      ],
    }));
  }

  for (const [entity, domains] of [...entities.competitors.entries()].filter(([entity]) => !entities.target.has(entity)).sort((a, b) => b[1].size - a[1].size).slice(0, 6)) {
    actions.push(makeAction({
      id: `suggestive-entity-${entity.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      type: 'improve',
      priority: domains.size >= 3 ? 'high' : 'medium',
      area: 'content',
      title: `Add use-case coverage around entity: ${entity}`,
      why: 'Competitor pages keep referencing this entity, which suggests buyer or developer demand the target has not served yet.',
      evidence: collectTop([
        `Competitors mentioning it: ${[...domains].join(', ')}`,
      ], 4),
      implementationHints: [
        'Decide whether this belongs in docs, a comparison page, a feature page, or a tutorial.',
        'Add concrete examples, code snippets, or workflows tied to the entity.',
      ],
    }));
  }

  const targetSchemaTypes = new Set(schemas.filter(s => s.role !== 'competitor').map(s => s.schema_type));
  const missingSchemaTypes = new Map();
  for (const row of schemas.filter(s => s.role === 'competitor')) {
    if (targetSchemaTypes.has(row.schema_type)) continue;
    if (!missingSchemaTypes.has(row.schema_type)) missingSchemaTypes.set(row.schema_type, new Set());
    missingSchemaTypes.get(row.schema_type).add(row.domain);
  }

  for (const [schemaType, domains] of [...missingSchemaTypes.entries()].slice(0, 5)) {
    actions.push(makeAction({
      id: `suggestive-schema-${schemaType.toLowerCase()}`,
      type: 'add_schema',
      priority: domains.size >= 2 ? 'medium' : 'low',
      area: 'schema',
      title: `Plan content/templates that support ${schemaType} schema`,
      why: 'Competitors use this schema type on pages or features the target site likely has not built yet.',
      evidence: collectTop([
        `Competitors using it: ${[...domains].join(', ')}`,
      ], 3),
      implementationHints: [
        `Identify which future page template should emit ${schemaType} schema.`,
        'Design the page structure so the schema fields are naturally supported in the content model.',
      ],
    }));
  }

  const targetAvgWords = average(pages.filter(p => p.role !== 'competitor').map(p => p.word_count || 0));
  const competitorInvestments = new Map();
  for (const page of pages.filter(p => p.role === 'competitor')) {
    const category = classifyPath(getUrlPath(page.url));
    if (!competitorInvestments.has(category)) competitorInvestments.set(category, []);
    competitorInvestments.get(category).push(page.word_count || 0);
  }

  for (const [category, words] of competitorInvestments.entries()) {
    if (allowedCategories && !allowedCategories.has(category)) continue;
    const avg = average(words);
    if (avg < 300 || avg <= targetAvgWords * 1.5) continue;
    actions.push(makeAction({
      id: `suggestive-depth-${category}`,
      type: 'improve',
      priority: avg > 1200 ? 'high' : 'medium',
      area: 'content',
      title: `Invest in deeper ${category} content`,
      why: `Competitors average ${Math.round(avg)} words on ${category} pages versus about ${Math.round(targetAvgWords || 0)} words across the target domain set.`,
      evidence: collectTop(pages.filter(p => p.role === 'competitor' && classifyPath(getUrlPath(p.url)) === category).slice(0, 4).map(p => `${p.domain}${getUrlPath(p.url)} (${p.word_count || 0} words)`), 4),
      implementationHints: [
        'Add examples, implementation details, FAQs, trust proof, and comparisons instead of pure feature fluff.',
        'Prioritize page types that map to high-intent keywords or repeated competitor templates.',
      ],
    }));
  }

  return sortActions(actions);
}

function average(values) {
  const filtered = values.filter(v => Number.isFinite(v) && v > 0);
  if (!filtered.length) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}
