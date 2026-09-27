/**
 * Backlink audit — import, reclamation, the absence/unknown distinction, and
 * origin: which source reported a link, what that corroborates, and what it
 * does not (Bing names the target page, never whether the link is followed).
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importBacklinks, hostOf } from '../lib/backlink-import.js';
import { runBacklinkAudit, findOurLink, originsOf, countByOrigin } from '../analyses/backlinks/index.js';

const GSC_ONLY_NOTE = 'Search Console exports a capped, lagging sample of the links it attributes to you. This is not a complete link profile.';

assert.equal(hostOf('https://www.Example.com/a'), 'example.com');
assert.equal(hostOf('not a url'), null);

// legacy: a backlinks table from before the origin and bing_checked_at columns.
function fixture({ legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, is_indexable INTEGER);
    CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, name TEXT, raw_json TEXT);
    CREATE TABLE insights (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', fingerprint TEXT NOT NULL, first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, source_analysis_id INTEGER, data TEXT NOT NULL,
      UNIQUE(project, type, fingerprint));
    CREATE TABLE backlinks (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      linking_url TEXT NOT NULL, linking_domain TEXT NOT NULL, last_crawled TEXT, source TEXT,
      imported_at INTEGER NOT NULL, checked_at INTEGER, http_status INTEGER, verify_state TEXT,
      link_present INTEGER, rel_nofollow INTEGER, target_url TEXT, anchor_text TEXT,
      ${legacy ? '' : 'origin TEXT, bing_checked_at INTEGER,'}
      UNIQUE(project, linking_url));`);
  db.prepare('INSERT INTO domains VALUES (?,?,?,?)').run(1, 'acme.io', 'fx', 'target');
  db.prepare('INSERT INTO page_schemas VALUES (?,?,?,?)').run(1, 'Organization', 'Acme',
    JSON.stringify({ '@type': 'Organization', name: 'Acme' }));
  return db;
}

// ── CSV import ──────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const csv = join(dir, 'fx.csv');
  // A quoted URL containing a comma: naive splitting would shred this row.
  writeFileSync(csv, [
    'Linking page,Last crawled',
    '"https://blog.example.com/a,b?x=1,2",2026-08-05',
    'https://news.example.org/post,2026-08-01',
    'https://oldbrand-fan.net/widgetco-review,2026-07-01',
  ].join('\n'));
  const db = fixture();
  const r = importBacklinks(db, 'fx', { file: csv });
  assert.equal(r.imported, 3);
  const stored = db.prepare("SELECT linking_url FROM backlinks WHERE project='fx' ORDER BY id").all();
  assert.equal(stored[0].linking_url, 'https://blog.example.com/a,b?x=1,2',
    'a comma inside a quoted URL must survive the CSV reader');
  // Re-importing the same file must not duplicate.
  importBacklinks(db, 'fx', { file: csv });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM backlinks WHERE project='fx'").get().c, 3);
}

// ── findOurLink ─────────────────────────────────────────────────────────────
{
  const html = `<a href="/local">no</a><a rel="ugc noopener" href="https://acme.io/pricing">Acme pricing</a>`;
  const f = findOurLink(html, ['acme.io']);
  assert.equal(f.href, 'https://acme.io/pricing');
  assert.equal(f.anchor, 'Acme pricing', 'anchor text is recovered — GSC never exports it');
  assert.equal(f.nofollow, true, 'ugc counts as not passing equity');
  assert.equal(findOurLink('<a href="https://other.com/">x</a>', ['acme.io']), null);
}

// ── Reclamation ─────────────────────────────────────────────────────────────
{
  const db = fixture();
  const ins = (url, dom) => db.prepare(`INSERT INTO backlinks
    (project,linking_url,linking_domain,imported_at) VALUES ('fx',?,?,1)`).run(url, dom);
  ins('https://dir.example.com/listing/widgetco', 'dir.example.com');   // legacy name
  ins('https://dir.example.com/other/widget-co', 'dir.example.com');    // legacy, hyphenated
  ins('https://news.example.org/acme-raises', 'news.example.org');      // current name
  const r = await runBacklinkAudit(db, 'fx', { brandTerms: ['widgetco', 'widget co'], skipLedger: true });
  assert.equal(r.currentBrand, 'acme');
  assert.equal(r.summary.legacyBrandPages, 2, 'both spellings of the old name are found');
  assert.deepEqual(r.reclamation.map(d => d.domain), ['dir.example.com'],
    'a domain that also links under the current name is not a reclamation target');
  // origin was never written for these rows: they read as Search Console's,
  // and with no Bing rows the note is exactly the one it has always been.
  assert.deepEqual(r.summary.by_origin, {
    gsc: { rows: 3, domains: 2 }, bing: { rows: 0, domains: 0 }, both: { rows: 0, domains: 0 },
  });
  assert.equal(r.sample_note, GSC_ONLY_NOTE);
}

// ── originsOf ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(originsOf({ origin: 'bing,gsc' }), ['bing', 'gsc']);
  assert.deepEqual(originsOf({ origin: 'gsc, BING' }), ['bing', 'gsc'], 'read loosely, returned sorted');
  assert.deepEqual(originsOf({ origin: null, source: 'fx-latest.csv' }), ['gsc'], 'no origin predates Bing');
  assert.deepEqual(originsOf({}), ['gsc'], 'a legacy row has no origin property at all');
  assert.deepEqual(originsOf({ origin: null, source: 'bing' }), ['bing']);
  assert.deepEqual(countByOrigin([]), {
    gsc: { rows: 0, domains: 0 }, bing: { rows: 0, domains: 0 }, both: { rows: 0, domains: 0 },
  });
}

// ── Two sources: origin, corroboration, Bing targets, unknown equity ────────
{
  const db = fixture();
  db.exec('CREATE TABLE citability_scores (url TEXT, score INTEGER)');
  const page = db.prepare('INSERT INTO pages VALUES (?,?,?,?)');
  page.run(1, 1, 'https://acme.io/pricing', 1);
  page.run(2, 1, 'https://acme.io/docs', 1);
  db.prepare('INSERT INTO citability_scores VALUES (?,?)').run('https://acme.io/pricing', 90);
  db.prepare('INSERT INTO citability_scores VALUES (?,?)').run('https://acme.io/docs', 40);
  const ins = db.prepare(`INSERT INTO backlinks
    (project,linking_url,linking_domain,source,origin,imported_at,bing_checked_at,target_url,anchor_text)
    VALUES ('fx',?,?,?,?,1,?,?,?)`);
  // Search Console only: the export carries no target.
  ins.run('https://a.example.com/1', 'a.example.com', 'fx-latest.csv', 'gsc', null, null, null);
  ins.run('https://a.example.com/2', 'a.example.com', 'fx-latest.csv', 'gsc', null, null, null);
  // Bing only, with the page of ours Bing says it links to (spelled with www
  // and a trailing slash, as Bing's site URLs are).
  ins.run('https://b.example.org/post', 'b.example.org', 'bing', 'bing', 1, 'https://www.acme.io/pricing/', 'Acme pricing');
  // Both: the Search Console row Bing also reported. source keeps the file name.
  ins.run('https://c.example.net/x', 'c.example.net', 'fx-latest.csv', 'bing,gsc', 1, 'https://acme.io/pricing', 'acme');

  const r = await runBacklinkAudit(db, 'fx', { skipLedger: true });
  assert.deepEqual(r.summary.by_origin, {
    gsc: { rows: 3, domains: 2 },
    bing: { rows: 2, domains: 2 },
    both: { rows: 1, domains: 1 },
  }, 'a row both sources reported counts in gsc, in bing, and in both');
  assert.notEqual(r.sample_note, GSC_ONLY_NOTE);
  assert.match(r.sample_note, /Search Console/);
  assert.match(r.sample_note, /Bing/);
  assert.match(r.sample_note, /1 linking page\(s\) are reported by both, which corroborates them/);
  assert.match(r.sample_note, /Neither source, nor both together, is a complete link profile/);

  // Bing's target counts without --live: pricing is linked, docs is not.
  assert.equal(r.summary.verified, 0, 'nothing was fetched');
  assert.equal(r.summary.targetsKnown, 2);
  assert.equal(r.summary.linkedOwnPages, 1, 'www and trailing slash normalise to one page');
  assert.deepEqual(r.unlinkedHighValuePages.map(p => p.url), ['https://acme.io/docs'],
    'a page Bing reports a link to is not listed as receiving none');
  assert.match(r.targets_note, /2 of 4/);

  // ...but Bing says nothing about rel, so equity stays unknown.
  assert.equal(r.summary.followed, 0, 'a Bing report is never a followed link');
  assert.equal(r.summary.nofollowed, 0);
  assert.equal(r.equity.followed, 0);
  assert.equal(r.equity.unknown, 4);
  assert.equal(r.equity.unknown_bing, 2);
  assert.equal(r.summary.equityUnknown, 4);
  assert.match(r.equity.note, /Neither Search Console nor Bing reports whether a link is followed/);
  assert.match(r.equity.note, /2 Bing-reported link\(s\).*until --live checks it/);
}

// ── Bing-only profile: the note still names Search Console, honestly ────────
{
  const db = fixture();
  db.prepare(`INSERT INTO backlinks (project,linking_url,linking_domain,source,origin,imported_at,target_url)
    VALUES ('fx','https://b.example.org/post','b.example.org','bing','bing',1,'https://acme.io/')`).run();
  const r = await runBacklinkAudit(db, 'fx', { skipLedger: true });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.summary.by_origin.gsc, { rows: 0, domains: 0 });
  assert.match(r.sample_note, /No Search Console export is imported/);
  assert.match(r.sample_note, /Bing reports the links its own index has seen/);
  assert.doesNotMatch(r.sample_note, /corroborat/, 'nothing to corroborate against');
  assert.match(r.sample_note, /complete link profile/);
}

// ── --live that learns nothing keeps what Bing reported ─────────────────────
{
  const db = fixture();
  db.exec('CREATE TABLE citability_scores (url TEXT, score INTEGER)');
  db.prepare('INSERT INTO pages VALUES (?,?,?,?)').run(1, 1, 'https://acme.io/pricing', 1);
  db.prepare('INSERT INTO pages VALUES (?,?,?,?)').run(2, 1, 'https://acme.io/docs', 1);
  const ins = db.prepare(`INSERT INTO backlinks (project,linking_url,linking_domain,source,origin,imported_at,target_url,anchor_text)
    VALUES ('fx',?,?,'bing','bing',1,?,?)`);
  ins.run('https://walled.example.com/p', 'walled.example.com', 'https://acme.io/pricing', 'Acme pricing');
  ins.run('https://dead.example.com/p', 'dead.example.com', 'https://acme.io/docs', 'Acme docs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    status: String(url).includes('walled') ? 403 : 404,
    text: async () => '',
  });
  let r;
  try { r = await runBacklinkAudit(db, 'fx', { live: true, skipLedger: true }); }
  finally { globalThis.fetch = realFetch; }
  const walled = db.prepare("SELECT * FROM backlinks WHERE linking_domain='walled.example.com'").get();
  assert.equal(walled.verify_state, 'blocked');
  assert.equal(walled.target_url, 'https://acme.io/pricing', 'a bot wall does not erase Bing\'s target');
  assert.equal(walled.anchor_text, 'Acme pricing');
  assert.equal(walled.link_present, null, '--live semantics unchanged: blocked is unknown');
  assert.equal(r.summary.gone, 1);
  assert.equal(r.summary.unknown, 1);
  assert.equal(r.equity.unknown, 1, 'blocked stays unknown; gone is not counted');
  assert.equal(r.summary.targetsKnown, 1, 'a link proved gone links nothing');
  assert.deepEqual(r.unlinkedHighValuePages.map(p => p.url), ['https://acme.io/docs'],
    'the page only a dead link pointed at receives no links');
}

// ── A database from before origin still audits, as all Search Console ───────
{
  const db = fixture({ legacy: true });
  const cols = db.prepare('PRAGMA table_info(backlinks)').all().map(c => c.name);
  assert.ok(!cols.includes('origin'), 'the legacy fixture really lacks the column');
  const ins = db.prepare(`INSERT INTO backlinks (project,linking_url,linking_domain,source,imported_at)
    VALUES ('fx',?,?,'fx-latest.csv',1)`);
  ins.run('https://a.example.com/1', 'a.example.com');
  ins.run('https://b.example.org/2', 'b.example.org');
  const r = await runBacklinkAudit(db, 'fx', { skipLedger: true });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.summary.by_origin, {
    gsc: { rows: 2, domains: 2 }, bing: { rows: 0, domains: 0 }, both: { rows: 0, domains: 0 },
  });
  assert.equal(r.sample_note, GSC_ONLY_NOTE);
  assert.equal(r.equity.unknown_bing, 0);
  assert.doesNotMatch(r.equity.note, /Bing/);
}

// ── The distinction that matters: unknown is not gone ───────────────────────
{
  const db = fixture();
  const set = (state, present) => db.prepare(`INSERT INTO backlinks
    (project,linking_url,linking_domain,imported_at,checked_at,http_status,verify_state,link_present,rel_nofollow)
    VALUES ('fx',?,?,1,1,?,?,?,?)`);
  let i = 0;
  const add = (state, status, present, nofollow) => set().run(
    `https://s${i++}.example.com/p`, `s${i}.example.com`, status, state, present, nofollow);
  add('ok', 200, 1, 0);            // followed
  add('ok', 200, 1, 1);            // nofollow
  add('ok', 200, 0, null);         // genuinely absent from a rendered page
  add('gone', 404, 0, null);       // dead page
  add('blocked', 403, null, null); // bot wall
  add('unrendered', 200, null, null); // JS-only page, told us nothing
  const r = await runBacklinkAudit(db, 'fx', { skipLedger: true });
  assert.equal(r.summary.followed, 1);
  assert.equal(r.summary.nofollowed, 1);
  assert.equal(r.summary.gone, 2, 'only a dead page and a real absence count as gone');
  assert.equal(r.summary.unknown, 2, 'blocked and unrendered are unknown, never lost');
  assert.equal(r.summary.blocked, 1);
  assert.equal(r.summary.unrendered, 1);
}

// ── No data is a reportable state, not a crash ─────────────────────────────
{
  const r = await runBacklinkAudit(fixture(), 'fx', { skipLedger: true });
  assert.equal(r.status, 'no_data');
  assert.equal(r.missing_inputs.length, 2, 'both routes are named');
  assert.match(r.missing_inputs[0], /seo-intel backlink-import fx/);
  assert.match(r.missing_inputs[1], /seo-intel bing-links fx/);
  assert.match(r.missing_inputs[1], /BING_WEBMASTER_API_KEY/);
}

console.log('backlink fixtures: PASS');
