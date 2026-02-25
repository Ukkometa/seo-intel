/**
 * robots.txt fetcher + parser
 * Checks if we're allowed to crawl a URL and what delay to respect.
 */

import fetch from 'node-fetch';

const cache = new Map(); // domain → { rules, crawlDelay, fetchedAt }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const OUR_AGENT = 'SEOIntelBot';

/**
 * Fetch and parse robots.txt for a domain.
 */
async function fetchRobots(domain) {
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  const url = `https://${domain}/robots.txt`;
  let text = '';
  try {
    const res = await fetch(url, { timeout: 8000, headers: { 'User-Agent': OUR_AGENT } });
    if (res.ok) text = await res.text();
  } catch {
    // No robots.txt = everything allowed
  }

  const parsed = parseRobots(text);
  cache.set(domain, { ...parsed, fetchedAt: Date.now() });
  return parsed;
}

function parseRobots(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  let crawlDelay = null;
  const disallowed = [];
  const allowed = [];
  let inOurBlock = false;
  let inAllBlock = false;

  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    const val = rest.join(':').trim();
    const k = key.toLowerCase().trim();

    if (k === 'user-agent') {
      inOurBlock = val === OUR_AGENT || val === '*';
      inAllBlock = val === '*';
    }
    if ((inOurBlock || inAllBlock) && k === 'disallow' && val) {
      disallowed.push(val);
    }
    if ((inOurBlock || inAllBlock) && k === 'allow' && val) {
      allowed.push(val);
    }
    if ((inOurBlock || inAllBlock) && k === 'crawl-delay' && val) {
      const d = parseFloat(val);
      if (!isNaN(d)) crawlDelay = Math.max(d, 1); // minimum 1s
    }
  }

  return { disallowed, allowed, crawlDelay };
}

/**
 * Check if we're allowed to crawl a URL.
 * Returns { allowed: bool, crawlDelayMs: number }
 */
export async function checkRobots(url) {
  try {
    const { hostname } = new URL(url);
    const { disallowed, allowed, crawlDelay } = await fetchRobots(hostname);

    const path = new URL(url).pathname;

    // Check disallow rules
    for (const rule of disallowed) {
      if (path.startsWith(rule)) {
        // Check if there's a more specific allow
        const overridden = allowed.some(a => a.length > rule.length && path.startsWith(a));
        if (!overridden) return { allowed: false, crawlDelayMs: 0 };
      }
    }

    // crawlDelay from robots.txt takes priority, min 1.5s always
    const crawlDelayMs = crawlDelay
      ? Math.max(crawlDelay * 1000, 1500)
      : parseInt(process.env.CRAWL_DELAY_MS || '1500');

    return { allowed: true, crawlDelayMs };
  } catch {
    return { allowed: true, crawlDelayMs: 1500 };
  }
}

/**
 * Get recommended crawl delay for a domain (ms).
 */
export async function getCrawlDelay(domain) {
  const { crawlDelay } = await fetchRobots(domain).catch(() => ({ crawlDelay: null }));
  return crawlDelay ? Math.max(crawlDelay * 1000, 1500) : 1500;
}
