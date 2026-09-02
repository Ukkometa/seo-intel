/**
 * Backlink audit — import, reclamation, and the absence/unknown distinction.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importBacklinks, hostOf } from '../lib/backlink-import.js';
import { runBacklinkAudit, findOurLink } from '../analyses/backlinks/index.js';

assert.equal(hostOf('https://www.Example.com/a'), 'example.com');
assert.equal(hostOf('not a url'), null);

function fixture() {
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
  assert.ok(r.missing_inputs.length);
}

console.log('backlink fixtures: PASS');
