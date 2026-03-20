#!/usr/bin/env node
/**
 * SEO Intel — Interactive Setup Wizard (CLI)
 *
 * Guides a new user through full setup:
 *   1. System check (Node, npm, Ollama, Playwright)
 *   2. Auto-install missing dependencies
 *   3. Model selection (extraction + analysis tiers)
 *   4. API key setup
 *   5. Project configuration (target + competitors)
 *   6. Pipeline validation (real crawl + extraction test)
 *   7. Summary + next steps
 *
 * Uses the shared setup engine (setup/engine.js) for all logic.
 *
 * Usage:
 *   node config/setup-wizard.js
 *   node config/setup-wizard.js --project myproject
 */

import { createInterface } from 'readline';
import {
  fullSystemCheck,
  getModelRecommendations,
  EXTRACTION_MODELS,
  ANALYSIS_MODELS,
  installNpmDeps,
  installPlaywright,
  pullOllamaModel,
  createEnvFile,
  runFullValidation,
  buildProjectConfig,
  writeProjectConfig,
  updateEnvForSetup,
  slugify,
  domainFromUrl,
  testApiKey,
} from '../setup/engine.js';

// ─── Chalk-lite (avoid import complexity) ──────────────────────────────────
const c = {
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  gold:   s => `\x1b[38;5;214m${s}\x1b[0m`,
  magenta:s => `\x1b[35m${s}\x1b[0m`,
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

function hr() { console.log(c.dim('─'.repeat(60))); }
function section(num, title) {
  console.log('');
  hr();
  console.log(c.gold(c.bold(`  Chapter ${num} — ${title}`)));
  hr();
}
function ok(msg)   { console.log(c.green(`  ✓ ${msg}`)); }
function warn(msg) { console.log(c.yellow(`  ⚠  ${msg}`)); }
function fail(msg) { console.log(c.red(`  ✗ ${msg}`)); }
function info(msg) { console.log(c.dim(`  ${msg}`)); }
function next(msg) { console.log(''); console.log(c.cyan(`  → ${msg}`)); console.log(''); }

// ─── Main wizard ─────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log(c.gold(c.bold('  🔶 SEO Intel — Setup Wizard')));
  console.log(c.dim('  Point it at 5 domains. Get the gap report in 10 minutes.'));
  console.log('');

  const args = process.argv.slice(2);
  const projectArg = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;

  // Track choices for later
  let selectedOllamaHost = null;
  let selectedExtractionModel = null;
  let selectedAnalysisProvider = null;
  let selectedApiKey = null;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 1: System Check
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section(1, 'System Check');
  info('Scanning your system...');
  console.log('');

  const status = await fullSystemCheck();

  // Node.js
  if (status.node.meetsMinimum) {
    ok(`Node.js ${status.node.version}`);
  } else if (status.node.installed) {
    fail(`Node.js ${status.node.version} — need v18+. Please upgrade.`);
  } else {
    fail('Node.js not found. Install from https://nodejs.org');
  }

  // npm
  if (status.npm.installed) {
    ok(`npm ${status.npm.version}`);
  } else {
    fail('npm not found');
  }

  // npm dependencies
  if (status.npmDeps.installed) {
    ok('npm dependencies installed');
  } else {
    warn(`Missing npm packages: ${status.npmDeps.missing.slice(0, 5).join(', ')}`);
  }

  // Playwright
  if (status.playwright.installed && status.playwright.chromiumReady) {
    ok('Playwright + Chromium ready');
  } else if (status.playwright.installed) {
    warn('Playwright installed but Chromium browser missing');
  } else {
    warn('Playwright not installed');
  }

  // Ollama
  if (status.ollama.available) {
    ok(`Ollama available (${status.ollama.mode}) — ${status.ollama.models.length} models at ${status.ollama.host}`);
  } else if (status.ollama.installed) {
    warn('Ollama installed but not running or no models. Start Ollama and pull a model.');
  } else {
    warn('Ollama not found — extraction will use degraded mode (regex only)');
    info('Install from https://ollama.com for local AI extraction');
  }

  // VRAM / GPU
  if (status.vram.available) {
    ok(`GPU: ${status.vram.gpuName} — ${Math.round(status.vram.vramMB / 1024)}GB ${status.vram.source === 'apple-silicon-unified' ? '(unified memory, ~75% available for GPU)' : 'VRAM'}`);
  } else {
    info('No GPU detected — CPU mode available but slower');
  }

  // .env
  if (status.env.exists) {
    const keys = Object.entries(status.env.keys).filter(([_, v]) => v).map(([k]) => k);
    if (keys.length > 0) {
      ok(`.env found — keys: ${keys.join(', ')}`);
    } else {
      ok('.env found (no API keys configured yet)');
    }
  } else {
    info('No .env file yet — will create one');
  }

  // Existing configs
  if (status.configs.configs.length > 0) {
    ok(`Existing projects: ${status.configs.configs.map(c => c.project).join(', ')}`);
  }

  if (!status.node.meetsMinimum) {
    console.log('');
    fail('Node.js 18+ is required. Please install it and re-run this wizard.');
    rl.close();
    process.exit(1);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 2: Auto-Install
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const needsInstall = !status.npmDeps.installed || !status.playwright.installed || !status.playwright.chromiumReady;

  if (needsInstall) {
    section(2, 'Install Dependencies');

    // npm install
    if (!status.npmDeps.installed) {
      const answer = await ask('  Install npm dependencies? [Y/n]: ');
      if (answer.toLowerCase() !== 'n') {
        for await (const ev of installNpmDeps()) {
          if (ev.status === 'start') info(ev.message);
          else if (ev.status === 'done') ok(ev.message);
          else if (ev.status === 'error') fail(ev.message);
        }
      }
    }

    // Playwright
    if (!status.playwright.installed || !status.playwright.chromiumReady) {
      const answer = await ask('  Install Playwright Chromium browser? (~150MB) [Y/n]: ');
      if (answer.toLowerCase() !== 'n') {
        for await (const ev of installPlaywright()) {
          if (ev.status === 'start') info(ev.message);
          else if (ev.status === 'done') ok(ev.message);
          else if (ev.status === 'error') fail(ev.message);
        }
      }
    }

    // .env
    if (!status.env.exists) {
      for (const ev of createEnvFile()) {
        if (ev.status === 'done') ok(ev.message);
      }
    }
  } else {
    section(2, 'Dependencies');
    ok('All dependencies already installed.');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 3: Model Selection
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section(3, 'Choose Your Models');

  const models = getModelRecommendations(
    status.ollama.models,
    status.env.keys,
    status.vram.vramMB
  );

  // ── Extraction tier ──
  console.log('');
  console.log(c.bold('  📦 Extraction Model (local, runs during crawl)'));
  console.log(c.dim('  Extracts structured SEO data from each crawled page using a local AI model.'));
  console.log(c.dim('  Minimum 4B parameters for reliable JSON extraction.'));
  console.log('');

  if (status.ollama.available) {
    // Show available options
    const fittingModels = models.allExtraction.filter(m => !m.legacy && m.fitsVram);
    fittingModels.forEach((m, i) => {
      const marker = m.installed ? c.green('✓ installed') : c.dim('  not pulled');
      const rec = models.extraction?.model?.id === m.id ? c.gold(' ★ recommended') : '';
      console.log(`    ${i + 1}. ${c.bold(m.name)} (${m.vram}) — ${m.quality}${rec}`);
      console.log(`       ${c.dim(m.description)} ${marker}`);
    });

    console.log(`    ${fittingModels.length + 1}. ${c.dim('Skip — use degraded mode (regex only, no AI)')}`);
    console.log('');

    const choice = await ask(`  Choose extraction model [1-${fittingModels.length + 1}] (default: 1): `);
    const idx = parseInt(choice.trim()) - 1;

    if (idx >= 0 && idx < fittingModels.length) {
      const chosen = fittingModels[idx];
      selectedExtractionModel = chosen.id;
      selectedOllamaHost = status.ollama.host;
      ok(`Selected: ${chosen.name}`);

      // Offer to pull if not installed
      if (!chosen.installed && status.ollama.available) {
        const pullAnswer = await ask(`  Pull ${chosen.id} now? (may take a few minutes) [Y/n]: `);
        if (pullAnswer.toLowerCase() !== 'n') {
          for await (const ev of pullOllamaModel(chosen.id, status.ollama.host)) {
            if (ev.status === 'start') info(ev.message);
            else if (ev.status === 'progress') process.stdout.write(`\r  ${c.dim(ev.message)}    `);
            else if (ev.status === 'done') { process.stdout.write('\r'); ok(ev.message); }
            else if (ev.status === 'error') { process.stdout.write('\r'); fail(ev.message); }
          }
        }
      }
    } else {
      info('Skipping extraction model — will use regex fallback.');
    }
  } else {
    warn('No Ollama available. Extraction will use degraded mode (regex only).');
    info('Install Ollama (https://ollama.com) and pull a model for better results.');
    info('Recommended: ollama pull qwen3.5:9b');
  }

  // ── Analysis tier ──
  console.log('');
  console.log(c.bold('  🧠 Analysis Model (cloud, runs during analysis)'));
  console.log(c.dim('  A powerful model analyzes your crawl data to find keyword gaps,'));
  console.log(c.dim('  competitive opportunities, and strategic recommendations.'));
  console.log(c.dim('  Cloud models recommended — they have larger context windows.'));
  console.log('');

  const cloudModels = ANALYSIS_MODELS.filter(m => m.type === 'cloud');
  cloudModels.forEach((m, i) => {
    const configured = models.allAnalysis.find(am => am.id === m.id)?.configured;
    const marker = configured ? c.green('✓ key found') : c.dim('  needs key');
    const rec = m.recommended ? c.gold(' ★') : '';
    console.log(`    ${i + 1}. ${c.bold(m.name)} — ${m.context} ctx, ${m.costNote}${rec}`);
    console.log(`       ${c.dim(m.description)} ${marker}`);
  });
  console.log(`    ${cloudModels.length + 1}. ${c.dim('Skip — no cloud analysis (local only)')}`);
  console.log('');

  const analysisChoice = await ask(`  Choose analysis model [1-${cloudModels.length + 1}] (default: 1): `);
  const analysisIdx = parseInt(analysisChoice.trim()) - 1;

  if (analysisIdx >= 0 && analysisIdx < cloudModels.length) {
    const chosen = cloudModels[analysisIdx];
    selectedAnalysisProvider = chosen.id;

    // Check if key already configured
    const existing = models.allAnalysis.find(am => am.id === chosen.id);
    if (existing?.configured) {
      ok(`${chosen.name} — API key already configured.`);
      // Read the actual key for validation
      const envKeys = status.env.raw || {};
      selectedApiKey = envKeys[chosen.envKey] || null;
    } else {
      console.log('');
      info(`Get your ${chosen.name} API key: ${chosen.setupUrl}`);
      info(chosen.setupNote);
      const key = await ask(`  Paste ${chosen.name} API key (or press Enter to skip): `);
      if (key.trim()) {
        selectedApiKey = key.trim();
        // Validate immediately
        info('Validating key...');
        const testResult = await testApiKey(chosen.id, selectedApiKey);
        if (testResult.valid) {
          ok(`${chosen.name} API key valid (${testResult.latencyMs}ms)`);
          updateEnvForSetup({ [chosen.id === 'gemini' ? 'geminiKey' : chosen.id === 'claude' ? 'anthropicKey' : chosen.id === 'openai' ? 'openaiKey' : 'deepseekKey']: selectedApiKey });
          ok('Key saved to .env');
        } else {
          warn(`Key validation failed: ${testResult.error}`);
          info('You can fix this later by editing .env');
        }
      } else {
        info('Skipping — you can add the key later in .env');
      }
    }
  } else {
    info('Skipping cloud analysis — local mode only.');
  }

  // Save Ollama config to .env if changed
  if (selectedOllamaHost && selectedExtractionModel) {
    updateEnvForSetup({
      ollamaUrl: selectedOllamaHost,
      ollamaModel: selectedExtractionModel,
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 4: Project Setup
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section(4, 'Your Project');

  let projectName = projectArg;
  if (!projectName) {
    const input = await ask('  Project name (e.g. "myclient" or "carbium"): ');
    projectName = slugify(input.trim()) || 'myproject';
  }

  // Check for existing config
  if (status.configs.configs.find(c => c.project === projectName)) {
    const overwrite = await ask(c.yellow(`  Config for "${projectName}" already exists. Overwrite? [y/N]: `));
    if (overwrite.toLowerCase() !== 'y') {
      info(`Keeping existing config. Skipping to validation.`);
      // Jump ahead to validation
      await runValidationChapter(projectName, selectedOllamaHost, selectedExtractionModel, selectedAnalysisProvider, selectedApiKey);
      rl.close();
      return;
    }
  }

  const siteUrl = await ask('  Your site URL (e.g. https://carbium.io): ');
  const siteName = await ask('  Site name (e.g. Carbium): ');
  const industry = await ask('  Industry / niche: ');
  const audience = await ask('  Target audience: ');
  const goal     = await ask('  SEO goal in one sentence: ');

  ok(`Project: ${projectName} → ${siteUrl}`);

  // Owned subdomains
  console.log('');
  info('Do you have subdomains? (e.g. blog.example.com, docs.example.com)');
  const owned = [];
  const hasOwned = await ask('  Add owned subdomains? [y/N]: ');
  if (hasOwned.toLowerCase() === 'y') {
    let i = 1;
    while (true) {
      const sub = await ask(`  Subdomain ${i} URL (or press Enter to finish): `);
      if (!sub.trim()) break;
      owned.push({ url: sub.trim() });
      ok(`Added: ${domainFromUrl(sub.trim())}`);
      i++;
    }
  }

  // Competitors
  console.log('');
  info('Now add competitors (enter one domain per line, blank line when done):');
  const competitors = [];
  let compIdx = 1;
  while (true) {
    const comp = await ask(`  Competitor ${compIdx} URL (or press Enter to finish): `);
    if (!comp.trim()) break;
    competitors.push({ url: comp.trim() });
    ok(`Added: ${domainFromUrl(comp.trim())}`);
    compIdx++;
  }

  if (competitors.length === 0) {
    warn('No competitors added. You can edit the config file later.');
  }

  // Crawl settings
  console.log('');
  console.log(c.dim('  Crawl mode:'));
  console.log(c.dim('    1. Standard  — fast, good for most sites'));
  console.log(c.dim('    2. Stealth   — Playwright browser, bypasses bot detection (slower)'));
  console.log(c.dim('    3. Manual    — you pass --stealth flag each time'));

  const modeChoice = await ask('  Mode [1/2/3] (default: 1): ');
  const crawlMode = modeChoice.trim() === '2' ? 'stealth' : modeChoice.trim() === '3' ? 'manual' : 'standard';

  const pagesInput = await ask('  Pages per domain? [default: 50]: ');
  const pagesPerDomain = parseInt(pagesInput.trim()) || 50;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 5: Save Config
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section(5, 'Saving Configuration');

  const config = buildProjectConfig({
    projectName,
    targetUrl: siteUrl.trim(),
    siteName: siteName.trim() || projectName,
    industry: industry.trim(),
    audience: audience.trim(),
    goal: goal.trim(),
    competitors,
    owned,
    crawlMode,
    pagesPerDomain,
    ollamaHost: selectedOllamaHost,
    extractionModel: selectedExtractionModel,
  });

  const result = writeProjectConfig(config);
  ok(`Config saved: ${result.path}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Chapter 6: Pipeline Validation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  await runValidationChapter(projectName, selectedOllamaHost, selectedExtractionModel, selectedAnalysisProvider, selectedApiKey, siteUrl.trim());

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Summary
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('✅', 'Setup Complete');

  console.log(`  ${c.bold('Project:')}     ${projectName}`);
  console.log(`  ${c.bold('Target:')}      ${siteUrl.trim()}`);
  if (owned.length > 0) {
    console.log(`  ${c.bold('Owned:')}       ${owned.map(o => domainFromUrl(o.url)).join(', ')}`);
  }
  console.log(`  ${c.bold('Competitors:')}  ${competitors.map(co => domainFromUrl(co.url)).join(', ') || 'none'}`);
  console.log(`  ${c.bold('Extraction:')}   ${selectedExtractionModel ? `${selectedExtractionModel} (${selectedOllamaHost})` : 'degraded (regex)'}`);
  console.log(`  ${c.bold('Analysis:')}     ${selectedAnalysisProvider || 'none'}`);
  console.log(`  ${c.bold('Config:')}       config/${projectName}.json`);

  console.log('');
  console.log(c.cyan('  → Next steps:'));
  console.log('');
  console.log(c.bold(`    node cli.js crawl ${projectName}${crawlMode === 'stealth' ? ' --stealth' : ''}`));
  console.log(c.dim('    ↑ Crawl your site + all competitors'));
  console.log('');
  console.log(c.bold(`    node cli.js html ${projectName}`));
  console.log(c.dim('    ↑ Generate your SEO dashboard'));
  console.log('');
  console.log(c.bold(`    node cli.js serve`));
  console.log(c.dim('    ↑ Open the live dashboard in your browser'));
  console.log('');
  console.log(c.dim('    Any time you need help: node cli.js --help'));
  console.log('');

  rl.close();
}

// ── Validation Chapter ──────────────────────────────────────────────────────

async function runValidationChapter(projectName, ollamaHost, ollamaModel, apiProvider, apiKey, targetUrl) {
  section(6, 'Pipeline Validation');

  const runTest = await ask('  Run end-to-end validation? (crawl 1 page + extract) [Y/n]: ');
  if (runTest.toLowerCase() === 'n') {
    info('Skipping validation. You can run it later: node cli.js setup --project ' + projectName);
    return;
  }

  console.log('');

  const validationConfig = {
    ollamaHost: ollamaHost || null,
    ollamaModel: ollamaModel || null,
    apiProvider: apiProvider || null,
    apiKey: apiKey || null,
    targetUrl: targetUrl || null,
  };

  for await (const step of runFullValidation(validationConfig)) {
    if (step.step === 'summary') {
      console.log('');
      if (step.status === 'pass') {
        ok(c.bold(`All tests passed! ${step.detail}`));
      } else {
        warn(`${step.detail} — some features may be limited.`);
      }
      continue;
    }

    const icon = step.status === 'pass' ? c.green('✓')
      : step.status === 'fail' ? c.red('✗')
      : step.status === 'skip' ? c.dim('○')
      : c.yellow('…');

    const label = step.step.padEnd(12);
    console.log(`  ${icon} ${label} ${step.detail}`);
  }
}

run().catch(err => {
  console.error('\n❌ Wizard error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
