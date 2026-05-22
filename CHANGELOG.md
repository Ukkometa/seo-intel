# Changelog

## 1.5.36 (2026-05-23)

### Setup — LM Studio detection works for LAN hosts (fixes "unreachable" false negative)
The wizard's host-ping logic was gated on port number — only checked LM Studio if port was exactly 1234, only checked Ollama if anything else. That broke for any non-default setup. **Now probes both engines in parallel for every host** regardless of port.

- **`/api/setup/ping-ollama`** runs `checkOllamaRemote` and `checkLmStudio` in parallel via `Promise.all`. Whichever responds wins. Order: Ollama preferred when both respond (preserves existing behaviour for ambiguous setups).
- Success message now identifies the engine: *"Connected to LM Studio — 5 model(s) found"* vs *"Connected to Ollama — 3 model(s) found"*.
- Unreachable error returns a structured `hint` with three common causes (bind to 127.0.0.1 only, firewall, wrong port) — much more useful than the old "check IP, port, and that Ollama is running" message.
- Wizard surfaces the `hint` directly via HTML-escaped error text. No more misleading "Ollama is running on that machine" when the user is running LM Studio.

The "EXTRACTION HOSTS" section copy already mentioned both engines correctly — only the per-ping result message and the backend gating needed fixing. Existing localhost auto-detection (the green `localhost:1234 active` row in the screenshot) was unaffected.

## 1.5.35 (2026-05-22)

### MCP — `mark_problem_status` closes the Problems loop
Agents can now confirm fixes and dismiss problems they've handled. Without this tool, subjective problems (positioning, content gaps) would keep re-appearing in `list_problems` even after the agent had addressed them.

- **`mark_problem_status(problem_id, project, status, snooze_days?, agent_name?, note?)`** — **free tier**. Status: `fixed` | `wont_fix` | `snoozed`. Snoozed requires `snooze_days` (1-365). Re-marking the same problem_id updates the existing record.
- **`list_problems` gains `include_marked: boolean`** — by default marked problems are hidden; set true to audit what's been suppressed (each row gains a `status: 'active' | 'fixed' | 'wont_fix' | 'snoozed'` field).
- **`problem_counts` in `list_projects` honor marks** — when an agent marks 12 of 26 orphans as fixed, the nag immediately drops to 14. The "warm fuzzy" of clearing things.

Schema: idempotent `CREATE TABLE IF NOT EXISTS problem_status` migration in `getDb()`. Stores `problem_id` (matches `list_problems` output), project, status, marked_at, marked_by (e.g. `agent:claude-opus-4-7`), note, expires_at (for snoozes). Indexed by `(project, status)`.

Verified end-to-end: mark a real orphan → count drops 26→25 → re-list with `include_marked` reveals it with `status: 'fixed'`. Smoke 10/10. MCP surface: 15 tools.

## 1.5.34 (2026-05-22)

### MCP — Problems as the entry surface ("what should I fix?")
The single biggest UX shift in the agent flow. Two new touchpoints turn `list_projects` into a passive nag layer and `list_problems` into the canonical "fix-able findings" tool.

- **`list_problems(project, severity?, category?, limit?, max_fix_difficulty?)`** — severity-sorted, agent-fixable problem list. Every item returns `{id, severity, category, tier, title, description, affected_urls, evidence, fix_template, verification, first_seen, last_seen, fix_difficulty}`. The `fix_template` is the design point — it gives a coding agent a concrete next step (file/URL, what to change, how to verify).
  - **Free categories**: `tech` (HTTP 4xx/5xx), `indexability` (robots header conflicts), `links` (orphan pages), `schema` (missing structured data on substantive pages).
  - **Paid categories**: `citability` (low AEO scores from `citability_scores`), `content` / `keyword` / `positioning` (mapped from Intelligence Ledger).
  - Sorting: severity (critical → warn → info), then fix_difficulty (1=trivial → 5=deep work), then last_seen DESC.
- **`list_projects` now nags.** Every project response includes `problem_counts`, `stale_days`, and a `nag` string that flags critical/warn counts and stale crawls. Solo users see paid-tier counts; free users see free-tier counts only (no teasing). Example output: `risunouto: 26 warn · crawl 42d stale. Call list_problems('risunouto') to see them.`
- **New library: `lib/problems.js`** — `getProblems(db, project, opts)` + `getProblemCounts(db, project, opts)` are the unifying primitive. Six collectors today (4 free + 2 paid); future patches add more (decay targets, friction points, mark_problem_status, schema-vs-competitor diffs).

The agent loop this unlocks: `list_projects` → see the nag → `list_problems(project, severity='critical')` → fix the highest-leverage one → `run_crawl(project)` → re-call `list_problems` to verify it cleared. Closed loop, no dashboard required.

**MCP surface: 14 tools.** Next patches: `mark_problem_status` (v1.5.35) + native notification daemon (v1.5.36) + dashboard Problems tab as landing (v1.5.37).

## 1.5.33 (2026-05-19)

### Dashboard — visual brief foundation (intel-blue tokens + component utilities)
First step toward the v1.6 marketing-video polish. **Purely additive** — every existing dashboard card looks identical; new tokens and component classes are in place for subsequent patches to opt in page-by-page.

- **Intel-blue palette** (alongside existing gold/purple accents — never mixed in the same component):
  `--intel-blue: #3b82f6`, plus `--intel-blue-soft`, `--intel-blue-faint`, `--intel-blue-border`, `--intel-blue-glow`.
- **Signal palette** for citability / health scores:
  `--signal-good: #4ade80`, `--signal-warn: #f5c842`, `--signal-bad: #f47b5d`.
- **Surface aliases** under brief-friendly names: `--surface-page`, `--surface-card`, `--surface-off`, `--surface-border`.
- **`--font-mono` now defined** — previously referenced in 6 places but never declared, falling through to nothing. Now properly resolves to JetBrains Mono → SF Mono → Fira Code. Mono fields (version stamps, code snippets, numeric tables) instantly look sharper without any markup change.
- **Component utility classes** (opt-in, prefixed `.vb-` for visual-brief):
  - `.vb-pill` — blue chip with a glowing left dot, for section headers
  - `.vb-label-caps` — small-caps Inter label, 1.8px letter-spacing
  - `.vb-num-tabular` — `font-variant-numeric: tabular-nums` + JetBrains Mono for column alignment
  - `.vb-severity-dot.info / .warn / .crit` — Site Watch dot with sized glow per severity
  - `.vb-score-big.good / .warn / .bad` — Syne 800 hero numeric with color-matched text-shadow
  - `.vb-card` — sharp-corner card (0 radius), `0 24px 60px` shadow
  - `.vb-card-featured` — premium variant with blue gradient + glow shadow

Next: v1.5.34 polishes the Citability page to use these tokens. v1.5.35 adds the Action Export modal. UI polish lands per page; nothing breaks in between.

## 1.5.32 (2026-05-19)

### Docs — `skill/SKILL.md` rewritten for AI agent discovery
- Updated YAML frontmatter description: now leads with "Local SEO data layer for AI agents" and enumerates the 13 MCP tools by name so MCP hosts surface them when matching a user query.
- New top-level **"MCP Server — Native AI Agent Integration"** section right after install: full free / paid tool tables, three agent session patterns (free closed loop, Solo strategic loop, bulk firehose), and an explicit instruction about `export_intel.notice` so agents don't blind-ingest large responses.
- Header reframed: `OpenClaw-recommended` → `local SEO data layer for AI agents` with two consumer paths (MCP and CLI) called out. Free vs Solo tier is now explicit, with the Ahrefs price comparison front-and-center.
- Pipeline table extended: `seo-intel intel` CLI primitive + `npx seo-intel-mcp` stdio entry, both with the right tier gating.

Skill files at ukkometa.fi (`/seo-intel/llms.txt`, `llms-ctx.txt`, `skill.md`) inherit this on next site deploy per the publishing pipeline.

## 1.5.31 (2026-05-17)

### MCP — `export_intel` ships the full data layer to AI agents
The biggest gap closed: agents can now grab seo-intel's entire structured intelligence in a single call. Mirrors `seo-intel export --full <project>` as an MCP tool, with a sharp safety valve and an explicit "do not blind-ingest" notice.

- **`export_intel(project, tables?, max_rows_per_table?)`** — bulk JSON export. Free tables: `pages, keywords, headings, links, technical, sitemap_urls`. Paid (Solo) tables: `extractions, analyses, page_schemas, citability_scores, insights`. Per-table row cap (default 1000, max 50000) so big projects can't OOM Node on `JSON.stringify`.
- **The notice field is the design point.** Every response includes a top-level `notice` with `level: important|critical`, token estimate, byte size, and a clear instruction set: *"🛑 DO NOT INGEST THIS RESPONSE WHOLESALE. (1) write to file and query with jq/sqlite-utils, (2) use get_intel(for=audit|blog|competitor) for digests, (3) for pre-parsed analysis upgrade to Solo."* Free users see the list of paid tables they're missing + the Solo tool names that return digests instead of raw rows.
- Truncation is first-class: `counts: { pages: { total: 3422, returned: 1000, truncated: true } }`. Notice flips to `critical` whenever any table truncates, with the explicit "re-call with `max_rows_per_table: <N>` or `tables: ['specific_one']`" guidance.
- Verified: carbium full free export = 1.2 MB / 314k tokens with 6 tables truncated — still fits the safety valve, won't crash Node. Free-tier `analyses` request → clean paid gate. Small slices (e.g. `tables: ['technical']` on risunouto) → tiny notice, no truncation.

**The strategy this lands:** free tier offers the firehose with explicit guardrails ("hiccup with tokens or pay €20"). Paid tools (`run_citability_audit`, `get_competitor_positioning`, `prescore_draft`, `draft_blog_prompt`, `get_intel(for=audit|blog|competitor)`) return *digested, AI-ready* output — the value-add for Solo subscribers vs raw-data parsing on the client side.

**MCP surface: 13 tools total** — 9 free (including export_intel for free-table subset) + 5 paid (including export_intel for paid tables).

## 1.5.30 (2026-05-17)

### MCP — paid analysis tools (the full Solo surface for AI agents)
Solo subscribers can now reach the full analysis layer from any MCP host, not just the dashboard. Four new tools, all paid, all wrap existing `analyses/*` modules — same library-first pattern.

- **`run_citability_audit(project, include_competitors?)`** — Run AEO scoring across all crawled pages (6 signals: entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage). Persists scores to `citability_scores` and upserts `citability_gap` insights into the ledger. Pure function — fast, no LLM calls. Returns target/competitor page counts, average score, top 20 low-score pages.
- **`get_competitor_positioning(project)`** — Latest positioning analysis (from analyze runs or agent ingests) + per-competitor crawl stats (page counts, keyword counts, last crawl). The strategic narrative + the raw coverage in one envelope.
- **`prescore_draft(draft_md)`** — Pre-publish AEO scorer for agent-written content. Same scorer the dashboard uses; takes markdown (frontmatter-aware) and returns 0–100 score, tier, signal breakdown, AI intents. Includes revision hints for sub-60 drafts. Pair with `draft_blog_prompt` for a write→score→revise loop.
- **`draft_blog_prompt(project, topic?, lang?, content_type?)`** — Assemble an AEO-aware prompt seeded with the project's keyword gaps, citability gaps, entities, brand voice, and competitor heading patterns. The agent's own flagship LLM (Opus 4.7 / GPT-4o / Gemini) writes the draft. Supports `en` and `fi`. Topic optional — if omitted, prompt asks the LLM to pick the highest-leverage topic from gap data.

**MCP surface now:** 12 tools total — 8 free (read raw data, trigger crawls, persist findings) + 4 paid (`get_intel` audit/blog/competitor slices, `run_citability_audit`, `get_competitor_positioning`, `prescore_draft`, `draft_blog_prompt`). Paid tools share a unified gate message that surfaces the Ahrefs/Semrush price comparison.

A Solo agent session now looks like: `run_citability_audit` → `get_competitor_positioning` → `draft_blog_prompt(topic)` → agent's LLM writes the draft → `prescore_draft(output)` → revise if < 60 → `ingest_insight` to persist the gap that motivated the draft. Closed loop, all via MCP, no dashboard required.

### Deferred
- `run_gap_intel` (Ollama-based, long-running) — deferred to v1.5.31 where it'll use the detached-spawn pattern from `run_crawl`.

## 1.5.29 (2026-05-17)

### MCP — `ingest_insight` closes the loop (agents become collaborators, not consumers)
The MCP server now accepts write-back. An agent can read your raw data, do its own analysis with its own flagship LLM, and persist findings into the Intelligence Ledger — surviving across sessions, surfacing in the dashboard, deduplicating against future runs.

- **`ingest_insight(project, type, data, agent_name?)`** — **free tier**. The agent's LLM did the analysis; we just provide storage. Allowed types mirror what `analyze` writes: `keyword_gap`, `long_tail`, `quick_win`, `new_page`, `content_gap`, `technical_gap`, `positioning`.
- **Dedup contract**: same `(project, type, fingerprint)` returns the existing row with `deduped: true` and bumps `last_seen` — no duplicate accumulation across sessions.
- **Provenance**: source is stored as `agent:<name>` (e.g. `agent:claude-opus-4-7`) when `agent_name` is supplied, else just `agent`. Also stamped into the `data` JSON blob as `_source` for downstream consumers that only read `data`.
- **Schema**: idempotent `ALTER TABLE insights ADD COLUMN source TEXT DEFAULT 'cli'` — existing rows backfill to `'cli'`; analyze-time writes stay as `'cli'`; agent writes flip to `'agent:*'`. Safe on existing DBs.

### Logo
- Updated product logo to the sharp / soft-corners v1 variant. Size dropped 1.46 MB → 953 KB. Dashboard favicon + npm package both pick up the new asset.

## 1.5.28 (2026-05-17)

### MCP — agents can now trigger crawls and watch progress
The MCP server gains its first **active** tools — agents move from read-only to actually doing work on the user's machine.

- **`run_crawl(project, stealth?, max_pages?)`** — spawn a crawl as a detached subprocess. Returns immediately with `{ started, pid, command, hint }`. Free tier — crawl page limits still apply (Solo unlocks unlimited). Refuses to start if any seo-intel job is already running (conflict guard mirrors the existing HTTP `/api/crawl` behaviour).
- **`get_crawl_status()`** — read the most recent job's progress: status (`running` / `completed` / `crashed` / `stopped` / `idle`), command, project, pid, timestamps. PID liveness is verified — a "running" job whose process died gets re-tagged as `crashed`.

A natural session now looks like: agent calls `run_crawl(carbium)` → polls `get_crawl_status()` every minute → once `completed`, calls `get_intel(carbium, for=raw)` and `get_pages(carbium)` to see new data. Free tier, end to end.

### Internal — shared progress reader
`server.js` and `mcp/server.js` now both read job state from `lib/progress.js` (the canonical implementation, with PID liveness detection). Eliminates a duplicate `readProgress()` and ensures any future progress-file schema changes propagate automatically.

## 1.5.27 (2026-05-16)

### MCP — three new free-tier read tools
The MCP server (`seo-intel-mcp`) now exposes individual records, not just summaries. AI agents can drill from inventory into actual pages, keywords, and heading structures without leaving the agent chat.

- **`get_pages(project, role?, limit?, offset?)`** — paginated page list with url, title, word count, status, click depth, and domain role. Filterable by role (target / owned / competitor). Returns total count for pagination math.
- **`list_keywords(project, domain?, limit?)`** — top extracted keywords grouped by domain + location (title / h1 / h2 / meta / body). Use to surface what each site is targeting before running gap analysis.
- **`get_headings(project, url, limit?)`** — heading structure (H1–H6) for a specific page. Returns ordered `{ level, text }` list. Useful for content-architecture comparisons between target and competitor pages.

All three are **free tier** — no license required. Pairs naturally with the existing `list_projects` and `get_intel(raw)` to give AI agents a complete free-tier read surface: list projects → inspect inventory → drill into pages → read headings → analyze with the agent's own flagship LLM.

Errors are returned as proper MCP `isError: true` responses with helpful guidance (e.g. `get_headings` on an unknown URL points the agent at `get_pages`).

## 1.5.26 (2026-05-16)

### New — MCP server (`seo-intel-mcp`)
- SEO Intel now ships a Model Context Protocol server. Any MCP-capable AI host (Claude Code, Cursor, Cline, Continue, Zed) can call seo-intel's local SQLite intelligence as native tools — no API keys to manage, no remote servers to host, all data stays on your machine.
- Install for Claude Code: `claude mcp add seo-intel "npx seo-intel-mcp"`
- Stdio transport — the host spawns the server as a subprocess; zero infrastructure.
- Tools shipped in this release:
  - `list_projects` (**free**) — every configured project on this machine + crawled page count
  - `get_intel(project, for?)` — wraps `seo-intel intel`. `for=raw` is free; `for=audit|blog|competitor` require an SEO Intel Solo license. When unlicensed, returns a clean MCP error with the upgrade message instead of silent failure.
- Both tools return structured JSON the agent's LLM can chain — e.g. an agent can call `list_projects` then `get_intel(project=X, for=raw)` and analyse the raw inventory with its own flagship model, no extra prompting needed.
- New dependency: `@modelcontextprotocol/sdk ^1.29.0`.

## 1.5.25 (2026-05-16)

### New — `seo-intel intel <project>` — canonical agent-facing entry point
- Returns structured project intelligence as JSON or markdown — the single source of truth that upcoming MCP server, dashboard, and prompt-copy modal will all wrap (one function, four surfaces).
- Slices:
  - `--for=raw` (**free**) — page/keyword/heading/schema/sitemap inventory per domain. Pipe into your own AI agent for self-service analysis.
  - `--for=audit` (paid) — citability scores + active insights ledger
  - `--for=blog` (paid) — keyword gaps + long tails + drafting hints
  - `--for=competitor` (paid) — competitor summary + keyword matrix + positioning
- `--format=json` for agents; `--format=md` for humans / agent context windows
- Paid slices use the existing `requirePro()` gate — free users see a standard upgrade message; paid users get the data.
- New library: `lib/intel.js` exports `getIntel(db, project, opts)` + `intelToMarkdown(envelope)` for reuse from any surface.

## 1.5.24 (2026-05-16)

### Dashboard — projects with owned subdomains + sitemap data no longer vanish
- Fixed: clicking **Analyse** (or any dashboard refresh) made projects with crawled sitemaps disappear from the panel list. The render-time "merge owned subdomains into target" pass deleted `domains` rows without first clearing the new `sitemap_urls` FK, hit `FOREIGN KEY constraint failed`, and the project was silently dropped from the rendered HTML.
- The merge now clears `sitemap_urls` for owned subdomains inside the savepoint (rollback at end of render still restores everything — on-disk data is never mutated).
- Wrapped the merge in try/catch so the savepoint always releases — future tables that add a `domain_id` FK can't poison subsequent renders.
- Fixed: `getSchemaBreakdown` crashed on extractions whose `schema_types` JSON contained a nested array (e.g. `[..., ["SoftwareApplication","WebAPI"], ...]`). Now flattens one level and skips non-string entries instead of throwing.

## 1.5.23 (2026-04-23)

### Technical Audit — extended-data checks
- New `seo-intel tech-audit <project>` command — runs technical SEO validation off the crawl DB
- Findings: title length, meta description length, noindex detection (meta + `X-Robots-Tag`), redirect chains, indexable-but-not-in-sitemap, redirect-target cross-reference
- `--head` pass runs bounded-concurrency HEAD checks against sitemap URLs (flags 3XX / 4XX)
- Gated under the `extended-data` banner — same tier surface as other audit extensions

### Crawler — new signal capture
- Captures final URL after redirects (`page.url()`)
- Walks the Playwright redirect chain and persists it as JSON
- Reads `X-Robots-Tag` response header (no-index detection now covers meta **and** header)
- Sitemap URLs discovered during crawl are persisted to a new `sitemap_urls` table

### Schema
- `pages` table gains `final_url`, `redirect_chain`, `x_robots_tag` (additive `ALTER TABLE`, safe on existing DBs)
- New `sitemap_urls` table for the HEAD-check inventory pass

### Accumulated since last changelog (1.5.3–1.5.22)
- LM Studio extraction backend + auto-discovery
- Scan command auto-resolves `www` when bare domain is unreachable
- Intelligence modules: intent scores, schema impact, rich-result probability
- Nav-link detection for external sites + missing-www redirect warning
- Solo audit prompt rewrite — no more hallucinated competitors
- Scan/serve/dashboard resilience fixes

## 1.5.2 (2026-04-11)

### Unified Export
- Merged dev/content/ai-pipeline profiles into a single unified export
- One file, all actionable sections: scorecard → fixes → content strategy → reference
- Removed profile picker — just choose format (MD/JSON/CSV/ZIP) and download
- Cleaner filenames: `carbium-2026-04-11.md` instead of `carbium-dev-2026-04-11.md`

## 1.5.1 (2026-04-11)

### Setup Wizard
- Fixed Playwright detection on macOS — now checks correct browser cache paths instead of legacy node_modules location
- Added persistent "Open Dashboard" link in wizard header, visible on all setup steps
- Renamed floating helper card to "Agentic Installations" with extended per-runtime setup prompts
- Cloud model cards now show live connection status (Connected via API key or OpenClaw gateway)
- OpenClaw gateway model detection with authenticated `/v1/models` query

### Extraction: LAN host model fix
- Fixed LAN/fallback hosts checking for wrong model (used stale `OLLAMA_FALLBACK_MODEL` instead of project-selected model)
- All Ollama hosts now use the project's configured extraction model consistently
- Added `OLLAMA_HOSTS` support — comma-separated LAN hosts from setup wizard are picked up by extractor

### Dashboard
- Stealth toggle moved next to Crawl button (only affects crawl, not extract)
- Analysis buttons (Analyze, Brief, Keywords, Templates) get subtle blue accent border
- Visual separator between action and intelligence command groups

## 1.5.0 (2026-04-10)

### Export: dashboard data, not raw DB dumps
- **Complete rewrite** of export endpoint — now exports the same processed data the dashboard shows
- Dev export: technical scorecard, quick wins, technical gaps, internal link stats, watch alerts
- Content export: keyword gaps, long-tails, new pages, content gaps, positioning, citability issues
- AI Pipeline: all actionable sections combined in structured JSON
- ~14 KB dev export instead of ~200 KB of competitor bloat
- No more raw link/heading/schema/keyword dumps — every item is an action

## 1.4.9 (2026-04-10)

### Security
- Fixed arbitrary file write via `--out` query param in dashboard terminal API — write paths now server-controlled only
- Fixed path traversal in froggo config loader — project names validated to `[a-z0-9_-]`
- Added project name validation to export and terminal API endpoints

### URL Normalization
- Pages are now normalized before storage: fragments stripped (`/#pricing` → `/`), `index.html` collapsed
- Internal link targets also normalized for consistent orphan/link analysis
- Re-crawl to clean up existing fragment duplicates in your database

## 1.4.8 (2026-04-10)

### Export: own site only, zero competitor bloat
- ALL profile sections now filter to own site (target/owned) — no competitor pages, links, headings, or AEO scores
- Keywords export shows gap summary only: keywords competitors use that you don't, with who uses them
- AEO export shows only low-scoring own pages (<60) that need improvement
- Technical export was already own-site; removed the AI pipeline exception that bypassed filtering

## 1.4.7 (2026-04-09)

### Export: profiles are actions only
- Removed schemas from all export profiles — pure inventory, not actionable
- "No schema" issues already surfaced in technical section
- Raw Full Export (ZIP) still includes everything for data access

## 1.4.6 (2026-04-09)

### Export: rich actionable content
- Insights export now renders type-specific tables (quick wins show issue + fix + impact, keyword gaps show coverage, etc.)
- Schema markup export scoped to own site only — no competitor schema dumps
- SKILL.md updated with export profiles documentation

## 1.4.5 (2026-04-09)

### Export: actionable summaries only
- Technical export: per-page issue summary (own site only) — lists specific problems per URL
- Links export: per-page link issue summary (own site only) — orphan pages, missing anchors, excessive external links
- No more raw data dumps in profile exports — every row is an action item

## 1.4.4 (2026-04-08)

### Export Profiles
- New profile-based export: Developer, Content, and AI Pipeline profiles
- Each profile filters to actionable data only — no raw database dumps
- Developer profile: technical issues, heading problems (own site only), orphan links, schema gaps
- Content profile: keyword gaps, long-tail opportunities, citability issues, content gaps
- AI Pipeline profile: structured JSON with all actionable sections for LLM consumption
- Heading export collapsed to per-page issue summaries (missing H1, duplicate H1, skipped levels)
- Empty sections automatically skipped in exports
- Profile picker UI in dashboard sidebar with format selector (MD, JSON, CSV, ZIP)

## 1.4.3 (2026-04-07)

### Dashboard: Export & Download
- Per-card download buttons (Markdown, JSON, CSV) on every dashboard card
- "Download All Reports (ZIP)" in export sidebar
- New `/api/export/download` endpoint with section filtering

### Improvements
- GSC data loader picks most recently modified folder (fixes stale folder selection)
- Report filenames use `YYYY-MM-DD` dates instead of Unix timestamps
- Setup wizard: multi-host Ollama support (`OLLAMA_HOSTS` env var)
- Skill file and Agent Guide updated with `watch`, `blog-draft`, and export features

### Cleanup
- Removed deprecated agentic setup banner from wizard
- Consolidated Agent Guide into `skill/` directory

## 1.4.2 (2026-04-05)

### New Feature: Site Watch
- `seo-intel watch <project>` — detect changes between crawl runs and track site health
- Health Score (0-100) based on page errors, missing titles, missing H1s
- Diff engine detects 10 event types: new/removed pages, status changes, title/H1/meta changes, word count shifts, indexability flips, content updates
- Events classified by severity: critical, warning, notice — with trend arrows
- Auto-runs after every crawl with a one-liner summary
- Dashboard card: health score gauge, severity counts with deltas, "What's New" event table
- Significant changes (critical/warning) feed into Intelligence Ledger as `site_watch` insights
- Available via CLI, dashboard terminal, and froggo.js API
- Free tier — no license required

## 1.4.1 (2026-04-03)

### Fixes
- **CLI JSON output** — all 11 commands now produce clean JSON with zero chalk/ANSI leakage
- **Brief `--format json`** — full rich data (keyword gaps, schema gaps, actions) instead of lean subset
- **Templates `--format json`** — suppressed chalk header and log output in JSON mode
- **JS-Delta `--format json`** — suppressed per-page progress chalk in JSON mode

### Agent Integration
- Model selection hints (`modelHint`, `modelNote`) on extract, gap-intel, blog-draft capabilities
- AGENT_GUIDE.md — added Model Selection Guidance table (light-local vs cloud-medium per phase)
- GitHub Releases now auto-created on tag push via CI

## 1.4.0 (2026-04-03)

### New Feature: Gap Intelligence
- `seo-intel gap-intel <project>` — topic/content gap analysis against competitors
- Extracts topics from your pages and competitor pages via Ollama
- Fuzzy set comparison identifies coverage gaps with substring matching
- LLM-powered prioritisation ranks gaps by traffic potential and difficulty
- Options: `--vs <domains>`, `--type docs|blog|landing|all`, `--limit <n>`, `--raw`, `--format`, `--out`
- Available from dashboard terminal and CLI (Pro feature)

### New Default: Gemma 4 Models
- **Gemma 4 e4b** is now the default extraction model (was Qwen 3 4B)
- Four extraction tiers: e2b (budget, 46 t/s), e4b (balanced, 23 t/s), 26b (quality), 31b (power)
- Two analysis tiers: 26b (recommended 11GB+ VRAM), 31b (16GB+ VRAM)
- Qwen models remain fully supported as alternatives
- Setup wizard, model recommendations, and VRAM tiers updated for Gemma 4

### Agent-Ready JSON Output
- All 11 analysis commands support `--format json` for clean, parseable output
- JSON output is chalk-free — no ANSI escape codes mixed into structured data
- Commands: shallow, decay, headings-audit, orphans, entities, schemas, friction, brief, velocity, templates, js-delta

### Programmatic API (`seo-intel/froggo`)
- Unified agent runner: `run(command, project, opts)` returns `{ ok, command, project, timestamp, data }`
- 18 capabilities with machine-readable manifest (inputs, outputs, dependencies, tier)
- Pipeline dependency graph for orchestration
- Model selection hints per capability (light-local vs cloud-medium)
- Deep imports: `seo-intel/aeo`, `seo-intel/crawler`, `seo-intel/db`, etc.
- Agent Guide (`AGENT_GUIDE.md`) with orchestration patterns and model guidance

### Server
- Added `gap-intel` to terminal command whitelist
- Forward `--vs`, `--type`, `--limit`, `--raw`, `--out` params from dashboard to CLI

## 1.3.1 (2026-04-02)

### Fixes
- **AI Citability Audit** now renders output in dashboard export viewer (was showing "No output")
- AEO command accepts `--format markdown|json|brief` for structured output
- Dashboard export viewer captures stderr — command errors are now visible instead of silent

### CI
- Added job-level timeout (15 min) — prevents 6-hour runaway jobs
- Cross-platform path handling — Windows CI no longer fails on backslash paths
- Playwright auto-installed for mock crawl test
- Step-level timeouts on crawl, setup wizard, and server tests

## 1.3.0 (2026-04-01)

### New Feature: AEO Blog Draft Generator
- `seo-intel blog-draft <project>` — generate AEO-optimised blog post drafts from Intelligence Ledger data
- Gathers keyword gaps, long-tails, citability insights, entities, and top citable pages
- Builds structured prompt with 10 AEO signal rules for maximum AI citability
- Pre-scores generated draft against AEO signals before publishing
- Options: `--topic`, `--lang en|fi`, `--model gemini|claude|gpt|deepseek`, `--save`
- Pro feature gated via Lemon Squeezy license

### Dashboard
- New "Create" section in export sidebar with interactive draft generator
- "Create a Draft" dropdown: select type (Blog Post / Documentation), topic, language, then generate
- "AI Citability Audit" button added to export sidebar — run AEO from dashboard
- Both `aeo` and `blog-draft` commands now available via dashboard terminal

### Server
- Added `aeo` and `blog-draft` to terminal command whitelist
- Forward `--topic`, `--lang`, `--model`, `--save` params from dashboard to CLI

## 1.2.6 (2026-03-31)

### Critical Fix
- **Ship analysis, extraction, and AEO modules in npm package** — these were gitignored as "proprietary" from the Froggo era but are required for `extract`, `analyze`, `aeo`, `templates`, and dashboard generation
- npm users can now run the full pipeline without missing module errors
- Files added to git: `analyses/aeo/`, `analyses/templates/`, `analysis/`, `extractor/`
- Removed stale "NOT shipped in free npm package" comment from cli.js
- Deleted local `froggo-package/` directory

## 1.2.5 (2026-03-31)

### Skill / OpenClaw
- SKILL.md updated for v1.2 — added AEO, Keywords, Intelligence Ledger, all analysis commands
- Added AEO workflow section with citability signals and AI query intent docs
- Added DB query examples for citability + keyword cross-analysis
- Fixed hardcoded DB path to relative `./seo-intel.db`
- Removed stale froggo references from description

### Fixes
- Fix wizard upgrade URLs — all now point to `ukkometa.fi/en/seo-intel/` (was missing `/en/`)

## 1.2.4 (2026-03-31)

### Fixes
- Fix favicon serving — explicit `Content-Type: image/png` header prevents browser showing cached favicon from crawled sites
- Favicon link tag now cache-busts on dashboard regeneration

## 1.2.3 (2026-03-28)

### Dashboard
- Remove redundant Crawl/Extract buttons from status bar — terminal already has them
- Status bar now shows only Stop, Restart, and Stealth toggle (cleaner UI)
- Fix stealth toggle scoping in multi-project dashboard — each project panel reads its own toggle
- Stop button now clears crashed processes (dead PIDs) instead of showing stale "running" state

## 1.2.0 (2026-03-28)

### AEO — AI Citability Audit (new feature)
- **New command: `seo-intel aeo <project>`** (alias: `citability`) — score every page for how well AI assistants can cite it
- Per-page citability score (0-100) computed from 6 signals: entity authority, structured claims, answer density, Q&A proximity, freshness, schema coverage
- AI Query Intent classification per page: synthesis, decision support, implementation, exploration, validation
- Tier breakdown: excellent (75+), good (55-74), needs work (35-54), poor (<35)
- Signal strength analysis — identifies your weakest citability signals site-wide
- Compares target vs competitor citability scores with delta
- Low-scoring pages automatically feed into Intelligence Ledger as `citability_gap` insights
- Dashboard: new "AI Citability Audit" card with stat bar, signal strength bars, and page score table
- Runs on existing crawl data — zero new network calls, zero Ollama required
- `--target-only` flag to skip competitor scoring
- `--save` flag to export `.md` report

## 1.1.12 (2026-03-28)

### Intelligence Ledger
- Analysis insights now **accumulate across runs** instead of showing only the latest
- New `insights` table with fingerprint-based dedup — re-running `analyze` adds new ideas without losing old ones
- Dashboard shows all active insights: 65 long-tails, 36 keyword gaps, 23 content gaps (vs 4 from latest-only)
- Done/dismiss buttons on every insight card — mark fixes as done, dismiss irrelevant suggestions
- `POST /api/insights/:id/status` endpoint for status toggling (active/done/dismissed)
- Keywords Inventor also persists to Intelligence Ledger via `keywords --save`

### Improvements
- Prompt and raw output files now save as `.md` with YAML frontmatter (Obsidian-compatible)
- Long-tail Opportunities moved to Research section where it belongs
- Migrated all existing prompt `.txt` files to `.md` with frontmatter

## 1.1.11 (2026-03-27)

### Fixes
- Extraction now preflights Ollama hosts at run start and only uses live hosts during crawl/extract
- Dead fallback hosts no longer poison the run or trigger noisy repeated circuit-breaker fallback spam
- Degraded mode messaging is clearer and only activates when no live extraction host remains
- Extractor timeout errors now include host/model/timeout context

## 1.1.10 (2026-03-27)

### Security
- Fix SSRF: llms.txt URLs now respect robots.txt before enqueue (crawler/index.js)

### Fixes
- SQL injection audit complete — all queries use parameterised statements (no changes needed)

### Testing
- Mock crawl test passes end-to-end: crawls http://localhost:19876, stores 7 pages in SQLite
- CI: Ubuntu job now runs mock crawl test after smoke checks
- Fixed mock-crawl-test.js: server binds to 127.0.0.1, CLI resolved from install root, DB assertions corrected

## 1.1.9 (2026-03-27)

### Security
- Fix shell injection risk in Gemini CLI integration (execSync → spawnSync + stdin)
- Fix SSRF vector in llms.txt URL processing (hostname validation)
- Fix SSRF: llms.txt URLs now respect robots.txt before enqueue
- Set license cache file permissions to 0600 (owner-only)
- SQL injection audit — all queries verified to use parameterised statements

### Fixes
- Crawler no longer upgrades http://localhost to https (fixes local/mock testing)
- Updater cache moved to ~/.seo-intel/ (fixes permission errors on Linux global install)
- Clear actionable error when Gemini times out and OpenClaw gateway is down
- Project name passed to error context for timeout messages

### Improvements
- Defensive logging when license variant name is unrecognised
- Setup wizard: Cloud Analysis column (gemini-3.1-pro, claude-sonnet-4-6, claude-opus-4-6, gpt-5.4, deepseek-r1) with API key input
- Setup wizard: Agentic Setup picker — OpenClaw, Claude Code, Codex CLI, Perplexity with tailored copy-paste prompts
- Setup wizard: Step 2 expanded to 1100px, OpenClaw as floating sidebar

## 1.1.7 (2026-03-26)

### New
- **Programmatic Template Intelligence** (`seo-intel templates <project>`) — detect URL pattern groups (e.g. `/token/*`, `/blog/*`), stealth-crawl samples, overlay GSC data, and score each group with keep/noindex/improve verdicts
- **Stale domain auto-pruning** — domains removed from config are automatically cleaned from DB on next crawl
- **Manual prune** — `seo-intel competitors <project> --prune` to clean stale DB entries on demand
- **Full body text storage** — crawler stores full page content in DB for richer offline extraction

### Improvements
- **Background crawl/extract** — long-running jobs survive browser tab close
- **Dashboard terminal** — stealth flag visible, stop button works properly, status bar syncs
- **Templates button** added to dashboard terminal panel
- **Dashboard refresh** — crawl and analyze always regenerate full multi-project dashboard
- **Config remove = DB remove** — `--remove` and `--remove-owned` auto-prune matching DB data

### Fixes
- SSE disconnect no longer kills crawl/extract processes
- Terminal command display shows `--stealth` flag when enabled

## 1.1.6 (2026-03-24)

- Stop button for crawl/extract jobs in dashboard
- Stealth toggle sync between status bar and terminal
- Extraction status bar layout improvements (CSS grid)
- EADDRINUSE recovery — server opens existing dashboard instead of crashing

## 1.1.5 (2026-03-21)

- Update checker, job stop API, background analyze
- LAN Ollama host support with fallback
- `html` CLI command, wizard UX improvements
