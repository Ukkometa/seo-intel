#!/usr/bin/env node
/**
 * Layer coherence check — Site ↔ Product ↔ Versions
 *
 *   node scripts/check-layers.js          # report, exit 1 on any drift
 *   node scripts/check-layers.js --fix    # auto-fix what is mechanically fixable
 *   node scripts/check-layers.js --json   # machine-readable output
 *
 * WHY THIS EXISTS
 * ---------------
 * The v1.5.41 monetization line (own site free, Solo adds competitors) was
 * applied to lib/gate.js and to nothing else. For months the README, LICENSE,
 * SKILL.md, both storefronts, llms.txt and the FAQ schema all still sold the
 * pre-v1.5.41 model — advertising a far weaker free tier than the code grants,
 * and charging for features that were already free. Nothing caught it because
 * nothing was checking.
 *
 * The rule this enforces: CODE IS THE TRUTH. Every claim about what is free,
 * what is paid, how many tools exist, and what version ships is derived from
 * source and then verified against every surface that repeats it.
 *
 * Site root resolution: $UKKOMETA_SITE_ROOT, else ../Ukkometa.fi.
 * If the site is not found, site checks are skipped (not failed) so this still
 * runs in CI or on a machine that only has the repo.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.UKKOMETA_SITE_ROOT || resolve(REPO, '..', 'Ukkometa.fi');
const HAS_SITE = existsSync(join(SITE, 'seo-intel', 'index.html'));

const FIX = process.argv.includes('--fix');
const JSON_OUT = process.argv.includes('--json');

const findings = [];
const fixed = [];
const read = p => readFileSync(p, 'utf8');
const rel = p => p.replace(REPO + '/', '').replace(SITE + '/', 'site:');

function fail(layer, msg, file, hint) {
  findings.push({ layer, msg, file: file ? rel(file) : undefined, hint });
}

// ── 1. DERIVE TRUTH FROM CODE ───────────────────────────────────────────────

const pkg = JSON.parse(read(join(REPO, 'package.json')));
const VERSION = pkg.version;

const gateSrc = read(join(REPO, 'lib', 'gate.js'));
const freeBlock = gateSrc.match(/const FREE_FEATURES = new Set\(\[([\s\S]*?)\]\)/);
const FREE_FEATURES = freeBlock
  ? [...freeBlock[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1])
  : [];

const cliSrc = read(join(REPO, 'cli.js'));
// `requirePro(\`intel-${opts.for}\`)` is a template literal — it yields the
// partial token "intel-", which is not a feature. The intel split is derived
// from FREE_SLICES/INTEL_SLICES below instead.
const gatedCalls = [...cliSrc.matchAll(/requirePro\(\s*['"`]([a-z-]+)/g)]
  .map(m => m[1])
  .filter(f => !f.endsWith('-'));
const PAID_FEATURES = [...new Set(gatedCalls)].filter(f => !FREE_FEATURES.includes(f)).sort();

// The capabilities manifest carries its own `tier` per capability. Platform
// integrators read it to decide what needs a licence, so a manifest that says
// 'pro' for something gate.js lets through free under-sells the free tier —
// the same class of bug this script was built to catch, one layer over.
// orphans, js-delta and blog-draft drifted this way and were corrected 2026-08-22.
const harnessSrc = read(join(REPO, 'agent-harness.js'));
const CAPABILITY_TIERS = [...harnessSrc.matchAll(/id:\s*'([a-z-]+)'[\s\S]{0,600}?tier:\s*'(free|pro)'/g)]
  .map(m => ({ id: m[1], tier: m[2] }));

const intelSrc = read(join(REPO, 'lib', 'intel.js'));
const FREE_SLICES = [...(intelSrc.match(/FREE_SLICES = \[(.*?)\]/)?.[1] || '').matchAll(/'(\w+)'/g)].map(m => m[1]);
const ALL_SLICES = [...(intelSrc.match(/INTEL_SLICES = \[(.*?)\]/)?.[1] || '').matchAll(/'(\w+)'/g)].map(m => m[1]);

const mcpSrc = read(join(REPO, 'mcp', 'server.js'));
const literalTools = [...mcpSrc.matchAll(/server\.registerTool\(\s*['"]([a-z_]+)['"]/g)].map(m => m[1]);
const literalPaid = [...mcpSrc.matchAll(/paidGate\(\s*['"]([a-z_]+)['"]/g)].map(m => m[1]);

// The competitor analysis tools are registered from a table in a loop, so the
// registerTool()/paidGate() literal regexes above cannot see them. Parse the
// table itself. Every tool in it is paid by construction — the loop body calls
// paidGate(t.name) unconditionally on !isPro().
const compBlock = mcpSrc.match(/const competitorTools = \[([\s\S]*?)\n\];/);
const COMPETITOR_TOOLS = compBlock
  ? [...compBlock[1].matchAll(/name:\s*'([a-z_]+)'/g)].map(m => m[1])
  : [];
if (compBlock && !COMPETITOR_TOOLS.length) {
  fail('truth', 'Found the competitorTools table but parsed no tool names — the regex needs updating',
    join(REPO, 'mcp/server.js'));
}

const MCP_TOOLS = [...literalTools, ...COMPETITOR_TOOLS];
const MCP_PAID = [...new Set([...literalPaid, ...COMPETITOR_TOOLS])];
const MCP_FREE_COUNT = MCP_TOOLS.length - MCP_PAID.length;

const licSrc = read(join(REPO, 'lib', 'license.js'));
const freeTier = licSrc.match(/free:\s*\{[\s\S]*?maxProjects:\s*(\w+)[\s\S]*?maxPagesPerDomain:\s*(\w+)/);
const FREE_UNLIMITED = freeTier && freeTier[1] === 'Infinity' && freeTier[2] === 'Infinity';

const scorerSrc = read(join(REPO, 'analyses', 'aeo', 'scorer.js'));
const weightBlock = scorerSrc.match(/entity_authority:\s*0\.22[\s\S]{0,200}?\}/);
const AEO_SIGNALS = weightBlock ? [...weightBlock[0].matchAll(/([a-z_]+):\s*0\./g)].length : 0;

const truth = {
  version: VERSION,
  freeFeatures: FREE_FEATURES.length,
  paidFeatures: PAID_FEATURES,
  mcpTools: MCP_TOOLS.length,
  mcpFree: MCP_FREE_COUNT,
  mcpPaid: MCP_PAID,
  freeSlices: FREE_SLICES,
  paidSlices: ALL_SLICES.filter(s => !FREE_SLICES.includes(s)),
  freeUnlimited: FREE_UNLIMITED,
  aeoSignals: AEO_SIGNALS,
};

// Sanity: if truth extraction itself broke, everything downstream is noise.
if (!FREE_FEATURES.length) fail('truth', 'Could not parse FREE_FEATURES from lib/gate.js — the regex needs updating', join(REPO, 'lib/gate.js'));
if (!MCP_TOOLS.length) fail('truth', 'Could not parse registerTool() calls from mcp/server.js', join(REPO, 'mcp/server.js'));
if (!CAPABILITY_TIERS.length) fail('truth', 'Could not parse capability tiers from agent-harness.js — the regex needs updating', join(REPO, 'agent-harness.js'));
for (const c of CAPABILITY_TIERS) {
  const realTier = PAID_FEATURES.includes(c.id) ? 'pro' : 'free';
  if (c.tier !== realTier) {
    fail('truth', `capabilities manifest says "${c.id}" is ${c.tier}, but lib/gate.js makes it ${realTier}`,
      join(REPO, 'agent-harness.js'), `set tier: '${realTier}' on the ${c.id} capability`);
  }
}
if (AEO_SIGNALS === 0) fail('truth', 'Could not parse AEO signal weights from analyses/aeo/scorer.js', join(REPO, 'analyses/aeo/scorer.js'));

// ── 2. VERSION COHERENCE ────────────────────────────────────────────────────

const versionTargets = [
  { file: join(REPO, 'skill', 'SKILL.md'),                      re: /# SEO Intel \(v([\d.]+)\)/ },
  { file: join(REPO, '.claude-plugin', 'plugin.json'),          re: /"version":\s*"([\d.]+)"/ },
  { file: join(REPO, '.claude-plugin', 'marketplace.json'),     re: /"version":\s*"([\d.]+)"/ },
];
if (HAS_SITE) {
  versionTargets.push(
    { file: join(SITE, 'en', 'seo-intel', 'index.html'), re: /"softwareVersion":\s*"([\d.]+)"/ },
    { file: join(SITE, 'seo-intel', 'index.html'),       re: /"softwareVersion":\s*"([\d.]+)"/ },
    { file: join(SITE, 'seo-intel', 'skill.md'),         re: /# SEO Intel \(v([\d.]+)\)/ },
    { file: join(SITE, 'skill.md'),                      re: /# SEO Intel \(v([\d.]+)\)/ },
  );
}

for (const t of versionTargets) {
  if (!existsSync(t.file)) { fail('version', 'File missing', t.file); continue; }
  let src = read(t.file);
  const m = src.match(t.re);
  if (!m) { fail('version', 'No version string found where one is expected', t.file); continue; }
  if (m[1] !== VERSION) {
    if (FIX) {
      writeFileSync(t.file, src.replace(t.re, (full, v) => full.replace(v, VERSION)));
      fixed.push(`${rel(t.file)}: ${m[1]} → ${VERSION}`);
    } else {
      fail('version', `Says ${m[1]}, package.json says ${VERSION}`, t.file, 'run with --fix');
    }
  }
}

// Storefront visible version badges (e.g. "Local SEO tool · v1.5.53")
// Paid features must never appear in the Free pricing card.
const PAID_IN_FREE = [
  { re: /competitor gap|kilpailijoiden gap|gap analysis|gap-analyysi/i, feature: 'gap-intel' },
  { re: /blog draft|blogiluonnos/i,                                    feature: 'blog-draft' },
  { re: /scheduled crawl|ajastet\w* crawl/i,                           feature: 'run (scheduler)' },
  { re: /change brief|muutosbrief|publishing velocity|julkaisutahti/i,  feature: 'brief / velocity' },
];

if (HAS_SITE) {
  for (const f of [join(SITE, 'en', 'seo-intel', 'index.html'), join(SITE, 'seo-intel', 'index.html')]) {
    let src = read(f);
    const stale = [...src.matchAll(/v(\d+\.\d+\.\d+)/g)].map(m => m[1]).filter(v => v !== VERSION);
    if (stale.length) {
      if (FIX) {
        writeFileSync(f, src.replace(/v\d+\.\d+\.\d+/g, `v${VERSION}`));
        fixed.push(`${rel(f)}: badge ${[...new Set(stale)].join(', ')} → ${VERSION}`);
      } else {
        fail('version', `Visible badge shows v${[...new Set(stale)].join(', v')}, expected v${VERSION}`, f, 'run with --fix');
      }
    }
  }
}

// CHANGELOG must carry an entry for the shipped version (Unreleased may sit above it)
const changelog = read(join(REPO, 'CHANGELOG.md'));
if (!new RegExp(`^## ${VERSION.replace(/\./g, '\\.')} `, 'm').test(changelog)) {
  fail('version', `No "## ${VERSION} (date)" entry — public release notes lag the code`,
    join(REPO, 'CHANGELOG.md'), 'add the entry; this is a release gate, not auto-fixable');
}

// ── 3. MIRROR COHERENCE ─────────────────────────────────────────────────────

const canonicalSkill = read(join(REPO, 'skill', 'SKILL.md'));
const mirrors = [join(REPO, 'skills', 'seo-intel', 'SKILL.md')];
if (HAS_SITE) mirrors.push(join(SITE, 'skill.md'), join(SITE, 'seo-intel', 'skill.md'));

for (const m of mirrors) {
  if (!existsSync(m)) { fail('mirror', 'Mirror missing', m); continue; }
  if (read(m) !== canonicalSkill) {
    if (FIX) { writeFileSync(m, canonicalSkill); fixed.push(`${rel(m)}: re-copied from skill/SKILL.md`); }
    else fail('mirror', 'Differs from canonical skill/SKILL.md', m, 'run with --fix');
  }
}

// ── 4. COUNT COHERENCE ──────────────────────────────────────────────────────

const countSurfaces = [join(REPO, 'skill', 'SKILL.md'), join(REPO, 'README.md')];
if (HAS_SITE) countSurfaces.push(
  join(SITE, 'seo-intel', 'llms-ctx.txt'), join(SITE, 'seo-intel', 'llms.txt'),
  join(SITE, 'en', 'seo-intel', 'index.html'), join(SITE, 'seo-intel', 'index.html'));

const WORD_NUM = { six: 6, seven: 7, eight: 8, kuusi: 6, seitsemän: 7, kuuden: 6, seitsemän_: 7 };

for (const f of countSurfaces) {
  if (!existsSync(f)) continue;
  const src = read(f);

  for (const m of src.matchAll(/(\d+)\s+(?:native\s+)?(?:MCP\s+)?tools?\b/gi)) {
    const n = Number(m[1]);
    if (n > 5 && n !== truth.mcpTools && n !== truth.mcpFree) {
      fail('count', `Claims "${m[0]}" — actual is ${truth.mcpTools} tools (${truth.mcpFree} free)`, f);
    }
  }
  for (const m of src.matchAll(/(\d+|six|seven|eight|kuuden|seitsemän)\s+(?:citability\s+)?signal/gi)) {
    const n = Number(m[1]) || WORD_NUM[m[1].toLowerCase()];
    if (n && n !== truth.aeoSignals) {
      fail('count', `Claims "${m[0]}" — AEO scorer has ${truth.aeoSignals} signals`, f);
    }
  }
}

// ── 5. GATING COHERENCE ─────────────────────────────────────────────────────
//
// Prose cannot be fully verified mechanically, so this does two things it CAN
// do reliably: ban phrases that only make sense under the old model, and assert
// that no free feature is listed inside a Solo pricing card.

const FORBIDDEN = [
  { re: /crawl-only dashboard|crawl-only-dashboard/i, why: 'free tier has the full dashboard' },
  { re: /no AI extraction[^.]*free tier|free tier[^.]*no AI extraction/i, why: 'extraction is free' },
  { re: /ei AI-analyysia|ei ole tekoälypoimintaa/i, why: 'extraction and own-site analysis are free' },
  { re: /500 pages|1 project,|Single project|Yksi projekti/i, why: 'free tier has no page or project limits' },
  { re: /requires Solo\/Agency/i, why: 'no feature uses this phrasing any more' },
  { re: /Full AI pipeline/i, why: 'implies the pipeline is paid; it is free for your own site' },
];

const proseSurfaces = [join(REPO, 'README.md'), join(REPO, 'LICENSE'), join(REPO, 'skill', 'SKILL.md'), join(REPO, 'cli.js')];
if (HAS_SITE) proseSurfaces.push(
  join(SITE, 'en', 'seo-intel', 'index.html'), join(SITE, 'seo-intel', 'index.html'),
  join(SITE, 'llms.txt'), join(SITE, 'llms-ctx.txt'),
  join(SITE, 'seo-intel', 'llms.txt'), join(SITE, 'seo-intel', 'llms-ctx.txt'));

for (const f of proseSurfaces) {
  if (!existsSync(f)) continue;
  const lines = read(f).split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|#)/.test(line)) return;            // skip code comments
    if (/NOTE ON SCOPE|corrected 2026|used to force/.test(line)) return; // skip our own changelog-ish notes
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) fail('gating', `Stale claim (${why}): "${line.trim().slice(0, 90)}"`, `${f}:${i + 1}`);
    }
  });
}

// Free features must never appear in a Solo pricing card.
// blog-draft was removed from this list on 2026-08-22: it moved behind Solo, so
// listing it in the Solo pricing card is now correct rather than a bug.
const FREE_IN_SOLO = [
  { re: /citability|siteerattavuus/i,        feature: 'aeo' },
  { re: /AI extraction|AI-poiminta|AI-ekstraktointi/i, feature: 'extract' },
  { re: /dashboard/i,                        feature: 'html' },
  { re: /multiple projects|useita projekteja/i, feature: 'unlimited projects' },
];

if (HAS_SITE) {
  for (const f of [join(SITE, 'en', 'seo-intel', 'index.html'), join(SITE, 'seo-intel', 'index.html')]) {
    const src = read(f);
    const cards = [...src.matchAll(/<ul class="pricing-features">([\s\S]*?)<\/ul>/g)].map(m => m[1]);
    if (cards.length < 2) { fail('gating', 'Could not find both pricing cards', f); continue; }
    const solo = cards[1];
    for (const { re, feature } of FREE_IN_SOLO) {
      if (re.test(solo)) fail('gating', `Solo pricing card lists "${feature}", which is free in gate.js`, f);
    }
    if (!/competitor|kilpailij/i.test(solo)) {
      fail('gating', 'Solo pricing card does not mention competitors — the actual paid differentiator', f);
    }

    // And the reverse: a paid feature advertised inside the Free card. The EN
    // free card listed "Competitor gap analysis" until 2026-08-22 — the single
    // most expensive thing to give away by accident, and nothing caught it.
    const free = cards[0];
    for (const { re, feature } of PAID_IN_FREE) {
      if (re.test(free)) fail('gating', `Free pricing card lists "${feature}", which is paid in gate.js`, f);
    }
  }
}

// ── 6. REPORT ───────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: findings.length === 0, truth, findings, fixed }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

const B = s => `\x1b[1m${s}\x1b[0m`, D = s => `\x1b[2m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;

console.log(`\n${B('Layer coherence — Site ↔ Product ↔ Versions')}`);
console.log(D(`  repo ${REPO}`));
console.log(D(`  site ${HAS_SITE ? SITE : '(not found — site checks skipped)'}\n`));

console.log(B('  Truth, derived from source'));
console.log(D(`    version        ${truth.version}`));
console.log(D(`    free features  ${truth.freeFeatures}`));
console.log(D(`    paid features  ${truth.paidFeatures.length}  (${truth.paidFeatures.join(', ')})`));
console.log(D(`    MCP tools      ${truth.mcpTools}  (${truth.mcpFree} free, paid: ${truth.mcpPaid.join(', ') || 'none'})`));
console.log(D(`    intel slices   free: ${truth.freeSlices.join('/')}  paid: ${truth.paidSlices.join('/') || 'none'}`));
console.log(D(`    AEO signals    ${truth.aeoSignals}`));
console.log(D(`    free limits    ${truth.freeUnlimited ? 'unlimited pages + projects' : Y('NOT unlimited — check TIERS.free')}`));

if (fixed.length) {
  console.log(`\n  ${G('Fixed')} (${fixed.length})`);
  for (const f of fixed) console.log(`    ${G('✓')} ${f}`);
}

if (findings.length) {
  console.log(`\n  ${R('Drift')} (${findings.length})`);
  const byLayer = {};
  for (const f of findings) (byLayer[f.layer] ||= []).push(f);
  for (const [layer, items] of Object.entries(byLayer)) {
    console.log(`\n    ${B(layer)}`);
    for (const i of items) {
      console.log(`      ${R('✗')} ${i.msg}`);
      if (i.file) console.log(D(`        ${i.file}`));
      if (i.hint) console.log(D(`        → ${i.hint}`));
    }
  }
  console.log(`\n  ${R('FAIL')} — ${findings.length} discrepanc${findings.length === 1 ? 'y' : 'ies'}\n`);
  process.exit(1);
}

console.log(`\n  ${G('PASS')} — every surface agrees with the code${fixed.length ? ' (after fixes)' : ''}\n`);
