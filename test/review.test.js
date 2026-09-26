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
      UNIQUE(project, page_url, query, date_range));`);
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

console.log('review fixtures: PASS');
