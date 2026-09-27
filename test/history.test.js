/**
 * history — getCrawlBrief and getPublishingVelocity against an in-memory
 * database built from db/schema.sql.
 *
 * Every window bound gets a page on each side of it: first seen one
 * millisecond after the cutoff and exactly at it, crawled after it and exactly
 * at it, a published_date equal to the cutoff date and an ISO timestamp on that
 * same day (text comparison makes those differ). Every exclusion gets a page
 * that would otherwise count — noindex, a login route, an app subdomain, a
 * query-string URL, a competitor the config no longer lists, a domain row
 * belonging to another project — so a filter that goes missing fails here
 * instead of in a golden diff. The orders asserted are the CLI's, because that
 * is where the CLI and harness copies disagreed: new pages newest first,
 * re-crawled pages most recent first, velocity rows competitor, owned, target,
 * and the own-site list in the insertion order the CLI's unordered query
 * returned. The keyword comparison asserted is the CLI's too, false gaps
 * included, so a fix to it has to change this file on purpose. The brief's
 * gap bounds get a case on each side as well — a three-character keyword and
 * one that is two only after the trim, the 10th- and 11th-newest new pages,
 * twelve candidate gaps against a limit of ten — written as literal numbers,
 * so a test cannot follow a changed BOUNDS constant to its new value.
 * Each block builds its own database so one command's seed cannot satisfy
 * another's assertion by accident. The clock is fixed at noon UTC.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOUNDS,
  DEFAULTS,
  briefActions,
  briefForHarness,
  getCrawlBrief,
  getPublishingVelocity,
  normalizeKeyword,
  ratePerWeek,
  velocityForHarness,
  windowDays,
} from '../analyses/history/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const P = 'fx';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 27, 12, 0, 0); // 2026-09-27 noon UTC
const LONG_AGO = NOW - 400 * DAY;

function freshDb(domains) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const addDomain = db.prepare('INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, 0)');
  for (const [domain, role, project = P] of domains) addDomain.run(domain, project, role);
  const domainId = db.prepare('SELECT id FROM domains WHERE domain = ?');
  const insPage = db.prepare(`
    INSERT INTO pages (domain_id, url, crawled_at, first_seen_at, word_count, is_indexable, published_date, modified_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insKeyword = db.prepare("INSERT INTO keywords (page_id, keyword, location) VALUES (?, ?, 'body')");
  const insExtraction = db.prepare('INSERT INTO extractions (page_id, schema_types, extracted_at) VALUES (?, ?, 0)');
  const page = (domain, url, {
    first = LONG_AGO, crawled = first, words = 500, indexable = 1,
    published = null, modified = null, keywords = [], schemas = null,
  } = {}) => {
    const { id } = domainId.get(domain);
    const pageId = Number(insPage.run(id, url, crawled, first, words, indexable, published, modified).lastInsertRowid);
    for (const k of keywords) insKeyword.run(pageId, k);
    if (schemas) insExtraction.run(pageId, JSON.stringify(schemas));
    return pageId;
  };
  return { db, page };
}

const urls = list => list.map(r => r.url);

// ── pure helpers ───────────────────────────────────────────────────────────
{
  assert.equal(DEFAULTS.briefDays, 7);
  assert.equal(DEFAULTS.velocityDays, 30);
  // The brief's bounds, as numbers. The gap blocks below test each one from
  // both sides with literal fixtures; this pins the constants they come from.
  assert.deepEqual({ ...BOUNDS }, { gapPagesPerCompetitor: 10, keywordGapLimit: 10, minKeywordLength: 3 });

  assert.equal(windowDays('14', 7), 14, 'a commander string parses');
  assert.equal(windowDays(30, 7), 30, 'an MCP number passes');
  for (const bad of [undefined, null, '', 'abc', 0, '0', -7]) {
    assert.equal(windowDays(bad, 7), 7, `${JSON.stringify(bad)} takes the default`);
  }

  assert.equal(ratePerWeek(3, 30), 0.7, '3 pages over 30 days, one decimal');
  assert.equal(ratePerWeek(4, 28), 1);
  assert.equal(ratePerWeek(0, 30), 0);
  assert.equal(ratePerWeek(5, 0), 0, 'an empty window is 0, not Infinity');

  assert.equal(normalizeKeyword('  Solana RPC '), 'solana rpc', 'a competitor keyword is lowered and trimmed');
  assert.equal(normalizeKeyword('ÖLJA'), 'ölja', 'non-ASCII capitals fold too, on the competitor side');

  // The publishing-rate action names the fastest competitor, config order on a tie.
  const moves = [
    { domain: 'b.dev', newPages: [{}, {}] },
    { domain: 'a.dev', newPages: [{}, {}] },
  ];
  assert.deepEqual(
    briefActions({ keywordGaps: [], schemaGaps: [], competitorMoves: moves, targetNewPages: 1 }),
    ['Increase publishing rate — b.dev published 2 pages vs your 1'],
  );
  assert.deepEqual(
    briefActions({ keywordGaps: [], schemaGaps: [], competitorMoves: moves, targetNewPages: 2 }),
    ['Re-crawl competitors to detect new content', 'Review dashboard for technical SEO fixes'],
    'matching the fastest competitor is not behind: the standing suggestions come back',
  );
}

// ── getCrawlBrief: new, changed and own-site pages ─────────────────────────
{
  const { db, page } = freshDb([
    ['acme.io', 'target'],
    ['docs.acme.io', 'owned'],
    ['helius.dev', 'competitor'],
    ['quicknode.com', 'competitor'],
    ['triton.one', 'competitor'],                // in the DB, no longer in the config
    ['other.dev', 'competitor', 'other'],        // in the config, but another project's row
  ]);
  const cutoff = NOW - 7 * DAY;
  const config = {
    target: { domain: 'acme.io' },
    owned: [{ domain: 'docs.acme.io' }],
    competitors: [{ domain: 'quicknode.com' }, { domain: 'helius.dev' }, { domain: 'other.dev' }],
  };

  // helius.dev: both sides of every bound
  page('helius.dev', 'https://helius.dev/blog/newer', { first: cutoff + 1, crawled: NOW, words: 800 });
  page('helius.dev', 'https://helius.dev/blog/newest', { first: cutoff + 3 * DAY, crawled: NOW - DAY, words: 900 });
  page('helius.dev', 'https://helius.dev/blog/on-cutoff', { first: cutoff, crawled: NOW });
  page('helius.dev', 'https://helius.dev/docs/recrawled', { first: cutoff - 1, crawled: cutoff + 1, words: 300 });
  page('helius.dev', 'https://helius.dev/docs/recrawled-later', { first: LONG_AGO, crawled: NOW - 2 * DAY, words: 400 });
  page('helius.dev', 'https://helius.dev/docs/not-recrawled', { first: LONG_AGO, crawled: cutoff });
  page('helius.dev', 'https://helius.dev/blog/new-noindex', { first: cutoff + DAY, crawled: NOW, indexable: 0 });
  page('helius.dev', 'https://helius.dev/login', { first: cutoff + DAY, crawled: NOW });
  page('helius.dev', 'https://helius.dev/blog/newest?ref=x', { first: cutoff + DAY, crawled: NOW });
  page('helius.dev', 'https://app.helius.dev/settings', { first: LONG_AGO, crawled: NOW });
  page('helius.dev', 'https://helius.dev/docs/old-noindex', { first: LONG_AGO, crawled: NOW, indexable: 0 });

  page('quicknode.com', 'https://quicknode.com/guides/old', { first: LONG_AGO, crawled: cutoff - DAY });
  page('triton.one', 'https://triton.one/blog/new', { first: NOW - DAY, crawled: NOW });
  page('other.dev', 'https://other.dev/blog/new', { first: NOW - DAY, crawled: NOW });

  // own site: one content page each is new; the target also gains a login
  // route and a noindex page, which targetNewPages counts and ownMoves does not
  page('acme.io', 'https://acme.io/blog/ours-new', { first: cutoff + DAY, crawled: NOW, words: 1200 });
  page('acme.io', 'https://acme.io/login', { first: cutoff + DAY, crawled: NOW });
  page('acme.io', 'https://acme.io/blog/ours-noindex', { first: cutoff + DAY, crawled: NOW, indexable: 0 });
  page('acme.io', 'https://acme.io/old', { first: LONG_AGO, crawled: NOW });
  page('docs.acme.io', 'https://docs.acme.io/start', { first: cutoff + 2 * DAY, crawled: NOW, words: 700 });

  const r = getCrawlBrief(db, P, { config, now: NOW });

  assert.deepEqual(r.period, { days: 7, cutoff: '2026-09-20', weekOf: '2026-09-27' });
  assert.equal(r.targetDomain, 'acme.io');
  assert.deepEqual(r.competitorMoves.map(m => m.domain), ['quicknode.com', 'helius.dev', 'other.dev'],
    'every configured competitor in config order, quiet ones included; triton.one is not configured');

  const helius = r.competitorMoves[1];
  assert.deepEqual(helius.newPages, [
    { url: 'https://helius.dev/blog/newest', wordCount: 900 },
    { url: 'https://helius.dev/blog/newer', wordCount: 800 },
  ], 'newest first; on-cutoff, noindex, login and query-string pages are not new pages');
  assert.deepEqual(urls(helius.changedPages), [
    'https://helius.dev/docs/recrawled-later',
    'https://helius.dev/docs/recrawled',
  ], 'most recently crawled first; not-recrawled, the app subdomain and the noindex page drop out');
  assert.ok(!urls(helius.changedPages).includes('https://helius.dev/blog/on-cutoff'),
    'first seen exactly at the cutoff is neither new nor changed');

  assert.deepEqual(r.competitorMoves[0], { domain: 'quicknode.com', newPages: [], changedPages: [] });
  assert.deepEqual(r.competitorMoves[2], { domain: 'other.dev', newPages: [], changedPages: [] },
    'a domain row of another project is not this project\'s competitor');

  assert.deepEqual(r.ownMoves, [
    { domain: 'acme.io', newPages: [{ url: 'https://acme.io/blog/ours-new', wordCount: 1200 }] },
    { domain: 'docs.acme.io', newPages: [{ url: 'https://docs.acme.io/start', wordCount: 700 }] },
  ]);
  assert.equal(r.targetNewPages, 3, 'the CLI\'s count is unfiltered: login and noindex pages count');

  assert.deepEqual(r.keywordGaps, []);
  assert.deepEqual(r.schemaGaps, []);
  assert.deepEqual(r.actions, ['Re-crawl competitors to detect new content', 'Review dashboard for technical SEO fixes'],
    'helius found 2 new pages against the target\'s 3, so no publishing-rate action');

  assert.deepEqual(briefForHarness(r), {
    competitorMoves: r.competitorMoves,
    period: { days: 7, weekOf: '2026-09-27' },
  }, 'the harness contract is the moves and the window, nothing more');
  assert.deepEqual(Object.keys(briefForHarness(r).competitorMoves[1]), ['domain', 'newPages', 'changedPages']);

  // A wider window, passed as commander passes it, reaches further back.
  const wide = getCrawlBrief(db, P, { config, now: NOW, days: '400' });
  assert.equal(wide.period.days, 400);
  assert.ok(urls(wide.competitorMoves[1].newPages).includes('https://helius.dev/blog/on-cutoff'));
  assert.equal(getCrawlBrief(db, P, { config, now: new Date(NOW), days: 0 }).period.days, 7,
    'a Date is accepted for now; a zero-day window takes the default');

  // A config without competitors (or owned) is an empty brief, not a TypeError.
  const bare = getCrawlBrief(db, P, { config: { target: { domain: 'acme.io' } }, now: NOW });
  assert.deepEqual(bare.competitorMoves, []);
  assert.deepEqual(urls(bare.ownMoves[0].newPages), ['https://acme.io/blog/ours-new']);
  const none = getCrawlBrief(db, 'no-such-project-history-test', { now: NOW });
  assert.equal(none.targetDomain, null);
  assert.deepEqual([none.competitorMoves, none.ownMoves, none.targetNewPages], [[], [], 0]);
}

// ── getCrawlBrief: keyword and schema gaps, actions ────────────────────────
{
  const { db, page } = freshDb([
    ['acme.io', 'target'],
    ['docs.acme.io', 'owned'],
    ['helius.dev', 'competitor'],
    ['quicknode.com', 'competitor'],
  ]);
  const cutoff = NOW - 7 * DAY;
  const HOUR = 60 * 60 * 1000;
  const config = {
    target: { domain: 'acme.io' },
    owned: [{ domain: 'docs.acme.io' }],
    competitors: [{ domain: 'helius.dev' }, { domain: 'quicknode.com' }],
  };

  // What the own side already covers, read as the CLI reads it: LOWER in SQL,
  // no trim. 'Solana RPC' and 'webhooks guide' cover the competitors' spellings
  // of them. ' zk compression' (stored untrimmed, as insertKeywords stores what
  // the extractor returns) and 'ÖLJA' (SQLite's LOWER folds ASCII only, so it
  // reads 'Ölja') do not: the two false gaps the header keeps for their own
  // change. Normalising the own side here would drop both from keywordGaps.
  page('acme.io', 'https://acme.io/', { keywords: ['Solana RPC', 'ÖLJA', ' zk compression'], schemas: ['Organization'] });
  page('docs.acme.io', 'https://docs.acme.io/', { keywords: ['webhooks guide'] });

  // ' ab ' is two characters only after the trim, so it is noise; 'api' is
  // exactly three and is a gap. Together they pin the length floor as
  // inclusive and measured after normalizeKeyword.
  page('helius.dev', 'https://helius.dev/blog/h1', {
    first: cutoff + 5 * DAY, crawled: NOW,
    keywords: ['Streams API', ' solana rpc ', ' ab ', 'api', 'ölja', 'Webhooks Guide', 'zk compression'],
    schemas: ['Organization', 'FAQPage'],
  });
  page('helius.dev', 'https://helius.dev/blog/h2', {
    first: cutoff + 4 * DAY, crawled: NOW, keywords: ['geyser plugin', 'streams api'], schemas: ['HowTo'],
  });
  page('helius.dev', 'https://helius.dev/blog/changed', {
    first: LONG_AGO, crawled: NOW, keywords: ['only on a changed page'], schemas: ['Event'],
  });
  page('helius.dev', 'https://helius.dev/blog/hidden', {
    first: cutoff + 4 * DAY, crawled: NOW, indexable: 0, keywords: ['only on a noindex page'], schemas: ['Course'],
  });
  page('helius.dev', 'https://helius.dev/signup', {
    first: cutoff + 4 * DAY, crawled: NOW, keywords: ['only on a signup page'],
  });

  // quicknode.com: eleven new pages; only the ten newest are read for gaps.
  // The tenth newest carries a keyword and a schema of its own, so the bound
  // is pinned from both sides: q10 is read, q11 is not.
  page('quicknode.com', 'https://quicknode.com/blog/q1', {
    first: cutoff + 3 * DAY, crawled: NOW, keywords: ['geyser plugin'], schemas: ['FAQPage'],
  });
  for (let i = 2; i <= 9; i++) {
    page('quicknode.com', `https://quicknode.com/blog/q${i}`, { first: cutoff + 2 * DAY - i * HOUR, crawled: NOW });
  }
  page('quicknode.com', 'https://quicknode.com/blog/q10', {
    first: cutoff + 2 * DAY - 10 * HOUR, crawled: NOW, keywords: ['only on the tenth page'], schemas: ['Dataset'],
  });
  page('quicknode.com', 'https://quicknode.com/blog/q11', {
    first: cutoff + 1, crawled: NOW, keywords: ['only on the eleventh page'], schemas: ['Recipe'],
  });

  const r = getCrawlBrief(db, P, { config, now: NOW });

  assert.equal(r.competitorMoves[1].newPages.length, 11, 'all eleven are new pages');
  assert.deepEqual(r.keywordGaps, [
    { keyword: 'geyser plugin', domains: ['helius.dev', 'quicknode.com'], count: 2 },
    { keyword: 'streams api', domains: ['helius.dev'], count: 1 },
    { keyword: 'api', domains: ['helius.dev'], count: 1 },
    { keyword: 'ölja', domains: ['helius.dev'], count: 1 },
    { keyword: 'zk compression', domains: ['helius.dev'], count: 1 },
    { keyword: 'only on the tenth page', domains: ['quicknode.com'], count: 1 },
  ], 'most competitors first, first found first on a tie; own keywords in any ASCII case and competitor keywords '
    + 'in any padding are covered; three characters is enough, two after the trim is not; the 10th-newest page '
    + 'is read; changed, noindex, app and 11th-newest pages excluded');
  assert.deepEqual(r.schemaGaps, [
    { schema: 'FAQPage', domains: ['helius.dev', 'quicknode.com'] },
    { schema: 'HowTo', domains: ['helius.dev'] },
    { schema: 'Dataset', domains: ['quicknode.com'] },
  ], 'every one found, in the order found; the 10th-newest page is read, the 11th (Recipe) is not');
  assert.equal(r.targetNewPages, 0);
  assert.deepEqual(r.actions, [
    'Write content covering "geyser plugin" — 2 competitor(s) rank for it',
    'Add FAQPage schema markup to relevant pages (helius.dev already has it)',
    'Increase publishing rate — quicknode.com published 11 pages vs your 0',
  ]);
}

// ── getCrawlBrief: the keyword-gap cap ─────────────────────────────────────
{
  const { db, page } = freshDb([['acme.io', 'target'], ['helius.dev', 'competitor']]);
  // Literal numbers, not BOUNDS: the brief promises the top ten, and a test
  // that reads the constant under test would follow it to eleven.
  const many = Array.from({ length: 12 }, (_, i) => `topic number ${i + 1}`);
  page('helius.dev', 'https://helius.dev/blog/wide', { first: NOW - DAY, crawled: NOW, keywords: many });
  const r = getCrawlBrief(db, P, { config: { target: { domain: 'acme.io' }, competitors: [{ domain: 'helius.dev' }] }, now: NOW });
  assert.equal(r.keywordGaps.length, 10, 'twelve candidates, ten kept');
  assert.deepEqual(r.keywordGaps.map(g => g.keyword), many.slice(0, 10),
    'at most ten, in the order found when every count ties');

  // Equal first-seen times keep insertion order, not URL order.
  page('helius.dev', 'https://helius.dev/blog/zz-first-inserted', { first: NOW - 2 * DAY, crawled: NOW });
  page('helius.dev', 'https://helius.dev/blog/aa-second-inserted', { first: NOW - 2 * DAY, crawled: NOW });
  const tied = getCrawlBrief(db, P, { config: { competitors: [{ domain: 'helius.dev' }] }, now: NOW });
  assert.deepEqual(urls(tied.competitorMoves[0].newPages), [
    'https://helius.dev/blog/wide',
    'https://helius.dev/blog/zz-first-inserted',
    'https://helius.dev/blog/aa-second-inserted',
  ]);
}

// ── getCrawlBrief: the order of Your Site ──────────────────────────────────
{
  // The CLI's own-site query had no ORDER BY and SQLite read it through
  // idx_pages_domain, so Your Site listed pages in insertion order. The pages
  // go in out of date order here, so insertion order, newest first and oldest
  // first are three different lists; a competitor gets the same four pages to
  // show that its list, unlike Your Site, is newest first.
  const { db, page } = freshDb([['acme.io', 'target'], ['docs.acme.io', 'owned'], ['helius.dev', 'competitor']]);
  for (const d of [4, 6, 3, 5]) {
    page('acme.io', `https://acme.io/blog/own-${d}`, { first: NOW - d * DAY, crawled: NOW });
    page('helius.dev', `https://helius.dev/blog/their-${d}`, { first: NOW - d * DAY, crawled: NOW });
  }
  page('docs.acme.io', 'https://docs.acme.io/b', { first: NOW - 2 * DAY, crawled: NOW });
  page('docs.acme.io', 'https://docs.acme.io/a', { first: NOW - DAY, crawled: NOW });
  page('acme.io', 'https://acme.io/login', { first: NOW - DAY, crawled: NOW });
  page('acme.io', 'https://acme.io/blog/own-noindex', { first: NOW - DAY, crawled: NOW, indexable: 0 });
  page('acme.io', 'https://acme.io/blog/own-old', { first: LONG_AGO, crawled: NOW });

  const r = getCrawlBrief(db, P, {
    config: { target: { domain: 'acme.io' }, owned: [{ domain: 'docs.acme.io' }], competitors: [{ domain: 'helius.dev' }] },
    now: NOW,
  });
  assert.deepEqual(r.ownMoves.map(m => [m.domain, urls(m.newPages)]), [
    ['acme.io', ['https://acme.io/blog/own-4', 'https://acme.io/blog/own-6', 'https://acme.io/blog/own-3', 'https://acme.io/blog/own-5']],
    ['docs.acme.io', ['https://docs.acme.io/b', 'https://docs.acme.io/a']],
  ], 'Your Site is in insertion order, as the CLI printed it; login, noindex and old pages are not new');
  assert.deepEqual(urls(r.competitorMoves[0].newPages), [
    'https://helius.dev/blog/their-3', 'https://helius.dev/blog/their-4',
    'https://helius.dev/blog/their-5', 'https://helius.dev/blog/their-6',
  ], 'a competitor\'s new pages are newest first');
}

// ── getPublishingVelocity ──────────────────────────────────────────────────
{
  const { db, page } = freshDb([
    ['acme.io', 'target'],
    ['docs.acme.io', 'owned'],
    ['helius.dev', 'competitor'],
    ['quicknode.com', 'competitor'],
    ['triton.one', 'competitor'],               // only a noindex page: no row at all
    ['other.dev', 'competitor', 'other'],
  ]);
  const days = 28;                               // four weeks, so rates are round
  const cutoff = NOW - days * DAY;               // 2026-08-30T12:00Z

  // helius.dev: discovery only — four content pages first seen in the window
  for (let i = 1; i <= 4; i++) {
    page('helius.dev', `https://helius.dev/blog/h${i}`, { first: cutoff + i * DAY, words: 100 * i });
  }
  page('helius.dev', 'https://helius.dev/blog/on-cutoff', { first: cutoff });
  page('helius.dev', 'https://helius.dev/login', { first: cutoff + DAY });           // total, not new
  page('helius.dev', 'https://helius.dev/blog/noindex', { first: cutoff + DAY, indexable: 0 });
  page('helius.dev', 'https://helius.dev/old', {});

  // quicknode.com: crawled long ago, dates only
  page('quicknode.com', 'https://quicknode.com/blog/future', { published: '2026-10-01' });
  page('quicknode.com', 'https://quicknode.com/blog/sept', { published: '2026-09-10', words: 900 });
  page('quicknode.com', 'https://quicknode.com/blog/cutoff-day-ts', { published: '2026-08-30T08:00:00Z' });
  page('quicknode.com', 'https://quicknode.com/blog/cutoff-day', { published: '2026-08-30' });
  page('quicknode.com', 'https://quicknode.com/blog/before', { published: '2026-08-29' });
  page('quicknode.com', 'https://quicknode.com/signup', { published: '2026-09-15' });
  page('quicknode.com', 'https://quicknode.com/blog/noindex', { published: '2026-09-15', indexable: 0 });

  // acme.io: one page, both new and dated — counted once, not twice
  page('acme.io', 'https://acme.io/blog/launch', { first: cutoff + 10 * DAY, published: '2026-09-20', words: 1200 });
  page('acme.io', 'https://acme.io/', {});
  page('docs.acme.io', 'https://docs.acme.io/start', {});
  page('triton.one', 'https://triton.one/blog/hidden', { first: NOW - DAY, indexable: 0 });
  page('other.dev', 'https://other.dev/blog/new', { first: NOW - DAY, published: '2026-09-20' });

  const r = getPublishingVelocity(db, P, { now: NOW, days });

  assert.deepEqual(r.period, { days: 28, cutoff: '2026-08-30T12:00:00.000Z' });
  assert.deepEqual(r.velocities, [
    { domain: 'helius.dev', role: 'competitor', total: 7, newCount: 4, pubCount: 0, ratePerWeek: 1 },
    { domain: 'quicknode.com', role: 'competitor', total: 6, newCount: 0, pubCount: 3, ratePerWeek: 0.8 },
    { domain: 'docs.acme.io', role: 'owned', total: 1, newCount: 0, pubCount: 0, ratePerWeek: 0 },
    { domain: 'acme.io', role: 'target', total: 2, newCount: 1, pubCount: 1, ratePerWeek: 0.3 },
  ], 'role then domain; rate on the larger signal; totals count every indexable page, app routes included');

  assert.deepEqual(r.recentlyPublished, [
    { url: 'https://quicknode.com/blog/future', domain: 'quicknode.com', role: 'competitor', publishedDate: '2026-10-01', wordCount: 500 },
    { url: 'https://acme.io/blog/launch', domain: 'acme.io', role: 'target', publishedDate: '2026-09-20', wordCount: 1200 },
    { url: 'https://quicknode.com/blog/sept', domain: 'quicknode.com', role: 'competitor', publishedDate: '2026-09-10', wordCount: 900 },
    { url: 'https://quicknode.com/blog/cutoff-day-ts', domain: 'quicknode.com', role: 'competitor', publishedDate: '2026-08-30T08:00:00Z', wordCount: 500 },
  ], 'latest first; a bare date equal to the cutoff date and anything before it are out, a timestamp on that day is in');

  assert.deepEqual(r.newPages.map(p => [p.url, p.firstSeen]), [
    ['https://acme.io/blog/launch', cutoff + 10 * DAY],
    ['https://helius.dev/blog/h4', cutoff + 4 * DAY],
    ['https://helius.dev/blog/h3', cutoff + 3 * DAY],
    ['https://helius.dev/blog/h2', cutoff + 2 * DAY],
    ['https://helius.dev/blog/h1', cutoff + DAY],
  ], 'newest first; on-cutoff, login, noindex and other-project pages are not new');
  assert.deepEqual(r.newPages[1], { url: 'https://helius.dev/blog/h4', domain: 'helius.dev', role: 'competitor', firstSeen: cutoff + 4 * DAY, wordCount: 400 });

  assert.equal(r.leader.domain, 'helius.dev');
  assert.equal(r.target.domain, 'acme.io');

  assert.deepEqual(velocityForHarness(r), {
    velocities: [
      { domain: 'helius.dev', role: 'competitor', totalPages: 7, newPages: 4, ratePerWeek: 1 },
      { domain: 'quicknode.com', role: 'competitor', totalPages: 6, newPages: 0, ratePerWeek: 0.8 },
      { domain: 'docs.acme.io', role: 'owned', totalPages: 1, newPages: 0, ratePerWeek: 0 },
      { domain: 'acme.io', role: 'target', totalPages: 2, newPages: 1, ratePerWeek: 0.3 },
    ],
    period: { days: 28, cutoff: '2026-08-30T12:00:00.000Z' },
  }, 'the harness keeps its field names; the rate and the order are the CLI\'s');

  // The default window is 30 days: the page on the 28-day cutoff is now inside it.
  const month = getPublishingVelocity(db, P, { now: NOW });
  assert.equal(month.period.days, 30);
  const heliusMonth = month.velocities.find(v => v.domain === 'helius.dev');
  assert.deepEqual([heliusMonth.newCount, heliusMonth.ratePerWeek], [5, 1.2], '5 pages over 30 days');
}

// ── getPublishingVelocity: the leader on a tie, and an empty project ────────
{
  const { db, page } = freshDb([['zeta.dev', 'competitor'], ['alpha.dev', 'competitor'], ['acme.io', 'target']]);
  page('zeta.dev', 'https://zeta.dev/a', { first: NOW - DAY });
  page('alpha.dev', 'https://alpha.dev/a', { first: NOW - DAY });
  page('acme.io', 'https://acme.io/', {});
  const r = getPublishingVelocity(db, P, { now: NOW });
  assert.deepEqual(r.velocities.map(v => v.domain), ['alpha.dev', 'zeta.dev', 'acme.io']);
  assert.equal(r.leader.domain, 'alpha.dev', 'equal rates: the first by domain leads');

  const empty = getPublishingVelocity(db, 'nobody', { now: NOW });
  assert.deepEqual([empty.velocities, empty.recentlyPublished, empty.newPages, empty.leader, empty.target], [[], [], [], null, null]);
}

console.log('history: PASS');
