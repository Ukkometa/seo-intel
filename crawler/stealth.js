import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { sanitize, extractSelective, extractAsMarkdown } from './sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, '..', '.sessions');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Stealth fingerprint pools ───────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
];

const REFERRERS = [
  'https://www.google.com/',
  'https://www.google.com/search?q=site',
  'https://www.google.com/search?q=',
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
];

const LOCALES = ['en-US', 'en-GB', 'en'];

// ── Advanced rendering script — injected before any page JS runs ───────────

export const STEALTH_INIT_SCRIPT = `
  // 1. navigator.webdriver = false (headless sets this to true)
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Fake plugins array (headless Chrome has 0 plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      plugins.length = 3;
      return plugins;
    }
  });

  // 3. Fake languages (headless often shows empty or minimal)
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en']
  });

  // 4. chrome.runtime should exist but be empty (headless has undefined)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  // 5. Permissions API — "notifications" should return "denied" not "prompt"
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery.call(window.navigator.permissions, params);
    };
  }

  // 6. WebGL vendor/renderer (headless returns "Google Inc." / "ANGLE...")
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  } catch {}

  // 7. Fake connection info (headless may report differently)
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }

  // 8. Prevent iframe-based detection (window.length, window.parent)
  Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
  Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + 15 });
`;

// ── Utility ─────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Content quality gate ────────────────────────────────────────────────
const SHELL_PATTERNS = /id=["'](root|app|__next|__nuxt)["']|<noscript[^>]*>.*enable javascript/i;
const CAPTCHA_PATTERNS = /cf-browser-verification|checking your browser|just a moment|verify you are human|challenge-platform/i;

function assessQuality({ wordCount, bodyText, title }) {
  if (CAPTCHA_PATTERNS.test(bodyText)) return { ok: false, reason: 'blocked' };
  if (wordCount < 30 && title && SHELL_PATTERNS.test(bodyText)) return { ok: false, reason: 'js-shell' };
  if (wordCount < 10) return { ok: false, reason: 'empty' };
  return { ok: true, reason: null };
}

// ── Session persistence — save/load cookies across stealth runs ──────────

export function loadSessionState(domain) {
  const sessionPath = join(SESSIONS_DIR, `${domain}.json`);
  try {
    if (!existsSync(sessionPath)) return null;
    const age = Date.now() - statSync(sessionPath).mtimeMs;
    if (age > SESSION_MAX_AGE_MS) {
      unlinkSync(sessionPath);
      console.log(`[stealth] Session expired for ${domain} (${Math.round(age / 86400000)}d old) — starting fresh`);
      return null;
    }
    console.log(`[stealth] Reusing session for ${domain} (${Math.round(age / 3600000)}h old)`);
    return sessionPath;
  } catch { return null; }
}

export async function saveSessionState(context, domain) {
  try {
    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
    const sessionPath = join(SESSIONS_DIR, `${domain}.json`);
    const state = await context.storageState();
    writeFileSync(sessionPath, JSON.stringify(state));
    console.log(`[stealth] Session saved for ${domain}`);
  } catch (err) {
    console.log(`[stealth] Failed to save session for ${domain}: ${err.message}`);
  }
}

export function discardSession(domain) {
  const sessionPath = join(SESSIONS_DIR, `${domain}.json`);
  try { unlinkSync(sessionPath); } catch {}
}

function contentHash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

// ── Human-like scrolling ────────────────────────────────────────────────

async function humanScroll(page) {
  try {
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = page.viewportSize()?.height || 900;
    const scrollTarget = Math.min(bodyHeight, viewportHeight * 3);
    let scrolled = 0;

    while (scrolled < scrollTarget) {
      const step = 200 + Math.random() * 300;
      await page.mouse.wheel(0, step);
      scrolled += step;
      await page.waitForTimeout(150 + Math.random() * 350);
    }

    // Scroll back to top (natural behavior)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  } catch {
    // Scrolling is best-effort — don't crash if page is weird
  }
}

// ── Shared stealth config for crawlDomain() ─────────────────────────────

export function getStealthConfig() {
  const userAgent = pick(USER_AGENTS);
  const viewport = pick(VIEWPORTS);
  return {
    launchArgs: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--no-first-run',
      ],
    },
    contextOpts: {
      userAgent,
      viewport,
      locale: pick(LOCALES),
      timezoneId: pick(TIMEZONES),
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    },
  };
}

// ── Stealth route handler (blocks images/fonts/tracking) ────────────────

export async function applyStealthRoutes(context) {
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    const url = route.request().url();
    if (/google-analytics|googletagmanager|facebook\.net|doubleclick|hotjar|segment\.io|intercom|sentry\.io/.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

// ── Session-based stealth fetcher (for extract command) ─────────────────

export async function createStealthSession(opts = {}) {
  const stealthCfg = getStealthConfig();

  const browser = await chromium.launch({
    headless: true,
    ...stealthCfg.launchArgs,
  });

  const context = await browser.newContext(stealthCfg.contextOpts);

  // Inject stealth patches before any page loads
  await context.addInitScript(STEALTH_INIT_SCRIPT);

  // Block unnecessary resources
  await applyStealthRoutes(context);

  let fetchCount = 0;
  const TIMEOUT = parseInt(process.env.CRAWL_TIMEOUT_MS || '15000');

  // ── fetchPage: extract full page data from a single URL ─────────────

  async function fetchPage(url) {
    const page = await context.newPage();

    try {
      const referrer = pick(REFERRERS);
      const t0 = Date.now();
      let status = 0;

      // Navigate with referrer
      let res;
      for (const waitUntil of ['domcontentloaded', 'load']) {
        try {
          res = await page.goto(url, { waitUntil, timeout: TIMEOUT, referer: referrer });
          break;
        } catch (err) {
          if (waitUntil === 'load') throw err;
        }
      }

      status = res?.status() || 0;
      const loadMs = Date.now() - t0;

      if (status >= 400) {
        return {
          url, depth: 0, status, loadMs, wordCount: 0, isIndexable: false,
          title: '', metaDesc: '', headings: [], links: [], bodyText: '',
          schemaTypes: [], vitals: {}, publishedDate: null, modifiedDate: null,
          contentHash: null,
        };
      }

      // Scroll like a human to trigger lazy content
      await humanScroll(page);

      // ── Extract all page data (mirrors processPage from crawler/index.js) ──

      const title = await page.title().catch(() => '');
      const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');

      const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els =>
        els.map(el => ({ level: parseInt(el.tagName[1]), text: el.innerText?.trim().slice(0, 200) })).filter(h => h.text)
      ).catch(() => []);

      const base = new URL(url);
      const links = await page.$$eval('a[href]', (els, baseHref) =>
        els.map(el => {
          try { return { url: new URL(el.href, baseHref).href, anchor: el.innerText?.trim().slice(0, 100) || '' }; }
          catch { return null; }
        }).filter(Boolean), base.href
      ).catch(() => []);

      const getRootDomain = h => h.split('.').slice(-2).join('.');
      const internalLinks = links.filter(l => {
        try { const h = new URL(l.url).hostname; return h === base.hostname || getRootDomain(h) === getRootDomain(base.hostname); }
        catch { return false; }
      }).map(l => ({ ...l, isInternal: true }));
      const externalLinks = links.filter(l => {
        try { return new URL(l.url).hostname !== base.hostname; }
        catch { return false; }
      }).map(l => ({ ...l, isInternal: false }));

      const bodyText = await extractAsMarkdown(page).catch(() => '')
        || await extractSelective(page, ['h1', 'h2', 'h3', 'p', 'li', 'span.hero', 'div.tagline']).catch(() => '');

      const schemaTypes = await page.$$eval('script[type="application/ld+json"]', els => {
        const types = [];
        for (const el of els) { try { const d = JSON.parse(el.textContent); types.push(d['@type']); } catch {} }
        return types.filter(Boolean);
      }).catch(() => []);

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

      const publishedDate = await page.evaluate(() => {
        for (const sel of ['meta[property="article:published_time"]', 'meta[name="date"]', 'meta[itemprop="datePublished"]']) {
          const el = document.querySelector(sel);
          if (el?.content) return el.content;
        }
        for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
          try { const d = JSON.parse(el.textContent); if (d.datePublished) return d.datePublished; } catch {}
        }
        return null;
      }).catch(() => null);

      const modifiedDate = await page.evaluate(() => {
        for (const sel of ['meta[property="article:modified_time"]', 'meta[name="last-modified"]', 'meta[itemprop="dateModified"]']) {
          const el = document.querySelector(sel);
          if (el?.content) return el.content;
        }
        for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
          try { const d = JSON.parse(el.textContent); if (d.dateModified) return d.dateModified; } catch {}
        }
        return null;
      }).catch(() => null);

      const hash = contentHash(bodyText);
      fetchCount++;

      // ── Quality gate ──
      const quality = assessQuality({ wordCount, bodyText, title });

      return {
        url, depth: 0, status, loadMs, wordCount, isIndexable,
        title, metaDesc, headings,
        links: [...internalLinks, ...externalLinks],
        bodyText: sanitize(bodyText, 2000),
        schemaTypes, vitals, publishedDate, modifiedDate,
        contentHash: hash,
        quality: quality.ok, qualityReason: quality.reason,
      };

    } finally {
      await page.close().catch(() => {});
    }
  }

  async function close() {
    await browser.close().catch(() => {});
  }

  return { fetchPage, close, getPageCount: () => fetchCount };
}
