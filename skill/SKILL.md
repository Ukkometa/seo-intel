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

Local SEO competitive intelligence — crawl your site + competitors, extract structure and semantic signals, then use OpenClaw to reason over the data and drive real implementation.

**OpenClaw is the recommended primary experience.** Standalone local Qwen handles extraction fine. But analysis, gap synthesis, and "what should I build next" reasoning needs a real model — Opus, Sonnet, GPT — and OpenClaw routes that automatically. No API keys to manage, no model config, just results.

## Install

```bash
npm i -g seo-intel
seo-intel setup      # detects OpenClaw automatically, configures everything
```

## Pipeline

```
Crawl → Extract (Ollama local) → Analyze (OpenClaw cloud model) → Export Actions → Implement
```

| Stage | Command | Gate | Best engine |
|---|---|---|---|
| Crawl | `seo-intel crawl <project>` | Free | Playwright |
| Extract | `seo-intel extract <project>` | Solo | Ollama/Qwen local |
| Analyze | `seo-intel analyze <project>` | Solo | OpenClaw (Opus/Sonnet) |
| Actions | `seo-intel export-actions <project>` | Free (technical) / Solo (full) | SQL heuristics |
| Dashboard | `seo-intel serve` | Free (limited) / Solo (full) | HTML |

## Core Commands

```bash
seo-intel setup                    # First-time wizard — detects OpenClaw
seo-intel crawl <project>          # Crawl target + competitors
seo-intel extract <project>        # Local AI extraction (Ollama)
seo-intel analyze <project>        # Strategic gap analysis
seo-intel html <project>           # Generate dashboard
seo-intel serve                    # Web dashboard at localhost:3000
seo-intel status                   # Data freshness + summary
seo-intel guide                    # Interactive chapter-based walkthrough
seo-intel export <project>         # Raw data export (JSON/CSV)
```

## Agentic Export Commands

These turn crawl data into prioritized implementation briefs. The right inputs for coding agents, docs writers, or any downstream workflow.

### Technical Audit (Free tier)
```bash
seo-intel export-actions <project> --scope technical
seo-intel export-actions <project> --scope technical --format json
```
Finds: missing schemas, broken links, orphan pages, thin content, deep pages, missing H1/meta, canonical issues. Works without AI — pure crawl data.

### Competitive Gaps (Solo)
```bash
seo-intel competitive-actions <project>
seo-intel competitive-actions <project> --vs helius.dev
seo-intel competitive-actions <project> --format json
```
Finds: content gaps, keyword gaps, schema coverage delta, topic authority gaps, missing trust/comparison pages. Needs extraction + analysis to have run first.

### Suggest What to Build (Solo)
```bash
seo-intel suggest-usecases <project>
seo-intel suggest-usecases <project> --scope docs
seo-intel suggest-usecases <project> --scope product-pages
seo-intel suggest-usecases <project> --scope onboarding
```
Infers what pages, docs, or features should exist based on competitor patterns. The differentiating feature — uses the local intelligence DB to reason about what's missing, not just what's broken.

### Combined
```bash
seo-intel export-actions <project> --scope all --format json
seo-intel export-actions <project> --scope all --format brief
```

## OpenClaw Workflow (Recommended)

When running inside OpenClaw, the full intelligence loop becomes conversational:

### "What should I build next?"
1. Run `seo-intel suggest-usecases <project> --format json`
2. Read the output — it contains prioritized suggestions with competitor evidence
3. Cross-reference against workspace context (what's already built)
4. Generate implementation briefs for the top actions
5. Spawn a coding/docs agent to execute
6. Re-crawl after shipping to measure delta

### "Where are my biggest competitive gaps?"
1. Run `seo-intel competitive-actions <project> --format json`
2. Analyze: which gaps are highest priority, which competitors are strongest in each area
3. Map gaps to existing projects/docs/roadmap
4. Produce a prioritized action plan

### "What's technically broken on my site?"
1. Run `seo-intel export-actions <project> --scope technical --format json`
2. Triage by priority: critical → high → medium
3. Assign quick wins (missing H1, meta) vs structural work (canonical chains, orphans)

## Direct DB Queries (Advanced)

The SQLite DB at `~/Desktop/Spiderbrain/seo-intel/seo-intel.db` can be queried directly for custom reasoning. See [references/db-schema.md](references/db-schema.md).

Key pattern — what competitors have that target doesn't:
```sql
-- Topic clusters in competitor pages missing from target
SELECT DISTINCT h.text FROM headings h
JOIN pages p ON p.id = h.page_id
JOIN domains d ON d.id = p.domain_id
WHERE d.role = 'competitor' AND d.project = 'myproject' AND h.level <= 2
AND h.text NOT IN (
  SELECT h2.text FROM headings h2
  JOIN pages p2 ON p2.id = h2.page_id
  JOIN domains d2 ON d2.id = p2.domain_id
  WHERE d2.role = 'target' AND d2.project = 'myproject' AND h2.level <= 2
);
```

## Cron Scheduling

```bash
# Daily crawl (14:00 recommended)
seo-intel crawl <project>

# Weekly analysis + brief (Sunday)
seo-intel analyze <project> && seo-intel export-actions <project> --format brief
```

Wire via OpenClaw cron for proactive weekly briefings delivered to your chat.

## Pricing

| Tier | Price | Features |
|---|---|---|
| Free | €0 | Unlimited crawl, technical exports, crawl-only dashboard |
| Solo | €19.99/mo or €199/yr | Full AI pipeline, all exports, full dashboard |

Solo via [ukkometa.fi/seo-intel](https://ukkometa.fi/seo-intel) or [froggo.pro](https://froggo.pro) ($9.99/mo).
