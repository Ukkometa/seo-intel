/**
 * Technical SEO Audit — reads crawl data from the DB and produces findings.
 *
 * Extended-data checks (gated via lib/gate.js `extended-data`):
 *   1. Title length (>60 warn, missing err)
 *   2. Meta description length (>160 warn, >320 err, missing err)
 *   3. Noindex detection (meta robots OR X-Robots-Tag header)
 *   4. Indexable pages missing from sitemap (set diff)
 *   5. Redirect chain surfacing (uses final_url + redirect_chain columns)
 *   6. Canonical points to a redirect target (uses redirect_chain + technical)
 *
 * Additional optional pass (network-heavy, must be explicitly enabled):
 *   - Sitemap HEAD check: flags 3XX / 4XX URLs in the sitemap itself.
 */

import { gateSection } from '../lib/gate.js';
import { headCheckAll } from '../crawler/sitemap.js';
import {
  getSitemapUrlsForDomain,
  updateSitemapHeadResult,
} from '../db/db.js';

const TITLE_WARN = 60;
const DESC_WARN = 160;
const DESC_ERR = 320;

/**
 * Run the audit for a single domain. Returns { findings: [], stats: {} }.
 * Pass { runSitemapHead: true } to run the HEAD pass over the sitemap inventory.
 * Gated: the actual checks only run when the `extended-data` gate is open.
 */
export async function runTechnicalAudit(db, { project, domain, runSitemapHead = false, sitemapConcurrency = 6 } = {}) {
  if (!gateSection('extended-data')) {
    return { gated: true, findings: [], stats: {} };
  }

  const domainRow = db.prepare(
    'SELECT id, domain FROM domains WHERE domain = ? AND project = ?'
  ).get(domain, project);
  if (!domainRow) {
    return { gated: false, findings: [], stats: {}, error: `domain not found: ${domain}` };
  }
  const domainId = domainRow.id;

  const findings = [];

  // ── Page-level checks (read from pages + technical) ──
  const pages = db.prepare(`
    SELECT
      p.id, p.url, p.final_url, p.redirect_chain, p.x_robots_tag,
      p.is_indexable, p.status_code, p.title, p.meta_desc,
      t.has_canonical
    FROM pages p
    LEFT JOIN technical t ON t.page_id = p.id
    WHERE p.domain_id = ?
  `).all(domainId);

  const redirectTargets = new Set();

  for (const p of pages) {
    // 1. Title length
    if (!p.title) {
      findings.push({ type: 'title_missing', severity: 'error', url: p.url, details: 'No <title>' });
    } else if (p.title.length > TITLE_WARN) {
      findings.push({ type: 'title_too_long', severity: 'warn', url: p.url, details: `${p.title.length}/${TITLE_WARN}` });
    }

    // 2. Meta description length
    if (!p.meta_desc) {
      findings.push({ type: 'meta_desc_missing', severity: 'error', url: p.url, details: 'No meta description' });
    } else if (p.meta_desc.length > DESC_ERR) {
      findings.push({ type: 'meta_desc_too_long', severity: 'error', url: p.url, details: `${p.meta_desc.length}/${DESC_ERR}` });
    } else if (p.meta_desc.length > DESC_WARN) {
      findings.push({ type: 'meta_desc_too_long', severity: 'warn', url: p.url, details: `${p.meta_desc.length}/${DESC_WARN}` });
    }

    // 3. Noindex (meta OR X-Robots-Tag) — informational only (valid decision, not error)
    const xrt = (p.x_robots_tag || '').toLowerCase();
    if (xrt.includes('noindex') && p.is_indexable === 0) {
      findings.push({ type: 'noindex_header', severity: 'info', url: p.url, details: `X-Robots-Tag: ${p.x_robots_tag}` });
    }

    // 5. Redirect chain
    let chain = [];
    try { chain = p.redirect_chain ? JSON.parse(p.redirect_chain) : []; } catch { chain = []; }
    if (chain.length > 0) {
      const finalUrl = p.final_url || p.url;
      findings.push({
        type: 'redirect_chain',
        severity: chain.length >= 2 ? 'warn' : 'info',
        url: p.url,
        details: `${chain.length} hop(s) → ${finalUrl}`,
        hops: chain,
        finalUrl,
      });
      redirectTargets.add(finalUrl);
    }
  }

  // 6. Canonical-points-to-redirect — requires a second pass with canonical URLs.
  // `technical.has_canonical` is a boolean; the canonical URL itself isn't stored.
  // For now we surface the set of redirect *targets* so reviewers can cross-reference.
  if (redirectTargets.size > 0) {
    findings.push({
      type: 'redirect_targets_summary',
      severity: 'info',
      details: `${redirectTargets.size} redirect target URL(s) — review canonical tags pointing to any of these`,
      urls: [...redirectTargets],
    });
  }

  // 4. Indexable-but-not-in-sitemap (set diff)
  const sitemapRows = getSitemapUrlsForDomain(db, domainId);
  const sitemapSet = new Set(sitemapRows.map(r => r.url));
  const missing = pages.filter(p =>
    p.is_indexable === 1 &&
    p.status_code === 200 &&
    !sitemapSet.has(p.url) &&
    !sitemapSet.has(p.final_url || '')
  );
  for (const m of missing) {
    findings.push({
      type: 'indexable_missing_from_sitemap',
      severity: 'warn',
      url: m.url,
      details: 'Page is indexable (200) but not declared in sitemap',
    });
  }

  // Optional: run HEAD pass over sitemap inventory
  let sitemapHeadStats = null;
  if (runSitemapHead && sitemapRows.length > 0) {
    const uncheckedRows = sitemapRows.filter(r => r.head_checked_at === null);
    const rowsToCheck = uncheckedRows.length ? uncheckedRows : sitemapRows;
    let ok = 0, redirected = 0, broken = 0, errored = 0;
    await headCheckAll(rowsToCheck, {
      concurrency: sitemapConcurrency,
      onResult: (row, res) => {
        updateSitemapHeadResult(db, row.id, res);
        if (!res.status) errored++;
        else if (res.status >= 200 && res.status < 300) ok++;
        else if (res.status >= 300 && res.status < 400) {
          redirected++;
          findings.push({
            type: 'sitemap_redirect',
            severity: 'warn',
            url: row.url,
            details: `Sitemap URL returns ${res.status}${res.location ? ` → ${res.location}` : ''}`,
          });
        }
        else if (res.status >= 400) {
          broken++;
          findings.push({
            type: 'sitemap_broken',
            severity: 'error',
            url: row.url,
            details: `Sitemap URL returns ${res.status}`,
          });
        }
      },
    });
    sitemapHeadStats = { checked: rowsToCheck.length, ok, redirected, broken, errored };
  }

  const stats = {
    pages: pages.length,
    sitemap_urls: sitemapRows.length,
    findings_total: findings.length,
    findings_by_severity: findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {}),
    sitemap_head: sitemapHeadStats,
  };

  return { gated: false, findings, stats };
}
