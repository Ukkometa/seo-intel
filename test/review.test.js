/**
 * Search Review — bucket routing, freshness gating, and the guarantees the
 * review makes to whoever acts on it.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runReview } from '../analyses/review/index.js';
import { getProblems, normalizeSeverity } from '../lib/problems.js';

const DAY = 86_400_000;

function fixture({ crawledAt = Date.now() } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT, word_count INTEGER,
      status_code INTEGER, is_indexable INTEGER DEFAULT 1, click_depth INTEGER DEFAULT 0, x_robots_tag TEXT,
      crawled_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE links (id INTEGER PRIMARY KEY, source_id INTEGER, target_url TEXT, anchor_text TEXT, is_internal INTEGER DEFAULT 0);
    CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, name TEXT, raw_json TEXT);
    CREATE TABLE sitemap_urls (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, sitemap_source TEXT, discovered_at INTEGER);
    CREATE TABLE problem_status (problem_id TEXT PRIMARY KEY, project TEXT, status TEXT, marked_at INTEGER, marked_by TEXT, note TEXT, expires_at INTEGER);
    CREATE TABLE insights (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      source_analysis_id INTEGER, data TEXT NOT NULL, source TEXT, UNIQUE(project, type, fingerprint));
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
  const page = (id, url, opts) => db.prepare(`INSERT INTO pages (id, domain_id, url, title, body_text, word_count, status_code, is_indexable, click_depth, crawled_at, first_seen_at)
    VALUES (?,1,?,?,?,?,?,?,?,?,?)`).run(id, url, opts.title || url, 'text', opts.words ?? 400, opts.status ?? 200, opts.indexable ?? 1, opts.depth ?? 1, crawledAt, crawledAt);
  page(1, 'https://acme.io/', { depth: 0, words: 500, title: 'Acme' });
  page(2, 'https://acme.io/orphan', { depth: 2 });                 // nothing links here
  page(3, 'https://acme.io/noschema', { words: 350 });            // linked, but no structured data
  page(4, 'https://acme.io/gone', { status: 404, words: 0 });     // broken
  page(5, 'https://acme.io/private', { indexable: 0 });           // deliberately noindex
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Organization', 'Acme', JSON.stringify({ '@type': 'Organization', name: 'Acme' }));
  // A Product block with no usable offer: invalid markup the page contract may fix regardless of demand.
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Product', 'Acme Widgets', JSON.stringify({ '@type': 'Product', name: 'Acme Widgets', description: 'Buy widgets from $9' }));
  for (const target of ['https://acme.io/noschema', 'https://acme.io/gone', 'https://acme.io/private']) {
    db.prepare('INSERT INTO links (source_id, target_url, is_internal) VALUES (1, ?, 1)').run(target);
  }
  for (const url of ['https://acme.io/', 'https://acme.io/noschema', 'https://acme.io/private']) {
    db.prepare('INSERT INTO sitemap_urls (domain_id, url, discovered_at) VALUES (1, ?, ?)').run(url, crawledAt);
  }
  // A backlink reclamation finding stores a page COUNT in `pages`, not a URL list.
  db.prepare(`INSERT INTO insights (project, type, fingerprint, first_seen, last_seen, data, source)
              VALUES ('fx', 'backlink_gap', 'reclaim::old.example', ?, ?, ?, 'backlink-audit')`)
    .run(crawledAt, crawledAt, JSON.stringify({ domain: 'old.example', pages: 12, message: 'old.example links to fx 12 time(s) under a name the site no longer uses.' }));
  return db;
}

// ── A problem's affected_urls is always an array, whatever the ledger stored ─
{
  const db = fixture();
  const problems = getProblems(db, 'fx', { includePaid: true });
  assert.ok(problems.some(p => p.id.includes('backlink_gap')), 'the reclamation finding surfaces as a problem');
  assert.ok(problems.every(p => Array.isArray(p.affected_urls)), 'affected_urls keeps its documented array shape');
}

// ── A schema-specificity finding is critical, and never breaks the sort ─────
// The registry used to declare it 'error', which has no rank: the comparator
// returned NaN and the order of the entire list became unstable.
{
  const db = fixture();
  const now = Date.now();
  db.prepare(`INSERT INTO insights (project, type, fingerprint, first_seen, last_seen, data, source)
              VALUES ('fx', 'schema_specificity', 'product_without_offers::https://acme.io', ?, ?, ?, 'schema-audit')`)
    .run(now, now, JSON.stringify({ url: 'https://acme.io/', code: 'product_without_offers', severity: 'error',
      schemaType: 'Product', message: 'Product markup carries no priced offers.', recommendation: 'Add offers with price and priceCurrency.' }));
  const problems = getProblems(db, 'fx', { includePaid: true });
  const schema = problems.find(p => p.id.includes('schema_specificity'));
  assert.ok(schema, 'the schema-specificity finding surfaces as a problem');
  assert.equal(schema.severity, 'critical', 'registry severity is on the public vocabulary');
  assert.equal(schema.tier, 'free', 'own-site schema findings are free');
  const RANK = { critical: 0, warn: 1, info: 2 };
  assert.ok(problems.length >= 3, 'fixture yields several severities to order');
  for (const p of problems) assert.ok(p.severity in RANK, `${p.id}: severity ${p.severity} is public vocabulary`);
  for (let i = 1; i < problems.length; i++) {
    assert.ok(RANK[problems[i - 1].severity] <= RANK[problems[i].severity],
      `problems are severity-sorted: ${problems[i - 1].severity} before ${problems[i].severity}`);
  }
  assert.equal(problems[0].severity, 'critical', 'a critical finding sorts first');
  // Rows and registries written by older versions still map onto the vocabulary.
  assert.equal(normalizeSeverity('error'), 'critical');
  assert.equal(normalizeSeverity('critical'), 'critical');
  assert.equal(normalizeSeverity('info'), 'info');
  assert.equal(normalizeSeverity('warning'), 'warn', 'an unknown severity is neither hidden nor promoted');
  assert.equal(normalizeSeverity(undefined), 'warn');
}

// ── Fresh crawl: buckets route by category and template; passes are reported ─
{
  const db = fixture();
  const r = runReview(db, 'fx', { includePaid: true });
  assert.equal(r.freshness.state, 'fresh');
  assert.equal(r.needs_input.length, 0, 'no evidence gaps without page contracts');
  const cats = (items) => new Set(items.map(i => i.category));
  assert.ok(cats(r.safe_now).has('links'), 'an orphan page is hygiene an agent may fix');
  assert.ok(cats(r.safe_now).has('schema'), 'missing structured data is hygiene');
  assert.ok(cats(r.safe_now).has('tech'), 'a 404 is hygiene');
  assert.ok(cats(r.opportunities).has('content'), 'backlink reclamation is a growth bet, never a task');
  assert.ok(!cats(r.needs_input).has('content'), 'growth bets never inflate the decision bucket');
  for (const it of [...r.safe_now, ...r.opportunities]) {
    assert.ok(Array.isArray(it.evidence), `${it.id}: evidence is a list`);
    assert.ok(typeof it.safe_action === 'string' && it.safe_action.length, `${it.id}: carries an action`);
  }
  const passes = r.working.map(w => w.id);
  assert.ok(passes.includes('sitemap'), 'declared sitemap URLs are a pass');
  assert.ok(passes.includes('noindex_intent'), 'a deliberate noindex is a pass, not a problem');
  assert.ok(passes.includes('server_rendered'), 'readable server-rendered pages are a pass');
  assert.equal(r.counts.total, r.safe_now.length + r.opportunities.length + r.needs_input.length, 'counts agree with the buckets');
}

// ── Page contracts feed the evidence half of needs_input ────────────────────
{
  const db = fixture();
  db.prepare(`INSERT INTO gsc_queries (project,page_url,query,clicks,impressions,ctr,position,date_range,source,imported_at)
              VALUES ('fx',NULL,'widgets',5,900,0,12,'Last 28 days','fx',1)`).run();   // property-wide only
  const r = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const evidence = r.needs_input.filter(i => i.category === 'evidence');
  assert.ok(evidence.length >= 4, 'every blocked recommendation becomes a decision item');
  for (const it of evidence) {
    assert.ok(it.blocked_by, `${it.id}: names the input that unblocks it`);
    assert.equal(it.decision, 'no_action_yet');
    assert.ok(it.id.startsWith('contract::'), 'contract items are distinguishable from problems');
  }
  assert.ok(r.safe_now.some(i => i.id.startsWith('contract::')), 'work the contract allows regardless of demand lands in safe_now');
}

// ── A stale crawl withholds every pass and warns on every item ──────────────
{
  const db = fixture({ crawledAt: Date.now() - 40 * DAY });
  const r = runReview(db, 'fx', { includePaid: true });
  assert.equal(r.freshness.state, 'stale');
  assert.equal(r.working.length, 0, 'no green ticks on stale data');
  assert.ok(r.safe_now.every(i => i.decision_basis.some(b => b.includes('days old'))), 'each item says to re-crawl first');
}

// ── Marks are honoured, limits cap every bucket, missing data is explicit ───
{
  const db = fixture();
  const orphan = runReview(db, 'fx', {}).safe_now.find(i => i.category === 'links');
  db.prepare(`INSERT INTO problem_status VALUES (?, 'fx', 'fixed', ?, 'cli', NULL, NULL)`).run(orphan.id, Date.now());
  assert.ok(!runReview(db, 'fx', {}).safe_now.some(i => i.id === orphan.id), 'a problem marked fixed leaves the review');

  const capped = runReview(db, 'fx', { includePaid: true, limit: 1 });
  for (const k of ['needs_input', 'safe_now', 'opportunities']) assert.ok(capped[k].length <= 1, `${k} respects the cap`);

  const empty = runReview(db, 'nothing-here', {});
  assert.equal(empty.freshness.state, 'missing');
  assert.equal(empty.working.length, 0);
  assert.equal(empty.counts.total, 0);
}

const addDaily = (db, date, page, query, clicks, impressions, position) =>
  db.prepare(`INSERT INTO gsc_daily (project,property,grain,search_type,date,page_url,query,clicks,impressions,ctr,position,fetched_at)
              VALUES ('fx','sc-domain:acme.io','page_query','web',?,?,?,?,?,0,?,1)`).run(date, page, query, clicks, impressions, position);
const addFetch = (db, start, end, truncated = false) =>
  db.prepare(`INSERT INTO gsc_fetches (project,property,grain,search_type,start_date,end_date,rows,requests,truncated,fetched_at)
              VALUES ('fx','sc-domain:acme.io','page_query','web',?,?,1,1,?,1)`).run(start, end, truncated ? 1 : 0);

// ── API coverage: a URL with no rows is reported as measured, not missing ────
// A page_query fetch covers every page the property reported, so the contract's
// silence on this URL is a Search Console fact, and the item must say so
// rather than ask for an export nobody needs. The fetch record vouches for
// the days that came back empty.
{
  const db = fixture();
  addDaily(db, '2026-09-23', 'https://acme.io/noschema', 'widgets', 0, 700, 30);
  addFetch(db, '2026-06-26', '2026-09-23');
  const r = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const evidence = r.needs_input.filter(i => i.category === 'evidence');
  assert.ok(evidence.length >= 4, 'measured absence still blocks every content bet');
  for (const it of evidence) {
    assert.equal(it.decision, 'no_action_yet');
    assert.equal(it.evidence[0].observed,
      'Search Console reports no impressions for this URL in the 2026-08-27..2026-09-23 window.');
    assert.ok(it.blocked_by.includes('gsc-fetch'), `${it.id}: a later fetch is the unblocking step`);
    assert.ok(!/windowDays/.test(it.blocked_by), `${it.id}: names no input the review's callers cannot pass`);
    assert.ok(!/export/i.test(it.blocked_by), `${it.id}: no export is requested under complete coverage`);
  }
}

// ── A capped walk is a gap, and the review says so instead of "no impressions"
// Reproduces the false measurement: one stored row, a truncated fetch record,
// and a URL that may simply have fallen below the row cap.
{
  const db = fixture();
  addDaily(db, '2026-09-23', 'https://acme.io/noschema', 'widgets', 900, 9000, 1);
  addFetch(db, '2026-09-01', '2026-09-23', true);
  const r = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const evidence = r.needs_input.filter(i => i.category === 'evidence');
  assert.ok(evidence.length >= 4, 'a gap blocks every content bet too');
  for (const it of evidence) {
    assert.equal(it.decision, 'no_action_yet');
    assert.ok(!/reports no impressions/.test(it.evidence[0].observed), `${it.id}: never repeats a zero the walk could not measure`);
    assert.ok(/row cap/.test(it.evidence[0].observed) && /not a measurement/.test(it.evidence[0].observed), `${it.id}: says why it is a gap`);
    assert.ok(it.evidence[0].observed.includes('2026-09-01..2026-09-23'), `${it.id}: names only the fetched days`);
    assert.ok(/Page filter/.test(it.blocked_by), `${it.id}: the page-filtered export is the reachable unblock`);
    assert.ok(!it.decision_basis.some(b => /measured, not missing/.test(b)));
  }
}

// ── The observed window is the fetched one, with the shortfall stated ────────
// After `gsc-fetch --days 7` the review must not say "in the 2026-08-27..
// 2026-09-23 window" about 21 days that were never fetched.
{
  const db = fixture();
  for (let d = 17; d <= 23; d++) addDaily(db, `2026-09-${d}`, 'https://acme.io/noschema', 'widgets', 0, 100, 30);
  addFetch(db, '2026-09-17', '2026-09-23');
  const r = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const evidence = r.needs_input.filter(i => i.category === 'evidence');
  assert.ok(evidence.length >= 4);
  for (const it of evidence) {
    assert.equal(it.evidence[0].observed,
      'Search Console reports no impressions for this URL in the 2026-09-17..2026-09-23 window (7 of 28 days fetched).');
  }
  // Page-level rows under a capped walk are labelled a floor in the review too.
  addFetch(db, '2026-09-17', '2026-09-23', true);
  for (let d = 17; d <= 23; d++) addDaily(db, `2026-09-${d}`, 'https://acme.io/', 'acme widgets', 1, 100, 8);
  const r2 = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const items = [...r2.needs_input, ...r2.safe_now].filter(i => i.id.startsWith('contract::') && i.evidence.some(e => e.source === 'gsc'));
  assert.ok(items.length, 'a thin page still has a blocked expand to carry the observation');
  for (const it of items) {
    assert.ok(/floor/.test(it.evidence[0].observed) && /row cap/.test(it.evidence[0].observed), `${it.id}: ${it.evidence[0].observed}`);
  }
}

// The CSV wording is unchanged when no API data exists.
{
  const db = fixture();
  const r = runReview(db, 'fx', { includePaid: false, urls: ['https://acme.io/'] });
  const evidence = r.needs_input.filter(i => i.category === 'evidence');
  assert.ok(evidence.length >= 4);
  for (const it of evidence) {
    assert.equal(it.evidence[0].observed, 'No page-filtered Search Console export covers this URL.');
  }
}

console.log('review fixtures: PASS');
