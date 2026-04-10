# Changelog

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
