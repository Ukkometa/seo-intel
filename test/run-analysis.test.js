/**
 * run-analysis — the orchestrator (analysis/run-analysis.js) over an
 * in-memory database built from db/schema.sql and migrateInsightProvenance,
 * seeded with a target, two competitors, keywords, headings, schemas and the
 * Search Console findings the demand analysis would have left in the Ledger.
 *
 * The model is a fake that answers every judgment by name from what the
 * prompt actually contains (the keywords and key_terms it lists), checks its
 * own answers against the judgment schema so a drift in judgments.js fails
 * here rather than in production, and records every request so the tests can
 * assert on prompts: batch sizes, the pages and domains each judgment was
 * shown, the order the judgments ran in.
 *
 * SEO_INTEL_FORCE_FREE closes the extended-data gate before technicalGaps
 * runs, so the technical section is the schema half only, on every machine.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

process.env.SEO_INTEL_FORCE_FREE = '1';

import { getActiveInsights, migrateInsightProvenance } from '../db/db.js';
import { JUDGMENT_VERSION } from '../analysis/judgments.js';
import {
  PIPELINE_VERSION,
  RULES_ONLY_MODEL,
  mergeContentJudgment,
  mergeKeywordJudgment,
  provenanceSections,
  rulesOnlyContentGaps,
  runProjectAnalysis,
} from '../analysis/run-analysis.js';
import { ProviderError } from '../lib/providers.js';
import { validate } from '../lib/schema-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0); // 2026-09-26
const PROJECT = 'fx';
const TARGET = 'acme.io';
const COMPETITORS = ['helius.dev', 'quicknode.com'];
const GAP_COUNT = 45; // more than one keyword batch
const CONFIG = {
  project: PROJECT,
  context: { siteName: 'Acme', url: 'https://acme.io', industry: 'RPC infrastructure' },
  target: { domain: TARGET },
  competitors: COMPETITORS.map(domain => ({ domain })),
};

const reportsDir = mkdtempSync(join(tmpdir(), 'seo-intel-run-analysis-'));
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * A crawled project: the target covers "solana rpc"; both competitors cover
 * it too plus GAP_COUNT multi-word phrases the target lacks; the competitors'
 * webhook headings share no stem with the target's; both publish FAQPage
 * schema the target does not. With `gsc`, the Ledger holds two quick wins and
 * two long tails as analyses/demand writes them.
 */
function seed({ gsc = true, competitorsOnly = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  migrateInsightProvenance(db);
  const dom = db.prepare(`INSERT INTO domains (domain, project, role, first_seen) VALUES (?, ?, ?, ${NOW})`);
  const page = db.prepare(`INSERT INTO pages (domain_id, url, title, crawled_at, word_count, click_depth) VALUES (?, ?, ?, ${NOW}, ?, ?)`);
  const heading = db.prepare('INSERT INTO headings (page_id, level, text) VALUES (?, ?, ?)');
  const keyword = db.prepare(`INSERT INTO keywords (page_id, keyword, location) VALUES (?, ?, 'body')`);
  const schema = db.prepare(`INSERT INTO page_schemas (page_id, schema_type, raw_json, extracted_at) VALUES (?, ?, '{}', ${NOW})`);

  if (!competitorsOnly) {
    const t = dom.run(TARGET, PROJECT, 'target').lastInsertRowid;
    const home = page.run(t, 'https://acme.io/', 'Acme', 800, 0).lastInsertRowid;
    const pricing = page.run(t, 'https://acme.io/pricing', 'Pricing', 400, 1).lastInsertRowid;
    heading.run(home, 1, 'Solana RPC nodes built for speed');
    heading.run(pricing, 2, 'Pricing plans');
    keyword.run(home, 'solana rpc');
    schema.run(home, 'Organization');
  }
  const h = dom.run('helius.dev', PROJECT, 'competitor').lastInsertRowid;
  const q = dom.run('quicknode.com', PROJECT, 'competitor').lastInsertRowid;
  const hp = page.run(h, 'https://helius.dev/', 'Helius', 900, 0).lastInsertRowid;
  const qp = page.run(q, 'https://quicknode.com/', 'QuickNode', 700, 0).lastInsertRowid;
  heading.run(hp, 2, 'Webhook streaming for wallets');
  heading.run(qp, 2, 'Webhooks and alerts');
  heading.run(qp, 1, 'Webhook retries explained');
  schema.run(hp, 'FAQPage');
  schema.run(qp, 'FAQPage');
  for (const p of [hp, qp]) {
    keyword.run(p, 'solana rpc');
    for (let i = 1; i <= GAP_COUNT; i++) keyword.run(p, `gap phrase ${String(i).padStart(2, '0')}`);
  }

  if (gsc) {
    const insert = db.prepare(
      `INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, data) VALUES (?, ?, 'active', ?, ${NOW}, ${NOW}, ?)`);
    insert.run(PROJECT, 'gsc_quick_win', 'https://acme.io/pricing|solana rpc pricing', JSON.stringify({
      page_url: 'https://acme.io/pricing', query: 'solana rpc pricing', impressions: 900, clicks: 3, position: 12.3,
      kind: 'ctr_gap', potential_clicks: 55, recommendation: 'Rewrite the pricing snippet.',
    }));
    insert.run(PROJECT, 'gsc_quick_win', 'https://acme.io/|cheap rpc node', JSON.stringify({
      page_url: 'https://acme.io/', query: 'cheap rpc node', impressions: 300, clicks: 1, position: 14,
      kind: 'page_two', potential_clicks: 20, recommendation: 'Link to the home page from the docs.',
    }));
    insert.run(PROJECT, 'gsc_long_tail', 'how to run solana validator', JSON.stringify({
      query: 'how to run solana validator', impressions: 150, clicks: 1, position: 14.2,
      best_page: 'https://acme.io/validators', words: 5, recommendation: 'Cover how to run solana validator.',
    }));
    insert.run(PROJECT, 'gsc_long_tail', 'solana rpc rate limit errors', JSON.stringify({
      query: 'solana rpc rate limit errors', impressions: 40, clicks: 0, position: 22,
      best_page: null, words: 5, recommendation: 'Cover solana rpc rate limit errors.',
    }));
  }
  return db;
}

// ── Fake model ──────────────────────────────────────────────────────────────

/** Schema-valid answers per judgment, read off the prompt so they echo exactly what was asked. */
function answerFor(req) {
  switch (req.name) {
    case 'keyword_gaps': {
      const keywords = [...req.prompt.matchAll(/"keyword": "([^"]+)"/g)].map(m => m[1]);
      const items = keywords.map(keyword => ({
        keyword, intent: 'commercial', difficulty: 'medium', suggested_action: 'new_page',
        suggested_page: `/${keyword.replace(/\s+/g, '-')}`, priority: 'medium', rationale: 'both competitors cover it',
      }));
      // A keyword the batch never listed: the orchestrator must drop it. Only
      // where it fits under the 40-item limit, or the fake would break its own schema check.
      if (items.length < 40) {
        items.push({ ...items[0], keyword: 'invented keyword', rationale: 'made up' });
      }
      return { items };
    }
    case 'content_gaps': {
      const terms = [...req.prompt.matchAll(/"key_term": "([^"]+)"/g)].map(m => m[1]);
      const items = terms.map(key_term => ({
        key_term, topic: `${key_term} coverage`, covered_by: ['helius.dev', 'quicknode.com'], format: 'how_to',
        why_it_matters: 'Both competitors lead with it.', suggested_title: `A guide to ${key_term}s`,
      }));
      items.push({ ...items[0], key_term: 'phantom', topic: 'phantom cluster' });
      return { items };
    }
    case 'new_pages':
      return { items: [{
        title: 'Webhook streaming guide', target_keyword: 'webhook', content_angle: 'From zero to a streaming wallet feed',
        why: 'Both competitors cover webhooks; the target has nothing.', priority: 'high',
        placement: [{ rank: 1, property: 'main', url: '/webhooks', reason: 'the only property configured' }],
      }] };
    case 'long_tails_fallback':
      return { items: Array.from({ length: 20 }, (_, i) => ({
        phrase: `invented phrase ${i + 1}`, intent: 'informational', page_type: 'blog', priority: 'low',
        notes: 'model-invented: fits the seed keywords.',
      })) };
    case 'positioning':
      return { market_context: 'Two infrastructure vendors and a newcomer.', open_angle: 'Uptime you can audit.',
        target_differentiator: 'Flat pricing.', competitor_map: 'helius.dev sells speed; quicknode.com sells breadth.' };
    default:
      throw new Error(`fake has no answer for ${req.name}`);
  }
}

/**
 * A callModel-shaped fake. `fail(req)` returns an error to throw for that
 * request, or null. Every answer is validated against the judgment's schema
 * and limits before it is returned.
 */
function makeFake({ fail = () => null } = {}) {
  const calls = [];
  const fake = async req => {
    calls.push(req);
    const boom = fail(req);
    if (boom) throw boom;
    const output = answerFor(req);
    const check = validate(req.schema, output, req.limits || {});
    assert.ok(check.ok, `fake ${req.name} answer is schema-valid: ${check.errors.join('; ')}`);
    return { output, provider: 'anthropic', model: 'claude-opus-5', attempts: 1, ms: 5 };
  };
  fake.calls = calls;
  fake.named = name => calls.filter(c => c.name === name);
  return fake;
}

const MODEL_OPTS = { provider: 'anthropic', model: 'claude-opus-5', reportsDir, now: NOW, env: {} };
const rowsOf = (db, type) => db.prepare('SELECT * FROM insights WHERE project = ? AND type = ? ORDER BY id').all(PROJECT, type);

// ── Pure helpers ────────────────────────────────────────────────────────────
{
  const batch = [
    { keyword: 'a b', competitor_count: 2, covered_by: ['x.example', 'y.example'] },
    { keyword: 'c d', competitor_count: 3, covered_by: ['x.example', 'y.example', 'z.example'] },
  ];
  const m = mergeKeywordJudgment(batch, [
    { keyword: 'A  B', intent: 'commercial', competitor_count: 99, covered_by: ['invented.example'] },
    { keyword: 'zzz', intent: 'navigational' },
    { keyword: 'a b', intent: 'duplicate' },
  ]);
  assert.deepEqual(m.items, [{ keyword: 'a b', intent: 'commercial', competitor_count: 2, covered_by: ['x.example', 'y.example'] }],
    'case and whitespace fold onto the batch keyword; the measured fields win over the model\'s');
  assert.deepEqual(m.dropped, ['zzz', 'a b'], 'an invented keyword and a duplicate are dropped');
  assert.deepEqual(m.unlabelled, ['c d'], 'a keyword the model skipped is counted, not filled in');
  assert.deepEqual(mergeKeywordJudgment(batch, null), { items: [], dropped: [], unlabelled: ['a b', 'c d'] });

  const clusters = [{ key_term: 'webhook', sample_headings: ['Webhooks and alerts'], covered_by: ['h.example'], heading_count: 3 }];
  const c = mergeContentJudgment(clusters, [
    { key_term: 'Webhook', topic: 'Webhook streaming', covered_by: ['invented.example'], format: 'how_to', why_it_matters: 'w', suggested_title: 's' },
    { key_term: 'phantom', topic: 'p', covered_by: [], format: 'blog', why_it_matters: 'w', suggested_title: 's' },
  ]);
  assert.deepEqual(c.items, [{
    topic: 'Webhook streaming', covered_by: ['h.example'], format: 'how_to', why_it_matters: 'w', suggested_title: 's',
    key_term: 'webhook', heading_count: 3, sample_headings: ['Webhooks and alerts'],
  }], 'covered_by is the cluster\'s, never the model\'s');
  assert.deepEqual(c.dropped, ['phantom']);
  assert.deepEqual(c.unlabelled, []);

  assert.deepEqual(rulesOnlyContentGaps(clusters)[0], {
    topic: 'webhook', covered_by: ['h.example'], format: null, why_it_matters: null, suggested_title: null,
    key_term: 'webhook', heading_count: 3, sample_headings: ['Webhooks and alerts'],
  }, 'a rules-only cluster carries the model\'s fields as null');

  const rule = { sourceKind: 'rule', ruleVersion: '1' };
  const model = { sourceKind: 'model', promptVersion: JUDGMENT_VERSION };
  assert.deepEqual(provenanceSections({ noModel: false, sections: { long_tails: 'gsc' } }), {
    quick_wins: rule, long_tails: rule, technical_gaps: rule, keyword_gaps: model, content_gaps: model, new_pages: model, positioning: model,
  });
  assert.deepEqual(provenanceSections({ noModel: false, sections: { long_tails: 'model' } }).long_tails, model, 'invented long tails are the model\'s');
  const rulesOnly = provenanceSections({ noModel: true, sections: { long_tails: 'none' } });
  assert.deepEqual([rulesOnly.keyword_gaps, rulesOnly.content_gaps], [rule, rule], 'nothing a rules-only run wrote is stamped model');
}

// ── Full run ────────────────────────────────────────────────────────────────
{
  const db = seed();
  const fake = makeFake();
  const logs = [];
  const res = await runProjectAnalysis(db, PROJECT, CONFIG, { ...MODEL_OPTS, call: fake, log: m => logs.push(m) });
  const { analysis, analysisId, provenance, savedPath, judgmentsPath } = res;

  // Shape.
  assert.deepEqual(Object.keys(analysis).sort(),
    ['content_gaps', 'keyword_gaps', 'long_tails', 'new_pages', 'pipeline', 'positioning', 'quick_wins', 'technical_gaps']);
  assert.equal(provenance, analysis.pipeline, 'the returned provenance is the pipeline block');
  assert.equal(analysis.pipeline.version, PIPELINE_VERSION);
  assert.equal(PIPELINE_VERSION, '2');
  assert.deepEqual([analysis.pipeline.provider, analysis.pipeline.model], ['anthropic', 'claude-opus-5']);
  assert.deepEqual(analysis.pipeline.sections, {
    keyword_gaps: 'model', long_tails: 'gsc', quick_wins: 'gsc', content_gaps: 'model',
    new_pages: 'model', technical_gaps: 'rule', positioning: 'model',
  });
  assert.deepEqual(analysis.pipeline.failures, []);

  // The prompts the fake received.
  assert.deepEqual(fake.calls.map(c => c.name), ['keyword_gaps', 'keyword_gaps', 'content_gaps', 'new_pages', 'positioning'],
    'judgments run in dependency order; long_tails_fallback is not called when Search Console rows exist');
  const kgCalls = fake.named('keyword_gaps');
  const sizes = kgCalls.map(c => Number(c.prompt.match(/Classify ONLY the (\d+) keyword/)[1]));
  assert.deepEqual(sizes, [40, 5], `${GAP_COUNT} gaps go out as a full batch and the remainder; no batch exceeds 40`);
  for (const c of kgCalls) {
    assert.ok(c.prompt.includes('https://acme.io/pricing') && c.prompt.includes('https://acme.io/'), 'keyword_gaps is shown the target pages');
    assert.ok(c.system.includes('Acme') && c.system.includes('RPC infrastructure'), 'the project context reaches the system prompt');
    assert.deepEqual([c.provider, c.model], ['anthropic', 'claude-opus-5'], 'the resolved provider is passed to every call');
  }
  const [pos] = fake.named('positioning');
  assert.ok(pos.prompt.includes('helius.dev') && pos.prompt.includes('quicknode.com'), 'positioning sees both competitors');
  assert.ok(pos.prompt.includes('"domain": "acme.io"'), 'and the target under its configured domain');
  assert.match(pos.prompt, /Competitor summaries \(2\)/);
  const [np] = fake.named('new_pages');
  assert.ok(np.prompt.includes('webhook coverage'), 'new_pages sees the named content gap');
  assert.ok(np.prompt.includes('how to run solana validator'), 'new_pages sees the measured long tails');
  assert.ok(np.prompt.includes('"source": "gsc"'), 'and knows they were measured');
  const [cg] = fake.named('content_gaps');
  assert.ok(cg.prompt.includes('"key_term": "webhook"') && cg.prompt.includes('Webhook streaming for wallets'));

  // keyword_gaps: every measured gap, labelled, with the measured fields kept.
  assert.equal(analysis.keyword_gaps.length, GAP_COUNT);
  assert.equal(new Set(analysis.keyword_gaps.map(k => k.keyword)).size, GAP_COUNT, 'no keyword twice');
  assert.ok(!analysis.keyword_gaps.some(k => k.keyword === 'invented keyword'), 'an item whose keyword was not in the batch is dropped');
  for (const k of analysis.keyword_gaps) {
    assert.equal(k.competitor_count, 2);
    assert.deepEqual(k.covered_by, ['helius.dev', 'quicknode.com']);
    assert.equal(k.intent, 'commercial');
    assert.equal(k.suggested_action, 'new_page');
  }
  assert.equal(analysis.keyword_gaps[0].keyword, 'gap phrase 01', 'deterministic order survives the merge');

  // content_gaps: the model's naming on the cluster's facts.
  assert.equal(analysis.content_gaps.length, 1, 'the phantom cluster is dropped');
  assert.deepEqual(pick(analysis.content_gaps[0], ['topic', 'covered_by', 'format', 'why_it_matters', 'suggested_title', 'heading_count']), {
    topic: 'webhook coverage', covered_by: ['helius.dev', 'quicknode.com'], format: 'how_to',
    why_it_matters: 'Both competitors lead with it.', suggested_title: 'A guide to webhooks', heading_count: 3,
  });

  // Measured sections, straight from the Ledger.
  assert.deepEqual(analysis.quick_wins.map(w => [w.page, w.impact, w.source]),
    [['https://acme.io/pricing', 'high', 'gsc'], ['https://acme.io/', 'medium', 'gsc']]);
  assert.deepEqual(analysis.long_tails.map(t => [t.phrase, t.priority, t.source]),
    [['how to run solana validator', 'high', 'gsc'], ['solana rpc rate limit errors', 'medium', 'gsc']]);
  assert.deepEqual(analysis.technical_gaps.map(g => [g.gap, g.source]), [['No FAQPage schema markup', 'rule']]);
  assert.deepEqual(analysis.technical_gaps[0].competitors_with_it, ['helius.dev', 'quicknode.com']);

  assert.equal(analysis.new_pages.length, 1);
  assert.equal(analysis.positioning.competitor_map, 'helius.dev sells speed; quicknode.com sells breadth.');

  // The judgments log.
  assert.deepEqual(analysis.pipeline.judgments.map(j => j.name), ['keyword_gaps', 'keyword_gaps', 'content_gaps', 'new_pages', 'positioning']);
  assert.deepEqual(analysis.pipeline.judgments[0], { name: 'keyword_gaps', prompt_version: JUDGMENT_VERSION, batch: 1, of: 2, attempts: 1, ms: 5 });
  assert.deepEqual(analysis.pipeline.judgments[4], { name: 'positioning', prompt_version: JUDGMENT_VERSION, attempts: 1, ms: 5 });

  // The analyses row.
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(analysisId);
  assert.equal(row.project, PROJECT);
  assert.equal(row.model, 'anthropic:claude-opus-5', 'analyses.model names provider and model');
  assert.equal(row.generated_at, NOW, 'the injected clock stamps the row');
  assert.equal(JSON.parse(row.keyword_gaps).length, GAP_COUNT);
  assert.equal(JSON.parse(row.quick_wins).length, 2);
  assert.equal(JSON.parse(row.positioning).open_angle, 'Uptime you can audit.');
  const raw = JSON.parse(row.raw);
  assert.equal(raw.version, '2');
  assert.equal(raw.judgments.length, 5, 'raw holds the judgments log, not a model transcript');
  assert.deepEqual(raw.sections, analysis.pipeline.sections);

  // The two report files.
  assert.equal(savedPath, join(reportsDir, 'fx-analysis-2026-09-26.json'));
  assert.equal(judgmentsPath, join(reportsDir, 'fx-judgments-2026-09-26.json'));
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  assert.equal(saved.pipeline.version, '2');
  assert.equal(saved.keyword_gaps.length, GAP_COUNT);
  const debug = JSON.parse(readFileSync(judgmentsPath, 'utf8'));
  assert.equal(debug.model, 'anthropic:claude-opus-5');
  assert.equal(debug.judgments.length, 5);
  assert.ok(debug.judgments[0].prompt.includes('Classify ONLY the 40 keyword'), 'the debug file keeps each prompt');
  assert.ok(debug.judgments[0].system.includes('Acme'));
  assert.equal(debug.judgments[0].output.items.length, 40, 'and each output');
  assert.deepEqual(debug.judgments[1].dropped, ['invented keyword'], 'and what the merge dropped');
  assert.deepEqual(debug.judgments[1].unlabelled, []);
  assert.deepEqual(debug.judgments[2].dropped, ['phantom']);

  // The Ledger: measured sections are rule findings, judged ones are the model's.
  const quickWins = rowsOf(db, 'quick_win');
  assert.equal(quickWins.length, 2);
  for (const r of quickWins) {
    assert.equal(r.source_kind, 'rule', 'a quick win read from Search Console is a rule finding');
    assert.equal(r.rule_version, '1');
    assert.equal(r.confidence, 1);
    assert.equal(r.expires_at, null, 'and never expires');
    assert.equal(r.model, null);
    assert.equal(r.prompt_version, null);
    assert.equal(r.source_analysis_id, analysisId);
  }
  const longTails = rowsOf(db, 'long_tail');
  assert.equal(longTails.length, 2);
  assert.deepEqual(longTails.map(r => [r.source_kind, r.expires_at]), [['rule', null], ['rule', null]], 'measured long tails are rules');
  const technical = rowsOf(db, 'technical_gap');
  assert.deepEqual(technical.map(r => [r.source_kind, r.rule_version, r.expires_at]), [['rule', '1', null]]);

  const contentGaps = rowsOf(db, 'content_gap');
  assert.equal(contentGaps.length, 1);
  assert.equal(contentGaps[0].source_kind, 'model', 'a judged content gap is the model\'s');
  assert.equal(contentGaps[0].prompt_version, JUDGMENT_VERSION, 'stamped with the judgment version');
  assert.equal(contentGaps[0].model, 'anthropic:claude-opus-5');
  assert.equal(contentGaps[0].rule_version, null);
  assert.equal(contentGaps[0].expires_at, NOW + 90 * DAY_MS, 'and expires 90 days from the run');
  assert.equal(contentGaps[0].confidence, null, 'no confidence was claimed, none is invented');
  const keywordGaps = rowsOf(db, 'keyword_gap');
  assert.equal(keywordGaps.length, GAP_COUNT);
  assert.ok(keywordGaps.every(r => r.source_kind === 'model' && r.prompt_version === JUDGMENT_VERSION));
  assert.deepEqual(rowsOf(db, 'new_page').map(r => r.source_kind), ['model']);
  assert.deepEqual(rowsOf(db, 'positioning').map(r => [r.source_kind, r.prompt_version]), [['model', JUDGMENT_VERSION]]);
  assert.equal(rowsOf(db, 'gsc_quick_win').length, 2, 'the demand rows the run read are untouched');

  const active = getActiveInsights(db, PROJECT, NOW);
  assert.equal(active.quick_wins[0]._source_kind, 'rule');
  assert.equal(active.content_gaps[0]._source_kind, 'model');
  assert.equal(active.content_gaps[0]._model, 'anthropic:claude-opus-5');

  assert.ok(logs.some(l => /judgments → anthropic \(claude-opus-5\)/.test(l)), 'the run says which provider it resolved');
  assert.ok(logs.some(l => /saved analyses row/.test(l)));
}

// ── Rules only ──────────────────────────────────────────────────────────────
{
  const db = seed();
  const fake = makeFake();
  // No provider, no env: a rules-only run must not so much as resolve one.
  const res = await runProjectAnalysis(db, PROJECT, CONFIG, { noModel: true, call: fake, reportsDir, now: NOW, env: {} });
  assert.equal(fake.calls.length, 0, 'no model call in a rules-only run');
  assert.equal(db.prepare('SELECT model FROM analyses WHERE id = ?').get(res.analysisId).model, RULES_ONLY_MODEL);
  assert.equal(RULES_ONLY_MODEL, 'rules-only');
  assert.deepEqual(res.analysis.pipeline, {
    version: '2', provider: null, model: null,
    sections: { keyword_gaps: 'rule', long_tails: 'gsc', quick_wins: 'gsc', content_gaps: 'rule', new_pages: 'none', technical_gaps: 'rule', positioning: 'none' },
    judgments: [], failures: [],
  });

  assert.equal(res.analysis.keyword_gaps.length, GAP_COUNT);
  assert.deepEqual(Object.keys(res.analysis.keyword_gaps[0]).sort(), ['competitor_count', 'covered_by', 'keyword'],
    'rules-only keyword gaps are the measured rows: no intent, nothing guessed');
  assert.deepEqual(pick(res.analysis.content_gaps[0], ['topic', 'covered_by', 'format', 'why_it_matters', 'suggested_title']), {
    topic: 'webhook', covered_by: ['helius.dev', 'quicknode.com'], format: null, why_it_matters: null, suggested_title: null,
  }, 'rules-only content gaps keep the consumer shape with the model\'s fields null');
  assert.deepEqual(res.analysis.new_pages, []);
  assert.deepEqual(res.analysis.positioning, {});
  assert.equal(res.analysis.quick_wins.length, 2);
  assert.equal(res.analysis.long_tails.length, 2);
  assert.equal(res.analysis.technical_gaps.length, 1);
  // The shape a consumer reads: every list is a list, positioning an object.
  for (const k of ['keyword_gaps', 'long_tails', 'content_gaps', 'quick_wins', 'new_pages', 'technical_gaps']) {
    assert.ok(Array.isArray(res.analysis[k]), `${k} is an array`);
  }

  const kg = rowsOf(db, 'keyword_gap');
  assert.equal(kg.length, GAP_COUNT);
  assert.ok(kg.every(r => r.source_kind === 'rule' && r.rule_version === '1' && r.expires_at === null && r.model === null),
    'rules-only keyword gaps are rule findings');
  assert.deepEqual(rowsOf(db, 'content_gap').map(r => [r.source_kind, r.prompt_version]), [['rule', null]]);
  assert.equal(rowsOf(db, 'positioning').length, 0, 'an empty positioning writes no row');
  assert.equal(rowsOf(db, 'new_page').length, 0);
  assert.equal(rowsOf(db, 'quick_win').length, 2);
  assert.ok(JSON.parse(readFileSync(res.savedPath, 'utf8')).pipeline.sections.keyword_gaps === 'rule');
}

// ── One judgment fails ──────────────────────────────────────────────────────
{
  const db = seed();
  const truncated = new ProviderError('anthropic (claude-opus-5): the answer was cut off at 4000 tokens', {
    provider: 'anthropic', model: 'claude-opus-5', kind: 'truncated', hint: 'Raise maxTokens, or ask for fewer items per call.',
  });
  const fake = makeFake({ fail: req => (req.name === 'content_gaps' ? truncated : null) });
  const logs = [];
  const res = await runProjectAnalysis(db, PROJECT, CONFIG, { ...MODEL_OPTS, call: fake, log: m => logs.push(m) });

  assert.deepEqual(res.analysis.content_gaps, [], 'the failed section is empty, not filled in');
  assert.deepEqual(res.analysis.pipeline.failures, [{
    name: 'content_gaps', kind: 'truncated', error: truncated.message, hint: 'Raise maxTokens, or ask for fewer items per call.',
  }]);
  assert.equal(res.analysis.pipeline.sections.content_gaps, 'none');
  assert.equal(res.analysis.pipeline.sections.keyword_gaps, 'model', 'the other sections are unaffected');
  assert.equal(res.analysis.pipeline.sections.positioning, 'model');
  assert.ok(!res.analysis.pipeline.judgments.some(j => j.name === 'content_gaps'), 'a failed judgment is not in the success log');
  assert.equal(res.analysis.keyword_gaps.length, GAP_COUNT);
  assert.equal(res.analysis.new_pages.length, 1, 'new_pages still ran, from the long tails');
  const [np] = fake.named('new_pages');
  assert.ok(!np.prompt.includes('webhook coverage') && np.prompt.includes('how to run solana validator'),
    'new_pages was shown what survived and nothing invented for the hole');
  assert.ok(logs.some(l => /content_gaps failed: .*cut off/.test(l) && /leaving the section empty/.test(l)));

  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(res.analysisId);
  assert.ok(row, 'the analyses row is still written');
  assert.equal(row.model, 'anthropic:claude-opus-5');
  assert.deepEqual(JSON.parse(row.content_gaps), []);
  assert.equal(JSON.parse(row.raw).failures.length, 1);
  assert.equal(rowsOf(db, 'content_gap').length, 0);
  assert.equal(rowsOf(db, 'keyword_gap').length, GAP_COUNT);
  assert.equal(rowsOf(db, 'quick_win').length, 2);

  const debug = JSON.parse(readFileSync(res.judgmentsPath, 'utf8'));
  const failed = debug.judgments.find(j => j.name === 'content_gaps');
  assert.equal(failed.kind, 'truncated');
  assert.ok(failed.prompt.includes('"key_term": "webhook"'), 'the debug file keeps the prompt that failed');
  assert.equal(failed.output, undefined);
}

// ── Every judgment fails ────────────────────────────────────────────────────
{
  const db = seed();
  const before = db.prepare('SELECT COUNT(*) c FROM analyses').get().c;
  const fake = makeFake({
    fail: req => new ProviderError(`anthropic (claude-opus-5): HTTP 401 invalid x-api-key [${req.name}]`, {
      provider: 'anthropic', model: 'claude-opus-5', status: 401, kind: 'auth', hint: 'Check ANTHROPIC_API_KEY in .env, or run: seo-intel setup',
    }),
  });
  await assert.rejects(
    runProjectAnalysis(db, PROJECT, CONFIG, { ...MODEL_OPTS, call: fake }),
    err => err instanceof ProviderError && err.kind === 'auth' && /\[keyword_gaps\]/.test(err.message),
    'when every judgment fails the first error is rethrown');
  assert.equal(fake.calls.length, 5, 'every judgment was still attempted before giving up');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM analyses').get().c, before, 'no analyses row for a run with nothing in it');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM insights WHERE type IN ('quick_win', 'keyword_gap', 'technical_gap')").get().c, 0,
    'and nothing written to the Ledger');
}

// ── No Search Console data: invented long tails, marked as such ─────────────
{
  const db = seed({ gsc: false });
  const fake = makeFake();
  const res = await runProjectAnalysis(db, PROJECT, CONFIG, { ...MODEL_OPTS, call: fake });

  assert.deepEqual(fake.calls.map(c => c.name), ['keyword_gaps', 'keyword_gaps', 'content_gaps', 'long_tails_fallback', 'new_pages', 'positioning']);
  const [lt] = fake.named('long_tails_fallback');
  assert.ok(lt.prompt.includes('gap phrase 01'), 'the seeds are the measured keyword gaps');
  assert.ok(lt.prompt.includes('MODEL-INVENTED'));
  assert.equal(res.analysis.long_tails.length, 20);
  assert.ok(res.analysis.long_tails.every(t => t.source === 'model' && t.notes.startsWith('model-invented:')),
    'every invented phrase says so');
  assert.deepEqual(res.analysis.quick_wins, [], 'no quick wins without Search Console; none invented either');
  assert.equal(res.analysis.pipeline.sections.long_tails, 'model');
  assert.equal(res.analysis.pipeline.sections.quick_wins, 'none');
  assert.ok(fake.named('new_pages')[0].prompt.includes('invented phrase 1'), 'new_pages sees the invented phrases');
  assert.ok(fake.named('new_pages')[0].prompt.includes('"source": "model"'), 'and knows they were invented');

  const rows = rowsOf(db, 'long_tail');
  assert.equal(rows.length, 20);
  for (const r of rows) {
    assert.equal(r.source_kind, 'model', 'an invented long tail is the model\'s');
    assert.equal(r.prompt_version, JUDGMENT_VERSION);
    assert.equal(r.model, 'anthropic:claude-opus-5');
    assert.equal(r.expires_at, NOW + 90 * DAY_MS);
  }
  assert.equal(rowsOf(db, 'quick_win').length, 0);
}

// ── Nothing to analyse ──────────────────────────────────────────────────────
{
  const empty = new DatabaseSync(':memory:');
  empty.exec(SCHEMA_SQL);
  await assert.rejects(runProjectAnalysis(empty, PROJECT, CONFIG, { noModel: true, reportsDir, now: NOW }),
    /No crawl data found for "fx"/, 'no crawl: a clear error the CLI prints');
  assert.equal(empty.prepare('SELECT COUNT(*) c FROM analyses').get().c, 0);

  const noTarget = seed({ competitorsOnly: true });
  await assert.rejects(runProjectAnalysis(noTarget, PROJECT, CONFIG, { noModel: true, reportsDir, now: NOW }),
    /No target site data found for "fx"/, 'competitors only: a clear error the CLI prints');
}

rmSync(reportsDir, { recursive: true, force: true });
// ── A competitor removed from the config reaches no judgment ────────────────
// The gap arithmetic already used the configured list; positioning was handed
// every crawled competitor row, so a domain the project stopped tracking was
// shown to the model and could be named in competitor_map.
{
  const db = seed();
  const stale = db.prepare(`INSERT INTO domains (domain, project, role, first_seen) VALUES ('removed.example', ?, 'competitor', ${NOW})`).run(PROJECT).lastInsertRowid;
  db.prepare(`INSERT INTO pages (domain_id, url, title, crawled_at, word_count, click_depth) VALUES (?, 'https://removed.example/', 'Gone', ${NOW}, 500, 0)`).run(stale);
  const fake = makeFake();
  await runProjectAnalysis(db, PROJECT, CONFIG, { ...MODEL_OPTS, call: fake, log: () => {} });
  const [pos] = fake.named('positioning');
  assert.ok(pos.prompt.includes('helius.dev') && pos.prompt.includes('quicknode.com'), 'the configured competitors are still there');
  assert.ok(!pos.prompt.includes('removed.example'), 'a competitor the config no longer names is not shown to positioning');
  for (const c of fake.calls) assert.ok(!c.prompt.includes('removed.example'), `${c.name}: no stale competitor in any prompt`);
}

console.log('run-analysis: PASS');
