/**
 * Light crawler — fetch-based, zero-browser, zero-config, zero-signup.
 *
 * The "crawl for all Claude users" path: point it at a URL and it BFS-crawls
 * same-origin pages with plain HTTP fetch (no Playwright, no browser download),
 * returns structured SEO/AEO data entirely in memory. Nothing is persisted,
 * nothing leaves the machine, no account required.
 *
 * Deliberately NOT a "massive crawl environment":
 *   - small page budget (default 10, hard cap 50)
 *   - same-origin only by default
 *   - honours robots.txt + crawl-delay (no tricks)
 *   - no JS rendering (use the full Playwright crawler for JS-heavy sites)
 *
 * For deep, persistent, JS-rendered crawls of a configured project, use the
 * heavyweight crawler (`crawler/index.js` via `seo-intel crawl`).
 */

import fetch from 'node-fetch';
import { checkRobots } from './robots.js';
import { extractPageData } from './html-extract.js';
import { scorePage } from '../analyses/aeo/scorer.js';

const HARD_CAP = 50;
const DEFAULT_UA = 'SEOIntelBot (+https://ukkometa.fi/seo-intel; light-crawl)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeStart(url) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).toString();
}

// Same-site key: hostname minus a leading "www." (and protocol-agnostic), so
// http↔https and www↔non-www redirects don't break same-origin link following.
function siteKey(u) {
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return null; }
}

/**
 * @param {string} startUrl
 * @param {object} [opts]
 * @param {number} [opts.maxPages=10]      pages to fetch (clamped to HARD_CAP)
 * @param {boolean} [opts.sameOrigin=true] only follow links on the start origin
 * @param {boolean} [opts.includeCitability=false] run the AEO scorer per page
 * @param {boolean} [opts.respectRobots=true] honour robots.txt + crawl-delay
 * @param {number} [opts.timeoutMs=10000]  per-request timeout
 * @param {number} [opts.maxDelayMs=3000]  cap on politeness delay between requests
 * @param {(msg:string)=>void} [opts.onProgress]
 * @returns {Promise<object>} { start, origin, pages, skipped, stats }
 */
export async function lightCrawl(startUrl, opts = {}) {
  const {
    maxPages = 10,
    sameOrigin = true,
    includeCitability = false,
    respectRobots = true,
    timeoutMs = 10000,
    maxDelayMs = 3000,
    onProgress,
  } = opts;

  const budget = Math.max(1, Math.min(maxPages, HARD_CAP));
  let start;
  try { start = normalizeStart(startUrl); } catch { throw new Error(`Invalid URL: ${startUrl}`); }
  const origin = new URL(start).origin;

  const siteRoot = siteKey(start);
  const queue = [start];
  const queued = new Set([start]);
  const visited = new Set();   // FINAL (post-redirect) URLs actually processed
  const pages = [];
  const skipped = [];
  const t0 = Date.now();

  while (queue.length && pages.length < budget) {
    const url = queue.shift();

    if (respectRobots) {
      let robot;
      try { robot = await checkRobots(url); } catch { robot = { allowed: true, crawlDelayMs: 0 }; }
      if (!robot.allowed) { skipped.push({ url, reason: 'robots_disallow' }); continue; }
    }

    let res, finalUrl = url, status = 0, html = '';
    try {
      res = await fetch(url, { timeout: timeoutMs, redirect: 'follow', headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml' } });
      status = res.status;
      finalUrl = res.url || url;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && ct.includes('html')) {
        html = await res.text();
      } else {
        skipped.push({ url, reason: res.ok ? `non_html (${ct || 'unknown'})` : `http_${status}`, status });
        continue;
      }
    } catch (e) {
      skipped.push({ url, reason: `fetch_error: ${e.message}` });
      continue;
    }

    // Dedupe on the FINAL url — a redirect may collapse onto a page we already
    // crawled (e.g. non-www start → www, then the page's own www self-link).
    if (visited.has(finalUrl)) continue;
    visited.add(finalUrl);
    queued.add(finalUrl);

    const data = extractPageData(html, finalUrl);
    data.status_code = status;

    if (includeCitability) {
      try {
        const cite = scorePage(
          { url: data.url, title: data.title, body_text: data.body_text, word_count: data.word_count, published_date: data.published_date, modified_date: data.modified_date },
          data.headings, [], data.schema_types, [], null
        );
        data.citability = { score: cite.score, tier: cite.tier, breakdown: cite.breakdown, ai_intents: cite.aiIntents };
      } catch (e) {
        data.citability = { error: e.message };
      }
    }

    pages.push(data);
    if (onProgress) onProgress(`[${pages.length}/${budget}] ${finalUrl} (${status}, ${data.word_count}w)`);

    // Enqueue internal links for BFS
    if (pages.length < budget) {
      for (const link of data.links) {
        if (!link.href || !/^https?:/i.test(link.href)) continue;
        if (queued.has(link.href)) continue;
        if (sameOrigin && siteKey(link.href) !== siteRoot) continue;
        // skip obvious non-page assets
        if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp4|woff2?|ttf)(\?|$)/i.test(link.href)) continue;
        queued.add(link.href);
        queue.push(link.href);
      }
    }

    // Politeness delay between requests (honour robots crawl-delay, capped)
    if (queue.length && pages.length < budget && respectRobots) {
      let delay = 0;
      try { delay = (await checkRobots(url)).crawlDelayMs || 0; } catch { delay = 0; }
      if (delay) await sleep(Math.min(delay, maxDelayMs));
    }
  }

  const indexable = pages.filter(p => p.is_indexable).length;
  const withSchema = pages.filter(p => p.schema_types.length).length;
  const missingTitle = pages.filter(p => !p.title).length;
  const missingMeta = pages.filter(p => !p.meta_desc).length;

  return {
    start,
    origin,
    pages,
    skipped,
    stats: {
      crawled: pages.length,
      skipped: skipped.length,
      queued_unvisited: Math.max(0, queue.length),
      indexable,
      with_schema: withSchema,
      missing_title: missingTitle,
      missing_meta_desc: missingMeta,
      elapsed_ms: Date.now() - t0,
    },
  };
}
