/**
 * SEO Intel — Pipeline Validator
 *
 * End-to-end tests that prove each component works:
 *   1. Ollama connectivity (POST tiny prompt)
 *   2. Analysis API key validity (minimal API call)
 *   3. Test crawl (fetch 1 page with Playwright)
 *   4. Test extraction (run Qwen on crawled content)
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Test 1: Ollama Connectivity ─────────────────────────────────────────────

/**
 * Test Ollama host + model by sending a tiny prompt.
 *
 * @param {string} host - e.g. 'http://localhost:11434'
 * @param {string} model - e.g. 'qwen3.5:9b'
 * @returns {{ success: boolean, latencyMs: number, response?: string, error?: string }}
 */
export async function testOllamaConnectivity(host, model) {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '/no_think\nRespond with exactly this JSON: {"status":"ok"}',
        format: 'json',
        stream: false,
        options: { num_predict: 20, temperature: 0.0 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = await res.json();
    if (data.error) {
      return { success: false, latencyMs, error: data.error };
    }

    const response = (data.response || data.thinking || '').trim();
    return { success: true, latencyMs, response: response.slice(0, 100) };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? 'Timed out after 15s' : err.message,
    };
  }
}

// ── Test 2: API Key Validity ────────────────────────────────────────────────

/**
 * Test an analysis API key with a minimal request.
 *
 * @param {'gemini'|'claude'|'openai'|'deepseek'} provider
 * @param {string} key
 * @returns {{ valid: boolean, error?: string, latencyMs: number }}
 */
export async function testApiKey(provider, key) {
  const start = Date.now();

  try {
    switch (provider) {
      case 'gemini':
        return await testGeminiKey(key, start);
      case 'claude':
        return await testAnthropicKey(key, start);
      case 'openai':
        return await testOpenAIKey(key, start);
      case 'deepseek':
        return await testDeepSeekKey(key, start);
      default:
        return { valid: false, error: `Unknown provider: ${provider}`, latencyMs: 0 };
    }
  } catch (err) {
    return { valid: false, error: err.message, latencyMs: Date.now() - start };
  }
}

async function testGeminiKey(key, start) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Respond with: ok' }] }],
      generationConfig: { maxOutputTokens: 5 },
    }),
  });

  const latencyMs = Date.now() - start;
  if (res.ok) return { valid: true, latencyMs };
  const data = await res.json().catch(() => ({}));
  return { valid: false, latencyMs, error: data.error?.message || `HTTP ${res.status}` };
}

async function testAnthropicKey(key, start) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Respond with: ok' }],
    }),
  });

  const latencyMs = Date.now() - start;
  if (res.ok) return { valid: true, latencyMs };
  const data = await res.json().catch(() => ({}));
  return { valid: false, latencyMs, error: data.error?.message || `HTTP ${res.status}` };
}

async function testOpenAIKey(key, start) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Respond with: ok' }],
    }),
  });

  const latencyMs = Date.now() - start;
  if (res.ok) return { valid: true, latencyMs };
  const data = await res.json().catch(() => ({}));
  return { valid: false, latencyMs, error: data.error?.message || `HTTP ${res.status}` };
}

async function testDeepSeekKey(key, start) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Respond with: ok' }],
    }),
  });

  const latencyMs = Date.now() - start;
  if (res.ok) return { valid: true, latencyMs };
  const data = await res.json().catch(() => ({}));
  return { valid: false, latencyMs, error: data.error?.message || `HTTP ${res.status}` };
}

// ── Test 3: Crawl Test ──────────────────────────────────────────────────────

/**
 * Crawl a single page to verify Playwright works.
 *
 * @param {string} url - page to crawl
 * @returns {{ success: boolean, title?: string, wordCount?: number, latencyMs: number, error?: string }}
 */
export async function testCrawl(url) {
  const start = Date.now();

  try {
    // Dynamic import to avoid requiring playwright if just checking config
    const { chromium } = await import('playwright');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

    await browser.close();

    return {
      success: true,
      title: title.slice(0, 100),
      wordCount,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err.message.slice(0, 300),
    };
  }
}

// ── Test 4: Extraction Test ─────────────────────────────────────────────────

/**
 * Run a real extraction on sample content to verify Ollama + Qwen works end-to-end.
 *
 * @param {string} host - Ollama host
 * @param {string} model - Ollama model
 * @param {{ title: string, bodyText: string, url: string }} samplePage - crawled page data
 * @returns {{ success: boolean, keywordsFound?: number, latencyMs: number, preview?: object, error?: string }}
 */
export async function testExtraction(host, model, samplePage) {
  const start = Date.now();

  try {
    const { extractPage } = await import(join(ROOT, 'extractor', 'qwen.js'));

    // Override env vars temporarily for this test
    const origUrl = process.env.OLLAMA_URL;
    const origModel = process.env.OLLAMA_MODEL;
    const origTimeout = process.env.OLLAMA_TIMEOUT_MS;

    process.env.OLLAMA_URL = host;
    process.env.OLLAMA_MODEL = model;
    process.env.OLLAMA_TIMEOUT_MS = '30000'; // generous timeout for test

    try {
      const result = await extractPage({
        url: samplePage.url || 'https://example.com',
        title: samplePage.title || 'Test Page',
        metaDesc: samplePage.metaDesc || '',
        headings: samplePage.headings || [{ level: 1, text: samplePage.title || 'Test' }],
        bodyText: (samplePage.bodyText || 'This is a test page for SEO Intel extraction validation.').slice(0, 2000),
        schemaTypes: [],
        publishedDate: null,
        modifiedDate: null,
      });

      const keywordsFound = (result.keywords || []).length;
      return {
        success: result.extraction_source !== 'degraded',
        keywordsFound,
        latencyMs: Date.now() - start,
        preview: {
          title: result.title?.slice(0, 60),
          intent: result.search_intent,
          keywords: (result.keywords || []).slice(0, 5).map(k => k.keyword),
          source: result.extraction_source,
        },
      };
    } finally {
      // Restore env vars
      if (origUrl !== undefined) process.env.OLLAMA_URL = origUrl;
      else delete process.env.OLLAMA_URL;
      if (origModel !== undefined) process.env.OLLAMA_MODEL = origModel;
      else delete process.env.OLLAMA_MODEL;
      if (origTimeout !== undefined) process.env.OLLAMA_TIMEOUT_MS = origTimeout;
      else delete process.env.OLLAMA_TIMEOUT_MS;
    }
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err.message.slice(0, 300),
    };
  }
}

// ── Full Validation Pipeline ────────────────────────────────────────────────

/**
 * Run all 4 tests sequentially, returning aggregate results.
 * Yields progress events for real-time feedback.
 *
 * @param {object} config
 * @param {string} config.ollamaHost
 * @param {string} config.ollamaModel
 * @param {string} [config.apiProvider] - 'gemini'|'claude'|'openai'|'deepseek'
 * @param {string} [config.apiKey]
 * @param {string} config.targetUrl
 * @returns {AsyncGenerator<{ step: string, status: string, detail: string, latencyMs?: number }>}
 */
export async function* runFullValidation(config) {
  const steps = [];

  // Step 1: Ollama
  if (config.ollamaHost && config.ollamaModel) {
    yield { step: 'ollama', status: 'running', detail: `Testing ${config.ollamaModel} at ${config.ollamaHost}...` };
    const result = await testOllamaConnectivity(config.ollamaHost, config.ollamaModel);
    steps.push({ name: 'Ollama Connectivity', ...result, status: result.success ? 'pass' : 'fail' });
    yield {
      step: 'ollama',
      status: result.success ? 'pass' : 'fail',
      detail: result.success ? `Connected (${result.latencyMs}ms)` : `Failed: ${result.error}`,
      latencyMs: result.latencyMs,
    };
  } else {
    steps.push({ name: 'Ollama Connectivity', status: 'skip' });
    yield { step: 'ollama', status: 'skip', detail: 'No Ollama configured — extraction will use degraded mode' };
  }

  // Step 2: API Key
  if (config.apiProvider && config.apiKey) {
    yield { step: 'api-key', status: 'running', detail: `Validating ${config.apiProvider} API key...` };
    const result = await testApiKey(config.apiProvider, config.apiKey);
    steps.push({ name: 'API Key', ...result, status: result.valid ? 'pass' : 'fail' });
    yield {
      step: 'api-key',
      status: result.valid ? 'pass' : 'fail',
      detail: result.valid ? `${config.apiProvider} key valid (${result.latencyMs}ms)` : `Invalid: ${result.error}`,
      latencyMs: result.latencyMs,
    };
  } else {
    steps.push({ name: 'API Key', status: 'skip' });
    yield { step: 'api-key', status: 'skip', detail: 'No API key configured — analysis unavailable' };
  }

  // Step 3: Test Crawl
  if (config.targetUrl) {
    yield { step: 'crawl', status: 'running', detail: `Crawling ${config.targetUrl}...` };
    const result = await testCrawl(config.targetUrl);
    steps.push({ name: 'Test Crawl', ...result, status: result.success ? 'pass' : 'fail' });
    yield {
      step: 'crawl',
      status: result.success ? 'pass' : 'fail',
      detail: result.success
        ? `"${result.title}" — ${result.wordCount} words (${result.latencyMs}ms)`
        : `Failed: ${result.error}`,
      latencyMs: result.latencyMs,
      title: result.title,
      wordCount: result.wordCount,
    };

    // Step 4: Test Extraction (only if crawl succeeded AND Ollama available)
    if (result.success && config.ollamaHost && config.ollamaModel && steps[0]?.status === 'pass') {
      yield { step: 'extraction', status: 'running', detail: `Extracting with ${config.ollamaModel}...` };
      const extractResult = await testExtraction(config.ollamaHost, config.ollamaModel, {
        url: config.targetUrl,
        title: result.title,
        bodyText: '', // Will use the default sample text
      });
      steps.push({ name: 'Test Extraction', ...extractResult, status: extractResult.success ? 'pass' : 'fail' });
      yield {
        step: 'extraction',
        status: extractResult.success ? 'pass' : 'fail',
        detail: extractResult.success
          ? `${extractResult.keywordsFound} keywords extracted (${extractResult.latencyMs}ms)`
          : `Failed: ${extractResult.error}`,
        latencyMs: extractResult.latencyMs,
        preview: extractResult.preview,
      };
    } else if (!config.ollamaHost) {
      steps.push({ name: 'Test Extraction', status: 'skip' });
      yield { step: 'extraction', status: 'skip', detail: 'Skipped — no Ollama configured' };
    } else if (steps[0]?.status !== 'pass') {
      steps.push({ name: 'Test Extraction', status: 'skip' });
      yield { step: 'extraction', status: 'skip', detail: 'Skipped — Ollama connectivity failed' };
    } else {
      steps.push({ name: 'Test Extraction', status: 'skip' });
      yield { step: 'extraction', status: 'skip', detail: 'Skipped — crawl test failed' };
    }
  } else {
    steps.push({ name: 'Test Crawl', status: 'skip' });
    steps.push({ name: 'Test Extraction', status: 'skip' });
    yield { step: 'crawl', status: 'skip', detail: 'No target URL configured' };
    yield { step: 'extraction', status: 'skip', detail: 'Skipped — no target URL' };
  }

  // Final summary
  const passed = steps.filter(s => s.status === 'pass').length;
  const total = steps.filter(s => s.status !== 'skip').length;
  yield {
    step: 'summary',
    status: passed === total ? 'pass' : 'partial',
    detail: `${passed}/${total} tests passed`,
    steps,
  };
}
