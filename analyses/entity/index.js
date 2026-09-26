/**
 * Entity Mapping & Schema Audit
 *
 * Audits Organization JSON-LD placement and `sameAs` identity links. Local mode
 * uses the crawl database only; live mode additionally resolves redirects and
 * checks whether accessible profiles expose the official site hostname.
 */

import { mapLimit, LIVE_CONCURRENCY } from '../../lib/concurrency.js';
import { upsertInsights, getActiveInsights, updateInsightStatus } from '../../db/db.js';

// The codes only a --live run can produce. A local run reads the crawl and
// probes nothing, so it cannot re-detect these — and a finding a run could not
// have detected is one it must not resolve either.
export const LIVE_ONLY_CODES = Object.freeze(['unreachable_entity_url', 'redirecting_entity_url', 'unidirectional_entity_link']);

// upsertInsights stores at most this many characters of a fingerprint. The
// resolve pass below compares recomputed fingerprints with stored ones, so it
// has to cut them the same way.
const FINGERPRINT_MAX = 300;

const SOCIAL_HOSTS = new Set([
  'x.com', 'twitter.com', 'github.com', 'youtube.com', 'www.youtube.com',
  'medium.com', 'www.medium.com', 'linkedin.com', 'www.linkedin.com',
  'instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com',
  'facebook.com', 'www.facebook.com', 'discord.gg', 'reddit.com', 'www.reddit.com',
]);

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function typesOf(raw) {
  const value = raw?.['@type'];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function sameAsOf(raw) {
  const value = raw?.sameAs;
  return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()) : [];
}

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function pathIsAllowed(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return path === '/' || path === '/about' || path.startsWith('/about/');
  } catch { return false; }
}

function sameUrl(a, b) {
  try {
    const aa = new URL(a); const bb = new URL(b);
    return aa.origin === bb.origin && aa.pathname.replace(/\/+$/, '/') === bb.pathname.replace(/\/+$/, '/');
  } catch { return a === b; }
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: controller.signal,
      headers: { 'user-agent': 'SEO-Intel/1.5 entity-audit (+https://ukkometa.fi/seo-intel)', ...init.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCanonicalUrl(url) {
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD' });
    if ([405, 501].includes(res.status)) res = await fetchWithTimeout(url, { method: 'GET' });
    return {
      input: url,
      status: res.status,
      finalUrl: res.url || url,
      reachable: res.status >= 200 && res.status < 400,
      redirects: !sameUrl(url, res.url || url),
    };
  } catch (error) {
    return { input: url, reachable: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  }
}

async function probeReciprocity(profileUrl, siteHost) {
  try {
    const res = await fetchWithTimeout(profileUrl, { method: 'GET' });
    const html = (await res.text()).slice(0, 1_000_000);
    const bareHost = siteHost.replace(/^www\./i, '');
    const hostRe = new RegExp(`(?:https?:)?//(?:www\\.)?${escapeRe(bareHost)}(?:[/?#\\"'<]|$)`, 'i');
    return {
      status: res.status,
      finalUrl: res.url || profileUrl,
      reachable: res.status >= 200 && res.status < 400,
      observedSiteReference: hostRe.test(html),
      method: 'accessible_profile_html',
    };
  } catch (error) {
    return {
      reachable: false,
      observedSiteReference: null,
      method: 'unavailable',
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

/**
 * Ledger fingerprint of an entity finding: its code and the URL it is about.
 * The formula has not changed since entity_gap rows were first written, and
 * resolveLocalEntityGaps recomputes it from a stored row's data to recognise
 * the row, so changing it would orphan every open row.
 */
export function entityFingerprint(code, url) {
  return `${code}::${(url || '').toLowerCase().replace(/\/+$/, '')}`;
}

/**
 * Resolve the active entity_gap rows a local run no longer detects, leaving
 * alone the ones it could not have detected.
 *
 * The Ledger writer's `complete` flag is all-or-nothing for a type: it would
 * resolve a live run's unreachable / redirecting / unidirectional findings the
 * moment a local run — which never probes a URL — failed to repeat them. So
 * the local run does the resolve step itself, over the active rows minus
 * LIVE_ONLY_CODES, through the same exported API and under the same rule as
 * the writer: only `active` rows are touched, so done / dismissed /
 * in_progress stay as the person left them, and a fingerprint emitted this run
 * stays active. An empty local run resolves every local-code row, as an empty
 * complete run would — fixing the last issue must close it.
 *
 * Best-effort like the writer: a database without the insights table, or a
 * failed update, leaves rows active until the next run rather than failing
 * the audit.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ fingerprint: string }[]} emitted  what this run wrote
 * @returns {number} rows resolved
 */
export function resolveLocalEntityGaps(db, project, emitted) {
  const seen = new Set((Array.isArray(emitted) ? emitted : []).map(f => String(f.fingerprint).slice(0, FINGERPRINT_MAX)));
  let active;
  try { active = getActiveInsights(db, project).entity_gaps || []; } catch { return 0; }
  let n = 0;
  for (const row of active) {
    // A row without a code cannot be placed on either side of the split, so it
    // is left as it is rather than resolved on a guess.
    if (!row?.code || LIVE_ONLY_CODES.includes(row.code)) continue;
    if (seen.has(entityFingerprint(row.code, row.url).slice(0, FINGERPRINT_MAX))) continue;
    try { updateInsightStatus(db, row._insight_id, 'resolved'); n++; } catch { /* best-effort */ }
  }
  return n;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ targetUrl?: string, live?: boolean }} opts
 */
export async function runEntityAudit(db, project, opts = {}) {
  const targetUrl = opts.targetUrl || db.prepare(
    "SELECT p.url FROM pages p JOIN domains d ON d.id = p.domain_id WHERE d.project = ? AND d.role IN ('target', 'owned') ORDER BY CASE WHEN p.url LIKE '%://%/' THEN 0 ELSE 1 END LIMIT 1"
  ).get(project)?.url || null;
  const targetHost = hostOf(targetUrl) || '';
  const targetRoot = targetHost.replace(/^www\./, '');

  const rows = db.prepare(`
    SELECT p.url AS page_url, d.domain, d.role, ps.raw_json
    FROM page_schemas ps
    JOIN pages p ON p.id = ps.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned') AND ps.schema_type = 'Organization'
    ORDER BY p.url
  `).all(project);

  const organizations = [];
  const issues = [];
  const canonicalChecks = [];
  const reciprocity = [];
  const seenOrganizations = new Set();

  for (const row of rows) {
    const raw = parseJson(row.raw_json);
    if (!raw || !typesOf(raw).includes('Organization')) continue;
    // One page crawled under two URL spellings ("https://x.io" and
    // "https://x.io/") yields the same Organization block twice. Count and
    // report it once, keyed by page identity plus entity identity.
    const pageKey = row.page_url.replace(/\/+$/, '').toLowerCase();
    const orgKey = `${pageKey}|${raw['@id'] || raw.url || raw.name || ''}`;
    if (seenOrganizations.has(orgKey)) continue;
    seenOrganizations.add(orgKey);
    const sameAs = sameAsOf(raw);
    const placement = pathIsAllowed(row.page_url) ? 'allowed' : 'subpage';
    const record = {
      pageUrl: row.page_url,
      name: raw.name || null,
      organizationUrl: raw.url || null,
      id: raw['@id'] || null,
      logo: typeof raw.logo === 'string' ? raw.logo : raw.logo?.url || raw.logo?.['@id'] || null,
      placement,
      sameAs,
    };
    organizations.push(record);

    if (placement === 'subpage' && sameAs.length) {
      issues.push({ severity: 'warning', code: 'schema_bloat', pageUrl: row.page_url, message: 'Organization.sameAs is repeated on a subpage. Keep identity mapping on the homepage or /about unless the repetition is intentional and maintained.' });
    }
    if (!sameAs.length) {
      issues.push({ severity: 'warning', code: 'missing_sameas', pageUrl: row.page_url, message: 'Organization schema has no sameAs identity links.' });
    }

    const seen = new Set();
    for (const profileUrl of sameAs) {
      let parsed;
      try { parsed = new URL(profileUrl); } catch {
        issues.push({ severity: 'error', code: 'invalid_sameas_url', pageUrl: row.page_url, url: profileUrl, message: 'sameAs must contain an absolute URL.' });
        continue;
      }
      if (parsed.protocol !== 'https:') {
        issues.push({ severity: 'warning', code: 'non_https_sameas', pageUrl: row.page_url, url: profileUrl, message: 'Use the final HTTPS profile URL.' });
      }
      const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
      if (seen.has(normalized)) {
        issues.push({ severity: 'warning', code: 'duplicate_sameas', pageUrl: row.page_url, url: profileUrl, message: 'Duplicate sameAs URL.' });
      }
      seen.add(normalized);

      const host = hostOf(profileUrl);
      if (host && (host === targetRoot || host.endsWith(`.${targetRoot}`))) {
        issues.push({ severity: 'notice', code: 'owned_surface_in_sameas', pageUrl: row.page_url, url: profileUrl, message: 'This is an owned web surface, not an external identity profile. Keep it in WebSite/WebPage linking rather than sameAs unless it represents a separately recognized entity.' });
      } else if (host && !SOCIAL_HOSTS.has(host)) {
        issues.push({ severity: 'notice', code: 'non_profile_sameas', pageUrl: row.page_url, url: profileUrl, message: 'Review whether this sameAs URL is an official public identity profile.' });
      }
    }
  }

  if (!organizations.length) {
    issues.push({ severity: 'error', code: 'missing_organization_schema', message: 'No Organization schema was found on crawled target/owned pages.' });
  }

  if (opts.live) {
    const limit = opts.concurrency || LIVE_CONCURRENCY;
    const urls = [...new Set(organizations.flatMap(o => [o.organizationUrl, o.logo, ...o.sameAs]).filter(Boolean))];
    const checks = await mapLimit(urls, limit, url => probeCanonicalUrl(url));
    for (const check of checks) {
      canonicalChecks.push(check);
      if (!check.reachable) {
        issues.push({ severity: 'warning', code: 'unreachable_entity_url', url: check.input, message: 'Entity URL could not be reached by the validator.' });
      } else if (check.redirects) {
        issues.push({ severity: 'warning', code: 'redirecting_entity_url', url: check.input, finalUrl: check.finalUrl, message: 'Use the final non-redirecting URL in Organization markup.' });
      }
    }

    const profileUrls = [...new Set(organizations.flatMap(o => o.sameAs))];
    const results = await mapLimit(profileUrls, limit, profileUrl => probeReciprocity(profileUrl, targetHost));
    results.forEach((result, i) => {
      const profileUrl = profileUrls[i];
      reciprocity.push({ profileUrl, ...result });
      if (result.reachable && !result.observedSiteReference) {
        issues.push({ severity: 'warning', code: 'unidirectional_entity_link', url: profileUrl, message: `No ${targetHost} reference was observed in accessible profile HTML. Confirm the Website field/bio links directly to the canonical site.` });
      }
    });
  }

  const homepageOrganizations = organizations.filter(o => {
    try { return new URL(o.pageUrl).pathname === '/'; } catch { return false; }
  });
  const status = issues.some(i => i.severity === 'error') ? 'fail' : issues.some(i => i.severity === 'warning') ? 'needs_work' : 'pass';

  // Errors and warnings are actionable, so they accumulate in the Ledger.
  // Notices are advisory ("review whether this is an official profile") and
  // would add a row per sameAs URL per run without ever being resolvable.
  //
  // Resolution: this audit reads every crawled target/owned page, so an active
  // entity_gap a run did not emit is no longer detected — for the codes that
  // run could have produced. A --live run produces every code and passes
  // `complete`, letting the Ledger resolve whatever it did not emit. A local
  // run produces every code but the three reachability ones, so it resolves
  // only those it could have detected and leaves the live-only rows for the
  // next --live run (see resolveLocalEntityGaps). Before this split the local
  // run passed `complete` too, and marked a redirecting profile URL "no longer
  // detected" without having probed anything.
  const findings = issues
    .filter(i => i.severity === 'error' || i.severity === 'warning')
    .map(i => ({
      fingerprint: entityFingerprint(i.code, i.url || i.pageUrl),
      data: { code: i.code, severity: i.severity, url: i.url || i.pageUrl || null, message: i.message, recommendation: i.message },
    }));
  if (opts.live) {
    upsertInsights(db, project, 'entity_gap', findings, { complete: true });
  } else {
    upsertInsights(db, project, 'entity_gap', findings);
    resolveLocalEntityGaps(db, project, findings);
  }

  return {
    status,
    project,
    targetUrl,
    targetHost,
    live: !!opts.live,
    organizations,
    canonicalChecks,
    reciprocity,
    issues,
    summary: {
      organizations: organizations.length,
      homepageOrganizations: homepageOrganizations.length,
      sameAsLinks: organizations.reduce((n, o) => n + o.sameAs.length, 0),
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      notices: issues.filter(i => i.severity === 'notice').length,
    },
  };
}
