---
name: seo-intel
description: >
  Local SEO competitive intelligence tool. Use when the user asks about SEO analysis, competitor research,
  keyword gaps, content strategy, site audits, AI citability, or wants to crawl/analyze websites. Covers: setup,
  crawling, extraction, analysis, AEO (AI citability scoring), keyword invention, content briefs, dashboards,
  agentic exports, suggestive SEO, and competitive action planning.
  Also use when asked to generate implementation briefs from SEO data, compare sites, audit AI citability,
  or suggest what pages/docs/features to build based on competitor intelligence.
---

# SEO Intel (v1.2)

Local SEO competitive intelligence — crawl your site + competitors, extract structure and semantic signals, then use OpenClaw to reason over the data and drive real implementation.

**OpenClaw is the recommended primary experience.** Standalone local Qwen handles extraction fine. But analysis, gap synthesis, and "what should I build next" reasoning needs a real model — Opus, Sonnet, GPT — and OpenClaw routes that automatically. No API keys to manage, no model config, just results.

## Install

```bash
npm install -g seo-intel
seo-intel setup      # detects OpenClaw automatically, configures everything
```

## Pipeline

```
Crawl → Extract (Ollama local) → Analyze (OpenClaw cloud model) → AEO → Export Actions → Implement
```

| Stage | Command | Gate | Best engine |
|---|---|---|---|
| Crawl | `seo-intel crawl <project>` | Free | Playwright |
| Extract | `seo-intel extract <project>` | Solo | Ollama/Qwen local |
| Analyze | `seo-intel analyze <project>` | Solo | OpenClaw (Opus/Sonnet) |
| AEO | `seo-intel aeo <project>` | Solo | Pure local (no AI needed) |
| Keywords | `seo-intel keywords <project>` | Solo | OpenClaw (Opus/Sonnet) |
| Actions | `seo-intel export-actions <project>` | Free (technical) / Solo (full) | SQL heuristics |
| Dashboard | `seo-intel serve` | Free (limited) / Solo (full) | HTML |

## Core Commands

```bash
seo-intel setup                    # First-time wizard — detects OpenClaw
seo-intel crawl <project>          # Crawl target + competitors
seo-intel extract <project>        # Local AI extraction (Ollama)
seo-intel analyze <project>        # Strategic gap analysis → Intelligence Ledger
seo-intel aeo <project>            # AI Citability Audit — score pages for AI citation
seo-intel keywords <project>       # Keyword Inventor — traditional + AI/agent queries
seo-intel brief <project>          # Generate content briefs for new pages
seo-intel html <project>           # Generate dashboard
seo-intel serve                    # Web dashboard at localhost:3000
seo-intel status                   # Data freshness + summary
seo-intel run                      # Full pipeline: crawl → extract → analyze → dashboard
seo-intel guide                    # Interactive chapter-based walkthrough
seo-intel export <project>         # Raw data export (JSON/CSV)
```

## Analysis & Audit Commands

```bash
seo-intel aeo <project>            # AI Citability Audit (0-100 per page, 6 signals)
seo-intel keywords <project>       # Keyword Inventor (traditional + Perplexity + agent queries)
seo-intel brief <project>          # Content brief generation for gap pages
seo-intel templates <project>      # URL pattern analysis and content type mapping
seo-intel entities <project>       # Entity extraction and topic mapping (Ollama)
seo-intel schemas <project>        # Schema.org markup audit
seo-intel headings-audit <project> # H1-H6 structure analysis
seo-intel orphans <project>        # Find orphan pages (no internal links)
seo-intel decay <project>          # Content freshness and decay detection
seo-intel friction <project>       # UX friction and conversion blocker detection (Ollama)
seo-intel velocity <project>       # Content publishing velocity tracking
seo-intel js-delta <project>       # JavaScript dependency change detection
seo-intel shallow <project>        # Quick technical audit (no full crawl needed)
seo-intel competitors <project>    # Manage competitor list
seo-intel subdomains <domain>      # Subdomain discovery
```

## AEO — AI Citability Audit (v1.2.0)

Score every page for how well AI assistants (ChatGPT, Perplexity, Claude) can cite it. This is not traditional SEO — it's Answer Engine Optimization.

```bash
seo-intel aeo <project>                # Full citability audit
seo-intel aeo <project> --target-only  # Skip competitor scoring
seo-intel aeo <project> --save         # Export .md report
```

**6 citability signals** scored per page:
- **Entity authority** — Is this page the canonical source for its entities?
- **Structured claims** — "X is Y because Z" patterns that AI can quote directly
- **Answer density** — Ratio of direct answers to filler content
- **Q&A proximity** — Question heading → answer paragraph pattern
- **Freshness** — dateModified, schema, "Updated March 2026" signals
- **Schema coverage** — JSON-LD structured data present

**AI Query Intent classification:** synthesis, decision support, implementation, exploration, validation

Low-scoring pages automatically feed into the Intelligence Ledger as `citability_gap` insights.

## Intelligence Ledger

Insights from `analyze`, `keywords`, and `aeo` **accumulate across runs** — they're never overwritten. The ledger uses fingerprint-based dedup: same insight found again = updated timestamp, not duplicated.

- Mark insights as **done** (fix applied) or **dismissed** (not relevant)
- Dashboard shows all active insights with done/dismiss buttons
- `POST /api/insights/:id/status` to toggle status programmatically

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
Infers what pages, docs, or features should exist based on competitor patterns. Uses the local intelligence DB to reason about what's missing, not just what's broken.

### Combined
```bash
seo-intel export-actions <project> --scope all --format json
seo-intel export-actions <project> --scope all --format brief
```

## OpenClaw Workflow (Recommended)

When running inside OpenClaw, the full intelligence loop becomes conversational:

### "How citable is my site for AI assistants?"
1. Run `seo-intel aeo <project>`
2. Review citability scores — pages scoring <35 need restructuring
3. Check weakest signals (schema coverage, Q&A proximity, structured claims)
4. Generate briefs for low-scoring pages: `seo-intel brief <project>`
5. Implement restructuring → re-crawl → re-score to measure lift

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

### "What keywords should I target — including AI search?"
1. Run `seo-intel keywords <project> --save`
2. Review: traditional keywords, Perplexity-style questions, agent queries
3. Cross with AEO scores to find high-value + low-citability gaps
4. Generate briefs: `seo-intel brief <project>`

## Direct DB Queries (Advanced)

The SQLite DB at `./seo-intel.db` (in your working directory) can be queried directly for custom reasoning.

Key tables: `pages`, `domains`, `headings`, `links`, `extractions`, `analyses`, `insights`, `citability_scores`

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

```sql
-- Pages with low AI citability that have high keyword potential
SELECT cs.url, cs.total_score, cs.weakest_signal, i.data
FROM citability_scores cs
JOIN insights i ON i.project = cs.project AND i.type = 'long_tail' AND i.status = 'active'
WHERE cs.project = 'myproject' AND cs.total_score < 35
ORDER BY cs.total_score ASC;
```

## Cron Scheduling

```bash
# Daily crawl (14:00 recommended)
seo-intel crawl <project>

# Weekly analysis + AEO + brief (Sunday)
seo-intel analyze <project> && seo-intel aeo <project> && seo-intel export-actions <project> --format brief
```

Wire via OpenClaw cron for proactive weekly briefings delivered to your chat.

## Pricing

| Tier | Price | Features |
|---|---|---|
| Free | €0 | Unlimited crawl, technical exports, crawl-only dashboard |
| Solo | €19.99/mo or €199.99/yr | Full AI pipeline, AEO, all exports, full dashboard |

Solo via [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/).
