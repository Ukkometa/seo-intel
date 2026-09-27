/**
 * lib/friction — competitor pages whose visitor wanted an answer and was asked
 * to talk to sales.
 *
 * Extraction gives every page a search intent (what the visitor came for) and
 * a primary CTA (what the page asks of them). When the intent is informational
 * or commercial — reading up, comparing options — and the CTA is "Contact
 * sales", "Book a demo" or "Request access", the page makes a self-serve
 * visitor book a meeting to learn the price. Many of them leave instead. A
 * page on the same topic whose CTA is "Start free" or "View pricing" catches
 * them, and that is the whole attack: the list below is a list of topics where
 * a low-friction page has a waiting audience.
 *
 * The heuristic is two substring tests, on purpose. The CTA and the intent are
 * a small model's labels, not measurements, and a keyword list is something a
 * person can read, argue with and extend; a score would pretend to a precision
 * the labels do not have. 'sales' matches "Talk to sales" and "Contact sales";
 * 'request' matches "Request a demo" and "Request access"; 'enterprise'
 * matches "Go enterprise". Transactional and navigational pages are left out:
 * someone arriving to buy or to log in is not put off by a form.
 *
 * Why one module. The rule and its row selection lived in cli.js (friction),
 * agent-harness.js (the friction case behind find_competitor_friction) and
 * reports/generate-html.js (the Intent Friction card), and the harness copy
 * had drifted: it counted extractions with an empty intent or CTA as
 * analysed, and did not order by click depth. The CLI's selection is the one
 * kept here — an empty label is a page extraction could not read, not a page
 * that was checked, and within a competitor the shallowest pages are the ones
 * that matter, which is what the dashboard's top-15 slice shows.
 */

import { isContentPage } from './content-pages.js';

/** CTA fragments (lower case) that make a visitor talk to a person before they can try or buy. */
export const HIGH_FRICTION_CTAS = Object.freeze(['enterprise', 'sales', 'contact', 'book a demo', 'request', 'talk to']);

/** Intent fragments (lower case) of a visitor still reading or comparing, who wants to self-serve. */
export const SELF_SERVE_INTENTS = Object.freeze(['informational', 'commercial']);

/** True when a primary CTA asks the visitor to contact a person (case-insensitive substring match). */
export function isHighFrictionCta(cta) {
  const c = String(cta || '').toLowerCase();
  return HIGH_FRICTION_CTAS.some(f => c.includes(f));
}

/** True when a search intent label is informational or commercial (case-insensitive substring match). */
export function isSelfServeIntent(intent) {
  const i = String(intent || '').toLowerCase();
  return SELF_SERVE_INTENTS.some(f => i.includes(f));
}

/**
 * True when an extraction row is a friction target: a self-serve intent met by
 * a high-friction CTA.
 *
 * @param {{ search_intent?: string, cta_primary?: string }} row  an extractions row
 */
export function isFrictionTarget(row) {
  return isHighFrictionCta(row?.cta_primary) && isSelfServeIntent(row?.search_intent);
}

/**
 * Competitor content pages with both labels present, shallowest first within
 * each domain. The rows the classifier runs over and totalAnalyzed counts.
 */
function frictionCandidates(db, project) {
  return db.prepare(`
    SELECT e.search_intent, e.cta_primary, e.pricing_tier, p.url, p.word_count, d.domain
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND e.search_intent IS NOT NULL AND e.search_intent != ''
      AND e.cta_primary IS NOT NULL AND e.cta_primary != ''
    ORDER BY d.domain, p.click_depth ASC
  `).all(project).filter(r => isContentPage(r.url));
}

/**
 * Intent/CTA friction targets across a project's competitors. The shape is the
 * friction command's JSON `data` and the find_competitor_friction MCP result,
 * so the key names and their order are a contract.
 *
 * totalAnalyzed is every competitor content page with both labels; when it is
 * 0, extraction has not run (or found nothing), which is a different message
 * from "analysed, and no mismatches".
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} [opts]  none today; accepted so every attack helper has one signature
 * @returns {{
 *   targets: Array<{ url: string, domain: string, searchIntent: string, ctaPrimary: string, pricingTier: string|null, wordCount: number|null }>,
 *   totalAnalyzed: number,
 *   totalHighFriction: number,
 * }}
 */
export function findFriction(db, project, opts = {}) {
  const rows = frictionCandidates(db, project);
  const targets = rows.filter(isFrictionTarget);
  return {
    targets: targets.map(t => ({
      url: t.url,
      domain: t.domain,
      searchIntent: t.search_intent,
      ctaPrimary: t.cta_primary,
      pricingTier: t.pricing_tier,
      wordCount: t.word_count,
    })),
    totalAnalyzed: rows.length,
    totalHighFriction: targets.length,
  };
}
