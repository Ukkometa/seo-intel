/**
 * Backlink Audit — what is wrong with the links you already have.
 *
 * Deliberately not a link index. Ahrefs crawls the open web and will always
 * cover more of it; what it cannot do is tell you which links *Google* actually
 * attributes to you, and it has none of your query data or citability scores to
 * join against. This audit reads two authoritative-but-narrow sources instead —
 * Search Console's own export, and the links Bing Webmaster Tools reports from
 * Bing's index (seo-intel bing-links) — and asks the questions an index does not:
 *
 *   reclamation   which domains link to a name you no longer use
 *   equity        which links are followed, and which are not
 *   concentration how much of the profile rests on one domain
 *   liveness      which links are actually still there (--live)
 *   targets       which of your pages receive links, and which receive none
 *
 * Both are samples. Search Console's export is capped and lagging; Bing reports
 * what Bing's own crawler has seen, capped and lagging in its own way. So every
 * row carries its origin ('gsc', 'bing' or 'bing,gsc'), for two reasons. A link
 * both engines report is corroborated: two independent crawlers saw it, which
 * is the nearest thing to confirmation short of fetching the page. And the
 * union of two samples is still a sample. Merging them makes the table bigger,
 * not complete, so every summary names the sources it rests on and none of it
 * should be read as a complete link profile.
 *
 * The sources also differ in what they carry. The export has only the linking
 * URL; Bing adds which page of yours is linked and the anchor text, so its rows
 * feed the target-page analysis without --live. Neither says whether a link is
 * followed. Equity is known only for a link the --live pass found on the page;
 * an unchecked link, whoever reported it, is unknown and never counted as
 * followed.
 *
 * A table from before the origin column existed held only Search Console rows,
 * so a missing or NULL origin reads as 'gsc'.
 */

import { mapLimit, LIVE_CONCURRENCY } from '../../lib/concurrency.js';
import { deriveBrandTerms } from '../../lib/brand.js';
import { normalizeUrlKey } from '../../lib/gsc-import.js';
import { upsertInsights } from '../../db/db.js';

const NOFOLLOW_RE = /\b(nofollow|ugc|sponsored)\b/i;

// Most backlink_gap rows one run writes to the Ledger; the same number the
// result's `reclamation` list is cut to. See the upsert below for why the cap
// also decides whether the run may resolve anything.
const RECLAMATION_CAP = 25;

// A page that serves almost no anchors or text to a bot has not shown us its
// links — it rendered them client-side, or it served a wall. Not finding our
// link in that HTML says nothing about whether the link exists, so the result
// is unknown rather than lost. Reddit returns 0 anchors and 29 words here.
const MIN_ANCHORS_FOR_ABSENCE = 10;
const MIN_WORDS_FOR_ABSENCE = 150;

// The note every Search-Console-only audit has always carried. Kept verbatim
// so an audit with no Bing rows reads exactly as it did before Bing existed.
const GSC_ONLY_NOTE = 'Search Console exports a capped, lagging sample of the links it attributes to you. This is not a complete link profile.';

/**
 * The sources that reported a row, as a sorted array: ['gsc'], ['bing'] or
 * ['bing', 'gsc'] — the same sorted comma list the origin column stores. A row
 * with no origin (a table older than the column, or a row the backfill has not
 * reached) came from the Search Console export, unless its source says 'bing':
 * the Bing writer stamps that on every row it creates.
 */
export function originsOf(row) {
  const raw = row && typeof row.origin === 'string' ? row.origin : '';
  const set = new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (!set.size) set.add(row?.source === 'bing' ? 'bing' : 'gsc');
  return [...set].sort();
}

/**
 * Rows and distinct linking domains per origin. A row both sources reported
 * counts in gsc, in bing, and in both: gsc and bing answer "what did this
 * source see", both answers "what is corroborated".
 */
export function countByOrigin(rows) {
  const acc = { gsc: [0, new Set()], bing: [0, new Set()], both: [0, new Set()] };
  const add = (k, r) => { acc[k][0]++; acc[k][1].add(r.linking_domain); };
  for (const r of rows) {
    const o = originsOf(r);
    const g = o.includes('gsc'), b = o.includes('bing');
    if (g) add('gsc', r);
    if (b) add('bing', r);
    if (g && b) add('both', r);
  }
  const out = {};
  for (const [k, [n, doms]] of Object.entries(acc)) out[k] = { rows: n, domains: doms.size };
  return out;
}

/**
 * What the rows are a sample of, in words. With no Bing rows this is the note
 * the audit has always printed. With Bing rows it names both sources, what
 * each is a sample of, what corroboration there is, and that no combination of
 * them is a complete profile.
 */
export function sampleNote(byOrigin) {
  if (!byOrigin?.bing?.rows) return GSC_ONLY_NOTE;
  const parts = [];
  parts.push(byOrigin.gsc.rows
    ? 'Search Console exports a capped, lagging sample of the links Google attributes to you.'
    : 'No Search Console export is imported, so none of these links is known to be one Google attributes to you.');
  parts.push('Bing reports the links its own index has seen: a different sample, also capped and lagging.');
  if (byOrigin.both.rows) {
    parts.push(`${byOrigin.both.rows} linking page(s) are reported by both, which corroborates them.`);
  } else if (byOrigin.gsc.rows) {
    parts.push('No linking page is reported by both yet, so none is corroborated.');
  }
  parts.push('Neither source, nor both together, is a complete link profile.');
  return parts.join(' ');
}

/**
 * How much of the profile the target-page analysis can see. Search Console
 * never exports the linked page, so until --live or Bing fills it in, "no
 * links to this page" can mean "no link we know the target of".
 */
export function targetsNote(known, live) {
  if (!known) return 'No linking page has a known target yet. seo-intel bing-links reports targets for the links Bing has seen; --live recovers them from the linking pages.';
  if (known >= live) return `The linked page is known for all ${live} linking pages not proved gone (recovered by --live, or reported by Bing).`;
  return `The linked page is known for ${known} of ${live} linking pages not proved gone (recovered by --live, or reported by Bing). A page listed as receiving no links may still be linked from one of the other ${live - known}.`;
}

/**
 * Why followed + nofollowed does not add up to the profile. Neither source
 * reports rel, so equity comes only from --live; a reported link it has not
 * found on the page is unknown, and a Bing report in particular is evidence
 * that a link exists, never that it is followed.
 */
export function equityNote(hasBing, unknown, unknownBing) {
  const parts = [hasBing
    ? 'Neither Search Console nor Bing reports whether a link is followed.'
    : 'Search Console does not report whether a link is followed.'];
  parts.push('Equity is known only for links the --live pass found on the page.');
  if (!unknown) {
    parts.push('Every link not proved gone has been found on its page.');
    return parts.join(' ');
  }
  parts.push(`${unknown} link(s) are unchecked or were checked without a verdict; their equity is unknown and none is counted as followed.`);
  if (unknownBing) {
    parts.push(`That includes ${unknownBing} Bing-reported link(s): Bing says the link exists, not whether it passes equity, so each stays unknown until --live checks it.`);
  }
  return parts.join(' ');
}

// A link the --live pass proved is no longer there: the linking page is dead,
// or it rendered in full and our link was not in it.
const isGone = r => r.verify_state === 'gone' || (r.verify_state === 'ok' && r.link_present === 0);

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
      // Either route starts the audit; both together corroborate each other.
      missing_inputs: [
        `Search Console links export for ${project}. Links → External links → Top linking sites → Export, saved to links/${project}-<label>.csv, then seo-intel backlink-import ${project}.`,
        `Bing Webmaster Tools links for ${project}. Bing Webmaster Tools → Settings → API access, set the key as BING_WEBMASTER_API_KEY, then seo-intel bing-links ${project}.`,
      ],
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
    // A link found on the page overwrites target and anchor: what the page says
    // today beats what any report said. A check that found nothing keeps the
    // stored values. A blocked or unrendered fetch knows nothing about the
    // target, and erasing what Bing (or an earlier fetch) reported would throw
    // away the only evidence there is. A link proved gone keeps them too; the
    // target analysis below leaves gone rows out, which is what used to happen
    // by nulling them.
    const stmt = db.prepare(`UPDATE backlinks SET checked_at=?, http_status=?, verify_state=?,
      link_present=?, rel_nofollow=?, target_url=COALESCE(?, target_url),
      anchor_text=COALESCE(?, anchor_text) WHERE id=?`);
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
  const gone = checked.filter(isGone);
  const followed = conclusive.filter(r => r.link_present === 1 && r.rel_nofollow === 0);
  const nofollowed = conclusive.filter(r => r.link_present === 1 && r.rel_nofollow === 1);
  // Equity is only known where --live found the link on the page and read its
  // rel. Everything else that is not gone is unknown: unchecked, or checked
  // without a verdict. A Bing-reported link sits here until --live checks it —
  // Bing reports that a link exists, not whether it is followed — and it is
  // never counted as followed on Bing's word.
  const equityUnknown = rows.filter(r => !isGone(r) && !(r.verify_state === 'ok' && r.link_present === 1));
  const equityUnknownBing = equityUnknown.filter(r => originsOf(r).includes('bing'));

  // ── Which of our pages actually receive links ────────────────────────────
  // A row's target is known when --live recovered it from the page or Bing
  // reported it; both land in target_url and count the same. A link proved
  // gone no longer links anything, so it is left out.
  const targetRows = rows.filter(r => r.target_url && !isGone(r));
  const linkedKeys = new Map();
  for (const r of targetRows) {
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

  const byOrigin = countByOrigin(rows);
  const hasBing = byOrigin.bing.rows > 0;

  const result = {
    project,
    status: 'ok',
    sample_note: sampleNote(byOrigin),
    summary: {
      by_origin: byOrigin,
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
      equityUnknown: equityUnknown.length,
      linkedOwnPages: linkedKeys.size,
      targetsKnown: targetRows.length,
    },
    equity: {
      followed: followed.length,
      nofollowed: nofollowed.length,
      unknown: equityUnknown.length,
      unknown_bing: equityUnknownBing.length,
      note: equityNote(hasBing, equityUnknown.length, equityUnknownBing.length),
    },
    // The unlinked-page list can only be as good as the targets behind it.
    targets_note: targetsNote(targetRows.length, rows.length - gone.length),
    topDomains: domains.slice(0, 15),
    reclamation: reclamation.slice(0, RECLAMATION_CAP),
    unlinkedHighValuePages: unlinkedRanking,
    legacyTerms,
    currentBrand: core,
  };

  if (!opts.skipLedger) {
    // complete — relative to the imported rows (the Search Console export and
    // whatever Bing has reported), which are the only evidence this audit has.
    // Every domain in them was classified, whichever source reported it, so a
    // reclamation row absent from this run is a domain that now links under
    // the current brand, or that neither sample holds any more; either way
    // this audit no longer detects it and the Ledger resolves it. The no_data
    // return above means a missing export resolves nothing. The 25-row cap
    // is a dashboard guard; when it truncates, the run is partial and resolves
    // nothing, for the same reason a top-N list is not a detector.
    upsertInsights(db, project, 'backlink_gap', reclamation.slice(0, RECLAMATION_CAP).map(d => ({
      fingerprint: `reclaim::${d.domain}`,
      data: {
        domain: d.domain, pages: d.pages,
        message: `${d.domain} links to ${project} ${d.pages} time(s) under a name the site no longer uses.`,
        recommendation: `One outreach to ${d.domain} updates ${d.pages} link(s) to the current brand. Existing relationships are cheaper to correct than new links are to earn.`,
      },
    })), { complete: reclamation.length <= RECLAMATION_CAP });
  }
  return result;
}
