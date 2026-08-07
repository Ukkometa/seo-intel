/**
 * SEO Intel — URL normalization
 *
 * Two different jobs, deliberately kept as two functions, because conflating
 * them is what caused the fragment-pages and phantom-orphans bugs:
 *
 *   stripFragment() — "what should I fetch, and is it the same resource?"
 *                     Used by the crawler before queueing. Conservative: only
 *                     the fragment is removed, because everything else
 *                     (query, case, trailing slash) can genuinely change what
 *                     the server returns.
 *
 *   pageKey()       — "do this link and this crawled page refer to the same
 *                     thing?" Used when matching links against pages. Lossy on
 *                     purpose, and never used to decide what to fetch or what
 *                     to store.
 */

/**
 * Remove the fragment from a URL.
 *
 * A fragment identifies a position inside a document, not a separate document:
 * `/pricing` and `/pricing#faq` are one page and one HTTP request. Treating
 * them as two inflates page counts, scores the same document repeatedly, and
 * makes real pages look like orphans because inbound links land on the anchor
 * variant instead of the page.
 *
 * Everything else is preserved. `?page=2` really is a different page, and some
 * servers are case- or trailing-slash-sensitive.
 *
 * @param {string} url
 * @returns {string} the URL without its fragment, or the input unchanged if it
 *                   cannot be parsed (callers already tolerate odd URLs)
 */
export function stripFragment(url) {
  if (typeof url !== 'string' || url === '') return url;
  const i = url.indexOf('#');
  // No fragment: return the input byte-for-byte. Deliberately NOT round-tripped
  // through new URL(), which would rewrite `https://example.com` to
  // `https://example.com/` and strand the rows an earlier crawl already wrote
  // under the un-normalized form.
  if (i === -1) return url;
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/#$/, '');
  } catch {
    // Relative or malformed — a textual cut still gives the caller
    // fragment-free input.
    return url.slice(0, i);
  }
}

/**
 * Collapse a URL to a comparison key for link/page matching.
 *
 * Normalizes the things that routinely differ between how a link is written
 * and how a page was crawled, while keeping the things that change content:
 *
 *   dropped  — fragment, `www.` prefix, protocol, trailing slash, host case,
 *              a trailing `index.html` / `index.htm` / `index.php`
 *   kept     — path case, query string
 *
 * Protocol is dropped so an `http://` link to an `https://` page still
 * resolves; for link-graph purposes they are the same destination. Path case
 * is kept because many servers are case-sensitive on the path.
 *
 * Only ever use this for comparison. Never store it, fetch it, or show it.
 *
 * @param {string} url
 * @returns {string|null} the key, or null if the URL cannot be parsed
 */
export function pageKey(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    // A directory index is the directory: /en/index.html and /en/ are one page,
    // and sites routinely link to both.
    const path = u.pathname
      .replace(/\/index\.(html?|php)$/i, '/')
      .replace(/\/+$/, '') || '/';
    return host + path + u.search;
  } catch {
    return null;
  }
}

/**
 * Build a lookup from crawled pages to their ids, keyed by pageKey().
 *
 * Later rows do not overwrite earlier ones, so when a `www` and a non-`www`
 * row collapse to the same key the first (lowest click depth, per the usual
 * ORDER BY) wins and the graph gets one node instead of two.
 *
 * @param {Array<{id: number, url: string}>} pages
 * @returns {Map<string, number>} key → page id
 */
export function buildPageKeyIndex(pages) {
  const index = new Map();
  for (const p of pages) {
    const key = pageKey(p.url);
    if (key && !index.has(key)) index.set(key, p.id);
  }
  return index;
}

/**
 * Collapse page rows that describe the same real page into one node.
 *
 * Several rows can refer to one page: `www` and non-`www` variants, `/x/` and
 * `/x/index.html`, and — in databases written before fragment stripping landed
 * — one row per `#anchor`. Left separate, each becomes a graph node, the
 * inbound links all land on whichever variant a link happened to be written
 * against, and every other variant is reported as an orphan.
 *
 * Accepts either a `depth` or a `click_depth` field.
 *
 * @param {Array<object>} pages rows with at least { id, url }
 * @param {(winner: object, loser: object) => void} [onMerge]
 *        called when two rows collapse, so the caller can rescue fields off
 *        the discarded row (a score, a title) before it is dropped
 * @returns {{ merged: object[], idToCanonical: Map<number, object>, keyToId: Map<string, number> }}
 */
export function canonicalizePages(pages, onMerge) {
  const depthOf = (p) => (p.depth ?? p.click_depth ?? 0);
  const byKey = new Map();
  const idToCanonical = new Map();

  for (const p of pages) {
    const key = pageKey(p.url);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, p);
      idToCanonical.set(p.id, p);
      continue;
    }
    // Pick the variant a human would call the real URL: fragment-free first,
    // then the configured target domain over an alias, then the shallower
    // page, then the shorter URL (which picks /en/ over /en/index.html).
    const better = (() => {
      const curFrag = current.url.includes('#');
      const pFrag = p.url.includes('#');
      if (curFrag !== pFrag) return curFrag;
      if (current.role !== p.role) return p.role === 'target';
      if (depthOf(p) !== depthOf(current)) return depthOf(p) < depthOf(current);
      return p.url.length < current.url.length;
    })();
    const winner = better ? p : current;
    const loser = better ? current : p;
    if (onMerge) onMerge(winner, loser);
    byKey.set(key, winner);
    idToCanonical.set(p.id, winner);
    idToCanonical.set(current.id, winner);
  }

  // Re-point every merged id at the final winner for its key: a row merged
  // early may have lost to a row that only appeared later.
  for (const [id, node] of idToCanonical) {
    const key = pageKey(node.url);
    if (key && byKey.has(key)) idToCanonical.set(id, byKey.get(key));
  }

  const merged = [...new Set(byKey.values())];
  const keyToId = new Map([...byKey].map(([k, n]) => [k, n.id]));
  return { merged, idToCanonical, keyToId };
}

/** Endpoints nothing is supposed to link to, so never flag them as orphans. */
export const NON_NAVIGABLE_RE = /\.(txt|md|json|xml|rss|atom|csv|ya?ml)$/i;

/**
 * True when a URL is a navigable page rather than a machine-readable endpoint
 * (llms.txt, skill.md, feeds, sitemaps). Reporting those as orphans hands the
 * user a fix instruction they should ignore.
 */
export function isNavigable(url) {
  try {
    return !NON_NAVIGABLE_RE.test(new URL(url).pathname);
  } catch {
    return !NON_NAVIGABLE_RE.test(String(url));
  }
}
