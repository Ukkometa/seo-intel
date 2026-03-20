import { collectTop, makeAction, normalizeActionType, normalizePriority, sortActions } from './heuristics.js';
import { getEntityCoverage, getLatestAnalysis, getProjectDomains, getSchemaCoverage } from './queries.js';

function aggregateEntityCoverage(rows) {
  const target = new Set();
  const competitors = new Map();

  for (const row of rows) {
    const parsed = Array.isArray(row.primary_entities) ? row.primary_entities : (() => {
      try { return JSON.parse(row.primary_entities || '[]'); } catch { return []; }
    })();
    for (const entity of parsed) {
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

export function buildCompetitiveActions(db, project, options = {}) {
  const { vsDomain = null } = options;
  const analysis = getLatestAnalysis(db, project);
  const competitorDomains = getProjectDomains(db, project).filter(d => d.role === 'competitor' && (!vsDomain || d.domain === vsDomain));
  if (!competitorDomains.length) return [];

  const actions = [];

  if (analysis) {
    for (const gap of analysis.keyword_gaps || []) {
      actions.push(makeAction({
        id: `competitive-keyword-${String(gap.keyword || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        type: normalizeActionType(gap.suggested_action === 'new_page' ? 'new_page' : 'improve', 'new_page'),
        priority: normalizePriority(gap.priority, 'medium'),
        area: 'content',
        title: `Close keyword gap: ${gap.keyword}`,
        why: `${gap.keyword} is covered by ${gap.competitor_count || competitorDomains.length} competitor domains and maps to ${gap.intent || 'search'} intent demand.`,
        evidence: collectTop([
          gap.suggested_page ? `Suggested page: ${gap.suggested_page}` : null,
          gap.difficulty ? `Difficulty: ${gap.difficulty}` : null,
          gap.intent ? `Intent: ${gap.intent}` : null,
        ].filter(Boolean), 5),
        implementationHints: [
          gap.suggested_page ? `Create or upgrade ${gap.suggested_page} around the target query.` : 'Create a dedicated landing page for this query cluster.',
          'Benchmark the top competitor pages for headings, examples, proof, and schema coverage.',
        ],
      }));
    }

    for (const gap of analysis.content_gaps || []) {
      actions.push(makeAction({
        id: `competitive-content-${String(gap.topic || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        type: gap.format === 'comparison' || gap.format === 'landing' ? 'new_page' : 'improve',
        priority: 'high',
        area: 'content',
        title: `Cover topic gap: ${gap.topic}`,
        why: gap.why_it_matters || 'Competitors cover this topic and the target site currently does not.',
        evidence: collectTop([
          gap.suggested_title ? `Suggested title: ${gap.suggested_title}` : null,
          Array.isArray(gap.covered_by) && gap.covered_by.length ? `Covered by: ${gap.covered_by.join(', ')}` : null,
          gap.format ? `Format: ${gap.format}` : null,
        ].filter(Boolean), 5),
        implementationHints: [
          gap.suggested_title ? `Build the piece around: ${gap.suggested_title}` : 'Publish a dedicated piece for this topic.',
          'Include comparison tables, proof, examples, and intent-matched CTAs.',
        ],
      }));
    }

    for (const gap of analysis.technical_gaps || []) {
      actions.push(makeAction({
        id: `competitive-schema-${String(gap.gap || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        type: 'add_schema',
        priority: 'medium',
        area: 'schema',
        title: `Match competitor schema pattern: ${gap.gap}`,
        why: gap.fix || 'Competitors have richer structured data coverage on relevant templates.',
        evidence: collectTop([
          Array.isArray(gap.competitors_with_it) && gap.competitors_with_it.length ? `Used by: ${gap.competitors_with_it.join(', ')}` : null,
        ].filter(Boolean), 3),
        implementationHints: [
          gap.fix || 'Add the schema type to matching target templates.',
          'Validate rich result eligibility in Google Rich Results Test after rollout.',
        ],
      }));
    }
  }

  const schemaCoverage = getSchemaCoverage(db, project, vsDomain);
  const targetSchemaTypes = new Set(schemaCoverage.filter(r => r.role !== 'competitor').map(r => r.schema_type));
  const competitorSchemaMap = new Map();
  for (const row of schemaCoverage.filter(r => r.role === 'competitor')) {
    if (!competitorSchemaMap.has(row.schema_type)) competitorSchemaMap.set(row.schema_type, { domains: new Set(), pages: 0 });
    competitorSchemaMap.get(row.schema_type).domains.add(row.domain);
    competitorSchemaMap.get(row.schema_type).pages += row.page_count || 0;
  }

  for (const [schemaType, info] of competitorSchemaMap.entries()) {
    if (targetSchemaTypes.has(schemaType)) continue;
    actions.push(makeAction({
      id: `competitive-schema-coverage-${String(schemaType).toLowerCase()}`,
      type: 'add_schema',
      priority: info.domains.size >= 2 ? 'high' : 'medium',
      area: 'schema',
      title: `Add ${schemaType} schema where competitors already do`,
      why: 'Competitors are enriching equivalent pages with schema types the target site has not deployed.',
      evidence: collectTop([
        `Competitors using it: ${[...info.domains].join(', ')}`,
        `Competitor pages with this schema: ${info.pages}`,
      ], 5),
      implementationHints: [
        `Map ${schemaType} to the closest target template and ship JSON-LD at render time.`,
        'Prioritize pages where this schema can improve CTR or eligibility for enhanced SERP features.',
      ],
    }));
  }

  const entityCoverage = aggregateEntityCoverage(getEntityCoverage(db, project, vsDomain));
  const missingEntities = [...entityCoverage.competitors.entries()]
    .filter(([entity]) => !entityCoverage.target.has(entity))
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8);

  for (const [entity, domains] of missingEntities) {
    actions.push(makeAction({
      id: `competitive-entity-${String(entity).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      type: 'improve',
      priority: domains.size >= 3 ? 'high' : 'medium',
      area: 'content',
      title: `Expand entity coverage around “${entity}”`,
      why: 'Competitors repeatedly mention this entity while the target domain set does not.',
      evidence: collectTop([
        `Competitors covering it: ${[...domains].join(', ')}`,
      ], 4),
      implementationHints: [
        'Add the entity to relevant product, docs, or comparison pages with supporting context, examples, and links.',
        'If the entity deserves dedicated intent coverage, create a focused landing page or guide.',
      ],
    }));
  }

  if (analysis?.new_pages?.length) {
    for (const page of analysis.new_pages.slice(0, 6)) {
      actions.push(makeAction({
        id: `competitive-new-page-${String(page.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        type: 'new_page',
        priority: normalizePriority(page.priority, 'medium'),
        area: 'content',
        title: `Build page: ${page.title}`,
        why: page.why || 'Analysis recommends a dedicated page to win competitor demand.',
        evidence: collectTop((page.placement || []).map(p => `${p.property}: ${p.url}`), 5),
        implementationHints: [
          page.content_angle ? `Angle: ${page.content_angle}` : null,
          'Use the best-fit property and internal link it from high-authority hub pages.',
        ].filter(Boolean),
      }));
    }
  }

  if (analysis?.positioning?.open_angle) {
    actions.push(makeAction({
      id: 'competitive-positioning-open-angle',
      type: 'improve',
      priority: 'medium',
      area: 'content',
      title: 'Sharpen positioning around the open market angle',
      why: analysis.positioning.open_angle,
      evidence: collectTop([
        analysis.positioning.target_differentiator ? `Differentiator: ${analysis.positioning.target_differentiator}` : null,
        analysis.positioning.competitor_map ? `Competitor map: ${analysis.positioning.competitor_map}` : null,
      ].filter(Boolean), 4),
      implementationHints: [
        'Reflect the differentiator in homepage hero copy, solution pages, and comparison pages.',
        'Use repeated phrasing across title tags, H1s, and product proof sections to build topical association.',
      ],
    }));
  }

  return sortActions(actions);
}
