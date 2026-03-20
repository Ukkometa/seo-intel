/**
 * SEO Intel — Auto-Installers
 *
 * Async generator functions that install dependencies and yield progress events.
 * Both CLI and web wizard consume the same generators — CLI prints, web streams via SSE.
 *
 * Usage:
 *   for await (const ev of installNpmDeps()) console.log(ev.message);
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Event helpers ───────────────────────────────────────────────────────────

function ev(phase, status, message, extra = {}) {
  return { phase, status, message, ts: Date.now(), ...extra };
}

// ── npm install ─────────────────────────────────────────────────────────────

export async function* installNpmDeps(rootDir = ROOT) {
  yield ev('npm-install', 'start', 'Installing npm dependencies...');

  try {
    const result = await runCommand('npm', ['install', '--no-audit', '--no-fund'], rootDir);

    if (result.exitCode === 0) {
      yield ev('npm-install', 'done', 'npm dependencies installed successfully.');
    } else {
      yield ev('npm-install', 'error', `npm install failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    }
  } catch (err) {
    yield ev('npm-install', 'error', `npm install error: ${err.message}`);
  }
}

// ── Playwright Chromium ─────────────────────────────────────────────────────

export async function* installPlaywright(rootDir = ROOT) {
  yield ev('playwright', 'start', 'Installing Playwright Chromium browser (~150MB)...');

  try {
    const result = await runCommand('npx', ['playwright', 'install', 'chromium'], rootDir);

    if (result.exitCode === 0) {
      yield ev('playwright', 'done', 'Playwright Chromium installed successfully.');
    } else {
      yield ev('playwright', 'error', `Playwright install failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    }
  } catch (err) {
    yield ev('playwright', 'error', `Playwright install error: ${err.message}`);
  }
}

// ── Ollama model pull ───────────────────────────────────────────────────────

export async function* pullOllamaModel(model, host = 'http://localhost:11434') {
  yield ev('ollama-pull', 'start', `Pulling model ${model} from Ollama...`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min timeout for large models

    const res = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield ev('ollama-pull', 'error', `Ollama pull failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return;
    }

    const reader = res.body;
    let lastPercent = -1;

    // Stream Ollama's NDJSON progress
    for await (const chunk of reader) {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          if (data.error) {
            yield ev('ollama-pull', 'error', `Ollama error: ${data.error}`);
            return;
          }

          if (data.total && data.completed) {
            const percent = Math.round((data.completed / data.total) * 100);
            if (percent !== lastPercent && percent % 5 === 0) {
              lastPercent = percent;
              yield ev('ollama-pull', 'progress', `Downloading ${model}... ${percent}%`, { progress: percent });
            }
          } else if (data.status) {
            // Status messages like "pulling manifest", "verifying sha256 digest"
            yield ev('ollama-pull', 'progress', data.status);
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }

    yield ev('ollama-pull', 'done', `Model ${model} pulled successfully.`);
  } catch (err) {
    if (err.name === 'AbortError') {
      yield ev('ollama-pull', 'error', `Ollama pull timed out after 10 minutes.`);
    } else {
      yield ev('ollama-pull', 'error', `Ollama pull error: ${err.message}`);
    }
  }
}

// ── Create .env from template ───────────────────────────────────────────────

export function* createEnvFile(rootDir = ROOT) {
  const envPath = join(rootDir, '.env');
  const examplePath = join(rootDir, '.env.example');

  if (existsSync(envPath)) {
    yield ev('env-create', 'done', '.env file already exists — keeping it.');
    return;
  }

  if (!existsSync(examplePath)) {
    // Create a minimal .env
    const minimal = [
      '# SEO Intel Configuration',
      '',
      '# Cloud model for analysis (pick one)',
      'GEMINI_API_KEY=',
      '# ANTHROPIC_API_KEY=',
      '# OPENAI_API_KEY=',
      '',
      '# Local Ollama for extraction',
      'OLLAMA_URL=http://localhost:11434',
      'OLLAMA_MODEL=qwen3.5:9b',
      'OLLAMA_CTX=8192',
      '',
      '# Crawler settings',
      'CRAWL_DELAY_MS=1500',
      'CRAWL_MAX_PAGES=50',
      'CRAWL_TIMEOUT_MS=15000',
      '',
    ].join('\n');

    writeFileSync(envPath, minimal);
    yield ev('env-create', 'done', 'Created .env with default values.');
    return;
  }

  writeFileSync(envPath, readFileSync(examplePath, 'utf8'));
  yield ev('env-create', 'done', 'Created .env from .env.example template.');
}

// ── Spawn helper ────────────────────────────────────────────────────────────

function runCommand(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', reject);
    proc.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    // Timeout after 5 minutes for npm/playwright
    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Command timed out after 5 minutes'));
    }, 300000);
  });
}
