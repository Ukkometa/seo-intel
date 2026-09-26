/**
 * gsc-inspect — candidate selection (demand first, recency skip, property
 * membership), quota discipline, and persistence, against a fake URL
 * Inspection API.
 *
 * Nothing here reaches the network or the real token store: fetch and the
 * OAuth module are injected, and the database is an in-memory DatabaseSync
 * with the gsc_* DDL db/db.js applies (copied verbatim so a schema change
 * that breaks the upsert's ON CONFLICT target breaks this test too) plus the
 * minimal domains/pages/sitemap_urls shapes test/review.test.js uses. The
 * clock is a fixed `now` so the recency and quota-day arithmetic holds
 * whenever the test runs.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GSC_ENDPOINTS, GscApiError, URL_INSPECTION_QUOTA } from '../lib/gsc-api.js';
import { getGscInspections } from '../db/db.js';
import {
  DEFAULTS,
  DEMAND_WINDOW_DAYS,
  runGscInspect,
  selectCandidates,
  startOfUtcDay,
} from '../analyses/gsc-inspect/index.js';

const DAY = 86_400_000;
// 2026-09-26 14:30 UTC: mid-day, so "today" has room on both sides.
const NOW = Date.UTC(2026, 8, 26, 14, 30);
const PROPERTY = 'sc-domain:acme.io';

// The gsc_* DDL below is copied verbatim from db/db.js getDb(). Keep them identical.
const GSC_DDL = `
  CREATE TABLE IF NOT EXISTS gsc_daily (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT NOT NULL,
    property     TEXT NOT NULL,      -- Search Console siteUrl the rows came from
    grain        TEXT NOT NULL,      -- page_query | page | query
    search_type  TEXT NOT NULL DEFAULT 'web',
    date         TEXT NOT NULL,      -- YYYY-MM-DD as the API returns it
    page_url     TEXT,               -- NULL for the query grain
    query        TEXT,               -- NULL for the page grain
    clicks       INTEGER NOT NULL DEFAULT 0,
    impressions  INTEGER NOT NULL DEFAULT 0,
    ctr          REAL,               -- fraction 0-1 as the API returns it (gsc_queries stores PERCENT — do not mix)
    position     REAL,
    fetched_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_daily_identity
    ON gsc_daily(project, property, grain, search_type, date, COALESCE(page_url,''), COALESCE(query,''));
  CREATE INDEX IF NOT EXISTS idx_gsc_daily_page ON gsc_daily(project, grain, page_url, date);
  CREATE INDEX IF NOT EXISTS idx_gsc_daily_date ON gsc_daily(project, grain, date);
  CREATE TABLE IF NOT EXISTS gsc_inspections (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    project               TEXT NOT NULL,
    property              TEXT NOT NULL,
    url                   TEXT NOT NULL,        -- as inspected (the crawled spelling)
    inspected_at          INTEGER NOT NULL,
    verdict               TEXT,                 -- PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
    coverage_state        TEXT,                 -- Google's prose
    robots_txt_state      TEXT,
    indexing_state        TEXT,
    page_fetch_state      TEXT,
    last_crawl_time       TEXT,                 -- RFC3339 as Google returns it
    crawled_as            TEXT,
    google_canonical      TEXT,
    user_canonical        TEXT,
    sitemaps              TEXT,                 -- JSON array
    referring_urls        TEXT,                 -- JSON array
    rich_results_verdict  TEXT,
    raw                   TEXT,                 -- the full inspectionResult JSON
    UNIQUE(project, url)
  );
  CREATE INDEX IF NOT EXISTS idx_gsc_inspections_project ON gsc_inspections(project, inspected_at);
`;

const CRAWL_DDL = `
  CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT, word_count INTEGER,
    status_code INTEGER, is_indexable INTEGER DEFAULT 1, click_depth INTEGER DEFAULT 0, x_robots_tag TEXT,
    crawled_at INTEGER, first_seen_at INTEGER);
  CREATE TABLE sitemap_urls (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, sitemap_source TEXT, discovered_at INTEGER);
`;

/**
 * A project with a target domain, an owned subdomain and a competitor. Pages
 * are inserted by the caller so each case states its own inventory.
 */
function fixture({ withGsc = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(CRAWL_DDL);
  if (withGsc) db.exec(GSC_DDL);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'acme', 'target');
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(2, 'docs.acme.io', 'acme', 'owned');
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(3, 'rival.example', 'acme', 'competitor');
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(4, 'elsewhere.test', 'other-project', 'target');
  let nextId = 1;
  const page = (url, { domainId = 1, status = 200, indexable = 1 } = {}) => {
    db.prepare(`INSERT INTO pages (id, domain_id, url, title, body_text, word_count, status_code, is_indexable, click_depth, crawled_at, first_seen_at)
      VALUES (?, ?, ?, ?, 'text', 400, ?, ?, 1, ?, ?)`).run(nextId++, domainId, url, url, status, indexable, NOW - DAY, NOW - DAY);
  };
  const sitemap = (url, domainId = 1) => db.prepare('INSERT INTO sitemap_urls (domain_id, url, discovered_at) VALUES (?, ?, ?)').run(domainId, url, NOW - DAY);
  const demand = (pageUrl, impressions, date = '2026-09-23') => db.prepare(`
    INSERT INTO gsc_daily (project, property, grain, search_type, date, page_url, query, clicks, impressions, ctr, position, fetched_at)
    VALUES ('acme', ?, 'page', 'web', ?, ?, NULL, 0, ?, NULL, NULL, ?)`).run(PROPERTY, date, pageUrl, impressions, NOW - DAY);
  const inspected = (url, at, verdict = 'PASS') => db.prepare(`
    INSERT INTO gsc_inspections (project, property, url, inspected_at, verdict, sitemaps, referring_urls, raw)
    VALUES ('acme', ?, ?, ?, ?, '[]', '[]', '{}')`).run(PROPERTY, url, at, verdict);
  return { db, page, sitemap, demand, inspected };
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;

// ── constants and the quota day ─────────────────────────────────────────────
assert.deepEqual(DEFAULTS, { limit: 100, maxAgeDays: 7, concurrency: 4 });
assert.equal(DEMAND_WINDOW_DAYS, 28);
assert.equal(startOfUtcDay(NOW), Date.UTC(2026, 8, 26));
assert.equal(startOfUtcDay(Date.UTC(2026, 8, 26, 23, 59, 59)), Date.UTC(2026, 8, 26));
assert.equal(startOfUtcDay(Date.UTC(2026, 8, 26)), Date.UTC(2026, 8, 26), 'midnight is its own day');

// ── selectCandidates: ordering ──────────────────────────────────────────────
// Demand first, then sitemap presence, then the crawl's indexability, then URL.
{
  const f = fixture();
  f.page('https://acme.io/a');                                   // nothing going for it
  f.page('https://acme.io/b');                                   // 50 impressions, reported under another spelling
  f.page('https://acme.io/c');                                   // in the sitemap
  f.page('https://acme.io/d', { indexable: 0 });                 // in the sitemap, noindex
  f.page('https://acme.io/e');                                   // ties with /a; URL breaks it
  f.page('https://acme.io/f', { status: 404 });                  // not a 200: never a candidate
  f.page('https://acme.io/g', { status: 301 });                  // nor a redirect
  f.page('https://docs.acme.io/', { domainId: 2 });              // owned subdomain: in
  f.page('https://rival.example/', { domainId: 3 });             // competitor: out
  f.page('https://elsewhere.test/', { domainId: 4 });            // another project: out
  f.sitemap('https://acme.io/c');
  f.sitemap('https://acme.io/d');
  f.sitemap('https://rival.example/', 3);                        // a competitor's sitemap says nothing about ours
  // Demand rows: www + trailing slash spelling still credits /b (normalizeUrlKey).
  f.demand('https://www.acme.io/b/', 30, '2026-09-20');
  f.demand('https://www.acme.io/b/', 20, '2026-09-23');
  // /a earned 100 impressions, but 40 days before the latest fetched day: outside the 28-day window.
  f.demand('https://acme.io/a', 100, '2026-08-14');
  // A page_query row must not count towards the page grain.
  f.db.prepare(`INSERT INTO gsc_daily (project, property, grain, search_type, date, page_url, query, clicks, impressions, fetched_at)
    VALUES ('acme', ?, 'page_query', 'web', '2026-09-23', 'https://acme.io/e', 'acme e', 0, 999, ?)`).run(PROPERTY, NOW);

  const sel = selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW });
  assert.deepEqual(sel.urls, [
    'https://acme.io/b',       // 50 impressions in the window
    'https://acme.io/c',       // sitemap, indexable
    'https://acme.io/d',       // sitemap, noindex
    'https://acme.io/a',       // neither; URL order
    'https://acme.io/e',
    'https://docs.acme.io/',
  ]);
  assert.equal(sel.skipped_recent, 0);
  assert.deepEqual(sel.skipped_out_of_property, []);

  // limit cuts from the tail, so the quota goes to the head of the order.
  assert.deepEqual(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, limit: 3 }).urls,
    ['https://acme.io/b', 'https://acme.io/c', 'https://acme.io/d']);
  assert.equal(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, limit: 0 }).urls.length, 6, 'a nonsense limit falls back to the default');
  assert.equal(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, limit: 'lots' }).urls.length, 6);

  // A URL-prefix property on the bare host leaves the owned subdomain outside.
  const prefix = selectCandidates(f.db, 'acme', { property: 'https://acme.io/', now: NOW });
  assert.equal(prefix.urls.includes('https://docs.acme.io/'), false);
  assert.deepEqual(prefix.skipped_out_of_property, ['https://docs.acme.io/']);
  assert.equal(prefix.urls.length, 5);

  // Without a property nothing can be checked, so nothing is excluded on that ground.
  assert.equal(selectCandidates(f.db, 'acme', { now: NOW }).urls.length, 6);
  assert.deepEqual(selectCandidates(f.db, 'other-project', { property: 'sc-domain:elsewhere.test', now: NOW }).urls, ['https://elsewhere.test/']);
}

// ── selectCandidates: demand follows the property fetched most recently ─────
// A project that moved from a URL-prefix property to a domain property keeps
// the old rows in gsc_daily. They may hold more impressions and even a later
// date, but the pair fetched most recently is the one lib/gsc-import.js sums
// and a new gsc-fetch would extend, so it is the one that orders the quota.
{
  const f = fixture();
  f.page('https://acme.io/old-hit');
  f.page('https://acme.io/new-hit');
  f.page('https://acme.io/quiet');
  const abandoned = f.db.prepare(`
    INSERT INTO gsc_daily (project, property, grain, search_type, date, page_url, query, clicks, impressions, ctr, position, fetched_at)
    VALUES ('acme', 'https://www.acme.io/', 'page', 'web', ?, ?, NULL, 0, ?, NULL, NULL, ?)`);
  abandoned.run('2026-09-23', 'https://www.acme.io/old-hit', 900, NOW - 30 * DAY);   // the same latest date as the domain property's ...
  abandoned.run('2026-09-24', 'https://www.acme.io/old-hit', 900, NOW - 30 * DAY);   // ... and a later one, which must not make it the source
  abandoned.run('2026-09-24', 'https://www.acme.io/quiet', 400, NOW - 30 * DAY);
  f.demand('https://acme.io/new-hit', 50);                       // PROPERTY, fetched NOW - DAY: the current pair
  f.demand('https://acme.io/old-hit', 10);

  assert.deepEqual(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW }).urls,
    ['https://acme.io/new-hit', 'https://acme.io/old-hit', 'https://acme.io/quiet'],
    'ordered by the domain property\'s 28 days, not by the abandoned property\'s larger, later numbers');

  // The choice is by fetch recency alone: make the URL-prefix rows the newer
  // fetch and its numbers order the run, whatever property is inspected against.
  f.db.prepare("UPDATE gsc_daily SET fetched_at = ? WHERE property = 'https://www.acme.io/'").run(NOW);
  assert.deepEqual(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW }).urls,
    ['https://acme.io/old-hit', 'https://acme.io/quiet', 'https://acme.io/new-hit']);
}

// ── selectCandidates: recency ───────────────────────────────────────────────
{
  const f = fixture();
  f.page('https://acme.io/fresh');
  f.page('https://acme.io/stale');
  f.page('https://acme.io/never');
  f.demand('https://acme.io/fresh', 90);
  f.demand('https://acme.io/stale', 80);
  f.inspected('https://acme.io/fresh', NOW - 2 * DAY);            // two days old: skip
  f.inspected('https://acme.io/stale', NOW - 8 * DAY, 'NEUTRAL'); // eight days old: ask again
  f.db.prepare(`INSERT INTO gsc_inspections (project, property, url, inspected_at, sitemaps, referring_urls, raw)
    VALUES ('other-project', 'x', 'https://acme.io/never', ?, '[]', '[]', '{}')`).run(NOW);   // another project's row is not ours

  const sel = selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW });
  assert.deepEqual(sel.urls, ['https://acme.io/stale', 'https://acme.io/never']);
  assert.equal(sel.skipped_recent, 1);
  // The window is inclusive of maxAgeDays exactly: a row 7 days old is not "newer than" the cutoff.
  f.inspected('https://acme.io/never', NOW - 7 * DAY);
  assert.deepEqual(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW }).urls, ['https://acme.io/stale', 'https://acme.io/never']);
  assert.equal(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, maxAgeDays: 30 }).skipped_recent, 3, 'a longer window skips them all');
  assert.equal(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, maxAgeDays: 0 }).skipped_recent, 0, 'maxAgeDays 0 re-asks everything');
  assert.equal(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, maxAgeDays: 0 }).urls.length, 3);
  // skipped_recent is counted before the limit, so the two are independent.
  const limited = selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, limit: 1 });
  assert.deepEqual(limited.urls, ['https://acme.io/stale']);
  assert.equal(limited.skipped_recent, 1);
}

// ── selectCandidates: explicit urls ─────────────────────────────────────────
{
  const f = fixture();
  f.page('https://acme.io/a');
  f.inspected('https://acme.io/a', NOW - 1000);
  const sel = selectCandidates(f.db, 'acme', {
    property: PROPERTY, now: NOW, limit: 1,
    urls: ['https://acme.io/a', 'https://docs.acme.io/x', 'https://rival.example/', 'https://acme.io/a', '', 'not a url', 'https://acme.io/not-crawled'],
  });
  assert.deepEqual(sel.urls, ['https://acme.io/a', 'https://docs.acme.io/x', 'https://acme.io/not-crawled'],
    'exactly the named URLs, deduplicated, crawled or not, recently inspected or not, beyond the limit or not');
  assert.equal(sel.skipped_recent, 0);
  assert.deepEqual(sel.skipped_out_of_property, ['https://rival.example/', 'not a url']);
  assert.deepEqual(selectCandidates(f.db, 'acme', { property: PROPERTY, now: NOW, urls: [] }), { urls: [], skipped_recent: 0, skipped_out_of_property: [] });
}

// ── selectCandidates: an older database ─────────────────────────────────────
// No gsc_daily, no gsc_inspections, no sitemap_urls: the crawl alone orders.
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, status_code INTEGER, is_indexable INTEGER DEFAULT 1);
  `);
  db.prepare('INSERT INTO domains VALUES (1, ?, ?, ?)').run('acme.io', 'acme', 'target');
  db.prepare('INSERT INTO pages VALUES (1, 1, ?, 200, 0)').run('https://acme.io/a');
  db.prepare('INSERT INTO pages VALUES (2, 1, ?, 200, 1)').run('https://acme.io/b');
  assert.deepEqual(selectCandidates(db, 'acme', { property: PROPERTY, now: NOW }), {
    urls: ['https://acme.io/b', 'https://acme.io/a'], skipped_recent: 0, skipped_out_of_property: [],
  });
  const empty = new DatabaseSync(':memory:');
  assert.deepEqual(selectCandidates(empty, 'acme', { property: PROPERTY, now: NOW }), { urls: [], skipped_recent: 0, skipped_out_of_property: [] }, 'no pages table is no candidates, not a throw');
}

// ── a fake URL Inspection API ───────────────────────────────────────────────
/**
 * Answers GET with the sites list and POST with the inspectionResult keyed by
 * inspectionUrl. `failAt(n)` returns a status to fail the n-th POST with
 * (1-based); an unknown URL answers 400 the way Google does.
 */
const SITES = [
  { siteUrl: 'sc-domain:acme.io', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.acme.io/', permissionLevel: 'siteFullUser' },
];
const ANSWERS = {
  'https://acme.io/': {
    inspectionResultLink: 'https://search.google.com/search-console/inspect?id=home',
    indexStatusResult: {
      verdict: 'PASS', coverageState: 'Submitted and indexed', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2026-09-24T03:12:45Z', pageFetchState: 'SUCCESSFUL', googleCanonical: 'https://acme.io/', userCanonical: 'https://acme.io/',
      sitemap: ['https://acme.io/sitemap.xml'], referringUrls: ['https://acme.io/docs'], crawledAs: 'MOBILE',
    },
    richResultsResult: { verdict: 'PASS', detectedItems: [] },
  },
  'https://acme.io/private': {
    indexStatusResult: {
      verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag", robotsTxtState: 'ALLOWED', indexingState: 'BLOCKED_BY_META_TAG',
      lastCrawlTime: '2026-09-20T10:00:00Z', pageFetchState: 'SUCCESSFUL', crawledAs: 'MOBILE',
    },
  },
  'https://acme.io/old': {
    indexStatusResult: { verdict: 'FAIL', coverageState: 'Not found (404)', pageFetchState: 'NOT_FOUND', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_STATE_UNSPECIFIED' },
  },
  'https://acme.io/docs': {
    indexStatusResult: {
      verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: 'https://acme.io/docs/', userCanonical: 'https://acme.io/docs',
      pageFetchState: 'SUCCESSFUL', crawledAs: 'DESKTOP', sitemap: [], referringUrls: [],
    },
  },
  'https://docs.acme.io/': {
    indexStatusResult: { verdict: 'VERDICT_UNSPECIFIED' },
  },
};

function makeInspectMock({ failAt, answers = ANSWERS, successDelayMs = 0 } = {}) {
  const calls = { get: [], post: [] };
  const fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      calls.get.push({ url, authorization: init.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ({ siteEntry: SITES }) };
    }
    const body = JSON.parse(init.body);
    calls.post.push({ url, authorization: init.headers?.Authorization, body });
    const n = calls.post.length;
    const status = failAt ? failAt(n, body) : 0;
    if (status) {
      return { ok: false, status, text: async () => JSON.stringify({ error: { code: status, message: `mock ${status}`, status: 'ERROR' } }) };
    }
    const answer = answers[body.inspectionUrl];
    if (!answer) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 400, message: 'URL is not in property', status: 'INVALID_ARGUMENT' } }) };
    }
    // A successful answer can be made slower than a failure, so a test can
    // hold a request in flight while a sibling's 429 lands.
    if (successDelayMs) await new Promise(r => setTimeout(r, successDelayMs));
    return { ok: true, status: 200, json: async () => ({ inspectionResult: answer }) };
  };
  return { fetch, calls };
}

const CONFIG = { project: 'acme', target: { domain: 'acme.io' } };

function inventory(f) {
  f.page('https://acme.io/');
  f.page('https://acme.io/private', { indexable: 0 });
  f.page('https://acme.io/old');           // the crawl saw a 200; Google saw a 404 last time it looked
  f.page('https://acme.io/docs');
  f.sitemap('https://acme.io/');
  f.sitemap('https://acme.io/docs');
  f.demand('https://acme.io/', 500);
  f.demand('https://acme.io/docs', 120);
  f.demand('https://acme.io/private', 3);
}

// ── runGscInspect: a full run, then a same-week rerun ───────────────────────
{
  const f = fixture();
  inventory(f);
  const mock = makeInspectMock();
  const progress = [];
  const result = await runGscInspect(f.db, 'acme', CONFIG, {
    accessToken: 'tok', fetch: mock.fetch, now: NOW, concurrency: 2, onProgress: e => progress.push(e),
  });

  // Property: matched from target.domain via the sites list, one GET.
  assert.equal(mock.calls.get.length, 1);
  assert.equal(mock.calls.get[0].url, GSC_ENDPOINTS.sites);
  assert.equal(result.property, PROPERTY);
  assert.equal(result.property_reason, 'domain property');
  assert.equal(result.project, 'acme');
  assert.equal(result.dry_run, false);
  assert.equal(result.inspected_at, NOW);

  // Every request went to the inspection endpoint with the property and the URL.
  assert.equal(mock.calls.post.length, 4);
  assert.ok(mock.calls.post.every(c => c.url === GSC_ENDPOINTS.urlInspection && c.authorization === 'Bearer tok'));
  assert.ok(mock.calls.post.every(c => c.body.siteUrl === PROPERTY && c.body.languageCode === 'en-US'));
  assert.deepEqual([...mock.calls.post.map(c => c.body.inspectionUrl)].sort(), ['https://acme.io/', 'https://acme.io/docs', 'https://acme.io/old', 'https://acme.io/private']);

  // Demand first: the plan and the results read in priority order whatever order the network answered in.
  assert.deepEqual(result.planned, ['https://acme.io/', 'https://acme.io/docs', 'https://acme.io/private', 'https://acme.io/old']);
  assert.deepEqual(result.results.map(r => r.url), result.planned);
  assert.deepEqual(result.results, [
    { url: 'https://acme.io/', verdict: 'PASS', coverage_state: 'Submitted and indexed', google_canonical: 'https://acme.io/' },
    { url: 'https://acme.io/docs', verdict: 'PASS', coverage_state: 'Submitted and indexed', google_canonical: 'https://acme.io/docs/' },
    { url: 'https://acme.io/private', verdict: 'NEUTRAL', coverage_state: "Excluded by 'noindex' tag", google_canonical: null },
    { url: 'https://acme.io/old', verdict: 'FAIL', coverage_state: 'Not found (404)', google_canonical: null },
  ]);
  assert.equal(result.inspected, 4);
  assert.equal(result.requests, 4);
  assert.deepEqual(result.verdicts, { PASS: 2, PARTIAL: 0, FAIL: 1, NEUTRAL: 1, other: 0 });
  assert.equal(result.skipped_recent, 0);
  assert.deepEqual(result.skipped_out_of_property, []);
  assert.equal(result.quota_capped, 0);
  assert.deepEqual(result.quota, { per_day: URL_INSPECTION_QUOTA.perDay, used_today: 0, remaining_after: URL_INSPECTION_QUOTA.perDay - 4 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.stopped_reason, null);
  // A PASS under a different canonical is visible from the summary alone.
  const docs = result.results.find(r => r.url === 'https://acme.io/docs');
  assert.notEqual(docs.google_canonical, docs.url, 'indexed, but under another address');

  // Persistence: one row per URL, the flattened columns, lists as arrays.
  assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 4);
  const rows = getGscInspections(f.db, 'acme');
  assert.ok(rows.every(r => r.property === PROPERTY && r.inspected_at === NOW));
  const home = rows.find(r => r.url === 'https://acme.io/');
  assert.equal(home.verdict, 'PASS');
  assert.equal(home.indexing_state, 'INDEXING_ALLOWED');
  assert.equal(home.robots_txt_state, 'ALLOWED');
  assert.equal(home.page_fetch_state, 'SUCCESSFUL');
  assert.equal(home.last_crawl_time, '2026-09-24T03:12:45Z');
  assert.equal(home.crawled_as, 'MOBILE');
  assert.deepEqual(home.sitemaps, ['https://acme.io/sitemap.xml']);
  assert.deepEqual(home.referring_urls, ['https://acme.io/docs']);
  assert.equal(home.rich_results_verdict, 'PASS');
  assert.deepEqual(JSON.parse(home.raw), ANSWERS['https://acme.io/']);
  const priv = rows.find(r => r.url === 'https://acme.io/private');
  assert.equal(priv.verdict, 'NEUTRAL');
  assert.equal(priv.indexing_state, 'BLOCKED_BY_META_TAG');
  assert.equal(priv.google_canonical, null);
  assert.deepEqual(priv.sitemaps, []);
  assert.equal(priv.rich_results_verdict, null);
  const old = rows.find(r => r.url === 'https://acme.io/old');
  assert.equal(old.verdict, 'FAIL');
  assert.equal(old.page_fetch_state, 'NOT_FOUND');

  // Progress: one event per inspection, carrying a running count.
  assert.equal(progress.length, 4);
  assert.ok(progress.every(e => e.total === 4 && typeof e.verdict === 'string'));
  assert.deepEqual([...progress.map(e => e.done)].sort(), [1, 2, 3, 4]);

  // Same week again: every URL has a fresh row, so nothing is asked.
  const rerun = await runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, now: NOW + 3 * DAY });
  assert.equal(mock.calls.post.length, 4, 'no new inspection requests');
  assert.equal(rerun.inspected, 0);
  assert.equal(rerun.skipped_recent, 4);
  assert.deepEqual(rerun.planned, []);
  assert.deepEqual(rerun.results, []);
  assert.equal(rerun.quota.used_today, 0, 'three days on, the earlier rows are not today\'s spend');

  // Eight days on, they are stale, and a fresh answer replaces the row in place.
  const week = await runGscInspect(f.db, 'acme', CONFIG, {
    accessToken: 'tok', fetch: mock.fetch, now: NOW + 8 * DAY, limit: 1,
    property: PROPERTY,
  });
  assert.equal(week.property_reason, 'configured');
  assert.equal(mock.calls.get.length, 2, 'a configured property skips the sites lookup');
  assert.deepEqual(week.planned, ['https://acme.io/'], 'limit 1 takes the head of the demand order');
  assert.equal(week.inspected, 1);
  assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 4, 're-inspecting adds no rows');
  assert.equal(f.db.prepare("SELECT inspected_at FROM gsc_inspections WHERE url = 'https://acme.io/'").get().inspected_at, NOW + 8 * DAY);
}

// ── runGscInspect: explicit urls, out-of-property skips, and a 400 recorded ─
{
  const f = fixture();
  inventory(f);
  const mock = makeInspectMock();
  const result = await runGscInspect(f.db, 'acme', { ...CONFIG, gsc: { property: PROPERTY } }, {
    accessToken: 'tok', fetch: mock.fetch, now: NOW, concurrency: 1,
    urls: ['https://acme.io/private', 'https://rival.example/', 'https://docs.acme.io/', 'https://acme.io/unknown-to-mock'],
  });
  assert.equal(mock.calls.get.length, 0);
  assert.deepEqual(result.skipped_out_of_property, ['https://rival.example/'], 'never sent: it would be a 400 that still costs a request');
  assert.deepEqual(mock.calls.post.map(c => c.body.inspectionUrl), ['https://acme.io/private', 'https://docs.acme.io/', 'https://acme.io/unknown-to-mock']);
  assert.equal(result.requests, 3);
  assert.equal(result.inspected, 2, 'the 400 is not a stored inspection');
  assert.deepEqual(result.verdicts, { PASS: 0, PARTIAL: 0, FAIL: 0, NEUTRAL: 1, other: 1 }, 'VERDICT_UNSPECIFIED counts as other');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].url, 'https://acme.io/unknown-to-mock');
  assert.equal(result.errors[0].status, 400);
  assert.match(result.errors[0].error, /400/);
  assert.equal(result.errors[0].hint, 'URL is not in property');
  assert.equal(result.stopped_reason, null, 'a 400 does not stop the run');
  assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 2);
  assert.equal(result.quota.remaining_after, URL_INSPECTION_QUOTA.perDay - 3, 'the failed request still counted against the day');
  assert.deepEqual(result.results.map(r => r.url), ['https://acme.io/private', 'https://docs.acme.io/']);
}

// ── runGscInspect: the day's quota caps the plan ────────────────────────────
{
  const f = fixture();
  inventory(f);
  // 1,998 URLs already inspected today under this property (not pages, so not candidates).
  const stmt = f.db.prepare(`INSERT INTO gsc_inspections (project, property, url, inspected_at, verdict, sitemaps, referring_urls, raw)
    VALUES ('acme', ?, ?, ?, 'PASS', '[]', '[]', '{}')`);
  f.db.exec('BEGIN');
  for (let i = 0; i < 1998; i++) stmt.run(PROPERTY, `https://acme.io/q/${i}`, startOfUtcDay(NOW) + i);
  f.db.exec('COMMIT');
  // Rows from yesterday and from another property do not count.
  stmt.run(PROPERTY, 'https://acme.io/yesterday', startOfUtcDay(NOW) - 1);
  stmt.run('https://www.acme.io/', 'https://www.acme.io/other-property', NOW);

  const mock = makeInspectMock();
  const result = await runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, now: NOW, concurrency: 4 });
  assert.equal(result.quota.used_today, 1998);
  assert.equal(result.quota_capped, 2, 'two of the four candidates did not fit');
  assert.deepEqual(result.planned, ['https://acme.io/', 'https://acme.io/docs'], 'the head of the demand order is what fits');
  assert.equal(mock.calls.post.length, 2);
  assert.equal(result.inspected, 2);
  assert.equal(result.quota.remaining_after, 0);
  assert.equal(result.stopped_reason, null, 'a cap is not a 429');

  // Now the day is spent: nothing is planned, nothing is sent.
  const spent = await runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, now: NOW + 1000, maxAgeDays: 0 });
  assert.equal(mock.calls.post.length, 2);
  assert.equal(spent.quota.used_today, 2000);
  assert.equal(spent.quota_capped, 4);
  assert.deepEqual(spent.planned, []);
  assert.equal(spent.quota.remaining_after, 0);

  // Tomorrow the count resets.
  const tomorrow = await runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, now: startOfUtcDay(NOW) + DAY, maxAgeDays: 0, dryRun: true, property: PROPERTY });
  assert.equal(tomorrow.quota.used_today, 0);
  assert.equal(tomorrow.planned.length, 4);
}

// ── runGscInspect: a 429 stops the run and keeps what was stored ────────────
{
  const f = fixture();
  inventory(f);
  const mock = makeInspectMock({ failAt: n => (n === 2 ? 429 : 0) });
  const result = await runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, now: NOW, concurrency: 1 });
  assert.equal(mock.calls.post.length, 2, 'the request that hit the wall was the last one sent');
  assert.equal(result.stopped_reason, 'quota');
  assert.equal(result.inspected, 1);
  assert.equal(result.requests, 2);
  assert.deepEqual(result.results, [{ url: 'https://acme.io/', verdict: 'PASS', coverage_state: 'Submitted and indexed', google_canonical: 'https://acme.io/' }]);
  assert.deepEqual(result.planned.length, 4, 'the plan is still reported in full, so what was not reached is knowable');
  assert.deepEqual(result.errors, [], 'the 429 is the stop reason, not a per-URL error');
  assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 1, 'the first verdict stays stored');
  assert.equal(getGscInspections(f.db, 'acme')[0].url, 'https://acme.io/');

  // With two workers, the first request meets the 429 while the second is
  // still in flight. The in-flight answer is a real verdict that already cost
  // its request, so it is stored; the flag is set by the time either worker
  // looks for its next URL, so nothing further is sent.
  const g = fixture();
  inventory(g);
  const wide = makeInspectMock({ failAt: n => (n === 1 ? 429 : 0), successDelayMs: 10 });
  const r2 = await runGscInspect(g.db, 'acme', CONFIG, { accessToken: 'tok', fetch: wide.fetch, now: NOW, concurrency: 2 });
  assert.equal(r2.stopped_reason, 'quota');
  assert.equal(wide.calls.post.length, 2, 'the two requests in flight, and no more');
  assert.deepEqual(wide.calls.post.map(c => c.body.inspectionUrl), ['https://acme.io/', 'https://acme.io/docs']);
  assert.equal(r2.inspected, 1);
  assert.deepEqual(r2.results.map(r => r.url), ['https://acme.io/docs'], 'the in-flight answer is kept');
  assert.equal(count(g.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 1);
  assert.equal(r2.quota.remaining_after, URL_INSPECTION_QUOTA.perDay - 2);
}

// ── runGscInspect: a 401 is the token, not the URL ──────────────────────────
// A rejected token fails every request alike, so the run does not spend its
// plan finding that out a hundred times: the workers stop, and the error
// propagates with the reconnect hint the CLI and MCP print.
{
  const f = fixture();
  inventory(f);
  const mock = makeInspectMock({ failAt: n => (n === 1 ? 401 : 0) });
  await assert.rejects(
    runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'stale', fetch: mock.fetch, now: NOW, concurrency: 1 }),
    err => err instanceof GscApiError && err.status === 401 && /seo-intel auth google/.test(err.hint),
  );
  assert.equal(mock.calls.post.length, 1, 'the 401 is the last request sent');
  assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 0);

  // With two workers, the sibling in flight when the 401 lands has already
  // spent its request: its verdict is stored before the run rejects, and
  // nothing further is sent.
  const g = fixture();
  inventory(g);
  const wide = makeInspectMock({ failAt: n => (n === 1 ? 401 : 0), successDelayMs: 10 });
  const progress = [];
  await assert.rejects(
    runGscInspect(g.db, 'acme', CONFIG, { accessToken: 'stale', fetch: wide.fetch, now: NOW, concurrency: 2, onProgress: e => progress.push(e) }),
    { name: 'GscApiError', status: 401 },
  );
  assert.equal(wide.calls.post.length, 2, 'the two requests in flight, and no more');
  assert.deepEqual(wide.calls.post.map(c => c.body.inspectionUrl), ['https://acme.io/', 'https://acme.io/docs']);
  assert.equal(count(g.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 1, 'the in-flight verdict is kept');
  assert.equal(getGscInspections(g.db, 'acme')[0].url, 'https://acme.io/docs');
  assert.equal(progress.length, 1, 'and was reported before the rejection, not after it');
}

// ── runGscInspect: dry run ──────────────────────────────────────────────────
{
  const f = fixture();
  inventory(f);
  f.inspected('https://acme.io/old', NOW - DAY);
  const mock = makeInspectMock();
  // A configured property and a dry run need no token at all: the OAuth module is never consulted.
  const refusing = { isConnected: () => { throw new Error('must not be consulted'); }, getAccessToken: async () => { throw new Error('nope'); } };
  const savedToken = process.env.GSC_ACCESS_TOKEN;
  delete process.env.GSC_ACCESS_TOKEN;
  try {
    const plan = await runGscInspect(f.db, 'acme', { ...CONFIG, gsc: { property: PROPERTY } }, { fetch: mock.fetch, now: NOW, dryRun: true, oauth: refusing, limit: 2 });
    assert.equal(mock.calls.get.length, 0);
    assert.equal(mock.calls.post.length, 0, 'a dry run sends nothing');
    assert.equal(plan.dry_run, true);
    assert.equal(plan.property, PROPERTY);
    assert.equal(plan.property_reason, 'configured');
    assert.deepEqual(plan.planned, ['https://acme.io/', 'https://acme.io/docs']);
    assert.equal(plan.skipped_recent, 1);
    assert.equal(plan.inspected, 0);
    assert.equal(plan.requests, 0);
    assert.deepEqual(plan.results, []);
    assert.deepEqual(plan.verdicts, { PASS: 0, PARTIAL: 0, FAIL: 0, NEUTRAL: 0, other: 0 });
    assert.equal(plan.stopped_reason, null);
    assert.deepEqual(plan.quota, { per_day: 2000, used_today: 0, remaining_after: 2000 });
    assert.equal(count(f.db, 'SELECT COUNT(*) c FROM gsc_inspections'), 1, 'nothing was written');

    // Without a configured property even a dry run must list the account's sites, and that needs a token.
    await assert.rejects(runGscInspect(f.db, 'acme', CONFIG, { fetch: mock.fetch, now: NOW, dryRun: true, oauth: { isConnected: () => false } }), /seo-intel auth google/);
    assert.equal(mock.calls.post.length, 0);
  } finally {
    if (savedToken === undefined) delete process.env.GSC_ACCESS_TOKEN;
    else process.env.GSC_ACCESS_TOKEN = savedToken;
  }
}

// ── runGscInspect: property resolution failures name the fix ────────────────
{
  const f = fixture();
  const mock = makeInspectMock();
  await assert.rejects(runGscInspect(f.db, 'acme', { target: { domain: 'nowhere.test' } }, { accessToken: 'tok', fetch: mock.fetch, now: NOW }),
    /No Search Console property matches nowhere.test.*Set gsc.property/);
  await assert.rejects(runGscInspect(f.db, 'acme', {}, { accessToken: 'tok', fetch: mock.fetch, now: NOW }),
    /set target.domain or gsc.property/);
  assert.equal(mock.calls.post.length, 0);
}


// ── runGscInspect: a transport failure stops the other workers ───────────────
// A TypeError from fetch (DNS down, connection reset) is not an API answer, so
// it propagates — but mapLimit rejects the moment it is thrown while the other
// workers keep looping. Without a stop flag, 8 planned URLs on a dead
// connection meant 8 failing requests after the caller had already been told.
{
  const f = fixture();
  for (let i = 0; i < 8; i++) f.page(`https://acme.io/p${i}`);
  const posts = [];
  const fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ siteEntry: SITES }) };
    posts.push(JSON.parse(init.body).inspectionUrl);
    if (posts.length === 1) throw new TypeError('fetch failed');
    await new Promise(r => setTimeout(r, 5));
    return { ok: true, status: 200, json: async () => ({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }) };
  };
  await assert.rejects(
    runGscInspect(f.db, 'acme', CONFIG, { accessToken: 'tok', fetch, now: NOW, concurrency: 2 }),
    err => err instanceof TypeError && err.message === 'fetch failed',
    'a transport failure propagates as itself, not as a GscApiError',
  );
  // Let any worker that was already looping run to the end of its loop.
  await new Promise(r => setTimeout(r, 50));
  assert.ok(posts.length <= 2, `only the requests already in flight were sent, not the rest of the plan (sent ${posts.length})`);
  assert.ok(getGscInspections(f.db, 'acme').length <= 1, 'at most the in-flight sibling stored a verdict');
}

console.log('gsc-inspect fixtures: PASS');
