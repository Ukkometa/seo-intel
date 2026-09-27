/**
 * coverage — findOrphanEntities, getEntityCoverage and getSchemaCoverage
 * against an in-memory database built from db/schema.sql.
 *
 * The fixture is one small market: a target, an owned docs host, three
 * competitors, and a domain in another project that would change every
 * answer if the project filter leaked. Each place the CLI and harness copies
 * disagreed has a row that tells them apart — an entity whose only competitor
 * page is at /das/api (the CLI's second dedicated-page spelling), "node.js"
 * and "café" for the suggested URL, a shared list that is out of count order
 * in the rows — so a copy's behaviour creeping back fails here rather than in
 * a golden diff. The known quirks the modules keep on purpose (orphans reads
 * no one-character floor and ignores the target; schemas puts owned domains
 * on the competitor side) are asserted too, so fixing one is a decision
 * somebody makes, not an accident. Pages and extractions are inserted grouped
 * by domain, in domain order, so the row order the queries read is the same
 * whichever table SQLite scans first.
 *
 * The last block runs `cli.js schemas` itself, because the case it covers is
 * the CLI's choice, not the module's: a config on disk under a name the loader
 * refuses. It runs the real cli.js through a temp directory of symlinks to the
 * repo with its own config/ beside them; --preserve-symlinks makes
 * lib/project-config resolve config/ there, so the test never writes into the
 * repo's config/, which other processes read.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOUNDS,
  DEFAULTS,
  entitySlug,
  findOrphanEntities,
  getEntityCoverage,
  hasDedicatedPage,
  intOpt,
  parseEntities,
  suggestedUrl,
} from '../analyses/entity-coverage/index.js';
import {
  HIGH_VALUE_TYPES,
  getSchemaCoverage,
  resolveTargetDomain,
} from '../analyses/schema-coverage/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

// No config/covfx.json exists, so the schema fallback read finds nothing.
const P = 'covfx';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const addDomain = db.prepare('INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, 0)');
  addDomain.run('acme.io', P, 'target');
  addDomain.run('docs.acme.io', P, 'owned');
  addDomain.run('a.com', P, 'competitor');
  addDomain.run('b.com', P, 'competitor');
  addDomain.run('c.com', P, 'competitor');
  addDomain.run('z.com', 'other', 'competitor');
  const domainId = db.prepare('SELECT id FROM domains WHERE domain = ?');
  const insPage = db.prepare('INSERT INTO pages (domain_id, url, crawled_at) VALUES (?, ?, 0)');
  const insExt = db.prepare('INSERT INTO extractions (page_id, primary_entities, extracted_at) VALUES (?, ?, 0)');
  const insSchema = db.prepare(`
    INSERT INTO page_schemas (page_id, schema_type, name, rating, rating_count, price, currency, raw_json, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 0)
  `);
  // entities: an array (stored as JSON), a raw string (stored as is), or undefined (no extraction row)
  const page = (domain, url, { entities, schemas = [] } = {}) => {
    const { id } = domainId.get(domain);
    const pageId = Number(insPage.run(id, url).lastInsertRowid);
    if (entities !== undefined) insExt.run(pageId, typeof entities === 'string' ? entities : JSON.stringify(entities));
    for (const s of schemas) {
      insSchema.run(pageId, s.type, s.name ?? null, s.rating ?? null, s.ratingCount ?? null, s.price ?? null, s.currency ?? null);
    }
    return pageId;
  };
  return { db, page };
}

/** The entity fixture. The expected answers below are worked out from it by hand. */
function entityMarket() {
  const { db, page } = freshDb();
  page('acme.io', 'https://acme.io/', { entities: ['Solana', 'RPC', 'Webhooks'] });
  page('acme.io', 'https://acme.io/solutions/indexing', { entities: ['Indexing'] });   // the target's page does not count
  page('docs.acme.io', 'https://docs.acme.io/sdk', { entities: ['SDK', 'rpc'] });
  page('a.com', 'https://a.com/', { entities: ['Solana', 'DAS API', 'Priority Fees', 'Geyser', 'x'] });
  page('a.com', 'https://a.com/blog/one', { entities: ['priority fees', 'Staking', 'Indexing', 'Node.js'] });
  page('a.com', 'https://a.com/das/api', { entities: ['Launch'] });                     // "das api" as a path
  page('b.com', 'https://b.com/', { entities: ['solana ', 'DAS API', 'Priority Fees', 'Staking', 'Indexing', 'x', 'Café'] });
  page('b.com', 'https://b.com/staking-guide', { entities: ['Grpc'] });                // "staking" as a slug
  page('c.com', 'https://c.com/', { entities: ['Priority Fees', 'Webhooks', 'Café', 'Node.js'] });
  // Rows the extractor never writes. Every copy threw on the last four.
  page('c.com', 'https://c.com/m1', { entities: 'not json' });
  page('c.com', 'https://c.com/m2', { entities: '"solana"' });
  page('c.com', 'https://c.com/m3', { entities: 'null' });
  page('c.com', 'https://c.com/m4', { entities: '42' });
  page('c.com', 'https://c.com/m5', { entities: '{"a":1}' });
  page('c.com', 'https://c.com/m6', { entities: '[42, null, "Staking", {"x":1}]' });
  page('c.com', 'https://c.com/empty', { entities: [] });
  // Crawled, never extracted. No competitor URL may contain an "x", or the
  // one-character entity below has a "dedicated page" and the pin is lost.
  page('c.com', 'https://c.com/pending');
  // Another project: its URL would give "solana" a dedicated page, its mention a third domain.
  page('z.com', 'https://z.com/solana', { entities: ['Solana', 'Priority Fees'] });
  return db;
}

// ── helpers ────────────────────────────────────────────────────────────────
{
  assert.equal(intOpt('3', 2), 3, 'a commander string parses');
  assert.equal(intOpt(3, 2), 3, 'an MCP number passes');
  assert.equal(intOpt('0', 2), 0, '0 is kept (both copies read `parseInt(x) || 2`)');
  for (const missing of [undefined, null, '', 'abc']) {
    assert.equal(intOpt(missing, 2), 2, `${JSON.stringify(missing)} takes the default`);
  }

  assert.deepEqual(parseEntities('["Solana", " RPC ", "DAS API"]'), ['solana', 'rpc', 'das api']);
  assert.deepEqual(parseEntities('["Solana", "solana"]'), ['solana', 'solana'], 'duplicates are kept; callers count domains');
  for (const bad of ['', 'not json', 'null', '42', '"solana"', '{"a":1}']) {
    assert.deepEqual(parseEntities(bad), [], `${JSON.stringify(bad)} yields nothing`);
  }
  assert.deepEqual(parseEntities('[1, null, "Staking", ["x"], {"y":1}]'), ['staking'], 'only string elements count');

  assert.equal(entitySlug('priority fees'), 'priority-fees');
  assert.equal(entitySlug('node.js'), 'nodejs');
  assert.equal(entitySlug('café'), 'caf', 'non-ASCII letters drop out of the slug (known, kept)');
  assert.equal(entitySlug('what’s  new'), 'whats-new');

  assert.equal(suggestedUrl('priority fees'), '/solutions/priority-fees');
  assert.equal(suggestedUrl('node.js'), '/solutions/node.js', "the CLI's form, not the harness's /solutions/nodejs");
  assert.equal(suggestedUrl('café'), '/solutions/café', "the CLI's form, not the harness's /solutions/caf");

  const urls = ['https://a.com/das/api', 'https://b.com/grpc-streams'];
  assert.ok(hasDedicatedPage('das api', urls), 'whitespace as path separators is the second spelling');
  assert.ok(hasDedicatedPage('rpc', urls), 'a short slug is found inside a longer word (known, kept)');
  assert.ok(!hasDedicatedPage('staking', urls));
  assert.ok(hasDedicatedPage('???', urls), 'an empty slug is in every URL, so it is never an orphan (known, kept)');
}

// ── findOrphanEntities ─────────────────────────────────────────────────────
{
  const db = entityMarket();
  const res = findOrphanEntities(db, P, {});

  assert.deepEqual(res.orphans, [
    { entity: 'priority fees', domains: ['a.com', 'b.com', 'c.com'], domainCount: 3, suggestedUrl: '/solutions/priority-fees' },
    { entity: 'solana', domains: ['a.com', 'b.com'], domainCount: 2, suggestedUrl: '/solutions/solana' },
    { entity: 'x', domains: ['a.com', 'b.com'], domainCount: 2, suggestedUrl: '/solutions/x' },
    { entity: 'indexing', domains: ['a.com', 'b.com'], domainCount: 2, suggestedUrl: '/solutions/indexing' },
    { entity: 'node.js', domains: ['a.com', 'c.com'], domainCount: 2, suggestedUrl: '/solutions/node.js' },
    { entity: 'café', domains: ['b.com', 'c.com'], domainCount: 2, suggestedUrl: '/solutions/café' },
  ], 'most domains first, ties in first-mention order');
  // What each exclusion pins:
  //   das api   a.com/das/api — the CLI's second spelling; the harness copy listed it
  //   staking   b.com/staking-guide — three domains, one of them malformed-row c.com
  //   geyser, launch, grpc, webhooks — one competitor domain each
  //   solana    still an orphan though the target names it, and z.com/solana is another project
  //   indexing  still an orphan though acme.io/solutions/indexing exists: target URLs are not read
  //   x         one character, kept (the dashboard's copy skipped it)
  assert.equal(res.totalOrphans, 6);
  assert.deepEqual(Object.keys(res.orphans[0]), ['entity', 'domains', 'domainCount', 'suggestedUrl'], 'the MCP and CLI JSON field order');
  assert.equal(res.extractionCount, 15, 'every extracted page with a non-empty list, target and owned included, "[]" excluded');
  assert.equal(res.entityCount, 12,
    'distinct competitor entities; the malformed rows add only "staking", and "\\"solana\\"" is not walked into letters');
  assert.equal(BOUNDS.orphanMinDomains, 2);
}

// ── getEntityCoverage ──────────────────────────────────────────────────────
{
  const db = entityMarket();
  const res = getEntityCoverage(db, P, {});

  assert.deepEqual(res.gaps, [
    { entity: 'priority fees', competitorCount: 3, domains: ['a.com', 'b.com', 'c.com'] },
    { entity: 'staking', competitorCount: 3, domains: ['a.com', 'b.com', 'c.com'] },
    { entity: 'das api', competitorCount: 2, domains: ['a.com', 'b.com'] },
    { entity: 'node.js', competitorCount: 2, domains: ['a.com', 'c.com'] },
    { entity: 'café', competitorCount: 2, domains: ['b.com', 'c.com'] },
  ], 'competitors name it, you never do; a dedicated competitor page does not matter here');
  assert.deepEqual(res.shared, [
    { entity: 'solana', competitorCount: 2, targetDomains: ['acme.io'], competitorDomains: ['a.com', 'b.com'] },
    { entity: 'indexing', competitorCount: 2, targetDomains: ['acme.io'], competitorDomains: ['a.com', 'b.com'] },
    { entity: 'webhooks', competitorCount: 1, targetDomains: ['acme.io'], competitorDomains: ['c.com'] },
  ], "sorted by competitor count, as the CLI does; the harness copy left webhooks second, in row order");
  assert.deepEqual(res.unique, [
    { entity: 'rpc', targetDomains: ['acme.io', 'docs.acme.io'] },
    { entity: 'sdk', targetDomains: ['docs.acme.io'] },
  ], 'the target and owned domains are both "you", target listed first');
  assert.deepEqual(res.summary, { totalEntities: 13, gapCount: 5, sharedCount: 3, uniqueCount: 2 },
    'geyser, launch and grpc are in no bucket but in the total; "x" is below the length floor and in neither');
  assert.equal(res.minMentions, DEFAULTS.minMentions);
  assert.equal(res.extractionCount, 15);
  assert.equal(BOUNDS.entityMinLength, 2);

  assert.deepEqual(Object.keys(res.gapPages).sort(), res.gaps.map(g => g.entity).sort(), 'one page list per gap, and only gaps');
  assert.deepEqual(res.gapPages['priority fees'], [
    { domain: 'a.com', url: 'https://a.com/', role: 'competitor' },
    { domain: 'a.com', url: 'https://a.com/blog/one', role: 'competitor' },
    { domain: 'b.com', url: 'https://b.com/', role: 'competitor' },
    { domain: 'c.com', url: 'https://c.com/', role: 'competitor' },
  ], 'every page naming it, in row order — the CLI prints the first two as examples');
  assert.deepEqual(res.gapPages.staking.map(p => p.url), ['https://a.com/blog/one', 'https://b.com/', 'https://c.com/m6']);

  const three = getEntityCoverage(db, P, { minMentions: '3' });
  assert.deepEqual(three.gaps.map(g => g.entity), ['priority fees', 'staking'], 'a commander string is a threshold');
  assert.equal(three.minMentions, 3);
  assert.deepEqual(three.shared, res.shared, 'the threshold only moves gaps');
  assert.deepEqual(three.summary.totalEntities, 13);

  const any = getEntityCoverage(db, P, { minMentions: 0 });
  assert.deepEqual(any.gaps.map(g => g.entity), ['priority fees', 'staking', 'das api', 'node.js', 'café', 'geyser', 'launch', 'grpc'],
    '0 means any competitor (it used to become 2)');
  assert.deepEqual(getEntityCoverage(db, P, { minMentions: 1 }).gaps, any.gaps);
  assert.deepEqual(getEntityCoverage(db, P, { minMentions: 'abc' }).gaps, res.gaps, 'garbage takes the default');
}

// ── entity functions on a project with no extraction ───────────────────────
{
  const { db, page } = freshDb();
  page('a.com', 'https://a.com/');
  page('b.com', 'https://b.com/', { entities: [] });
  assert.deepEqual(findOrphanEntities(db, P, {}), { orphans: [], totalOrphans: 0, extractionCount: 0, entityCount: 0 });
  assert.deepEqual(getEntityCoverage(db, P, {}), {
    gaps: [], shared: [], unique: [],
    summary: { totalEntities: 0, gapCount: 0, sharedCount: 0, uniqueCount: 0 },
    gapPages: {}, minMentions: 2, extractionCount: 0,
  });
}

// ── getSchemaCoverage ──────────────────────────────────────────────────────
function schemaMarket() {
  const { db, page } = freshDb();
  page('acme.io', 'https://acme.io/', { schemas: [{ type: 'Organization', name: 'Acme' }, { type: 'Product', name: 'Acme RPC', price: '49', currency: 'EUR' }] });
  page('acme.io', 'https://acme.io/pricing', { schemas: [{ type: 'Product', name: 'Acme Pro' }] });
  page('docs.acme.io', 'https://docs.acme.io/sdk', { schemas: [{ type: 'TechArticle', name: 'SDK' }] });
  page('a.com', 'https://a.com/', { schemas: [
    { type: 'Organization', name: 'A' },
    { type: 'FAQPage' },
    { type: 'SoftwareApplication', name: 'A App', rating: 4.6, ratingCount: 120, price: '0', currency: 'USD' },
  ] });
  page('b.com', 'https://b.com/', { schemas: [{ type: 'Organization', name: 'B' }, { type: 'BreadcrumbList' }, { type: 'FAQPage' }] });
  page('c.com', 'https://c.com/', { schemas: [{ type: 'HowTo', name: 'How to' }, { type: 'WebSite' }] });
  page('z.com', 'https://z.com/', { schemas: [{ type: 'Event', rating: 5, price: '1' }] });   // another project
  return db;
}

{
  const db = schemaMarket();
  const res = getSchemaCoverage(db, P, { targetDomain: 'acme.io' });

  assert.equal(res.targetDomain, 'acme.io');
  assert.deepEqual(res.domains, ['acme.io', 'a.com', 'b.com', 'c.com', 'docs.acme.io'], 'the target first, then by name');
  assert.deepEqual(res.types, ['BreadcrumbList', 'FAQPage', 'HowTo', 'Organization', 'Product', 'SoftwareApplication', 'TechArticle', 'WebSite']);
  assert.deepEqual(res.counts, {
    'a.com': { FAQPage: 1, Organization: 1, SoftwareApplication: 1 },
    'acme.io': { Organization: 1, Product: 2 },
    'b.com': { BreadcrumbList: 1, FAQPage: 1, Organization: 1 },
    'c.com': { HowTo: 1, WebSite: 1 },
    'docs.acme.io': { TechArticle: 1 },
  }, 'schema objects per cell: two Product rows on the target');

  assert.deepEqual(Object.keys(res.coverageMatrix), ['a.com', 'acme.io', 'b.com', 'c.com', 'docs.acme.io'], 'matrix keys in row order');
  assert.deepEqual(res.coverageMatrix['a.com'], [
    { type: 'FAQPage', url: 'https://a.com/', name: null, rating: null, ratingCount: null, price: null, currency: null },
    { type: 'Organization', url: 'https://a.com/', name: 'A', rating: null, ratingCount: null, price: null, currency: null },
    { type: 'SoftwareApplication', url: 'https://a.com/', name: 'A App', rating: 4.6, ratingCount: 120, price: '0', currency: 'USD' },
  ], "the CLI's entry shape; the harness cuts it to type, url, name, rating, price");
  // Two Product rows tie on (domain, type); SQLite does not promise their order.
  assert.deepEqual(res.coverageMatrix['acme.io'].map(s => `${s.type} ${s.url}`).sort(), [
    'Organization https://acme.io/', 'Product https://acme.io/', 'Product https://acme.io/pricing',
  ]);

  assert.deepEqual(res.gaps, ['FAQPage', 'SoftwareApplication', 'BreadcrumbList', 'HowTo', 'WebSite', 'TechArticle'],
    'row order; TechArticle is a gap because the owned docs host counts as a competitor here (known, kept)');
  assert.deepEqual(res.gapDomains, {
    FAQPage: ['a.com', 'b.com'],
    SoftwareApplication: ['a.com'],
    BreadcrumbList: ['b.com'],
    HowTo: ['c.com'],
    WebSite: ['c.com'],
    TechArticle: ['docs.acme.io'],
  });
  assert.deepEqual(res.exclusives, ['Product']);

  assert.deepEqual(res.ratings, [{ domain: 'a.com', url: 'https://a.com/', name: 'A App', rating: 4.6, ratingCount: 120 }]);
  assert.deepEqual(res.pricing, [
    { domain: 'a.com', url: 'https://a.com/', name: 'A App', price: '0', currency: 'USD' },
    { domain: 'acme.io', url: 'https://acme.io/', name: 'Acme RPC', price: '49', currency: 'EUR' },
  ], 'a price of "0" is a price');
  assert.deepEqual(res.ratingCoverage, { target: 0, competitors: 1 });
  assert.deepEqual(res.pricingCoverage, { target: 1, competitors: 1 });

  assert.deepEqual(res.actions, [
    'Add high-value schema types: FAQPage, SoftwareApplication, HowTo',
    'Consider adding: BreadcrumbList, WebSite, TechArticle',
    'Add aggregateRating schema for star-rich snippets (highest SERP CTR impact)',
    'Add FAQPage schema — expands your SERP real estate with accordion snippets',
    'Add BreadcrumbList schema — improves SERP display and navigation signals',
  ], 'no pricing action: the target has a price');
  assert.ok(HIGH_VALUE_TYPES.includes('FAQPage'));

  assert.deepEqual(res.summary, { totalSchemas: 12, uniqueTypes: 8, domainsWithSchemas: 5, gapCount: 6 },
    'the harness and CLI summary, unchanged; z.com in the other project is not counted');

  assert.deepEqual(getSchemaCoverage(db, P, { config: { target: { domain: 'acme.io' } } }), res, 'a config names the same target');
}

// ── getSchemaCoverage: where the target comes from ─────────────────────────
{
  assert.equal(resolveTargetDomain(P, { targetDomain: 'acme.io', config: { target: { domain: 'x.io' } } }), 'acme.io');
  assert.equal(resolveTargetDomain(P, { targetDomain: null }), null, 'an explicit null is not a reason to read the disk');
  assert.equal(resolveTargetDomain(P, { config: null }), null);
  assert.equal(resolveTargetDomain(P, { config: { target: { domain: 'acme.io' } } }), 'acme.io');
  assert.equal(resolveTargetDomain(P, {}), null, 'no config/covfx.json');
  assert.equal(resolveTargetDomain('../package', {}), null, 'a name outside the guard is never read');

  const db = schemaMarket();
  const blind = getSchemaCoverage(db, P, {});
  assert.equal(blind.targetDomain, null);
  assert.deepEqual(blind.domains, ['a.com', 'acme.io', 'b.com', 'c.com', 'docs.acme.io']);
  assert.deepEqual(blind.gaps, ['FAQPage', 'Organization', 'SoftwareApplication', 'Product', 'BreadcrumbList', 'HowTo', 'WebSite', 'TechArticle'],
    'with no target every type is a gap — what the CLI printed when run outside the package root');
  assert.deepEqual(blind.exclusives, []);
  assert.deepEqual(blind.pricingCoverage, { target: 0, competitors: 2 });
  assert.ok(blind.actions.includes('Add pricing schema (Product/Offer) for price-rich results'));
}

// ── getSchemaCoverage on a project with no schemas ─────────────────────────
{
  const { db, page } = freshDb();
  page('acme.io', 'https://acme.io/');
  assert.deepEqual(getSchemaCoverage(db, P, { targetDomain: 'acme.io' }), {
    targetDomain: 'acme.io',
    domains: [], types: [], counts: {}, coverageMatrix: {},
    gaps: [], gapDomains: {}, exclusives: [],
    ratings: [], pricing: [],
    ratingCoverage: { target: 0, competitors: 0 },
    pricingCoverage: { target: 0, competitors: 0 },
    actions: [],
    summary: { totalSchemas: 0, uniqueTypes: 0, domainsWithSchemas: 0, gapCount: 0 },
  });
}

// ── cli.js schemas: a config the loader refuses by name ────────────────────
{
  const REPO = join(__dirname, '..');
  const root = mkdtempSync(join(tmpdir(), 'coverage-cli-'));
  try {
    for (const name of readdirSync(REPO)) {
      if (name !== 'config' && name !== '.git') symlinkSync(join(REPO, name), join(root, name));
    }
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    // `setup --project acme.io` writes this file under exactly that name.
    writeFileSync(join(configDir, 'acme.io.json'), JSON.stringify({ target: { domain: 'acme.io' }, competitors: [{ domain: 'rival.dev' }] }));
    writeFileSync(join(configDir, 'beta.json'), JSON.stringify({ target: { domain: 'beta.dev' }, competitors: [{ domain: 'rival2.dev' }] }));
    writeFileSync(join(configDir, 'broken.json'), '{ not json');

    const dbPath = join(root, 'coverage-cli.db');
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA_SQL);
    const addDomain = db.prepare("INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, 0)");
    const addPage = db.prepare('INSERT INTO pages (domain_id, url, crawled_at) VALUES (?, ?, 0)');
    const addSchema = db.prepare("INSERT INTO page_schemas (page_id, schema_type, raw_json, extracted_at) VALUES (?, ?, '{}', 0)");
    // Each project: the target and a competitor both carry FAQPage, only the
    // competitor carries HowTo — one real gap, and one the target covers.
    for (const [project, target, rival] of [['acme.io', 'acme.io', 'rival.dev'], ['beta', 'beta.dev', 'rival2.dev']]) {
      for (const [domain, role, types] of [[target, 'target', ['FAQPage']], [rival, 'competitor', ['FAQPage', 'HowTo']]]) {
        const domainId = Number(addDomain.run(domain, project, role).lastInsertRowid);
        const pageId = Number(addPage.run(domainId, `https://${domain}/`).lastInsertRowid);
        for (const t of types) addSchema.run(pageId, t);
      }
    }
    db.close();

    const schemas = (...args) => {
      const r = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'cli.js'), 'schemas', ...args], {
        env: { ...process.env, SEO_INTEL_DB: dbPath, SEO_INTEL_FORCE_FREE: '1', NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60000,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };

    // The rig reads its own config/: beta's target is known, so FAQPage is covered.
    const beta = schemas('beta', '--format', 'json');
    assert.equal(beta.status, 0, beta.stderr);
    assert.deepEqual(JSON.parse(beta.stdout).data.gaps, ['HowTo'], 'a loadable config names the target');

    // acme.io.json is on disk but the name fails the guard. The command used to
    // read that file directly; without the hint it would run with no target and
    // report the target's own FAQPage as a gap "used by acme.io".
    for (const format of ['json', 'brief']) {
      const refused = schemas('acme.io', '--format', format);
      assert.equal(refused.status, 1, `--format ${format}: a refused config name stops the command`);
      assert.equal(refused.stdout, '', `--format ${format}: no report is printed`);
      assert.match(refused.stderr, /config\/acme\.io\.json exists, but project names may only use letters, digits, '-' and '_'/);
      assert.match(refused.stderr, /Rename it, e\.g\. config\/acme-io\.json/, 'the same rename hint loadConfig gives');
    }

    // No file at all, or one that does not parse under a good name, is still
    // "no config": the report runs, as it always has.
    for (const project of ['ghost.io', 'broken']) {
      const none = schemas(project, '--format', 'json');
      assert.equal(none.status, 0, `${project}: ${none.stderr}`);
      assert.equal(JSON.parse(none.stdout).data.summary.totalSchemas, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('coverage: PASS');
