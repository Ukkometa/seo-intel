/**
 * Sitemap.xml fetcher + parser
 * Discovers URLs from sitemap before link-following begins.
 */

import fetch from 'node-fetch';

const SITEMAP_TIMEOUT = 10000;

/**
 * Fetch and parse sitemap.xml for a domain.
 * Handles sitemap index files (multiple sitemaps) and regular sitemaps.
 * Returns array of { url, lastmod? } objects.
 */
export async function fetchSitemap(startUrl) {
  const base = new URL(startUrl);
  const sitemapUrls = [
    `${base.origin}/sitemap.xml`,
    `${base.origin}/sitemap_index.xml`,
    `${base.origin}/sitemap-index.xml`,
  ];

  const allUrls = [];
  const seen = new Set();

  for (const sitemapUrl of sitemapUrls) {
    try {
      const urls = await parseSitemapUrl(sitemapUrl, base.hostname, seen);
      allUrls.push(...urls);
      if (urls.length > 0) break; // found a working sitemap
    } catch {
      continue;
    }
  }

  return allUrls;
}

async function parseSitemapUrl(url, hostname, seen, depth = 0) {
  if (depth > 2 || seen.has(url)) return []; // prevent infinite recursion
  seen.add(url);

  let text;
  try {
    const res = await fetch(url, {
      timeout: SITEMAP_TIMEOUT,
      headers: { 'User-Agent': 'SEOIntelBot/1.0' },
    });
    if (!res.ok) return [];
    text = await res.text();
  } catch {
    return [];
  }

  // Check if it's a sitemap index (contains <sitemap> tags)
  if (text.includes('<sitemap>') || text.includes('<sitemapindex')) {
    const childUrls = extractTagContent(text, 'loc');
    const results = [];
    for (const childUrl of childUrls.slice(0, 20)) { // max 20 child sitemaps
      const childResults = await parseSitemapUrl(childUrl, hostname, seen, depth + 1);
      results.push(...childResults);
    }
    return results;
  }

  // Regular sitemap — extract <url> entries
  const urls = [];
  const locs = extractTagContent(text, 'loc');
  const lastmods = extractTagContent(text, 'lastmod');

  for (let i = 0; i < locs.length; i++) {
    const loc = locs[i];
    try {
      const parsed = new URL(loc);
      // Only include URLs from the same hostname
      if (parsed.hostname !== hostname) continue;
      // Skip non-page resources
      if (/\.(pdf|png|jpg|jpeg|gif|svg|css|js|woff|ico|xml)$/i.test(parsed.pathname)) continue;

      urls.push({
        url: parsed.href,
        lastmod: lastmods[i] || null,
      });
    } catch {
      continue;
    }
  }

  return urls;
}

/**
 * Simple XML tag content extractor (no full XML parser needed).
 */
function extractTagContent(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]+)</${tagName}>`, 'gi');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/**
 * HEAD-check a single URL without following redirects.
 * Returns { status, location } — location is the Location header when 3XX.
 * Never throws — errors return { status: 0, error: msg }.
 */
export async function headCheck(url, { timeoutMs = 8000 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'SEOIntelBot/1.0' },
    }).finally(() => clearTimeout(t));
    return {
      status: res.status,
      location: res.headers.get('location') || null,
    };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

/**
 * Run HEAD checks against an array of sitemap URL rows in parallel (capped).
 * Accepts [{ id, url }]. Invokes onResult(row, result) per check.
 */
export async function headCheckAll(rows, { concurrency = 6, onResult } = {}) {
  const queue = [...rows];
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      const result = await headCheck(row.url);
      if (onResult) {
        try { await onResult(row, result); } catch { /* swallow */ }
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(workers);
}
