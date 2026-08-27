/**
 * Page Contract — decision branches and the guarantees the contract makes.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deriveBrandTerms, isBrandedQuery, registrableName } from '../lib/brand.js';
import { runPageContract, pickFreshestRange } from '../analyses/page-contract/index.js';
import { normalizeUrlKey } from '../lib/gsc-import.js';

// ── Brand derivation ────────────────────────────────────────────────────────
assert.equal(registrableName('docs.example.io'), 'example');
assert.equal(registrableName('www.example.co.uk'), 'example');
assert.equal(pickFreshestRange(['Last 12 months', 'Last 28 days', 'Last 3 months']), 'Last 28 days');
assert.equal(pickFreshestRange([]), null);

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT, word_count INTEGER, is_indexable INTEGER);
    CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, name TEXT, raw_json TEXT);
    CREATE TABLE gsc_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, page_url TEXT, query TEXT,
      clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, date_range TEXT, source TEXT, imported_at INTEGER,
      UNIQUE(project, page_url, query, date_range));`);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'fx', 'target');
  db.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?,?)').run(1, 1, 'https://acme.io/widgets', 'Widgets', 'pricing from $9', 400, 1);
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Organization', 'Acme', JSON.stringify({ '@type': 'Organization', name: 'Acme' }));
  // A generic schema name that must NOT become a brand term.
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Product', 'Solana Swap Aggregator',
    JSON.stringify({ '@type': 'Product', name: 'Solana Swap Aggregator' }));
  return db;
}
const addQ = (db, page, query, clicks, impressions, position) =>
  db.prepare(`INSERT INTO gsc_queries (project,page_url,query,clicks,impressions,ctr,position,date_range,source,imported_at)
              VALUES ('fx',?,?,?,?,0,?,'Last 28 days','fx',1)`).run(page, query, clicks, impressions, position);

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

console.log('page-contract fixtures: PASS');
