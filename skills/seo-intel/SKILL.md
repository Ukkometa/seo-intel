---
name: seo-intel
description: >
  Local SEO data layer for AI agents. Use when the user asks about SEO analysis, competitor research,
  keyword gaps, content strategy, site audits, AI citability (AEO), backlinks, Search Console data,
  or wants to crawl, audit, or fix websites. Ships an MCP server (seo-intel-mcp) so Claude Code,
  Cursor, Cline, Hermes, or any MCP host can query a local SQLite intelligence store as native tools.
  Start with search_review (what needs a decision, what an agent may fix now, what already works),
  then list_problems, page_contract, run_citability_audit, rescore_page, tech_audit, backlink_audit,
  and get_intel. Free covers your own site end to end; Solo adds competitor synthesis, scheduled
  crawls, history, and content production. Also covers the CLI (crawl, extract, analyze, aeo, review, keywords, watch,
  blog-draft, export) and the Intelligence Ledger.
---

# SEO Intel (v1.7.1)

The local **SEO data layer for AI agents**. Crawl your site + competitors, store structured intelligence in local SQLite, then expose it to any AI agent via Model Context Protocol or call CLI commands directly. No API keys held in seo-intel, no remote servers, all data stays on the user's machine.

**Two consumer paths, same underlying library:**
- **AI agents via MCP** — install `seo-intel-mcp` into Claude Code / Cursor / Cline / any MCP host. The agent's own flagship LLM (Opus / GPT / Gemini) does synthesis using seo-intel as the deterministic data source.
- **Humans via CLI + dashboard** — `seo-intel <command>` for power users, `seo-intel serve` for the web dashboard.

**Free vs Solo** (the line: *free thinks; paid remembers and watches*):
- **Free** = everything that reads or audits **your own** site — crawl, AI citability (AEO) scoring, keyword intelligence, template/orphan detection, JS-render delta, Search Console insights, the full dashboard, and the daily problem-notification cron. A capable agent commoditizes one-shot analysis anyway, so own-site analysis is free.
- **Solo (€19.99/mo, ~14× cheaper than Ahrefs)** = what an agent structurally can't do for itself — **competitor synthesis** (gap analysis, positioning, keyword battleground, competitor export/digest), **automation** (scheduled crawls), **history & trends** (crawl change brief, publishing velocity, Search Console traffic trends) — plus **content production** (`blog-draft`, `loop`, `draft_blog_prompt`, `run_content_loop`, `prescore_draft`), the "do the work for me" step reached only after the free audit has shown its worth.

## Install

```bash
npm install -g seo-intel
seo-intel setup                                  # configure projects + extraction model

# Then add the MCP server to your AI agent:
claude mcp add seo-intel "npx seo-intel-mcp"      # Claude Code
# or follow your MCP host's "add server" flow with the same npx command
```

## MCP Server — Native AI Agent Integration (v1.5.26+, competitor tools v1.5.56+)

The MCP server exposes 39 tools as native AI agent calls. Agents discover tool descriptions automatically; no extra prompting required. 27 of the 39 are free: everything that reads or audits **your own** site. Solo covers the three things an agent cannot do for itself — competitor analysis, history and trends, and content production: `scan_site`, `get_competitor_positioning`, `gap_intel`, `find_shallow_competitor_pages`, `find_decaying_competitor_pages`, `audit_competitor_headings`, `get_entity_coverage`, `find_competitor_friction`, `demand_trends`, `run_content_loop`, `draft_blog_prompt` and `prescore_draft`, plus the `competitor` slice of `get_intel` and the `analyses` table of `export_intel`.

### Free tier MCP tools (own-site, no license required)
| Tool | Purpose |
|---|---|
| `setup_project(project_name, target_url, competitors?, industry?, audience?, goal?, …)` | **Create a project from chat** — writes the same config the setup wizard produces (target, competitors, owned domains, analysis context, crawl budget, extraction model). Overwrite-guarded. Zero → configured → audited without leaving the conversation |
| `crawl_site(url, max_pages?, include_citability?, same_origin?)` | **Ad-hoc crawl of any URL** — no project, no account, nothing saved. Fetch-based (no browser), robots-aware, returns title/meta/headings/links/schema/word-count + optional AEO score. The zero-signup entry point for any agent |
| `list_projects` | Discover configured projects + page counts |
| `get_intel(project, for='raw')` | Structured digest — domains, totals, last crawl |
| `get_intel(project, for='audit')` | Citability + active insights ledger |
| `get_intel(project, for='blog')` | Keyword gaps + long tails + drafting hints |
| `get_pages(project, role?, limit?, offset?)` | Paginated page list with title/word count/status |
| `list_keywords(project, domain?, limit?)` | Top extracted keywords by domain + location |
| `get_headings(project, url, limit?)` | Heading structure (H1–H6) for a specific page |
| `run_crawl(project, stealth?, max_pages?)` | Spawn a crawl as detached subprocess; returns pid |
| `get_crawl_status()` | Read most recent job's progress with PID liveness |
| `ingest_insight(project, type, data, agent_name?, confidence?, ttl_days?)` | Persist agent-generated insight to the ledger (deduped). The row carries `source.kind: agent`, `model` = your `agent_name`, and the `confidence` (0..1) you pass — omit it when unknown rather than guess; it is stored as given, never invented. It expires `ttl_days` (default 90) after `last_seen` unless re-ingested, and re-ingesting the same fingerprint reopens an expired row. An agent-sourced finding never enters `search_review.safe_now` |
| `search_review(project, urls?, limit?)` | **Start here** — every own-site finding triaged into `needs_input` (a person decides), `safe_now` (an agent may fix unattended), `opportunities` (bets to weigh) and `working` (passes, withheld on a stale crawl). Every item carries `source {kind: rule\|model\|agent, model, prompt_version, rule_version, confidence}`. `safe_now` holds only rule-sourced findings — a deterministic detector over the crawl found them, so an agent may act on them unattended. Model- and agent-sourced findings land in `needs_input` (with `Model-sourced finding (<model>): verify before acting.` in `decision_basis`) or `opportunities`, and must be verified before acting. Pass `urls` to fold `page_contract` decisions in |
| `list_problems(project, severity?, limit?)` | Ahrefs-style "what's broken" — prioritised issues with fix templates. Each problem carries `source {kind, model, prompt_version, rule_version, confidence}`: who found it (a rule over the crawl, an LLM synthesis, or an agent via `ingest_insight`) and how far to trust it before acting |
| `mark_problem_status(project, problem_id, status, agent_name?)` | Mark a problem done/dismissed |
| `run_citability_audit(project, include_competitors?, check_ai_access?)` | AEO scoring (7 signals incl. AI-crawler access); checks robots.txt for ClaudeBot/GPTBot/PerplexityBot/Google-Extended blocks; persists scores + upserts insights |
| `tech_audit(project, domain?, sitemap_head?, limit?)` | Technical SEO audit from crawled data — titles, meta, noindex/robots conflicts, redirects, canonicals, sitemap diff. Severity-sorted findings |
| `fetch_gsc(project, days?, months?, dry_run?, property?)` | **Search Console straight from the API** — stores page×query daily (last 90 days), page daily and query daily (16 months, the API's horizon) with real dates. Incremental, so repeat calls are cheap; `dry_run` shows the windows without spending quota. Needs `seo-intel auth google`. `page_contract` prefers this over CSV exports, and under it a page with no rows is measured absence (no reportable impressions in the window), not missing data |
| `inspect_urls(project, urls?, limit?, max_age_days?, dry_run?, property?)` | **Google's own index verdict, page by page** — URL Inspection API: `PASS` indexed · `PARTIAL` indexed with issues · `FAIL` an error prevents indexing · `NEUTRAL` excluded, plus the coverage state in Google's words and the canonical Google chose; stored locally. Demand-first (28-day impressions, then sitemap presence, then crawl indexability), 100 per call by default, URLs inspected in the last 7 days skipped (`max_age_days` 0 re-asks), 2,000 per property per day; a 429 stops cleanly with every verdict so far kept; `dry_run` lists the plan without spending quota. `NEUTRAL` is often intended (a noindex, a canonical elsewhere) — read it against the page. Feeds `list_problems` (indexability) and `search_review.working`. Needs `seo-intel auth google` |
| `demand_opportunities(project, window_days?, min_impressions?)` | **Quick wins and long tails from your own Search Console rows** — arithmetic over `fetch_gsc` data for the last 28 days: no request, no model, nothing estimated; every impression, click and position is what Google reported for this property. A quick win is a query already at positions 4-20 with 50+ impressions whose CTR is under 60% of the position baseline (`ctr_gap`: rewrite title + meta description) or that sits on page two (`page_two`: internal links + depth), or `both`; `potential_clicks` sizes it per window. A long tail is a 3+ word phrase with 20+ impressions at position 10.5 or worse and no page on page one; `best_page` names the page to strengthen, null means a page is missing. The CTR baseline is a heuristic curve, not a measurement, so read `potential_clicks` as "about". Filed as rule-sourced `gsc_quick_win` / `gsc_long_tail` with `complete: true`: `search_review.opportunities` lists them, and a win missing from a later complete run is resolved because the position moved or the CTR recovered. Needs `fetch_gsc` first; with no rows it says so |
| `import_gsc_queries(project)` | The CSV route — imports Search Console exports from `gsc/<project>*/` with the scope each export's own `Filters.csv` declares: a page-filtered export is page-level evidence, an unfiltered one is property-wide context only |
| `page_contract(project, url, brand_terms?)` | What ONE page needs, from measured demand — `expand` / `consolidate` / `reposition` / `protect` / `no_action_yet`, plus `blocked_recommendations` (binding: advice not to give yet, each with the input that unblocks it) and `allowed_now` (correctness work that never waits on demand data). Needs `fetch_gsc` or `import_gsc_queries` first |
| `import_backlinks(project)` | The Search Console links CSV from `links/<project>*.csv` into the `backlinks` table, origin `gsc`. Use the "Latest links" export: under the export cap it holds the same URLs as "More sample links" plus a Last crawled date. The export has the linking URL only, not the page of yours it links to and not the anchor text |
| `fetch_bing_links(project, site_url?, max_targets?, dry_run?)` | **Inbound links from Bing Webmaster Tools, fetched automatically.** Search Console's Links report has no API, so its links stay a hand export. Bing's API lists your pages that have inbound links, then the pages linking to the 50 most-linked (`max_targets`), with anchor text. Rows go into the same `backlinks` table with origin `bing`. A link the export also holds becomes `bing,gsc`: two independent crawlers saw it, so it is corroborated. A link only one source reports is not doubtful for that reason; it has been seen once. An existing row gets a target page and anchor only where it has none, and the columns `live:true` writes are never touched, so equity stays unknown until `backlink_audit(live:true)` checks the page. Each call may make up to 300 requests against a daily quota. A quota stop keeps what was stored (`stopped_reason: 'quota'`), `truncated` means a cap was hit, and `errors[]` lists the requests Bing did not answer. The site is `site_url`, else `bing.siteUrl` in the project config, else matched from `target.domain`; a miss lists the sites the account has. `dry_run` returns the plan without making any link request. The rows are a sample of Bing's own index: never call them a complete link profile, alone or merged with the export. Needs `BING_WEBMASTER_API_KEY`. The response shapes were written without access to Microsoft's docs; a shape error quotes the start of the body, and `seo-intel bing-links <project> --debug` writes the raw responses for checking |
| `backlink_audit(project, live?, limit?)` | What is wrong with the links you already have: brand **reclamation**, followed vs nofollow, domain concentration, and which of your pages receive no links. It is not a link index. Summaries depend on origin. `summary.by_origin` counts rows and domains from Search Console, from Bing, and from both. `sample_note` names the sources the audit rests on. `equity` separates `followed` / `nofollowed` from `unknown`, and a Bing-reported link is never counted as followed on Bing's word. `targets_note` says how many linking pages have a known target, which tells you how far to trust the "receives no links" list. `live:true` fetches the linking pages to read nofollow and prove a link is still there. A blocked or unrendered page is `unknown`, not lost. Needs `import_backlinks` or `fetch_bing_links` first |
| `qualify_link_prospect(project, domain)` | Scores a domain you found for outreach against the local link data. It reports whether the domain already links here (`reported_by` names the origins), whether those links use an outdated brand name (the ask is then an update), how much of your profile the domain already accounts for, and which of your pages most needs a link. `verdict`: `update_existing`, `already_linked_followed`, `already_linked_nofollow`, `already_linked_unverified` (nothing has read the rel yet, as with every Bing row before `live:true`), or `new_prospect` |
| `suggest_models(vram_gb?)` | Suggest **local** extraction models for the user's hardware (Gemma 4 E2B/E4B/12B, Qwen 3.5 4B/9B). Always returns a cloud disclaimer — extraction should be done locally |
| `export_intel(project, tables?, max_rows_per_table?)` | Bulk export of own-site tables (pages, keywords, headings, links, technical, schemas, extractions, citability scores, insights). Includes a `notice` field telling the agent NOT to ingest wholesale — pipe to file or use targeted tools instead |

### Solo (paid) MCP surface — competitor synthesis and content production
| Tool | Purpose |
|---|---|
| `scan_site(domain, pages?, stealth?, no_ai?, model?)` | One-shot full audit of any domain (crawl → extract → analyze → export) as a detached background job — mirrors `seo-intel scan` |
| `get_competitor_positioning(project)` | Strategic positioning narrative + competitor coverage |
| `get_intel(project, for='competitor')` | Competitor summary + keyword matrix |
| `export_intel(project, tables=['analyses'])` | Adds the competitor gap-analysis history table |
| `gap_intel(project, vs?, type?, limit?)` | Topic gap analysis — what competitors cover that you do not, ranked by buyer intent |
| `find_shallow_competitor_pages(project, max_words?, max_depth?)` | Competitor pages ranking on thin content — the cheapest pages to outrank |
| `find_decaying_competitor_pages(project, months?)` | Competitor pages gone stale, split into confirmed-stale and unknown-freshness |
| `audit_competitor_headings(project, depth?, domain?)` | Full H1-H6 outlines of competitor pages — their structure, extracted |
| `get_entity_coverage(project, min_mentions?)` | Entity gap map: what competitors mention that you never do |
| `find_competitor_friction(project)` | Competitor pages forcing a sales call where the visitor wanted an answer |
| `run_content_loop(project, topic?, count?, lang?, content_type?, dry_run?)` | **The content loop in one call** — ranks open Ledger gaps by leverage, picks the top one, returns a seeded AEO draft prompt. Your LLM writes it, then `prescore_draft(project, topic)` scores + closes the loop |
| `draft_blog_prompt(project, topic?, lang?, content_type?)` | AEO-aware prompt seeded with gap data — agent's LLM writes the draft |
| `prescore_draft(draft_md, project?, topic?)` | Pre-publish AEO scorer; pass `project` to record the draft and mark matching gaps `in_progress` |
| `demand_trends(project, window_days?)` | **Traffic decay and growth from your Search Console history** — the page grain of the last 28 days against the same-length window ending the day before: clicks down 40%+ from 10+ clicks is a decay, up 40%+ from that floor is growth. Each carries both windows' clicks, impressions and position and a recommendation naming the lever the two windows point at (page gone, position slipped, demand fell with position held, snippet converting less). Decays are filed as `gsc_decay` (scope `history`) and reach `search_review` / `list_problems`; growth is returned, not filed. Skipped, nothing written, when the previous window is shorter than the current one — pass a smaller `window_days`. Needs `fetch_gsc` first |

### Agent session patterns

**Start every session with the review** (free — the decide phase):
```
1. list_projects                                  # discover
2. search_review(project)                         # one triage: needs_input / safe_now / opportunities / working
   #   freshness.state is stale or missing → run_crawl(project), then call it again
   #   working lists "Google has indexed your pages" only after inspect_urls has run — Google's verdict, never the crawl's inference
3. needs_input   → ask the person; never guess a blocked decision
   #   a model- or agent-sourced hygiene item lands here too, its decision_basis saying
   #   "Model-sourced finding (<model>): verify before acting." — check it against the page first
4. safe_now      → fix unattended, verify with each item's verification, then mark_problem_status
   #   rule-sourced only (source.kind === 'rule'): a detector over the crawl found it; nothing here is a hypothesis
5. opportunities → weigh with the person; page_contract (free) / draft_blog_prompt (Solo) when they choose one
   #   model- and agent-sourced findings live here or in needs_input, never in safe_now
   #   measured-demand quick wins and long tails (gsc_quick_win / gsc_long_tail, from demand_opportunities over Search
   #   Console rows) sit here too — rule-sourced counts of real searches, not a model's guess: when one and a model gap
   #   (keyword_gap, long_tail) name the same topic, prefer the measured one. The content loop weights the measured source
   #   highest but does not let it veto: a small row (under 50 potential_clicks, or 100 impressions for a long tail) ranks
   #   medium and a high-priority model gap on the same topic still wins its dedupe — pass the query as `topic` to
   #   draft_blog_prompt when the measured one must be what gets drafted
```

**Finding provenance, in agent terms.** Every problem from `list_problems` and every review item carries `source {kind: rule|model|agent, model, prompt_version, rule_version, confidence}`. `safe_now` holds only rule-sourced findings, so an agent may act on them unattended. Model- and agent-sourced findings — competitor gaps, positioning, anything another agent wrote through `ingest_insight` — land in `needs_input` or `opportunities` and must be verified before acting: the model may have been right, but nothing has checked. The Ledger also closes findings on its own as the data changes. A rule finding that a later complete run of the same audit no longer detects becomes `resolved`; a model or agent finding expires 90 days after `last_seen` unless it is re-emitted (`ingest_insight` takes `confidence` and `ttl_days` for this). Both return to `active` when the finding is detected again; `done` and `dismissed` are never flipped by a re-run, because a person decided those.

**Own-site closed loop** (steps 1–5 free; 6–8 are Solo content production):
```
1. list_projects                                  # discover
2. get_crawl_status                               # check freshness
3. run_crawl(carbium) if stale                    # refresh
4. run_citability_audit(carbium)                  # score everything (AEO, 7 signals incl. AI-crawler access)
5. get_intel(carbium, for=audit|blog)             # citability + gaps + hints
6. draft_blog_prompt(carbium, topic=X)            # AEO-aware prompt (Solo)
7. agent's own Opus/GPT writes the draft          # generate
8. prescore_draft(draft_md, project, topic)       # 0-100 score + closes the loop (Solo):
                                                  #   records the draft, marks the gap in_progress
9. next session get_intel(audit) shows the drafted gap is handled, not re-suggested
```

**Solo-tier competitor loop** (the part an agent can't gather itself):
```
1. run_crawl(carbium) with competitors configured # crawl the field
2. get_competitor_positioning(carbium)            # strategic narrative + coverage
3. get_intel(carbium, for=competitor)             # competitor summary + keyword matrix
4. feed into the drafting loop above              # out-execute the gaps
```

**Bulk firehose** (free or Solo, both with safety):
```
export_intel(project)                             # default cap 1000 rows/table
# Read response.notice FIRST — it explicitly says do NOT ingest wholesale.
# Recommended: pipe to a file via Bash tool, then query with jq/sqlite-utils.
# Own-site tables are free; the competitor gap-analysis history needs Solo.
```

**Important:** the `export_intel` response includes a top-level `notice` field with `level: important|critical`, token estimate, and instructions. Agents should ALWAYS read the notice before deciding what to do with the data — for large projects (carbium-sized), the firehose is ~300k tokens and will blow up most context windows. Save to file or use targeted tools.

## Pipeline

```
Crawl → Extract (Ollama local) → Analyze (computed sections + schema-checked model judgments) → AEO → Export Actions → Implement
```

| Stage | Command | Gate | Best engine |
|---|---|---|---|
| **Scan** | `seo-intel scan <domain>` | Free | Full pipeline (no config) |
| Crawl | `seo-intel crawl <project>` | Free | Playwright |
| Extract | `seo-intel extract <project>` | Free | Ollama / Gemma 4 or Qwen local |
| Analyze | `seo-intel analyze <project>` | Solo (competitor) | Counted from the rows (keyword gaps, clusters, Search Console quick wins and long tails, technical gaps) + narrow schema-validated judgments from the configured provider: Anthropic, OpenAI, Gemini or DeepSeek with your key, Ollama locally, the Agent Harness or Gemini CLI as fallbacks (`--provider` / `--model`; `--no-model` asks none) |
| AEO | `seo-intel aeo <project>` | Free | Pure local (no AI needed) |
| Watch | `seo-intel watch <project>` | Free | Pure local (diff engine) |
| Demand | `seo-intel demand <project>` | Free | Pure local (SQL over Search Console rows, no AI needed) |
| Trends | `seo-intel trends <project>` | Solo (history) | Pure local (two Search Console windows compared) |
| Keywords | `seo-intel keywords <project>` | Free | The `keyword_inventor` judgment through the same provider layer (closed schema, one repair; `--provider` / `--model`) |
| Blog Draft | `seo-intel blog-draft <project>` | Solo (content production) | Cloud LLM (Gemini/Claude/GPT) |
| Actions | `seo-intel export-actions <project>` | Free (technical) / Solo (competitive) | SQL heuristics |
| Dashboard | `seo-intel serve` | Free (full own-site) / Solo (+ competitor sections) | HTML |
| **Review** | `seo-intel review <project> [--url <page>]` | Free | Pure DB read — needs_input / safe_now / opportunities / working |
| **Intel digest** | `seo-intel intel <project> [--for=raw\|audit\|blog\|competitor]` | Free (raw/audit/blog) / Solo (competitor) | Pure DB read |
| MCP server | `npx seo-intel-mcp` (stdio) | Tier-aware per tool | 39 native MCP tools for AI agents (27 free) |

### How analysis is assembled

`analyze` is not one prompt. It is assembled from three kinds of section, and each row it writes says which kind it came from (`analysis.pipeline.sections`, and the same map on the Ledger rows):

- **Computed** (`analysis/deterministic.js`) — facts re-derivable from the rows, written as rule findings that never expire and resolve when the rule stops firing. Keyword gaps are a set difference over the `keywords` table (a keyword two or more competitors use and the target never does, with `competitor_count` and `covered_by` measured). Content-gap clusters are competitor H1/H2 headings whose stems the target's headings never use. Quick wins and long tails are the `gsc_quick_win` / `gsc_long_tail` rows `demand` measured from Search Console (`source: 'gsc'`). Technical gaps are the schema types competitors publish and the target lacks, plus the technical audit's findings.
- **Judged** (`analysis/judgments.js`) — one task per model call, a closed JSON schema per task, only the rows that task needs, never more than forty items. `keyword_gaps` labels each measured gap with intent, difficulty, suggested action and priority (batched forty at a time; labels are merged back by the exact keyword, an item the model invented is dropped, a gap it skipped is counted, not guessed). `content_gaps` names each cluster and says why it matters. `positioning` writes the market position from the crawl summaries. Every answer is validated against its schema client-side and sent back once with the errors for repair; still invalid, the judgment fails. Provenance is recorded per judgment: name, `JUDGMENT_VERSION`, provider, model, attempts, elapsed.
- **Generated** (also `judgments.js`) — `new_pages`, proposed from the content gaps and long tails and skipped when there are neither; and `long_tails_fallback`, run only when Search Console has measured nothing for the project, every item marked `model-invented:` in its own notes.

`--no-model` runs the computed part alone: keyword gaps with counts but no intent, clusters with the model's fields null, Search Console quick wins and long tails, technical gaps, no new pages, no positioning; `analyses.model` is `rules-only` and every row is a rule finding. A judgment that fails — a refusal, a timeout, a schema the model could not produce — leaves a hole, not a guess: its section is empty and marked `none`, the failure is recorded in `pipeline.failures` with its kind and hint, and the run goes on; only when every judgment failed does the run stop, because then the provider is down or misconfigured. `reports/<project>-judgments-<date>.json` holds every prompt, answer and failure for auditing. `analyses.model` and the model rows' `model` column record `provider:model` (`anthropic:claude-opus-5`, `ollama:gemma4:26b`, `harness:openclaw`) for the provider that actually answered.

### Agent interpretation rule

Do **not** treat SEO Intel as just a report generator. It is a decision layer.

Agents using this skill should interpret outputs like this:
- **crawl** = structural ground truth (pages, headings, links, schemas, domain roles)
- **extract** = semantic layer (entities, intent, CTAs, page types, signals)
- **analyze / gap-intel / keywords / competitive-actions** = what competitors prove is working or missing
- **aeo** = whether pages are shaped for AI citation and answer engines
- **watch** = what changed since last crawl — regressions, new pages, content shifts
- **review** = the decide phase — what needs a person, what an agent may fix unattended, what already works
- **export-actions / brief / suggest-usecases / blog-draft** = implementation-ready next steps

When helping a docs writer, page builder, or implementation agent:
1. identify what competitors cover that the target does not
2. identify where the target exists but is weaker / shallower / less citable
3. convert those gaps into concrete pages, docs, comparison pages, landing pages, schema fixes, or brief-driven updates
4. prefer evidence-backed actions over vague “do more SEO” advice

## Core Commands

```bash
seo-intel scan <domain>            # One-shot full audit (no config needed)
seo-intel review <project>         # Search Review — what needs you, what an agent may fix, what works
seo-intel setup                    # First-time wizard — detects the Agent Harness
seo-intel crawl <project>          # Crawl target + competitors
seo-intel extract <project>        # Local AI extraction (Ollama)
seo-intel analyze <project>        # Strategic gap analysis → Intelligence Ledger
seo-intel aeo <project>            # AI Citability Audit — score pages for AI citation
seo-intel keywords <project>       # Keyword Inventor — traditional + AI/agent queries
seo-intel brief <project>          # Generate content briefs for new pages
seo-intel gap-intel <project>      # Topic/content gap analysis vs competitors (Solo)
seo-intel watch <project>          # Site health monitor — diff between crawl runs
seo-intel blog-draft <project>     # Generate AEO-optimised blog post draft (Solo)
seo-intel html <project>           # Generate dashboard
seo-intel serve                    # Web dashboard at localhost:3000
seo-intel status                   # Data freshness + summary
seo-intel run                      # Full pipeline: crawl → extract → analyze → dashboard
seo-intel guide                    # Interactive chapter-based walkthrough
seo-intel export <project>         # Raw data export (JSON/CSV)
seo-intel entity-audit <project>   # Organization/sameAs identity map; --live tests redirects + reciprocal links
seo-intel triangulation <project>  # Embedded YouTube + GitHub + TechArticle/SoftwareSourceCode proof matrix
seo-intel gsc-platform <project> --input gsc-platform.json # Website vs supported-platform query gaps
seo-intel gsc-fetch <project>      # Search Console → database: page×query (90 d), page + query daily (16 mo); page-contract reads it
seo-intel gsc-inspect <project>    # Google's index verdict per page (URL Inspection): demand-first, 2,000/day; --url names pages, --dry-run plans; review + list_problems read it
seo-intel demand <project>         # Quick wins + long tails from your own Search Console rows (needs gsc-fetch): CTR gaps, page-two queries, unserved phrases; review lists them as opportunities
seo-intel trends <project>         # Clicks decay + growth per page, this window against the last (Solo); decays filed as gsc_decay
seo-intel geo <project>            # LLM retrieval-shape audit for technical content
seo-intel schema-audit <project>   # Schema type specificity + required offers/price fields
seo-intel backlink-import <project> # Import Search Console links export from links/
seo-intel backlink-audit <project>  # Reclamation, equity, concentration, origin-aware (gsc / bing / both); --live recovers target + anchor and reads nofollow
seo-intel bing-links <project>      # Inbound links Bing Webmaster Tools reports, with target page + anchor, into backlinks (origin bing); needs BING_WEBMASTER_API_KEY; --dry-run plans, --debug writes the raw responses
```

### Scan — One-Shot Full Audit (v1.5.21+)

Zero-config audit pipeline. Just pass a domain — no project setup, no competitor config needed.

```bash
seo-intel scan carbium.io                # Full pipeline with AI-enriched export
seo-intel scan carbium.io --no-ai        # Deterministic export only (no LLM enrichment)
seo-intel scan carbium.io --pages 50     # Limit crawl to 50 pages
seo-intel scan carbium.io --model claude # Ask Claude for the judgments instead of the configured provider
seo-intel scan carbium.io --no-stealth   # Disable stealth browser mode
```

**Pipeline:** crawl (stealth) → extract (Ollama) → analyze (computed sections + judgments from the configured provider; falls back to the computed sections alone when no model is configured) → AI-enriched markdown export.

Output: `reports/scan-<domain>-<date>.md` — full report with filled tables, instruction blocks, and AI action plan.

**Dashboard export:** The web dashboard (`seo-intel serve`) has per-card download buttons (MD/JSON/CSV) and profile-based export via `/api/export/download`.

### Export Report (v1.5.21+)

Single unified export — everything actionable in one file. Sections: Technical Scorecard, Site Watch, Technical Gaps, Quick Wins, Keyword Gaps, Long-tails, New Pages, Content Gaps, Positioning, AI Citability, Internal Links, Schema Types, Keyword Ideas.

**Deterministic fills:** Empty table columns are now auto-filled from DB data (long-tail parents, content gap suggestions, keyword potential, page rationale). Instruction blocks between sections explain how to use each data set.

**AI Smart Export:** Toggle in dashboard opens a popup with swarm animation + progress bar. Gemini enriches the report: fills remaining gaps, scores priorities, adds a top-10 AI Action Plan. Non-blocking (async spawn).

Formats: Markdown, JSON, CSV, ZIP. API: `/api/export/download?project=<name>&format=<md|json|csv|zip>&ai=true`

Per-card exports (MD/JSON/CSV) on individual dashboard cards still work for granular downloads.

## Full Command Surface

Use this section when an isolated agent needs the whole toolbox in one place.

### Setup / Core Flow

```bash
seo-intel scan <domain>            # One-shot full audit (no config needed)
seo-intel setup                    # First-time wizard — detects the Agent Harness
seo-intel guide                    # Interactive chapter-based walkthrough
seo-intel status                   # Data freshness + system summary
seo-intel serve                    # Web dashboard at localhost:3000
seo-intel html <project>           # Generate dashboard HTML
seo-intel run <project>            # Full pipeline: crawl → extract → analyze → dashboard
seo-intel export <project>         # Raw data export (JSON/CSV)
```

### Pipeline Commands

```bash
seo-intel crawl <project>          # Crawl target + competitors
seo-intel extract <project>        # Local AI extraction (Ollama)
seo-intel analyze <project>        # Strategic competitive analysis
seo-intel aeo <project>            # AI citability audit
seo-intel watch <project>          # Site health monitor — diff between crawl runs
seo-intel keywords <project>       # Traditional + AI/agent keyword discovery
seo-intel brief <project>          # Content brief generation
seo-intel blog-draft <project>     # AEO-optimised blog post draft
seo-intel gap-intel <project>      # Topic/content gap analysis vs competitors
```

### Agentic / Implementation Commands

```bash
seo-intel export-actions <project>                     # Action export (technical by default / full in Solo)
seo-intel export-actions <project> --scope technical   # Technical fixes from crawl data
seo-intel export-actions <project> --scope all         # Combined action export
seo-intel competitive-actions <project>                # Competitor-backed action list
seo-intel suggest-usecases <project>                   # Suggest missing pages/docs/features
```

### Audit / Analysis Commands

```bash
seo-intel schemas <project>           # Schema coverage audit
seo-intel headings-audit <project>    # H1-H6 structure analysis
seo-intel tech-audit <project>        # Technical audit — titles, meta, noindex, redirects, sitemap diff (extended-data)
seo-intel orphans <project>           # Orphan page/entity detection
seo-intel entities <project>          # Entity/topic mapping
seo-intel friction <project>          # Intent/CTA friction detection
seo-intel velocity <project>          # Content publishing velocity
seo-intel decay <project>             # Content freshness / decay detection
seo-intel js-delta <project>          # JS-rendered vs raw HTML changes
seo-intel shallow <project>           # Thin/shallow content opportunity scan
seo-intel templates <project>         # URL pattern / content type mapping
seo-intel demand <project>            # Quick wins + long tails from Search Console rows (Free, needs gsc-fetch)
seo-intel trends <project>            # Search Console click decay / growth, window over window (Solo)
```

### Modern multi-surface SEO

- `entity-audit <project>` reads crawled `Organization` JSON-LD and checks `sameAs` placement. `--live` resolves redirects and checks accessible profile HTML for a direct canonical-site reference. Treat an inaccessible or bot-blocked profile as **unknown**, not proof of a missing backlink.
- `gsc-platform <project> --input <file>` compares Search Console query exports across `web`, `youtube`, `x`, `instagram`, and/or `tiktok`. The JSON input accepts native Search Console response shapes (`{ "rows": [{ "keys": ["query"], ... }] }`). It outputs **High-Intent Web Content Gaps** (platform query absent from web) and cross-surface SERP opportunities. `--api` is intentionally opt-in: configure exact verified property IDs under `gsc.platformProperties`; it uses the Google account connected with `seo-intel auth google` (`GSC_ACCESS_TOKEN` still works as an override); do not guess platform property IDs.
- `gsc-fetch <project>` pulls your own Search Console rows straight from the Search Analytics API into the database, with real dates instead of "Last 28 days" labels: page×query daily for the last 90 days (what `page-contract` reads), plus page daily and query daily for 16 months — the API's own horizon, collected now so the history exists later. It is incremental (each run extends what is stored and re-fetches only the last few days Google still revises) and rides along with the scheduled `run`. The property is matched from `target.domain` or pinned with `gsc.property`; a miss lists what the account has. `page_contract` prefers these rows over CSV exports, and because one fetch covers every page the property reported, a page with **no rows is measured absence** — no reportable impressions in the window — not missing data, so no export is asked for. `--dry-run` plans the windows without a request. The Links report has no API, so Search Console links stay a CSV import (`backlink-import`); `bing-links` below is the automated route to link data, from Bing's index instead of Google's. Free: it is your own data.
- `gsc-inspect <project>` asks Google the one question a crawl cannot answer: has it indexed this page? The crawl infers indexability from the robots meta, the `X-Robots-Tag` header and the canonical link; Google may disagree for reasons no crawl sees — a noindex added by a CDN, a canonical it chose for itself, a page crawled and judged not worth keeping, a soft 404 behind a 200. Each URL Inspection answer is stored in `gsc_inspections`: the verdict, the coverage state in Google's own words ("Crawled - currently not indexed"), the robots.txt, indexing and page-fetch states behind it, Google's last crawl time, the canonical Google chose next to the one the page declares, and the sitemaps and referring URLs Google knows the page from. Read the verdict as **PASS** indexed · **PARTIAL** indexed with issues · **FAIL** an error prevents indexing · **NEUTRAL** excluded — and NEUTRAL is often the intended outcome (a noindex page, a URL canonicalised elsewhere), so read it against the page's own tags before calling it a problem. Quota discipline: Google allows 2,000 inspections per property per day, so the run is demand-first — crawled target pages that answered 200, ordered by 28-day impressions (`gsc-fetch` data), then sitemap presence, then the crawl's own indexability — 100 per run by default, anything inspected in the last 7 days skipped (`--max-age 0` re-asks), URLs outside the property never sent (the API charges for the 400), and a 429 stops the run cleanly with every verdict so far kept. `--url <urls...>` inspects exactly those; `--dry-run` lists the plan without a request; `gsc.property` / `--property` pin the property as for `gsc-fetch`. What it feeds: `list_problems` and `search_review` report **not indexed** (FAIL, or NEUTRAL on a page the crawl calls indexable — critical when the URL is in the sitemap) with a fix keyed to the coverage state, and **canonical mismatch** (indexed, but under another URL); a deliberate noindex that Google honours is not reported. `search_review.working` gains "Google has indexed your pages" only from these verdicts, never from the crawl's inference. The scheduled `run` (Solo) inspects 50 URLs after each crawl. Free: it is your own site and your own Search Console.
- `demand <project>` turns the rows `gsc-fetch` stored into the two answers a keyword tool sells as estimates — what is already within reach, and what people ask for that no page of yours answers — computed instead from what Google reported for your property: impressions, clicks and position are measurements here, not modelled volume. It aggregates the last 28 days of `gsc_daily` (`--window`, at least 7; clamped to the days fetched) and emits two kinds of finding. A **quick win** is a page × query pair already ranking at positions 4–20 with 50+ impressions in the window (`--min-impressions`) where the click-through rate is under 60% of the baseline for that position (`ctr_gap`: the snippet is losing clicks the ranking has already earned, so a title and meta description rewrite recovers them without ranking any higher) or the page sits on page two (`page_two`: internal links and depth move it onto page one), or `both`; `potential_clicks` sizes each in additional clicks per window — the impressions times the gap between the current CTR and the baseline CTR at that position, or at position 8 for a page-two row (where a page-one landing would put it); `both` takes the larger. A **long tail** is a phrase of 3+ words with 20+ impressions at an average position of 10.5 or worse where no page × query row places any page at 10 or better — both checks, because the query grain averages every page shown for the phrase and a page ranking 5th can hide behind another ranking 40th; `best_page` names the page most shown for it (strengthen it under its own heading) or is null (a page is missing). Up to 50 of each, best first. The CTR baseline (`expected_ctr`) is a heuristic industry curve — 28% at position 1, 15% at 2, 10% at 3, 7% at 4, down to 2% at 10 and 1% across page two — chosen to rank rows against each other and size an estimate, never a measurement of this site: read `potential_clicks` as "about", not a forecast, and expect a branded query or a SERP full of features to sit off the curve. The findings are written to the Ledger as rule-sourced `gsc_quick_win` and `gsc_long_tail` with `complete: true`, which is honest here because every run reads the whole property for the window: a win missing from a later run is resolved because the position moved or the CTR recovered, not guessed away. The exception is partial coverage — a fetch that hit its row cap dropped exactly the low-click rows a quick win tends to be — when the run records what it found and resolves nothing. `search_review` lists them under `opportunities` next to the model's `keyword_gap` and `long_tail` (the same words, a different provenance, kept as separate types so the two never share a card or a fingerprint; when both name a topic, prefer the measured one), `list_problems` carries them with `source.kind: rule`, and the content loop (`run_content_loop`, `loop`) gives them the highest source weight of any candidate — one factor of the leverage, not a veto: a small row (under 50 potential clicks, or 100 impressions for a long tail) ranks medium and a high-priority model gap on the same topic still wins the dedupe, so pass the query as `topic` to `draft_blog_prompt` when it must be the one drafted — while the intelligence-data section of the draft prompt behind `draft_blog_prompt` and `blog-draft` opens with a "Measured demand" block, ahead of every inferred table and marked as counted, not inferred. No request and no model: with no `gsc_daily` rows the command says so and names `gsc-fetch`. Free: it is your own data. `trends <project>` (Solo) is the paid half of the same module: the page grain over the current window against the same-length window ending the day before — a page whose clicks fell 40%+ from 10+ clicks is a **decay**, filed as `gsc_decay` with scope `history` and a recommendation naming the lever the two windows point at (the page is gone: check it is live and indexed; the position slipped: recover the ranking; impressions fell with position held: demand moved; both held while clicks fell: the snippet converts less); one whose clicks rose 40%+ from that floor is **growth**, returned but not filed. The comparison is skipped, and nothing written, when the fetched history does not yet reach back two full windows, because a short previous window would make every page look like growth; a smaller `--window` fits two into what is fetched. The scheduled `run` computes all of it, trends included, after each crawl.
- `triangulation <project>` scores the three proof signals only when evidenced: a YouTube **iframe** (confirmed by `--live`), a direct active GitHub link, and matching `TechArticle` or `SoftwareSourceCode` markup. `--video-metadata` checks descriptions through the YouTube Data API only when `YOUTUBE_API_KEY` is configured.
- `geo <project>` scores technical pages for concise opening definitions, flat list structure, syntax-tagged code blocks, and, with `--live`, detected copy controls. It measures extraction affordances; it does not claim a particular LLM will cite the page.
- `schema-audit <project>` checks whether a schema type is the *right* type and carries the fields its rich result needs. It flags `Product` markup on API, docs, dashboard, or app surfaces (where `SoftwareApplication` / `WebApplication` is the typed match), `Product` with no priced `offers`/`aggregateRating`/`review`, and `offers.price` without `priceCurrency`. A price of `0` is valid for a free tier.

- `backlink-audit <project>` audits the links Search Console and Bing report for you. It is **not a link index**: it cannot find links neither engine has reported, and it cannot see competitor backlinks. It answers what is wrong with the links you already have: **reclamation** (domains linking under a product or brand name the site no longer uses — existing relationships, cheaper to correct than new links are to earn, one outreach per domain), followed vs `nofollow`, domain concentration, and which of your pages receive no links at all. The summaries depend on origin. Every row carries `origin`: `gsc`, `bing`, or `bing,gsc` when both engines report it. A row from before the column existed reads as `gsc`. `summary.by_origin` counts rows and domains per source and for both, and the brief output prints that line once Bing rows exist. `sample_note` names the sources the rows are a sample of and how many linking pages both report. `equity` puts every link that `--live` has neither found on its page nor proved gone under `unknown`, never under followed, and `unknown_bing` counts the Bing-reported ones among them. `targets_note` says how many linking pages have a known target, so read a page listed as receiving no links against it. `--live` fetches the linking pages to read nofollow, prove the link is still there, and recover the target URL and anchor text, which Search Console does not export. A link found on the page overwrites the stored target and anchor; a fetch that found nothing keeps them, whether Bing or an earlier fetch supplied them. A site that blocks bots or renders links client-side is reported as **unknown**, never as a lost link. Use the "Latest links" export: under the export cap it holds the same URLs as "More sample links" plus a date.
- `bing-links <project>` fetches the inbound links Bing Webmaster Tools reports into the same `backlinks` table. Search Console's Links report has no API, so its links arrive only as a hand export, and that export has the linking URL and nothing else. Bing's API has link reports that include the page of yours each link points at and the anchor text, so a Bing row feeds the audit's target-page analysis without `--live`. The walk: `GetLinkCounts` lists your pages that have inbound links and how many, then the 50 most-linked (`--max-targets`) go through `GetUrlLinks` for the linking pages and their anchors, two at a time. A linking page on your own host is skipped: it is an internal link. **What is stored.** A new linking URL is inserted with origin `bing`. One the export already holds gets `bing` merged into its origin (`bing,gsc`) and gets a target and anchor only where it has none; its source and import date are kept. The `--live` columns (`verify_state`, `link_present`, `rel_nofollow`, `http_status`, `checked_at`) are never touched, because Bing having seen a link says nothing about whether it is on the page today or whether it is followed. A later `backlink-import` merges `gsc` into a Bing row the same way. **Corroboration.** A link both engines report was seen by two independent crawlers, the nearest thing to confirmation short of fetching the page. A link only one reports has been seen once; that does not make it doubtful. **Never a complete link profile.** Bing reports what its own index has seen, a different sample from Google's, also capped and lagging, and the union of the two is still a sample. **Quota.** Every request counts against the key's daily quota, so a run makes at most 300 (`--max-requests`), `GetUserSites` included. A 429, or a message about quota or throttling, stops every worker at its next request. Each target's links are stored as soon as that target is done, so a stopped run keeps what it fetched and the next run re-reports it harmlessly. `truncated` and `stopped_reason` (`quota` or `max_requests`) say which cap was hit. A server error or timeout on one target is listed in `errors` and the run goes on; a rejected key, an unverified site or an unexpected shape stops it, with the fix in the message. **The site** is `--site-url`, else `bing.siteUrl` in the project config, else matched from `target.domain` against the account's verified sites; a miss lists what the account has. `--dry-run` resolves the site and prints the plan without a link request. The scheduled `run` (Solo) walks the 20 most-linked pages after each crawl when the key is set. **The response shapes are unverified.** Microsoft's documentation was not reachable when this was written, so every endpoint, method and field name comes from prior knowledge. They all sit in one constants block (`BING_API` in `lib/bing-api.js`). Fields are read case-insensitively, with or without the `d` wrapper, and a response that still does not fit fails loudly with the first 500 characters of its body rather than storing nothing. `--debug` writes the first raw body of each method called — `GetUserSites` when the site is matched, `GetLinkCounts`, `GetUrlLinks`, a non-JSON body exactly as sent, the key redacted — to `reports/<project>-bing-<Method>.json` to compare with `BING_API.fields`. A linking page Bing lists for several of your pages is stored once per run, and a plain-text error that mentions quota or throttling stops the run as a quota stop. Needs `BING_WEBMASTER_API_KEY` (Bing Webmaster Tools → Settings → API access; the site must be verified in that account). Free: it is your own site's links.

`entity-audit`, `gsc-platform`, `triangulation`, `geo`, `schema-audit` and `demand` write their findings to the Intelligence Ledger, so they accumulate and dedupe across runs, appear on the dashboard under **Own-site Findings**, and reach agents through `list_problems`. Marking one done or dismissed keeps it from returning. A finding a later complete run of the same audit no longer detects is marked `resolved` on its own and returns to `active` if the audit detects it again; `gsc-platform` writes a top-30 list rather than a complete detection, so its rows clear only when marked.

```jsonc
{
  "gsc": {
    // optional — gsc-fetch matches a property to target.domain when this is omitted
    "property": "sc-domain:example.com",
    "platformProperties": {
      "web": "sc-domain:example.com",
      "youtube": "YOUR_VERIFIED_PLATFORM_PROPERTY_ID"
    }
  },
  "bing": {
    // optional — bing-links matches a verified site to target.domain when this is omitted
    "siteUrl": "https://www.example.com/"
  }
}
```

### Project Management Commands

```bash
seo-intel competitors <project>                    # List competitors
seo-intel competitors <project> --add rival.com   # Add competitor
seo-intel competitors <project> --remove rival.com# Remove competitor
seo-intel subdomains <domain>                     # Discover subdomains
```

## Analysis & Audit Commands

```bash
seo-intel aeo <project>            # AI Citability Audit (0-100 per page, 7 signals incl. AI-crawler access)
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
seo-intel gap-intel <project>      # Topic gap analysis vs competitor domains (Solo)
seo-intel watch <project>          # Site health monitor — diff between crawl runs (Free)
seo-intel blog-draft <project>     # AEO-optimised blog post draft (Solo)
```

## Site Watch — Health Monitoring & Change Detection (v1.4.2+)

Tracks crawl-to-crawl changes and computes a site health score (0-100) from page errors, missing titles, and missing H1s. Site Watch is available on the free tier and auto-runs after every crawl.

```bash
seo-intel watch <project>                # Brief health report
seo-intel watch <project> --format json  # Structured JSON output
```

**How it works:**
- First run captures a baseline snapshot
- Subsequent runs diff against the previous snapshot
- Significant changes feed into the Intelligence Ledger as `site_watch` insights
- Dashboard shows the Site Watch card with health score, trend arrows, severity deltas, and a “What’s New” event feed
- Available via CLI, dashboard terminal, and programmatic API: `run('watch', project)`

**Detected event types (10):**
- `page_added`
- `page_removed`
- `status_changed`
- `new_error`
- `title_changed`
- `h1_changed`
- `meta_desc_changed`
- `word_count_changed`
- `indexability_changed`
- `content_changed`

**Severity classes:** `critical`, `warning`, `notice`

**Agent use:** Run `watch` after every crawl to detect regressions early. If the health score drops, investigate critical/warning events before spending cycles on higher-order analysis.

## Technical Audit — Extended-Data Validation (v1.5.23)

Reads signals captured during crawl and produces concrete findings. Own-site technical validation — available on the free tier.

```bash
seo-intel tech-audit <project>                # Audit all domains in project
seo-intel tech-audit <project> --domain site.com
seo-intel tech-audit <project> --head         # Also HEAD-check sitemap URLs
seo-intel tech-audit <project> --format json
```

**Finding types:**
- `title_missing`, `title_too_long` (>60 chars)
- `meta_desc_missing`, `meta_desc_too_long` (warn >160, error >320)
- `noindex_header` — `X-Robots-Tag: noindex` detected
- `redirect_chain` — 1+ hop before final URL (warn at 2+)
- `indexable_missing_from_sitemap` — 200 + indexable page not declared in sitemap
- `redirect_targets_summary` — review canonicals pointing to redirect targets
- `sitemap_redirect`, `sitemap_broken` — only with `--head`

Signals captured during crawl: `final_url`, `redirect_chain` (JSON), `x_robots_tag`. Sitemap inventory persisted in `sitemap_urls`.

## Blog Draft — AEO-Optimised Content Generation (v1.3.0)

Generates blog post drafts from Intelligence Ledger data — keyword gaps, citability insights, and competitor patterns feed into structured markdown with frontmatter.

```bash
seo-intel blog-draft <project>                          # Auto-pick topic from ledger
seo-intel blog-draft <project> --topic "api security"   # Specific topic
seo-intel blog-draft <project> --lang fi                # Finnish
seo-intel blog-draft <project> --model claude --save    # Use Claude, save to reports/
```

**Models:** gemini (default), claude, gpt, deepseek

Solo tier — content production (paid since v1.6.0; the audit that feeds it stays free).

## Gap Intel — Topic Coverage Gap Analysis (v1.4.0)

Compares your crawled pages against competitor domains to surface topic gaps — content they cover that you don't, and depth gaps where they go deeper.

```bash
seo-intel gap-intel <project>                          # vs all crawled competitors
seo-intel gap-intel <project> --vs helius,quicknode   # specific competitors
seo-intel gap-intel <project> --type docs              # filter to doc pages only
seo-intel gap-intel <project> --raw                   # skip LLM, raw topic matrix
seo-intel gap-intel <project> --out ./gap-report.md   # write to file
```

**Output:** Prioritised gap report (High/Medium/Low buyer intent) with:
- Topics competitors cover → you don't
- Depth gaps (you have 1 page, they have 5)
- Topics where you lead
- Raw topic matrix per domain

Use `--out ~/clawd/projects/carbium/docs-mirror/waiting-room/gap-intel-latest.md` to feed the docs pipeline automatically.

Solo tier only.

## Default Extraction Model

**Gemma 4 e4b** is now the default extraction model (replaces Qwen 3 4B).

| Model | Size | Speed | Tier |
|-------|------|-------|------|
| `gemma4:e2b` | 6.7 GB | ~47 t/s | Budget |
| `gemma4:e4b` | 8.9 GB | ~23 t/s | **Balanced (default)** |
| `gemma4:26b` | ~18 GB | — | Quality |
| `gemma4:31b` | ~20 GB | — | Power |

All Qwen models remain available. Change model via `seo-intel setup` or edit `config/<project>.json`.

## AEO — AI Citability Audit (v1.2.0)

Score every page for how well AI assistants (ChatGPT, Perplexity, Claude) can cite it. This is not traditional SEO — it's Answer Engine Optimization.

```bash
seo-intel aeo <project>                # Full citability audit
seo-intel aeo <project> --target-only  # Skip competitor scoring
seo-intel aeo <project> --save         # Export .md report
```

**7 citability signals** scored per page:
- **Entity authority** — Is this page the canonical source for its entities?
- **Structured claims** — "X is Y because Z" patterns that AI can quote directly
- **Answer density** — Ratio of direct answers to filler content
- **Q&A proximity** — Question heading → answer paragraph pattern
- **Freshness** — dateModified, schema, "Updated March 2026" signals
- **Schema coverage** — JSON-LD structured data present
- **AI-crawler access** — does robots.txt let GPTBot, ClaudeBot, PerplexityBot, Google-Extended and CCBot through? A block hard-caps the page score at 30, because a page an answer engine cannot fetch cannot be cited no matter how well it is written.

**AI Query Intent classification:** synthesis, decision support, implementation, exploration, validation

Low-scoring pages automatically feed into the Intelligence Ledger as `citability_gap` insights.

## Intelligence Ledger

Insights from `analyze`, `keywords`, `aeo` and the own-site audits **accumulate across runs** — they're never overwritten. The ledger uses fingerprint-based dedup: same insight found again = updated timestamp, not duplicated.

- Mark insights as **done** (fix applied) or **dismissed** (not relevant) — a re-detection never reopens either
- Dashboard shows all active insights with done/dismiss buttons
- `POST /api/insights/:id/status` to toggle status programmatically

### Finding provenance

Every row says where it came from, in six fields; `list_problems` and `search_review` copy them onto each problem and review item as `source`:

| Field | Meaning |
|---|---|
| `source_kind` | `rule` — a deterministic detector over crawl, extraction or Search Console data, including the computed sections of `analyze` (quick wins and long tails from Search Console, technical gaps, and every section of a `--no-model` run); `model` — a judgment a model produced (keyword-gap labels, content-gap naming, new pages, positioning, model-invented long tails, invented keywords); `agent` — written through `ingest_insight` |
| `model` | `provider:model` that answered (`anthropic:claude-opus-5`, `ollama:gemma4:26b`), or agent name, behind a model or agent finding; `null` for rules |
| `prompt_version` | version tag of the judgment prompt that produced a model finding (`JUDGMENT_VERSION` in `analysis/judgments.js`); `null` otherwise |
| `rule_version` | version tag of the detector behind a rule finding (`1` today); `null` otherwise |
| `confidence` | 0..1. Rules write `1.0`; models and agents write what they were given, `null` when unknown — never invented |
| `expires_at` | epoch ms. `null` for rule findings, which clear when the rule stops firing; model and agent findings expire 90 days after `last_seen` unless re-emitted |

Two statuses sit next to `active` / `done` / `dismissed` / `in_progress`, and the data sets both:

- **`resolved`** — a rule finding that a later complete run of the same audit no longer emitted: no longer detected.
- **`expired`** — a model or agent finding past `expires_at`; swept on every database open, and readers skip a past-expiry row even before the sweep.

Both are reversible by the data: a re-emitted fingerprint flips `resolved` or `expired` back to `active`. `done` and `dismissed` are never flipped by a re-emission — the person decided. Rows written before these fields existed are classified once, on open: an `agent…` source becomes `agent`, the LLM synthesis types become `model` (the model taken from the analysis row when the insight still points at one), everything else becomes `rule` with confidence `1.0`.

`search_review` reads `source` to place each item: only a rule-sourced problem can enter `safe_now`; a model- or agent-sourced one in an otherwise autonomous category goes to `needs_input` with `Model-sourced finding (<model or agent>): verify before acting.` in its `decision_basis`.

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

## How isolated writer / docs agents should use this skill

If the agent is writing docs, landing pages, comparison pages, or implementation briefs in an isolated environment, use this order:

1. **Establish reality**
   - use `crawl`, `watch`, `schemas`, `headings-audit`, `status`
   - identify target vs competitor coverage, detect regressions from previous crawl
2. **Understand meaning**
   - use `extract`, `entities`, `keywords`, `gap-intel`
   - determine what themes, intents, and problem clusters competitors cover
3. **Prioritise action**
   - use `competitive-actions`, `export-actions`, `suggest-usecases`, `brief`
   - convert findings into pages/features/docs, not abstract insights
4. **Shape for answer engines**
   - use `aeo`
   - improve citability, answer density, structured claims, schema, and entity authority

### Interpretation heuristics for agents

- If competitors have whole topic clusters the target lacks → create **net-new pages or docs**
- If the target has the page but competitors go deeper → create **rewrite / expansion brief**
- If trust/comparison/integration pages are missing → create **commercial-intent pages**
- If schema / headings / orphan issues dominate → start with **technical actions**
- If AEO scores are low on important pages → restructure for **AI-citable answers**
- If `suggest-usecases` and `gap-intel` overlap on the same topic → treat that as a **high-confidence build target**
- If `source.kind` is `model` or `agent` → **verify before acting**; only `rule` findings are safe to fix unattended

## How to use SEO Intel reports for automation

For automation, treat SEO Intel as the upstream decision layer, not a live database you rediscover every run.

### Prefer stable report artifacts over raw discovery

Automation should prefer:
- fixed-path exports like `waiting-room/gap-intel-latest.md`
- project-level aliases like `reports/<project>-latest-analysis.json`
- short docs-facing briefs like `reports/<project>-docs-brief.md`

Automation should avoid depending on:
- ad hoc CLI discovery
- guessing the newest timestamped file in multiple places
- direct `seo-intel.db` queries unless the workflow is explicitly advanced/custom

If timestamped files are all you have, read the newest `reports/<project>-analysis-*.json` and then normalize it into one stable handoff file for the downstream automation.

### What to read from the reports

The main report to automate against is the analysis export:

```text
reports/<project>-analysis-*.json
```

Useful keys:
- `new_pages` = net-new page candidates
- `content_gaps` = topics competitors cover that you do not, or where your coverage is materially weaker
- `keyword_gaps` = missing demand clusters or landing/doc opportunities
- `long_tails` = specific problem-led queries worth docs/blog coverage
- `quick_wins` = existing pages that can be improved quickly
- `technical_gaps` = crawl-backed fixes, usually for technical/site work rather than net-new content

Other high-value exports:
- `gap-intel` output = competitor-backed topic and depth gaps
- `competitive-actions` output = prioritized strategic actions
- `export-actions --scope technical` = technical fixes from crawl data
- `aeo` output = weakest pages by AI citability, answer density, and claim structure
- `suggest-usecases` output = inferred missing docs/pages/features based on competitor patterns

### Recommended automation mapping

Use the report fields like this:
- `new_pages` → create-page queue
- `content_gaps` → docs/product/content gap queue
- `keyword_gaps` → landing page, glossary, comparison, or docs opportunity queue
- `long_tails` → problem-led docs, recipes, or blog queue
- `quick_wins` → rewrite queue for weak existing pages
- `technical_gaps` → engineering/site-health queue

For docs automations specifically:
1. read the latest analysis JSON
2. read the latest `gap-intel` markdown if present
3. identify:
   - topics competitors cover that you lack entirely
   - existing pages with weak coverage or weak citability
   - overlap between `suggest-usecases`, `content_gaps`, and `aeo`
4. collapse that into one short docs brief with:
   - top 3 new pages to create
   - top 3 pages to rewrite
   - why they matter
   - competitor proof
   - blockers / confidence notes
5. let the downstream docs agent choose only from that brief, not from raw DB state

### Suggested handoff pattern

For recurring docs pipelines, create a stable file like:

```text
reports/<project>-docs-brief.md
```

Recommended sections:
- `New Pages to Create`
- `Content Gaps`
- `Weak Existing Pages`
- `Competitor Proof`
- `Blockers`
- `Best Next Pick`

This is the simplest way to make downstream automation reliable. The SEO Intel job does the heavy analysis once; docs/product automations consume a short, fixed-format brief instead of rediscovering the entire workspace each run.

## Agent Harness Workflow (Recommended)

When running inside the Agent Harness (Hermes, Claude Code, Cursor, or any MCP host), the full intelligence loop becomes conversational:

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

## Deploy Loop — Applying Fixes via Wrangler

SEO Intel tells you what's wrong and what to build. Wrangler deploys it. Agents can close the loop end-to-end.

### Setup (once)

```bash
npm install -g wrangler
wrangler login        # opens browser for Cloudflare OAuth
```

The site needs a `wrangler.toml` in its root:
```toml
name = "your-cloudflare-project-name"
compatibility_date = "2024-01-01"
assets = { directory = "." }
```

And a `.wranglerignore` to keep internal files off the public site:
```
.DS_Store
.claude/
.wrangler/
deploy.sh
wrangler.toml
```

### Deploy

```bash
cd /path/to/site && wrangler deploy
```

Only changed files are uploaded. Deploy is instant and global (Cloudflare edge, no staging).

---

### "SEO Intel found issues — fix and deploy"

1. Run analysis to get findings
   ```bash
   seo-intel aeo <project> --format json
   seo-intel export-actions <project> --scope technical --format json
   seo-intel schemas <project> --format json
   ```

2. Apply fixes to static HTML based on findings:

   | SEO Intel finding | What to fix in the HTML |
   |---|---|
   | Low schema coverage (AEO) | Add/update `<script type="application/ld+json">` blocks |
   | Low answer density (AEO) | Add direct-answer paragraphs after H2/H3 headings |
   | Low Q&A proximity (AEO) | Add FAQ sections: `<h3>` question + `<p>` answer |
   | Low freshness signal (AEO) | Add `dateModified` to JSON-LD, add "Updated [date]" near content |
   | Schema gap vs competitors | Add the missing `@type` to JSON-LD |
   | Missing meta tags | Add `og:title`, `og:description`, `twitter:card`, `meta description` |
   | Missing hreflang | Add `<link rel="alternate" hreflang="...">` pairs in `<head>` |
   | Content/topic gap | Create new page, update `sitemap.xml` and `llms.txt` |
   | Version drift | Update `softwareVersion` in JSON-LD, nav badge, `llms.txt`, `skill.md` |

3. Deploy
   ```bash
   cd /path/to/site && wrangler deploy
   ```

4. Re-crawl to verify lift
   ```bash
   seo-intel crawl <project> --scope new
   seo-intel aeo <project>
   ```

---

### Keeping llms.txt / skill.md in sync after releases

After any version bump or feature release, update and redeploy. Also keep public listing surfaces aligned, not just local docs:

```bash
# Update skill.md from source
cp /path/to/seo-intel/skill/SKILL.md /path/to/site/seo-intel/skill.md

# Update version references in llms.txt and llms-ctx.txt
# (sed or agent edit — bump version number, update feature list)

# Deploy
cd /path/to/site && wrangler deploy
```

Files/surfaces that must stay in sync on every version bump:
- `skill/SKILL.md`
- public site `seo-intel/skill.md` — copy from `skill/SKILL.md`
- public site `llms.txt` — version number + feature summary
- public site `llms-ctx.txt` — full context, version number, feature descriptions
- JSON-LD `softwareVersion` on product pages
- nav / hero version badges in HTML
- ClawHub listing / manifest text and runtime expectation disclosure
- `CHANGELOG.md`

---

### Safety rules for deploy agents

- **Always read a file before editing it** — never blind-write HTML
- **Never change pricing or contact info** without explicit instruction
- **Keep all version references consistent** — JSON-LD, badge, llms.txt must all match
- **Deploy is live immediately** — no staging, no undo. Be deliberate.

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

## Programmatic API (for platform integrations)

All commands support `--format json` for structured output. For deep integration, use the programmatic API:

```javascript
import { run, capabilities, pipeline } from 'seo-intel/agent-harness';

// Unified runner — one function, all commands
const aeoResult = await run('aeo', 'myproject');
const gaps = await run('gap-intel', 'myproject', { vs: ['competitor.com'] });
const brief = await run('brief', 'myproject', { days: 7 });

// Every result: { ok, command, project, timestamp, data }
if (aeoResult.ok) {
  console.log(aeoResult.data.summary.avgTargetScore);
}

// Capability introspection
capabilities.forEach(c => console.log(c.id, c.phase, c.tier));

// Dependency graph for orchestration
pipeline.graph['entities']; // → ['extract']
```

Available: `aeo`, `gap-intel`, `watch`, `shallow`, `decay`, `headings-audit`, `orphans`, `entities`, `schemas`, `friction`, `brief`, `velocity`, `js-delta`, `export-actions`, `competitive-actions`, `suggest-usecases`, `blog-draft`, `insights`, `status`

See `AGENT_GUIDE.md` for full orchestration patterns.

## Cron Scheduling

```bash
# Daily crawl (14:00 recommended)
seo-intel crawl <project>

# Weekly analysis + AEO + brief (Sunday)
seo-intel analyze <project> && seo-intel aeo <project> && seo-intel export-actions <project> --format brief
```

For ongoing operator summaries, treat `reports/` as a folder-aware signal surface, not a one-file source. In practice, the most useful recurring artifacts are:
- `triage-continuous.md`
- latest dated `triage-YYYY-MM-DD.md`
- latest `bugscan-*`
- optional `bugfix-*`
- optional `cross-debate-*`
- optional briefs when they actually exist

Wire via your agent harness cron for proactive briefings delivered to your chat.

## Pricing

| Tier | Price | Features |
|---|---|---|
| Free | €0 | Your own site, end-to-end: unlimited crawl, extraction, AI Citability (AEO), keyword intel, templates/orphans, JS-render delta, GSC insights, technical exports, full dashboard, Site Watch, daily problem cron |
| Solo | €19.99/mo or €199.99/yr | Everything in Free + competitor synthesis (gap analysis, positioning, keyword battleground), scheduled crawls, history/trends (change brief, publishing velocity), and content production (blog drafts, content loop) |

Solo via [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/).
