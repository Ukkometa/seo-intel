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
 * Tool counts are derived at boot (TOOL_COUNT and PAID_TOOL_NAMES at the foot
 * of this file) and printed in the ready banner; nothing here hand-counts
 * them. Two tools are partially gated:
 *   get_intel     — free `raw|audit|blog|graph` slices / Solo `competitor` slice
 *   export_intel  — free on 10 tables / Solo for the `analyses` table
 * The free/paid line lives in lib/gate.js (CLI) and the isPro() checks below
 * (MCP). Keep this comment in sync with them; it has drifted before.
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

import { getDb, insertAgentInsight, AGENT_INSIGHT_TYPES, getActiveInsights, getCompetitorSummary, recordDraftCreated } from '../db/db.js';
import { getIntel, INTEL_SLICES, FREE_SLICES } from '../lib/intel.js';
import { isPro } from '../lib/license.js';
import { readProgress } from '../lib/progress.js';
import { getProblems, getProblemCounts, markProblemStatus, getActiveStatusMap, PROBLEM_CATEGORIES, PROBLEM_STATUSES } from '../lib/problems.js';

import { runAeoAnalysis, persistAeoScores, upsertCitabilityInsights } from '../analyses/aeo/index.js';
import { fetchAiAccessForDomains } from '../analyses/aeo/ai-access.js';
import { runTechnicalAudit } from '../analysis/technical-audit.js';
// NOTE: model-suggestion helpers (setup/models.js, setup/checks.js) are loaded
// lazily inside the suggest_models handler, NOT imported at top level — to keep
// the setup subtree (and anything it transitively pulls) off the MCP boot path.
import { prescore, extractDraftTopic } from '../analyses/blog-draft/prescorer.js';
// NOTE: lightCrawl (crawler/light.js) is loaded lazily inside the crawl_site
// handler, NOT imported at top level. Its chain pulls turndown
// (light.js → html-extract.js → sanitize.js → turndown), and a slow/hanging
// turndown import would otherwise block the entire MCP stdio boot — no tools,
// no banner, no handshake. Keep the crawler subtree off the boot path.
// markDraftedGapsInProgress rather than db.js markGapsInProgress: the loop's
// helper also flips the gsc_quick_win / gsc_long_tail rows a draft on a
// measured query closes, so prescore_draft and `seo-intel loop` agree.
import { runContentLoop, markDraftedGapsInProgress } from '../analyses/loop/orchestrator.js';
import { gatherBlogDraftContext, buildBlogDraftPrompt } from '../analyses/blog-draft/index.js';
import { runGscFetch, DEFAULTS as GSC_FETCH_DEFAULTS } from '../analyses/gsc-fetch/index.js';
import { runGscInspect, DEFAULTS as GSC_INSPECT_DEFAULTS } from '../analyses/gsc-inspect/index.js';
import { runDemand, DEFAULTS as DEMAND_DEFAULTS } from '../analyses/demand/index.js';
import { GscApiError, URL_INSPECTION_QUOTA } from '../lib/gsc-api.js';
import { run } from '../agent-harness.js';

// ── Helpers ────────────────────────────────────────────────────────────────
function paidGate(toolName) {
  // Counts stay derived — this message is the one moment a user decides whether
  // to pay, and a stale free-tier list here undersells the product.
  const freeCount = TOOL_COUNT - PAID_TOOL_NAMES.length;
  return {
    content: [{ type: 'text', text: `The "${toolName}" tool requires SEO Intel Solo (€19.99/mo — vs Ahrefs ~$129/mo or Semrush ~$140/mo). The free tier already covers ${freeCount} of the ${TOOL_COUNT} tools, including the full AI Citability Audit (run_citability_audit, rescore_page), tech_audit, the whole crawl pipeline (setup_project, crawl_site, run_crawl, get_crawl_status), every own-site read (get_intel raw/audit/blog/graph, get_pages, list_keywords, get_headings, export_intel) and the problem loop (list_problems, mark_problem_status, ingest_insight). Solo adds what you cannot do alone: competitor analysis, history and trends, and the content loop. Activate at https://ukkometa.fi/en/seo-intel/ — set SEO_INTEL_LICENSE=SI-xxxx-xxxx-xxxx-xxxx in your env.` }],
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
// Designed as the natural entry point. Returns per-project pending problem
// counts so that every interaction with the agent surfaces stale audits —
// the "freemium nag" pattern. Solo users see paid-tier problem counts too.
server.registerTool(
  'list_projects',
  {
    description: 'List all SEO Intel projects on this machine with crawled-page counts AND pending problem counts. Use this as the entry point for every SEO conversation — the response includes a `nag` field per project flagging stale crawls or unresolved critical issues. After noticing the nag, the next natural tool is list_problems(project). Free tier — no license required (Solo users see paid-tier problem counts in addition to free ones).',
  },
  async () => {
    const db = getDb();
    const configs = listConfigProjects();
    const includePaid = isPro();
    const now = Date.now();
    const out = configs.map(c => {
      const row = db.prepare(
        'SELECT COUNT(*) AS n, MAX(d.last_crawled) AS last_crawled FROM pages p JOIN domains d ON d.id=p.domain_id WHERE d.project=?'
      ).get(c.project);
      const pages = row?.n || 0;
      const lastCrawl = row?.last_crawled || null;
      const staleDays = lastCrawl ? Math.floor((now - lastCrawl) / 86_400_000) : null;
      let counts = null;
      let nag = null;
      if (pages > 0) {
        try {
          counts = getProblemCounts(db, c.project, { includePaid });
          const reasons = [];
          if (counts.critical > 0) reasons.push(`${counts.critical} CRITICAL`);
          if (counts.warn > 0) reasons.push(`${counts.warn} warn`);
          if (staleDays !== null && staleDays >= 7) reasons.push(`crawl ${staleDays}d stale`);
          if (reasons.length) {
            nag = `${reasons.join(' · ')}. Call list_problems('${c.project}') to see them${counts.critical > 0 ? ', then fix the criticals first' : ''}.`;
          }
        } catch { /* problems collector failed (e.g. fresh DB) — silent */ }
      }
      return {
        project: c.project,
        target: c.target,
        pages,
        last_crawled: lastCrawl ? new Date(lastCrawl).toISOString() : null,
        stale_days: staleDays,
        problem_counts: counts,
        nag,
        problems_tier: includePaid ? 'paid' : 'free',
      };
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
      '  audit       (FREE)  citability scores + active insights ledger',
      '  blog        (FREE)  keyword gaps + long tails + drafting hints',
      '  graph       (FREE)  internal-link graph — nodes with citability + inbound counts, edges, orphan detection',
      '  competitor  (paid)  competitor summary + keyword matrix + positioning',
      '',
      'Everything about YOUR OWN site is free. Only the competitor slice — data an agent cannot gather for itself — requires an SEO Intel Solo license (set SEO_INTEL_LICENSE in env, or activate via the CLI). When unlicensed, that slice returns a clear upgrade message — no silent failure.',
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

// ── Tool: crawl_site (free — zero-config, zero-signup, local, lightweight) ──
// "Crawl for all Claude users": point it at a URL and it BFS-crawls same-origin
// pages with plain fetch (no browser, no project config, nothing persisted,
// nothing leaves the machine). For deep/JS-rendered/persistent crawls, the user
// installs seo-intel and runs `seo-intel crawl`.
server.registerTool(
  'crawl_site',
  {
    description: [
      'Crawl a website ad-hoc and return structured SEO/AEO data — no project setup, no account, no API key, nothing saved. Point it at any URL.',
      '',
      'Lightweight by design: plain HTTP fetch (no browser/JS rendering), same-origin BFS, honours robots.txt + crawl-delay, small page budget (default 10, hard cap 50). Returns title, meta, headings, links, JSON-LD schema types, word count, indexability — optionally a per-page AI-citability (AEO) score.',
      '',
      'Limits: JS-rendered/SPA pages under-report content (use the full `seo-intel crawl` with Playwright for those). Results are ephemeral — for persistent history, the Intelligence Ledger, and competitor analysis, install seo-intel (still local, own-site free). Free tier.',
    ].join('\n'),
    inputSchema: {
      url: z.string().describe('Start URL (scheme optional — "example.com" works). The crawl follows same-origin links from here.'),
      max_pages: z.number().int().positive().optional().describe('Pages to fetch (default 10, hard cap 50).'),
      include_citability: z.boolean().optional().describe('Run the AEO citability scorer per page (default false). Note: light mode does no entity extraction, so entity-authority is under-counted — run `seo-intel aeo` for the full score.'),
      same_origin: z.boolean().optional().describe('Only follow links on the start site (default true). www/non-www and http/https are treated as the same site.'),
    },
  },
  async ({ url, max_pages, include_citability, same_origin }) => {
    try {
      // Lazy-load the crawler subtree (pulls turndown) only when crawl_site is
      // actually invoked — keeps it off the MCP boot path. See note at top.
      const { lightCrawl } = await import('../crawler/light.js');
      const r = await lightCrawl(url, {
        maxPages: max_pages ?? 10,
        includeCitability: include_citability ?? false,
        sameOrigin: same_origin ?? true,
      });

      // Compact, token-aware shape: drop body_text + the full per-page link lists
      // (return counts + a deduped discovered-URL list instead).
      const pages = r.pages.map(p => ({
        url: p.url,
        status_code: p.status_code,
        title: p.title,
        meta_desc: p.meta_desc,
        canonical: p.canonical || null,
        is_indexable: p.is_indexable,
        word_count: p.word_count,
        headings: p.headings.slice(0, 40),
        schema_types: p.schema_types,
        published_date: p.published_date,
        modified_date: p.modified_date,
        internal_links: p.links.filter(l => l.internal).length,
        external_links: p.links.filter(l => !l.internal).length,
        ...(p.citability ? { citability: p.citability } : {}),
      }));

      // Deduped internal URLs discovered but not crawled (structure peek).
      const crawled = new Set(r.pages.map(p => p.url));
      const discovered = [];
      const seen = new Set();
      for (const p of r.pages) {
        for (const l of p.links) {
          if (l.internal && !crawled.has(l.href) && !seen.has(l.href)) {
            seen.add(l.href); discovered.push(l.href);
            if (discovered.length >= 50) break;
          }
        }
        if (discovered.length >= 50) break;
      }

      const out = {
        start: r.start,
        origin: r.origin,
        stats: r.stats,
        pages,
        discovered_internal_urls: discovered,
        skipped: r.skipped,
        notice: 'Ephemeral + local — nothing was saved and nothing left this machine. Light mode does not render JavaScript, so SPA/JS-built pages under-report content; use `seo-intel crawl` (Playwright) for those. For persistent history, the Intelligence Ledger, AI-citability over time, and competitor analysis, install seo-intel — own-site stays free.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel crawl_site error: ${err.message}` }], isError: true };
    }
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
      '',
      'Provenance: rows written here carry source_kind "agent", model = agent_name, and the confidence you pass (never invented — omit it and the row says "unknown"). They expire ttl_days (default 90) after last_seen unless re-ingested; ingesting the same fingerprint again reopens an expired row. An agent-sourced insight never enters search_review.safe_now: it is a claim another agent may not act on unattended, so a problem derived from it lands in needs_input with your agent_name shown, for a person to verify.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug'),
      type: z.enum(AGENT_INSIGHT_TYPES).describe('Insight type from the allowed set'),
      data: z.record(z.any()).describe('Insight payload — JSON object. Must include the identifier field for the chosen type.'),
      agent_name: z.string().optional().describe('Optional provenance tag (e.g. "claude-opus-4-7"). Stored as source="agent:<name>" and as the row\'s model.'),
      confidence: z.number().min(0).max(1).optional().describe('How sure you are, 0..1. Stored as given; omit when unknown rather than guessing — a NULL reads as "unknown", a made-up number reads as a measurement.'),
      ttl_days: z.number().int().positive().optional().describe('Days after last_seen before the row expires unless re-ingested. Default 90.'),
    },
  },
  async ({ project, type, data, agent_name, confidence, ttl_days }) => {
    try {
      const db = getDb();
      const result = insertAgentInsight(db, { project, type, data, agentName: agent_name, confidence, ttlDays: ttl_days });
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
        source_kind: result.source_kind,
        model: result.model,
        confidence: result.confidence,
        expires_at: result.expires_at ? new Date(result.expires_at).toISOString() : null,
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

// ── Tool: run_citability_audit (FREE) ─────────────────────────────────────
server.registerTool(
  'run_citability_audit',
  {
    description: 'Run AEO citability scoring across all crawled pages (7 signals: entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage, and AI-crawler access). Also checks robots.txt per target domain — if it blocks answer-engine crawlers (ClaudeBot / GPTBot / PerplexityBot / Google-Extended), affected pages are gated low because AI assistants literally cannot read them. Persists scores to citability_scores and upserts citability_gap insights into the ledger. Free tier — analysis of your own site is free.',
    inputSchema: {
      project: z.string(),
      include_competitors: z.boolean().optional().describe('Score competitor pages too (default true)'),
      check_ai_access: z.boolean().optional().describe('Fetch robots.txt per target domain to score AI-crawler access (default true). The only network call this tool makes; set false to keep it fully offline.'),
    },
  },
  async ({ project, include_competitors = true, check_ai_access = true }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      let aiAccessByDomain = null;
      if (check_ai_access) {
        const targetDomains = db
          .prepare("SELECT DISTINCT domain FROM domains WHERE project = ? AND role IN ('target','owned')")
          .all(project).map(r => r.domain);
        if (targetDomains.length) {
          try { aiAccessByDomain = await fetchAiAccessForDomains(targetDomains); } catch { /* best-effort */ }
        }
      }
      const results = runAeoAnalysis(db, project, { includeCompetitors: include_competitors, aiAccessByDomain, log: () => {} });
      if (!results.summary) {
        // No crawled page has body text: nothing was scored and nothing may be
        // resolved. The CLI says so; this used to throw on the null summary.
        const empty = {
          ok: false, project, target_pages_scored: 0, competitor_pages_scored: 0,
          hint: `No pages with body_text found for "${project}". Run "seo-intel crawl ${project}" first (the crawl stores body text since v1.1.6).`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(empty, null, 2) }], structuredContent: empty };
      }
      persistAeoScores(db, results, project);
      // aiAccessChecked: only a run that actually read robots.txt for every
      // target domain may resolve the domain-level "crawlers are blocked" rows
      // it did not re-emit. The summary decides that, not `aiAccessByDomain !=
      // null`: fetchAiAccessForDomains never throws, so a failed fetch still
      // hands back a Map — of "assume open" verdicts.
      upsertCitabilityInsights(db, project, results.target, results.summary.aiAccess, { aiAccessChecked: results.summary.aiAccessChecked });
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
        ai_access: results.summary.aiAccess,
        // false when robots.txt was skipped or could not be read for a target
        // domain: each ai_access entry's `fetched` says which. Such a run
        // scores AI access as open by default and resolves no citability_gap.
        ai_access_checked: results.summary.aiAccessChecked,
        ai_access_gated_pages: results.summary.gatedPages,
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

// ── Tool: backlink_audit (FREE) ───────────────────────────────────────────
server.registerTool(
  'backlink_audit',
  {
    description: [
      'Audit the link profile Google attributes to this project: brand reclamation, followed vs nofollow, domain concentration, and which of your pages receive no links.',
      '',
      'Not a link index — it will not find links Google has not reported, and it cannot see competitor backlinks. What it does instead is ask what is wrong with the links you already have, and join them to your own crawl and query data.',
      '',
      'The single highest-yield output is usually `reclamation`: domains already linking to you under a product or brand name the site no longer uses. Those are existing relationships, far cheaper to correct than new links are to earn, and one outreach fixes every page on that domain.',
      '',
      'Set live:true to fetch the linking pages and recover the target URL and anchor text, which Search Console does not export. Treat `unknown` as unknown: a site that blocks bots or renders its links client-side has told you nothing, and its absence is not a lost link.',
      '',
      'Requires import_backlinks to have run. Free tier — your own Search Console data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      live: z.boolean().optional().describe('Fetch linking pages to verify and recover target/anchor. Slower and partly blocked by third-party sites.'),
      limit: z.number().int().positive().max(500).optional().describe('With live, only verify the first N links.'),
    },
  },
  async ({ project, live, limit }) => {
    const config = loadProjectConfig(project);
    if (!config) return { content: [{ type: 'text', text: `Project "${project}" not found.` }], isError: true };
    const { runBacklinkAudit } = await import('../analyses/backlinks/index.js');
    const r = await runBacklinkAudit(getDb(), project, { live: !!live, limit, brandTerms: config.brandTerms || [] });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  },
);

// ── Tool: qualify_link_prospect (FREE) ────────────────────────────────────
server.registerTool(
  'qualify_link_prospect',
  {
    description: [
      'Given a domain you are considering for outreach, say whether it is worth the effort for this project.',
      '',
      'This is the division of labour that works: YOU find candidates — web search is good at "who writes about X" — and this scores them against data only the local database has. It deliberately does not suggest prospects of its own, because without a link index any such list would be generic filler.',
      '',
      'Returns whether the domain already links here and how, whether those links point at an outdated brand name (in which case the ask is an update, not a new link, and is far more likely to land), how saturated your profile already is with that domain, and which of your pages most needs a link.',
      '',
      'Free tier — your own data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug.'),
      domain: z.string().describe('Candidate domain, e.g. "example.com". A full URL is accepted and reduced to its host.'),
    },
  },
  async ({ project, domain }) => {
    const config = loadProjectConfig(project);
    if (!config) return { content: [{ type: 'text', text: `Project "${project}" not found.` }], isError: true };
    const db = getDb();
    const { hostOf } = await import('../lib/backlink-import.js');
    const host = hostOf(domain.includes('://') ? domain : `https://${domain}`) || domain.toLowerCase().replace(/^www\./, '');

    let existing = [];
    try {
      existing = db.prepare('SELECT * FROM backlinks WHERE project = ? AND linking_domain = ?').all(project, host);
    } catch { /* not imported */ }

    let total = 0, domains = 0;
    try {
      total = db.prepare('SELECT COUNT(*) c FROM backlinks WHERE project = ?').get(project).c;
      domains = db.prepare('SELECT COUNT(DISTINCT linking_domain) c FROM backlinks WHERE project = ?').get(project).c;
    } catch { /* ignore */ }

    const { runBacklinkAudit } = await import('../analyses/backlinks/index.js');
    const audit = await runBacklinkAudit(db, project, { brandTerms: config.brandTerms || [], skipLedger: true });
    const reclaim = (audit.reclamation || []).find(d => d.domain === host);
    const followed = existing.filter(r => r.link_present === 1 && r.rel_nofollow === 0).length;
    const nofollowed = existing.filter(r => r.link_present === 1 && r.rel_nofollow === 1).length;

    const verdict = reclaim
      ? 'update_existing'
      : existing.length
        ? (followed ? 'already_linked_followed' : 'already_linked_nofollow')
        : 'new_prospect';

    return { content: [{ type: 'text', text: JSON.stringify({
      project, domain: host, verdict,
      already_linking: existing.length > 0,
      linking_pages: existing.length,
      followed, nofollowed,
      verified: existing.filter(r => r.verify_state).length,
      brand_reclamation: reclaim
        ? { pages: reclaim.pages, note: `Already links here ${reclaim.pages} time(s) under a name the site no longer uses. Ask for an update, not a new link — one message fixes every page on this domain.` }
        : null,
      profile_context: {
        linking_pages: total, referring_domains: domains,
        this_domain_share_pct: total ? Math.round(existing.length * 100 / total) : 0,
        top_domain_share_pct: audit.summary?.topDomainSharePct ?? null,
      },
      best_target_pages: (audit.unlinkedHighValuePages || []).slice(0, 5),
      caveat: 'Based on the links Google reports for this site, which is a capped and lagging sample. A domain absent here may still link to you.',
    }, null, 2) }] };
  },
);

// ── Tool: import_backlinks (FREE) ─────────────────────────────────────────
server.registerTool(
  'import_backlinks',
  {
    description: 'Import a Search Console external-links CSV from links/<project>*.csv into the local database. Use the "Latest links" export: on a site under the export cap it holds the same URLs as "More sample links" plus a Last crawled date. Free tier.',
    inputSchema: { project: z.string().describe('Project slug.') },
  },
  async ({ project }) => {
    if (!loadProjectConfig(project)) return { content: [{ type: 'text', text: `Project "${project}" not found.` }], isError: true };
    const { importBacklinks } = await import('../lib/backlink-import.js');
    const db = getDb();
    const r = importBacklinks(db, project, {});
    const stored = db.prepare('SELECT COUNT(*) c FROM backlinks WHERE project = ?').get(project).c;
    return { content: [{ type: 'text', text: JSON.stringify({
      ...r, stored_unique: stored,
      hint: r.files.length ? 'Next: backlink_audit(project) — add live:true to recover target URLs and anchor text.'
        : `No export found. Search Console → Links → External links → Export, saved as links/${project}-<label>.csv`,
    }, null, 2) }] };
  },
);

// ── Tool: import_gsc_queries (FREE) ───────────────────────────────────────
server.registerTool(
  'import_gsc_queries',
  {
    description: [
      'Import Google Search Console query exports for a project from gsc/<project>*/ into the local database.',
      '',
      'Each export is recorded with the scope its own Filters.csv declares. An export taken with a Page filter becomes page-level evidence; an unfiltered one is property-wide and is NOT evidence about any individual page. The result says which you have.',
      '',
      'This is the CSV route; prefer fetch_gsc when the Google account is connected — it covers every page with real dates and needs no export. Run one of the two before page_contract. Free tier — it is your own Search Console data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
    },
  },
  async ({ project }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    const { importGscQueries } = await import('../lib/gsc-import.js');
    const result = importGscQueries(getDb(), project);
    const hasPage = result.exports.some(e => e.scope === 'page');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        ...result,
        has_page_scoped_evidence: hasPage,
        hint: hasPage
          ? 'Page-level evidence available. page_contract can now decide on those URLs.'
          : `No page-filtered export present, so every page-level decision will come back blocked. In Search Console, filter by Page, then Export, and save the folder as gsc/${project}-<label>/.`,
      }, null, 2) }],
    };
  },
);

// ── Tool: fetch_gsc (FREE) ────────────────────────────────────────────────
server.registerTool(
  'fetch_gsc',
  {
    description: [
      `Fetch Google Search Console data for a project straight from the Search Analytics API into the local database. Stores three grains with real dates: page×query daily (the last ${GSC_FETCH_DEFAULTS.days} days by default), page daily and query daily (${GSC_FETCH_DEFAULTS.months} months of history, the API's own horizon).`,
      '',
      'Incremental: each call extends what is stored and re-fetches only the last few days Google may still revise, so repeat calls are cheap. Only the project\'s own property is fetched — matched from target.domain, or pinned with gsc.property in the project config or the property argument; a miss lists the properties the account does have. Set dry_run to see the windows it would request without spending quota; with a configured property that needs no credentials at all.',
      '',
      'Needs the Google account connected (seo-intel auth google) or GSC_ACCESS_TOKEN in the environment.',
      '',
      'page_contract prefers this data over CSV exports (import_gsc_queries). With it, a page with no rows is measured absence — the page earned no reportable impressions in the window — not missing data. Free tier — it is your own Search Console data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      days: z.number().int().positive().optional().describe(`page×query lookback in days. Default ${GSC_FETCH_DEFAULTS.days}.`),
      months: z.number().int().positive().optional().describe(`page and query lookback in months, capped at the API's ${GSC_FETCH_DEFAULTS.maxMonths}. Default ${GSC_FETCH_DEFAULTS.months}.`),
      dry_run: z.boolean().optional().describe('Plan the date windows without making any Search Analytics request.'),
      property: z.string().optional().describe('Search Console siteUrl to fetch (sc-domain:example.com or https://www.example.com/). Overrides auto-detection and config.gsc.property.'),
    },
  },
  async ({ project, days, months, dry_run, property }) => {
    const config = loadProjectConfig(project);
    if (!config) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const result = await runGscFetch(getDb(), project, config, { days, months, dryRun: !!dry_run, property });
      const rows = result.grains.reduce((n, g) => n + (g.rows || 0), 0);
      const windows = result.grains.reduce((n, g) => n + g.windows.length, 0);
      return { content: [{ type: 'text', text: JSON.stringify({
        ...result,
        hint: result.dry_run
          ? `Plan only: ${windows} window(s) would be requested. Call again without dry_run to fetch them.`
          : windows
            ? `${rows} rows stored. page_contract now decides from this data; call it on the URLs you care about.`
            : 'Already current — nothing to fetch. page_contract reads the stored data.',
      }, null, 2) }] };
    } catch (err) {
      // GscApiError carries the fix (401 → reconnect, 403 → property or API
      // access, 429 → wait). The agent needs it verbatim, not paraphrased.
      const text = err instanceof GscApiError && err.hint ? `${err.message}\n${err.hint}` : `seo-intel error: ${err.message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  },
);

// ── Tool: inspect_urls (FREE) ─────────────────────────────────────────────
server.registerTool(
  'inspect_urls',
  {
    description: [
      "Ask Google whether it has indexed a project's pages, via the URL Inspection API, and store each answer locally. Per URL: Google's own verdict (PASS indexed · PARTIAL indexed with issues · FAIL an error prevents indexing · NEUTRAL excluded), the coverage state in Google's words, and the canonical Google chose. This is the fact the crawl's is_indexable flag only infers: a noindex added by a CDN, a canonical Google picked for itself, a page crawled and judged not worth keeping are all invisible to a crawl and visible here.",
      '',
      `Quota: ${URL_INSPECTION_QUOTA.perDay} inspections per property per day, so the tool is demand-first — candidates are the crawled target pages ordered by 28-day impressions (fetch_gsc data), then sitemap presence, then crawl indexability — the default limit is ${GSC_INSPECT_DEFAULTS.limit}, and URLs inspected within the last ${GSC_INSPECT_DEFAULTS.maxAgeDays} days are skipped (max_age_days 0 re-asks). Pass urls to inspect exactly those instead; URLs outside the property are reported as skipped rather than sent. A 429 stops the run cleanly with every verdict so far kept. dry_run lists the selection without spending quota.`,
      '',
      'NEUTRAL is often intended: a noindex page or a URL canonicalised elsewhere. Read it against the page before calling it a problem. The stored verdicts feed list_problems (indexability: FAIL, unintended NEUTRAL, canonical mismatch) and search_review.working ("Google has indexed your pages"), so call those after this.',
      '',
      'Needs the Google account connected (seo-intel auth google) or GSC_ACCESS_TOKEN in the environment. Free tier — it is your own site and your own Search Console.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      urls: z.array(z.string()).optional().describe('Inspect exactly these URLs, ignoring limit and the recency skip. Omit to let demand choose.'),
      limit: z.number().int().positive().optional().describe(`URLs to inspect this call. Default ${GSC_INSPECT_DEFAULTS.limit}.`),
      max_age_days: z.number().int().min(0).optional().describe(`Skip URLs inspected within this many days; 0 re-inspects everything selected. Default ${GSC_INSPECT_DEFAULTS.maxAgeDays}.`),
      dry_run: z.boolean().optional().describe('Select and return the planned URLs without making any URL Inspection request.'),
      property: z.string().optional().describe('Search Console siteUrl to inspect against (sc-domain:example.com or https://www.example.com/). Overrides auto-detection and config.gsc.property.'),
    },
  },
  async ({ project, urls, limit, max_age_days, dry_run, property }) => {
    const config = loadProjectConfig(project);
    if (!config) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const result = await runGscInspect(getDb(), project, config, { urls, limit, maxAgeDays: max_age_days, dryRun: !!dry_run, property });
      const v = result.verdicts;
      const maxAge = max_age_days ?? GSC_INSPECT_DEFAULTS.maxAgeDays;
      let hint;
      if (result.dry_run) {
        hint = `Plan only: ${result.planned.length} URL(s) would be inspected. Call again without dry_run to inspect them.`;
      } else if (result.inspected) {
        hint = `${result.inspected} verdict(s) stored (${v.PASS} PASS, ${v.PARTIAL} PARTIAL, ${v.FAIL} FAIL, ${v.NEUTRAL} NEUTRAL). NEUTRAL is often an intended noindex or canonical — read it against the page. list_problems(project, category='indexability') and search_review now include these verdicts.`
          + (result.stopped_reason === 'quota' ? ` Google's daily inspection quota is spent; ${result.quota_capped + (result.planned.length - result.inspected - result.errors.length)} planned URL(s) remain for tomorrow.` : '');
      } else if (result.planned.length) {
        hint = 'Nothing stored: every request failed. See errors[] for what Google said about each URL.';
      } else if (result.skipped_recent) {
        hint = `Nothing to inspect: every candidate was inspected within the last ${maxAge} day(s). Pass max_age_days 0 to re-ask, or urls to name specific pages.`;
      } else if (result.quota_capped) {
        hint = "Nothing to inspect today: Google's daily inspection quota for this property is already spent. Try again tomorrow.";
      } else {
        hint = 'Nothing to inspect: no crawled target pages answered 200, or every named URL lies outside the property (see skipped_out_of_property). run_crawl(project) first.';
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, hint }, null, 2) }] };
    } catch (err) {
      // GscApiError carries the fix (401 → reconnect, 403 → property or API
      // access, 429 → the day's quota). The agent needs it verbatim.
      const text = err instanceof GscApiError && err.hint ? `${err.message}\n${err.hint}` : `seo-intel error: ${err.message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  },
);

// ── Tool: demand_opportunities (FREE) ─────────────────────────────────────
server.registerTool(
  'demand_opportunities',
  {
    description: [
      `Quick wins and long tails computed from the project's own Search Console rows (fetch_gsc data) over the last ${DEMAND_DEFAULTS.windowDays} days by default. Arithmetic over stored rows — no request, no model, nothing estimated: every impression, click and position is what Google reported for this property. This is the measured counterpart of the keyword-volume estimates Ahrefs and Semrush sell.`,
      '',
      `A quick win is a query the site already ranks for within striking distance (positions ${DEMAND_DEFAULTS.strikingMin}-${DEMAND_DEFAULTS.strikingMax}) with ${DEMAND_DEFAULTS.minImpressions}+ impressions in the window, where either the click-through rate is well under the baseline for that position (kind ctr_gap: a title and meta description rewrite recovers clicks without ranking any higher) or the page sits on page two (kind page_two: internal links and depth move it onto page one), or both. potential_clicks sizes each in clicks per window.`,
      '',
      `A long tail is a phrase of ${DEMAND_DEFAULTS.longTailMinWords}+ words the property is shown for (${DEMAND_DEFAULTS.minLongTailImpressions}+ impressions) at position ${DEMAND_DEFAULTS.longTailMinPosition} or worse with no page of its own on page one. best_page names the page most shown for the phrase, to strengthen; null means a page is missing.`,
      '',
      'The CTR baseline (expected_ctr) is a heuristic industry curve — steep at the top, flat past position 10 — used to rank rows against each other and to size an estimate. It is not a measurement of this site, so read potential_clicks as "about", never as a forecast.',
      '',
      'Both kinds are written to the Intelligence Ledger as rule-sourced insights (gsc_quick_win, gsc_long_tail), so search_review(project).opportunities lists them next to the model\'s, and a win missing from a later complete run is resolved because the position moved or the CTR recovered. Requires fetch_gsc to have run; with no rows the response says so instead of returning empty lists. Free tier — it is your own Search Console data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      window_days: z.number().int().min(7).optional().describe(`Days of Search Console history to aggregate. Default ${DEMAND_DEFAULTS.windowDays}; clamped to the days actually fetched.`),
      min_impressions: z.number().int().positive().optional().describe(`Impressions a query needs in the window to count as a quick win. Default ${DEMAND_DEFAULTS.minImpressions}.`),
    },
  },
  async ({ project, window_days, min_impressions }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const result = runDemand(getDb(), project, { windowDays: window_days, minImpressions: min_impressions, trends: false });
      let hint;
      if (result.skipped_reason) {
        hint = `${result.hint} — then call this again.`;
      } else {
        hint = `${result.counts.quick_wins} quick win(s) and ${result.counts.long_tails} long tail(s) over ${result.window.start}..${result.window.end}, filed in the Ledger as rule-sourced findings; search_review("${project}").opportunities lists them. ctr_gap wins are snippet rewrites, page_two wins are internal-link work; a long tail with a best_page is a section to add there, one without is a page to create. Call page_contract before recommending content changes on any page named here.`;
        if (Object.values(result.coverage).includes('partial')) hint += ' Coverage is partial (a fetch hit its row cap), so findings are recorded but none resolved this run.';
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, hint }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  },
);

// ── Tool: demand_trends (PAID) ────────────────────────────────────────────
server.registerTool(
  'demand_trends',
  {
    description: [
      `Traffic decay and growth from the project's own Search Console history: the page grain of the last ${DEMAND_DEFAULTS.windowDays} days (window_days) against the same-length window ending the day before. A page is decaying when its clicks fell ${DEMAND_DEFAULTS.decayPct}%+ from ${DEMAND_DEFAULTS.minTrendClicks}+ clicks, growing when they rose ${DEMAND_DEFAULTS.growthPct}%+ from that floor; the floor keeps 3 → 1 clicks from reading as a trend. Each entry carries both windows' clicks, impressions and position, and a recommendation naming the lever the two windows point at: a page gone, a ranking slipped, demand fallen with position held, or a snippet converting less.`,
      '',
      'Arithmetic over stored rows — no request, no model. Decays are written to the Ledger as gsc_decay (scope history) and reach search_review and list_problems under a Solo licence; growth is returned but not filed. The comparison is skipped, and nothing written, when the previous window is shorter than the current one — history that does not yet reach back two windows would make every page look like growth; a smaller window_days fits two windows into what is fetched.',
      '',
      'Requires fetch_gsc to have run; it pulls months of page history, so two windows are usually available from the first fetch. Paid tier (Solo): history is what one crawl or one fetch cannot give.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      window_days: z.number().int().min(7).optional().describe(`Days per window; the previous window is the same length, ending the day before this one starts. Default ${DEMAND_DEFAULTS.windowDays}.`),
    },
  },
  async ({ project, window_days }) => {
    if (!isPro()) return paidGate('demand_trends');
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const result = runDemand(getDb(), project, { windowDays: window_days, trends: true });
      const t = result.trends;
      let hint;
      if (result.skipped_reason) {
        hint = `${result.hint} — then call this again.`;
      } else if (t.skipped_reason === 'no_page_grain') {
        hint = `No page-grain rows stored; fetch_gsc("${project}") pulls them.`;
      } else if (t.skipped_reason === 'previous_window_short') {
        hint = `Not compared: the previous window (${t.previous_window ? `${t.previous_window.days} day(s)` : 'none'}) is shorter than the current ${result.window.days}. Pass a smaller window_days to fit two windows into the fetched history, or wait for more fetches. Nothing was written.`;
      } else {
        hint = `${t.decays.length} decaying and ${t.growth.length} growing page(s), ${t.previous_window.start}..${t.previous_window.end} → ${result.window.start}..${result.window.end}. Decays are filed as gsc_decay; search_review("${project}") lists them under opportunities. Each recommendation names the lever the two windows point at — read the position and impression columns before choosing another.`;
        if (result.coverage.page === 'partial') hint += ' Coverage is partial (a fetch hit its row cap in one window), so decays are recorded but none resolved this run.';
      }
      // The trends half only: quick wins and long tails are demand_opportunities'
      // (free), even though this run refreshed them in the Ledger too.
      const out = {
        project: result.project, property: result.property, search_type: result.search_type,
        window: result.window, previous_window: t?.previous_window ?? null,
        coverage: result.coverage?.page ?? null,
        decays: t?.decays ?? [], growth: t?.growth ?? [],
        counts: { decays: result.counts.decays, growth: result.counts.growth },
        skipped_reason: result.skipped_reason ?? t?.skipped_reason ?? null,
        hint,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  },
);

// ── Tool: page_contract (FREE) ────────────────────────────────────────────
server.registerTool(
  'page_contract',
  {
    description: [
      'Decide what ONE page actually needs, from measured search demand rather than from what the page happens to look like.',
      '',
      'CALL THIS BEFORE recommending any content change to an indexable page — before suggesting the page expand, target new terms, merge with another, or claim a category. It returns:',
      '',
      '  decision                 expand | consolidate | reposition | protect | no_action_yet',
      '  decision_basis           the measured facts that produced it',
      '  blocked_recommendations  advice you must NOT give yet, each with the exact input that would unblock it',
      '  allowed_now              work that is safe regardless of demand data',
      '  evidence                 branded vs non-branded split, page-level and property-level',
      '',
      'TREAT blocked_recommendations AS BINDING. If "expand" is blocked, do not suggest adding sections, keywords, or FAQs to the page — say what is missing and how to get it. Property-wide rankings are context only and can never be attributed to a single URL.',
      '',
      'Demand evidence gates content INVESTMENT, not correctness. Items under allowed_now — invalid structured data, indexability faults — should still be fixed and reported even when every content action is blocked.',
      '',
      'Requires fetch_gsc or import_gsc_queries to have run. Free tier — it is your own site and your own Search Console data.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      url: z.string().describe('The exact page URL to decide on.'),
      brand_terms: z.array(z.string()).optional().describe('Extra brand names that cannot be derived from the domain or schema (a product brand, for example). Terms derived automatically are returned in evidence.brand_terms — check them.'),
    },
  },
  async ({ project, url, brand_terms }) => {
    const config = loadProjectConfig(project);
    if (!config) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    const { runPageContract } = await import('../analyses/page-contract/index.js');
    const result = runPageContract(getDb(), project, url, {
      brandTerms: brand_terms || config.brandTerms || config.gsc?.brandTerms || [],
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: search_review (FREE) ────────────────────────────────────────────
server.registerTool(
  'search_review',
  {
    description: [
      'The one-call answer to "what should I do about this site?" — every known own-site finding, triaged into three buckets and one reassurance list:',
      '',
      '  needs_input    blocked on a person: missing evidence, or a judgment no detector can make. Short by design — growth ideas never land here.',
      '  safe_now       hygiene that ships with a fix template. Correctness, not investment, so an agent may work these unattended.',
      '  opportunities  growth bets (keyword, content, positioning). Weigh them with the person; never treat them as tasks.',
      '  working        checks that passed. Withheld entirely when the crawl is stale or missing, because a wrong green tick stops someone looking.',
      '',
      'Composes list_problems with page_contract. Pass urls to fold per-page decisions in: their blocked recommendations land in needs_input with the exact input that unblocks them, and their allowed work lands in safe_now.',
      '',
      'Every item carries source {kind, model, prompt_version, rule_version, confidence}, and safe_now holds only rule-sourced findings — a model- or agent-sourced problem in an autonomous category goes to needs_input with its origin named, because nothing has checked it.',
      '',
      "When inspect_urls has run, Google's own index verdicts are included: pages Google did not index surface as problems, and working reports \"Google has indexed your pages\" from the stored verdicts rather than from the crawl's inference.",
      '',
      'CALL THIS FIRST in a session, before list_problems or any content advice. Read freshness.state before acting on anything: "stale" or "missing" means the findings may describe a page that no longer exists — run_crawl(project) first. Free tier — it reads only your own site.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      urls: z.array(z.string()).optional().describe('Page URLs whose page_contract decisions should be folded into the review.'),
      limit: z.number().int().positive().max(200).optional().describe('Cap per bucket. Default: no cap.'),
    },
  },
  async ({ project, urls = [], limit }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const { runReview } = await import('../analyses/review/index.js');
      const result = runReview(getDb(), project, { includePaid: isPro(), urls, limit: limit || 0 });
      const next = result.freshness.state !== 'fresh'
        ? 'Crawl data is stale or missing — run_crawl(project) before acting on any item.'
        : result.needs_input.length
          ? 'Resolve needs_input with the person first. safe_now may be worked unattended; verify each fix with its verification step, then mark_problem_status.'
          : 'No decisions pending. safe_now may be worked unattended; verify each fix with its verification step, then mark_problem_status.';
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, next }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `search_review failed: ${err.message}` }], isError: true };
    }
  },
);

// ── Tool: tech_audit (FREE) ───────────────────────────────────────────────
server.registerTool(
  'tech_audit',
  {
    description: [
      'Run the technical SEO audit on already-crawled data for a project — titles, meta descriptions, noindex/robots conflicts, redirect chains, canonical issues, and sitemap-vs-crawl diff. Returns severity-sorted findings (error / warn / info) with the affected URL and a description each.',
      '',
      'Reads from the local DB (no re-crawl). Optionally runs live HEAD checks against sitemap URLs (network) to catch broken/redirected entries. Free tier — covers your own target/owned domains.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug. Use list_projects to discover.'),
      domain: z.string().optional().describe('Audit a single domain. Omit to audit all target/owned domains in the project.'),
      sitemap_head: z.boolean().optional().describe('Also run live HEAD checks against sitemap URLs (network-heavy). Default false.'),
      limit: z.number().int().positive().max(200).optional().describe('Max findings to return per domain (default 60).'),
    },
  },
  async ({ project, domain, sitemap_head, limit = 60 }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const domainRows = domain
        ? [{ domain }]
        : db.prepare("SELECT domain FROM domains WHERE project = ? AND role IN ('target','owned')").all(project);
      if (!domainRows.length) {
        return { content: [{ type: 'text', text: `No target/owned domains found for project "${project}".` }], isError: true };
      }
      const order = { error: 0, warn: 1, info: 2 };
      const domains = [];
      for (const { domain: d } of domainRows) {
        const res = await runTechnicalAudit(db, { project, domain: d, runSitemapHead: !!sitemap_head });
        if (res.error) { domains.push({ domain: d, error: res.error }); continue; }
        const findings = [...(res.findings || [])]
          .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
          .slice(0, limit)
          .map(f => ({ severity: f.severity, type: f.type, url: f.url || null, details: f.details }));
        domains.push({ domain: d, stats: res.stats, findings, findings_truncated: (res.findings || []).length > limit });
      }
      const out = {
        ok: true,
        project,
        domains,
        hint: 'Findings read from the local crawl DB. Re-run `run_crawl` then this tool to verify fixes cleared. For AI-citability gaps, use run_citability_audit; for the prioritized fix queue, use list_problems.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: rescore_page (FREE) ─────────────────────────────────────────────
// Closes the agent loop from ANY MCP host: act → rescore_page → see the delta.
server.registerTool(
  'rescore_page',
  {
    description: [
      'Re-check a single URL\'s AI citability after a fix — the verify step of the agent loop. Fetches the LIVE page over plain HTTP (raw-HTML / "what bots see" lens: server-rendered fixes move the score, JS-only fixes correctly do not), re-scores it, and returns before / after / delta against the stored baseline plus the per-signal breakdown.',
      '',
      'Read-only toward your site and toward stored scores — a measurement, not a mutation. Use after editing a page (e.g. via the seo-autofix loop) to prove the change actually landed. Free tier.',
    ].join('\n'),
    inputSchema: {
      project: z.string().describe('Project slug (scopes the stored baseline). Use list_projects to discover.'),
      url: z.string().describe('The exact URL to re-score, e.g. https://example.com/pricing'),
    },
  },
  async ({ project, url }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      // Lazy import — rescore.js pulls the crawler subtree (light.js → turndown),
      // which must stay off the MCP boot path (see crawl_site note above).
      const { rescorePage } = await import('../analyses/aeo/rescore.js');
      const db = getDb();
      const result = await rescorePage(db, project, url);
      const out = {
        ok: true,
        project,
        ...result,
        hint: result.before == null
          ? 'No stored baseline for this URL — run run_crawl + run_citability_audit first to establish one; the after-score is still valid on its own.'
          : 'Delta is measured on the raw-HTML lens. If your fix is client-side JS only, the score will not move — and that itself is the finding.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: suggest_models (FREE) ───────────────────────────────────────────
server.registerTool(
  'suggest_models',
  {
    description: [
      'Suggest LOCAL extraction models for the user\'s machine — the small models seo-intel runs once per crawled page to pull structured SEO data. Detects GPU/VRAM and which models are already in Ollama, then recommends from the curated set (Gemma 4 E2B / E4B / 12B, Qwen 3.5 4B / 9B).',
      '',
      'IMPORTANT: extraction should be done with a LOCAL model. The response always includes a cloud disclaimer — surface it to the user. Cloud extraction sends every page off-machine, costs money at scale, and rate-limits; a 4–8B local model handles this task well, offline. Free tier.',
    ].join('\n'),
    inputSchema: {
      vram_gb: z.number().positive().optional().describe('Override detected VRAM (GB). Omit to auto-detect the host GPU/unified memory.'),
    },
  },
  async ({ vram_gb }) => {
    try {
      const { suggestExtractionModels, CLOUD_EXTRACTION_DISCLAIMER } = await import('../setup/models.js');
      let vramMB = 0, gpuName = null;
      if (vram_gb) { vramMB = Math.round(vram_gb * 1024); gpuName = 'user-specified'; }
      else { try { const { detectVRAM } = await import('../setup/checks.js'); const v = detectVRAM(); vramMB = v.vramMB || 0; gpuName = v.gpuName || null; } catch { /* unknown */ } }

      let installed = [];
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 1500);
        const r = await fetch('http://localhost:11434/api/tags', { signal: c.signal });
        clearTimeout(t);
        if (r.ok) { const d = await r.json(); installed = (d.models || []).map(m => m.name); }
      } catch { /* Ollama not reachable */ }

      const { suggestions, recommendedId } = suggestExtractionModels(vramMB, installed);
      const out = {
        hardware: { gpu: gpuName, vram_gb: vramMB ? +(vramMB / 1024).toFixed(1) : null },
        recommended: recommendedId,
        install_hint: recommendedId ? `ollama pull ${recommendedId}` : null,
        suggestions,
        cloud_disclaimer: CLOUD_EXTRACTION_DISCLAIMER,
        note: 'Extraction should be done with a LOCAL model — show cloud_disclaimer to the user before suggesting any cloud option.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: setup_project (FREE — project creation from chat) ───────────────
// Closes the "setting up" gap: before this, projects could only be created via
// the CLI/web wizard. An agent can now take a user from zero → configured →
// crawled → audited entirely in chat.
server.registerTool(
  'setup_project',
  {
    description: [
      'Create (or update) a SEO Intel project from chat — no CLI wizard needed. Writes the project config that run_crawl / run_citability_audit / tech_audit / get_intel operate on.',
      '',
      'Minimum: project_name + target_url. Add competitors to unlock the Solo competitive surface later. Industry/audience/goal feed the analysis prompts — better context, better insights. Use suggest_models first to pick a local extraction model for the user\'s hardware.',
      '',
      'Refuses to overwrite an existing project unless overwrite=true. Free tier.',
    ].join('\n'),
    inputSchema: {
      project_name: z.string().describe('Human name — slugified for the project id (e.g. "Carbium Docs" → carbium-docs).'),
      target_url: z.string().describe('The site to optimize (scheme optional).'),
      site_name: z.string().optional().describe('Brand/site display name (defaults to project_name).'),
      industry: z.string().optional().describe('What the site/business does — feeds analysis context.'),
      audience: z.string().optional().describe('Who the site serves — feeds analysis context.'),
      goal: z.string().optional().describe('What success looks like — feeds analysis context.'),
      competitors: z.array(z.string()).optional().describe('Competitor URLs/domains to track (Solo features use these).'),
      owned: z.array(z.string()).optional().describe('Other owned domains/subdomains to include.'),
      pages_per_domain: z.number().int().positive().optional().describe('Max pages per domain per crawl (default 50).'),
      extraction_model: z.string().optional().describe('Local extraction model tag (e.g. gemma4:e4b). Get a recommendation from suggest_models.'),
      overwrite: z.boolean().optional().describe('Allow overwriting an existing project config (default false).'),
    },
  },
  async ({ project_name, target_url, site_name, industry, audience, goal, competitors = [], owned = [], pages_per_domain, extraction_model, overwrite = false }) => {
    try {
      const { buildProjectConfig, writeProjectConfig, validateConfig, slugify } = await import('../setup/config-builder.js');
      const slug = slugify(project_name);
      const existing = join(CONFIG_DIR, `${slug}.json`);
      if (existsSync(existing) && !overwrite) {
        return { content: [{ type: 'text', text: `Project "${slug}" already exists. Pass overwrite=true to replace it, or use list_projects to see what's configured.` }], isError: true };
      }

      const config = buildProjectConfig({
        projectName: project_name,
        targetUrl: target_url,
        siteName: site_name || project_name,
        industry: industry || '',
        audience: audience || '',
        goal: goal || '',
        competitors: competitors.map(u => ({ url: u })),
        owned: owned.map(u => ({ url: u })),
        pagesPerDomain: pages_per_domain || 50,
        extractionModel: extraction_model,
      });

      const validation = validateConfig(config);
      if (!validation.valid) {
        return { content: [{ type: 'text', text: `Config validation failed: ${validation.errors.join('; ')}` }], isError: true };
      }

      const written = writeProjectConfig(config, ROOT);
      const out = {
        ok: true,
        project: config.project,
        config_path: written.path,
        overwritten: written.overwritten,
        target: config.target?.domain,
        competitors: (config.competitors || []).map(c => c.domain),
        owned: (config.owned || []).map(o => o.domain),
        extraction_model: config.crawl?.extractionModel || '(default)',
        hint: `Project ready. Next: run_crawl("${config.project}") to crawl, then run_citability_audit + tech_audit + list_problems. For a local extraction model, see suggest_models.`,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: scan_site (PAID — one-shot full audit, no config) ───────────────
// Mirrors `seo-intel scan <domain>`: crawl → extract → analyze → export. It is
// heavyweight (browser crawl + extraction + cloud analysis), so it runs as a
// detached subprocess like run_crawl and returns the report path to poll.
server.registerTool(
  'scan_site',
  {
    description: [
      'One-shot full SEO audit of any domain with no project setup — crawl → extract → analyze → export. Spawns a detached background job (like run_crawl) and returns immediately with the report path; poll get_crawl_status for progress.',
      '',
      'Heavyweight: full browser crawl, local extraction, and cloud analysis. For a fast, ephemeral, offline read of a single URL use crawl_site instead. Paid tier (Solo).',
    ].join('\n'),
    inputSchema: {
      domain: z.string().describe('Domain or URL to audit (e.g. "docs.carbium.sh").'),
      pages: z.number().int().positive().max(500).optional().describe('Max pages to crawl (default 100).'),
      stealth: z.boolean().optional().describe('Enable stealth browser mode for JS-heavy / anti-bot sites.'),
      no_ai: z.boolean().optional().describe('Skip the AI-enriched export (deterministic markdown only).'),
      model: z.enum(['gemini', 'claude', 'gpt']).optional().describe('Model for analysis + AI export (default gemini).'),
    },
  },
  async ({ domain, pages, stealth, no_ai, model }) => {
    if (!isPro()) return paidGate('scan_site');
    const progress = readProgress();
    if (progress?.status === 'running') {
      return { content: [{ type: 'text', text: `A seo-intel job is already running (command="${progress.command}", pid=${progress.pid}). Wait or call get_crawl_status.` }], isError: true };
    }
    const bare = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    const args = ['cli.js', 'scan', bare];
    if (pages) args.push('--pages', String(pages));
    if (stealth) args.push('--stealth');
    if (no_ai) args.push('--no-ai');
    if (model) args.push('--model', model);

    const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore' });
    child.unref();

    const reportPath = join(ROOT, 'reports', `scan-${bare.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.md`);
    const result = {
      started: true,
      pid: child.pid,
      domain: bare,
      command: `node ${args.join(' ')}`,
      report_path: reportPath,
      hint: 'Scan is running detached (crawl → extract → analyze → export). Poll get_crawl_status; when status="completed" read the markdown at report_path. The ephemeral project is "_scan-<domain>" — tech_audit/run_citability_audit can be run against it once the crawl lands.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
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

// ── Competitor analysis tools (PAID) ──────────────────────────────────────
//
// These wrap analyses that already existed behind the CLI paywall but had no
// MCP surface at all, so a Solo subscriber working in an agent could not reach
// what they were paying for. All six are read-only queries over the crawl DB:
// fast, synchronous, no job spawning. They require a crawl that included
// competitors — run_crawl first, and add competitors via setup_project.
const competitorTools = [
  {
    name: 'gap_intel',
    command: 'gap-intel',
    summary: 'Topic gap analysis against competitors: what they cover that you do not.',
    detail: 'Returns a prioritised gap report — topics, depth gaps and a coverage matrix, ranked by buyer intent. The single most useful starting point once a competitor crawl has landed.',
    schema: {
      project: z.string(),
      vs: z.array(z.string()).optional().describe('Competitor domains to compare against. Omit to use every competitor configured on the project.'),
      type: z.enum(['all', 'docs', 'blog', 'landing']).optional().describe('Restrict to one page type (default "all"). docs = /docs//guide//api/, blog = /blog//post/, landing = /pricing//features//product/.'),
      limit: z.number().int().positive().max(500).optional().describe('Max gaps to return (default 100).'),
    },
    map: ({ vs, type, limit }) => ({ vs, type, limit }),
  },
  {
    name: 'find_shallow_competitor_pages',
    command: 'shallow',
    summary: 'Competitor pages that rank on thin content — the cheapest pages to outrank.',
    detail: 'Finds indexable competitor pages that are shallow in word count yet sit close to the homepage in click depth. Low word count plus low click depth means the page ranks on authority rather than substance, so a thorough page on the same topic is unusually easy to beat.',
    schema: {
      project: z.string(),
      max_words: z.number().int().positive().optional().describe('Word-count ceiling for "thin" (default 700). Pages under 80 words are always excluded as boilerplate.'),
      max_depth: z.number().int().nonnegative().optional().describe('Click-depth ceiling (default 2).'),
    },
    map: ({ max_words, max_depth }) => ({ maxWords: max_words, maxDepth: max_depth }),
  },
  {
    name: 'find_decaying_competitor_pages',
    command: 'decay',
    summary: 'Competitor pages that have gone stale — outdated content you can displace.',
    detail: 'Splits into confirmedStale (a modified date older than the threshold) and unknownFreshness (no date at all, mid-length, so likely unmaintained). Stale top-level pages are displaceable with a genuinely current equivalent.',
    schema: {
      project: z.string(),
      months: z.number().int().positive().optional().describe('How many months without an update counts as stale (default 18).'),
    },
    map: ({ months }) => ({ months }),
  },
  {
    name: 'audit_competitor_headings',
    command: 'headings-audit',
    summary: 'Full H1-H6 outlines of competitor pages — their content structure, extracted.',
    detail: 'Returns the heading tree for up to 30 substantial competitor pages. Use it to see how a competitor structures a topic before writing your own version, and to spot subtopics they answer that you do not.',
    schema: {
      project: z.string(),
      depth: z.number().int().nonnegative().optional().describe('Click-depth ceiling (default 2).'),
      domain: z.string().optional().describe('Restrict to a single competitor domain.'),
    },
    map: ({ depth, domain }) => ({ depth, domain }),
  },
  {
    name: 'get_entity_coverage',
    command: 'entities',
    summary: 'Entity gap map: what competitors talk about that you never mention.',
    detail: 'Buckets every extracted entity into gaps (competitors cover it, you do not), shared, and unique to you. Requires extraction to have run. Entity gaps are the rawest form of topical-authority gap and map directly onto pages worth writing.',
    schema: {
      project: z.string(),
      min_mentions: z.number().int().positive().optional().describe('How many distinct competitor domains must mention an entity before it counts as a gap (default 2).'),
    },
    map: ({ min_mentions }) => ({ minMentions: min_mentions }),
  },
  {
    name: 'find_competitor_friction',
    command: 'friction',
    summary: 'Competitor pages that force a sales call where the visitor wanted an answer.',
    detail: 'Finds competitor pages whose search intent is informational or commercial but whose primary CTA is high-friction ("contact sales", "book a demo", "request access"). Each one is a visitor who wanted something self-serve and did not get it, which is a conversion opening for you.',
    schema: { project: z.string() },
    map: () => ({}),
  },
];

for (const t of competitorTools) {
  server.registerTool(
    t.name,
    {
      description: [
        t.summary,
        '',
        t.detail,
        '',
        'Reads the existing crawl — no network calls, returns immediately. Needs a crawl that included competitors (run_crawl, with competitors set via setup_project). Paid tier (Solo).',
      ].join('\n'),
      inputSchema: t.schema,
    },
    async (args) => {
      if (!isPro()) return paidGate(t.name);
      const { project } = args;
      if (!loadProjectConfig(project)) {
        return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
      }
      try {
        const opts = Object.fromEntries(Object.entries(t.map(args)).filter(([, v]) => v !== undefined));
        const result = await run(t.command, project, opts);
        if (!result.ok) {
          return { content: [{ type: 'text', text: `seo-intel error: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
          structuredContent: result.data,
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
      }
    }
  );
}

// ── Tool: prescore_draft (PAID) ───────────────────────────────────────────
server.registerTool(
  'prescore_draft',
  {
    description: 'Run the AEO scorer on a markdown draft before publishing. Returns the same 6-signal breakdown the dashboard uses (entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage) plus the overall 0-100 score and tier (excellent / good / fair / poor). Use this as a pre-publish gate when drafting via draft_blog_prompt — score < 60 means revise. Free tier. Pass `project` (and optionally `topic`) to close the loop: the draft is recorded in the Ledger and matching gaps are marked in_progress so they stop resurfacing.',
    inputSchema: {
      draft_md: z.string().describe('Full markdown of the draft, including YAML frontmatter if present. The scorer extracts headings, word count, schema_type from frontmatter, etc.'),
      project: z.string().optional().describe('If set, the scored draft is written back to this project\'s Intelligence Ledger (records a draft_created insight + marks matching gaps in_progress). Omit for a pure, stateless score.'),
      topic: z.string().optional().describe('The topic/keyword this draft targets. Used to match gaps for the in_progress write-back. If omitted, recovered from the draft\'s frontmatter title or first H1.'),
    },
  },
  async ({ draft_md, project, topic }) => {
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

      // F1 (v1.5.42): loop write-back — only when a project is supplied, and
      // best-effort so a Ledger hiccup never fails the score.
      if (project && loadProjectConfig(project)) {
        try {
          const db = getDb();
          const effectiveTopic = topic || extractDraftTopic(draft_md);
          recordDraftCreated(db, project, {
            topic: effectiveTopic,
            score: score.score,
            tier: score.tier,
            wordCount: score.wordCount,
          });
          const marked = markDraftedGapsInProgress(db, project, effectiveTopic);
          out.ledger = {
            recorded: true,
            topic: effectiveTopic || '(auto)',
            gaps_marked_in_progress: marked,
            note: marked > 0
              ? `${marked} matching gap(s) marked in_progress — they stop resurfacing until a re-audit re-scores the published page.`
              : 'Draft recorded; no active gaps matched the topic.',
          };
        } catch (e) {
          out.ledger = { recorded: false, error: e.message };
        }
      }

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
    description: 'Generate an AEO-aware blog draft prompt seeded with full project context — keyword gaps, citability gaps, top entities, brand voice notes, competitor heading patterns. The agent\'s own LLM writes the draft using this prompt. Pair with prescore_draft for a write→score→revise loop. Free tier.',
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

// ── Tool: run_content_loop (PAID — the one-call content loop) ─────────────
// Walks gap → draft → prescore → queue. In MCP the agent's own LLM is the
// writer, so this runs in HAND-BACK mode: it ranks the gaps, picks the highest-
// leverage one(s), and returns a seeded prompt per gap. The agent writes the
// draft, then calls prescore_draft(project, topic) to score + close the loop.
server.registerTool(
  'run_content_loop',
  {
    description: [
      'Run the content loop for a project in one call: ranks the open gaps in the Intelligence Ledger by leverage (priority × source × AI-intent), picks the highest, and returns an AEO-aware draft prompt seeded with full context.',
      '',
      'Hand-back by design — your own LLM writes the draft from the returned prompt, then you call prescore_draft(project, topic) to AEO-score it and close the loop (records the draft, marks the gap in_progress). Use dry_run to just see which gap it would target. Free tier.',
    ].join('\n'),
    inputSchema: {
      project: z.string(),
      topic: z.string().optional().describe('Focus a specific topic instead of auto-picking the top gap.'),
      count: z.number().int().positive().optional().describe('Return prompts for the top N gaps (default 1).'),
      lang: z.enum(['en', 'fi']).optional(),
      content_type: z.enum(['blog', 'article', 'guide', 'docs', 'social']).optional(),
      dry_run: z.boolean().optional().describe('Only rank + select the gap(s); do not build prompts.'),
    },
  },
  async ({ project, topic, count, lang = 'en', content_type = 'blog', dry_run }) => {
    if (!isPro()) return paidGate('run_content_loop');
    const config = loadProjectConfig(project);
    if (!config) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const result = await runContentLoop(db, project, {
        config, topic: topic || null, count: count || 1, lang, contentType: content_type,
        dryRun: !!dry_run, generate: null, // hand-back: the agent writes
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel run_content_loop error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: export_intel (firehose; free tables + paid tables) ──────────────
// v1.5.41: own-site derived data (extractions, schemas, citability, the
// ledger) is free — only the competitor gap analysis (`analyses`) is paid.
const FREE_EXPORT_TABLES = ['pages', 'keywords', 'headings', 'links', 'technical', 'sitemap_urls', 'extractions', 'page_schemas', 'citability_scores', 'insights'];
const PAID_EXPORT_TABLES = ['analyses'];
const ALL_EXPORT_TABLES = [...FREE_EXPORT_TABLES, ...PAID_EXPORT_TABLES];

const EXPORT_TABLE_QUERIES = {
  pages: `SELECT p.url, d.domain, d.role, p.status_code, p.word_count, p.load_ms, p.is_indexable, p.click_depth, p.published_date, p.modified_date, p.title, p.meta_desc, p.final_url, p.x_robots_tag
          FROM pages p JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY d.role, d.domain, p.click_depth`,
  keywords: `SELECT k.keyword, k.location, p.url, d.domain, d.role FROM keywords k JOIN pages p ON p.id = k.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY k.keyword`,
  headings: `SELECT h.level, h.text, p.url, d.domain FROM headings h JOIN pages p ON p.id = h.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY p.url, h.level`,
  links: `SELECT l.target_url, l.anchor_text, l.is_internal, p.url as source_url, d.domain FROM links l JOIN pages p ON p.id = l.source_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY l.is_internal DESC, d.domain`,
  technical: `SELECT t.has_canonical, t.has_og_tags, t.has_schema, t.is_mobile_ok, t.has_sitemap, t.has_robots, t.core_web_vitals, p.url, d.domain FROM technical t JOIN pages p ON p.id = t.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ?`,
  sitemap_urls: `SELECT s.url, s.sitemap_source, s.head_status, s.head_location, s.discovered_at, d.domain FROM sitemap_urls s JOIN domains d ON d.id = s.domain_id WHERE d.project = ?`,
  extractions: `SELECT e.title, e.meta_desc, e.h1, e.product_type, e.pricing_tier, e.cta_primary, e.tech_stack, e.schema_types, e.search_intent, e.primary_entities, e.intent_scores, p.url, d.domain FROM extractions e JOIN pages p ON p.id = e.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ?`,
  analyses: `SELECT generated_at, model, keyword_gaps, long_tails, quick_wins, new_pages, content_gaps, positioning, technical_gaps FROM analyses WHERE project = ? ORDER BY generated_at DESC`,
  page_schemas: `SELECT ps.schema_type, ps.name, ps.description, ps.rating, ps.rating_count, ps.price, ps.currency, ps.author, ps.date_published, p.url, d.domain FROM page_schemas ps JOIN pages p ON p.id = ps.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY ps.schema_type`,
  citability_scores: `SELECT cs.url, cs.score, cs.tier, cs.entity_authority, cs.structured_claims, cs.answer_density, cs.qa_proximity, cs.freshness, cs.schema_coverage, cs.ai_intents, cs.scored_at, p.title, d.domain, d.role FROM citability_scores cs JOIN pages p ON p.id = cs.page_id JOIN domains d ON d.id = p.domain_id WHERE d.project = ? ORDER BY cs.score`,
  insights: `SELECT id, type, status, fingerprint, first_seen, last_seen, source, data FROM insights WHERE project = ? ORDER BY last_seen DESC`,
};

const DEFAULT_MAX_ROWS_PER_TABLE = 1000;
const MAX_MAX_ROWS_PER_TABLE = 50000;

function buildExportNotice({ tokens, bytes, free, paidRequested, paidExcluded, anyTruncated, maxRowsPerTable }) {
  const tooBig = tokens > 50000;
  const upgradeBlurb = free
    ? `\n\n📦 Table NOT in this response (requires SEO Intel Solo, €19.99/mo — vs Ahrefs ~$129/mo): ${PAID_EXPORT_TABLES.join(', ')}.\n   That's the competitor gap-analysis history (keyword_gaps, content_gaps, positioning, quick_wins). Everything about YOUR OWN site — extractions, schemas, citability scores, and the Intelligence Ledger — is free.\n   Free pre-parsed digests: get_intel(for=audit|blog), run_citability_audit, prescore_draft, draft_blog_prompt. Solo adds competitor synthesis: get_competitor_positioning + get_intel(for=competitor).`
    : `\n\nYou have Solo. Paid tables in this export: ${(paidRequested || []).join(', ') || '(none requested)'}.`;

  const sizeLine = tooBig
    ? `\n\n⚠️  HEAVY EXPORT: ${tokens.toLocaleString()} estimated tokens (~${(bytes / 1024 / 1024).toFixed(1)} MB). This WILL blow up a typical agent's context budget.`
    : `\n\nSize: ${tokens.toLocaleString()} estimated tokens (~${(bytes / 1024).toFixed(0)} KB).`;

  const truncLine = anyTruncated
    ? `\n\n✂️  TRUNCATED: some tables hit the per-table row cap (currently ${maxRowsPerTable.toLocaleString()}). Check the per-table \`counts\` map — \`truncated: true\` means there are more rows. To pull more, re-call with \`max_rows_per_table: <N up to ${MAX_MAX_ROWS_PER_TABLE.toLocaleString()}>\` or \`tables: ["specific_one"]\`.`
    : '';

  return {
    level: tooBig || anyTruncated ? 'critical' : 'important',
    message: [
      '🛑 DO NOT INGEST THIS RESPONSE WHOLESALE INTO YOUR CONTEXT.',
      '',
      'This is a raw structured-data firehose — designed for tooling, not direct LLM consumption. Recommended ways to handle it:',
      '  1. Write it to a file via your shell tool (e.g. `... > intel.json`), then query selectively with jq / sqlite-utils / a small Python script.',
      '  2. For pre-digested intelligence, call get_intel(for=audit|blog|competitor) — same data, summarized.',
      '  3. For specific record lookups, use the targeted tools: get_pages, get_headings, list_keywords, get_competitor_positioning.',
    ].join('\n') + sizeLine + truncLine + upgradeBlurb,
    token_estimate: tokens,
    size_bytes: bytes,
    max_rows_per_table: maxRowsPerTable,
    truncated: anyTruncated,
    tables_paid_excluded: paidExcluded,
  };
}

server.registerTool(
  'export_intel',
  {
    description: [
      'Bulk export of raw structured intelligence — pages, keywords, headings, links, technical, sitemap URLs, extractions, schemas, citability scores, and the Intelligence Ledger (all free), plus the competitor gap-analysis history (Solo). Mirrors `seo-intel export --full <project>` as a single MCP call.',
      '',
      '⚠️ FIREHOSE WARNING: this is raw rows, not summaries. For carbium-sized projects it can be 5–10 MB / 200k+ tokens. The response includes a `notice` field telling the agent how to handle it (pipe to file, use other tools, or upgrade). Agents SHOULD NOT paste the response wholesale into their context — read the `notice` first, then either query selectively or save to a file.',
      '',
      'For pre-parsed AI-ready intel, prefer: get_intel(for=audit|blog|competitor), run_citability_audit, get_competitor_positioning, draft_blog_prompt.',
    ].join('\n'),
    inputSchema: {
      project: z.string(),
      tables: z.array(z.enum(ALL_EXPORT_TABLES)).optional().describe(`Tables to include. Free: ${FREE_EXPORT_TABLES.join(', ')}. Paid (Solo only): ${PAID_EXPORT_TABLES.join(', ')}. Omit to get the free subset.`),
      max_rows_per_table: z.number().int().positive().max(MAX_MAX_ROWS_PER_TABLE).optional().describe(`Cap on rows returned per table — safety valve against OOM on large projects (default ${DEFAULT_MAX_ROWS_PER_TABLE}, max ${MAX_MAX_ROWS_PER_TABLE}). When truncated, the per-table counts map shows total + returned so you know what's missing.`),
    },
  },
  async ({ project, tables, max_rows_per_table }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    const requested = tables && tables.length ? tables : FREE_EXPORT_TABLES;
    const paidRequested = requested.filter(t => PAID_EXPORT_TABLES.includes(t));
    if (paidRequested.length && !isPro()) {
      return paidGate(`export_intel (paid tables: ${paidRequested.join(', ')})`);
    }
    const maxRows = max_rows_per_table || DEFAULT_MAX_ROWS_PER_TABLE;
    try {
      const db = getDb();
      const domains = db.prepare('SELECT domain, role, last_crawled FROM domains WHERE project=? ORDER BY role, domain').all(project);
      const data = {};
      const counts = {};
      let anyTruncated = false;
      for (const table of requested) {
        try {
          // Two-step: count first, then fetch with LIMIT. Cheaper than .all() then .slice() for huge tables.
          const countRow = db.prepare(`SELECT COUNT(*) AS n FROM (${EXPORT_TABLE_QUERIES[table]}) AS sub`).get(project);
          const total = countRow?.n || 0;
          const rows = db.prepare(`${EXPORT_TABLE_QUERIES[table]} LIMIT ?`).all(project, maxRows);
          const truncated = total > rows.length;
          if (truncated) anyTruncated = true;
          data[table] = rows;
          counts[table] = { total, returned: rows.length, truncated };
        } catch (e) {
          data[table] = { error: e.message };
          counts[table] = { total: 0, returned: 0, truncated: false, error: e.message };
        }
      }
      const free = !isPro();
      const dataJson = JSON.stringify(data);
      const tokenEstimate = Math.ceil(dataJson.length / 4);
      const sizeBytes = Buffer.byteLength(dataJson, 'utf8');
      const notice = buildExportNotice({
        tokens: tokenEstimate,
        bytes: sizeBytes,
        free,
        paidRequested,
        paidExcluded: free ? PAID_EXPORT_TABLES : undefined,
        anyTruncated,
        maxRowsPerTable: maxRows,
      });
      const envelope = {
        project,
        exported_at: new Date().toISOString(),
        seo_intel_version: VERSION,
        tier: free ? 'free' : 'paid',
        tables_included: requested,
        counts,
        domains,
        notice,
        data,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `seo-intel error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: list_problems (the "what should I fix?" entry tool) ─────────────
// This is the canonical Problems surface. Returns severity-sorted, agent-
// fixable findings with affected_urls, fix_template, verification. Free
// categories: tech, indexability, links, schema. Paid adds: citability,
// content, keyword, positioning.
server.registerTool(
  'list_problems',
  {
    description: [
      "List concrete, fixable SEO problems for a project — severity-sorted, with everything an AI coding agent needs to remediate (affected_urls, fix_template, verification). This is the primary 'what should I work on?' tool: call list_projects first to see the nag/counts, then call list_problems here.",
      "",
      "Free tier categories: tech (HTTP errors), indexability (robots conflicts), links (orphan pages), schema (missing structured data).",
      "Index verdicts from inspect_urls are included under indexability when present: a FAIL, a NEUTRAL on a page the crawl says is indexable, or a canonical Google chose that differs from the page's own.",
      "Paid tier adds: citability (low AEO scores), content/keyword/positioning gaps from the Intelligence Ledger.",
      "",
      "Each problem returns {id, severity, category, tier, title, description, affected_urls, evidence, fix_template, verification, first_seen, last_seen, fix_difficulty, source}. fix_difficulty: 1=trivial → 5=deep work.",
      "Every problem carries source {kind, model, prompt_version, rule_version, confidence} — who found it (a deterministic rule over the crawl, an LLM synthesis, or an agent via ingest_insight) and how far to trust it before acting; search_review's safe_now holds only rule-sourced findings.",
      "",
      "Typical agent loop: list_projects → list_problems(project, severity='critical') → fix highest-leverage one → run_crawl(project) → list_problems again to verify it cleared.",
    ].join("\n"),
    inputSchema: {
      project: z.string(),
      severity: z.enum(['critical', 'warn', 'info']).optional().describe('Filter to one severity'),
      category: z.enum(PROBLEM_CATEGORIES).optional().describe('Filter to one category'),
      limit: z.number().int().positive().max(500).optional().describe('Max problems to return (default 50)'),
      max_fix_difficulty: z.number().int().min(1).max(5).optional().describe('Cap on fix_difficulty — useful for picking quick wins (set to 2 for "easy" only)'),
      include_marked: z.boolean().optional().describe('Include problems already marked fixed/wont_fix/snoozed (default false — they are hidden). Useful for auditing what has been suppressed.'),
    },
  },
  async ({ project, severity, category, limit = 50, max_fix_difficulty, include_marked }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const includePaid = isPro();
      const problems = getProblems(db, project, {
        severity, category, limit,
        maxFixDifficulty: max_fix_difficulty,
        includePaid,
        includeMarked: !!include_marked,
      });
      const counts = getProblemCounts(db, project, { includePaid });
      const out = {
        project,
        tier: includePaid ? 'paid' : 'free',
        counts,
        returned: problems.length,
        filters: { severity: severity || 'any', category: category || 'any', max_fix_difficulty: max_fix_difficulty || null },
        upsell: includePaid ? null : 'Solo unlocks citability, content_gap, keyword_gap, positioning categories. Currently showing free-tier categories only (tech, indexability, links, schema). Upgrade at https://ukkometa.fi/en/seo-intel/',
        problems,
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

// ── Tool: mark_problem_status (free — closes the loop) ────────────────────
server.registerTool(
  'mark_problem_status',
  {
    description: [
      "Mark a problem (from list_problems) as fixed, wont_fix, or snoozed. Subsequent list_problems calls will hide it unless the underlying source data re-surfaces it. Free tier — agents need this to confirm 'I fixed it' on subjective problems (positioning, content_gap) whose source data won't auto-clear on re-crawl.",
      "",
      "Statuses:",
      "  fixed     — done. Hide permanently. (If the same problem_id resurfaces from a future crawl, the mark is ignored and it shows again — i.e. the mark is per-instance not per-fingerprint.)",
      "  wont_fix  — accepted/ignored. Hide permanently.",
      "  snoozed   — hide for N days (require `snooze_days`). After that the problem re-appears in list_problems.",
      "",
      "Re-marking the same problem_id with a different status updates the existing record. To un-hide, re-mark with status='fixed' and snooze_days=0, then re-mark with 'snoozed' / snooze_days=0 — actually simpler: call list_problems(include_marked=true) to see hidden ones and mark them again.",
    ].join("\n"),
    inputSchema: {
      problem_id: z.string().describe('The `id` field from a list_problems result, e.g. "links::orphan::abc1234567"'),
      project: z.string().describe('Must match the project the problem belongs to'),
      status: z.enum(PROBLEM_STATUSES).describe('fixed | wont_fix | snoozed'),
      snooze_days: z.number().int().positive().max(365).optional().describe('Required when status=snoozed. Max 365.'),
      agent_name: z.string().optional().describe('Provenance — stored as marked_by'),
      note: z.string().optional().describe('Optional context, e.g. "added internal link from homepage"'),
    },
  },
  async ({ problem_id, project, status, snooze_days, agent_name, note }) => {
    if (!loadProjectConfig(project)) {
      return { content: [{ type: 'text', text: `Project "${project}" not found. Use list_projects to discover.` }], isError: true };
    }
    try {
      const db = getDb();
      const result = markProblemStatus(db, {
        problemId: problem_id,
        project,
        status,
        markedBy: agent_name ? `agent:${agent_name}` : 'agent',
        note,
        snoozeDays: snooze_days,
      });
      if (!result.ok) {
        return { content: [{ type: 'text', text: `seo-intel mark error: ${result.error}` }], isError: true };
      }
      const payload = {
        ok: true,
        problem_id,
        project,
        status,
        marked_at: new Date(result.marked_at).toISOString(),
        expires_at: result.expires_at ? new Date(result.expires_at).toISOString() : null,
        hint: status === 'fixed'
          ? 'Marked fixed. Hidden from list_problems. Re-call list_problems to confirm.'
          : status === 'wont_fix'
          ? 'Marked wont_fix. Permanently hidden. To un-hide: call this tool again with a different status.'
          : `Snoozed until ${new Date(result.expires_at).toISOString()}. Will re-appear in list_problems after that.`,
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

// Derived so they cannot drift from the registrations above.
// server._registeredTools is a private SDK field. If a future SDK version drops
// it we want a loud failure at boot, not a banner and an upgrade message that
// quietly report "0 tools".
const TOOL_COUNT = Object.keys(server._registeredTools ?? {}).length;
if (!TOOL_COUNT) {
  console.error('[seo-intel-mcp] fatal: could not count registered tools — the MCP SDK no longer exposes _registeredTools. Update the TOOL_COUNT derivation in mcp/server.js.');
  process.exit(1);
}
const PAID_TOOL_NAMES = [
  'scan_site', 'get_competitor_positioning', 'prescore_draft', 'draft_blog_prompt',
  'run_content_loop', 'demand_trends', ...competitorTools.map(t => t.name),
];

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine; the host typically surfaces this in its MCP logs panel.
  // Counts are derived, not hand-written: this banner drifted from reality once
  // already, and it is the first thing a host shows in its MCP logs panel.
  // The free list is derived too — the hand-written one stopped at v1.5.x and
  // silently omitted every free tool added since (page_contract, the backlink
  // tools, search_review).
  const freeTools = Object.keys(server._registeredTools ?? {}).filter(n => !PAID_TOOL_NAMES.includes(n));
  const wrap = (names, indent, width = 90) => {
    const lines = []; let line = '';
    for (const n of names) {
      const piece = line ? `, ${n}` : n;
      if (line && (line + piece).length > width) { lines.push(line + ','); line = n; } else line += piece;
    }
    if (line) lines.push(line);
    return lines.join(`\n${indent}`);
  };
  console.error(
    `[seo-intel-mcp] v${VERSION} ready on stdio. ${TOOL_COUNT} tools, ${freeTools.length} free.\n` +
    `  Free: ${wrap(freeTools, '        ')}\n` +
    `        (get_intel: raw/audit/blog/graph slices; export_intel: own-site tables)\n` +
    `  Solo: ${PAID_TOOL_NAMES.join(', ')}, get_intel(competitor), export_intel (analyses table)`
  );
}

main().catch(err => {
  console.error('[seo-intel-mcp] fatal:', err);
  process.exit(1);
});
