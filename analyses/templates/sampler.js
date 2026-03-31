/**
 * Smart Sample Selection & Stealth Crawl — Phase 2
 *
 * Selects a strategic sample from each template group,
 * then stealth-crawls those pages for content analysis.
 */

import { createHash } from 'crypto';
import { domFingerprint } from './similarity.js';

/**
 * Select which URLs to crawl from a group.
 * Pure function — no I/O.
 *
 * Strategy:
 *   - high-value: shortest paths (likely most important)
 *   - middle: middle of sorted list
 *   - long-tail: longest paths (most specific/obscure)
 *   - random: random picks across the full list
 *
 * @param {string[]} urls
 * @param {number} sampleSize — default 20
 * @returns {{ url: string, role: string }[]}
 */
export function selectSample(urls, sampleSize = 20) {
  if (urls.length <= sampleSize) {
    return urls.map(url => ({ url, role: 'all' }));
  }

  // Sort by path length (shorter = likely higher value)
  const sorted = [...urls].sort((a, b) => {
    const pathA = new URL(a).pathname;
    const pathB = new URL(b).pathname;
    return pathA.length - pathB.length || pathA.localeCompare(pathB);
  });

  const used = new Set();
  const result = [];

  const nHighValue = Math.ceil(sampleSize * 0.30);
  const nMiddle = Math.ceil(sampleSize * 0.25);
  const nLongTail = Math.ceil(sampleSize * 0.25);

  // High-value: top of sorted (shortest paths)
  for (let i = 0; i < sorted.length && result.length < nHighValue; i++) {
    if (!used.has(sorted[i])) {
      result.push({ url: sorted[i], role: 'high-value' });
      used.add(sorted[i]);
    }
  }

  // Middle: around the center
  const mid = Math.floor(sorted.length / 2);
  const midStart = Math.max(0, mid - Math.floor(nMiddle / 2));
  for (let i = midStart; i < sorted.length && result.filter(r => r.role === 'middle').length < nMiddle; i++) {
    if (!used.has(sorted[i])) {
      result.push({ url: sorted[i], role: 'middle' });
      used.add(sorted[i]);
    }
  }

  // Long-tail: bottom of sorted (longest paths)
  for (let i = sorted.length - 1; i >= 0 && result.filter(r => r.role === 'long-tail').length < nLongTail; i--) {
    if (!used.has(sorted[i])) {
      result.push({ url: sorted[i], role: 'long-tail' });
      used.add(sorted[i]);
    }
  }

  // Random: fill remainder
  const remaining = sampleSize - result.length;
  const unused = sorted.filter(u => !used.has(u));
  // Fisher-Yates shuffle
  for (let i = unused.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unused[i], unused[j]] = [unused[j], unused[i]];
  }
  for (let i = 0; i < Math.min(remaining, unused.length); i++) {
    result.push({ url: unused[i], role: 'random' });
  }

  return result;
}

/**
 * Stealth-crawl a sample of URLs from a template group.
 *
 * @param {{ url: string, role: string }[]} sample — from selectSample()
 * @param {object} opts
 * @param {string} opts.hostname — for session persistence
 * @param {Function} opts.onPage — (result, index, total) => void
 * @returns {Promise<SampleResult[]>}
 */
export async function crawlSample(sample, opts = {}) {
  const { getStealthConfig, STEALTH_INIT_SCRIPT, applyStealthRoutes } = await import('../../crawler/stealth.js');
  const { chromium } = await import('playwright');

  const stealthCfg = getStealthConfig();
  const browser = await chromium.launch({ headless: true, ...stealthCfg.launchArgs });
  const context = await browser.newContext(stealthCfg.contextOpts);
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  await applyStealthRoutes(context);

  const results = [];

  try {
    for (let i = 0; i < sample.length; i++) {
      const { url, role } = sample[i];
      const result = await crawlSinglePage(context, url, role);
      results.push(result);

      if (opts.onPage) opts.onPage(result, i, sample.length);

      // Jittered delay: 2-4s
      if (i < sample.length - 1) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

/**
 * Crawl a single page and extract template analysis fields.
 */
async function crawlSinglePage(context, url, role) {
  const page = await context.newPage();
  const result = {
    url,
    sampleRole: role,
    statusCode: 0,
    wordCount: 0,
    title: '',
    metaDesc: '',
    hasCanonical: false,
    hasSchema: false,
    isIndexable: true,
    domFingerprintStr: '',
    contentHash: '',
    bodyText: '',
    crawledAt: Date.now(),
  };

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    result.statusCode = response?.status() || 0;

    if (result.statusCode >= 400) {
      await page.close();
      return result;
    }

    // Wait for dynamic content
    await page.waitForTimeout(2000);

    // Extract page data
    const data = await page.evaluate(() => {
      const title = document.title || '';
      const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
      const canonical = document.querySelector('link[rel="canonical"]');
      const hasCanonical = !!canonical;
      const hasSchema = !!document.querySelector('script[type="application/ld+json"]');

      // Indexability: check robots meta
      const robotsMeta = document.querySelector('meta[name="robots"]')?.content || '';
      const isIndexable = !robotsMeta.includes('noindex');

      // Body text
      const bodyText = document.body?.innerText || '';
      const wordCount = bodyText.split(/\s+/).filter(w => w.length > 1).length;

      return { title, metaDesc, hasCanonical, hasSchema, isIndexable, bodyText, wordCount };
    });

    result.title = data.title;
    result.metaDesc = data.metaDesc;
    result.hasCanonical = data.hasCanonical;
    result.hasSchema = data.hasSchema;
    result.isIndexable = data.isIndexable;
    result.wordCount = data.wordCount;
    // Cap body text at 5000 chars for similarity computation
    result.bodyText = data.bodyText.slice(0, 5000);
    result.contentHash = createHash('sha256').update(data.bodyText).digest('hex').slice(0, 16);

    // DOM fingerprint
    result.domFingerprintStr = await domFingerprint(page);

  } catch (err) {
    // Page failed — result stays with defaults (statusCode 0)
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}
