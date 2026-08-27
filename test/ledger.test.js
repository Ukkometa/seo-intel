/**
 * Intelligence Ledger — registry, writer, and schema-specificity fixtures.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { INSIGHT_TYPES, INSIGHT_TYPE_KEYS, FREE_INSIGHT_TYPES, PROBLEM_INSIGHT_TYPES, insightMeta } from '../lib/insight-types.js';
import { upsertInsights, getActiveInsights } from '../db/db.js';
import { runSchemaAudit } from '../analyses/schema-audit/index.js';

// ── Registry integrity ──────────────────────────────────────────────────────
for (const key of INSIGHT_TYPE_KEYS) {
  const m = INSIGHT_TYPES[key];
  assert.equal(m.key, key, `${key}: key matches its map entry`);
  for (const fn of ['title', 'detail', 'fix', 'url']) {
    assert.equal(typeof m[fn], 'function', `${key}.${fn} is an accessor`);
    assert.doesNotThrow(() => m[fn]({}), `${key}.${fn} tolerates an empty blob`);
    assert.doesNotThrow(() => m[fn](null), `${key}.${fn} tolerates null`);
  }
}
const groupKeys = INSIGHT_TYPE_KEYS.map(k => INSIGHT_TYPES[k].groupKey);
assert.equal(new Set(groupKeys).size, groupKeys.length, 'group keys are unique');
assert.equal(insightMeta('never_registered').label, 'never_registered', 'unknown types get a fallback');
assert.ok(!PROBLEM_INSIGHT_TYPES.includes('citability_gap'), 'citability has its own collector, so it is not double-reported');
assert.ok(FREE_INSIGHT_TYPES.includes('schema_specificity'));

// The dashboard reads these keys directly; renaming one silently empties a card.
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, source_analysis_id INTEGER,
  data TEXT NOT NULL, UNIQUE(project, type, fingerprint));`);
const shape = getActiveInsights(db, 'fixture');
for (const k of ['keyword_gaps', 'long_tails', 'quick_wins', 'new_pages', 'content_gaps',
                 'technical_gaps', 'positioning', 'keyword_inventor', 'site_watch', 'generated_at']) {
  assert.ok(k in shape, `legacy key ${k} still returned`);
}

// ── Writer semantics ────────────────────────────────────────────────────────
const items = [{ fingerprint: 'a', data: { url: 'https://x.io/a' } }, { fingerprint: 'b', data: { url: 'https://x.io/b' } }];
assert.equal(upsertInsights(db, 'fixture', 'entity_gap', items), 2);
upsertInsights(db, 'fixture', 'entity_gap', items);
assert.equal(db.prepare('SELECT COUNT(*) c FROM insights').get().c, 2, 're-running an audit dedups by fingerprint');

db.prepare("UPDATE insights SET status = 'dismissed' WHERE fingerprint = 'a'").run();
upsertInsights(db, 'fixture', 'entity_gap', items);
assert.equal(db.prepare("SELECT status FROM insights WHERE fingerprint = 'a'").get().status, 'dismissed',
  'a dismissed finding is not resurrected by the next run');
assert.equal(getActiveInsights(db, 'fixture').entity_gaps.length, 1);

assert.equal(upsertInsights(new DatabaseSync(':memory:'), 'p', 'entity_gap', items), 0,
  'a database without the insights table returns 0 rather than throwing');
assert.equal(upsertInsights(db, 'fixture', 'entity_gap', []), 0);

// A malformed blob must not take the whole dashboard down.
db.prepare(`INSERT INTO insights (project,type,status,fingerprint,first_seen,last_seen,data)
            VALUES ('fixture','technical_gap','active','bad',1,1,'{ not json')`).run();
assert.doesNotThrow(() => getActiveInsights(db, 'fixture'));
assert.equal(getActiveInsights(db, 'fixture').technical_gaps.length, 0, 'the bad row is skipped, not fatal');

// ── Schema specificity ──────────────────────────────────────────────────────
const sdb = new DatabaseSync(':memory:');
sdb.exec(`
  CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT);
  CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, raw_json TEXT);`);
sdb.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'example.com', 'fx', 'target');
let pid = 0;
const addPage = (url, schema, body = '') => {
  pid++;
  sdb.prepare('INSERT INTO pages VALUES (?,?,?,?,?)').run(pid, 1, url, 'T', body || '');
  sdb.prepare('INSERT INTO page_schemas VALUES (?,?,?)').run(pid, JSON.stringify(schema['@type']), JSON.stringify(schema));
};
addPage('https://api.example.com/', { '@type': 'Product', name: 'API' });
addPage('https://example.com/shop/mug', { '@type': 'Product', name: 'Mug', offers: { '@type': 'Offer', price: '12.00', priceCurrency: 'EUR' } }, 'Buy now, price 12.00 EUR');
addPage('https://example.com/free', { '@type': 'SoftwareApplication', name: 'Free', offers: { price: 0, priceCurrency: 'EUR' } });
addPage('https://example.com/nocur', { '@type': 'Product', name: 'X', offers: { price: '9' } });
// A genuine documentation page with no commercial signals: Product is wrong here.
addPage('https://docs.example.com/reference/widgets', { '@type': 'Product', name: 'Widgets API' }, 'Returns a widget object. See the schema below.');

const audit = runSchemaAudit(sdb, 'fx', { skipLedger: true });
const codes = audit.issues.map(i => `${i.code}@${new URL(i.url).hostname}${new URL(i.url).pathname}`);
assert.ok(!codes.some(c => c.startsWith('product_on_docs_page@api.example.com')),
  'an api.* host is not assumed to be documentation — commercial API landers legitimately use Product');
assert.ok(codes.includes('product_without_offers@api.example.com/'), 'Product with no offers is flagged');
assert.ok(!codes.some(c => c.includes('/shop/mug')), 'a properly priced Product on a shop URL is clean');
assert.ok(!codes.some(c => c.includes('/free')), 'price 0 is a valid price for a free tier');
assert.ok(codes.includes('offers_missing_currency@example.com/nocur'), 'price without priceCurrency is flagged');
assert.ok(codes.includes('product_on_docs_page@docs.example.com/reference/widgets'),
  'Product on a docs page with no pricing signals is flagged');
assert.equal(audit.status, 'fail');

console.log('ledger + schema-specificity fixtures: PASS');
