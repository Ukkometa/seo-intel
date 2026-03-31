/**
 * GSC Overlay — Phase 3
 *
 * Cross-references template groups against Google Search Console per-URL data.
 * Pure computation — no I/O.
 */

/**
 * Normalize a URL for GSC matching.
 * GSC reports URLs inconsistently — trailing slashes, www, http vs https.
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol + '//' + u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Cross-reference template groups with GSC pages data.
 *
 * @param {TemplateGroup[]} groups — from cluster.js
 * @param {Array<{url: string, clicks: number, impressions: number, ctr: number, position: number}>|null} gscPages
 * @returns {GscOverlayResult[]}
 */
export function overlayGsc(groups, gscPages) {
  if (!gscPages || gscPages.length === 0) {
    // No GSC data — return groups with null GSC fields
    return groups.map(g => ({
      ...g,
      gscUrlsWithImpressions: null,
      gscTotalClicks: null,
      gscTotalImpressions: null,
      gscAvgPosition: null,
      indexationEfficiency: null,
      topGscUrls: [],
    }));
  }

  // Build normalized URL → GSC entry lookup
  const gscMap = new Map();
  for (const entry of gscPages) {
    const key = normalizeUrl(entry.url);
    // Keep the one with more impressions if dupes
    const existing = gscMap.get(key);
    if (!existing || entry.impressions > existing.impressions) {
      gscMap.set(key, entry);
    }
  }

  return groups.map(group => {
    let urlsWithImpressions = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    let positionSum = 0;
    let positionCount = 0;
    const topUrls = [];

    for (const url of group.urls) {
      const gscEntry = gscMap.get(normalizeUrl(url));
      if (gscEntry && gscEntry.impressions > 0) {
        urlsWithImpressions++;
        totalClicks += gscEntry.clicks || 0;
        totalImpressions += gscEntry.impressions || 0;
        if (gscEntry.position > 0) {
          positionSum += gscEntry.position;
          positionCount++;
        }
        topUrls.push({
          url: gscEntry.url,
          clicks: gscEntry.clicks,
          impressions: gscEntry.impressions,
          position: gscEntry.position,
        });
      }
    }

    // Sort top URLs by impressions desc, take top 10
    topUrls.sort((a, b) => b.impressions - a.impressions);

    return {
      ...group,
      gscUrlsWithImpressions: urlsWithImpressions,
      gscTotalClicks: totalClicks,
      gscTotalImpressions: totalImpressions,
      gscAvgPosition: positionCount > 0 ? Math.round((positionSum / positionCount) * 10) / 10 : null,
      indexationEfficiency: group.urlCount > 0 ? urlsWithImpressions / group.urlCount : 0,
      topGscUrls: topUrls.slice(0, 10),
    };
  });
}
