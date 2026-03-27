/**
 * SEO Intel — Subdomain Discovery
 *
 * Finds subdomains for a root domain using multiple passive + active techniques.
 * No bruteforce — uses public data sources + crawl data + DNS checks.
 *
 * Methods (in order of speed/reliability):
 *   1. Certificate Transparency logs (crt.sh) — free, fast, comprehensive
 *   2. Crawl data mining — check links already in our DB for subdomains
 *   3. Common subdomain probe — check well-known subdomains (docs, api, app, etc.)
 *   4. DNS verification — confirm discovered subdomains actually resolve
 *
 * Usage:
 *   import { discoverSubdomains } from './subdomain-discovery.js';
 *   const results = await discoverSubdomains('example.com', { db });
 */

import { resolve as dnsResolve } from 'dns';
import { promisify } from 'util';
import { fetchSitemap } from './sitemap.js';

const resolveDns = promisify(dnsResolve);

// Common subdomains to probe (prioritized by SEO relevance)
const COMMON_SUBDOMAINS = [
  'www', 'docs', 'blog', 'app', 'api', 'dl', 'cdn',
  'rpc', 'status', 'dashboard', 'portal', 'help', 'support',
  'dev', 'staging', 'beta', 'shop', 'store', 'mail',
  'admin', 'auth', 'accounts', 'community', 'forum',
  'learn', 'academy', 'wiki', 'kb', 'changelog',
];

// ── Certificate Transparency (crt.sh) ─────────────────────────────────────

/**
 * Query crt.sh for all subdomains seen in SSL certificates.
 * This is the most comprehensive passive method — catches subdomains
 * that were ever issued a cert, even if they're no longer active.
 */
async function queryCrtSh(rootDomain) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const url = `https://crt.sh/?q=%25.${encodeURIComponent(rootDomain)}&output=json`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) return [];

    const data = await res.json();
    const subdomains = new Set();

    for (const entry of data) {
      const name = (entry.name_value || '').toLowerCase();
      // crt.sh returns wildcard and multi-line entries
      for (const line of name.split('\n')) {
        const cleaned = line.trim().replace(/^\*\./, '');
        if (cleaned.endsWith('.' + rootDomain) || cleaned === rootDomain) {
          subdomains.add(cleaned);
        }
      }
    }

    return [...subdomains];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Crawl Data Mining ──────────────────────────────────────────────────────

/**
 * Scan existing crawl data for links pointing to subdomains.
 * Free — uses data we already have.
 */
function mineFromCrawlData(rootDomain, db) {
  if (!db) return [];

  try {
    // Check all URLs we've seen in links table
    const rows = db.prepare(`
      SELECT DISTINCT target_url FROM links
      WHERE target_url LIKE '%${rootDomain}%'
    `).all();

    const subdomains = new Set();
    for (const row of rows) {
      try {
        const u = new URL(row.target_url);
        if (u.hostname.endsWith('.' + rootDomain) || u.hostname === rootDomain) {
          subdomains.add(u.hostname);
        }
      } catch { /* skip invalid URLs */ }
    }

    // Also check page URLs
    const pages = db.prepare(`
      SELECT DISTINCT url FROM pages
      WHERE url LIKE '%${rootDomain}%'
    `).all();

    for (const row of pages) {
      try {
        const u = new URL(row.url);
        if (u.hostname.endsWith('.' + rootDomain) || u.hostname === rootDomain) {
          subdomains.add(u.hostname);
        }
      } catch { /* skip */ }
    }

    return [...subdomains];
  } catch {
    return [];
  }
}

// ── Common Subdomain Probe ─────────────────────────────────────────────────

/**
 * Probe well-known subdomains via DNS lookup.
 * Fast — just DNS queries, no HTTP requests.
 */
async function probeCommonSubdomains(rootDomain) {
  const found = [];

  const checks = COMMON_SUBDOMAINS.map(async (sub) => {
    const hostname = `${sub}.${rootDomain}`;
    try {
      await resolveDns(hostname);
      found.push(hostname);
    } catch {
      // NXDOMAIN — doesn't exist
    }
  });

  await Promise.all(checks);
  return found;
}

// ── DNS Verification ───────────────────────────────────────────────────────

/**
 * Verify a list of hostnames actually resolve via DNS.
 * Filters out expired/dead subdomains from crt.sh results.
 */
async function verifyDns(hostnames) {
  const verified = [];

  const checks = hostnames.map(async (hostname) => {
    try {
      const addrs = await resolveDns(hostname);
      if (addrs && addrs.length > 0) {
        verified.push({ hostname, ip: addrs[0] });
      }
    } catch {
      // Dead subdomain — skip
    }
  });

  await Promise.all(checks);
  return verified;
}

// ── HTTP Liveness Check ────────────────────────────────────────────────────

/**
 * Quick HTTP check to see if a subdomain serves content.
 * Returns status code and basic page info.
 */
async function checkHttp(hostname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`https://${hostname}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOIntelBot/1.0; +https://ukkometa.fi/en/seo-intel/bot)',
      },
    });

    const finalUrl = res.url;
    const status = res.status;
    const contentType = res.headers.get('content-type') || '';
    const isHtml = contentType.includes('text/html');

    // Read just enough to check if it's a real page
    let title = null;
    if (isHtml) {
      const text = await res.text();
      const titleMatch = text.match(/<title[^>]*>([^<]+)</i);
      title = titleMatch ? titleMatch[1].trim() : null;
    }

    return {
      hostname,
      status,
      finalUrl,
      isHtml,
      title,
      redirected: new URL(finalUrl).hostname !== hostname,
      redirectTarget: new URL(finalUrl).hostname !== hostname ? new URL(finalUrl).hostname : null,
    };
  } catch (err) {
    return {
      hostname,
      status: 0,
      error: err.code || err.message || 'unknown',
      isHtml: false,
      title: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main Discovery Function ────────────────────────────────────────────────

/**
 * Discover all subdomains for a root domain.
 *
 * @param {string} rootDomain - e.g. "example.com"
 * @param {object} opts
 * @param {object} [opts.db] - SQLite database (for crawl data mining)
 * @param {boolean} [opts.httpCheck=true] - also check HTTP liveness
 * @param {function} [opts.onProgress] - callback({ phase, found, total })
 * @returns {Promise<SubdomainResult>}
 */
export async function discoverSubdomains(rootDomain, opts = {}) {
  const { db, httpCheck = true, onProgress } = opts;

  const allFound = new Set();
  const sources = {};

  // Phase 1: Certificate Transparency
  if (onProgress) onProgress({ phase: 'crt.sh', message: 'Checking certificate transparency logs...' });
  const crtResults = await queryCrtSh(rootDomain);
  for (const d of crtResults) allFound.add(d);
  sources['crt.sh'] = crtResults.length;

  // Phase 2: Crawl data mining
  if (db) {
    if (onProgress) onProgress({ phase: 'crawl-data', message: 'Mining existing crawl data...' });
    const crawlResults = mineFromCrawlData(rootDomain, db);
    for (const d of crawlResults) allFound.add(d);
    sources['crawl-data'] = crawlResults.length;
  }

  // Phase 3: Common subdomain probe
  if (onProgress) onProgress({ phase: 'dns-probe', message: 'Probing common subdomains...' });
  const probeResults = await probeCommonSubdomains(rootDomain);
  for (const d of probeResults) allFound.add(d);
  sources['dns-probe'] = probeResults.length;

  // Phase 4: DNS verification (filter dead ones from crt.sh)
  if (onProgress) onProgress({ phase: 'dns-verify', message: `Verifying ${allFound.size} subdomains via DNS...` });
  const verified = await verifyDns([...allFound]);
  const liveHostnames = new Set(verified.map(v => v.hostname));

  // Phase 5: HTTP liveness check (optional)
  let httpResults = [];
  if (httpCheck) {
    if (onProgress) onProgress({ phase: 'http-check', message: `Checking HTTP on ${liveHostnames.size} live subdomains...` });

    // Check in batches of 5 to not overwhelm
    const liveList = [...liveHostnames];
    for (let i = 0; i < liveList.length; i += 5) {
      const batch = liveList.slice(i, i + 5);
      const results = await Promise.all(batch.map(h => checkHttp(h)));
      httpResults.push(...results);
    }
  }

  // Phase 6: Sitemap check — get page counts for SEO-relevant subdomains
  const sitemapResults = new Map();
  const seoLive = httpResults.filter(r => r.isHtml && r.status === 200 && !r.redirected);

  if (seoLive.length > 0) {
    if (onProgress) onProgress({ phase: 'sitemaps', message: `Checking sitemaps on ${seoLive.length} live subdomains...` });

    // Check sitemaps in batches of 3
    for (let i = 0; i < seoLive.length; i += 3) {
      const batch = seoLive.slice(i, i + 3);
      const results = await Promise.all(batch.map(async (r) => {
        try {
          const urls = await fetchSitemap(`https://${r.hostname}`);
          return { hostname: r.hostname, urls };
        } catch {
          return { hostname: r.hostname, urls: [] };
        }
      }));
      for (const r of results) sitemapResults.set(r.hostname, r.urls);
    }
    sources['sitemaps'] = [...sitemapResults.values()].reduce((sum, urls) => sum + urls.length, 0);
  }

  // Build final result
  const subdomains = [...liveHostnames].sort().map(hostname => {
    const http = httpResults.find(r => r.hostname === hostname) || {};
    const dns = verified.find(v => v.hostname === hostname) || {};
    const isRoot = hostname === rootDomain;
    const sub = isRoot ? '(root)' : hostname.replace('.' + rootDomain, '');
    const sitemap = sitemapResults.get(hostname) || [];

    return {
      hostname,
      subdomain: sub,
      isRoot,
      ip: dns.ip || null,
      httpStatus: http.status || null,
      title: http.title || null,
      isHtml: http.isHtml || false,
      redirected: http.redirected || false,
      redirectTarget: http.redirectTarget || null,
      error: http.error || null,
      sitemapUrls: sitemap.length,
      sitemapSample: sitemap.slice(0, 5).map(u => u.url || u),
      // SEO relevance score
      seoRelevant: http.isHtml && http.status === 200 && !http.redirected,
    };
  });

  // Total sitemap URLs across all subdomains
  const totalSitemapUrls = subdomains.reduce((sum, s) => sum + s.sitemapUrls, 0);

  return {
    rootDomain,
    discovered: subdomains.length,
    live: subdomains.filter(s => s.httpStatus === 200).length,
    seoRelevant: subdomains.filter(s => s.seoRelevant).length,
    totalSitemapUrls,
    sources,
    subdomains,
  };
}
