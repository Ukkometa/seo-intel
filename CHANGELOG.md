# Changelog

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
