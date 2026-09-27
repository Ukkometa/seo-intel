/**
 * The provider layer — resolver precedence, request builders, response
 * readers, the schema/repair loop in callModel, HTTP status mapping and the
 * legacy fallback chain.
 *
 * Nothing here reaches a real model: fetch is a scripted mock that records
 * every request, spawn is a stub for the Gemini CLI, and env is always an
 * explicit object (with no HOME, so the harness token never comes from
 * ~/.openclaw). A test that reaches the network is a bug in the test.
 */
import assert from 'node:assert/strict';
import {
  ANTHROPIC_FALLBACK_BETA,
  ENDPOINTS,
  PROVIDERS,
  ProviderError,
  buildAnthropicRequest,
  buildDeepSeekRequest,
  buildGeminiRequest,
  buildHarnessRequest,
  buildOllamaRequest,
  buildOpenAIRequest,
  callModel,
  callText,
  callTextWithFallback,
  getHarnessToken,
  hasGeminiCli,
  readAnthropicResponse,
  readGeminiResponse,
  readOllamaResponse,
  readOpenAIResponse,
  resolveProvider,
  resolveTimeoutMs,
  routeModel,
  withSchemaInPrompt,
} from '../lib/providers.js';
import { forAnthropic, forGemini, forOllama } from '../lib/schema-check.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keyword', 'intent'],
        properties: {
          keyword: { type: 'string' },
          intent: { type: 'string', enum: ['informational', 'commercial'] },
        },
      },
    },
  },
};
const GOOD = { items: [{ keyword: 'seo tool', intent: 'commercial' }] };
const BAD = { items: [{ keyword: 'seo tool', intent: 'other' }] };

const never = () => false;
const always = () => true;

// ── resolveProvider: explicit provider ──────────────────────────────────────
{
  const r = resolveProvider({ provider: 'anthropic', env: {}, hasHarnessToken: never, hasGeminiCli: never });
  assert.deepEqual(r, { provider: 'anthropic', model: 'claude-opus-5', reason: 'provider argument' });

  assert.equal(resolveProvider({ provider: 'claude', env: {}, hasHarnessToken: never, hasGeminiCli: never }).provider, 'anthropic', "the wizard's and validator's 'claude' spelling");
  assert.equal(resolveProvider({ provider: 'openclaw', env: {}, hasHarnessToken: never, hasGeminiCli: never }).provider, 'harness');

  const env = resolveProvider({ env: { ANALYSIS_PROVIDER: 'openai', ANALYSIS_MODEL: 'gpt-4.1' }, hasHarnessToken: never, hasGeminiCli: never });
  assert.deepEqual(env, { provider: 'openai', model: 'gpt-4.1', reason: 'ANALYSIS_PROVIDER' });

  const ollama = resolveProvider({ env: { ANALYSIS_PROVIDER: 'ollama', OLLAMA_ANALYSIS_MODEL: 'qwen3:14b' }, hasHarnessToken: never, hasGeminiCli: never });
  assert.deepEqual(ollama, { provider: 'ollama', model: 'qwen3:14b', reason: 'ANALYSIS_PROVIDER' });

  const wizard = resolveProvider({ env: { ANALYSIS_PROVIDER: 'ollama', ANALYSIS_MODEL: 'gemma4:31b' }, hasHarnessToken: never, hasGeminiCli: never });
  assert.equal(wizard.model, 'gemma4:31b', 'the wizard writes ANALYSIS_PROVIDER + ANALYSIS_MODEL together');

  // an explicit provider beats what the model name implies, and the model id is passed through as given
  assert.deepEqual(
    resolveProvider({ provider: 'openai', model: 'claude-x', env: { ANALYSIS_PROVIDER: 'gemini' }, hasHarnessToken: never, hasGeminiCli: never }),
    { provider: 'openai', model: 'claude-x', reason: 'provider argument' },
  );
  assert.equal(resolveProvider({ provider: 'anthropic', model: 'claude', env: {}, hasHarnessToken: never, hasGeminiCli: never }).model, 'claude-opus-5', 'an alias model means the default');
  assert.equal(resolveProvider({ provider: 'gemini', env: {}, hasHarnessToken: never, hasGeminiCli: never }).provider, 'gemini', 'explicit gemini without a key stays gemini; the key error comes at call time');
  assert.equal(resolveProvider({ provider: 'anthropic', model: 'gpt-4o', env: {}, hasHarnessToken: never, hasGeminiCli: never }).model, 'gpt-4o', 'explicit provider with a foreign model id: no second-guessing');

  assert.throws(
    () => resolveProvider({ provider: 'bedrock', env: {}, hasHarnessToken: never, hasGeminiCli: never }),
    (e) => e instanceof ProviderError && e.kind === 'config' && /bedrock/.test(e.message) && /seo-intel setup/.test(e.hint),
  );
}

// ── resolveProvider: legacy aliases select the provider and its default ─────
{
  const on = (model, env = {}) => resolveProvider({ model, env, hasHarnessToken: never, hasGeminiCli: never });
  assert.deepEqual(on('claude'), { provider: 'anthropic', model: 'claude-opus-5', reason: 'model name "claude"' });
  assert.deepEqual(on('gpt'), { provider: 'openai', model: 'gpt-4o-mini', reason: 'model name "gpt"' });
  assert.deepEqual(on('deepseek'), { provider: 'deepseek', model: 'deepseek-chat', reason: 'model name "deepseek"' });
  assert.deepEqual(on('ollama'), { provider: 'ollama', model: PROVIDERS.ollama.defaultModel, reason: 'model name "ollama"' });
  assert.deepEqual(on('gemini', { GEMINI_API_KEY: 'k' }), { provider: 'gemini', model: 'gemini-2.0-flash', reason: 'model name "gemini"' });
  assert.deepEqual(on('gemini'), { provider: 'gemini-cli', model: 'gemini-cli', reason: 'model name "gemini"' }, 'gemini without a key is the CLI, as cli.js always did');
  assert.deepEqual(on('openclaw'), { provider: 'harness', model: 'openclaw', reason: 'model name "openclaw"' });
  assert.deepEqual(on('default'), { provider: 'harness', model: 'openclaw', reason: 'model name "default"' }, "'default' was the harness default agent");
  assert.equal(on('GEMINI', { GEMINI_API_KEY: 'k' }).provider, 'gemini', 'aliases are case-insensitive');
}

// ── resolveProvider: model-name routing ─────────────────────────────────────
{
  const on = (model, env = {}, probes = {}) => resolveProvider({ model, env, hasHarnessToken: never, hasGeminiCli: never, ...probes });
  assert.deepEqual(on('claude-sonnet-4-5'), { provider: 'anthropic', model: 'claude-sonnet-4-5', reason: 'model name "claude-sonnet-4-5"' });
  assert.equal(on('gpt-5.4').provider, 'openai');
  assert.equal(on('o3-mini').provider, 'openai');
  assert.equal(on('o1').provider, 'openai');
  assert.equal(on('o4-mini').provider, 'openai');
  assert.deepEqual(on('gemini-2.5-pro', { GEMINI_API_KEY: 'k' }), { provider: 'gemini', model: 'gemini-2.5-pro', reason: 'model name "gemini-2.5-pro"' });
  assert.deepEqual(on('gemini-2.5-pro'), { provider: 'gemini-cli', model: 'gemini-cli', reason: 'model name "gemini-2.5-pro"' }, 'no key: the CLI, which takes no model id');
  assert.equal(on('deepseek-reasoner').provider, 'deepseek');
  assert.equal(on('gemma4:26b').provider, 'ollama');
  assert.equal(on('qwen3:14b').provider, 'ollama');
  assert.equal(on('llama3').provider, 'ollama');
  assert.equal(on('nemotron-3-super:120b').provider, 'ollama', 'any tag with a colon is an Ollama tag');
  assert.deepEqual(on('openclaw/seo'), { provider: 'harness', model: 'openclaw/seo', reason: 'model name "openclaw/seo"' });

  assert.equal(routeModel('Claude-Opus-5'), 'anthropic', 'routing is case-insensitive');
  assert.equal(routeModel('my-agent'), null);
  assert.equal(routeModel(''), null);

  // ANALYSIS_MODEL alone routes the same way
  assert.deepEqual(on(undefined, { ANALYSIS_MODEL: 'deepseek-chat' }), { provider: 'deepseek', model: 'deepseek-chat', reason: 'ANALYSIS_MODEL "deepseek-chat"' });

  // an unrecognised model goes where cli.js sent every non-Gemini model: the harness, when there is one
  assert.deepEqual(on('my-agent', {}, { hasHarnessToken: always }), { provider: 'harness', model: 'my-agent', reason: 'unrecognised model "my-agent" sent to the Agent Harness' });
  assert.throws(
    () => on('my-agent'),
    (e) => e instanceof ProviderError && e.kind === 'config' && /my-agent/.test(e.message) && /ANALYSIS_PROVIDER/.test(e.hint),
    'with no harness it is a config error, not a guess',
  );
}

// ── resolveProvider: key order, then the probes, then a config error ────────
{
  const on = (env, probes = {}) => resolveProvider({ env, hasHarnessToken: never, hasGeminiCli: never, ...probes });
  assert.deepEqual(on({ OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd' }), { provider: 'openai', model: 'gpt-4o-mini', reason: 'OPENAI_API_KEY is set' });
  assert.equal(on({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' }).provider, 'anthropic');
  assert.equal(on({ GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' }).provider, 'gemini');
  assert.deepEqual(on({ DEEPSEEK_API_KEY: 'd' }), { provider: 'deepseek', model: 'deepseek-chat', reason: 'DEEPSEEK_API_KEY is set' });
  assert.equal(on({ ANTHROPIC_API_KEY: '' }, { hasHarnessToken: always }).provider, 'harness', 'an empty key does not count');

  assert.deepEqual(on({}, { hasHarnessToken: always }), { provider: 'harness', model: 'openclaw', reason: 'Agent Harness token found' });
  assert.equal(on({ OPENCLAW_ANALYSIS_MODEL: 'openclaw/seo' }, { hasHarnessToken: always }).model, 'openclaw/seo');
  assert.equal(on({ OPENCLAW_ANALYSIS_MODEL: 'default' }, { hasHarnessToken: always }).model, 'openclaw', "the .env.example's 'default' means the gateway default");
  assert.deepEqual(on({}, { hasGeminiCli: always }), { provider: 'gemini-cli', model: 'gemini-cli', reason: 'gemini CLI on PATH' });
  assert.equal(on({}, { hasHarnessToken: always, hasGeminiCli: always }).provider, 'harness', 'the harness is tried before the CLI');

  assert.throws(
    () => on({}),
    (e) => e instanceof ProviderError && e.kind === 'config'
      && /ANTHROPIC_API_KEY/.test(e.hint) && /OPENAI_API_KEY/.test(e.hint) && /GEMINI_API_KEY/.test(e.hint) && /DEEPSEEK_API_KEY/.test(e.hint)
      && /seo-intel setup/.test(e.hint),
  );

  // the probes are lazy: with a key set neither is consulted
  let probed = 0;
  on({ ANTHROPIC_API_KEY: 'a' }, { hasHarnessToken: () => { probed++; return true; }, hasGeminiCli: () => { probed++; return true; } });
  assert.equal(probed, 0);
}

// ── PROVIDERS table ─────────────────────────────────────────────────────────
{
  assert.deepEqual(Object.keys(PROVIDERS), ['anthropic', 'openai', 'gemini', 'deepseek', 'ollama', 'harness', 'gemini-cli']);
  assert.equal(PROVIDERS.anthropic.env, 'ANTHROPIC_API_KEY');
  assert.equal(PROVIDERS.openai.env, 'OPENAI_API_KEY');
  assert.equal(PROVIDERS.gemini.env, 'GEMINI_API_KEY');
  assert.equal(PROVIDERS.deepseek.env, 'DEEPSEEK_API_KEY');
  for (const p of ['ollama', 'harness', 'gemini-cli']) {
    assert.equal(PROVIDERS[p].env, null);
    assert.equal(PROVIDERS[p].local, true);
  }
  assert.equal(PROVIDERS.harness.native_json, false);
  assert.equal(PROVIDERS['gemini-cli'].native_json, false);
  assert.equal(PROVIDERS.anthropic.native_json, true);
}

// ── getHarnessToken / hasGeminiCli ──────────────────────────────────────────
{
  assert.equal(getHarnessToken({ OPENCLAW_TOKEN: '  abc  ' }), 'abc');
  assert.equal(getHarnessToken({}), null, 'no HOME: nothing to read');
  assert.equal(getHarnessToken({ HOME: '/nonexistent/for/sure' }), null);
  assert.equal(hasGeminiCli(() => ({ status: 0 })), true);
  assert.equal(hasGeminiCli(() => ({ status: 1 })), false);
  assert.equal(hasGeminiCli(() => ({ error: new Error('ENOENT') })), false);
  assert.equal(hasGeminiCli(() => { throw new Error('boom'); }), false);
}

// ── buildAnthropicRequest ───────────────────────────────────────────────────
{
  const r = buildAnthropicRequest({ model: 'claude-opus-5', system: 'sys', prompt: 'hi', schema: SCHEMA, maxTokens: 1000, effort: 'low', apiKey: 'sk-a' });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-a');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.headers['anthropic-beta'], ANTHROPIC_FALLBACK_BETA);
  assert.equal(r.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body.model, 'claude-opus-5');
  assert.equal(r.body.max_tokens, 1000);
  assert.equal(r.body.system, 'sys');
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal('temperature' in r.body, false, 'no temperature');
  assert.equal('top_p' in r.body, false);
  assert.equal('thinking' in r.body, false, 'no thinking parameter');
  assert.equal(r.body.output_config.format.type, 'json_schema');
  assert.deepEqual(r.body.output_config.format.schema, forAnthropic(SCHEMA));
  assert.equal(r.body.output_config.format.schema.additionalProperties, false);
  assert.equal(r.body.output_config.effort, 'low');
  assert.equal(r.body.fallbacks, 'default');

  const plain = buildAnthropicRequest({ model: 'claude-opus-5', prompt: 'hi', fallbacks: false });
  assert.equal('output_config' in plain.body, false, 'no schema and no effort: no output_config');
  assert.equal('system' in plain.body, false);
  assert.equal('fallbacks' in plain.body, false);
  assert.equal('anthropic-beta' in plain.headers, false);
  assert.equal(plain.body.max_tokens, 4096);

  const effortOnly = buildAnthropicRequest({ model: 'm', prompt: 'p', effort: 'high' });
  assert.deepEqual(effortOnly.body.output_config, { effort: 'high' });
}

// ── readAnthropicResponse ───────────────────────────────────────────────────
{
  const ok = readAnthropicResponse({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-opus-5' });
  assert.deepEqual(ok, { text: '{"a":1}', stop: 'ok', usage: { input: 10, output: 5 }, model: 'claude-opus-5' });
  const refusal = readAnthropicResponse({ content: [], stop_reason: 'refusal', stop_details: { category: 'harmful' }, usage: {} });
  assert.equal(refusal.stop, 'refusal');
  assert.equal(refusal.category, 'harmful');
  assert.equal(readAnthropicResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }).stop, 'truncated');
  assert.deepEqual(readAnthropicResponse({}), { text: '', stop: 'ok', usage: { input: 0, output: 0 }, model: null });
}

// ── buildOpenAIRequest / readOpenAIResponse ─────────────────────────────────
{
  const r = buildOpenAIRequest({ model: 'gpt-4o-mini', system: 'sys', prompt: 'hi', schema: SCHEMA, maxTokens: 500, temperature: 0.2, apiKey: 'sk-o' });
  assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer sk-o');
  assert.deepEqual(r.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(r.body.max_completion_tokens, 500);
  assert.equal('max_tokens' in r.body, false);
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.body.response_format.type, 'json_schema');
  assert.equal(r.body.response_format.json_schema.strict, true);
  assert.equal(r.body.response_format.json_schema.name, 'seo_intel');
  assert.deepEqual(r.body.response_format.json_schema.schema, forAnthropic(SCHEMA), 'strict mode takes the same shape as Anthropic');

  assert.equal('temperature' in buildOpenAIRequest({ model: 'o3-mini', prompt: 'p', temperature: 0.2 }).body, false, 'reasoning models reject temperature');
  assert.equal('temperature' in buildOpenAIRequest({ model: 'gpt-5.4', prompt: 'p', temperature: 0.2 }).body, false);
  assert.equal('response_format' in buildOpenAIRequest({ model: 'gpt-4o-mini', prompt: 'p' }).body, false);

  assert.deepEqual(
    readOpenAIResponse({ choices: [{ message: { content: '{"a":1}', refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'gpt-4o-mini-2024' }),
    { text: '{"a":1}', stop: 'ok', usage: { input: 3, output: 2 }, model: 'gpt-4o-mini-2024' },
  );
  assert.equal(readOpenAIResponse({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] }).stop, 'refusal');
  assert.equal(readOpenAIResponse({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }).stop, 'truncated');
}

// ── buildGeminiRequest / readGeminiResponse ─────────────────────────────────
{
  const r = buildGeminiRequest({ model: 'gemini-2.0-flash', system: 'sys', prompt: 'hi', schema: SCHEMA, maxTokens: 700, temperature: 0.1, apiKey: 'g-key' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=g-key');
  assert.equal(r.url, ENDPOINTS.gemini('gemini-2.0-flash', 'g-key'));
  assert.equal('authorization' in r.headers, false, 'the key rides in the URL');
  assert.deepEqual(r.body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(r.body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(r.body.generationConfig.maxOutputTokens, 700);
  assert.equal(r.body.generationConfig.temperature, 0.1);
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.body.generationConfig.responseSchema, forGemini(SCHEMA));
  assert.equal(JSON.stringify(r.body).includes('additionalProperties'), false);

  const plain = buildGeminiRequest({ model: 'gemini-2.0-flash', prompt: 'hi', apiKey: 'k' });
  assert.equal('responseSchema' in plain.body.generationConfig, false);
  assert.equal('systemInstruction' in plain.body, false);

  assert.deepEqual(
    readGeminiResponse({ candidates: [{ content: { parts: [{ text: '{"a"' }, { text: ':1}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 }, modelVersion: 'gemini-2.0-flash-001' }),
    { text: '{"a":1}', stop: 'ok', usage: { input: 7, output: 4 }, model: 'gemini-2.0-flash-001' },
  );
  assert.equal(readGeminiResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }).stop, 'truncated');
  const safety = readGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
  assert.equal(safety.stop, 'refusal');
  assert.equal(safety.category, 'SAFETY');
  assert.equal(readGeminiResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }).stop, 'refusal', 'a blocked prompt has no candidates at all');
}

// ── buildDeepSeekRequest ────────────────────────────────────────────────────
{
  const r = buildDeepSeekRequest({ model: 'deepseek-chat', system: 'sys', prompt: 'rank these', schema: SCHEMA, maxTokens: 300, temperature: 0.2, apiKey: 'ds' });
  assert.equal(r.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer ds');
  assert.deepEqual(r.body.response_format, { type: 'json_object' });
  assert.equal(r.body.max_tokens, 300);
  assert.equal(r.body.messages[0].role, 'system');
  const user = r.body.messages[1].content;
  assert.ok(user.startsWith('rank these'), 'the prompt comes first');
  assert.ok(user.includes(JSON.stringify(SCHEMA)), 'the schema is appended as text');
  assert.ok(/json/i.test(user), 'json_object mode insists the word appears in the prompt');

  const plain = buildDeepSeekRequest({ model: 'deepseek-chat', prompt: 'hi', apiKey: 'ds' });
  assert.equal('response_format' in plain.body, false);
  assert.equal(plain.body.messages[0].content, 'hi');
}

// ── buildOllamaRequest / readOllamaResponse ─────────────────────────────────
{
  const r = buildOllamaRequest({ model: 'gemma4:26b', system: 'sys', prompt: 'hi', schema: SCHEMA, maxTokens: 900, temperature: 0.3, baseUrl: 'http://gpu.local:11434/', numCtx: 32768 });
  assert.equal(r.url, 'http://gpu.local:11434/api/chat');
  assert.equal(r.body.model, 'gemma4:26b');
  assert.equal(r.body.stream, false);
  assert.deepEqual(r.body.format, forOllama(SCHEMA), 'the schema is the format');
  assert.deepEqual(r.body.options, { temperature: 0.3, num_ctx: 32768, num_predict: 900 });
  assert.equal(buildOllamaRequest({ model: 'm', prompt: 'p' }).url, 'http://127.0.0.1:11434/api/chat');
  assert.equal('format' in buildOllamaRequest({ model: 'm', prompt: 'p' }).body, false);

  assert.deepEqual(
    readOllamaResponse({ message: { role: 'assistant', content: '{"a":1}' }, done_reason: 'stop', prompt_eval_count: 12, eval_count: 6, model: 'gemma4:26b' }),
    { text: '{"a":1}', stop: 'ok', usage: { input: 12, output: 6 }, model: 'gemma4:26b' },
  );
  assert.equal(readOllamaResponse({ message: { content: '{' }, done_reason: 'length' }).stop, 'truncated');
}

// ── buildHarnessRequest ─────────────────────────────────────────────────────
{
  const r = buildHarnessRequest({ model: 'default', prompt: 'hi', token: 'tok' });
  assert.equal(r.url, 'http://127.0.0.1:18789/v1/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer tok');
  assert.equal(r.body.model, 'openclaw', "'default' maps to the gateway's id, as callOpenClaw did");
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.body.max_tokens, 4000);
  assert.equal(buildHarnessRequest({ model: 'openclaw/seo', prompt: 'hi', token: 't' }).body.model, 'openclaw/seo');
  assert.equal(buildHarnessRequest({ prompt: 'hi', token: 't' }).body.model, 'openclaw');
}

// ── A scripted fetch ────────────────────────────────────────────────────────
// Each step is { status?, json?, text? } or a function of the recorded request.
// The last step repeats for any further call.
function mockFetch(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { url, headers: init.headers || {}, body, signal: init.signal };
    calls.push(call);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const r = typeof step === 'function' ? step(call) : step;
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.json ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { fetch, calls };
}
const anthropicOk = (text, extra = {}) => ({ json: { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, model: 'claude-opus-5', ...extra } });
const openaiOk = (content) => ({ json: { choices: [{ message: { content, refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 }, model: 'gpt-4o-mini' } });
const ANTHROPIC_ENV = { ANTHROPIC_API_KEY: 'sk-a' };

// ── callModel: valid JSON first try ─────────────────────────────────────────
{
  const { fetch, calls } = mockFetch([anthropicOk(JSON.stringify(GOOD))]);
  const r = await callModel({ provider: 'anthropic', system: 'sys', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV });
  assert.deepEqual(r.json, GOOD);
  assert.equal(r.text, JSON.stringify(GOOD));
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.usage, { input: 10, output: 5 });
  assert.equal(typeof r.ms, 'number');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINTS.anthropic);
  assert.equal(calls[0].headers['x-key'], undefined);
  assert.equal(calls[0].headers['x-api-key'], 'sk-a');
  assert.equal(calls[0].headers['anthropic-beta'], ANTHROPIC_FALLBACK_BETA);
  assert.equal(calls[0].body.output_config.format.type, 'json_schema');
  assert.equal(calls[0].body.system, 'sys');
  assert.ok(calls[0].signal, 'the request carries an abort signal');
}

// ── callModel: ANTHROPIC_FALLBACKS=off drops the header and the body field ──
{
  const { fetch, calls } = mockFetch([anthropicOk('ok')]);
  await callModel({ provider: 'anthropic', prompt: 'p', fetch, env: { ...ANTHROPIC_ENV, ANTHROPIC_FALLBACKS: 'off' } });
  assert.equal('anthropic-beta' in calls[0].headers, false);
  assert.equal('fallbacks' in calls[0].body, false);
}

// ── callModel: invalid JSON, then valid on the repair request ───────────────
{
  const { fetch, calls } = mockFetch([anthropicOk(JSON.stringify(BAD)), anthropicOk(JSON.stringify(GOOD))]);
  const lines = [];
  const r = await callModel({ provider: 'anthropic', system: 'sys', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV, log: (l) => lines.push(l) });
  assert.deepEqual(r.json, GOOD);
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(r.usage, { input: 20, output: 10 }, 'usage is summed over both requests');
  const repair = calls[1].body.messages[0].content;
  assert.ok(repair.startsWith('judge'), 'the original prompt is kept');
  assert.ok(repair.includes('Your previous answer was not valid:'), 'the repair suffix is present');
  assert.ok(repair.includes('$.items[0].intent: expected one of'), 'the validation error is carried to the model');
  assert.ok(repair.includes(`It began: ${JSON.stringify(BAD).slice(0, 400)}`), 'the failed answer is quoted');
  assert.ok(repair.endsWith('Return only JSON that matches the schema.'));
  assert.equal(calls[1].body.system, 'sys', 'same system prompt');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /did not match the schema/);
}

// ── callModel: prose instead of JSON, then valid ────────────────────────────
{
  const { fetch, calls } = mockFetch([anthropicOk('I cannot produce that right now.'), anthropicOk(JSON.stringify(GOOD))]);
  const r = await callModel({ provider: 'anthropic', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV });
  assert.deepEqual(r.json, GOOD);
  assert.ok(calls[1].body.messages[0].content.includes('no JSON value found'));
}

// ── callModel: still invalid after the repair ───────────────────────────────
{
  const { fetch, calls } = mockFetch([anthropicOk(JSON.stringify(BAD))]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV }),
    (e) => e instanceof ProviderError && e.kind === 'invalid_json'
      && e.provider === 'anthropic' && e.model === 'claude-opus-5'
      && Array.isArray(e.errors) && /intent/.test(e.errors[0])
      && e.text === JSON.stringify(BAD),
  );
  assert.equal(calls.length, 2, 'exactly one repair, then give up');
}

// ── callModel: limits are enforced through the same loop ────────────────────
{
  const many = { items: [GOOD.items[0], GOOD.items[0]] };
  const { fetch, calls } = mockFetch([anthropicOk(JSON.stringify(many)), anthropicOk(JSON.stringify(GOOD))]);
  const r = await callModel({ provider: 'anthropic', prompt: 'judge', schema: SCHEMA, limits: { items: { maxItems: 1 } }, fetch, env: ANTHROPIC_ENV });
  assert.deepEqual(r.json, GOOD);
  assert.ok(calls[1].body.messages[0].content.includes('$.items: more than 1 items'));
}

// ── callModel: fenced JSON from a native provider is parsed without a repair ─
{
  const { fetch, calls } = mockFetch([anthropicOk('```json\n' + JSON.stringify(GOOD) + '\n```')]);
  const r = await callModel({ provider: 'anthropic', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV });
  assert.deepEqual(r.json, GOOD);
  assert.equal(calls.length, 1);
}

// ── callModel: 429 then 200 with retryDelayMs 0 ─────────────────────────────
{
  const { fetch, calls } = mockFetch([{ status: 429, json: { error: { message: 'slow down' } } }, anthropicOk(JSON.stringify(GOOD))]);
  const lines = [];
  const r = await callModel({ provider: 'anthropic', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV, retryDelayMs: 0, log: (l) => lines.push(l) });
  assert.deepEqual(r.json, GOOD);
  assert.equal(calls.length, 2);
  assert.equal(r.attempts, 2);
  assert.match(lines[0], /HTTP 429/);
}

// ── callModel: 429 twice is a rate_limit error ──────────────────────────────
{
  const { fetch, calls } = mockFetch([{ status: 429, json: { error: { message: 'slow down' } } }]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch, env: ANTHROPIC_ENV, retryDelayMs: 0 }),
    (e) => e instanceof ProviderError && e.kind === 'rate_limit' && e.status === 429 && /slow down/.test(e.message),
  );
  assert.equal(calls.length, 2, 'one retry, no more');
}

// ── callModel: 5xx retries once; retries: 0 does not ────────────────────────
{
  const { fetch, calls } = mockFetch([{ status: 503, text: '<html>overloaded</html>' }, anthropicOk('fine')]);
  const r = await callModel({ provider: 'anthropic', prompt: 'p', fetch, env: ANTHROPIC_ENV, retryDelayMs: 0 });
  assert.equal(r.text, 'fine');
  assert.equal(calls.length, 2);

  const noRetry = mockFetch([{ status: 500, json: { error: { message: 'boom' } } }]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch: noRetry.fetch, env: ANTHROPIC_ENV, retries: 0 }),
    (e) => e.kind === 'server' && e.status === 500 && /boom/.test(e.message),
  );
  assert.equal(noRetry.calls.length, 1);
}

// ── callModel: 401 is auth and the hint names the env var ───────────────────
{
  const { fetch, calls } = mockFetch([{ status: 401, json: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch, env: ANTHROPIC_ENV }),
    (e) => e instanceof ProviderError && e.kind === 'auth' && e.status === 401
      && /invalid x-api-key/.test(e.message) && /ANTHROPIC_API_KEY/.test(e.hint),
  );
  assert.equal(calls.length, 1, 'auth failures are not retried');

  const forbidden = mockFetch([{ status: 403, json: {} }]);
  await assert.rejects(
    callModel({ provider: 'openai', prompt: 'p', fetch: forbidden.fetch, env: { OPENAI_API_KEY: 'x' } }),
    (e) => e.kind === 'auth' && /OPENAI_API_KEY/.test(e.hint),
  );
}

// ── callModel: other non-OK statuses are server errors with the body's message
{
  const { fetch } = mockFetch([{ status: 400, json: { error: { message: 'model: claude-nope not found' } } }]);
  await assert.rejects(
    callModel({ provider: 'anthropic', model: 'claude-nope', prompt: 'p', fetch, env: ANTHROPIC_ENV }),
    (e) => e.kind === 'server' && e.status === 400 && /claude-nope not found/.test(e.message) && /model id/.test(e.hint),
  );
}

// ── callModel: refusal and truncation ───────────────────────────────────────
{
  const refused = mockFetch([{ json: { content: [], stop_reason: 'refusal', stop_details: { category: 'harmful_content' }, usage: {} } }]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', schema: SCHEMA, fetch: refused.fetch, env: ANTHROPIC_ENV }),
    (e) => e instanceof ProviderError && e.kind === 'refusal' && /harmful_content/.test(e.message),
  );
  assert.equal(refused.calls.length, 1, 'a refusal is not repaired or retried');

  const cut = mockFetch([anthropicOk('{"items": [', { stop_reason: 'max_tokens' })]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', schema: SCHEMA, fetch: cut.fetch, env: ANTHROPIC_ENV, maxTokens: 50 }),
    (e) => e instanceof ProviderError && e.kind === 'truncated' && /50 tokens/.test(e.message) && /maxTokens/.test(e.hint),
  );
  assert.equal(cut.calls.length, 1);
}

// ── callModel: a missing key is a config error before any request ──────────
{
  const { fetch, calls } = mockFetch([anthropicOk('x')]);
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch, env: {} }),
    (e) => e instanceof ProviderError && e.kind === 'config' && /ANTHROPIC_API_KEY is not set/.test(e.message),
  );
  assert.equal(calls.length, 0);
  await assert.rejects(callModel({ provider: 'anthropic', fetch, env: ANTHROPIC_ENV }), (e) => e.kind === 'config' && /prompt/.test(e.message));
}

// ── callModel: timeout is a transport error ─────────────────────────────────
{
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch: hanging, env: ANTHROPIC_ENV, timeoutMs: 10 }),
    (e) => e instanceof ProviderError && e.kind === 'transport' && /10ms/.test(e.message),
  );
  const refused = mockFetch([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })]);
  await assert.rejects(
    callModel({ provider: 'ollama', prompt: 'p', fetch: refused.fetch, env: {} }),
    (e) => e.kind === 'transport' && /ECONNREFUSED/.test(e.message) && /Ollama/.test(e.hint),
  );
}

// ── callModel: the other native providers end to end ────────────────────────
{
  const oa = mockFetch([openaiOk(JSON.stringify(GOOD))]);
  const r1 = await callModel({ provider: 'openai', prompt: 'p', schema: SCHEMA, fetch: oa.fetch, env: { OPENAI_API_KEY: 'sk-o' } });
  assert.deepEqual(r1.json, GOOD);
  assert.equal(r1.model, 'gpt-4o-mini');
  assert.equal(oa.calls[0].headers.authorization, 'Bearer sk-o');
  assert.equal(oa.calls[0].body.response_format.json_schema.strict, true);
  assert.equal(oa.calls[0].body.max_completion_tokens, 4096);
  assert.deepEqual(r1.usage, { input: 3, output: 2 });

  const ge = mockFetch([{ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } }]);
  const r2 = await callModel({ model: 'gemini-2.5-pro', prompt: 'p', schema: SCHEMA, fetch: ge.fetch, env: { GEMINI_API_KEY: 'g-key' } });
  assert.deepEqual(r2.json, GOOD);
  assert.equal(r2.provider, 'gemini');
  assert.equal(r2.model, 'gemini-2.5-pro');
  assert.ok(ge.calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=g-key'));
  assert.deepEqual(ge.calls[0].body.generationConfig.responseSchema, forGemini(SCHEMA));

  const ds = mockFetch([openaiOk(JSON.stringify(GOOD))]);
  const r3 = await callModel({ model: 'deepseek-chat', prompt: 'p', schema: SCHEMA, fetch: ds.fetch, env: { DEEPSEEK_API_KEY: 'ds' } });
  assert.deepEqual(r3.json, GOOD);
  assert.equal(ds.calls[0].url, ENDPOINTS.deepseek);
  assert.deepEqual(ds.calls[0].body.response_format, { type: 'json_object' });
  assert.ok(ds.calls[0].body.messages[0].content.includes('"keyword"'), 'the schema rides in the prompt');

  const ol = mockFetch([{ json: { message: { content: JSON.stringify(GOOD) }, done_reason: 'stop', prompt_eval_count: 9, eval_count: 4, model: 'gemma4:26b' } }]);
  const r4 = await callModel({ model: 'gemma4:26b', prompt: 'p', schema: SCHEMA, fetch: ol.fetch, env: { OLLAMA_URL: 'http://gpu:11434' }, numCtx: 8192 });
  assert.deepEqual(r4.json, GOOD);
  assert.equal(r4.provider, 'ollama');
  assert.equal(ol.calls[0].url, 'http://gpu:11434/api/chat');
  assert.deepEqual(ol.calls[0].body.format, forOllama(SCHEMA));
  assert.equal(ol.calls[0].body.options.num_ctx, 8192);
  assert.deepEqual(r4.usage, { input: 9, output: 4 });

  const olErr = mockFetch([{ json: { error: 'model "nope" not found' } }]);
  await assert.rejects(callModel({ provider: 'ollama', model: 'nope', prompt: 'p', fetch: olErr.fetch, env: {} }), (e) => e.kind === 'server' && /not found/.test(e.message));

  const hz = mockFetch([openaiOk('harness says hi')]);
  const r5 = await callModel({ model: 'openclaw/seo', prompt: 'p', fetch: hz.fetch, env: { OPENCLAW_TOKEN: 'tok' } });
  assert.equal(r5.text, 'harness says hi');
  assert.equal(r5.provider, 'harness');
  assert.equal(hz.calls[0].url, ENDPOINTS.harness);
  assert.equal(hz.calls[0].headers.authorization, 'Bearer tok');
  assert.equal(hz.calls[0].body.model, 'openclaw/seo');
}

// ── callModel / callText without a schema ───────────────────────────────────
{
  const { fetch, calls } = mockFetch([anthropicOk('plain prose answer')]);
  const r = await callModel({ provider: 'anthropic', prompt: 'p', fetch, env: ANTHROPIC_ENV });
  assert.equal(r.text, 'plain prose answer');
  assert.equal(r.json, null);
  assert.equal('output_config' in calls[0].body, false);

  const t = mockFetch([anthropicOk('text only')]);
  const r2 = await callText({ provider: 'anthropic', prompt: 'p', schema: SCHEMA, fetch: t.fetch, env: ANTHROPIC_ENV });
  assert.equal(r2.text, 'text only');
  assert.equal('output_config' in t.calls[0].body, false, 'callText drops the schema');
}

// ── callModel: the Gemini CLI path spawns instead of fetching ───────────────
{
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, input: opts.input });
    if (args[0] === '--version') return { status: 0, stdout: '1.0.0' };
    return { status: 0, stdout: 'Sure:\n```json\n' + JSON.stringify(GOOD) + '\n```\n' };
  };
  const r = await callModel({ model: 'gemini', system: 'sys', prompt: 'judge', schema: SCHEMA, spawn, fetch: () => { throw new Error('must not fetch'); }, env: {} });
  assert.equal(r.provider, 'gemini-cli');
  assert.equal(r.model, 'gemini-cli');
  assert.deepEqual(r.json, GOOD, 'text providers go through extractJson');
  const call = spawned.find(s => s.args[0] === '-p');
  assert.deepEqual(call.args, ['-p', '-']);
  assert.ok(call.input.startsWith('sys\n\njudge'), 'the system prompt is prepended to the original prompt');
  assert.ok(call.input.includes(JSON.stringify(SCHEMA)), 'the CLI takes no schema parameter, so the schema rides in the prompt');

  const failing = (cmd, args) => (args[0] === '--version' ? { status: 0 } : { status: 1, stderr: 'quota exceeded' });
  await assert.rejects(callModel({ provider: 'gemini-cli', prompt: 'p', spawn: failing, env: {} }), (e) => e.kind === 'server' && /quota exceeded/.test(e.message));
  const missing = () => ({ error: Object.assign(new Error('spawn gemini ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(callModel({ provider: 'gemini-cli', prompt: 'p', spawn: missing, env: {} }), (e) => e.kind === 'transport' && /ENOENT/.test(e.message));
}

// ── callTextWithFallback ────────────────────────────────────────────────────
const cliSpawn = (answer = 'cli says hi') => (cmd, args) => (args[0] === '--version' ? { status: 0, stdout: '1.0' } : { status: 0, stdout: answer });
const noCli = () => ({ error: Object.assign(new Error('spawn gemini ENOENT'), { code: 'ENOENT' }) });
// The gateway reports the agent it routed to, which is the id it was asked for.
const harnessOk = (content) => (call) => ({ json: { choices: [{ message: { content, refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 }, model: call.body.model } });
const byUrl = (routes) => mockFetch([(call) => {
  for (const [prefix, step] of Object.entries(routes)) if (call.url.startsWith(prefix)) return typeof step === 'function' ? step(call) : step;
  throw new Error(`unexpected url ${call.url}`);
}]);

{
  // the provider the model implies fails → the harness answers
  const { fetch, calls } = byUrl({ [ENDPOINTS.anthropic]: { status: 500, json: { error: { message: 'overloaded' } } }, [ENDPOINTS.harness]: harnessOk('harness answer') });
  const lines = [];
  const r = await callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: cliSpawn(), env: { ...ANTHROPIC_ENV, OPENCLAW_TOKEN: 'tok' }, retryDelayMs: 0, log: (l) => lines.push(l) });
  assert.deepEqual(r, { text: 'harness answer', provider: 'harness', model: 'openclaw' });
  assert.equal(calls.filter(c => c.url === ENDPOINTS.anthropic).length, 2, 'the 5xx was retried once first');
  assert.equal(calls.filter(c => c.url === ENDPOINTS.harness).length, 1);
  const fallbackLines = lines.filter(l => /falling back/.test(l));
  assert.equal(fallbackLines.length, 1, 'one line per fallback');
  assert.match(fallbackLines[0], /^\[anthropic\] .*overloaded.*falling back to harness \(openclaw\)$/);
}
{
  // the harness fails too → the Gemini CLI answers
  const { fetch } = byUrl({ [ENDPOINTS.anthropic]: { status: 500, json: {} }, [ENDPOINTS.harness]: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), { code: 'ECONNREFUSED' }) });
  const lines = [];
  const r = await callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: cliSpawn('from the cli'), env: { ...ANTHROPIC_ENV, OPENCLAW_TOKEN: 'tok' }, retryDelayMs: 0, log: (l) => lines.push(l) });
  assert.deepEqual(r, { text: 'from the cli', provider: 'gemini-cli', model: 'gemini-cli' });
  const fallbackLines = lines.filter(l => /falling back/.test(l));
  assert.equal(fallbackLines.length, 2);
  assert.match(fallbackLines[1], /^\[harness\] .*ECONNREFUSED.*falling back to gemini-cli \(gemini-cli\)$/);
}
{
  // OPENCLAW_ANALYSIS_MODEL names the harness fallback agent
  const { fetch, calls } = byUrl({ [ENDPOINTS.anthropic]: { status: 500, json: {} }, [ENDPOINTS.harness]: harnessOk('ok') });
  const r = await callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: noCli, env: { ...ANTHROPIC_ENV, OPENCLAW_TOKEN: 'tok', OPENCLAW_ANALYSIS_MODEL: 'openclaw/seo' }, retryDelayMs: 0 });
  assert.equal(r.model, 'openclaw/seo');
  assert.equal(calls.find(c => c.url === ENDPOINTS.harness).body.model, 'openclaw/seo');
}
{
  // a refusal never falls back
  const { fetch, calls } = byUrl({ [ENDPOINTS.anthropic]: { json: { content: [], stop_reason: 'refusal', stop_details: { category: 'x' } } }, [ENDPOINTS.harness]: harnessOk('should not be asked') });
  await assert.rejects(
    callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: cliSpawn(), env: { ...ANTHROPIC_ENV, OPENCLAW_TOKEN: 'tok' } }),
    (e) => e instanceof ProviderError && e.kind === 'refusal',
  );
  assert.equal(calls.filter(c => c.url === ENDPOINTS.harness).length, 0);
}
{
  // skipped fallbacks: no token means no harness attempt, no CLI means no spawn attempt; the last real error is thrown
  const { fetch, calls } = byUrl({ [ENDPOINTS.anthropic]: { status: 401, json: { error: { message: 'bad key' } } } });
  await assert.rejects(
    callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: noCli, env: ANTHROPIC_ENV }),
    (e) => e instanceof ProviderError && e.kind === 'auth' && /bad key/.test(e.message),
  );
  assert.equal(calls.length, 1);
}
{
  // nothing configured at all
  await assert.rejects(
    callTextWithFallback({ prompt: 'p', fetch: () => { throw new Error('must not fetch'); }, spawn: noCli, env: {} }),
    (e) => e instanceof ProviderError && e.kind === 'config' && /seo-intel setup/.test(e.hint),
  );
}
{
  // an unrecognised model id goes to the harness with that id, as callAnalysisModel always did
  const { fetch, calls } = byUrl({ [ENDPOINTS.harness]: harnessOk('agent answer') });
  const r = await callTextWithFallback({ model: 'my-agent', prompt: 'p', fetch, spawn: noCli, env: { OPENCLAW_TOKEN: 'tok' } });
  assert.deepEqual(r, { text: 'agent answer', provider: 'harness', model: 'my-agent' });
  assert.equal(calls[0].body.model, 'my-agent');
}
{
  // the legacy default: 'gemini' with no key is the CLI first, then the harness
  const { fetch, calls } = byUrl({ [ENDPOINTS.harness]: harnessOk('harness after cli') });
  const cliBroken = (cmd, args) => (args[0] === '--version' ? { status: 0 } : { status: 1, stderr: 'quota' });
  const r = await callTextWithFallback({ model: 'gemini', prompt: 'p', fetch, spawn: cliBroken, env: { OPENCLAW_TOKEN: 'tok' } });
  assert.deepEqual(r, { text: 'harness after cli', provider: 'harness', model: 'openclaw' });
  assert.equal(calls.length, 1);
}
{
  // every path fails: the last ProviderError is thrown
  const { fetch } = byUrl({ [ENDPOINTS.anthropic]: { status: 500, json: {} }, [ENDPOINTS.harness]: { status: 502, text: 'bad gateway' } });
  const cliBroken = (cmd, args) => (args[0] === '--version' ? { status: 0 } : { status: 1, stderr: 'cli quota' });
  await assert.rejects(
    callTextWithFallback({ model: 'claude', prompt: 'p', fetch, spawn: cliBroken, env: { ...ANTHROPIC_ENV, OPENCLAW_TOKEN: 'tok' }, retryDelayMs: 0 }),
    (e) => e instanceof ProviderError && e.provider === 'gemini-cli' && /cli quota/.test(e.message),
  );
}


// ── Text-only providers see the schema ──────────────────────────────────────
// The Agent Harness and the Gemini CLI take no schema parameter. Without the
// schema in the prompt they were asked for JSON matching a shape they never saw.
{
  assert.equal(withSchemaInPrompt('p', null), 'p');
  assert.ok(withSchemaInPrompt('p', SCHEMA).startsWith('p\n\n'));
  const h = buildHarnessRequest({ prompt: 'judge these', schema: SCHEMA, token: 't' });
  const user = h.body.messages.find(m => m.role === 'user').content;
  assert.ok(user.startsWith('judge these') && user.includes(JSON.stringify(SCHEMA)), 'harness user message carries the schema');
  const plain = buildHarnessRequest({ prompt: 'hi', token: 't' });
  assert.equal(plain.body.messages.find(m => m.role === 'user').content, 'hi', 'no schema, no suffix');

  // The repair request keeps the original prompt and the schema.
  const bad = { json: { choices: [{ message: { content: '{"items":[{"keyword":"x"}]}' }, finish_reason: 'stop' }], model: 'openclaw' } };
  const good = { json: { choices: [{ message: { content: JSON.stringify(GOOD) }, finish_reason: 'stop' }], model: 'openclaw' } };
  const { fetch, calls } = mockFetch([bad, good]);
  const r = await callModel({ provider: 'harness', prompt: 'judge these', schema: SCHEMA, fetch, env: { OPENCLAW_TOKEN: 'tok' } });
  assert.deepEqual(r.json, GOOD);
  const second = calls[1].body.messages.find(m => m.role === 'user').content;
  assert.ok(second.startsWith('judge these'), 'the repair starts with the original prompt');
  assert.ok(second.includes('not valid') && second.includes(JSON.stringify(SCHEMA)), 'and still carries the schema');
}

// ── Ollama tags with a cloud vendor's name stay local ───────────────────────
{
  for (const tag of ['deepseek-r1:14b', 'deepseek-r1:70b', 'gpt-oss:20b', 'gpt-oss:120b', 'o1:latest', 'claude-ish:7b', 'gemma4:26b']) {
    assert.equal(routeModel(tag), 'ollama', `${tag} is an Ollama tag`);
  }
  assert.equal(routeModel('ft:gpt-4o-mini:acme:custom:abc123'), 'openai', 'an OpenAI fine-tune id keeps its colons and stays on OpenAI');
  assert.equal(routeModel('deepseek-chat'), 'deepseek');
  assert.equal(routeModel('gpt-4o-mini'), 'openai');
  assert.deepEqual(resolveProvider({ model: 'deepseek-r1:14b', env: {} }).provider, 'ollama');
}

// ── A --model argument overrides ANALYSIS_PROVIDER, not the --provider argument ─
{
  const env = { ANALYSIS_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' };
  const probes = { hasHarnessToken: () => false, hasGeminiCli: () => false };
  const alias = resolveProvider({ model: 'claude', env, ...probes });
  assert.equal(alias.provider, 'anthropic', '--model claude asks Claude even though the wizard wrote ANALYSIS_PROVIDER=gemini');
  assert.equal(alias.model, 'claude-opus-5');
  assert.match(alias.reason, /overrides ANALYSIS_PROVIDER/);
  const id = resolveProvider({ model: 'claude-opus-5', env, ...probes });
  assert.deepEqual([id.provider, id.model], ['anthropic', 'claude-opus-5'], 'a Claude id is never sent to Gemini');
  const same = resolveProvider({ model: 'gemini-2.5-pro', env, ...probes });
  assert.deepEqual([same.provider, same.model, same.reason], ['gemini', 'gemini-2.5-pro', 'ANALYSIS_PROVIDER'], 'a model of the configured provider keeps ANALYSIS_PROVIDER');
  const unknown = resolveProvider({ model: 'house-model-7', env, ...probes });
  assert.deepEqual([unknown.provider, unknown.model], ['gemini', 'house-model-7'], 'an unrecognisable id cannot override: ANALYSIS_PROVIDER stands');
  const arg = resolveProvider({ provider: 'gemini', model: 'claude-opus-5', env, ...probes });
  assert.equal(arg.provider, 'gemini', 'the --provider argument is never overridden');
  const envModel = resolveProvider({ env: { ...env, ANALYSIS_MODEL: 'claude-opus-5' }, ...probes });
  assert.equal(envModel.provider, 'gemini', 'ANALYSIS_PROVIDER still outranks ANALYSIS_MODEL');
}

// ── The model that answered is the one recorded ─────────────────────────────
{
  const { fetch } = mockFetch([anthropicOk(JSON.stringify(GOOD), { model: 'claude-opus-4-8' })]);
  const r = await callModel({ provider: 'anthropic', model: 'claude-opus-5', prompt: 'judge', schema: SCHEMA, fetch, env: ANTHROPIC_ENV });
  assert.equal(r.model, 'claude-opus-4-8', 'a server-side fallback answered, and provenance says so');
  assert.equal(r.requested_model, 'claude-opus-5');
  const t = mockFetch([anthropicOk('hello', { model: 'claude-opus-4-8' })]);
  const viaText = await callTextWithFallback({ provider: 'anthropic', model: 'claude-opus-5', prompt: 'p', fetch: t.fetch, env: ANTHROPIC_ENV, spawn: noCli });
  assert.deepEqual([viaText.provider, viaText.model], ['anthropic', 'claude-opus-4-8']);
  const noModel = mockFetch([{ json: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } }]);
  const r2 = await callModel({ provider: 'anthropic', model: 'claude-opus-5', prompt: 'p', fetch: noModel.fetch, env: ANTHROPIC_ENV });
  assert.equal(r2.model, 'claude-opus-5', 'a body without a model falls back to the one requested');
}

// ── The retry waits retryDelayMs ────────────────────────────────────────────
{
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const { fetch } = mockFetch([{ status: 503, json: {} }, anthropicOk('ok')]);
  await callModel({ provider: 'anthropic', prompt: 'p', fetch, env: ANTHROPIC_ENV, retryDelayMs: 1234, sleep });
  assert.deepEqual(waits, [1234], 'one retry, after the configured delay');
  const fast = mockFetch([anthropicOk('ok')]);
  const none = [];
  await callModel({ provider: 'anthropic', prompt: 'p', fetch: fast.fetch, env: ANTHROPIC_ENV, sleep: async (ms) => { none.push(ms); } });
  assert.deepEqual(none, [], 'no wait without a retry');
}

// ── A content filter is a refusal, and does not fall through ────────────────
{
  const filtered = { choices: [{ message: { content: null }, finish_reason: 'content_filter' }], model: 'gpt-4o-mini' };
  const read = readOpenAIResponse(filtered);
  assert.equal(read.stop, 'refusal');
  assert.equal(read.category, 'content_filter');
  const { fetch, calls } = mockFetch([{ json: filtered }]);
  const spawned = [];
  await assert.rejects(
    callTextWithFallback({ provider: 'openai', prompt: 'p', fetch, env: { OPENAI_API_KEY: 'o', OPENCLAW_TOKEN: 'tok' }, spawn: (c, a) => { spawned.push(a); return { status: 0, stdout: '1' }; } }),
    (e) => e.kind === 'refusal' && /content_filter/.test(e.message),
  );
  assert.equal(calls.length, 1, 'the filtered request is not re-sent to the harness');
  assert.ok(!spawned.some(a => a[0] === '-p'), 'nor to the Gemini CLI');
}

// ── Timeouts come from env when the caller gives none ───────────────────────
{
  assert.equal(resolveTimeoutMs('anthropic', {}), 120000);
  assert.equal(resolveTimeoutMs('anthropic', { ANALYSIS_TIMEOUT_MS: '300000' }), 300000);
  assert.equal(resolveTimeoutMs('gemini-cli', { GEMINI_TIMEOUT_MS: '180000' }), 180000, 'the legacy Gemini variable still lengthens a Gemini call');
  assert.equal(resolveTimeoutMs('harness', { OPENCLAW_TIMEOUT_MS: '90000' }), 90000);
  assert.equal(resolveTimeoutMs('ollama', { GEMINI_TIMEOUT_MS: '180000' }), 120000, 'but not another provider');
  assert.equal(resolveTimeoutMs('ollama', { ANALYSIS_TIMEOUT_MS: '600000', GEMINI_TIMEOUT_MS: '1' }), 600000);
  assert.equal(resolveTimeoutMs('anthropic', { ANALYSIS_TIMEOUT_MS: '300000' }, 5000), 5000, 'an explicit timeout wins');
  assert.equal(resolveTimeoutMs('anthropic', { ANALYSIS_TIMEOUT_MS: 'soon' }), 120000, 'garbage falls back');

  // A hung request aborts at the env timeout and the hint names the variable.
  const hang = async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    callModel({ provider: 'anthropic', prompt: 'p', fetch: hang, env: { ...ANTHROPIC_ENV, ANALYSIS_TIMEOUT_MS: '20' } }),
    (e) => e.kind === 'transport' && /within 20ms/.test(e.message) && /ANALYSIS_TIMEOUT_MS/.test(e.hint),
  );
}

// ── The Ollama default model is read from the env it is given ───────────────
{
  assert.equal(resolveProvider({ provider: 'ollama', env: { OLLAMA_ANALYSIS_MODEL: 'qwen3:14b' } }).model, 'qwen3:14b');
  assert.equal(resolveProvider({ provider: 'ollama', env: {} }).model, 'gemma4:26b');
}

console.log('providers: all tests passed');
