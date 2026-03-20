import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PROGRESS_FILE = join(__dirname, '.extraction-progress.json');
const REPORTS_DIR = join(__dirname, 'reports');

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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

  if (req.method === 'GET' && path.startsWith('/reports/') && path.endsWith('.html')) {
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
      const { project, stealth } = body;
      if (!project) { json(res, 400, { error: 'Missing project' }); return; }

      // Conflict guard
      const progress = readProgress();
      if (progress?.status === 'running') {
        json(res, 409, { error: 'Job already running', progress });
        return;
      }

      const args = ['cli.js', 'extract', project];
      if (stealth) args.push('--stealth');

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

      // Determine key type
      const isFroggo = key.startsWith('FROGGO_') || key.length > 60;
      const envVar = isFroggo ? 'FROGGO_TOKEN' : 'SEO_INTEL_LICENSE';

      // Remove existing lines for both key types
      const lines = envContent.split('\n').filter(l =>
        !l.startsWith('SEO_INTEL_LICENSE=') && !l.startsWith('FROGGO_TOKEN=')
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SEO Intel Dashboard Server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /              → Dashboard`);
  console.log(`    GET  /setup         → Setup Wizard`);
  console.log(`    GET  /api/progress  → Live extraction progress`);
  console.log(`    GET  /api/projects  → Available projects`);
  console.log(`    POST /api/crawl     → Start crawl { project, stealth? }`);
  console.log(`    POST /api/extract   → Start extract { project, stealth? }\n`);
});
