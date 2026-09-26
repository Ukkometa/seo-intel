/**
 * Page Contract — what this page actually needs, and what may not be claimed yet.
 *
 * seo-intel used to answer "what does this page need?" with structure alone,
 * because structure was the only thing in the database. An agent handed nothing
 * but schema signals will recommend schema work for every question it is asked.
 * That is not the model being unreliable; it is the tool offering one instrument.
 *
 * This returns three things instead of a pile of facts:
 *
 *   decision                 one of five outcomes, computed from evidence, never
 *                            from judgement.
 *   blocked_recommendations  what must NOT be advised yet, each with the exact
 *                            missing input that would unblock it.
 *   allowed_now              what is safe to act on regardless of demand data.
 *
 * The split between the last two is deliberate. Demand evidence gates content
 * *investment* — expanding, repositioning, consolidating. It does not gate
 * *correctness*: invalid markup is invalid whether or not anyone searches for
 * the page, and blocking hygiene behind a GSC export nobody has exported yet
 * just stalls work that was never in question.
 *
 * Demand evidence comes from lib/gsc-import.js, which prefers Search Console
 * API rows over CSV exports. The source changes what "no rows" means: under
 * the API's complete page coverage, zero rows is a measurement (the page got
 * no reportable impressions); under an export it is a missing input; and
 * under an API walk that stopped at its row cap (coverage 'partial') it is a
 * gap again, because the rows a capped walk drops are the low-click pages —
 * the very pages a "no demand" verdict would be about. The three states get
 * different wording, different unblocking steps, and the missing input is
 * named only when something is actually missing.
 *
 * Every date this module prints is a day that was fetched. The evidence
 * window is clamped to what gsc_daily holds (7 days after `gsc-fetch --days 7`,
 * whatever was asked for) and the shortfall is stated, so "no impressions
 * between A and B" never names days nobody requested.
 *
 * Unblocking steps name only inputs the caller can supply. The read window
 * (opts.windowDays) is a library parameter that neither the CLI nor the MCP
 * tool exposes, so no block asks for it: the step every caller has is another
 * fetch, which adds days while the window is short of what was asked for and
 * otherwise brings the impressions a later verdict would rest on.
 */

import { deriveBrandTerms, splitBranded } from '../../lib/brand.js';
import {
  EVIDENCE_WINDOW_DAYS,
  getPageQueryEvidence,
  getPropertyQueryContext,
  normalizeUrlKey,
  pickFreshestRange,
} from '../../lib/gsc-import.js';
import { runSchemaAudit } from '../schema-audit/index.js';

// Re-exported so existing consumers keep importing it from here; the ranking
// itself lives next to the CSV path it serves.
export { pickFreshestRange };

// Evidence thresholds. Deliberately conservative: below these, a decision would
// be reading noise, and saying so is more useful than producing a confident number.
const MIN_IMPRESSIONS = 30;     // per page, to call demand "observed"
const WINNABLE_POSITION = 20;   // within striking distance of page one
const STRONG_POSITION = 10;
// Beyond this the crawl is describing a page that may no longer exist as crawled.
// Everything derived from crawl data — markup, headings, word count — inherits
// that doubt, so it is declared rather than presented as current fact.
const STALE_CRAWL_DAYS = 30;

function agg(rows) {
  const clicks = rows.reduce((n, r) => n + (r.clicks || 0), 0);
  const impressions = rows.reduce((n, r) => n + (r.impressions || 0), 0);
  const weighted = rows.reduce((n, r) => n + (r.position || 0) * (r.impressions || 0), 0);
  return {
    queries: rows.length,
    clicks,
    impressions,
    ctr: impressions ? +(clicks / impressions * 100).toFixed(2) : 0,
    avgPosition: impressions ? +(weighted / impressions).toFixed(1) : null,
  };
}

function block(action, reason, unblockedBy) {
  return { action, reason, unblocked_by: unblockedBy };
}

/** True when fewer days were fetched than the window asked for. */
function windowIsShort(window) {
  return Boolean(window) && window.days < window.requested_days;
}

/**
 * How many days the API window really covers, for the decision basis. Reads
 * "28 days" when the fetch holds them all and states the shortfall otherwise,
 * so a reader is never left assuming the default.
 */
function describeDays(window) {
  return windowIsShort(window)
    ? `${window.days} of the ${window.requested_days} days asked for have been fetched`
    : `${window.days} days`;
}

/**
 * The step that turns "too little signal" into a readable one. With an export
 * it is a longer export; with API data it is a later fetch — the one input
 * every caller has (see the header on windowDays) — which also lengthens a
 * window that is short of what was asked for.
 * Returned without a full stop so callers can extend the sentence.
 */
function widerEvidenceHint(evidence, project) {
  if (evidence.source !== 'api') return 'A 3-month or 12-month page-filtered export';
  const growth = windowIsShort(evidence.window)
    ? ` — the window holds ${evidence.window.days} of the ${evidence.window.requested_days} days asked for, and each fetch adds days`
    : '';
  return `A rise in non-branded impressions on a later fetch (seo-intel gsc-fetch ${project})${growth}`;
}

/**
 * Caveats a verdict built on API rows must carry: a capped walk makes the
 * totals a floor, and a short window is fewer days than the reader expects.
 */
function windowNotes(evidence) {
  const notes = [];
  if (evidence.source !== 'api' || !evidence.window) return notes;
  const w = evidence.window;
  if (evidence.truncated) {
    notes.push(`The page_query fetch for ${evidence.property} hit its row cap inside this window, so these totals are a floor: the API returns rows in click order, and the rows below the cap were dropped.`);
  }
  if (windowIsShort(w)) {
    notes.push(`Only ${w.days} of the ${w.requested_days} days asked for have been fetched (${w.start}..${w.end}); later fetches add days.`);
  }
  return notes;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string} url
 * @param {{ brandTerms?: string[], windowDays?: number }} opts
 */
export function runPageContract(db, project, url, opts = {}) {
  const windowDays = Number.isInteger(opts.windowDays) && opts.windowDays >= 1
    ? opts.windowDays
    : EVIDENCE_WINDOW_DAYS;
  const brand = deriveBrandTerms(db, project, opts.brandTerms || []);
  const evidence = getPageQueryEvidence(db, project, url, { windowDays });
  const key = normalizeUrlKey(url);

  const page = db.prepare(`
    SELECT p.id, p.url, p.title, p.word_count, p.is_indexable, p.crawled_at
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target','owned')
  `).all(project).find(r => normalizeUrlKey(r.url) === key) || null;

  const crawlAgeDays = page?.crawled_at ? Math.floor((Date.now() - page.crawled_at) / 86_400_000) : null;
  const crawlStale = crawlAgeDays !== null && crawlAgeDays > STALE_CRAWL_DAYS;

  // Property-wide rows are context, never evidence about this page. API rows
  // win when present; otherwise the unfiltered CSV exports, from one window.
  let propertyScoped, newestRange, propertySource;
  const apiContext = getPropertyQueryContext(db, project, { windowDays });
  if (apiContext) {
    propertyScoped = apiContext.rows;
    newestRange = apiContext.date_range;
    propertySource = apiContext.source;
  } else {
    let propertyRows = [];
    try {
      propertyRows = db.prepare(
        'SELECT * FROM gsc_queries WHERE project = ? AND page_url IS NULL ORDER BY impressions DESC'
      ).all(project);
    } catch { /* not imported yet */ }
    // Every row from one import shares an imported_at, so sorting by it picks an
    // arbitrary window. Rank the declared ranges by how recent they are instead,
    // so the context shown is reproducible.
    newestRange = pickFreshestRange(propertyRows.map(r => r.date_range));
    propertyScoped = propertyRows.filter(r => r.date_range === newestRange);
    propertySource = newestRange ? 'csv' : null;
  }
  const propSplit = splitBranded(propertyScoped, brand.terms);

  const pageSplit = splitBranded(evidence.rows, brand.terms);
  const pageBranded = agg(pageSplit.branded);
  const pageNonBranded = agg(pageSplit.nonBranded);
  const hasPageEvidence = evidence.rows.length > 0;
  const fromApi = evidence.source === 'api';
  // Zero rows under complete API coverage is a measurement. Under a walk that
  // stopped at its row cap it is not: the rows dropped were the low-click
  // ones, and nothing says which pages they belonged to.
  const measuredAbsence = !hasPageEvidence && fromApi && evidence.coverage === 'complete';
  const truncatedAbsence = !hasPageEvidence && fromApi && !measuredAbsence;

  // ── Decision, computed only from what is measured ────────────────────────
  let decision, basis;
  const blocked = [];

  if (measuredAbsence) {
    // The fetch covered every page the property reported over these days.
    // This one was not among them, so the absence is a fact about the page,
    // not about the inputs — over exactly the days named, no more.
    const { start, end } = evidence.window;
    decision = 'no_action_yet';
    basis = [
      `Search Console reports no impressions for this URL between ${start} and ${end} (${describeDays(evidence.window)}); page-level coverage for this property is complete over those days, so that absence is measured, not missing.`,
    ];
    const growth = windowIsShort(evidence.window)
      ? `; each later fetch also adds days to the window, which holds ${evidence.window.days} of the ${evidence.window.requested_days} asked for`
      : '';
    const unblock = `Non-branded impressions on this URL in a later fetch (seo-intel gsc-fetch ${project})${growth}.`;
    blocked.push(
      block('expand', 'Expanding content requires proof that non-branded demand reaches this page. Search Console measured none in the window.', unblock),
      block('reposition', 'Repositioning requires knowing which queries currently land here. Search Console recorded none.', unblock),
      block('consolidate', 'Consolidation requires query overlap with another page. This page has no measured queries to overlap.', unblock),
      block('claim_category_ownership', 'Property-wide rankings cannot be attributed to a single page, and this page has no rankings of its own in the window.', unblock),
    );
  } else if (truncatedAbsence) {
    // The walk stopped at its row cap somewhere in the window. The API returns
    // rows in click order, so the pages it dropped are the low-click ones —
    // this URL may be one of them. Its silence is a gap in the inputs.
    const { start, end } = evidence.window;
    decision = 'no_action_yet';
    basis = [
      `Search Console returned no rows for this URL between ${start} and ${end}, but the page_query fetch for ${evidence.property} hit its row cap in that window. The API hands rows back in click order, so the rows dropped were the lowest-click pages — this one may be among them. The absence is a gap in the inputs, not a measurement.`,
    ];
    const unblock = `A Search Console export taken with a Page filter set to ${url}, saved to gsc/${project}-<label>/ and re-imported (seo-intel gsc-import ${project}); page-filtered rows for this URL are read even where the API walk was cut short.`;
    blocked.push(
      block('expand', 'Expanding content requires proof that non-branded demand reaches this page. The fetch that would have shown it stopped at its row cap, so none has been measured.', unblock),
      block('reposition', 'Repositioning requires knowing which queries currently land here. The truncated fetch recorded none for this URL.', unblock),
      block('consolidate', 'Consolidation requires query overlap with another page. No queries are recorded for this URL, and the fetch was cut short.', unblock),
      block('claim_category_ownership', 'Property-wide rankings cannot be attributed to a single page, and no rankings for this page survived the row cap.', unblock),
    );
  } else if (!hasPageEvidence) {
    decision = 'no_action_yet';
    basis = evidence.hasPageScopedExports
      ? ['Page-filtered exports exist for this project, but none cover this URL.']
      : [
          'No page-filtered Search Console export has been imported for this project.',
          `Property-wide data covers ${propertyScoped.length} queries but says nothing about which of them land on this URL.`,
        ];
    const unblock = `A Search Console export taken with a Page filter set to ${url}, saved to gsc/${project}-<label>/ and re-imported — or seo-intel gsc-fetch ${project} (connected Google account), which covers every page at once.`;
    blocked.push(
      block('expand', 'Expanding content requires proof that non-branded demand reaches this page. None has been measured.', unblock),
      block('reposition', 'Repositioning requires knowing which queries currently land here. Unknown.', unblock),
      block('consolidate', 'Consolidation requires query overlap with another page. Unmeasurable without page-level data.', unblock),
      block('claim_category_ownership', 'Property-wide rankings cannot be attributed to a single page.', unblock),
    );
  } else if (pageNonBranded.impressions < MIN_IMPRESSIONS && pageBranded.impressions > 0) {
    decision = 'protect';
    basis = [
      `Branded queries deliver ${pageBranded.impressions} impressions; non-branded reach only ${pageNonBranded.impressions}, below the ${MIN_IMPRESSIONS}-impression floor.`,
      'The page serves navigation. Nothing here shows category demand to expand into.',
    ];
    blocked.push(block('expand',
      `Non-branded demand (${pageNonBranded.impressions} impressions) is below the ${MIN_IMPRESSIONS} floor, so any content bet would be built on noise.`,
      evidence.source === 'api'
        ? `${widerEvidenceHint(evidence, project)}.`
        : 'A longer date range, or a rise in non-branded impressions on a later export.'));
  } else if (pageNonBranded.impressions < MIN_IMPRESSIONS) {
    decision = 'no_action_yet';
    basis = [`Only ${pageNonBranded.impressions} non-branded impressions recorded, below the ${MIN_IMPRESSIONS}-impression floor.`];
    blocked.push(block('expand', 'Demand too small to distinguish from noise.', `${widerEvidenceHint(evidence, project)}.`));
  } else if (pageNonBranded.avgPosition !== null && pageNonBranded.avgPosition <= WINNABLE_POSITION) {
    decision = 'expand';
    basis = [
      `${pageNonBranded.impressions} non-branded impressions across ${pageNonBranded.queries} queries.`,
      `Average non-branded position ${pageNonBranded.avgPosition} is within striking distance of page one.`,
      pageNonBranded.avgPosition <= STRONG_POSITION
        ? 'Already on page one for these terms — depth and internal linking should move clicks.'
        : 'On page two. Depth, entity coverage, and internal links are the usual levers.',
    ];
  } else {
    decision = 'reposition';
    basis = [
      `${pageNonBranded.impressions} non-branded impressions, but average position ${pageNonBranded.avgPosition} is beyond page two.`,
      'Demand exists and the page is not competing for it. This is a targeting problem, not a depth problem.',
    ];
    blocked.push(block('expand',
      `At position ${pageNonBranded.avgPosition}, adding length rarely moves a page onto page one; the mismatch is what the page is about.`,
      'Evidence that the page targets the right query cluster — or a decision to reposition first.'));
  }
  if (hasPageEvidence) basis.push(...windowNotes(evidence));

  // ── Hygiene is never gated on demand ─────────────────────────────────────
  const schema = runSchemaAudit(db, project, { skipLedger: true });
  const pageSchemaIssues = schema.issues.filter(i => normalizeUrlKey(i.url) === key);
  const staleNote = crawlStale
    ? ` Crawl data for this page is ${crawlAgeDays} days old — re-crawl before acting, as these findings may describe a version of the page that no longer exists.`
    : '';
  const allowed = [
    { action: 'fix_invalid_markup', reason: 'Structured-data validity is independent of search demand.' + staleNote, items: pageSchemaIssues.map(i => `${i.code}: ${i.fix}`) },
    { action: 'fix_technical_errors', reason: 'Indexability, canonicals, and redirects are correctness, not investment.', items: [] },
  ];
  if (page && !page.is_indexable) {
    allowed.push({ action: 'review_indexability', reason: 'The page is marked non-indexable; no query work matters until that is intended or fixed.', items: [] });
  }

  return {
    project,
    url,
    page: page ? { title: page.title, wordCount: page.word_count, indexable: !!page.is_indexable } : null,
    crawled: !!page,
    decision,
    decision_basis: basis,
    blocked_recommendations: blocked,
    allowed_now: allowed,
    evidence: {
      scope: hasPageEvidence ? 'page' : 'none',
      source: evidence.source,
      coverage: evidence.coverage,
      truncated: evidence.truncated,
      property: evidence.property,
      // start..end are fetched days only; days < requested_days says the
      // fetch holds fewer than the window asked for.
      window: evidence.window,
      page_level: hasPageEvidence ? { branded: pageBranded, non_branded: pageNonBranded, date_ranges: evidence.dateRanges } : null,
      property_level_context: {
        date_range: newestRange,
        source: propertySource,
        truncated: apiContext?.truncated ?? false,
        branded: agg(propSplit.branded),
        non_branded: agg(propSplit.nonBranded),
        note: 'Property-wide totals. Context only — they cannot be attributed to this URL.',
      },
      brand_terms: brand.terms,
      brand_terms_note: 'Derived from the registrable domain and Organization/WebSite/Product schema names. Correct these in config if a real brand is missing or a category term crept in.',
      crawl: {
        crawled_at: page?.crawled_at ?? null,
        age_days: crawlAgeDays,
        stale: crawlStale,
        note: page
          ? (crawlStale
              ? `Crawl is ${crawlAgeDays} days old. Every crawl-derived field below — markup, headings, word count — describes the page as it was then, not as it is now.`
              : `Crawl is ${crawlAgeDays} days old.`)
          : 'This URL is not in the crawl data at all, so no crawl-derived finding is available for it.',
      },
      // Under complete API coverage nothing is missing: the absence of rows
      // is the finding, so no export is asked for. Under a truncated walk the
      // export is the one input that reaches past the row cap.
      missing_inputs: [
        ...(hasPageEvidence || measuredAbsence ? []
          : truncatedAbsence
            ? [`Page-filtered Search Console export for ${url} — the API fetch for this window hit its row cap, so its silence on this URL is not a measurement`]
            : [`Page-filtered Search Console export for ${url}, or seo-intel gsc-fetch ${project}`]),
        ...(crawlStale ? [`Fresh crawl — current data is ${crawlAgeDays} days old (seo-intel crawl ${project} --domain ${(() => { try { return new URL(url).hostname; } catch { return url; } })()})`] : []),
        ...(page ? [] : ['This URL has never been crawled']),
      ],
    },
    schema_issues: pageSchemaIssues.map(i => ({ code: i.code, severity: i.severity, fix: i.fix })),
  };
}
