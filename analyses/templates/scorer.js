/**
 * Template Group Scorer — Phase 4
 *
 * Combines sample data + GSC overlay into a verdict and recommendations.
 * Pure function — no I/O.
 */

/**
 * Score a template group and generate recommendations.
 *
 * @param {object} group — enriched with samples + GSC overlay
 * @returns {{ score: number, verdict: string, recommendations: string[] }}
 */
export function scoreGroup(group) {
  const scores = {
    indexation: scoreIndexation(group),
    traffic: scoreTraffic(group),
    content: scoreContent(group),
    structure: scoreStructure(group),
  };

  const totalScore = scores.indexation + scores.traffic + scores.content + scores.structure;

  let verdict;
  if (totalScore >= 65) verdict = 'high-value';
  else if (totalScore >= 35) verdict = 'mixed';
  else if (totalScore >= 15) verdict = 'thin';
  else verdict = 'invisible';

  const recommendations = generateRecommendations(group, scores, verdict);

  return { score: totalScore, verdict, recommendations };
}

// ── Indexation signal (0–25 pts) ──

function scoreIndexation(g) {
  if (g.indexationEfficiency == null) return 12; // no GSC data — neutral
  if (g.indexationEfficiency >= 0.50) return 25;
  if (g.indexationEfficiency >= 0.20) return 15;
  if (g.indexationEfficiency >= 0.05) return 8;
  return 0;
}

// ── Traffic signal (0–25 pts) ──

function scoreTraffic(g) {
  if (g.gscTotalClicks == null) return 12; // no GSC data
  const clicksPerPage = g.urlCount > 0 ? g.gscTotalClicks / g.urlCount : 0;
  if (clicksPerPage >= 0.5) return 25;
  if (clicksPerPage >= 0.1) return 15;
  if (clicksPerPage >= 0.01) return 8;
  return 0;
}

// ── Content signal (0–25 pts) ──

function scoreContent(g) {
  const wc = g.avgWordCount || 0;
  const sim = g.contentSimilarity ?? 1;

  if (wc >= 500 && sim < 0.80) return 25; // rich + diverse
  if (wc >= 300 || sim < 0.90) return 15;
  if (wc >= 100) return 8;
  return 0; // thin shell
}

// ── Structure signal (0–25 pts) ──

function scoreStructure(g) {
  const domSim = g.domSimilarity ?? 1;
  const canonicalRate = g.canonicalRate ?? 0;

  if (domSim < 0.95 && canonicalRate >= 0.80) return 25;
  if (canonicalRate >= 0.80) return 15;
  if (domSim < 0.98) return 8;
  return 0;
}

// ── Recommendations ──

function generateRecommendations(g, scores, verdict) {
  const recs = [];
  const urlCount = g.urlCount.toLocaleString();

  // Massive invisible template
  if (g.indexationEfficiency != null && g.indexationEfficiency < 0.02 && g.urlCount > 1000) {
    recs.push(
      `Only ${g.gscUrlsWithImpressions || 0} of ${urlCount} pages have search impressions (${(g.indexationEfficiency * 100).toFixed(1)}% efficiency). ` +
      `Consider noindex on low-demand pages and consolidating into a hub page.`
    );
  }

  // Near-duplicate thin content
  if ((g.contentSimilarity ?? 0) > 0.92 && (g.avgWordCount || 0) < 200) {
    recs.push(
      `Detected near-duplicate thin content (${Math.round((g.contentSimilarity || 0) * 100)}% similar, avg ${Math.round(g.avgWordCount || 0)} words). ` +
      `Add unique H1, meta description, and ≥300 words of dynamic content per page.`
    );
  }

  // Missing canonicals
  if ((g.canonicalRate ?? 1) < 0.5 && g.sampleSize > 0) {
    const pct = Math.round((1 - (g.canonicalRate || 0)) * 100);
    recs.push(
      `${pct}% of sampled pages lack canonical tags. Template pages need self-referential canonicals to prevent deduplication issues.`
    );
  }

  // Ranking but not on page 1
  if ((g.gscAvgPosition ?? 100) > 20 && (g.gscTotalImpressions || 0) > 100) {
    recs.push(
      `Pages rank at avg position ${g.gscAvgPosition} — not on page 1. Internal linking from authority pages to top-performing variants may lift rankings.`
    );
  }

  // Zero impressions on large template
  if ((g.gscTotalImpressions || 0) === 0 && g.gscTotalImpressions != null && g.urlCount > 500) {
    recs.push(
      `Zero search impressions across ${urlCount} pages. Evaluate whether this template targets any real search demand.`
    );
  }

  // Pure structural clone
  if ((g.domSimilarity ?? 0) > 0.98 && g.urlCount > 100) {
    recs.push(
      `DOM structure is near-identical across all samples — pure programmatic template. Ensure each page has a unique title, meta, and H1.`
    );
  }

  // High-value template — positive recommendation
  if (verdict === 'high-value' && g.gscTotalClicks > 0) {
    recs.push(
      `This template drives real traffic (${g.gscTotalClicks.toLocaleString()} clicks). ` +
      `Focus on enriching the top ${Math.min(50, g.gscUrlsWithImpressions || 0)} pages with unique content.`
    );
  }

  // No recommendations generated — add a generic one
  if (recs.length === 0) {
    if (verdict === 'mixed') {
      recs.push(`Mixed signals — some pages perform, most don't. Audit the top-performing variants to understand what differentiates them.`);
    } else if (verdict === 'thin' || verdict === 'invisible') {
      recs.push(`This template shows minimal search value. Consider whether these pages serve user needs or just inflate the sitemap.`);
    }
  }

  return recs;
}
