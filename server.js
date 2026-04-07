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

      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      const { getDb } = await import('./db/db.js');
      const db = getDb(join(__dirname, 'seo-intel.db'));
      const configPath = join(__dirname, 'config', `${project}.json`);
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;

      const dateStr = new Date().toISOString().slice(0, 10);
      const { createZip } = await import('./lib/export-zip.js');

      const SECTIONS = ['aeo', 'insights', 'technical', 'keywords', 'pages', 'watch', 'schemas', 'headings', 'links'];

      function querySection(sec) {
        switch (sec) {
          case 'aeo': {
            try {
              return db.prepare(`
                SELECT cs.score, cs.entity_authority, cs.structured_claims, cs.answer_density,
                       cs.qa_proximity, cs.freshness, cs.schema_coverage, cs.tier, cs.ai_intents,
                       p.url, p.title, p.word_count, d.domain, d.role
                FROM citability_scores cs
                JOIN pages p ON p.id = cs.page_id
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                ORDER BY d.role ASC, cs.score ASC
              `).all(project);
            } catch { return []; }
          }
          case 'insights': {
            try {
              const rows = db.prepare(
                `SELECT * FROM insights WHERE project = ? AND status = 'active' ORDER BY type, last_seen DESC`
              ).all(project);
              return rows.map(r => {
                try { return { ...JSON.parse(r.data), _type: r.type, _id: r.id, _first_seen: r.first_seen, _last_seen: r.last_seen }; }
                catch { return { _type: r.type, _id: r.id, raw: r.data }; }
              });
            } catch { return []; }
          }
          case 'technical': {
            try {
              return db.prepare(`
                SELECT p.url, p.status_code, p.word_count, p.load_ms, p.is_indexable, p.click_depth,
                       t.has_canonical, t.has_og_tags, t.has_schema, t.has_robots, t.is_mobile_ok,
                       d.domain, d.role
                FROM pages p
                JOIN domains d ON d.id = p.domain_id
                LEFT JOIN technical t ON t.page_id = p.id
                WHERE d.project = ?
                ORDER BY d.domain, p.url
              `).all(project);
            } catch { return []; }
          }
          case 'keywords': {
            try {
              return db.prepare(`
                SELECT k.keyword, d.domain, d.role, k.location, COUNT(*) as freq
                FROM keywords k
                JOIN pages p ON p.id = k.page_id
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                GROUP BY k.keyword, d.domain
                ORDER BY freq DESC
              `).all(project);
            } catch { return []; }
          }
          case 'pages': {
            try {
              return db.prepare(`
                SELECT p.url, p.status_code, p.word_count, p.load_ms, p.is_indexable, p.click_depth,
                       p.title, p.meta_desc, p.published_date, p.modified_date,
                       p.crawled_at, p.first_seen_at, d.domain, d.role
                FROM pages p
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                ORDER BY d.domain, p.url
              `).all(project);
            } catch { return []; }
          }
          case 'watch': {
            try {
              const snap = db.prepare('SELECT * FROM watch_snapshots WHERE project = ? ORDER BY created_at DESC LIMIT 1').get(project);
              if (!snap) return [];
              const events = db.prepare('SELECT * FROM watch_events WHERE snapshot_id = ? ORDER BY severity, event_type').all(snap.id);
              const pages = db.prepare('SELECT * FROM watch_page_states WHERE snapshot_id = ?').all(snap.id);
              return { snapshot: snap, events, pages };
            } catch { return []; }
          }
          case 'schemas': {
            try {
              return db.prepare(`
                SELECT d.domain, d.role, p.url, ps.schema_type, ps.name, ps.description,
                       ps.rating, ps.rating_count, ps.price, ps.currency, ps.author,
                       ps.date_published, ps.date_modified
                FROM page_schemas ps
                JOIN pages p ON p.id = ps.page_id
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                ORDER BY d.domain, ps.schema_type
              `).all(project);
            } catch { return []; }
          }
          case 'headings': {
            try {
              return db.prepare(`
                SELECT d.domain, d.role, p.url, h.level, h.text
                FROM headings h
                JOIN pages p ON p.id = h.page_id
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                ORDER BY d.domain, p.url, h.level
              `).all(project);
            } catch { return []; }
          }
          case 'links': {
            try {
              return db.prepare(`
                SELECT l.source_page_id, l.target_url, l.anchor_text, l.is_internal,
                       p.url as source_url, d.domain, d.role
                FROM links l
                JOIN pages p ON p.id = l.source_page_id
                JOIN domains d ON d.id = p.domain_id
                WHERE d.project = ?
                ORDER BY d.domain, p.url
              `).all(project);
            } catch { return []; }
          }
          default: return [];
        }
      }

      function toCSV(rows) {
        if (!rows || (Array.isArray(rows) && !rows.length)) return '';
        const arr = Array.isArray(rows) ? rows : (rows.events || rows.pages || []);
        if (!arr.length) return '';
        const keys = Object.keys(arr[0]);
        const escape = (v) => {
          if (v == null) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [keys.join(','), ...arr.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
      }

      function toMarkdown(sec, data, proj) {
        const date = new Date().toISOString().slice(0, 10);
        const header = `# SEO Intel — ${sec.charAt(0).toUpperCase() + sec.slice(1)} Export\n\n- Project: ${proj}\n- Date: ${date}\n\n`;
        if (!data || (Array.isArray(data) && !data.length)) return header + '_No data available._\n';

        switch (sec) {
          case 'aeo': {
            const targetRows = data.filter(r => r.role === 'target' || r.role === 'owned');
            const avg = targetRows.length ? Math.round(targetRows.reduce((a, r) => a + r.score, 0) / targetRows.length) : 0;
            let md = header + `## Summary\n\n- Pages scored: ${data.length}\n- Target average: ${avg}/100\n\n`;
            md += '## Page Scores\n\n| Score | Tier | URL | Title | Weakest Signals |\n|-------|------|-----|-------|-----------------|\n';
            for (const r of data) {
              const signals = ['entity_authority', 'structured_claims', 'answer_density', 'qa_proximity', 'freshness', 'schema_coverage'];
              const weakest = signals.sort((a, b) => (r[a] || 0) - (r[b] || 0)).slice(0, 2).map(s => s.replace(/_/g, ' ')).join(', ');
              md += `| ${r.score} | ${r.tier} | ${r.url} | ${(r.title || '').slice(0, 50)} | ${weakest} |\n`;
            }
            return md;
          }
          case 'insights': {
            let md = header + `## Active Insights (${data.length})\n\n`;
            const grouped = {};
            for (const r of data) { (grouped[r._type] ||= []).push(r); }
            for (const [type, items] of Object.entries(grouped)) {
              md += `### ${type.replace(/_/g, ' ')} (${items.length})\n\n`;
              for (const item of items) {
                const desc = item.phrase || item.keyword || item.title || item.page || item.message || JSON.stringify(item).slice(0, 120);
                md += `- ${desc}\n`;
              }
              md += '\n';
            }
            return md;
          }
          case 'technical': {
            let md = header + '## Technical Audit\n\n| URL | Status | Words | Load ms | Canonical | OG | Schema | Robots | Mobile |\n|-----|--------|-------|---------|-----------|-----|--------|--------|--------|\n';
            for (const r of data) {
              md += `| ${r.url} | ${r.status_code} | ${r.word_count || 0} | ${r.load_ms || 0} | ${r.has_canonical ? 'Y' : 'N'} | ${r.has_og_tags ? 'Y' : 'N'} | ${r.has_schema ? 'Y' : 'N'} | ${r.has_robots ? 'Y' : 'N'} | ${r.is_mobile_ok ? 'Y' : 'N'} |\n`;
            }
            return md;
          }
          case 'keywords': {
            let md = header + '## Keyword Matrix\n\n| Keyword | Domain | Role | Location | Frequency |\n|---------|--------|------|----------|-----------|\n';
            for (const r of data.slice(0, 500)) {
              md += `| ${r.keyword} | ${r.domain} | ${r.role} | ${r.location || ''} | ${r.freq} |\n`;
            }
            if (data.length > 500) md += `\n_...and ${data.length - 500} more rows._\n`;
            return md;
          }
          case 'pages': {
            let md = header + '## Crawled Pages\n\n| URL | Status | Words | Title | Domain | Role |\n|-----|--------|-------|-------|--------|------|\n';
            for (const r of data) {
              md += `| ${r.url} | ${r.status_code} | ${r.word_count || 0} | ${(r.title || '').slice(0, 50)} | ${r.domain} | ${r.role} |\n`;
            }
            return md;
          }
          case 'watch': {
            const snap = data.snapshot || {};
            const events = data.events || [];
            let md = header + `## Site Watch Snapshot\n\n- Health score: ${snap.health_score ?? 'N/A'}\n- Pages: ${snap.total_pages || 0}\n- Errors: ${snap.errors_count || 0} | Warnings: ${snap.warnings_count || 0} | Notices: ${snap.notices_count || 0}\n\n`;
            if (events.length) {
              md += '## Events\n\n| Type | Severity | URL | Details |\n|------|----------|-----|---------|\n';
              for (const e of events) {
                md += `| ${e.event_type} | ${e.severity} | ${e.url} | ${(e.details || '').slice(0, 80)} |\n`;
              }
            }
            return md;
          }
          case 'schemas': {
            let md = header + '## Schema Markup\n\n| Domain | URL | Type | Name | Rating | Price |\n|--------|-----|------|------|--------|-------|\n';
            for (const r of data) {
              md += `| ${r.domain} | ${r.url} | ${r.schema_type} | ${(r.name || '').slice(0, 40)} | ${r.rating || ''} | ${r.price ? r.currency + r.price : ''} |\n`;
            }
            return md;
          }
          case 'headings': {
            let md = header + '## Heading Structure\n\n| Domain | URL | Level | Text |\n|--------|-----|-------|------|\n';
            for (const r of data.slice(0, 1000)) {
              md += `| ${r.domain} | ${r.url} | H${r.level} | ${(r.text || '').slice(0, 80)} |\n`;
            }
            if (data.length > 1000) md += `\n_...and ${data.length - 1000} more rows._\n`;
            return md;
          }
          case 'links': {
            let md = header + '## Internal Links\n\n| Source | Target | Anchor |\n|--------|--------|--------|\n';
            for (const r of data.filter(l => l.is_internal).slice(0, 1000)) {
              md += `| ${r.source_url} | ${r.target_url} | ${(r.anchor_text || '').slice(0, 50)} |\n`;
            }
            if (data.length > 1000) md += `\n_...and more rows._\n`;
            return md;
          }
          default: {
            return header + '```json\n' + JSON.stringify(data, null, 2).slice(0, 10000) + '\n```\n';
          }
        }
      }

      // Build response based on section + format
      const sections = section === 'all' ? SECTIONS : [section];
      if (section !== 'all' && !SECTIONS.includes(section)) {
        json(res, 400, { error: `Invalid section. Allowed: ${SECTIONS.join(', ')}, all` });
        return;
      }

      if (format === 'zip') {
        // ZIP: bundle all requested sections in all formats
        const entries = [];
        for (const sec of sections) {
          const data = querySection(sec);
          const baseName = `${project}-${sec}-${dateStr}`;
          entries.push({ name: `${baseName}.json`, content: JSON.stringify(data, null, 2) });
          entries.push({ name: `${baseName}.md`, content: toMarkdown(sec, data, project) });
          const csv = toCSV(data);
          if (csv) entries.push({ name: `${baseName}.csv`, content: csv });
        }
        const zipBuf = createZip(entries);
        const zipName = section === 'all' ? `${project}-full-export-${dateStr}.zip` : `${project}-${section}-${dateStr}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'Content-Length': zipBuf.length,
        });
        res.end(zipBuf);
      } else if (format === 'json') {
        const data = querySection(sections[0]);
        const fileName = `${project}-${sections[0]}-${dateStr}.json`;
        const content = JSON.stringify(data, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
      } else if (format === 'csv') {
        const data = querySection(sections[0]);
        const fileName = `${project}-${sections[0]}-${dateStr}.csv`;
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(toCSV(data));
      } else if (format === 'md') {
        const data = querySection(sections[0]);
        const fileName = `${project}-${sections[0]}-${dateStr}.md`;
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(toMarkdown(sections[0], data, project));
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
    if (params.get('out')) args.push('--out', params.get('out'));

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
