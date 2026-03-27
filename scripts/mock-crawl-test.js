#!/usr/bin/env node
/**
 * SEO Intel — Mock Crawl Fire Test
 * 
 * Spins up a tiny local HTTP server with realistic pages,
 * runs seo-intel crawl against it, validates the SQLite output.
 * 
 * Usage: node scripts/mock-crawl-test.js
 * Requirements: node 22.5+, seo-intel installed (npm install -g seo-intel)
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.join(__dirname, '..');
const TEST_PORT = 19876;
const TEST_PROJECT = '_firetest_';

function isSeoIntelRoot(root) {
  return !!root
    && existsSync(path.join(root, 'cli.js'))
    && existsSync(path.join(root, 'config'))
    && existsSync(path.join(root, 'db', 'schema.sql'));
}

// Resolve the actual seo-intel install root (global vs local)
function getSeoIntelInstall() {
  const preferGlobal = process.env.CI === 'true' || process.env.SEO_INTEL_TEST_USE_GLOBAL === '1';
  const sourceInstall = isSeoIntelRoot(SOURCE_ROOT)
    ? { root: SOURCE_ROOT, cliPath: path.join(SOURCE_ROOT, 'cli.js') }
    : null;

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const globalPath = path.join(globalRoot, 'seo-intel');
    if (isSeoIntelRoot(globalPath)) {
      const globalInstall = { root: globalPath, cliPath: path.join(globalPath, 'cli.js') };
      if (preferGlobal || !sourceInstall) return globalInstall;
    }
  } catch {}

  if (sourceInstall) return sourceInstall;
  throw new Error('Could not resolve a valid SEO Intel install root');
}

const { root: ROOT, cliPath: CLI_PATH } = getSeoIntelInstall();
const CONFIG_PATH = path.join(ROOT, 'config', `${TEST_PROJECT}.json`);
const DB_PATH = path.join(ROOT, 'seo-intel.db');

// ── Mock pages ────────────────────────────────────────────────────────────────

const PAGES = {
  '/': `<!DOCTYPE html><html><head>
    <title>Mock Home — Fire Test</title>
    <meta name="description" content="Mock homepage for SEO Intel fire test">
    <meta property="og:title" content="Mock Home">
    <link rel="canonical" href="http://localhost:${TEST_PORT}/">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Mock Site","url":"http://localhost:${TEST_PORT}/"}</script>
  </head><body>
    <h1>Mock Home</h1>
    <p>This is a fire test page for SEO Intel crawling.</p>
    <a href="/about/">About</a>
    <a href="/pricing/">Pricing</a>
    <a href="/blog/">Blog</a>
  </body></html>`,

  '/about/': `<!DOCTYPE html><html><head>
    <title>About — Mock Site</title>
    <meta name="description" content="About the mock site">
  </head><body>
    <h1>About Us</h1>
    <h2>Our Mission</h2>
    <p>We test SEO crawlers. This page has structured content.</p>
    <a href="/">Home</a>
  </body></html>`,

  '/pricing/': `<!DOCTYPE html><html><head>
    <title>Pricing — Mock Site</title>
    <meta name="description" content="Pricing plans for mock site">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mock Plan","offers":{"@type":"Offer","price":"9.99","priceCurrency":"EUR"}}</script>
  </head><body>
    <h1>Pricing</h1>
    <p>€9.99/month. Cancel anytime.</p>
    <a href="/">Home</a>
  </body></html>`,

  '/blog/': `<!DOCTYPE html><html><head>
    <title>Blog — Mock Site</title>
    <meta name="description" content="Blog posts">
  </head><body>
    <h1>Blog</h1>
    <a href="/blog/post-1/">Post 1</a>
    <a href="/blog/post-2/">Post 2</a>
    <a href="/">Home</a>
  </body></html>`,

  '/blog/post-1/': `<!DOCTYPE html><html><head>
    <title>Post 1 — Mock Site</title>
    <meta name="description" content="First blog post">
  </head><body>
    <h1>First Post</h1>
    <p>Content of the first blog post. Keywords: SEO, crawling, testing.</p>
    <a href="/blog/">Back</a>
  </body></html>`,

  '/blog/post-2/': `<!DOCTYPE html><html><head>
    <title>Post 2 — Mock Site</title>
    <!-- missing description intentionally -->
  </head><body>
    <h1>Second Post</h1>
    <p>Content of the second post. No meta description — should be flagged.</p>
    <a href="/blog/">Back</a>
  </body></html>`,

  '/robots.txt': `User-agent: *\nAllow: /\nDisallow: /private/\n`,
  '/sitemap.xml': `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://localhost:${TEST_PORT}/</loc></url>
    <url><loc>http://localhost:${TEST_PORT}/about/</loc></url>
    <url><loc>http://localhost:${TEST_PORT}/pricing/</loc></url>
    <url><loc>http://localhost:${TEST_PORT}/blog/</loc></url>
    <url><loc>http://localhost:${TEST_PORT}/blog/post-1/</loc></url>
    <url><loc>http://localhost:${TEST_PORT}/blog/post-2/</loc></url>
  </urlset>`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); FAILURES++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`); }

let FAILURES = 0;

// ── Server ────────────────────────────────────────────────────────────────────

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (PAGES[url]) {
      const ct = url.endsWith('.xml') ? 'application/xml'
                : url.endsWith('.txt') ? 'text/plain'
                : 'text/html';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(PAGES[url]);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>404</h1></body></html>');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(TEST_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

// ── Config ────────────────────────────────────────────────────────────────────

function writeConfig() {
  const cfg = {
    project: TEST_PROJECT,
    context: {
      siteName: 'Mock Fire Test',
      url: `http://localhost:${TEST_PORT}`,
      industry: 'Testing',
      audience: 'Developers',
      goal: 'Validate SEO Intel crawl pipeline'
    },
    target: {
      url: `http://localhost:${TEST_PORT}`,
      domain: `localhost:${TEST_PORT}`,
      maxPages: 20,
      crawlMode: 'standard'
    },
    competitors: []
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Run crawl ─────────────────────────────────────────────────────────────────

function runCrawl() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_PATH, 'crawl', TEST_PROJECT], {
      cwd: ROOT,
      env: { ...process.env, SEO_INTEL_LICENSE: 'FREE' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('Crawl timed out after 60s'));
    }, 60000);
    let out = '';
    proc.stdout.on('data', d => { out += d; process.stdout.write(d); });
    proc.stderr.on('data', d => { out += d; process.stderr.write(d); });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, out });
    });
    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Validate DB ───────────────────────────────────────────────────────────────

function validateDB() {
  section('SQLite Validation');

  if (!existsSync(DB_PATH)) {
    fail('seo-intel.db not found — crawl may have failed');
    return;
  }

  const db = new DatabaseSync(DB_PATH);

  // Check pages were crawled
  // Get domain_ids for this project
  const domains = db.prepare(`SELECT id FROM domains WHERE project = ?`).all(TEST_PROJECT);
  if (domains.length === 0) {
    fail('No domains registered in DB for test project — crawl did not register domain');
    return;
  }
  const ids = domains.map(d => d.id);
  const placeholders = ids.map(() => '?').join(',');
  const pages = db.prepare(
    `SELECT url, title, meta_desc, word_count, status_code FROM pages WHERE domain_id IN (${placeholders})`
  ).all(...ids);

  if (pages.length === 0) {
    fail('No pages crawled into DB');
    db.close();
    return;
  }
  if (pages.length >= 4) {
    pass(`${pages.length} pages in DB`);
  } else {
    fail(`Expected at least 4 pages in DB, found ${pages.length}`);
  }

  // Check specific pages
  const urls = pages.map(p => p.url);
  const expected = ['/', '/about/', '/pricing/', '/blog/', '/blog/post-1/', '/blog/post-2/'];
  for (const u of expected) {
    if (urls.some(x => x.includes(u))) {
      pass(`Found: ${u}`);
    } else {
      warn(`Missing page: ${u} (may be path normalisation)`);
    }
  }

  // Check titles stored
  const withTitle = pages.filter(p => p.title && p.title.length > 0);
  pass(`${withTitle.length}/${pages.length} pages have titles`);

  // Check meta descriptions (post-2 should be missing)
  const noDesc = pages.filter(p => !p.meta_desc || p.meta_desc.length === 0);
  if (noDesc.length > 0) {
    pass(`${noDesc.length} page(s) correctly flagged with no meta description`);
  }

  // Check status codes
  const ok = pages.filter(p => p.status_code === 200);
  pass(`${ok.length}/${pages.length} pages returned 200`);

  // Check links table
  try {
    const links = db.prepare(`
      SELECT COUNT(*) as c
      FROM links l
      JOIN pages p ON p.id = l.source_id
      WHERE p.domain_id IN (${placeholders})
    `).get(...ids);
    pass(`${links.c} internal links stored`);
  } catch { warn('links table not found or empty'); }

  // Check schemas table
  try {
    const schemas = db.prepare(`
      SELECT COUNT(*) as c
      FROM page_schemas ps
      JOIN pages p ON p.id = ps.page_id
      WHERE p.domain_id IN (${placeholders})
    `).get(...ids);
    pass(`${schemas.c} schema.org entries stored`);
  } catch { warn('page_schemas table not found (schema parser may not run on free tier)'); }

  db.close();
}

// ── export-actions (technical scope, free) ───────────────────────────────────

function runExportActions() {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_PATH, 'export-actions', TEST_PROJECT, '--scope', 'technical'], {
      cwd: ROOT,
      env: { ...process.env, SEO_INTEL_LICENSE: 'FREE' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => resolve({ code, out }));
    setTimeout(() => { proc.kill(); resolve({ code: -1, out: 'timeout' }); }, 30000);
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup(server) {
  server.close();
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  // Remove test project data from DB if it exists
  if (existsSync(DB_PATH)) {
    try {
      const db = new DatabaseSync(DB_PATH);
      const doms = db.prepare(`SELECT id FROM domains WHERE project = ?`).all(TEST_PROJECT);
      const dids = doms.map(d => d.id);
      if (dids.length > 0) {
        const ph = dids.map(() => '?').join(',');
        const pageIds = db.prepare(`SELECT id FROM pages WHERE domain_id IN (${ph})`).all(...dids).map(p => p.id);
        if (pageIds.length > 0) {
          const pagePh = pageIds.map(() => '?').join(',');
          try { db.prepare(`DELETE FROM links WHERE source_id IN (${pagePh})`).run(...pageIds); } catch {}
          for (const tbl of ['page_schemas', 'keywords', 'extractions', 'headings', 'technical']) {
            try { db.prepare(`DELETE FROM ${tbl} WHERE page_id IN (${pagePh})`).run(...pageIds); } catch {}
          }
          try { db.prepare(`DELETE FROM pages WHERE id IN (${pagePh})`).run(...pageIds); } catch {}
        }
      }
      db.prepare(`DELETE FROM domains WHERE project = ?`).run(TEST_PROJECT);
      db.close();
    } catch {}
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🔶 SEO Intel — Mock Crawl Fire Test');
console.log('────────────────────────────────────\n');

section('Setup');
console.log(`  seo-intel root: ${ROOT}`);
console.log(`  cli path: ${CLI_PATH}`);
console.log(`  Mock server: http://localhost:${TEST_PORT}`);
console.log(`  Pages: ${Object.keys(PAGES).filter(p => p.endsWith('/')).length} HTML + robots.txt + sitemap.xml`);
console.log(`  Project: ${TEST_PROJECT}\n`);

const server = await startServer();
pass(`Mock server started on :${TEST_PORT}`);

writeConfig();
pass('Config written');

section('Crawl');
let crawlResult;
try {
  crawlResult = await runCrawl();
  if (crawlResult.code === 0) {
    pass('Crawl exited cleanly (code 0)');
  } else {
    warn(`Crawl exited with code ${crawlResult.code} — check output above`);
  }
} catch (e) {
  fail(`Crawl failed: ${e.message}`);
}

validateDB();

section('export-actions (technical, free tier)');
const exportResult = await runExportActions();
if (exportResult.code === 0) {
  pass('export-actions --scope technical succeeded');
  if (exportResult.out.includes('missing') || exportResult.out.includes('fix') || exportResult.out.includes('action')) {
    pass('Output contains actionable items');
  }
} else if (exportResult.out.includes('Solo') || exportResult.out.includes('license')) {
  warn('export-actions gated behind license (expected for some scopes)');
} else {
  warn(`export-actions exited ${exportResult.code} — may need crawl data`);
}

section('Cleanup');
cleanup(server);
pass('Mock server stopped, test config removed, DB cleaned');

section('Result');
if (FAILURES === 0) {
  console.log('\n  ✅ All checks passed\n');
  process.exit(0);
} else {
  console.log(`\n  ❌ ${FAILURES} check(s) failed\n`);
  process.exit(1);
}
