/**
 * URL Pattern Clustering — Phase 1
 *
 * Takes sitemap URLs, detects parametric patterns, groups them.
 * Pure function — no I/O, no side effects.
 */

/**
 * Is this path segment a "variable" (one of N possible values)
 * vs a "constant" (structural path like 'swap', 'docs', 'blog')?
 */
function isVariable(segment) {
  // Version prefixes stay constant: v1, v2, v3...
  if (/^v\d+$/.test(segment)) return false;

  // Common structural words stay constant
  const STRUCTURAL = new Set([
    'api', 'docs', 'blog', 'news', 'about', 'pricing', 'features',
    'help', 'support', 'contact', 'legal', 'terms', 'privacy',
    'login', 'signup', 'register', 'dashboard', 'settings',
    'token', 'tokens', 'swap', 'trade', 'perps', 'perpetuals',
    'pool', 'pools', 'stake', 'staking', 'bridge', 'earn',
    'governance', 'vote', 'proposals', 'stats', 'analytics',
    'markets', 'pairs', 'explorer', 'episodes', 'categories',
    'tags', 'products', 'collections', 'pages', 'posts',
  ]);
  if (STRUCTURAL.has(segment.toLowerCase())) return false;

  // Purely numeric → variable (IDs, dates)
  if (/^\d+$/.test(segment)) return true;

  // UUID or hash-like
  if (/^[0-9a-f-]{8,}$/i.test(segment)) return true;

  // Hex address (0x...)
  if (/^0x[0-9a-fA-F]+$/.test(segment)) return true;

  // Contains separator characters typical of slugs/pairs: SOL-USDC, my-blog-post
  if (/[-_.]/.test(segment) && segment.length > 2) return true;

  // All uppercase short string → likely a ticker: SOL, BONK, USDT, ETH
  if (/^[A-Z0-9]{2,10}$/.test(segment)) return true;

  // Mixed case with digits → product codes, IDs
  if (/[A-Z]/.test(segment) && /\d/.test(segment)) return true;

  // Very long segments are likely slugs or IDs
  if (segment.length > 30) return true;

  return false;
}

/**
 * Infer a semantic name for a param position based on observed values.
 */
function inferParamName(values, position) {
  const sample = values.slice(0, 100);

  // Crypto pairs: X-Y format where both parts are short uppercase
  const pairCount = sample.filter(v => /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(v)).length;
  if (pairCount > sample.length * 0.6) return 'pair';

  // Token tickers: 2-10 uppercase chars
  const tickerCount = sample.filter(v => /^[A-Z0-9]{2,10}$/.test(v)).length;
  if (tickerCount > sample.length * 0.6) return 'symbol';

  // Slugs: lowercase with hyphens
  const slugCount = sample.filter(v => /^[a-z0-9]+(-[a-z0-9]+)+$/.test(v)).length;
  if (slugCount > sample.length * 0.6) return 'slug';

  // Numeric IDs
  const numCount = sample.filter(v => /^\d+$/.test(v)).length;
  if (numCount > sample.length * 0.6) return 'id';

  // Hex hashes/addresses
  const hexCount = sample.filter(v => /^(0x)?[0-9a-f]{8,}$/i.test(v)).length;
  if (hexCount > sample.length * 0.6) return 'hash';

  return `param${position}`;
}

/**
 * Cluster sitemap URLs into template groups.
 *
 * @param {Array<{url: string, lastmod?: string}>} sitemapEntries
 * @param {object} opts
 * @param {number} opts.minGroupSize — min URLs to qualify as template (default 10)
 * @param {number} opts.maxSegments — max path depth to consider (default 8)
 * @returns {{ groups: TemplateGroup[], ungrouped: string[], stats: object }}
 */
export function clusterUrls(sitemapEntries, opts = {}) {
  const minGroupSize = opts.minGroupSize || 10;
  const maxSegments = opts.maxSegments || 8;

  // patternKey → { pattern parts, urls[], paramValues by position }
  const clusters = new Map();

  for (const entry of sitemapEntries) {
    let pathname;
    try {
      pathname = new URL(entry.url).pathname;
    } catch { continue; }

    // Normalize
    pathname = pathname.replace(/\/+$/, '') || '/';

    // Homepage is always unique
    if (pathname === '/') continue;

    const segments = pathname.split('/').filter(Boolean).slice(0, maxSegments);
    const patternParts = [];
    const paramPositions = {};
    let paramIdx = 0;

    for (let i = 0; i < segments.length; i++) {
      if (isVariable(segments[i])) {
        const key = `p${paramIdx}`;
        patternParts.push(`{${key}}`);
        if (!paramPositions[key]) paramPositions[key] = [];
        paramPositions[key].push(segments[i]);
        paramIdx++;
      } else {
        patternParts.push(segments[i].toLowerCase());
      }
    }

    const patternKey = '/' + patternParts.join('/');

    if (!clusters.has(patternKey)) {
      clusters.set(patternKey, {
        patternKey,
        patternParts,
        urls: [],
        paramPositions: {},
        lastmods: [],
      });
    }

    const cluster = clusters.get(patternKey);
    cluster.urls.push(entry.url);
    if (entry.lastmod) cluster.lastmods.push(entry.lastmod);

    // Collect param values (cap at 200 for memory)
    for (const [key, values] of Object.entries(paramPositions)) {
      if (!cluster.paramPositions[key]) cluster.paramPositions[key] = [];
      if (cluster.paramPositions[key].length < 200) {
        cluster.paramPositions[key].push(...values);
      }
    }
  }

  // Separate into template groups (>= minGroupSize) and ungrouped
  const groups = [];
  const ungrouped = [];

  for (const [patternKey, cluster] of clusters) {
    if (cluster.urls.length >= minGroupSize) {
      // Rename params to semantic names
      const params = {};
      const renamedParts = [...cluster.patternParts];

      let paramIdx = 0;
      for (let i = 0; i < renamedParts.length; i++) {
        const match = renamedParts[i].match(/^\{(p\d+)\}$/);
        if (match) {
          const key = match[1];
          const name = inferParamName(cluster.paramPositions[key] || [], paramIdx);
          renamedParts[i] = `{${name}}`;
          params[name] = (cluster.paramPositions[key] || []).slice(0, 50);
          paramIdx++;
        }
      }

      const pattern = '/' + renamedParts.join('/');
      const sortedLastmods = cluster.lastmods.sort();

      groups.push({
        pattern,
        patternKey,
        params,
        urls: cluster.urls,
        urlCount: cluster.urls.length,
        depth: cluster.patternParts.length,
        firstSeen: sortedLastmods[0] || null,
        lastSeen: sortedLastmods[sortedLastmods.length - 1] || null,
      });
    } else {
      ungrouped.push(...cluster.urls);
    }
  }

  // Sort by URL count descending
  groups.sort((a, b) => b.urlCount - a.urlCount);

  const totalGrouped = groups.reduce((sum, g) => sum + g.urlCount, 0);
  const totalUrls = sitemapEntries.length;

  return {
    groups,
    ungrouped,
    stats: {
      totalUrls,
      totalGroups: groups.length,
      totalGrouped,
      largestGroup: groups[0]?.urlCount || 0,
      coverage: totalUrls > 0 ? totalGrouped / totalUrls : 0,
    },
  };
}
