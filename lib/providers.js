/**
 * lib/providers.js — the one place that knows how to ask a model a question.
 *
 * Analysis prompts used to reach a model through callAnalysisModel in cli.js:
 * a Gemini CLI on PATH, the Agent Harness gateway on localhost, and nothing
 * else. Every call was text in, text out, and the caller regex-hunted the
 * JSON it hoped was in the answer. Meanwhile setup/validator.js already knew
 * how to ping Anthropic, OpenAI, Gemini and DeepSeek with a raw fetch, but
 * only to say "key valid". Each new judgment would have copied one of those
 * paths, and every copy would have drifted: a different timeout here, a
 * different error string there, and no way to say which model actually
 * produced a finding.
 *
 * So the transport lives here and nowhere else. This module knows:
 *   - which providers exist and what each defaults to (PROVIDERS)
 *   - how a provider is chosen when nobody said (resolveProvider): an explicit
 *     name, the shape of a model id, the first key in .env, the gateway, the
 *     CLI — in that order, pure given injected probes so the table is testable
 *   - the exact request each API wants (build*Request) and how to read what
 *     comes back (read*Response), both pure so a fixture can prove them
 *   - how an HTTP failure becomes something a person can act on
 *     (ProviderError: 401 names the env var, 429 waits once, 5xx retries once,
 *     a refusal is never retried and never falls back)
 *   - the schema loop (callModel): ask for JSON that matches a schema, check
 *     it client-side with lib/schema-check.js, and send the errors back for
 *     one repair before giving up
 *   - the legacy text path (callTextWithFallback): the provider the model
 *     name implies, then the Agent Harness, then the Gemini CLI, exactly the
 *     order cli.js always used
 *
 * Every provider is called over raw HTTP with the global fetch, the way
 * validator.js pings them; no SDKs, no new dependencies. fetch and spawn are
 * injectable so tests never touch a real API, and env is injectable so the
 * resolver can be exercised as a table.
 *
 * Provider facts this module treats as the spec: Anthropic takes no
 * temperature (thinking is adaptive), takes the schema as
 * output_config.format and runs a declined request on a fallback model when
 * asked (fallbacks: 'default' plus its beta header; ANTHROPIC_FALLBACKS=off
 * drops both). OpenAI wants max_completion_tokens and a strict json_schema
 * response_format. Gemini wants responseMimeType + responseSchema in
 * generationConfig and the key in the URL. DeepSeek has json_object mode
 * and no schema, so the schema rides in the prompt and is checked here.
 * Ollama takes the schema as `format`, which is what makes a small local
 * model viable for a narrow judgment. The Agent Harness gateway and the
 * Gemini CLI are text only.
 *
 * Log lines go through opts.log as plain text; the CLI decides how to dim
 * them, like every other lib module leaves colour to its caller.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJson, forAnthropic, forGemini, forOllama, forOpenAI, validate } from './schema-check.js';

// ── Providers ───────────────────────────────────────────────────────────────

/**
 * env          the API key variable, or null for a provider without one
 * defaultModel what a bare provider name means
 * native_json  the provider guarantees a JSON body when asked for one
 * local        the model runs on this machine or a local gateway
 */
export const PROVIDERS = {
  anthropic:    { env: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5', native_json: true, local: false },
  openai:       { env: 'OPENAI_API_KEY', defaultModel: 'gpt-4o-mini', native_json: true, local: false },
  gemini:       { env: 'GEMINI_API_KEY', defaultModel: 'gemini-2.0-flash', native_json: true, local: false },
  deepseek:     { env: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', native_json: true, local: false },
  ollama:       { env: null, defaultModel: 'gemma4:26b', native_json: true, local: true },
  harness:      { env: null, defaultModel: 'openclaw', native_json: false, local: true },
  'gemini-cli': { env: null, defaultModel: 'gemini-cli', native_json: false, local: true },
};

export const ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: (model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
  deepseek: 'https://api.deepseek.com/chat/completions',
  ollama: (baseUrl) => `${baseUrl.replace(/\/+$/, '')}/api/chat`,
  harness: 'http://127.0.0.1:18789/v1/chat/completions',
};

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

/** The order a key in .env wins when nothing else says which provider to use. */
const KEY_ORDER = ['anthropic', 'openai', 'gemini', 'deepseek'];

/** Spellings of a provider that other parts of the tool still use. */
const PROVIDER_ALIASES = {
  claude: 'anthropic',
  gpt: 'openai',
  google: 'gemini',
  openclaw: 'harness',
  'agent-harness': 'harness',
};

/**
 * Legacy model aliases: a bare word that names a provider and means "its
 * default model". 'default' is what the harness path always mapped to
 * 'openclaw'. 'gemini' is resolved by routeModel because it depends on a key.
 */
const MODEL_ALIASES = {
  claude: 'anthropic',
  gpt: 'openai',
  deepseek: 'deepseek',
  ollama: 'ollama',
  openclaw: 'harness',
  harness: 'harness',
  default: 'harness',
  'gemini-cli': 'gemini-cli',
};

const SETUP_HINT = 'Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or DEEPSEEK_API_KEY in .env '
  + '(or ANALYSIS_PROVIDER=ollama with a local model), start the Agent Harness gateway, '
  + 'or install the Gemini CLI. Run: seo-intel setup';

// ── ProviderError ───────────────────────────────────────────────────────────

/**
 * kind:
 *   config       nothing to call, or the call is misconfigured (no key, unknown provider)
 *   auth         401/403 — the key or token was rejected
 *   rate_limit   429 — retried once, then this
 *   server       5xx, or any other non-OK answer, or a body without an answer
 *   refusal      a safety classifier declined; never retried, never falls back
 *   truncated    the answer hit max tokens; raise maxTokens
 *   invalid_json the answer did not match the schema after one repair
 *   transport    timeout, DNS, connection refused
 */
export class ProviderError extends Error {
  constructor(message, { provider = null, model = null, status = null, kind = 'server', hint = null, errors = null, text = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.kind = kind;
    this.hint = hint;
    if (errors) this.errors = errors;
    if (text !== null) this.text = text;
  }
}

// ── Probes ──────────────────────────────────────────────────────────────────

/**
 * The Agent Harness bearer token: OPENCLAW_TOKEN, else the last "token" in
 * ~/.openclaw/openclaw.json. Moved verbatim from cli.js getOpenClawToken.
 */
export function getHarnessToken(env = process.env) {
  const envToken = env.OPENCLAW_TOKEN?.trim();
  if (envToken) return envToken;

  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
  try {
    const raw = readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf8');
    const matches = [...raw.matchAll(/"token":\s*"([a-f0-9]{40,})"/g)];
    if (matches.length > 0) return matches[matches.length - 1][1];
  } catch {}

  return null;
}

/** Whether `gemini --version` runs: the CLI is installed and on PATH. */
export function hasGeminiCli(spawn = spawnSync) {
  try {
    const r = spawn('gemini', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: 'pipe' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

// ── resolveProvider ─────────────────────────────────────────────────────────

function normalizeProvider(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return PROVIDER_ALIASES[n] || n;
}

function defaultModelFor(provider, env) {
  if (provider === 'ollama') return env.OLLAMA_ANALYSIS_MODEL || PROVIDERS.ollama.defaultModel;
  if (provider === 'harness') {
    const m = env.OPENCLAW_ANALYSIS_MODEL;
    return !m || m === 'default' ? PROVIDERS.harness.defaultModel : m;
  }
  return PROVIDERS[provider].defaultModel;
}

/**
 * Which provider a model id implies, or null when the name says nothing.
 * 'gemini*' means the API when a key exists and the CLI otherwise, which is
 * why this takes env.
 */
export function routeModel(name, env = {}) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (MODEL_ALIASES[n]) return MODEL_ALIASES[n];
  if (n === 'gemini') return env.GEMINI_API_KEY ? 'gemini' : 'gemini-cli';
  // An Ollama tag names its variant after a colon, and several local models
  // carry a cloud vendor's name (deepseek-r1:14b, gpt-oss:20b), so the colon
  // is checked before any cloud prefix. OpenAI fine-tune ids also contain
  // colons but always start with "ft:", which keeps them on OpenAI.
  if (n.includes(':') && !n.startsWith('ft:')) return 'ollama';
  if (n.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o1|o3|o4)/.test(n)) return 'openai';
  if (n.startsWith('gemini')) return env.GEMINI_API_KEY ? 'gemini' : 'gemini-cli';
  if (n.startsWith('deepseek')) return 'deepseek';
  if (n.startsWith('openclaw')) return 'harness';
  if (n.startsWith('ft:')) return 'openai';
  if (/^(gemma|qwen|llama)/.test(n)) return 'ollama';
  return null;
}

function isModelAlias(name) {
  const n = String(name || '').trim().toLowerCase();
  return !!MODEL_ALIASES[n] || n === 'gemini';
}

/**
 * Decide which provider and model answer a call. Pure given the probes.
 *
 * Precedence: the provider argument → a model argument whose name routes
 * to a provider (an alias or a recognisable id) → ANALYSIS_PROVIDER → the
 * model name from ANALYSIS_MODEL → the first key set in KEY_ORDER → the
 * Agent Harness when a token exists → the Gemini CLI when it is installed →
 * a config error that names the env vars and `seo-intel setup`.
 *
 * A model argument outranks ANALYSIS_PROVIDER because the setup wizard
 * always writes ANALYSIS_PROVIDER, and a person who types `--model claude`
 * on the command line is asking for Claude this once; letting the .env
 * setting win would silently answer from the configured provider, or send
 * a Claude id to Gemini. ANALYSIS_PROVIDER still outranks ANALYSIS_MODEL:
 * both come from the same file, and the provider is the deliberate choice.
 *
 * A model name nothing recognises goes to the Agent Harness when a token
 * exists, because that is where cli.js always sent a non-Gemini model; with
 * no harness it is a config error rather than a guess at a cloud provider.
 *
 * @returns {{ provider: string, model: string, reason: string }}
 */
export function resolveProvider({
  provider,
  model,
  env = process.env,
  hasHarnessToken = () => !!getHarnessToken(env),
  hasGeminiCli: geminiCliProbe = () => hasGeminiCli(),
} = {}) {
  const modelName = (model && String(model).trim()) || (env.ANALYSIS_MODEL && String(env.ANALYSIS_MODEL).trim()) || '';
  const modelIsAlias = isModelAlias(modelName);

  // 1. Explicit provider. The argument always wins; ANALYSIS_PROVIDER yields
  //    to a model argument that names a different provider (see above).
  const argProvider = normalizeProvider(provider);
  const argModel = (model && String(model).trim()) || '';
  const argModelRoute = argModel ? routeModel(argModel, env) : null;
  const envProvider = normalizeProvider(env.ANALYSIS_PROVIDER);
  const modelOverridesEnv = !argProvider && envProvider && argModelRoute
    && argModelRoute !== envProvider;
  const explicit = argProvider || (modelOverridesEnv ? null : envProvider);
  if (explicit) {
    if (!PROVIDERS[explicit]) {
      throw new ProviderError(`Unknown analysis provider "${explicit}"`, {
        kind: 'config',
        hint: `Known providers: ${Object.keys(PROVIDERS).join(', ')}. ${SETUP_HINT}`,
      });
    }
    // Explicit stays explicit: a missing key surfaces as a config error at call time, not as a silent reroute.
    return {
      provider: explicit,
      model: modelName && !modelIsAlias ? modelName : defaultModelFor(explicit, env),
      reason: provider ? 'provider argument' : 'ANALYSIS_PROVIDER',
    };
  }

  // 2. The model name.
  if (modelName) {
    const routed = routeModel(modelName, env);
    if (routed) {
      const useDefault = modelIsAlias || routed === 'gemini-cli';
      return {
        provider: routed,
        model: useDefault ? defaultModelFor(routed, env) : modelName,
        reason: model
          ? (modelOverridesEnv ? `model name "${modelName}" overrides ANALYSIS_PROVIDER` : `model name "${modelName}"`)
          : `ANALYSIS_MODEL "${modelName}"`,
      };
    }
    if (hasHarnessToken()) {
      return { provider: 'harness', model: modelName, reason: `unrecognised model "${modelName}" sent to the Agent Harness` };
    }
    throw new ProviderError(`Cannot tell which provider serves the model "${modelName}"`, {
      kind: 'config',
      model: modelName,
      hint: `Set ANALYSIS_PROVIDER to one of ${Object.keys(PROVIDERS).join(', ')}, or use a recognisable model id (claude-*, gpt-*, gemini-*, deepseek-*, an Ollama tag with ':').`,
    });
  }

  // 3. The first key in .env.
  for (const p of KEY_ORDER) {
    if (env[PROVIDERS[p].env]) return { provider: p, model: defaultModelFor(p, env), reason: `${PROVIDERS[p].env} is set` };
  }

  // 4. The Agent Harness gateway.
  if (hasHarnessToken()) return { provider: 'harness', model: defaultModelFor('harness', env), reason: 'Agent Harness token found' };

  // 5. The Gemini CLI.
  if (geminiCliProbe()) return { provider: 'gemini-cli', model: 'gemini-cli', reason: 'gemini CLI on PATH' };

  throw new ProviderError('No analysis model configured', { kind: 'config', hint: SETUP_HINT });
}

// ── Request builders ────────────────────────────────────────────────────────

const JSON_HEADERS = { 'content-type': 'application/json' };

function chatMessages(system, prompt) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return messages;
}

/**
 * Anthropic Messages. No temperature and no thinking parameter: current
 * models reject the first and reason adaptively without the second. The
 * schema goes in output_config.format; effort only when asked for; the
 * server-side fallback header and body field unless fallbacks is false.
 */
export function buildAnthropicRequest({ model, system, prompt, schema, maxTokens = 4096, effort, fallbacks = true, apiKey = '' }) {
  const headers = {
    ...JSON_HEADERS,
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (system) body.system = system;
  if (schema || effort) {
    body.output_config = {};
    if (schema) body.output_config.format = { type: 'json_schema', schema: forAnthropic(schema) };
    if (effort) body.output_config.effort = effort;
  }
  if (fallbacks) {
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
    body.fallbacks = 'default';
  }
  return { url: ENDPOINTS.anthropic, headers, body };
}

/**
 * @returns {{ text: string, stop: 'ok'|'truncated'|'refusal', usage: { input: number, output: number }, model: string|null, category?: string }}
 */
export function readAnthropicResponse(json) {
  const text = (json?.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  const reason = json?.stop_reason;
  const stop = reason === 'refusal' ? 'refusal' : reason === 'max_tokens' ? 'truncated' : 'ok';
  const out = {
    text,
    stop,
    usage: { input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 },
    model: json?.model ?? null,
  };
  if (json?.stop_details?.category) out.category = json.stop_details.category;
  return out;
}

/**
 * OpenAI Chat Completions. max_completion_tokens is the current name for the
 * output cap. Temperature is left off the reasoning models (o-series, gpt-5)
 * that reject anything but the default.
 */
export function buildOpenAIRequest({ model, system, prompt, schema, maxTokens = 4096, temperature, apiKey = '', url = ENDPOINTS.openai }) {
  const body = {
    model,
    messages: chatMessages(system, prompt),
    max_completion_tokens: maxTokens,
  };
  if (temperature !== undefined && !/^(o\d|gpt-5)/.test(String(model))) body.temperature = temperature;
  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'seo_intel', strict: true, schema: forOpenAI(schema) },
    };
  }
  return { url, headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` }, body };
}

export function readOpenAIResponse(json) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const usage = { input: json?.usage?.prompt_tokens ?? 0, output: json?.usage?.completion_tokens ?? 0 };
  if (message.refusal) return { text: String(message.refusal), stop: 'refusal', usage, model: json?.model ?? null };
  // A content filter that withheld the answer is a refusal too: sending the
  // same request again, or to a fallback provider, gets the same verdict.
  if (choice.finish_reason === 'content_filter') {
    return { text: '', stop: 'refusal', usage, model: json?.model ?? null, category: 'content_filter' };
  }
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content) ? message.content.map(p => p?.text || '').join('') : '';
  return {
    text: content,
    stop: choice.finish_reason === 'length' ? 'truncated' : 'ok',
    usage,
    model: json?.model ?? null,
  };
}

/** Gemini generateContent: the key rides in the URL, the schema in generationConfig. */
export function buildGeminiRequest({ model, system, prompt, schema, maxTokens = 4096, temperature, apiKey = '' }) {
  const generationConfig = { maxOutputTokens: maxTokens };
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = forGemini(schema);
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return { url: ENDPOINTS.gemini(model, apiKey), headers: { ...JSON_HEADERS }, body };
}

const GEMINI_REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export function readGeminiResponse(json) {
  const usage = { input: json?.usageMetadata?.promptTokenCount ?? 0, output: json?.usageMetadata?.candidatesTokenCount ?? 0 };
  const model = json?.modelVersion ?? null;
  const candidate = json?.candidates?.[0];
  if (!candidate) {
    const blocked = json?.promptFeedback?.blockReason;
    return { text: '', stop: blocked ? 'refusal' : 'ok', usage, model, ...(blocked ? { category: blocked } : {}) };
  }
  const text = (candidate.content?.parts || []).map(p => p?.text || '').join('');
  const reason = candidate.finishReason;
  const stop = reason === 'MAX_TOKENS' ? 'truncated' : GEMINI_REFUSALS.has(reason) ? 'refusal' : 'ok';
  const out = { text, stop, usage, model };
  if (stop === 'refusal') out.category = reason;
  return out;
}

/**
 * The prompt with the schema appended as text, for every provider that
 * cannot take a schema as a request parameter (DeepSeek's json_object mode,
 * the Agent Harness gateway, the Gemini CLI). Without it those providers are
 * asked for JSON matching a schema they have never seen, and the one repair
 * request would say "match the schema" about a schema still unseen. No
 * schema: the prompt unchanged.
 */
export function withSchemaInPrompt(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\nReturn only a JSON value that matches this JSON Schema exactly (no prose, no code fences):\n${JSON.stringify(schema)}`;
}

/**
 * DeepSeek: OpenAI-shaped, json_object mode, no schema support. The schema
 * is appended to the prompt as text (json_object mode also insists the word
 * "json" appears in the prompt) and the answer is validated here.
 */
export function buildDeepSeekRequest({ model, system, prompt, schema, maxTokens = 4096, temperature, apiKey = '', url = ENDPOINTS.deepseek }) {
  const body = { model, messages: [], max_tokens: maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  if (schema) body.response_format = { type: 'json_object' };
  body.messages = chatMessages(system, withSchemaInPrompt(prompt, schema));
  return { url, headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` }, body };
}

export const readDeepSeekResponse = readOpenAIResponse;

/**
 * Ollama /api/chat: the schema is the `format`, which constrains decoding
 * and is what lets a small local model answer a narrow judgment reliably.
 */
export function buildOllamaRequest({ model, system, prompt, schema, maxTokens = 4096, temperature = 0.2, baseUrl = OLLAMA_DEFAULT_URL, numCtx = 16384 }) {
  const body = {
    model,
    messages: chatMessages(system, prompt),
    stream: false,
    options: { temperature, num_ctx: numCtx, num_predict: maxTokens },
  };
  if (schema) body.format = forOllama(schema);
  return { url: ENDPOINTS.ollama(baseUrl), headers: { ...JSON_HEADERS }, body };
}

export function readOllamaResponse(json) {
  return {
    text: json?.message?.content ?? '',
    stop: json?.done_reason === 'length' ? 'truncated' : 'ok',
    usage: { input: json?.prompt_eval_count ?? 0, output: json?.eval_count ?? 0 },
    model: json?.model ?? null,
  };
}

/**
 * Agent Harness gateway: OpenAI-shaped, text only, so a schema rides in the
 * prompt (withSchemaInPrompt). The gateway expects the
 * model id 'openclaw' or 'openclaw/<agentId>'; 'default' and an empty model
 * mean 'openclaw', as callOpenClaw in cli.js always mapped them.
 */
export function buildHarnessRequest({ model, system, prompt, schema, maxTokens = 4000, temperature = 0.2, token = '', url = ENDPOINTS.harness }) {
  const clawModel = (!model || model === 'default') ? 'openclaw' : model;
  return {
    url,
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: { model: clawModel, messages: chatMessages(system, withSchemaInPrompt(prompt, schema)), temperature, max_tokens: maxTokens },
  };
}

export const readHarnessResponse = readOpenAIResponse;

const BUILDERS = {
  anthropic: buildAnthropicRequest,
  openai: buildOpenAIRequest,
  gemini: buildGeminiRequest,
  deepseek: buildDeepSeekRequest,
  ollama: buildOllamaRequest,
  harness: buildHarnessRequest,
};

const READERS = {
  anthropic: readAnthropicResponse,
  openai: readOpenAIResponse,
  gemini: readGeminiResponse,
  deepseek: readDeepSeekResponse,
  ollama: readOllamaResponse,
  harness: readHarnessResponse,
};

// ── HTTP ────────────────────────────────────────────────────────────────────

function authHint(provider) {
  if (provider === 'harness') return 'Check OPENCLAW_TOKEN, or the token in ~/.openclaw/openclaw.json, against the running gateway.';
  if (provider === 'ollama') return 'Ollama does not take a key; check OLLAMA_URL points at your own instance.';
  const envVar = PROVIDERS[provider]?.env;
  return envVar ? `Check ${envVar} in .env, or run: seo-intel setup` : 'Check the provider credentials.';
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  return 'server';
}

/** The message a provider put in an error body, whatever shape it chose. */
function bodyMessage(json, text) {
  const m = json?.error?.message || (typeof json?.error === 'string' ? json.error : null) || json?.message;
  if (m) return String(m);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function postJson(fetch, { url, headers, body }, { timeoutMs, label, provider, model }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    let text = '';
    let json = null;
    if (typeof res.text === 'function') {
      text = await res.text().catch(() => '');
      try { json = JSON.parse(text); } catch { /* not JSON: text tells the story */ }
    } else if (typeof res.json === 'function') {
      json = await res.json().catch(() => null);
    }
    return { ok: !!res.ok, status: Number(res.status), json, text };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ProviderError(`${label}: no answer within ${timeoutMs}ms`, {
        provider, model, kind: 'transport', cause: err,
        hint: `Raise ANALYSIS_TIMEOUT_MS in .env (milliseconds; this call allowed ${timeoutMs}), or ask for fewer items per call.`,
      });
    }
    const local = PROVIDERS[provider]?.local;
    throw new ProviderError(`${label}: ${err?.message || String(err)}`, {
      provider, model, kind: 'transport', cause: err,
      hint: local ? (provider === 'ollama' ? 'Is Ollama running? Check OLLAMA_URL.' : 'Is the Agent Harness gateway running? Start it: openclaw gateway') : 'Check the network connection and any proxy.',
    });
  } finally {
    clearTimeout(timer);
  }
}

const defaultSleep = (ms) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How long one request may take, in milliseconds. An explicit timeoutMs
 * wins; then ANALYSIS_TIMEOUT_MS, which every provider honours; then the
 * variable the legacy text path read for that transport (GEMINI_TIMEOUT_MS
 * for Gemini, OPENCLAW_TIMEOUT_MS for the Agent Harness), so a setting that
 * used to lengthen analyze still does; then two minutes. A large local model
 * labelling forty keywords on modest hardware can need more than that, and
 * without an env knob the CLI would have no way to say so.
 */
export function resolveTimeoutMs(provider, env = {}, explicit) {
  const pick = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const legacy = provider === 'gemini' || provider === 'gemini-cli' ? env.GEMINI_TIMEOUT_MS
    : provider === 'harness' ? env.OPENCLAW_TIMEOUT_MS : undefined;
  return pick(explicit) ?? pick(env.ANALYSIS_TIMEOUT_MS) ?? pick(legacy) ?? DEFAULT_TIMEOUT_MS;
}

/** One text-only answer from the Gemini CLI, exactly as cli.js spawned it. */
function runGeminiCli({ system, prompt, spawn, timeoutMs, label }) {
  const input = system ? `${system}\n\n${prompt}` : prompt;
  const result = spawn('gemini', ['-p', '-'], { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new ProviderError(`${label}: ${result.error.message}`, {
      provider: 'gemini-cli', model: 'gemini-cli', kind: 'transport', cause: result.error,
      hint: timedOut ? `Gemini timed out after ${timeoutMs}ms. Raise ANALYSIS_TIMEOUT_MS (or GEMINI_TIMEOUT_MS) in .env, e.g. 300000.` : 'Is the Gemini CLI installed and on PATH? npm i -g @google/gemini-cli',
    });
  }
  if (result.status !== 0) {
    throw new ProviderError(`${label}: ${result.stderr?.trim() || `gemini exited with status ${result.status}`}`, {
      provider: 'gemini-cli', model: 'gemini-cli', kind: 'server', status: result.status,
    });
  }
  return { text: result.stdout || '', stop: 'ok', usage: { input: 0, output: 0 }, model: 'gemini-cli' };
}

// ── callModel ───────────────────────────────────────────────────────────────

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text.trim());
    return v !== null && typeof v === 'object' ? v : extractJson(text);
  } catch {
    return extractJson(text);
  }
}

function repairSuffix(errors, text) {
  const began = String(text || '').slice(0, 400);
  return `\n\nYour previous answer was not valid: ${errors.join('; ')}. It began: ${began}. Return only JSON that matches the schema.`;
}

/**
 * Ask a model one question and, when a schema is given, insist on an answer
 * that matches it.
 *
 * Flow: resolve provider → build the request → POST with a timeout (or
 * spawn the Gemini CLI) → map the status (401/403 auth, 429 rate_limit with
 * one retry, 5xx server with one retry, other non-OK server with the body's
 * message) → read the answer → refusal or truncation throws → with a schema,
 * parse (JSON.parse, then extractJson) and validate; on failure send ONE
 * repair request carrying the errors; still invalid throws invalid_json
 * with the errors and the text attached.
 *
 * `model` in the result is the model that answered (the response body's
 * own model field when it carries one), `requested_model` the one asked for.
 *
 * @returns {Promise<{ text: string, json: any, provider: string, model: string, requested_model: string, attempts: number, usage: { input: number, output: number }, ms: number }>}
 */
export async function callModel({
  provider: providerArg,
  model: modelArg,
  system,
  prompt,
  schema,
  limits,
  maxTokens = 4096,
  effort,
  temperature = 0.2,
  timeoutMs: timeoutArg,
  retries = 1,
  retryDelayMs = 2000,
  fetch = globalThis.fetch,
  spawn = spawnSync,
  env = process.env,
  log,
  numCtx,
  sleep = defaultSleep,
} = {}) {
  const started = Date.now();
  if (typeof prompt !== 'string' || !prompt) {
    throw new ProviderError('callModel needs a prompt', { kind: 'config' });
  }
  const { provider, model } = resolveProvider({
    provider: providerArg,
    model: modelArg,
    env,
    hasHarnessToken: () => !!getHarnessToken(env),
    hasGeminiCli: () => hasGeminiCli(spawn),
  });
  const label = `${provider} (${model})`;
  const timeoutMs = resolveTimeoutMs(provider, env, timeoutArg);
  const usage = { input: 0, output: 0 };
  let attempts = 0;

  // Everything a builder could want; each takes what it needs.
  const credentials = () => {
    const envVar = PROVIDERS[provider].env;
    if (envVar) {
      const apiKey = env[envVar];
      if (!apiKey) throw new ProviderError(`${label}: ${envVar} is not set`, { provider, model, kind: 'config', hint: authHint(provider) });
      return { apiKey };
    }
    if (provider === 'harness') {
      const token = getHarnessToken(env);
      if (!token) throw new ProviderError(`${label}: Agent Harness token not found`, { provider, model, kind: 'config', hint: authHint('harness') });
      return { token };
    }
    return {};
  };

  const ask = async (userPrompt) => {
    if (provider === 'gemini-cli') {
      attempts++;
      return runGeminiCli({ system, prompt: withSchemaInPrompt(userPrompt, schema), spawn, timeoutMs, label });
    }
    const req = BUILDERS[provider]({
      model, system, prompt: userPrompt, schema, maxTokens, effort, temperature,
      fallbacks: env.ANTHROPIC_FALLBACKS !== 'off',
      baseUrl: env.OLLAMA_URL || OLLAMA_DEFAULT_URL,
      numCtx: numCtx ?? (env.OLLAMA_ANALYSIS_CTX ? Number(env.OLLAMA_ANALYSIS_CTX) : undefined),
      ...credentials(),
    });
    for (let attempt = 0; ; attempt++) {
      attempts++;
      const res = await postJson(fetch, req, { timeoutMs, label, provider, model });
      if (res.ok) {
        if (res.json?.error && provider === 'ollama') {
          throw new ProviderError(`${label}: ${bodyMessage(res.json, res.text)}`, { provider, model, kind: 'server', status: res.status });
        }
        if (!res.json) {
          throw new ProviderError(`${label}: answer was not JSON`, { provider, model, kind: 'server', status: res.status, text: res.text });
        }
        return READERS[provider](res.json);
      }
      const kind = kindForStatus(res.status);
      const retryable = (kind === 'rate_limit' || res.status >= 500) && attempt < retries;
      if (retryable) {
        log?.(`[${provider}] HTTP ${res.status}; retrying once in ${retryDelayMs}ms`);
        await sleep(retryDelayMs);
        continue;
      }
      const message = bodyMessage(res.json, res.text);
      throw new ProviderError(`${label}: HTTP ${res.status}${message ? ` ${message}` : ''}`, {
        provider, model, status: res.status, kind,
        hint: kind === 'auth' ? authHint(provider)
          : kind === 'rate_limit' ? 'Rate limited; wait a little and run again, or lower concurrency.'
          : (res.status === 400 || res.status === 404) ? 'Check the model id and the request; the provider rejected it.'
          : 'The provider had a problem; run again in a moment.',
      });
    }
  };

  const finish = (answer) => {
    usage.input += answer.usage?.input ?? 0;
    usage.output += answer.usage?.output ?? 0;
    if (answer.stop === 'refusal') {
      const why = answer.category ? ` (${answer.category})` : '';
      throw new ProviderError(`${label}: the model declined to answer${why}`, {
        provider, model, kind: 'refusal', text: answer.text,
        hint: 'A safety classifier declined this request. Rephrase the prompt or narrow the content; retrying the same request will not help.',
      });
    }
    if (answer.stop === 'truncated') {
      throw new ProviderError(`${label}: the answer was cut off at ${maxTokens} tokens`, {
        provider, model, kind: 'truncated', text: answer.text,
        hint: 'Raise maxTokens, or ask for fewer items per call.',
      });
    }
    return answer;
  };

  // The model that answered, which is not always the one asked for: an
  // Anthropic request carries server-side fallbacks by default, so a request
  // the named model declined comes back from another. Provenance must name
  // what produced the words; `requested_model` keeps what was asked for.
  const served = (a) => (a && typeof a.model === 'string' && a.model.trim()) ? a.model.trim() : model;

  let answer = finish(await ask(prompt));
  if (!schema) {
    return { text: answer.text, json: null, provider, model: served(answer), requested_model: model, attempts, usage, ms: Date.now() - started };
  }

  let json = parseJson(answer.text);
  let check = json === null ? { ok: false, errors: ['$: no JSON value found in the answer'] } : validate(schema, json, limits);
  if (!check.ok) {
    log?.(`[${provider}] answer did not match the schema (${check.errors.length} problem${check.errors.length === 1 ? '' : 's'}); asking once more`);
    answer = finish(await ask(prompt + repairSuffix(check.errors, answer.text)));
    json = parseJson(answer.text);
    check = json === null ? { ok: false, errors: ['$: no JSON value found in the answer'] } : validate(schema, json, limits);
    if (!check.ok) {
      throw new ProviderError(`${label}: answer did not match the schema after one repair: ${check.errors.slice(0, 5).join('; ')}`, {
        provider, model, kind: 'invalid_json', errors: check.errors, text: answer.text,
        hint: 'The model could not produce the requested shape. Try a stronger model, a smaller batch, or a simpler schema.',
      });
    }
  }
  return { text: answer.text, json, provider, model: served(answer), requested_model: model, attempts, usage, ms: Date.now() - started };
}

/** callModel without a schema: text in, text out. */
export async function callText(opts = {}) {
  const { schema, limits, ...rest } = opts;
  return callModel(rest);
}

/**
 * The legacy text path cli.js callAnalysisModel had, generalised: resolve
 * the provider from the model name (aliases included), try it, and on any
 * ProviderError except a refusal fall to the Agent Harness (when a token
 * exists) and then to the Gemini CLI (when it is installed), one plain log
 * line per fallback. Returns the text and which provider and model actually
 * answered, which is what provenance (analyses.model, insights.model) needs.
 *
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 */
export async function callTextWithFallback({ model, prompt, ...opts } = {}) {
  const env = opts.env || process.env;
  const spawn = opts.spawn || spawnSync;
  const log = opts.log || (() => {});
  const candidates = [];
  let lastErr = null;

  try {
    const first = resolveProvider({
      provider: opts.provider,
      model,
      env,
      hasHarnessToken: () => !!getHarnessToken(env),
      hasGeminiCli: () => hasGeminiCli(spawn),
    });
    candidates.push(first);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    lastErr = err;
  }

  const tried = new Set(candidates.map(c => c.provider));
  if (!tried.has('harness') && getHarnessToken(env)) {
    // The requested model was a harness id already if it is unrecognised; otherwise the configured default.
    candidates.push({ provider: 'harness', model: defaultModelFor('harness', env), reason: 'fallback' });
  }
  if (!tried.has('gemini-cli') && hasGeminiCli(spawn)) {
    candidates.push({ provider: 'gemini-cli', model: 'gemini-cli', reason: 'fallback' });
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (lastErr) log(`[${lastErr.provider || 'analysis'}] ${lastErr.message}; falling back to ${c.provider} (${c.model})`);
    try {
      const r = await callText({ ...opts, provider: c.provider, model: c.model, prompt, env, spawn, log });
      return { text: r.text, provider: r.provider, model: r.model };
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind === 'refusal') throw err;
      lastErr = err;
    }
  }

  throw lastErr || new ProviderError('No analysis model configured', { kind: 'config', hint: SETUP_HINT });
}
