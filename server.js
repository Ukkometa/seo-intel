import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { checkForUpdates, getUpdateInfo } from './lib/updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PROGRESS_FILE = join(__dirname, '.extraction-progress.json');
const REPORTS_DIR = join(__dirname, 'reports');


function buildActionsMarkdown(payload) {
  const grouped = (payload.actions || []).reduce((acc, action) => {
    const area = action.area || 'other';
    if (!acc[area]) acc[area] = [];
    acc[area].push(action);
    return acc;
  }, {});

  const lines = [
    `# SEO Intel Actions — ${payload.project}`,
    '',
    `- Generated: ${payload.generatedAt || new Date().toISOString()}`,
    `- Scope: ${payload.scope || 'all'}`,
    `- Total actions: ${(payload.actions || []).length}`,
    `- Priority mix: critical ${payload.summary?.critical || 0}, high ${payload.summary?.high || 0}, medium ${payload.summary?.medium || 0}, low ${payload.summary?.low || 0}`,
    '',
    '## Summary',
    '',
    `- Critical: ${payload.summary?.critical || 0}`,
    `- High: ${payload.summary?.high || 0}`,
    `- Medium: ${payload.summary?.medium || 0}`,
    `- Low: ${payload.summary?.low || 0}`,
    '',
  ];

  const orderedAreas = ['technical', 'content', 'schema', 'structure', 'other'];
  for (const area of orderedAreas) {
    const items = grouped[area] || [];
    if (!items.length) continue;
    lines.push(`## ${area.charAt(0).toUpperCase() + area.slice(1)}`);
    lines.push('');
    for (const action of items) {
      lines.push(`### ${action.title}`);
      lines.push(`- ID: ${action.id}`);
      lines.push(`- Type: ${action.type}`);
      lines.push(`- Priority: ${action.priority}`);
      lines.push(`- Why: ${action.why}`);
      if (action.evidence?.length) {
        lines.push('- Evidence:');
        for (const item of action.evidence) lines.push(`  - ${item}`);
      }
      if (action.implementationHints?.length) {
        lines.push('- Implementation hints:');
        for (const item of action.implementationHints) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }

  if (!(payload.actions || []).length) {
    lines.push('## No actions found');
    lines.push('');
    lines.push('- The current dataset did not surface any qualifying actions for this scope.');
    lines.push('');
  }

  return lines.join('\n');
}

function getExportHistory() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(name => /-actions-.*\.(json|md)$/i.test(name))
    .map(name => {
      const match = name.match(/^(.*?)-actions-(.*)\.(json|md)$/i);
      return {
        name,
        project: match?.[1] || null,
        stamp: match?.[2] || null,
        format: (match?.[3] || '').toLowerCase(),
        url: `/reports/${name}`,
      };
    })
    .sort((a, b) => a.name < b.name ? 1 : -1);
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
};

// ── Read progress with PID liveness check (mirrors cli.js) ──
function readProgress() {
  try {
    if (!existsSync(PROGRESS_FILE)) return null;
    const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    if (data.status === 'running' && data.pid) {
      try { process.kill(data.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') {
          data.status = 'crashed';
          data.crashed_at = data.updated_at;
        }
      }
    }
    return data;
  } catch { return null; }
}

// ── Parse JSON body from request ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── JSON response helper ──
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Serve static file ──
function serveFile(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));
}

// ── Available project configs ──
function getProjects() {
  const configDir = join(__dirname, 'config');
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const cfg = JSON.parse(readFileSync(join(configDir, f), 'utf8'));
        return { project: cfg.project, domain: cfg.target?.domain };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── Request handler ──
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ─── Setup wizard routes ───
  if (path.startsWith('/setup') || path.startsWith('/api/setup/')) {
    try {
      const { handleSetupRequest } = await import('./setup/web-routes.js');
      if (handleSetupRequest(req, res, url)) return;
    } catch (err) {
      console.error('Setup route error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Setup wizard error: ' + err.message);
      return;
    }
  }

  // ─── Dashboard: auto-generate and serve ───
  if (req.method === 'GET' && path === '/') {
    // Debug: ?tier=free simulates free tier dashboard
    const forceFree = url.searchParams.get('tier') === 'free';

    try {
      const configDir = join(__dirname, 'config');
      const configFiles = existsSync(configDir)
        ? readdirSync(configDir).filter(f => f.endsWith('.json') && f !== 'example.json' && !f.startsWith('setup'))
        : [];

      if (!configFiles.length) {
        console.log('[dashboard] No config files found in', configDir);
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return;
      }
      console.log('[dashboard] Found configs:', configFiles.join(', '), forceFree ? '(tier=free)' : '');

      const { getDb } = await import('./db/db.js');
      const db = getDb(join(__dirname, 'seo-intel.db'));

      // Load all configs that have crawl data
      const activeConfigs = [];
      for (const file of configFiles) {
        const config = JSON.parse(readFileSync(join(configDir, file), 'utf8'));
        const project = file.replace('.json', '');
        const pageCount = db.prepare('SELECT COUNT(*) as c FROM pages p JOIN domains d ON d.id=p.domain_id WHERE d.project=?').get(project)?.c || 0;
        if (pageCount > 0) activeConfigs.push(config);
      }

      if (!activeConfigs.length) {
        // Projects configured but no crawl data yet — send to wizard
        console.log('[dashboard] No active configs with crawl data');
        res.writeHead(302, { Location: '/setup' });
        res.end();
        return;
      }
      console.log('[dashboard] Active projects:', activeConfigs.map(c => c.project).join(', '));

      if (forceFree) {
        process.env.SEO_INTEL_FORCE_FREE = '1';
        const { _resetLicenseCache } = await import('./lib/license.js');
        _resetLicenseCache();
      }

      // Always generate fresh — one dashboard for all projects (1 or many)
      const { generateMultiDashboard } = await import('./reports/generate-html.js');
      const outPath = generateMultiDashboard(db, activeConfigs);

      if (forceFree) {
        delete process.env.SEO_INTEL_FORCE_FREE;
        const { _resetLicenseCache } = await import('./lib/license.js');
        _resetLicenseCache();
      }
      serveFile(res, outPath);
    } catch (err) {
      console.error('[dashboard] Generation error:', err.message);
      // Generation failed — try serving a cached dashboard
      const allDash = join(REPORTS_DIR, 'all-projects-dashboard.html');
      if (existsSync(allDash)) { serveFile(res, allDash); return; }
      const htmlFiles = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter(f => f.endsWith('-dashboard.html')) : [];
      if (htmlFiles.length) { serveFile(res, join(REPORTS_DIR, htmlFiles[0])); return; }
      res.writeHead(302, { Location: '/setup' });
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && path.startsWith('/reports/')) {
    const fileName = path.replace('/reports/', '');
    if (fileName.includes('..') || fileName.includes('/')) { res.writeHead(400); res.end('Bad path'); return; }
    serveFile(res, join(REPORTS_DIR, fileName));
    return;
  }

  // ─── API: Get progress ───
  if (req.method === 'GET' && path === '/api/progress') {
    const progress = readProgress();
    json(res, 200, progress || { status: 'idle' });
    return;
  }

  // ─── API: Get projects ───
  if (req.method === 'GET' && path === '/api/projects') {
    json(res, 200, getProjects());
    return;
  }

  // ─── API: Crawl ───
  if (req.method === 'POST' && path === '/api/crawl') {
    try {
      const body = await readBody(req);
      const { project, stealth } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      // Conflict guard
      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'crawl', project];
      if (stealth) args.push('--stealth');

      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'crawl', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Extract ───
  if (req.method === 'POST' && path === '/api/extract') {
    try {
      const body = await readBody(req);
      const { project } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      // Conflict guard
      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'extract', project];

      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'extract', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }


  // ─── API: Stop running job ───
  // ─── API: Update check ───
  if (req.method === 'GET' && path === '/api/update-check') {
    try {
      const info = await getUpdateInfo();
      json(res, 200, info);
    } catch (e) {
      json(res, 200, { hasUpdate: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/stop') {
    try {
      const progress = readProgress();
      if (!progress || !progress.pid) {
        json(res, 404, { error: 'No running job to stop' });
        return;
      }

      // Check if process is actually alive
      let isAlive = false;
      try { process.kill(progress.pid, 0); isAlive = true; } catch { isAlive = false; }

      if (isAlive) {
        try {
          // Graceful: SIGTERM lets the CLI close browsers / write progress
          process.kill(progress.pid, 'SIGTERM');
          // Escalate: SIGKILL after 5s if still alive (stealth browser cleanup needs time)
          setTimeout(() => {
            try { process.kill(progress.pid, 0); } catch { return; } // already dead
            try { process.kill(progress.pid, 'SIGKILL'); } catch {}
          }, 5000);
        } catch (e) {
          if (e.code !== 'ESRCH') throw e;
        }
      }

      // Update progress file — clears both running and crashed states
      try {
        writeFileSync(PROGRESS_FILE, JSON.stringify({
          ...progress,
          status: isAlive ? 'stopped' : 'crashed_cleared',
          stopped_at: Date.now(),
          updated_at: Date.now(),
        }, null, 2));
      } catch { /* best-effort */ }
      json(res, 200, { stopped: true, pid: progress.pid, command: progress.command, wasAlive: isAlive });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Restart — kill running jobs + restart server ───
  if (req.method === 'POST' && path === '/api/restart') {
    try {
      // 1. Kill any running job
      const progress = readProgress();
      if (progress?.status === 'running' && progress.pid) {
        try { process.kill(progress.pid, 'SIGTERM'); } catch {}
        try {
          writeFileSync(PROGRESS_FILE, JSON.stringify({
            ...progress, status: 'stopped', stopped_at: Date.now(), updated_at: Date.now(),
          }, null, 2));
        } catch {}
      }
      json(res, 200, { restarting: true });

      // 2. Restart the server process after response is sent
      setTimeout(() => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
          cwd: __dirname,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, SEO_INTEL_AUTO_OPEN: '0' },
        });
        child.unref();
        process.exit(0);
      }, 300);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Export actions ───
  if (req.method === 'POST' && path === '/api/export-actions') {
    try {
      const body = await readBody(req);
      const { project } = body;
      const scope = ['technical', 'competitive', 'suggestive', 'all'].includes(body.scope) ? body.scope : 'all';
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'export-actions', project, '--scope', scope, '--format', 'json'];
      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => { json(res, 500, { error: err.message }); });
      child.on('close', code => {
        if (res.writableEnded) return;
        if (code !== 0) {
          json(res, 500, { error: (stderr || stdout || `export-actions exited with code ${code}`).trim() });
          return;
        }

        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        const rawJson = jsonStart >= 0 && jsonEnd >= jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : stdout.trim();

        try {
          const data = JSON.parse(rawJson);
          const stamp = new Date().toISOString().slice(0, 10);
          const baseName = `${project}-actions-${stamp}`;
          writeFileSync(join(REPORTS_DIR, `${baseName}.json`), JSON.stringify(data, null, 2), 'utf8');
          writeFileSync(join(REPORTS_DIR, `${baseName}.md`), buildActionsMarkdown(data), 'utf8');
          json(res, 200, { success: true, data });
        } catch (err) {
          json(res, 500, {
            error: 'Failed to parse export output',
            details: err.message,
            output: stdout.trim(),
            stderr: stderr.trim(),
          });
        }
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Export history ───
  if (req.method === 'GET' && path === '/api/export-history') {
    json(res, 200, { success: true, items: getExportHistory() });
    return;
  }

  // ─── API: License status ───
  if (req.method === 'GET' && path === '/api/license-status') {
    try {
      const { loadLicense, activateLicense } = await import('./lib/license.js');
      let license = loadLicense();
      if (license.needsActivation) {
        license = await activateLicense();
      }
      json(res, 200, {
        tier: license.tier || 'free',
        valid: license.active || false,
        key: license.key ? license.key.slice(0, 7) + '...' + license.key.slice(-4) : null,
        source: license.source || null,
      });
    } catch (err) {
      json(res, 200, { tier: 'free', valid: false, key: null, source: null });
    }
    return;
  }

  // ─── API: Save license key ───
  if (req.method === 'POST' && path === '/api/save-license') {
    try {
      const body = await readBody(req);
      const { key } = body;
      if (!key || typeof key !== 'string') { json(res, 400, { error: 'No key provided' }); return; }

      const envPath = join(__dirname, '.env');
      let envContent = '';
      if (existsSync(envPath)) {
        envContent = readFileSync(envPath, 'utf8');
      }

      const envVar = 'SEO_INTEL_LICENSE';

      // Remove existing license line
      const lines = envContent.split('\n').filter(l =>
        !l.startsWith('SEO_INTEL_LICENSE=')
      );
      lines.push(`${envVar}=${key}`);

      writeFileSync(envPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8');

      // Set in process.env so activation picks it up
      process.env[envVar] = key;

      // Clear cache and re-validate
      const { clearLicenseCache, activateLicense } = await import('./lib/license.js');
      clearLicenseCache();
      const license = await activateLicense();

      json(res, 200, {
        ok: true,
        tier: license.tier || 'free',
        valid: license.active || false,
      });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ─── API: Update insight status (Intelligence Ledger) ───
  const insightMatch = path.match(/^\/api\/insights\/(\d+)\/status$/);
  if (req.method === 'POST' && insightMatch) {
    try {
      const id = parseInt(insightMatch[1]);
      const body = await readBody(req);
      const status = body.status;
      if (!['active', 'done', 'dismissed'].includes(status)) {
        json(res, 400, { error: 'Invalid status. Use: active, done, dismissed' });
        return;
      }
      const { getDb, updateInsightStatus } = await import('./db/db.js');
      const db = getDb();
      updateInsightStatus(db, id, status);
      json(res, 200, { success: true, id, status });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Analyze (spawn background) ───
  if (req.method === 'POST' && path === '/api/analyze') {
    try {
      const body = await readBody(req);
      const { project } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'analyze', project];
      const child = spawn(process.execPath, args, {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      json(res, 202, { started: true, pid: child.pid, command: 'analyze', project });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: Universal Export Download ───
  if (req.method === 'GET' && path === '/api/export/download') {
    try {
      const project = url.searchParams.get('project');
      const section = url.searchParams.get('section') || 'all';
      const format = url.searchParams.get('format') || 'json';

      if (!project || !/^[a-z0-9_-]+$/i.test(project)) { json(res, 400, { error: 'Invalid project name' }); return; }

      const { getDb } = await import('./db/db.js');
      const { gatherProjectData } = await import('./reports/generate-html.js');
      const db = getDb(join(__dirname, 'seo-intel.db'));
      const configPath = join(__dirname, 'config', `${project}.json`);
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
      if (!config) { json(res, 404, { error: `Project config not found: ${project}` }); return; }

      const dateStr = new Date().toISOString().slice(0, 10);
      const { createZip } = await import('./lib/export-zip.js');

      // ── Gather dashboard data — same source as the HTML dashboard ──
      const dash = gatherProjectData(db, project, config);

      // ── Build unified export from dashboard data ──
      function buildDashboardExport(dash) {
        const a = dash.latestAnalysis || {};
        const sections = {};

        // ── Status: scorecard + crawl ──
        const target = dash.technicalScores?.find(d => d.isTarget);
        if (target) {
          sections.technical = {
            score: target.score,
            h1_coverage: target.h1Pct + '%',
            meta_coverage: target.metaPct + '%',
            schema_coverage: target.schemaPct + '%',
            title_coverage: target.titlePct + '%',
          };
        }

        // ── Site Watch ──
        if (dash.watchData?.events?.length) {
          const critical = dash.watchData.events.filter(e => e.severity === 'error' || e.severity === 'warning');
          if (critical.length) sections.watch_alerts = critical;
          if (dash.watchData.snapshot) {
            sections.watch_summary = {
              health_score: dash.watchData.snapshot.health_score,
              errors: dash.watchData.snapshot.errors_count,
              warnings: dash.watchData.snapshot.warnings_count,
            };
          }
        }

        // ── Fix Now: technical gaps + quick wins ──
        if (a.technical_gaps?.length) sections.technical_gaps = a.technical_gaps;
        if (a.quick_wins?.length) sections.quick_wins = a.quick_wins;

        // ── Content Strategy: keywords, gaps, new pages, positioning ──
        if (a.keyword_gaps?.length) sections.keyword_gaps = a.keyword_gaps;
        if (dash.keywordGaps?.length) sections.top_keyword_gaps = dash.keywordGaps.slice(0, 50);
        if (a.long_tails?.length) sections.long_tails = a.long_tails;
        if (a.new_pages?.length) sections.new_pages = a.new_pages;
        if (a.content_gaps?.length) sections.content_gaps = a.content_gaps;
        if (a.positioning) sections.positioning = a.positioning;

        // ── AI Citability ──
        if (dash.citabilityData?.scores?.length) {
          const own = dash.citabilityData.scores.filter(s => s.role === 'target' || s.role === 'owned');
          const needsWork = own.filter(s => s.score < 60);
          if (needsWork.length) sections.citability_low_scores = needsWork;
          sections.citability_summary = {
            avg_score: own.length ? Math.round(own.reduce((a, s) => a + s.score, 0) / own.length) : null,
            pages_scored: own.length,
            pages_below_60: needsWork.length,
          };
        }

        // ── Reference: internal links, schema types, keyword ideas ──
        if (dash.internalLinks) {
          sections.internal_links = {
            total_links: dash.internalLinks.totalLinks,
            orphan_pages: dash.internalLinks.orphanCount,
            top_pages: dash.internalLinks.topPages,
          };
        }
        if (dash.schemaBreakdown?.length) {
          const tgt = dash.schemaBreakdown.find(d => d.isTarget);
          if (tgt?.types?.length) sections.schema_types = tgt.types;
        }
        if (a.keyword_inventor?.length) sections.keyword_inventor = a.keyword_inventor;

        // ── Crawl Stats ──
        sections.crawl_stats = dash.crawlStats;

        return sections;
      }

      function dashboardToMarkdown(sections, proj) {
        const date = new Date().toISOString().slice(0, 10);
        let md = `# SEO Intel Report — ${proj}\n\n- Date: ${date}\n\n`;

        const s = sections;

        if (s.technical) {
          md += `## Technical Scorecard\n\n`;
          md += `- Overall: **${s.technical.score}/100**\n`;
          md += `- H1: ${s.technical.h1_coverage} | Meta: ${s.technical.meta_coverage} | Schema: ${s.technical.schema_coverage} | Title: ${s.technical.title_coverage}\n\n`;
        }
        if (s.technical_gaps?.length) {
          md += `## Technical Gaps (${s.technical_gaps.length})\n\n| Issue | Affected | Fix |\n|-------|----------|-----|\n`;
          for (const g of s.technical_gaps) md += `| ${g.gap || g.issue || ''} | ${g.affected || g.pages || ''} | ${g.recommendation || g.fix || ''} |\n`;
          md += '\n';
        }
        if (s.quick_wins?.length) {
          md += `## Quick Wins (${s.quick_wins.length})\n\n| Page | Issue | Fix | Impact |\n|------|-------|-----|--------|\n`;
          for (const w of s.quick_wins) md += `| ${w.page || ''} | ${w.issue || ''} | ${w.fix || ''} | ${w.impact || ''} |\n`;
          md += '\n';
        }
        if (s.internal_links) {
          md += `## Internal Links\n\n- Total links: ${s.internal_links.total_links}\n- Orphan pages: ${s.internal_links.orphan_pages}\n`;
          if (s.internal_links.top_pages?.length) {
            md += '\n| Page | Depth Score |\n|------|-------------|\n';
            for (const p of s.internal_links.top_pages) md += `| ${p.url || p.label} | ${p.count} |\n`;
          }
          md += '\n';
        }
        if (s.watch_summary) {
          md += `## Site Watch\n\n- Health: **${s.watch_summary.health_score ?? 'N/A'}** | Errors: ${s.watch_summary.errors} | Warnings: ${s.watch_summary.warnings}\n\n`;
        }
        if (s.watch_alerts?.length) {
          md += `### Alerts (${s.watch_alerts.length})\n\n| Type | Severity | URL | Details |\n|------|----------|-----|---------|\n`;
          for (const e of s.watch_alerts) md += `| ${e.event_type} | ${e.severity} | ${e.url || ''} | ${(e.details || '').slice(0, 80)} |\n`;
          md += '\n';
        }
        if (s.keyword_gaps?.length) {
          md += `## Keyword Gaps (${s.keyword_gaps.length})\n\n| Keyword | Your Coverage | Competitor Coverage |\n|---------|--------------|--------------------|\n`;
          for (const g of s.keyword_gaps) md += `| ${g.keyword || ''} | ${g.your_coverage || g.target_count || 'none'} | ${g.competitor_coverage || g.competitor_count || ''} |\n`;
          md += '\n';
        }
        if (s.top_keyword_gaps?.length) {
          md += `## Top Keyword Gaps\n\n| Keyword | Frequency | Your Count | Gap |\n|---------|-----------|------------|-----|\n`;
          for (const g of s.top_keyword_gaps) md += `| ${g.keyword || ''} | ${g.total || ''} | ${g.target || 0} | ${g.gap || ''} |\n`;
          md += '\n';
        }
        if (s.long_tails?.length) {
          md += `## Long-tail Opportunities (${s.long_tails.length})\n\n| Phrase | Parent | Opportunity |\n|-------|--------|-------------|\n`;
          for (const l of s.long_tails) md += `| ${l.phrase || ''} | ${l.parent || l.keyword || ''} | ${l.opportunity || l.rationale || ''} |\n`;
          md += '\n';
        }
        if (s.new_pages?.length) {
          md += `## New Pages to Create (${s.new_pages.length})\n\n| Title | Target Keyword | Rationale |\n|-------|----------------|----------|\n`;
          for (const p of s.new_pages) md += `| ${p.title || ''} | ${p.target_keyword || ''} | ${p.rationale || ''} |\n`;
          md += '\n';
        }
        if (s.content_gaps?.length) {
          md += `## Content Gaps (${s.content_gaps.length})\n\n| Topic | Gap | Suggestion |\n|-------|-----|------------|\n`;
          for (const g of s.content_gaps) md += `| ${g.topic || ''} | ${g.gap || ''} | ${g.suggestion || ''} |\n`;
          md += '\n';
        }
        if (s.keyword_inventor?.length) {
          md += `## Keyword Ideas (${s.keyword_inventor.length})\n\n| Phrase | Cluster | Potential |\n|-------|---------|----------|\n`;
          for (const k of s.keyword_inventor.slice(0, 50)) md += `| ${k.phrase || ''} | ${k.cluster || ''} | ${k.potential || k.volume || ''} |\n`;
          if (s.keyword_inventor.length > 50) md += `\n_...and ${s.keyword_inventor.length - 50} more._\n`;
          md += '\n';
        }
        if (s.positioning) {
          md += `## Positioning Strategy\n\n`;
          if (s.positioning.open_angle) md += `**Open angle:** ${s.positioning.open_angle}\n\n`;
          if (s.positioning.target_differentiator) md += `**Differentiator:** ${s.positioning.target_differentiator}\n\n`;
          if (s.positioning.competitor_map) md += `**Competitor map:** ${s.positioning.competitor_map}\n\n`;
        }
        if (s.citability_summary) {
          md += `## AI Citability\n\n- Average: **${s.citability_summary.avg_score ?? 'N/A'}/100** (${s.citability_summary.pages_scored} pages, ${s.citability_summary.pages_below_60} below 60)\n\n`;
        }
        if (s.citability_low_scores?.length) {
          md += `### Pages Needing Improvement\n\n| Score | URL | Tier |\n|-------|-----|------|\n`;
          for (const p of s.citability_low_scores) md += `| ${p.score} | ${p.url || ''} | ${p.tier || ''} |\n`;
          md += '\n';
        }
        if (s.schema_types?.length) {
          md += `## Schema Types (own site)\n\n| Type | Count |\n|------|-------|\n`;
          for (const t of s.schema_types) md += `| ${t.type || t.schema_type || ''} | ${t.count || ''} |\n`;
          md += '\n';
        }
        if (s.crawl_stats) {
          md += `## Crawl Info\n\n- Last crawl: ${s.crawl_stats.lastCrawl || 'N/A'}\n- Extracted pages: ${s.crawl_stats.extractedPages || 0}\n`;
        }

        return md;
      }

      function toCSV(obj) {
        // Flatten sections into CSV-friendly rows
        const rows = [];
        for (const [key, val] of Object.entries(obj)) {
          if (Array.isArray(val)) {
            for (const item of val) {
              rows.push({ section: key, ...item });
            }
          } else if (val && typeof val === 'object') {
            rows.push({ section: key, ...val });
          }
        }
        if (!rows.length) return '';
        const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const escape = (v) => {
          if (v == null) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
      }

      // ── Build and serve ──
      const sections = buildDashboardExport(dash);

      if (format === 'json') {
        const content = JSON.stringify({ project, date: dateStr, ...sections }, null, 2);
        const fileName = `${project}-${dateStr}.json`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content);
      } else if (format === 'md') {
        const content = dashboardToMarkdown(sections, project);
        const fileName = `${project}-${dateStr}.md`;
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content);
      } else if (format === 'csv') {
        const content = toCSV(sections);
        const fileName = `${project}-${dateStr}.csv`;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
        res.end(content || 'No data.');
      } else if (format === 'zip') {
        const entries = [];
        entries.push({ name: `${project}-${dateStr}.json`, content: JSON.stringify({ project, date: dateStr, ...sections }, null, 2) });
        entries.push({ name: `${project}-${dateStr}.md`, content: dashboardToMarkdown(sections, project) });
        const csv = toCSV(sections);
        if (csv) entries.push({ name: `${project}-${dateStr}.csv`, content: csv });
        const zipBuf = createZip(entries);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${project}-${dateStr}.zip"`, 'Content-Length': zipBuf.length });
        res.end(zipBuf);
      } else {
        json(res, 400, { error: 'Invalid format. Allowed: json, csv, md, zip' });
      }
    } catch (e) {
      console.error('[export/download]', e);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ─── API: SSE Terminal — stream command output ───
  if (req.method === 'GET' && path === '/api/terminal') {
    const params = url.searchParams;
    const command = params.get('command');
    const project = params.get('project') || '';
    if (project && !/^[a-z0-9_-]+$/i.test(project)) {
      json(res, 400, { error: 'Invalid project name' });
      return;
    }

    // Whitelist allowed commands
    const ALLOWED = ['crawl', 'extract', 'analyze', 'export-actions', 'competitive-actions',
      'suggest-usecases', 'html', 'status', 'brief', 'keywords', 'report', 'guide',
      'schemas', 'headings-audit', 'orphans', 'entities', 'friction', 'shallow', 'decay', 'export', 'templates',
      'aeo', 'blog-draft', 'gap-intel', 'watch'];

    if (!command || !ALLOWED.includes(command)) {
      json(res, 400, { error: `Invalid command. Allowed: ${ALLOWED.join(', ')}` });
      return;
    }

    // Build args
    const args = ['cli.js', command];
    if (project && command !== 'status' && command !== 'html') args.push(project);
    if (params.get('stealth') === 'true') args.push('--stealth');
    if (params.get('scope')) args.push('--scope', params.get('scope'));
    if (params.get('format')) args.push('--format', params.get('format'));
    if (params.get('topic')) args.push('--topic', params.get('topic'));
    if (params.get('lang')) args.push('--lang', params.get('lang'));
    if (params.get('model')) args.push('--model', params.get('model'));
    if (params.has('save')) args.push('--save');
    if (params.get('vs')) args.push('--vs', params.get('vs'));
    if (params.get('type')) args.push('--type', params.get('type'));
    if (params.get('limit')) args.push('--limit', params.get('limit'));
    if (params.has('raw')) args.push('--raw');
    // --out is NOT passed from dashboard — write paths are server-controlled only (see auto-save below)

    // Auto-save exports from dashboard to reports/
    const EXPORT_CMDS = ['export-actions', 'suggest-usecases', 'competitive-actions'];
    if (EXPORT_CMDS.includes(command) && project) {
      const scope = params.get('scope') || 'all';
      const ts = new Date().toISOString().slice(0, 10);
      const slug = command === 'suggest-usecases' ? 'suggestions' : scope;
      const outFile = join(__dirname, 'reports', `${project}-${slug}-${ts}.md`);
      args.push('--output', outFile);
      args.push('--format', 'brief');
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    const isLongRunning = ['crawl', 'extract'].includes(command);

    send('start', { command, project, args: args.slice(1) });

    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      // Crawl/extract: detach so they survive SSE disconnect
      ...(isLongRunning ? { detached: true } : {}),
    });

    let clientClosed = false;

    child.stdout.on('data', chunk => {
      if (clientClosed) return;
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line) send('stdout', line);
      }
    });

    child.stderr.on('data', chunk => {
      if (clientClosed) return;
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line) send('stderr', line);
      }
    });

    child.on('error', err => {
      if (!clientClosed) { send('error', err.message); res.end(); }
    });

    child.on('close', code => {
      if (!clientClosed) { send('exit', { code }); res.end(); }
    });

    // Client disconnect: kill short commands, let crawl/extract continue
    req.on('close', () => {
      clientClosed = true;
      if (isLongRunning) {
        // Detach — crawl/extract keeps running, progress file tracks it
        child.unref();
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
      } else {
        if (!child.killed) child.kill();
      }
    });

    return;
  }

  // ─── Favicon ───
  if (req.method === 'GET' && (path === '/favicon.ico' || path === '/favicon.png')) {
    const faviconPath = join(__dirname, 'seo-intel.png');
    if (existsSync(faviconPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(readFileSync(faviconPath));
    } else {
      res.writeHead(204); res.end();
    }
    return;
  }

  // ─── 404 ───
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ─── Start server ───
const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Server error:', err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  });
});

// Start background update check
checkForUpdates();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  ⚠️  Port ${PORT} is already in use — opening existing dashboard…\n`);
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${cmd} "${url}"`));
    setTimeout(() => process.exit(0), 500);
  } else {
    throw err;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SEO Intel Dashboard Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /              → Dashboard`);
  console.log(`    GET  /setup         → Setup Wizard`);
  console.log(`    GET  /api/progress  → Live extraction progress`);
  console.log(`    GET  /api/projects  → Available projects`);
  console.log(`    GET  /api/export-history → List saved action exports`);
  console.log(`    POST /api/crawl     → Start crawl { project, stealth? }`);
  console.log(`    POST /api/extract   → Start extract { project, stealth? }`);
  console.log(`    POST /api/export-actions → Run export-actions { project, scope }`);
  console.log(`    GET  /api/terminal  → SSE command streaming\n`);

  // Auto-open browser if requested
  if (process.env.SEO_INTEL_AUTO_OPEN === '1') {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${cmd} "${url}"`));
  }
});
