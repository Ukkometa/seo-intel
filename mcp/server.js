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

// ── Tool: get_pages (free) ────────────────────────────────────────────────
server.registerTool(
  'get_pages',
  {
    description: 'Paginated list of crawled pages for a project, with url, title, word count, status, and domain role. Use this to drill into individual pages after seeing the inventory summary from get_intel. Free tier.',
    inputSchema: {
      project: z.string().describe('Project slug'),
      role: z.enum(['target', 'owned', 'competitor']).optional().describe('Filter by domain role'),
      limit: z.number().int().positive().max(500).optional().describe('Max pages to return (default 50, max 500)'),
      offset: z.number().int().nonnegative().optional().describe('Offset for pagination (default 0)'),
    },
  },
  async ({ project, role, limit = 50, offset = 0 }) => {
    try {
      const db = getDb();
      const whereParams = role ? [project, role] : [project];
      const where = role ? 'd.project = ? AND d.role = ?' : 'd.project = ?';
      const rows = db.prepare(
        `SELECT p.url, p.title, p.word_count, p.status_code, p.click_depth,
                d.domain, d.role
         FROM pages p JOIN domains d ON d.id = p.domain_id
         WHERE ${where}
         ORDER BY d.role, d.domain, p.url
         LIMIT ? OFFSET ?`
      ).all(...whereParams, limit, offset);
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM pages p JOIN domains d ON d.id = p.domain_id WHERE ${where}`
      ).get(...whereParams)?.n || 0;
      const out = { project, role: role || 'any', total, returned: rows.length, offset, pages: rows };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: list_keywords (free) ────────────────────────────────────────────
server.registerTool(
  'list_keywords',
  {
    description: 'Top extracted keywords for a project, grouped by domain. Each keyword has frequency, location (title/h1/h2/meta/body), and source domain. Use this to surface what each site is targeting before running gap analysis. Free tier.',
    inputSchema: {
      project: z.string().describe('Project slug'),
      domain: z.string().optional().describe('Optional: filter to a single domain'),
      limit: z.number().int().positive().max(1000).optional().describe('Max keywords to return (default 100, max 1000)'),
    },
  },
  async ({ project, domain, limit = 100 }) => {
    try {
      const db = getDb();
      const params = [project];
      let where = 'd.project = ?';
      if (domain) { where += ' AND d.domain = ?'; params.push(domain); }
      params.push(limit);
      const rows = db.prepare(
        `SELECT k.keyword, k.location, d.domain, d.role, COUNT(*) AS freq
         FROM keywords k
           JOIN pages p ON p.id = k.page_id
           JOIN domains d ON d.id = p.domain_id
         WHERE ${where}
         GROUP BY k.keyword, k.location, d.domain
         ORDER BY freq DESC
         LIMIT ?`
      ).all(...params);
      const out = { project, domain: domain || 'all', returned: rows.length, keywords: rows };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: get_headings (free) ─────────────────────────────────────────────
server.registerTool(
  'get_headings',
  {
    description: 'Heading structure (H1–H6) for a specific page. Returns ordered list of { level, text }. Useful for content architecture comparisons between target and competitor pages. Free tier.',
    inputSchema: {
      project: z.string().describe('Project slug'),
      url: z.string().describe('Exact page URL (as crawled). Get URLs from get_pages.'),
      limit: z.number().int().positive().max(200).optional().describe('Max headings (default 50)'),
    },
  },
  async ({ project, url, limit = 50 }) => {
    try {
      const db = getDb();
      const page = db.prepare(
        `SELECT p.id, p.title, p.word_count, d.domain, d.role
         FROM pages p JOIN domains d ON d.id = p.domain_id
         WHERE d.project = ? AND p.url = ?`
      ).get(project, url);
      if (!page) {
        return {
          content: [{ type: 'text', text: `No crawled page found for url="${url}" in project "${project}". Use get_pages to discover URLs.` }],
          isError: true,
        };
      }
      const headings = db.prepare(
        `SELECT level, text FROM headings WHERE page_id = ? ORDER BY id LIMIT ?`
      ).all(page.id, limit);
      const out = { project, url, page_title: page.title, domain: page.domain, role: page.role, word_count: page.word_count, headings };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine; the host typically surfaces this in its MCP logs panel.
  console.error(`[seo-intel-mcp] v${VERSION} ready on stdio. Tools: list_projects, get_intel, get_pages, list_keywords, get_headings.`);
}

main().catch(err => {
  console.error('[seo-intel-mcp] fatal:', err);
  process.exit(1);
});
