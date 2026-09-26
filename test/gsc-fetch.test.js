/**
 * gsc-fetch — window planning, property matching, paging, persistence and
 * incremental re-runs, against a fake Search Console.
 *
 * Nothing here reaches the network or the real token store: fetch and the
 * OAuth module are injected, and the database is an in-memory DatabaseSync
 * with the same DDL db/db.js applies (copied verbatim so a schema change that
 * breaks the upsert's ON CONFLICT target breaks this test too). All dates are
 * anchored at a fixed `today` built with Date.UTC, so the expectations hold in
 * every time zone.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GscApiError, GSC_ENDPOINTS } from '../lib/gsc-api.js';
import {
  DEFAULTS,
  GRAINS,
  isoDate,
  monthChunks,
  planWindows,
  runGscFetch,
  utcDay,
} from '../analyses/gsc-fetch/index.js';

// The DDL below is copied verbatim from db/db.js getDb(). Keep them identical.
const DDL = `
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
`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  return db;
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;

// Saturday 2026-09-26; with lagDays 3 the last requested day is 2026-09-23.
const TODAY = new Date(Date.UTC(2026, 8, 26));

// ── constants ───────────────────────────────────────────────────────────────
assert.deepEqual(GRAINS, { page_query: ['date', 'page', 'query'], page: ['date', 'page'], query: ['date', 'query'] });
assert.deepEqual(DEFAULTS, { days: 90, months: 16, lagDays: 3, revisionDays: 3, maxMonths: 16 });
for (const dims of Object.values(GRAINS)) assert.equal(dims[0], 'date', 'every grain requests date: gsc_daily.date is NOT NULL');

// ── UTC helpers ─────────────────────────────────────────────────────────────
assert.equal(utcDay('2026-09-26'), Date.UTC(2026, 8, 26));
assert.equal(utcDay(TODAY), Date.UTC(2026, 8, 26));
assert.equal(utcDay(new Date('2026-09-26T23:59:59Z')), Date.UTC(2026, 8, 26), 'the time of day is dropped in UTC');
assert.throws(() => utcDay('yesterday'));
assert.equal(isoDate(Date.UTC(2026, 1, 28)), '2026-02-28');
assert.deepEqual(monthChunks(utcDay('2026-06-26'), utcDay('2026-08-02')), [
  { start: '2026-06-26', end: '2026-06-30' },
  { start: '2026-07-01', end: '2026-07-31' },
  { start: '2026-08-01', end: '2026-08-02' },
]);
assert.deepEqual(monthChunks(utcDay('2026-09-23'), utcDay('2026-09-23')), [{ start: '2026-09-23', end: '2026-09-23' }], 'a one-day span is one chunk');
assert.deepEqual(monthChunks(utcDay('2026-09-24'), utcDay('2026-09-23')), [], 'an inverted span is empty');
assert.deepEqual(monthChunks(utcDay('2025-12-31'), utcDay('2026-01-01')), [
  { start: '2025-12-31', end: '2025-12-31' }, { start: '2026-01-01', end: '2026-01-01' },
], 'a year boundary is a month boundary');

// ── planWindows: fresh ──────────────────────────────────────────────────────
// page_query: 90 days inclusive ending at today - lagDays, split at month ends.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query' }), [
  { start: '2026-06-26', end: '2026-06-30' },
  { start: '2026-07-01', end: '2026-07-31' },
  { start: '2026-08-01', end: '2026-08-31' },
  { start: '2026-09-01', end: '2026-09-23' },
]);
{
  const fresh = planWindows({ today: TODAY, grain: 'page_query' });
  const span = (utcDay(fresh.at(-1).end) - utcDay(fresh[0].start)) / 86_400_000 + 1;
  assert.equal(span, DEFAULTS.days, 'the fresh page_query plan covers exactly `days` days');
}
// page and query: 16 × 30 days back, which from 2026-09-23 lands on 2025-06-01.
for (const grain of ['page', 'query']) {
  const w = planWindows({ today: TODAY, grain });
  assert.equal(w.length, 16, `${grain}: sixteen calendar-month chunks`);
  assert.deepEqual(w[0], { start: '2025-06-01', end: '2025-06-30' });
  assert.deepEqual(w[1], { start: '2025-07-01', end: '2025-07-31' });
  assert.deepEqual(w.at(-1), { start: '2026-09-01', end: '2026-09-23' });
  for (let i = 1; i < w.length; i++) {
    assert.equal(utcDay(w[i].start), utcDay(w[i - 1].end) + 86_400_000, 'chunks are contiguous');
  }
}
// The API's horizon caps every grain: asking for 40 months yields the same plan as 16.
assert.deepEqual(planWindows({ today: TODAY, grain: 'query', months: 40 }), planWindows({ today: TODAY, grain: 'query' }));
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', days: 10_000 })[0], { start: '2025-06-01', end: '2025-06-30' });
// Custom spans and lag.
assert.deepEqual(planWindows({ today: TODAY, grain: 'query', months: 2 }), [
  { start: '2026-07-26', end: '2026-07-31' },
  { start: '2026-08-01', end: '2026-08-31' },
  { start: '2026-09-01', end: '2026-09-23' },
]);
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', days: 7, lagDays: 0 }), [{ start: '2026-09-20', end: '2026-09-26' }]);
assert.deepEqual(planWindows({ today: '2026-09-26', grain: 'page_query', days: 1 }), [{ start: '2026-09-23', end: '2026-09-23' }], 'today may be an ISO string');
// Nonsense sizes fall back to the defaults instead of producing an empty or inverted plan.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', days: 0 }), planWindows({ today: TODAY, grain: 'page_query' }));
assert.deepEqual(planWindows({ today: TODAY, grain: 'page', months: 'lots' }), planWindows({ today: TODAY, grain: 'page' }));

// ── planWindows: incremental ────────────────────────────────────────────────
// Coverage up to 2026-09-20: extend from there, re-fetching the last revisionDays.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-09-20' } }),
  [{ start: '2026-09-17', end: '2026-09-23' }]);
assert.deepEqual(planWindows({ today: TODAY, grain: 'page', coverage: { max_date: '2026-09-20' } }),
  [{ start: '2026-09-17', end: '2026-09-23' }], 'the same rule applies to the long grains');
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-09-20' }, revisionDays: 0 }),
  [{ start: '2026-09-20', end: '2026-09-23' }], 'revisionDays 0 still re-fetches the last stored day');
// Coverage that straddles a month end still splits at it.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-09-02' } }),
  [{ start: '2026-08-30', end: '2026-08-31' }, { start: '2026-09-01', end: '2026-09-23' }]);
// Old coverage never pulls the start back past what a fresh run would ask for.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-01-15' } }),
  planWindows({ today: TODAY, grain: 'page_query' }));
// Coverage complete up to `end`: the revision window alone is asked for again.
// Google revises the last few published days, so a same-day rerun is not free,
// but it is four days and one request per grain, and the upsert replaces in place.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-09-23' } }),
  [{ start: '2026-09-20', end: '2026-09-23' }]);

// ── planWindows: nothing to do ──────────────────────────────────────────────
// Coverage already past the lag boundary by more than revisionDays — rows
// fetched elsewhere with a shorter lag — leaves start > end, and that is an
// empty plan rather than an inverted window.
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: { max_date: '2026-09-27' } }), []);
assert.deepEqual(planWindows({ today: TODAY, grain: 'query', coverage: { max_date: '2026-09-24' }, revisionDays: 0 }), []);
assert.deepEqual(planWindows({ today: TODAY, grain: 'query', coverage: { max_date: '2026-09-23' }, revisionDays: 0 }),
  [{ start: '2026-09-23', end: '2026-09-23' }], 'exactly at end with no revision: the last day only');
assert.deepEqual(planWindows({ today: TODAY, grain: 'page_query', coverage: null }), planWindows({ today: TODAY, grain: 'page_query' }), 'null coverage is a fresh plan');

// ── a fake Search Console ───────────────────────────────────────────────────
/**
 * Serves the sites list to GETs and Search Analytics rows to POSTs, honouring
 * startDate/endDate/dimensions/rowLimit/startRow the way Google does. Rows
 * exist only for `dataDates`; two pages × two queries per day. `state.impressions`
 * is mutable so a second run can observe a "revision". `failWhen(body)` returns
 * an HTTP status to fail one specific window with.
 */
const SITES = [
  { siteUrl: 'https://www.acme.io/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'sc-domain:acme.io', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:other.example', permissionLevel: 'siteRestrictedUser' },
];
const PAGES = ['https://acme.io/', 'https://acme.io/docs/'];
const QUERIES = ['acme', 'acme docs'];
const SEP_DATES = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];

function makeGscMock({ sites = SITES, dataDates = SEP_DATES, status = 200, errorBody, failWhen } = {}) {
  const calls = { get: [], post: [] };
  const state = { impressions: 10 };
  const rowsFor = (body) => {
    const dims = body.dimensions;
    const combos = dims.includes('page') && dims.includes('query')
      ? PAGES.flatMap(p => QUERIES.map(q => ({ page: p, query: q })))
      : dims.includes('page') ? PAGES.map(p => ({ page: p }))
        : QUERIES.map(q => ({ query: q }));
    const out = [];
    for (const date of dataDates) {
      if (date < body.startDate || date > body.endDate) continue;
      for (const c of combos) {
        out.push({
          keys: dims.map(d => (d === 'date' ? date : c[d])),
          clicks: 1, impressions: state.impressions, ctr: 1 / state.impressions, position: 4.5,
        });
      }
    }
    return out;
  };
  const fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      calls.get.push({ url, authorization: init.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ({ siteEntry: sites }) };
    }
    const body = JSON.parse(init.body);
    calls.post.push({ url, authorization: init.headers?.Authorization, body });
    const failStatus = status !== 200 ? status : (failWhen ? failWhen(body) : 0);
    if (failStatus) {
      const err = errorBody || { error: { code: failStatus, message: `mock ${failStatus}`, status: 'ERROR' } };
      return { ok: false, status: failStatus, text: async () => JSON.stringify(err) };
    }
    const all = rowsFor(body);
    const rows = all.slice(body.startRow, body.startRow + body.rowLimit);
    // Google omits `rows` entirely when there is nothing.
    return { ok: true, status: 200, json: async () => (rows.length ? { rows, responseAggregationType: 'byPage' } : {}) };
  };
  return { fetch, calls, state };
}

const CONFIG = { project: 'acme', target: { domain: 'www.acme.io' } };
const settle = () => new Promise(r => setTimeout(r, 5)); // so fetched_at can advance

// ── runGscFetch: a fresh project, then a same-day rerun ─────────────────────
{
  const db = freshDb();
  const mock = makeGscMock();
  const progress = [];
  const result = await runGscFetch(db, 'acme', CONFIG, {
    accessToken: 'tok', fetch: mock.fetch, today: TODAY, rowLimit: 2, onProgress: e => progress.push(e),
  });

  // Property: auto-matched from target.domain via the sites list.
  assert.equal(mock.calls.get.length, 1);
  assert.equal(mock.calls.get[0].url, GSC_ENDPOINTS.sites);
  assert.equal(mock.calls.get[0].authorization, 'Bearer tok');
  assert.equal(result.property, 'sc-domain:acme.io', 'www.acme.io resolves to the bare domain property');
  assert.equal(result.property_reason, 'domain property');
  assert.equal(result.project, 'acme');
  assert.equal(result.dry_run, false);
  assert.equal(typeof result.fetched_at, 'number');

  // Every request went to that property, typed web, with the grain's dimensions in order.
  assert.ok(mock.calls.post.every(c => c.url === GSC_ENDPOINTS.searchAnalytics('sc-domain:acme.io')));
  assert.ok(mock.calls.post.every(c => c.body.type === 'web' && c.body.rowLimit === 2 && c.authorization === 'Bearer tok'));
  assert.ok(mock.calls.post.every(c => c.body.dataState === undefined), 'dataState is left to the API default');

  // Requests. Data exists on four September days only, two pages × two queries:
  //   page_query  4 windows: Jun/Jul/Aug empty (1 request each) + Sep 16 rows at 2/page (8 full + 1 empty) = 12
  //   page        16 windows: 15 empty + Sep 8 rows (4 full + 1 empty)                                   = 20
  //   query       same shape as page                                                                       = 20
  assert.deepEqual(result.grains.map(g => g.grain), ['page_query', 'page', 'query']);
  const [pq, pg, qy] = result.grains;
  assert.equal(pq.windows.length, 4);
  assert.deepEqual(pq.windows.map(w => [w.start, w.end]), [
    ['2026-06-26', '2026-06-30'], ['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-23'],
  ]);
  assert.deepEqual(pq.windows[3], { start: '2026-09-01', end: '2026-09-23', rows: 16, requests: 9, truncated: false });
  assert.deepEqual(pq.windows[0], { start: '2026-06-26', end: '2026-06-30', rows: 0, requests: 1, truncated: false });
  assert.equal(pq.rows, 16);
  assert.equal(pq.requests, 12);
  assert.equal(pg.windows.length, 16);
  assert.equal(pg.rows, 8);
  assert.equal(pg.requests, 20);
  assert.equal(qy.rows, 8);
  assert.equal(qy.requests, 20);
  assert.equal(mock.calls.post.length, 52, 'the mock saw exactly the requests the result reports');
  assert.deepEqual(mock.calls.post.filter(c => c.body.startDate === '2026-09-01' && c.body.dimensions.length === 3).map(c => c.body.startRow),
    [0, 2, 4, 6, 8, 10, 12, 14, 16], 'startRow advances by rowLimit until the short page');
  assert.deepEqual(mock.calls.post.map(c => c.body.dimensions.join(',')).slice(0, 4), Array(4).fill('date,page,query'));
  // Windows are walked oldest first so a crash leaves a contiguous prefix.
  const pageStarts = mock.calls.post.filter(c => c.body.dimensions.join() === 'date,page').map(c => c.body.startDate);
  assert.deepEqual([...pageStarts].sort(), pageStarts);

  // Persistence: one gsc_daily row per API row, one gsc_fetches record per window.
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 32);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_daily WHERE grain = 'page_query'"), 16);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_daily WHERE grain = 'page' AND query IS NULL AND page_url IS NOT NULL"), 8);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_daily WHERE grain = 'query' AND page_url IS NULL AND query IS NOT NULL"), 8);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_daily WHERE property = 'sc-domain:acme.io' AND search_type = 'web' AND project = 'acme'"), 32);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_fetches'), 36);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_fetches WHERE grain = 'page_query'"), 4);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_fetches WHERE truncated = 1'), 0);
  {
    const rec = db.prepare("SELECT * FROM gsc_fetches WHERE grain = 'page_query' AND start_date = '2026-09-01'").get();
    assert.equal(rec.end_date, '2026-09-23');
    assert.equal(rec.rows, 16);
    assert.equal(rec.requests, 9);
    assert.equal(rec.fetched_at, result.fetched_at);
    const row = db.prepare("SELECT * FROM gsc_daily WHERE grain = 'page_query' AND date = '2026-09-20' AND page_url = 'https://acme.io/docs/' AND query = 'acme docs'").get();
    assert.equal(row.clicks, 1);
    assert.equal(row.impressions, 10);
    assert.equal(row.ctr, 0.1, 'ctr is stored as the API fraction');
    assert.equal(row.position, 4.5);
    assert.equal(row.fetched_at, result.fetched_at);
  }

  // Coverage after the run, for every grain against the fetched property.
  assert.deepEqual(Object.keys(result.coverage), ['page_query', 'page', 'query']);
  assert.equal(result.coverage.page_query.property, 'sc-domain:acme.io');
  assert.equal(result.coverage.page_query.min_date, '2026-09-20');
  assert.equal(result.coverage.page_query.max_date, '2026-09-23');
  assert.equal(result.coverage.page_query.days, 4);
  assert.equal(result.coverage.page_query.rows, 16);
  assert.equal(result.coverage.page.rows, 8);
  assert.equal(result.coverage.query.max_date, '2026-09-23');

  // Progress: one event per fetched window, in order, with the window's numbers.
  assert.equal(progress.length, 36);
  assert.deepEqual(progress[3], { grain: 'page_query', window: { start: '2026-09-01', end: '2026-09-23' }, rows: 16, requests: 9, truncated: false });
  assert.equal(progress[4].grain, 'page');

  // ── Same today, second run: coverage is complete, so only the revision
  // window is asked for again (one window per grain), and the rows it returns
  // replace what is stored instead of adding to it.
  await settle();
  mock.state.impressions = 12; // Google revised the last days
  const before = mock.calls.post.length;
  const second = await runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY, rowLimit: 2 });
  const rerun = mock.calls.post.slice(before);
  assert.equal(rerun.length, 9 + 5 + 5, 'revision window only: 16, 8 and 8 rows at 2 per page');
  assert.ok(rerun.every(c => c.body.startDate === '2026-09-20' && c.body.endDate === '2026-09-23'));
  assert.deepEqual(second.grains.map(g => g.windows.length), [1, 1, 1]);
  assert.deepEqual(second.grains[0].windows[0], { start: '2026-09-20', end: '2026-09-23', rows: 16, requests: 9, truncated: false });
  assert.equal(second.grains[1].requests, 5);
  assert.equal(mock.calls.get.length, 2, 'the property is matched again; that is one GET, not a Search Analytics request');

  // Upsert idempotence: same identities, so the count holds; the values and fetched_at move.
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 32, 're-fetching adds no rows');
  assert.ok(second.fetched_at > result.fetched_at);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily WHERE fetched_at = ?', second.fetched_at), 32, 'every stored day was inside the revision window, so every row was refreshed');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily WHERE impressions = 12'), 32, 'the revised values won');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_fetches'), 39, 'each rerun window is logged');
  assert.equal(second.coverage.page_query.last_fetched_at, second.fetched_at);
  assert.equal(second.coverage.page_query.rows, 16);

  // A run three days later extends coverage and re-fetches the revision days once more.
  const later = planWindows({ today: new Date(Date.UTC(2026, 8, 29)), grain: 'page_query', coverage: second.coverage.page_query });
  assert.deepEqual(later, [{ start: '2026-09-20', end: '2026-09-26' }]);
}

// ── runGscFetch: a subset of grains, and a configured property ──────────────
{
  const db = freshDb();
  const mock = makeGscMock();
  const result = await runGscFetch(db, 'acme', { ...CONFIG, gsc: { property: 'https://www.acme.io/' } }, {
    accessToken: 'tok', fetch: mock.fetch, today: TODAY, rowLimit: 25_000, grains: ['page'],
  });
  assert.equal(result.property, 'https://www.acme.io/');
  assert.equal(result.property_reason, 'configured');
  assert.equal(mock.calls.get.length, 0, 'a configured property is not looked up');
  assert.deepEqual(result.grains.map(g => g.grain), ['page']);
  assert.equal(result.grains[0].requests, 16, 'one request per month at the API ceiling: 15 empty months and one exact fit');
  assert.equal(result.grains[0].rows, 8);
  assert.ok(mock.calls.post.every(c => c.url === GSC_ENDPOINTS.searchAnalytics('https://www.acme.io/') && c.body.rowLimit === 25_000));
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_daily WHERE property = 'https://www.acme.io/'"), 8);
  assert.equal(result.coverage.page.rows, 8);
  assert.equal(result.coverage.page_query, null, 'grains that were not fetched read as no coverage');
  assert.equal(result.coverage.query, null);

  // opts.property outranks config.gsc.property.
  const override = await runGscFetch(db, 'acme', { ...CONFIG, gsc: { property: 'https://www.acme.io/' } }, {
    accessToken: 'tok', fetch: mock.fetch, today: TODAY, grains: ['query'], property: 'sc-domain:acme.io', rowLimit: 2,
  });
  assert.equal(override.property, 'sc-domain:acme.io');
  assert.equal(override.coverage.query.property, 'sc-domain:acme.io');
  assert.equal(override.coverage.page, null, 'coverage is reported for the fetched property, not the other one');

  await assert.rejects(runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY, grains: ['country'] }), /Unknown Search Console grain "country"/);
}

// ── runGscFetch: dry run ────────────────────────────────────────────────────
// Same env hygiene as test/gsc-api.test.js: the machine's own token must not
// leak into the "no credentials" assertions, and is restored afterwards.
const savedGscToken = process.env.GSC_ACCESS_TOKEN;
delete process.env.GSC_ACCESS_TOKEN;
try {
  // (a) property known: no token is resolved and nothing is fetched.
  const db = freshDb();
  const mock = makeGscMock();
  const refusing = { isConnected: () => { throw new Error('the token store must not be consulted'); }, getAccessToken: async () => 'nope' };
  const plan = await runGscFetch(db, 'acme', { ...CONFIG, gsc: { property: 'sc-domain:acme.io' } }, {
    fetch: mock.fetch, oauth: refusing, today: TODAY, dryRun: true,
  });
  assert.equal(mock.calls.get.length, 0);
  assert.equal(mock.calls.post.length, 0, 'a dry run makes no Search Analytics request');
  assert.equal(plan.dry_run, true);
  assert.equal(plan.property, 'sc-domain:acme.io');
  assert.equal(plan.property_reason, 'configured');
  assert.deepEqual(plan.grains.map(g => g.grain), ['page_query', 'page', 'query']);
  assert.deepEqual(plan.grains[0].windows, planWindows({ today: TODAY, grain: 'page_query' }), 'planned windows carry start/end only');
  assert.equal(plan.grains[1].windows.length, 16);
  assert.deepEqual(plan.grains.map(g => [g.rows, g.requests]), [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(plan.coverage, { page_query: null, page: null, query: null });
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_fetches'), 0);

  // (b) property unknown: the token is needed to list sites, and that is all it is used for.
  const matched = await runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY, dryRun: true, grains: ['page_query'] });
  assert.equal(mock.calls.get.length, 1);
  assert.equal(mock.calls.post.length, 0);
  assert.equal(matched.property, 'sc-domain:acme.io');
  assert.equal(matched.property_reason, 'domain property');
  // … and without any credentials it says how to get some.
  await assert.rejects(
    runGscFetch(db, 'acme', CONFIG, { fetch: mock.fetch, oauth: { isConnected: () => false, getAccessToken: async () => 'x' }, today: TODAY, dryRun: true }),
    err => err.message.includes('seo-intel auth google'),
  );

  // (c) a dry run on a project with coverage plans the increment, not the full range.
  const covered = freshDb();
  await runGscFetch(covered, 'acme', CONFIG, { accessToken: 'tok', fetch: makeGscMock().fetch, today: TODAY, rowLimit: 2, grains: ['page_query'] });
  const incremental = await runGscFetch(covered, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY, dryRun: true, grains: ['page_query'] });
  assert.deepEqual(incremental.grains[0].windows, [{ start: '2026-09-20', end: '2026-09-23' }]);
  assert.equal(incremental.coverage.page_query.max_date, '2026-09-23');
} finally {
  if (savedGscToken === undefined) delete process.env.GSC_ACCESS_TOKEN;
  else process.env.GSC_ACCESS_TOKEN = savedGscToken;
}

// ── runGscFetch: property resolution failures ───────────────────────────────
{
  const db = freshDb();
  const mock = makeGscMock({ sites: SITES.filter(s => !s.siteUrl.includes('acme')) });
  await assert.rejects(
    runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY }),
    err => {
      assert.match(err.message, /No Search Console property matches www\.acme\.io/);
      assert.match(err.message, /sc-domain:other\.example/, 'the account\'s properties are listed');
      assert.match(err.message, /gsc\.property/, 'and the fix is named');
      return true;
    },
  );
  assert.equal(mock.calls.post.length, 0);
  await assert.rejects(
    runGscFetch(db, 'acme', { project: 'acme' }, { accessToken: 'tok', fetch: mock.fetch, today: TODAY }),
    /target\.domain or gsc\.property/,
  );
  // An unverified property does not count, even when it is the only match.
  const unverified = makeGscMock({ sites: [{ siteUrl: 'sc-domain:acme.io', permissionLevel: 'siteUnverifiedUser' }] });
  await assert.rejects(runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: unverified.fetch, today: TODAY }), /No Search Console property matches/);

  // A www target with only URL-prefix properties fetches from the www prefix.
  // The bare prefix holds no rows for a site canonical on www; fetching it
  // would store nothing, and the page contract would read that as measured
  // absence for every page — the false negative this feature exists to remove.
  const prefixOnly = makeGscMock({ sites: [
    { siteUrl: 'https://acme.io/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.acme.io/', permissionLevel: 'siteOwner' },
  ] });
  const viaPrefix = await runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: prefixOnly.fetch, today: TODAY, dryRun: true, grains: ['query'] });
  assert.equal(viaPrefix.property, 'https://www.acme.io/', 'www.acme.io is not shortened to the bare prefix');
  assert.equal(viaPrefix.property_reason, 'url-prefix property');
  assert.equal(prefixOnly.calls.get.length, 1, 'the site list was consulted');
  assert.equal(prefixOnly.calls.post.length, 0, 'a dry run makes no Search Analytics request');
}

// ── runGscFetch: API errors surface as GscApiError with the hint ────────────
{
  const db = freshDb();
  const mock = makeGscMock({
    status: 401,
    errorBody: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } },
  });
  await assert.rejects(
    runGscFetch(db, 'acme', CONFIG, { accessToken: 'stale', fetch: mock.fetch, today: TODAY, rowLimit: 2 }),
    err => {
      assert.ok(err instanceof GscApiError);
      assert.equal(err.status, 401);
      assert.equal(err.hint, 'Token rejected. Reconnect with: seo-intel auth google');
      assert.match(err.message, /sc-domain:acme.io/, 'the failing property is named');
      assert.match(err.message, /invalid authentication credentials/);
      return true;
    },
  );
  assert.equal(mock.calls.post.length, 1, 'the walk stops at the first failure');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_fetches'), 0, 'a failed window is not logged as fetched');
  // The connection is not left inside a transaction.
  db.exec('BEGIN'); db.exec('ROLLBACK');
}

// ── runGscFetch: a mid-run 429 leaves whole months committed; the next run resumes ──
{
  const db = freshDb();
  const dataDates = ['2026-07-15', ...SEP_DATES];
  const failing = makeGscMock({ dataDates, failWhen: body => (body.startDate === '2026-08-01' ? 429 : 0) });
  await assert.rejects(
    runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: failing.fetch, today: TODAY, rowLimit: 2, grains: ['page_query'] }),
    err => err instanceof GscApiError && err.status === 429 && /quota/i.test(err.hint),
  );
  // June (empty) and July (four rows) were committed before August failed.
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 4);
  assert.deepEqual(db.prepare('SELECT start_date, end_date, rows FROM gsc_fetches ORDER BY id').all().map(r => ({ ...r })),
    [{ start_date: '2026-06-26', end_date: '2026-06-30', rows: 0 }, { start_date: '2026-07-01', end_date: '2026-07-31', rows: 4 }]);

  const healthy = makeGscMock({ dataDates });
  const resumed = await runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: healthy.fetch, today: TODAY, rowLimit: 2, grains: ['page_query'] });
  assert.deepEqual(resumed.grains[0].windows.map(w => [w.start, w.end]), [
    ['2026-07-12', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-23'],
  ], 'resumes from the last stored date minus revisionDays, not from the beginning');
  assert.equal(count(db, 'SELECT COUNT(*) c FROM gsc_daily'), 20, 'July rows were replaced, September rows added');
  assert.equal(resumed.coverage.page_query.min_date, '2026-07-15');
  assert.equal(resumed.coverage.page_query.max_date, '2026-09-23');
}

// ── runGscFetch: a walk that hits its row cap is marked truncated ───────────
{
  const db = freshDb();
  const mock = makeGscMock();
  const capped = await runGscFetch(db, 'acme', CONFIG, { accessToken: 'tok', fetch: mock.fetch, today: TODAY, rowLimit: 2, maxRows: 6, grains: ['page_query'] });
  const sep = capped.grains[0].windows.at(-1);
  assert.equal(sep.truncated, true);
  assert.equal(sep.rows, 6);
  assert.equal(count(db, "SELECT COUNT(*) c FROM gsc_fetches WHERE truncated = 1 AND start_date = '2026-09-01'"), 1, 'the log says this month is partial');
}

console.log('gsc-fetch fixtures: PASS');
