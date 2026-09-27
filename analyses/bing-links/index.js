/**
 * analyses/bing-links — pull the inbound links Bing Webmaster Tools reports
 * for the target site into the backlinks table, beside the Search Console
 * export.
 *
 * Search Console's Links report has no API. Its links reach seo-intel only
 * as a CSV a person exports by hand, and that CSV carries the linking URL and
 * nothing else: not which of your pages is linked, not the anchor text. Bing
 * Webmaster Tools has an API, and its link reports carry both, so a Bing row
 * feeds the target-page analysis without a --live pass.
 *
 * What it does not do is complete the picture. Bing reports the links BING
 * has seen, from Bing's own index: a second, independent sample, different
 * from Google's, also capped and lagging. A link both engines report is
 * corroborated (backlinks.origin 'bing,gsc'); a link only one reports is not
 * therefore doubtful, just seen once. The union of two samples is still a
 * sample, and nothing here or downstream may call it a complete profile.
 *
 * The walk is two lists deep:
 *   GetLinkCounts  which of your pages have inbound links, and how many. Paged;
 *                  every page is read (up to maxPagesPerList) before anything
 *                  else, so the targets can be ranked by count.
 *   GetUrlLinks    for each of the top maxTargetPages targets, the pages that
 *                  link to it, with anchor text. Paged the same way.
 * Every request counts against the key's daily quota, so one budget
 * (maxRequests) is shared by every worker, the list walk included; when it
 * runs out, no new request starts and the result says truncated. A quota
 * error stops every worker at its next request. Either way each target's
 * links are stored as soon as that target is done, so a stopped run keeps
 * what it fetched and the next run re-reports it harmlessly: the upsert is
 * idempotent.
 *
 * A linking page that links to several of your pages comes back once per
 * target. It is stored once per run, by the first target to finish with it
 * (with one worker, the most-linked), so inserted + updated counts distinct
 * rows and "updated" means a row that existed before this run. The other
 * targets' linking_pages_stored leave it out. Which of your pages a row names
 * is therefore one true target among several, never the only one, the same
 * rule a later run follows when it finds a target already stored.
 *
 * The response shapes are UNVERIFIED against the live API (see the header of
 * lib/bing-api.js): the field names came from prior knowledge because the
 * Microsoft documentation was unreachable. A shape the reader does not
 * recognise fails the run loudly, with the body excerpt, rather than storing
 * nothing. To check them, run with debugDir (the CLI's --debug): the first raw
 * body of each method the run calls (GetUserSites when the site is matched
 * rather than configured, GetLinkCounts, GetUrlLinks) is written to
 * <debugDir>/<project>-bing-<Method>.json for a person to compare with
 * BING_API.fields. It is written before it is read, so a shape miss on that
 * first body leaves it on disk. JSON is pretty-printed; a body that is not
 * JSON is written as Bing sent it, under the same name, because that is the
 * body a person most needs to see.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BING_API,
  BingApiError,
  getLinkCounts,
  getUrlLinks,
  listUserSites,
  matchBingSite,
} from '../../lib/bing-api.js';
import { mapLimit } from '../../lib/concurrency.js';
import { hostOf } from '../../lib/backlink-import.js';
import { upsertBingBacklinks } from '../../db/db.js';

/**
 * maxTargetPages   your pages whose linking pages are listed, most-linked first
 * maxPagesPerList  API pages read per paged list (GetLinkCounts, and each
 *                  target's GetUrlLinks)
 * concurrency      targets walked at once. Kept low: the quota is per key and
 *                  Bing publishes no rate limit to stay under
 * maxRequests      every request this run may make, GetUserSites included
 */
export const DEFAULTS = { maxTargetPages: 50, maxPagesPerList: 20, concurrency: 2, maxRequests: 300 };

const KEY_HINT = `Set ${BING_API.keyEnv} to an API key from Bing Webmaster Tools → Settings → API access.`;

function intAtLeast(value, min, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** A project name as a file-name fragment. */
function fileSafe(name) {
  return String(name ?? '').replace(/[^\w.-]+/g, '_') || 'project';
}

/**
 * Decide which Bing site to read. A configured one (opts.siteUrl, then
 * config.bing.siteUrl) is taken as given, without a request. Otherwise the
 * account's sites are matched against the target domain, and a miss names
 * what the account does have, so the fix is a config line rather than a guess.
 * onRaw is the --debug writer: GetUserSites' shape is as unverified as the
 * link reports', and a readUserSites miss needs its body on disk too.
 */
async function resolveSite({ configured, config, apiKey, fetchImpl, take, onRaw }) {
  if (configured) return { site: String(configured).trim(), reason: 'configured' };
  const domain = config?.target?.domain;
  if (!domain) {
    throw new BingApiError('No Bing Webmaster site to read: set target.domain or bing.siteUrl in the project config.', {
      kind: 'config',
    });
  }
  take();
  const sites = await listUserSites({ apiKey, fetch: fetchImpl, onRaw });
  const match = matchBingSite(sites, { domain });
  if (!match.site) {
    const available = match.available?.length ? match.available.join(', ') : '(none)';
    throw new BingApiError(
      `No Bing Webmaster site matches ${domain} (${match.reason}). Sites in this account: ${available}.`,
      { kind: 'config', hint: 'Add and verify the site in Bing Webmaster Tools, or set bing.siteUrl in the project config to pick one.' },
    );
  }
  return { site: match.site, reason: match.reason };
}

/**
 * Fetch the links Bing reports for the target site and store them.
 *
 * Failures, by BingApiError kind:
 *   quota           every worker stops at its next request; what was stored is
 *                   kept; the result says stopped_reason 'quota'
 *   server,         recorded in errors[] for that target (or list page) and
 *   transport       the run continues. A failure on the first GetLinkCounts
 *                   page propagates: there is nothing to continue with
 *   auth, config,   every worker stops, then the error propagates, with what
 *   shape, other    was already stored kept
 *
 * With dryRun the site is resolved (at most one GetUserSites request) and the
 * plan is returned; no link request is made.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} config            the project config (target.domain, bing.siteUrl)
 * @param {object} [opts]
 * @param {string}   [opts.apiKey]           else BING_WEBMASTER_API_KEY
 * @param {string}   [opts.siteUrl]          override the site; else config.bing.siteUrl, else matched
 * @param {function} [opts.fetch]            injectable fetch (tests)
 * @param {number}   [opts.maxTargetPages]   (DEFAULTS.maxTargetPages)
 * @param {number}   [opts.maxPagesPerList]  (DEFAULTS.maxPagesPerList)
 * @param {number}   [opts.concurrency]      (DEFAULTS.concurrency)
 * @param {number}   [opts.maxRequests]      (DEFAULTS.maxRequests)
 * @param {boolean}  [opts.dryRun]           resolve the site and return the plan
 * @param {string}   [opts.debugDir]         write the first raw bodies here
 * @param {number}   [opts.now]              the run stamp (tests)
 * @param {function} [opts.onProgress]       ({ phase: 'targets', ... }) after the list walk,
 *                                           ({ phase: 'target', ... }) after each target
 * @returns {Promise<{ project: string, site: string, site_reason: string, dry_run: boolean,
 *   max_target_pages: number, max_pages_per_list: number, concurrency: number, max_requests: number,
 *   target_pages_available: number,
 *   target_pages: { url: string, count: number|null, linking_pages_stored: number, complete: boolean }[],
 *   inserted: number, updated: number, requests: number, truncated: boolean,
 *   stopped_reason: 'quota'|'max_requests'|null,
 *   errors: { method: string, target?: string, page: number, kind: string, status: number|null, message: string }[],
 *   linking_domains: number, fetched_at: number }>}
 */
export async function runBingLinks(db, project, config, opts = {}) {
  const apiKey = opts.apiKey || process.env[BING_API.keyEnv];
  if (!apiKey) {
    throw new BingApiError('No Bing Webmaster API key.', { kind: 'config', hint: KEY_HINT });
  }
  const fetchImpl = opts.fetch || globalThis.fetch;
  const dryRun = Boolean(opts.dryRun);
  const maxTargetPages = intAtLeast(opts.maxTargetPages, 1, DEFAULTS.maxTargetPages);
  const maxPagesPerList = intAtLeast(opts.maxPagesPerList, 1, DEFAULTS.maxPagesPerList);
  const concurrency = intAtLeast(opts.concurrency, 1, DEFAULTS.concurrency);
  const maxRequests = intAtLeast(opts.maxRequests, 1, DEFAULTS.maxRequests);
  const fetchedAt = opts.now ?? Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // One budget for every request of the run. take() is synchronous, so two
  // workers can never both spend the last request.
  let requests = 0;
  let truncated = false;
  let stoppedReason = null;
  const take = () => {
    if (requests >= maxRequests) {
      truncated = true;
      stoppedReason = stoppedReason || 'max_requests';
      return false;
    }
    requests++;
    return true;
  };

  // The first raw body of each method, for a person checking the unverified
  // shapes. bingGet calls this before the body is read, so a shape miss on
  // it (or a body that is not JSON) still leaves it. The key is redacted
  // here too: Bing echoing a URL in a body would otherwise carry it to disk.
  const debugged = new Set();
  const debugHook = (method) => {
    if (!opts.debugDir || debugged.has(method)) return undefined;
    return (json, text) => {
      if (debugged.has(method)) return;
      debugged.add(method);
      const body = json === undefined ? String(text ?? '') : `${JSON.stringify(json, null, 2)}\n`;
      mkdirSync(opts.debugDir, { recursive: true });
      writeFileSync(join(opts.debugDir, `${fileSafe(project)}-bing-${method}.json`), body.split(apiKey).join('***'));
    };
  };

  const configured = opts.siteUrl || config?.bing?.siteUrl || null;
  const { site, reason } = await resolveSite({
    configured, config, apiKey, fetchImpl, take, onRaw: debugHook(BING_API.methods.userSites),
  });

  const result = {
    project,
    site,
    site_reason: reason,
    dry_run: dryRun,
    max_target_pages: maxTargetPages,
    max_pages_per_list: maxPagesPerList,
    concurrency,
    max_requests: maxRequests,
    target_pages_available: 0,
    target_pages: [],
    inserted: 0,
    updated: 0,
    requests: 0,
    truncated: false,
    stopped_reason: null,
    errors: [],
    linking_domains: 0,
    fetched_at: fetchedAt,
  };
  if (dryRun) {
    result.requests = requests;
    return result;
  }

  const recordError = (err, fields) => {
    result.errors.push({
      ...fields,
      kind: err?.kind ?? 'error',
      status: err?.status ?? null,
      message: String(err?.message || err),
    });
  };

  // ── Your pages with inbound links, most-linked first ────────────────────
  const counts = new Map();
  let listPages = 1;
  for (let page = 0; page < Math.min(listPages, maxPagesPerList); page++) {
    if (!take()) break;
    let res;
    try {
      res = await getLinkCounts({
        siteUrl: site, page, apiKey, fetch: fetchImpl, onRaw: debugHook(BING_API.methods.linkCounts),
      });
    } catch (err) {
      const kind = err instanceof BingApiError ? err.kind : null;
      if (kind === 'quota') { stoppedReason = 'quota'; break; }
      if ((kind === 'server' || kind === 'transport') && page > 0) {
        recordError(err, { method: BING_API.methods.linkCounts, page });
        break;
      }
      throw err;
    }
    listPages = res.totalPages;
    for (const { url, count } of res.links) {
      const prev = counts.get(url);
      if (prev === undefined || (count ?? -1) > (prev ?? -1)) counts.set(url, count);
    }
  }
  if (listPages > maxPagesPerList) truncated = true;

  const ranked = [...counts].map(([url, count]) => ({ url, count }))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.url.localeCompare(b.url));
  result.target_pages_available = ranked.length;
  const targets = ranked.slice(0, maxTargetPages);
  if (onProgress) onProgress({ phase: 'targets', available: ranked.length, targets: targets.length, requests });

  // ── The pages linking to each target ────────────────────────────────────
  const siteHost = hostOf(site);
  const domains = new Set();
  // Linking URLs this run has stored, whichever target reported them: a page
  // Bing lists for two of your pages is one row, stored once (see header).
  const storedThisRun = new Set();
  let fatal = null;
  let done = 0;
  const halted = () => stoppedReason === 'quota' || fatal !== null;

  result.target_pages = await mapLimit(targets, concurrency, async (target) => {
    const entry = { url: target.url, count: target.count, linking_pages_stored: 0, complete: false };
    const seen = new Map();
    let total = 1;
    let page = 0;
    let finished = false;
    try {
      for (; page < Math.min(total, maxPagesPerList); page++) {
        if (halted() || !take()) break;
        const res = await getUrlLinks({
          siteUrl: site, link: target.url, page, apiKey, fetch: fetchImpl,
          onRaw: debugHook(BING_API.methods.urlLinks),
        });
        total = res.totalPages;
        for (const { url, anchor } of res.details) {
          const domain = hostOf(url);
          // A link from the site itself is not a backlink, whatever the
          // report calls it.
          if (!domain || domain === siteHost || seen.has(url)) continue;
          seen.set(url, { linking_url: url, linking_domain: domain, target_url: target.url, anchor_text: anchor });
        }
      }
      finished = page >= Math.min(total, maxPagesPerList);
      if (finished && total > maxPagesPerList) truncated = true;
    } catch (err) {
      const kind = err instanceof BingApiError ? err.kind : null;
      if (kind === 'quota') stoppedReason = 'quota';
      else if (kind === 'server' || kind === 'transport') {
        recordError(err, { method: BING_API.methods.urlLinks, target: target.url, page });
      } else if (fatal === null) fatal = err;
    }

    // Stored as each target finishes, partial pages included: what Bing
    // answered is true whether or not the walk got to the end. The upsert is
    // synchronous, so no other worker lands between this filter and the Set
    // update below.
    const rows = [...seen.values()].filter(r => !storedThisRun.has(r.linking_url));
    if (rows.length) {
      try {
        const { inserted, updated } = upsertBingBacklinks(db, project, rows, { now: fetchedAt });
        result.inserted += inserted;
        result.updated += updated;
        entry.linking_pages_stored = rows.length;
        for (const r of rows) {
          storedThisRun.add(r.linking_url);
          domains.add(r.linking_domain);
        }
      } catch (err) {
        if (fatal === null) fatal = err;
      }
    }
    entry.complete = finished && total <= maxPagesPerList;
    done++;
    if (onProgress) {
      onProgress({
        phase: 'target', url: target.url, count: target.count, linking_pages_stored: entry.linking_pages_stored,
        done, total: targets.length, requests,
      });
    }
    return entry;
  });

  if (fatal) throw fatal;

  result.requests = requests;
  result.truncated = truncated;
  result.stopped_reason = stoppedReason;
  result.linking_domains = domains.size;
  return result;
}
