/**
 * Google Search Console Platform Property Gap Analysis
 *
 * Compares query exports from a verified website property and one or more
 * supported platform properties (YouTube, X, TikTok, Instagram). It accepts a
 * portable JSON export by default and can query the Search Console API when
 * configured property IDs and an OAuth access token are supplied.
 */

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRow(row) {
  const query = String(row.query || row.keys?.[0] || '').trim().toLowerCase();
  if (!query) return null;
  return {
    query,
    clicks: asNumber(row.clicks),
    impressions: asNumber(row.impressions),
    ctr: asNumber(row.ctr),
    position: asNumber(row.position),
  };
}

function normalizeSurface(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : [];
  const map = new Map();
  for (const raw of rows) {
    const row = normalizeRow(raw);
    if (!row) continue;
    const prev = map.get(row.query) || { ...row, clicks: 0, impressions: 0, ctr: 0, position: 0, samples: 0 };
    prev.clicks += row.clicks;
    prev.impressions += row.impressions;
    prev.position += row.position;
    prev.samples += 1;
    map.set(row.query, prev);
  }
  for (const row of map.values()) {
    row.ctr = row.impressions ? row.clicks / row.impressions : 0;
    row.position = row.samples ? row.position / row.samples : 0;
    delete row.samples;
  }
  return map;
}

function gapPriority(surfaces) {
  const impressions = surfaces.reduce((sum, item) => sum + item.impressions, 0);
  const clicks = surfaces.reduce((sum, item) => sum + item.clicks, 0);
  // Directional sorting signal, not a volume estimate: high visibility with
  // demonstrable cross-surface demand should rise above low-signal queries.
  return Math.round(impressions + clicks * 8);
}

async function fetchPropertyQueries(property, accessToken, { startDate, endDate, rowLimit = 5_000 } = {}) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit }),
  });
  if (!res.ok) throw new Error(`${property}: Search Console API ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * @param {Record<string, unknown>} source Surface name -> GSC Search Analytics rows or response.
 */
export function analyzePlatformQueryGaps(source) {
  const surfaces = Object.fromEntries(Object.entries(source || {}).map(([name, rows]) => [name, normalizeSurface(rows)]));
  const web = surfaces.web || surfaces.website || new Map();
  const platformNames = Object.keys(surfaces).filter(name => name !== 'web' && name !== 'website');
  const gaps = new Map();
  const shared = [];

  for (const surfaceName of platformNames) {
    for (const row of surfaces[surfaceName].values()) {
      if (web.has(row.query)) {
        const webRow = web.get(row.query);
        shared.push({
          query: row.query,
          web: webRow,
          platform: { name: surfaceName, ...row },
          opportunity: surfaceName === 'youtube'
            ? 'video_serp_opportunity: align title, description, chapters, and the canonical landing page for video/key-moment eligibility.'
            : 'cross_surface_serp_opportunity: align entity, title, and canonical landing page to reinforce the same query intent.',
          priority: gapPriority([webRow, row]),
        });
      } else {
        const entry = gaps.get(row.query) || { query: row.query, platformSignals: [], priority: 0 };
        entry.platformSignals.push({ name: surfaceName, ...row });
        entry.priority = gapPriority(entry.platformSignals);
        gaps.set(row.query, entry);
      }
    }
  }

  const sortedGaps = [...gaps.values()].sort((a, b) => b.priority - a.priority);
  const sortedShared = shared.sort((a, b) => b.priority - a.priority);
  return {
    gaps: sortedGaps,
    shared: sortedShared,
    summary: {
      webQueries: web.size,
      platformProperties: platformNames,
      platformQueries: platformNames.reduce((sum, name) => sum + surfaces[name].size, 0),
      highIntentWebContentGaps: sortedGaps.length,
      crossSurfaceSerpOpportunities: sortedShared.length,
    },
  };
}

export async function runPlatformGapAnalysis(config, opts = {}) {
  let source;
  let mode;
  if (opts.input) {
    const { readFile } = await import('node:fs/promises');
    source = JSON.parse(await readFile(opts.input, 'utf8'));
    mode = 'import';
  } else if (opts.api) {
    const properties = config?.gsc?.platformProperties;
    const token = process.env.GSC_ACCESS_TOKEN;
    if (!properties || typeof properties !== 'object' || !Object.keys(properties).length) {
      throw new Error('Configure gsc.platformProperties with verified Search Console property IDs before using --api.');
    }
    if (!token) throw new Error('Set GSC_ACCESS_TOKEN with a short-lived OAuth token before using --api.');
    const endDate = opts.endDate || new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const startDate = opts.startDate || new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
    source = {};
    for (const [surface, property] of Object.entries(properties)) {
      source[surface] = await fetchPropertyQueries(property, token, { startDate, endDate });
    }
    mode = 'api';
  } else {
    throw new Error('Provide --input <gsc-platform.json>, or configure GSC platform properties and use --api.');
  }
  return { mode, ...analyzePlatformQueryGaps(source) };
}
