import { chromium } from 'playwright';
import { sanitize, extractSelective } from './sanitize.js';
import { checkRobots, getCrawlDelay } from './robots.js';

const CRAWL_DELAY  = parseInt(process.env.CRAWL_DELAY_MS  || '1500');
const MAX_PAGES    = parseInt(process.env.CRAWL_MAX_PAGES  || '50');
const MAX_DEPTH    = parseInt(process.env.CRAWL_MAX_DEPTH  || '3');   // BFS depth limit
const TIMEOUT      = parseInt(process.env.CRAWL_TIMEOUT_MS || '15000');

/**
 * Crawl a domain and return structured page data.
 * @param {string} startUrl - e.g. 'https://helius.dev'
 * @param {object} opts
 * @returns {AsyncGenerator<PageData>}
 */
export async function* crawlDomain(startUrl, opts = {}) {
  const base = new URL(startUrl);
  const visited = new Set();
  // BFS queue: each entry carries {url, depth}
  const queue = [{ url: startUrl, depth: 0 }];
  let count = 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; SEOIntelBot/1.0; +https://carbium.io/bot)',
    ignoreHTTPSErrors: true,
  });

  try {
    while (queue.length > 0 && count < MAX_PAGES) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      // Respect robots.txt before fetching
      const { allowed, crawlDelayMs } = await checkRobots(url);
      if (!allowed) {
        console.log(`[robots] Skipping disallowed: ${url}`);
        continue;
      }

      const page = await context.newPage();
      const t0 = Date.now();
      let status = 0;

      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        status = res?.status() || 0;
        const loadMs = Date.now() - t0;

        if (status >= 400) {
          await page.close();
          continue;
        }

        // --- Extract structured data ---
        const title       = await page.title().catch(() => '');
        const metaDesc    = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
        const canonical   = await page.$eval('link[rel="canonical"]', el => el.href).catch(() => '');
        const ogTags      = await page.$$eval('meta[property^="og:"]', els =>
          Object.fromEntries(els.map(e => [e.getAttribute('property'), e.getAttribute('content')]))).catch(() => ({}));

        // Headings
        const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els =>
          els.map(el => ({ level: parseInt(el.tagName[1]), text: el.innerText?.trim().slice(0, 200) }))
            .filter(h => h.text)
        ).catch(() => []);

        // Links
        const links = await page.$$eval('a[href]', (els, base) =>
          els.map(el => {
            try {
              const abs = new URL(el.href, base).href;
              return { url: abs, anchor: el.innerText?.trim().slice(0, 100) || '' };
            } catch { return null; }
          }).filter(Boolean),
          base.href
        ).catch(() => []);

        // Internal vs external
        const internalLinks = links
          .filter(l => { try { return new URL(l.url).hostname === base.hostname; } catch { return false; } })
          .map(l => ({ ...l, isInternal: true }));
        const externalLinks = links
          .filter(l => { try { return new URL(l.url).hostname !== base.hostname; } catch { return false; } })
          .map(l => ({ ...l, isInternal: false }));

        // Body text (for extraction)
        const bodyText = await extractSelective(page, ['h1','h2','h3','p','li','span.hero','div.tagline']);

        // Schema markup
        const schemaTypes = await page.$$eval('script[type="application/ld+json"]', els => {
          const types = [];
          for (const el of els) {
            try { const d = JSON.parse(el.textContent); types.push(d['@type']); } catch {}
          }
          return types.filter(Boolean);
        }).catch(() => []);

        // Core Web Vitals (Playwright can measure LCP via PerformanceObserver)
        const vitals = await page.evaluate(() => {
          return new Promise(resolve => {
            let lcp = null;
            try {
              new PerformanceObserver(list => {
                const entries = list.getEntries();
                lcp = entries.at(-1)?.startTime || null;
              }).observe({ type: 'largest-contentful-paint', buffered: true });
            } catch {}
            setTimeout(() => resolve({ lcp }), 500);
          });
        }).catch(() => ({}));

        // Word count
        const wordCount = await page.$eval('body', el =>
          el.innerText.split(/\s+/).filter(Boolean).length
        ).catch(() => 0);

        // Robots / noindex check
        const robotsMeta = await page.$eval('meta[name="robots"]', el => el.content).catch(() => '');
        const isIndexable = !robotsMeta.toLowerCase().includes('noindex');

        // Extract published / modified dates from meta tags and JSON-LD
        const publishedDate = await page.evaluate(() => {
          const metas = [
            'meta[property="article:published_time"]',
            'meta[name="date"]',
            'meta[name="pubdate"]',
            'meta[itemprop="datePublished"]',
          ];
          for (const sel of metas) {
            const el = document.querySelector(sel);
            if (el?.content) return el.content;
          }
          // JSON-LD fallback
          for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const d = JSON.parse(el.textContent);
              if (d.datePublished) return d.datePublished;
            } catch {}
          }
          return null;
        }).catch(() => null);

        const modifiedDate = await page.evaluate(() => {
          const metas = [
            'meta[property="article:modified_time"]',
            'meta[name="last-modified"]',
            'meta[itemprop="dateModified"]',
          ];
          for (const sel of metas) {
            const el = document.querySelector(sel);
            if (el?.content) return el.content;
          }
          for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const d = JSON.parse(el.textContent);
              if (d.dateModified) return d.dateModified;
            } catch {}
          }
          return null;
        }).catch(() => null);

        // Queue new internal URLs (BFS — only if within depth limit)
        if (depth < MAX_DEPTH) {
          for (const link of internalLinks) {
            try {
              const u = new URL(link.url);
              // Skip non-HTML resources
              if (/\.(pdf|png|jpg|jpeg|gif|svg|css|js|woff|ico)$/i.test(u.pathname)) continue;
              const alreadyQueued = queue.some(q => q.url === link.url);
              if (!visited.has(link.url) && !alreadyQueued) {
                queue.push({ url: link.url, depth: depth + 1 });
              }
            } catch {}
          }
        }

        count++;
        yield {
          url,
          depth,
          status,
          loadMs,
          wordCount,
          isIndexable,
          title,
          metaDesc,
          canonical,
          ogTags,
          headings,
          links: [...internalLinks, ...externalLinks],
          bodyText: sanitize(bodyText, 2000),
          schemaTypes,
          vitals,
          publishedDate,
          modifiedDate,
        };

      } catch (err) {
        console.error(`[crawler] Error on ${url}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }

      // Polite crawl delay — honour robots.txt Crawl-delay, never less than 1.5s
      await new Promise(r => setTimeout(r, Math.max(crawlDelayMs, CRAWL_DELAY)));
    }
  } finally {
    await browser.close();
  }
}

/**
 * Convenience: crawl and return array (small sites only)
 */
export async function crawlAll(startUrl) {
  const pages = [];
  for await (const page of crawlDomain(startUrl)) {
    pages.push(page);
  }
  return pages;
}
