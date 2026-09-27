/**
 * analysis parts — the deterministic pieces (analysis/deterministic.js) over
 * hand-built rows and an in-memory database from db/schema.sql, and the
 * narrow judgments (analysis/judgments.js): schema conventions, prompt
 * contents, and runJudgment with a fake model call.
 *
 * SEO_INTEL_FORCE_FREE closes the extended-data gate before technicalGaps
 * runs, so the audit half is skipped on every machine regardless of a licence
 * in ~/.seo-intel; the assertions cover the schema half and that the gated
 * call does not throw.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SEO_INTEL_FORCE_FREE = '1';

import {
  auditKindGaps,
  contentGapClusters,
  demandSections,
  headingTokens,
  keywordGapsFromMatrix,
  schemaTypeGaps,
  stemToken,
  technicalGaps,
} from '../analysis/deterministic.js';
import { DISCIPLINE, JUDGMENTS, JUDGMENT_VERSION, runJudgment } from '../analysis/judgments.js';
import { validate } from '../lib/schema-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const TARGET = 'acme.io';
const COMPETITORS = ['helius.dev', 'quicknode.com', 'alchemy.com'];

// ── keywordGapsFromMatrix ───────────────────────────────────────────────────
{
  const row = (keyword, domain, freq = 1) => ({
    keyword, domain, role: domain === TARGET ? 'target' : 'competitor', location: 'body', freq,
  });
  const matrix = [
    // covered by the target: excluded whatever the competitors do
    row('solana rpc', TARGET, 4), row('solana rpc', 'helius.dev', 9), row('solana rpc', 'quicknode.com', 3),
    // three competitors, multi-word: the top gap
    row('webhook streaming', 'helius.dev', 2), row('webhook streaming', 'quicknode.com', 5), row('webhook streaming', 'alchemy.com', 1),
    // two competitors, multi-word: kept at the floor
    row('archive node', 'helius.dev', 1), row('archive node', 'alchemy.com', 1),
    // two competitors with a higher frequency than archive node: sorts first among the twos
    row('dedicated node', 'helius.dev', 6), row('dedicated node', 'quicknode.com', 6),
    // single word, two competitors: noise
    row('pricing', 'helius.dev', 20), row('pricing', 'quicknode.com', 20),
    // single word, three competitors: a theme
    row('webhooks', 'helius.dev', 2), row('webhooks', 'quicknode.com', 2), row('webhooks', 'alchemy.com', 2),
    // one competitor only
    row('gasless swaps', 'alchemy.com', 7),
    // a domain no longer in the config must not count
    row('legacy thing', 'gone.example', 9), row('legacy thing', 'also-gone.example', 9),
    // case and whitespace fold onto the target's row
    row('  Solana   RPC ', 'alchemy.com', 1),
  ];

  const gaps = keywordGapsFromMatrix(matrix, { targetDomain: TARGET, competitorDomains: COMPETITORS });
  const keywords = gaps.map(g => g.keyword);
  assert.ok(!keywords.includes('solana rpc'), 'a keyword the target covers is not a gap');
  assert.ok(!keywords.includes('pricing'), 'a single word covered by two competitors is noise');
  assert.ok(keywords.includes('webhooks'), 'a single word covered by three competitors is a theme');
  assert.ok(!keywords.includes('gasless swaps'), 'one competitor is below the floor');
  assert.ok(!keywords.includes('legacy thing'), 'domains outside the competitor list do not count');
  assert.deepEqual(keywords, ['webhook streaming', 'webhooks', 'dedicated node', 'archive node'],
    'ordered by competitor_count, then frequency, then keyword');
  assert.deepEqual(gaps[0], {
    keyword: 'webhook streaming', competitor_count: 3,
    covered_by: ['alchemy.com', 'helius.dev', 'quicknode.com'], frequency: 8,
  });

  assert.equal(keywordGapsFromMatrix(matrix, { targetDomain: TARGET, competitorDomains: COMPETITORS, limit: 2 }).length, 2, 'limit caps the list');
  assert.deepEqual(
    keywordGapsFromMatrix(matrix, { targetDomain: TARGET, competitorDomains: COMPETITORS, minCompetitors: 3 }).map(g => g.keyword),
    ['webhook streaming', 'webhooks'], 'minCompetitors raises the floor');

  // Without a competitor list the role column decides, and 'owned' rows are the target's.
  const byRole = keywordGapsFromMatrix([
    { keyword: 'edge cache', domain: 'www.acme.io', role: 'owned', freq: 1 },
    { keyword: 'edge cache', domain: 'a.example', role: 'competitor', freq: 1 },
    { keyword: 'edge cache', domain: 'b.example', role: 'competitor', freq: 1 },
    { keyword: 'rate limits', domain: 'a.example', role: 'competitor', freq: 1 },
    { keyword: 'rate limits', domain: 'b.example', role: 'competitor', freq: 1 },
  ], { targetDomain: TARGET });
  assert.deepEqual(byRole.map(g => g.keyword), ['rate limits'], 'owned subdomain rows count as target coverage');
  assert.deepEqual(keywordGapsFromMatrix([], { targetDomain: TARGET }), [], 'no rows, no gaps');
  assert.deepEqual(keywordGapsFromMatrix(null, { targetDomain: TARGET }), [], 'null rows, no gaps');
}

// ── Tokens and stems ────────────────────────────────────────────────────────
{
  assert.equal(stemToken('webhooks'), 'webhook');
  assert.equal(stemToken('indexing'), 'index');
  assert.equal(stemToken('indexed'), 'index');
  assert.equal(stemToken('indexes'), 'index');
  assert.equal(stemToken('queries'), 'query');
  assert.equal(stemToken('status'), 'status', 'a -us word keeps its s');
  assert.equal(stemToken('class'), 'class', 'a -ss word keeps its s');
  assert.deepEqual(headingTokens('Learn more about Webhooks and webhook retries').map(t => t.stem),
    ['webhook', 'retry'], 'stopwords, short words and duplicate stems drop out');
  assert.deepEqual(headingTokens('Get started'), [], 'chrome yields no content tokens');
}

// ── contentGapClusters ──────────────────────────────────────────────────────
{
  const h = (domain, level, text) => ({ domain, role: domain === TARGET ? 'target' : 'competitor', level, text });
  const headings = [
    h(TARGET, 1, 'Solana RPC nodes built for speed'),
    h(TARGET, 2, 'Pricing plans'),
    h(TARGET, 3, 'Dedicated nodes'),
    // uncovered on two competitors → a cluster
    h('helius.dev', 2, 'Webhook streaming for wallets'),
    h('helius.dev', 2, 'Webhook streaming for wallets'),       // sitewide repeat counts once
    h('quicknode.com', 2, 'Webhooks and alerts'),
    h('quicknode.com', 1, 'Webhook retries explained'),
    // covered by the target's headings → not a cluster
    h('helius.dev', 1, 'Pricing plans'),
    h('quicknode.com', 2, 'Solana RPC nodes'),
    // covered through the target's H3 → not a cluster
    h('alchemy.com', 2, 'Dedicated nodes'),
    // uncovered but on one competitor only → dropped with three competitors
    h('alchemy.com', 2, 'Gasless swaps for traders'),
    // an H3 on a competitor is not read
    h('alchemy.com', 3, 'Compliance reporting suite'),
    h('helius.dev', 3, 'Compliance reporting suite'),
  ];

  const clusters = contentGapClusters(headings, { targetDomain: TARGET, competitorDomains: COMPETITORS });
  assert.equal(clusters.length, 1, 'one cluster survives');
  const [webhook] = clusters;
  assert.equal(webhook.key_term, 'webhook', 'keyed on the shared stem\'s most frequent surface form');
  assert.deepEqual(webhook.covered_by, ['helius.dev', 'quicknode.com']);
  assert.equal(webhook.heading_count, 3, 'the sitewide repeat counts once');
  assert.ok(webhook.sample_headings.length <= 5);
  assert.ok(webhook.sample_headings.includes('Webhook streaming for wallets'));
  assert.ok(webhook.sample_headings.includes('Webhooks and alerts'));
  const joined = JSON.stringify(clusters);
  assert.ok(!/pricing/i.test(joined), 'a heading the target covers does not cluster');
  assert.ok(!/gasless/i.test(joined), 'a single-competitor heading drops with several competitors');
  assert.ok(!/compliance/i.test(joined), 'competitor H3s are not read');

  // With one competitor its lone headings are the only evidence, so they stay.
  const solo = contentGapClusters(headings.filter(r => r.domain === TARGET || r.domain === 'alchemy.com'),
    { targetDomain: TARGET, competitorDomains: ['alchemy.com'] });
  assert.deepEqual(solo.map(c => c.key_term), ['gasless'], 'single-competitor rule keeps a one-domain cluster');
  assert.deepEqual(solo[0].covered_by, ['alchemy.com']);

  assert.equal(contentGapClusters(headings, { targetDomain: TARGET, competitorDomains: COMPETITORS, limit: 0 }).length, 0, 'limit applies');
  assert.deepEqual(contentGapClusters([], { targetDomain: TARGET }), [], 'no rows, no clusters');
}

// ── demandSections ──────────────────────────────────────────────────────────
{
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const empty = demandSections(db, 'fx');
  assert.deepEqual(empty, { available: false, quick_wins: [], long_tails: [], counts: { quick_wins: 0, long_tails: 0 } },
    'no rows: not available, empty sections');

  const bare = new DatabaseSync(':memory:');
  assert.equal(demandSections(bare, 'fx').available, false, 'a database without the insights table is tolerated');

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, data) VALUES ('fx', ?, 'active', ?, ?, ?, ?)`);
  const win = (query, page_url, kind, potential_clicks, impressions) => insert.run('gsc_quick_win', `${page_url}|${query}`, now, now,
    JSON.stringify({ page_url, query, impressions, clicks: 3, position: 12.3, ctr: 1.1, expected_ctr: 2.0, kind, potential_clicks,
      recommendation: `Do something about ${query}.` }));
  win('solana rpc pricing', 'https://acme.io/pricing', 'ctr_gap', 55, 900);
  win('cheap rpc node', 'https://acme.io/nodes', 'page_two', 20, 300);
  win('rpc uptime sla', 'https://acme.io/sla', 'both', 19, 200);
  // a dismissed row is not active and must not appear
  db.prepare(`INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, data) VALUES ('fx','gsc_quick_win','dismissed','x|y',?,?,?)`)
    .run(now, now, JSON.stringify({ page_url: 'https://acme.io/x', query: 'y', potential_clicks: 999, kind: 'ctr_gap' }));

  const tail = (query, impressions, best_page) => insert.run('gsc_long_tail', query, now, now,
    JSON.stringify({ query, impressions, clicks: 1, position: 14.2, best_page, best_position: best_page ? 15.1 : null, words: 4,
      recommendation: `Cover ${query}.` }));
  tail('how to run solana validator', 150, 'https://acme.io/validators');
  tail('solana rpc rate limit errors', 40, null);
  tail('websocket subscription solana example', 39, null);

  const sections = demandSections(db, 'fx');
  assert.equal(sections.available, true);
  assert.deepEqual(sections.counts, { quick_wins: 3, long_tails: 3 });

  assert.deepEqual(sections.quick_wins.map(w => [w.page, w.impact]), [
    ['https://acme.io/pricing', 'high'],
    ['https://acme.io/nodes', 'medium'],
    ['https://acme.io/sla', 'low'],
  ], 'impact from potential_clicks: ≥50 high, ≥20 medium, else low; best first');
  const first = sections.quick_wins[0];
  assert.equal(first.source, 'gsc');
  assert.equal(first.issue, 'Snippet losing clicks for "solana rpc pricing"', 'issue names the kind and query, no numbers');
  assert.equal(first.fix, 'Do something about solana rpc pricing.', 'fix is the measured recommendation');
  assert.equal(sections.quick_wins[1].issue, 'Ranking on page two for "cheap rpc node"');
  assert.equal(sections.quick_wins[2].issue, 'Page two and a weak snippet for "rpc uptime sla"');
  for (const w of sections.quick_wins) {
    assert.ok(!Object.keys(w).some(k => k.startsWith('_')), 'ledger bookkeeping fields do not leak into the section');
  }

  assert.deepEqual(sections.long_tails.map(t => [t.phrase, t.priority]), [
    ['how to run solana validator', 'high'],
    ['solana rpc rate limit errors', 'medium'],
    ['websocket subscription solana example', 'low'],
  ], 'priority from impressions: ≥100 high, ≥40 medium, else low');
  assert.deepEqual(
    [sections.long_tails[0].intent, sections.long_tails[0].page_type, sections.long_tails[0].source, sections.long_tails[0].best_page],
    [null, null, 'gsc', 'https://acme.io/validators'], 'Search Console knows no intent or page type');
  assert.equal(sections.long_tails[0].notes, 'Cover how to run solana validator.');
}

// ── schemaTypeGaps / auditKindGaps / technicalGaps (gate closed) ────────────
{
  const rows = [
    { domain: TARGET, role: 'target', url: 'https://acme.io/', schema_type: 'Organization' },
    { domain: 'www.acme.io', role: 'owned', url: 'https://www.acme.io/pricing', schema_type: 'https://schema.org/Product' },
    { domain: 'helius.dev', role: 'competitor', url: 'https://helius.dev/', schema_type: 'Organization' },
    { domain: 'helius.dev', role: 'competitor', url: 'https://helius.dev/faq', schema_type: 'FAQPage' },
    { domain: 'quicknode.com', role: 'competitor', url: 'https://quicknode.com/faq', schema_type: 'FAQPage' },
    { domain: 'quicknode.com', role: 'competitor', url: 'https://quicknode.com/docs/x', schema_type: 'HowTo' },
    { domain: 'alchemy.com', role: 'competitor', url: 'https://alchemy.com/pricing', schema_type: 'Product' },
  ];
  const gaps = schemaTypeGaps(rows, { targetDomain: TARGET });
  assert.deepEqual(gaps.map(g => g.gap), ['No FAQPage schema markup', 'No HowTo schema markup'],
    'types the target (or its owned subdomain) publishes are not gaps; more competitors first');
  assert.deepEqual(gaps[0].competitors_with_it, ['helius.dev', 'quicknode.com']);
  assert.ok(gaps[0].fix.includes('"@type": "FAQPage"'), 'the fix names the JSON-LD type');
  assert.equal(gaps[0].source, 'rule');

  const kinds = auditKindGaps([
    { type: 'title_missing', severity: 'error', url: 'https://acme.io/a' },
    { type: 'title_missing', severity: 'error', url: 'https://acme.io/b' },
    { type: 'meta_desc_too_long', severity: 'warn', url: 'https://acme.io/a' },
    { type: 'redirect_chain', severity: 'warn', url: 'https://acme.io/old' },
    { type: 'redirect_targets_summary', severity: 'info', urls: ['https://acme.io/new'] },
    { type: 'indexable_missing_from_sitemap', severity: 'warn', url: 'https://acme.io/c' },
    { type: 'noindex_header', severity: 'info', url: 'https://acme.io/d' },
  ]);
  assert.deepEqual(kinds.map(k => [k.gap, k.count]), [
    ['Pages without a <title>', 2],
    ['Indexable pages missing from the sitemap', 1],
    ['Meta descriptions over 160 characters', 1],
    ['Pages reached through redirect chains', 1],
    ['Pages served with a noindex X-Robots-Tag', 1],
  ], 'one row per kind, the summary roll-up skipped, largest first');
  assert.ok(kinds[0].fix.includes('2 page(s)'));
  assert.deepEqual(kinds[0].sample_urls, ['https://acme.io/a', 'https://acme.io/b']);
  assert.deepEqual(kinds[0].competitors_with_it, []);

  // The database path, with the extended-data gate closed by SEO_INTEL_FORCE_FREE.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  const dom = db.prepare(`INSERT INTO domains (domain, project, role, first_seen) VALUES (?, 'fx', ?, ${Date.now()})`);
  const targetId = dom.run(TARGET, 'target').lastInsertRowid;
  const heliusId = dom.run('helius.dev', 'competitor').lastInsertRowid;
  const quickId = dom.run('quicknode.com', 'competitor').lastInsertRowid;
  const page = db.prepare(`INSERT INTO pages (domain_id, url, title, crawled_at) VALUES (?, ?, ?, ${Date.now()})`);
  const p1 = page.run(targetId, 'https://acme.io/', null).lastInsertRowid;      // no title: an audit finding, if the audit ran
  const p2 = page.run(heliusId, 'https://helius.dev/faq', 'FAQ').lastInsertRowid;
  const p3 = page.run(quickId, 'https://quicknode.com/faq', 'FAQ').lastInsertRowid;
  const schema = db.prepare(`INSERT INTO page_schemas (page_id, schema_type, raw_json, extracted_at) VALUES (?, ?, '{}', ?)`);
  schema.run(p1, 'Organization', Date.now());
  schema.run(p2, 'FAQPage', Date.now());
  schema.run(p3, 'FAQPage', Date.now());
  schema.run(p3, 'Organization', Date.now());

  const result = await technicalGaps(db, 'fx', { target: { domain: TARGET } });
  assert.deepEqual(result.map(g => g.gap), ['No FAQPage schema markup'], 'gate closed: schema gaps only, no audit rows');
  assert.deepEqual(result[0].competitors_with_it, ['helius.dev', 'quicknode.com']);
  assert.ok(!result.some(g => g.kind), 'no audit-kind rows while the gate is closed');

  const bare = new DatabaseSync(':memory:');
  assert.deepEqual(await technicalGaps(bare, 'fx', { target: { domain: TARGET } }), [], 'a database without the tables yields no gaps and no error');
  assert.deepEqual((await technicalGaps(db, 'fx', {})).map(g => g.gap), ['No FAQPage schema markup'],
    'no target domain configured: the role column still identifies the target');
}

// ── JUDGMENTS: schema conventions ───────────────────────────────────────────
{
  const FORBIDDEN = ['$ref', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'definitions', '$defs'];

  function checkSchema(node, path) {
    assert.ok(node && typeof node === 'object', `${path}: schema node is an object`);
    for (const key of FORBIDDEN) assert.ok(!(key in node), `${path}: no ${key} in the schema (limits live in judgment.limits)`);
    const type = node.type;
    if (type === 'object') {
      assert.equal(node.additionalProperties, false, `${path}: object is closed`);
      const keys = Object.keys(node.properties || {});
      assert.ok(keys.length > 0, `${path}: object has properties`);
      assert.deepEqual([...(node.required || [])].sort(), [...keys].sort(), `${path}: every property is required`);
      for (const k of keys) checkSchema(node.properties[k], `${path}.${k}`);
    } else if (type === 'array') {
      assert.ok(node.items, `${path}: array has items`);
      checkSchema(node.items, `${path}[]`);
    } else {
      const types = Array.isArray(type) ? type : [type];
      for (const t of types) assert.ok(['string', 'integer', 'number', 'boolean', 'null'].includes(t), `${path}: scalar type ${t}`);
      if (node.enum) {
        assert.ok(Array.isArray(node.enum) && node.enum.length > 1, `${path}: enum lists its values`);
        assert.equal(new Set(node.enum).size, node.enum.length, `${path}: enum values are unique`);
      }
    }
  }

  const names = Object.keys(JUDGMENTS);
  assert.deepEqual(names.sort(), ['content_gaps', 'keyword_gaps', 'keyword_inventor', 'long_tails_fallback', 'new_pages', 'positioning']);
  assert.match(JUDGMENT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/, 'version is <date>.<n>');
  for (const [key, j] of Object.entries(JUDGMENTS)) {
    assert.equal(j.name, key, `${key}: name matches its map entry`);
    assert.equal(j.version, JUDGMENT_VERSION, `${key}: carries the shared prompt version`);
    assert.ok(['medium', 'high'].includes(j.effort), `${key}: effort is medium or high`);
    assert.ok(Number.isInteger(j.maxTokens) && j.maxTokens > 0, `${key}: maxTokens is a positive integer`);
    assert.equal(typeof j.buildSystem, 'function', `${key}: buildSystem`);
    assert.equal(typeof j.buildPrompt, 'function', `${key}: buildPrompt`);
    assert.equal(j.schema.type, 'object', `${key}: object at the root`);
    checkSchema(j.schema, key);
    if (j.limits) {
      for (const [path, rule] of Object.entries(j.limits)) {
        assert.ok(typeof path === 'string' && path.length, `${key}: limits path`);
        for (const [k, v] of Object.entries(rule)) {
          assert.ok(['minItems', 'maxItems', 'maxLength'].includes(k), `${key}: limits.${path}.${k} is a known limit`);
          assert.ok(Number.isInteger(v) && v >= 0, `${key}: limits.${path}.${k} is an integer`);
        }
      }
    }
    // Every prompt states the discipline and the JSON-only rule, and tolerates an empty input.
    const system = j.buildSystem({ siteName: 'Acme', url: 'https://acme.io', industry: 'RPC infrastructure' });
    for (const rule of DISCIPLINE) assert.ok(system.includes(rule), `${key}: system states "${rule.slice(0, 30)}…"`);
    assert.ok(system.includes('Acme') && system.includes('RPC infrastructure'), `${key}: system carries the project context`);
    assert.equal(typeof j.buildSystem(undefined), 'string', `${key}: buildSystem tolerates no context`);
    assert.equal(typeof j.buildPrompt({}), 'string', `${key}: buildPrompt tolerates an empty input`);
    assert.equal(typeof j.buildPrompt(), 'string', `${key}: buildPrompt tolerates no input`);
  }
  assert.equal(JUDGMENTS.positioning.effort, 'high', 'positioning is the one judgment worth high effort');
  assert.equal(JUDGMENTS.keyword_gaps.batchSize, 40);
  assert.deepEqual(JUDGMENTS.new_pages.limits.items, { maxItems: 8 }, 'new_pages caps at eight in limits');
  assert.deepEqual(JUDGMENTS.long_tails_fallback.limits.items, { minItems: 20, maxItems: 30 });
  assert.deepEqual(JUDGMENTS.positioning.schema.properties.competitor_map.type, ['string', 'null'], 'competitor_map is nullable');
  assert.deepEqual(JUDGMENTS.keyword_gaps.schema.properties.items.items.properties.intent.enum,
    ['informational', 'commercial', 'navigational', 'transactional']);
}

// ── JUDGMENTS: prompts mention the input and the rules ──────────────────────
{
  const jsonRule = /single JSON object/;

  const kg = JUDGMENTS.keyword_gaps.buildPrompt({
    gaps: [
      { keyword: 'webhook streaming', competitor_count: 3, covered_by: ['helius.dev', 'quicknode.com', 'alchemy.com'] },
      { keyword: 'archive node', competitor_count: 2, covered_by: ['helius.dev', 'alchemy.com'] },
    ],
    target_pages: ['https://acme.io/', 'https://acme.io/pricing'],
  });
  assert.ok(kg.includes('"webhook streaming"') && kg.includes('"archive node"'), 'keyword_gaps lists every keyword');
  assert.ok(kg.includes('helius.dev'), 'keyword_gaps shows covered_by');
  assert.ok(kg.includes('https://acme.io/pricing'), 'keyword_gaps lists the target pages');
  assert.ok(kg.includes('Classify ONLY the 2 keyword(s)') && kg.includes('exactly 2 items'), 'keyword_gaps says: only these, all of these');
  assert.match(kg, jsonRule);
  assert.ok(kg.includes('starting with "/"'), 'keyword_gaps says how a new page path looks');

  const cg = JUDGMENTS.content_gaps.buildPrompt({
    clusters: [{ key_term: 'webhook', sample_headings: ['Webhook streaming for wallets'], covered_by: ['helius.dev'], heading_count: 3 }],
  });
  assert.ok(cg.includes('"webhook"') && cg.includes('Webhook streaming for wallets'), 'content_gaps shows the cluster');
  assert.ok(cg.includes('copied character for character'), 'content_gaps says to echo key_term');
  assert.match(cg, jsonRule);

  const np = JUDGMENTS.new_pages.buildPrompt({
    content_gaps: [{ topic: 'Webhook streaming', format: 'how_to', why_it_matters: 'x', suggested_title: 'Streaming wallet events', covered_by: ['helius.dev'] }],
    long_tails: Array.from({ length: 20 }, (_, i) => ({ phrase: `long tail phrase ${i}`, priority: 'low' })),
    target_pages: ['https://acme.io/'],
    context: { site_architecture: { note: 'Subdomains carry less authority.', properties: [
      { id: 'main', url: 'https://acme.io', platform: 'next', best_for: 'product', difficulty: 'medium' },
      { id: 'blog', url: 'https://blog.acme.io', platform: 'ghost', best_for: 'guides', difficulty: 'low', seo_note: 'separate host' },
    ] } },
  });
  assert.ok(np.includes('Webhook streaming') && np.includes('Streaming wallet events'), 'new_pages shows the gaps');
  assert.ok(np.includes('long tail phrase 14') && !np.includes('long tail phrase 15'), 'new_pages takes at most 15 long tails');
  assert.ok(np.includes('at most 8 pages'), 'new_pages caps at eight in the prompt');
  assert.ok(np.includes('blog.acme.io') && np.includes('separate host'), 'new_pages lists the configured properties');
  assert.match(np, jsonRule);
  const npNoArch = JUDGMENTS.new_pages.buildPrompt({ content_gaps: [], long_tails: [], target_pages: [] });
  assert.ok(npNoArch.includes('none configured'), 'without site_architecture the prompt says so instead of inviting invention');

  const lt = JUDGMENTS.long_tails_fallback.buildPrompt({ seed_keywords: ['solana rpc', { keyword: 'archive node' }] });
  assert.ok(lt.includes('solana rpc') && lt.includes('archive node'), 'long_tails_fallback lists the seeds');
  assert.ok(lt.includes('MODEL-INVENTED') && lt.includes('"model-invented:"'), 'long_tails_fallback marks its output as invented, in the prompt and in notes');
  assert.ok(lt.includes('between 20 and 30'), 'long_tails_fallback asks for 20-30');
  assert.match(lt, jsonRule);

  const target_summary = { domain: TARGET, page_count: 40, avg_word_count: 812.4, product_types: 'rpc', pricing_tiers: 'free,pro', ctas: 'Start free' };
  const posWith = JUDGMENTS.positioning.buildPrompt({
    target_summary, competitor_summaries: [{ domain: 'helius.dev', role: 'competitor', page_count: 90, avg_word_count: 500 }],
  });
  assert.ok(posWith.includes('helius.dev') && posWith.includes('"pages_crawled": 40'), 'positioning shows the summaries');
  assert.ok(posWith.includes('naming only the domains listed'));
  const posWithout = JUDGMENTS.positioning.buildPrompt({ target_summary, competitor_summaries: [] });
  assert.match(posWithout, /NO competitor data/, 'positioning without competitors says so');
  assert.ok(posWithout.includes('competitor_map: null'), 'and asks for a null competitor_map');
  assert.ok(posWithout.includes('Do not name, guess at or imply any competitor'));
  assert.ok(!posWithout.includes('helius.dev'), 'no competitor leaks into the solo prompt');
  assert.match(posWithout, jsonRule);

  const ki = JUDGMENTS.keyword_inventor.buildPrompt({
    target_domain: TARGET, competitor_domains: ['helius.dev'], count: 60,
    top_keywords: [{ keyword: 'webhook streaming', competitor_count: 3 }, 'archive node'],
    intent_instruction: 'Focus primarily on commercial intent keywords.', industry: 'RPC infrastructure',
  });
  assert.ok(ki.includes('acme.io') && ki.includes('helius.dev'), 'keyword_inventor names target and competitors');
  assert.ok(ki.includes('webhook streaming (3 competitors)') && ki.includes('archive node'), 'keyword_inventor lists the signals');
  assert.ok(ki.includes('exactly 60 keyword phrases') && ki.includes('Focus primarily on commercial intent'), 'count and intent instruction carry through');
  assert.ok(ki.includes('traditional') && ki.includes('perplexity') && ki.includes('agent'), 'the three keyword types');
  assert.match(ki, jsonRule);
  assert.ok(JUDGMENTS.keyword_inventor.buildPrompt({ target_domain: TARGET, competitor_domains: [] }).includes('none configured — do not name any'));
}

// ── runJudgment ─────────────────────────────────────────────────────────────
{
  const gaps = [{ keyword: 'webhook streaming', competitor_count: 3, covered_by: ['helius.dev'] }];
  const answer = { items: [{ keyword: 'webhook streaming', intent: 'commercial', difficulty: 'medium', suggested_action: 'new_page',
    suggested_page: '/webhooks', priority: 'high', rationale: 'three competitors cover it' }] };

  // An envelope answer: provenance comes from it.
  const calls = [];
  const fake = async req => { calls.push(req); return { output: answer, provider: 'fake', model: 'fake-1', attempts: 2, ms: 7 }; };
  const logs = [];
  const res = await runJudgment(JUDGMENTS.keyword_gaps, { gaps, target_pages: ['https://acme.io/'], context: { siteName: 'Acme' } },
    { call: fake, provider: 'ignored-when-envelope-knows', model: 'ignored', log: m => logs.push(m) });
  assert.deepEqual(res.output, answer);
  assert.deepEqual(res.provenance, { name: 'keyword_gaps', prompt_version: JUDGMENT_VERSION, provider: 'fake', model: 'fake-1', attempts: 2, ms: 7 });
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.deepEqual(Object.keys(req).sort(), ['effort', 'limits', 'maxTokens', 'model', 'name', 'prompt', 'provider', 'schema', 'system']);
  assert.equal(req.name, 'keyword_gaps');
  assert.equal(req.schema, JUDGMENTS.keyword_gaps.schema, 'the call receives the judgment schema');
  assert.deepEqual(req.limits, { items: { maxItems: 40 } });
  assert.equal(req.effort, 'medium');
  assert.ok(req.system.includes('Acme'), 'system carries the context');
  assert.ok(req.prompt.includes('"webhook streaming"'), 'prompt carries the input');
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('keyword_gaps'));

  // A bare object answer: provenance falls back to the requested provider/model; ms is measured.
  const bare = await runJudgment(JUDGMENTS.keyword_gaps, { gaps }, { call: async () => answer, provider: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(bare.output, answer);
  assert.equal(bare.provenance.provider, 'gemini');
  assert.equal(bare.provenance.model, 'gemini-2.5-flash');
  assert.equal(bare.provenance.attempts, 1);
  assert.ok(Number.isInteger(bare.provenance.ms) && bare.provenance.ms >= 0);

  // A text answer, fenced: parsed.
  const text = await runJudgment(JUDGMENTS.keyword_gaps, { gaps }, { call: async () => `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` });
  assert.deepEqual(text.output, answer);
  assert.deepEqual([text.provenance.provider, text.provenance.model], [null, null], 'nothing known, nothing claimed');

  // An oversize batch is refused before any call is made.
  const big = Array.from({ length: 41 }, (_, i) => ({ keyword: `kw ${i}`, competitor_count: 2, covered_by: ['a.example', 'b.example'] }));
  let called = 0;
  await assert.rejects(
    runJudgment(JUDGMENTS.keyword_gaps, { gaps: big }, { call: async () => { called++; return answer; } }),
    err => err instanceof RangeError && /41 gaps exceed the batch size of 40/.test(err.message),
    'runJudgment refuses more gaps than batchSize');
  assert.equal(called, 0, 'the model is never called for an oversize batch');
  await assert.doesNotReject(runJudgment(JUDGMENTS.keyword_gaps, { gaps: big.slice(0, 40) }, {
    call: async () => ({ items: big.slice(0, 40).map(g => ({ ...answer.items[0], keyword: g.keyword })) }),
  }), 'exactly batchSize is fine');

  // A malformed answer is an error, not an undefined the caller trips on later.
  await assert.rejects(runJudgment(JUDGMENTS.keyword_gaps, { gaps }, { call: async () => ({ output: { nope: 1 } }) }),
    /missing items/, 'a missing root key is reported');
  await assert.rejects(runJudgment(JUDGMENTS.keyword_gaps, { gaps }, { call: async () => ({ output: { items: 'x' } }) }),
    /items is not an array/, 'a non-array items is reported');
  await assert.rejects(runJudgment(JUDGMENTS.positioning, {}, { call: async () => 'no json here' }),
    /no JSON object/, 'a text answer without JSON is reported');
  await assert.rejects(runJudgment(JUDGMENTS.positioning, {}, { call: async () => null }),
    /returned nothing/, 'an empty answer is reported');
  await assert.rejects(runJudgment({ name: 'x' }, {}, { call: async () => ({}) }), TypeError, 'a non-judgment is refused');

  // Positioning without competitors round-trips a null competitor_map.
  const pos = await runJudgment(JUDGMENTS.positioning, { target_summary: { domain: TARGET }, competitor_summaries: [] }, {
    call: async req => {
      assert.match(req.prompt, /NO competitor data/);
      return { output: { market_context: 'm', open_angle: 'o', target_differentiator: 't', competitor_map: null }, provider: 'fake', model: 'f' };
    },
  });
  assert.equal(pos.output.competitor_map, null);
  assert.equal(pos.provenance.name, 'positioning');
}

// ── Every limits path resolves to a node of its schema ──────────────────────
// lib/schema-check.js looks limits up by dotted property path with array
// indices left out. A key it cannot resolve (new_pages once said
// "items[].placement") is never checked, and nothing reports that it is not.
{
  const resolve = (schema, path) => {
    let node = schema;
    for (const seg of path ? path.split('.') : []) {
      const types = [].concat(node?.type || []);
      if (types.includes('array')) node = node.items;
      node = node?.properties?.[seg];
      if (!node) return null;
    }
    return node;
  };
  for (const [key, j] of Object.entries(JUDGMENTS)) {
    for (const path of Object.keys(j.limits || {})) {
      assert.ok(resolve(j.schema, path), `${key}: limits path "${path}" names a property of the schema`);
    }
  }
  const placement = n => Array.from({ length: n }, (_, i) => ({ rank: i + 1, property: 'blog', url: `/p${i}`, reason: 'fits' }));
  const page = n => ({ title: 'T', target_keyword: 'k', content_angle: 'a', why: 'w', priority: 'high', placement: placement(n) });
  const over = validate(JUDGMENTS.new_pages.schema, { items: [page(4)] }, JUDGMENTS.new_pages.limits);
  assert.equal(over.ok, false, 'four placements break the cap of three');
  assert.ok(over.errors.some(e => /placement/.test(e) && /3/.test(e)), `the error names the placement cap: ${over.errors.join('; ')}`);
  assert.equal(validate(JUDGMENTS.new_pages.schema, { items: [page(3)] }, JUDGMENTS.new_pages.limits).ok, true, 'three placements pass');
}

// ── technicalGaps takes the crawl's target domain when the config has none ──
{
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(await technicalGaps(db, 'fx', {}, { targetDomain: 'acme.io' }), [], 'the fallback is accepted without tables');
}

console.log('analysis parts: PASS');
