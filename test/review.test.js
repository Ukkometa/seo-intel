/**
 * Search Review — bucket routing, freshness gating, and the guarantees the
 * review makes to whoever acts on it.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runReview, indexedByGoogle } from '../analyses/review/index.js';
import { getProblems, normalizeSeverity, coverageFamily, getInspectedPages, insightSource, RULE_SOURCE } from '../lib/problems.js';
import { insightMeta } from '../lib/insight-types.js';

const DAY = 86_400_000;

// `provenance: false` builds the insights table as it was before the six
// provenance columns, for the older-database path.
function fixture({ crawledAt = Date.now(), provenance = true } = {}) {
  const db = new DatabaseSync(':memory:');
  const provenanceColumns = provenance
    ? `source_kind TEXT, model TEXT, prompt_version TEXT, rule_version TEXT, confidence REAL, expires_at INTEGER,`
    : '';
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
      source_analysis_id INTEGER, data TEXT NOT NULL, source TEXT,
      ${provenanceColumns}
      UNIQUE(project, type, fingerprint));
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
    );
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
    CREATE INDEX IF NOT EXISTS idx_gsc_inspections_project ON gsc_inspections(project, inspected_at);`);
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

// ── Provenance: safe_now is rule-only ───────────────────────────────────────
// One insert per case; `prov` is the six provenance columns, all optional so a
// legacy row (every one NULL) is the same call with nothing passed.
const addInsight = (db, type, fingerprint, data, prov = {}, { status = 'active', source = 'cli', at = Date.now() } = {}) =>
  db.prepare(`INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, data, source,
                source_kind, model, prompt_version, rule_version, confidence, expires_at)
              VALUES ('fx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, status, fingerprint, at, at, JSON.stringify(data), source,
      prov.source_kind ?? null, prov.model ?? null, prov.prompt_version ?? null,
      prov.rule_version ?? null, prov.confidence ?? null, prov.expires_at ?? null);
const TECH_GAP = { gap: 'No hreflang on localized pages', url: 'https://acme.io/', recommendation: 'Add hreflang link elements for each locale.' };
const SCHEMA_GAP = { url: 'https://acme.io/', code: 'product_without_offers', severity: 'error', schemaType: 'Product',
  message: 'Product markup carries no priced offers.', recommendation: 'Add offers with price and priceCurrency.' };
const SOURCE_KINDS = new Set(['rule', 'model', 'agent']);

// A model's technical_gap has an autonomous category (tech) and a fix template,
// the two conditions that used to put it in safe_now. It now waits for a
// person, and the item says which model to check against.
{
  const db = fixture();
  addInsight(db, 'technical_gap', 'hreflang::acme.io', TECH_GAP, { source_kind: 'model', model: 'claude-fable-5-1', prompt_version: '3', confidence: 0.7 });
  const problem = getProblems(db, 'fx', { includePaid: true }).find(p => p.id.includes('technical_gap'));
  assert.ok(problem, 'the model finding surfaces as a problem');
  assert.equal(problem.category, 'tech', 'in an autonomous category');
  assert.ok(problem.fix_template, 'with a fix template');
  assert.deepEqual(problem.source, { kind: 'model', model: 'claude-fable-5-1', prompt_version: '3', rule_version: null, confidence: 0.7 },
    'the row\'s provenance is copied as stored; a model finding claims no rule version');
  const r = runReview(db, 'fx', { includePaid: true });
  assert.ok(!r.safe_now.some(i => i.id === problem.id), 'a model finding never reaches safe_now');
  const item = r.needs_input.find(i => i.id === problem.id);
  assert.ok(item, 'it waits for a person instead');
  assert.ok(item.decision_basis.includes('Model-sourced finding (claude-fable-5-1): verify before acting.'), item.decision_basis.join(' | '));
  assert.deepEqual(item.source, problem.source, 'the review item carries the provenance through');
  assert.equal(r.counts.total, r.safe_now.length + r.opportunities.length + r.needs_input.length, 'counts still agree with the buckets');
}

// An agent finding with no recorded model is named by its kind.
{
  const db = fixture();
  addInsight(db, 'technical_gap', 'agent::acme.io', TECH_GAP, { source_kind: 'agent' }, { source: 'agent-harness' });
  const r = runReview(db, 'fx', { includePaid: true });
  const item = r.needs_input.find(i => i.id.includes('technical_gap'));
  assert.ok(item, 'an agent finding waits for a person');
  assert.ok(item.decision_basis.includes('Model-sourced finding (agent): verify before acting.'));
  assert.deepEqual(item.source, { kind: 'agent', model: null, prompt_version: null, rule_version: null, confidence: null },
    'an agent with no recorded confidence is null, never 1');
  assert.ok(!r.safe_now.some(i => i.id === item.id));
}

// A detector's finding in the ledger is still hygiene an agent may fix.
{
  const db = fixture();
  addInsight(db, 'schema_specificity', 'product_without_offers::https://acme.io', SCHEMA_GAP, { source_kind: 'rule', rule_version: '1', confidence: 1 }, { source: 'schema-audit' });
  const r = runReview(db, 'fx', { includePaid: true });
  const item = r.safe_now.find(i => i.id.includes('schema_specificity'));
  assert.ok(item, 'a rule-sourced ledger finding lands in safe_now');
  assert.deepEqual(item.source, { kind: 'rule', model: null, prompt_version: null, rule_version: '1', confidence: 1 });
  assert.ok(!item.decision_basis.some(b => /Model-sourced/.test(b)), 'no model note on a rule finding');
  assert.ok(!r.needs_input.some(i => i.id === item.id));
}

// Every problem carries a source, whatever collector produced it; the crawl
// collectors all write the one RULE_SOURCE.
{
  const db = fixture();
  addInsight(db, 'technical_gap', 'hreflang::acme.io', TECH_GAP, { source_kind: 'model', model: 'm' });
  const problems = getProblems(db, 'fx', { includePaid: true });
  assert.ok(problems.length >= 4, 'crawl and ledger problems both present');
  for (const p of problems) {
    assert.ok(p.source && typeof p.source === 'object', `${p.id}: has a source object`);
    assert.ok(SOURCE_KINDS.has(p.source.kind), `${p.id}: kind ${p.source.kind} is rule | model | agent`);
    assert.deepEqual(Object.keys(p.source).sort(), ['confidence', 'kind', 'model', 'prompt_version', 'rule_version'], `${p.id}: full source shape`);
  }
  for (const p of problems.filter(p => ['tech', 'links', 'schema'].includes(p.category) && !p.id.includes('technical_gap'))) {
    assert.equal(p.source, RULE_SOURCE, `${p.id}: a crawl finding is the shared rule source`);
  }
  assert.deepEqual(RULE_SOURCE, { kind: 'rule', rule_version: '1', confidence: 1, model: null, prompt_version: null });
  assert.ok(Object.isFrozen(RULE_SOURCE), 'shared across every problem, so nobody may mutate it');
  const r = runReview(db, 'fx', { includePaid: true, urls: ['https://acme.io/'] });
  for (const it of [...r.needs_input, ...r.safe_now, ...r.opportunities]) {
    assert.ok(it.source && SOURCE_KINDS.has(it.source.kind), `${it.id}: every review item, contract items included, carries a source`);
  }
  for (const it of r.safe_now) assert.equal(it.source.kind, 'rule', `${it.id}: safe_now is rule-only`);
}

// Rows written before the columns existed have NULL provenance; the type
// registry says who found them. A technical_gap was always a model's and now
// waits for a person; an entity_gap was always a detector's.
{
  const db = fixture();
  addInsight(db, 'technical_gap', 'legacy::tech', TECH_GAP);
  addInsight(db, 'entity_gap', 'legacy::entity', { url: 'https://acme.io/', code: 'no_sameas', message: 'Organization has no sameAs.', recommendation: 'Add sameAs links.' }, {}, { source: 'entity-audit' });
  const problems = getProblems(db, 'fx', { includePaid: true });
  const tech = problems.find(p => p.id.includes('technical_gap'));
  const entity = problems.find(p => p.id.includes('entity_gap'));
  assert.deepEqual(tech.source, { kind: 'model', model: null, prompt_version: null, rule_version: null, confidence: null },
    'a legacy model finding: kind from the registry, nothing invented for the rest');
  assert.deepEqual(entity.source, { kind: 'rule', model: null, prompt_version: null, rule_version: '1', confidence: 1 },
    'a legacy rule finding: the registry\'s version and a rule\'s certainty');
  const r = runReview(db, 'fx', { includePaid: true });
  assert.ok(r.needs_input.some(i => i.id === tech.id), 'legacy technical_gap -> model -> needs_input');
  assert.ok(!r.safe_now.some(i => i.id === tech.id));
  assert.ok(r.needs_input.find(i => i.id === tech.id).decision_basis.includes('Model-sourced finding (model): verify before acting.'));
  assert.ok(r.safe_now.some(i => i.id === entity.id), 'legacy entity_gap -> rule -> safe_now');
  // The resolution itself, on the registry's own answers.
  assert.equal(insightSource({}, insightMeta('technical_gap')).kind, 'model');
  assert.equal(insightSource({}, insightMeta('entity_gap')).kind, 'rule');
  assert.deepEqual(insightSource({ source_kind: 'model', confidence: 0.4 }, insightMeta('entity_gap')),
    { kind: 'model', model: null, prompt_version: null, rule_version: null, confidence: 0.4 }, 'the row outranks the registry');
  assert.deepEqual(insightSource({}, { sourceKind: undefined, ruleVersion: undefined }),
    { kind: 'rule', model: null, prompt_version: null, rule_version: '1', confidence: 1 }, 'a registry without the fields falls back to rule / 1');
  assert.deepEqual(insightSource({ rule_version: '2' }, insightMeta('entity_gap')).rule_version, '2');
  assert.equal(insightSource(undefined, undefined).kind, 'rule');
}

// ── Measured demand: a quick win is a free opportunity, a decay is paid ──────
// analyses/demand writes rule insights over gsc_daily. gsc_quick_win is
// own-site and category keyword, so it reaches the review's opportunities
// without Solo and never its safe_now (a rewrite is a bet, not hygiene).
// gsc_decay is scope 'history' — the first scope that is neither own-site nor
// competitor — and must still read as paid: absent without includePaid, tier
// 'paid' with it.
{
  const db = fixture();
  const QUICK_WIN = { page_url: 'https://acme.io/noschema', query: 'acme widgets pricing', impressions: 700, clicks: 3, position: 6.2,
    ctr: 0.43, expected_ctr: 4, kind: 'ctr_gap', potential_clicks: 25,
    recommendation: 'Rewrite the title and meta description of https://acme.io/noschema to answer "acme widgets pricing" directly.' };
  const DECAY = { page_url: 'https://acme.io/', clicks: 40, previous_clicks: 100, delta_pct: -60, impressions: 900, previous_impressions: 1200,
    position: 9.1, previous_position: 5.4, window: '2026-08-27..2026-09-23', previous_window: '2026-07-30..2026-08-26',
    recommendation: 'Refresh https://acme.io/: clicks fell 60% against the previous window.' };
  const prov = { source_kind: 'rule', rule_version: '1', confidence: 1 };
  addInsight(db, 'gsc_quick_win', 'ctr_gap::acme widgets pricing::https://acme.io/noschema', QUICK_WIN, prov, { source: 'demand' });
  addInsight(db, 'gsc_decay', 'https://acme.io/', DECAY, prov, { source: 'demand' });

  assert.equal(insightMeta('gsc_quick_win').scope, 'own-site', 'the registry declares a quick win own-site');
  assert.equal(insightMeta('gsc_decay').scope, 'history', 'and a decay history');

  const free = getProblems(db, 'fx', {});
  const qw = free.find(p => p.id.includes('gsc_quick_win'));
  assert.ok(qw, 'a quick win surfaces without Solo');
  assert.equal(qw.tier, 'free');
  assert.equal(qw.category, 'keyword', 'category comes from the registry');
  assert.equal(qw.severity, 'info');
  assert.equal(qw.fix_difficulty, 2);
  assert.deepEqual(qw.source, { kind: 'rule', model: null, prompt_version: null, rule_version: '1', confidence: 1 }, 'a rule found it');
  assert.ok(qw.title.includes('acme widgets pricing') && qw.title.includes('https://acme.io/noschema'), `title names query and page: ${qw.title}`);
  assert.deepEqual(qw.affected_urls, ['https://acme.io/noschema']);
  assert.equal(qw.fix_template, QUICK_WIN.recommendation, 'the fix is the recommendation the rule wrote');
  assert.ok(!free.some(p => p.id.includes('gsc_decay')), 'a decay is paid: absent without includePaid');

  const paid = getProblems(db, 'fx', { includePaid: true });
  const decay = paid.find(p => p.id.includes('gsc_decay'));
  assert.ok(decay, 'with Solo the decay is listed');
  assert.equal(decay.tier, 'paid');
  assert.equal(decay.category, 'content');
  assert.equal(decay.severity, 'warn');
  assert.equal(decay.source.kind, 'rule');
  assert.deepEqual(decay.affected_urls, ['https://acme.io/']);
  assert.ok(paid.some(p => p.id === qw.id), 'the free quick win is still there');

  const r = runReview(db, 'fx', {});
  assert.ok(r.opportunities.some(i => i.id === qw.id), 'measured demand is a growth bet: opportunities');
  assert.ok(!r.safe_now.some(i => i.id === qw.id), 'never safe_now — a title rewrite is a judgment, rule-sourced or not');
  assert.ok(!r.needs_input.some(i => i.id === qw.id), 'and it does not inflate the decision bucket');
  assert.ok(![...r.opportunities, ...r.safe_now, ...r.needs_input].some(i => i.id.includes('gsc_decay')), 'the review without Solo shows no decay');
  const solo = runReview(db, 'fx', { includePaid: true });
  assert.ok(solo.opportunities.some(i => i.id === decay.id), 'with Solo the decay is an opportunity too');
  assert.equal(solo.counts.total, solo.safe_now.length + solo.opportunities.length + solo.needs_input.length);
}

// A model finding past its expiry is not a problem, even while its status
// still reads active: the sweep that flips it to 'expired' may not have run.
{
  const db = fixture();
  const now = Date.now();
  addInsight(db, 'technical_gap', 'expired::acme.io', TECH_GAP, { source_kind: 'model', model: 'm', expires_at: now - DAY });
  addInsight(db, 'technical_gap', 'live::acme.io', { ...TECH_GAP, gap: 'Live gap' }, { source_kind: 'model', model: 'm', expires_at: now + 30 * DAY });
  const problems = getProblems(db, 'fx', { includePaid: true }).filter(p => p.id.includes('technical_gap'));
  assert.equal(problems.length, 1, 'the expired finding is gone, the live one stays');
  assert.equal(problems[0].evidence.gap, 'Live gap');
  const r = runReview(db, 'fx', { includePaid: true });
  assert.equal(r.needs_input.filter(i => i.id.includes('technical_gap')).length, 1);
  assert.equal(r.counts.total, r.safe_now.length + r.opportunities.length + r.needs_input.length);
}

// An older database without the six columns still lists its insights; their
// provenance comes from the registry, as for a legacy row.
{
  const db = fixture({ provenance: false });
  db.prepare(`INSERT INTO insights (project, type, fingerprint, first_seen, last_seen, data, source)
              VALUES ('fx', 'technical_gap', 'old-table::tech', ?, ?, ?, 'cli')`).run(Date.now(), Date.now(), JSON.stringify(TECH_GAP));
  db.prepare(`INSERT INTO insights (project, type, fingerprint, first_seen, last_seen, data, source)
              VALUES ('fx', 'schema_specificity', 'old-table::schema', ?, ?, ?, 'schema-audit')`).run(Date.now(), Date.now(), JSON.stringify(SCHEMA_GAP));
  const problems = getProblems(db, 'fx', { includePaid: true });
  assert.ok(problems.some(p => p.id.includes('backlink_gap')), 'the fixture\'s own insight still surfaces');
  assert.equal(problems.find(p => p.id.includes('technical_gap')).source.kind, 'model');
  assert.deepEqual(problems.find(p => p.id.includes('schema_specificity')).source, { kind: 'rule', model: null, prompt_version: null, rule_version: '1', confidence: 1 });
  const r = runReview(db, 'fx', { includePaid: true });
  assert.ok(r.needs_input.some(i => i.id.includes('technical_gap')));
  assert.ok(r.safe_now.some(i => i.id.includes('schema_specificity')));
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

// ── URL Inspection: Google's verdicts become problems and one pass ───────────
// One stored inspection per (project, url); a fresh one replaces the old, as
// the table's upsert does. `extra` names the enum fields the fixture varies.
const inspect = (db, url, verdict, coverage, extra = {}) =>
  db.prepare(`INSERT INTO gsc_inspections (project, property, url, inspected_at, verdict, coverage_state, robots_txt_state,
                indexing_state, page_fetch_state, last_crawl_time, crawled_as, google_canonical, user_canonical,
                sitemaps, referring_urls, rich_results_verdict, raw)
              VALUES ('fx', 'sc-domain:acme.io', ?, ?, ?, ?, ?, ?, ?, ?, 'MOBILE', ?, ?, '[]', '[]', NULL, '{}')
              ON CONFLICT(project, url) DO UPDATE SET
                inspected_at = excluded.inspected_at, verdict = excluded.verdict, coverage_state = excluded.coverage_state,
                robots_txt_state = excluded.robots_txt_state, indexing_state = excluded.indexing_state,
                page_fetch_state = excluded.page_fetch_state, last_crawl_time = excluded.last_crawl_time,
                google_canonical = excluded.google_canonical, user_canonical = excluded.user_canonical`)
    .run(url, extra.inspectedAt ?? Date.now(), verdict, coverage,
      extra.robots ?? 'ALLOWED', extra.indexing ?? 'INDEXING_ALLOWED', extra.fetch ?? 'SUCCESSFUL',
      extra.lastCrawl ?? '2026-09-20T03:14:15Z', extra.googleCanonical ?? null, extra.userCanonical ?? null);

const notIndexed = (db) => getProblems(db, 'fx', {}).filter(p => p.id.startsWith('indexability::not-indexed::'));

// A FAIL on an indexable page is a problem; on a sitemap URL, a critical one.
// The fix follows the coverage family, not the verdict.
{
  const db = fixture();
  inspect(db, 'https://acme.io/noschema', 'FAIL', 'Crawled - currently not indexed');
  inspect(db, 'https://acme.io/orphan', 'FAIL', 'Server error (5xx)', { fetch: 'SERVER_ERROR' });
  const problems = notIndexed(db);
  assert.equal(problems.length, 2);
  const submitted = problems.find(p => p.affected_urls[0] === 'https://acme.io/noschema');
  assert.equal(submitted.severity, 'critical', 'submitted in the sitemap and refused: critical');
  assert.equal(submitted.category, 'indexability');
  assert.equal(submitted.tier, 'free');
  assert.ok(submitted.title.startsWith('Not indexed: acme.io/noschema — Crawled - currently not indexed'), submitted.title);
  assert.ok(/internal links/.test(submitted.fix_template) && /request indexing/.test(submitted.fix_template),
    'crawled-not-indexed is a content-quality fix: links and a request');
  assert.equal(submitted.fix_difficulty, 4);
  assert.deepEqual(submitted.evidence, {
    verdict: 'FAIL', coverage_state: 'Crawled - currently not indexed', indexing_state: 'INDEXING_ALLOWED',
    robots_txt_state: 'ALLOWED', page_fetch_state: 'SUCCESSFUL', last_crawl_time: '2026-09-20T03:14:15Z', in_sitemap: true,
  });
  assert.ok(submitted.description.includes('"Crawled - currently not indexed"') && submitted.description.includes('2026-09-20T03:14:15Z'),
    'the description quotes Google\'s state and last crawl');
  assert.ok(submitted.verification.includes('seo-intel gsc-inspect fx --url https://acme.io/noschema') && /inspect_urls/.test(submitted.verification));
  assert.equal(submitted.first_seen, submitted.last_seen);
  const unlisted = problems.find(p => p.affected_urls[0] === 'https://acme.io/orphan');
  assert.equal(unlisted.severity, 'warn', 'not in the sitemap: warn');
  assert.equal(unlisted.evidence.in_sitemap, false);
  assert.ok(/Search Console/.test(unlisted.fix_template), 'a state no family claims gets the generic template');
  // In the review these are Search Console evidence, and hygiene an agent may act on.
  const r = runReview(db, 'fx', {});
  const item = r.safe_now.find(i => i.id === submitted.id);
  assert.ok(item, 'a Google verdict with a fix template is hygiene');
  assert.equal(item.evidence[0].source, 'gsc');
  assert.ok(r.safe_now.filter(i => i.category === 'tech').every(i => i.evidence[0].source === 'crawl'), 'crawl findings keep their source');
}

// NEUTRAL where the site meant it, or where the crawl already says broken, is not a problem.
{
  const db = fixture();
  inspect(db, 'https://acme.io/private', 'NEUTRAL', "Excluded by 'noindex' tag", { indexing: 'BLOCKED_BY_META_TAG' });
  inspect(db, 'https://acme.io/gone', 'NEUTRAL', 'Not found (404)', { fetch: 'NOT_FOUND' });
  assert.equal(getProblems(db, 'fx', {}).filter(p => p.category === 'indexability').length, 0,
    'a noindex page excluded, or a 404 not indexed, is intent or an existing finding, not a new problem');
  assert.ok(runReview(db, 'fx', {}).working.some(w => w.id === 'noindex_intent'), 'the deliberate noindex is still a pass');
}

// Nor is a FAIL on those pages: Google saying "Submitted URL marked 'noindex'"
// about a page the crawl saw noindex on, or "Not found (404)" about a 404, is
// the crawl's own finding in Google's words. Reported as index status it read
// "a noindex reaches Google that the crawl did not see" — the crawl did — and
// listed the 404 a second time next to the tech finding.
{
  const db = fixture();
  inspect(db, 'https://acme.io/private', 'FAIL', "Submitted URL marked 'noindex'", { indexing: 'BLOCKED_BY_META_TAG' });
  inspect(db, 'https://acme.io/gone', 'FAIL', 'Not found (404)', { fetch: 'NOT_FOUND' });
  const problems = getProblems(db, 'fx', {});
  assert.equal(problems.filter(p => p.category === 'indexability').length, 0,
    'FAIL on a deliberate noindex or on a 404 restates the crawl, and is not an index-status problem');
  const gone = problems.filter(p => p.affected_urls[0] === 'https://acme.io/gone');
  assert.equal(gone.length, 1, 'the 404 is listed once');
  assert.equal(gone[0].category, 'tech', 'by the crawl');
  const r = runReview(db, 'fx', {});
  assert.ok(r.working.some(w => w.id === 'noindex_intent'), 'the deliberate noindex is still a pass');
  assert.ok(!r.safe_now.some(i => i.id.startsWith('indexability::')), 'nothing sends an agent to undo what the site chose');
}

// NEUTRAL on a page the crawl calls indexable is a problem, and the fix names what the crawl missed.
{
  const db = fixture();
  inspect(db, 'https://acme.io/noschema', 'NEUTRAL', "Excluded by 'noindex' tag", { indexing: 'BLOCKED_BY_HTTP_HEADER' });
  inspect(db, 'https://acme.io/orphan', 'NEUTRAL', 'Blocked by robots.txt',
    { robots: 'DISALLOWED', indexing: 'BLOCKED_BY_ROBOTS_TXT', fetch: 'BLOCKED_ROBOTS_TXT' });
  const problems = notIndexed(db);
  const noindex = problems.find(p => p.affected_urls[0] === 'https://acme.io/noschema');
  assert.ok(noindex, 'a noindex Google saw on a page the crawl calls indexable is a problem');
  assert.ok(['warn', 'critical'].includes(noindex.severity));
  assert.equal(noindex.severity, 'critical', 'the URL is in the sitemap');
  assert.ok(/noindex reaches Google that the crawl did not see/.test(noindex.fix_template) && /CDN/.test(noindex.fix_template) && /render time/.test(noindex.fix_template));
  assert.equal(noindex.fix_difficulty, 2);
  assert.equal(noindex.evidence.indexing_state, 'BLOCKED_BY_HTTP_HEADER');
  const robots = problems.find(p => p.affected_urls[0] === 'https://acme.io/orphan');
  assert.ok(/robots\.txt/.test(robots.fix_template) && /Allow the path/.test(robots.fix_template));
  assert.equal(robots.fix_difficulty, 2);
  assert.equal(robots.evidence.robots_txt_state, 'DISALLOWED');
}

// The family is read from Google's prose, backed by the enums where they are more explicit.
{
  const fam = (coverage_state, extra = {}) => coverageFamily({ url: 'https://acme.io/x', coverage_state, ...extra });
  assert.equal(fam('Crawled - currently not indexed'), 'crawled');
  assert.equal(fam('Discovered - currently not indexed'), 'discovered');
  assert.equal(fam('Duplicate without user-selected canonical'), 'duplicate');
  assert.equal(fam('Duplicate, Google chose different canonical than user'), 'duplicate');
  assert.equal(fam('Alternate page with proper canonical tag'), 'duplicate');
  assert.equal(fam("Excluded by 'noindex' tag"), 'noindex');
  assert.equal(fam('Crawled - currently not indexed', { indexing_state: 'BLOCKED_BY_HTTP_HEADER' }), 'noindex', 'a header block outranks the prose');
  assert.equal(fam('Blocked by robots.txt'), 'robots');
  assert.equal(fam('Some wording Google adds later', { robots_txt_state: 'DISALLOWED' }), 'robots');
  assert.equal(fam('Soft 404'), 'not_found');
  assert.equal(fam('Not found (404)'), 'not_found');
  assert.equal(fam('Page with redirect'), 'redirect');
  assert.equal(fam('URL is unknown to Google'), 'unknown');
  assert.equal(fam(null), 'unknown');
  assert.equal(fam('Crawled - currently not indexed', { google_canonical: 'https://acme.io/y' }), 'duplicate',
    'indexed under another URL is a canonical decision whatever the prose says');
  assert.equal(fam('Crawled - currently not indexed', { google_canonical: 'https://www.acme.io/x/' }), 'crawled',
    'Google\'s spelling of the same URL is not another canonical');
  assert.equal(fam('Crawled - currently not indexed', { url: 'https://acme.io/x?sort=price', google_canonical: 'https://acme.io/x' }), 'duplicate',
    'the bare path is another canonical for a query-string variant');
  assert.equal(fam('Crawled - currently not indexed', { url: 'https://acme.io/x?sort=price', google_canonical: 'https://www.acme.io/x/?sort=price' }), 'crawled',
    'the same variant in Google\'s spelling is not');
}

// PASS under a different canonical: indexed, but not here.
{
  const db = fixture();
  inspect(db, 'https://acme.io/noschema', 'PASS', 'Submitted and indexed',
    { googleCanonical: 'https://acme.io/', userCanonical: 'https://acme.io/noschema' });
  inspect(db, 'https://acme.io/orphan', 'PASS', 'Indexed, not submitted in sitemap', { googleCanonical: 'https://www.acme.io/orphan/' });
  inspect(db, 'https://acme.io/', 'PASS', 'Submitted and indexed', { googleCanonical: 'https://acme.io/' });
  // A sorted variant indexed under the bare path is the commonest mismatch of
  // all, and the join key alone cannot see it: it drops the query string.
  const crawledAt = db.prepare('SELECT MAX(crawled_at) AS t FROM pages').get().t;
  for (const [id, url] of [[6, 'https://acme.io/products?sort=price'], [7, 'https://acme.io/products']]) {
    db.prepare(`INSERT INTO pages (id, domain_id, url, title, body_text, word_count, status_code, is_indexable, click_depth, crawled_at, first_seen_at)
                VALUES (?, 1, ?, 'Products', 'text', 400, 200, 1, 1, ?, ?)`).run(id, url, crawledAt, crawledAt);
    inspect(db, url, 'PASS', 'Indexed, not submitted in sitemap', { googleCanonical: 'https://acme.io/products' });
  }
  const problems = getProblems(db, 'fx', {}).filter(p => p.category === 'indexability');
  assert.deepEqual(problems.map(p => p.affected_urls[0]).sort(), ['https://acme.io/noschema', 'https://acme.io/products?sort=price'],
    'only the URLs whose canonical is elsewhere; a spelling difference is not a mismatch, a query-string difference is');
  const variant = problems.find(p => p.affected_urls[0] === 'https://acme.io/products?sort=price');
  assert.ok(variant.id.startsWith('indexability::canonical-mismatch::'));
  assert.equal(variant.evidence.google_canonical, 'https://acme.io/products');
  const mismatch = problems.find(p => p.affected_urls[0] === 'https://acme.io/noschema');
  assert.ok(mismatch.id.startsWith('indexability::canonical-mismatch::'));
  assert.equal(mismatch.severity, 'warn');
  assert.equal(mismatch.fix_difficulty, 3);
  assert.equal(mismatch.affected_urls[0], 'https://acme.io/noschema');
  assert.equal(mismatch.title, 'Google chose a different canonical for acme.io/noschema');
  assert.ok(mismatch.description.includes('`https://acme.io/`'), 'names the canonical Google chose');
  assert.ok(/rel=canonical/.test(mismatch.fix_template) && /internal links/.test(mismatch.fix_template));
  assert.equal(mismatch.evidence.google_canonical, 'https://acme.io/');
  assert.equal(mismatch.evidence.user_canonical, 'https://acme.io/noschema');
  assert.equal(runReview(db, 'fx', {}).safe_now.find(i => i.id === mismatch.id)?.evidence[0].source, 'gsc');
}

// Inspections join to pages on the comparison key, so Google's spelling of a
// crawled URL still lands on the page; an inspected URL the crawl never reached does not.
{
  const db = fixture();
  inspect(db, 'https://www.acme.io/noschema/', 'FAIL', 'Crawled - currently not indexed');
  const rows = getInspectedPages(db, 'fx');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page.url, 'https://acme.io/noschema');
  assert.equal(rows[0].in_sitemap, true, 'the sitemap match survives the spelling too');
  assert.equal(notIndexed(db)[0].severity, 'critical');
  inspect(db, 'https://acme.io/never-crawled', 'FAIL', 'Not found (404)');
  assert.equal(getInspectedPages(db, 'fx').length, 1, 'no crawled page, no finding');
}

// The problem's id keys on the crawled page, so a newer inspection of the same
// page under another spelling keeps the id — and the mark somebody put on it.
{
  const db = fixture();
  inspect(db, 'https://acme.io/noschema', 'FAIL', 'Crawled - currently not indexed', { inspectedAt: Date.now() - DAY });
  const [first] = notIndexed(db);
  inspect(db, 'https://www.acme.io/noschema/', 'FAIL', 'Crawled - currently not indexed');
  const [second] = notIndexed(db);
  assert.equal(notIndexed(db).length, 1, 'two spellings, one page, one problem');
  assert.equal(second.affected_urls[0], 'https://www.acme.io/noschema/', 'the newer inspection supersedes');
  assert.equal(second.id, first.id, 'the id survives the spelling change');
  db.prepare(`INSERT INTO problem_status VALUES (?, 'fx', 'wont_fix', ?, 'cli', NULL, NULL)`).run(first.id, Date.now());
  assert.equal(notIndexed(db).length, 0, 'a mark on the old id still holds');
}

// Ten indexable pages inspected — the fixture's three plus seven more — with
// `passes` of them PASS. The noindex page and the 404 are inspected too and
// must stay out of the pass's denominator.
function inspectSite(db, { passes, inspectedAt = Date.now() }) {
  const crawledAt = db.prepare('SELECT MAX(crawled_at) AS t FROM pages').get().t;
  for (let i = 6; i <= 12; i++) {
    db.prepare(`INSERT INTO pages (id, domain_id, url, title, body_text, word_count, status_code, is_indexable, click_depth, crawled_at, first_seen_at)
                VALUES (?, 1, ?, ?, 'text', 400, 200, 1, 1, ?, ?)`).run(i, `https://acme.io/p${i}`, `P${i}`, crawledAt, crawledAt);
  }
  const indexable = ['https://acme.io/', 'https://acme.io/orphan', 'https://acme.io/noschema',
    ...Array.from({ length: 7 }, (_, i) => `https://acme.io/p${i + 6}`)];
  indexable.forEach((url, i) => inspect(db, url, i < passes ? 'PASS' : 'NEUTRAL',
    i < passes ? 'Submitted and indexed' : 'Crawled - currently not indexed', { inspectedAt }));
  inspect(db, 'https://acme.io/private', 'NEUTRAL', "Excluded by 'noindex' tag", { inspectedAt });
  inspect(db, 'https://acme.io/gone', 'FAIL', 'Not found (404)', { inspectedAt });
}

{
  const db = fixture();
  inspectSite(db, { passes: 9 });
  const r = runReview(db, 'fx', {});
  const w = r.working.find(x => x.id === 'indexed_by_google');
  assert.ok(w, '9 of 10 fresh indexable inspections PASS: a pass');
  assert.equal(w.title, 'Google has indexed your pages');
  assert.equal(w.observed, '9 of 10 indexable pages inspected within the last 30 days return PASS in URL Inspection (oldest counted inspection 0 days ago).');
  assert.deepEqual(Object.keys(r.freshness.inspections).sort(), ['age_days', 'count', 'newest_at']);
  assert.equal(r.freshness.inspections.count, 12);
  assert.equal(r.freshness.inspections.age_days, 0);
  const misses = r.safe_now.filter(i => i.id.startsWith('indexability::not-indexed::'));
  assert.deepEqual(misses.map(i => i.evidence[0].url), ['https://acme.io/p12'],
    'the pass does not hide the one indexable miss, and the 404 is not listed as a second one');
}
{
  const db = fixture();
  inspectSite(db, { passes: 8 });
  assert.ok(!runReview(db, 'fx', {}).working.some(x => x.id === 'indexed_by_google'), '80% is not a pass');
}
{
  const db = fixture();
  inspectSite(db, { passes: 10, inspectedAt: Date.now() - 40 * DAY });
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.state, 'fresh');
  assert.equal(r.freshness.inspections.age_days, 40);
  assert.ok(!r.working.some(x => x.id === 'indexed_by_google'), '40-day-old verdicts do not vouch for the pages');
  assert.ok(r.working.some(x => x.id === 'sitemap'), 'the crawl-based passes are unaffected');
}
// Freshness is judged per verdict, not by the newest row in the table. One
// inspection run today must not renew ten verdicts from six weeks ago —
// whether it inspected a URL the crawl never reached or re-asked about one
// page. The table-wide metadata still says "0 days", which is why the pass
// cannot be gated on it.
{
  const db = fixture();
  inspectSite(db, { passes: 10, inspectedAt: Date.now() - 45 * DAY });
  inspect(db, 'https://acme.io/never-crawled', 'FAIL', 'Not found (404)');
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.inspections.age_days, 0, 'the newest row is from today');
  assert.ok(!r.working.some(x => x.id === 'indexed_by_google'), 'ten stale passes and one fresh row for an uncrawled URL are no pass');
}
{
  const db = fixture();
  inspectSite(db, { passes: 10, inspectedAt: Date.now() - 45 * DAY });
  inspect(db, 'https://acme.io/', 'PASS', 'Submitted and indexed');
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.inspections.age_days, 0);
  assert.ok(!r.working.some(x => x.id === 'indexed_by_google'), 'one fresh re-inspection does not renew nine stale ones');
}
// Within the horizon, the sentence names the oldest verdict it rests on.
{
  const db = fixture();
  inspectSite(db, { passes: 10, inspectedAt: Date.now() - 20 * DAY });
  inspect(db, 'https://acme.io/', 'PASS', 'Submitted and indexed');
  const w = runReview(db, 'fx', {}).working.find(x => x.id === 'indexed_by_google');
  assert.ok(w, 'ten passes within 30 days');
  assert.equal(w.observed, '10 of 10 indexable pages inspected within the last 30 days return PASS in URL Inspection (oldest counted inspection 20 days ago).');
}
{
  const db = fixture();
  for (const url of ['https://acme.io/', 'https://acme.io/orphan', 'https://acme.io/noschema', 'https://acme.io/private', 'https://acme.io/gone']) {
    inspect(db, url, 'PASS', 'Submitted and indexed');
  }
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.inspections.count, 5);
  assert.ok(!r.working.some(x => x.id === 'indexed_by_google'), 'three indexable pages are too small a sample, whatever else was inspected');
}
{
  const db = fixture({ crawledAt: Date.now() - 40 * DAY });
  inspectSite(db, { passes: 10 });
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.state, 'stale');
  assert.equal(r.freshness.inspections.age_days, 0);
  assert.equal(r.working.length, 0, 'a stale crawl withholds every pass, Google\'s included');
}
// The thresholds, at their edges. Rows carry their own inspected_at, measured
// against the clock the caller passes.
{
  const now = Date.now();
  const row = (verdict, { indexable = 1, status = 200, age = 0 } = {}) =>
    ({ verdict, inspected_at: now - age * DAY, page: { is_indexable: indexable, status_code: status } });
  const passes = (n, age = 0) => Array.from({ length: n }, () => row('PASS', { age }));
  assert.ok(indexedByGoogle(passes(5), now), 'five suffice');
  assert.equal(indexedByGoogle(passes(4), now), null, 'four do not');
  assert.ok(indexedByGoogle([...passes(9), row('NEUTRAL')], now), 'exactly 90% passes');
  assert.equal(indexedByGoogle([...passes(9), row('NEUTRAL'), row('FAIL')], now), null, 'below 90% does not');
  assert.ok(indexedByGoogle([...passes(9), row('NEUTRAL'), row('FAIL', { status: 404 }), row('NEUTRAL', { indexable: 0 })], now),
    'a 404 and a noindex page stay out of the denominator');
  assert.equal(indexedByGoogle(passes(9, 30), now).oldest_age_days, 30, 'day 30 is still fresh');
  assert.equal(indexedByGoogle(passes(9, 31), now), null, 'day 31 is stale');
  const mixed = indexedByGoogle([...passes(5), ...passes(5, 45)], now);
  assert.deepEqual([mixed.passed, mixed.total, mixed.oldest_age_days], [5, 5, 0], 'stale rows leave the sample; the fresh ones carry it');
  assert.equal(indexedByGoogle([...passes(4), ...passes(6, 45)], now), null, 'stale rows do not fill the sample either');
  assert.ok(indexedByGoogle([...passes(9), row('NEUTRAL', { age: 45 })], now), 'a stale miss is out of the sample too; the problems list still names it');
  assert.equal(indexedByGoogle([...passes(4), { verdict: 'PASS', page: { is_indexable: 1, status_code: 200 } }], now), null,
    'a row without an inspected_at vouches for nothing');
  assert.equal(indexedByGoogle([], now), null, 'nothing inspected, nothing claimed');
  assert.equal(indexedByGoogle(null), null);
}
// No inspections, and an older database without the table, both read as "nothing inspected".
{
  assert.equal(runReview(fixture(), 'fx', {}).freshness.inspections, null);
  const db = fixture();
  db.exec('DROP TABLE gsc_inspections');
  const r = runReview(db, 'fx', {});
  assert.equal(r.freshness.inspections, null);
  assert.ok(!r.working.some(x => x.id === 'indexed_by_google'));
  assert.ok(r.working.some(x => x.id === 'sitemap'), 'the other passes still report');
  assert.equal(getInspectedPages(db, 'fx').length, 0);
  assert.equal(getProblems(db, 'fx', {}).filter(p => p.category === 'indexability').length, 0);
}

console.log('review fixtures: PASS');
