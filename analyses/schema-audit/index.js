/**
 * Schema Specificity Audit
 *
 * Most schema tooling checks whether markup *exists*. This checks whether the
 * type is the right one and whether it carries the fields Google actually
 * requires for the rich result that type claims.
 *
 * Two failures show up constantly and neither is caught by a coverage check:
 *
 *   1. `Product` with no priced `offers`. Google's Product rich result needs
 *      `offers`, `review`, or `aggregateRating`; `offers` in turn needs `price`
 *      and `priceCurrency`. Markup without them is ignored at best and reported
 *      in Search Console at worst.
 *   2. `Product` on an API, docs, dashboard, or app surface. Software is not a
 *      product listing — `SoftwareApplication` / `WebApplication` is the typed
 *      match, and it is what earns app rich results.
 *
 * Reads the crawl DB only. No network, no model.
 */

import { upsertInsights } from '../../db/db.js';

// Documentation surfaces only. Deliberately NOT api./rpc./app. bare hosts: a
// company that sells an API commonly puts its commercial lander on api.example
// .com, and Product is the right type there. Judging by hostname alone flagged
// those real product pages as mistyped.
const DOCS_HOST_RE = /^(?:docs?|developer|developers|reference|sandbox|status)\./i;
const DOCS_PATH_RE = /^\/(?:docs?|developer|developers|reference|api-reference|sdk|playground|guides?)(?:\/|$)/i;

// Commercial intent on the page itself. Any of these means the page is selling
// something, so Product/Offer markup is appropriate regardless of where it lives.
const COMMERCIAL_RE = /\b(?:pricing|price|per month|\/mo\b|free tier|subscribe|subscription|plan|plans|billing|buy now|start free|upgrade|checkout)\b|[$€£]\s?\d/i;

const PRODUCT_TYPES = new Set(['Product', 'IndividualProduct', 'ProductModel']);
const SOFTWARE_TYPES = new Set(['SoftwareApplication', 'WebApplication', 'MobileApplication', 'WebAPI']);

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function typesOf(raw) {
  const v = raw?.['@type'];
  return (Array.isArray(v) ? v : v ? [v] : []).filter(t => typeof t === 'string');
}

/** Google accepts a single offer object or an array; normalize both. */
function offersOf(raw) {
  const o = raw?.offers;
  if (!o) return [];
  return (Array.isArray(o) ? o : [o]).filter(x => x && typeof x === 'object');
}

function hasUsablePrice(offer) {
  const p = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
  if (p === undefined || p === null || p === '') return false;
  // "0" is a legitimate price for a free tier — only a missing value is a fault.
  return Number.isFinite(Number(p));
}

/**
 * A page is a documentation surface only when it looks like docs *and* shows no
 * sign of selling anything. Both halves matter: a pricing page under /docs/ is
 * still commercial, and an API lander on api.* is still a product.
 */
function isDocumentationSurface(url, body) {
  let looksLikeDocs = false;
  try {
    const u = new URL(url);
    looksLikeDocs = DOCS_HOST_RE.test(u.hostname) || DOCS_PATH_RE.test(u.pathname);
  } catch { return false; }
  if (!looksLikeDocs) return false;
  return !COMMERCIAL_RE.test(body || '');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 */
export function runSchemaAudit(db, project, opts = {}) {
  const rows = db.prepare(`
    SELECT ps.raw_json, ps.schema_type, p.url, p.title, p.body_text
    FROM page_schemas ps
    JOIN pages p ON p.id = ps.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
    ORDER BY p.url
  `).all(project);

  const issues = [];
  const seen = new Set();
  let productBlocks = 0;
  let softwareBlocks = 0;

  for (const row of rows) {
    const raw = parseJson(row.raw_json);
    if (!raw) continue;
    const types = typesOf(raw);
    const isProduct = types.some(t => PRODUCT_TYPES.has(t));
    const isSoftware = types.some(t => SOFTWARE_TYPES.has(t));
    if (!isProduct && !isSoftware) continue;

    // One page can repeat the same block under several URL spellings.
    const key = `${row.url.replace(/\/+$/, '').toLowerCase()}::${types.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isProduct) productBlocks++;
    if (isSoftware) softwareBlocks++;

    const offers = offersOf(raw);
    const priced = offers.filter(hasUsablePrice);
    const hasRatingOrReview = !!(raw.aggregateRating || raw.review);
    const docsSurface = isDocumentationSurface(row.url, row.body_text);
    const push = (severity, code, message, fix) =>
      issues.push({ severity, code, url: row.url, schemaType: types.join(', '), message, fix });

    if (isProduct && docsSurface) {
      push('warning', 'product_on_docs_page',
        `${types.join(', ')} markup on a documentation page with no pricing or purchase signals. Google reads this as a purchasable item, which reference material is not.`,
        'Use TechArticle for reference content, or SoftwareApplication if the page really does describe the product itself.');
    }

    if (isProduct && !priced.length && !hasRatingOrReview) {
      push('error', 'product_without_offers',
        'Product markup carries no priced offers, aggregateRating, or review. Google needs at least one of these, so this block earns no rich result.',
        'Add offers with price and priceCurrency (price "0" is valid for a free tier), or drop the Product type if nothing is being sold.');
    }

    if (offers.length && !priced.length) {
      push('error', 'offers_without_price',
        'An offers block is present but has no parseable price.',
        'Set offers.price to a number and offers.priceCurrency to an ISO 4217 code such as EUR.');
    }

    for (const offer of priced) {
      if (!offer.priceCurrency && !offer.priceSpecification?.priceCurrency) {
        push('error', 'offers_missing_currency',
          'offers.price is set without priceCurrency, which Search Console reports as invalid.',
          'Add offers.priceCurrency (ISO 4217, for example "EUR").');
        break;
      }
    }

    if (isSoftware && !priced.length && !hasRatingOrReview) {
      push('warning', 'software_without_offers',
        'SoftwareApplication markup has no offers or rating, so it is not eligible for the app rich result.',
        'Add offers with price "0" for a free tier, and aggregateRating once you have genuine ratings.');
    }
  }

  if (!opts.skipLedger) {
    upsertInsights(db, project, 'schema_specificity', issues.map(i => ({
      fingerprint: `${i.code}::${i.url.toLowerCase().replace(/\/+$/, '')}`,
      data: { url: i.url, code: i.code, severity: i.severity, schemaType: i.schemaType, message: i.message, recommendation: i.fix },
    })));
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  return {
    project,
    status: errors ? 'fail' : issues.length ? 'needs_work' : 'pass',
    issues,
    summary: {
      productBlocks,
      softwareBlocks,
      errors,
      warnings: issues.filter(i => i.severity === 'warning').length,
      affectedUrls: new Set(issues.map(i => i.url)).size,
    },
  };
}
