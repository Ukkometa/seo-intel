#!/usr/bin/env node
import 'dotenv/config';
import { program } from 'commander';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { crawlDomain } from './crawler/index.js';
import { extractPage } from './extractor/qwen.js';
import { buildAnalysisPrompt } from './analysis/prompt-builder.js';
import {
  getDb, upsertDomain, upsertPage, insertExtraction,
  insertKeywords, insertHeadings, insertLinks,
  getCompetitorSummary, getKeywordMatrix, getHeadingStructure
} from './db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

program
  .name('seo-intel')
  .description('SEO Competitor Intelligence Tool')
  .version('0.1.0');

// ── CRAWL ──────────────────────────────────────────────────────────────────
program
  .command('crawl <project>')
  .description('Crawl target + competitors for a project (carbium | ukkometa)')
  .option('--target-only', 'Crawl target site only, skip competitors')
  .option('--domain <domain>', 'Crawl a specific domain only')
  .action(async (project, opts) => {
    const config = loadConfig(project);
    const db = getDb();

    const sites = opts.domain
      ? [...config.competitors, config.target].filter(s => s.domain === opts.domain)
      : opts.targetOnly
        ? [config.target]
        : [config.target, ...config.competitors];

    console.log(chalk.bold.cyan(`\n🔍 SEO Intel — Crawling ${sites.length} site(s) for project: ${project}\n`));

    for (const site of sites) {
      console.log(chalk.yellow(`\n→ Crawling ${site.url} [${site.role}]`));

      // Upsert domain
      const domainRes = upsertDomain(db, { domain: site.domain, project, role: site.role });
      const domainId = domainRes.lastInsertRowid || db.prepare('SELECT id FROM domains WHERE domain = ?').get(site.domain).id;

      let pageCount = 0;
      for await (const page of crawlDomain(site.url)) {
        // Save page
        const pageRes = upsertPage(db, {
          domainId,
          url: page.url,
          statusCode: page.status,
          wordCount: page.wordCount,
          loadMs: page.loadMs,
          isIndexable: page.isIndexable,
        });
        const pageId = pageRes.lastInsertRowid || db.prepare('SELECT id FROM pages WHERE url = ?').get(page.url).id;

        // Extract with Qwen
        process.stdout.write(chalk.gray(`  [${pageCount + 1}] ${page.url.slice(0, 80)} → extracting...`));
        const extraction = await extractPage(page);
        insertExtraction(db, { pageId, data: extraction });
        insertKeywords(db, pageId, extraction.keywords);
        insertHeadings(db, pageId, page.headings);
        insertLinks(db, pageId, page.links);
        process.stdout.write(chalk.green(' ✓\n'));

        pageCount++;
      }

      console.log(chalk.green(`  ✅ Done: ${pageCount} pages crawled`));
    }

    console.log(chalk.bold.green('\n✅ Crawl complete. Run `node cli.js analyze ${project}` next.\n'));
  });

// ── ANALYZE ────────────────────────────────────────────────────────────────
program
  .command('analyze <project>')
  .description('Run cloud analysis (Gemini) on crawled data')
  .option('--model <model>', 'Model to use', 'gemini')
  .action(async (project, opts) => {
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

    const prompt = buildAnalysisPrompt({
      project,
      target,
      competitors,
      keywordMatrix,
      headingStructure: headings,
      context: config.context,
    });

    console.log(chalk.yellow(`Prompt length: ~${Math.round(prompt.length / 4)} tokens`));
    console.log(chalk.yellow('Sending to Gemini...\n'));

    // Save prompt for debugging
    const promptPath = join(__dirname, `reports/${project}-prompt-${Date.now()}.txt`);
    writeFileSync(promptPath, prompt, 'utf8');
    console.log(chalk.gray(`Prompt saved: ${promptPath}`));

    // Call Gemini via gemini CLI (reuse existing auth)
    const result = await callGemini(prompt);

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
      const rawPath = join(__dirname, `reports/${project}-raw-${Date.now()}.txt`);
      writeFileSync(rawPath, result, 'utf8');
      process.exit(1);
    }

    // Save structured analysis
    const outPath = join(__dirname, `reports/${project}-analysis-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(analysis, null, 2), 'utf8');

    // Print summary
    printAnalysisSummary(analysis, project);

    console.log(chalk.bold.green(`\n✅ Analysis saved: ${outPath}\n`));
  });

// ── REPORT ─────────────────────────────────────────────────────────────────
program
  .command('report <project>')
  .description('Print latest analysis as readable markdown')
  .action((project) => {
    const { readdirSync } = await import('fs');
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
  const path = join(__dirname, `config/${project}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.error(chalk.red(`Config not found: ${path}`));
    process.exit(1);
  }
}

async function callGemini(prompt) {
  // Use gemini CLI (already auth'd via OpenClaw)
  const { execSync } = await import('child_process');
  try {
    const result = execSync(
      `echo ${JSON.stringify(prompt)} | gemini -p -`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
    ).toString();
    return result;
  } catch (err) {
    console.error('[gemini]', err.message);
    return null;
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

program.parse();
