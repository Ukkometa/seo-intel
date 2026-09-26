/**
 * demand — the CTR baseline, the three pure detectors, and runDemand against
 * an in-memory gsc_daily holding two full 28-day windows.
 *
 * The gsc_* DDL is copied verbatim from db/db.js getDb() (as gsc-fetch.test.js
 * does), and the insights table carries the six provenance columns: without
 * them upsertInsights returns 0 silently and every Ledger assertion below
 * would pass for the wrong reason. Dates are fixed strings, so the windows are
 * the same on every machine.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULTS,
  EXPECTED_CTR,
  computeLongTails,
  computeQuickWins,
  computeTrends,
  expectedCtr,
  runDemand,
} from '../analyses/demand/index.js';
import { getWindowRows } from '../lib/gsc-import.js';
import { getActiveInsights } from '../db/db.js';
import { FREE_INSIGHT_TYPES, INSIGHT_TYPES, RULE_INSIGHT_TYPES } from '../lib/insight-types.js';

// The gsc_* DDL below is copied verbatim from db/db.js getDb(). Keep them identical.
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
  CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, word_count INTEGER, is_indexable INTEGER, crawled_at INTEGER);
  CREATE TABLE insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, source_analysis_id INTEGER,
    data TEXT NOT NULL, source TEXT, source_kind TEXT, model TEXT, prompt_version TEXT,
    rule_version TEXT, confidence REAL, expires_at INTEGER,
    UNIQUE(project, type, fingerprint));
`;

const PROPERTY = 'sc-domain:acme.io';
// The latest fetched day is 2026-09-23; the two 28-day windows behind it.
const CUR = { start: '2026-08-27', end: '2026-09-23', days: 28, requested_days: 28 };
const PREV = { start: '2026-07-30', end: '2026-08-26', days: 28, requested_days: 28 };

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'fx', 'target');
  db.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?,?)').run(1, 1, 'https://acme.io/widgets', 'Widgets', 400, 1, Date.now());
  return db;
}

// One API row: (grain, day, page, query). ctr is stored as the API's 0-1 fraction.
const addDaily = (db, grain, date, page, query, clicks, impressions, position) =>
  db.prepare(`INSERT INTO gsc_daily (project,property,grain,search_type,date,page_url,query,clicks,impressions,ctr,position,fetched_at)
              VALUES ('fx',?,?,'web',?,?,?,?,?,?,?,1)`)
    .run(PROPERTY, grain, date, page, query, clicks, impressions, impressions ? clicks / impressions : 0, position);
// One fetch record: the walk that produced the rows, and whether it hit its cap.
const addFetch = (db, grain, start, end, { truncated = false } = {}) =>
  db.prepare(`INSERT INTO gsc_fetches (project,property,grain,search_type,start_date,end_date,rows,requests,truncated,fetched_at)
              VALUES ('fx',?,?,'web',?,?,1,1,?,1)`)
    .run(PROPERTY, grain, start, end, truncated ? 1 : 0);

const P = path => `https://acme.io${path}`;

/**
 * Two full windows of all three grains. The page_query rows are split across
 * two days where it matters, so the aggregation is exercised and not just the
 * arithmetic on a single row. Each grain has one row dated on the last fetched
 * day: the window is anchored at the newest ROW, not at the fetch record.
 */
function seeded() {
  const db = freshDb();
  for (const grain of ['page_query', 'query', 'page']) addFetch(db, grain, PREV.start, CUR.end);

  // page_query, current window
  addDaily(db, 'page_query', '2026-09-01', P('/widgets'), 'blue widgets', 1, 100, 6);
  addDaily(db, 'page_query', '2026-09-15', P('/widgets'), 'blue widgets', 1, 100, 6);        // → 2/200 at 6: ctr_gap
  addDaily(db, 'page_query', '2026-09-10', P('/gizmos'), 'gizmo pricing', 1, 120, 14);      // page_two
  addDaily(db, 'page_query', '2026-09-10', P('/gadgets'), 'gadget review', 0, 300, 12);     // both
  addDaily(db, 'page_query', CUR.end, P('/'), 'acme', 50, 100, 1.2);                         // position 1: not striking; anchors the window
  addDaily(db, 'page_query', '2026-09-10', P('/widgets'), 'cheap widgets', 0, 30, 8);       // under minImpressions
  addDaily(db, 'page_query', '2026-09-10', P('/widgets'), 'how to install blue widgets', 5, 40, 5);   // page one: covers the phrase
  addDaily(db, 'page_query', '2026-09-10', P('/gizmos'), 'best budget gizmo for garages', 1, 30, 18);
  addDaily(db, 'page_query', '2026-09-10', P('/garage'), 'best budget gizmo for garages', 0, 10, 25);
  // page_query, previous window (only to prove the current window excludes it)
  addDaily(db, 'page_query', '2026-08-10', P('/old'), 'old query', 0, 500, 12);

  // query, current window
  addDaily(db, 'query', '2026-09-10', null, 'how to install blue widgets', 5, 60, 12);    // excluded: page one covers it
  addDaily(db, 'query', '2026-09-10', null, 'best budget gizmo for garages', 1, 45, 15);  // long tail, best page /gizmos
  addDaily(db, 'query', CUR.end, null, 'gizmo pricing', 1, 120, 14);                      // two words; anchors the window
  addDaily(db, 'query', '2026-09-10', null, 'widget install guide pdf', 2, 25, 9);        // position under 10.5
  addDaily(db, 'query', '2026-09-10', null, 'orphan long tail query', 0, 25, 30);         // long tail, no page
  addDaily(db, 'query', '2026-09-10', null, 'tiny long tail query here', 0, 10, 40);      // under minLongTailImpressions

  // page, current window
  addDaily(db, 'page', '2026-09-10', P('/widgets'), null, 16, 400, 7);
  addDaily(db, 'page', '2026-09-10', P('/gizmos'), null, 20, 300, 12);
  addDaily(db, 'page', '2026-09-10', P('/tiny'), null, 1, 20, 30);
  addDaily(db, 'page', CUR.end, P('/'), null, 95, 200, 1.3);                               // anchors the window
  addDaily(db, 'page', '2026-09-10', P('/gadgets'), null, 30, 400, 12);
  // page, previous window
  addDaily(db, 'page', '2026-08-05', P('/widgets'), null, 20, 250, 4);
  addDaily(db, 'page', '2026-08-20', P('/widgets'), null, 20, 250, 4);                    // → 40/500 at 4
  addDaily(db, 'page', '2026-08-10', P('/gizmos'), null, 10, 250, 13);
  addDaily(db, 'page', '2026-08-10', P('/tiny'), null, 3, 30, 28);
  addDaily(db, 'page', '2026-08-10', P('/'), null, 100, 210, 1.2);
  addDaily(db, 'page', '2026-08-10', P('/gadgets'), null, 0, 50, 15);
  return db;
}

const rowsOf = (db, type) => db.prepare('SELECT * FROM insights WHERE project = ? AND type = ? ORDER BY fingerprint').all('fx', type);
const activeOf = (db, type) => rowsOf(db, type).filter(r => r.status === 'active');

// ── Registry ────────────────────────────────────────────────────────────────
{
  const qw = INSIGHT_TYPES.gsc_quick_win;
  assert.equal(qw.groupKey, 'gsc_quick_wins');
  assert.equal(qw.label, 'Demand quick win');
  assert.deepEqual([qw.scope, qw.category, qw.severity, qw.difficulty, qw.sourceKind], ['own-site', 'keyword', 'info', 2, 'rule']);
  assert.equal(qw.title({ query: 'blue widgets', page_url: 'https://acme.io/widgets' }), 'blue widgets → https://acme.io/widgets');
  assert.equal(qw.fix({ recommendation: 'Do the thing.' }), 'Do the thing.');
  assert.match(qw.detail({ impressions: 200, position: 6, ctr: 1, expected_ctr: 4, kind: 'ctr_gap', potential_clicks: 6 }), /200 impressions at position 6/);

  const lt = INSIGHT_TYPES.gsc_long_tail;
  assert.equal(lt.groupKey, 'gsc_long_tails');
  assert.equal(lt.label, 'Demand long tail');
  assert.deepEqual([lt.scope, lt.category, lt.severity, lt.difficulty, lt.sourceKind], ['own-site', 'content', 'info', 3, 'rule']);
  assert.equal(lt.url({ best_page: 'https://acme.io/gizmos' }), 'https://acme.io/gizmos');

  const dc = INSIGHT_TYPES.gsc_decay;
  assert.equal(dc.groupKey, 'gsc_decays');
  assert.equal(dc.label, 'Traffic decay');
  assert.deepEqual([dc.scope, dc.category, dc.severity, dc.difficulty, dc.sourceKind], ['history', 'content', 'warn', 3, 'rule']);
  assert.equal(dc.title({ page_url: 'https://acme.io/widgets' }), 'https://acme.io/widgets');
  assert.match(dc.detail({ previous_clicks: 40, clicks: 16, delta_pct: -60, previous_impressions: 500, impressions: 400, previous_position: 4, position: 7, previous_window: 'a..b', window: 'c..d' }), /40 → 16 \(-60%\)/);

  for (const t of [qw, lt, dc]) {
    for (const fn of ['title', 'detail', 'fix', 'url']) {
      assert.doesNotThrow(() => t[fn]({}), `${t.key}.${fn} tolerates an empty blob`);
      assert.doesNotThrow(() => t[fn](null), `${t.key}.${fn} tolerates null`);
    }
    assert.ok(RULE_INSIGHT_TYPES.includes(t.key), `${t.key} is a rule`);
    assert.equal(t.ruleVersion, '1');
  }
  assert.ok(FREE_INSIGHT_TYPES.includes('gsc_quick_win') && FREE_INSIGHT_TYPES.includes('gsc_long_tail'), 'demand findings are free');
  assert.ok(!FREE_INSIGHT_TYPES.includes('gsc_decay'), "scope 'history' is not free");
}

// ── Constants and the CTR baseline ──────────────────────────────────────────
assert.deepEqual(DEFAULTS, {
  windowDays: 28, minImpressions: 50, minLongTailImpressions: 20, strikingMin: 4, strikingMax: 20,
  longTailMinPosition: 10.5, longTailMinWords: 3, cap: 50, decayPct: 40, growthPct: 40, minTrendClicks: 10,
});
for (let p = 1; p <= 20; p++) assert.equal(typeof EXPECTED_CTR[p], 'number', `bucket ${p} exists`);
for (let p = 2; p <= 20; p++) assert.ok(EXPECTED_CTR[p] <= EXPECTED_CTR[p - 1], 'the curve never rises with position');
assert.equal(expectedCtr(1), 0.28);
assert.equal(expectedCtr(3.4), 0.10, 'rounds down to the nearest bucket');
assert.equal(expectedCtr(3.6), 0.07, 'rounds up to the nearest bucket');
assert.equal(expectedCtr(8), 0.03);
assert.equal(expectedCtr(10.5), 0.01, 'the half rounds to page two');
assert.equal(expectedCtr(15), 0.01);
assert.equal(expectedCtr(47), 0.01, 'clamped to the last bucket');
assert.equal(expectedCtr(0.4), 0.28, 'clamped to the first bucket');
assert.equal(expectedCtr(null), null, 'no position, no baseline');
assert.equal(expectedCtr('x'), null);

// ── computeQuickWins ────────────────────────────────────────────────────────
{
  const rows = [
    { page_url: P('/widgets'), query: 'blue widgets', clicks: 2, impressions: 200, position: 6 },
    { page_url: P('/gizmos'), query: 'gizmo pricing', clicks: 1, impressions: 120, position: 14 },
    { page_url: P('/gadgets'), query: 'gadget review', clicks: 0, impressions: 300, position: 12 },
    { page_url: P('/'), query: 'acme', clicks: 50, impressions: 100, position: 1.2 },          // below strikingMin
    { page_url: P('/far'), query: 'far away', clicks: 0, impressions: 900, position: 20.1 },   // above strikingMax
    { page_url: P('/widgets'), query: 'cheap widgets', clicks: 0, impressions: 30, position: 8 }, // under minImpressions
    { page_url: P('/ok'), query: 'healthy row', clicks: 5, impressions: 100, position: 5 },     // CTR on the curve, page one
    { page_url: P('/none'), query: 'no position', clicks: 0, impressions: 100, position: null },
    { page_url: null, query: 'no page', clicks: 0, impressions: 100, position: 12 },
  ];
  const wins = computeQuickWins(rows);
  assert.deepEqual(wins.map(w => [w.query, w.kind, w.potential_clicks]), [
    ['gadget review', 'both', 9],     // max(round(300×.01)=3, round(300×.03)=9)
    ['blue widgets', 'ctr_gap', 6],   // round(200×(.04−.01))
    ['gizmo pricing', 'page_two', 3], // round(120×(.03−.0083))
  ], 'classified, scored and sorted by potential');
  const gadget = wins[0];
  assert.deepEqual([gadget.page_url, gadget.impressions, gadget.clicks, gadget.position, gadget.ctr, gadget.expected_ctr],
    [P('/gadgets'), 300, 0, 12, 0, 1], 'ctr and expected_ctr are percents');
  for (const w of wins) {
    assert.ok(w.recommendation.includes(w.page_url) && w.recommendation.includes(`"${w.query}"`), `${w.kind}: names the page and the query`);
  }
  assert.match(wins[1].recommendation, /title and meta description/, 'a CTR gap asks for a snippet rewrite');
  assert.match(wins[2].recommendation, /internal links/, 'page two asks for links and depth');

  assert.equal(computeQuickWins(rows, { cap: 2 }).length, 2, 'capped');
  assert.deepEqual(computeQuickWins(rows, { minImpressions: 20 }).map(w => w.query).sort(),
    ['blue widgets', 'cheap widgets', 'gadget review', 'gizmo pricing'], 'a lower floor admits the small row');
  assert.deepEqual(computeQuickWins(rows, { strikingMin: 1 }).find(w => w.query === 'acme'), undefined,
    'position 1 with 50% CTR is not a gap even inside the range');

  // The striking range is inclusive at both ends: 4 and 20 are in, a hair
  // outside either is out. Position 4 needs a CTR gap to be a win (it is page
  // one); 20 is page two and a win on that alone.
  const striking = pos => computeQuickWins([{ page_url: P('/a'), query: 'edge', clicks: 0, impressions: 100, position: pos }]);
  assert.deepEqual(striking(4).map(w => [w.kind, w.position]), [['ctr_gap', 4]], 'position 4 is inside the range');
  assert.deepEqual(striking(20).map(w => [w.kind, w.position]), [['both', 20]], 'position 20 is inside the range');
  assert.deepEqual(striking(3.99), [], 'just above the top of the range is out');
  assert.deepEqual(striking(20.01), [], 'just past the bottom of the range is out');
  assert.equal(computeQuickWins([{ page_url: P('/a'), query: 'edge', clicks: 0, impressions: 100, position: 21 }], { strikingMax: 21 }).length, 1,
    'the bounds are thresholds');

  // The gap threshold is strict: exactly 60% of the baseline is not a gap.
  assert.equal(computeQuickWins([{ page_url: P('/a'), query: 'edge', clicks: 3, impressions: 100, position: 5 }]).length, 0);
  assert.equal(computeQuickWins([{ page_url: P('/a'), query: 'edge', clicks: 2, impressions: 100, position: 5 }])[0].potential_clicks, 3);
  // A page-two row above the landing baseline is still page two, worth nothing extra.
  const rich = computeQuickWins([{ page_url: P('/a'), query: 'rich', clicks: 10, impressions: 100, position: 12 }])[0];
  assert.deepEqual([rich.kind, rich.potential_clicks], ['page_two', 0]);
  assert.deepEqual(computeQuickWins([]), []);
  assert.deepEqual(computeQuickWins(null), []);
}

// ── computeLongTails ────────────────────────────────────────────────────────
{
  const queryRows = [
    { query: 'how to install blue widgets', clicks: 5, impressions: 60, position: 12 },
    { query: 'best budget gizmo for garages', clicks: 1, impressions: 45, position: 15 },
    { query: 'gizmo pricing', clicks: 1, impressions: 120, position: 14 },
    { query: 'widget install guide pdf', clicks: 2, impressions: 25, position: 9 },
    { query: 'orphan long tail query', clicks: 0, impressions: 25, position: 30 },
    { query: 'tiny long tail query here', clicks: 0, impressions: 10, position: 40 },
    { query: 'no position at all', clicks: 0, impressions: 50, position: null },
  ];
  const pageQueryRows = [
    { page_url: P('/widgets'), query: 'how to install blue widgets', clicks: 5, impressions: 40, position: 5 },
    { page_url: P('/gizmos'), query: 'best budget gizmo for garages', clicks: 1, impressions: 30, position: 18 },
    { page_url: P('/garage'), query: 'best budget gizmo for garages', clicks: 0, impressions: 10, position: 25 },
  ];
  const tails = computeLongTails(queryRows, pageQueryRows);
  assert.deepEqual(tails.map(t => t.query), ['best budget gizmo for garages', 'orphan long tail query'], 'sorted by impressions');
  const [garages, orphan] = tails;
  assert.deepEqual([garages.best_page, garages.best_position, garages.words, garages.position, garages.impressions],
    [P('/gizmos'), 18, 5, 15, 45], 'the page with most impressions for the phrase is attached');
  assert.match(garages.recommendation, /Strengthen https:\/\/acme\.io\/gizmos for "best budget gizmo for garages"/);
  assert.deepEqual([orphan.best_page, orphan.best_position, orphan.words], [null, null, 4]);
  assert.match(orphan.recommendation, /Create a page for "orphan long tail query"/);

  assert.ok(computeLongTails(queryRows, pageQueryRows, { longTailMinWords: 2 }).some(t => t.query === 'gizmo pricing'),
    'the word floor is a threshold');
  assert.ok(computeLongTails(queryRows, pageQueryRows, { longTailMinPosition: 8 }).some(t => t.query === 'widget install guide pdf'),
    'the position floor is a threshold');
  assert.ok(computeLongTails(queryRows, []).some(t => t.query === 'how to install blue widgets'),
    'without a page-one row the phrase is a long tail');
  assert.equal(computeLongTails(queryRows, pageQueryRows, { cap: 1 }).length, 1);
  assert.deepEqual(computeLongTails([], pageQueryRows), []);
  assert.deepEqual(computeLongTails(null, null), []);
}

// ── computeTrends ───────────────────────────────────────────────────────────
{
  const current = [
    { page_url: P('/widgets'), clicks: 10, impressions: 400, position: 7 },
    { page_url: P('/gizmos'), clicks: 20, impressions: 300, position: 12 },
    { page_url: P('/tiny'), clicks: 1, impressions: 20, position: 30 },
    { page_url: P('/'), clicks: 95, impressions: 200, position: 1.3 },
    { page_url: P('/new'), clicks: 30, impressions: 400, position: 12 },
  ];
  const previous = [
    { page_url: P('/widgets'), clicks: 20, impressions: 500, position: 4 },
    { page_url: P('/gizmos'), clicks: 10, impressions: 250, position: 13 },
    { page_url: P('/tiny'), clicks: 3, impressions: 30, position: 28 },
    { page_url: P('/'), clicks: 100, impressions: 210, position: 1.2 },
    { page_url: P('/gone'), clicks: 15, impressions: 100, position: 9 },
  ];
  const { decays, growth } = computeTrends(current, previous);
  assert.deepEqual(decays.map(d => [d.page_url, d.previous_clicks, d.clicks, d.delta_pct]), [
    [P('/gone'), 15, 0, -100],   // vanished: the larger absolute change sorts first
    [P('/widgets'), 20, 10, -50],
  ], 'a 50% drop from 20 clicks is a decay; a drop from 3 is not');
  assert.deepEqual(growth.map(g => [g.page_url, g.previous_clicks, g.clicks, g.delta_pct]), [[P('/gizmos'), 10, 20, 100]],
    'growth from a real floor only: a page appearing from nothing is not growth');
  const widgets = decays[1];
  assert.deepEqual([widgets.impressions, widgets.previous_impressions, widgets.position, widgets.previous_position], [400, 500, 7, 4]);
  assert.match(widgets.recommendation, /Recover the ranking of https:\/\/acme\.io\/widgets/, 'a slipped position names the ranking as the lever');
  assert.match(decays[0].recommendation, /still live and indexed/, 'a vanished page is asked about first');
  assert.match(growth[0].recommendation, /Build on https:\/\/acme\.io\/gizmos/);

  const held = computeTrends([{ page_url: P('/s'), clicks: 5, impressions: 500, position: 5 }],
    [{ page_url: P('/s'), clicks: 20, impressions: 500, position: 5 }]).decays[0];
  assert.match(held.recommendation, /Rewrite the snippet/, 'clicks down with impressions and position held is a snippet problem');
  const demand = computeTrends([{ page_url: P('/d'), clicks: 5, impressions: 100, position: 5 }],
    [{ page_url: P('/d'), clicks: 20, impressions: 500, position: 5 }]).decays[0];
  assert.match(demand.recommendation, /Check demand/, 'impressions falling with the position held is a demand change');

  // The threshold is applied before rounding: a drop that prints as -40.0%
  // but is -39.95% is not a 40% decay, and a rise that prints as 40.0% but
  // is 39.95% is not 40% growth. Exactly 40% is both.
  const one = (prevClicks, curClicks) => computeTrends(
    [{ page_url: P('/a'), clicks: curClicks, impressions: 1, position: 5 }],
    [{ page_url: P('/a'), clicks: prevClicks, impressions: 1, position: 5 }]);
  assert.deepEqual(one(2503, 1503), { decays: [], growth: [] }, '-39.95% is under the decay floor even though it rounds to -40');
  assert.deepEqual(one(2500, 1500).decays.map(d => d.delta_pct), [-40], 'exactly -40% is a decay');
  assert.deepEqual(one(2500, 1501).decays, [], '-39.96% is not');
  assert.deepEqual(one(2503, 3503), { decays: [], growth: [] }, '+39.95% is under the growth floor even though it rounds to 40');
  assert.deepEqual(one(2500, 3500).growth.map(g => g.delta_pct), [40], 'exactly +40% is growth');
  assert.equal(one(3, 1).decays.length + one(3, 1).growth.length, 0, 'under the click floor nothing is a trend');
  assert.equal(one(30, 17).decays[0].delta_pct, -43.3, 'delta_pct is rounded to a tenth for display');

  assert.equal(computeTrends(current, previous, { minTrendClicks: 2 }).decays.some(d => d.page_url === P('/tiny')), true,
    'the click floor is a threshold');
  assert.equal(computeTrends(current, previous, { decayPct: 60 }).decays.length, 1, 'the drop threshold is a threshold');
  assert.deepEqual(computeTrends([], []), { decays: [], growth: [] });
  assert.deepEqual(computeTrends(null, undefined), { decays: [], growth: [] });
}

// ── getWindowRows with endDate ──────────────────────────────────────────────
{
  const db = seeded();
  const current = getWindowRows(db, 'fx', 'page', { windowDays: 28 });
  assert.deepEqual(current.window, CUR, 'the default window ends on the latest fetched day');
  assert.equal(current.rows.find(r => r.page_url === P('/widgets')).clicks, 16);

  const earlier = getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-26' });
  assert.deepEqual(earlier.window, PREV, 'endDate moves the window back');
  assert.equal(earlier.coverage, 'complete');
  const w = earlier.rows.find(r => r.page_url === P('/widgets'));
  assert.deepEqual([w.clicks, w.impressions, w.position], [40, 500, 4], 'the earlier window sums its own days only');
  assert.equal(earlier.rows.some(r => r.page_url === P('/gadgets') && r.clicks === 30), false, 'current rows stay out');

  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-09-30' }).window.end, CUR.end,
    'an end past the latest fetched day is pulled back to it');
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: 'not a date' }).window.end, CUR.end,
    'a malformed endDate is ignored');
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-01-15' }), null,
    'a window wholly before the fetched days is nothing');
  const clipped = getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-05' });
  assert.deepEqual([clipped.window.start, clipped.window.end, clipped.window.days], ['2026-07-30', '2026-08-05', 7],
    'the clamp to fetched days applies to an earlier window too');

  const pq = getWindowRows(db, 'fx', 'page_query', { windowDays: 28 });
  assert.equal(pq.rows.some(r => r.query === 'old query'), false, 'a previous-window row is not in the current one');
  assert.equal(pq.rows.find(r => r.query === 'blue widgets').impressions, 200, 'two days sum');
  const q = getWindowRows(db, 'fx', 'query', { windowDays: 28 });
  assert.ok(q.rows.every(r => r.page_url === null), 'the query grain groups on its NULL page_url');
  assert.ok(current.rows.every(r => r.query === null), 'the page grain groups on its NULL query');
  assert.equal(getWindowRows(db, 'fx', 'missing_grain', { windowDays: 28 }), null);
  assert.equal(getWindowRows(new DatabaseSync(':memory:'), 'fx', 'page', { windowDays: 28 }), null, 'no table, no rows');
}

// ── getWindowRows: an end in a gap between fetch walks is no window ──────────
// gsc-fetch's default lookback re-fetches from the last stored day, so its
// walks abut; a `--months` fetch after a pause does not, and leaves a gap of
// days nobody requested between two runs of records. The window ending on a
// day in that gap must not be answered from the run before it padded with
// zero rows: 16 of its 28 days would be days nobody asked for, and a trend
// comparing 28 fetched days against 12 would call flat traffic growth.
{
  const db = seeded();
  db.prepare(`DELETE FROM gsc_fetches WHERE grain = 'page'`).run();
  addFetch(db, 'page', '2026-06-01', '2026-08-10');
  addFetch(db, 'page', '2026-08-27', CUR.end);
  // Rows since June inside the fetched runs; none in the gap 08-11..08-26,
  // because nobody fetched those days.
  db.prepare(`DELETE FROM gsc_daily WHERE grain = 'page' AND date BETWEEN '2026-08-11' AND '2026-08-26'`).run();
  addDaily(db, 'page', '2026-06-15', P('/widgets'), null, 20, 250, 4);
  addDaily(db, 'page', '2026-07-20', P('/widgets'), null, 20, 250, 4);
  addDaily(db, 'page', '2026-07-20', P('/'), null, 100, 210, 1.2);

  assert.deepEqual(getWindowRows(db, 'fx', 'page', { windowDays: 28 }).window, CUR, 'the current window is untouched by the gap');
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-26' }), null,
    'a window ending in the gap does not exist');
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-11' }), null, 'the first day of the gap too');
  const before = getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-10' });
  assert.deepEqual([before.window.start, before.window.end, before.window.days, before.coverage], ['2026-07-14', '2026-08-10', 28, 'complete'],
    'the run before the gap answers for a window that ends inside it');
  assert.equal(before.rows.find(r => r.page_url === P('/widgets')).clicks, 40, 'and sums its own rows: 07-20 and 08-05');
  const after = getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-27' });
  assert.deepEqual([after.window.start, after.window.end, after.window.days], ['2026-08-27', '2026-08-27', 1],
    'the run after the gap starts the day it was fetched from');

  // The trend comparison sees no previous window and skips; /widgets (40
  // clicks in the earlier run, 16 now) and / are neither growth nor decay,
  // and nothing reaches the Ledger.
  const r = runDemand(db, 'fx', { trends: true });
  assert.equal(r.trends.skipped_reason, 'previous_window_short');
  assert.equal(r.trends.previous_window, null, 'there is no previous window to report');
  assert.deepEqual([r.trends.decays, r.trends.growth], [[], []]);
  assert.deepEqual(r.counts, { quick_wins: 3, long_tails: 2, decays: 0, growth: 0 });
  assert.equal(rowsOf(db, 'gsc_decay').length, 0, 'nothing is written across a gap');
}

// With fetch records present, a row a record never covered vouches for its
// own day and no more: the rows' whole span is the contract only when there
// are no records at all (a hand-loaded table).
{
  const db = seeded();
  db.prepare(`DELETE FROM gsc_fetches WHERE grain = 'page'`).run();
  addFetch(db, 'page', CUR.start, CUR.end);
  // seeded() left page rows on 08-05, 08-10 and 08-20 with no record behind them.
  assert.deepEqual(getWindowRows(db, 'fx', 'page', { windowDays: 28 }).window, CUR);
  const own = getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-20' });
  assert.deepEqual([own.window.start, own.window.end, own.window.days], ['2026-08-20', '2026-08-20', 1],
    'a row day outside every record is a one-day window');
  assert.equal(own.rows.find(r => r.page_url === P('/widgets')).clicks, 20);
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-19' }), null,
    'the day before it, with no row and no record, is nothing');
  assert.equal(getWindowRows(db, 'fx', 'page', { windowDays: 28, endDate: '2026-08-26' }), null,
    'the day before the current window is unfetched, so the previous window does not exist');
  assert.equal(runDemand(db, 'fx', { trends: true }).trends.skipped_reason, 'previous_window_short');
}

// ── runDemand: findings, the Ledger, and complete semantics ─────────────────
{
  const db = seeded();
  const r = runDemand(db, 'fx');
  assert.equal(r.skipped_reason, null);
  assert.equal(r.project, 'fx');
  assert.equal(r.property, PROPERTY);
  assert.deepEqual(r.window, CUR);
  assert.deepEqual(r.coverage, { page_query: 'complete', query: 'complete', page: 'complete' });
  assert.deepEqual(r.quick_wins.map(w => [w.query, w.kind, w.potential_clicks]), [
    ['gadget review', 'both', 9], ['blue widgets', 'ctr_gap', 6], ['gizmo pricing', 'page_two', 3],
  ]);
  assert.deepEqual(r.long_tails.map(t => [t.query, t.best_page]), [
    ['best budget gizmo for garages', P('/gizmos')], ['orphan long tail query', null],
  ]);
  assert.equal(r.trends, null, 'trends are off unless asked for');
  assert.deepEqual(r.counts, { quick_wins: 3, long_tails: 2, decays: 0, growth: 0 });
  assert.deepEqual(Object.keys(r).sort(),
    ['counts', 'coverage', 'long_tails', 'project', 'property', 'quick_wins', 'search_type', 'skipped_reason', 'trends', 'window']);

  const wins = rowsOf(db, 'gsc_quick_win');
  assert.equal(wins.length, 3, 'every quick win is in the Ledger');
  for (const row of wins) {
    assert.equal(row.status, 'active');
    assert.equal(row.source_kind, 'rule', 'a demand finding is a rule finding');
    assert.equal(row.rule_version, '1');
    assert.equal(row.confidence, 1);
    assert.equal(row.expires_at, null, 'a rule finding resolves; it does not expire');
    const data = JSON.parse(row.data);
    assert.ok(data.recommendation && data.query && data.page_url);
  }
  assert.equal(rowsOf(db, 'gsc_long_tail').length, 2);
  assert.equal(rowsOf(db, 'gsc_decay').length, 0, 'no decay is written without trends');

  const active = getActiveInsights(db, 'fx');
  assert.equal(active.gsc_quick_wins.length, 3, 'the registry group key surfaces them without a dashboard change');
  assert.equal(active.gsc_long_tails.length, 2);
  assert.deepEqual(active.gsc_decays, []);
  assert.equal(INSIGHT_TYPES.gsc_quick_win.title(active.gsc_quick_wins[0]), 'gadget review → https://acme.io/gadgets');

  // A second run is idempotent.
  runDemand(db, 'fx');
  assert.equal(rowsOf(db, 'gsc_quick_win').length, 3, 'a re-run dedups by fingerprint');
  assert.equal(activeOf(db, 'gsc_quick_win').length, 3);

  // The gadgets row climbs to position 3: outside the striking range, so the
  // win is gone, and a complete run resolves it rather than leaving it active.
  db.prepare(`UPDATE gsc_daily SET position = 3, clicks = 30 WHERE query = 'gadget review'`).run();
  const again = runDemand(db, 'fx');
  assert.deepEqual(again.quick_wins.map(w => w.query), ['blue widgets', 'gizmo pricing']);
  const gadgets = rowsOf(db, 'gsc_quick_win').find(row => JSON.parse(row.data).query === 'gadget review');
  assert.equal(gadgets.status, 'resolved', 'a quick win no longer detected is resolved');
  assert.equal(activeOf(db, 'gsc_quick_win').length, 2, 'the others stay active');
  assert.equal(activeOf(db, 'gsc_long_tail').length, 2, 'the long tails are untouched');

  // And it comes back if the data does.
  db.prepare(`UPDATE gsc_daily SET position = 12, clicks = 0 WHERE query = 'gadget review'`).run();
  runDemand(db, 'fx');
  assert.equal(rowsOf(db, 'gsc_quick_win').find(row => JSON.parse(row.data).query === 'gadget review').status, 'active');
  assert.equal(rowsOf(db, 'gsc_quick_win').length, 3, 'the same row, not a second one');
}

// ── runDemand: trends are the paid part and the caller gates them ───────────
{
  const db = seeded();
  const r = runDemand(db, 'fx', { trends: true });
  assert.ok(r.trends, 'asked for, so present');
  assert.deepEqual(r.trends.previous_window, PREV);
  assert.equal(r.trends.skipped_reason, null);
  assert.deepEqual(r.trends.decays.map(d => [d.page_url, d.previous_clicks, d.clicks, d.delta_pct]), [[P('/widgets'), 40, 16, -60]]);
  assert.deepEqual(r.trends.growth.map(g => [g.page_url, g.previous_clicks, g.clicks, g.delta_pct]), [[P('/gizmos'), 10, 20, 100]]);
  assert.deepEqual([r.trends.decays[0].window, r.trends.decays[0].previous_window], ['2026-08-27..2026-09-23', '2026-07-30..2026-08-26'],
    'each trend names both windows');
  assert.deepEqual(r.counts, { quick_wins: 3, long_tails: 2, decays: 1, growth: 1 });

  const decays = rowsOf(db, 'gsc_decay');
  assert.equal(decays.length, 1, 'the decay reaches the Ledger; growth is reported, not filed');
  assert.equal(decays[0].source_kind, 'rule');
  assert.equal(decays[0].status, 'active');
  const data = JSON.parse(decays[0].data);
  assert.deepEqual([data.page_url, data.previous_clicks, data.clicks, data.previous_position, data.position],
    [P('/widgets'), 40, 16, 4, 7]);
  assert.match(data.recommendation, /Recover the ranking/);
  assert.equal(INSIGHT_TYPES.gsc_decay.title(data), P('/widgets'));
  assert.equal(getActiveInsights(db, 'fx').gsc_decays.length, 1);

  // A free run afterwards must not touch the paid finding.
  runDemand(db, 'fx');
  assert.equal(activeOf(db, 'gsc_decay').length, 1, 'a run without trends leaves gsc_decay alone');

  // Recovery resolves it.
  db.prepare(`UPDATE gsc_daily SET clicks = 40 WHERE grain = 'page' AND page_url = ? AND date >= ?`).run(P('/widgets'), CUR.start);
  const recovered = runDemand(db, 'fx', { trends: true });
  assert.deepEqual(recovered.trends.decays, []);
  assert.equal(rowsOf(db, 'gsc_decay')[0].status, 'resolved', 'a decay that recovered is resolved');
}

// ── runDemand: URL variants are as many findings in the Ledger as in counts ──
// The API's page dimension is Google's canonical, so /a, /a/ and /a?ref=x are
// three pages with their own impressions. Fingerprinting on a normalised key
// wrote them into ONE Ledger row — whichever sorted last, the weakest — while
// counts.quick_wins said three.
{
  const db = freshDb();
  for (const grain of ['page_query', 'page']) addFetch(db, grain, PREV.start, CUR.end);
  const variants = ['https://acme.io/a', 'https://acme.io/a/', 'http://acme.io/a?ref=x'];
  const imps = [100, 300, 200];
  variants.forEach((url, i) => {
    addDaily(db, 'page_query', CUR.end, url, 'q one', 0, imps[i], 12);
    addDaily(db, 'page', CUR.end, url, null, 5, imps[i], 12);
    addDaily(db, 'page', '2026-08-10', url, null, 20, imps[i], 12);
  });
  const r = runDemand(db, 'fx', { trends: true });
  assert.equal(r.counts.quick_wins, 3);
  assert.deepEqual(r.quick_wins.map(w => [w.page_url, w.impressions]),
    [['https://acme.io/a/', 300], ['http://acme.io/a?ref=x', 200], ['https://acme.io/a', 100]]);
  const wins = rowsOf(db, 'gsc_quick_win');
  assert.equal(wins.length, r.counts.quick_wins, 'the Ledger holds every variant');
  assert.deepEqual(wins.map(row => JSON.parse(row.data).page_url).sort(), [...variants].sort());
  for (const row of wins) assert.ok(row.fingerprint.startsWith(JSON.parse(row.data).page_url), 'the fingerprint carries the URL as reported');
  assert.equal(r.counts.decays, 3);
  assert.equal(rowsOf(db, 'gsc_decay').length, 3, 'decays too');
  runDemand(db, 'fx', { trends: true });
  assert.equal(rowsOf(db, 'gsc_quick_win').length, 3, 'and a re-run still dedups');
  assert.equal(rowsOf(db, 'gsc_decay').length, 3);
}

// ── runDemand: a short previous window skips the comparison ─────────────────
{
  const db = seeded();
  // History reaches back only to 2026-08-10: the previous window would be 17 days.
  db.prepare(`DELETE FROM gsc_fetches WHERE grain = 'page'`).run();
  addFetch(db, 'page', '2026-08-10', CUR.end);
  db.prepare(`DELETE FROM gsc_daily WHERE grain = 'page' AND date < '2026-08-10'`).run();
  const r = runDemand(db, 'fx', { trends: true });
  assert.equal(r.trends.skipped_reason, 'previous_window_short');
  assert.deepEqual([r.trends.decays, r.trends.growth], [[], []], 'nothing is compared against a short window');
  assert.equal(r.trends.previous_window.days, 17, 'the short window is reported so the reader knows why');
  assert.equal(rowsOf(db, 'gsc_decay').length, 0, 'and nothing is written');
  assert.equal(r.counts.quick_wins, 3, 'the free findings are unaffected');
}

// ── runDemand: partial coverage writes but resolves nothing ─────────────────
{
  const db = seeded();
  db.prepare(`UPDATE gsc_fetches SET truncated = 1 WHERE grain = 'page_query'`).run();
  // A stale win from an earlier run that this capped walk may simply have dropped.
  db.prepare(`INSERT INTO insights (project,type,status,fingerprint,first_seen,last_seen,data,source_kind,rule_version,confidence)
              VALUES ('fx','gsc_quick_win','active','stale',1,1,'{"query":"stale"}','rule','1',1)`).run();
  const r = runDemand(db, 'fx');
  assert.equal(r.coverage.page_query, 'partial');
  assert.equal(r.quick_wins.length, 3, 'the rows present are still findings');
  assert.equal(activeOf(db, 'gsc_quick_win').length, 4, 'the stale win is not resolved on a partial read');
  assert.equal(activeOf(db, 'gsc_long_tail').length, 2, 'long tails depend on page_query coverage too, and are written');
}

// ── runDemand: skipLedger, no data, no tables ───────────────────────────────
{
  const db = seeded();
  const r = runDemand(db, 'fx', { skipLedger: true, trends: true });
  assert.equal(r.counts.quick_wins, 3);
  assert.equal(r.counts.decays, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM insights').get().c, 0, 'skipLedger computes only');

  const empty = freshDb();
  const none = runDemand(empty, 'fx', { trends: true });
  assert.equal(none.skipped_reason, 'no_gsc_data');
  assert.match(none.hint, /seo-intel gsc-fetch fx/, 'the hint names the fetch');
  assert.deepEqual([none.property, none.window, none.coverage, none.trends], [null, null, null, null]);
  assert.deepEqual([none.quick_wins, none.long_tails], [[], []]);
  assert.deepEqual(none.counts, { quick_wins: 0, long_tails: 0, decays: 0, growth: 0 });
  assert.equal(empty.prepare('SELECT COUNT(*) c FROM insights').get().c, 0, 'nothing is written without rows');

  const bare = runDemand(new DatabaseSync(':memory:'), 'fx', { trends: true });
  assert.equal(bare.skipped_reason, 'no_gsc_data', 'a database without gsc_daily is "nothing fetched", not an error');

  // Only the query grain fetched: quick wins need page_query, long tails need
  // both, so neither is written and neither is falsely resolved.
  const onlyQuery = freshDb();
  addFetch(onlyQuery, 'query', PREV.start, CUR.end);
  addDaily(onlyQuery, 'query', '2026-09-10', null, 'orphan long tail query', 0, 25, 30);
  onlyQuery.prepare(`INSERT INTO insights (project,type,status,fingerprint,first_seen,last_seen,data,source_kind,rule_version,confidence)
                     VALUES ('fx','gsc_quick_win','active','old',1,1,'{}','rule','1',1)`).run();
  const partial = runDemand(onlyQuery, 'fx');
  assert.equal(partial.skipped_reason, null);
  assert.deepEqual(partial.coverage, { page_query: null, query: 'complete', page: null });
  assert.deepEqual([partial.quick_wins, partial.long_tails], [[], []]);
  assert.equal(activeOf(onlyQuery, 'gsc_quick_win').length, 1, 'no page_query grain, no resolution of quick wins');
  assert.equal(rowsOf(onlyQuery, 'gsc_long_tail').length, 0);
}

// ── runDemand: thresholds pass through ──────────────────────────────────────
{
  const db = seeded();
  const r = runDemand(db, 'fx', { skipLedger: true, minImpressions: 20, cap: 1, windowDays: 7 });
  assert.equal(r.window.days, 7, 'windowDays is honoured');
  assert.deepEqual([r.window.start, r.window.end], ['2026-09-17', '2026-09-23']);
  assert.equal(r.quick_wins.length, 0, 'the seeded rows are dated before a 7-day window');
  const wide = runDemand(db, 'fx', { skipLedger: true, minImpressions: 20, cap: 1 });
  assert.equal(wide.quick_wins.length, 1, 'cap is honoured');
}

console.log('demand: all tests passed');
