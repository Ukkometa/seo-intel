/**
 * SEO Intel — System Detection
 *
 * Stateless check functions that detect installed software,
 * available models, and environment configuration.
 * Used by both CLI wizard and web setup wizard.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Node.js ────────────────────────────────────────────────────────────────

export function checkNodeVersion() {
  try {
    const version = process.version; // e.g. 'v20.11.0'
    const major = parseInt(version.slice(1).split('.')[0], 10);
    return { installed: true, version, major, meetsMinimum: major >= 18 };
  } catch {
    return { installed: false, version: null, major: 0, meetsMinimum: false };
  }
}

// ── npm ─────────────────────────────────────────────────────────────────────

export function checkNpm() {
  try {
    const version = execSync('npm --version', { encoding: 'utf8', timeout: 5000 }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

// ── Ollama (local) ──────────────────────────────────────────────────────────

export function checkOllamaLocal() {
  const installed = commandExists('ollama');
  if (!installed) return { installed: false, running: false, models: [], host: null };

  try {
    const out = execSync('ollama list 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const models = out.split('\n')
      .slice(1)
      .map(l => l.split(/\s+/)[0])
      .filter(Boolean)
      .filter(m => m !== 'NAME');
    return { installed: true, running: true, models, host: 'http://localhost:11434' };
  } catch {
    return { installed: true, running: false, models: [], host: 'http://localhost:11434' };
  }
}

// ── Ollama (remote host) ────────────────────────────────────────────────────

export async function checkOllamaRemote(host) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { reachable: false, models: [], host };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    return { reachable: true, models, host };
  } catch {
    return { reachable: false, models: [], host };
  }
}

// ── Ollama auto-detect (local → custom hosts) ──────────────────────────────

export async function checkOllamaAuto(customHosts = []) {
  // 1. Try local
  const local = checkOllamaLocal();
  const allHosts = []; // Track all reachable hosts for UI

  if (local.running && local.models.length > 0) {
    allHosts.push({ host: local.host, mode: 'local', models: local.models, reachable: true });
  }

  // 2. Try custom/LAN hosts (check ALL, not just first)
  for (const host of customHosts) {
    if (host === 'http://localhost:11434') continue; // already checked
    const remote = await checkOllamaRemote(host);
    allHosts.push({ host: remote.host, mode: 'remote', models: remote.models, reachable: remote.reachable });
  }

  // Pick best available host (first with models)
  const best = allHosts.find(h => h.reachable && h.models.length > 0);

  if (best) {
    // Combine models from all reachable hosts
    const allModels = [...new Set(allHosts.filter(h => h.reachable).flatMap(h => h.models))];
    return {
      available: true,
      mode: best.mode,
      host: best.host,
      models: allModels,
      installed: local.installed,
      allHosts,
    };
  }

  // 3. Local installed but not running or no models
  if (local.installed) {
    return {
      available: false,
      mode: 'installed-not-ready',
      host: local.host,
      models: [],
      installed: true,
      allHosts,
    };
  }

  return {
    available: false,
    mode: 'none',
    host: null,
    models: [],
    installed: false,
    allHosts,
  };
}

// ── Playwright ──────────────────────────────────────────────────────────────

export function checkPlaywright() {
  const pkgPath = join(ROOT, 'node_modules', 'playwright');
  const installed = existsSync(pkgPath);

  if (!installed) return { installed: false, chromiumReady: false };

  // Check if Chromium binary is actually available
  let chromiumReady = false;
  try {
    // Playwright stores browser paths in its package
    const browserPath = join(pkgPath, '.local-browsers');
    if (existsSync(browserPath)) {
      const browsers = readdirSync(browserPath);
      chromiumReady = browsers.some(b => b.toLowerCase().includes('chromium'));
    }
    // Alternative check: playwright's own registry
    if (!chromiumReady) {
      const result = spawnSync('npx', ['playwright', 'install', '--dry-run'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // If dry-run shows chromium is already installed, it's ready
      chromiumReady = result.status === 0 && !result.stdout.includes('chromium');
    }
  } catch {
    // If we can't determine, assume it needs install
    chromiumReady = false;
  }

  return { installed, chromiumReady };
}

// ── npm dependencies ────────────────────────────────────────────────────────

export function checkNpmDeps() {
  const nodeModules = join(ROOT, 'node_modules');
  if (!existsSync(nodeModules)) return { installed: false, missing: [] };

  const pkgPath = join(ROOT, 'package.json');
  if (!existsSync(pkgPath)) return { installed: false, missing: [] };

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const missing = deps.filter(d => !existsSync(join(nodeModules, d)));
    return { installed: missing.length === 0, missing };
  } catch {
    return { installed: false, missing: [] };
  }
}

// ── .env file ───────────────────────────────────────────────────────────────

export function checkEnvFile() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    return {
      exists: false,
      keys: {},
      raw: {},
    };
  }

  const raw = parseEnvFile(envPath);
  return {
    exists: true,
    keys: {
      GEMINI_API_KEY: !!raw.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: !!raw.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: !!raw.OPENAI_API_KEY,
      OLLAMA_URL: raw.OLLAMA_URL || null,
      OLLAMA_MODEL: raw.OLLAMA_MODEL || null,
      OLLAMA_CTX: raw.OLLAMA_CTX || null,
      CRAWL_MAX_PAGES: raw.CRAWL_MAX_PAGES || null,
    },
    raw,
  };
}

// ── Existing project configs ────────────────────────────────────────────────

export function checkExistingConfigs() {
  const configDir = join(ROOT, 'config');
  if (!existsSync(configDir)) return { configs: [] };

  try {
    const files = readdirSync(configDir).filter(f => f.endsWith('.json'));
    const configs = files.map(f => {
      try {
        const data = JSON.parse(readFileSync(join(configDir, f), 'utf8'));
        return {
          project: data.project || f.replace('.json', ''),
          domain: data.target?.domain || '',
          competitors: (data.competitors || []).length,
          path: join(configDir, f),
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    return { configs };
  } catch {
    return { configs: [] };
  }
}

// ── OS Detection ────────────────────────────────────────────────────────────

export function detectOS() {
  const platform = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : 'linux';
  return { platform, arch: process.arch };
}

// ── VRAM Detection ──────────────────────────────────────────────────────────

export function detectVRAM() {
  const os = detectOS();

  // NVIDIA GPU (Linux / Windows)
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }
    );
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const parts = lines[0].split(',').map(s => s.trim());
      const gpuName = parts[0];
      const vramMB = parseInt(parts[1], 10) || 0;
      return { available: true, gpuName, vramMB, source: 'nvidia-smi' };
    }
  } catch {}

  // macOS Metal GPU
  if (os.platform === 'macos') {
    try {
      const out = execSync(
        'system_profiler SPDisplaysDataType 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      );

      // Extract GPU name
      const nameMatch = out.match(/Chipset Model:\s*(.+)/i) || out.match(/Chip:\s*(.+)/i);
      const gpuName = nameMatch ? nameMatch[1].trim() : 'Unknown';

      // Extract VRAM — Apple Silicon uses unified memory
      const vramMatch = out.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
      if (vramMatch) {
        const val = parseInt(vramMatch[1], 10);
        const vramMB = vramMatch[2].toUpperCase() === 'GB' ? val * 1024 : val;
        return { available: true, gpuName, vramMB, source: 'system_profiler' };
      }

      // Apple Silicon: use total system memory as proxy (shared with GPU)
      const memMatch = execSync('sysctl -n hw.memsize 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const totalBytes = parseInt(memMatch.trim(), 10);
      if (totalBytes > 0) {
        // Apple Silicon can use ~75% of system RAM for GPU
        const vramMB = Math.floor((totalBytes / 1024 / 1024) * 0.75);
        return { available: true, gpuName, vramMB, source: 'apple-silicon-unified' };
      }
    } catch {}
  }

  // AMD GPU (Linux)
  try {
    const out = execSync('rocm-smi --showmeminfo vram 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const match = out.match(/Total.*?(\d+)\s*MB/i);
    if (match) {
      return { available: true, gpuName: 'AMD GPU', vramMB: parseInt(match[1], 10), source: 'rocm-smi' };
    }
  } catch {}

  return { available: false, gpuName: null, vramMB: 0, source: 'none' };
}

// ── Google Search Console data ───────────────────────────────────────────

export function checkGscData(project) {
  const gscDir = join(ROOT, 'gsc');
  if (!existsSync(gscDir)) return { hasData: false, folders: [], project };

  try {
    const allFolders = readdirSync(gscDir).filter(f => !f.startsWith('.'));

    // If project specified, filter to matching folders
    const folders = project
      ? allFolders.filter(f => f.toLowerCase().startsWith(project.toLowerCase()))
      : allFolders;

    if (folders.length === 0) return { hasData: false, folders: allFolders, project };

    // Check what CSV files exist in the latest folder
    const latest = folders.sort().pop();
    const folderPath = join(gscDir, latest);
    const expectedFiles = ['Chart.csv', 'Queries.csv', 'Pages.csv', 'Countries.csv', 'Devices.csv'];
    const found = [];
    const missing = [];

    for (const f of expectedFiles) {
      if (existsSync(join(folderPath, f))) {
        found.push(f);
      } else {
        missing.push(f);
      }
    }

    return {
      hasData: found.length >= 2, // At minimum Chart + Queries
      folder: latest,
      folderPath,
      found,
      missing,
      allFolders,
      project,
    };
  } catch {
    return { hasData: false, folders: [], project };
  }
}

// ── Full System Check ───────────────────────────────────────────────────────

export async function fullSystemCheck(options = {}) {
  const { customOllamaHosts = [] } = options;

  const { project } = options;

  const [node, npm, ollama, playwright, npmDeps, env, configs, os, vram, gsc] = await Promise.all([
    checkNodeVersion(),
    checkNpm(),
    checkOllamaAuto(customOllamaHosts),
    checkPlaywright(),
    checkNpmDeps(),
    checkEnvFile(),
    checkExistingConfigs(),
    detectOS(),
    detectVRAM(),
    checkGscData(project),
  ]);

  // OpenClaw detection (sync, fast)
  const openclaw = checkOpenClaw();

  const ready = node.meetsMinimum && npm.installed;
  const hasAnalysisKey = env.keys.GEMINI_API_KEY || env.keys.ANTHROPIC_API_KEY || env.keys.OPENAI_API_KEY;

  return {
    node,
    npm,
    ollama,
    playwright,
    npmDeps,
    env,
    configs,
    os,
    vram,
    gsc,
    openclaw,
    ready,
    hasAnalysisKey,
    summary: {
      canCrawl: node.meetsMinimum && playwright.installed,
      canExtract: ollama.available,
      canAnalyze: hasAnalysisKey,
      canGenerateHtml: node.meetsMinimum,
      hasGscData: gsc.hasData,
      hasOpenClaw: openclaw.installed,
      canAgentSetup: openclaw.canAgentSetup,
    },
  };
}

// ── Helpers (private) ───────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── OpenClaw Detection ──────────────────────────────────────────────────────

/**
 * Detect OpenClaw installation and capabilities.
 * Returns info about the gateway, available models, and agent readiness.
 */
export function checkOpenClaw() {
  const result = {
    installed: false,
    version: null,
    gatewayRunning: false,
    gatewayUrl: 'ws://127.0.0.1:18789',
    apiUrl: 'http://127.0.0.1:18789',
    hasSkillsDir: false,
    skillsPath: null,
    canAgentSetup: false,
  };

  // 1. Check if openclaw binary exists
  if (!commandExists('openclaw')) return result;
  result.installed = true;

  // 2. Get version
  try {
    const ver = execSync('openclaw --version 2>/dev/null', { timeout: 5000 }).toString().trim();
    const match = ver.match(/OpenClaw\s+([\d.]+)/);
    result.version = match ? match[1] : ver;
  } catch { /* ok */ }

  // 3. Check if gateway is running (quick HTTP ping)
  try {
    execSync('curl -s --max-time 2 http://127.0.0.1:18789/v1/models >/dev/null 2>&1', { timeout: 5000 });
    result.gatewayRunning = true;
  } catch {
    result.gatewayRunning = false;
  }

  // 4. Check skills directory
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const possiblePaths = [
    join(homeDir, '.openclaw', 'skills'),
    join(homeDir, '.openclaw', 'managed-skills'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      result.hasSkillsDir = true;
      result.skillsPath = p;
      break;
    }
  }

  // Agent setup is possible if gateway is running
  result.canAgentSetup = result.gatewayRunning;

  return result;
}

export function parseEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
