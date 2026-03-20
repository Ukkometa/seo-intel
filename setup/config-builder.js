/**
 * SEO Intel — Config Builder
 *
 * Generates project configuration files and manages .env updates.
 * Extracted from config/setup-wizard.js for reuse by both CLI and web wizard.
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Helpers ────────────────────────────────────────────────────────────────

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function domainFromUrl(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ── Build Project Config ────────────────────────────────────────────────────

/**
 * Build a complete project config object.
 *
 * @param {object} params
 * @param {string} params.projectName
 * @param {string} params.targetUrl
 * @param {string} params.siteName
 * @param {string} params.industry
 * @param {string} params.audience
 * @param {string} params.goal
 * @param {string} [params.maturity='early stage']
 * @param {Array<{url: string}>} [params.competitors=[]]
 * @param {Array<{url: string}>} [params.owned=[]]
 * @param {string} [params.crawlMode='standard']
 * @param {number} [params.pagesPerDomain=50]
 * @param {string} [params.ollamaHost]
 * @param {string} [params.extractionModel]
 * @returns {object} Full config JSON
 */
export function buildProjectConfig({
  projectName,
  targetUrl,
  siteName,
  industry,
  audience,
  goal,
  maturity = 'early stage',
  competitors = [],
  owned = [],
  crawlMode = 'standard',
  pagesPerDomain = 50,
  ollamaHost,
  extractionModel,
}) {
  const slug = slugify(projectName);
  const targetDomain = domainFromUrl(targetUrl);
  const normalizedUrl = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`;

  const config = {
    project: slug,
    crawl: {
      mode: crawlMode,
      pagesPerDomain,
      depth: 3,
    },
    context: {
      siteName: siteName || slug,
      url: normalizedUrl,
      industry: industry || '',
      audience: audience || '',
      goal: goal || '',
      maturity,
    },
    target: {
      url: normalizedUrl,
      domain: targetDomain,
      role: 'target',
    },
    competitors: competitors.map(c => {
      const url = c.url.startsWith('http') ? c.url : `https://${c.url}`;
      return {
        url,
        domain: domainFromUrl(url),
        role: 'competitor',
      };
    }),
  };

  // Optional: owned subdomains
  if (owned.length > 0) {
    config.owned = owned.map(o => {
      const url = o.url.startsWith('http') ? o.url : `https://${o.url}`;
      return {
        url,
        domain: domainFromUrl(url),
        role: 'owned',
      };
    });
  }

  // Optional: Ollama settings
  if (ollamaHost || extractionModel) {
    config.crawl.ollamaHost = ollamaHost;
    config.crawl.extractionModel = extractionModel;
  }

  return config;
}

// ── Write Project Config ────────────────────────────────────────────────────

/**
 * Write a project config to disk.
 *
 * @param {object} config - full config object from buildProjectConfig()
 * @param {string} [rootDir] - override root directory
 * @returns {{ path: string, overwritten: boolean }}
 */
export function writeProjectConfig(config, rootDir = ROOT) {
  const configPath = join(rootDir, 'config', `${config.project}.json`);
  const overwritten = existsSync(configPath);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { path: configPath, overwritten };
}

// ── .env Management ─────────────────────────────────────────────────────────

/**
 * Write a single key to .env (create or update).
 */
export function writeEnvKey(key, value, rootDir = ROOT) {
  const envPath = join(rootDir, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  writeFileSync(envPath, content.trim() + '\n');
}

/**
 * Batch-update .env with setup choices.
 * Creates .env from .env.example if it doesn't exist.
 */
export function updateEnvForSetup(values = {}, rootDir = ROOT) {
  const envPath = join(rootDir, '.env');
  const examplePath = join(rootDir, '.env.example');

  // Create .env from template if missing
  if (!existsSync(envPath)) {
    if (existsSync(examplePath)) {
      writeFileSync(envPath, readFileSync(examplePath, 'utf8'));
    } else {
      writeFileSync(envPath, '# SEO Intel Configuration\n');
    }
  }

  // Apply each value
  const keyMap = {
    ollamaUrl: 'OLLAMA_URL',
    ollamaModel: 'OLLAMA_MODEL',
    ollamaCtx: 'OLLAMA_CTX',
    ollamaTimeout: 'OLLAMA_TIMEOUT_MS',
    geminiKey: 'GEMINI_API_KEY',
    anthropicKey: 'ANTHROPIC_API_KEY',
    openaiKey: 'OPENAI_API_KEY',
    deepseekKey: 'DEEPSEEK_API_KEY',
    crawlDelay: 'CRAWL_DELAY_MS',
    crawlMaxPages: 'CRAWL_MAX_PAGES',
    crawlTimeout: 'CRAWL_TIMEOUT_MS',
  };

  for (const [jsKey, envKey] of Object.entries(keyMap)) {
    if (values[jsKey] !== undefined && values[jsKey] !== null && values[jsKey] !== '') {
      writeEnvKey(envKey, String(values[jsKey]), rootDir);
    }
  }

  return { path: envPath };
}

/**
 * Validate a project config for completeness.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = [];

  if (!config.project) errors.push('Missing project name');
  if (!config.target?.url) errors.push('Missing target URL');
  if (!config.target?.domain) errors.push('Missing target domain');
  if (!config.context?.siteName) errors.push('Missing site name');

  // Validate URL format
  if (config.target?.url) {
    try {
      new URL(config.target.url);
    } catch {
      errors.push(`Invalid target URL: ${config.target.url}`);
    }
  }

  // Validate competitors
  if (config.competitors) {
    for (const c of config.competitors) {
      if (!c.url || !c.domain) {
        errors.push(`Competitor missing URL or domain: ${JSON.stringify(c)}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
