/**
 * Backlink Audit — what is wrong with the links you already have.
 *
 * Deliberately not a link index. Ahrefs crawls the open web and will always
 * cover more of it; what it cannot do is tell you which links *Google* actually
 * attributes to you, and it has none of your query data or citability scores to
 * join against. This audit takes the authoritative-but-narrow source — Search
 * Console's own export — and asks the questions an index does not:
 *
 *   reclamation   which domains link to a name you no longer use
 *   equity        which links are followed, and which are not
 *   concentration how much of the profile rests on one domain
 *   liveness      which links are actually still there (--live)
 *   targets       which of your pages receive links, and which receive none
 *
 * Search Console's export is a capped, lagging sample. Every summary here says
 * so; none of it should be read as a complete link profile.
 */

import { mapLimit, LIVE_CONCURRENCY } from '../../lib/concurrency.js';
import { deriveBrandTerms } from '../../lib/brand.js';
import { normalizeUrlKey } from '../../lib/gsc-import.js';
import { upsertInsights } from '../../db/db.js';

const NOFOLLOW_RE = /\b(nofollow|ugc|sponsored)\b/i;

// A page that serves almost no anchors or text to a bot has not shown us its
// links — it rendered them client-side, or it served a wall. Not finding our
// link in that HTML says nothing about whether the link exists, so the result
// is unknown rather than lost. Reddit returns 0 anchors and 29 words here.
const MIN_ANCHORS_FOR_ABSENCE = 10;
const MIN_WORDS_FOR_ABSENCE = 150;

function renderedEnoughToJudge(html) {
  const anchors = (html.match(/<a\b/gi) || []).length;
  const words = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  return { anchors, words, enough: anchors >= MIN_ANCHORS_FOR_ABSENCE && words >= MIN_WORDS_FOR_ABSENCE };
}

async function fetchPage(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'user-agent': 'SEO-Intel/1.6 backlink-audit (+https://ukkometa.fi/seo-intel)' },
    });
    const html = (await res.text()).slice(0, 1_500_000);
    return { status: res.status, html };
  } catch (error) {
    return { status: 0, html: '', error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}

/**
 * Find the anchor that points at our site and read what it says.
 * Returns null when no such anchor is present in the fetched HTML.
 */
export function findOurLink(html, hosts) {
  const anchors = [...(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const [, attrs, inner] of anchors) {
    const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    let host;
    try { host = new URL(href, 'https://example.invalid').hostname.toLowerCase().replace(/^www\./, ''); }
    catch { continue; }
    if (!hosts.some(h => host === h || host.endsWith(`.${h}`))) continue;
    const rel = (attrs.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const text = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { href, rel, nofollow: NOFOLLOW_RE.test(rel), anchor: text.slice(0, 200) || null };
  }
  return null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ live?: boolean, limit?: number, concurrency?: number, brandTerms?: string[], skipLedger?: boolean }} opts
 */
export async function runBacklinkAudit(db, project, opts = {}) {
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM backlinks WHERE project = ? ORDER BY last_crawled DESC').all(project);
  } catch { rows = []; }
  if (!rows.length) {
    return {
      project, status: 'no_data', rows: 0,
      missing_inputs: [`Search Console links export for ${project}. Links → External links → Top linking sites → Export, saved to links/${project}-<label>.csv, then seo-intel backlink-import ${project}.`],
    };
  }

  const brand = deriveBrandTerms(db, project, opts.brandTerms || []);
  const core = brand.core;
  const ownHosts = (() => {
    try {
      return db.prepare("SELECT domain FROM domains WHERE project = ? AND role IN ('target','owned')").all(project)
        .map(d => d.domain.replace(/^www\./, ''));
    } catch { return []; }
  })();

  // ── Profile shape ────────────────────────────────────────────────────────
  const byDomain = new Map();
  for (const r of rows) byDomain.set(r.linking_domain, (byDomain.get(r.linking_domain) || 0) + 1);
  const domains = [...byDomain.entries()].map(([domain, pages]) => ({ domain, pages }))
    .sort((a, b) => b.pages - a.pages);
  const topShare = domains.length ? Math.round(domains[0].pages * 100 / rows.length) : 0;

  // ── Reclamation ──────────────────────────────────────────────────────────
  // A link whose URL carries a brand term that is NOT the current registrable
  // name is pointing at something the site no longer calls itself. Those are
  // existing relationships, which are far cheaper to update than to create.
  const legacyTerms = brand.terms.filter(t => core && !t.includes(core));
  // A brand can appear in a URL spaced, hyphenated, or run together
  // ("spider swap" -> spider-swap, spiderswap), so test each spelling.
  const carries = (url, terms) => {
    const u = url.toLowerCase();
    return terms.some(t => {
      if (t.length < 3) return false;
      const forms = [t, t.replace(/\s+/g, ''), t.replace(/\s+/g, '-'), t.replace(/\s+/g, '_')];
      return forms.some(f => f.length >= 3 && u.includes(f));
    });
  };
  const legacyRows = legacyTerms.length ? rows.filter(r => carries(r.linking_url, legacyTerms)) : [];
  const currentRows = core ? rows.filter(r => r.linking_url.toLowerCase().includes(core)) : [];
  const legacyDomains = new Set(legacyRows.map(r => r.linking_domain));
  const currentDomains = new Set(currentRows.map(r => r.linking_domain));
  const reclamation = [...legacyDomains].filter(d => !currentDomains.has(d))
    .map(domain => ({ domain, pages: legacyRows.filter(r => r.linking_domain === domain).length }))
    .sort((a, b) => b.pages - a.pages);

  // ── Live verification ────────────────────────────────────────────────────
  let verified = 0;
  if (opts.live) {
    const targets = (opts.limit ? rows.slice(0, opts.limit) : rows);
    const hosts = ownHosts.length ? ownHosts : (core ? [`${core}.io`] : []);
    const allHosts = [...new Set([...hosts, ...legacyTerms.map(t => t.replace(/\s+/g, '') + '.io')])];
    const stmt = db.prepare(`UPDATE backlinks SET checked_at=?, http_status=?, verify_state=?,
      link_present=?, rel_nofollow=?, target_url=?, anchor_text=? WHERE id=?`);
    const results = await mapLimit(targets, opts.concurrency || LIVE_CONCURRENCY, async (r) => {
      const res = await fetchPage(r.linking_url);
      // A site that blocks bots tells us nothing about the link. Reporting that
      // as a lost link would be the same error as calling a bot-blocked social
      // profile a missing backlink.
      if (res.status === 403 || res.status === 401 || res.status === 429) {
        return { id: r.id, status: res.status, state: 'blocked', present: null, nofollow: null, target: null, anchor: null };
      }
      if (!res.status) return { id: r.id, status: 0, state: 'error', present: null, nofollow: null, target: null, anchor: null };
      if (res.status >= 400) return { id: r.id, status: res.status, state: 'gone', present: 0, nofollow: null, target: null, anchor: null };
      const found = findOurLink(res.html, allHosts);
      if (found) {
        return {
          id: r.id, status: res.status, state: 'ok', present: 1,
          nofollow: found.nofollow ? 1 : 0, target: found.href, anchor: found.anchor,
        };
      }
      // No anchor found. Only call that an absence if the page actually showed
      // us its links in the first place.
      const shape = renderedEnoughToJudge(res.html);
      return shape.enough
        ? { id: r.id, status: res.status, state: 'ok', present: 0, nofollow: null, target: null, anchor: null }
        : { id: r.id, status: res.status, state: 'unrendered', present: null, nofollow: null, target: null, anchor: null };
    });
    const ts = Date.now();
    db.exec('BEGIN');
    try {
      for (const x of results) {
        stmt.run(ts, x.status || null, x.state, x.present, x.nofollow, x.target, x.anchor, x.id);
        verified++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error('[links] verify write failed:', e.message); }
    rows = db.prepare('SELECT * FROM backlinks WHERE project = ? ORDER BY last_crawled DESC').all(project);
  }

  // ── Equity and liveness, from whatever has been checked ──────────────────
  const checked = rows.filter(r => r.verify_state);
  const conclusive = checked.filter(r => r.verify_state === 'ok');
  // blocked, unrendered and error are all "we could not tell" — kept apart from
  // gone so a bot wall is never reported as a lost link.
  const unknown = checked.filter(r => ['blocked', 'unrendered', 'error'].includes(r.verify_state));
  const blocked = checked.filter(r => r.verify_state === 'blocked');
  const unrendered = checked.filter(r => r.verify_state === 'unrendered');
  const gone = checked.filter(r => r.verify_state === 'gone' || (r.verify_state === 'ok' && r.link_present === 0));
  const followed = conclusive.filter(r => r.link_present === 1 && r.rel_nofollow === 0);
  const nofollowed = conclusive.filter(r => r.link_present === 1 && r.rel_nofollow === 1);

  // ── Which of our pages actually receive links ────────────────────────────
  const linkedKeys = new Map();
  for (const r of rows) {
    if (!r.target_url) continue;
    const k = normalizeUrlKey(r.target_url);
    linkedKeys.set(k, (linkedKeys.get(k) || 0) + 1);
  }
  let unlinkedRanking = [];
  if (linkedKeys.size) {
    try {
      unlinkedRanking = db.prepare(`
        SELECT p.url, c.score FROM pages p
        JOIN domains d ON d.id = p.domain_id
        LEFT JOIN citability_scores c ON c.url = p.url
        WHERE d.project = ? AND d.role IN ('target','owned') AND p.is_indexable = 1
        ORDER BY COALESCE(c.score, 0) DESC LIMIT 60
      `).all(project)
        .filter(p => !linkedKeys.has(normalizeUrlKey(p.url)))
        .slice(0, 15)
        .map(p => ({ url: p.url, citability: p.score ?? null }));
    } catch { /* citability may not exist yet */ }
  }

  const result = {
    project,
    status: 'ok',
    sample_note: 'Search Console exports a capped, lagging sample of the links it attributes to you. This is not a complete link profile.',
    summary: {
      linkingPages: rows.length,
      referringDomains: domains.length,
      topDomainSharePct: topShare,
      legacyBrandPages: legacyRows.length,
      reclamationDomains: reclamation.length,
      verified: checked.length,
      conclusive: conclusive.length,
      blocked: blocked.length,
      unrendered: unrendered.length,
      unknown: unknown.length,
      gone: gone.length,
      followed: followed.length,
      nofollowed: nofollowed.length,
      linkedOwnPages: linkedKeys.size,
    },
    topDomains: domains.slice(0, 15),
    reclamation: reclamation.slice(0, 25),
    unlinkedHighValuePages: unlinkedRanking,
    legacyTerms,
    currentBrand: core,
  };

  if (!opts.skipLedger) {
    upsertInsights(db, project, 'backlink_gap', reclamation.slice(0, 25).map(d => ({
      fingerprint: `reclaim::${d.domain}`,
      data: {
        domain: d.domain, pages: d.pages,
        message: `${d.domain} links to ${project} ${d.pages} time(s) under a name the site no longer uses.`,
        recommendation: `One outreach to ${d.domain} updates ${d.pages} link(s) to the current brand. Existing relationships are cheaper to correct than new links are to earn.`,
      },
    })));
  }
  return result;
}
