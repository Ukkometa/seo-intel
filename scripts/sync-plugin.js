#!/usr/bin/env node
// sync-plugin.js — keep the Claude Code plugin bundle in lockstep with the
// repo's sources of truth. Local-only release helper (scripts/ is gitignored).
//
//   node scripts/sync-plugin.js           # write: pin manifest versions + mirror skill/ -> skills/seo-intel/
//   node scripts/sync-plugin.js --check    # exit non-zero if anything drifts (pre-release gate)
//
// Sources of truth:
//   - package.json "version"  -> .claude-plugin/{plugin.json, marketplace.json} versions
//   - skill/ (canonical skill, also consumed by the website deploy) -> skills/seo-intel/ (plugin copy)
// Run AFTER any version bump / SKILL.md edit, before committing a release.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const PLUGIN_NAME = 'seo-intel';

let drift = 0;

// ── 1. Version sync: package.json -> plugin manifests ──────────────────────
const versionTargets = [
  {
    file: join(ROOT, '.claude-plugin', 'plugin.json'),
    get: (j) => j.version,
    set: (j) => { j.version = version; },
  },
  {
    file: join(ROOT, '.claude-plugin', 'marketplace.json'),
    get: (j) => (j.plugins.find((p) => p.name === PLUGIN_NAME) || {}).version,
    set: (j) => { const p = j.plugins.find((x) => x.name === PLUGIN_NAME); if (p) p.version = version; },
  },
];

for (const t of versionTargets) {
  const json = JSON.parse(readFileSync(t.file, 'utf8'));
  const rel = relative(ROOT, t.file);
  if (t.get(json) === version) { console.log(`  ✓ ${rel} (${version})`); continue; }
  drift++;
  if (check) {
    console.log(`  ✗ ${rel}: ${t.get(json)} ≠ package.json ${version}`);
  } else {
    t.set(json);
    writeFileSync(t.file, JSON.stringify(json, null, 2) + '\n');
    console.log(`  → ${rel}: → ${version}`);
  }
}

// ── 2. Skill mirror: skill/ -> skills/seo-intel/ ───────────────────────────
const SKILL_SRC = join(ROOT, 'skill');
const SKILL_DST = join(ROOT, 'skills', PLUGIN_NAME);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue; // skip .DS_Store and other dotfiles
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let skillDrift = 0;
for (const srcFile of walk(SKILL_SRC)) {
  const rel = relative(SKILL_SRC, srcFile);
  const dstFile = join(SKILL_DST, rel);
  const src = readFileSync(srcFile, 'utf8');
  const dst = existsSync(dstFile) ? readFileSync(dstFile, 'utf8') : null;
  if (dst === src) continue;
  drift++; skillDrift++;
  const relDst = relative(ROOT, dstFile);
  if (check) {
    console.log(`  ✗ ${relDst} ${dst === null ? '(missing)' : '(out of date)'}`);
  } else {
    mkdirSync(dirname(dstFile), { recursive: true });
    writeFileSync(dstFile, src);
    console.log(`  → mirrored ${relDst}`);
  }
}
if (!skillDrift) console.log(`  ✓ skills/${PLUGIN_NAME}/ matches skill/`);

if (check && drift) {
  console.error(`\nPlugin bundle drift (${drift}). Run: node scripts/sync-plugin.js`);
  process.exit(1);
}
console.log(check ? '\n✓ plugin bundle in sync' : `\n✓ plugin bundle synced to ${version}`);
