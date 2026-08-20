/**
 * lib/insight-types.js — the Intelligence Ledger's type registry.
 *
 * Every insight type is declared here once. Readers derive their behaviour from
 * this table instead of repeating it:
 *
 *   db/db.js   getActiveInsights  — grouping and the returned shape
 *   lib/problems.js               — which types become problems, and at what tier
 *   reports/generate-html.js      — which types get rendered, and how
 *
 * Before this existed the same list was hardcoded in all three places, and they
 * disagreed: `citability_gap` had been written to the table since v1.2.0 but
 * appeared in none of the three, so every one of those insights was stored and
 * then silently dropped. Adding a type now means adding one row here.
 *
 * Fields:
 *   groupKey    Key under which getActiveInsights returns this type. Existing
 *               keys are load-bearing for the dashboard — do not rename them.
 *   single      Return one object instead of an array (positioning).
 *   scope       'own-site' findings are free; 'competitor' ones are the paid moat.
 *   category    Problem category for MCP list_problems.
 *   severity    'error' | 'warn' | 'info'.
 *   difficulty  1–5, surfaced to agents for planning.
 *   emitsProblems  Whether list_problems derives problems from this type. False
 *               for types that already have a dedicated collector, so the same
 *               finding is not reported twice under two ids.
 *   title/detail/fix/url  Accessors that turn a stored `data` blob into display
 *               text, so renderers do not need to know each type's shape.
 */

const firstOf = (...keys) => data => {
  for (const k of keys) {
    const v = data?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};

const defaultTitle = firstOf('keyword', 'topic', 'gap', 'phrase', 'query', 'title', 'url', 'domain');
const defaultDetail = firstOf('why', 'description', 'message', 'detail', 'reason');
const defaultFix = firstOf('recommendation', 'suggestion', 'fix', 'action');
const defaultUrl = firstOf('url', 'pageUrl', 'page_url');

function entry(key, spec) {
  return {
    key,
    groupKey: spec.groupKey || `${key}s`,
    single: !!spec.single,
    scope: spec.scope || 'competitor',
    category: spec.category || 'content',
    severity: spec.severity || 'warn',
    difficulty: spec.difficulty ?? 3,
    emitsProblems: spec.emitsProblems !== false,
    label: spec.label || key,
    title: spec.title || defaultTitle,
    detail: spec.detail || defaultDetail,
    fix: spec.fix || defaultFix,
    url: spec.url || defaultUrl,
  };
}

export const INSIGHT_TYPES = Object.freeze({
  // ── Competitor synthesis and history — the paid moat ──────────────────────
  keyword_gap: entry('keyword_gap', {
    groupKey: 'keyword_gaps', label: 'Keyword gap', category: 'keyword', difficulty: 3,
  }),
  long_tail: entry('long_tail', {
    groupKey: 'long_tails', label: 'Long-tail opportunity', category: 'keyword', severity: 'info', difficulty: 2,
  }),
  quick_win: entry('quick_win', {
    groupKey: 'quick_wins', label: 'Quick win', category: 'content', severity: 'info', difficulty: 2,
  }),
  new_page: entry('new_page', {
    groupKey: 'new_pages', label: 'Suggested page', category: 'content', severity: 'info', difficulty: 4,
  }),
  content_gap: entry('content_gap', {
    groupKey: 'content_gaps', label: 'Content gap', category: 'content', difficulty: 4,
  }),
  technical_gap: entry('technical_gap', {
    groupKey: 'technical_gaps', label: 'Technical gap', category: 'tech', difficulty: 3,
  }),
  positioning: entry('positioning', {
    groupKey: 'positioning', single: true, label: 'Positioning', category: 'positioning',
    severity: 'info', difficulty: 5,
  }),
  keyword_inventor: entry('keyword_inventor', {
    groupKey: 'keyword_inventor', label: 'Invented keyword', category: 'keyword',
    severity: 'info', difficulty: 2,
  }),
  site_watch: entry('site_watch', {
    groupKey: 'site_watch', label: 'Site change', category: 'tech', severity: 'info', difficulty: 2,
  }),

  // ── Own-site analysis — free ──────────────────────────────────────────────
  // Surfaced through getActiveInsights (it was orphaned before the registry),
  // but not turned into problems here: collectCitabilityGaps already derives
  // those from the citability_scores table, and reporting both would give the
  // same finding two different problem ids.
  citability_gap: entry('citability_gap', {
    groupKey: 'citability_gaps', label: 'AI citability gap', scope: 'own-site',
    category: 'tech', difficulty: 3, emitsProblems: false,
    detail: d => d?.score !== undefined
      ? `Scores ${d.score}/100${d.weakest_signals?.length ? `; weakest: ${d.weakest_signals.join(', ')}` : ''}.`
      : defaultDetail(d),
  }),
  entity_gap: entry('entity_gap', {
    groupKey: 'entity_gaps', label: 'Entity mapping', scope: 'own-site',
    category: 'tech', difficulty: 2,
    title: d => d?.code ? d.code.replace(/_/g, ' ') : defaultUrl(d),
  }),
  triangulation_gap: entry('triangulation_gap', {
    groupKey: 'triangulation_gaps', label: 'Missing proof', scope: 'own-site',
    category: 'content', difficulty: 3,
    detail: d => d?.missing?.length ? `Missing: ${d.missing.join(', ')}` : defaultDetail(d),
  }),
  retrieval_gap: entry('retrieval_gap', {
    groupKey: 'retrieval_gaps', label: 'LLM retrieval shape', scope: 'own-site',
    category: 'content', difficulty: 2,
  }),
  platform_gap: entry('platform_gap', {
    groupKey: 'platform_gaps', label: 'Platform query gap', scope: 'own-site',
    category: 'content', difficulty: 4,
    detail: d => d?.platformSignals?.length
      ? `Ranks on ${d.platformSignals.map(s => s.name).join(', ')} with no matching page on the site.`
      : defaultDetail(d),
  }),
  schema_specificity: entry('schema_specificity', {
    groupKey: 'schema_specificity_issues', label: 'Schema type mismatch', scope: 'own-site',
    category: 'tech', severity: 'error', difficulty: 2,
  }),
});

/** Every registered type key. */
export const INSIGHT_TYPE_KEYS = Object.keys(INSIGHT_TYPES);

/** Types that list_problems derives problems from. */
export const PROBLEM_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].emitsProblems);

/** Types produced by own-site analysis, which the free tier includes. */
export const FREE_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].scope === 'own-site');

/** Metadata for a type, with a safe fallback for rows written by older versions. */
export function insightMeta(type) {
  return INSIGHT_TYPES[type] || entry(type, { label: type, groupKey: `${type}s` });
}
