---
name: seo-intel
description: >
  Local SEO competitive intelligence tool. Use when the user asks about SEO analysis, competitor research,
  keyword gaps, content strategy, site audits, or wants to crawl/analyze websites. Covers: setup, crawling,
  extraction, analysis, dashboards, agentic exports, suggestive SEO, and competitive action planning.
  Also use when asked to generate implementation briefs from SEO data, compare sites, or suggest
  what pages/docs/features to build based on competitor intelligence.
---

# SEO Intel

Local-first SEO competitive intelligence. Crawl → Extract → Analyze → Act.

## Install

```bash
npm i -g seo-intel
seo-intel setup
```

OpenClaw users: setup auto-detects OpenClaw and routes AI through connected models.

## Pipeline

| Stage | Command | Gate | Engine |
|---|---|---|---|
| Crawl | `seo-intel crawl <project>` | Free | Playwright |
| Extract | `seo-intel extract <project>` | Solo | Ollama (local) |
| Analyze | `seo-intel analyze <project>` | Solo | Cloud AI or local |
| Dashboard | `seo-intel serve` | Free (limited) / Solo (full) | HTML |
| Export | `seo-intel export-actions <project>` | Free (technical) / Solo (full) | SQL + heuristics |

## Core Commands

```bash
seo-intel setup                    # First-time wizard
seo-intel crawl <project>          # Crawl target + competitors
seo-intel extract <project>        # AI extraction (needs Ollama)
seo-intel analyze <project>        # Gap analysis
seo-intel html <project>           # Generate dashboard
seo-intel serve                    # Web dashboard at localhost:3000
seo-intel status                   # Crawl freshness + data summary
seo-intel guide                    # Interactive chapter-based guide
seo-intel export <project>         # Raw data export (JSON/CSV)
```

## Agentic Exports (The Power Feature)

Three export scopes that turn crawl data into actionable intelligence:

### Technical SEO
```bash
seo-intel export-actions <project> --scope technical
seo-intel export-actions <project> --scope technical --format json
```
Works on FREE tier. Finds: missing schemas, broken links, orphan pages, thin content, deep pages, missing H1/meta, canonical issues.

### Competitive SEO
```bash
seo-intel export-actions <project> --scope competitive
seo-intel export-actions <project> --scope competitive --vs helius.dev
seo-intel competitive-actions <project>  # shortcut
```
Solo tier. Finds: content gaps, keyword gaps, schema coverage delta, topic authority gaps, missing trust pages.

### Suggestive SEO
```bash
seo-intel suggest-usecases <project>
seo-intel suggest-usecases <project> --scope docs
seo-intel suggest-usecases <project> --scope product-pages
seo-intel suggest-usecases <project> --scope onboarding
```
Solo tier. Infers what pages/features SHOULD exist based on competitor patterns. Scopes: docs, product-pages, dashboards, onboarding, all.

### Output Formats
- `--format brief` (default) → human/agent-readable markdown
- `--format json` → structured JSON for automation pipelines

## Suggestive SEO Pattern (Agent Workflow)

This is the key differentiated workflow. When the user wants to improve their site based on competitor intelligence:

### Step 1 — Ensure fresh data
```bash
seo-intel crawl <project>     # if stale (check with `seo-intel status`)
seo-intel extract <project>   # if extractions outdated
seo-intel analyze <project>   # regenerate analysis
```

### Step 2 — Generate action exports
```bash
seo-intel export-actions <project> --format json --output /tmp/actions.json
```
Read the output. It contains prioritized actions with evidence and implementation hints.

### Step 3 — Cross-reference with workspace
Before implementing, check what already exists:
- Read the user's project docs/pages to avoid duplicating existing content
- Check MEMORY.md for recently completed work
- Filter actions to only what's genuinely missing

### Step 4 — Generate implementation briefs
For each high-priority action, create a focused brief:
- What to build (page title, slug, structure)
- Why it matters (competitor evidence, SEO value)
- Content outline (headings, key points to cover)
- Where it goes (file path, navigation placement)

### Step 5 — Execute or delegate
Either implement directly or spawn a coding agent with the brief.

### Step 6 — Re-crawl and measure
After implementation, re-crawl to measure the delta. The loop: crawl → analyze → export → implement → re-crawl.

## Direct DB Access (Advanced)

The SQLite database at `<project-dir>/seo-intel.db` can be queried directly for custom analysis.
See [references/db-schema.md](references/db-schema.md) for table definitions.

Useful queries:
```sql
-- Pages competitor has that target doesn't (by heading topics)
SELECT DISTINCT h.text FROM headings h
JOIN pages p ON p.id = h.page_id
JOIN domains d ON d.id = p.domain_id
WHERE d.role = 'competitor' AND h.level <= 2
AND h.text NOT IN (
  SELECT h2.text FROM headings h2
  JOIN pages p2 ON p2.id = h2.page_id
  JOIN domains d2 ON d2.id = p2.domain_id
  WHERE d2.role = 'target' AND h2.level <= 2
);

-- Schema types competitors use but target doesn't
SELECT DISTINCT ps.schema_type FROM page_schemas ps
JOIN pages p ON p.id = ps.page_id
JOIN domains d ON d.id = p.domain_id
WHERE d.role = 'competitor' AND d.project = ?
AND ps.schema_type NOT IN (
  SELECT ps2.schema_type FROM page_schemas ps2
  JOIN pages p2 ON p2.id = ps2.page_id
  JOIN domains d2 ON d2.id = p2.domain_id
  WHERE d2.role = 'target' AND d2.project = ?
);
```

## Cron Scheduling

For ongoing monitoring, set up daily crawls and weekly analysis:

```bash
# Daily crawl at 14:00
seo-intel crawl <project>

# Weekly analysis + brief on Sundays
seo-intel analyze <project>
seo-intel export-actions <project> --format brief
```

Use OpenClaw cron for scheduling. The weekly brief makes an excellent proactive notification.

## Tier Summary

| Feature | Free | Solo |
|---|---|---|
| Crawl (unlimited) | ✅ | ✅ |
| Raw data export | ✅ | ✅ |
| Technical SEO export | ✅ | ✅ |
| Crawl-only dashboard | ✅ | ✅ |
| AI extraction | ❌ | ✅ |
| AI analysis | ❌ | ✅ |
| Full dashboard | ❌ | ✅ |
| Competitive exports | ❌ | ✅ |
| Suggestive SEO | ❌ | ✅ |

Solo: €19.99/mo or €199/yr at ukkometa.fi/seo-intel, or $9.99/mo at froggo.pro.
