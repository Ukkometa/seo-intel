/**
 * SEO Intel — OpenClaw Setup Bridge
 *
 * When OpenClaw gateway is running, this module lets the setup process
 * delegate to the agent for a conversational, intelligent setup flow.
 *
 * Instead of a rigid wizard with fixed steps, the agent:
 *   1. Reads the system check results
 *   2. Knows what's missing / misconfigured
 *   3. Guides the user conversationally through fixes
 *   4. Can troubleshoot errors in real-time
 *   5. Configures everything via the setup engine API
 *
 * Falls back to the standard wizard if OpenClaw is not available.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const OPENCLAW_API = 'http://127.0.0.1:18789';

// ── OpenClaw Gateway Communication ─────────────────────────────────────────

/**
 * Send a message to OpenClaw's agent via the OpenAI-compatible API.
 * Returns the agent's text response.
 */
async function askAgent(messages, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 60000);

  try {
    const res = await fetch(`${OPENCLAW_API}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { 'Authorization': `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model || 'default',
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenClaw API error: ${res.status} ${err}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if the OpenClaw gateway is reachable and ready.
 */
export async function isGatewayReady() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OPENCLAW_API}/v1/models`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Setup Context Builder ──────────────────────────────────────────────────

/**
 * Build a context message for the agent with full system status.
 * This gives the agent everything it needs to guide the setup.
 */
function buildSetupContext(systemCheck) {
  const ctx = {
    tool: 'SEO Intel',
    version: systemCheck._version || '0.2.0',
    installDir: ROOT,
    systemStatus: {
      node: {
        version: systemCheck.node.version,
        ok: systemCheck.node.meetsMinimum,
      },
      ollama: {
        available: systemCheck.ollama.available,
        host: systemCheck.ollama.host,
        models: systemCheck.ollama.models?.map(m => m.name) || [],
      },
      playwright: {
        installed: systemCheck.playwright.installed,
      },
      apiKeys: {
        gemini: systemCheck.env.keys.GEMINI_API_KEY || false,
        anthropic: systemCheck.env.keys.ANTHROPIC_API_KEY || false,
        openai: systemCheck.env.keys.OPENAI_API_KEY || false,
        deepseek: systemCheck.env.keys.DEEPSEEK_API_KEY || false,
      },
      gpu: {
        vram: systemCheck.vram.vramMB,
        name: systemCheck.vram.gpuName,
      },
      existingProjects: systemCheck.configs.projects?.map(p => p.project) || [],
      gsc: {
        hasData: systemCheck.gsc?.hasData || false,
      },
    },
    capabilities: systemCheck.summary,
    setupApiBase: 'http://localhost:3000/api/setup',
  };

  return JSON.stringify(ctx, null, 2);
}

// ── The System Prompt ──────────────────────────────────────────────────────

const SETUP_SYSTEM_PROMPT = `You are the SEO Intel setup assistant. You help users configure SEO Intel — a competitive SEO intelligence tool that runs locally.

IMPORTANT RULES:
- Be concise and friendly. No walls of text.
- Guide step by step. One thing at a time.
- When something is already configured, acknowledge it and move on.
- If something is broken, explain what's wrong and offer to fix it.
- You have access to bash to run commands. Use it to install things, check status, and configure.

THE SETUP FLOW:
1. Check what's already working (I'll give you the system status)
2. Fix any missing dependencies (Node, npm deps, Playwright, Ollama)
3. Help choose and configure the extraction model (local Ollama recommended)
4. Help configure an analysis API key (Gemini recommended for best value)
5. Create a project config (target domain + competitors)
6. Optionally set up Google Search Console data
7. Run a quick pipeline test to verify everything works
8. Show the user their first commands to run

AVAILABLE COMMANDS (run these from ${ROOT}):
- node cli.js setup-web → opens web wizard at http://localhost:3000/setup
- node cli.js crawl <project> → crawl domains
- node cli.js extract <project> → extract with local AI
- node cli.js html <project> → generate dashboard
- node cli.js serve → start dashboard server
- node cli.js status → show system status
- node cli.js competitors <project> → manage domains
- node cli.js auth → show auth connections

TO INSTALL THINGS:
- npm install (in ${ROOT}) → install Node dependencies
- npx playwright install chromium → install browser
- ollama pull qwen3.5:9b → install extraction model

TO CONFIGURE:
- Edit ${ROOT}/.env for API keys and settings
- Project configs go in ${ROOT}/config/<project>.json

ANALYSIS MODELS (user needs at least one API key):
- Gemini: Best value, 1M context (~$0.01-0.05/analysis) → GEMINI_API_KEY
- Claude: Best quality, nuanced reasoning (~$0.10-0.30) → ANTHROPIC_API_KEY
- OpenAI: Solid all-around (~$0.05-0.15) → OPENAI_API_KEY
- DeepSeek: Budget option (~$0.02-0.08) → DEEPSEEK_API_KEY

EXTRACTION MODELS (local, free):
- qwen3.5:9b (recommended, needs 6GB+ VRAM)
- qwen3.5:4b (budget, needs 3GB+ VRAM)
- qwen3.5:27b (quality, needs 16GB+ VRAM)`;

// ── Agent-Driven Setup Flow ────────────────────────────────────────────────

/**
 * Start an agent-driven setup session.
 * Uses OpenClaw's agent to guide the user conversationally.
 *
 * @param {object} systemCheck - Result from fullSystemCheck()
 * @param {object} [opts]
 * @param {function} [opts.onMessage] - Callback for agent messages
 * @param {function} [opts.onInput] - Callback to get user input
 * @returns {Promise<{ completed: boolean, project?: string }>}
 */
export async function runAgentSetup(systemCheck, opts = {}) {
  const { onMessage, onInput } = opts;

  const context = buildSetupContext(systemCheck);

  const messages = [
    {
      role: 'system',
      content: SETUP_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Here's the current system status. Guide me through setting up SEO Intel. Be concise — one step at a time.\n\n${context}`,
    },
  ];

  // Get initial response
  const initialResponse = await askAgent(messages);
  messages.push({ role: 'assistant', content: initialResponse });

  if (onMessage) onMessage(initialResponse);

  // Conversational loop
  let completed = false;
  let maxTurns = 20; // safety limit

  while (!completed && maxTurns > 0) {
    maxTurns--;

    // Get user input
    const userInput = onInput ? await onInput() : null;
    if (!userInput || userInput.toLowerCase() === 'done' || userInput.toLowerCase() === 'exit') {
      completed = true;
      break;
    }

    messages.push({ role: 'user', content: userInput });

    const response = await askAgent(messages);
    messages.push({ role: 'assistant', content: response });

    if (onMessage) onMessage(response);

    // Check if setup seems complete
    if (response.includes('setup is complete') || response.includes('all set') || response.includes('ready to go')) {
      completed = true;
    }
  }

  return { completed };
}

// ── CLI Integration ────────────────────────────────────────────────────────

/**
 * Run the OpenClaw-powered setup from the CLI.
 * Falls back to web wizard if OpenClaw isn't available.
 */
export async function cliAgentSetup(systemCheck) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('\n  \x1b[36m\x1b[1m🐸 SEO Intel — Agent-Powered Setup\x1b[0m\n');
  console.log('  \x1b[2mOpenClaw is guiding your setup. Type your answers, or "done" to finish.\x1b[0m\n');

  try {
    await runAgentSetup(systemCheck, {
      onMessage: (msg) => {
        // Format agent output with indentation
        const lines = msg.split('\n');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log();
      },
      onInput: async () => {
        const input = await ask('  \x1b[36m>\x1b[0m ');
        return input;
      },
    });
  } finally {
    rl.close();
  }

  console.log('\n  \x1b[32m✓ Setup session ended.\x1b[0m\n');
}

// ── Web API Integration ────────────────────────────────────────────────────

/**
 * Handle a setup chat message via the web API.
 * Used by the web wizard's "Agent Mode" chat panel.
 *
 * @param {object} body - { message, history, systemCheck }
 * @returns {Promise<{ response: string }>}
 */
export async function handleAgentChat(body) {
  const { message, history = [], systemCheck } = body;

  const context = systemCheck ? buildSetupContext(systemCheck) : '';

  const messages = [
    {
      role: 'system',
      content: SETUP_SYSTEM_PROMPT,
    },
  ];

  // Add context as first user message if this is a new conversation
  if (history.length === 0 && context) {
    messages.push({
      role: 'user',
      content: `System status:\n${context}`,
    });
  }

  // Add conversation history
  for (const msg of history) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add current message
  messages.push({ role: 'user', content: message });

  const response = await askAgent(messages);

  return { response };
}
