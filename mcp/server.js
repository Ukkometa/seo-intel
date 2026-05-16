#!/usr/bin/env node
/**
 * seo-intel MCP server — stdio transport.
 *
 * Run as a subprocess by an MCP-capable host (Claude Code, Cursor, Cline,
 * Continue, Zed, etc.). Exposes seo-intel's local SQLite intelligence to
 * the host's LLM as native tools.
 *
 * Install for Claude Code:
 *   claude mcp add seo-intel "npx seo-intel-mcp"
 *
 * Tools (v1.5.26):
 *   list_projects  — free  — projects on this machine + page counts
 *   get_intel      — free `raw` slice / paid `audit|blog|competitor` slices
 *
 * IMPORTANT: stdout is reserved for JSON-RPC messages. All logging here goes
 * to stderr. Never use console.log in this file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getDb } from '../db/db.js';
import { getIntel, INTEL_SLICES, FREE_SLICES } from '../lib/intel.js';
import { isPro } from '../lib/license.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const CONFIG_DIR = join(ROOT, 'config');

const server = new McpServer({ name: 'seo-intel', version: VERSION });

function listConfigProjects() {
  if (!existsSync(CONFIG_DIR)) return [];
  return readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json') && f !== 'example.json' && !f.startsWith('setup'))
    .map(f => {
      try {
        const c = JSON.parse(readFileSync(join(CONFIG_DIR, f), 'utf8'));
        return { project: c.project || f.replace('.json', ''), target: c.target?.domain || null };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── Tool: list_projects (free) ────────────────────────────────────────────
server.registerTool(
  'list_projects',
  {
    description: 'List all SEO Intel projects configured on this machine, each with its target domain and crawled page count. Use this first to discover which projects are available before calling get_intel. Free tier — no license required.',
  },
  async () => {
    const db = getDb();
    const configs = listConfigProjects();
    const out = configs.map(c => {
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM pages p JOIN domains d ON d.id=p.domain_id WHERE d.project=?'
      ).get(c.project);
      return { ...c, pages: row?.n || 0 };
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      structuredContent: { projects: out },
    };
  }
);

// ── Tool: get_intel (free raw / paid others) ──────────────────────────────
server.registerTool(
  'get_intel',
  {
    description: [
      'Get structured project intelligence as a JSON envelope ready for AI agent consumption.',
      '',
      'Slices:',
      '  raw         (FREE)  page/keyword/heading/schema/sitemap inventory per domain',
      '  audit       (paid)  citability scores + active insights ledger',
      '  blog        (paid)  keyword gaps + long tails + drafting hints',
      '  competitor  (paid)  competitor summary + keyword matrix + positioning',
      '',
      'Paid slices require an SEO Intel Solo license (set SEO_INTEL_LICENSE in env, or activate via the CLI). When unlicensed, the tool returns a clear upgrade message — no silent failure.',
      '',
      'Output envelope: { project, for, tier, generated_at, seo_intel_version, data }.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Call list_projects first to discover available projects.'),
      for: z.enum(INTEL_SLICES).optional().describe('Slice — defaults to "raw" (free).'),
    },
  },
  async ({ project, for: slice = 'raw' }) => {
    if (!FREE_SLICES.includes(slice) && !isPro()) {
      const msg = `The "${slice}" slice requires SEO Intel Solo (€19.99/mo). Free tier supports: ${FREE_SLICES.join(', ')}. Activate at https://ukkometa.fi/en/seo-intel/ — set SEO_INTEL_LICENSE=SI-xxxx-xxxx-xxxx-xxxx in your env.`;
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
    try {
      const db = getDb();
      const envelope = getIntel(db, project, { for: slice });
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `seo-intel error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine; the host typically surfaces this in its MCP logs panel.
  console.error(`[seo-intel-mcp] v${VERSION} ready on stdio. Tools: list_projects, get_intel.`);
}

main().catch(err => {
  console.error('[seo-intel-mcp] fatal:', err);
  process.exit(1);
});
