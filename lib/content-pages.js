/**
 * lib/content-pages — which crawled URLs are content a reader could be won
 * over by, and which are the product's own chrome.
 *
 * The competitor attacks (shallow, decay, headings-audit, friction, brief,
 * velocity, js-delta, and the dashboard's attack cards) all answer "what did
 * they write that you could write better". A competitor crawl also lands on
 * their sign-up form, their login wall, their swap widget and every ?ref=
 * variant of the homepage. None of those is an article anyone ranks with, and
 * left in they crowd the top of the lists: a login page is short and one click
 * from the homepage, so it reads as a Shallow Champion; a "Contact sales" form
 * reads as Friction. This filter is what keeps those lists about content.
 *
 * Why one module. The function existed three times, byte for byte — cli.js,
 * agent-harness.js and reports/generate-html.js — so the terminal, the MCP
 * tools and the dashboard agreed only for as long as nobody edited one of
 * them. When the three were compared they were still identical, so this is
 * that list unchanged, not a union or a rewrite.
 *
 * What it matches, deliberately loosely. Everything is a substring test on the
 * whole URL string, not a parsed hostname and path. The app paths come from
 * the SaaS and on-chain competitor sets the tool was first run against
 * (/swap, /portfolio, /perps and /vaults are DeFi app routes that were
 * drowning the Solana RPC comparisons). The loose match has known false
 * positives, kept because changing them changes every attack list at once and
 * belongs in its own change with its own before/after:
 *   - 'app.' matches anywhere, so a whole competitor on getapp.com, or a post
 *     at /blog/whatsapp.html, is filtered out;
 *   - '/send' also matches /sendgrid-integration, '/swap' matches
 *     /swap-fees-explained, and so on for any path that starts with an app word;
 *   - 'console.' matches a /docs/console.log-debugging page.
 * Any query string excludes the URL: on a competitor crawl a query is almost
 * always tracking or pagination, and the canonical page is crawled without it.
 */

/** Path fragments that mark an application route rather than a content page. */
export const APP_PATHS = Object.freeze([
  '/signup', '/login', '/register', '/onboarding', '/dashboard',
  '/app/', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults',
]);

/** Subdomain prefixes (with their dot) that host the product, not the marketing site. */
export const APP_SUBDOMAINS = Object.freeze(['dashboard.', 'app.', 'customers.', 'console.']);

/**
 * True when a crawled URL is content (an article, a landing page, docs) rather
 * than an app route, an auth page or a query-string variant.
 *
 * @param {string} url
 * @returns {boolean} false for anything that is not a string: pages.url is
 *                    NOT NULL, so that only happens on a caller's bug, and
 *                    "not content" is the safe answer for a filter
 */
export function isContentPage(url) {
  if (typeof url !== 'string') return false;
  if (url.includes('?')) return false;
  if (APP_PATHS.some(p => url.includes(p))) return false;
  if (APP_SUBDOMAINS.some(s => url.includes(s))) return false;
  return true;
}
