/**
 * Crawl Scheduler
 *
 * Decides what to crawl next based on freshness windows.
 * Returns ONE domain per run — never hammers multiple sites at once.
 *
 * Freshness windows:
 *   target site:   7 days  (your own site changes frequently)
 *   competitors:  14 days  (they don't change that often)
 *
 * Priority order:
 *   1. Target site (always first if stale)
 *   2. Competitor sites (round-robin, oldest-crawled-first)
 *   3. Nothing → exit cleanly (DONE signal)
 */

import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FRESHNESS = {
  target:     7  * 24 * 60 * 60 * 1000,  // 7 days
  competitor: 14 * 24 * 60 * 60 * 1000,  // 14 days
};

/**
 * Load all project configs.
 */
export function loadAllConfigs() {
  const configDir = join(__dirname, 'config');
  return readdirSync(configDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(configDir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Get the next domain to crawl across all projects.
 * Returns null if everything is fresh.
 *
 * @param {object} db - DatabaseSync instance
 * @returns {{ project, domain, url, role } | null}
 */
export function getNextCrawlTarget(db) {
  const configs = loadAllConfigs();
  const now = Date.now();

  // Build a flat list of all sites with their last crawl time
  const candidates = [];

  for (const config of configs) {
    const allSites = [config.target, ...(config.owned || []), ...config.competitors];

    for (const site of allSites) {
      const row = db.prepare(
        'SELECT last_crawled FROM domains WHERE domain = ? AND project = ?'
      ).get(site.domain, config.project);

      const lastCrawled = row?.last_crawled || 0;
      const window = site.role === 'competitor' ? FRESHNESS.competitor : FRESHNESS.target;
      const staleSince = now - lastCrawled;
      const isStale = staleSince > window;

      if (isStale) {
        candidates.push({
          project: config.project,
          domain: site.domain,
          url: site.url,
          role: site.role,
          lastCrawled,
          staleSince,
        });
      }
    }
  }

  if (!candidates.length) return null;

  // Owned properties + target site first, then oldest competitor
  const targets = candidates.filter(c => c.role !== 'competitor');
  if (targets.length) return targets[0];

  // Oldest competitor (most stale first)
  candidates.sort((a, b) => a.lastCrawled - b.lastCrawled);
  return candidates[0];
}

/**
 * Check if analysis is needed for a project.
 * True if any domain was crawled since the last analysis.
 */
export function needsAnalysis(db, project) {
  const lastAnalysis = db.prepare(
    'SELECT MAX(generated_at) as t FROM analyses WHERE project = ?'
  ).get(project)?.t || 0;

  const lastCrawl = db.prepare(`
    SELECT MAX(last_crawled) as t FROM domains WHERE project = ?
  `).get(project)?.t || 0;

  return lastCrawl > lastAnalysis;
}

/**
 * Human-readable status of all domains.
 */
export function getCrawlStatus(db) {
  const configs = loadAllConfigs();
  const now = Date.now();
  const rows = [];

  for (const config of configs) {
    const allSites = [config.target, ...(config.owned || []), ...config.competitors];
    for (const site of allSites) {
      const row = db.prepare(
        'SELECT last_crawled FROM domains WHERE domain = ? AND project = ?'
      ).get(site.domain, config.project);

      const lastCrawled = row?.last_crawled;
      const window = site.role === 'competitor' ? FRESHNESS.competitor : FRESHNESS.target;
      const isStale = !lastCrawled || (now - lastCrawled) > window;
      const daysAgo = lastCrawled ? Math.round((now - lastCrawled) / 86400000) : null;

      rows.push({
        project: config.project,
        domain: site.domain,
        role: site.role,
        lastCrawled: lastCrawled ? new Date(lastCrawled).toISOString().split('T')[0] : 'never',
        daysAgo: daysAgo ?? '—',
        status: isStale ? '🔴 stale' : '✅ fresh',
        freshnessWindow: site.role === 'competitor' ? '14d' : '7d',
      });
    }
  }

  return rows;
}
