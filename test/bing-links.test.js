/**
 * bing-links — the Bing Webmaster transport (URL building, tolerant readers,
 * error mapping, site matching), the backlinks origin column, and the fetch
 * run against a fake Bing.
 *
 * Nothing here reaches the network: fetch is always a mock, and the API key
 * is a literal. The database is an in-memory DatabaseSync with the backlinks
 * CREATE copied verbatim from db/db.js getDb(), then the exported migration
 * applied the way getDb applies it, so a schema change that breaks the Bing
 * upsert or the origin backfill breaks this test too. The last block opens a
 * temp file through getDb() itself, so getDb dropping the migration breaks
 * it as well.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BING_API,
  BingApiError,
  bingGet,
  buildBingUrl,
  classifyFailure,
  matchBingSite,
  parseWcfDate,
  readLinkCounts,
  readUrlLinks,
  readUserSites,
  unwrap,
} from '../lib/bing-api.js';
import { getDb, mergeOrigin, migrateBacklinkOrigin, upsertBingBacklinks } from '../db/db.js';
import { importBacklinks } from '../lib/backlink-import.js';
import { DEFAULTS, runBingLinks } from '../analyses/bing-links/index.js';

delete process.env.BING_WEBMASTER_API_KEY;

const KEY = 'test-key-123';
const NOW = Date.UTC(2026, 8, 27, 12, 0);
const SITE = 'https://www.acme.io/';

// The backlinks CREATE below is copied verbatim from db/db.js getDb(). Keep them identical.
const DDL = `
    CREATE TABLE IF NOT EXISTS backlinks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project        TEXT NOT NULL,
      linking_url    TEXT NOT NULL,
      linking_domain TEXT NOT NULL,
      last_crawled   TEXT,            -- as Search Console reported it
      source         TEXT,            -- export file the row came from
      imported_at    INTEGER NOT NULL,
      -- Filled in by the --live pass. NULL means "not checked", which is a
      -- different state from "checked and found missing".
      checked_at     INTEGER,
      http_status    INTEGER,
      verify_state   TEXT,            -- ok | blocked | gone | error
      link_present   INTEGER,         -- 1 | 0 | NULL when unverifiable
      rel_nofollow   INTEGER,         -- 1 when nofollow/ugc/sponsored
      target_url     TEXT,            -- recovered: GSC does not export it
      anchor_text    TEXT,            -- recovered
      UNIQUE(project, linking_url)
    );
    CREATE INDEX IF NOT EXISTS idx_backlinks_domain ON backlinks(project, linking_domain);
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'fx', 'target');
  migrateBacklinkOrigin(db);
  return db;
}

const row = (db, url) => db.prepare("SELECT * FROM backlinks WHERE project = 'fx' AND linking_url = ?").get(url);
const count = (db) => db.prepare("SELECT COUNT(*) c FROM backlinks WHERE project = 'fx'").get().c;

function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/**
 * A fake Bing. `handler(method, query)` returns a body (served as 200) or
 * { status, body }, or a promise of either (to hold one answer back and fix
 * which worker finishes first). Every call is recorded with its method and
 * query at the moment it is made.
 */
function fakeBing(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = u.pathname.split('/').pop();
    const query = Object.fromEntries(u.searchParams);
    calls.push({ method, query, init, url });
    const out = await handler(method, query);
    if (out && typeof out === 'object' && 'status' in out && 'body' in out) return response(out.status, out.body);
    return response(200, out);
  };
  return { fetch, calls };
}

const later = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));

async function rejects(promise, check) {
  let caught = null;
  try { await promise; } catch (err) { caught = err; }
  assert.ok(caught, 'expected a rejection');
  check(caught);
  return caught;
}

// ── constants ───────────────────────────────────────────────────────────────
assert.deepEqual(DEFAULTS, { maxTargetPages: 50, maxPagesPerList: 20, concurrency: 2, maxRequests: 300 });
assert.equal(BING_API.base, 'https://ssl.bing.com/webmaster/api.svc/json');
assert.equal(BING_API.keyEnv, 'BING_WEBMASTER_API_KEY');

// ── buildBingUrl ────────────────────────────────────────────────────────────
{
  const url = buildBingUrl('GetUrlLinks', {
    siteUrl: SITE, link: 'https://www.acme.io/a b?x=1&y=2', page: 0, skipped: undefined, alsoSkipped: null,
  }, 'k&y/z');
  assert.equal(url,
    'https://ssl.bing.com/webmaster/api.svc/json/GetUrlLinks?apikey=k%26y%2Fz'
    + '&siteUrl=https%3A%2F%2Fwww.acme.io%2F&link=https%3A%2F%2Fwww.acme.io%2Fa%20b%3Fx%3D1%26y%3D2&page=0',
    'the key and every URL-valued param are percent-encoded; null and undefined params are left out');
  assert.equal(buildBingUrl('GetUserSites', {}, KEY), `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${KEY}`);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('apikey'), 'k&y/z');
  assert.equal(parsed.searchParams.get('link'), 'https://www.acme.io/a b?x=1&y=2');
}

// ── unwrap and the readers: "d" or top level, any case ─────────────────────
{
  assert.deepEqual(unwrap({ d: [1] }), [1]);
  assert.deepEqual(unwrap({ D: { a: 1 } }), { a: 1 }, 'the wrapper is read case-insensitively');
  assert.deepEqual(unwrap({ Links: [] }), { Links: [] }, 'an unwrapped body is its own payload');
  assert.deepEqual(unwrap([1, 2]), [1, 2]);

  const wrapped = readLinkCounts({ d: { Links: [{ Url: 'https://www.acme.io/', Count: 12 }, { Url: 'https://www.acme.io/p', Count: '3' }], TotalPages: 4 } });
  assert.deepEqual(wrapped, { links: [{ url: 'https://www.acme.io/', count: 12 }, { url: 'https://www.acme.io/p', count: 3 }], totalPages: 4 });
  const flat = readLinkCounts({ links: [{ url: 'https://www.acme.io/', count: 1 }], totalpages: 1 });
  assert.deepEqual(flat, { links: [{ url: 'https://www.acme.io/', count: 1 }], totalPages: 1 }, 'top level, lower-case field names');
  assert.equal(readLinkCounts({ d: { Links: [] } }).totalPages, 1, 'no TotalPages: the page in hand is the only one known');
  assert.deepEqual(readLinkCounts({ d: { Links: [], TotalPages: 0 } }), { links: [], totalPages: 0 }, 'an empty list is a real answer');

  assert.deepEqual(
    readUrlLinks({ d: { Details: [{ Url: 'https://news.example.org/a', AnchorText: ' Acme ' }, { Url: 'https://x.example/b' }], TotalPages: 2 } }),
    { details: [{ url: 'https://news.example.org/a', anchor: 'Acme' }, { url: 'https://x.example/b', anchor: null }], totalPages: 2 },
  );
  assert.deepEqual(
    readUrlLinks({ details: [{ url: 'https://news.example.org/a', anchortext: 'acme' }], TOTALPAGES: 1 }),
    { details: [{ url: 'https://news.example.org/a', anchor: 'acme' }], totalPages: 1 },
  );

  assert.deepEqual(
    readUserSites({ d: [{ Url: SITE, IsVerified: true }, { Url: 'http://acme.io/', IsVerified: false }, { Url: 'https://old.acme.io/' }] }),
    [{ url: SITE, verified: true }, { url: 'http://acme.io/', verified: false }, { url: 'https://old.acme.io/', verified: true }],
    'an absent IsVerified is not read as unverified',
  );
  assert.deepEqual(readUserSites([{ url: SITE, isverified: 'false' }]), [{ url: SITE, verified: false }]);
}

// ── a shape miss is loud, with the body ─────────────────────────────────────
{
  const miss = (fn, body, ...needles) => {
    let caught = null;
    try { fn(body); } catch (err) { caught = err; }
    assert.ok(caught instanceof BingApiError, 'a shape miss throws BingApiError');
    assert.equal(caught.kind, 'shape');
    for (const n of needles) assert.ok(caught.body.includes(n) && caught.message.includes(n), `the excerpt carries ${n}`);
    assert.match(caught.hint, /--debug/);
    return caught;
  };
  miss(readLinkCounts, { d: { Results: [{ Page: 'x' }] } }, 'Results');
  miss(readUrlLinks, { d: { Items: [] } }, 'Items');
  miss(readUrlLinks, { d: { Details: [{ SourceUrl: 'https://x.example/' }] } }, 'SourceUrl');
  miss(readUserSites, { d: { Sites: [] } }, 'Sites');
  const big = miss(readLinkCounts, { d: { Other: 'x'.repeat(2000) } }, 'Other');
  assert.equal(big.body.length, 500, 'the excerpt is the first 500 characters');
}

// ── parseWcfDate ────────────────────────────────────────────────────────────
assert.equal(parseWcfDate('/Date(1690000000000)/'), 1690000000000);
assert.equal(parseWcfDate('/Date(1690000000000-0700)/'), 1690000000000, 'the offset is display-only: the number is UTC');
assert.equal(parseWcfDate('/Date(1690000000000+0200)/'), 1690000000000);
assert.equal(parseWcfDate('/Date(-86400000)/'), -86400000);
assert.equal(parseWcfDate('2026-09-27T00:00:00Z'), Date.UTC(2026, 8, 27));
assert.equal(parseWcfDate('yesterday'), null);
assert.equal(parseWcfDate(null), null);
assert.equal(parseWcfDate(undefined), null);

// ── matchBingSite ───────────────────────────────────────────────────────────
{
  const v = (url, verified = true) => ({ url, verified });
  const sites = [v('http://acme.io/'), v('https://acme.io/'), v('https://www.acme.io/blog/'), v('https://www.acme.io/'), v('https://other.io/')];
  assert.deepEqual(matchBingSite(sites, { domain: 'www.acme.io' }), { site: 'https://www.acme.io/', reason: 'url-prefix site' },
    'the exact host, then the shorter prefix');
  assert.deepEqual(matchBingSite(sites, { domain: 'acme.io' }), { site: 'https://acme.io/', reason: 'url-prefix site' });
  assert.equal(matchBingSite(sites, { domain: 'https://www.acme.io/pricing' }).site, 'https://www.acme.io/', 'a URL is accepted as the domain');
  assert.equal(matchBingSite([v('http://www.acme.io/'), v('https://acme.io/')], { domain: 'www.acme.io' }).site, 'https://acme.io/',
    'https outranks the exact host');
  const unverified = matchBingSite([v('https://www.acme.io/', false), v('https://other.io/')], { domain: 'acme.io' });
  assert.equal(unverified.site, null, 'an unverified site never qualifies');
  assert.equal(unverified.reason, 'no site matches acme.io');
  assert.deepEqual(unverified.available, ['https://www.acme.io/', 'https://other.io/']);
  assert.equal(matchBingSite(sites, {}).reason, 'no domain to match');

  assert.deepEqual(matchBingSite(sites, { domain: 'acme.io', configured: 'https://www.acme.io/blog/' }),
    { site: 'https://www.acme.io/blog/', reason: 'configured' }, 'a configured site in the list wins over the match');
  assert.deepEqual(matchBingSite(sites, { configured: 'https://WWW.acme.io' }), { site: 'https://www.acme.io/', reason: 'configured' },
    'a configured site compares case-insensitively on the host, trailing slash optional, and comes back as the account spells it');
  assert.deepEqual(matchBingSite([], { configured: 'https://x.io/' }), { site: 'https://x.io/', reason: 'configured' },
    'with no list to check against, the configured site is trusted');
  assert.deepEqual(matchBingSite(null, { configured: 'https://x.io/' }), { site: 'https://x.io/', reason: 'configured' });
  const notThere = matchBingSite(sites, { configured: 'https://nope.io/' });
  assert.equal(notThere.site, null);
  assert.equal(notThere.reason, 'configured site not in the account');
  assert.equal(notThere.available.length, sites.length);
  assert.equal(matchBingSite([v(SITE, false)], { configured: SITE }).reason, 'configured site is unverified in this account');
}

// ── mergeOrigin ─────────────────────────────────────────────────────────────
assert.equal(mergeOrigin('gsc', 'bing'), 'bing,gsc');
assert.equal(mergeOrigin(null, 'bing'), 'bing');
assert.equal(mergeOrigin(undefined, 'gsc'), 'gsc');
assert.equal(mergeOrigin('bing,gsc', 'gsc'), 'bing,gsc');
assert.equal(mergeOrigin('gsc,bing', 'bing'), 'bing,gsc', 'the result is always sorted');
assert.equal(mergeOrigin(' GSC ', ''), 'gsc');
assert.equal(mergeOrigin(null, null), null);

// ── the origin migration: backfill once, harmlessly again ───────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.prepare("INSERT INTO backlinks (project, linking_url, linking_domain, source, imported_at) VALUES ('fx', ?, ?, 'old.csv', 1)")
    .run('https://old.example.com/a', 'old.example.com');
  migrateBacklinkOrigin(db);
  migrateBacklinkOrigin(db);
  const r = row(db, 'https://old.example.com/a');
  assert.equal(r.origin, 'gsc', 'every row older than the column came from the Search Console export');
  assert.equal(r.bing_checked_at, null);
  // A database without the table is not an error.
  migrateBacklinkOrigin(new DatabaseSync(':memory:'));
}

// ── the Search Console import merges 'gsc' ─────────────────────────────────
{
  const db = freshDb();
  upsertBingBacklinks(db, 'fx', [
    { linking_url: 'https://news.example.org/post', linking_domain: 'news.example.org', target_url: SITE, anchor_text: 'Acme' },
  ], { now: NOW });
  const dir = mkdtempSync(join(tmpdir(), 'bing-links-'));
  try {
    const csv = join(dir, 'fx-export.csv');
    writeFileSync(csv, ['Linking page,Last crawled', 'https://news.example.org/post,2026-08-01', 'https://blog.example.com/a,2026-08-02'].join('\n'));
    assert.equal(importBacklinks(db, 'fx', { file: csv }).imported, 2);
    importBacklinks(db, 'fx', { file: csv });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(row(db, 'https://news.example.org/post').origin, 'bing,gsc', 'a link Bing reported first is corroborated by the export');
  assert.equal(row(db, 'https://news.example.org/post').target_url, SITE, 'the import never clears what Bing recovered');
  assert.equal(row(db, 'https://blog.example.com/a').origin, 'gsc');
  assert.equal(count(db), 2, 're-importing does not duplicate');
}

// ── bingGet: every failure mapped to a kind ─────────────────────────────────
{
  const serve = (status, body) => async () => response(status, body);
  const get = (fetch, extra = {}) => bingGet({ method: 'GetUserSites', params: {}, apiKey: KEY, fetch, ...extra });

  await rejects(bingGet({ method: 'GetUserSites', fetch: serve(200, { d: [] }) }), (err) => {
    assert.equal(err.kind, 'config');
    assert.match(err.hint, /BING_WEBMASTER_API_KEY/);
    assert.match(err.hint, /Settings → API access/);
  });
  await rejects(get(serve(401, { ErrorCode: 3, Message: 'Invalid API key' })), (err) => {
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
    assert.equal(err.code, 3);
    assert.match(err.message, /Invalid API key/);
  });
  await rejects(get(serve(400, { ErrorCode: 3, Message: 'InvalidApiKey' })), (err) => assert.equal(err.kind, 'auth', 'a key message is auth whatever the status'));
  await rejects(get(serve(400, { d: { ErrorCode: 9, Message: 'Site is not verified' } })), (err) => assert.equal(err.kind, 'auth'));
  await rejects(get(serve(429, '')), (err) => assert.equal(err.kind, 'quota'));
  await rejects(get(serve(400, { ErrorCode: 14, Message: 'Daily quota exceeded' })), (err) => {
    assert.equal(err.kind, 'quota');
    assert.match(err.hint, /stored is kept/);
  });
  await rejects(get(serve(503, { ErrorCode: 1, Message: 'Request throttled' })), (err) => assert.equal(err.kind, 'quota'));
  await rejects(get(serve(500, { ErrorCode: 1, Message: 'Internal failure' })), (err) => {
    assert.equal(err.kind, 'server');
    assert.equal(err.status, 500);
    assert.match(err.message, /Internal failure/);
  });
  await rejects(get(serve(502, '<html>bad gateway</html>')), (err) => {
    assert.equal(err.kind, 'server');
    assert.match(err.body, /bad gateway/);
  });
  await rejects(get(serve(200, '<html>not json</html>')), (err) => {
    assert.equal(err.kind, 'shape');
    assert.match(err.body, /not json/);
  });
  await rejects(get(serve(200, { ErrorCode: 3, Message: 'InvalidApiKey' })), (err) => assert.equal(err.kind, 'auth',
    'a 2xx that carries only an error is the error it describes'));
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await rejects(get(hanging, { timeoutMs: 5 }), (err) => {
    assert.equal(err.kind, 'transport');
    assert.match(err.hint, /did not answer in time/);
  });
  await rejects(get(async (url) => { throw new TypeError(`fetch failed for ${url}`); }), (err) => {
    assert.equal(err.kind, 'transport');
    assert.ok(!err.message.includes(KEY), 'the key never appears in an error message');
  });
  await rejects(get(serve(500, { Message: `bad request ${KEY}` })), (err) => {
    assert.ok(!err.message.includes(KEY) && !err.body.includes(KEY), 'an echoed key is redacted');
  });
  await rejects(get(serve(500, `${'x'.repeat(495)}${KEY} and more`)), (err) => {
    assert.equal(err.body.length, 500);
    assert.ok(!err.body.includes(KEY.slice(0, 5)) && !err.message.includes(KEY.slice(0, 5)),
      'a key echoed across the 500-character cut is redacted before the cut, not left as a prefix');
  });

  const okCalls = [];
  const ok = await bingGet({ method: 'GetUserSites', params: {}, apiKey: KEY, fetch: async (url, init) => { okCalls.push({ url, init }); return response(200, { d: [] }); } });
  assert.deepEqual(ok, { d: [] });
  assert.equal(okCalls[0].init.method, 'GET');

  assert.equal(classifyFailure(429, ''), 'quota');
  assert.equal(classifyFailure(403, ''), 'auth');
  assert.equal(classifyFailure(500, 'boom'), 'server');
  assert.equal(classifyFailure(503, '', 'The request was throttled'), 'quota', 'a plain-text body is read for quota');
  assert.equal(classifyFailure(500, '', 'at VerifySite() access'), 'server', 'but never for auth');

  // A plain-text error has no JSON Message: its own words decide quota.
  await rejects(get(serve(503, 'The request was throttled')), (err) => {
    assert.equal(err.kind, 'quota', 'a plain-text throttle is quota, not a server error to retry on the next target');
    assert.match(err.hint, /quota exhausted/);
    assert.match(err.message, /throttled/);
  });
  await rejects(get(serve(403, 'Quota exceeded')), (err) => {
    assert.equal(err.kind, 'quota', 'a plain-text 403 about quota is quota, not a rejected key');
    assert.doesNotMatch(err.hint, /rejected the API key/);
  });
  await rejects(get(serve(500, '<html><body>Server Error at VerifySiteOwnership(): access</body></html>')), (err) => {
    assert.equal(err.kind, 'server', 'an error page that says "verify" in passing does not abort the run as auth');
    assert.match(err.body, /VerifySiteOwnership/);
  });

  // ErrorCode 0 (or None) is a success that says so, not an error.
  const zero = { ErrorCode: 0, Message: '', Links: [], TotalPages: 0 };
  assert.deepEqual(await get(serve(200, zero)), zero, 'ErrorCode 0 beside a top-level payload is a success');
  assert.deepEqual(readLinkCounts(zero), { links: [], totalPages: 0 });
  const named = { d: { ErrorCode: 'None', Details: [{ Url: 'https://x.example/a' }], TotalPages: 1 } };
  assert.deepEqual(await get(serve(200, named)), named, 'the enum name None is no error either');
  const zeroOnly = { ErrorCode: 0, Message: '' };
  assert.deepEqual(await get(serve(200, zeroOnly)), zeroOnly, 'ErrorCode 0 with no payload is left to the reader');
  assert.throws(() => readLinkCounts(zeroOnly), (err) => err.kind === 'shape', '... which fails it loudly on shape');
  await rejects(get(serve(200, { d: { ErrorCode: 3, Message: 'InvalidApiKey' } })), (err) => assert.equal(err.kind, 'auth',
    'a failing code under "d" with no payload is the error it describes'));
  await rejects(get(serve(200, { d: null, ErrorCode: 14, Message: 'Daily quota exceeded' })), (err) => assert.equal(err.kind, 'quota',
    'a null payload is no payload'));

  // onRaw sees every readable 2xx before it is read, JSON or not, with the key redacted.
  const seenRaw = [];
  const onRaw = (json, text) => seenRaw.push({ json, text });
  await get(serve(200, { d: [], echo: `k=${KEY}` }), { onRaw });
  assert.deepEqual(seenRaw[0].json, { d: [], echo: `k=${KEY}` }, 'the parsed body, whole');
  assert.ok(!seenRaw[0].text.includes(KEY), 'the raw text is redacted');
  await rejects(get(serve(200, `<html>not json ${KEY}</html>`), { onRaw }), (err) => assert.equal(err.kind, 'shape'));
  assert.equal(seenRaw.length, 2, 'a body that is not JSON reaches onRaw before the shape error');
  assert.equal(seenRaw[1].json, undefined, 'json is undefined when the body is not JSON');
  assert.equal(seenRaw[1].text, '<html>not json ***</html>');
  await rejects(get(serve(500, { Message: 'Internal failure' }), { onRaw }), () => {});
  await rejects(get(serve(200, { ErrorCode: 3, Message: 'InvalidApiKey' }), { onRaw }), () => {});
  assert.equal(seenRaw.length, 2, 'an error answer is not a raw body to compare shapes with');
}

// ── the fetch run ───────────────────────────────────────────────────────────

const LINK_COUNTS = [
  { d: { Links: [{ Url: 'https://www.acme.io/pricing', Count: 5 }, { Url: 'https://www.acme.io/', Count: 12 }], TotalPages: 2 } },
  { d: { Links: [{ Url: 'https://www.acme.io/blog/post', Count: 2 }], TotalPages: 2 } },
];
const URL_LINKS = {
  'https://www.acme.io/': [
    { d: { Details: [
      { Url: 'https://news.example.org/acme-raises', AnchorText: 'Acme raises' },
      { Url: 'https://blog.example.com/a', AnchorText: 'acme' },
    ], TotalPages: 2 } },
    { d: { Details: [
      { Url: 'https://dir.example.com/listing', AnchorText: 'Acme directory' },
      { Url: 'https://www.acme.io/about', AnchorText: 'internal' },
    ], TotalPages: 2 } },
  ],
  'https://www.acme.io/pricing': [
    { d: { Details: [{ Url: 'https://review.example.net/acme', AnchorText: 'pricing' }], TotalPages: 1 } },
  ],
  'https://www.acme.io/blog/post': [
    { d: { Details: [], TotalPages: 0 } },
  ],
};

/** The standard fake: override(method, query) may return a response to serve instead. */
function standardBing(override = () => undefined) {
  return fakeBing((method, q) => {
    const over = override(method, q);
    if (over !== undefined) return over;
    if (method === 'GetUserSites') return { d: [{ Url: 'http://acme.io/', IsVerified: true }, { Url: SITE, IsVerified: true }, { Url: 'https://acme.io/', IsVerified: false }] };
    if (method === 'GetLinkCounts') return LINK_COUNTS[Number(q.page)];
    if (method === 'GetUrlLinks') return URL_LINKS[q.link][Number(q.page)];
    return { status: 404, body: { Message: `unknown method ${method}` } };
  });
}

/** Rows a Search Console import and a --live pass left behind. */
function seed(db) {
  db.prepare(`INSERT INTO backlinks (project, linking_url, linking_domain, source, origin, imported_at,
      checked_at, http_status, verify_state, link_present, rel_nofollow, target_url, anchor_text)
    VALUES ('fx', ?, ?, 'export.csv', 'gsc', 5, 111, 200, 'ok', 1, 0, NULL, NULL)`)
    .run('https://news.example.org/acme-raises', 'news.example.org');
  db.prepare(`INSERT INTO backlinks (project, linking_url, linking_domain, source, origin, imported_at,
      checked_at, http_status, verify_state, link_present, rel_nofollow, target_url, anchor_text)
    VALUES ('fx', ?, ?, 'export.csv', 'gsc', 5, 222, 200, 'ok', 1, 1, 'https://www.acme.io/old-target', 'Old anchor')`)
    .run('https://dir.example.com/listing', 'dir.example.com');
}

const CONFIG = { target: { domain: 'acme.io' } };

{
  const db = freshDb();
  seed(db);
  const bing = standardBing();
  const progress = [];
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, onProgress: p => progress.push(p) });

  assert.equal(r.site, SITE, 'https outranks the bare host; the unverified https://acme.io/ never qualifies');
  assert.equal(r.site_reason, 'url-prefix site');
  assert.equal(r.dry_run, false);
  assert.deepEqual(bing.calls.map(c => c.method), [
    'GetUserSites', 'GetLinkCounts', 'GetLinkCounts', ...bing.calls.slice(3).map(() => 'GetUrlLinks'),
  ]);
  assert.equal(r.requests, 7, 'one site list, two list pages, four link pages');
  assert.equal(bing.calls.length, 7);
  for (const c of bing.calls) {
    assert.equal(c.query.apikey, KEY);
    assert.equal(c.init.method, 'GET');
    if (c.method !== 'GetUserSites') assert.equal(c.query.siteUrl, SITE);
  }
  assert.deepEqual(bing.calls.filter(c => c.method === 'GetLinkCounts').map(c => c.query.page), ['0', '1'], 'pages are 0-based');

  assert.deepEqual(r.target_pages, [
    { url: 'https://www.acme.io/', count: 12, linking_pages_stored: 3, complete: true },
    { url: 'https://www.acme.io/pricing', count: 5, linking_pages_stored: 1, complete: true },
    { url: 'https://www.acme.io/blog/post', count: 2, linking_pages_stored: 0, complete: true },
  ], 'targets are ranked by inbound count; a link from the site itself is not stored');
  assert.equal(r.target_pages_available, 3);
  assert.equal(r.inserted, 2);
  assert.equal(r.updated, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.stopped_reason, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.linking_domains, 4);
  assert.equal(r.fetched_at, NOW);
  assert.equal(progress[0].phase, 'targets');
  assert.equal(progress.filter(p => p.phase === 'target').length, 3);

  const fresh = row(db, 'https://blog.example.com/a');
  assert.equal(fresh.target_url, 'https://www.acme.io/');
  assert.equal(fresh.anchor_text, 'acme');
  assert.equal(fresh.source, 'bing');
  assert.equal(fresh.origin, 'bing');
  assert.equal(fresh.linking_domain, 'blog.example.com');
  assert.equal(fresh.imported_at, NOW);
  assert.equal(fresh.bing_checked_at, NOW);
  assert.equal(fresh.verify_state, null, 'Bing having seen a link is not a --live check');
  assert.equal(row(db, 'https://review.example.net/acme').target_url, 'https://www.acme.io/pricing');
  assert.equal(row(db, 'https://www.acme.io/about'), undefined);

  const corroborated = row(db, 'https://news.example.org/acme-raises');
  assert.equal(corroborated.origin, 'bing,gsc', 'a Search Console link Bing also reports is corroborated');
  assert.equal(corroborated.source, 'export.csv', 'source keeps naming the export file');
  assert.equal(corroborated.target_url, 'https://www.acme.io/', 'Bing fills the target the export lacks');
  assert.equal(corroborated.anchor_text, 'Acme raises');
  assert.equal(corroborated.imported_at, 5, 'imported_at stays when the row first arrived');
  assert.equal(corroborated.bing_checked_at, NOW);
  assert.deepEqual(
    [corroborated.checked_at, corroborated.http_status, corroborated.verify_state, corroborated.link_present, corroborated.rel_nofollow],
    [111, 200, 'ok', 1, 0], 'the --live columns are untouched');

  const kept = row(db, 'https://dir.example.com/listing');
  assert.equal(kept.origin, 'bing,gsc');
  assert.equal(kept.target_url, 'https://www.acme.io/old-target', 'a stored target is not overwritten');
  assert.equal(kept.anchor_text, 'Old anchor');
  assert.deepEqual([kept.checked_at, kept.rel_nofollow], [222, 1]);

  // Again: idempotent. Nothing new, the same four rows touched, origins stable.
  const again = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: standardBing().fetch, now: NOW + 1 });
  assert.equal(again.inserted, 0);
  assert.equal(again.updated, 4);
  assert.equal(count(db), 4);
  assert.equal(row(db, 'https://blog.example.com/a').origin, 'bing');
  assert.equal(row(db, 'https://blog.example.com/a').imported_at, NOW);
  assert.equal(row(db, 'https://blog.example.com/a').bing_checked_at, NOW + 1);
  assert.equal(row(db, 'https://news.example.org/acme-raises').origin, 'bing,gsc');
}

// A linking page Bing reports for a second target keeps the first target.
{
  const db = freshDb();
  const r1 = upsertBingBacklinks(db, 'fx', [
    { linking_url: 'https://x.example/a', linking_domain: 'x.example', target_url: 'https://www.acme.io/one', anchor_text: 'one' },
    { linking_url: '', linking_domain: 'x.example' },
    { linking_url: 'https://y.example/b', linking_domain: null },
  ], { now: NOW });
  assert.deepEqual(r1, { inserted: 1, updated: 0 }, 'rows without a URL or domain are skipped');
  const r2 = upsertBingBacklinks(db, 'fx', [
    { linking_url: 'https://x.example/a', linking_domain: 'x.example', target_url: 'https://www.acme.io/two', anchor_text: 'two' },
  ], { now: NOW + 5 });
  assert.deepEqual(r2, { inserted: 0, updated: 1 });
  assert.equal(row(db, 'https://x.example/a').target_url, 'https://www.acme.io/one');
  assert.equal(row(db, 'https://x.example/a').anchor_text, 'one');
  assert.equal(row(db, 'https://x.example/a').bing_checked_at, NOW + 5);
  // A failure mid-batch rolls the whole batch back.
  assert.throws(() => upsertBingBacklinks(db, 'fx', [
    { linking_url: 'https://z.example/c', linking_domain: 'z.example' },
    { linking_url: { toString() { throw new Error('boom'); } }, linking_domain: 'z.example' },
  ], { now: NOW }), /boom/);
  assert.equal(row(db, 'https://z.example/c'), undefined);
  assert.deepEqual(upsertBingBacklinks(db, 'fx', [], { now: NOW }), { inserted: 0, updated: 0 });
}

// maxRequests: the shared budget stops new requests and says truncated.
{
  const db = freshDb();
  const bing = standardBing();
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, maxRequests: 4, concurrency: 1 });
  assert.equal(r.site_reason, 'configured');
  assert.equal(bing.calls.length, 4, 'a configured site costs no GetUserSites request');
  assert.equal(r.requests, 4);
  assert.equal(r.truncated, true);
  assert.equal(r.stopped_reason, 'max_requests');
  assert.deepEqual(r.target_pages.map(t => [t.linking_pages_stored, t.complete]), [[3, true], [0, false], [0, false]]);
  assert.equal(count(db), 3, 'what the budget paid for is stored');
}

// maxPagesPerList and maxTargetPages cap the walk; a capped list says truncated.
{
  const db = freshDb();
  const bing = standardBing();
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, maxPagesPerList: 1, maxTargetPages: 1 });
  assert.deepEqual(bing.calls.map(c => `${c.method}:${c.query.page}`), ['GetLinkCounts:0', 'GetUrlLinks:0']);
  assert.equal(r.truncated, true);
  assert.equal(r.stopped_reason, null);
  assert.equal(r.target_pages_available, 2, 'only the first list page was read');
  assert.deepEqual(r.target_pages, [{ url: 'https://www.acme.io/', count: 12, linking_pages_stored: 2, complete: false }],
    'the most-linked page is taken, and only its first page of links is read');
}

// A quota error stops every further request and keeps what was stored.
{
  const db = freshDb();
  const bing = standardBing((method, q) => (method === 'GetUrlLinks' && q.link === SITE && q.page === '1'
    ? { status: 400, body: { ErrorCode: 14, Message: 'Daily quota exceeded' } } : undefined));
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 1 });
  assert.equal(r.stopped_reason, 'quota');
  assert.equal(bing.calls.length, 4, 'no request after the quota error');
  assert.equal(count(db), 2, 'the pages answered before the quota ran out are kept');
  assert.ok(row(db, 'https://news.example.org/acme-raises'));
  assert.deepEqual(r.target_pages.map(t => t.linking_pages_stored), [2, 0, 0]);
  assert.equal(r.target_pages[0].complete, false);
}
{
  // With two workers, the one in flight finishes and stores; nobody starts
  // another request. The home page's first answer is held back so the 429
  // on /pricing lands while it is in flight: the count is then exact.
  const db = freshDb();
  const bing = standardBing((method, q) => {
    if (method !== 'GetUrlLinks') return undefined;
    if (q.link === 'https://www.acme.io/pricing') return { status: 429, body: '' };
    if (q.link === SITE && q.page === '0') return later(20, URL_LINKS[SITE][0]);
    return undefined;
  });
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 2 });
  assert.equal(r.stopped_reason, 'quota');
  assert.deepEqual(bing.calls.map(c => `${c.method}:${c.query.link ?? ''}:${c.query.page}`), [
    'GetLinkCounts::0', 'GetLinkCounts::1', `GetUrlLinks:${SITE}:0`, 'GetUrlLinks:https://www.acme.io/pricing:0',
  ], 'the in-flight request finishes; no worker starts another, not even page 1 of the same target');
  assert.equal(r.requests, 4);
  assert.equal(count(db), 2, 'the answer in flight when the quota ran out is stored');
  assert.deepEqual(r.target_pages.map(t => [t.linking_pages_stored, t.complete]), [[2, false], [0, false], [0, false]]);
}

// The request budget holds with several workers racing for its last request.
{
  const db = freshDb();
  const bing = standardBing();
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, maxRequests: 4, concurrency: 3 });
  assert.equal(bing.calls.length, 4, 'three workers, two requests left after the list walk: exactly two are made');
  assert.equal(r.requests, 4);
  assert.equal(r.truncated, true);
  assert.equal(r.stopped_reason, 'max_requests');
  assert.deepEqual(r.target_pages.map(t => [t.linking_pages_stored, t.complete]), [[2, false], [1, true], [0, false]]);
  assert.equal(count(db), 3);
}

// A per-target server error is recorded and the run continues.
{
  const db = freshDb();
  const bing = standardBing((method, q) => (method === 'GetUrlLinks' && q.link === 'https://www.acme.io/pricing'
    ? { status: 500, body: { ErrorCode: 1, Message: 'Internal failure' } } : undefined));
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 1 });
  assert.equal(r.stopped_reason, null);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(
    { method: r.errors[0].method, target: r.errors[0].target, page: r.errors[0].page, kind: r.errors[0].kind, status: r.errors[0].status },
    { method: 'GetUrlLinks', target: 'https://www.acme.io/pricing', page: 0, kind: 'server', status: 500 });
  assert.match(r.errors[0].message, /Internal failure/);
  assert.ok(bing.calls.some(c => c.query.link === 'https://www.acme.io/blog/post'), 'the next target is still walked');
  assert.equal(count(db), 3);
}

// A plain-text throttle is a quota stop, not a per-target server error: the
// remaining targets are not requested into the same wall.
{
  const db = freshDb();
  const bing = standardBing((method, q) => (method === 'GetUrlLinks' && q.link === 'https://www.acme.io/pricing'
    ? { status: 503, body: 'The request was throttled' } : undefined));
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 1 });
  assert.equal(r.stopped_reason, 'quota');
  assert.deepEqual(r.errors, [], 'not recorded as a server error');
  assert.equal(bing.calls.filter(c => c.query.link === 'https://www.acme.io/blog/post').length, 0, 'no request after it');
  assert.equal(count(db), 3, 'what was fetched before it is kept');
}
{
  // A plain-text 403 about quota stops the run as quota; it does not reject the key.
  const db = freshDb();
  const bing = standardBing((method, q) => (method === 'GetUrlLinks' && q.link === 'https://www.acme.io/pricing'
    ? { status: 403, body: 'Quota exceeded' } : undefined));
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 1 });
  assert.equal(r.stopped_reason, 'quota');
  assert.equal(count(db), 3);
}

// A linking page Bing reports for two of your pages is one row, stored once
// per run: inserted + updated counts distinct rows, and "updated" means a row
// that existed before the run.
{
  const shared = { Url: 'https://news.example.org/acme-raises', AnchorText: 'Acme pricing' };
  const twice = (method, q) => (method === 'GetUrlLinks' && q.link === 'https://www.acme.io/pricing'
    ? { d: { Details: [{ Url: 'https://review.example.net/acme', AnchorText: 'pricing' }, shared], TotalPages: 1 } } : undefined);

  const db = freshDb();
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: standardBing(twice).fetch, now: NOW, siteUrl: SITE, concurrency: 1 });
  assert.equal(count(db), 4);
  assert.deepEqual([r.inserted, r.updated], [4, 0], 'nothing existed before the run, so nothing is "already known"');
  assert.deepEqual(r.target_pages.map(t => t.linking_pages_stored), [3, 1, 0], '/pricing stores only the page no other target stored');
  assert.equal(r.target_pages.reduce((n, t) => n + t.linking_pages_stored, 0), count(db));
  assert.equal(row(db, 'https://news.example.org/acme-raises').target_url, SITE, 'with one worker, the most-linked target keeps it');
  assert.equal(row(db, 'https://news.example.org/acme-raises').anchor_text, 'Acme raises', 'target and anchor come from the same report');

  // With two workers the counts hold whichever target finishes first. Here
  // /pricing does: the home page's first answer is held back.
  const db2 = freshDb();
  seed(db2);
  const slowHome = (method, q) => (method === 'GetUrlLinks' && q.link === SITE && q.page === '0'
    ? later(20, URL_LINKS[SITE][0]) : twice(method, q));
  const r2 = await runBingLinks(db2, 'fx', CONFIG, { apiKey: KEY, fetch: standardBing(slowHome).fetch, now: NOW, siteUrl: SITE, concurrency: 2 });
  assert.equal(count(db2), 4);
  assert.deepEqual([r2.inserted, r2.updated], [2, 2], 'the two seeded rows are the only ones already known');
  assert.equal(r2.target_pages.reduce((n, t) => n + t.linking_pages_stored, 0), 4);
  assert.deepEqual(r2.target_pages.map(t => t.linking_pages_stored), [2, 2, 0]);
  assert.equal(row(db2, 'https://news.example.org/acme-raises').target_url, 'https://www.acme.io/pricing');
  assert.equal(row(db2, 'https://news.example.org/acme-raises').anchor_text, 'Acme pricing');
}

// A 401 propagates as auth; what earlier targets stored is kept.
{
  const db = freshDb();
  const bing = standardBing((method) => (method === 'GetLinkCounts' ? { status: 401, body: { ErrorCode: 3, Message: 'Invalid API key' } } : undefined));
  await rejects(runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE }), (err) => {
    assert.ok(err instanceof BingApiError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
  });
  assert.equal(count(db), 0);
}
{
  const db = freshDb();
  const bing = standardBing((method, q) => (method === 'GetUrlLinks' && q.link === 'https://www.acme.io/pricing'
    ? { status: 403, body: { Message: 'Access denied' } } : undefined));
  await rejects(runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE, concurrency: 1 }),
    (err) => assert.equal(err.kind, 'auth'));
  assert.equal(count(db), 3, 'the target stored before the auth error is kept');
  assert.equal(bing.calls.filter(c => c.query.link === 'https://www.acme.io/blog/post').length, 0, 'no worker starts after it');
}

// A shape miss fails the run loudly instead of storing nothing.
{
  const db = freshDb();
  const bing = standardBing((method) => (method === 'GetLinkCounts' ? { d: { Results: [{ Page: 'https://www.acme.io/' }] } } : undefined));
  await rejects(runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, now: NOW, siteUrl: SITE }), (err) => {
    assert.equal(err.kind, 'shape');
    assert.match(err.body, /Results/);
  });
}

// No key, and no site to be found: config errors that say what to set.
{
  const db = freshDb();
  await rejects(runBingLinks(db, 'fx', CONFIG, { fetch: standardBing().fetch }), (err) => {
    assert.equal(err.kind, 'config');
    assert.match(err.hint, /BING_WEBMASTER_API_KEY/);
  });
  process.env.BING_WEBMASTER_API_KEY = KEY;
  try {
    const bing = standardBing();
    const r = await runBingLinks(db, 'fx', CONFIG, { fetch: bing.fetch, dryRun: true });
    assert.equal(r.site, SITE, 'the key is read from BING_WEBMASTER_API_KEY');
    assert.equal(bing.calls[0].query.apikey, KEY);
  } finally {
    delete process.env.BING_WEBMASTER_API_KEY;
  }
  await rejects(runBingLinks(db, 'fx', { target: { domain: 'nothere.io' } }, { apiKey: KEY, fetch: standardBing().fetch }), (err) => {
    assert.equal(err.kind, 'config');
    assert.match(err.message, /No Bing Webmaster site matches nothere\.io/);
    assert.match(err.message, /https:\/\/www\.acme\.io\//, 'the miss lists the account\'s sites');
  });
  await rejects(runBingLinks(db, 'fx', {}, { apiKey: KEY, fetch: standardBing().fetch }), (err) => assert.equal(err.kind, 'config'));
}

// dryRun resolves the site and makes no link request.
{
  const db = freshDb();
  const bing = standardBing();
  const r = await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: bing.fetch, dryRun: true, now: NOW });
  assert.deepEqual(bing.calls.map(c => c.method), ['GetUserSites']);
  assert.equal(r.dry_run, true);
  assert.equal(r.site, SITE);
  assert.equal(r.max_target_pages, 50);
  assert.equal(r.max_pages_per_list, 20);
  assert.equal(r.max_requests, 300);
  assert.equal(r.requests, 1);
  assert.deepEqual(r.target_pages, []);
  assert.equal(count(db), 0);

  const configured = standardBing();
  const c = await runBingLinks(db, 'fx', { target: { domain: 'acme.io' }, bing: { siteUrl: 'https://acme.io/' } },
    { apiKey: KEY, fetch: configured.fetch, dryRun: true });
  assert.equal(configured.calls.length, 0, 'a configured site needs no request at all');
  assert.equal(c.site, 'https://acme.io/');
  assert.equal(c.site_reason, 'configured');
}

// debugDir writes the first raw body of each method the run calls.
{
  const dir = mkdtempSync(join(tmpdir(), 'bing-debug-'));
  try {
    const db = freshDb();
    await runBingLinks(db, 'fx', CONFIG, { apiKey: KEY, fetch: standardBing().fetch, now: NOW, siteUrl: SITE, debugDir: join(dir, 'raw'), concurrency: 1 });
    const counts = join(dir, 'raw', 'fx-bing-GetLinkCounts.json');
    const links = join(dir, 'raw', 'fx-bing-GetUrlLinks.json');
    assert.ok(existsSync(counts) && existsSync(links));
    assert.deepEqual(JSON.parse(readFileSync(counts, 'utf8')), LINK_COUNTS[0], 'the first list page, as Bing sent it');
    assert.deepEqual(JSON.parse(readFileSync(links, 'utf8')), URL_LINKS[SITE][0]);
    assert.ok(!readFileSync(counts, 'utf8').includes(KEY), 'the key is not in the debug file');

    // A shape miss still leaves the raw body behind: that is when it is needed.
    const shapeDir = join(dir, 'shape');
    const bad = standardBing((method) => (method === 'GetLinkCounts' ? { d: { Results: [] } } : undefined));
    await rejects(runBingLinks(freshDb(), 'fx', CONFIG, { apiKey: KEY, fetch: bad.fetch, siteUrl: SITE, debugDir: shapeDir }),
      (err) => assert.equal(err.kind, 'shape'));
    assert.deepEqual(JSON.parse(readFileSync(join(shapeDir, 'fx-bing-GetLinkCounts.json'), 'utf8')), { d: { Results: [] } });

    // A matched site: GetUserSites is as unverified as the rest, so it is written too.
    const matchedDir = join(dir, 'matched');
    await runBingLinks(freshDb(), 'fx', CONFIG, { apiKey: KEY, fetch: standardBing().fetch, now: NOW, debugDir: matchedDir, dryRun: true });
    const sites = JSON.parse(readFileSync(join(matchedDir, 'fx-bing-GetUserSites.json'), 'utf8'));
    assert.equal(sites.d[1].Url, SITE, 'the site list, as Bing sent it');

    // ... and a readUserSites shape miss leaves the body that broke it.
    const sitesDir = join(dir, 'sites-shape');
    const badSites = standardBing((method) => (method === 'GetUserSites' ? { d: { Sites: [{ Url: SITE }] } } : undefined));
    await rejects(runBingLinks(freshDb(), 'fx', CONFIG, { apiKey: KEY, fetch: badSites.fetch, debugDir: sitesDir }),
      (err) => assert.equal(err.kind, 'shape'));
    assert.deepEqual(JSON.parse(readFileSync(join(sitesDir, 'fx-bing-GetUserSites.json'), 'utf8')), { d: { Sites: [{ Url: SITE }] } });

    // A 2xx that is not JSON at all is written as Bing sent it, key redacted.
    const textDir = join(dir, 'text');
    const html = `<html><body>Sign in to Bing Webmaster Tools ${KEY}</body></html>`;
    const notJson = standardBing((method) => (method === 'GetLinkCounts' ? { status: 200, body: html } : undefined));
    await rejects(runBingLinks(freshDb(), 'fx', CONFIG, { apiKey: KEY, fetch: notJson.fetch, siteUrl: SITE, debugDir: textDir }),
      (err) => {
        assert.equal(err.kind, 'shape');
        assert.match(err.message, /not JSON/);
      });
    assert.equal(readFileSync(join(textDir, 'fx-bing-GetLinkCounts.json'), 'utf8'),
      '<html><body>Sign in to Bing Webmaster Tools ***</body></html>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// getDb() itself: a database older than the origin column opens with both
// columns added and its rows backfilled, and both writers work on it. The
// in-memory fixtures above apply migrateBacklinkOrigin by hand; this is what
// fails if getDb stops applying it. Last in the file: getDb keeps one handle
// per process.
{
  const dir = mkdtempSync(join(tmpdir(), 'bing-getdb-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    // The backlinks table as it was before origin and bing_checked_at.
    old.exec(`CREATE TABLE backlinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, linking_url TEXT NOT NULL, linking_domain TEXT NOT NULL,
      last_crawled TEXT, source TEXT, imported_at INTEGER NOT NULL, checked_at INTEGER, http_status INTEGER,
      verify_state TEXT, link_present INTEGER, rel_nofollow INTEGER, target_url TEXT, anchor_text TEXT,
      UNIQUE(project, linking_url))`);
    old.prepare("INSERT INTO backlinks (project, linking_url, linking_domain, source, imported_at) VALUES ('fx', ?, ?, 'old.csv', 1)")
      .run('https://old.example.com/a', 'old.example.com');
    old.close();

    const db = getDb(path);
    try {
      const columns = db.prepare('PRAGMA table_info(backlinks)').all().map(c => c.name);
      assert.ok(columns.includes('origin') && columns.includes('bing_checked_at'), 'getDb adds both columns');
      assert.equal(row(db, 'https://old.example.com/a').origin, 'gsc', 'getDb backfills the older rows');
      assert.equal(row(db, 'https://old.example.com/a').bing_checked_at, null);

      assert.deepEqual(upsertBingBacklinks(db, 'fx', [
        { linking_url: 'https://old.example.com/a', linking_domain: 'old.example.com', target_url: SITE, anchor_text: 'Acme' },
      ], { now: NOW }), { inserted: 0, updated: 1 });
      assert.equal(row(db, 'https://old.example.com/a').origin, 'bing,gsc');
      const csvDir = mkdtempSync(join(tmpdir(), 'bing-getdb-csv-'));
      try {
        const csv = join(csvDir, 'fx-export.csv');
        writeFileSync(csv, ['Linking page,Last crawled', 'https://new.example.com/b,2026-08-02'].join('\n'));
        assert.equal(importBacklinks(db, 'fx', { file: csv }).imported, 1);
      } finally {
        rmSync(csvDir, { recursive: true, force: true });
      }
      assert.equal(row(db, 'https://new.example.com/b').origin, 'gsc', 'the Search Console import takes its origin-aware path');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('bing-links: PASS');
