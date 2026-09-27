/**
 * analysis/run-analysis.js — one competitive analysis of one project, from
 * crawl rows to Ledger rows, with a receipt for every section.
 *
 * The analysis used to be one prompt. analysis/prompt-builder.js packed the
 * whole keyword matrix, every heading, and seven tasks into a single request
 * — count the keyword gaps, invent long tails, cluster content gaps, find
 * quick wins, propose pages, audit the schema, write the positioning — and
 * asked for one JSON document back. No schema was sent, nothing checked the
 * answer against one, and the same prompt went to whichever model happened
 * to be reachable: a Gemini CLI, the Agent Harness, a local Ollama tag. The
 * caller regex-hunted the first brace and parsed what it found. Three copies
 * of that flow lived in cli.js (analyze, the run scheduler, the scan step),
 * each with its own way of recording which model answered.
 *
 * What went wrong was not the model. A single call carrying seven tasks does
 * the first few and abbreviates the rest: sixty keywords became forty, counts
 * were rounded, and where the data ran thin the answer filled in domains it
 * had never been shown. Every consumer downstream then stored those as
 * findings with the same provenance as the real ones, because there was only
 * one provenance to give: "the model said so".
 *
 * So the flow is split by what each part actually is:
 *
 *   computed  (analysis/deterministic.js) — keyword gaps are a set difference
 *             over the keywords table; content gap clusters are competitor
 *             headings whose stems the target never uses; quick wins and long
 *             tails are Search Console rows the demand analysis already
 *             measured; technical gaps are schema types the target lacks and
 *             the audit's own findings. Facts, re-derivable from the rows,
 *             written as rule findings that never expire and resolve when the
 *             rule stops firing.
 *   judged    (analysis/judgments.js) — the intent, difficulty and action of
 *             each keyword gap; the name and format of each cluster; the
 *             positioning. One task per call, a closed schema per task, only
 *             the data the task needs, forty items at most. Hypotheses,
 *             written as model findings with the prompt version that produced
 *             them, expiring unless re-emitted.
 *   generated (also judgments.js) — new pages to create, and long-tail
 *             phrases only when no Search Console data exists to measure them,
 *             every one marked model-invented in its own notes.
 *
 * This module is the orchestrator of that split: it gathers the rows, runs
 * the arithmetic, runs each judgment against one provider resolved once,
 * merges the model's labels back onto the measured rows by key (never by
 * fuzzy match: the prompt told the model to copy the key), assembles the
 * legacy analysis shape every consumer already reads, and stamps a `pipeline`
 * block that says which section came from where. `pipeline.sections` is the
 * per-section source; db/db.js upsertInsightsFromAnalysis takes the same map
 * as `meta.sections` so the Ledger rows carry it too.
 *
 * Why a failed judgment leaves a hole rather than a guess. When a provider
 * refuses, times out, or cannot produce the schema after one repair, the old
 * flow lost the whole analysis; the temptation is to lose nothing by filling
 * the section from what the model did not say. But a section that appears
 * full and is partly invented is worse than one that is visibly empty: the
 * Ledger would stamp the filler with a prompt version and a model that never
 * produced it, the review would treat it as a hypothesis worth a person's
 * time, and nobody could tell it from a real answer. So a judgment that fails
 * records { name, error, hint } in pipeline.failures, its section is empty,
 * its status in pipeline.sections is 'none', and the run goes on — unless
 * every judgment failed, which means the provider is down or misconfigured
 * and the person should hear the first error rather than get an analyses row
 * with nothing in it. The same rule applies inside a section: a keyword the
 * model did not label is counted, not stamped with a label it never got, and
 * the deterministic rows remain available from a --no-model run.
 *
 * With opts.noModel the run is the computed part alone: keyword gaps without
 * intent, clusters with the model's fields null, no new pages, no
 * positioning, analyses.model 'rules-only'. The shape stays valid for every
 * consumer, and every row is a rule finding, because that is what it is.
 *
 * Nothing here prints: log lines go through opts.log as plain text and the
 * CLI colours them. fetch never appears; the model is reached only through
 * the injected `call` (lib/providers.js callModel by default).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCompetitorSummary,
  getHeadingStructure,
  getKeywordMatrix,
  upsertInsightsFromAnalysis,
} from '../db/db.js';
import { callModel, resolveProvider } from '../lib/providers.js';
import { contentGapClusters, demandSections, keywordGapsFromMatrix, technicalGaps } from './deterministic.js';
import { JUDGMENTS, runJudgment } from './judgments.js';

/** Stamped on analysis.pipeline.version; '1' is the mega-prompt this replaces. */
export const PIPELINE_VERSION = '2';

/** The rule version stamped on every computed section. Bump when deterministic.js changes what a section means. */
export const RULE_VERSION = '1';

/** analyses.model for a run that asked no model anything. */
export const RULES_ONLY_MODEL = 'rules-only';

const DEFAULT_REPORTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
const KEYWORD_BATCH = JUDGMENTS.keyword_gaps.batchSize || 40;
const TARGET_PAGE_LIMIT = 60;
const NEW_PAGE_LONG_TAILS = 15;
const SEED_KEYWORDS = 40;

const normKey = k => String(k || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ── Gather ──────────────────────────────────────────────────────────────────

/**
 * The target's crawled URLs, for the prompts that may name an existing page.
 * Inline rather than a db.js reader because nothing else wants this list; a
 * database without the tables yields none.
 */
function targetPageUrls(db, project, limit = TARGET_PAGE_LIMIT) {
  try {
    return db.prepare(`
      SELECT p.url FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned')
      ORDER BY p.click_depth, p.url
      LIMIT ?
    `).all(project, limit).map(r => r.url);
  } catch {
    return [];
  }
}

/**
 * Everything the analysis reads, in one place, with the two conditions the
 * CLI always checked first: some crawl data, and a target in it. Both are
 * Errors with a message the CLI prints as-is.
 */
export function gather(db, project, config = {}) {
  const summary = getCompetitorSummary(db, project);
  if (!summary.length) {
    throw new Error(`No crawl data found for "${project}". Run: seo-intel crawl ${project}`);
  }
  const target = summary.find(s => s.role === 'target');
  if (!target) {
    throw new Error(`No target site data found for "${project}". The crawl reached competitors only; crawl the target and run again.`);
  }
  // The merged target row may carry the owned www. spelling; the configured
  // domain is what the prompts and the gap arithmetic should call it.
  if (config?.target?.domain) target.domain = config.target.domain;
  const configured = (config?.competitors || []).map(c => c?.domain).filter(Boolean);
  // One competitor set for the whole run. With a configured list, a crawled
  // competitor the config no longer names is left out of the summaries too,
  // not only out of the gap arithmetic below; otherwise positioning would be
  // shown a domain the project stopped tracking and name it in competitor_map.
  const domainKey = d => String(d || '').trim().toLowerCase().replace(/^www\./, '');
  const configuredKeys = new Set(configured.map(domainKey));
  const competitors = summary
    .filter(s => s.role === 'competitor')
    .filter(s => !configuredKeys.size || configuredKeys.has(domainKey(s.domain)));

  return {
    target,
    competitors,
    targetDomain: target.domain,
    // With a configured list only those domains count (a competitor removed
    // from the config must not resurface); without one, the crawled roles decide.
    competitorDomains: configured.length ? configured : competitors.map(c => c.domain),
    keywordMatrix: getKeywordMatrix(db, project),
    headings: getHeadingStructure(db, project),
    targetPages: targetPageUrls(db, project),
  };
}

// ── Merging labels back onto measured rows ──────────────────────────────────

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The model's labels joined onto the batch by keyword. PURE.
 *
 * competitor_count and covered_by come from the batch, never from the
 * answer: they were measured. An item whose keyword is not in the batch is
 * an invention and is dropped; a batch keyword the model did not answer is
 * left out and counted, for the reason the header gives.
 *
 * @returns {{ items: object[], dropped: string[], unlabelled: string[] }}
 */
export function mergeKeywordJudgment(batch, items) {
  const byKey = new Map((batch || []).map(g => [normKey(g.keyword), g]));
  const seen = new Set();
  const out = [];
  const dropped = [];
  for (const item of items || []) {
    const key = normKey(item?.keyword);
    const gap = byKey.get(key);
    if (!gap || seen.has(key)) { dropped.push(String(item?.keyword ?? '')); continue; }
    seen.add(key);
    out.push({ ...item, keyword: gap.keyword, competitor_count: gap.competitor_count, covered_by: gap.covered_by });
  }
  const unlabelled = (batch || []).filter(g => !seen.has(normKey(g.keyword))).map(g => g.keyword);
  return { items: out, dropped, unlabelled };
}

/**
 * A cluster in the shape prompt-builder asked the model for, with the
 * model's fields null: what a rules-only run reports. PURE.
 */
export function rulesOnlyContentGaps(clusters) {
  return (clusters || []).map(c => ({
    topic: c.key_term,
    covered_by: c.covered_by,
    format: null,
    why_it_matters: null,
    suggested_title: null,
    key_term: c.key_term,
    heading_count: c.heading_count,
    sample_headings: c.sample_headings,
  }));
}

/**
 * The model's naming joined onto the clusters by key_term. covered_by and
 * the counts are the cluster's. Same drop / count rule as the keywords.
 * PURE.
 *
 * @returns {{ items: object[], dropped: string[], unlabelled: string[] }}
 */
export function mergeContentJudgment(clusters, items) {
  const byKey = new Map((clusters || []).map(c => [normKey(c.key_term), c]));
  const seen = new Set();
  const out = [];
  const dropped = [];
  for (const item of items || []) {
    const key = normKey(item?.key_term);
    const cluster = byKey.get(key);
    if (!cluster || seen.has(key)) { dropped.push(String(item?.key_term ?? '')); continue; }
    seen.add(key);
    out.push({
      topic: item.topic || cluster.key_term,
      covered_by: cluster.covered_by,
      format: item.format ?? null,
      why_it_matters: item.why_it_matters ?? null,
      suggested_title: item.suggested_title ?? null,
      key_term: cluster.key_term,
      heading_count: cluster.heading_count,
      sample_headings: cluster.sample_headings,
    });
  }
  const unlabelled = (clusters || []).filter(c => !seen.has(normKey(c.key_term))).map(c => c.key_term);
  return { items: out, dropped, unlabelled };
}

/**
 * Seeds for the model-invented long tails: the keyword gaps first (what the
 * market talks about that the target does not), then the target's own
 * keywords to fill the list.
 */
function seedKeywords(gapRows, keywordMatrix, targetDomain, limit = SEED_KEYWORDS) {
  const seeds = [];
  const seen = new Set();
  const add = k => {
    const key = normKey(k);
    if (!key || seen.has(key)) return;
    seen.add(key);
    seeds.push(key);
  };
  for (const g of gapRows) add(g.keyword);
  if (seeds.length < limit) {
    const target = normKey(targetDomain).replace(/^www\./, '');
    const own = (keywordMatrix || [])
      .filter(r => r?.role === 'target' || r?.role === 'owned' || normKey(r?.domain).replace(/^www\./, '') === target)
      .sort((a, b) => (Number(b.freq) || 0) - (Number(a.freq) || 0));
    for (const r of own) { if (seeds.length >= limit) break; add(r.keyword); }
  }
  return seeds.slice(0, limit);
}

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * The meta.sections map for upsertInsightsFromAnalysis, from what actually
 * produced each section. Search Console rows and the technical audit are
 * rules whatever mode the run was in; a rules-only run's keyword gaps and
 * clusters are rules too, because no prompt ever touched them; everything a
 * judgment produced is the model's, stamped with that judgment's version.
 * PURE.
 */
export function provenanceSections({ noModel, sections }) {
  const rule = { sourceKind: 'rule', ruleVersion: RULE_VERSION };
  const model = judgment => ({ sourceKind: 'model', promptVersion: judgment.version });
  return {
    quick_wins: rule,
    long_tails: sections.long_tails === 'model' ? model(JUDGMENTS.long_tails_fallback) : rule,
    technical_gaps: rule,
    keyword_gaps: noModel ? rule : model(JUDGMENTS.keyword_gaps),
    content_gaps: noModel ? rule : model(JUDGMENTS.content_gaps),
    new_pages: model(JUDGMENTS.new_pages),
    positioning: model(JUDGMENTS.positioning),
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Run one project's analysis end to end.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} config           config/<project>.json as loaded (target, competitors, context)
 * @param {{ provider?: string, model?: string, noModel?: boolean,
 *           call?: Function, log?: Function, now?: number|Function, reportsDir?: string, env?: object }} [opts]
 *   call  callModel-shaped: receives { name, system, prompt, schema, limits, effort, maxTokens, provider, model }
 *         and resolves to the parsed output or an envelope carrying it (see judgments.js runJudgment)
 *   now   the run's timestamp (ms) or a clock returning one; stamps analyses.generated_at and the report file names
 * @returns {Promise<{ analysis: object, analysisId: number, provenance: object, savedPath: string, judgmentsPath: string }>}
 */
export async function runProjectAnalysis(db, project, config = {}, opts = {}) {
  const {
    provider: providerArg,
    model: modelArg,
    noModel = false,
    log = () => {},
    reportsDir = DEFAULT_REPORTS_DIR,
    env = process.env,
  } = opts;
  const nowMs = Number(typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()));
  const cfg = config || {};

  // a. gather
  const g = gather(db, project, cfg);

  // b. deterministic
  const gapRows = keywordGapsFromMatrix(g.keywordMatrix, { targetDomain: g.targetDomain, competitorDomains: g.competitorDomains });
  const clusters = contentGapClusters(g.headings, { targetDomain: g.targetDomain, competitorDomains: g.competitorDomains });
  const demand = demandSections(db, project);
  // The audit keys on the target domain; a config without one still has a
  // target in the crawl, and gather() already found it.
  const technical = await technicalGaps(db, project, cfg, { targetDomain: g.targetDomain });
  log(`[analysis] computed: ${gapRows.length} keyword gap(s), ${clusters.length} content cluster(s), `
    + `${demand.counts.quick_wins} quick win(s) and ${demand.counts.long_tails} long tail(s) from Search Console, ${technical.length} technical gap(s)`);

  const sections = {
    keyword_gaps: 'none',
    long_tails: 'none',
    quick_wins: demand.quick_wins.length ? 'gsc' : 'none',
    content_gaps: 'none',
    new_pages: 'none',
    technical_gaps: 'rule',
    positioning: 'none',
  };
  const judgmentsLog = [];
  const failures = [];
  const debug = [];

  let provider = null;
  let model = null;
  let keywordGaps = [];
  let contentGaps = [];
  let longTails = demand.long_tails;
  let newPages = [];
  let positioning = {};

  if (noModel) {
    keywordGaps = gapRows.map(({ keyword, competitor_count, covered_by }) => ({ keyword, competitor_count, covered_by }));
    contentGaps = rulesOnlyContentGaps(clusters);
    sections.keyword_gaps = keywordGaps.length ? 'rule' : 'none';
    sections.content_gaps = contentGaps.length ? 'rule' : 'none';
    sections.long_tails = longTails.length ? 'gsc' : 'none';
  } else {
    // c. judgments — one provider, resolved once; a config error here (no
    // key, no gateway) is the person's to fix and is not a judgment failure.
    const resolved = resolveProvider({ provider: providerArg, model: modelArg, env });
    provider = resolved.provider;
    model = resolved.model;
    log(`[analysis] judgments → ${provider} (${model}); ${resolved.reason}`);
    const call = opts.call || (req => callModel({ ...req, env, log }));

    let attempted = 0;
    let firstError = null;
    let answeredModel = null;

    /**
     * One judgment, wrapped: a success adds to the log, a failure adds to
     * failures[] and returns null so the caller leaves the section empty.
     * `extra` is bookkeeping for a batched call ({ batch, of }).
     */
    const judge = async (judgment, input, extra = {}) => {
      attempted++;
      const entry = { name: judgment.name, prompt_version: judgment.version, ...extra };
      let request = null;
      const recording = async req => { request = req; return call(req); };
      try {
        const { output, provenance } = await runJudgment(judgment, { ...input, context: cfg.context }, {
          call: recording, provider, model, log,
        });
        judgmentsLog.push({ ...entry, attempts: provenance.attempts, ms: provenance.ms });
        answeredModel ??= provenance.model;
        debug.push({
          ...entry, provider: provenance.provider, model: provenance.model, attempts: provenance.attempts, ms: provenance.ms,
          system: request?.system ?? null, prompt: request?.prompt ?? null, output,
        });
        return output;
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        firstError ??= err;
        failures.push({ name: judgment.name, ...extra, kind: err.kind ?? null, error: err.message, hint: err.hint ?? null });
        debug.push({ ...entry, system: request?.system ?? null, prompt: request?.prompt ?? null, error: err.message, kind: err.kind ?? null });
        log(`[analysis] ${judgment.name}${extra.batch ? ` batch ${extra.batch}/${extra.of}` : ''} failed: ${err.message}`
          + `${err.hint ? ` (${err.hint})` : ''}; leaving the section empty`);
        return null;
      }
    };

    // keyword_gaps: forty at a time, labels merged back by keyword.
    const batches = chunk(gapRows, KEYWORD_BATCH);
    for (let i = 0; i < batches.length; i++) {
      const extra = batches.length > 1 ? { batch: i + 1, of: batches.length } : {};
      const out = await judge(JUDGMENTS.keyword_gaps, { gaps: batches[i], target_pages: g.targetPages }, extra);
      if (!out) continue;
      const merged = mergeKeywordJudgment(batches[i], out.items);
      keywordGaps.push(...merged.items);
      const last = debug[debug.length - 1];
      last.dropped = merged.dropped;
      last.unlabelled = merged.unlabelled;
      if (merged.dropped.length || merged.unlabelled.length) {
        log(`[analysis] keyword_gaps: dropped ${merged.dropped.length} invented keyword(s), ${merged.unlabelled.length} left unlabelled`);
      }
    }
    sections.keyword_gaps = keywordGaps.length ? 'model' : 'none';

    // content_gaps: only when the arithmetic found clusters to name.
    if (clusters.length) {
      const out = await judge(JUDGMENTS.content_gaps, { clusters });
      if (out) {
        const merged = mergeContentJudgment(clusters, out.items);
        contentGaps = merged.items;
        const last = debug[debug.length - 1];
        last.dropped = merged.dropped;
        last.unlabelled = merged.unlabelled;
      }
    }
    sections.content_gaps = contentGaps.length ? 'model' : 'none';

    // long_tails: measured when Search Console has spoken at all; invented
    // only when it has not, and marked as such by the judgment itself.
    if (demand.available) {
      sections.long_tails = longTails.length ? 'gsc' : 'none';
    } else {
      const out = await judge(JUDGMENTS.long_tails_fallback, { seed_keywords: seedKeywords(gapRows, g.keywordMatrix, g.targetDomain) });
      longTails = out ? out.items.map(t => ({ ...t, source: 'model' })) : [];
      sections.long_tails = longTails.length ? 'model' : 'none';
    }

    // new_pages: from the gaps and the long tails, or not at all — with
    // neither, the model could only propose from thin air.
    if (contentGaps.length || longTails.length) {
      const out = await judge(JUDGMENTS.new_pages, {
        content_gaps: contentGaps, long_tails: longTails.slice(0, NEW_PAGE_LONG_TAILS), target_pages: g.targetPages,
      });
      newPages = out ? out.items : [];
    }
    sections.new_pages = newPages.length ? 'model' : 'none';

    // positioning: always; the judgment handles the no-competitor case itself.
    const pos = await judge(JUDGMENTS.positioning, { target_summary: g.target, competitor_summaries: g.competitors });
    positioning = pos || {};
    sections.positioning = pos ? 'model' : 'none';

    if (attempted > 0 && failures.length === attempted) throw firstError;
    if (answeredModel) model = answeredModel;
  }

  // d. assemble — the legacy shape, plus the receipt.
  const analysis = {
    keyword_gaps: keywordGaps,
    long_tails: longTails,
    content_gaps: contentGaps,
    quick_wins: demand.quick_wins,
    new_pages: newPages,
    technical_gaps: technical,
    positioning,
    pipeline: {
      version: PIPELINE_VERSION,
      provider,
      model,
      sections,
      judgments: judgmentsLog,
      failures,
    },
  };

  // e. persist — the analyses row, the two report files, the Ledger rows.
  const modelUsed = noModel ? RULES_ONLY_MODEL : `${provider}:${model}`;
  const inserted = db.prepare(`
    INSERT INTO analyses (project, generated_at, model, keyword_gaps, long_tails, quick_wins, new_pages, content_gaps, positioning, technical_gaps, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project, nowMs, modelUsed,
    JSON.stringify(analysis.keyword_gaps),
    JSON.stringify(analysis.long_tails),
    JSON.stringify(analysis.quick_wins),
    JSON.stringify(analysis.new_pages),
    JSON.stringify(analysis.content_gaps),
    JSON.stringify(analysis.positioning),
    JSON.stringify(analysis.technical_gaps),
    JSON.stringify(analysis.pipeline, null, 2),
  );
  const analysisId = Number(inserted.lastInsertRowid);

  mkdirSync(reportsDir, { recursive: true });
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const savedPath = join(reportsDir, `${project}-analysis-${day}.json`);
  writeFileSync(savedPath, JSON.stringify(analysis, null, 2), 'utf8');
  const judgmentsPath = join(reportsDir, `${project}-judgments-${day}.json`);
  writeFileSync(judgmentsPath, JSON.stringify({
    project,
    generated_at: new Date(nowMs).toISOString(),
    provider,
    model: modelUsed,
    judgments: debug,
    failures,
  }, null, 2), 'utf8');

  upsertInsightsFromAnalysis(db, project, analysisId, analysis, nowMs, {
    model: modelUsed,
    promptVersion: JUDGMENTS.keyword_gaps.version,
    sections: provenanceSections({ noModel, sections }),
  });

  log(`[analysis] saved analyses row ${analysisId} (${modelUsed}); ${failures.length} failed judgment(s)`);
  return { analysis, analysisId, provenance: analysis.pipeline, savedPath, judgmentsPath };
}
