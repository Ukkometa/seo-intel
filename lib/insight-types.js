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
 *   scope       'own-site' findings are free; 'competitor' ones are the paid
 *               moat, and so are 'history' ones — a comparison across time
 *               windows that only accumulated data can make. Everything that
 *               is not 'own-site' is paid (lib/problems.js), so a new scope
 *               needs no gate of its own.
 *   category    Problem category for MCP list_problems.
 *   severity    'critical' | 'warn' | 'info' — the same vocabulary MCP
 *               list_problems, search_review and the dashboard expose. It used
 *               to say 'error', which lib/problems.js could not rank, so the
 *               sort order of every problem list containing one broke.
 *   difficulty  1–5, surfaced to agents for planning.
 *   emitsProblems  Whether list_problems derives problems from this type. False
 *               for types that already have a dedicated collector, so the same
 *               finding is not reported twice under two ids.
 *   sourceKind  Where findings of this type come from: 'rule' for a detector
 *               that reads the crawl and decides deterministically, 'model'
 *               for a synthesis an LLM produced. Provenance exists for two
 *               reasons. A finding an agent may act on unattended must come
 *               from a rule — a model's keyword gap is a hypothesis, and the
 *               review (analyses/review) sends those to a human. And a model's
 *               guess must not live forever: rule findings clear on their own
 *               when the rule stops firing, but nothing re-checks a model's
 *               claim, so the Ledger expires those unless they are re-emitted.
 *               Rows carry their own source_kind (an agent can write a type a
 *               model usually produces); this is the default a writer stamps
 *               and the fallback a reader uses when a row predates the column.
 *   ruleVersion Version tag of the detector, for rule types; null otherwise.
 *               Bumped when a rule's logic changes enough that its old
 *               findings should not be trusted as this rule's output.
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
  // 'rule' is the safe default: an unknown type is treated as a detector's
  // output for grouping, but a row's own source_kind still wins when it is set,
  // so a model row of an unregistered type is never promoted to rule by this.
  const sourceKind = spec.sourceKind || 'rule';
  return {
    key,
    groupKey: spec.groupKey || `${key}s`,
    single: !!spec.single,
    scope: spec.scope || 'competitor',
    category: spec.category || 'content',
    severity: spec.severity || 'warn',
    difficulty: spec.difficulty ?? 3,
    emitsProblems: spec.emitsProblems !== false,
    sourceKind,
    ruleVersion: sourceKind === 'rule' ? String(spec.ruleVersion ?? '1') : null,
    label: spec.label || key,
    title: spec.title || defaultTitle,
    detail: spec.detail || defaultDetail,
    fix: spec.fix || defaultFix,
    url: spec.url || defaultUrl,
  };
}

export const INSIGHT_TYPES = Object.freeze({
  // ── Competitor synthesis and history — the paid moat ──────────────────────
  // The LLM synthesis types (cli.js analyze / keywords, and agent write-back
  // through MCP). Their findings are hypotheses: the review never lets an agent
  // act on them unattended, and the Ledger expires them unless re-emitted.
  keyword_gap: entry('keyword_gap', {
    groupKey: 'keyword_gaps', label: 'Keyword gap', category: 'keyword', difficulty: 3, sourceKind: 'model',
  }),
  long_tail: entry('long_tail', {
    groupKey: 'long_tails', label: 'Long-tail opportunity', category: 'keyword', severity: 'info', difficulty: 2,
    sourceKind: 'model',
  }),
  quick_win: entry('quick_win', {
    groupKey: 'quick_wins', label: 'Quick win', category: 'content', severity: 'info', difficulty: 2, sourceKind: 'model',
  }),
  new_page: entry('new_page', {
    groupKey: 'new_pages', label: 'Suggested page', category: 'content', severity: 'info', difficulty: 4, sourceKind: 'model',
  }),
  content_gap: entry('content_gap', {
    groupKey: 'content_gaps', label: 'Content gap', category: 'content', difficulty: 4, sourceKind: 'model',
  }),
  technical_gap: entry('technical_gap', {
    groupKey: 'technical_gaps', label: 'Technical gap', category: 'tech', difficulty: 3, sourceKind: 'model',
  }),
  positioning: entry('positioning', {
    groupKey: 'positioning', single: true, label: 'Positioning', category: 'positioning',
    severity: 'info', difficulty: 5, sourceKind: 'model',
  }),
  keyword_inventor: entry('keyword_inventor', {
    groupKey: 'keyword_inventor', label: 'Invented keyword', category: 'keyword',
    severity: 'info', difficulty: 2, sourceKind: 'model',
  }),
  // A diff between two crawl snapshots: deterministic, so a rule even though it
  // sits in the paid tier.
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
  backlink_gap: entry('backlink_gap', {
    groupKey: 'backlink_gaps', label: 'Backlink reclamation', scope: 'own-site',
    category: 'content', difficulty: 3,
    title: d => d?.domain || null,
    detail: d => d?.pages ? `${d.pages} link(s) under a name the site no longer uses.` : defaultDetail(d),
  }),
  schema_specificity: entry('schema_specificity', {
    groupKey: 'schema_specificity_issues', label: 'Schema type mismatch', scope: 'own-site',
    category: 'tech', severity: 'critical', difficulty: 2,
  }),

  // ── Search Console demand — measured, not estimated ───────────────────────
  // analyses/demand reads gsc_daily and decides by arithmetic, so these are
  // rules even though their names echo the model's quick_win and long_tail
  // above: the model's are hypotheses about a market, these are facts about
  // this property's own impressions. They are kept as separate types so the
  // two provenances never share a card or a fingerprint space.
  gsc_quick_win: entry('gsc_quick_win', {
    groupKey: 'gsc_quick_wins', label: 'Demand quick win', scope: 'own-site',
    category: 'keyword', severity: 'info', difficulty: 2,
    title: d => d?.query && d?.page_url ? `${d.query} → ${d.page_url}` : defaultTitle(d),
    detail: d => d?.impressions !== undefined
      ? `${d.impressions} impressions at position ${d.position}: ${d.ctr}% CTR against a ${d.expected_ctr}% baseline`
        + `${d.kind === 'page_two' ? ' from page two' : d.kind === 'both' ? ' and on page two' : ''}`
        + `${d.potential_clicks !== undefined ? `; about ${d.potential_clicks} more clicks per window on the table.` : '.'}`
      : defaultDetail(d),
    fix: d => d?.recommendation || null,
    url: d => d?.page_url || null,
  }),
  gsc_long_tail: entry('gsc_long_tail', {
    groupKey: 'gsc_long_tails', label: 'Demand long tail', scope: 'own-site',
    category: 'content', severity: 'info', difficulty: 3,
    title: d => d?.query || null,
    detail: d => d?.impressions !== undefined
      ? `${d.impressions} impressions at position ${d.position} with no page on page one`
        + `${d.best_page ? `; best page ${d.best_page} at ${d.best_position}.` : '; no page ranks for it.'}`
      : defaultDetail(d),
    fix: d => d?.recommendation || null,
    url: d => d?.best_page || null,
  }),
  gsc_decay: entry('gsc_decay', {
    groupKey: 'gsc_decays', label: 'Traffic decay', scope: 'history',
    category: 'content', severity: 'warn', difficulty: 3,
    title: d => d?.page_url || null,
    detail: d => d?.previous_clicks !== undefined
      ? `Clicks ${d.previous_clicks} → ${d.clicks} (${d.delta_pct}%), impressions ${d.previous_impressions} → ${d.impressions}, `
        + `position ${d.previous_position} → ${d.position}`
        + `${d.previous_window && d.window ? ` between ${d.previous_window} and ${d.window}.` : '.'}`
      : defaultDetail(d),
    fix: d => d?.recommendation || null,
    url: d => d?.page_url || null,
  }),
});

/** Every registered type key. */
export const INSIGHT_TYPE_KEYS = Object.keys(INSIGHT_TYPES);

/** Types that list_problems derives problems from. */
export const PROBLEM_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].emitsProblems);

/**
 * Types produced by own-site analysis, which the free tier includes. Scope
 * 'own-site' alone: 'competitor' and 'history' are both paid.
 */
export const FREE_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].scope === 'own-site');

/**
 * Types an LLM produces by default. db/db.js uses this list to classify rows
 * written before the source_kind column existed, so it is derived from the
 * registry rather than repeated: the two could otherwise drift apart and a
 * type would be a model's in one place and a rule's in the other.
 */
export const MODEL_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].sourceKind === 'model');

/** Types a deterministic detector produces by default. */
export const RULE_INSIGHT_TYPES = INSIGHT_TYPE_KEYS.filter(k => INSIGHT_TYPES[k].sourceKind === 'rule');

/**
 * Metadata for a type, with a safe fallback for rows written by older versions.
 * The fallback is a rule (sourceKind 'rule', ruleVersion '1'): see entry().
 */
export function insightMeta(type) {
  return INSIGHT_TYPES[type] || entry(type, { label: type, groupKey: `${type}s` });
}
