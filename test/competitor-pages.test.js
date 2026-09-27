/**
 * competitor-pages — findShallowPages, findDecayingPages and
 * auditCompetitorHeadings against an in-memory database built from
 * db/schema.sql.
 *
 * Every filter bound gets a page on each side of it (80/81 words, 700/701,
 * the cutoff day and the day before, depth 2/3, indexable 0/1, a target page
 * that would otherwise qualify, a login route and a query-string URL), so a
 * bound that moves by one fails here instead of in a golden diff. The orders
 * asserted are the CLI's — click depth before anything else — because that is
 * where the CLI and harness copies disagreed. Each block builds its own
 * database so one attack's seed cannot satisfy another's assertion by
 * accident. The clock is fixed at noon UTC, which keeps the month arithmetic
 * (local time) on the same calendar day in every timezone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOUNDS,
  DEFAULTS,
  auditCompetitorHeadings,
  decayCutoff,
  findDecayingPages,
  findShallowPages,
  intOpt,
} from '../analyses/competitor-pages/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const P = 'fx';
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0); // 2026-09-27 noon UTC

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const addDomain = db.prepare('INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, 0)');
  addDomain.run('acme.io', P, 'target');
  addDomain.run('helius.dev', P, 'competitor');
  addDomain.run('quicknode.com', P, 'competitor');
  addDomain.run('elsewhere.example', 'other', 'competitor');
  const domainId = db.prepare('SELECT id FROM domains WHERE domain = ?');
  const insPage = db.prepare(`
    INSERT INTO pages (domain_id, url, crawled_at, word_count, click_depth, is_indexable, modified_date, published_date)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?)
  `);
  const insHeading = db.prepare('INSERT INTO headings (page_id, level, text) VALUES (?, ?, ?)');
  // url is absolute; the domain row is named separately so an app subdomain
  // can sit under its parent domain the way the crawler files it.
  const page = (domain, url, { words = null, depth = null, indexable = 1, modified = null, published = null, headings = [] } = {}) => {
    const { id } = domainId.get(domain);
    const { lastInsertRowid } = insPage.run(id, url, words, depth, indexable, modified, published);
    for (const [level, text] of headings) insHeading.run(lastInsertRowid, level, text);
    return Number(lastInsertRowid);
  };
  return { db, page };
}

const urls = list => list.map(r => r.url);

// ── intOpt and decayCutoff ─────────────────────────────────────────────────
{
  assert.equal(intOpt('700', 1), 700, 'a commander string parses');
  assert.equal(intOpt(12, 1), 12, 'an MCP number passes');
  assert.equal(intOpt('0', 2), 0, '0 is a value, not a missing one (the harness turned it into 2)');
  assert.equal(intOpt(0, 2), 0);
  for (const missing of [undefined, null, '', 'abc']) {
    assert.equal(intOpt(missing, 2), 2, `${JSON.stringify(missing)} takes the default`);
  }

  assert.equal(decayCutoff(NOW, 18), '2025-03-27');
  assert.equal(decayCutoff(NOW, 0), '2026-09-27');
  assert.equal(decayCutoff(new Date(NOW), 12), '2025-09-27', 'a Date is accepted for now');
}

// ── findShallowPages ───────────────────────────────────────────────────────
{
  const { db, page } = freshDb();
  page('helius.dev', 'https://helius.dev/', { words: 300, depth: 0 });
  page('helius.dev', 'https://helius.dev/floor-plus-one', { words: 81, depth: 1 });
  page('helius.dev', 'https://helius.dev/floor', { words: 80, depth: 1 });           // at the floor: boilerplate
  page('helius.dev', 'https://helius.dev/ceiling', { words: 700, depth: 2 });
  page('helius.dev', 'https://helius.dev/over-ceiling', { words: 701, depth: 2 });
  page('helius.dev', 'https://helius.dev/too-deep', { words: 200, depth: 3 });
  page('helius.dev', 'https://helius.dev/noindex', { words: 300, depth: 1, indexable: 0 });
  page('helius.dev', 'https://helius.dev/unmeasured', { depth: 1 });                  // NULL word_count
  page('helius.dev', 'https://helius.dev/login', { words: 300, depth: 1 });
  page('helius.dev', 'https://helius.dev/pricing?ref=nav', { words: 300, depth: 1 });
  page('helius.dev', 'https://app.helius.dev/overview', { words: 300, depth: 1 });
  page('quicknode.com', 'https://quicknode.com/guides/short', { words: 200, depth: 1 });
  page('acme.io', 'https://acme.io/thin', { words: 200, depth: 1 });                 // the target is never a target
  page('elsewhere.example', 'https://elsewhere.example/thin', { words: 200, depth: 1 });

  const res = findShallowPages(db, P, {});
  assert.deepEqual(urls(res.targets), [
    'https://helius.dev/',
    'https://helius.dev/floor-plus-one',
    'https://quicknode.com/guides/short',
    'https://helius.dev/ceiling',
  ], 'shallowest first, then thinnest; every excluded page stays out');
  assert.equal(res.totalTargets, 4);
  assert.equal(res.maxWords, DEFAULTS.maxWords);
  assert.equal(res.maxDepth, DEFAULTS.maxDepth);
  assert.deepEqual(res.targets[0], { url: 'https://helius.dev/', domain: 'helius.dev', wordCount: 300, clickDepth: 0 });
  assert.deepEqual(Object.keys(res.targets[0]), ['url', 'domain', 'wordCount', 'clickDepth'], 'the MCP field order');
  assert.deepEqual(res.byDomain, {
    'helius.dev': [
      { url: 'https://helius.dev/', wordCount: 300, clickDepth: 0 },
      { url: 'https://helius.dev/floor-plus-one', wordCount: 81, clickDepth: 1 },
      { url: 'https://helius.dev/ceiling', wordCount: 700, clickDepth: 2 },
    ],
    'quicknode.com': [
      { url: 'https://quicknode.com/guides/short', wordCount: 200, clickDepth: 1 },
    ],
  }, 'byDomain keeps the targets order within each domain, in the CLI JSON shape');

  const narrow = findShallowPages(db, P, { maxWords: '300', maxDepth: '1' });
  assert.deepEqual(urls(narrow.targets), [
    'https://helius.dev/',
    'https://helius.dev/floor-plus-one',
    'https://quicknode.com/guides/short',
  ], 'both ceilings are inclusive and read from strings');

  assert.deepEqual(urls(findShallowPages(db, P, { maxDepth: 0 }).targets), ['https://helius.dev/'],
    'maxDepth 0 means the homepage only, not the default');
  assert.equal(findShallowPages(db, P, { maxDepth: 'deep' }).totalTargets, 4, 'a garbled option takes the default');
  assert.equal(findShallowPages(db, 'nobody', {}).totalTargets, 0);
  assert.deepEqual(findShallowPages(db, 'nobody', {}).byDomain, {});
}

// ── findDecayingPages ──────────────────────────────────────────────────────
{
  const { db, page } = freshDb();
  // confirmedStale candidates; cutoff at 18 months is 2025-03-27
  page('helius.dev', 'https://helius.dev/docs/old-deep', { words: 500, depth: 2, modified: '2022-06-01' });
  page('helius.dev', 'https://helius.dev/blog/old-shallow', { words: 250, depth: 1, modified: '2023-01-10' });
  page('helius.dev', 'https://helius.dev/day-before', { words: 400, depth: 1, modified: '2025-03-26' });
  page('helius.dev', 'https://helius.dev/on-cutoff', { words: 400, depth: 1, modified: '2025-03-27' });
  page('helius.dev', 'https://helius.dev/cutoff-timestamp', { words: 400, depth: 1, modified: '2025-03-27T08:00:00Z' });
  page('helius.dev', 'https://helius.dev/fresh', { words: 400, depth: 1, modified: '2026-01-01' });
  page('helius.dev', 'https://helius.dev/stale-100', { words: 100, depth: 1, modified: '2020-01-01' });
  page('helius.dev', 'https://helius.dev/stale-101', { words: 101, depth: 1, modified: '2020-01-01' });
  page('helius.dev', 'https://helius.dev/stale-deep', { words: 500, depth: 3, modified: '2020-01-01' });
  page('helius.dev', 'https://helius.dev/stale-noindex', { words: 500, depth: 1, modified: '2020-01-01', indexable: 0 });
  page('helius.dev', 'https://helius.dev/login', { words: 500, depth: 1, modified: '2020-01-01' });
  page('acme.io', 'https://acme.io/stale', { words: 500, depth: 1, modified: '2020-01-01' });
  // unknownFreshness candidates: no date of either kind
  page('quicknode.com', 'https://quicknode.com/', { words: 1500, depth: 0 });
  page('quicknode.com', 'https://quicknode.com/over-max', { words: 1501, depth: 0 });
  page('quicknode.com', 'https://quicknode.com/guides/mid', { words: 800, depth: 1 });
  page('quicknode.com', 'https://quicknode.com/guides/min', { words: 300, depth: 1 });
  page('quicknode.com', 'https://quicknode.com/guides/under-min', { words: 299, depth: 1 });
  page('quicknode.com', 'https://quicknode.com/guides/deep', { words: 500, depth: 3 });
  page('quicknode.com', 'https://quicknode.com/published-only', { words: 500, depth: 1, published: '2020-01-01' });
  page('quicknode.com', 'https://quicknode.com/enterprise?plan=x', { words: 500, depth: 1 });
  page('acme.io', 'https://acme.io/undated', { words: 500, depth: 1 });

  const res = findDecayingPages(db, P, { now: NOW });
  assert.equal(res.cutoff, '2025-03-27');
  assert.equal(res.monthsThreshold, 18);
  assert.deepEqual(urls(res.confirmedStale), [
    'https://helius.dev/stale-101',
    'https://helius.dev/blog/old-shallow',
    'https://helius.dev/day-before',
    'https://helius.dev/docs/old-deep',
  ], 'shallowest first, then oldest; the cutoff day itself is not stale (the harness copy put old-deep first)');
  assert.deepEqual(res.confirmedStale[1], {
    url: 'https://helius.dev/blog/old-shallow', domain: 'helius.dev', wordCount: 250, modifiedDate: '2023-01-10', clickDepth: 1,
  });
  assert.deepEqual(Object.keys(res.confirmedStale[0]), ['url', 'domain', 'wordCount', 'modifiedDate', 'clickDepth']);

  assert.deepEqual(urls(res.unknownFreshness), [
    'https://quicknode.com/',
    'https://quicknode.com/guides/min',
    'https://quicknode.com/guides/mid',
  ], 'shallowest first, then shortest; 300 and 1500 are inclusive; a published date is a date');
  assert.deepEqual(res.unknownFreshness[0], { url: 'https://quicknode.com/', domain: 'quicknode.com', wordCount: 1500, clickDepth: 0 });
  assert.deepEqual(Object.keys(res.unknownFreshness[0]), ['url', 'domain', 'wordCount', 'clickDepth']);

  const now0 = findDecayingPages(db, P, { now: NOW, months: '0' });
  assert.equal(now0.monthsThreshold, 0, 'months 0 is kept (the harness turned it into 18)');
  assert.ok(urls(now0.confirmedStale).includes('https://helius.dev/fresh'), 'with months 0 anything dated before today is stale');
  assert.ok(urls(now0.confirmedStale).includes('https://helius.dev/cutoff-timestamp'));

  assert.equal(findDecayingPages(db, P, { now: NOW, months: 'x' }).monthsThreshold, 18, 'a garbled months takes the default');
  assert.equal(findDecayingPages(db, P, { now: new Date(NOW), months: 12 }).cutoff, '2025-09-27');
}

// ── findDecayingPages: the undated cap ─────────────────────────────────────
{
  const { db, page } = freshDb();
  // 25 qualifying undated pages: 18 at depth 1, then 7 shorter ones at depth 2.
  // Depth sorts first, so the cap keeps all of depth 1 and the two shortest of
  // depth 2 — under the harness's word-count-only order it kept the reverse.
  for (let i = 0; i < 25; i++) {
    page('helius.dev', `https://helius.dev/undated-${String(i).padStart(2, '0')}`, { words: 300 + (24 - i) * 10, depth: i < 18 ? 1 : 2 });
  }
  const res = findDecayingPages(db, P, { now: NOW });
  assert.equal(res.unknownFreshness.length, BOUNDS.undatedLimit);
  assert.equal(res.unknownFreshness[0].url, 'https://helius.dev/undated-17', 'depth 1 comes before the shorter depth-2 pages');
  assert.deepEqual(
    urls(res.unknownFreshness).slice(-2),
    ['https://helius.dev/undated-24', 'https://helius.dev/undated-23'],
    'the cap cuts the depth-2 tail, shortest kept',
  );

  // The cap applies before the content-page filter (every copy did this), so
  // an app route among the first 20 costs a slot. Pinned so a change is deliberate.
  page('helius.dev', 'https://helius.dev/signup', { words: 300, depth: 0 });
  assert.equal(findDecayingPages(db, P, { now: NOW }).unknownFreshness.length, BOUNDS.undatedLimit - 1);
}

// ── auditCompetitorHeadings ────────────────────────────────────────────────
{
  const { db, page } = freshDb();
  page('helius.dev', 'https://helius.dev/', {
    words: 1500, depth: 0,
    headings: [[1, 'Helius RPC'], [2, 'Webhooks'], [4, 'Payloads'], [2, 'DAS API']],
  });
  page('helius.dev', 'https://helius.dev/blog/short', { words: 250, depth: 1, headings: [[1, 'Priority fees']] });
  page('helius.dev', 'https://helius.dev/docs/long', { words: 900, depth: 1, headings: [[1, 'Geyser'], [3, 'gRPC']] });
  // Longer than the homepage but one click deeper: depth has to sort before
  // length for the homepage to stay first.
  page('helius.dev', 'https://helius.dev/docs/huge', { words: 2000, depth: 1, headings: [[1, 'Huge']] });
  page('helius.dev', 'https://helius.dev/no-headings', { words: 1000, depth: 1 });
  page('helius.dev', 'https://helius.dev/at-floor', { words: 200, depth: 1, headings: [[1, 'Too short']] });
  page('helius.dev', 'https://helius.dev/too-deep', { words: 900, depth: 3, headings: [[1, 'Deep']] });
  page('helius.dev', 'https://helius.dev/noindex', { words: 900, depth: 1, indexable: 0, headings: [[1, 'Hidden']] });
  page('helius.dev', 'https://helius.dev/dashboard/home', { words: 900, depth: 1, headings: [[1, 'App']] });
  page('quicknode.com', 'https://quicknode.com/', { words: 1300, depth: 0, headings: [[1, 'QuickNode'], [2, 'Streams']] });
  page('acme.io', 'https://acme.io/', { words: 1300, depth: 0, headings: [[1, 'Acme']] });

  const res = auditCompetitorHeadings(db, P, {});
  assert.deepEqual(urls(res.pages), [
    'https://helius.dev/',
    'https://helius.dev/docs/huge',
    'https://helius.dev/docs/long',
    'https://helius.dev/blog/short',
    'https://quicknode.com/',
  ], 'by domain, then shallowest, then longest (the harness copy had no word-count tiebreak)');
  assert.equal(res.totalPages, 5);
  assert.equal(res.candidateCount, 6, 'the page without headings was a candidate, then dropped');
  assert.equal(res.maxDepth, DEFAULTS.depth);
  assert.equal(res.domain, null);
  assert.deepEqual(res.pages[0], {
    url: 'https://helius.dev/', domain: 'helius.dev', wordCount: 1500, clickDepth: 0,
    headings: [
      { level: 1, text: 'Helius RPC' }, { level: 2, text: 'Webhooks' },
      { level: 4, text: 'Payloads' }, { level: 2, text: 'DAS API' },
    ],
  }, 'every level, in document order');
  assert.deepEqual(Object.keys(res.pages[0]), ['url', 'domain', 'wordCount', 'clickDepth', 'headings']);

  const one = auditCompetitorHeadings(db, P, { domain: 'quicknode.com' });
  assert.deepEqual(urls(one.pages), ['https://quicknode.com/']);
  assert.equal(one.domain, 'quicknode.com');

  assert.deepEqual(urls(auditCompetitorHeadings(db, P, { depth: '0' }).pages),
    ['https://helius.dev/', 'https://quicknode.com/'], 'depth 0 means homepages only, not the default');

  const none = auditCompetitorHeadings(db, P, { domain: 'acme.io' });
  assert.equal(none.candidateCount, 0, 'the target is not a competitor even when named');
  assert.deepEqual(none.pages, []);
}

// ── auditCompetitorHeadings: the cap of 30 ─────────────────────────────────
{
  const { db, page } = freshDb();
  // 31 candidates, longest first; the longest has no headings
  for (let i = 0; i < 31; i++) {
    page('helius.dev', `https://helius.dev/p-${String(i).padStart(2, '0')}`, {
      words: 2000 - i, depth: 1, headings: i === 0 ? [] : [[1, `Page ${i}`]],
    });
  }
  const res = auditCompetitorHeadings(db, P, {});
  assert.equal(res.candidateCount, 31);
  assert.equal(res.totalPages, BOUNDS.headingsPageCap - 1,
    'the cap is on candidates read, so the headingless one costs a slot and p-30 is never read');
  assert.equal(res.pages[0].url, 'https://helius.dev/p-01');
  assert.ok(!urls(res.pages).includes('https://helius.dev/p-30'));
}

// ── an empty project ───────────────────────────────────────────────────────
{
  const { db } = freshDb();
  assert.deepEqual(findShallowPages(db, P, {}), { targets: [], totalTargets: 0, byDomain: {}, maxWords: 700, maxDepth: 2 });
  const decay = findDecayingPages(db, P, { now: NOW });
  assert.deepEqual([decay.confirmedStale, decay.unknownFreshness], [[], []]);
  assert.deepEqual(auditCompetitorHeadings(db, P, {}), { pages: [], totalPages: 0, candidateCount: 0, maxDepth: 2, domain: null });
}

console.log('competitor pages: PASS');
