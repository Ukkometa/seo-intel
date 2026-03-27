import { createHash } from 'crypto';
import { chromium } from 'playwright';
import { sanitize, extractSelective, extractAsMarkdown } from './sanitize.js';
import { checkRobots, getCrawlDelay } from './robots.js';
import { fetchSitemap } from './sitemap.js';
import { parseJsonLd } from './schema-parser.js';
import { loadSessionState, saveSessionState, discardSession } from './stealth.js';

const CRAWL_DELAY  = parseInt(process.env.CRAWL_DELAY_MS  || '1500');
const MAX_PAGES    = parseInt(process.env.CRAWL_MAX_PAGES  || '50');
const MAX_DEPTH    = parseInt(process.env.CRAWL_MAX_DEPTH  || '3');
const TIMEOUT      = parseInt(process.env.CRAWL_TIMEOUT_MS || '12000');
const PAGE_BUDGET  = parseInt(process.env.PAGE_BUDGET_MS   || '25000'); // hard per-page wall-clock limit
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

// ── Content quality gate ────────────────────────────────────────────────
const SHELL_PATTERNS = /id=["'](root|app|__next|__nuxt)["']|<noscript[^>]*>.*enable javascript/i;
const CAPTCHA_PATTERNS = /cf-browser-verification|checking your browser|just a moment|verify you are human|challenge-platform/i;

function assessQuality({ wordCount, bodyText, title }) {
  if (CAPTCHA_PATTERNS.test(bodyText)) return { ok: false, reason: 'blocked' };
  if (wordCount < 30 && title && SHELL_PATTERNS.test(bodyText)) return { ok: false, reason: 'js-shell' };
  if (wordCount < 10) return { ok: false, reason: 'empty' };
  return { ok: true, reason: null };
}

// ── SECTION TIERS — smart crawl priorities ──────────────────────────────
// Not all pages are equal. Section-aware crawling gets 90% of SEO insight
// at ~15% of full-crawl cost.
const SECTION_TIERS = {
  skip: {
    // These sections have no SEO value — skip entirely
    patterns: ['/changelog', '/legal', '/tos', '/terms', '/privacy', '/cookie',
               '/cdn-cgi', '/wp-admin', '/wp-json', '/wp-content', '/wp-includes',
               '/_next', '/__', '/admin', '/console', '/account', '/auth',
               '/login', '/signup', '/register', '/onboarding', '/settings'],
    depth: 0,
    budget: 0,
  },
  high: {
    // Conversion-critical — always crawl, moderate depth
    patterns: ['/', '/pricing', '/plans', '/features', '/product', '/solutions',
               '/services', '/about', '/contact', '/demo'],
    depth: 2,
    budget: Infinity, // always included
  },
  core: {
    // Core product content — full depth
    patterns: ['/api', '/rpc', '/platform', '/tools', '/integrations',
               '/resources', '/use-cases', '/customers', '/case-studies'],
    depth: 3,
    budget: 30,
  },
  docs: {
    // Documentation — index + 1 level (skip deep API refs)
    patterns: ['/docs', '/documentation', '/reference', '/guides', '/tutorials',
               '/learn', '/help', '/support', '/knowledge-base', '/kb'],
    depth: 2,
    budget: 15,
  },
  blog: {
    // Blog/news — latest posts only, not full archive
    patterns: ['/blog', '/news', '/articles', '/posts', '/journal',
               '/updates', '/insights', '/content'],
    depth: 1,
    budget: 10,
  },
  default: {
    // Everything else — standard depth
    depth: 3,
    budget: 20,
  },
};

/**
 * Classify a URL into a section tier.
 * Returns { tier, section, depth, budget }
 */
function classifyUrl(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();

    // Exact homepage match
    if (pathname === '/' || pathname === '') {
      return { tier: 'high', section: '/', depth: SECTION_TIERS.high.depth, budget: SECTION_TIERS.high.budget };
    }

    // Check skip tier first (highest priority — never crawl these)
    for (const pattern of SECTION_TIERS.skip.patterns) {
      if (pathname.startsWith(pattern)) {
        return { tier: 'skip', section: pattern, depth: 0, budget: 0 };
      }
    }

    // Check named tiers in priority order
    for (const tierName of ['high', 'core', 'docs', 'blog']) {
      const tier = SECTION_TIERS[tierName];
      for (const pattern of tier.patterns) {
        if (pattern === '/') continue; // homepage already handled
        if (pathname === pattern || pathname.startsWith(pattern + '/') || pathname.startsWith(pattern + '?')) {
          return { tier: tierName, section: pattern, depth: tier.depth, budget: tier.budget };
        }
      }
    }

    // Default tier
    const firstSegment = '/' + (pathname.split('/').filter(Boolean)[0] || '');
    return { tier: 'default', section: firstSegment, depth: SECTION_TIERS.default.depth, budget: SECTION_TIERS.default.budget };
  } catch {
    return { tier: 'default', section: '/', depth: SECTION_TIERS.default.depth, budget: SECTION_TIERS.default.budget };
  }
}

/**
 * Apply section-aware sorting + budgeting to sitemap URLs.
 * Prioritizes high-value sections, limits blog/docs, skips junk.
 */
function applySectionBudgets(sitemapUrls, maxPages) {
  // Classify all URLs
  const classified = sitemapUrls.map(entry => ({
    ...entry,
    ...classifyUrl(entry.url),
  }));

  // Remove skipped sections
  const allowed = classified.filter(u => u.tier !== 'skip');

  // Group by section
  const sectionMap = new Map();
  for (const u of allowed) {
    const key = u.section;
    if (!sectionMap.has(key)) sectionMap.set(key, []);
    sectionMap.get(key).push(u);
  }

  // Sort sections by tier priority
  const tierOrder = { high: 0, core: 1, docs: 2, blog: 3, default: 4 };
  const sortedSections = [...sectionMap.entries()].sort((a, b) => {
    const tierA = tierOrder[a[1][0]?.tier] ?? 4;
    const tierB = tierOrder[b[1][0]?.tier] ?? 4;
    return tierA - tierB;
  });

  // Apply per-section budgets
  const result = [];
  for (const [section, urls] of sortedSections) {
    const tier = urls[0]?.tier || 'default';
    const budget = SECTION_TIERS[tier]?.budget ?? SECTION_TIERS.default.budget;

    // For blog: sort by lastmod descending to get newest posts first
    if (tier === 'blog') {
      urls.sort((a, b) => {
        if (!a.lastmod && !b.lastmod) return 0;
        if (!a.lastmod) return 1;
        if (!b.lastmod) return -1;
        return b.lastmod.localeCompare(a.lastmod);
      });
    }

    const limited = Number.isFinite(budget) ? urls.slice(0, budget) : urls;
    result.push(...limited);
  }

  return result;
}

/** Race a promise against a timeout */
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)),
  ]);
}

/** SHA-256 hash for incremental crawling */
function contentHash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

export async function* crawlDomain(startUrl, opts = {}) {
  const base = new URL(startUrl);
  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  let count = 0;

  // ── Docs domains: some hosted docs platforms block unknown bots.
  // When hostname contains "docs.", spoof Googlebot UA to reduce WAF friction.
  const isDocsHostname = base.hostname.toLowerCase().includes('docs.');
  const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const defaultUA = 'Mozilla/5.0 (compatible; SEOIntelBot/1.0; +https://ukkometa.fi/en/seo-intel/bot)';
  const effectiveUA = isDocsHostname ? GOOGLEBOT_UA : defaultUA;

  async function tryLoadLlmsTxt() {
    const llmsOrigin = base.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(base.hostname)
      ? `https://${base.host}`
      : base.origin;
    const llmsUrl = `${llmsOrigin}/llms.txt`;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), Math.min(TIMEOUT, 8000));
      const res = await fetch(llmsUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': effectiveUA,
          'accept': 'text/plain,text/markdown;q=0.9,*/*;q=0.1',
        },
      }).finally(() => clearTimeout(t));

      if (!res?.ok) return;
      const text = await res.text();
      if (!text || text.length < 5) return;

      // Extract markdown links: - [Title](url): description
      const urls = [];
      const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
      let m;
      while ((m = linkRe.exec(text))) {
        const u = m[1];
        if (!u) continue;
        // allow absolute http(s) only
        if (!/^https?:\/\//i.test(u)) continue;
        urls.push(u);
      }

      // De-dupe and enqueue
      const unique = [...new Set(urls)];
      let added = 0;
      for (const u of unique) {
        try {
          if (new URL(u).hostname !== base.hostname) continue;
        } catch {
          continue;
        }
        if (!queue.some(q => q.url === u)) {
          queue.push({ url: u, depth: 1 });
          added++;
        }
      }
      if (unique.length > 0) {
        console.log(`[llms.txt] ${base.hostname} — discovered ${unique.length} URLs (${added} added to queue)`);
      }
    } catch {
      // silent: llms.txt is optional
    }
  }

  // ── llms.txt: if present, use it to seed crawl queue first ──
  await tryLoadLlmsTxt();

  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : MAX_PAGES;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : MAX_DEPTH;

  // ── Section budget tracking ──
  const sectionCounts = new Map(); // section → pages crawled
  const tiered = opts.tiered !== false; // tiered crawling on by default

  // ── Sitemap-first: seed queue from sitemap.xml (section-aware) ──
  try {
    const sitemapUrls = await fetchSitemap(startUrl);
    if (sitemapUrls.length > 0) {
      // Apply section budgets if tiered crawling is enabled
      const budgeted = tiered ? applySectionBudgets(sitemapUrls, maxPages) : sitemapUrls;

      const skipped = sitemapUrls.length - budgeted.length;
      console.log(`[sitemap] Found ${sitemapUrls.length} URLs — ${budgeted.length} after section budgets` +
        (skipped > 0 ? ` (${skipped} skipped)` : ''));

      if (tiered && budgeted.length > 0) {
        // Show section breakdown
        const sections = new Map();
        for (const u of budgeted) {
          const { tier, section } = classifyUrl(u.url);
          const key = `${section} [${tier}]`;
          sections.set(key, (sections.get(key) || 0) + 1);
        }
        for (const [sec, cnt] of [...sections.entries()].slice(0, 8)) {
          console.log(`  ${sec}: ${cnt} URLs`);
        }
        if (sections.size > 8) console.log(`  ... and ${sections.size - 8} more sections`);
      }

      // Don't enqueue 10k URLs if the crawl budget is tiny.
      const seedLimit = Number.isFinite(opts.sitemapSeedLimit)
        ? opts.sitemapSeedLimit
        : Math.max(maxPages * 2, 50);

      for (const entry of budgeted.slice(0, seedLimit)) {
        if (!queue.some(q => q.url === entry.url) && entry.url !== startUrl) {
          queue.push({ url: entry.url, depth: 1 }); // treat sitemap URLs as depth 1
        }
      }
    }
  } catch (err) {
    console.log(`[sitemap] Could not fetch sitemap: ${err.message}`);
  }

  // ── Backoff tracking per domain ──
  let consecutiveErrors = 0;
  let currentDelay = CRAWL_DELAY;
  let blocked = false;
  const MAX_CONSECUTIVE_ERRORS = 5;

  // ── Advanced mode: full browser rendering with enhanced compatibility ──
  let browser, context;
  if (opts.stealth) {
    const { getStealthConfig, STEALTH_INIT_SCRIPT, applyStealthRoutes } = await import('./stealth.js');
    const stealthCfg = getStealthConfig();
    browser = await chromium.launch({ headless: true, ...stealthCfg.launchArgs });
    // Try to load a saved session for this domain (returning visitor = less WAF friction)
    const sessionPath = loadSessionState(base.hostname);
    const contextOpts = { ...stealthCfg.contextOpts, userAgent: effectiveUA };
    if (sessionPath) contextOpts.storageState = sessionPath;
    context = await browser.newContext(contextOpts);
    await context.addInitScript(STEALTH_INIT_SCRIPT);
    await applyStealthRoutes(context);
    console.log(`[stealth] 🥷 Advanced mode — full browser rendering, persistent sessions`);
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: effectiveUA,
      ignoreHTTPSErrors: true,
    });
  }

  try {
    while (queue.length > 0 && count < maxPages && !blocked) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      // ── Section tier check — skip junk sections, respect depth limits ──
      if (tiered) {
        const { tier, section, depth: sectionMaxDepth, budget: sectionBudget } = classifyUrl(url);

        // Skip banned sections entirely
        if (tier === 'skip') continue;

        // Check per-section depth limit (section-relative depth, not global)
        if (depth > sectionMaxDepth + 1) continue; // +1 because sitemap URLs start at depth 1

        // Check per-section budget
        if (Number.isFinite(sectionBudget)) {
          const currentCount = sectionCounts.get(section) || 0;
          if (currentCount >= sectionBudget) continue;
        }
      }

      // In stealth mode, skip robots.txt — user explicitly opted into bypass
      let crawlDelayMs = 0;
      if (!opts.stealth) {
        const robotsResult = await checkRobots(url).catch(() => ({ allowed: true, crawlDelayMs: 0 }));
        if (!robotsResult.allowed) {
          console.log(`[robots] Skipping disallowed: ${url}`);
          continue;
        }
        crawlDelayMs = robotsResult.crawlDelayMs || 0;
      }

      const page = await context.newPage();

      try {
        // Hard per-page deadline wrapping everything
        const pageResult = await withTimeout(processPage(page, url, base, depth, queue, maxDepth), PAGE_BUDGET, url);

        if (pageResult) {
          // ── Backoff: check for rate limit / WAF responses ──
          if (pageResult.status === 429 || pageResult.status === 503) {
            consecutiveErrors++;
            currentDelay = Math.min(currentDelay * 2, 30000); // exponential backoff, max 30s
            console.log(`[backoff] ${pageResult.status} on ${url} — delay now ${currentDelay}ms (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              blocked = true;
              console.log(`[blocked] ${base.hostname} — too many ${pageResult.status} errors, stopping crawl`);
              // Yield a blocked marker
              yield { ...pageResult, _blocked: true, _blockReason: `${MAX_CONSECUTIVE_ERRORS}x ${pageResult.status}` };
            }
            continue; // don't count rate-limited pages
          }

          if (pageResult.status === 403) {
            consecutiveErrors++;
            // If stealth session caused 3+ consecutive 403s, discard it
            if (opts.stealth && consecutiveErrors >= 3) discardSession(base.hostname);
            console.log(`[blocked] 403 on ${url} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              blocked = true;
              console.log(`[blocked] ${base.hostname} — likely WAF/firewall, stopping crawl`);
              yield { ...pageResult, _blocked: true, _blockReason: `${MAX_CONSECUTIVE_ERRORS}x 403 Forbidden` };
            }
            continue;
          }

          // Success — reset backoff
          consecutiveErrors = 0;
          currentDelay = CRAWL_DELAY;

          // Track section budget
          if (tiered) {
            const { section } = classifyUrl(url);
            sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
          }

          count++;
          yield pageResult;
        }
      } catch (err) {
        console.error(`[crawler] Error on ${url}: ${err.message}`);
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          blocked = true;
          console.log(`[blocked] ${base.hostname} — ${MAX_CONSECUTIVE_ERRORS} consecutive failures, stopping`);
        }
      } finally {
        await page.close().catch(() => {});
      }

      // Stealth: jittered human-like delays (2-5s), Standard: configured crawl delay
      const delay = opts.stealth
        ? 2000 + Math.random() * 3000
        : Math.max(crawlDelayMs, currentDelay);
      await new Promise(r => setTimeout(r, delay));
    }
  } finally {
    // Persist stealth session cookies for next run (returning visitor)
    if (opts.stealth && !blocked) await saveSessionState(context, base.hostname);
    await browser.close().catch(() => {});
  }
}

async function processPage(page, url, base, depth, queue, maxDepth) {
  let status = 0;
  const t0 = Date.now();

  // Try domcontentloaded first, fall back to load
  let res;
  for (const waitUntil of ['domcontentloaded', 'load']) {
    try {
      res = await page.goto(url, { waitUntil, timeout: TIMEOUT });
      break;
    } catch (err) {
      if (waitUntil === 'load') throw err;
      console.log(`[crawler] ${waitUntil} failed for ${url}, retrying with load...`);
    }
  }

  status = res?.status() || 0;
  const loadMs = Date.now() - t0;

  // ── Return status for backoff logic (don't silently drop 4xx) ──
  if (status === 429 || status === 503 || status === 403) {
    return { url, depth, status, loadMs, wordCount: 0, isIndexable: false, title: '', metaDesc: '', headings: [], links: [], bodyText: '', schemaTypes: [], vitals: {}, publishedDate: null, modifiedDate: null, contentHash: null };
  }
  if (status >= 400) return null;

  const title    = await page.title().catch(() => '');
  const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');

  const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els =>
    els.map(el => ({ level: parseInt(el.tagName[1]), text: el.innerText?.trim().slice(0, 200) })).filter(h => h.text)
  ).catch(() => []);

  const links = await page.$$eval('a[href]', (els, baseHref) =>
    els.map(el => {
      try { return { url: new URL(el.href, baseHref).href, anchor: el.innerText?.trim().slice(0, 100) || '' }; }
      catch { return null; }
    }).filter(Boolean), base.href
  ).catch(() => []);

  const getRootDomain = h => h.split(".").slice(-2).join(".");
  // BUG-006: When strictHost is set (--domain flag), only exact hostname match is internal.
  // Otherwise, same root domain = internal (so blog.x and docs.x are internal to x).
  const isInternal = (h) => opts.strictHost
    ? h === base.hostname
    : (h === base.hostname || getRootDomain(h) === getRootDomain(base.hostname));
  const internalLinks = links.filter(l => { try { return isInternal(new URL(l.url).hostname); } catch { return false; } }).map(l => ({ ...l, isInternal: true }));
  const externalLinks = links.filter(l => { try { return !isInternal(new URL(l.url).hostname); } catch { return false; } }).map(l => ({ ...l, isInternal: false }));

  // Markdown-first extraction — preserves headings, lists, emphasis. Falls back to selector-based.
  const bodyText = await extractAsMarkdown(page).catch(() => '')
    || await extractSelective(page, ['h1','h2','h3','p','li','span.hero','div.tagline']).catch(() => '');

  const schemaTypes = await page.$$eval('script[type="application/ld+json"]', els => {
    const types = [];
    for (const el of els) { try { const d = JSON.parse(el.textContent); types.push(d['@type']); } catch {} }
    return types.filter(Boolean);
  }).catch(() => []);

  // LCP with a hard 1.5s cap (was hanging before)
  const vitals = await Promise.race([
    page.evaluate(() => new Promise(resolve => {
      let lcp = null;
      try {
        new PerformanceObserver(list => { lcp = list.getEntries().at(-1)?.startTime || null; })
          .observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      setTimeout(() => resolve({ lcp }), 1000);
    })),
    new Promise(resolve => setTimeout(() => resolve({}), 1500)),
  ]).catch(() => ({}));

  const wordCount = await page.$eval('body', el => el.innerText.split(/\s+/).filter(Boolean).length).catch(() => 0);

  const robotsMeta = await page.$eval('meta[name="robots"]', el => el.content).catch(() => '');
  const isIndexable = !robotsMeta.toLowerCase().includes('noindex');
  const hasCanonical = await page.$('link[rel="canonical"]').then(el => !!el).catch(() => false);
  const hasOgTags = await page.$('meta[property^="og:"]').then(el => !!el).catch(() => false);

  const publishedDate = await page.evaluate(() => {
    for (const sel of ['meta[property="article:published_time"]','meta[name="date"]','meta[itemprop="datePublished"]']) {
      const el = document.querySelector(sel);
      if (el?.content) return el.content;
    }
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const d = JSON.parse(el.textContent); if (d.datePublished) return d.datePublished; } catch {}
    }
    return null;
  }).catch(() => null);

  const modifiedDate = await page.evaluate(() => {
    for (const sel of ['meta[property="article:modified_time"]','meta[name="last-modified"]','meta[itemprop="dateModified"]']) {
      const el = document.querySelector(sel);
      if (el?.content) return el.content;
    }
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const d = JSON.parse(el.textContent); if (d.dateModified) return d.dateModified; } catch {}
    }
    return null;
  }).catch(() => null);

  // Queue new URLs (section-aware: skip junk links early)
  if (depth < maxDepth) {
    for (const link of internalLinks) {
      try {
        const u = new URL(link.url);
        if (/\.(pdf|png|jpg|jpeg|gif|svg|css|js|woff|ico)$/i.test(u.pathname)) continue;
        // Pre-filter: don't even enqueue URLs from skip sections
        const { tier } = classifyUrl(link.url);
        if (tier === 'skip') continue;
        if (!queue.some(q => q.url === link.url)) {
          queue.push({ url: link.url, depth: depth + 1 });
        }
      } catch(e) {
      }
    }
  }

  // ── Deep JSON-LD parsing — extract structured schema data from raw HTML ──
  const rawHtml = await page.content().catch(() => '');
  const parsedSchemas = parseJsonLd(rawHtml);

  // ── Content hash for incremental crawling ──
  const hash = contentHash(bodyText);

  // ── Quality gate — detect shells, blocked pages, empty content ──
  const quality = assessQuality({ wordCount, bodyText, title, status });

  // Full body text for DB storage (extraction reads this); truncated for log output
  const fullBodyText = sanitize(bodyText, 50000); // ~200K chars — enough for any real page
  const shortBodyText = sanitize(bodyText, 2000);  // compact version for logging

  return {
    url, depth, status, loadMs, wordCount, isIndexable,
    title, metaDesc, headings,
    links: [...internalLinks, ...externalLinks],
    bodyText: shortBodyText,
    fullBodyText,
    schemaTypes, parsedSchemas, vitals, publishedDate, modifiedDate,
    contentHash: hash,
    quality: quality.ok, qualityReason: quality.reason,
    hasCanonical, hasOgTags,
    hasRobots: !!robotsMeta,
    hasSchema: schemaTypes.length > 0,
  };
}

export async function crawlAll(startUrl) {
  const pages = [];
  for await (const page of crawlDomain(startUrl)) pages.push(page);
  return pages;
}

// Export for use by other modules (content velocity, weekly brief, etc.)
export { classifyUrl, SECTION_TIERS };
