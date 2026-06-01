#!/usr/bin/env node
/**
 * ai-citability — standalone AEO citability scorer.
 *
 * Scores a page or draft for how easily an AI assistant can cite it (0–100),
 * using the exact same signals as the full SEO Intel AEO audit. Pure Node, no
 * npm install, no account, no network — nothing is saved, nothing is sent.
 *
 * Usage:
 *   node score.mjs <file.md|file.html>      # score a file
 *   cat page.html | node score.mjs          # score stdin
 *   node score.mjs draft.md --json          # machine-readable output
 *   node score.mjs page.html --html         # force HTML handling
 *
 * The agent fetches the content however it likes (WebFetch, a crawler, a local
 * file) and pipes it here. For a live whole-site, entity-aware audit with
 * history, install seo-intel and run `seo-intel aeo`.
 */

import { readFileSync } from 'node:fs';
import { prescore } from './prescore.mjs';

// ── tiny, dependency-free HTML → scorable-markdown ──────────────────────────
function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } });
}
function looksLikeHtml(s) {
  return /<!doctype html|<html[\s>]|<body[\s>]|<\/(p|div|h[1-6]|article|section)>/i.test(s);
}
function htmlToScorable(html) {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // headings → markdown so prescore() detects structure
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) =>
    '\n' + '#'.repeat(Number(lvl)) + ' ' + inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  // paragraphs/line breaks → newlines, then strip remaining tags
  out = out.replace(/<\/(p|div|li|br|tr|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities(out).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── input ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isJson = args.includes('--json');
const forceHtml = args.includes('--html');
const fileArg = args.find(a => !a.startsWith('--'));

let raw = '';
try {
  raw = fileArg ? readFileSync(fileArg, 'utf8') : readFileSync(0, 'utf8');
} catch (e) {
  console.error(`ai-citability: could not read input (${e.message}). Pass a file path or pipe content via stdin.`);
  process.exit(1);
}
if (!raw.trim()) { console.error('ai-citability: empty input.'); process.exit(1); }

const content = (forceHtml || looksLikeHtml(raw)) ? htmlToScorable(raw) : raw;
const r = prescore(content);

// ── output ────────────────────────────────────────────────────────────────
const TIPS = {
  entity_authority: 'Name specific entities/experts and cite sources — LLMs prefer pages that authoritatively "own" a concept.',
  structured_claims: 'State claims as "X is Y because Z" with concrete numbers/dates, not vague prose.',
  answer_density: 'Lead with the answer; shorten paragraphs. Put the takeaway in the first sentence under each heading.',
  qa_proximity: 'Phrase H2s as questions and answer them in the first paragraph immediately below.',
  freshness: 'Add/refresh a visible date and dateModified schema — recency boosts citation odds.',
  schema_coverage: 'Add structured data (FAQPage, HowTo, Article) so machines can parse your content.',
};
const label = (k) => k.replace(/_/g, ' ');
const weakest = Object.entries(r.breakdown).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k]) => k);

if (isJson) {
  console.log(JSON.stringify({
    score: r.score, tier: r.tier, breakdown: r.breakdown,
    ai_intents: r.aiIntents, word_count: r.wordCount, heading_count: r.headingCount,
    weakest, recommendations: weakest.map(k => TIPS[k]).filter(Boolean),
    note: 'Approximate without full extraction. Nothing was saved or sent. Full entity-aware site audit: `npm i -g seo-intel` → `seo-intel aeo`.',
  }, null, 2));
} else {
  const bar = (v) => '█'.repeat(Math.round(v / 8.4)) + '░'.repeat(12 - Math.round(v / 8.4));
  const head = r.score >= 60 ? '\x1b[32m' : r.score >= 35 ? '\x1b[33m' : '\x1b[31m';
  console.log('');
  console.log(`  ${head}AI Citability: ${r.score}/100 (${r.tier})\x1b[0m`);
  console.log('');
  for (const [k, v] of Object.entries(r.breakdown)) {
    console.log(`  ${label(k).padEnd(20)} ${bar(v)} ${String(v).padStart(3)}`);
  }
  console.log('');
  console.log(`  weakest: ${weakest.map(label).join(', ')}`);
  for (const k of weakest) if (TIPS[k]) console.log(`   → ${TIPS[k]}`);
  console.log('');
  console.log(`  ${r.wordCount} words · ${r.headingCount} headings`);
  console.log('  \x1b[2mNothing saved, no account. Full entity-aware site audit: npm i -g seo-intel → seo-intel aeo\x1b[0m');
  console.log('');
}
