#!/usr/bin/env node

// ── Node.js version guard ───────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\n  SEO Intel requires Node.js 22.5 or later.\n` +
    `  You have Node.js ${process.versions.node}.\n\n` +
    `  Install the latest LTS:  https://nodejs.org\n`
  );
  process.exit(1);
}

import 'dotenv/config';
import { program } from 'commander';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { totalmem } from 'os';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { crawlDomain } from './crawler/index.js';
// Paid modules — loaded lazily inside gated commands only.
let _extractPage, _buildAnalysisPrompt;
async function getExtractPage() {
  if (!_extractPage) _extractPage = (await import('./extractor/qwen.js')).extractPage;
  return _extractPage;
}
async function getBuildAnalysisPrompt() {
  if (!_buildAnalysisPrompt) _buildAnalysisPrompt = (await import('./analysis/prompt-builder.js')).buildAnalysisPrompt;
  return _buildAnalysisPrompt;
}
import { getNextCrawlTarget, needsAnalysis, getCrawlStatus, loadAllConfigs } from './scheduler.js';
import {
  getDb, upsertDomain, upsertPage, insertExtraction,
  insertKeywords, insertHeadings, insertLinks, insertPageSchemas,
  upsertTechnical, pruneStaleDomains,
  getCompetitorSummary, getKeywordMatrix, getHeadingStructure,
  getPageHash, getSchemasByProject,
  upsertInsightsFromAnalysis, upsertInsightsFromKeywords,
} from './db/db.js';
import { generateMultiDashboard } from './reports/generate-html.js';
import { buildTechnicalActions } from './exports/technical.js';
import { buildCompetitiveActions } from './exports/competitive.js';
import { buildSuggestiveActions } from './exports/suggestive.js';
import { buildExportPayload, formatActionsJson, formatActionsBrief } from './exports/templates.js';
import { assertHasCrawlData, getLatestAnalysis } from './exports/queries.js';
import { requirePro, enforceLimits, capPages, printLicenseStatus } from './lib/gate.js';
import { isPro, loadLicense, activateLicense } from './lib/license.js';
import { getCurrentVersion, checkForUpdates, printUpdateNotice, forceUpdateCheck } from './lib/updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Start background update check (non-blocking, never slows startup)
checkForUpdates();

// Ensure reports/ and config/ directories exist
try { mkdirSync(join(__dirname, 'reports'), { recursive: true }); } catch { /* ok */ }
try { mkdirSync(join(__dirname, 'config'), { recursive: true }); } catch { /* ok */ }

function defaultSiteUrl(domain) {
  const host = String(domain || '').trim();
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '');
  const protocol = hostname === 'localhost' || hostname === '127.0.0.1' ? 'http' : 'https';
  return `${protocol}://${host}`;
}

function resolveExtractionRuntime(config) {
  const primaryUrl = config?.crawl?.ollamaHost || process.env.OLLAMA_URL || 'http://localhost:11434';
  const primaryModel = config?.crawl?.extractionModel || process.env.OLLAMA_MODEL || 'qwen3:4b';
  const fallbackUrl = process.env.OLLAMA_FALLBACK_URL || '';
  const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || primaryModel;
  const localhost = 'http://localhost:11434';

  const candidates = [
    { host: String(primaryUrl).trim().replace(/\/+$/, ''), model: String(primaryModel).trim() || 'qwen3:4b' },
  ];

  if (fallbackUrl) {
    candidates.push({
      host: String(fallbackUrl).trim().replace(/\/+$/, ''),
      model: String(fallbackModel).trim() || String(primaryModel).trim() || 'qwen3:4b',
    });
  }

  if (!candidates.some(candidate => candidate.host === localhost)) {
    candidates.push({ host: localhost, model: String(primaryModel).trim() || 'qwen3:4b' });
  }

  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate.host) return false;
    const key = `${candidate.host}::${candidate.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyExtractionRuntimeConfig(config) {
  if (!config?.crawl) return;
  if (config.crawl.ollamaHost) process.env.OLLAMA_URL = config.crawl.ollamaHost;
  if (config.crawl.extractionModel) process.env.OLLAMA_MODEL = config.crawl.extractionModel;
}

// ── AI AVAILABILITY PREFLIGHT ────────────────────────────────────────────
/**
 * Check if any AI extraction backend is reachable.
 * Tries: primary Ollama → fallback Ollama → returns false.
 * Fast: 2s timeout per host, runs sequentially.
 */
async function checkOllamaAvailability(config) {
  const candidates = resolveExtractionRuntime(config);
  let sawReachableHost = false;

  for (const candidate of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${candidate.host}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map(m => m.name);
        sawReachableHost = true;
        const hasModel = models.some(m => m && m.split(':')[0] === candidate.model.split(':')[0]);
        if (hasModel) {
          return true; // Ollama reachable + model available
        }
      }
    } catch { /* host unreachable, try next */ }
  }

  if (sawReachableHost) {
    const primary = candidates[0];
    console.log(chalk.yellow(`  ⚠️  Ollama is reachable but model "${primary?.model || 'qwen3:4b'}" was not found on any live host`));
    console.log(chalk.dim(`  Run: ollama pull ${primary?.model || 'qwen3:4b'}`));
  }

  return false;
}

// ── EXTRACTION PROGRESS TRACKER ──────────────────────────────────────────
const PROGRESS_FILE = join(__dirname, '.extraction-progress.json');

// ── Graceful shutdown support ──
// Cleanup callbacks registered by crawl/extract commands (e.g. close browser)
const _shutdownCallbacks = [];
let _shuttingDown = false;

function onShutdown(fn) { _shutdownCallbacks.push(fn); }
function clearShutdownCallbacks() { _shutdownCallbacks.length = 0; }

async function _gracefulExit(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(chalk.yellow(`\n⏹  Received ${signal} — stopping gracefully…`));

  // Update progress file
  try {
    const progress = readProgress();
    if (progress && progress.status === 'running' && progress.pid === process.pid) {
      writeProgress({ ...progress, status: 'stopped', stopped_at: Date.now() });
    }
  } catch { /* best-effort */ }

  // Run cleanup callbacks (close browsers, etc.)
  for (const fn of _shutdownCallbacks) {
    try { await Promise.resolve(fn()); } catch { /* best-effort */ }
  }

  process.exit(0);
}

process.on('SIGTERM', () => _gracefulExit('SIGTERM'));
process.on('SIGINT', () => _gracefulExit('SIGINT'));

function writeProgress(data) {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify({
      ...data,
      updated_at: Date.now(),
      pid: process.pid,
    }, null, 2));
  } catch { /* best-effort */ }
}

function clearProgress() {
  try { if (existsSync(PROGRESS_FILE)) unlinkSync(PROGRESS_FILE); } catch { /* ok */ }
}

function readProgress() {
  try {
    if (!existsSync(PROGRESS_FILE)) return null;
    const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));

    // PID liveness check — if status says "running" but PID is dead, it crashed
    if (data.status === 'running' && data.pid) {
      try { process.kill(data.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') {
          // No such process — it's dead
          data.status = 'crashed';
          data.crashed_at = data.updated_at;
        }
        // EPERM means process exists but we can't signal it — it's alive
      }
    }

    return data;
  } catch { return null; }
}

program
  .name('seo-intel')
  .description('SEO Competitor Intelligence Tool')
  .version(getCurrentVersion());

// ── SETUP WIZARD ───────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Interactive setup wizard — uses OpenClaw agent if available, otherwise standard CLI wizard')
  .option('--project <name>', 'Project name to prefill')
  .option('--classic', 'Force classic CLI wizard (skip OpenClaw agent)')
  .option('--agent', 'Force OpenClaw agent setup (fail if not available)')
  .action(async (opts) => {
    // Check for OpenClaw unless --classic is forced
    if (!opts.classic) {
      try {
        const { checkOpenClaw } = await import('./setup/checks.js');
        const oc = checkOpenClaw();

        if (oc.installed && oc.gatewayRunning) {
          console.log(chalk.dim('\n  OpenClaw detected — using agent-powered setup'));
          console.log(chalk.dim('  (use --classic for the standard wizard)\n'));

          const { fullSystemCheck } = await import('./setup/engine.js');
          const status = await fullSystemCheck();
          const { cliAgentSetup } = await import('./setup/openclaw-bridge.js');
          await cliAgentSetup(status);
          return;
        } else if (opts.agent) {
          console.error(chalk.red('\n  OpenClaw gateway not running.'));
          console.log(chalk.dim('  Start it with: openclaw gateway\n'));
          process.exit(1);
        }
        // Fall through to classic wizard
      } catch (err) {
        if (opts.agent) {
          console.error(chalk.red(`\n  OpenClaw setup failed: ${err.message}\n`));
          process.exit(1);
        }
        // Fall through to classic wizard
      }
    }

    // Classic CLI wizard
    const args = ['config/setup-wizard.js'];
    if (opts.project) args.push('--project', opts.project);
    const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: __dirname });
    process.exit(res.status ?? 0);
  });

// ── SUBDOMAIN DISCOVERY ───────────────────────────────────────────────────
program
  .command('subdomains <domain>')
  .description('Discover subdomains for a domain (crt.sh + DNS + crawl data)')
  .option('--no-http', 'Skip HTTP liveness check (faster, DNS only)')
  .option('--add-to <project>', 'Auto-add SEO-relevant subdomains to a project config')
  .action(async (domain, opts) => {
    const { discoverSubdomains } = await import('./crawler/subdomain-discovery.js');

    // Clean domain input
    const rootDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

    console.log(chalk.bold.cyan(`\n🔍 Discovering subdomains for ${rootDomain}\n`));

    // Optionally use DB for crawl data mining
    let db = null;
    try { db = getDb(); } catch { /* no DB yet, that's fine */ }

    const result = await discoverSubdomains(rootDomain, {
      db,
      httpCheck: opts.http !== false,
      onProgress: ({ phase, message }) => {
        console.log(chalk.dim(`  ${message}`));
      },
    });

    // Display results
    console.log(chalk.bold(`\n  Found ${result.discovered} subdomains (${result.live} live, ${result.seoRelevant} SEO-relevant)\n`));

    if (result.subdomains.length === 0) {
      console.log(chalk.yellow('  No subdomains found.'));
      return;
    }

    // Table header
    console.log(chalk.dim('  ' + 'Subdomain'.padEnd(30) + 'Status'.padEnd(8) + 'Sitemap'.padEnd(10) + 'Title'.padEnd(35) + 'SEO'));
    console.log(chalk.dim('  ' + '─'.repeat(90)));

    for (const s of result.subdomains) {
      const statusColor = s.httpStatus === 200 ? chalk.green
        : s.httpStatus >= 300 && s.httpStatus < 400 ? chalk.yellow
        : s.httpStatus >= 400 ? chalk.red
        : chalk.dim;

      const seoIcon = s.seoRelevant ? chalk.green('✓') : s.redirected ? chalk.yellow('→ ' + (s.redirectTarget || '')) : chalk.dim('–');
      const title = String(s.title || s.error || '').slice(0, 33);
      const sitemapStr = s.sitemapUrls > 0 ? chalk.cyan(s.sitemapUrls.toString()) : chalk.dim('—');

      console.log(
        '  ' +
        chalk.white(s.hostname.padEnd(30)) +
        statusColor((s.httpStatus || '—').toString().padEnd(8)) +
        sitemapStr.padEnd(10 + (sitemapStr.length - String(s.sitemapUrls || '—').length)) +
        chalk.dim(title.padEnd(35)) +
        seoIcon
      );
    }

    // Summary
    if (result.totalSitemapUrls > 0) {
      console.log(chalk.dim(`\n  📄 Total sitemap URLs across subdomains: ${chalk.cyan(result.totalSitemapUrls)}`));
    }

    // Sources breakdown
    console.log(chalk.dim(`  Sources: ${Object.entries(result.sources).map(([k,v]) => `${k}: ${v}`).join(', ')}`));

    // Auto-add to project config
    if (opts.addTo) {
      const relevant = result.subdomains.filter(s => s.seoRelevant && !s.isRoot);
      if (relevant.length === 0) {
        console.log(chalk.yellow('\n  No SEO-relevant subdomains to add.'));
        return;
      }

      console.log(chalk.bold(`\n  Adding ${relevant.length} subdomains to ${opts.addTo} config as owned domains:\n`));

      try {
        const configPath = join(__dirname, 'config', opts.addTo + '.json');
        if (!existsSync(configPath)) {
          console.log(chalk.red(`  Config not found: ${configPath}`));
          return;
        }

        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        if (!config.owned) config.owned = [];

        let added = 0;
        for (const s of relevant) {
          const alreadyExists = config.owned.some(o => o.domain === s.hostname)
            || config.target?.domain === s.hostname
            || config.competitors?.some(c => c.domain === s.hostname);

          if (!alreadyExists) {
            config.owned.push({
              domain: s.hostname,
              maxPages: 100,
              crawlMode: 'standard',
            });
            console.log(chalk.green(`    + ${s.hostname}`) + chalk.dim(` (${s.title || 'no title'})`));
            added++;
          } else {
            console.log(chalk.dim(`    ○ ${s.hostname} (already in config)`));
          }
        }

        if (added > 0) {
          writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
          console.log(chalk.green(`\n  ✓ Added ${added} subdomains. Run: seo-intel crawl ${opts.addTo}`));
        } else {
          console.log(chalk.dim('\n  All subdomains already in config.'));
        }
      } catch (err) {
        console.error(chalk.red(`  Error updating config: ${err.message}`));
      }
    }

    console.log('');
  });

// ── CRAWL ──────────────────────────────────────────────────────────────────
program
  .command('crawl <project>')
  .description('Crawl target + competitors for a project')
  .option('--target-only', 'Crawl target site only, skip competitors')
  .option('--domain <domain>', 'Crawl a specific domain only')
  .option('--max-pages <n>', 'Override max pages per domain (default from CRAWL_MAX_PAGES)', null)
  .option('--max-depth <n>', 'Override max click depth (default from CRAWL_MAX_DEPTH)', null)
  .option('--no-extract', 'Skip Qwen extraction (crawl only, extract later)')
  .option('--stealth', 'Advanced browser mode for JS-heavy and dynamic sites')
  .option('--no-tiered', 'Disable section-aware crawling (flat BFS instead)')
  .option('--concurrency <n>', 'Domains to crawl in parallel (auto: 1 if <8GB RAM, 2 if <16GB, 3 otherwise)')
  .option('--no-discover', 'Skip automatic subdomain discovery')
  .action(async (project, opts) => {
    const config = loadConfig(project);
    const db = getDb();
    applyExtractionRuntimeConfig(config);

    // ── Auto-discover subdomains for target domain ──────────────────────
    if (opts.discover !== false && config.target?.domain) {
      const rootDomain = config.target.domain.replace(/^www\./, '');
      console.log(chalk.dim(`\n  🔍 Discovering subdomains for ${rootDomain}...`));

      try {
        const { discoverSubdomains } = await import('./crawler/subdomain-discovery.js');
        const result = await discoverSubdomains(rootDomain, { db, httpCheck: true });

        const relevant = result.subdomains.filter(s => s.seoRelevant && !s.isRoot);
        if (relevant.length > 0) {
          // Check which ones are new (not in config)
          if (!config.owned) config.owned = [];
          const allConfigDomains = new Set([
            config.target.domain,
            ...(config.owned || []).map(o => o.domain),
            ...(config.competitors || []).map(c => c.domain),
          ]);

          const newSubs = relevant.filter(s => !allConfigDomains.has(s.hostname));

          if (newSubs.length > 0) {
            console.log(chalk.green(`  ✓ Found ${newSubs.length} new subdomain(s):`));
            for (const s of newSubs) {
              const sitemapInfo = s.sitemapUrls > 0 ? chalk.cyan(` (${s.sitemapUrls} sitemap URLs)`) : '';
              console.log(chalk.green(`    + ${s.hostname}`) + chalk.dim(` — ${s.title || 'no title'}`) + sitemapInfo);
              // Use sitemap count to suggest maxPages (at least 100, capped at 500)
              const suggestedPages = s.sitemapUrls > 0 ? Math.min(500, Math.max(100, s.sitemapUrls)) : 100;
              config.owned.push({
                domain: s.hostname,
                maxPages: suggestedPages,
                crawlMode: 'standard',
              });
            }
            // Save updated config
            const configPath = join(__dirname, `config/${project}.json`);
            writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
            console.log(chalk.dim(`  Config updated → ${newSubs.length} subdomains added as owned`));
          } else {
            console.log(chalk.dim(`  ✓ All ${relevant.length} subdomains already in config`));
          }
        } else {
          console.log(chalk.dim('  ✓ No new subdomains found'));
        }
      } catch (err) {
        console.log(chalk.dim(`  ⚠ Subdomain discovery skipped: ${err.message}`));
      }
    }

    // ── Prune stale domains (DB entries no longer in config) ─────────────
    {
      const configDomains = new Set([
        config.target?.domain,
        ...(config.owned || []).map(o => o.domain),
        ...(config.competitors || []).map(c => c.domain),
      ].filter(Boolean));

      const pruned = pruneStaleDomains(db, project, configDomains);
      if (pruned.length) {
        console.log(chalk.yellow(`\n  🧹 Pruned ${pruned.length} stale domain(s) from DB (no longer in config):`));
        for (const d of pruned) console.log(chalk.dim(`     − ${d}`));
      }
    }

    // ── Tier gate: Free tier = crawl-only, no AI extraction ──────────────
    if (opts.extract !== false && !isPro()) {
      console.log(chalk.dim('\n  ℹ  Free tier: crawl-only mode (AI extraction requires Solo/Agency)'));
      opts.extract = false;
    }

    // ── BUG-003/009: AI preflight — check Ollama availability before crawl ──
    if (opts.extract !== false) {
      const ollamaAvailable = await checkOllamaAvailability(config);
      if (!ollamaAvailable) {
        console.log(chalk.yellow('\n  ⚠️  No AI extraction available (Ollama unreachable, no API keys configured)'));
        console.log(chalk.white('  → Switching to ') + chalk.bold.green('crawl-only mode') + chalk.white(' — raw data will be collected without AI extraction'));
        console.log(chalk.dim('  Tip: Install Ollama (ollama.com) + run `ollama pull qwen3:4b` to enable local AI extraction\n'));
        opts.extract = false;
      }
    }

    const owned = config.owned || [];
    const allSites = [config.target, ...owned, ...config.competitors];

    // Add role + url to owned entries if missing
    for (const site of allSites) {
      if (!site.role) {
        if (site === config.target) site.role = 'target';
        else if (config.competitors?.includes(site)) site.role = 'competitor';
        else site.role = 'owned';
      }
      if (!site.url && site.domain) site.url = defaultSiteUrl(site.domain);
    }

    const sites = opts.domain
      ? allSites.filter(s => s.domain === opts.domain)
      : opts.targetOnly
        ? [config.target, ...owned]
        : allSites;

    const stealthLabel = opts.stealth ? chalk.magenta(' [STEALTH]') : '';
    const tieredLabel = opts.tiered === false ? chalk.gray(' [flat BFS]') : chalk.green(' [tiered]');
    console.log(chalk.bold.cyan(`\n🔍 SEO Intel — Crawling ${sites.length} site(s) for project: ${project}`) + stealthLabel + tieredLabel + '\n');

    const crawlStart = Date.now();
    let totalExtracted = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalBlocked = 0;
    const ramGb = totalmem() / (1024 ** 3);
    const defaultConcurrency = ramGb < 8 ? 1 : ramGb < 16 ? 2 : 3;
    const concurrency = Math.max(1, parseInt(opts.concurrency) || defaultConcurrency);

    // ── Per-domain crawl worker ──────────────────────────────────────────
    async function crawlSite(site) {
      const tag = chalk.cyan(`[${site.domain.split('.')[0]}]`);
      console.log(chalk.yellow(`\n${tag} → Crawling ${site.url} [${site.role}]`));

      upsertDomain(db, { domain: site.domain, project, role: site.role });
      const domainId = db.prepare('SELECT id FROM domains WHERE domain = ? AND project = ?').get(site.domain, project)?.id;
      if (!domainId) { console.error(`${tag} No domainId for`, site.domain); return; }

      let pageCount = 0;
      let siteExtracted = 0;
      let siteSkipped = 0;
      const requestedPages = opts.maxPages ? parseInt(opts.maxPages) : undefined;
      const crawlOpts = {
        maxPages: requestedPages ? capPages(requestedPages) : capPages(9999),
        maxDepth: opts.maxDepth ? parseInt(opts.maxDepth) : undefined,
        stealth: !!opts.stealth,
        tiered: opts.tiered !== false,
        strictHost: !!opts.domain, // BUG-006: enforce exact hostname when --domain is set
      };

      for await (const page of crawlDomain(site.url, crawlOpts)) {
        if (page._blocked) {
          totalBlocked++;
          console.log(chalk.bold.red(`  ${tag} ⛔ BLOCKED: ${page._blockReason} — stopping ${site.domain}`));
          break;
        }

        const oldHash = (opts.extract !== false && page.contentHash)
          ? getPageHash(db, page.url)
          : null;
        const hadExtraction = (opts.extract !== false)
          ? !!db.prepare('SELECT 1 FROM extractions e JOIN pages p ON p.id = e.page_id WHERE p.url = ? LIMIT 1').get(page.url)
          : false;

        const pageRes = upsertPage(db, {
          domainId,
          url: page.url,
          statusCode: page.status,
          wordCount: page.wordCount,
          loadMs: page.loadMs,
          isIndexable: page.isIndexable,
          clickDepth: page.depth ?? 0,
          publishedDate: page.publishedDate || null,
          modifiedDate: page.modifiedDate || null,
          contentHash: page.contentHash || null,
          title: page.title || null,
          metaDesc: page.metaDesc || null,
          bodyText: page.fullBodyText || page.bodyText || null,
        });
        const pageId = pageRes?.id;

        if (opts.extract !== false && page.contentHash && hadExtraction && oldHash && oldHash === page.contentHash) {
          totalSkipped++;
          siteSkipped++;
          process.stdout.write(chalk.gray(`  ${tag} [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} `) + chalk.blue('≡ unchanged\n'));
          pageCount++;
          continue;
        }

        if (!page.quality && page.qualityReason) {
          process.stdout.write(chalk.yellow(`  ${tag} [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} `) + chalk.yellow(`⚠ ${page.qualityReason} (${page.wordCount}w) — skipped\n`));
          pageCount++;
          continue;
        }

        if (opts.extract !== false) {
          process.stdout.write(chalk.gray(`  ${tag} [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} → extracting...`));
          writeProgress({
            status: 'running', command: 'crawl', project,
            domain: site.domain, current_url: page.url,
            page_index: totalExtracted + 1,
            started_at: crawlStart,
            failed: totalFailed,
            stealth: !!crawlOpts.stealth,
          });
          upsertTechnical(db, { pageId, hasCanonical: page.hasCanonical, hasOgTags: page.hasOgTags, hasSchema: page.hasSchema, hasRobots: page.hasRobots });
          try {
            const extractFn = await getExtractPage();
            const extraction = await extractFn(page);
            insertExtraction(db, { pageId, data: extraction });
            insertKeywords(db, pageId, extraction.keywords);
            insertHeadings(db, pageId, page.headings);
            insertLinks(db, pageId, page.links);
            if (page.parsedSchemas?.length) insertPageSchemas(db, pageId, page.parsedSchemas);
            process.stdout.write(chalk.green(` ✓${page.parsedSchemas?.length ? ` [${page.parsedSchemas.length} schema]` : ''}\n`));
            totalExtracted++;
            siteExtracted++;
          } catch (err) {
            process.stdout.write(chalk.red(` ✗ ${err.message}\n`));
            totalFailed++;
          }
        } else {
          upsertTechnical(db, { pageId, hasCanonical: page.hasCanonical, hasOgTags: page.hasOgTags, hasSchema: page.hasSchema, hasRobots: page.hasRobots });
          insertHeadings(db, pageId, page.headings);
          insertLinks(db, pageId, page.links);
          if (page.parsedSchemas?.length) insertPageSchemas(db, pageId, page.parsedSchemas);
          process.stdout.write(chalk.gray(`  ${tag} [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} ✓${page.parsedSchemas?.length ? ` [${page.parsedSchemas.length} schema]` : ''}\n`));
        }

        pageCount++;
      }

      const parts = [`${pageCount} pages`];
      if (siteExtracted > 0) parts.push(chalk.green(`${siteExtracted} extracted`));
      if (siteSkipped > 0) parts.push(chalk.blue(`${siteSkipped} unchanged`));
      console.log(chalk.green(`  ${tag} ✅ Done: ${parts.join(' · ')}`));
    }

    // ── Concurrency-limited parallel executor ────────────────────────────
    if (concurrency > 1 && sites.length > 1) {
      console.log(chalk.magenta(`⚡ Parallel mode: ${concurrency} domains at a time\n`));
    }

    const queue = [...sites];
    const running = new Set();
    const results = [];

    async function runNext() {
      if (queue.length === 0) return;
      const site = queue.shift();
      const promise = crawlSite(site).catch(err => {
        console.error(chalk.red(`\n✗ ${site.domain} failed: ${err.message}`));
      });
      running.add(promise);
      promise.finally(() => running.delete(promise));
      results.push(promise);
      if (running.size >= concurrency) {
        await Promise.race(running);
      }
      await runNext();
    }

    await runNext();
    await Promise.all(results);

    writeProgress({ status: 'completed', command: 'crawl', project, extracted: totalExtracted, failed: totalFailed, skipped: totalSkipped, started_at: crawlStart, finished_at: Date.now() });
    if (totalSkipped > 0) console.log(chalk.blue(`\n📊 Incremental: ${totalSkipped} unchanged pages skipped (same content hash)`));
    if (totalBlocked > 0) console.log(chalk.red(`\n⛔ ${totalBlocked} domain(s) blocked (rate-limited or WAF)`));
    const elapsed = ((Date.now() - crawlStart) / 1000).toFixed(1);
    // Auto-regenerate dashboard (always multi-project so all projects stay current)
    try {
      const allConfigs = loadAllConfigs();
      const dashPath = generateMultiDashboard(db, allConfigs);
      console.log(chalk.dim(`  📊 Dashboard refreshed → ${dashPath}`));
    } catch (dashErr) {
      console.log(chalk.dim(`  ⚠  Dashboard refresh skipped: ${dashErr.message}`));
    }

    if (opts.extract === false && totalExtracted === 0) {
      console.log(chalk.bold.green(`\n✅ Crawl complete (${elapsed}s) — raw data collected.`));
      console.log(chalk.white('  Next steps:'));
      console.log(chalk.cyan('    → seo-intel extract ' + project) + chalk.dim('  (run AI extraction when Ollama is available)'));
      console.log(chalk.cyan('    → seo-intel analyze ' + project) + chalk.dim('  (run full AI analysis)'));
      console.log('');
    } else {
      console.log(chalk.bold.green(`\n✅ Crawl complete (${elapsed}s). Run \`seo-intel analyze ${project}\` next.\n`));
    }

    // Exit non-zero if any extraction failures or all domains blocked
    if (totalFailed > 0 || totalBlocked === sites.length) {
      process.exit(1);
    }
  });

// ── ANALYZE ────────────────────────────────────────────────────────────────
program
  .command('analyze <project>')
  .description('Run cloud analysis (Gemini) on crawled data')
  .option('--model <model>', 'Model to use', 'gemini')
  .action(async (project, opts) => {
    if (!requirePro('analyze')) return;
    const config = loadConfig(project);
    const db = getDb();

    console.log(chalk.bold.cyan(`\n🧠 Analyzing ${project} data...\n`));

    const summary      = getCompetitorSummary(db, project);
    const keywordMatrix = getKeywordMatrix(db, project);
    const headings     = getHeadingStructure(db, project);

    if (!summary.length) {
      console.error(chalk.red('No crawl data found. Run `crawl` first.'));
      process.exit(1);
    }

    const target      = summary.find(s => s.role === 'target');
    const competitors = summary.filter(s => s.role === 'competitor');

    if (!target) {
      console.error(chalk.red('No target site data found.'));
      process.exit(1);
    }

    // Augment with domain for formatting
    target.domain      = config.target.domain;
    competitors.forEach((c, i) => c.domain = config.competitors[i]?.domain || c.domain);

    const buildPromptFn = await getBuildAnalysisPrompt();
    const prompt = buildPromptFn({
      project,
      target,
      competitors,
      keywordMatrix,
      headingStructure: headings,
      context: config.context,
    });

    console.log(chalk.yellow(`Prompt length: ~${Math.round(prompt.length / 4)} tokens`));
    console.log(chalk.yellow('Sending to Gemini...\n'));

    // Save prompt for debugging (markdown for Obsidian/agent compatibility)
    const promptTs = Date.now();
    const promptPath = join(__dirname, `reports/${project}-prompt-${promptTs}.md`);
    const promptFrontmatter = `---\nproject: ${project}\ngenerated: ${new Date(promptTs).toISOString()}\ntype: analysis-prompt\nmodel: gemini\n---\n\n`;
    writeFileSync(promptPath, promptFrontmatter + prompt, 'utf8');
    console.log(chalk.gray(`Prompt saved: ${promptPath}`));

    // Call Gemini via gemini CLI (reuse existing auth)
    process.env._SEO_INTEL_PROJECT = project;
    const result = await callAnalysisModel(prompt, opts.model);

    if (!result) {
      console.error(chalk.red('No response from model.'));
      process.exit(1);
    }

    // Parse JSON from response
    let analysis;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch[0]);
    } catch {
      console.error(chalk.red('Could not parse JSON from response. Saving raw output.'));
      const rawPath = join(__dirname, `reports/${project}-raw-${Date.now()}.md`);
      writeFileSync(rawPath, result, 'utf8');
      process.exit(1);
    }

    // Save structured analysis to file
    const outPath = join(__dirname, `reports/${project}-analysis-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(analysis, null, 2), 'utf8');

    // Save to DB (so HTML dashboard picks it up)
    const analysisTs = Date.now();
    db.prepare(`
      INSERT INTO analyses (project, generated_at, model, keyword_gaps, long_tails, quick_wins, new_pages, content_gaps, positioning, technical_gaps, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project, analysisTs, 'gemini',
      JSON.stringify(analysis.keyword_gaps || []),
      JSON.stringify(analysis.long_tails || []),
      JSON.stringify(analysis.quick_wins || []),
      JSON.stringify(analysis.new_pages || []),
      JSON.stringify(analysis.content_gaps || []),
      JSON.stringify(analysis.positioning || {}),
      JSON.stringify(analysis.technical_gaps || []),
      result,
    );

    // Upsert individual insights (Intelligence Ledger — accumulates across runs)
    const analysisRowId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    upsertInsightsFromAnalysis(db, project, analysisRowId, analysis, analysisTs);

    // Print summary
    printAnalysisSummary(analysis, project);

    // Auto-regenerate dashboard (always multi-project so all projects stay current)
    try {
      const allConfigs = loadAllConfigs();
      const dashPath = generateMultiDashboard(db, allConfigs);
      console.log(chalk.dim(`  📊 Dashboard refreshed → ${dashPath}`));
    } catch (dashErr) {
      console.log(chalk.dim(`  ⚠  Dashboard refresh skipped: ${dashErr.message}`));
    }

    console.log(chalk.bold.green(`\n✅ Analysis saved: ${outPath}\n`));
  });

// ── KEYWORDS ───────────────────────────────────────────────────────────────
program
  .command('keywords <project>')
  .description('Generate a keyword cluster matrix (traditional + perplexity + agent) via Gemini')
  .option('--count <n>', 'Number of keyword phrases to generate', '120')
  .option('--intent <type>', 'Filter by intent: commercial|informational|all', 'all')
  .option('--save', 'Save output to reports/<project>-keywords-<timestamp>.json')
  .action(async (project, opts) => {
    if (!requirePro('keywords')) return;
    const config = loadConfig(project);
    const db = getDb();
    const count = parseInt(opts.count) || 120;
    const intentFilter = opts.intent || 'all';

    console.log(chalk.bold.cyan(`\n🔑 Keyword Matrix — ${project.toUpperCase()}\n`));
    console.log(chalk.gray(`Generating ${count} phrases (intent: ${intentFilter})...\n`));

    const keywordMatrix = getKeywordMatrix(db, project);
    const summary       = getCompetitorSummary(db, project);

    if (!summary.length) {
      console.error(chalk.red('No crawl data found. Run `crawl` first.'));
      process.exit(1);
    }

    const target      = summary.find(s => s.role === 'target');
    const competitors = summary.filter(s => s.role === 'competitor');

    if (!target) {
      console.error(chalk.red('No target site data found.'));
      process.exit(1);
    }

    target.domain = config.target.domain;
    competitors.forEach((c, i) => { c.domain = config.competitors[i]?.domain || c.domain; });

    // Top competitor keywords for context (count unique competitor domains mentioning each keyword)
    const competitorCountByKeyword = new Map();
    for (const row of keywordMatrix) {
      if (row.role !== 'competitor') continue;
      const key = String(row.keyword || '').toLowerCase().trim();
      if (!key) continue;
      if (!competitorCountByKeyword.has(key)) competitorCountByKeyword.set(key, new Set());
      competitorCountByKeyword.get(key).add(row.domain);
    }

    const topKeywords = [...competitorCountByKeyword.entries()]
      .map(([keyword, domains]) => ({ keyword, competitor_count: domains.size }))
      .sort((a, b) => b.competitor_count - a.competitor_count)
      .slice(0, 60)
      .map(k => `${k.keyword} (${k.competitor_count} competitors)`)
      .join('\n');

    const competitorDomains = competitors.map(c => c.domain).join(', ');

    const intentInstruction = intentFilter === 'all'
      ? 'Include a mix of informational, commercial, transactional, and navigational intents.'
      : `Focus primarily on ${intentFilter} intent keywords.`;

    const industry = config.context || `the industry of ${target.domain}`;
    const prompt = `You are an expert SEO strategist. Analyze the competitive landscape and generate keyword opportunities.

Project: ${project.toUpperCase()}
Target site: ${target.domain}
Competitors: ${competitorDomains}
Industry context: ${industry}

Competitor keyword signals (crawled data):
${topKeywords || '(no crawl data yet — use your knowledge of the space)'}

Generate exactly ${count} keyword phrases organized into clusters. ${intentInstruction}

Three keyword types to generate:
1. **traditional** — how humans search Google (3-5 words, keyword-style)
2. **perplexity** — how users ask Perplexity/ChatGPT (more complete, question-style)
3. **agent** — how an AI agent researches on behalf of a user (technical, complete, spec-like queries that include requirements and constraints). Agent queries are a new SEO vector — LLMs cite structured, factual content, so optimizing for agent queries means getting cited by AI assistants.

Distribute the ${count} phrases roughly as: 40% traditional, 35% perplexity, 25% agent.

Respond ONLY with a single valid JSON object matching this exact schema. No explanation, no markdown, no backticks:

{
  "keyword_clusters": [
    {
      "topic": "cluster topic name",
      "funnel_stage": "awareness|consideration|decision",
      "competition": "low|medium|high",
      "keywords": [
        {
          "phrase": "3-6 word keyword phrase or full question",
          "type": "traditional|perplexity|agent",
          "intent": "informational|commercial|navigational|transactional",
          "priority": "high|medium|low",
          "notes": "why this is a good target for ${target.domain}"
        }
      ]
    }
  ],
  "quick_targets": ["phrase1", "phrase2", "phrase3", "phrase4", "phrase5"],
  "agent_queries": [
    "full question an AI agent would ask to find this product"
  ],
  "summary": "2-3 sentence executive summary of the keyword opportunity for ${target.domain}"
}`;

    console.log(chalk.yellow(`Prompt length: ~${Math.round(prompt.length / 4)} tokens`));
    console.log(chalk.yellow('Sending to Gemini...\n'));

    const result = await callGemini(prompt);

    if (!result) {
      console.error(chalk.red('No response from Gemini.'));
      process.exit(1);
    }

    let data;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      data = JSON.parse(jsonMatch[0]);
    } catch {
      console.error(chalk.red('Could not parse JSON from Gemini response.'));
      const rawPath = join(__dirname, `reports/${project}-keywords-raw-${Date.now()}.md`);
      writeFileSync(rawPath, result, 'utf8');
      console.error(chalk.gray(`Raw output saved: ${rawPath}`));
      process.exit(1);
    }

    // Apply intent filter if needed
    if (intentFilter !== 'all') {
      for (const cluster of (data.keyword_clusters || [])) {
        cluster.keywords = (cluster.keywords || []).filter(k => k.intent === intentFilter);
      }
      data.keyword_clusters = data.keyword_clusters.filter(c => c.keywords.length > 0);
    }

    // Count totals
    const allKeywords = (data.keyword_clusters || []).flatMap(c => c.keywords || []);
    const byType = { traditional: 0, perplexity: 0, agent: 0 };
    const byStage = { awareness: 0, consideration: 0, decision: 0 };
    for (const kw of allKeywords) {
      if (byType[kw.type] !== undefined) byType[kw.type]++;
    }
    for (const cluster of (data.keyword_clusters || [])) {
      const stage = cluster.funnel_stage;
      if (byStage[stage] !== undefined) byStage[stage] += (cluster.keywords || []).length;
    }

    // Print terminal output
    console.log(chalk.bold.cyan(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold.cyan(`  📊 Keyword Matrix Results — ${project.toUpperCase()}`));
    console.log(chalk.bold.cyan(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    console.log(chalk.bold(`Total phrases: ${allKeywords.length}`));
    console.log(chalk.gray(`  Traditional: ${byType.traditional}  ·  Perplexity: ${byType.perplexity}  ·  Agent: ${byType.agent}\n`));

    console.log(chalk.bold('By funnel stage:'));
    console.log(`  ${chalk.blue('Awareness:')}      ${byStage.awareness}`);
    console.log(`  ${chalk.yellow('Consideration:')} ${byStage.consideration}`);
    console.log(`  ${chalk.green('Decision:')}      ${byStage.decision}\n`);

    if (data.quick_targets?.length) {
      console.log(chalk.bold('⚡ Top Quick Targets:'));
      data.quick_targets.slice(0, 5).forEach((phrase, i) => {
        console.log(`  ${chalk.bold.green(`${i + 1}.`)} ${phrase}`);
      });
      console.log();
    }

    if (data.agent_queries?.length) {
      console.log(chalk.bold.magenta('🤖 Top Agent Queries (AI citation gold):'));
      data.agent_queries.slice(0, 3).forEach((q, i) => {
        console.log(`  ${chalk.bold.magenta(`${i + 1}.`)} ${q}`);
      });
      console.log();
    }

    if (data.summary) {
      console.log(chalk.bold('📝 Summary:'));
      console.log(chalk.gray(`  ${data.summary}\n`));
    }

    if (opts.save) {
      const outPath = join(__dirname, `reports/${project}-keywords-${Date.now()}.json`);
      writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
      console.log(chalk.bold.green(`✅ Report saved: ${outPath}\n`));

      // Persist keyword inventor insights to Intelligence Ledger
      const db = getDb();
      upsertInsightsFromKeywords(db, project, data);
    }
  });

// ── REPORT ─────────────────────────────────────────────────────────────────
program
  .command('report <project>')
  .description('Print latest analysis as readable markdown')
  .action((project) => {
    const files = readdirSync(join(__dirname, 'reports'))
      .filter(f => f.startsWith(`${project}-analysis-`))
      .sort().reverse();

    if (!files.length) {
      console.error(chalk.red('No analysis found. Run `analyze` first.'));
      process.exit(1);
    }

    const latest = JSON.parse(readFileSync(join(__dirname, 'reports', files[0]), 'utf8'));
    printAnalysisSummary(latest, project);
  });

// ── Helpers ────────────────────────────────────────────────────────────────

function loadConfig(project) {
  const configDir = join(__dirname, 'config');
  const path = join(configDir, `${project}.json`);

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // BUG-001: If input looks like a domain, try to match against existing project configs
    if (project.includes('.')) {
      const inputDomain = project.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      try {
        const configs = readdirSync(configDir).filter(f => f.endsWith('.json'));
        for (const file of configs) {
          try {
            const cfg = JSON.parse(readFileSync(join(configDir, file), 'utf8'));
            const allDomains = [
              cfg.target?.domain,
              ...(cfg.owned || []).map(o => o.domain),
              ...(cfg.competitors || []).map(c => c.domain),
            ].filter(Boolean);

            if (allDomains.some(d => d === inputDomain || d === `www.${inputDomain}` || inputDomain === `www.${d}`)) {
              const projectName = file.replace('.json', '');
              console.error(chalk.yellow(`\n⚠️  "${project}" looks like a domain. Did you mean the project name?`));
              console.error(chalk.bold.cyan(`   → seo-intel crawl ${projectName}\n`));
              process.exit(1);
            }
          } catch { /* skip malformed configs */ }
        }
      } catch { /* config dir unreadable */ }
    }

    // List available projects for guidance
    try {
      const configs = readdirSync(configDir).filter(f => f.endsWith('.json') && f !== 'example.json');
      if (configs.length > 0) {
        console.error(chalk.red(`\n✗ Project "${project}" not found.\n`));
        console.error(chalk.white('  Available projects:'));
        for (const f of configs) {
          console.error(chalk.cyan(`    → seo-intel crawl ${f.replace('.json', '')}`));
        }
        console.error(chalk.dim(`\n  Or create a new project: seo-intel setup\n`));
      } else {
        console.error(chalk.red(`\n✗ No projects configured yet.\n`));
        console.error(chalk.white(`  Get started: `) + chalk.bold.cyan(`seo-intel setup\n`));
      }
    } catch {
      console.error(chalk.red(`\n✗ Config not found: ${path}`));
      console.error(chalk.dim(`  Run: seo-intel setup\n`));
    }
    process.exit(1);
  }
}

async function callGemini(prompt) {
  return callAnalysisModel(prompt, 'gemini');
}

function getOpenClawToken() {
  const envToken = process.env.OPENCLAW_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const configPath = join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
    const raw = readFileSync(configPath, 'utf8');
    const matches = [...raw.matchAll(/"token":\s*"([a-f0-9]{40,})"/g)];
    if (matches.length > 0) return matches[matches.length - 1][1];
  } catch {}

  return null;
}

async function callOpenClaw(prompt, model = 'default') {
  const token = getOpenClawToken();
  if (!token) throw new Error('OpenClaw token not found');

  const timeoutMs = parseInt(process.env.OPENCLAW_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || '120000', 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model === 'openclaw' ? 'default' : model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 4000,
      }),
    });

    if (!res.ok) throw new Error(`OpenClaw API error: ${res.status} ${await res.text()}`);

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnalysisModel(prompt, model = 'gemini') {
  const requestedModel = String(model || 'gemini').trim();
  const normalizedModel = requestedModel.toLowerCase();

  if (normalizedModel !== 'gemini') {
    try {
      return await callOpenClaw(prompt, requestedModel);
    } catch (err) {
      console.error('[openclaw]', err.message);
      return null;
    }
  }

  const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '120000', 10);
  try {
    const result = spawnSync('gemini', ['-p', '-'], {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `gemini exited with status ${result.status}`);
    }

    return result.stdout;
  } catch (err) {
    const fallbackModel = process.env.OPENCLAW_ANALYSIS_MODEL || 'default';
    try {
      console.warn(`[gemini] ${err.message}`);
      console.log(chalk.yellow(`Gemini CLI unavailable, retrying via OpenClaw (${fallbackModel})...\n`));
      return await callOpenClaw(prompt, fallbackModel);
    } catch (fallbackErr) {
      // Produce clear, actionable error messages
      const geminiMsg = err.message || '';
      const ocMsg = fallbackErr.message || '';

      const isTimeout = geminiMsg.includes('ETIMEDOUT') || geminiMsg.includes('timeout') || err.name === 'AbortError';
      const isGatewayDown = ocMsg.includes('ECONNREFUSED') || ocMsg.includes('token not found') || ocMsg.includes('gateway');

      console.error(chalk.red('\n  ✗ Analysis failed — no model available\n'));

      if (isTimeout) {
        console.error(chalk.yellow('  Gemini timed out.') + chalk.dim(' Try: GEMINI_TIMEOUT_MS=180000 seo-intel analyze ' + (process.env._SEO_INTEL_PROJECT || '<project>')));
      } else {
        console.error(chalk.dim(`  Gemini: ${geminiMsg}`));
      }

      if (isGatewayDown) {
        console.error(chalk.yellow('  OpenClaw gateway is not running.'));
        console.error(chalk.dim('  Start it:   ') + chalk.cyan('openclaw gateway'));
        console.error(chalk.dim('  Or set key: ') + chalk.cyan('echo "GEMINI_API_KEY=your-key" >> .env'));
      } else {
        console.error(chalk.dim(`  OpenClaw: ${ocMsg}`));
      }

      console.error(chalk.dim('\n  Docs: https://ukkometa.fi/en/seo-intel/setup/\n'));
      return null;
    }
  }
}

function printAnalysisSummary(a, project) {
  console.log(chalk.bold.cyan(`\n📊 SEO Analysis — ${project.toUpperCase()}\n`));

  if (a.positioning) {
    console.log(chalk.bold('🎯 Positioning'));
    console.log(`  Open angle: ${a.positioning.open_angle}`);
    console.log(`  Your differentiator: ${a.positioning.target_differentiator}\n`);
  }

  if (a.keyword_gaps?.length) {
    console.log(chalk.bold(`🔑 Top Keyword Gaps (${a.keyword_gaps.length} total)`));
    a.keyword_gaps.filter(k => k.priority === 'high').slice(0, 10).forEach(k => {
      console.log(`  ${chalk.green('+')} [${k.difficulty}] ${k.keyword} (${k.intent})`);
    });
    console.log();
  }

  if (a.long_tails?.length) {
    console.log(chalk.bold(`🔭 Long-tail Opportunities (${a.long_tails.length} total)`));
    a.long_tails.filter(l => l.priority === 'high').slice(0, 10).forEach(l => {
      console.log(`  ${chalk.blue('→')} "${l.phrase}" [${l.page_type}]`);
    });
    console.log();
  }

  if (a.quick_wins?.length) {
    console.log(chalk.bold(`⚡ Quick Wins (${a.quick_wins.length} total)`));
    a.quick_wins.filter(w => w.impact === 'high').slice(0, 5).forEach(w => {
      console.log(`  ${chalk.yellow('!')} ${w.page} → ${w.fix}`);
    });
    console.log();
  }

  if (a.new_pages?.length) {
    console.log(chalk.bold(`📄 New Pages to Create (${a.new_pages.length} total)`));
    a.new_pages.filter(p => p.priority === 'high').slice(0, 5).forEach(p => {
      console.log(`  ${chalk.magenta('*')} /${p.slug} — "${p.title}"`);
    });
    console.log();
  }
}

// ── RUN (cron-friendly) ────────────────────────────────────────────────────
program
  .command('run')
  .description('Smart cron run: crawl next stale domain, analyze if needed, exit when done')
  .action(async () => {
    if (!requirePro('run')) return;
    const db = getDb();
    const next = getNextCrawlTarget(db);

    if (!next) {
      console.log(chalk.green('✅ All domains fresh. Nothing to crawl.'));
      console.log('DONE');
      process.exit(0);
    }

    console.log(chalk.bold.cyan(`\n🔍 Cron run: crawling ${next.domain} [${next.role}] (project: ${next.project})\n`));
    applyExtractionRuntimeConfig(loadConfig(next.project));

    const runStart = Date.now();

    // Upsert domain
    upsertDomain(db, { domain: next.domain, project: next.project, role: next.role });
    const domainRow = db.prepare('SELECT id FROM domains WHERE domain = ? AND project = ?')
      .get(next.domain, next.project);
    const domainId = domainRow.id;

    let pageCount = 0;
    let skipped = 0;
    let blocked = false;
    for await (const page of crawlDomain(next.url)) {
      // ── Handle blocked pages from backoff system ──
      if (page._blocked) {
        blocked = true;
        console.log(chalk.bold.red(`  ⛔ BLOCKED: ${page._blockReason} — stopping ${next.domain}`));
        break;
      }

      const pageRes = upsertPage(db, {
        domainId,
        url: page.url,
        statusCode: page.status,
        wordCount: page.wordCount,
        loadMs: page.loadMs,
        isIndexable: page.isIndexable,
        clickDepth: page.depth ?? 0,
        publishedDate: page.publishedDate || null,
        modifiedDate: page.modifiedDate || null,
        contentHash: page.contentHash || null,
        title: page.title || null,
        metaDesc: page.metaDesc || null,
        bodyText: page.fullBodyText || page.bodyText || null,
      });
      const pageId = pageRes?.id;

      if (!pageId) continue;

      // ── Incremental: skip extraction if content unchanged ──
      if (page.contentHash) {
        const oldHash = getPageHash(db, page.url);
        if (oldHash && oldHash === page.contentHash) {
          skipped++;
          process.stdout.write(chalk.gray(`  [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} `) + chalk.blue('≡ unchanged\n'));
          pageCount++;
          continue;
        }
      }

      upsertTechnical(db, { pageId, hasCanonical: page.hasCanonical, hasOgTags: page.hasOgTags, hasSchema: page.hasSchema, hasRobots: page.hasRobots });
      process.stdout.write(chalk.gray(`  [${pageCount + 1}] d${page.depth ?? 0} ${page.url.slice(0, 65)} → extracting...`));
      writeProgress({
        status: 'running', command: 'run', project: next.project,
        domain: next.domain, current_url: page.url,
        page_index: pageCount + 1,
        started_at: runStart,
      });
      try {
        const extractFn = await getExtractPage();
        const extraction = await extractFn(page);
        insertExtraction(db, { pageId, data: extraction });
        insertKeywords(db, pageId, extraction.keywords);
        insertHeadings(db, pageId, page.headings);
        insertLinks(db, pageId, page.links);
        if (page.parsedSchemas?.length) insertPageSchemas(db, pageId, page.parsedSchemas);
        process.stdout.write(chalk.green(` ✓${page.parsedSchemas?.length ? ` [${page.parsedSchemas.length} schema]` : ''}\n`));
      } catch (err) {
        process.stdout.write(chalk.red(` ✗ ${err.message}\n`));
      }
      pageCount++;
    }

    writeProgress({ status: 'completed', command: 'run', project: next.project, domain: next.domain, extracted: pageCount, skipped, started_at: runStart, finished_at: Date.now() });
    const parts = [`${pageCount} pages from ${next.domain}`];
    if (skipped > 0) parts.push(chalk.blue(`${skipped} unchanged`));
    if (blocked) parts.push(chalk.red(`blocked`));
    console.log(chalk.green(`\n✅ Crawled ${parts.join(' · ')}`));
    if (skipped > 0) console.log(chalk.blue(`  📊 Incremental: ${skipped} pages skipped (same content hash)`));

    // Check if analysis needed for this project
    if (needsAnalysis(db, next.project)) {
      console.log(chalk.yellow(`\n🧠 New crawl data detected — running analysis for ${next.project}...`));
      await runAnalysis(next.project, db);
    }

    // Check if more stale domains remain
    const remaining = getNextCrawlTarget(db);
    if (remaining) {
      console.log(chalk.yellow(`\n⏳ More stale domains: ${remaining.domain} (${remaining.project}). Next cron run will handle it.`));
    } else {
      console.log(chalk.bold.green('\n🎉 All domains are now fresh!'));
    }

    process.exit(0);
  });

// ── STATUS ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show crawl freshness + extraction coverage for all domains')
  .action(async () => {
    printLicenseStatus();
    const db = getDb();

    // 1. Check live progress file (with PID liveness detection)
    const progress = readProgress();
    if (progress && progress.status === 'running') {
      const elapsed = Math.round((Date.now() - progress.started_at) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      console.log(chalk.bold.yellow(`\n⚡ EXTRACTION RUNNING  (pid ${progress.pid})`));
      console.log(chalk.gray(`   Command:  `) + chalk.white(progress.command));
      console.log(chalk.gray(`   Project:  `) + chalk.white(progress.project));
      if (progress.domain) console.log(chalk.gray(`   Domain:   `) + chalk.white(progress.domain));
      if (progress.current_url) console.log(chalk.gray(`   Current:  `) + chalk.white(progress.current_url.slice(0, 70)));
      if (progress.total) {
        const pct = progress.percent || Math.round((progress.page_index / progress.total) * 100);
        const etaSecs = pct > 0 ? Math.round(elapsed * (100 - pct) / pct) : 0;
        console.log(chalk.gray(`   Progress: `) + chalk.cyan(`${progress.page_index}/${progress.total}`) + chalk.gray(` (${pct}%)`));
        if (etaSecs > 0) console.log(chalk.gray(`   ETA:      `) + chalk.white(`~${Math.floor(etaSecs / 60)}m ${etaSecs % 60}s`));
      } else {
        console.log(chalk.gray(`   Page #:   `) + chalk.cyan(progress.page_index));
      }
      console.log(chalk.gray(`   Elapsed:  `) + chalk.white(`${mins}m ${secs}s`));
      if (progress.failed > 0) console.log(chalk.gray(`   Failed:   `) + chalk.red(progress.failed));
    } else if (progress && progress.status === 'crashed') {
      const ago = Math.round((Date.now() - (progress.crashed_at || progress.updated_at)) / 1000);
      console.log(chalk.bold.red(`\n💀 EXTRACTION CRASHED  (pid ${progress.pid} is dead)`));
      console.log(chalk.gray(`   Command:  `) + chalk.white(progress.command));
      console.log(chalk.gray(`   Project:  `) + chalk.white(progress.project));
      if (progress.domain) console.log(chalk.gray(`   Domain:   `) + chalk.white(progress.domain));
      if (progress.current_url) console.log(chalk.gray(`   Last URL: `) + chalk.white(progress.current_url.slice(0, 70)));
      console.log(chalk.gray(`   Died:     `) + chalk.white(`${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'} ago`));
      console.log(chalk.yellow(`   → Re-run: node cli.js extract ${progress.project}`));
    } else if (progress && progress.status === 'completed') {
      const ago = Math.round((Date.now() - progress.finished_at) / 1000);
      const duration = Math.round((progress.finished_at - progress.started_at) / 1000);
      console.log(chalk.bold.green(`\n✅ Last extraction completed`));
      console.log(chalk.gray(`   Command:   `) + chalk.white(progress.command));
      console.log(chalk.gray(`   Project:   `) + chalk.white(progress.project));
      console.log(chalk.gray(`   Extracted: `) + chalk.cyan(progress.extracted || 0));
      if (progress.failed > 0) console.log(chalk.gray(`   Failed:    `) + chalk.red(progress.failed));
      console.log(chalk.gray(`   Duration:  `) + chalk.white(`${Math.floor(duration / 60)}m ${duration % 60}s`));
      console.log(chalk.gray(`   Finished:  `) + chalk.white(`${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'} ago`));
    } else {
      console.log(chalk.gray('\n○ No extraction running'));
    }

    // 2. Crawl freshness
    const rows = getCrawlStatus(db);
    if (!rows.length) {
      console.log(chalk.yellow('\nNo domains configured. Check config/ directory.'));
      return;
    }

    console.log(chalk.bold.cyan('\n📊 SEO Intel — Domain Status\n'));
    console.log('Project      Domain                         Role        Last Crawled  Age     Extraction');
    console.log('─'.repeat(100));

    // 3. Extraction coverage
    const coverage = db.prepare(`
      SELECT d.domain, d.project,
             COUNT(p.id) as total_pages,
             COUNT(e.id) as extracted_pages
      FROM domains d
      LEFT JOIN pages p ON p.domain_id = d.id
      LEFT JOIN extractions e ON e.page_id = p.id
      GROUP BY d.id
    `).all();
    const covMap = {};
    for (const c of coverage) covMap[c.domain] = c;

    for (const r of rows) {
      const daysStr = r.daysAgo === '—' ? '—      ' : `${r.daysAgo}d ago `;
      const cov = covMap[r.domain] || { total_pages: 0, extracted_pages: 0 };
      const pct = cov.total_pages > 0 ? Math.round((cov.extracted_pages / cov.total_pages) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
      const pctColor = pct === 100 ? chalk.green : pct > 50 ? chalk.yellow : chalk.red;
      console.log(
        `${(r.project || '').padEnd(12)} ${(r.domain || '').padEnd(30)} ${(r.role || '—').padEnd(11)} ${(r.lastCrawled || '—').padEnd(13)} ${daysStr.padEnd(7)} ${bar} ${pctColor(pct + '%')}`
      );
    }
    console.log();

    // Show update notice at end of status output
    await printUpdateNotice();
  });

// ── UPDATE COMMAND ────────────────────────────────────────────────────────
program
  .command('update')
  .description('Check for updates and show upgrade instructions')
  .option('--apply', 'Auto-apply the update via npm')
  .action(async (opts) => {
    console.log(chalk.dim('\n  Checking for updates...\n'));

    const info = await forceUpdateCheck();

    console.log(chalk.bold.cyan('  SEO Intel — Update Check\n'));
    console.log(chalk.gray('  Current version:  ') + chalk.white(info.current));

    if (info.npmVersion) {
      console.log(chalk.gray('  npm registry:     ') + chalk.white(info.npmVersion));
    }
    if (info.ukkometaVersion) {
      console.log(chalk.gray('  ukkometa.fi:      ') + chalk.white(info.ukkometaVersion));
    }

    if (!info.hasUpdate) {
      console.log(chalk.green('\n  ✓ You\'re on the latest version.\n'));
      return;
    }

    console.log(chalk.yellow(`\n  ⬆ Update available: ${info.current} → ${info.latest}`));

    if (info.changelog) {
      console.log(chalk.gray('\n  What\'s new:'));
      for (const line of info.changelog.split('\n').slice(0, 5)) {
        console.log(chalk.gray('    ') + chalk.white(line));
      }
    }

    if (opts.apply) {
      console.log(chalk.dim('\n  Applying update...\n'));
      const { spawnSync } = await import('child_process');
      const result = spawnSync('npm', ['install', '-g', 'seo-intel@latest'], {
        stdio: 'inherit',
        shell: true,
      });
      if (result.status === 0) {
        console.log(chalk.green('\n  ✓ Updated successfully! Restart any running seo-intel processes.\n'));
      } else {
        console.log(chalk.red('\n  ✗ Update failed. Try manually:'));
        console.log(chalk.cyan('    npm install -g seo-intel@latest\n'));
      }
    } else {
      console.log(chalk.gray('\n  To update:'));
      if (info.source === 'npm' || info.npmVersion) {
        console.log(chalk.cyan('    npm install -g seo-intel@latest'));
        console.log(chalk.dim('    or: seo-intel update --apply'));
      }
      if (info.downloadUrl) {
        console.log(chalk.cyan(`    ${info.downloadUrl}`));
      }
      console.log('');
    }
  });

// ── AUTH (OAuth connections) ──────────────────────────────────────────────
program
  .command('auth [provider]')
  .description('Connect OAuth services (google, etc.) or show connection status')
  .option('--disconnect', 'Disconnect / remove stored tokens')
  .option('--port <port>', 'Callback port for OAuth redirect (default: 9876)')
  .action(async (provider, opts) => {
    const { startOAuthFlow, getAllConnectionStatus, clearTokens, getProviderRequirements } = await import('./lib/oauth.js');

    // No provider → show status
    if (!provider) {
      const statuses = getAllConnectionStatus();
      const requirements = getProviderRequirements();

      console.log(chalk.bold.cyan('\n  🔐 OAuth Connections\n'));

      for (const req of requirements) {
        const status = statuses[req.id];
        if (status.connected) {
          console.log(chalk.green(`  ✓ ${req.name}`) + chalk.dim(` — connected (${status.scopes.length} scopes)`));
        } else if (status.hasCredentials) {
          console.log(chalk.yellow(`  ○ ${req.name}`) + chalk.dim(' — credentials configured, not connected'));
          console.log(chalk.dim(`    → seo-intel auth ${req.id}`));
        } else {
          console.log(chalk.red(`  ✗ ${req.name}`) + chalk.dim(' — not configured'));
          console.log(chalk.dim(`    → Add ${req.envVars.join(' + ')} to .env`));
          if (req.setupUrl) {
            console.log(chalk.dim(`    → Create credentials: ${req.setupUrl}`));
          }
        }
        console.log();
      }

      // Show API key auth alongside OAuth
      console.log(chalk.bold.cyan('  🔑 API Key Auth\n'));
      const env = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
      const keys = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
      for (const key of keys) {
        const line = env.find(l => l.startsWith(key + '='));
        const hasValue = line && line.split('=')[1]?.trim();
        const name = key.replace('_API_KEY', '').replace('_', ' ');
        if (hasValue) {
          console.log(chalk.green(`  ✓ ${name}`) + chalk.dim(` — ${hasValue.slice(0, 8)}...`));
        } else {
          console.log(chalk.dim(`  ○ ${name} — not set`));
        }
      }
      console.log();
      return;
    }

    // Disconnect
    if (opts.disconnect) {
      clearTokens(provider);
      console.log(chalk.green(`\n  ✓ Disconnected from ${provider}. Tokens removed.\n`));
      return;
    }

    // Start OAuth flow
    console.log(chalk.dim(`\n  Starting ${provider} OAuth flow...`));
    console.log(chalk.dim('  A browser window will open for authorization.\n'));

    try {
      const result = await startOAuthFlow(provider, {
        port: opts.port ? parseInt(opts.port) : undefined,
      });
      console.log(chalk.green(`\n  ✓ Connected to ${provider}!`));
      console.log(chalk.dim(`    Scopes: ${result.scopes.join(', ')}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  ✗ OAuth failed: ${err.message}\n`));
      if (err.message.includes('Missing')) {
        console.log(chalk.yellow('  Setup instructions:'));
        console.log(chalk.dim('  1. Go to https://console.cloud.google.com/apis/credentials'));
        console.log(chalk.dim('  2. Create OAuth 2.0 Client ID (type: Desktop app)'));
        console.log(chalk.dim('  3. Add to .env:'));
        console.log(chalk.cyan('     GOOGLE_CLIENT_ID=your-client-id'));
        console.log(chalk.cyan('     GOOGLE_CLIENT_SECRET=your-client-secret\n'));
      }
    }
  });

// ── COMPETITORS MANAGEMENT ────────────────────────────────────────────────
program
  .command('competitors <project>')
  .description('List, add, or remove competitors for a project')
  .option('--add <domain>', 'Add a competitor domain')
  .option('--remove <domain>', 'Remove a competitor domain')
  .option('--add-owned <domain>', 'Add an owned subdomain')
  .option('--remove-owned <domain>', 'Remove an owned subdomain')
  .option('--set-target <domain>', 'Change the target domain')
  .option('--prune', 'Remove DB data for domains no longer in config')
  .action((project, opts) => {
    const configPath = join(__dirname, `config/${project}.json`);
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      console.error(chalk.red(`Config not found: config/${project}.json`));
      console.log(chalk.dim('  Run: seo-intel setup'));
      process.exit(1);
    }

    const { domainFromUrl } = (() => {
      // inline domain helper
      function domainFromUrl(url) {
        try { return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, ''); }
        catch { return url; }
      }
      return { domainFromUrl };
    })();

    let modified = false;

    // ── Add competitor
    if (opts.add) {
      const domain = domainFromUrl(opts.add);
      const url = opts.add.startsWith('http') ? opts.add : defaultSiteUrl(opts.add);
      if (config.competitors.some(c => c.domain === domain)) {
        console.log(chalk.yellow(`  ⚠ ${domain} is already a competitor`));
      } else {
        config.competitors.push({ url, domain, role: 'competitor' });
        console.log(chalk.green(`  ✓ Added competitor: ${domain}`));
        modified = true;
      }
    }

    // ── Remove competitor
    if (opts.remove) {
      const domain = domainFromUrl(opts.remove);
      const before = config.competitors.length;
      config.competitors = config.competitors.filter(c => c.domain !== domain);
      if (config.competitors.length < before) {
        console.log(chalk.green(`  ✓ Removed competitor: ${domain}`));
        modified = true;
      } else {
        console.log(chalk.yellow(`  ⚠ ${domain} not found in competitors`));
      }
    }

    // ── Add owned subdomain
    if (opts.addOwned) {
      if (!config.owned) config.owned = [];
      const domain = domainFromUrl(opts.addOwned);
      const url = opts.addOwned.startsWith('http') ? opts.addOwned : defaultSiteUrl(opts.addOwned);
      if (config.owned.some(o => o.domain === domain)) {
        console.log(chalk.yellow(`  ⚠ ${domain} is already an owned domain`));
      } else {
        config.owned.push({ url, domain, role: 'owned' });
        console.log(chalk.green(`  ✓ Added owned domain: ${domain}`));
        modified = true;
      }
    }

    // ── Remove owned subdomain
    if (opts.removeOwned) {
      if (!config.owned) config.owned = [];
      const domain = domainFromUrl(opts.removeOwned);
      const before = config.owned.length;
      config.owned = config.owned.filter(o => o.domain !== domain);
      if (config.owned.length < before) {
        console.log(chalk.green(`  ✓ Removed owned domain: ${domain}`));
        modified = true;
      } else {
        console.log(chalk.yellow(`  ⚠ ${domain} not found in owned domains`));
      }
    }

    // ── Change target
    if (opts.setTarget) {
      const domain = domainFromUrl(opts.setTarget);
      const url = opts.setTarget.startsWith('http') ? opts.setTarget : defaultSiteUrl(opts.setTarget);
      config.target = { url, domain, role: 'target' };
      config.context.url = url;
      console.log(chalk.green(`  ✓ Target changed to: ${domain}`));
      modified = true;
    }

    // Save if modified
    if (modified) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      console.log(chalk.dim(`\n  Saved → config/${project}.json`));
    }

    // ── Prune stale DB data (auto on remove, or manual --prune) ─────────
    if (modified || opts.prune) {
      const db = getDb();
      const configDomains = new Set([
        config.target?.domain,
        ...(config.owned || []).map(o => o.domain),
        ...(config.competitors || []).map(c => c.domain),
      ].filter(Boolean));

      const pruned = pruneStaleDomains(db, project, configDomains);
      if (pruned.length) {
        console.log(chalk.yellow(`\n  🧹 Pruned ${pruned.length} stale domain(s) from DB:`));
        for (const d of pruned) console.log(chalk.dim(`     − ${d}`));
      } else if (opts.prune) {
        console.log(chalk.dim('\n  ✓ No stale domains to prune'));
      }
    }

    // ── Always show current config
    console.log(chalk.bold.cyan(`\n  📋 ${project} — Domain Configuration\n`));
    console.log(chalk.white('  Target:'));
    console.log(chalk.green(`    ● ${config.target.domain}`));

    if (config.owned?.length) {
      console.log(chalk.white('\n  Owned (subdomains):'));
      for (const o of config.owned) {
        console.log(chalk.blue(`    ○ ${o.domain}`));
      }
    }

    console.log(chalk.white('\n  Competitors:'));
    for (const c of config.competitors) {
      console.log(chalk.red(`    ◆ ${c.domain}`));
    }

    console.log(chalk.dim(`\n  Total: ${config.competitors.length} competitors` +
      (config.owned?.length ? ` + ${config.owned.length} owned` : '') + '\n'));

    // Hint about re-crawl
    if (modified) {
      console.log(chalk.yellow('  → Run a crawl to update data for new domains:'));
      console.log(chalk.cyan(`    node cli.js crawl ${project}\n`));
    }
  });

// ── Shared analysis runner ─────────────────────────────────────────────────
async function runAnalysis(project, db) {
  const configs = loadAllConfigs();
  const config = configs.find(c => c.project === project);
  if (!config) return;

  const summary       = getCompetitorSummary(db, project);
  const keywordMatrix = getKeywordMatrix(db, project);
  const headings      = getHeadingStructure(db, project);

  const target      = summary.find(s => s.role === 'target');
  const competitors = summary.filter(s => s.role === 'competitor');
  if (!target) return;

  target.domain = config.target.domain;
  competitors.forEach((c, i) => { c.domain = config.competitors[i]?.domain || c.domain; });

  const buildPromptFn = await getBuildAnalysisPrompt();
  const prompt = buildPromptFn({
    project, target, competitors, keywordMatrix,
    headingStructure: headings, context: config.context,
  });

  const promptTs2 = Date.now();
  const promptFm2 = `---\nproject: ${project}\ngenerated: ${new Date(promptTs2).toISOString()}\ntype: analysis-prompt\nmodel: gemini\n---\n\n`;
  writeFileSync(join(__dirname, `reports/${project}-prompt-${promptTs2}.md`), promptFm2 + prompt, 'utf8');

  const result = await callGemini(prompt);
  if (!result) { console.error(chalk.red('Gemini returned no response.')); process.exit(1); }

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(jsonMatch[0]);
    const outPath = join(__dirname, `reports/${project}-analysis-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(analysis, null, 2), 'utf8');

    // Save to DB
    const analysisTs2 = Date.now();
    db.prepare(`
      INSERT INTO analyses (project, generated_at, model, keyword_gaps, long_tails, quick_wins, new_pages, content_gaps, positioning, technical_gaps, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project, analysisTs2, 'gemini',
      JSON.stringify(analysis.keyword_gaps || []),
      JSON.stringify(analysis.long_tails || []),
      JSON.stringify(analysis.quick_wins || []),
      JSON.stringify(analysis.new_pages || []),
      JSON.stringify(analysis.content_gaps || []),
      JSON.stringify(analysis.positioning || {}),
      JSON.stringify(analysis.technical_gaps || []),
      result,
    );

    // Upsert individual insights (Intelligence Ledger)
    const analysisRowId2 = db.prepare('SELECT last_insert_rowid() as id').get().id;
    upsertInsightsFromAnalysis(db, project, analysisRowId2, analysis, analysisTs2);

    printAnalysisSummary(analysis, project);
    console.log(chalk.green(`\n✅ Analysis saved: ${outPath}`));
  } catch (err) {
    console.error(chalk.red(`Could not parse analysis JSON: ${err.message}`));
    process.exit(1);
  }
}

// ── EXTRACT ────────────────────────────────────────────────────────────────
program
  .command('extract <project>')
  .description('Run AI extraction on all crawled-but-not-yet-extracted pages (requires Solo/Agency)')
  .action(async (project) => {
    if (!requirePro('extract')) return;
    applyExtractionRuntimeConfig(loadConfig(project));
    const db = getDb();

    // Query pages that have body_text stored (from crawl) but no extraction yet
    const pendingPages = db.prepare(`
      SELECT p.id, p.url, p.word_count, p.title, p.meta_desc, p.body_text,
             p.published_date, p.modified_date
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      LEFT JOIN extractions e ON e.page_id = p.id
      WHERE d.project = ? AND e.id IS NULL
    `).all(project);

    if (!pendingPages.length) {
      console.log(chalk.green(`✅ All pages already extracted for ${project}`));
      process.exit(0);
    }

    // Check how many have body_text stored vs need re-crawl
    const withContent = pendingPages.filter(r => r.body_text);
    const needsRecrawl = pendingPages.length - withContent.length;

    console.log(chalk.bold.cyan(`\n⚙️  Extracting ${pendingPages.length} pages for ${project} via Qwen...\n`));
    if (needsRecrawl > 0) {
      console.log(chalk.yellow(`  ⚠  ${needsRecrawl} pages have no stored content (crawled before v1.1.6). Re-crawl to populate.\n`));
    }

    const extractStart = Date.now();
    let done = 0, failed = 0, skipped = 0;

    // ── Pre-extract template grouping: sample N per group, skip the rest ──
    const SAMPLE_PER_GROUP = 5;
    const MIN_GROUP_FOR_SAMPLING = 10;
    let extractQueue = pendingPages.filter(r => r.body_text); // only pages with stored content

    try {
      const { clusterUrls } = await import('./analyses/templates/cluster.js');
      const { groups } = clusterUrls(
        extractQueue.map(r => ({ url: r.url })),
        { minGroupSize: MIN_GROUP_FOR_SAMPLING }
      );

      if (groups.length > 0) {
        const skipUrls = new Set();

        for (const group of groups) {
          const urls = group.urls;
          if (urls.length <= SAMPLE_PER_GROUP) continue;

          const sampleSet = new Set();
          sampleSet.add(urls[0]); sampleSet.add(urls[1]);
          sampleSet.add(urls[urls.length - 1]); sampleSet.add(urls[urls.length - 2]);
          sampleSet.add(urls[Math.floor(urls.length / 2)]);

          const skippedCount = urls.length - sampleSet.size;
          for (const u of urls) {
            if (!sampleSet.has(u)) skipUrls.add(u);
          }
          console.log(chalk.yellow(`  [template] ${group.pattern} → ${urls.length} pages, sampling ${sampleSet.size}, skipping ${skippedCount}`));
        }

        if (skipUrls.size > 0) {
          extractQueue = extractQueue.filter(r => !skipUrls.has(r.url));
          skipped += skipUrls.size;
          console.log(chalk.yellow(`  [template] ${withContent.length} extractable → ${extractQueue.length} to extract (${skipUrls.size} template-skipped)\n`));
        }
      }
    } catch (e) {
      console.log(chalk.gray(`  [template] Pattern detection skipped: ${e.message}`));
    }

    // ── Consecutive failure tracking per URL pattern ──
    const CONSEC_FAIL_THRESHOLD = 3;
    const patternFailCounts = new Map();
    const skippedPatterns = new Set();

    function getPatternKey(url) {
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        return u.hostname + '/' + parts.map(p =>
          (p.length > 20 || /^[0-9a-fA-F]{8,}$/.test(p) || /^0x/.test(p) || /[-_]/.test(p)) ? '{var}' : p
        ).join('/');
      } catch { return url; }
    }

    // ── Content similarity detection ──
    const SIMILARITY_THRESHOLD = 0.80;
    const SIMILARITY_SAMPLE_SIZE = 3;
    const patternFingerprints = new Map();

    function textToShingles(text, n = 3) {
      const words = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
      const shingles = new Set();
      for (let i = 0; i <= words.length - n; i++) {
        shingles.add(words.slice(i, i + n).join(' '));
      }
      return shingles;
    }

    function jaccardSimilarity(a, b) {
      if (!a.size || !b.size) return 0;
      let intersection = 0;
      for (const s of a) { if (b.has(s)) intersection++; }
      return intersection / (a.size + b.size - intersection);
    }

    function checkPatternSimilarity(patKey, newShingles) {
      if (!patternFingerprints.has(patKey)) patternFingerprints.set(patKey, []);
      const fps = patternFingerprints.get(patKey);
      fps.push(newShingles);
      if (fps.length < SIMILARITY_SAMPLE_SIZE || fps.length > SIMILARITY_SAMPLE_SIZE) return false;
      for (let i = 0; i < fps.length; i++) {
        for (let j = i + 1; j < fps.length; j++) {
          if (jaccardSimilarity(fps[i], fps[j]) < SIMILARITY_THRESHOLD) return false;
        }
      }
      return true;
    }

    // ── Prepare headings + schema queries (per-page lookups from DB) ──
    const getHeadings = db.prepare('SELECT level, text FROM headings WHERE page_id = ? ORDER BY id');
    const getSchemaTypes = db.prepare('SELECT DISTINCT schema_type FROM page_schemas WHERE page_id = ?');

    const totalToProcess = extractQueue.length;
    console.log(chalk.gray(`  📖 Reading from DB — no network needed\n`));

    for (const row of extractQueue) {
      const patKey = getPatternKey(row.url);
      if (skippedPatterns.has(patKey)) {
        skipped++;
        continue;
      }

      const pos = done + failed + 1;
      process.stdout.write(chalk.gray(`  [${pos}/${totalToProcess}] ${row.url.slice(0, 70)} → `));
      process.stdout.write(chalk.gray('extracting...'));

      writeProgress({
        status: 'running', command: 'extract', project,
        current_url: row.url,
        page_index: pos, total: totalToProcess,
        percent: Math.round(((done + failed) / totalToProcess) * 100),
        started_at: extractStart, failed, skipped,
      });

      let pageFailed = false;

      try {
        // Read headings + schema types from DB
        const headings = getHeadings.all(row.id);
        const schemaTypes = getSchemaTypes.all(row.id).map(r => r.schema_type);

        const extractFn = await getExtractPage();
        const extraction = await extractFn({
          url: row.url,
          title: row.title || '',
          metaDesc: row.meta_desc || '',
          headings,
          bodyText: row.body_text,
          schemaTypes,
          publishedDate: row.published_date,
          modifiedDate: row.modified_date,
        });
        insertExtraction(db, { pageId: row.id, data: extraction });
        insertKeywords(db, row.id, extraction.keywords);

        const isDegraded = extraction.extraction_source === 'degraded';
        if (isDegraded) {
          process.stdout.write(chalk.yellow(` ⚠ degraded\n`));
          done++;
          pageFailed = true;
        } else {
          process.stdout.write(chalk.green(` ✓\n`));
          done++;
          patternFailCounts.set(patKey, 0);
        }

        // ── Content similarity detection ──
        if (row.body_text.length > 50) {
          const shingles = textToShingles(row.body_text);
          if (checkPatternSimilarity(patKey, shingles) && !skippedPatterns.has(patKey)) {
            const remaining = extractQueue.filter(r => getPatternKey(r.url) === patKey).length - (patternFingerprints.get(patKey)?.length || 0);
            skippedPatterns.add(patKey);
            if (remaining > 0) {
              console.log(chalk.yellow(`  [similarity] 🔍 ${SIMILARITY_SAMPLE_SIZE} pages from ${patKey} are ${Math.round(SIMILARITY_THRESHOLD * 100)}%+ identical — skipping ${remaining} remaining`));
            }
          }
        }
      } catch (err) {
        process.stdout.write(chalk.red(` ✗ ${err.message}\n`));
        failed++;
        pageFailed = true;
      }

      // ── Track consecutive failures per pattern ──
      if (pageFailed) {
        const count = (patternFailCounts.get(patKey) || 0) + 1;
        patternFailCounts.set(patKey, count);
        if (count >= CONSEC_FAIL_THRESHOLD) {
          const remaining = extractQueue.filter(r => !skippedPatterns.has(getPatternKey(r.url)) && getPatternKey(r.url) === patKey).length;
          skippedPatterns.add(patKey);
          console.log(chalk.yellow(`  [template] ⚡ ${count} consecutive failures for ${patKey} — skipping ~${remaining} remaining pages`));
        }
      }
    }

    writeProgress({ status: 'completed', command: 'extract', project, extracted: done, failed, skipped, total: pendingPages.length, started_at: extractStart, finished_at: Date.now() });
    const skipMsg = skipped > 0 ? chalk.yellow(`, ${skipped} template-skipped`) : '';
    const recrawlMsg = needsRecrawl > 0 ? chalk.yellow(`, ${needsRecrawl} need re-crawl`) : '';
    console.log(chalk.bold.green(`\n✅ Extraction complete: ${done} extracted, ${failed} failed${skipMsg}${recrawlMsg}\n`));
  });

// ── TEMPLATES ANALYSIS ────────────────────────────────────────────────────
program
  .command('templates <project>')
  .description('Detect programmatic template pages — assess SEO value without crawling all of them')
  .option('--min-group <n>', 'Minimum URLs to qualify as a template group', '10')
  .option('--sample-size <n>', 'Pages to stealth-crawl per template group', '20')
  .option('--skip-crawl', 'Skip sample crawl (pattern analysis + GSC only)')
  .option('--skip-gsc', 'Skip GSC overlay phase')
  .option('--skip-competitors', 'Skip competitor sitemap census')
  .action(async (project, opts) => {
    if (!requirePro('templates')) return;

    console.log(chalk.bold.cyan(`\n🔍 SEO Intel — Template Analysis`));
    console.log(chalk.dim(`  Project: ${project}`));

    try {
      const { runTemplatesAnalysis } = await import('./analyses/templates/index.js');
      const report = await runTemplatesAnalysis(project, {
        minGroupSize: parseInt(opts.minGroup) || 10,
        sampleSize: parseInt(opts.sampleSize) || 20,
        skipCrawl: !!opts.skipCrawl,
        skipGsc: !!opts.skipGsc,
        skipCompetitors: !!opts.skipCompetitors,
        log: (msg) => console.log(chalk.gray(msg)),
      });

      if (report.groups.length === 0) {
        console.log(chalk.yellow(`\n  No template patterns detected.\n`));
        process.exit(0);
      }

      // Summary
      console.log(chalk.bold.green(`\n✅ Template analysis complete`));
      console.log(chalk.dim(`  ${report.stats.totalGroups} groups · ${report.stats.totalGrouped.toLocaleString()} URLs · ${(report.stats.coverage * 100).toFixed(0)}% of sitemap`));
      console.log(chalk.dim(`  Run ${chalk.white('seo-intel html ' + project)} to see the full dashboard.\n`));
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

// ── HTML DASHBOARD ─────────────────────────────────────────────────────────
program
  .command('html [project]')
  .description('Generate HTML dashboard (all projects with switcher)')
  .option('--open', 'Open dashboard in browser after generation', true)
  .option('--no-open', 'Do not open browser')
  .action(async (project, opts) => {
    // Always generate the unified all-projects dashboard.
    // project arg is accepted for backwards compatibility but ignored.
    const db = getDb();
    const configs = loadAllConfigs();

    if (!configs.length) {
      console.log(chalk.red('No project configs found in config/ directory.'));
      process.exit(1);
    }

    const tierLabel = isPro() ? '' : chalk.dim(' (crawl-only — upgrade to Solo for full dashboard)');
    console.log(chalk.bold.cyan(`\n📊 Generating dashboard...`) + tierLabel + '\n');
    configs.forEach(c => console.log(chalk.gray(`  • ${c.project} (${c.target.domain})`)));
    console.log();

    const outPath = generateMultiDashboard(db, configs);

    console.log(chalk.bold.green(`✅ Dashboard generated: ${outPath}\n`));
    console.log(chalk.dim(`   file://${outPath}\n`));

    if (opts.open) {
      const { exec } = await import('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${outPath}"`);
    }
  });

// ── SITE GRAPH ────────────────────────────────────────────────────────────────
program
  .command('graph <project>')
  .description('Generate Obsidian-style site graph visualization')
  .option('-d, --depth <n>', 'Max click depth to include (default: all)', '99')
  .option('--open', 'Open in browser after generation')
  .action(async (project, opts) => {
    const db = getDb();
    const config = loadConfig(project);
    if (!config) {
      console.log(chalk.red(`No config found for project: ${project}`));
      return;
    }

    console.log(chalk.bold.cyan(`\n🕸️  Generating site graph for ${project}...\n`));

    const { generateSiteGraphHtml } = await import('./reports/generate-site-graph.js');
    const outPath = await generateSiteGraphHtml(db, project, {
      maxDepth: parseInt(opts.depth) || 99,
    });

    console.log(chalk.bold.green(`✅ Site graph generated: ${outPath}`));
    console.log(chalk.dim(`   Open in browser to explore.\n`));

    if (opts.open) {
      const { exec } = await import('child_process');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} "${outPath}"`);
    }
  });

// ── HTML ALL-PROJECTS DASHBOARD (alias for html — kept for backwards compat) ──
program
  .command('html-all')
  .description('Alias for "html" — generates the all-projects dashboard')
  .action(() => {
    const db = getDb();
    const configs = loadAllConfigs();

    if (!configs.length) {
      console.log(chalk.red('No project configs found in config/ directory.'));
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n📊 Generating multi-project dashboard...\n`));
    configs.forEach(c => console.log(chalk.gray(`  • ${c.project} (${c.target.domain})`)));
    console.log();

    const outPath = generateMultiDashboard(db, configs);

    console.log(chalk.bold.green(`✅ All-projects dashboard generated: ${outPath}\n`));
  });

// ── SERVE DASHBOARD ──────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start dashboard web server with live crawl/extract controls')
  .option('--port <n>', 'Server port', '3000')
  .option('--open', 'Open browser automatically', true)
  .option('--no-open', 'Do not open browser')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    process.env.PORT = String(port);
    if (opts.open) process.env.SEO_INTEL_AUTO_OPEN = '1';
    await import('./server.js');
  });

// ── SETUP WEB WIZARD ──────────────────────────────────────────────────────
program
  .command('setup-web')
  .description('Open the web-based setup wizard in your browser')
  .option('--port <n>', 'Server port', '3000')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    process.env.PORT = String(port);
    await import('./server.js');

    // Open browser to setup page
    const url = `http://localhost:${port}/setup`;
    const { execSync } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    try {
      execSync(`${cmd} ${url}`, { stdio: 'ignore' });
      console.log(`  Opening ${url} in your browser...`);
    } catch {
      console.log(`  Open ${url} in your browser to start the setup wizard.`);
    }
  });

// ── ATTACK COMMANDS ────────────────────────────────────────────────────────

// Shared helper: filter out app routes, login pages, query-string URLs
function isContentPage(url) {
  if (url.includes('?')) return false;
  const appPaths = ['/signup', '/login', '/register', '/onboarding', '/dashboard',
    '/app/', '/swap', '/portfolio', '/send', '/rewards', '/perps', '/vaults'];
  const appSubdomains = ['dashboard.', 'app.', 'customers.', 'console.'];
  if (appPaths.some(p => url.includes(p))) return false;
  if (appSubdomains.some(s => url.includes(s))) return false;
  return true;
}

function printAttackHeader(title, project) {
  console.log(chalk.bold.cyan(`\n${'═'.repeat(60)}`));
  console.log(chalk.bold.cyan(`  ${title} — ${project.toUpperCase()}`));
  console.log(chalk.bold.cyan(`${'═'.repeat(60)}\n`));
}

// ── SHALLOW CHAMPION ───────────────────────────────────────────────────────
program
  .command('shallow <project>')
  .description('Find competitor pages that are important but thin (Shallow Champion attack)')
  .option('--max-words <n>', 'Max word count threshold', '700')
  .option('--max-depth <n>', 'Max click depth', '2')
  .action((project, opts) => {
    if (!requirePro('shallow')) return;
    const db = getDb();
    const maxWords = parseInt(opts.maxWords);
    const maxDepth = parseInt(opts.maxDepth);

    printAttackHeader('⚡ Shallow Champion Attack', project);

    const rows = db.prepare(`
      SELECT p.url, p.click_depth, p.word_count, d.domain
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND p.click_depth <= ? AND p.word_count <= ? AND p.word_count > 80
        AND p.is_indexable = 1
      ORDER BY p.click_depth ASC, p.word_count ASC
    `).all(project, maxDepth, maxWords).filter(r => isContentPage(r.url));

    if (!rows.length) {
      console.log(chalk.yellow('No shallow champions found with current thresholds.'));
      return;
    }

    console.log(chalk.gray(`Found ${rows.length} shallow champion targets (depth ≤${maxDepth}, words ≤${maxWords}):\n`));

    const byDomain = {};
    for (const r of rows) {
      if (!byDomain[r.domain]) byDomain[r.domain] = [];
      byDomain[r.domain].push(r);
    }

    for (const [domain, pages] of Object.entries(byDomain)) {
      console.log(chalk.bold.yellow(`  ${domain}`));
      for (const p of pages) {
        const depthBar = '→'.repeat(p.click_depth + 1);
        const wordColor = p.word_count < 300 ? chalk.red : chalk.yellow;
        console.log(`    ${chalk.gray(depthBar)} ${p.url.replace(/https?:\/\/[^/]+/, '')  || '/'}`);
        console.log(`       ${wordColor(`${p.word_count} words`)} · depth ${p.click_depth}`);
      }
      console.log();
    }

    console.log(chalk.bold.green('💡 Action: Write 1500+ word versions of these pages with proper schema + FAQs.'));
    console.log(chalk.gray('   These competitors already validated the topic. Out-invest them.\n'));
  });

// ── CONTENT DECAY ─────────────────────────────────────────────────────────
program
  .command('decay <project>')
  .description('Find competitor pages decaying due to staleness (Content Decay Arbitrage)')
  .option('--months <n>', 'Months since last update to flag as stale', '18')
  .action((project, opts) => {
    if (!requirePro('decay')) return;
    const db = getDb();
    const monthsAgo = parseInt(opts.months);
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsAgo);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    printAttackHeader('📉 Content Decay Arbitrage', project);

    // Pages with known stale modified_date
    const staleKnown = db.prepare(`
      SELECT p.url, p.click_depth, p.word_count, p.modified_date, p.published_date, d.domain
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND p.click_depth <= 2 AND p.word_count > 100
        AND p.modified_date IS NOT NULL AND p.modified_date < ?
        AND p.is_indexable = 1
      ORDER BY p.click_depth ASC, p.modified_date ASC
    `).all(project, cutoff).filter(r => isContentPage(r.url));

    // High-value pages with NO date metadata at all (unknown freshness = treat as suspect)
    const staleUnknown = db.prepare(`
      SELECT p.url, p.click_depth, p.word_count, p.modified_date, p.published_date, d.domain
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND p.click_depth <= 2 AND p.word_count BETWEEN 300 AND 1500
        AND p.modified_date IS NULL AND p.published_date IS NULL
        AND p.is_indexable = 1
      ORDER BY p.click_depth ASC, p.word_count ASC
      LIMIT 20
    `).all(project).filter(r => isContentPage(r.url));

    if (!staleKnown.length && !staleUnknown.length) {
      console.log(chalk.yellow('No decay targets found. More crawl data or date metadata needed.'));
      return;
    }

    if (staleKnown.length) {
      console.log(chalk.bold.red(`🔴 Confirmed stale (modified > ${monthsAgo} months ago): ${staleKnown.length} pages\n`));
      for (const r of staleKnown) {
        console.log(`  ${chalk.bold(r.domain)} · depth ${r.click_depth}`);
        console.log(`    ${r.url}`);
        console.log(`    ${chalk.red(`Last modified: ${r.modified_date}`)} · ${r.word_count} words\n`);
      }
    }

    if (staleUnknown.length) {
      console.log(chalk.bold.yellow(`🟡 No date metadata — freshness unknown (${staleUnknown.length} pages):\n`));
      for (const r of staleUnknown) {
        console.log(`  ${chalk.bold(r.domain)} · depth ${r.click_depth} · ${r.word_count} words`);
        console.log(`    ${r.url}\n`);
      }
    }

    console.log(chalk.bold.green('💡 Action: Publish updated versions of these topics now.'));
    console.log(chalk.gray('   Your 2026 publish date vs their stale content = freshness advantage.\n'));
  });

// ── HEADINGS AUDIT ────────────────────────────────────────────────────────
program
  .command('headings-audit <project>')
  .description('Pull competitor heading structures for AI gap analysis')
  .option('--domain <domain>', 'Audit a specific competitor domain')
  .option('--depth <n>', 'Max click depth to include', '2')
  .action(async (project, opts) => {
    if (!requirePro('headings-audit')) return;
    const db = getDb();
    const maxDepth = parseInt(opts.depth);

    printAttackHeader('🏗️  Heading Architecture Audit', project);

    const domainFilter = opts.domain ? 'AND d.domain = ?' : '';
    const params = opts.domain ? [project, maxDepth, opts.domain] : [project, maxDepth];

    const pages = db.prepare(`
      SELECT p.id, p.url, p.word_count, p.click_depth, d.domain
      FROM pages p JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND p.click_depth <= ? AND p.word_count > 200
        ${domainFilter}
        AND p.is_indexable = 1
      ORDER BY d.domain, p.click_depth ASC, p.word_count DESC
    `).all(...params).filter(r => isContentPage(r.url));

    if (!pages.length) {
      console.log(chalk.yellow('No pages found matching criteria.'));
      return;
    }

    let report = `# Heading Architecture Audit — ${project.toUpperCase()}\nGenerated: ${new Date().toISOString()}\n\n`;

    for (const page of pages.slice(0, 30)) {
      const headings = db.prepare(`
        SELECT level, text FROM headings WHERE page_id = ?
        ORDER BY rowid ASC
      `).all(page.id);

      if (!headings.length) continue;

      const structure = headings.map(h => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
      console.log(chalk.bold(`\n${page.domain} · ${page.url.replace(/https?:\/\/[^/]+/, '') || '/'}`));
      console.log(chalk.gray(`  depth ${page.click_depth} · ${page.word_count} words`));
      headings.filter(h => h.level <= 3).forEach(h => {
        const indent = '  '.repeat(h.level - 1);
        const color = h.level === 1 ? chalk.bold.white : h.level === 2 ? chalk.yellow : chalk.gray;
        console.log(`  ${indent}${color('H' + h.level + ':')} ${h.text}`);
      });

      report += `## ${page.domain} — ${page.url}\n`;
      report += `*click depth: ${page.click_depth} · words: ${page.word_count}*\n\n`;
      report += '```\n' + structure + '\n```\n\n';
      report += `**Gemini prompt:**\n`;
      report += `> Analyze this heading structure from ${page.domain}. What H2/H3 sub-topics are logically missing? What would a user expect to find that isn't covered? Be specific.\n\n---\n\n`;
    }

    const outPath = join(__dirname, `reports/${project}-headings-audit-${Date.now()}.md`);
    writeFileSync(outPath, report, 'utf8');

    console.log(chalk.bold.green(`\n✅ Full audit saved: ${outPath}`));
    console.log(chalk.gray('   Feed this to Gemini: "Find the gaps in each heading structure above."\n'));
  });

// ── ORPHAN ENTITIES ───────────────────────────────────────────────────────
program
  .command('orphans <project>')
  .description('Find orphaned entities — mentioned everywhere but no dedicated page (needs Qwen extraction)')
  .action((project) => {
    if (!requirePro('orphans')) return;
    const db = getDb();

    printAttackHeader('👻 Orphan Entity Attack', project);

    // Check if we have any extraction data with primary_entities
    const extractionCount = db.prepare(`
      SELECT COUNT(*) as c FROM extractions e
      JOIN pages p ON p.id = e.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]' AND e.primary_entities != ''
    `).get(project);

    if (!extractionCount || extractionCount.c === 0) {
      console.log(chalk.yellow('⚠️  No entity extraction data found.'));
      console.log(chalk.gray('   Run: node cli.js extract ' + project + '  (requires Ollama + Qwen)\n'));
      return;
    }

    // Get all entities from competitor pages
    const extractions = db.prepare(`
      SELECT e.primary_entities, p.url, d.domain
      FROM extractions e
      JOIN pages p ON p.id = e.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND e.primary_entities IS NOT NULL AND e.primary_entities != ''
    `).all(project);

    // Build entity → pages map
    const entityMap = new Map();
    for (const row of extractions) {
      let entities = [];
      try { entities = JSON.parse(row.primary_entities); } catch {}
      for (const entity of entities) {
        const key = entity.toLowerCase().trim();
        if (!entityMap.has(key)) entityMap.set(key, new Set());
        entityMap.get(key).add(row.domain);
      }
    }

    // Get all competitor URLs to check for dedicated pages
    const allUrls = db.prepare(`
      SELECT p.url FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
    `).all(project).map(r => r.url.toLowerCase());

    // Find entities mentioned 3+ times with no dedicated URL
    const orphans = [];
    for (const [entity, domains] of entityMap.entries()) {
      if (domains.size < 2) continue; // mentioned by 2+ competitors
      const slug = entity.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const hasDedicatedPage = allUrls.some(u => u.includes(slug) || u.includes(entity.replace(/\s+/g, '/')));
      if (!hasDedicatedPage) {
        orphans.push({ entity, domains: [...domains], domainCount: domains.size });
      }
    }

    orphans.sort((a, b) => b.domainCount - a.domainCount);

    if (!orphans.length) {
      if (entityMap.size === 0) {
        console.log(chalk.yellow('⚠️  Entity extraction data exists but no entities were extracted.'));
        console.log(chalk.gray('   Re-run: node cli.js extract ' + project + '\n'));
      } else {
        console.log(chalk.green('No orphaned entities found — competitors have dedicated pages for all major entities.'));
      }
      return;
    }

    console.log(chalk.bold(`Found ${orphans.length} orphaned entities (mentioned by 2+ competitors, no dedicated page):\n`));
    for (const o of orphans.slice(0, 20)) {
      console.log(`  ${chalk.bold.yellow(o.entity)}`);
      console.log(`    Mentioned by: ${o.domains.join(', ')}`);
      console.log(`    ${chalk.green('→ Build: /solutions/' + o.entity.replace(/\s+/g, '-').toLowerCase())}\n`);
    }

    console.log(chalk.bold.green('💡 Action: Build dedicated pillar pages for top orphaned entities.'));
    console.log(chalk.gray('   Focused page > scattered mentions, every time.\n'));
  });

// ── ENTITY COVERAGE MAP ──────────────────────────────────────────────────
program
  .command('entities <project>')
  .description('Entity coverage map — semantic gap at the entity level (concepts competitors mention, you don\'t)')
  .option('--min-mentions <n>', 'Minimum competitor mentions to show', '2')
  .option('--save', 'Save entity map to reports/')
  .action((project, opts) => {
    if (!requirePro('entities')) return;
    const db = getDb();
    const config = loadConfig(project);
    const minMentions = parseInt(opts.minMentions) || 2;

    printAttackHeader('🧬 Entity Coverage Map', project);

    // ── Gather all entities from all domains ──
    const allExtractions = db.prepare(`
      SELECT e.primary_entities, d.domain, d.role, p.url
      FROM extractions e
      JOIN pages p ON p.id = e.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ?
        AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]' AND e.primary_entities != ''
    `).all(project);

    if (!allExtractions.length) {
      console.log(chalk.yellow('⚠️  No entity extraction data found.'));
      console.log(chalk.gray('   Run: node cli.js extract ' + project + '  (requires Ollama + Qwen)\n'));
      return;
    }

    // Build entity → { targetMentions, competitorMentions, domains, pages }
    const entityMap = new Map();

    for (const row of allExtractions) {
      let entities = [];
      try { entities = JSON.parse(row.primary_entities); } catch { continue; }

      for (const entity of entities) {
        const key = entity.toLowerCase().trim();
        if (key.length < 2) continue;

        if (!entityMap.has(key)) {
          entityMap.set(key, { target: new Set(), competitor: new Set(), owned: new Set(), pages: [] });
        }
        const e = entityMap.get(key);
        if (row.role === 'target') e.target.add(row.domain);
        else if (row.role === 'owned') e.owned.add(row.domain);
        else e.competitor.add(row.domain);
        e.pages.push({ domain: row.domain, url: row.url, role: row.role });
      }
    }

    // ── Classify entities ──
    const gaps = [];       // competitor has, you don't
    const shared = [];     // both have
    const yourOnly = [];   // you have, competitor doesn't

    for (const [entity, data] of entityMap) {
      const compCount = data.competitor.size;
      const hasTarget = data.target.size > 0 || data.owned.size > 0;

      if (compCount >= minMentions && !hasTarget) {
        gaps.push({ entity, compCount, domains: [...data.competitor], pages: data.pages });
      } else if (compCount > 0 && hasTarget) {
        shared.push({ entity, compCount, targetDomains: [...data.target, ...data.owned], compDomains: [...data.competitor] });
      } else if (compCount === 0 && hasTarget) {
        yourOnly.push({ entity, targetDomains: [...data.target, ...data.owned] });
      }
    }

    gaps.sort((a, b) => b.compCount - a.compCount);
    shared.sort((a, b) => b.compCount - a.compCount);

    let mdOutput = `# Entity Coverage Map — ${config.target.domain}\nGenerated: ${new Date().toISOString().slice(0, 10)}\n\n`;

    // ── Coverage summary ──
    console.log(chalk.bold(`  Summary: ${entityMap.size} unique entities across all domains\n`));
    console.log(`    ${chalk.red(`🔴 Gaps:`)}     ${chalk.bold(gaps.length)} entities competitors mention, you don't`);
    console.log(`    ${chalk.green('🟢 Shared:')}   ${chalk.bold(shared.length)} entities both sides cover`);
    console.log(`    ${chalk.blue('🔵 Yours:')}    ${chalk.bold(yourOnly.length)} entities only you mention`);
    console.log('');

    mdOutput += `## Summary\n- **${gaps.length}** entity gaps (competitors have, you don't)\n- **${shared.length}** shared entities\n- **${yourOnly.length}** your unique entities\n\n`;

    // ── Entity gaps (the actionable ones) ──
    if (gaps.length > 0) {
      console.log(chalk.bold.red(`  🔴 Entity Gaps — competitors cover these, you don't:\n`));
      mdOutput += `## Entity Gaps\n\n`;

      for (const g of gaps.slice(0, 20)) {
        const domainList = g.domains.join(', ');
        console.log(`    ${chalk.bold.yellow(g.entity)}`);
        console.log(chalk.gray(`      Mentioned by: ${domainList} (${g.compCount} competitor${g.compCount > 1 ? 's' : ''})`));

        // Show example pages
        const examplePages = g.pages.filter(p => p.role === 'competitor').slice(0, 2);
        for (const p of examplePages) {
          const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
          console.log(chalk.gray(`      └ ${p.domain}${path.slice(0, 50)}`));
        }
        console.log('');

        mdOutput += `### ${g.entity}\n- Competitors: ${domainList}\n`;
        for (const p of examplePages) {
          mdOutput += `- Example: \`${p.url}\`\n`;
        }
        mdOutput += '\n';
      }
      if (gaps.length > 20) {
        console.log(chalk.gray(`    ... and ${gaps.length - 20} more gaps\n`));
      }
    }

    // ── Shared entities (competitive overlap) ──
    if (shared.length > 0) {
      console.log(chalk.bold.green(`  🟢 Shared Entities — both you and competitors cover:\n`));
      mdOutput += `## Shared Entities\n\n`;

      for (const s of shared.slice(0, 10)) {
        console.log(`    ${chalk.green('✓')} ${s.entity} ${chalk.gray(`(you + ${s.compCount} competitor${s.compCount > 1 ? 's' : ''})`)}`);
        mdOutput += `- ✓ ${s.entity} — you + ${s.compCount} competitor(s)\n`;
      }
      if (shared.length > 10) {
        console.log(chalk.gray(`    ... and ${shared.length - 10} more shared\n`));
      }
      console.log('');
    }

    // ── Your unique entities ──
    if (yourOnly.length > 0) {
      console.log(chalk.bold.blue(`  🔵 Your Unique Entities — competitors don't mention:\n`));
      mdOutput += `\n## Your Unique Entities\n\n`;

      for (const y of yourOnly.slice(0, 10)) {
        console.log(`    ${chalk.blue('★')} ${y.entity}`);
        mdOutput += `- ★ ${y.entity}\n`;
      }
      if (yourOnly.length > 10) {
        console.log(chalk.gray(`    ... and ${yourOnly.length - 10} more\n`));
      }
      console.log('');
    }

    // ── Action items ──
    console.log(chalk.bold.green('  💡 Actions:'));
    if (gaps.length > 0) {
      console.log(chalk.green(`     1. Create content covering top entity gaps (start with "${gaps[0].entity}")`));
      console.log(chalk.green(`     2. Build dedicated pages for high-frequency gap entities`));
    }
    if (yourOnly.length > 0) {
      console.log(chalk.green(`     3. Double down on your unique entities — they're your differentiator`));
    }
    console.log('');

    // ── Save ──
    if (opts.save) {
      const outPath = join(__dirname, `reports/${project}-entities-${Date.now()}.md`);
      writeFileSync(outPath, mdOutput, 'utf8');
      console.log(chalk.bold.green(`  ✅ Entity map saved: ${outPath}\n`));
    }
  });

// ── SCHEMA INTEL ─────────────────────────────────────────────────────────
program
  .command('schemas <project>')
  .description('Deep structured data competitive analysis — ratings, pricing, rich results gaps')
  .option('--save', 'Save report to reports/')
  .action((project, opts) => {
    const db = getDb();

    printAttackHeader('🔬 Schema Intelligence Report', project);

    const rows = getSchemasByProject(db, project);

    if (rows.length === 0) {
      console.log(chalk.yellow('  No structured data found. Run a crawl first — schemas are parsed from JSON-LD during crawl.'));
      console.log(chalk.dim('  Tip: node cli.js crawl ' + project + '\n'));
      return;
    }

    // Load config to identify target domain
    const configPath = `./config/${project}.json`;
    let targetDomain = null;
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      targetDomain = config.target?.domain;
    } catch {}

    // ── Group by domain ──
    const byDomain = new Map();
    for (const row of rows) {
      if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
      byDomain.get(row.domain).push(row);
    }

    // ── Schema type coverage matrix ──
    console.log(chalk.bold('\n  SCHEMA TYPE COVERAGE'));
    console.log(chalk.dim('  Which structured data types each domain uses\n'));

    const allTypes = [...new Set(rows.map(r => r.schema_type))].sort();
    const domainList = [...byDomain.keys()].sort((a, b) => {
      if (a === targetDomain) return -1;
      if (b === targetDomain) return 1;
      return a.localeCompare(b);
    });

    // Header
    const typeColWidth = 22;
    const domColWidth = 12;
    let header = '  ' + 'Schema Type'.padEnd(typeColWidth);
    for (const dom of domainList) {
      const label = dom === targetDomain ? chalk.bold.hex('#DAA520')(dom.slice(0, domColWidth - 1)) : dom.slice(0, domColWidth - 1);
      header += label.padEnd(domColWidth);
    }
    console.log(header);
    console.log(chalk.dim('  ' + '─'.repeat(typeColWidth + domColWidth * domainList.length)));

    for (const type of allTypes) {
      let line = '  ' + type.padEnd(typeColWidth);
      for (const dom of domainList) {
        const domSchemas = byDomain.get(dom) || [];
        const count = domSchemas.filter(s => s.schema_type === type).length;
        if (count > 0) {
          const marker = dom === targetDomain ? chalk.hex('#DAA520')(`✓ ${count}`) : chalk.green(`✓ ${count}`);
          line += marker.padEnd(domColWidth + 10); // account for ANSI codes
        } else {
          const marker = dom === targetDomain ? chalk.red('✗') : chalk.dim('·');
          line += marker.padEnd(domColWidth + 10);
        }
      }
      console.log(line);
    }

    // ── Rating intel — who has review stars? ──
    const withRatings = rows.filter(r => r.rating !== null);
    if (withRatings.length > 0) {
      console.log(chalk.bold('\n\n  RATING INTELLIGENCE'));
      console.log(chalk.dim('  Competitors with aggregateRating — rich star snippets in SERPs\n'));

      for (const r of withRatings) {
        const isTarget = r.domain === targetDomain;
        const domLabel = isTarget ? chalk.bold.hex('#DAA520')(r.domain) : chalk.white(r.domain);
        const stars = '★'.repeat(Math.round(r.rating)) + '☆'.repeat(5 - Math.round(r.rating));
        const ratingStr = `${r.rating}/5 ${chalk.yellow(stars)}`;
        const countStr = r.rating_count ? chalk.dim(` (${r.rating_count} reviews)`) : '';
        const nameStr = r.name ? chalk.dim(` — ${r.name.slice(0, 50)}`) : '';
        console.log(`  ${domLabel} ${ratingStr}${countStr}${nameStr}`);
        console.log(chalk.dim(`    ${r.url.slice(0, 80)}`));
      }

      // Check if target has ratings
      const targetRatings = withRatings.filter(r => r.domain === targetDomain);
      const compRatings = withRatings.filter(r => r.domain !== targetDomain);
      if (targetRatings.length === 0 && compRatings.length > 0) {
        console.log(chalk.red(`\n  ⚠ GAP: ${compRatings.length} competitor page(s) have star ratings — you have NONE`));
        console.log(chalk.dim('  Adding aggregateRating schema gives you rich star snippets in search results'));
      }
    }

    // ── Pricing intel ──
    const withPricing = rows.filter(r => r.price !== null);
    if (withPricing.length > 0) {
      console.log(chalk.bold('\n\n  PRICING SCHEMA'));
      console.log(chalk.dim('  Structured pricing data (enables price rich results)\n'));

      for (const r of withPricing) {
        const isTarget = r.domain === targetDomain;
        const domLabel = isTarget ? chalk.bold.hex('#DAA520')(r.domain) : chalk.white(r.domain);
        const priceStr = r.currency ? `${r.currency} ${r.price}` : r.price;
        const nameStr = r.name ? ` — ${r.name.slice(0, 40)}` : '';
        console.log(`  ${domLabel} ${chalk.green(priceStr)}${chalk.dim(nameStr)}`);
      }

      const targetPricing = withPricing.filter(r => r.domain === targetDomain);
      const compPricing = withPricing.filter(r => r.domain !== targetDomain);
      if (targetPricing.length === 0 && compPricing.length > 0) {
        console.log(chalk.red(`\n  ⚠ GAP: ${compPricing.length} competitor page(s) have pricing schema — you have NONE`));
      }
    }

    // ── Gap analysis — what competitors have that you don't ──
    const targetTypes = new Set((byDomain.get(targetDomain) || []).map(s => s.schema_type));
    const compTypes = new Set(rows.filter(r => r.domain !== targetDomain).map(r => r.schema_type));
    const schemaGaps = [...compTypes].filter(t => !targetTypes.has(t));
    const yourExclusives = [...targetTypes].filter(t => !compTypes.has(t));

    if (schemaGaps.length > 0 || yourExclusives.length > 0) {
      console.log(chalk.bold('\n\n  COMPETITIVE GAPS'));

      if (schemaGaps.length > 0) {
        console.log(chalk.red(`\n  Missing schema types (competitors have, you don't):`));
        for (const gap of schemaGaps) {
          // Find which competitors have it
          const competitorsWith = [...new Set(rows.filter(r => r.schema_type === gap && r.domain !== targetDomain).map(r => r.domain))];
          console.log(chalk.red(`    ✗ ${gap}`) + chalk.dim(` — used by: ${competitorsWith.join(', ')}`));
        }
      }

      if (yourExclusives.length > 0) {
        console.log(chalk.green(`\n  Your exclusive schema types (competitors lack):`));
        for (const exc of yourExclusives) {
          console.log(chalk.green(`    ✓ ${exc}`) + chalk.dim(' — competitive advantage'));
        }
      }
    }

    // ── Actionable recommendations ──
    console.log(chalk.bold('\n\n  ACTIONS'));

    const actions = [];
    if (schemaGaps.length > 0) {
      const highValue = schemaGaps.filter(t => ['Product', 'SoftwareApplication', 'FAQPage', 'HowTo', 'Review', 'AggregateRating'].includes(t));
      if (highValue.length > 0) {
        actions.push(`Add high-value schema types: ${highValue.join(', ')}`);
      }
      const remaining = schemaGaps.filter(t => !highValue.includes(t));
      if (remaining.length > 0) {
        actions.push(`Consider adding: ${remaining.join(', ')}`);
      }
    }
    if (withRatings.length > 0 && !rows.some(r => r.domain === targetDomain && r.rating !== null)) {
      actions.push('Add aggregateRating schema for star-rich snippets (highest SERP CTR impact)');
    }
    if (withPricing.length > 0 && !rows.some(r => r.domain === targetDomain && r.price !== null)) {
      actions.push('Add pricing schema (Product/Offer) for price-rich results');
    }
    if (!targetTypes.has('FAQPage') && compTypes.has('FAQPage')) {
      actions.push('Add FAQPage schema — expands your SERP real estate with accordion snippets');
    }
    if (!targetTypes.has('BreadcrumbList') && compTypes.has('BreadcrumbList')) {
      actions.push('Add BreadcrumbList schema — improves SERP display and navigation signals');
    }

    if (actions.length > 0) {
      for (let i = 0; i < actions.length; i++) {
        console.log(`  ${chalk.cyan(`${i + 1}.`)} ${actions[i]}`);
      }
    } else {
      console.log(chalk.green('  Your schema coverage matches or exceeds competitors!'));
    }

    // ── Summary stats ──
    console.log(chalk.bold('\n\n  SUMMARY'));
    console.log(`  Total schemas parsed: ${chalk.bold(rows.length)}`);
    console.log(`  Unique types: ${chalk.bold(allTypes.length)}`);
    console.log(`  Domains with schemas: ${chalk.bold(byDomain.size)}`);
    if (schemaGaps.length > 0) console.log(`  Schema gaps: ${chalk.red.bold(schemaGaps.length)}`);
    if (withRatings.length > 0) console.log(`  Pages with ratings: ${chalk.yellow.bold(withRatings.length)}`);
    if (withPricing.length > 0) console.log(`  Pages with pricing: ${chalk.green.bold(withPricing.length)}`);
    console.log('');

    // ── Save option ──
    if (opts.save) {
      const mdLines = [
        `# Schema Intelligence Report — ${project}`,
        `Generated: ${new Date().toISOString().split('T')[0]}`,
        '',
        `## Coverage Matrix`,
        '',
        `| Type | ${domainList.join(' | ')} |`,
        `| --- | ${domainList.map(() => '---').join(' | ')} |`,
      ];
      for (const type of allTypes) {
        const cells = domainList.map(dom => {
          const count = (byDomain.get(dom) || []).filter(s => s.schema_type === type).length;
          return count > 0 ? `✓ (${count})` : '✗';
        });
        mdLines.push(`| ${type} | ${cells.join(' | ')} |`);
      }
      mdLines.push('');
      if (withRatings.length > 0) {
        mdLines.push('## Ratings', '');
        for (const r of withRatings) {
          mdLines.push(`- **${r.domain}**: ${r.rating}/5 (${r.rating_count || '?'} reviews) — ${r.name || r.url}`);
        }
        mdLines.push('');
      }
      if (schemaGaps.length > 0) {
        mdLines.push('## Gaps (competitors have, you don\'t)', '');
        for (const gap of schemaGaps) mdLines.push(`- ✗ ${gap}`);
        mdLines.push('');
      }
      if (actions.length > 0) {
        mdLines.push('## Actions', '');
        for (const a of actions) mdLines.push(`- ${a}`);
      }

      const outPath = `reports/schema-intel-${project}-${new Date().toISOString().split('T')[0]}.md`;
      writeFileSync(outPath, mdLines.join('\n'), 'utf8');
      console.log(chalk.bold.green(`  ✅ Report saved: ${outPath}\n`));
    }
  });

// ── SCHEMA BACKFILL ──────────────────────────────────────────────────────
program
  .command('schemas-backfill <project>')
  .description('Backfill JSON-LD schema data for already-crawled pages (lightweight HTTP fetch, no Playwright)')
  .option('--max <n>', 'Max pages to backfill', parseInt)
  .option('--delay <ms>', 'Delay between fetches in ms', parseInt, 500)
  .action(async (project, opts) => {
    const db = getDb();
    const { parseJsonLd } = await import('./crawler/schema-parser.js');
    const fetch = (await import('node-fetch')).default;

    printAttackHeader('🔬 Schema Backfill', project);

    // Get all pages for this project that don't have schemas yet
    const pages = db.prepare(`
      SELECT p.id, p.url, d.domain
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      LEFT JOIN page_schemas ps ON ps.page_id = p.id
      WHERE d.project = ? AND p.status_code = 200 AND ps.id IS NULL
      ORDER BY d.domain, p.url
    `).all(project);

    const maxPages = opts.max || pages.length;
    const toProcess = pages.slice(0, maxPages);

    console.log(`  Found ${pages.length} pages without schema data`);
    console.log(`  Processing: ${toProcess.length} pages\n`);

    let done = 0, found = 0, failed = 0, totalSchemas = 0;

    for (const page of toProcess) {
      process.stdout.write(chalk.gray(`  [${done + 1}/${toProcess.length}] ${page.url.slice(0, 70)} `));
      try {
        const res = await fetch(page.url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SEOIntelBot/1.0)',
            'Accept': 'text/html',
          },
        });
        if (!res.ok) {
          process.stdout.write(chalk.red(`HTTP ${res.status}\n`));
          failed++;
          done++;
          continue;
        }
        const html = await res.text();
        const schemas = parseJsonLd(html);
        if (schemas.length > 0) {
          insertPageSchemas(db, page.id, schemas);
          totalSchemas += schemas.length;
          found++;
          process.stdout.write(chalk.green(`✓ ${schemas.length} schema(s)\n`));
        } else {
          process.stdout.write(chalk.dim('no JSON-LD\n'));
        }
      } catch (err) {
        process.stdout.write(chalk.red(`✗ ${err.message.slice(0, 40)}\n`));
        failed++;
      }
      done++;
      if (done < toProcess.length) await new Promise(r => setTimeout(r, opts.delay || 500));
    }

    console.log('');
    console.log(chalk.bold.green(`  ✅ Backfill complete`));
    console.log(`  Pages processed: ${done}`);
    console.log(`  Pages with schemas: ${chalk.bold(found)}`);
    console.log(`  Total schemas stored: ${chalk.bold(totalSchemas)}`);
    if (failed > 0) console.log(`  Failed: ${chalk.red(failed)}`);
    console.log(chalk.dim(`\n  Run: node cli.js schemas ${project}\n`));
  });

// ── INTENT FRICTION ───────────────────────────────────────────────────────
program
  .command('friction <project>')
  .description('Find competitor pages with intent/CTA mismatch — high friction targets (needs Qwen extraction)')
  .action((project) => {
    if (!requirePro('friction')) return;
    const db = getDb();

    printAttackHeader('🎯 Intent & Friction Hijacking', project);

    const rows = db.prepare(`
      SELECT e.search_intent, e.cta_primary, e.pricing_tier, p.url, p.word_count, d.domain
      FROM extractions e
      JOIN pages p ON p.id = e.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role = 'competitor'
        AND e.search_intent IS NOT NULL AND e.search_intent != ''
        AND e.cta_primary IS NOT NULL AND e.cta_primary != ''
      ORDER BY d.domain, p.click_depth ASC
    `).all(project).filter(r => isContentPage(r.url));

    if (!rows.length) {
      console.log(chalk.yellow('⚠️  No intent/CTA extraction data found.'));
      console.log(chalk.gray('   Run: node cli.js extract ' + project + '  (requires Ollama + Qwen)\n'));
      return;
    }

    // High friction patterns
    const highFrictionCTAs = ['enterprise', 'sales', 'contact', 'book a demo', 'request', 'talk to'];
    const targets = rows.filter(r => {
      const cta = (r.cta_primary || '').toLowerCase();
      const intent = (r.search_intent || '').toLowerCase();
      const isHighFriction = highFrictionCTAs.some(f => cta.includes(f));
      const isInfoOrCommercial = intent.includes('informational') || intent.includes('commercial');
      return isHighFriction && isInfoOrCommercial;
    });

    if (!targets.length) {
      console.log(chalk.green('No high-friction mismatches found in current extraction data.'));
      console.log(chalk.gray(`  (${rows.length} pages analyzed)\n`));
      return;
    }

    console.log(chalk.bold.red(`Found ${targets.length} high-friction targets:\n`));
    for (const t of targets) {
      console.log(`  ${chalk.bold(t.domain)}`);
      console.log(`    ${t.url}`);
      console.log(`    Intent: ${chalk.yellow(t.search_intent)} · CTA: ${chalk.red(t.cta_primary)}`);
      console.log(`    ${chalk.green('→ Build low-friction alternative: same topic, CTA = "Start Free" or "View Pricing"')}\n`);
    }

    console.log(chalk.bold.green('💡 Action: Build transactional pages for these exact topics with low-friction CTAs.'));
    console.log(chalk.gray('   Google rewards pages that solve the user\'s problem without making them jump through hoops.\n'));
  });

// ── WEEKLY INTEL BRIEF ───────────────────────────────────────────────────
program
  .command('brief <project>')
  .description('Weekly SEO Intel Brief — what changed, new gaps, wins, actions')
  .option('--days <n>', 'Lookback window in days', '7')
  .option('--save', 'Save brief to reports/')
  .action((project, opts) => {
    if (!requirePro('brief')) return;
    const db = getDb();
    const config = loadConfig(project);
    const days = parseInt(opts.days) || 7;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const cutoffISO = new Date(cutoff).toISOString().slice(0, 10);
    const weekOf = new Date().toISOString().slice(0, 10);

    const hr = '─'.repeat(60);
    const header = `📊 Weekly SEO Intel Brief — ${config.target.domain}\n   Week of ${weekOf} (last ${days} days)`;

    console.log(chalk.bold.cyan(`\n${hr}`));
    console.log(chalk.bold.cyan(`  ${header}`));
    console.log(chalk.bold.cyan(hr));

    let mdOutput = `# Weekly SEO Intel Brief — ${config.target.domain}\n**Week of ${weekOf}** (last ${days} days)\n\n---\n\n`;

    // ── COMPETITOR MOVES ──
    console.log(chalk.bold('\n  COMPETITOR MOVES\n'));
    mdOutput += `## Competitor Moves\n\n`;

    const compDomains = config.competitors.map(c => c.domain);
    const compMoves = [];

    for (const comp of compDomains) {
      // New pages discovered this week
      const newPages = db.prepare(`
        SELECT p.url, p.word_count, p.published_date
        FROM pages p JOIN domains d ON d.id = p.domain_id
        WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
        ORDER BY p.first_seen_at DESC
      `).all(comp, project, cutoff).filter(r => isContentPage(r.url));

      // Changed pages (content hash changed or re-crawled)
      const changedPages = db.prepare(`
        SELECT p.url, p.word_count, p.modified_date
        FROM pages p JOIN domains d ON d.id = p.domain_id
        WHERE d.domain = ? AND d.project = ?
          AND p.crawled_at > ? AND p.first_seen_at < ?
          AND p.is_indexable = 1
        ORDER BY p.crawled_at DESC
      `).all(comp, project, cutoff, cutoff).filter(r => isContentPage(r.url));

      if (newPages.length === 0 && changedPages.length === 0) {
        console.log(chalk.gray(`    ${comp.padEnd(25)} no changes`));
        mdOutput += `- **${comp}** — no changes\n`;
        continue;
      }

      const parts = [];
      if (newPages.length > 0) parts.push(chalk.green(`+${newPages.length} new`));
      if (changedPages.length > 0) parts.push(chalk.yellow(`${changedPages.length} updated`));
      console.log(`    ${chalk.bold(comp.padEnd(25))} ${parts.join(' · ')}`);

      mdOutput += `- **${comp}** — `;
      const mdParts = [];
      if (newPages.length > 0) mdParts.push(`+${newPages.length} new pages`);
      if (changedPages.length > 0) mdParts.push(`${changedPages.length} updated`);
      mdOutput += mdParts.join(', ') + '\n';

      // Show top new pages
      for (const p of newPages.slice(0, 3)) {
        const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
        console.log(chalk.green(`      + ${path.slice(0, 65)}`));
        mdOutput += `  - \`${path}\`\n`;
      }
      if (newPages.length > 3) {
        console.log(chalk.gray(`      ... and ${newPages.length - 3} more`));
      }

      compMoves.push({ domain: comp, newPages, changedPages });
    }

    // ── YOUR SITE ──
    console.log(chalk.bold('\n  YOUR SITE\n'));
    mdOutput += `\n## Your Site\n\n`;

    const targetDomain = config.target.domain;
    const ownedDomains = (config.owned || []).map(o => o.domain);
    const allOwned = [targetDomain, ...ownedDomains];

    for (const dom of allOwned) {
      const newPages = db.prepare(`
        SELECT p.url, p.word_count
        FROM pages p JOIN domains d ON d.id = p.domain_id
        WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
      `).all(dom, project, cutoff).filter(r => isContentPage(r.url));

      if (newPages.length > 0) {
        console.log(`    ${chalk.bold.green(dom.padEnd(25))} +${newPages.length} new page(s)`);
        mdOutput += `- **${dom}** — +${newPages.length} new page(s)\n`;
        for (const p of newPages.slice(0, 3)) {
          const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
          console.log(chalk.green(`      + ${path.slice(0, 65)}`));
          mdOutput += `  - \`${path}\`\n`;
        }
      } else {
        console.log(chalk.gray(`    ${dom.padEnd(25)} no new pages`));
        mdOutput += `- **${dom}** — no new pages\n`;
      }
    }

    // ── NEW GAPS DETECTED ──
    console.log(chalk.bold('\n  NEW GAPS DETECTED\n'));
    mdOutput += `\n## New Gaps Detected\n\n`;

    // Find keywords competitors have that target doesn't
    const targetKeywords = new Set(
      db.prepare(`
        SELECT DISTINCT LOWER(k.keyword) as kw
        FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
        WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
      `).all(project).map(r => r.kw)
    );

    // Keywords from new competitor pages
    const gapKeywords = new Map();
    for (const move of compMoves) {
      for (const np of move.newPages.slice(0, 10)) {
        const pageRow = db.prepare('SELECT id FROM pages WHERE url = ?').get(np.url);
        if (!pageRow) continue;
        const kws = db.prepare('SELECT keyword FROM keywords WHERE page_id = ?').all(pageRow.id);
        for (const kw of kws) {
          const key = kw.keyword.toLowerCase().trim();
          if (key.length < 3) continue;
          if (targetKeywords.has(key)) continue;
          if (!gapKeywords.has(key)) gapKeywords.set(key, new Set());
          gapKeywords.get(key).add(move.domain);
        }
      }
    }

    // Sort by number of competitors mentioning the keyword
    const sortedGaps = [...gapKeywords.entries()]
      .map(([kw, domains]) => ({ keyword: kw, domains: [...domains], count: domains.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    if (sortedGaps.length > 0) {
      for (const g of sortedGaps) {
        console.log(`    ${chalk.yellow('⚠️')}  ${chalk.bold(g.keyword)} — ${g.domains.join(', ')}`);
        mdOutput += `- ⚠️ **${g.keyword}** — ${g.domains.join(', ')}\n`;
      }
    } else {
      console.log(chalk.green('    No new keyword gaps detected this week.'));
      mdOutput += `No new keyword gaps detected this week.\n`;
    }

    // ── SCHEMA GAPS ──
    // Check if competitors added schema types target doesn't have
    const targetSchema = new Set();
    try {
      const ts = db.prepare(`
        SELECT DISTINCT e.schema_types FROM extractions e
        JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
        WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
          AND e.schema_types IS NOT NULL AND e.schema_types != '[]'
      `).all(project);
      for (const row of ts) {
        try { for (const t of JSON.parse(row.schema_types)) targetSchema.add(t); } catch {}
      }
    } catch {}

    const compSchema = new Map();
    for (const move of compMoves) {
      for (const np of move.newPages.slice(0, 10)) {
        const pageRow = db.prepare('SELECT id FROM pages WHERE url = ?').get(np.url);
        if (!pageRow) continue;
        const ext = db.prepare('SELECT schema_types FROM extractions WHERE page_id = ?').get(pageRow.id);
        if (!ext?.schema_types) continue;
        try {
          for (const st of JSON.parse(ext.schema_types)) {
            if (!targetSchema.has(st)) {
              if (!compSchema.has(st)) compSchema.set(st, new Set());
              compSchema.get(st).add(move.domain);
            }
          }
        } catch {}
      }
    }

    if (compSchema.size > 0) {
      console.log('');
      for (const [schema, domains] of compSchema) {
        console.log(`    ${chalk.yellow('⚠️')}  ${chalk.bold(schema + ' schema')} — ${[...domains].join(', ')} has it, you don't`);
        mdOutput += `- ⚠️ **${schema} schema** — ${[...domains].join(', ')} has it, you don't\n`;
      }
    }

    // ── ACTIONS ──
    console.log(chalk.bold('\n  ACTIONS FOR THIS WEEK\n'));
    mdOutput += `\n## Actions\n\n`;

    let actionNum = 1;
    const actions = [];

    // Action: cover new competitor topics
    if (sortedGaps.length > 0) {
      const topGap = sortedGaps[0];
      const action = `Write content covering "${topGap.keyword}" — ${topGap.count} competitor(s) rank for it`;
      actions.push(action);
    }

    // Action: add missing schema
    if (compSchema.size > 0) {
      const [schema, domains] = [...compSchema.entries()][0];
      const action = `Add ${schema} schema markup to relevant pages (${[...domains][0]} already has it)`;
      actions.push(action);
    }

    // Action: match publishing rate
    const compVelocities = compMoves
      .map(m => ({ domain: m.domain, rate: m.newPages.length }))
      .sort((a, b) => b.rate - a.rate);
    const targetNew = db.prepare(`
      SELECT COUNT(*) as c FROM pages p JOIN domains d ON d.id = p.domain_id
      WHERE d.domain = ? AND d.project = ? AND p.first_seen_at > ?
    `).get(targetDomain, project, cutoff)?.c || 0;

    if (compVelocities.length > 0 && compVelocities[0].rate > targetNew) {
      const action = `Increase publishing rate — ${compVelocities[0].domain} published ${compVelocities[0].rate} pages vs your ${targetNew}`;
      actions.push(action);
    }

    if (actions.length === 0) {
      actions.push('Re-crawl competitors to detect new content');
      actions.push('Review dashboard for technical SEO fixes');
    }

    for (const action of actions.slice(0, 5)) {
      console.log(`    ${chalk.bold.green(`${actionNum}.`)} ${action}`);
      mdOutput += `${actionNum}. ${action}\n`;
      actionNum++;
    }

    console.log('');
    mdOutput += `\n---\n\nFull report: \`reports/${project}-dashboard.html\`\n`;
    console.log(chalk.gray(`  Full report: reports/${project}-dashboard.html\n`));

    // ── Save ──
    if (opts.save) {
      const outPath = join(__dirname, `reports/${project}-brief-${Date.now()}.md`);
      writeFileSync(outPath, mdOutput, 'utf8');
      console.log(chalk.bold.green(`  ✅ Brief saved: ${outPath}\n`));
    }

    console.log(chalk.dim(`  → Next: node cli.js brief ${project} --save`));
    console.log(chalk.dim(`  → Set on cron: weekly Sunday analysis + brief\n`));
  });

// ── CONTENT VELOCITY ─────────────────────────────────────────────────────
program
  .command('velocity <project>')
  .description('Content velocity — how fast each domain publishes (publishing rate + new page detection)')
  .option('--days <n>', 'Lookback window in days', '30')
  .action((project, opts) => {
    if (!requirePro('velocity')) return;
    const db = getDb();
    const days = parseInt(opts.days) || 30;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    printAttackHeader('📈 Content Velocity Tracker', project);

    // ── 1. Pages discovered recently (first_seen_at within window) ──
    const newPages = db.prepare(`
      SELECT d.domain, d.role, p.url, p.first_seen_at, p.published_date, p.word_count, p.click_depth
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND p.first_seen_at > ? AND p.is_indexable = 1
      ORDER BY p.first_seen_at DESC
    `).all(project, cutoff).filter(r => isContentPage(r.url));

    // ── 2. Pages with published_date within window ──
    const cutoffISO = new Date(cutoff).toISOString().slice(0, 10);
    const publishedRecently = db.prepare(`
      SELECT d.domain, d.role, p.url, p.published_date, p.word_count
      FROM pages p
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND p.published_date IS NOT NULL AND p.published_date > ?
        AND p.is_indexable = 1
      ORDER BY p.published_date DESC
    `).all(project, cutoffISO).filter(r => isContentPage(r.url));

    // ── 3. Total page counts per domain (for context) ──
    const totals = db.prepare(`
      SELECT d.domain, d.role, COUNT(*) as total_pages,
        COUNT(p.published_date) as pages_with_date,
        MIN(p.first_seen_at) as earliest_seen,
        MAX(p.first_seen_at) as latest_seen
      FROM pages p JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND p.is_indexable = 1
      GROUP BY d.domain ORDER BY d.role, d.domain
    `).all(project);

    // ── Velocity summary per domain ──
    console.log(chalk.bold('  Domain Velocity Summary') + chalk.gray(` (last ${days} days)\n`));
    console.log(chalk.gray('  Domain                         Role         Total   New    Rate/wk  Published'));
    console.log(chalk.gray('  ' + '─'.repeat(85)));

    const domainNewMap = {};
    for (const np of newPages) {
      if (!domainNewMap[np.domain]) domainNewMap[np.domain] = [];
      domainNewMap[np.domain].push(np);
    }

    const domainPubMap = {};
    for (const pp of publishedRecently) {
      if (!domainPubMap[pp.domain]) domainPubMap[pp.domain] = [];
      domainPubMap[pp.domain].push(pp);
    }

    const velocities = [];

    for (const t of totals) {
      const newCount = (domainNewMap[t.domain] || []).length;
      const pubCount = (domainPubMap[t.domain] || []).length;
      const weeksInWindow = days / 7;
      const ratePerWeek = weeksInWindow > 0 ? (Math.max(newCount, pubCount) / weeksInWindow).toFixed(1) : '—';

      velocities.push({ domain: t.domain, role: t.role, total: t.total_pages, newCount, pubCount, ratePerWeek: parseFloat(ratePerWeek) || 0 });

      const roleColor = t.role === 'target' ? chalk.green : t.role === 'owned' ? chalk.blue : chalk.yellow;
      const rateColor = parseFloat(ratePerWeek) > 2 ? chalk.green : parseFloat(ratePerWeek) > 0 ? chalk.yellow : chalk.gray;

      console.log(`  ${t.domain.padEnd(30)} ${roleColor(t.role.padEnd(12))} ${String(t.total_pages).padEnd(7)} ${chalk.cyan(String(newCount).padEnd(6))} ${rateColor(String(ratePerWeek + '/wk').padEnd(8))} ${String(pubCount).padEnd(6)}`);
    }

    // ── Velocity leader ──
    const competitors = velocities.filter(v => v.role === 'competitor');
    const target = velocities.find(v => v.role === 'target');
    const leader = competitors.sort((a, b) => b.ratePerWeek - a.ratePerWeek)[0];

    if (leader && target) {
      console.log('');
      if (leader.ratePerWeek > target.ratePerWeek) {
        console.log(chalk.bold.yellow(`  ⚠️  ${leader.domain} is publishing ${leader.ratePerWeek}/wk vs your ${target.ratePerWeek}/wk`));
        console.log(chalk.gray(`     They're out-publishing you. Check what topics they're covering.\n`));
      } else if (target.ratePerWeek > 0) {
        console.log(chalk.bold.green(`  ✅ You're leading! ${target.ratePerWeek}/wk vs fastest competitor ${leader?.ratePerWeek || 0}/wk\n`));
      }
    }

    // ── Recently published pages (with dates) ──
    if (publishedRecently.length > 0) {
      console.log(chalk.bold(`\n  📅 Recently Published (with date metadata):\n`));
      for (const p of publishedRecently.slice(0, 15)) {
        const roleColor = p.role === 'target' ? chalk.green : chalk.yellow;
        const dateStr = p.published_date?.slice(0, 10) || '?';
        console.log(`  ${roleColor(p.domain.padEnd(25))} ${chalk.cyan(dateStr)}  ${p.url.replace(/https?:\/\/[^/]+/, '').slice(0, 60)}`);
      }
    }

    // ── New pages by section ──
    if (newPages.length > 0) {
      console.log(chalk.bold(`\n  🆕 New Pages Discovered (first seen in last ${days} days):\n`));

      // Group by domain
      const byDomain = {};
      for (const p of newPages) {
        if (!byDomain[p.domain]) byDomain[p.domain] = [];
        byDomain[p.domain].push(p);
      }

      for (const [domain, pages] of Object.entries(byDomain).slice(0, 6)) {
        const role = pages[0]?.role || '?';
        const roleColor = role === 'target' ? chalk.green : role === 'owned' ? chalk.blue : chalk.yellow;
        console.log(`  ${roleColor(chalk.bold(domain))} (${pages.length} new pages)`);
        for (const p of pages.slice(0, 5)) {
          const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
          const date = p.first_seen_at ? new Date(p.first_seen_at).toISOString().slice(0, 10) : '?';
          console.log(chalk.gray(`    ${date}  ${path.slice(0, 70)}`));
        }
        if (pages.length > 5) console.log(chalk.gray(`    ... and ${pages.length - 5} more`));
        console.log('');
      }
    }

    // ── Actionable insight ──
    if (newPages.length === 0 && publishedRecently.length === 0) {
      console.log(chalk.yellow('\n  No velocity data yet. Re-crawl after a few days to detect new content.\n'));
      console.log(chalk.gray('  Velocity tracking improves over time — each crawl builds a timeline.'));
      console.log(chalk.gray('  Tip: Set up daily cron: 0 14 * * * node cli.js run\n'));
    } else {
      console.log(chalk.bold.green('  💡 Action: Match or exceed the fastest competitor\'s publishing rate.'));
      console.log(chalk.gray('     Focus on the topics THEY\'re covering that YOU haven\'t.\n'));
    }
  });

// ── JS RENDERING DELTA ───────────────────────────────────────────────────
program
  .command('js-delta <project>')
  .description('Compare raw HTML vs rendered DOM — find pages with hidden JS-only content')
  .option('--domain <domain>', 'Check a specific domain only')
  .option('--max-pages <n>', 'Max pages to check per domain', '10')
  .option('--threshold <n>', 'Word count difference threshold to flag', '50')
  .option('--save', 'Save report to reports/')
  .action(async (project, opts) => {
    if (!requirePro('js-delta')) return;
    const config = loadConfig(project);
    const db = getDb();
    const maxPerDomain = parseInt(opts.maxPages) || 10;
    const threshold = parseInt(opts.threshold) || 50;

    printAttackHeader('🔬 JS Rendering Delta', project);
    console.log(chalk.gray('  Comparing raw HTML (no JS) vs Playwright render (full JS)\n'));

    // Get pages to check — focus on high-value pages (low depth, indexable)
    const domainFilter = opts.domain ? 'AND d.domain = ?' : '';
    const params = opts.domain ? [project, opts.domain] : [project];

    const domains = db.prepare(`
      SELECT DISTINCT d.domain, d.role FROM domains d WHERE d.project = ? ${opts.domain ? 'AND d.domain = ?' : ''}
      ORDER BY d.role, d.domain
    `).all(...params);

    if (!domains.length) {
      console.log(chalk.red('No domains found for project.'));
      return;
    }

    // Lightweight fetch (no JS) using node-fetch
    let nodeFetch;
    try {
      nodeFetch = (await import('node-fetch')).default;
    } catch {
      console.log(chalk.red('node-fetch not available. Run: npm install node-fetch'));
      return;
    }

    // Playwright for full render
    let chromium;
    try {
      chromium = (await import('playwright')).chromium;
    } catch {
      console.log(chalk.red('Playwright not available. Run: npx playwright install'));
      return;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      ignoreHTTPSErrors: true,
    });

    const results = [];
    let mdOutput = `# JS Rendering Delta — ${project}\nGenerated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    mdOutput += `Threshold: ${threshold}+ word difference\n\n`;

    try {
      for (const dom of domains) {
        const pages = db.prepare(`
          SELECT p.url, p.word_count, p.click_depth
          FROM pages p JOIN domains d ON d.id = p.domain_id
          WHERE d.domain = ? AND d.project = ? AND p.is_indexable = 1
            AND p.click_depth <= 2 AND p.word_count > 50
          ORDER BY p.click_depth ASC, p.word_count DESC
          LIMIT ?
        `).all(dom.domain, project, maxPerDomain).filter(r => isContentPage(r.url));

        if (!pages.length) continue;

        const roleColor = dom.role === 'target' ? chalk.green : dom.role === 'owned' ? chalk.blue : chalk.yellow;
        console.log(roleColor(chalk.bold(`  ${dom.domain}`) + chalk.gray(` (${pages.length} pages)`)));

        for (const pg of pages) {
          process.stdout.write(chalk.gray(`    ${pg.url.replace(/https?:\/\/[^/]+/, '').slice(0, 55).padEnd(55)} `));

          try {
            // 1. Raw HTML fetch (no JS)
            const rawRes = await nodeFetch(pg.url, {
              timeout: 10000,
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
            });
            const rawHtml = await rawRes.text();
            const rawText = rawHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ').trim();
            const rawWords = rawText.split(/\s+/).filter(w => w.length > 1).length;

            // 2. Playwright render (full JS)
            const page = await context.newPage();
            try {
              await page.goto(pg.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(2000); // let JS execute
              const renderedWords = await page.$eval('body', el =>
                el.innerText.split(/\s+/).filter(w => w.length > 1).length
              ).catch(() => 0);

              const delta = renderedWords - rawWords;
              const pctDelta = rawWords > 0 ? Math.round((delta / rawWords) * 100) : (renderedWords > 0 ? 100 : 0);

              const result = {
                url: pg.url, domain: dom.domain, role: dom.role,
                rawWords, renderedWords, delta, pctDelta,
                hidden: delta > threshold,
              };
              results.push(result);

              if (delta > threshold) {
                process.stdout.write(chalk.red(`⚠️  raw:${rawWords} → rendered:${renderedWords} (+${delta} words, +${pctDelta}%)\n`));
              } else if (delta < -threshold) {
                process.stdout.write(chalk.yellow(`📉 raw:${rawWords} → rendered:${renderedWords} (${delta} words)\n`));
              } else {
                process.stdout.write(chalk.green(`✓ raw:${rawWords} ≈ rendered:${renderedWords}\n`));
              }
            } finally {
              await page.close().catch(() => {});
            }
          } catch (err) {
            process.stdout.write(chalk.red(`✗ ${err.message.slice(0, 40)}\n`));
          }

          // Be respectful
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
        }
        console.log('');
      }
    } finally {
      await browser.close().catch(() => {});
    }

    // ── Summary ──
    const hiddenContent = results.filter(r => r.hidden);
    const totalChecked = results.length;

    console.log(chalk.bold(`  Summary: ${totalChecked} pages checked\n`));
    console.log(`    ${chalk.green('✓')} ${results.filter(r => !r.hidden && r.delta >= -threshold).length} pages render correctly (raw ≈ rendered)`);
    console.log(`    ${chalk.red('⚠️')}  ${hiddenContent.length} pages with JS-hidden content (${threshold}+ words invisible to raw crawlers)`);
    console.log('');

    mdOutput += `## Summary\n- ${totalChecked} pages checked\n- ${hiddenContent.length} with JS-hidden content\n\n`;

    if (hiddenContent.length > 0) {
      console.log(chalk.bold.red('  Pages with hidden JS content:\n'));
      mdOutput += `## Hidden Content Detected\n\n`;

      for (const h of hiddenContent.sort((a, b) => b.delta - a.delta)) {
        const path = h.url.replace(/https?:\/\/[^/]+/, '') || '/';
        console.log(`    ${chalk.bold(h.domain)} ${path.slice(0, 50)}`);
        console.log(chalk.red(`      Raw: ${h.rawWords} words → Rendered: ${h.renderedWords} words (+${h.delta} hidden)`));
        console.log(chalk.gray(`      ${h.pctDelta}% of content is invisible to simple crawlers\n`));

        mdOutput += `### ${h.domain}${path}\n- Raw: ${h.rawWords} words\n- Rendered: ${h.renderedWords} words\n- **+${h.delta} hidden words (${h.pctDelta}%)**\n\n`;
      }

      console.log(chalk.bold.green('  💡 Actions:'));
      const targetHidden = hiddenContent.filter(h => h.role === 'target' || h.role === 'owned');
      const compHidden = hiddenContent.filter(h => h.role === 'competitor');

      if (targetHidden.length > 0) {
        console.log(chalk.yellow(`     ⚠️  YOUR site has ${targetHidden.length} page(s) with hidden content!`));
        console.log(chalk.yellow(`     → Implement SSR or pre-rendering for these pages`));
        console.log(chalk.yellow(`     → Googlebot can render JS, but it's slower and less reliable\n`));
      }
      if (compHidden.length > 0) {
        console.log(chalk.green(`     ✅ ${compHidden.length} competitor page(s) have hidden content`));
        console.log(chalk.green(`     → Their content is harder for Google to index — your opportunity\n`));
      }
    } else {
      console.log(chalk.green('  ✅ No significant JS rendering gaps detected.\n'));
    }

    if (opts.save) {
      const outPath = join(__dirname, `reports/${project}-js-delta-${Date.now()}.md`);
      writeFileSync(outPath, mdOutput, 'utf8');
      console.log(chalk.bold.green(`  ✅ Report saved: ${outPath}\n`));
    }
  });

// ── EXPORT (JSON/CSV for paste-into-any-AI) ─────────────────────────────
program
  .command('export <project>')
  .description('Export crawl data as JSON or CSV — paste into any AI for analysis')
  .option('--format <type>', 'Output format: json or csv', 'json')
  .option('--tables <list>', 'Comma-separated tables to include (pages,keywords,headings,links,technical,extractions,analyses,schemas)', 'pages,keywords,links,technical')
  .option('--output <path>', 'Output file path (default: reports/<project>-export-<timestamp>.<format>)')
  .option('--full', 'Export all tables including AI analysis data (requires Solo)')
  .action(async (project, opts) => {
    const config = loadConfig(project);
    const db = getDb();
    const format = opts.format === 'csv' ? 'csv' : 'json';

    // --full requires Solo (includes extractions + analyses)
    let tables = opts.tables.split(',').map(t => t.trim()).filter(Boolean);
    if (opts.full) {
      if (!requirePro('extract')) return;
      tables = ['pages', 'keywords', 'headings', 'links', 'technical', 'extractions', 'analyses', 'schemas'];
    }

    // Gate AI tables behind Solo
    const proTables = ['extractions', 'analyses'];
    const requestedProTables = tables.filter(t => proTables.includes(t));
    if (requestedProTables.length > 0 && !isPro()) {
      console.log('');
      console.log(chalk.yellow(`  Skipping pro-only tables: ${requestedProTables.join(', ')}`));
      console.log(chalk.dim(`  Upgrade to Solo to export AI analysis data.`));
      tables = tables.filter(t => !proTables.includes(t));
    }

    if (tables.length === 0) {
      console.error(chalk.red('\nNo tables to export.\n'));
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n📦 Export — ${project.toUpperCase()} (${format.toUpperCase()})\n`));
    console.log(chalk.dim(`  Tables: ${tables.join(', ')}\n`));

    const exportData = {};

    // Get domain IDs for this project
    const domainRows = db.prepare(`SELECT id, domain, role FROM domains WHERE project = ?`).all(project);
    const domainIds = domainRows.map(d => d.id);
    const domainPlaceholders = domainIds.map(() => '?').join(',');

    if (domainIds.length === 0) {
      console.error(chalk.red('  No crawl data found. Run `crawl` first.\n'));
      process.exit(1);
    }

    exportData.project = project;
    exportData.exported_at = new Date().toISOString();
    exportData.domains = domainRows;

    for (const table of tables) {
      try {
        switch (table) {
          case 'pages':
            exportData.pages = db.prepare(`
              SELECT p.url, d.domain, d.role, p.status_code, p.word_count, p.load_ms,
                     p.is_indexable, p.click_depth, p.published_date, p.modified_date
              FROM pages p JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
              ORDER BY d.role, d.domain, p.click_depth
            `).all(project);
            break;

          case 'keywords':
            exportData.keywords = db.prepare(`
              SELECT k.keyword, k.location, p.url, d.domain, d.role
              FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
              ORDER BY k.keyword
            `).all(project);
            break;

          case 'headings':
            exportData.headings = db.prepare(`
              SELECT h.level, h.text, p.url, d.domain
              FROM headings h JOIN pages p ON p.id = h.page_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
              ORDER BY p.url, h.level
            `).all(project);
            break;

          case 'links':
            exportData.links = db.prepare(`
              SELECT l.target_url, l.anchor_text, l.is_internal, p.url as source_url, d.domain
              FROM links l JOIN pages p ON p.id = l.source_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
              ORDER BY l.is_internal DESC, d.domain
            `).all(project);
            break;

          case 'technical':
            exportData.technical = db.prepare(`
              SELECT t.has_canonical, t.has_og_tags, t.has_schema, t.is_mobile_ok,
                     t.has_sitemap, t.has_robots, t.core_web_vitals, p.url, d.domain
              FROM technical t JOIN pages p ON p.id = t.page_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
            `).all(project);
            break;

          case 'extractions':
            exportData.extractions = db.prepare(`
              SELECT e.title, e.meta_desc, e.h1, e.product_type, e.pricing_tier,
                     e.cta_primary, e.tech_stack, e.schema_types, e.search_intent,
                     e.primary_entities, p.url, d.domain
              FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
            `).all(project);
            break;

          case 'analyses':
            exportData.analyses = db.prepare(`
              SELECT generated_at, model, keyword_gaps, long_tails, quick_wins,
                     new_pages, content_gaps, positioning
              FROM analyses WHERE project = ?
              ORDER BY generated_at DESC LIMIT 1
            `).all(project);
            break;

          case 'schemas':
            exportData.schemas = db.prepare(`
              SELECT ps.schema_type, ps.name, ps.description, ps.rating, ps.rating_count,
                     ps.price, ps.currency, ps.author, ps.date_published, p.url, d.domain
              FROM page_schemas ps JOIN pages p ON p.id = ps.page_id JOIN domains d ON d.id = p.domain_id
              WHERE d.project = ?
              ORDER BY ps.schema_type
            `).all(project);
            break;
        }
        const count = exportData[table]?.length || 0;
        console.log(chalk.dim(`  ${table}: ${count} rows`));
      } catch (err) {
        console.log(chalk.yellow(`  ${table}: skipped (${err.message})`));
      }
    }

    // Output
    const timestamp = Date.now();
    const defaultPath = join(__dirname, `reports/${project}-export-${timestamp}.${format}`);
    const outPath = opts.output || defaultPath;

    if (format === 'csv') {
      // Flatten to CSV — export the largest table, or pages by default
      const primaryTable = tables.includes('pages') ? 'pages' : tables[0];
      const rows = exportData[primaryTable] || [];
      if (rows.length === 0) {
        console.log(chalk.yellow('\n  No data to export.\n'));
        return;
      }
      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        csvLines.push(headers.map(h => {
          const val = row[h];
          if (val == null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(','));
      }
      writeFileSync(outPath, csvLines.join('\n'), 'utf8');
      console.log(chalk.dim(`\n  CSV exports the "${primaryTable}" table. Use --format json for all tables.\n`));
    } else {
      writeFileSync(outPath, JSON.stringify(exportData, null, 2), 'utf8');
    }

    console.log(chalk.bold.green(`\n  ✅ Exported to: ${outPath}\n`));
    console.log(chalk.dim(`  Paste this file into Claude, ChatGPT, or any AI for instant analysis.\n`));
  });

// ── ACTION EXPORTS (Prioritized recommendations) ─────────────────────────
function renderActionOutput(payload, format) {
  return format === 'json' ? formatActionsJson(payload) : formatActionsBrief(payload);
}

function writeOrPrintActionOutput(output, outPath) {
  if (outPath) {
    writeFileSync(outPath, output, 'utf8');
    console.log(chalk.bold.green(`\n  ✅ Exported to: ${outPath}\n`));
  } else {
    console.log('');
    console.log(output);
    console.log('');
  }
}

program
  .command('export-actions <project>')
  .description('Export prioritized SEO actions across technical, competitive, and suggestive scopes')
  .option('--scope <type>', 'technical, competitive, suggestive, or all', 'all')
  .option('--format <type>', 'Output format: json or brief', 'brief')
  .option('--output <path>', 'Write output to a file instead of stdout')
  .option('--vs <domain>', 'Filter competitor comparisons to one domain')
  .action(async (project, opts) => {
    loadConfig(project);
    const db = getDb();
    const scope = ['technical', 'competitive', 'suggestive', 'all'].includes(opts.scope) ? opts.scope : 'all';
    const format = opts.format === 'json' ? 'json' : 'brief';

    try {
      assertHasCrawlData(db, project);
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }

    if (!isPro() && (scope === 'competitive' || scope === 'suggestive')) {
      if (!requirePro('competitive')) return;
    }

    if (scope === 'all' && !isPro()) {
      console.log('');
      console.log(chalk.yellow('  Competitive and suggestive actions require SEO Intel Solo.'));
      console.log(chalk.dim('  Showing technical actions only.'));
    }

    console.log(chalk.bold.cyan(`\n🎯 Action Export — ${project.toUpperCase()}\n`));
    console.log(chalk.dim(`  Scope: ${scope}`));
    if (opts.vs) console.log(chalk.dim(`  Competitor filter: ${opts.vs}`));
    console.log(chalk.dim(`  Format: ${format}\n`));

    let actions = [];

    if (scope === 'technical' || scope === 'all') {
      const technicalActions = buildTechnicalActions(db, project);
      actions.push(...technicalActions);
      console.log(chalk.dim(`  technical: ${technicalActions.length} actions`));
    }

    if (isPro() && (scope === 'competitive' || scope === 'all')) {
      const latestAnalysis = getLatestAnalysis(db, project);
      if (!latestAnalysis) {
        console.log(chalk.yellow('  competitive: skipped (run `analyze` first for richer gap data)'));
      } else {
        const competitiveActions = buildCompetitiveActions(db, project, { vsDomain: opts.vs });
        actions.push(...competitiveActions);
        console.log(chalk.dim(`  competitive: ${competitiveActions.length} actions`));
      }
    }

    if (isPro() && (scope === 'suggestive' || scope === 'all')) {
      const suggestiveActions = buildSuggestiveActions(db, project, { vsDomain: opts.vs, scope: 'all' });
      actions.push(...suggestiveActions);
      console.log(chalk.dim(`  suggestive: ${suggestiveActions.length} actions`));
    }

    const payload = buildExportPayload({ project, scope, actions });
    const output = renderActionOutput(payload, format);
    writeOrPrintActionOutput(output, opts.output);
  });

program
  .command('competitive-actions <project>')
  .description('Shortcut for export-actions --scope competitive')
  .option('--format <type>', 'Output format: json or brief', 'brief')
  .option('--output <path>', 'Write output to a file instead of stdout')
  .option('--vs <domain>', 'Filter to one competitor domain')
  .action(async (project, opts) => {
    loadConfig(project);
    if (!requirePro('competitive')) return;

    const db = getDb();
    try {
      assertHasCrawlData(db, project);
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n⚔️  Competitive Actions — ${project.toUpperCase()}\n`));
    if (opts.vs) console.log(chalk.dim(`  Competitor filter: ${opts.vs}`));

    const latestAnalysis = getLatestAnalysis(db, project);
    if (!latestAnalysis) {
      console.error(chalk.red('\n  No analysis data found. Run `analyze` first.\n'));
      process.exit(1);
    }

    const actions = buildCompetitiveActions(db, project, { vsDomain: opts.vs });
    const payload = buildExportPayload({ project, scope: 'competitive', actions });
    const output = renderActionOutput(payload, opts.format === 'json' ? 'json' : 'brief');
    writeOrPrintActionOutput(output, opts.output);
  });

program
  .command('suggest-usecases <project>')
  .description('Suggest missing page/use-case opportunities from competitor patterns')
  .option('--scope <type>', 'docs, product-pages, dashboards, onboarding, or all', 'all')
  .option('--format <type>', 'Output format: json or brief', 'brief')
  .option('--vs <domain>', 'Filter to one competitor domain')
  .option('--output <path>', 'Write output to a file instead of stdout')
  .action(async (project, opts) => {
    loadConfig(project);
    if (!requirePro('competitive')) return;

    const db = getDb();
    const scope = ['docs', 'product-pages', 'dashboards', 'onboarding', 'all'].includes(opts.scope) ? opts.scope : 'all';
    try {
      assertHasCrawlData(db, project);
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n💡 Suggested Use Cases — ${project.toUpperCase()}\n`));
    console.log(chalk.dim(`  Scope: ${scope}`));
    if (opts.vs) console.log(chalk.dim(`  Competitor filter: ${opts.vs}`));
    console.log('');

    const actions = buildSuggestiveActions(db, project, { vsDomain: opts.vs, scope });
    const payload = buildExportPayload({ project, scope, actions });
    const output = renderActionOutput(payload, opts.format === 'json' ? 'json' : 'brief');
    writeOrPrintActionOutput(output, opts.output);
  });

// ── AEO / AI CITABILITY AUDIT ────────────────────────────────────────────
program
  .command('aeo <project>')
  .alias('citability')
  .description('AI Citability Audit — score every page for how well AI assistants can cite it')
  .option('--target-only', 'Only score target domain (skip competitors)')
  .option('--save', 'Save report to reports/')
  .action(async (project, opts) => {
    if (!requirePro('aeo')) return;
    const db = getDb();
    const config = loadConfig(project);

    printAttackHeader('🤖 AEO — AI Citability Audit', project);

    const { runAeoAnalysis, persistAeoScores, upsertCitabilityInsights } = await import('./analyses/aeo/index.js');

    const results = runAeoAnalysis(db, project, {
      includeCompetitors: !opts.targetOnly,
      log: (msg) => console.log(chalk.gray(msg)),
    });

    if (!results.target.length && !results.competitors.size) {
      console.log(chalk.yellow('\n  ⚠️  No pages with body_text found.'));
      console.log(chalk.gray('   Run: seo-intel crawl ' + project + '  (crawl stores body text since v1.1.6)\n'));
      return;
    }

    // Persist scores
    persistAeoScores(db, results);
    upsertCitabilityInsights(db, project, results.target);

    const { summary } = results;

    // ── Summary ──
    console.log('');
    console.log(chalk.bold('  📊 Citability Summary'));
    console.log('');

    const scoreFmt = (s) => {
      if (s >= 75) return chalk.bold.green(s + '/100');
      if (s >= 55) return chalk.bold.yellow(s + '/100');
      if (s >= 35) return chalk.hex('#ff8c00')(s + '/100');
      return chalk.bold.red(s + '/100');
    };

    console.log(`    Target average:     ${scoreFmt(summary.avgTargetScore)}`);
    if (summary.competitorPages > 0) {
      console.log(`    Competitor average:  ${scoreFmt(summary.avgCompetitorScore)}`);
      const delta = summary.scoreDelta;
      const deltaStr = delta > 0 ? chalk.green(`+${delta}`) : delta < 0 ? chalk.red(`${delta}`) : chalk.gray('0');
      console.log(`    Delta:              ${deltaStr}`);
    }
    console.log('');

    // ── Tier breakdown ──
    const { tierCounts } = summary;
    console.log(`    ${chalk.green('●')} Excellent (75+):  ${tierCounts.excellent}`);
    console.log(`    ${chalk.yellow('●')} Good (55-74):     ${tierCounts.good}`);
    console.log(`    ${chalk.hex('#ff8c00')('●')} Needs work (35-54): ${tierCounts.needs_work}`);
    console.log(`    ${chalk.red('●')} Poor (<35):        ${tierCounts.poor}`);
    console.log('');

    // ── Weakest signals ──
    if (summary.weakestSignals.length) {
      console.log(chalk.bold('  🔍 Weakest Signals (target average)'));
      console.log('');
      for (const s of summary.weakestSignals) {
        const bar = '█'.repeat(Math.round(s.avg / 5)) + chalk.gray('░'.repeat(20 - Math.round(s.avg / 5)));
        console.log(`    ${s.signal.padEnd(20)} ${bar} ${s.avg}/100`);
      }
      console.log('');
    }

    // ── Worst pages (actionable) ──
    const worst = results.target.filter(r => r.score < 55).slice(0, 10);
    if (worst.length) {
      console.log(chalk.bold.red('  ⚡ Pages Needing Work'));
      console.log('');
      for (const p of worst) {
        const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
        const weakest = Object.entries(p.breakdown)
          .sort(([, a], [, b]) => a - b)
          .slice(0, 2)
          .map(([k]) => k.replace(/_/g, ' '));
        console.log(`    ${scoreFmt(p.score)}  ${chalk.bold(path.slice(0, 50))}`);
        console.log(chalk.gray(`           Weak: ${weakest.join(', ')}`));
      }
      console.log('');
    }

    // ── Best pages ──
    const best = results.target.filter(r => r.score >= 55).slice(-5).reverse();
    if (best.length) {
      console.log(chalk.bold.green('  ✨ Top Citable Pages'));
      console.log('');
      for (const p of best) {
        const path = p.url.replace(/https?:\/\/[^/]+/, '') || '/';
        console.log(`    ${scoreFmt(p.score)}  ${chalk.bold(path.slice(0, 50))}  ${chalk.gray(p.aiIntents.join(', '))}`);
      }
      console.log('');
    }

    // ── Actions ──
    console.log(chalk.bold.green('  💡 Actions:'));
    if (tierCounts.poor > 0) {
      console.log(chalk.green(`     1. Fix ${tierCounts.poor} poor-scoring pages — add structured headings, Q&A format, entity depth`));
    }
    if (summary.weakestSignals.length && summary.weakestSignals[0].avg < 40) {
      console.log(chalk.green(`     2. Site-wide weakness: "${summary.weakestSignals[0].signal}" — systematically improve across all pages`));
    }
    if (summary.scoreDelta < 0) {
      console.log(chalk.green(`     3. Competitors are ${Math.abs(summary.scoreDelta)} points ahead — prioritise top-traffic pages first`));
    }
    console.log('');

    // ── Regenerate dashboard ──
    try {
      const configs = loadAllConfigs();
      generateMultiDashboard(db, configs);
      console.log(chalk.green('  ✅ Dashboard updated with AI Citability card\n'));
    } catch (e) {
      console.log(chalk.gray(`  (Dashboard not updated: ${e.message})\n`));
    }

    // ── Save report ──
    if (opts.save) {
      let md = `---\ntype: aeo-report\nproject: ${project}\ndate: ${new Date().toISOString()}\n---\n# AEO Citability Report — ${config.target.domain}\n\n`;
      md += `## Summary\n- Target avg: ${summary.avgTargetScore}/100\n- Competitor avg: ${summary.avgCompetitorScore}/100\n- Delta: ${summary.scoreDelta}\n\n`;
      md += `## Tier Breakdown\n- Excellent: ${tierCounts.excellent}\n- Good: ${tierCounts.good}\n- Needs work: ${tierCounts.needs_work}\n- Poor: ${tierCounts.poor}\n\n`;
      md += `## Pages Needing Work\n`;
      for (const p of worst) {
        md += `- **${p.url}** — ${p.score}/100 (${p.tier})\n`;
      }
      const outPath = join(__dirname, `reports/${project}-aeo-${Date.now()}.md`);
      writeFileSync(outPath, md, 'utf8');
      console.log(chalk.bold.green(`  ✅ Report saved: ${outPath}\n`));
    }
  });

// ── GUIDE (Coach-style chapter map) ──────────────────────────────────────
program
  .command('guide')
  .description('Print the 7 Chapters — always know where you are and what comes next')
  .argument('[project]', 'Show progress for a specific project')
  .action((project) => {
    const db = getDb();
    const hr = chalk.dim('─'.repeat(62));
    const gold = s => chalk.hex('#d4a853')(s);
    const dim = chalk.gray;

    console.log('');
    console.log(gold(chalk.bold('  🔶 SEO Intel — The 7 Chapters')));
    console.log(dim('  Your competitive intelligence journey, step by step.'));
    console.log('');

    // ── Detect state ──
    const configs = loadAllConfigs();
    const hasOllama = (() => { try { spawnSync('which', ['ollama'], { stdio: 'ignore' }); return spawnSync('which', ['ollama'], { stdio: 'pipe' }).status === 0; } catch { return false; } })();
    const env = (() => { try { return readFileSync(join(__dirname, '.env'), 'utf8'); } catch { return ''; } })();
    const hasGemini = env.includes('GEMINI_API_KEY');
    const hasOpenAI = env.includes('OPENAI_API_KEY');
    const hasAnalysisKey = hasGemini || hasOpenAI;

    // Project-specific state
    let projConfig = null;
    let pageCount = 0, extractedCount = 0, analysisCount = 0, reportExists = false;
    if (project) {
      projConfig = configs.find(c => c.project === project);
      if (!projConfig) {
        console.log(chalk.red(`  Project "${project}" not found in config/.\n`));
        console.log(dim(`  Available: ${configs.map(c => c.project).join(', ') || 'none'}`));
        console.log(dim(`  Create one: node cli.js setup --project ${project}\n`));
        return;
      }
      try {
        pageCount = db.prepare(`
          SELECT COUNT(*) as c FROM pages p JOIN domains d ON d.id = p.domain_id WHERE d.project = ?
        `).get(project)?.c || 0;
        extractedCount = db.prepare(`
          SELECT COUNT(*) as c FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ?
        `).get(project)?.c || 0;
        analysisCount = db.prepare(`
          SELECT COUNT(*) as c FROM analyses WHERE project = ?
        `).get(project)?.c || 0;
      } catch { /* tables may not exist yet */ }
      const dashFile = join(__dirname, `reports/${project}-dashboard.html`);
      reportExists = existsSync(dashFile);
    }

    // ── Determine current chapter ──
    let currentChapter = 1;
    if (hasOllama || hasAnalysisKey) currentChapter = 2;
    if (project && projConfig) currentChapter = 3;
    if (project && pageCount > 0) currentChapter = 4;
    if (project && analysisCount > 0) currentChapter = 5;
    if (project && reportExists) currentChapter = 6;
    // Chapter 7 is always "act"

    const chapters = [
      {
        num: 1,
        title: 'Setup',
        desc: 'Check dependencies, configure API keys',
        status: (hasOllama ? chalk.green('✓ Ollama') : chalk.red('✗ Ollama')) +
                dim(' · ') +
                (hasAnalysisKey ? chalk.green('✓ API key') : chalk.yellow('○ no API key')),
        cmd: 'node cli.js setup --project <name>',
        detail: [
          'Checks Ollama (local extraction) + Playwright (crawling)',
          'Optionally saves Gemini/OpenAI API key to .env',
          hasOllama && hasAnalysisKey ? chalk.green('  → You\'re fully set up!') :
          hasOllama ? chalk.yellow('  → Add an API key for analysis: edit .env') :
          chalk.yellow('  → Install Ollama: https://ollama.com  then: ollama pull qwen3:4b'),
        ].filter(Boolean),
      },
      {
        num: 2,
        title: 'Add Your Site + Competitors',
        desc: 'Create a project config with target domain and competitors',
        status: configs.length > 0
          ? chalk.green(`✓ ${configs.length} project(s): ${configs.map(c => c.project).join(', ')}`)
          : chalk.yellow('○ no projects yet'),
        cmd: 'node cli.js setup --project <name>',
        detail: project && projConfig ? [
          `  Target: ${chalk.bold(projConfig.target.domain)}`,
          `  Competitors: ${projConfig.competitors.map(c => c.domain).join(', ')}`,
          projConfig.owned?.length ? `  Owned: ${projConfig.owned.map(o => o.domain).join(', ')}` : null,
        ].filter(Boolean) : [
          '  Enter your domain, competitors, crawl settings',
          '  Generates config/<project>.json',
        ],
      },
      {
        num: 3,
        title: 'Initial Full Crawl',
        desc: 'Spider your site + competitors, extract SEO signals',
        status: project && pageCount > 0
          ? chalk.green(`✓ ${pageCount} pages crawled` + (extractedCount > 0 ? `, ${extractedCount} extracted` : ''))
          : chalk.yellow('○ not crawled yet'),
        cmd: project ? `node cli.js crawl ${project}` : 'node cli.js crawl <project>',
        detail: [
          'BFS from homepage + sitemap discovery',
          'Each page: status, word count, load time, headings, links',
          'Qwen3 extracts: intent, entities, CTAs, keywords, tech stack',
          project && pageCount > 0 ? chalk.green(`  → ${project}: ${pageCount} pages in DB`) : null,
        ].filter(Boolean),
      },
      {
        num: 4,
        title: 'Analysis',
        desc: 'AI reads everything, finds your gaps and opportunities',
        status: project && analysisCount > 0
          ? chalk.green(`✓ ${analysisCount} analysis run(s)`)
          : chalk.yellow('○ not analyzed yet'),
        cmd: project ? `node cli.js analyze ${project}` : 'node cli.js analyze <project>',
        detail: [
          'Sends crawl data to Gemini/GPT for competitive synthesis',
          'Keyword gaps, quick wins, new pages to create, positioning',
          project && analysisCount > 0 ? chalk.green(`  → Latest analysis ready`) : null,
        ].filter(Boolean),
      },
      {
        num: 5,
        title: 'Report',
        desc: 'Interactive HTML dashboard with charts and visualizations',
        status: project && reportExists
          ? chalk.green('✓ Dashboard generated')
          : chalk.yellow('○ no dashboard yet'),
        cmd: project ? `node cli.js html ${project}` : 'node cli.js html <project>',
        detail: [
          'Competitor matrix, gap heatmaps, score cards',
          'Topic cluster network, keyword territories, link DNA',
          'Open in browser — works offline, shareable',
        ],
      },
      {
        num: 6,
        title: 'Ongoing Monitoring',
        desc: 'Keep data fresh automatically',
        status: dim('runs via cron or manually'),
        cmd: 'node cli.js run',
        detail: [
          'Incremental: only re-crawls changed pages (content hash)',
          'Set on cron: 0 */6 * * * node cli.js run',
          'Or use the dashboard: node cli.js serve → click Crawl',
        ],
      },
      {
        num: 7,
        title: 'Act + Iterate',
        desc: 'Use attack commands to find specific opportunities',
        status: dim('always available'),
        cmd: null,
        detail: [
          `${chalk.yellow('brief')}    — weekly intel brief (gaps, moves, actions)`,
          `${chalk.yellow('velocity')} — content publishing rate per domain`,
          `${chalk.yellow('entities')} — entity coverage map (semantic gaps)`,
          `${chalk.yellow('shallow')}  — thin competitor pages to outwrite`,
          `${chalk.yellow('decay')}    — stale competitor content to replace`,
          `${chalk.yellow('orphans')}  — entities with no dedicated page`,
          `${chalk.yellow('friction')} — CTA/intent mismatches to exploit`,
          `${chalk.yellow('js-delta')} — JS rendering delta (hidden content)`,
          `${chalk.yellow('schemas')}  — deep structured data competitive intel`,
          `${chalk.yellow('keywords')} — keyword cluster matrix (trad + AI + agent)`,
        ],
      },
    ];

    for (const ch of chapters) {
      const isCurrent = ch.num === currentChapter;
      const isDone = ch.num < currentChapter;
      const marker = isDone ? chalk.green('✓') : isCurrent ? chalk.hex('#d4a853')('▶') : dim('○');
      const titleColor = isCurrent ? chalk.bold.hex('#d4a853') : isDone ? chalk.green : dim;
      const pointer = isCurrent ? chalk.hex('#d4a853')(' ← you are here') : '';

      console.log(hr);
      console.log(`  ${marker} ${titleColor(`Chapter ${ch.num} — ${ch.title}`)}${pointer}`);
      console.log(dim(`    ${ch.desc}`));
      console.log(`    ${ch.status}`);
      if (ch.cmd) console.log(`    ${dim('Run:')} ${chalk.cyan(ch.cmd)}`);
      if (ch.detail?.length) {
        for (const line of ch.detail) {
          console.log(dim(`    ${line}`));
        }
      }
    }

    console.log(hr);

    // ── Next step suggestion ──
    console.log('');
    if (currentChapter <= 2 && !project) {
      console.log(chalk.cyan('  → Next: Create your first project'));
      console.log(dim('    node cli.js setup --project mysite\n'));
    } else if (currentChapter === 3 && project) {
      console.log(chalk.cyan(`  → Next: Run your first crawl`));
      console.log(dim(`    node cli.js crawl ${project}\n`));
    } else if (currentChapter === 4 && project) {
      console.log(chalk.cyan(`  → Next: Run analysis to find gaps`));
      console.log(dim(`    node cli.js analyze ${project}\n`));
    } else if (currentChapter === 5 && project) {
      console.log(chalk.cyan(`  → Next: Generate your dashboard`));
      console.log(dim(`    node cli.js html ${project}\n`));
    } else if (currentChapter >= 6 && project) {
      console.log(chalk.cyan(`  → Next: Find quick wins with attack commands`));
      console.log(dim(`    node cli.js shallow ${project}`));
      console.log(dim(`    node cli.js decay ${project}`));
      console.log(dim(`    node cli.js friction ${project}\n`));
    } else {
      console.log(chalk.cyan(`  → Pick a project: node cli.js guide <project>\n`));
    }

    console.log(dim('  Lost? Run this any time: node cli.js guide'));
    console.log(dim('  Full reference:          node cli.js --help'));
    console.log('');
  });

// ── License activation hook — phone-home if cache is stale/missing ──────────
program.hook('preAction', async () => {
  const license = loadLicense();
  if (license.needsActivation || license.stale) {
    await activateLicense().catch(() => {});
  }
});

// ── BUG-002: No-args getting-started handler ─────────────────────────────────
// When run with no command, show a friendly entry point instead of generic help
if (process.argv.length <= 2) {
  const gold = s => chalk.hex('#d4a853')(s);
  const dim = chalk.gray;
  const configs = (() => {
    try { return readdirSync(join(__dirname, 'config')).filter(f => f.endsWith('.json') && f !== 'example.json'); }
    catch { return []; }
  })();

  console.log('');
  console.log(gold(chalk.bold('  🔶 SEO Intel')));
  console.log(dim('  Competitive intelligence for your site — powered by local AI.'));
  console.log('');

  if (configs.length === 0) {
    console.log(chalk.cyan('  → Get started:'));
    console.log('');
    console.log('    ' + chalk.bold('seo-intel setup'));
    console.log(dim('    ↑ Create your first project (target + competitors)'));
  } else {
    const projectNames = configs.map(f => f.replace('.json', ''));
    console.log(dim(`  Projects: ${projectNames.join(', ')}`));
    console.log('');
    console.log(chalk.cyan('  → Resume your work:'));
    console.log('');
    console.log('    ' + chalk.bold(`seo-intel guide ${projectNames[0]}`));
    console.log(dim('    ↑ See where you are in the pipeline'));
  }

  console.log('');
  console.log(dim('  Full command list: seo-intel --help'));
  console.log('');
  process.exit(0);
}

// Global error handler — ensures uncaught errors in async actions exit non-zero (BUG-004)
program.parseAsync().catch(err => {
  console.error(chalk.red(`\n✗ ${err.message}\n`));
  process.exit(1);
});
