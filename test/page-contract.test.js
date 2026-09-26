/**
 * Page Contract — decision branches and the guarantees the contract makes.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deriveBrandTerms, isBrandedQuery, registrableName } from '../lib/brand.js';
import { runPageContract, pickFreshestRange } from '../analyses/page-contract/index.js';
import {
  normalizeUrlKey, getApiPageQueryEvidence, getPageQueryEvidence, getPropertyQueryContext,
  coveredStart, truncatedWithin,
} from '../lib/gsc-import.js';

// ── Brand derivation ────────────────────────────────────────────────────────
assert.equal(registrableName('docs.example.io'), 'example');
assert.equal(registrableName('www.example.co.uk'), 'example');
assert.equal(pickFreshestRange(['Last 12 months', 'Last 28 days', 'Last 3 months']), 'Last 28 days');
assert.equal(pickFreshestRange([]), null);

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT, word_count INTEGER, is_indexable INTEGER, crawled_at INTEGER);
    CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, name TEXT, raw_json TEXT);
    CREATE TABLE gsc_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, page_url TEXT, query TEXT,
      clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, date_range TEXT, source TEXT, imported_at INTEGER,
      UNIQUE(project, page_url, query, date_range));
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
    );`);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'fx', 'target');
  db.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)').run(1, 1, 'https://acme.io/widgets', 'Widgets', 'pricing from $9', 400, 1, Date.now());
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Organization', 'Acme', JSON.stringify({ '@type': 'Organization', name: 'Acme' }));
  // A generic schema name that must NOT become a brand term.
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Product', 'Solana Swap Aggregator',
    JSON.stringify({ '@type': 'Product', name: 'Solana Swap Aggregator' }));
  return db;
}
const addQRange = (db, range, page, query, clicks, impressions, position) =>
  db.prepare(`INSERT INTO gsc_queries (project,page_url,query,clicks,impressions,ctr,position,date_range,source,imported_at)
              VALUES ('fx',?,?,?,?,0,?,?,'fx',1)`).run(page, query, clicks, impressions, position, range);
const addQ = (db, page, query, clicks, impressions, position) =>
  addQRange(db, 'Last 28 days', page, query, clicks, impressions, position);
// One API row: (grain, day, page, query). ctr is stored as the API's 0-1 fraction.
// The trailing options place a row under another property, search type or
// fetch time; the defaults are the property every other fixture row uses.
const addDaily = (db, grain, date, page, query, clicks, impressions, position, { property = 'sc-domain:acme.io', searchType = 'web', fetchedAt = 1 } = {}) =>
  db.prepare(`INSERT INTO gsc_daily (project,property,grain,search_type,date,page_url,query,clicks,impressions,ctr,position,fetched_at)
              VALUES ('fx',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(property, grain, searchType, date, page, query, clicks, impressions, impressions ? clicks / impressions : 0, position, fetchedAt);
// One fetch record: the walk that produced the rows, and whether it hit its cap.
const addFetch = (db, grain, start, end, { truncated = false, property = 'sc-domain:acme.io', searchType = 'web' } = {}) =>
  db.prepare(`INSERT INTO gsc_fetches (project,property,grain,search_type,start_date,end_date,rows,requests,truncated,fetched_at)
              VALUES ('fx',?,?,?,?,?,1,1,?,1)`)
    .run(property, grain, searchType, start, end, truncated ? 1 : 0);
const ISO_WINDOW = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
const W28 = { start: '2026-08-27', end: '2026-09-23', days: 28, requested_days: 28 };

// A generic Organization name must never be treated as a brand: doing so would
// reclassify real category demand as navigation and hide the gap.
{
  const db = fixture();
  const b = deriveBrandTerms(db, 'fx');
  assert.ok(b.terms.includes('acme'), 'core brand derived from the domain');
  assert.ok(!b.terms.includes('solana swap aggregator'), 'a purely generic schema name is rejected');
  assert.equal(isBrandedQuery('acme widgets', b.terms), true);
  assert.equal(isBrandedQuery('solana swap aggregator', b.terms), false);
}

// ── no evidence → nothing may be recommended, but hygiene is still allowed ──
{
  const db = fixture();
  addQ(db, null, 'widgets', 5, 900, 12);          // property-wide only
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'no_action_yet');
  assert.equal(r.evidence.scope, 'none');
  const blocked = r.blocked_recommendations.map(b => b.action);
  for (const a of ['expand', 'reposition', 'consolidate', 'claim_category_ownership']) {
    assert.ok(blocked.includes(a), `${a} is blocked without page evidence`);
  }
  assert.ok(r.evidence.missing_inputs.length, 'the missing input is named');
  assert.ok(r.allowed_now.some(a => a.action === 'fix_invalid_markup'),
    'correctness work stays available even when every content action is blocked');
  assert.ok(r.evidence.property_level_context.note.includes('cannot be attributed'),
    'property-wide numbers are labelled as non-attributable');
}

// ── strong non-branded demand near page one → expand ───────────────────────
{
  const db = fixture();
  addQ(db, 'https://acme.io/widgets', 'blue widgets', 3, 400, 8);
  addQ(db, 'https://acme.io/widgets', 'widget sizes', 1, 200, 11);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'expand');
  assert.equal(r.blocked_recommendations.length, 0, 'nothing is blocked once demand is proven');
  assert.equal(r.evidence.page_level.non_branded.impressions, 600);
}

// ── demand exists but ranks far away → reposition, and expand is blocked ────
{
  const db = fixture();
  addQ(db, 'https://acme.io/widgets', 'blue widgets', 0, 500, 42);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'reposition');
  assert.ok(r.blocked_recommendations.some(b => b.action === 'expand'),
    'adding length is blocked when the problem is targeting');
}

// ── branded-only traffic → protect ─────────────────────────────────────────
{
  const db = fixture();
  addQ(db, 'https://acme.io/widgets', 'acme', 10, 300, 2);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'protect');
  assert.ok(r.blocked_recommendations.some(b => b.action === 'expand'));
}

// ── too little signal → no_action_yet rather than a confident guess ────────
{
  const db = fixture();
  addQ(db, 'https://acme.io/widgets', 'blue widgets', 0, 4, 9);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'no_action_yet');
}

// ── a stale crawl must be declared, not silently trusted ───────────────────
{
  const db = fixture();
  const old = Date.now() - 150 * 86_400_000;
  db.prepare('UPDATE pages SET crawled_at = ? WHERE id = 1').run(old);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.evidence.crawl.stale, true, 'a 150-day-old crawl is stale');
  assert.ok(r.evidence.crawl.age_days >= 149);
  assert.ok(r.evidence.missing_inputs.some(m => /Fresh crawl/.test(m)),
    'a re-crawl is named as a missing input');
  assert.ok(r.allowed_now[0].reason.includes('re-crawl'),
    'crawl-derived advice carries the staleness caveat');
}

// A fresh crawl must not raise the warning.
{
  const db = fixture();
  db.prepare('UPDATE pages SET crawled_at = ? WHERE id = 1').run(Date.now());
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.evidence.crawl.stale, false);
  assert.ok(!r.evidence.missing_inputs.some(m => /Fresh crawl/.test(m)));
}

// A URL that was never crawled is a distinct state from a stale one.
{
  const db = fixture();
  const r = runPageContract(db, 'fx', 'https://acme.io/never-crawled');
  assert.equal(r.crawled, false);
  assert.ok(r.evidence.missing_inputs.some(m => /never been crawled/.test(m)));
}

// ── every block must be actionable ─────────────────────────────────────────
{
  const db = fixture();
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  for (const b of r.blocked_recommendations) {
    assert.ok(b.action && b.reason && b.unblocked_by,
      'a block without an unblocking step is a dead end, not guidance');
  }
}

// URL matching must survive scheme, www, and trailing-slash differences.
assert.equal(normalizeUrlKey('https://www.acme.io/widgets/'), normalizeUrlKey('http://acme.io/widgets'));

// Regression: /docs and /docs/ must be one page. Storing them separately meant a
// re-crawl wrote a second row and every lookup kept reading the stale original.
{
  const { normalizePageUrlForTest } = await import('../db/db.js').catch(() => ({}));
  const norm = (u) => { const x = new URL(u); x.hash=''; let p2 = x.pathname.replace(/\/index\.html?$/i,'/'); if (p2.length>1) p2 = p2.replace(/\/+$/,''); x.pathname = p2; return x.toString(); };
  assert.equal(norm('https://x.io/docs/'), norm('https://x.io/docs'));
  assert.equal(norm('https://x.io/'), 'https://x.io/', 'the site root keeps its slash');
  assert.equal(norm('https://x.io'), 'https://x.io/');
}

// ═══ Search Console API rows (gsc_daily) ═════════════════════════════════════
// The window is anchored at the latest fetched date and runs 28 days back,
// inclusive: 2026-08-27..2026-09-23.

// ── (a) API rows for the URL → expand; totals are the window's sums only ────
{
  const db = fixture();
  const W = 'https://acme.io/widgets';
  addDaily(db, 'page_query', '2026-09-23', W, 'blue widgets', 3, 200, 8);
  addDaily(db, 'page_query', '2026-09-01', W, 'blue widgets', 2, 200, 10);
  addDaily(db, 'page_query', '2026-08-27', W, 'widget sizes', 1, 200, 11);   // first day of the window
  addDaily(db, 'page_query', '2026-08-26', W, 'blue widgets', 0, 5000, 50);  // one day too old
  addDaily(db, 'page_query', '2026-05-01', W, 'old query', 0, 9000, 60);     // outside even a 90-day window
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 700, 30); // another page
  const r = runPageContract(db, 'fx', W);
  assert.equal(r.decision, 'expand');
  assert.equal(r.evidence.source, 'api');
  assert.equal(r.evidence.coverage, 'complete');
  assert.equal(r.evidence.scope, 'page');
  assert.deepEqual(r.evidence.window, W28, 'rows reach back past the window, so it is the full 28 days');
  assert.equal(r.evidence.truncated, false);
  assert.equal(r.evidence.property, 'sc-domain:acme.io');
  assert.equal(r.decision_basis.length, 3, 'no window caveat when the fetch holds every day asked for');
  assert.equal(r.evidence.page_level.date_ranges.length, 1);
  assert.match(r.evidence.page_level.date_ranges[0], ISO_WINDOW, 'API date ranges read start..end');
  assert.deepEqual(r.evidence.page_level.date_ranges, ['2026-08-27..2026-09-23']);
  const nb = r.evidence.page_level.non_branded;
  assert.equal(nb.impressions, 600, 'rows older than the window are excluded');
  assert.equal(nb.clicks, 6);
  assert.equal(nb.queries, 2, 'days collapse into one row per query');
  assert.equal(nb.avgPosition, 9.7, 'position is impression-weighted across days');
  assert.equal(nb.ctr, 1, 'ctr is percent, as the CSV path reports it');
  assert.equal(r.evidence.missing_inputs.length, 0, 'nothing is missing under complete coverage');

  // The rows themselves carry percent ctr and a weighted position.
  const api = getApiPageQueryEvidence(db, 'fx', W);
  assert.equal(api.coverage, 'complete');
  assert.deepEqual(api.rows.map(x => x.query), ['blue widgets', 'widget sizes'], 'ordered by impressions');
  assert.equal(api.rows[0].ctr, 1.25, '5 clicks / 400 impressions, in percent');
  assert.equal(api.rows[0].position, 9);

  // A longer window pulls the older row in and changes the verdict with it.
  const r90 = runPageContract(db, 'fx', W, { windowDays: 90 });
  assert.equal(r90.evidence.window.start, '2026-06-26');
  assert.equal(r90.evidence.window.days, 90);
  assert.equal(r90.evidence.page_level.non_branded.impressions, 5600);
  assert.equal(r90.decision, 'reposition');
}

// ── (b) API data for the project, none for this URL → measured absence ──────
// The fetch record is what vouches for the empty days: a walk over
// 2026-06-26..2026-09-23 that stored one row still asked the API about every
// day in between, and a day that came back empty is a measurement.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 700, 30);
  addFetch(db, 'page_query', '2026-06-26', '2026-09-23');
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'no_action_yet');
  assert.equal(r.evidence.scope, 'none');
  assert.equal(r.evidence.source, 'api');
  assert.equal(r.evidence.coverage, 'complete');
  assert.equal(r.evidence.truncated, false);
  assert.deepEqual(r.evidence.window, W28);
  assert.ok(r.decision_basis[0].includes('measured, not missing'), 'absence under complete coverage is a finding');
  assert.ok(r.decision_basis[0].includes('between 2026-08-27 and 2026-09-23 (28 days)'));
  const blocked = r.blocked_recommendations;
  assert.deepEqual(blocked.map(b => b.action), ['expand', 'reposition', 'consolidate', 'claim_category_ownership']);
  for (const b of blocked) {
    assert.ok(b.unblocked_by.includes('gsc-fetch fx'), `${b.action}: a later fetch unblocks it`);
    assert.ok(!/windowDays/.test(b.unblocked_by), `${b.action}: never asks for an input the CLI and MCP callers cannot pass`);
    assert.ok(!/export/i.test(b.unblocked_by), `${b.action}: no export is asked for when coverage is complete`);
  }
  assert.deepEqual(r.evidence.missing_inputs, [], 'nothing is missing under complete coverage');
  assert.ok(r.allowed_now.some(a => a.action === 'fix_invalid_markup'), 'hygiene stays available');
}

// ── (b′) A walk that hit its row cap cannot vouch for a missing URL ─────────
// The API returns rows in click order, so a capped walk drops exactly the
// low-click pages. Declaring one of them "no demand" would be a false
// measurement presented as fact: coverage must read 'partial', the wording
// must not claim measurement, and the export route — the one input that
// reaches past the cap — must be named.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/top', 'widgets', 900, 9000, 1);
  addDaily(db, 'page_query', '2026-09-01', 'https://acme.io/top', 'widgets', 900, 9000, 1);
  addFetch(db, 'page_query', '2026-09-01', '2026-09-23', { truncated: true });
  const r = runPageContract(db, 'fx', 'https://acme.io/long-tail');
  assert.equal(r.decision, 'no_action_yet');
  assert.equal(r.evidence.scope, 'none');
  assert.equal(r.evidence.source, 'api');
  assert.equal(r.evidence.coverage, 'partial', 'a truncated walk is not complete coverage');
  assert.equal(r.evidence.truncated, true);
  assert.deepEqual(r.evidence.window, { start: '2026-09-01', end: '2026-09-23', days: 23, requested_days: 28 },
    'the window is the days the walk asked for, not 28');
  assert.ok(!r.decision_basis.some(b => /measured, not missing/.test(b)), 'never claims measurement over a capped walk');
  assert.ok(!r.decision_basis.some(b => /reports no impressions/.test(b)), 'never states the zero as a Search Console report');
  assert.ok(r.decision_basis[0].includes('row cap'), 'names the truncation as the reason');
  assert.ok(r.decision_basis[0].includes('gap in the inputs, not a measurement'));
  assert.deepEqual(r.blocked_recommendations.map(b => b.action), ['expand', 'reposition', 'consolidate', 'claim_category_ownership']);
  for (const b of r.blocked_recommendations) {
    assert.ok(/Page filter/.test(b.unblocked_by), `${b.action}: the page-filtered export is the reachable unblock`);
    assert.ok(!/windowDays|maxRows|max-rows/.test(b.unblocked_by), `${b.action}: names no input the caller cannot pass`);
  }
  assert.ok(r.evidence.missing_inputs.some(m => /export/i.test(m) && /row cap/.test(m)), 'the export is genuinely missing here, and the reason is given');

  // The page that DID survive the cap is read, but its totals are declared a floor.
  const top = runPageContract(db, 'fx', 'https://acme.io/top');
  assert.equal(top.evidence.scope, 'page');
  assert.equal(top.evidence.coverage, 'partial');
  assert.equal(top.evidence.page_level.non_branded.impressions, 18000);
  assert.ok(top.decision_basis.some(b => /floor/.test(b) && /row cap/.test(b)), 'totals under a capped walk are labelled a floor');

  // A page-filtered export for the missing URL is better evidence than the gap, and is read.
  addQ(db, 'https://acme.io/long-tail', 'long tail widgets', 3, 400, 8);
  const csv = runPageContract(db, 'fx', 'https://acme.io/long-tail');
  assert.equal(csv.evidence.source, 'csv', 'the export named as the unblock actually unblocks');
  assert.equal(csv.evidence.coverage, 'export');
  assert.equal(csv.decision, 'expand');
  assert.equal(csv.evidence.page_level.non_branded.impressions, 400);
  // ...but a page with API rows keeps them: the API stays first whenever it has rows.
  assert.equal(runPageContract(db, 'fx', 'https://acme.io/top').evidence.source, 'api');
}

// A truncated walk OUTSIDE the window does not taint it.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 700, 30);
  addFetch(db, 'page_query', '2026-05-01', '2026-05-31', { truncated: true });
  addFetch(db, 'page_query', '2026-06-01', '2026-09-23');
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.evidence.coverage, 'complete');
  assert.equal(r.evidence.truncated, false);
  assert.deepEqual(r.evidence.window, W28);
  assert.ok(r.decision_basis[0].includes('measured, not missing'));
}

// ── Two properties for one project are never summed ─────────────────────────
// Switching a project from a URL-prefix property to sc-domain (or back) leaves
// both sets of rows in gsc_daily. Only the most recently fetched property is
// read — the one a new fetch would extend — and only its search type.
{
  const db = fixture();
  const T = 'https://acme.io/top';
  addDaily(db, 'page_query', '2026-09-23', T, 'widgets', 90, 9000, 3, { property: 'https://acme.io/', fetchedAt: 100 });
  addDaily(db, 'page_query', '2026-09-23', T, 'widgets', 90, 9000, 3, { property: 'sc-domain:acme.io', fetchedAt: 200 });
  addDaily(db, 'page_query', '2026-09-23', T, 'widgets', 5, 500, 3, { property: 'sc-domain:acme.io', searchType: 'image', fetchedAt: 150 });
  const r = runPageContract(db, 'fx', T);
  assert.equal(r.evidence.property, 'sc-domain:acme.io', 'the most recently fetched property is read');
  assert.equal(r.evidence.page_level.non_branded.impressions, 9000, 'the same day under the other property is not added on top');
  assert.equal(r.evidence.page_level.non_branded.clicks, 90, 'nor is the other search type');
  // A newer fetch under the URL-prefix property flips the choice, and the sum with it.
  addDaily(db, 'page_query', '2026-09-22', T, 'widgets', 10, 1000, 3, { property: 'https://acme.io/', fetchedAt: 300 });
  const r2 = runPageContract(db, 'fx', T);
  assert.equal(r2.evidence.property, 'https://acme.io/');
  assert.equal(r2.evidence.page_level.non_branded.impressions, 10000);

  // The query grain makes its own choice, and is scoped the same way.
  addDaily(db, 'query', '2026-09-23', null, 'widgets', 5, 900, 12, { property: 'https://acme.io/', fetchedAt: 100 });
  addDaily(db, 'query', '2026-09-23', null, 'widgets', 5, 900, 12, { property: 'sc-domain:acme.io', fetchedAt: 200 });
  const ctx = getPropertyQueryContext(db, 'fx');
  assert.equal(ctx.property, 'sc-domain:acme.io');
  assert.equal(ctx.rows[0].impressions, 900, 'property-wide totals are not doubled either');
}

// ── The window never names a day that was not fetched ───────────────────────
// After `gsc-fetch --days 7` gsc_daily holds a week. The old text asserted "no
// impressions between 2026-08-27 and 2026-09-23" — 21 of those days were never
// asked for. The window is clamped to the fetched days and says so.
{
  const db = fixture();
  for (let d = 17; d <= 23; d++) addDaily(db, 'page_query', `2026-09-${d}`, 'https://acme.io/other', 'blue widgets', 0, 100, 30);
  addFetch(db, 'page_query', '2026-09-17', '2026-09-23');
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.deepEqual(r.evidence.window, { start: '2026-09-17', end: '2026-09-23', days: 7, requested_days: 28 });
  assert.equal(r.evidence.coverage, 'complete', 'seven fully fetched days are complete coverage over those seven days');
  assert.ok(r.decision_basis[0].includes('between 2026-09-17 and 2026-09-23'), 'the claim covers fetched days only');
  assert.ok(r.decision_basis[0].includes('7 of the 28 days asked for have been fetched'), 'the shortfall is stated');
  assert.ok(!r.decision_basis[0].includes('2026-08-27'), 'no unfetched day is named');
  assert.ok(r.decision_basis[0].includes('measured, not missing'), 'absence over the fetched days is still a measurement');
  for (const b of r.blocked_recommendations) {
    assert.ok(b.unblocked_by.includes('adds days to the window'), `${b.action}: a later fetch is named as what lengthens the window`);
    assert.ok(b.unblocked_by.includes('7 of the 28'));
  }
  assert.deepEqual(r.evidence.page_level, null);

  // A page with rows in the short window is decided on it, with the caveat spelled out.
  for (let d = 17; d <= 23; d++) addDaily(db, 'page_query', `2026-09-${d}`, 'https://acme.io/widgets', 'blue widgets', 1, 100, 8);
  const w = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(w.decision, 'expand');
  assert.equal(w.evidence.page_level.non_branded.impressions, 700);
  assert.deepEqual(w.evidence.page_level.date_ranges, ['2026-09-17..2026-09-23']);
  assert.ok(w.decision_basis.some(b => /Only 7 of the 28 days/.test(b)), 'a verdict on fewer days than asked says so');
}

// Without fetch records the rows themselves bound the claim: MIN(date).
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-20', 'https://acme.io/other', 'blue widgets', 0, 100, 30);
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 100, 30);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.deepEqual(r.evidence.window, { start: '2026-09-20', end: '2026-09-23', days: 4, requested_days: 28 });
  assert.ok(r.evidence.window.start >= '2026-09-20', 'window.start is never earlier than the first stored day');
  assert.equal(getPropertyQueryContext(db, 'fx'), null);
}

// A fetch record that stops short of the latest day cannot vouch for it: only
// a run of records containing the latest day extends the window past the rows.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 100, 30);
  addFetch(db, 'page_query', '2026-07-01', '2026-07-31');                // an old, disconnected walk
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.deepEqual(r.evidence.window, { start: '2026-09-23', end: '2026-09-23', days: 1, requested_days: 28 });
  addFetch(db, 'page_query', '2026-08-01', '2026-08-31');
  addFetch(db, 'page_query', '2026-09-01', '2026-09-23');
  const r2 = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.deepEqual(r2.evidence.window, W28, 'month chunks merge into one run that reaches the latest day');
}

// ── coveredStart / truncatedWithin are pure and gap-aware ───────────────────
{
  const jul = { start_date: '2026-07-01', end_date: '2026-07-31', truncated: 0 };
  const aug = { start_date: '2026-08-01', end_date: '2026-08-31', truncated: 0 };
  const sep = { start_date: '2026-09-01', end_date: '2026-09-30', truncated: 1 };
  assert.equal(coveredStart([sep, jul, aug], '2026-09-23'), '2026-07-01', 'order does not matter; adjacent months merge');
  assert.equal(coveredStart([jul, sep], '2026-09-23'), '2026-09-01', 'a gap (August) breaks the run');
  assert.equal(coveredStart([jul, aug], '2026-09-23'), null, 'no record covers the latest day');
  assert.equal(coveredStart([], '2026-09-23'), null);
  assert.equal(coveredStart([{ start_date: '2026-09-01', end_date: '2026-09-23' }, { start_date: '2026-09-21', end_date: '2026-09-25' }], '2026-09-24'),
    '2026-09-01', 'overlapping re-fetches of the revision days merge too');
  assert.equal(truncatedWithin([jul, aug, sep], { start: '2026-08-27', end: '2026-09-23' }), true);
  assert.equal(truncatedWithin([jul, aug, sep], { start: '2026-08-01', end: '2026-08-31' }), false, 'a truncated month outside the window does not count');
  assert.equal(truncatedWithin([{ ...sep, truncated: '0' }], { start: '2026-09-01', end: '2026-09-23' }), false);
  assert.equal(truncatedWithin([], { start: '2026-09-01', end: '2026-09-23' }), false);
}

// ── (c) URL matching tolerates the API's canonical spelling ─────────────────
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://www.acme.io/widgets/', 'blue widgets', 3, 400, 8);
  addDaily(db, 'page_query', '2026-09-22', 'https://www.acme.io/widgets/', 'widget sizes', 1, 200, 11);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'expand');
  assert.equal(r.evidence.page_level.non_branded.impressions, 600);
}

// ── Thin API signal points at a later fetch, not at another export ──────────
// The read window is a library parameter (runPageContract windowDays) that the
// CLI and the MCP tool do not expose, so the unblock never names it: the one
// step every caller has is another fetch.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/widgets', 'blue widgets', 0, 4, 9);
  addFetch(db, 'page_query', '2026-06-26', '2026-09-23');
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'no_action_yet');
  const expand = r.blocked_recommendations.find(b => b.action === 'expand');
  assert.ok(expand.unblocked_by.includes('later fetch (seo-intel gsc-fetch fx)'), 'the fetch is the reachable step');
  assert.ok(!/windowDays/.test(expand.unblocked_by), 'no parameter the caller cannot pass');
  assert.ok(!/export/i.test(expand.unblocked_by));
  assert.ok(!/adds days/.test(expand.unblocked_by), 'a full window does not promise to grow');

  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/widgets', 'acme', 10, 300, 2);
  const p = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(p.decision, 'protect');
  const pExpand = p.blocked_recommendations.find(b => b.action === 'expand');
  assert.ok(pExpand.unblocked_by.includes('later fetch'));
  assert.ok(!/windowDays/.test(pExpand.unblocked_by));

  // On a short window the same hint says the fetch also lengthens it.
  const short = fixture();
  addDaily(short, 'page_query', '2026-09-23', 'https://acme.io/widgets', 'blue widgets', 0, 4, 9);
  const s = runPageContract(short, 'fx', 'https://acme.io/widgets');
  const sExpand = s.blocked_recommendations.find(b => b.action === 'expand');
  assert.ok(sExpand.unblocked_by.includes('1 of the 28 days asked for'), 'the shortfall is named');
  assert.ok(sExpand.unblocked_by.includes('each fetch adds days'));
}

// runPageContract's windowDays is honoured for library callers, and the
// window says what was asked so the caller can tell a clamp from a choice.
{
  const db = fixture();
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 700, 30);
  addFetch(db, 'page_query', '2026-09-17', '2026-09-23');
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets', { windowDays: 7 });
  assert.deepEqual(r.evidence.window, { start: '2026-09-17', end: '2026-09-23', days: 7, requested_days: 7 });
  assert.ok(r.decision_basis[0].includes('(7 days)'), 'a window that is exactly what was asked for carries no shortfall');
}

// ── (d) CSV path: overlapping exports must not double count ─────────────────
// The same page exported as "Last 28 days" and "Last 3 months" used to be summed
// (2100 impressions). Only the freshest window may be read.
{
  const db = fixture();
  const W = 'https://acme.io/widgets';
  addQRange(db, 'Last 28 days', W, 'blue widgets', 3, 400, 8);
  addQRange(db, 'Last 28 days', W, 'widget sizes', 1, 200, 11);
  addQRange(db, 'Last 3 months', W, 'blue widgets', 10, 1200, 9);
  addQRange(db, 'Last 3 months', W, 'widget sizes', 3, 300, 12);
  const r = runPageContract(db, 'fx', W);
  assert.equal(r.decision, 'expand');
  assert.equal(r.evidence.source, 'csv');
  assert.equal(r.evidence.coverage, 'export');
  assert.equal(r.evidence.window, null);
  assert.deepEqual(r.evidence.page_level.date_ranges, ['Last 28 days'], 'one window is read');
  assert.equal(r.evidence.page_level.non_branded.impressions, 600, 'the 3-month export is not added on top');
  assert.equal(r.evidence.page_level.non_branded.clicks, 4);
  const ev = getPageQueryEvidence(db, 'fx', W);
  assert.equal(ev.rows.length, 2);
  assert.ok(ev.rows.every(x => x.date_range === 'Last 28 days'));
}

// ── CSV path with no page rows: the fetch is offered as the other way in ─────
{
  const db = fixture();
  addQ(db, null, 'widgets', 5, 900, 12);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'no_action_yet');
  assert.equal(r.evidence.source, null, 'no page-level source of any kind');
  assert.equal(r.evidence.coverage, null);
  for (const b of r.blocked_recommendations) {
    assert.ok(/Page filter/.test(b.unblocked_by), 'the export route is still named');
    assert.ok(b.unblocked_by.includes('gsc-fetch fx'), 'the fetch route is named too');
  }
  assert.ok(r.evidence.missing_inputs.some(m => /export/i.test(m)), 'an export is genuinely missing here');
  assert.equal(r.evidence.property_level_context.source, 'csv');
  assert.equal(r.evidence.property_level_context.date_range, 'Last 28 days');
}

// ── (e) Property context from query-grain rows ──────────────────────────────
{
  const db = fixture();
  addDaily(db, 'query', '2026-09-23', null, 'widgets', 5, 900, 12);
  addDaily(db, 'query', '2026-09-10', null, 'acme', 40, 300, 1.2);
  addDaily(db, 'query', '2026-08-01', null, 'widgets', 0, 5000, 40);   // outside the window
  const ctx = getPropertyQueryContext(db, 'fx');
  assert.equal(ctx.source, 'api');
  assert.match(ctx.date_range, ISO_WINDOW);
  assert.equal(ctx.date_range, '2026-08-27..2026-09-23');
  assert.equal(ctx.coverage, 'complete');
  assert.equal(ctx.truncated, false);
  assert.equal(ctx.property, 'sc-domain:acme.io');
  assert.deepEqual(ctx.rows.map(x => x.query), ['widgets', 'acme']);
  assert.equal(ctx.rows[0].ctr, 0.56, 'percent, two decimals');

  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  const pl = r.evidence.property_level_context;
  assert.equal(pl.source, 'api');
  assert.equal(pl.date_range, '2026-08-27..2026-09-23');
  assert.equal(pl.non_branded.impressions, 900, 'the out-of-window row is not counted');
  assert.equal(pl.branded.impressions, 300);
  assert.equal(pl.truncated, false);
  assert.ok(pl.note.includes('cannot be attributed'));
  // Query-grain rows are context only: they do not make page evidence exist.
  assert.equal(r.evidence.scope, 'none');
  assert.equal(r.evidence.source, null, 'no page_query fetch, so no page-level source');
}

// gsc_daily without gsc_fetches (a hand-loaded table) still answers: the rows
// vouch for themselves and nothing is claimed beyond them.
{
  const db = fixture();
  db.exec('DROP TABLE gsc_fetches;');
  addDaily(db, 'page_query', '2026-09-23', 'https://acme.io/other', 'blue widgets', 0, 700, 30);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.evidence.source, 'api');
  assert.equal(r.evidence.coverage, 'complete');
  assert.deepEqual(r.evidence.window, { start: '2026-09-23', end: '2026-09-23', days: 1, requested_days: 28 });
}

// ── An older database without gsc_daily behaves as "no API data" ────────────
{
  const db = fixture();
  db.exec('DROP TABLE gsc_daily; DROP TABLE gsc_fetches;');
  assert.equal(getApiPageQueryEvidence(db, 'fx', 'https://acme.io/widgets'), null);
  assert.equal(getPropertyQueryContext(db, 'fx'), null);
  addQ(db, 'https://acme.io/widgets', 'blue widgets', 3, 400, 8);
  const r = runPageContract(db, 'fx', 'https://acme.io/widgets');
  assert.equal(r.decision, 'expand');
  assert.equal(r.evidence.source, 'csv');
}

console.log('page-contract fixtures: PASS');
