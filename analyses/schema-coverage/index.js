/**
 * analyses/schema-coverage — structured data compared across the market: which
 * schema.org types each domain publishes, which ones competitors carry and you
 * do not, and who has the star ratings and prices that become rich results.
 *
 * Why it matters. JSON-LD is the part of a page a search engine does not have
 * to interpret: a Product with an aggregateRating can earn stars in the
 * result, a FAQPage an accordion, an Offer a price. A competitor with those and
 * a target without them compete for the same position with different-sized
 * results, and the fix is markup, not content. This module finds the
 * difference; analyses/schema-audit, by contrast, judges whether the target's
 * own markup is the right type and carries the fields Google requires.
 *
 * Where the rows come from. page_schemas, filled from each page's JSON-LD at
 * crawl time (crawler/schema-parser.js) and by `schemas-backfill`, read through
 * db.getSchemasByProject, which orders by domain, then type. One row is one
 * JSON-LD object, so a homepage carrying Organization and FAQPage is two rows,
 * and every count here — the matrix cells, totalSchemas, the rating and
 * pricing lists — counts schema objects, not pages. No model is involved.
 *
 * Why one module. The command was written twice: inline in cli.js and again in
 * agent-harness.js run(). The row selection and the gap arithmetic agreed; the
 * copies differed in what they returned and where the target came from. The
 * harness returned fewer fields (no name on ratings or pricing, no rating count
 * or currency in the matrix) and no actions, though its capability manifest
 * lists actions among the outputs. The CLI read the project config relative to
 * the working directory (`./config/<project>.json`), so run from anywhere but
 * the package root it found no target, and every type every domain used —
 * including the target's own — came out as a gap. The harness read it from the
 * package's config directory; that is a fix, and it is kept: pass the config
 * (or the target domain) in, or let this module read it through
 * lib/project-config.js. Everything else is the CLI's.
 *
 * Who "you" is. The config's target domain, and nothing else. An owned domain
 * — a docs subdomain, or the www host a redirecting target gets crawled under —
 * is on the competitor side of every comparison here, unlike entity coverage,
 * which counts owned domains as you. Both copies did this, so it stays, but it
 * is a known flaw: when the target's schemas land under its www host, its own
 * types read as gaps "used by www.<target>". The rows carry d.role, so the fix
 * is one comparison; it changes the answer for those projects and belongs in
 * its own change.
 *
 * Gaps and exclusives. A gap is a type some non-target domain uses and the
 * target does not; an exclusive is the reverse. Presence, not count: one
 * FAQPage anywhere on the target closes the FAQPage gap. Both lists are in row
 * order — domain, then type — so each type sits where the alphabetically first
 * domain carrying it lists it, as in both copies.
 *
 * Actions, in order: high-value gaps (HIGH_VALUE_TYPES — the types that earn
 * a rich result or a product panel), the remaining gaps, star ratings when
 * any domain has them and the target has none, pricing on the same rule, then
 * FAQPage and BreadcrumbList specifically. A FAQPage gap is therefore named
 * twice, in the high-value line and on its own; the CLI has always printed it
 * that way and the text of each line says something different.
 */

import { getSchemasByProject } from '../../db/db.js';
import { readProjectConfig } from '../../lib/project-config.js';

/** Types whose absence costs a visible rich result or panel; named first in the actions. */
export const HIGH_VALUE_TYPES = Object.freeze([
  'Product', 'SoftwareApplication', 'FAQPage', 'HowTo', 'Review', 'AggregateRating',
]);

/**
 * The domain that counts as "you": opts.targetDomain if given (null allowed),
 * else opts.config.target.domain if a config is given (null allowed), else the
 * project's config read from disk. null when none of those names one — every
 * domain is then a competitor and every type a gap, which is what the CLI
 * printed when it could not find the config. A config on disk under a name
 * lib/project-config refuses (config/acme.io.json) is null here too; the old
 * CLI read that file directly and found the target, so `cli.js schemas` stops
 * with the rename hint before it gets this far rather than print the target's
 * own types as gaps.
 */
export function resolveTargetDomain(project, opts = {}) {
  if (opts.targetDomain !== undefined) return opts.targetDomain || null;
  if (opts.config !== undefined) return opts.config?.target?.domain || null;
  return readProjectConfig(project)?.target?.domain || null;
}

/**
 * The recommendations, in the order the header gives. Pure: takes the pieces
 * getSchemaCoverage has already computed.
 *
 * @param {{ gaps: string[], targetTypes: Set<string>, competitorTypes: Set<string>,
 *           anyRatings: boolean, targetHasRatings: boolean,
 *           anyPricing: boolean, targetHasPricing: boolean }} p
 * @returns {string[]}
 */
export function schemaActions({ gaps, targetTypes, competitorTypes, anyRatings, targetHasRatings, anyPricing, targetHasPricing }) {
  const actions = [];
  if (gaps.length > 0) {
    const highValue = gaps.filter(t => HIGH_VALUE_TYPES.includes(t));
    if (highValue.length > 0) actions.push(`Add high-value schema types: ${highValue.join(', ')}`);
    const remaining = gaps.filter(t => !highValue.includes(t));
    if (remaining.length > 0) actions.push(`Consider adding: ${remaining.join(', ')}`);
  }
  if (anyRatings && !targetHasRatings) {
    actions.push('Add aggregateRating schema for star-rich snippets (highest SERP CTR impact)');
  }
  if (anyPricing && !targetHasPricing) {
    actions.push('Add pricing schema (Product/Offer) for price-rich results');
  }
  if (!targetTypes.has('FAQPage') && competitorTypes.has('FAQPage')) {
    actions.push('Add FAQPage schema — expands your SERP real estate with accordion snippets');
  }
  if (!targetTypes.has('BreadcrumbList') && competitorTypes.has('BreadcrumbList')) {
    actions.push('Add BreadcrumbList schema — improves SERP display and navigation signals');
  }
  return actions;
}

/**
 * Schema coverage. Returns
 *   targetDomain     the domain treated as you (see resolveTargetDomain)
 *   domains          every domain with schemas, the target first, then by name
 *   types            every schema type seen, sorted
 *   counts           { [domain]: { [type]: n } } — schema objects per cell,
 *                    only cells with at least one
 *   coverageMatrix   { [domain]: [{ type, url, name, rating, ratingCount, price, currency }] },
 *                    domains and entries in row order (domain, then type)
 *   gaps             types a non-target domain has and the target lacks
 *   gapDomains       { [type]: [non-target domains using it] } for every gap
 *   exclusives       types only the target has
 *   ratings          [{ domain, url, name, rating, ratingCount }] — every row with a rating
 *   pricing          [{ domain, url, name, price, currency }] — every row with a price
 *   ratingCoverage   { target, competitors } — rating rows on each side
 *   pricingCoverage  { target, competitors } — price rows on each side
 *   actions          recommendations, strings, in the header's order
 *   summary          { totalSchemas, uniqueTypes, domainsWithSchemas, gapCount }
 * The CLI's --format json is { coverageMatrix, gaps, exclusives, ratings,
 * pricing, actions, summary } as shaped here. The harness returns the same
 * minus actions, with matrix entries cut to { type, url, name, rating, price },
 * ratings to { domain, url, rating, ratingCount } and pricing to
 * { domain, url, price, currency }.
 *
 * opts: targetDomain or config (see resolveTargetDomain).
 */
export function getSchemaCoverage(db, project, opts = {}) {
  const rows = getSchemasByProject(db, project);
  const targetDomain = resolveTargetDomain(project, opts);

  const byDomain = new Map();
  for (const row of rows) {
    if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
    byDomain.get(row.domain).push(row);
  }

  const types = [...new Set(rows.map(r => r.schema_type))].sort();
  const domains = [...byDomain.keys()].sort((a, b) => {
    if (a === targetDomain) return -1;
    if (b === targetDomain) return 1;
    return a.localeCompare(b);
  });

  const counts = Object.fromEntries([...byDomain].map(([domain, list]) => {
    const perType = new Map();
    for (const s of list) perType.set(s.schema_type, (perType.get(s.schema_type) || 0) + 1);
    return [domain, Object.fromEntries(perType)];
  }));

  const isTarget = r => r.domain === targetDomain;
  const withRatings = rows.filter(r => r.rating !== null);
  const withPricing = rows.filter(r => r.price !== null);

  const targetTypes = new Set((byDomain.get(targetDomain) || []).map(s => s.schema_type));
  const competitorTypes = new Set(rows.filter(r => !isTarget(r)).map(r => r.schema_type));
  const gaps = [...competitorTypes].filter(t => !targetTypes.has(t));
  const exclusives = [...targetTypes].filter(t => !competitorTypes.has(t));
  const gapDomains = Object.fromEntries(gaps.map(type => [
    type,
    [...new Set(rows.filter(r => r.schema_type === type && !isTarget(r)).map(r => r.domain))],
  ]));

  const targetRatings = withRatings.filter(isTarget).length;
  const targetPricing = withPricing.filter(isTarget).length;

  const actions = schemaActions({
    gaps,
    targetTypes,
    competitorTypes,
    anyRatings: withRatings.length > 0,
    targetHasRatings: targetRatings > 0,
    anyPricing: withPricing.length > 0,
    targetHasPricing: targetPricing > 0,
  });

  return {
    targetDomain,
    domains,
    types,
    counts,
    coverageMatrix: Object.fromEntries([...byDomain].map(([domain, list]) => [
      domain,
      list.map(s => ({ type: s.schema_type, url: s.url, name: s.name, rating: s.rating, ratingCount: s.rating_count, price: s.price, currency: s.currency })),
    ])),
    gaps,
    gapDomains,
    exclusives,
    ratings: withRatings.map(r => ({ domain: r.domain, url: r.url, name: r.name, rating: r.rating, ratingCount: r.rating_count })),
    pricing: withPricing.map(r => ({ domain: r.domain, url: r.url, name: r.name, price: r.price, currency: r.currency })),
    ratingCoverage: { target: targetRatings, competitors: withRatings.length - targetRatings },
    pricingCoverage: { target: targetPricing, competitors: withPricing.length - targetPricing },
    actions,
    summary: { totalSchemas: rows.length, uniqueTypes: types.length, domainsWithSchemas: byDomain.size, gapCount: gaps.length },
  };
}
