/**
 * Entity Mapping & Schema Audit
 *
 * Audits Organization JSON-LD placement and `sameAs` identity links. Local mode
 * uses the crawl database only; live mode additionally resolves redirects and
 * checks whether accessible profiles expose the official site hostname.
 */

import { mapLimit, LIVE_CONCURRENCY } from '../../lib/concurrency.js';
import { upsertInsights } from '../../db/db.js';

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
  upsertInsights(db, project, 'entity_gap', issues
    .filter(i => i.severity === 'error' || i.severity === 'warning')
    .map(i => ({
      fingerprint: `${i.code}::${(i.url || i.pageUrl || '').toLowerCase().replace(/\/+$/, '')}`,
      data: { code: i.code, severity: i.severity, url: i.url || i.pageUrl || null, message: i.message, recommendation: i.message },
    })));

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
