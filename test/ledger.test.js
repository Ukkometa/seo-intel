/**
 * Intelligence Ledger — registry, writer, provenance, and schema-specificity fixtures.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  INSIGHT_TYPES, INSIGHT_TYPE_KEYS, FREE_INSIGHT_TYPES, PROBLEM_INSIGHT_TYPES,
  MODEL_INSIGHT_TYPES, RULE_INSIGHT_TYPES, insightMeta,
} from '../lib/insight-types.js';
import {
  upsertInsights, getActiveInsights, upsertInsightsFromAnalysis, insertAgentInsight,
  migrateInsightProvenance, expireInsights, INSIGHT_STATUSES,
} from '../db/db.js';
import { runSchemaAudit } from '../analyses/schema-audit/index.js';

const DAY_MS = 86_400_000;

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

// ── Registry provenance ─────────────────────────────────────────────────────
// The eight LLM synthesis types are the model's; everything else is a rule.
// db/db.js classifies pre-provenance rows from this list, so it is asserted
// literally: a type quietly moving between the two would rewrite history.
assert.deepEqual([...MODEL_INSIGHT_TYPES].sort(), [
  'content_gap', 'keyword_gap', 'keyword_inventor', 'long_tail', 'new_page', 'positioning', 'quick_win', 'technical_gap',
], 'the model types are exactly the eight LLM synthesis types');
for (const key of MODEL_INSIGHT_TYPES) {
  assert.equal(INSIGHT_TYPES[key].sourceKind, 'model', `${key} is model-sourced`);
  assert.equal(INSIGHT_TYPES[key].ruleVersion, null, `${key} has no rule version`);
}
for (const key of FREE_INSIGHT_TYPES) {
  assert.equal(INSIGHT_TYPES[key].sourceKind, 'rule', `own-site type ${key} is a rule`);
  assert.equal(INSIGHT_TYPES[key].ruleVersion, '1', `own-site type ${key} carries a rule version`);
}
assert.equal(INSIGHT_TYPES.site_watch.sourceKind, 'rule', 'a snapshot diff is deterministic, paid tier or not');
assert.deepEqual([...MODEL_INSIGHT_TYPES, ...RULE_INSIGHT_TYPES].sort(), [...INSIGHT_TYPE_KEYS].sort(),
  'every type is exactly one of model or rule');
assert.equal(insightMeta('never_registered').sourceKind, 'rule', 'the fallback is a rule');
assert.equal(insightMeta('never_registered').ruleVersion, '1', 'the fallback carries rule version 1');
assert.deepEqual(INSIGHT_STATUSES, ['active', 'done', 'dismissed', 'in_progress', 'resolved', 'expired']);

// The dashboard reads these keys directly; renaming one silently empties a card.
// The fixture is the table as getDb() leaves it after migrateInsightProvenance.
const PROVENANCE_DDL = `source TEXT, source_kind TEXT, model TEXT, prompt_version TEXT,
  rule_version TEXT, confidence REAL, expires_at INTEGER,`;
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, source_analysis_id INTEGER,
  data TEXT NOT NULL, ${PROVENANCE_DDL} UNIQUE(project, type, fingerprint));`);
const shape = getActiveInsights(db, 'fixture');
for (const k of ['keyword_gaps', 'long_tails', 'quick_wins', 'new_pages', 'content_gaps',
                 'technical_gaps', 'positioning', 'keyword_inventor', 'site_watch', 'generated_at']) {
  assert.ok(k in shape, `legacy key ${k} still returned`);
}

const rowOf = (fp, type = null) => db.prepare(
  `SELECT * FROM insights WHERE fingerprint = ?${type ? ' AND type = ?' : ''}`
).get(...(type ? [fp, type] : [fp]));

// ── Writer semantics ────────────────────────────────────────────────────────
const items = [{ fingerprint: 'a', data: { url: 'https://x.io/a' } }, { fingerprint: 'b', data: { url: 'https://x.io/b' } }];
assert.equal(upsertInsights(db, 'fixture', 'entity_gap', items), 2);
upsertInsights(db, 'fixture', 'entity_gap', items);
assert.equal(db.prepare('SELECT COUNT(*) c FROM insights').get().c, 2, 're-running an audit dedups by fingerprint');

db.prepare("UPDATE insights SET status = 'dismissed' WHERE fingerprint = 'a'").run();
upsertInsights(db, 'fixture', 'entity_gap', items);
assert.equal(rowOf('a').status, 'dismissed', 'a dismissed finding is not resurrected by the next run');
assert.equal(getActiveInsights(db, 'fixture').entity_gaps.length, 1);

assert.equal(upsertInsights(new DatabaseSync(':memory:'), 'p', 'entity_gap', items), 0,
  'a database without the insights table returns 0 rather than throwing');
assert.equal(upsertInsights(db, 'fixture', 'entity_gap', []), 0);

// A malformed blob must not take the whole dashboard down.
db.prepare(`INSERT INTO insights (project,type,status,fingerprint,first_seen,last_seen,data)
            VALUES ('fixture','technical_gap','active','bad',1,1,'{ not json')`).run();
assert.doesNotThrow(() => getActiveInsights(db, 'fixture'));
assert.equal(getActiveInsights(db, 'fixture').technical_gaps.length, 0, 'the bad row is skipped, not fatal');

// ── Provenance: rule findings ───────────────────────────────────────────────
{
  const r = rowOf('b');
  assert.equal(r.source_kind, 'rule', 'an own-site audit writes a rule finding');
  assert.equal(r.rule_version, '1', 'the registry rule version is stamped');
  assert.equal(r.confidence, 1, 'a rule is certain');
  assert.equal(r.expires_at, null, 'a rule finding does not expire — it resolves when the rule stops firing');
  assert.equal(r.model, null);
  assert.equal(r.prompt_version, null);
  const viaRead = getActiveInsights(db, 'fixture').entity_gaps.find(i => i._insight_id === r.id);
  assert.equal(viaRead._source_kind, 'rule', 'getActiveInsights carries source kind');
  assert.equal(viaRead._confidence, 1);
  assert.equal(viaRead._expires_at, null);
  assert.equal(viaRead._model, null);
}

// ── Provenance: model findings ──────────────────────────────────────────────
{
  const before = Date.now();
  upsertInsights(db, 'fixture', 'keyword_gap',
    [{ fingerprint: 'kw1', data: { keyword: 'one' } }, { fingerprint: 'kw2', data: { keyword: 'two' }, confidence: 0.6 }],
    { model: 'claude-test', promptVersion: 'analyze-v2', confidence: 0.9 });
  const after = Date.now();
  const r = rowOf('kw1');
  assert.equal(r.source_kind, 'model', 'keyword_gap is model-sourced by registry default');
  assert.equal(r.model, 'claude-test');
  assert.equal(r.prompt_version, 'analyze-v2');
  assert.equal(r.rule_version, null, 'a model finding has no rule version');
  assert.equal(r.confidence, 0.9, 'meta confidence applies when the item gives none');
  assert.equal(rowOf('kw2').confidence, 0.6, 'an item confidence overrides the meta one');
  assert.ok(r.expires_at >= before + 90 * DAY_MS && r.expires_at <= after + 90 * DAY_MS,
    'a model finding expires 90 days out');
  const viaRead = getActiveInsights(db, 'fixture').keyword_gaps.find(i => i._insight_id === r.id);
  assert.equal(viaRead._source_kind, 'model');
  assert.equal(viaRead._model, 'claude-test');
  assert.equal(viaRead._expires_at, r.expires_at);

  // No confidence given anywhere: NULL, never invented.
  upsertInsights(db, 'fixture', 'long_tail', [{ fingerprint: 'lt1', data: { phrase: 'p' } }], { model: 'claude-test' });
  assert.equal(rowOf('lt1').confidence, null, 'an unknown model confidence is NULL');
  // A percentage is not a confidence; store "unknown" rather than a lie.
  upsertInsights(db, 'fixture', 'long_tail', [{ fingerprint: 'lt2', data: { phrase: 'q' }, confidence: 85 }], { model: 'claude-test' });
  assert.equal(rowOf('lt2').confidence, null);
  // An explicit sourceKind beats the registry: an agent may write a rule type.
  upsertInsights(db, 'fixture', 'entity_gap', [{ fingerprint: 'agentish', data: { url: 'https://x.io/z' } }],
    { sourceKind: 'agent', model: 'hermes', ttlDays: 10 });
  const ag = rowOf('agentish');
  assert.equal(ag.source_kind, 'agent');
  assert.equal(ag.model, 'hermes');
  assert.equal(ag.rule_version, null);
  assert.ok(ag.expires_at > Date.now() + 9 * DAY_MS && ag.expires_at <= Date.now() + 10 * DAY_MS, 'ttlDays is honoured');
}

// ── Provenance: the analyze writer ──────────────────────────────────────────
{
  upsertInsightsFromAnalysis(db, 'fixture', null, {
    keyword_gaps: [{ keyword: 'from analysis' }],
    positioning: { statement: 'we are the fast one' },
  }, 1_700_000_000_000, { model: 'claude-analyze', promptVersion: 'v7' });
  const kg = rowOf('from analysis', 'keyword_gap');
  assert.equal(kg.source_kind, 'model');
  assert.equal(kg.model, 'claude-analyze');
  assert.equal(kg.prompt_version, 'v7');
  assert.equal(kg.expires_at, 1_700_000_000_000 + 90 * DAY_MS, 'expiry counts from the run timestamp');
  assert.equal(rowOf('positioning', 'positioning').source_kind, 'model');
  // No analyses table here and no meta.model: the lookup degrades to NULL, not a throw.
  assert.doesNotThrow(() => upsertInsightsFromAnalysis(db, 'fixture', 42, { keyword_gaps: [{ keyword: 'no model' }] }, Date.now()));
  assert.equal(rowOf('no model', 'keyword_gap').model, null);
}

// ── Complete runs resolve what they no longer emit ──────────────────────────
{
  const c = { fingerprint: 'c', data: { url: 'https://x.io/c' } };
  upsertInsights(db, 'fixture', 'entity_gap', [items[1], c], { complete: true });
  assert.equal(rowOf('c').status, 'active');
  assert.equal(rowOf('b').status, 'active');
  assert.equal(rowOf('a').status, 'dismissed', 'a complete run leaves a dismissed row alone');

  // The next complete run does not see c: it is no longer detected.
  upsertInsights(db, 'fixture', 'entity_gap', [items[1]], { complete: true });
  assert.equal(rowOf('c').status, 'resolved', 'a fingerprint missing from a complete run is resolved');
  assert.equal(rowOf('b').status, 'active');
  assert.equal(rowOf('a').status, 'dismissed', 'the person\'s decision stands');
  assert.equal(rowOf('agentish').status, 'resolved', 'the same-type agent row was not emitted either');
  assert.ok(!getActiveInsights(db, 'fixture').entity_gaps.some(i => i._insight_id === rowOf('c').id), 'resolved is not active');

  // A later run re-emits c: the data says it is back.
  upsertInsights(db, 'fixture', 'entity_gap', [items[1], c]);
  assert.equal(rowOf('c').status, 'active', 'a re-emitted resolved finding returns to active');
  assert.equal(rowOf('a').status, 'dismissed', 'a re-emission never flips a dismissed row');

  // A partial run (complete unset) resolves nothing.
  upsertInsights(db, 'fixture', 'entity_gap', [c]);
  assert.equal(rowOf('b').status, 'active', 'a run that did not claim completeness resolves nothing');

  // in_progress is a person's (or the loop's) state too.
  db.prepare("UPDATE insights SET status = 'in_progress' WHERE fingerprint = 'b'").run();
  upsertInsights(db, 'fixture', 'entity_gap', [items[1], c], { complete: true });
  assert.equal(rowOf('b').status, 'in_progress', 'in_progress is kept on re-emission');
  db.prepare("UPDATE insights SET status = 'active' WHERE fingerprint = 'b'").run();

  // An empty complete run resolves everything active of the type — fixing the
  // last issue must close it — and still reports 0 rows written.
  assert.equal(upsertInsights(db, 'fixture', 'entity_gap', [], { complete: true }), 0);
  assert.equal(rowOf('b').status, 'resolved');
  assert.equal(rowOf('c').status, 'resolved');
  assert.equal(rowOf('a').status, 'dismissed');
  upsertInsights(db, 'fixture', 'entity_gap', [items[1], c]);
  assert.equal(rowOf('b').status, 'active');
}

// ── Expiry ──────────────────────────────────────────────────────────────────
{
  const kw = rowOf('kw1');
  // The analyze run above was stamped in 2023: its two rows are the only ones
  // already past expiry, and the sweep retires exactly those.
  assert.equal(expireInsights(db, Date.now()), 2, 'a run stamped long ago is expired at the next sweep');
  assert.equal(rowOf('from analysis', 'keyword_gap').status, 'expired');
  assert.equal(rowOf('positioning', 'positioning').status, 'expired');
  assert.equal(rowOf('kw1').status, 'active', 'a fresh model finding is not');
  // Before the sweep runs, the reader already treats a past-expiry row as gone.
  const future = kw.expires_at + 1;
  assert.ok(!getActiveInsights(db, 'fixture', future).keyword_gaps.some(i => i._insight_id === kw.id),
    'getActiveInsights excludes a row past expires_at even before the sweep');
  assert.ok(getActiveInsights(db, 'fixture', future).entity_gaps.length > 0, 'rule findings never expire');

  const flipped = expireInsights(db, future);
  assert.ok(flipped >= 1, `the sweep flips past-expiry active rows (got ${flipped})`);
  assert.equal(rowOf('kw1').status, 'expired');
  assert.equal(rowOf('kw2').status, 'expired');
  assert.equal(rowOf('b').status, 'active', 'a rule row is untouched by the sweep');
  assert.ok(!getActiveInsights(db, 'fixture').keyword_gaps.some(i => i._insight_id === kw.id), 'expired is not active');
  assert.equal(expireInsights(db, future), 0, 'the sweep is idempotent');

  // A dismissed model row is not expired: a person already closed it.
  db.prepare("UPDATE insights SET status = 'dismissed' WHERE fingerprint = 'lt1'").run();
  expireInsights(db, future);
  assert.equal(rowOf('lt1').status, 'dismissed');

  // Re-emission flips expired back to active, with a fresh expiry.
  upsertInsights(db, 'fixture', 'keyword_gap', [{ fingerprint: 'kw1', data: { keyword: 'one' } }], { model: 'claude-test' });
  const again = rowOf('kw1');
  assert.equal(again.status, 'active', 'a re-emitted expired finding returns to active');
  assert.ok(again.expires_at > kw.expires_at, 'its expiry moved forward');
  assert.equal(rowOf('kw2').status, 'expired', 'the one not re-emitted stays expired');

  assert.equal(expireInsights(new DatabaseSync(':memory:')), 0, 'no table: 0, not a throw');
}

// ── Agent write-back ────────────────────────────────────────────────────────
{
  const before = Date.now();
  const res = insertAgentInsight(db, {
    project: 'fixture', type: 'content_gap', data: { topic: 'pricing page' }, agentName: 'hermes', confidence: 0.7,
  });
  assert.equal(res.ok, true);
  assert.equal(res.source_kind, 'agent');
  assert.equal(res.confidence, 0.7);
  const r = db.prepare('SELECT * FROM insights WHERE id = ?').get(res.id);
  assert.equal(r.source_kind, 'agent', 'an agent finding is stamped agent');
  assert.equal(r.model, 'hermes', 'model holds the agent name');
  assert.equal(r.confidence, 0.7);
  assert.equal(r.source, 'agent:hermes', 'the legacy source column still says who');
  assert.equal(r.prompt_version, null);
  assert.equal(r.rule_version, null);
  assert.ok(r.expires_at >= before + 90 * DAY_MS, 'an agent finding expires like a model one');
  const dedup = insertAgentInsight(db, { project: 'fixture', type: 'content_gap', data: { topic: 'pricing page' } });
  assert.equal(dedup.deduped, true);
  assert.equal(db.prepare('SELECT confidence, model FROM insights WHERE id = ?').get(res.id).confidence, null,
    'a repeat without a confidence records unknown, not the old number');
  assert.equal(insertAgentInsight(db, { project: 'fixture', type: 'entity_gap', data: { url: 'x' } }).ok, false,
    'agents still write only the agent types');
}

// ── Migration of a pre-provenance table ─────────────────────────────────────
{
  // The shape a v1.5.x database has: `source` present, nothing else.
  const old = new DatabaseSync(':memory:');
  old.exec(`
    CREATE TABLE insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, source_analysis_id INTEGER,
      data TEXT NOT NULL, source TEXT DEFAULT 'cli', UNIQUE(project, type, fingerprint));
    CREATE TABLE analyses (id INTEGER PRIMARY KEY, project TEXT, generated_at INTEGER, model TEXT);
    INSERT INTO analyses VALUES (7, 'legacy', 1, 'claude-legacy');
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,source_analysis_id,data,source)
      VALUES ('legacy','keyword_gap','old kw',1,1,7,'{"keyword":"old kw"}','cli');
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,source_analysis_id,data,source)
      VALUES ('legacy','long_tail','orphan',1,1,NULL,'{"phrase":"orphan"}','cli');
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,data,source)
      VALUES ('legacy','entity_gap','ent',1,1,'{"url":"https://x.io"}','cli');
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,data,source)
      VALUES ('legacy','quick_win','typed',1,1,'{"page":"/","issue":"x"}','agent:hermes');
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,data,source)
      VALUES ('legacy','citability_gap','cit',1,1,'{"url":"https://x.io/c"}',NULL);
  `);
  assert.throws(() => old.prepare('SELECT source_kind FROM insights').get(), 'the fixture really predates the columns');
  // A reader on the old shape degrades rather than throws, and says "no data".
  const legacyRead = getActiveInsights(old, 'legacy');
  assert.equal(legacyRead.entity_gaps.length, 1);
  assert.equal(legacyRead.entity_gaps[0]._source_kind, null, 'a row without the column reads as unknown');

  migrateInsightProvenance(old);
  const cols = old.prepare('PRAGMA table_info(insights)').all().map(c => c.name);
  for (const c of ['source_kind', 'model', 'prompt_version', 'rule_version', 'confidence', 'expires_at']) {
    assert.ok(cols.includes(c), `migration adds ${c}`);
  }
  const get = fp => old.prepare('SELECT * FROM insights WHERE fingerprint = ?').get(fp);
  assert.equal(get('old kw').source_kind, 'model', 'a legacy keyword_gap is classified model');
  assert.equal(get('old kw').model, 'claude-legacy', 'the model comes from the analyses row');
  assert.equal(get('old kw').expires_at, null, 'legacy model rows keep living until re-emitted');
  assert.equal(get('orphan').source_kind, 'model');
  assert.equal(get('orphan').model, null, 'no analyses row, no model id');
  assert.equal(get('ent').source_kind, 'rule', 'a legacy entity_gap is classified rule');
  assert.equal(get('ent').confidence, 1, 'a rule is certain');
  assert.equal(get('ent').rule_version, '1');
  assert.equal(get('cit').source_kind, 'rule', 'a NULL source is still a rule');
  assert.equal(get('typed').source_kind, 'agent', 'an agent-sourced row of a model type stays the agent\'s');
  assert.equal(get('typed').model, 'hermes');

  // Idempotent: a second run changes nothing, and a row stamped since is untouched.
  old.prepare("UPDATE insights SET source_kind = 'model', confidence = 0.4 WHERE fingerprint = 'ent'").run();
  assert.doesNotThrow(() => migrateInsightProvenance(old));
  assert.equal(get('ent').source_kind, 'model', 'the backfill only classifies rows with no source_kind');
  assert.equal(get('ent').confidence, 0.4);

  // The fixture without the `source` column (older still) and one without the table at all.
  const older = new DatabaseSync(':memory:');
  older.exec(`CREATE TABLE insights (id INTEGER PRIMARY KEY, project TEXT, type TEXT, status TEXT DEFAULT 'active',
    fingerprint TEXT, first_seen INTEGER, last_seen INTEGER, source_analysis_id INTEGER, data TEXT);
    INSERT INTO insights (project,type,fingerprint,first_seen,last_seen,data) VALUES ('p','new_page','np',1,1,'{}');`);
  assert.doesNotThrow(() => migrateInsightProvenance(older));
  assert.equal(older.prepare('SELECT source_kind FROM insights').get().source_kind, 'model');
  assert.doesNotThrow(() => migrateInsightProvenance(new DatabaseSync(':memory:')), 'no insights table is not a fault');
}

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

console.log('ledger + provenance + schema-specificity fixtures: PASS');
