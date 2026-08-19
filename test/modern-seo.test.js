import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runEntityAudit } from '../analyses/entity/index.js';
import { runTriangulationScan } from '../analyses/triangulation/index.js';
import { runGeoAudit } from '../analyses/geo/index.js';
import { analyzePlatformQueryGaps } from '../analyses/gsc-platform/index.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE domains (id INTEGER PRIMARY KEY, domain TEXT, project TEXT, role TEXT);
  CREATE TABLE pages (id INTEGER PRIMARY KEY, domain_id INTEGER, url TEXT, title TEXT, body_text TEXT, word_count INTEGER, is_indexable INTEGER);
  CREATE TABLE page_schemas (page_id INTEGER, schema_type TEXT, raw_json TEXT);
  CREATE TABLE links (source_id INTEGER, target_url TEXT);
`);
db.prepare('INSERT INTO domains VALUES (?, ?, ?, ?)').run(1, 'example.com', 'fixture', 'target');
db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  1, 1, 'https://example.com/', 'Example docs',
  'Example API is a deterministic integration service.\n\n- First item\n- Second item\n- Third item\n\n```ts\nconst answer = 42;\n```',
  80, 1,
);
db.prepare('INSERT INTO page_schemas VALUES (?, ?, ?)').run(1, 'Organization', JSON.stringify({
  '@type': 'Organization', name: 'Example', url: 'https://example.com/', sameAs: ['https://github.com/example'],
}));
db.prepare('INSERT INTO page_schemas VALUES (?, ?, ?)').run(1, 'TechArticle', JSON.stringify({ '@type': 'TechArticle' }));
db.prepare('INSERT INTO links VALUES (?, ?)').run(1, 'https://github.com/example/project');
db.prepare('INSERT INTO links VALUES (?, ?)').run(1, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

const entity = await runEntityAudit(db, 'fixture', { targetUrl: 'https://example.com/' });
assert.equal(entity.status, 'pass');
assert.equal(entity.summary.homepageOrganizations, 1);
assert.equal(entity.summary.sameAsLinks, 1);

const tri = await runTriangulationScan(db, 'fixture');
assert.equal(tri.pages.length, 1);
assert.equal(tri.pages[0].score, 65, 'local scan does not mistake a YouTube link for an iframe');
assert.equal(tri.pages[0].signals.githubActive, true);
assert.equal(tri.pages[0].signals.technicalSchema, true);
assert.equal(tri.pages[0].signals.videoEmbedded, false);

const geo = await runGeoAudit(db, 'fixture');
assert.equal(geo.pages.length, 1);
assert.ok(geo.pages[0].definition);
assert.equal(geo.pages[0].code.withLanguage, 1);
assert.ok(geo.pages[0].score >= 80);

const platform = analyzePlatformQueryGaps({
  web: { rows: [{ keys: ['solana rpc'], clicks: 5, impressions: 100, position: 9 }] },
  youtube: { rows: [
    { keys: ['solana rpc'], clicks: 10, impressions: 200, position: 4 },
    { keys: ['solana rpc tutorial'], clicks: 12, impressions: 500, position: 3 },
  ] },
  x: { rows: [{ keys: ['solana rpc tutorial'], clicks: 4, impressions: 80, position: 5 }] },
});
assert.equal(platform.summary.highIntentWebContentGaps, 1);
assert.equal(platform.gaps[0].query, 'solana rpc tutorial');
assert.equal(platform.gaps[0].platformSignals.length, 2);
assert.equal(platform.summary.crossSurfaceSerpOpportunities, 1);

console.log('modern SEO module fixtures: PASS');
