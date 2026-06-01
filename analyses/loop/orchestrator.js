/**
 * Content-loop orchestrator (F2) — the "hands, not eyes" engine.
 *
 * One invocation walks the content half of the agentic loop:
 *   gather gaps → rank → draft → prescore → (revise) → write-back → queue
 *
 * Library-first: backs both `seo-intel loop` (CLI) and `run_content_loop` (MCP).
 * The `generate` fn is injected so the CLI can drive the user's cloud model while
 * MCP can hand the prompt back to the agent's own LLM (generate = null).
 *
 * Builds on F1 (v1.5.42): a finished draft records a `draft_created` insight and
 * flips matching gaps to in_progress, so the loop remembers its own work.
 * F3 (re-audit → flip in_progress→done once the live page clears 60) is NOT here.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherBlogDraftContext, buildBlogDraftPrompt } from '../blog-draft/index.js';
import { prescore, extractDraftTopic } from '../blog-draft/prescorer.js';
import { recordDraftCreated, markGapsInProgress } from '../../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const REPORTS_DIR = join(REPO_ROOT, 'reports');

const PRIORITY_W = { high: 3, medium: 2, low: 1 };
const SOURCE_W = { citability_gap: 1.3, content_gap: 1.3, keyword_gap: 1.1, long_tail: 1.0, keyword_inventor: 1.0 };
const HOT_INTENT = /decision|comparison|implementation|compare|\bvs\b|best|should/i;

function slugify(s) {
  return (s || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'draft';
}

/** Build a unified, leverage-ranked list of candidate gaps from gathered context. */
export function rankGaps(ctx) {
  const cands = [];
  const add = (source, topicRaw, priority, intent, extra = {}) => {
    const topic = (topicRaw || '').toString().trim();
    if (!topic) return;
    const pw = PRIORITY_W[(priority || 'medium').toLowerCase()] || 2;
    const sw = SOURCE_W[source] || 1;
    const bonus = intent && HOT_INTENT.test(intent) ? 0.25 : 0;
    cands.push({ source, topic, priority: (priority || 'medium'), intent: intent || null, leverage: +(pw * sw * (1 + bonus)).toFixed(3), ...extra });
  };
  for (const kg of ctx.keywordGaps || []) add('keyword_gap', kg.keyword, kg.priority, kg.intent);
  for (const lt of ctx.longTails || []) add('long_tail', lt.phrase, lt.priority, lt.intent);
  for (const kw of ctx.kwInventor || []) add('keyword_inventor', kw.phrase, kw.priority, kw.intent);
  for (const cg of ctx.contentGaps || []) add('content_gap', typeof cg === 'string' ? cg : (cg.topic || cg.suggested_title || cg.gap), cg.priority || 'high', null);
  for (const cgap of ctx.citabilityGaps || []) add('citability_gap', cgap.title || cgap.url, (cgap.score ?? 50) < 35 ? 'high' : 'medium', (cgap.ai_intents || [])[0], { url: cgap.url, current_score: cgap.score });

  // Dedupe by lowercased topic, keep highest leverage.
  const best = new Map();
  for (const c of cands) {
    const k = c.topic.toLowerCase();
    if (!best.has(k) || best.get(k).leverage < c.leverage) best.set(k, c);
  }
  return [...best.values()].sort((a, b) => b.leverage - a.leverage);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} opts
 * @param {object} opts.config            project config (for the prompt builder)
 * @param {string} [opts.topic]           focus topic (else auto-pick top gap)
 * @param {number} [opts.count=1]         draft the top N gaps
 * @param {string} [opts.lang='en']
 * @param {string} [opts.contentType='blog']
 * @param {number} [opts.minScore=60]
 * @param {number} [opts.revise=0]        auto-revise up to k times if below minScore
 * @param {boolean} [opts.queue=true]     write approved drafts to reports/ready/<project>/
 * @param {string} [opts.queueDir]
 * @param {boolean} [opts.dryRun=false]   select + plan only, no model call
 * @param {(prompt:string)=>Promise<string|null>} [opts.generate] null ⇒ hand-back mode
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function runContentLoop(db, project, opts = {}) {
  const {
    config = { project }, topic = null, count = 1, lang = 'en', contentType = 'blog',
    minScore = 60, revise = 0, queue = true, queueDir, dryRun = false,
    generate = null, onProgress = () => {},
  } = opts;

  const ctx = gatherBlogDraftContext(db, project, topic);
  const ranked = rankGaps(ctx);

  if (!ranked.length) {
    return {
      project, mode: 'no-gaps', drafts: [], skipped: [],
      next_action: 'No active gaps to draft. Run `seo-intel aeo` + `seo-intel keywords` (own-site, free) or `seo-intel analyze` (competitor, Solo) to populate the Ledger.',
    };
  }

  const targets = ranked.slice(0, Math.max(1, count));

  if (dryRun) {
    return {
      project, mode: 'dry-run',
      planned: targets.map(t => ({ topic: t.topic, source: t.source, priority: t.priority, leverage: t.leverage })),
      next_action: 'Dry run — no draft generated. Re-run without dryRun to draft these.',
    };
  }

  const drafts = [];
  const skipped = [];

  for (const target of targets) {
    const tTopic = target.topic;
    const prompt = buildBlogDraftPrompt(ctx, { config, lang, topic: tTopic, contentType });

    // Hand-back mode (MCP default): no model wired — return the prompt so the
    // agent's own LLM writes the draft, then calls prescore_draft to close.
    if (!generate) {
      drafts.push({
        gap: { source: target.source, topic: tTopic, leverage: target.leverage },
        mode: 'handback', prompt,
        next: `Write the draft from this prompt with your own LLM, then call prescore_draft(project="${project}", topic="${tTopic}") to AEO-score it and close the loop.`,
      });
      continue;
    }

    onProgress(`drafting "${tTopic}" (${target.source} · leverage ${target.leverage})`);
    let draft = await generate(prompt);
    if (!draft) { skipped.push({ topic: tTopic, reason: 'generation_failed' }); continue; }
    let score = prescore(draft);

    let revisions = 0;
    while (score.score < minScore && revisions < revise) {
      const weak = Object.entries(score.breakdown).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => k.replace(/_/g, ' '));
      onProgress(`revising ${revisions + 1}/${revise} (was ${score.score}; weak: ${weak.join(', ')})`);
      const revised = await generate(prompt + `\n\n## REVISION\nThe previous draft scored ${score.score}/100. Strengthen the weakest signals: ${weak.join(', ')}. Add Q&A structure (H2 question → immediate answer), concrete numbers/dates, and named entities/sources. Return the full improved draft.`);
      revisions++;
      if (revised) {
        const rs = prescore(revised);
        if (rs.score >= score.score) { draft = revised; score = rs; }
      }
    }

    const effectiveTopic = tTopic || extractDraftTopic(draft);

    // Queue for publish (handoff, not auto-deploy).
    let queuedPath = null;
    if (queue) {
      const dir = queueDir || join(REPORTS_DIR, 'ready', project);
      mkdirSync(dir, { recursive: true });
      queuedPath = join(dir, `${slugify(effectiveTopic)}.md`);
      const fm = `---\nstatus: ready\nscore: ${score.score}\ntier: ${score.tier}\ntopic: ${JSON.stringify(effectiveTopic)}\nsource_gap: ${target.source}\nlang: ${lang}\ntype: ${contentType}\ncreated_at: ${new Date().toISOString()}\n---\n\n`;
      writeFileSync(queuedPath, /^\s*---/.test(draft) ? draft : fm + draft, 'utf8');
    }

    // Write-back (F1) — never let a Ledger hiccup fail the draft.
    let marked = 0;
    try {
      recordDraftCreated(db, project, { topic: effectiveTopic, score: score.score, tier: score.tier, wordCount: score.wordCount, lang, contentType, savedPath: queuedPath });
      marked = markGapsInProgress(db, project, effectiveTopic);
    } catch { /* best-effort */ }

    drafts.push({
      gap: { source: target.source, topic: tTopic, leverage: target.leverage, ...(target.url ? { url: target.url, previous_score: target.current_score } : {}) },
      topic: effectiveTopic, score: score.score, tier: score.tier, revisions,
      word_count: score.wordCount,
      queued_path: queuedPath ? relative(REPO_ROOT, queuedPath) : null,
      ledger: { draft_recorded: true, gaps_marked_in_progress: marked },
    });
  }

  const handback = !generate;
  return {
    project,
    mode: handback ? 'handback' : 'generated',
    drafts, skipped,
    next_action: handback
      ? `No generation model wired — write each draft from its prompt, then call prescore_draft(project, topic) to score + close the loop. (CLI: \`seo-intel loop ${project}\` drives a model directly.)`
      : queue
        ? `Review reports/ready/${project}/, publish, then re-crawl + \`seo-intel aeo\` to verify the gap closed.`
        : 'Drafts generated (not queued).',
  };
}
