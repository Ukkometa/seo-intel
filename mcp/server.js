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
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getDb, insertAgentInsight, AGENT_INSIGHT_TYPES, getActiveInsights, getCompetitorSummary } from '../db/db.js';
import { getIntel, INTEL_SLICES, FREE_SLICES } from '../lib/intel.js';
import { isPro } from '../lib/license.js';
import { readProgress } from '../lib/progress.js';

import { runAeoAnalysis, persistAeoScores, upsertCitabilityInsights } from '../analyses/aeo/index.js';
import { prescore } from '../analyses/blog-draft/prescorer.js';
import { gatherBlogDraftContext, buildBlogDraftPrompt } from '../analyses/blog-draft/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────
function paidGate(toolName) {
  return {
    content: [{ type: 'text', text: `The "${toolName}" tool requires SEO Intel Solo (€19.99/mo — vs Ahrefs ~$129/mo or Semrush ~$140/mo). Free tier already covers list_projects, get_intel(raw), get_pages, list_keywords, get_headings, run_crawl, get_crawl_status, ingest_insight. Activate at https://ukkometa.fi/en/seo-intel/ — set SEO_INTEL_LICENSE=SI-xxxx-xxxx-xxxx-xxxx in your env.` }],
    isError: true,
  };
}

function loadProjectConfig(project) {
  const p = join(CONFIG_DIR, `${project}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

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

// ── Tool: run_crawl (free) ────────────────────────────────────────────────
server.registerTool(
  'run_crawl',
  {
    description: [
      'Trigger a background crawl for an existing project. Spawns the crawl as a detached subprocess and returns immediately — the crawl will keep running even if this MCP server exits. Use get_crawl_status to monitor progress, or call get_intel/get_pages once the crawl completes to see results.',
      '',
      'Conflict guard: refuses to start if any seo-intel job is already running. Free tier — crawl page limits still apply (configurable via setup / Solo license unlocks unlimited).',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Existing project slug. Use list_projects to discover.'),
      stealth: z.boolean().optional().describe('Enable stealth browser mode for JS-heavy or anti-bot sites'),
      max_pages: z.number().int().positive().optional().describe('Override max pages per domain'),
    },
  },
  async ({ project, stealth, max_pages }) => {
    const configPath = join(CONFIG_DIR, `${project}.json`);
    if (!existsSync(configPath)) {
      const available = listConfigProjects().map(p => p.project).join(', ') || '(none configured)';
      return {
        content: [{ type: 'text', text: `Project "${project}" not found. Available: ${available}. Use list_projects to discover, or run \`seo-intel setup\` to add a new project.` }],
        isError: true,
      };
    }
    const progress = readProgress();
    if (progress?.status === 'running') {
      return {
        content: [{ type: 'text', text: `A seo-intel job is already running (command="${progress.command}", project="${progress.project}", pid=${progress.pid}). Call get_crawl_status to monitor, or wait for it to finish before starting another.` }],
        isError: true,
      };
    }

    const args = ['cli.js', 'crawl', project];
    if (stealth) args.push('--stealth');
    if (max_pages) args.push('--max-pages', String(max_pages));

    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const result = {
      started: true,
      pid: child.pid,
      project,
      command: `node ${args.join(' ')}`,
      hint: 'Crawl is running detached. Call get_crawl_status to check progress (updates every few seconds), or call get_intel(project, for=raw) in a minute or two to see new data.',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// ── Tool: get_crawl_status (free) ─────────────────────────────────────────
server.registerTool(
  'get_crawl_status',
  {
    description: 'Read the current state of the most recent seo-intel job (crawl/extract/analyze/etc). Returns status: running | completed | crashed | stopped | idle, plus project/command/pid/timestamps when available. Use this after run_crawl to monitor progress. Free tier.',
  },
  async () => {
    const progress = readProgress() || { status: 'idle', note: 'No seo-intel job has been recorded since startup. Use run_crawl to start one.' };
    return {
      content: [{ type: 'text', text: JSON.stringify(progress, null, 2) }],
      structuredContent: progress,
    };
  }
);

// ── Tool: ingest_insight (free — write-back closes the loop) ──────────────
server.registerTool(
  'ingest_insight',
  {
    description: [
      'Persist an agent-generated insight into the SEO Intel Intelligence Ledger so it shows up in the dashboard and survives across sessions. Free tier — the agent\'s own LLM did the analysis; we just provide storage.',
      '',
      'Dedup contract: same (project, type, fingerprint) updates `last_seen` instead of creating a duplicate row. So an agent rediscovering the same finding across sessions cleanly bumps the timestamp.',
      '',
      'Allowed types (mirror what the cloud `analyze` command writes):',
      '  keyword_gap     data: { keyword, ... }       fingerprint = keyword',
      '  long_tail       data: { phrase, ... }        fingerprint = phrase',
      '  quick_win       data: { page, issue, ... }   fingerprint = page::issue',
      '  new_page        data: { target_keyword | title, ... }',
      '  content_gap     data: { topic, ... }         fingerprint = topic',
      '  technical_gap   data: { gap, ... }           fingerprint = gap',
      '  positioning     data: { ...free-form... }    one slot per project',
      '',
      'data must include the identifier field above; otherwise the tool returns an error.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug'),
      type: z.enum(AGENT_INSIGHT_TYPES).describe('Insight type from the allowed set'),
      data: z.record(z.any()).describe('Insight payload — JSON object. Must include the identifier field for the chosen type.'),
      agent_name: z.string().optional().describe('Optional provenance tag (e.g. "claude-opus-4-7"). Stored as source="agent:<name>".'),
    },
  },
  async ({ project, type, data, agent_name }) => {
    try {
      const db = getDb();
      const result = insertAgentInsight(db, { project, type, data, agentName: agent_name });
      if (!result.ok) {
        return { content: [{ type: 'text', text: `seo-intel ingest error: ${result.error}` }], isError: true };
      }
      const payload = {
        ok: true,
        project,
        type,
        insight_id: result.id,
        fingerprint: result.fingerprint,
        deduped: result.deduped,
        source: result.source,
        last_seen: new Date(result.last_seen).toISOString(),
        hint: result.deduped
          ? 'Insight already existed; last_seen refreshed.'
          : 'New insight persisted. It will appear in the dashboard ledger and in get_intel(for=audit).',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: run_citability_audit (PAID) ─────────────────────────────────────
server.registerTool(
  'run_citability_audit',
  {
    description: 'Run AEO citability scoring across all crawled pages (6 signals: entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage). Persists scores to citability_scores and upserts citability_gap insights into the ledger. Pure function — fast, no LLM calls. Paid tier.',
    inputSchema: {
      project: z.string(),
      include_competitors: z.boolean().optional().describe('Score competitor pages too (default true)'),
    },
  },
  async ({ project, include_competitors = true }) => {
    if (!isPro()) return paidGate('run_citability_audit');
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const results = runAeoAnalysis(db, project, { includeCompetitors: include_competitors, log: () => {} });
      persistAeoScores(db, results);
      upsertCitabilityInsights(db, project, results.target);
      const competitorPageCount = [...results.competitors.values()].reduce((a, list) => a + list.length, 0);
      const avgTargetScore = results.target.length
        ? Math.round(results.target.reduce((s, p) => s + p.score, 0) / results.target.length)
        : 0;
      const lowScorePages = results.target
        .filter(p => p.score < 40)
        .sort((a, b) => a.score - b.score)
        .slice(0, 20)
        .map(p => ({ url: p.url, score: p.score, tier: p.tier }));
      const summary = {
        ok: true,
        project,
        target_pages_scored: results.target.length,
        competitor_pages_scored: competitorPageCount,
        avg_target_score: avgTargetScore,
        low_score_target_pages: lowScorePages,
        hint: 'Scores persisted to DB. Call get_intel(project, for=audit) to see the full citability matrix + insights ledger.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        structuredContent: summary,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: get_competitor_positioning (PAID) ───────────────────────────────
server.registerTool(
  'get_competitor_positioning',
  {
    description: 'Return the latest positioning analysis for a project + per-competitor crawl stats. Combines the positioning insight from the ledger (from `analyze` or agent ingests) with raw competitor coverage (page counts, keyword counts, last crawl). Paid tier.',
    inputSchema: {
      project: z.string(),
    },
  },
  async ({ project }) => {
    if (!isPro()) return paidGate('get_competitor_positioning');
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const insights = getActiveInsights(db, project);
      const competitorSummary = getCompetitorSummary(db, project);
      const out = {
        project,
        positioning: insights.positioning,  // null if never analysed
        competitor_summary: competitorSummary,
        last_insight_at: insights.generated_at ? new Date(insights.generated_at).toISOString() : null,
        hint: insights.positioning ? 'Positioning is from the most recent analyze run or agent ingest.' : 'No positioning insight yet — run `seo-intel analyze <project>` or ingest one via ingest_insight(type=positioning).',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: prescore_draft (PAID) ───────────────────────────────────────────
server.registerTool(
  'prescore_draft',
  {
    description: 'Run the AEO scorer on a markdown draft before publishing. Returns the same 6-signal breakdown the dashboard uses (entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage) plus the overall 0-100 score and tier (excellent / good / fair / poor). Use this as a pre-publish gate when drafting via draft_blog_prompt — score < 60 means revise. Paid tier.',
    inputSchema: {
      draft_md: z.string().describe('Full markdown of the draft, including YAML frontmatter if present. The scorer extracts headings, word count, schema_type from frontmatter, etc.'),
    },
  },
  async ({ draft_md }) => {
    if (!isPro()) return paidGate('prescore_draft');
    try {
      const score = prescore(draft_md);
      const out = {
        ok: true,
        score: score.score,
        tier: score.tier,
        signals: score.signals,
        ai_intents: score.ai_intents,
        hint: score.score >= 60
          ? 'Draft scores well. Safe to publish.'
          : 'Below 60 — consider strengthening: add FAQ schema for Q&A proximity, increase entity authority via named experts/citations, shorten paragraphs for answer density, add structured claims (numbers/dates).',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: draft_blog_prompt (PAID) ────────────────────────────────────────
server.registerTool(
  'draft_blog_prompt',
  {
    description: 'Generate an AEO-aware blog draft prompt seeded with full project context — keyword gaps, citability gaps, top entities, brand voice notes, competitor heading patterns. The agent\'s own LLM writes the draft using this prompt. Pair with prescore_draft for a write→score→revise loop. Paid tier.',
    inputSchema: {
      project: z.string(),
      topic: z.string().optional().describe('Specific topic to draft about. If omitted, the prompt asks the LLM to pick the highest-leverage topic from the gap data.'),
      lang: z.enum(['en', 'fi']).optional().describe('Output language (default en)'),
      content_type: z.enum(['blog', 'article', 'guide']).optional().describe('Content type framing (default blog)'),
    },
  },
  async ({ project, topic, lang = 'en', content_type = 'blog' }) => {
    if (!isPro()) return paidGate('draft_blog_prompt');
    const config = loadProjectConfig(project);
    if (!config) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const context = gatherBlogDraftContext(db, project, topic);
      const prompt = buildBlogDraftPrompt(context, { config, lang, topic, contentType: content_type });
      const out = {
        project,
        topic: topic || '(LLM to pick from gap data)',
        lang,
        content_type,
        prompt_length_chars: prompt.length,
        prompt,
        hint: 'Pass `prompt` to your flagship LLM (Opus 4.7 / GPT-4o / etc) to generate the draft. Then run prescore_draft on the output to AEO-score before publishing.',
      };
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
  console.error(`[seo-intel-mcp] v${VERSION} ready on stdio. 12 tools — free: list_projects, get_intel(raw), get_pages, list_keywords, get_headings, run_crawl, get_crawl_status, ingest_insight; paid: get_intel(audit/blog/competitor), run_citability_audit, get_competitor_positioning, prescore_draft, draft_blog_prompt.`);
}

main().catch(err => {
  console.error('[seo-intel-mcp] fatal:', err);
  process.exit(1);
});
