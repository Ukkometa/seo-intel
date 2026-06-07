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

import { getDb, insertAgentInsight, AGENT_INSIGHT_TYPES, getActiveInsights, getCompetitorSummary, recordDraftCreated, markGapsInProgress } from '../db/db.js';
import { getIntel, INTEL_SLICES, FREE_SLICES } from '../lib/intel.js';
import { isPro } from '../lib/license.js';
import { readProgress } from '../lib/progress.js';
import { getProblems, getProblemCounts, markProblemStatus, getActiveStatusMap, PROBLEM_CATEGORIES, PROBLEM_STATUSES } from '../lib/problems.js';

import { runAeoAnalysis, persistAeoScores, upsertCitabilityInsights } from '../analyses/aeo/index.js';
import { fetchAiAccessForDomains } from '../analyses/aeo/ai-access.js';
import { runTechnicalAudit } from '../analysis/technical-audit.js';
import { prescore, extractDraftTopic } from '../analyses/blog-draft/prescorer.js';
import { lightCrawl } from '../crawler/light.js';
import { runContentLoop } from '../analyses/loop/orchestrator.js';
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
      persistAeoScores(db, results);
      upsertCitabilityInsights(db, project, results.target, results.summary.aiAccess);
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

// ── Tool: prescore_draft (FREE) ───────────────────────────────────────────
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
          const marked = markGapsInProgress(db, project, effectiveTopic);
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

// ── Tool: draft_blog_prompt (FREE) ────────────────────────────────────────
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

// ── Tool: run_content_loop (free — the one-call content loop) ─────────────
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
      "Paid tier adds: citability (low AEO scores), content/keyword/positioning gaps from the Intelligence Ledger.",
      "",
      "Each problem returns {id, severity, category, tier, title, description, affected_urls, evidence, fix_template, verification, first_seen, last_seen, fix_difficulty}. fix_difficulty: 1=trivial → 5=deep work.",
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine; the host typically surfaces this in its MCP logs panel.
  console.error(`[seo-intel-mcp] v${VERSION} ready on stdio. 19 tools — free: crawl_site (ad-hoc, any URL, no config), run_content_loop (gap→draft→close), list_projects, list_problems, mark_problem_status, get_intel(raw/audit/blog), get_pages, list_keywords, get_headings, run_crawl, get_crawl_status, ingest_insight, run_citability_audit (now with AI-crawler access), tech_audit, prescore_draft, draft_blog_prompt, export_intel (own-site tables); Solo: scan_site (one-shot full audit), get_competitor_positioning, get_intel(competitor), export_intel (analyses table).`);
}

main().catch(err => {
  console.error('[seo-intel-mcp] fatal:', err);
  process.exit(1);
});
