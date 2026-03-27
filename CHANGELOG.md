# Changelog

## 1.1.8 (2026-03-27)

- Rebranded all references from froggo.pro → ukkometa.fi (endpoints, dashboard links, license validation, bot user-agents, skill)
- Pricing updated: €9.99/mo · €79/yr
- Contact updated: ukko@ukkometa.fi
- Added README.md and CHANGELOG.md to npm package and LS zip

## 1.1.7 (2026-03-26)

### New Features
- **Programmatic Template Intelligence** (`seo-intel templates <project>`) — detect URL pattern groups (e.g. `/token/*`, `/blog/*`), stealth-crawl samples, overlay GSC data, and score each group with keep/noindex/improve verdicts. Pro-gated.
- **Stale domain auto-pruning** — domains removed from config are now automatically cleaned from the DB (pages, keywords, extractions, schemas, headings, links) on next crawl. No more ghost data from renamed/removed subdomains.
- **Manual prune** — `seo-intel competitors <project> --prune` to clean stale DB entries on demand.
- **Full body text storage** — crawler now stores full page body text in DB (up to 200K chars) for richer extraction and analysis. Log output stays compact.

### Improvements
- **Background crawl/extract** — long-running crawl and extract jobs now survive browser tab close. Terminal shows "backgrounded" instead of "disconnected", and jobs continue server-side.
- **Dashboard terminal** — stealth flag now visible in terminal command display. Stop button properly closes SSE + server-side process. Status bar syncs with terminal state.
- **Templates button** added to dashboard terminal panel.
- **Dashboard refresh** — crawl and analyze now always regenerate the multi-project dashboard, keeping all projects current.
- **Config remove = DB remove** — `--remove` and `--remove-owned` now auto-prune matching DB data, not just config JSON.

### Fixes
- SSE disconnect no longer kills crawl/extract processes (detached child process).
- Terminal command display now shows `--stealth` flag when enabled.

## 1.1.6 (2026-03-24)

- Stop button, stealth sync, extraction layout, EADDRINUSE recovery.

## 1.1.5 (2026-03-21)

- Update checker, job stop API, background analyze, LAN Ollama hosts, `html` CLI command, wizard UX improvements.

## 1.1.8 (2026-03-27)

- Rebranded all references from froggo.pro → ukkometa.fi (endpoints, dashboard links, license validation, bot user-agents, skill)
- Pricing updated: €9.99/mo · €79/yr
- Contact updated: ukko@ukkometa.fi
- Added README.md and CHANGELOG.md to npm package and LS zip
