# Changelog

## Unreleased

### Claude Code plugin — install the MCP server *and* skill in one command
- Added a Claude Code plugin marketplace. Claude Code users can install seo-intel with `/plugin marketplace add Ukkometa/seo-intel` then `/plugin install seo-intel@ukkometa` — one step wires both the MCP server **and** the seo-intel skill, with no manual `claude mcp add` or config editing.
- The existing `claude mcp add seo-intel "npx seo-intel-mcp"` (and Cursor/Cline setup) still works unchanged.

## 1.5.51 (2026-06-11)

### Fixed — LM Studio extraction now actually works (it was silently degrading)
Local extraction via LM Studio never functioned: every page fell back to degraded (regex) mode, so entity-level signals (entity authority, intent, keywords) came back empty even when a model was loaded and serving. Four stacked bugs:

- **Preflight hit the wrong endpoint.** It probed `/api/v1/models` (LM Studio's *native* API, shape `{models:[{key}]}`) but parsed it as the OpenAI shape `{data:[{id}]}` — so it always concluded "no models loaded." Now uses the OpenAI-compatible `/v1/models`.
- **Inference hit the wrong endpoint.** It POSTed to `/api/v1/chat` (returns `400 'input' is required`). Now uses `/v1/chat/completions`.
- **Unsupported `response_format`.** It sent `{type:'json_object'}`, which LM Studio rejects (`must be 'json_schema' or 'text'`). Now sends `text` and relies on the existing JSON-extraction/repair pass.
- **A few bad pages disabled the whole model.** Content/parse failures (a small model returning unparseable JSON for one long page) were counted as host failures and retired the local model for the rest of the run. Now only *transport* failures (host unreachable/timeout/5xx) retire a host; a single unparseable page just degrades itself.

Point at a loaded LM Studio model with `LMSTUDIO_MODEL=<model-id>` (e.g. `google/gemma-4-e2b`). Note: very small models (≈2B) still struggle to emit clean JSON for very long pages — use a 4B+ extraction model (Gemma E4B, Qwen 3.5) for higher coverage, or see `seo-intel models`.

## 1.5.50 (2026-06-11)

### New MCP tool: `setup_project` — zero → configured → audited, entirely from chat
The last setup gap in chat-native coverage: projects could previously only be created via the CLI or web wizard. An AI agent can now take a user from nothing to a configured, crawled, audited project without leaving the conversation.

- **`setup_project(project_name, target_url, …)`** writes the same project config the wizard produces — target domain, competitors, owned domains, analysis context (industry / audience / goal), crawl budget, and extraction model. Pairs with `suggest_models` for picking the local model first.
- Refuses to overwrite an existing project unless `overwrite=true`.
- MCP server now exposes **21 tools**; the full lifecycle (set up → crawl → extract → audit → problems → fix → draft → re-audit) is reachable from any MCP host.
- Model catalog: cloud analysis entry refreshed to **Claude Opus 4.8**.

## 1.5.49 (2026-06-08)

### New skill: `seo-autofix` — autonomous audit → fix → verify loop
SEO Intel already reports each problem with a concrete fix **and** a verification recipe. This skill turns that into a closed loop an AI code agent runs against a repo it has checked out — with the human in exactly one place: merging and deploying the branch.

- **The loop:** `run_crawl` → `list_problems` → for each problem, map the affected URL to its source file, apply the `fix_template`, **verify against a local preview before deploying** (`crawl_site` against `localhost`), keep it only if the problem signal clears, then collect verified fixes on one branch and `mark_problem_status(fixed)`.
- **Autonomy gate:** only `fix_difficulty ≤ 2` (deterministic structural fixes — missing meta/title, missing JSON-LD, orphan links, noindex conflicts) are applied autonomously. Judgment-heavy problems (positioning, content rewrites) are summarized for the human, never auto-applied.
- **Hard rules:** verify every fix against a real crawl (a `fix_template` is guidance, the crawl is proof — unverified edits get reverted); one branch, no push to `main`, no deploy, no publishing. The blast radius is a branch the human reviews.
- Lives in `skills/seo-autofix/` — distributed via the repo / skill directories.

### Fixed
- **CLI starts in ~100ms instead of loading the browser engine up front.** `cli.js` statically imported the crawl engine (Playwright + the HTML→markdown chain) at startup, so every command — even `seo-intel --version` — paid that import, which could stall for minutes on a cold module cache. The crawler now loads on first use (`crawl` / `run` / `scan`); all other commands skip it entirely. Measured: `--version` went from 143s (worst case observed) to ~110ms.

## 1.5.48 (2026-06-07)

### Local-model suggester — `seo-intel models` + `suggest_models` (MCP)
Extraction runs a small AI model once per crawled page. This makes it easy to pick the right **local** one — and is emphatic that local is the way to do it.

- **`seo-intel models`** — detects your GPU/VRAM and which models are already in Ollama, then recommends from a curated local set: **Gemma 4 E2B / E4B / 12B** and **Qwen 3.5 4B / 9B** (smallest → largest, with VRAM/speed/quality and the `ollama pull` command for each). `--format json` for machine output.
- **`suggest_models` (MCP)** — the same recommendation from any chat/agent, so an assistant can suggest a model for the user's hardware.
- **Both always carry a disclaimer: extraction should be done with a LOCAL model.** Cloud is a fallback, not the default — it sends every page's content off-machine, costs money at scale, and rate-limits, all for a task a 4–8B local model handles well, offline, with data never leaving the machine.
- Added **Gemma 4 12B** to the extraction model catalog (a quality step up from E4B that still fits ~10 GB cards).

### Fixed
- **MCP server boot is no longer blocked by the crawler dependency chain.** The `crawl_site` tool's crawler (which pulls in `turndown`) is now loaded on first use instead of at startup. Previously, if importing `turndown` was slow on a given machine, the entire MCP server could fail to start — no tools, no banner, no handshake. Boot now completes in well under a second regardless of crawler import speed.
- **Commands no longer hang when the license or update servers are slow or unreachable.** Two startup network paths had no effective cap: the license phone-home was awaited without a hard timeout (blocking commands like `status` for up to ~10s), and background update-check fetches kept the process from exiting until the OS connect timeout. The license check is now capped at 2.5s and degrades to cached/offline behavior, and one-shot commands exit as soon as their work is done instead of waiting on lingering background requests. Activation still works normally when the server is reachable.

## 1.5.47 (2026-06-07)

### AI-crawler access is now part of AI citability — and the audit runs from your agent
A page can be perfectly structured and still be impossible for an AI assistant to cite — because `robots.txt` blocks the crawler. AEO now checks for exactly that.

- **New citability signal: AI-crawler access.** `seo-intel aeo <project>` fetches each target domain's `robots.txt` and detects whether answer-engine crawlers (ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, Google-Extended, Amazonbot, DuckAssistBot, and training crawlers like CCBot / Applebot-Extended) are allowed, plus the Cloudflare `Content-Signal: ai-train=no` directive. When the assistants developers actually use are locked out, the affected pages are **capped at 30/100** — on-page quality can't help a page the AI can't read. A new "AI Crawler Access" section appears in the audit, and a high-priority `citability_gap` is written to the Intelligence Ledger per blocked domain.
- The check is the only network call AEO makes (one `robots.txt` per target domain), it's best-effort, and a missing/unreachable `robots.txt` is treated as open. The pure scorer stays offline — robots verdicts are fetched separately and passed in.
- **New MCP tool `tech_audit`** — run the technical SEO audit (titles, meta, noindex/robots conflicts, redirects, canonicals, sitemap diff) straight from any MCP host, no shelling out to the CLI.
- **New MCP tool `scan_site`** (Solo) — one-shot full audit of any domain (crawl → extract → analyze → export) as a detached background job, mirroring `seo-intel scan`.
- **`run_citability_audit` (MCP)** now performs the same AI-crawler-access check and returns an `ai_access` verdict per domain.
- **Fix: `aeo` and `gap-intel` now emit clean JSON in `--format json`.** Both commands previously regenerated the dashboard after printing the JSON, and the dashboard step's progress logs (e.g. "Topic clusters loaded…") leaked onto stdout — breaking `JSON.parse` for agents and scripts. Dashboard regeneration is now skipped in JSON mode, so stdout contains only the JSON object.

## 1.5.46 (2026-05-29)

### Security — the local dashboard now accepts requests from localhost only
Hardened `seo-intel serve` against a class of browser-based attack that affects local web servers in general (cross-site request forgery and DNS rebinding). While the dashboard was running, a web page open in the same browser could send requests to `localhost` — and the command-stream endpoint additionally sent a wildcard `Access-Control-Allow-Origin`, which would have let such a page read its output.

- **Loopback-only gate:** every request is now checked at the door — the `Host` must be a loopback name (defeats DNS rebinding) and any `Origin` must be loopback too (blocks cross-origin / CSRF). Non-local requests get `403`.
- **Removed the wildcard `Access-Control-Allow-Origin: *`** from the terminal SSE stream — the dashboard is same-origin and never needed CORS.
- **Standard headers added:** `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (anti-clickjacking), `X-Content-Type-Options: nosniff`.

The server already bound `127.0.0.1` only; this adds the missing in-app checks. Same-origin dashboard use is unchanged. **Recommended update for anyone who runs `seo-intel serve`.**

## 1.5.45 (2026-05-29)

### The content loop in one command — `seo-intel loop` + `run_content_loop` (MCP)
Closes the loop from the agent's side: instead of running gap-finding, drafting, and scoring as separate steps, one invocation walks the whole content half — **rank the open gaps → draft the highest-leverage one → AEO-prescore → record it → queue for publish.**

- **CLI `seo-intel loop <project>`** (free): picks the top gap from the Intelligence Ledger (ranked by priority × source × AI-intent), drafts it with your chosen model, pre-scores citability, optionally auto-revises (`--revise k`) until it clears `--min-score`, marks the gap in-progress (the v1.5.42 write-back), and writes the approved draft to `reports/ready/<project>/`. Flags: `--topic`, `--count`, `--lang`, `--type`, `--model`, `--min-score`, `--revise`, `--no-queue`, `--dry-run`, `--format json`. `--dry-run` shows which gap it would target with no model call.
- **MCP `run_content_loop`** (free): the same ranking + selection, returned as a seeded draft prompt for the agent's own LLM (hand-back mode) — write the draft, then call `prescore_draft(project, topic)` to score and close the loop. `dry_run` to just see the target.
- New module `analyses/loop/orchestrator.js` (`runContentLoop`) backs both surfaces; the model writer is injectable so the CLI drives your cloud model while MCP hands the prompt to the agent.
- The queued draft carries front-matter (`status: ready`, score, tier, source gap) as a publish handoff — it does not auto-deploy.

## 1.5.44 (2026-05-29)

### New standalone skill: `ai-citability` — score AI citability with zero install, zero account
A drop-in Agent Skill (Claude Code / Cursor / Codex) that scores any page or draft 0–100 for how easily an AI assistant (ChatGPT, Claude, Perplexity, AI Overviews, Bing Copilot) can cite it — across the same six signals as the full AEO audit.

- **Truly self-contained:** pure Node, no `npm install`, no account, no API key, no network. Nothing is saved or sent. Drop the folder into your agent's skills directory and it works.
- **Markdown or HTML** input, from a file or stdin: `node scripts/score.mjs <file>` (add `--json` for machine output). The agent fetches the content however it likes — a local file, WebFetch, or the `crawl_site` MCP tool.
- Reports the overall score + tier, all six signal bars, the two weakest signals with concrete fixes, and funnels to the full `seo-intel aeo` audit for whole-site, entity-aware, historical scoring.
- Ships the exact scoring engine as the product (vendored from `analyses/aeo/scorer.js`), with a smoke-test drift guard so the standalone score never diverges from `seo-intel aeo`.
- Lives in `skills/ai-citability/` — distributed via the repo / skill directories, not the npm package.

## 1.5.43 (2026-05-29)

### New MCP tool: `crawl_site` — crawl any URL, no setup, no account, nothing saved
A zero-config crawl for any AI agent. Point it at a URL and it returns structured SEO/AEO data — no project to configure, no account, no API key, and nothing is persisted or sent anywhere.

- **Lightweight by design:** plain HTTP fetch (no browser, no Playwright download), same-origin BFS, honours `robots.txt` + crawl-delay, small page budget (default 10, hard cap 50). www/non-www and http/https are treated as the same site.
- **Returns per page:** title, meta description, canonical, indexability, headings, internal/external link counts, JSON-LD schema types, word count, and published/modified dates — plus a deduped list of discovered internal URLs.
- **Optional AI-citability (AEO) score** per page via `include_citability` (approximate in light mode — no entity extraction; run `seo-intel aeo` for the full score).
- **Knows its limits:** JavaScript-rendered / SPA pages under-report content (the response says so) — use `seo-intel crawl` (Playwright) for those, and install seo-intel for persistent history, the Intelligence Ledger, and competitor analysis.
- New modules: `crawler/light.js` (fetch crawler) + `crawler/html-extract.js` (pure regex HTML extraction, zero new dependencies).

## 1.5.42 (2026-05-29)

### The content loop now remembers its own work
Drafting a post used to leave the Intelligence Ledger untouched — so the same gap kept getting suggested even after you'd written about it. Now drafting closes that memory gap.

- **`blog-draft` writes back to the Ledger.** After a draft is generated and AEO-scored, SEO Intel records a `draft_created` insight and flips the matching gap(s) to `in_progress` — so they stop resurfacing until a re-audit re-scores the published page. Matching is precise (keyword/topic), and the write-back is best-effort: a Ledger hiccup never fails your draft.
- **MCP `prescore_draft` can close the loop too.** It gains optional `project` and `topic` arguments — pass them and the scored draft is recorded + matching gaps marked `in_progress`, identical to the CLI. Omit them for a pure, stateless score (unchanged default).
- When no `--topic` is given, the targeted gap is recovered from the draft's own frontmatter title or first H1.

### Fix — free-tier `blog-draft` no longer claims "no data" when you have citability gaps
`blog-draft`'s empty-state check only counted competitor-analysis gaps, so a free user whose gaps came from `aeo` (AI citability) or only from `keywords` could be wrongly told "No intelligence data found." It now counts citability and content gaps too, and points free users at `aeo` + `keywords` first (competitor gaps via `analyze` are Solo).

### Fix — MCP startup banner now reflects the real free/paid split
The `seo-intel-mcp` startup line (shown in your MCP host's logs) still listed `run_citability_audit`, `prescore_draft`, `draft_blog_prompt`, and `get_intel(audit/blog)` as paid. They've been free since 1.5.41 — the banner now says so, listing only competitor synthesis (`get_competitor_positioning`, `get_intel(competitor)`, the `analyses` export table) as Solo.

## 1.5.41 (2026-05-28)

### Your own site is now fully free — across CLI, MCP, and the dashboard
Everything SEO Intel can tell you about **your own** site is now available on the free tier: full crawl, AI Citability (AEO) scoring, keyword intelligence, programmatic template detection, orphan detection, JS-rendering delta, Search Console insights, blog-draft generation, and the complete dashboard. The daily problem-notification cron stays free too.

Solo (€19.99/mo) now focuses on the things a tool has to do that an AI agent can't do for itself:

- **Competitor synthesis** — gap analysis, keyword battleground, positioning, competitive landscape sections, and the competitor export/digest.
- **Automation** — the scheduled-crawl scheduler.
- **History & trends** — the crawl change brief ("what changed") and publishing velocity.

**CLI:** own-site commands (`aeo`, `keywords`, `templates`, `orphans`, `js-delta`, `blog-draft`, `gsc-insights`, `scan`, `extract`, `html`) no longer prompt to upgrade. `intel <project> --for=audit|blog` is free; `--for=competitor` is Solo.

**MCP:** `run_citability_audit`, `prescore_draft`, and `draft_blog_prompt` are now free tools. `export_intel` returns all own-site tables (pages, keywords, headings, links, technical, schemas, extractions, citability scores, and the Intelligence Ledger) for free; only the competitor gap-analysis history requires Solo. `get_competitor_positioning` remains Solo.

**Dashboard:** collapsed to a single template that gates sections individually — own-site analysis (citability, keyword inventor, top keywords, GSC insights, internal links, exports, drafts) renders on every tier; competitor and strategy sections render with Solo. The old separate free-tier dashboard codepath is gone.

## 1.5.40 (2026-05-28)

### Setup wizard — daily notifications now self-install
The notify loop is now opt-in via a single click. Setup-wizard's Done step gains a small "Daily problem notifications" card that toggles a managed `crontab` line via `lib/cron.js`. No more manual `crontab -e`.

- **New CLI:** `seo-intel install-cron [--schedule "0 9 * * *"] [--open] [--remove]` — install / replace / remove a managed cron line. Idempotent. macOS + Linux. Windows returns a clear "use Task Scheduler" message.
- **New library:** `lib/cron.js` exports `installNotifyCron`, `removeNotifyCron`, `getNotifyCronStatus`. Uses a `# managed-by-seo-intel` marker comment so we only touch our own entries — the user's other cron jobs are never modified.
- **Setup wizard card** (Step 6, Done): live status pill, one-click Enable/Disable button, default schedule 9am daily, intel-blue accent matching the visual brief tokens. Polls `/api/setup/cron` on step entry; toggle hits `/api/setup/cron POST { action: 'install'|'remove' }`.
- Cron line writes the absolute `process.execPath` so the scheduled job works regardless of the user's PATH inside cron's minimal environment (a classic foot-gun avoided).

Full lifecycle verified: status read → install (`0 9 * * *` line written, crontab confirms) → status reports installed → remove → crontab clean → status reports clean. Smoke 10/10.

## 1.5.39 (2026-05-27)

### Dashboard — Problems card as the landing surface (Ahrefs-style "what's broken")
The biggest UX shift since MCP shipped. Opening the dashboard now greets the user with a unified Problems card at the very top of every project panel — same data backing the `list_problems` MCP tool, finally surfaced for humans too.

- **New `buildProblemsCard()`** renders Ahrefs-style: big counters (Critical / Warn / Info) using the v1.5.33 visual-brief `.vb-score-big` numerals, top 12 issues table with severity dots, category, fix-difficulty stars (1–5), and an expandable "Fix" disclosure per row showing the agent-friendly `fix_template`.
- Single source of truth: same `getProblems()` library function that powers `list_problems` MCP tool. Dashboard and AI agents see identical data; closing one closes both.
- "Showing top 12 of 190 — query the rest via MCP: `list_problems("carbium", limit=190)`" — makes the agent escape hatch visible from the dashboard itself.
- Empty state: "all clear" message when no problems pending.

### Dashboard — AI Citability card polished to brief spec
- Inline colors (`#4ade80`, `#facc15`, `#ff8c00`, `#ef4444`) swapped to brief signal tokens (`var(--signal-good)`, `var(--signal-warn)`, `var(--signal-bad)`). One color system, no drift.
- Score gradient aligned with `lib/problems.js` severity buckets: ≥60 good, 35–59 warn, <35 bad.
- New `.vb-pill` header chip with the "weakest signal" caption ("weakest: answer density") so the user sees the headline takeaway at a glance.
- Existing signal bars + page-score table preserved — minimal disruption, maximum polish.

**Verified live against carbium / risunouto / ukkometa:** 36 severity dots rendered across three Problems cards, 3 MCP-hint references, citability cards on each pro panel, no existing functionality broken. Smoke 10/10. HTML size unchanged (2.4MB).

Next: setup-wizard cron-entry installer (v1.5.40), then per-page polish for Site Watch timeline / Competitive Radar / Action Export modal.

## 1.5.38 (2026-05-23)

### Fix — LM Studio model count was always 0 (wrong endpoint + wrong parser)
The wizard showed `localhost:1234 LM Studio · 0 model(s) active` even when LM Studio had models loaded. Two bugs stacked:

1. We were hitting `/api/v1/models` (LM Studio's native endpoint), not `/v1/models` (the OpenAI-compatible one).
2. Even on the native endpoint, the response shape is `{ models: [{ key, loaded_instances }] }` — we were parsing it as `{ data: [{ id }] }` (OpenAI shape), so even when the call succeeded, the filter zeroed everything out.

Fix in `setup/checks.js`:
- Try `/v1/models` first (standard OpenAI-compat, listed under LM Studio's "OpenAI-compatible" Developer tab).
- Fall back to `/api/v1/models` if the OpenAI route is disabled in LM Studio settings.
- Parse both shapes: `data.data` (OpenAI) and `data.models` (LM Studio native). Identifier extracted via first-of `id | key | model | name`.

Verified against the user's live LM Studio (3 models surfaced correctly — Gemma 4 E2B, an uncensored variant, and an embedding model). Smoke 10/10.

## 1.5.37 (2026-05-23)

### Notify — native macOS / Linux notifications for pending problems
The "subtle nudge" delivery channel agreed in the v1.5.34 brainstorm. Users don't have to remember to open the dashboard; the OS reminds them when there's work to do.

- **New CLI:** `seo-intel notify [project]` — scans configured projects (or one if specified), fires a native notification per project with critical/warn/info problem counts. Cron-friendly: no interactive output, never blocks, never throws. Pass `--open` to also open the dashboard URL after notifying.
- **macOS:** uses built-in `osascript` (Notification Center). Glass sound fires when any project has critical issues; quiet otherwise. No third-party deps (no `terminal-notifier` etc).
- **Linux:** uses `notify-send` (libnotify, ships with GNOME/KDE/XFCE). Falls through to console if not installed.
- **Windows/unknown:** console-prints the notification so cron logs still capture it.
- **New library:** `lib/notify.js` exports `notify({ title, message, subtitle?, sound? })` + `openUrl(url)`. Reusable from any future module (e.g. a Site Watch hook firing notifications on regressions).

**Suggested cron entry** (macOS): `0 9 * * * cd /path/to/seo-intel && node cli.js notify` — fires at 9am every day for every project with pending issues.

**Verified live:** 4 notifications fired correctly during testing (carbium 190 warn · 51 info; dgents 11 warn · 1 info; risunouto 26 warn · 11 info; ukkometa 55 warn · 20 info). All four landed in macOS Notification Center.

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
