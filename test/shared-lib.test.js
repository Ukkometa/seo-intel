/**
 * shared libs — lib/content-pages.js, lib/project-config.js and lib/friction.js,
 * the three helpers cli.js, agent-harness.js and the dashboard each used to
 * carry a copy of.
 *
 * The config tests run against a temp config dir holding a real project, the
 * shipped template, a malformed file and a file whose name fails the project
 * guard, because those are the four things readdir actually returns in the
 * wild — plus a second project tracking the same domains, named so that
 * readdir order and name order disagree, because "sorted by name" and "first
 * match in name order" are promises a test on alphabetical files cannot see
 * broken. findFriction runs over an in-memory database built from db/schema.sql
 * with rows chosen to hit every exclusion the canonical selection makes: an
 * app route, a query-string URL, an empty label, a NULL label, the target's
 * own pages and another project's competitor — so a drift back to the old
 * harness selection (which counted empty labels) fails here, not in a golden
 * diff.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_PATHS, APP_SUBDOMAINS, isContentPage } from '../lib/content-pages.js';
import {
  CONFIG_DIR,
  findProjectByDomain,
  isValidProjectName,
  listProjectConfigs,
  readProjectConfig,
} from '../lib/project-config.js';
import {
  HIGH_FRICTION_CTAS,
  findFriction,
  isFrictionTarget,
  isHighFrictionCta,
  isSelfServeIntent,
} from '../lib/friction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

// ── isContentPage ───────────────────────────────────────────────────────────
{
  assert.equal(isContentPage('https://helius.dev/blog/solana-rpc-guide'), true, 'a normal blog post is content');
  assert.equal(isContentPage('https://helius.dev/'), true, 'the homepage is content');
  assert.equal(isContentPage('https://helius.dev/pricing'), true, 'a pricing page is content');
  assert.equal(isContentPage('https://docs.helius.dev/rpc/getting-started'), true, 'a docs subdomain is content');

  // One URL per APP_PATHS entry, and the list itself pinned: the header says
  // this is the three copies' list unchanged, so dropping or adding a fragment
  // has to change this file on purpose.
  assert.deepEqual([...APP_PATHS], [
    '/signup', '/login', '/register', '/onboarding', '/dashboard',
    '/app/', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults',
  ]);
  assert.deepEqual([...APP_SUBDOMAINS], ['dashboard.', 'app.', 'customers.', 'console.']);
  for (const path of ['/signup', '/login', '/register', '/onboarding', '/dashboard/settings', '/app/wallet', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults']) {
    assert.equal(isContentPage(`https://jup.ag${path}`), false, `${path} is an app route`);
  }
  for (const host of ['app.acme.io', 'dashboard.acme.io', 'customers.acme.io', 'console.acme.io']) {
    assert.equal(isContentPage(`https://${host}/overview`), false, `${host} is the product, not the marketing site`);
  }
  assert.equal(isContentPage('https://acme.io/blog/post?page=2'), false, 'pagination query');
  assert.equal(isContentPage('https://acme.io/?utm_source=x'), false, 'tracking query');
  assert.equal(isContentPage('https://acme.io/blog/post?'), false, 'even an empty query');

  assert.equal(isContentPage(null), false, 'a non-string is not content');
  assert.equal(isContentPage(undefined), false);
  assert.ok(Object.isFrozen(APP_PATHS) && Object.isFrozen(APP_SUBDOMAINS), 'the lists cannot be mutated by a caller');
}

// ── project config ──────────────────────────────────────────────────────────
{
  assert.equal(CONFIG_DIR, join(__dirname, '..', 'config'), 'CONFIG_DIR is config/ at the repo root');

  assert.equal(isValidProjectName('acme'), true);
  assert.equal(isValidProjectName('_scan-acme-io'), true, 'the scan command\'s ephemeral slug');
  assert.equal(isValidProjectName('My_Site-2'), true);
  for (const bad of ['', 'acme.io', '../acme', 'a/b', 'a b', null, undefined, 42]) {
    assert.equal(isValidProjectName(bad), false, `${JSON.stringify(bad)} is not a project name`);
  }

  const root = mkdtempSync(join(tmpdir(), 'shared-lib-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  try {
    const acme = {
      project: 'acme',
      target: { domain: 'acme.io' },
      owned: [{ domain: 'docs.acme.io' }],
      competitors: [{ domain: 'helius.dev' }, { domain: 'www.quicknode.com' }],
    };
    // acme-old is the same site under an older name, so two projects match
    // acme.io and helius.dev. Its file name is what pins the sort: '-' sorts
    // before '.', so acme-old.json comes before acme.json in a byte-ordered
    // readdir (what this container's filesystem returns) while the name acme
    // comes before acme-old. The files are also written out of order, and not
    // in reverse order either, so creation-order and newest-first readdirs
    // disagree with name order too. A listing that skips the sort, or sorts
    // file names before stripping .json, fails on any of the three.
    const acmeOld = { project: 'acme-old', target: { domain: 'acme.io' }, competitors: [{ domain: 'helius.dev' }] };
    writeFileSync(join(configDir, 'weird.name.json'), JSON.stringify({ target: { domain: 'weird.dev' }, competitors: [{ domain: 'x.dev' }] }));
    writeFileSync(join(configDir, 'acme-old.json'), JSON.stringify(acmeOld));
    writeFileSync(join(configDir, 'broken.json'), '{ not json');
    writeFileSync(join(configDir, 'acme.json'), JSON.stringify(acme));
    writeFileSync(join(configDir, 'beta.json'), JSON.stringify({ project: 'beta', target: { domain: 'beta.dev' } }));
    writeFileSync(join(configDir, 'example.json'), JSON.stringify({ target: { domain: 'example.com' } }));
    writeFileSync(join(configDir, 'notes.txt'), 'not a config');
    writeFileSync(join(root, 'outside.json'), JSON.stringify({ secret: true }));

    // readProjectConfig
    assert.deepEqual(readProjectConfig('acme', { configDir }), acme, 'a valid project loads');
    assert.equal(readProjectConfig('missing', { configDir }), null, 'a missing file is null');
    assert.equal(readProjectConfig('broken', { configDir }), null, 'malformed JSON is null');
    assert.equal(readProjectConfig('../outside', { configDir }), null, 'a path out of the config dir is refused');
    assert.equal(readProjectConfig('weird.name', { configDir }), null, 'a file whose name fails the guard is not loadable');
    assert.equal(readProjectConfig('', { configDir }), null);
    assert.equal(readProjectConfig(undefined, { configDir }), null);
    assert.equal(readProjectConfig('acme', { configDir: join(root, 'nope') }), null, 'an unreadable config dir is null, not a throw');

    // listProjectConfigs
    assert.deepEqual(listProjectConfigs({ configDir }), [
      { name: 'acme', targetDomain: 'acme.io', competitors: ['helius.dev', 'www.quicknode.com'] },
      { name: 'acme-old', targetDomain: 'acme.io', competitors: ['helius.dev'] },
      { name: 'beta', targetDomain: 'beta.dev', competitors: [] },
      { name: 'broken', targetDomain: null, competitors: [] },
      { name: 'weird.name', targetDomain: null, competitors: [] },
    ], 'every *.json but the template, sorted by name; unloadable files listed with no domains');
    assert.deepEqual(listProjectConfigs({ configDir: join(root, 'nope') }), [], 'an unreadable dir lists nothing');

    // findProjectByDomain — the CLI's "that looks like a domain" hint
    assert.equal(findProjectByDomain('acme.io', { configDir }), 'acme', 'the target domain; acme-old tracks it too, and the first in name order wins');
    assert.equal(findProjectByDomain('https://www.acme.io/pricing', { configDir }), 'acme', 'scheme, path and www. are ignored');
    assert.equal(findProjectByDomain('docs.acme.io', { configDir }), 'acme', 'an owned domain');
    assert.equal(findProjectByDomain('helius.dev', { configDir }), 'acme', 'a competitor, again the first of two in name order');
    assert.equal(findProjectByDomain('quicknode.com', { configDir }), 'acme', 'a www. competitor matched without it');
    assert.equal(findProjectByDomain('example.com', { configDir }), null, 'the template is never suggested');
    assert.equal(findProjectByDomain('weird.dev', { configDir }), null, 'a project the guard refuses is never suggested');
    assert.equal(findProjectByDomain('nobody.org', { configDir }), null);
    assert.equal(findProjectByDomain('acme', { configDir }), null, 'a bare word is a project name, not a domain');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── friction classifiers ────────────────────────────────────────────────────
{
  for (const cta of ['Contact sales', 'Talk to sales', 'Book a Demo', 'Request access', 'Request a quote', 'Talk to us', 'Go Enterprise', 'CONTACT US']) {
    assert.equal(isHighFrictionCta(cta), true, `"${cta}" asks for a person`);
  }
  for (const cta of ['Start free', 'View pricing', 'Sign up', 'Get API key', 'Try it now', '', null, undefined]) {
    assert.equal(isHighFrictionCta(cta), false, `${JSON.stringify(cta)} is self-serve`);
  }
  assert.ok(Object.isFrozen(HIGH_FRICTION_CTAS));

  for (const intent of ['Informational', 'Commercial', 'commercial investigation']) {
    assert.equal(isSelfServeIntent(intent), true, `${intent} is a self-serve visitor`);
  }
  for (const intent of ['Transactional', 'Navigational', '', null, undefined]) {
    assert.equal(isSelfServeIntent(intent), false, `${JSON.stringify(intent)} is not`);
  }

  assert.equal(isFrictionTarget({ search_intent: 'Informational', cta_primary: 'Contact sales' }), true);
  assert.equal(isFrictionTarget({ search_intent: 'Commercial', cta_primary: 'Book a demo' }), true);
  assert.equal(isFrictionTarget({ search_intent: 'Transactional', cta_primary: 'Contact sales' }), false, 'a buyer is not turned away by a form');
  assert.equal(isFrictionTarget({ search_intent: 'Informational', cta_primary: 'Start free' }), false, 'a low-friction CTA is not a target');
  assert.equal(isFrictionTarget({}), false);
  assert.equal(isFrictionTarget(null), false);
}

// ── findFriction ────────────────────────────────────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  const insDomain = db.prepare('INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, ?)');
  const insPage = db.prepare('INSERT INTO pages (domain_id, url, crawled_at, word_count, click_depth) VALUES (?, ?, ?, ?, ?)');
  const insExt = db.prepare('INSERT INTO extractions (page_id, search_intent, cta_primary, pricing_tier, extracted_at) VALUES (?, ?, ?, ?, ?)');
  const domainId = (domain, project, role) => Number(insDomain.run(domain, project, role, now).lastInsertRowid);
  const page = (domId, url, { depth = 1, words = 500, intent = 'Informational', cta = 'Sign up', tier = 'freemium' } = {}) => {
    const id = Number(insPage.run(domId, url, now, words, depth).lastInsertRowid);
    insExt.run(id, intent, cta, tier, now);
  };

  assert.deepEqual(findFriction(db, 'p', {}), { targets: [], totalAnalyzed: 0, totalHighFriction: 0 },
    'no extraction data: an empty result, not a throw');

  const helius = domainId('helius.dev', 'p', 'competitor');
  const alpha = domainId('alpha.com', 'p', 'competitor');
  const target = domainId('acme.io', 'p', 'target');
  const other = domainId('other.dev', 'q', 'competitor');

  // Inserted deepest first, so the depth ordering is the query's doing.
  page(helius, 'https://helius.dev/pricing', { depth: 2, words: 450, cta: 'Talk to sales' });
  page(helius, 'https://helius.dev/enterprise', { depth: 1, words: 350, intent: 'Commercial', cta: 'Contact Sales', tier: 'enterprise' });
  page(helius, 'https://helius.dev/blog/guide', { depth: 1 });                                   // analysed, self-serve CTA
  page(helius, 'https://helius.dev/buy', { depth: 1, intent: 'Transactional', cta: 'Book a demo' }); // analysed, buyer intent
  page(helius, 'https://helius.dev/signup', { cta: 'Contact sales' });                           // app route: not analysed
  page(helius, 'https://helius.dev/pricing?ref=nav', { cta: 'Contact sales' });                  // query string: not analysed
  page(helius, 'https://helius.dev/empty-intent', { intent: '', cta: 'Contact sales' });         // empty label: not analysed
  page(helius, 'https://helius.dev/null-cta', { cta: null });                                    // NULL label: not analysed
  page(alpha, 'https://alpha.com/demo', { depth: 0, words: 800, cta: 'Request a demo', tier: null });
  page(target, 'https://acme.io/pricing', { cta: 'Contact sales' });                             // our own page
  page(other, 'https://other.dev/pricing', { cta: 'Contact sales' });                            // another project

  const r = findFriction(db, 'p', {});
  assert.deepEqual(Object.keys(r), ['targets', 'totalAnalyzed', 'totalHighFriction'], 'the MCP result shape, in order');
  assert.equal(r.totalAnalyzed, 5, 'competitor content pages with both labels: alpha /demo + helius pricing, enterprise, guide, buy');
  assert.equal(r.totalHighFriction, 3);
  assert.equal(r.targets.length, r.totalHighFriction);
  assert.deepEqual(r.targets.map(t => t.url), [
    'https://alpha.com/demo',
    'https://helius.dev/enterprise',
    'https://helius.dev/pricing',
  ], 'ordered by domain, then shallowest first');
  assert.deepEqual(Object.keys(r.targets[0]), ['url', 'domain', 'searchIntent', 'ctaPrimary', 'pricingTier', 'wordCount'],
    'target keys and their order are the find_competitor_friction contract');
  assert.deepEqual({ ...r.targets[1] }, {
    url: 'https://helius.dev/enterprise',
    domain: 'helius.dev',
    searchIntent: 'Commercial',
    ctaPrimary: 'Contact Sales',
    pricingTier: 'enterprise',
    wordCount: 350,
  }, 'labels are passed through as extracted, not lower-cased');
  assert.equal(r.targets[0].pricingTier, null, 'a missing pricing tier stays null');

  assert.equal(findFriction(db, 'q').totalAnalyzed, 1, 'opts is optional; the other project sees only its own competitor');
  db.close();
}

console.log('shared-lib: all tests passed');
