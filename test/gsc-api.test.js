/**
 * Search Console API transport — property matching, row reshaping, paging,
 * error shaping and token precedence — and the gsc_daily/gsc_fetches helpers.
 *
 * Nothing here reaches the network or the real token store: fetch and the
 * OAuth module are injected, and the database is an in-memory DatabaseSync
 * with the same DDL db/db.js applies (copied verbatim so a schema change that
 * breaks the upsert's ON CONFLICT target breaks this test too).
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  GSC_ENDPOINTS,
  GscApiError,
  URL_INSPECTION_QUOTA,
  hintForStatus,
  inspectUrl,
  inspectionToRow,
  listSites,
  matchProperty,
  registrableDomain,
  resolveAccessToken,
  rowsToDaily,
  searchAnalytics,
  searchAnalyticsAll,
  urlBelongsToProperty,
} from '../lib/gsc-api.js';
import {
  countInspectionsSince,
  getGscCoverage,
  getGscInspections,
  recordGscFetch,
  upsertGscDaily,
  upsertGscInspection,
} from '../db/db.js';

// ── Endpoints ───────────────────────────────────────────────────────────────
assert.equal(GSC_ENDPOINTS.sites, 'https://www.googleapis.com/webmasters/v3/sites');
assert.equal(
  GSC_ENDPOINTS.searchAnalytics('sc-domain:example.com'),
  'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
  'the property is URL-encoded into the path',
);
assert.equal(
  GSC_ENDPOINTS.searchAnalytics('https://www.example.com/'),
  'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query',
);

// ── registrableDomain ───────────────────────────────────────────────────────
assert.equal(registrableDomain('example.com'), 'example.com');
assert.equal(registrableDomain('www.example.com'), 'example.com');
assert.equal(registrableDomain('docs.dev.example.com'), 'example.com');
assert.equal(registrableDomain('EXAMPLE.COM'), 'example.com');
assert.equal(registrableDomain(''), '');

// ── matchProperty ───────────────────────────────────────────────────────────
const sites = [
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'http://example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:other.net', permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'sc-domain:pending.org', permissionLevel: 'siteUnverifiedUser' },
];

// (a) configured wins outright when there is nothing to check it against …
assert.deepEqual(matchProperty(null, { domain: 'example.com', configured: 'sc-domain:example.com' }),
  { property: 'sc-domain:example.com', reason: 'configured' });
assert.deepEqual(matchProperty([], { domain: 'example.com', configured: 'https://x.test/' }),
  { property: 'https://x.test/', reason: 'configured' });
// … and when the account has it — even when a better-ranked candidate exists.
assert.deepEqual(matchProperty(sites, { domain: 'example.com', configured: 'http://example.com/' }),
  { property: 'http://example.com/', reason: 'configured' });
// A configured property the account cannot see is refused, with the list.
{
  const r = matchProperty(sites, { domain: 'example.com', configured: 'sc-domain:nope.com' });
  assert.equal(r.property, null);
  assert.equal(r.reason, 'configured property not in the account');
  assert.deepEqual(r.available, sites.map(s => s.siteUrl));
}
// A configured property that is only unverified is not usable either.
{
  const r = matchProperty(sites, { domain: 'pending.org', configured: 'sc-domain:pending.org' });
  assert.equal(r.property, null);
  assert.match(r.reason, /unverified/);
}

// (b) ranking without a configured property: exact domain property first.
assert.deepEqual(matchProperty(sites, { domain: 'example.com' }),
  { property: 'sc-domain:example.com', reason: 'domain property' });
assert.equal(matchProperty(sites, { domain: 'www.example.com' }).property, 'sc-domain:example.com',
  'a www. domain still finds the bare domain property');
// A subdomain falls back to the registrable domain's property.
{
  const r = matchProperty(sites, { domain: 'docs.example.com' });
  assert.equal(r.property, 'sc-domain:example.com');
  assert.match(r.reason, /registrable/);
}
// An exact subdomain property outranks the registrable fallback.
{
  const withSub = [...sites, { siteUrl: 'sc-domain:docs.example.com', permissionLevel: 'siteOwner' }];
  assert.equal(matchProperty(withSub, { domain: 'docs.example.com' }).property, 'sc-domain:docs.example.com');
}
// URL-prefix fallback: https before http, host may be the domain or www.<domain>.
{
  const prefixOnly = sites.filter(s => !s.siteUrl.startsWith('sc-domain:'));
  const r = matchProperty(prefixOnly, { domain: 'example.com' });
  assert.equal(r.reason, 'url-prefix property');
  assert.equal(r.property, 'https://example.com/', 'https and the exact host outranks www and http');
  assert.equal(matchProperty(prefixOnly, { domain: 'www.example.com' }).property, 'https://www.example.com/',
    'a www target picks the www prefix from the same list');
  const wwwOnly = [{ siteUrl: 'http://www.example.com/', permissionLevel: 'siteOwner' }, { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' }];
  assert.equal(matchProperty(wwwOnly, { domain: 'example.com' }).property, 'https://www.example.com/');
  const httpOnly = [{ siteUrl: 'http://example.com/', permissionLevel: 'siteOwner' }];
  assert.equal(matchProperty(httpOnly, { domain: 'example.com' }).property, 'http://example.com/');
  const rootBeatsPath = [
    { siteUrl: 'https://example.com/blog/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  ];
  assert.equal(matchProperty(rootBeatsPath, { domain: 'example.com' }).property, 'https://example.com/');

  // The exact host outranks the www/bare variant even when the variant's
  // siteUrl is shorter. A URL-prefix property holds only URLs under its
  // prefix, so for a site canonical on www the bare prefix has no rows at
  // all; picking it would store nothing and read back as measured absence.
  const bothHosts = [
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
  ];
  assert.deepEqual(matchProperty(bothHosts, { domain: 'www.example.com' }),
    { property: 'https://www.example.com/', reason: 'url-prefix property' }, 'a www target is not shortened to the bare prefix');
  assert.equal(matchProperty(bothHosts, { domain: 'example.com' }).property, 'https://example.com/', 'a bare target still takes the bare prefix');
  assert.equal(matchProperty(bothHosts, { domain: 'https://WWW.example.com/pricing' }).property, 'https://www.example.com/', 'a full URL keeps its host');
  const exactPathBeatsOtherRoot = [
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/blog/', permissionLevel: 'siteOwner' },
  ];
  assert.equal(matchProperty(exactPathBeatsOtherRoot, { domain: 'www.example.com' }).property, 'https://www.example.com/blog/',
    'a prefix on the right host holds some rows; the root of the other host holds none');
  // … but https still comes first: a migrated site leaves its http property behind.
  const httpsBeatsHost = [
    { siteUrl: 'http://www.example.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  ];
  assert.equal(matchProperty(httpsBeatsHost, { domain: 'www.example.com' }).property, 'https://example.com/');
}
// Unverified entries never match, and an unrelated domain reports what exists.
{
  const r = matchProperty(sites, { domain: 'pending.org' });
  assert.equal(r.property, null);
  assert.equal(r.reason, 'no property matches pending.org');
  assert.deepEqual(r.available, sites.map(s => s.siteUrl));
}
assert.equal(matchProperty(sites, { domain: 'https://Example.com/path' }).property, 'sc-domain:example.com',
  'a full URL is reduced to its host');
assert.equal(matchProperty(sites, {}).property, null, 'nothing to match on is not a crash');

// ── rowsToDaily ─────────────────────────────────────────────────────────────
{
  const rows = [
    { keys: ['2026-09-01', 'https://example.com/a', 'solana rpc'], clicks: 3, impressions: 40, ctr: 0.075, position: 8.4 },
    { keys: ['2026-09-02', 'https://example.com/a', 'solana rpc'], clicks: '1', impressions: '10' },
  ];
  const daily = rowsToDaily({
    rows, dimensions: ['date', 'page', 'query'],
    project: 'p', property: 'sc-domain:example.com', grain: 'page_query', searchType: 'web', fetchedAt: 1234,
  });
  assert.equal(daily.length, 2);
  assert.deepEqual(daily[0], {
    project: 'p', property: 'sc-domain:example.com', grain: 'page_query', search_type: 'web',
    date: '2026-09-01', page_url: 'https://example.com/a', query: 'solana rpc',
    clicks: 3, impressions: 40, ctr: 0.075, position: 8.4, fetched_at: 1234,
  });
  assert.equal(daily[1].clicks, 1, 'numeric strings are coerced');
  assert.equal(daily[1].ctr, null, 'a missing metric is null, not 0');
  assert.equal(daily[1].position, null);

  // Dimension order drives the mapping; a dimension not requested stays null.
  const byQuery = rowsToDaily({
    rows: [{ keys: ['solana rpc', '2026-09-01'], clicks: 1, impressions: 2 }],
    dimensions: ['query', 'date'], project: 'p', property: 'x', grain: 'query',
  });
  assert.equal(byQuery[0].query, 'solana rpc');
  assert.equal(byQuery[0].date, '2026-09-01');
  assert.equal(byQuery[0].page_url, null);
  assert.equal(byQuery[0].search_type, 'web', 'searchType defaults to web');
  assert.equal(typeof byQuery[0].fetched_at, 'number');

  // Dimensions without a column (country, device) are ignored, not misfiled.
  const withDevice = rowsToDaily({
    rows: [{ keys: ['2026-09-01', 'MOBILE', 'https://example.com/'], clicks: 1, impressions: 2 }],
    dimensions: ['date', 'device', 'page'], project: 'p', property: 'x', grain: 'page',
  });
  assert.equal(withDevice[0].page_url, 'https://example.com/');
  assert.equal(withDevice[0].query, null);
  assert.deepEqual(rowsToDaily({ rows: undefined, dimensions: ['date'] }), []);
}

// ── searchAnalytics / searchAnalyticsAll with a mock fetch ──────────────────
/**
 * A fake API over `total` rows, honouring rowLimit/startRow exactly the way
 * Google does. Records every request so paging can be asserted.
 */
function makePagedFetch(total, { status = 200, errorBody } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, authorization: init.headers.Authorization, body });
    if (status !== 200) {
      return {
        ok: false, status,
        text: async () => (typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)),
      };
    }
    const rows = [];
    for (let i = body.startRow; i < Math.min(total, body.startRow + body.rowLimit); i++) {
      rows.push({ keys: [`2026-09-0${(i % 9) + 1}`, `q${i}`], clicks: i, impressions: i * 10, ctr: 0.1, position: 1 });
    }
    // Google omits `rows` entirely when there is nothing.
    return { ok: true, status: 200, json: async () => (rows.length ? { rows, responseAggregationType: 'byProperty' } : {}) };
  };
  return { fetch, calls };
}

{
  const mock = makePagedFetch(5);
  const one = await searchAnalytics({
    siteUrl: 'sc-domain:example.com', accessToken: 'tok', fetch: mock.fetch,
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date', 'query'], rowLimit: 2,
  });
  assert.equal(one.rows.length, 2);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, GSC_ENDPOINTS.searchAnalytics('sc-domain:example.com'));
  assert.equal(mock.calls[0].authorization, 'Bearer tok');
  assert.deepEqual(mock.calls[0].body, {
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date', 'query'], type: 'web', rowLimit: 2, startRow: 0,
  }, 'dataState is not sent unless given');

  const withState = makePagedFetch(0);
  const empty = await searchAnalytics({
    siteUrl: 'x', accessToken: 'tok', fetch: withState.fetch,
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date'], dataState: 'all', searchType: 'image',
  });
  assert.deepEqual(empty.rows, [], 'an absent rows field reads as an empty page');
  assert.equal(withState.calls[0].body.dataState, 'all');
  assert.equal(withState.calls[0].body.type, 'image');
  assert.equal(withState.calls[0].body.rowLimit, 25000, 'rowLimit defaults to the API ceiling');
}

// Paging: rowLimit 2 over 5 rows → pages of 2,2,1 → 3 requests, all rows.
{
  const mock = makePagedFetch(5);
  const all = await searchAnalyticsAll({
    siteUrl: 'sc-domain:example.com', accessToken: 'tok', fetch: mock.fetch,
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date', 'query'], rowLimit: 2,
  });
  assert.equal(all.requests, 3);
  assert.equal(all.rows.length, 5);
  assert.equal(all.truncated, false);
  assert.deepEqual(mock.calls.map(c => c.body.startRow), [0, 2, 4], 'startRow advances by rowLimit');
  assert.deepEqual(all.rows.map(r => r.keys[1]), ['q0', 'q1', 'q2', 'q3', 'q4']);
}
// maxRows 3 stops the walk after the page that crosses it and says so.
{
  const mock = makePagedFetch(5);
  const capped = await searchAnalyticsAll({
    siteUrl: 'x', accessToken: 'tok', fetch: mock.fetch,
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date'], rowLimit: 2, maxRows: 3,
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows.length, 3, 'rows are capped at maxRows');
  assert.equal(capped.requests, 2);
}
// A total that exactly fills the last page needs one extra (empty) request to know it is done.
{
  const mock = makePagedFetch(4);
  const exact = await searchAnalyticsAll({
    siteUrl: 'x', accessToken: 'tok', fetch: mock.fetch,
    startDate: '2026-09-01', endDate: '2026-09-09', dimensions: ['date'], rowLimit: 2,
  });
  assert.equal(exact.rows.length, 4);
  assert.equal(exact.requests, 3);
  assert.equal(exact.truncated, false);
}

// ── GscApiError ─────────────────────────────────────────────────────────────
{
  const mock = makePagedFetch(0, {
    status: 401,
    errorBody: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } },
  });
  await assert.rejects(
    searchAnalytics({ siteUrl: 'sc-domain:example.com', accessToken: 'stale', fetch: mock.fetch, startDate: '2026-09-01', endDate: '2026-09-02', dimensions: ['date'] }),
    err => {
      assert.ok(err instanceof GscApiError);
      assert.equal(err.name, 'GscApiError');
      assert.equal(err.status, 401);
      assert.equal(err.hint, 'Token rejected. Reconnect with: seo-intel auth google');
      assert.match(err.message, /401/);
      assert.match(err.message, /sc-domain:example.com/, 'the failing property is named');
      assert.match(err.message, /invalid authentication credentials/, 'the API message is kept');
      return true;
    },
  );
  // 403 and 429 carry their own fixes; anything else falls back to the API's message.
  assert.match(hintForStatus(403), /Search Console API is not enabled|permission/);
  assert.match(hintForStatus(429), /quota/i);
  assert.equal(hintForStatus(500, 'Backend Error'), 'Backend Error');
  assert.equal(new GscApiError('boom', { status: 401 }).hint, 'Token rejected. Reconnect with: seo-intel auth google');
  assert.equal(new GscApiError('boom', { status: 418, hint: 'custom' }).hint, 'custom');
  assert.equal(new GscApiError('boom').status, null);

  // A non-JSON error body (a proxy page) still produces a usable error.
  const html = makePagedFetch(0, { status: 429, errorBody: '<html>Too Many Requests</html>' });
  await assert.rejects(
    listSites({ accessToken: 'tok', fetch: html.fetch }).catch(() => searchAnalytics({ siteUrl: 'x', accessToken: 'tok', fetch: html.fetch, startDate: '2026-09-01', endDate: '2026-09-02' })),
    err => err instanceof GscApiError && err.status === 429 && /quota/i.test(err.hint),
  );
}

// ── listSites ───────────────────────────────────────────────────────────────
{
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ siteEntry: [
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
    ] }) };
  };
  const list = await listSites({ accessToken: 'tok', fetch });
  assert.equal(calls[0].url, GSC_ENDPOINTS.sites);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(list, [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
  ]);
  const none = await listSites({ accessToken: 'tok', fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.deepEqual(none, [], 'an account with no properties is an empty list, not a crash');
}

// ── resolveAccessToken precedence ───────────────────────────────────────────
// Same injection pattern as test/modern-seo.test.js: the env override is
// cleared for the duration so the machine running the test cannot leak a
// real token into the assertions, and restored afterwards.
const savedGscToken = process.env.GSC_ACCESS_TOKEN;
delete process.env.GSC_ACCESS_TOKEN;
try {
  const notConnected = { isConnected: () => false, getAccessToken: async () => { throw new Error('unreachable'); } };
  const connected = { isConnected: () => true, getAccessToken: async () => 'from-oauth' };

  assert.equal(await resolveAccessToken({ accessToken: 'explicit', oauth: notConnected }), 'explicit',
    'an explicit token wins without consulting anything else');
  assert.equal(await resolveAccessToken({ oauth: connected }), 'from-oauth',
    'the connected account is used when nothing overrides it');
  await assert.rejects(
    resolveAccessToken({ oauth: notConnected }),
    err => err.message.includes('seo-intel auth google') && err.message.includes('GSC_ACCESS_TOKEN'),
  );

  process.env.GSC_ACCESS_TOKEN = 'from-env';
  const refusing = { isConnected: () => true, getAccessToken: async () => { throw new Error('env must win over oauth'); } };
  assert.equal(await resolveAccessToken({ oauth: refusing }), 'from-env', 'the env token beats the connected account');
  assert.equal(await resolveAccessToken({ accessToken: 'explicit', oauth: refusing }), 'explicit', 'and an explicit token beats the env');
  delete process.env.GSC_ACCESS_TOKEN;
} finally {
  if (savedGscToken === undefined) delete process.env.GSC_ACCESS_TOKEN;
  else process.env.GSC_ACCESS_TOKEN = savedGscToken;
}

// ── gsc_daily / gsc_fetches on an in-memory database ────────────────────────
// The DDL below is copied verbatim from db/db.js getDb(). Keep them identical.
const db = new DatabaseSync(':memory:');
db.exec(`
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
  CREATE TABLE IF NOT EXISTS gsc_fetches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT NOT NULL,
    property    TEXT NOT NULL,
    grain       TEXT NOT NULL,
    search_type TEXT NOT NULL DEFAULT 'web',
    start_date  TEXT NOT NULL,
    end_date    TEXT NOT NULL,
    rows        INTEGER NOT NULL,
    requests    INTEGER NOT NULL,
    truncated   INTEGER NOT NULL DEFAULT 0,
    fetched_at  INTEGER NOT NULL
  );
`);

assert.equal(getGscCoverage(db, 'p'), null, 'no rows yet reads as null, not zero');
assert.equal(upsertGscDaily(db, []), 0, 'an empty batch writes nothing');

const apiRows = [
  { keys: ['2026-09-01', 'https://example.com/a', 'solana rpc'], clicks: 3, impressions: 40, ctr: 0.075, position: 8.4 },
  { keys: ['2026-09-02', 'https://example.com/a', 'solana rpc'], clicks: 1, impressions: 10, ctr: 0.1, position: 9 },
  { keys: ['2026-09-02', 'https://example.com/b', 'solana rpc tutorial'], clicks: 0, impressions: 5, ctr: 0, position: 14 },
];
const daily = rowsToDaily({ rows: apiRows, dimensions: ['date', 'page', 'query'], project: 'p', property: 'sc-domain:example.com', grain: 'page_query', fetchedAt: 1000 });
assert.equal(upsertGscDaily(db, daily), 3);
assert.equal(db.prepare('SELECT COUNT(*) c FROM gsc_daily').get().c, 3);

// Idempotence: the same window again (Google revised a day) updates in place.
const revised = rowsToDaily({
  rows: [{ ...apiRows[1], clicks: 2, impressions: 12 }],
  dimensions: ['date', 'page', 'query'], project: 'p', property: 'sc-domain:example.com', grain: 'page_query', fetchedAt: 2000,
});
assert.equal(upsertGscDaily(db, revised), 1);
assert.equal(db.prepare('SELECT COUNT(*) c FROM gsc_daily').get().c, 3, 're-fetching does not add rows');
{
  const row = db.prepare("SELECT * FROM gsc_daily WHERE date = '2026-09-02' AND page_url = 'https://example.com/a'").get();
  assert.equal(row.clicks, 2);
  assert.equal(row.impressions, 12);
  assert.equal(row.fetched_at, 2000, 'the newest fetch wins');
}

// The NULL side of each grain must collide too: a query-grain row (page_url NULL)
// and a page-grain row (query NULL) each upsert against themselves, not append.
const queryGrain = rowsToDaily({ rows: [{ keys: ['2026-09-01', 'solana rpc'], clicks: 5, impressions: 50 }], dimensions: ['date', 'query'], project: 'p', property: 'sc-domain:example.com', grain: 'query', fetchedAt: 3000 });
const pageGrain = rowsToDaily({ rows: [{ keys: ['2026-09-01', 'https://example.com/a'], clicks: 5, impressions: 50 }], dimensions: ['date', 'page'], project: 'p', property: 'sc-domain:example.com', grain: 'page', fetchedAt: 3000 });
upsertGscDaily(db, queryGrain);
upsertGscDaily(db, queryGrain);
upsertGscDaily(db, pageGrain);
upsertGscDaily(db, pageGrain);
assert.equal(db.prepare("SELECT COUNT(*) c FROM gsc_daily WHERE grain = 'query'").get().c, 1);
assert.equal(db.prepare("SELECT COUNT(*) c FROM gsc_daily WHERE grain = 'page'").get().c, 1);
assert.equal(db.prepare("SELECT ctr FROM gsc_daily WHERE grain = 'query'").get().ctr, null, 'a metric the API omitted stays NULL');

// A bad row rolls the whole batch back and surfaces the error.
{
  const before = db.prepare('SELECT COUNT(*) c FROM gsc_daily').get().c;
  const bad = [
    { ...daily[0], date: '2026-09-03', fetched_at: 4000 },
    { ...daily[0], date: null, fetched_at: 4000 }, // violates NOT NULL
  ];
  assert.throws(() => upsertGscDaily(db, bad));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM gsc_daily').get().c, before, 'nothing from the failed batch survives');
  assert.equal(upsertGscDaily(db, [daily[0]]), 1, 'the connection is usable after the rollback');
}

// Coverage: per grain, and the newest-fetched property when none is given.
{
  const cov = getGscCoverage(db, 'p', { grain: 'page_query' });
  assert.equal(cov.property, 'sc-domain:example.com');
  assert.equal(cov.grain, 'page_query');
  assert.equal(cov.min_date, '2026-09-01');
  assert.equal(cov.max_date, '2026-09-02');
  assert.equal(cov.days, 2);
  assert.equal(cov.rows, 3);
  assert.equal(cov.last_fetched_at, 2000);

  const whole = getGscCoverage(db, 'p');
  assert.equal(whole.rows, 5, 'no grain filter counts every grain');
  assert.equal(whole.days, 2);
  assert.equal(whole.last_fetched_at, 3000);

  // A second property fetched later becomes the default; the first is still reachable by name.
  upsertGscDaily(db, rowsToDaily({
    rows: [{ keys: ['2026-08-01', 'https://www.example.com/'], clicks: 1, impressions: 1 }],
    dimensions: ['date', 'page'], project: 'p', property: 'https://www.example.com/', grain: 'page', fetchedAt: 9000,
  }));
  assert.equal(getGscCoverage(db, 'p').property, 'https://www.example.com/', 'the most recently fetched property is described');
  assert.equal(getGscCoverage(db, 'p', { property: 'sc-domain:example.com' }).rows, 5);
  assert.equal(getGscCoverage(db, 'p', { property: 'sc-domain:example.com', grain: 'query' }).rows, 1);
  assert.equal(getGscCoverage(db, 'p', { property: 'sc-domain:nope' }), null);
  assert.equal(getGscCoverage(db, 'other-project'), null);
  assert.equal(getGscCoverage(db, 'p', { grain: 'country' }), null, 'a grain with no rows is null');
}

// recordGscFetch
{
  const id = recordGscFetch(db, { project: 'p', property: 'sc-domain:example.com', grain: 'page_query', startDate: '2026-09-01', endDate: '2026-09-02', rows: 3, requests: 1, fetchedAt: 1000 });
  assert.equal(typeof id, 'number');
  const rec = db.prepare('SELECT * FROM gsc_fetches WHERE id = ?').get(id);
  assert.equal(rec.search_type, 'web');
  assert.equal(rec.truncated, 0);
  assert.equal(rec.rows, 3);
  const id2 = recordGscFetch(db, { project: 'p', property: 'x', grain: 'query', searchType: 'image', startDate: '2026-09-01', endDate: '2026-09-02', rows: 250000, requests: 10, truncated: true, fetchedAt: 1001 });
  const rec2 = db.prepare('SELECT * FROM gsc_fetches WHERE id = ?').get(id2);
  assert.equal(rec2.truncated, 1);
  assert.equal(rec2.search_type, 'image');
}

// An older database without the table answers null rather than throwing.
{
  const old = new DatabaseSync(':memory:');
  assert.equal(getGscCoverage(old, 'p'), null);
}

// ── URL Inspection: quota, property membership ──────────────────────────────
assert.deepEqual(URL_INSPECTION_QUOTA, { perDay: 2000, perMinute: 600 });
assert.equal(GSC_ENDPOINTS.urlInspection, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');

// A domain property covers the domain, its subdomains, both schemes, any path.
assert.equal(urlBelongsToProperty('https://example.com/', 'sc-domain:example.com'), true);
assert.equal(urlBelongsToProperty('https://www.example.com/docs', 'sc-domain:example.com'), true);
assert.equal(urlBelongsToProperty('http://docs.dev.example.com/a?b=1', 'sc-domain:example.com'), true, 'any depth of subdomain, either scheme');
assert.equal(urlBelongsToProperty('https://EXAMPLE.com/', 'sc-domain:Example.COM'), true, 'hosts compare case-insensitively');
assert.equal(urlBelongsToProperty('https://notexample.com/', 'sc-domain:example.com'), false, 'a suffix match needs the dot');
assert.equal(urlBelongsToProperty('https://example.com.evil.net/', 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty('https://other.org/', 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty('https://example.com/', 'sc-domain:'), false, 'an empty domain covers nothing');

// A URL-prefix property covers URLs that start with it: scheme and host loosely, path exactly.
assert.equal(urlBelongsToProperty('https://www.example.com/', 'https://www.example.com/'), true);
assert.equal(urlBelongsToProperty('https://www.example.com/docs/a', 'https://www.example.com/'), true);
assert.equal(urlBelongsToProperty('HTTPS://WWW.Example.com/docs', 'https://www.example.com/'), true, 'scheme and host are not case-sensitive');
assert.equal(urlBelongsToProperty('https://example.com/docs', 'https://www.example.com/'), false, 'the bare host is a different property');
assert.equal(urlBelongsToProperty('http://www.example.com/docs', 'https://www.example.com/'), false, 'so is the other scheme');
assert.equal(urlBelongsToProperty('https://www.example.com/blog/post', 'https://www.example.com/blog/'), true);
assert.equal(urlBelongsToProperty('https://www.example.com/blog', 'https://www.example.com/blog/'), false, 'the prefix includes its trailing slash');
assert.equal(urlBelongsToProperty('https://www.example.com/Blog/post', 'https://www.example.com/blog/'), false, 'paths compare exactly');
assert.equal(urlBelongsToProperty('https://www.example.com/x', 'https://www.example.com'), true, 'a prefix without a slash is the root');

// Nothing unparseable or non-web qualifies, and it is a false rather than a throw.
assert.equal(urlBelongsToProperty('not a url', 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty('', 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty(null, 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty('mailto:a@example.com', 'sc-domain:example.com'), false);
assert.equal(urlBelongsToProperty('ftp://example.com/x', 'sc-domain:example.com'), false, 'only http(s) pages are inspectable');
assert.equal(urlBelongsToProperty('https://example.com/', 'garbage'), false, 'an unparseable prefix covers nothing');
assert.equal(urlBelongsToProperty('https://example.com/', ''), false);
assert.equal(urlBelongsToProperty('https://example.com/', null), false);

// ── URL Inspection: inspectionToRow ─────────────────────────────────────────
const FULL_RESULT = {
  inspectionResultLink: 'https://search.google.com/search-console/inspect?resource_id=sc-domain:example.com&id=abc',
  indexStatusResult: {
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
    robotsTxtState: 'ALLOWED',
    indexingState: 'INDEXING_ALLOWED',
    lastCrawlTime: '2026-09-24T03:12:45Z',
    pageFetchState: 'SUCCESSFUL',
    googleCanonical: 'https://example.com/a',
    userCanonical: 'https://example.com/a',
    sitemap: ['https://example.com/sitemap.xml'],
    referringUrls: ['https://example.com/', 'https://example.com/b'],
    crawledAs: 'MOBILE',
  },
  mobileUsabilityResult: { verdict: 'VERDICT_UNSPECIFIED', issues: [] },
  richResultsResult: { verdict: 'PASS', detectedItems: [{ richResultType: 'FAQ', items: [] }] },
};
{
  const row = inspectionToRow({ project: 'p', property: 'sc-domain:example.com', url: 'https://example.com/a', result: FULL_RESULT, inspectedAt: 1234 });
  assert.deepEqual(row, {
    project: 'p',
    property: 'sc-domain:example.com',
    url: 'https://example.com/a',
    inspected_at: 1234,
    verdict: 'PASS',
    coverage_state: 'Submitted and indexed',
    robots_txt_state: 'ALLOWED',
    indexing_state: 'INDEXING_ALLOWED',
    page_fetch_state: 'SUCCESSFUL',
    last_crawl_time: '2026-09-24T03:12:45Z',
    crawled_as: 'MOBILE',
    google_canonical: 'https://example.com/a',
    user_canonical: 'https://example.com/a',
    sitemaps: '["https://example.com/sitemap.xml"]',
    referring_urls: '["https://example.com/","https://example.com/b"]',
    rich_results_verdict: 'PASS',
    raw: JSON.stringify(FULL_RESULT),
  });
  assert.deepEqual(JSON.parse(row.raw).mobileUsabilityResult, { verdict: 'VERDICT_UNSPECIFIED', issues: [] },
    'the deprecated block is kept in raw, and nowhere else');
}
// Absent fields are null, absent lists are '[]', and a missing indexStatusResult is not a crash.
{
  const sparse = inspectionToRow({ project: 'p', property: 'x', url: 'https://example.com/u', result: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag" } }, inspectedAt: 1 });
  assert.equal(sparse.verdict, 'NEUTRAL');
  assert.equal(sparse.coverage_state, "Excluded by 'noindex' tag");
  for (const col of ['robots_txt_state', 'indexing_state', 'page_fetch_state', 'last_crawl_time', 'crawled_as', 'google_canonical', 'user_canonical', 'rich_results_verdict']) {
    assert.equal(sparse[col], null, `${col} is null when absent`);
  }
  assert.equal(sparse.sitemaps, '[]');
  assert.equal(sparse.referring_urls, '[]');

  const empty = inspectionToRow({ project: 'p', property: 'x', url: 'https://example.com/u', result: {}, inspectedAt: 1 });
  assert.equal(empty.verdict, null);
  assert.equal(empty.sitemaps, '[]');
  assert.equal(empty.raw, '{}');
  const nothing = inspectionToRow({ project: 'p', property: 'x', url: 'https://example.com/u', result: undefined, inspectedAt: 1 });
  assert.equal(nothing.verdict, null);
  assert.equal(nothing.raw, '{}');
  assert.equal(typeof inspectionToRow({ project: 'p', property: 'x', url: 'u', result: {} }).inspected_at, 'number', 'inspectedAt defaults to now');
}

// ── URL Inspection: inspectUrl ──────────────────────────────────────────────
{
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ inspectionResult: FULL_RESULT }) };
  };
  const result = await inspectUrl({ siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://example.com/a', accessToken: 'tok', fetch });
  assert.deepEqual(result, FULL_RESULT, 'the inspectionResult is returned as is');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GSC_ENDPOINTS.urlInspection);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(calls[0].body, { inspectionUrl: 'https://example.com/a', siteUrl: 'sc-domain:example.com', languageCode: 'en-US' });

  await inspectUrl({ siteUrl: 'https://www.example.com/', inspectionUrl: 'https://www.example.com/b', accessToken: 'tok', fetch, languageCode: 'fi-FI' });
  assert.equal(calls[1].body.languageCode, 'fi-FI');
  assert.equal(calls[1].body.siteUrl, 'https://www.example.com/', 'a URL-prefix property is sent verbatim, trailing slash included');

  // No inspectionResult in the answer → {} rather than undefined, so callers can read fields off it.
  const bare = await inspectUrl({ siteUrl: 'x', inspectionUrl: 'https://example.com/', accessToken: 'tok', fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.deepEqual(bare, {});

  await assert.rejects(inspectUrl({ inspectionUrl: 'https://example.com/', accessToken: 'tok', fetch }), /siteUrl is required/);
  await assert.rejects(inspectUrl({ siteUrl: 'x', accessToken: 'tok', fetch }), /inspectionUrl is required/);

  // A 429 is a GscApiError whose hint speaks of the inspection quota, not of date ranges.
  const quota = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { code: 429, message: 'Quota exceeded for quota metric', status: 'RESOURCE_EXHAUSTED' } }) });
  await assert.rejects(
    inspectUrl({ siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://example.com/a', accessToken: 'tok', fetch: quota }),
    err => {
      assert.ok(err instanceof GscApiError);
      assert.equal(err.status, 429);
      assert.match(err.message, /429/);
      assert.match(err.message, /https:\/\/example.com\/a/, 'the URL that failed is named');
      assert.match(err.message, /Quota exceeded/, 'the API message is kept');
      assert.match(err.hint, /2000 inspections per property per day/);
      assert.doesNotMatch(err.hint, /date range/, 'the Search Analytics fix is not offered for an inspection');
      return true;
    },
  );
  // A 400 (URL outside the property) keeps the API's own explanation as the hint.
  const outside = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 400, message: 'URL is not in property', status: 'INVALID_ARGUMENT' } }) });
  await assert.rejects(
    inspectUrl({ siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://other.org/', accessToken: 'tok', fetch: outside }),
    err => err instanceof GscApiError && err.status === 400 && err.hint === 'URL is not in property',
  );
  // 401 still says reconnect.
  const stale = async () => ({ ok: false, status: 401, text: async () => '{}' });
  await assert.rejects(
    inspectUrl({ siteUrl: 'x', inspectionUrl: 'https://example.com/', accessToken: 'tok', fetch: stale }),
    err => err.status === 401 && /seo-intel auth google/.test(err.hint),
  );
}

// ── gsc_inspections on an in-memory database ────────────────────────────────
// The DDL below is copied verbatim from db/db.js getDb(). Keep them identical.
{
  const idb = new DatabaseSync(':memory:');
  idb.exec(`
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
  `);
  assert.deepEqual(getGscInspections(idb, 'p'), []);
  assert.equal(countInspectionsSince(idb, 'p', 'sc-domain:example.com', 0), 0);

  const first = inspectionToRow({ project: 'p', property: 'sc-domain:example.com', url: 'https://example.com/a', result: FULL_RESULT, inspectedAt: 1000 });
  assert.equal(upsertGscInspection(idb, first), 1);
  upsertGscInspection(idb, inspectionToRow({ project: 'p', property: 'sc-domain:example.com', url: 'https://example.com/b', result: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag" } }, inspectedAt: 2000 }));
  upsertGscInspection(idb, inspectionToRow({ project: 'other', property: 'sc-domain:other.net', url: 'https://other.net/', result: {}, inspectedAt: 3000 }));

  const rows = getGscInspections(idb, 'p');
  assert.equal(rows.length, 2, 'scoped to the project');
  assert.deepEqual(rows.map(r => r.url), ['https://example.com/b', 'https://example.com/a'], 'newest first');
  assert.deepEqual(rows[1].sitemaps, ['https://example.com/sitemap.xml'], 'JSON lists come back as arrays');
  assert.deepEqual(rows[1].referring_urls, ['https://example.com/', 'https://example.com/b']);
  assert.deepEqual(rows[0].sitemaps, [], 'and an empty list is an empty array');
  assert.equal(rows[0].robots_txt_state, null);
  assert.equal(JSON.parse(rows[1].raw).indexStatusResult.verdict, 'PASS');

  // A fresh inspection of the same URL replaces every column: the old verdict is gone.
  const again = inspectionToRow({
    project: 'p', property: 'https://example.com/', url: 'https://example.com/a', inspectedAt: 5000,
    result: { indexStatusResult: { verdict: 'FAIL', coverageState: 'Not found (404)', pageFetchState: 'NOT_FOUND' } },
  });
  assert.equal(upsertGscInspection(idb, again), 1);
  assert.equal(idb.prepare('SELECT COUNT(*) c FROM gsc_inspections').get().c, 3, 're-inspecting adds no row');
  const replaced = getGscInspections(idb, 'p').find(r => r.url === 'https://example.com/a');
  assert.equal(replaced.verdict, 'FAIL');
  assert.equal(replaced.coverage_state, 'Not found (404)');
  assert.equal(replaced.property, 'https://example.com/', 'the property moves with the row');
  assert.equal(replaced.inspected_at, 5000);
  assert.equal(replaced.google_canonical, null, 'a column the new answer lacks is cleared, not kept from the old one');
  assert.deepEqual(replaced.sitemaps, []);
  assert.equal(replaced.rich_results_verdict, null);

  // countInspectionsSince: per project and property, at or after the stamp.
  assert.equal(countInspectionsSince(idb, 'p', 'sc-domain:example.com', 0), 1, 'a re-inspected row under another property no longer counts for the old one');
  assert.equal(countInspectionsSince(idb, 'p', 'https://example.com/', 5000), 1, 'the boundary is inclusive');
  assert.equal(countInspectionsSince(idb, 'p', 'https://example.com/', 5001), 0);
  assert.equal(countInspectionsSince(idb, 'other', 'sc-domain:other.net', 0), 1);
  assert.equal(countInspectionsSince(idb, 'p', 'sc-domain:nope', 0), 0);

  // A malformed JSON list column reads as [] rather than taking the caller down.
  idb.prepare("UPDATE gsc_inspections SET sitemaps = 'not json' WHERE url = 'https://example.com/b'").run();
  assert.deepEqual(getGscInspections(idb, 'p').find(r => r.url === 'https://example.com/b').sitemaps, []);

  // An older database without the table answers "no data" rather than throwing.
  const old = new DatabaseSync(':memory:');
  assert.deepEqual(getGscInspections(old, 'p'), []);
  assert.equal(countInspectionsSince(old, 'p', 'x', 0), 0);
  assert.throws(() => upsertGscInspection(old, first), 'a write against a missing table is an error, not silence');
}

console.log('gsc-api fixtures: PASS');
