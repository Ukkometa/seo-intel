# Changelog

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