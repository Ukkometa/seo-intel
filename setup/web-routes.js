/**
 * SEO Intel — Web Setup Routes
 *
 * HTTP API endpoints for the web-based setup wizard.
 * Uses raw http (no Express) to match the existing server.js pattern.
 * Long-running operations (install, validate) use SSE for streaming.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  fullSystemCheck,
  checkGscData,
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
  writeEnvKey,
  validateConfig,
} from './engine.js';

import { getCurrentVersion, getUpdateInfo, checkForUpdates } from '../lib/updater.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WIZARD_HTML = join(__dirname, 'wizard.html');

// ── CORS / JSON helpers ─────────────────────────────────────────────────────

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ── Route Handler ───────────────────────────────────────────────────────────

/**
 * Handle setup-related HTTP requests.
 * Returns true if the request was handled, false to pass through.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @returns {boolean}
 */
export function handleSetupRequest(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS' && path.startsWith('/api/setup/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  // GET /setup — serve wizard HTML
  if ((path === '/setup' || path === '/setup/') && method === 'GET') {
    serveWizardHtml(res);
    return true;
  }

  // GET /api/setup/status — full system check
  if (path === '/api/setup/status' && method === 'GET') {
    handleStatus(req, res);
    return true;
  }

  // GET /api/setup/models — model recommendations
  if (path === '/api/setup/models' && method === 'GET') {
    handleModels(req, res);
    return true;
  }

  // POST /api/setup/install — install dependencies (SSE)
  if (path === '/api/setup/install' && method === 'POST') {
    handleInstall(req, res);
    return true;
  }

  // GET /api/setup/ping-ollama?host=... — ping a remote Ollama host
  if (path === '/api/setup/ping-ollama' && method === 'GET') {
    handlePingOllama(req, res);
    return true;
  }

  // POST /api/setup/save-env — save a key to .env
  if (path === '/api/setup/save-env' && method === 'POST') {
    handleSaveEnv(req, res);
    return true;
  }

  // POST /api/setup/env — update .env keys
  if (path === '/api/setup/env' && method === 'POST') {
    handleEnv(req, res);
    return true;
  }

  // GET /api/setup/config/:project — read existing project config
  if (path.startsWith('/api/setup/config/') && method === 'GET') {
    const projectName = decodeURIComponent(path.split('/').pop());
    try {
      const configPath = join(ROOT, 'config', `${projectName}.json`);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      jsonResponse(res, config);
    } catch (err) {
      jsonResponse(res, { error: 'Config not found: ' + projectName }, 404);
    }
    return true;
  }

  // POST /api/setup/config — create project config
  if (path === '/api/setup/config' && method === 'POST') {
    handleConfig(req, res);
    return true;
  }

  // POST /api/setup/test-pipeline — run validation (SSE)
  if (path === '/api/setup/test-pipeline' && method === 'POST') {
    handleTestPipeline(req, res);
    return true;
  }

  // GET /api/setup/gsc — check GSC data status
  if (path === '/api/setup/gsc' && method === 'GET') {
    handleGscStatus(req, res, url);
    return true;
  }

  // POST /api/setup/gsc/upload — upload GSC CSV files
  if (path === '/api/setup/gsc/upload' && method === 'POST') {
    handleGscUpload(req, res);
    return true;
  }

  // POST /api/setup/dashboard/restart — soft restart / reload hint for dashboard UI
  if (path === '/api/setup/dashboard/restart' && method === 'POST') {
    handleDashboardRestart(res);
    return true;
  }

  // GET /api/setup/version — current version + update info
  if (path === '/api/setup/version' && method === 'GET') {
    handleVersion(req, res);
    return true;
  }

  // GET /api/setup/projects — list all projects
  if (path === '/api/setup/projects' && method === 'GET') {
    handleListProjects(res);
    return true;
  }

  // GET /api/setup/projects/:project — get project config
  if (path.match(/^\/api\/setup\/projects\/[^/]+$/) && method === 'GET') {
    const project = path.split('/').pop();
    handleGetProject(res, project);
    return true;
  }

  // PATCH /api/setup/projects/:project/competitors — add/remove competitors
  if (path.match(/^\/api\/setup\/projects\/[^/]+\/competitors$/) && method === 'PATCH') {
    const project = path.split('/')[4];
    handleUpdateCompetitors(req, res, project);
    return true;
  }

  // GET /api/setup/auth/status — all OAuth connection statuses
  if (path === '/api/setup/auth/status' && method === 'GET') {
    handleAuthStatus(res);
    return true;
  }

  // GET /api/setup/auth/:provider/url — get OAuth authorization URL
  if (path.match(/^\/api\/setup\/auth\/[^/]+\/url$/) && method === 'GET') {
    const provider = path.split('/')[4];
    handleAuthUrl(res, provider);
    return true;
  }

  // POST /api/setup/auth/:provider/callback — exchange OAuth code for tokens
  if (path.match(/^\/api\/setup\/auth\/[^/]+\/callback$/) && method === 'POST') {
    const provider = path.split('/')[4];
    handleAuthCallback(req, res, provider);
    return true;
  }

  // DELETE /api/setup/auth/:provider — disconnect provider
  if (path.match(/^\/api\/setup\/auth\/[^/]+$/) && method === 'DELETE') {
    const provider = path.split('/')[4];
    handleAuthDisconnect(res, provider);
    return true;
  }

  // POST /api/setup/agent/chat — agent-powered setup chat
  if (path === '/api/setup/agent/chat' && method === 'POST') {
    handleAgentChat(req, res);
    return true;
  }

  return false;
}

// ── Route Implementations ───────────────────────────────────────────────────

function serveWizardHtml(res) {
  if (!existsSync(WIZARD_HTML)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Setup wizard not found');
    return;
  }
  const html = readFileSync(WIZARD_HTML, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function getOllamaHosts() {
  const hosts = [];
  if (process.env.OLLAMA_URL) hosts.push(process.env.OLLAMA_URL);
  // Support comma-separated OLLAMA_HOSTS for multiple LAN addresses
  if (process.env.OLLAMA_HOSTS) {
    for (const h of process.env.OLLAMA_HOSTS.split(',')) {
      const trimmed = h.trim();
      if (trimmed && !hosts.includes(trimmed)) hosts.push(trimmed);
    }
  }
  // Legacy single fallback
  if (process.env.OLLAMA_FALLBACK_URL) {
    if (!hosts.includes(process.env.OLLAMA_FALLBACK_URL)) hosts.push(process.env.OLLAMA_FALLBACK_URL);
  }
  return hosts;
}

async function handleStatus(req, res) {
  try {
    const status = await fullSystemCheck({ customOllamaHosts: getOllamaHosts() });
    jsonResponse(res, status);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleModels(req, res) {
  try {
    const status = await fullSystemCheck({ customOllamaHosts: getOllamaHosts() });
    const models = getModelRecommendations(
      status.ollama.models,
      status.env.keys,
      status.vram.vramMB
    );
    jsonResponse(res, {
      ...models,
      gpu: status.vram,
      ollama: status.ollama,
      openclaw: {
        gatewayRunning: status.openclaw?.gatewayRunning || false,
        gatewayModels: status.openclaw?.gatewayModels || [],
      },
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handlePingOllama(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const host = url.searchParams.get('host');
    if (!host) { jsonResponse(res, { error: 'Missing host param' }, 400); return; }

    const { checkOllamaRemote } = await import('./checks.js');
    const result = await checkOllamaRemote(host);
    jsonResponse(res, result);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleSaveEnv(req, res) {
  try {
    const body = await readBody(req);
    const { key, value } = body;
    if (!key || !key.match(/^[A-Z_]+$/)) { jsonResponse(res, { error: 'Invalid key' }, 400); return; }

    const { join } = await import('path');
    const { readFileSync, writeFileSync, existsSync } = await import('fs');
    const envPath = join(process.cwd(), '.env');
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (value) {
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
      }
      process.env[key] = value;
    } else {
      envContent = envContent.replace(regex, '').replace(/\n{3,}/g, '\n\n');
      delete process.env[key];
    }
    writeFileSync(envPath, envContent);
    jsonResponse(res, { saved: true, key });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleInstall(req, res) {
  try {
    const body = await readBody(req);
    const { action, model, host } = body;

    sseHeaders(res);

    let generator;
    switch (action) {
      case 'npm':
        generator = installNpmDeps();
        break;
      case 'playwright':
        generator = installPlaywright();
        break;
      case 'ollama-pull':
        if (!model) {
          sseWrite(res, { phase: 'error', status: 'error', message: 'Missing model parameter' });
          res.end();
          return;
        }
        generator = pullOllamaModel(model, host || 'http://localhost:11434');
        break;
      case 'env':
        generator = createEnvFile();
        break;
      default:
        sseWrite(res, { phase: 'error', status: 'error', message: `Unknown action: ${action}` });
        res.end();
        return;
    }

    let hadError = false;
    for await (const ev of generator) {
      if (ev.status === 'error') hadError = true;
      sseWrite(res, ev);
    }

    if (hadError) {
      sseWrite(res, { phase: 'complete', status: 'error', message: 'Installation finished with errors' });
    } else {
      sseWrite(res, { phase: 'complete', status: 'done', message: 'Installation complete' });
    }
    res.end();
  } catch (err) {
    try {
      sseWrite(res, { phase: 'error', status: 'error', message: err.message });
      res.end();
    } catch {
      // Response already ended
    }
  }
}

async function handleEnv(req, res) {
  try {
    const body = await readBody(req);
    const { keys } = body;

    if (!keys || typeof keys !== 'object') {
      jsonResponse(res, { error: 'Missing keys object' }, 400);
      return;
    }

    // saveModelsModule sends raw env var names (OLLAMA_MODEL, ANALYSIS_PROVIDER, etc.)
    // while updateEnvForSetup expects camelCase. Write raw env vars directly.
    for (const [key, value] of Object.entries(keys)) {
      if (/^[A-Z_]+$/.test(key) && value) {
        writeEnvKey(key, String(value));
        process.env[key] = String(value);
      }
    }

    const envPath = join(ROOT, '.env');
    jsonResponse(res, { success: true, path: envPath });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleConfig(req, res) {
  try {
    const body = await readBody(req);
    const config = buildProjectConfig(body);
    const validation = validateConfig(config);

    if (!validation.valid) {
      jsonResponse(res, { success: false, errors: validation.errors }, 400);
      return;
    }

    const result = writeProjectConfig(config);
    jsonResponse(res, {
      success: true,
      path: result.path,
      overwritten: result.overwritten,
      config,
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleTestPipeline(req, res) {
  try {
    const body = await readBody(req);
    sseHeaders(res);

    for await (const step of runFullValidation(body)) {
      sseWrite(res, step);
    }

    res.end();
  } catch (err) {
    try {
      sseWrite(res, { step: 'error', status: 'fail', detail: err.message });
      res.end();
    } catch {
      // Response already ended
    }
  }
}

// ── GSC Data Handlers ──────────────────────────────────────────────────────

async function handleGscStatus(req, res, url) {
  try {
    const project = url.searchParams.get('project') || '';
    const gsc = checkGscData(project);
    jsonResponse(res, gsc);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleGscUpload(req, res) {
  try {
    // Read multipart form data (simplified — expects JSON with base64 files)
    const body = await readBody(req);
    const { project, files } = body;

    if (!project || !files || !Array.isArray(files) || files.length === 0) {
      jsonResponse(res, { error: 'Missing project name or files array' }, 400);
      return;
    }

    // Create GSC directory: gsc/<project>/
    const gscDir = join(ROOT, 'gsc');
    const projectDir = join(gscDir, project);

    if (!existsSync(gscDir)) mkdirSync(gscDir, { recursive: true });
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });

    const saved = [];
    for (const file of files) {
      if (!file.name || !file.content) continue;

      // Decode base64 content and write CSV
      const content = Buffer.from(file.content, 'base64').toString('utf8');
      const filePath = join(projectDir, file.name);
      writeFileSync(filePath, content, 'utf8');
      saved.push(file.name);
    }

    // Re-check GSC data status
    const gsc = checkGscData(project);

    jsonResponse(res, {
      success: true,
      saved,
      folder: project,
      gsc,
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleDashboardRestart(res) {
  jsonResponse(res, {
    success: true,
    restarted: true,
    mode: 'soft',
    message: 'Dashboard restart requested. Reload the dashboard UI to pick up latest settings.',
  });
}

// ── Version / Update Handler ──────────────────────────────────────────────

async function handleVersion(req, res) {
  try {
    checkForUpdates(); // trigger background check if not already
    const info = await getUpdateInfo();
    jsonResponse(res, info);
  } catch (err) {
    jsonResponse(res, {
      current: getCurrentVersion(),
      hasUpdate: false,
      error: err.message,
    });
  }
}

// ── Project / Competitors Handlers ────────────────────────────────────────

import { domainFromUrl } from './config-builder.js';

function loadProjectConfig(project) {
  const configPath = join(ROOT, 'config', `${project}.json`);
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function saveProjectConfig(project, config) {
  const configPath = join(ROOT, 'config', `${project}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function handleListProjects(res) {
  try {
    const configDir = join(ROOT, 'config');
    const configs = readdirSync(configDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .map(f => {
        try {
          const config = JSON.parse(readFileSync(join(configDir, f), 'utf8'));
          return {
            project: config.project,
            target: config.target?.domain,
            competitors: (config.competitors || []).map(c => c.domain),
            owned: (config.owned || []).map(o => o.domain),
          };
        } catch { return null; }
      })
      .filter(Boolean);

    jsonResponse(res, { projects: configs });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleGetProject(res, project) {
  try {
    const config = loadProjectConfig(project);
    if (!config) {
      jsonResponse(res, { error: `Project '${project}' not found` }, 404);
      return;
    }
    jsonResponse(res, config);
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

async function handleUpdateCompetitors(req, res, project) {
  try {
    const config = loadProjectConfig(project);
    if (!config) {
      jsonResponse(res, { error: `Project '${project}' not found` }, 404);
      return;
    }

    const body = await readBody(req);
    const changes = [];

    // Add competitors
    if (body.add && Array.isArray(body.add)) {
      for (const entry of body.add) {
        const domain = domainFromUrl(entry);
        const url = entry.startsWith('http') ? entry : `https://${entry}`;
        if (!config.competitors.some(c => c.domain === domain)) {
          config.competitors.push({ url, domain, role: 'competitor' });
          changes.push({ action: 'added', type: 'competitor', domain });
        }
      }
    }

    // Remove competitors
    if (body.remove && Array.isArray(body.remove)) {
      for (const entry of body.remove) {
        const domain = domainFromUrl(entry);
        const before = config.competitors.length;
        config.competitors = config.competitors.filter(c => c.domain !== domain);
        if (config.competitors.length < before) {
          changes.push({ action: 'removed', type: 'competitor', domain });
        }
      }
    }

    // Add owned
    if (body.addOwned && Array.isArray(body.addOwned)) {
      if (!config.owned) config.owned = [];
      for (const entry of body.addOwned) {
        const domain = domainFromUrl(entry);
        const url = entry.startsWith('http') ? entry : `https://${entry}`;
        if (!config.owned.some(o => o.domain === domain)) {
          config.owned.push({ url, domain, role: 'owned' });
          changes.push({ action: 'added', type: 'owned', domain });
        }
      }
    }

    // Remove owned
    if (body.removeOwned && Array.isArray(body.removeOwned)) {
      if (!config.owned) config.owned = [];
      for (const entry of body.removeOwned) {
        const domain = domainFromUrl(entry);
        const before = config.owned.length;
        config.owned = config.owned.filter(o => o.domain !== domain);
        if (config.owned.length < before) {
          changes.push({ action: 'removed', type: 'owned', domain });
        }
      }
    }

    if (changes.length > 0) {
      saveProjectConfig(project, config);
    }

    jsonResponse(res, {
      success: true,
      changes,
      competitors: config.competitors.map(c => c.domain),
      owned: (config.owned || []).map(o => o.domain),
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

// ── OAuth Handlers ────────────────────────────────────────────────────────

import {
  getAllConnectionStatus,
  getAuthUrl,
  getProviderRequirements,
  clearTokens,
} from '../lib/oauth.js';

function handleAuthStatus(res) {
  try {
    const statuses = getAllConnectionStatus();
    const requirements = getProviderRequirements();

    // Also include API key status
    const envPath = join(ROOT, '.env');
    const apiKeys = {};
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, 'utf8');
      for (const key of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) {
        const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
        apiKeys[key] = !!(match && match[1]?.trim());
      }
      // Check OAuth credentials too
      for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
        const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
        apiKeys[key] = !!(match && match[1]?.trim());
      }
    }

    jsonResponse(res, {
      oauth: statuses,
      providers: requirements,
      apiKeys,
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleAuthUrl(res, provider) {
  try {
    const { url, state } = getAuthUrl(provider, { port: 9876 });
    jsonResponse(res, { url, state, provider });
  } catch (err) {
    // Likely missing credentials
    jsonResponse(res, {
      error: err.message,
      needsSetup: true,
      provider,
      setupUrl: provider === 'google' ? 'https://console.cloud.google.com/apis/credentials' : null,
      envVars: provider === 'google' ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] : [],
    }, 400);
  }
}

async function handleAuthCallback(req, res, provider) {
  try {
    const body = await readBody(req);
    const { code, redirectUri } = body;

    if (!code) {
      jsonResponse(res, { error: 'Missing authorization code' }, 400);
      return;
    }

    // Dynamically import the exchange function
    const { default: _, ...oauth } = await import('../lib/oauth.js');

    // We need to call exchangeCode — but it's not exported directly.
    // Instead, the web wizard will use the popup window flow:
    // 1. Open auth URL in popup
    // 2. Google redirects to localhost:9876/oauth/callback
    // 3. The callback server (started by startOAuthFlow) handles the exchange
    //
    // For web-initiated flows, we provide the auth URL and let the CLI
    // callback server handle token exchange.

    jsonResponse(res, {
      success: true,
      message: 'Use the auth URL flow — tokens are exchanged via the local callback server',
    });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleAuthDisconnect(res, provider) {
  try {
    clearTokens(provider);
    jsonResponse(res, { success: true, provider, disconnected: true });
  } catch (err) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

// ── Agent Chat Handler ────────────────────────────────────────────────────

async function handleAgentChat(req, res) {
  try {
    const { isGatewayReady, handleAgentChat: agentChat } = await import('./openclaw-bridge.js');

    const ready = await isGatewayReady();
    if (!ready) {
      jsonResponse(res, {
        error: 'OpenClaw gateway not running',
        available: false,
        hint: 'Start OpenClaw with: openclaw gateway',
      }, 503);
      return;
    }

    const body = await readBody(req);
    const result = await agentChat(body);
    jsonResponse(res, { ...result, available: true });
  } catch (err) {
    jsonResponse(res, { error: err.message, available: false }, 500);
  }
}
