// rescore.js — re-check a single URL's AI citability after a fix.
//
// Read-only re-measurement (SEO Intel mutates nothing). Uses the lightweight
// HTTP crawl — the RAW-HTML / "what bots see" lens: if an agent's fix is
// server-rendered, the score moves; if it's JS-only, it correctly does not.
// This closes the agent loop: act → re-score → see the delta.
import { lightCrawl } from '../../crawler/light.js';

const bucket = (s) => (s == null ? null : s >= 75 ? 'good' : s >= 55 ? 'needs-work' : s >= 35 ? 'weak' : 'poor');

/**
 * @param {object} db        open SQLite handle (for the stored baseline)
 * @param {string} project   project name (scopes the baseline lookup)
 * @param {string} url        the URL to re-score
 * @param {object} [opts]     { log?: (msg)=>void }
 * @returns {Promise<{url, status_code, lens, before, after, delta, improved, status_before, status_after, signals, note}>}
 */
export async function rescorePage(db, project, url, opts = {}) {
  // Baseline = most recent stored citability score (from the last full crawl).
  let before = null;
  try {
    const row = db.prepare(`
      SELECT c.score
      FROM citability_scores c
      JOIN pages p ON p.id = c.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND p.url = ?
      ORDER BY c.scored_at DESC
      LIMIT 1
    `).get(project, url);
    before = row ? row.score : null;
  } catch { /* citability_scores table may not exist yet */ }

  const r = await lightCrawl(url, {
    maxPages: 1,
    includeCitability: true,
    sameOrigin: true,
    onProgress: opts.log,
  });

  const page = (r.pages || [])[0] || null;
  const cite = page && page.citability && !page.citability.error ? page.citability : null;
  const after = cite ? cite.score : null;
  const delta = before != null && after != null ? after - before : null;

  return {
    url,
    status_code: page ? page.status_code : null,
    lens: 'raw-html', // bot's-eye view — what crawlers / LLMs actually see
    before, // last full-crawl score (baseline)
    after, // current raw / bot-visible score
    delta,
    improved: delta != null ? delta > 0 : null,
    status_before: bucket(before),
    status_after: bucket(after),
    signals: cite ? cite.breakdown : null,
    note: cite ? null : ((page && page.citability && page.citability.error) || 'no citability computed for this URL'),
  };
}
