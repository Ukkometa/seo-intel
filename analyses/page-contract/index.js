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
 */

import { deriveBrandTerms, splitBranded } from '../../lib/brand.js';
import { getPageQueryEvidence, normalizeUrlKey } from '../../lib/gsc-import.js';
import { runSchemaAudit } from '../schema-audit/index.js';

// Evidence thresholds. Deliberately conservative: below these, a decision would
// be reading noise, and saying so is more useful than producing a confident number.
const MIN_IMPRESSIONS = 30;     // per page, to call demand "observed"
const WINNABLE_POSITION = 20;   // within striking distance of page one
const STRONG_POSITION = 10;
// Beyond this the crawl is describing a page that may no longer exist as crawled.
// Everything derived from crawl data — markup, headings, word count — inherits
// that doubt, so it is declared rather than presented as current fact.
const STALE_CRAWL_DAYS = 30;

/**
 * GSC writes its window as prose ("Last 28 days"). Rank by the span it covers,
 * shortest first, so the freshest window wins deterministically.
 */
function rangeSpanDays(range) {
  const m = /last\s+(\d+)\s+(day|week|month|year)/i.exec(String(range || ''));
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * ({ day: 1, week: 7, month: 30, year: 365 }[unit] || 1);
}

export function pickFreshestRange(ranges) {
  const uniq = [...new Set((ranges || []).filter(Boolean))];
  if (!uniq.length) return null;
  return uniq.sort((a, b) => rangeSpanDays(a) - rangeSpanDays(b) || a.localeCompare(b))[0];
}

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

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string} url
 * @param {{ brandTerms?: string[] }} opts
 */
export function runPageContract(db, project, url, opts = {}) {
  const brand = deriveBrandTerms(db, project, opts.brandTerms || []);
  const evidence = getPageQueryEvidence(db, project, url);
  const key = normalizeUrlKey(url);

  const page = db.prepare(`
    SELECT p.id, p.url, p.title, p.word_count, p.is_indexable, p.crawled_at
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target','owned')
  `).all(project).find(r => normalizeUrlKey(r.url) === key) || null;

  const crawlAgeDays = page?.crawled_at ? Math.floor((Date.now() - page.crawled_at) / 86_400_000) : null;
  const crawlStale = crawlAgeDays !== null && crawlAgeDays > STALE_CRAWL_DAYS;

  // Property-wide rows are context, never evidence about this page.
  let propertyRows = [];
  try {
    propertyRows = db.prepare(
      'SELECT * FROM gsc_queries WHERE project = ? AND page_url IS NULL ORDER BY impressions DESC'
    ).all(project);
  } catch { /* not imported yet */ }
  // Every row from one import shares an imported_at, so sorting by it picks an
  // arbitrary window. Rank the declared ranges by how recent they are instead,
  // so the context shown is reproducible.
  const newestRange = pickFreshestRange(propertyRows.map(r => r.date_range));
  const propertyScoped = propertyRows.filter(r => r.date_range === newestRange);
  const propSplit = splitBranded(propertyScoped, brand.terms);

  const pageSplit = splitBranded(evidence.rows, brand.terms);
  const pageBranded = agg(pageSplit.branded);
  const pageNonBranded = agg(pageSplit.nonBranded);
  const hasPageEvidence = evidence.rows.length > 0;

  // ── Decision, computed only from what is measured ────────────────────────
  let decision, basis;
  const blocked = [];

  if (!hasPageEvidence) {
    decision = 'no_action_yet';
    basis = evidence.hasPageScopedExports
      ? ['Page-filtered exports exist for this project, but none cover this URL.']
      : [
          'No page-filtered Search Console export has been imported for this project.',
          `Property-wide data covers ${propertyScoped.length} queries but says nothing about which of them land on this URL.`,
        ];
    const unblock = `A Search Console export taken with a Page filter set to ${url}, saved to gsc/${project}-<label>/ and re-imported.`;
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
      'A longer date range, or a rise in non-branded impressions on a later export.'));
  } else if (pageNonBranded.impressions < MIN_IMPRESSIONS) {
    decision = 'no_action_yet';
    basis = [`Only ${pageNonBranded.impressions} non-branded impressions recorded, below the ${MIN_IMPRESSIONS}-impression floor.`];
    blocked.push(block('expand', 'Demand too small to distinguish from noise.', 'A 3-month or 12-month page-filtered export.'));
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
      page_level: hasPageEvidence ? { branded: pageBranded, non_branded: pageNonBranded, date_ranges: evidence.dateRanges } : null,
      property_level_context: {
        date_range: newestRange,
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
      missing_inputs: [
        ...(hasPageEvidence ? [] : [`Page-filtered Search Console export for ${url}`]),
        ...(crawlStale ? [`Fresh crawl — current data is ${crawlAgeDays} days old (seo-intel crawl ${project} --domain ${(() => { try { return new URL(url).hostname; } catch { return url; } })()})`] : []),
        ...(page ? [] : ['This URL has never been crawled']),
      ],
    },
    schema_issues: pageSchemaIssues.map(i => ({ code: i.code, severity: i.severity, fix: i.fix })),
  };
}
