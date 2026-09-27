# SEO Intel

Local-first competitive SEO intelligence. Point it at your site + competitors, get keyword gaps, content audits, and visual dashboards. All data stays on your machine.

**Crawl → Extract (local AI) → Analyze (computed facts + narrow model judgments) → Dashboard**

```
Your site + competitors (Playwright crawler)
    ↓ structured extraction
Qwen 3.5 via Ollama (local, free)
    ↓ stored in
SQLite database (WAL mode)
    ↓ competitive analysis: gaps counted from the rows, quick wins and long
    ↓ tails from Search Console, technical gaps from the audit; a model is
    ↓ asked only narrow, schema-validated questions
Anthropic / OpenAI / Gemini / DeepSeek (your key) · Ollama (local) · Agent Harness or Gemini CLI (fallbacks)
    ↓ visual reports
Self-contained HTML dashboards (Chart.js)
```

## Quick Start

```bash
# Install globally
npm install -g seo-intel

# Run the setup wizard (auto-detects the Agent Harness for agent-powered setup)
seo-intel setup
```

The setup wizard handles everything: dependency checks, model selection, API keys, project configuration, and pipeline validation.

### Requirements

- **Node.js 22.5+** (uses built-in SQLite)
- **Ollama** with a Qwen model (for local extraction)
- **One API key** for analysis — Anthropic, OpenAI, Gemini or DeepSeek, each called over its own API with the key in `.env` — or none: a local Ollama model, the Agent Harness gateway or the Gemini CLI also work. `ANALYSIS_PROVIDER` (and `ANALYSIS_MODEL`) in `.env` say which one answers when more than one is available; the setup wizard writes both

### Manual Setup

```bash
npm install -g seo-intel
seo-intel setup --classic    # traditional CLI wizard
# or
seo-intel setup              # agent-powered if the Agent Harness is running
```

## Usage

```bash
# Full pipeline
seo-intel crawl myproject       # crawl target + competitors
seo-intel extract myproject     # local AI extraction (Ollama)
seo-intel analyze myproject     # competitive gap analysis (--provider / --model pick the judge, --no-model asks none)
seo-intel html myproject        # generate dashboard
seo-intel serve                 # open dashboard at localhost:3000

# Agentic exports — turn data into implementation briefs
seo-intel export-actions myproject --scope technical   # free: broken links, missing schemas, orphans
seo-intel export-actions myproject --scope all         # full: technical + competitive + suggestive
seo-intel competitive-actions myproject --vs rival.com # what competitors have that you don't
seo-intel suggest-usecases myproject --scope docs      # infer what pages/docs should exist
```

## Commands

**The line: everything about your own site is free. Solo adds your competitors.**

Analysis of your own site is free because a capable agent commoditizes one-shot
analysis anyway. The paywall sits on what you structurally can't do alone —
competitor synthesis, automation, and history — plus content production (blog
drafts and the content loop), the "do the work for me" step you reach only after
the free audit has shown its worth.

### Free — your own site, no page or project limits

| Command | Description |
|---------|-------------|
| `setup` | First-time wizard — auto-detects the Agent Harness for agent-powered setup |
| `scan <domain>` | One-shot full audit, no config needed — start here |
| `crawl-url <url>` | Ad-hoc crawl of any URL — no project, nothing saved |
| `crawl <project>` | Crawl target + competitor sites |
| `extract <project>` | Local AI extraction via Ollama / LM Studio |
| `aeo <project>` | AI Citability Audit — score every page across 7 signals |
| `rescore <project> <url>` | Verify a fix — before/after/delta on the raw-HTML score |
| `keywords <project>` | Keyword intelligence matrix |
| `html <project>` / `graph <project>` | Full dashboard and site-graph visualization |
| `watch <project>` | Site Watch — health score and change detection |
| `tech-audit <project>` | Technical SEO audit from crawl data |
| `templates` / `orphans` / `js-delta` | Template detection, orphan entities, JS-render delta |
| `schemas <project>` | Schema.org coverage analysis |
| `entity-audit <project>` | Organization / `sameAs` placement, canonical-profile, and reciprocal-link audit; add `--live` for redirect/profile checks |
| `triangulation <project>` | Proof matrix for embedded YouTube + GitHub source + `TechArticle`/`SoftwareSourceCode` schema |
| `gsc-platform <project> --input <file>` | Website vs verified platform-property query gaps; `--api` uses configured properties and the Google account connected with `seo-intel auth google` (`GSC_ACCESS_TOKEN` still works as an override) |
| `gsc-fetch <project>` | Pull Search Console data straight from the API — page×query daily (90 days), page and query daily history (16 months) — so `page-contract` decides from measured demand; needs `seo-intel auth google` |
| `gsc-inspect <project>` | Ask Google whether your pages are indexed — URL Inspection verdicts, coverage state and chosen canonical, stored locally; demand-first, quota-aware; feeds `review` and `list_problems` |
| `demand <project>` | Quick wins and long tails computed from your own Search Console rows — striking-distance queries with a CTR below the baseline, page-two queries, unserved long-tail demand; rule-sourced, so `review` lists them as opportunities; needs `gsc-fetch` |
| `geo <project>` | LLM retrieval audit for definitions, flat lists, typed code blocks, and optional live copy-control checks |
| `schema-audit <project>` | Schema type specificity: `Product` vs `SoftwareApplication`, and the `offers`/`price` fields Google actually requires |
| `backlink-import` / `backlink-audit <project>` | Import your Search Console links export; audit brand reclamation, followed vs nofollow, concentration, and unlinked pages, and say which source reported each link. `--live` recovers target URL and anchor text |
| `bing-links <project>` | Fetch the inbound links Bing Webmaster Tools reports into the same backlinks table, each with the page of yours it points at and its anchor text, which the Search Console export does not have. A link both sources report counts as corroborated. It is a sample of Bing's index, not a complete link profile. Quota-aware; needs `BING_WEBMASTER_API_KEY` |
| `review <project>` | Search Review — what needs your decision, what an agent may fix now, and what already works; `--url` folds per-page decisions in |
| `intel <project> --for raw\|audit\|blog\|graph` | Agent-ready intelligence slices |
| `export` / `export-actions --scope technical` | Raw data and technical action exports |
| `serve` / `status` / `update` / `guide` | Dashboard server, status, updates, guided walkthrough |

Every finding carries its provenance, whether a crawl rule, the competitor-analysis model or an agent produced it: `source {kind: rule|model|agent, model, prompt_version, rule_version, confidence}` on each problem from `list_problems` and each item in `review` / `search_review`. Only rule-sourced findings are marked safe for unattended fixes (`safe_now`); a model- or agent-sourced finding in the same category goes to `needs_input` flagged `Model-sourced finding (<model>): verify before acting.` The Intelligence Ledger also closes findings as the data changes — a rule finding a later complete run no longer detects becomes `resolved`, a model or agent finding expires 90 days after it was last emitted, and both return to `active` if detected again — while `done` and `dismissed` are never flipped by a re-run, because a person decided those.

### Solo (€19.99/mo · €199.99/yr · 14-day free trial · [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/))

| Command | Description |
|---------|-------------|
| **Competitors** | |
| `analyze <project>` | Competitive gap analysis, assembled section by section: keyword gaps and content-gap clusters are counted from the crawl, quick wins and long tails come from your Search Console rows (`demand`), technical gaps from the audit; a model is asked only narrow schema-validated questions — the intent and priority of each gap, the name of each cluster, pages to create, positioning. `--provider` / `--model` choose the judge (Anthropic, OpenAI, Gemini, DeepSeek with your key; Ollama locally; the Agent Harness or Gemini CLI as fallbacks), `--no-model` writes the computed sections alone. Every section carries its provenance into the Ledger |
| `gap-intel <project>` | Topic/content gaps vs competitors |
| `shallow <project>` | Find "shallow champion" pages to outrank |
| `decay <project>` | Find stale, decaying competitor content |
| `headings-audit <project>` | Competitor H1-H6 structure analysis |
| `entities <project>` | Entity coverage gaps vs competitors |
| `friction <project>` | Competitor intent/CTA mismatch targets |
| `competitive-actions <project>` | Competitive gap export with `--vs domain` |
| `suggest-usecases <project>` | Infer missing pages from competitor patterns |
| `intel <project> --for competitor` | Competitor digest for agents |
| **Automation** | |
| `run` | Smart scheduler — crawl next stale domain, analyze, exit |
| **History & trends** | |
| `brief <project>` | Crawl change brief — what changed since last run |
| `velocity <project>` | Publishing velocity — how fast each domain ships |
| `trends <project>` | Clicks decay and growth per page between the last two windows of Search Console data |
| **Content production** | |
| `blog-draft <project>` | AEO-optimised blog draft from the Intelligence Ledger |
| `loop <project>` | Content loop: top gap → draft → prescore → queue |

## Project Configuration

Create a project config in `config/`:

```json
{
  "project": "myproject",
  "context": {
    "siteName": "My Site",
    "url": "https://example.com",
    "industry": "Your industry description",
    "audience": "Your target audience",
    "goal": "Your SEO objective"
  },
  "target": {
    "domain": "example.com",
    "maxPages": 200,
    "crawlMode": "standard"
  },
  "competitors": [
    { "domain": "competitor1.com", "maxPages": 100 },
    { "domain": "competitor2.com", "maxPages": 100 }
  ]
}
```

Or use the setup wizard: `seo-intel setup`

### Managing Competitors

```bash
seo-intel competitors myproject                    # list all
seo-intel competitors myproject --add new-rival.com
seo-intel competitors myproject --remove old-rival.com
```

## Web Setup Wizard

```bash
seo-intel serve
# Open http://localhost:3000/setup
```

The 6-step web wizard guides you through:
1. **System Check** — Node, Ollama, Playwright, GPU detection
2. **Models** — VRAM-based model recommendations
3. **Project** — Target domain + competitors
4. **Search Console** — CSV upload or OAuth API
5. **Pipeline Test** — Validates the full pipeline
6. **Done** — Your first CLI commands

If the Agent Harness is running, you'll see an option for **agent-powered setup** that handles everything conversationally — including troubleshooting, dependency installation, and OAuth configuration.

## Model Configuration

### Extraction (local, free)

SEO Intel uses Ollama for local AI extraction. Edit `.env`:

```bash
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e4b         # recommended (MoE, needs 6GB+ VRAM)
OLLAMA_CTX=16384
```

Model recommendations by VRAM:
- **4-5 GB** → `gemma4:e2b` (MoE edge model)
- **6-10 GB** → `gemma4:e4b` (recommended)
- **12+ GB** → `gemma4:26b` (MoE, frontier quality)
- Also supported: `qwen3.5:4b`, `qwen3.5:9b`, `qwen3.5:27b`

### Analysis (your API key, a local model, or the Agent Harness)

The analysis (`analyze`, `keywords`, `scan`, `blog-draft`, `loop`) does not hand a model the whole dataset and hope. `analyze` counts what the rows can prove — keyword gaps and content-gap clusters from the crawl, quick wins and long tails from your Search Console rows, technical gaps from the audit — and asks a model only narrow questions with a closed JSON schema each (classify these forty gaps, name these clusters, propose pages, write the positioning). Every answer is validated against its schema and repaired once when it does not match; the provider's JSON mode is used where it has one. Each provider is called over its own API with the key in `.env`:

```bash
ANTHROPIC_API_KEY=your-key       # highest quality; ANTHROPIC_FALLBACKS=off keeps every answer on the exact model named
# or
OPENAI_API_KEY=your-key          # solid all-around
# or
GEMINI_API_KEY=your-key          # best value (~$0.01/analysis); without a key, gemini-* models go to the Gemini CLI
# or
DEEPSEEK_API_KEY=your-key        # budget option
# or none of the above:
ANALYSIS_PROVIDER=ollama         # a local model; OLLAMA_ANALYSIS_MODEL picks the tag (the judgments are small enough)
```

Which one answers: `--provider`; then a `--model` whose name points at a provider (`claude-*`, `gpt-*`, `gemini-*`, `deepseek-*`, an Ollama tag such as `deepseek-r1:14b` — the colon keeps it local — or the aliases `claude`, `gpt`, `gemini`, `deepseek`, `ollama`, `harness`, which mean a provider's default), so `--model claude` asks Claude this once even when `.env` names another provider; then `ANALYSIS_PROVIDER`; then the shape of `ANALYSIS_MODEL`; then the first key in `.env` in the order Anthropic, OpenAI, Gemini, DeepSeek; then the Agent Harness gateway if its token is found; then the Gemini CLI if it is installed. `ANALYSIS_TIMEOUT_MS` sets how long one request may take (two minutes by default; raise it for a large local model). The setup wizard writes `ANALYSIS_PROVIDER` and `ANALYSIS_MODEL`. `analyze --no-model` skips the model entirely and writes the computed sections as rule findings.

## Google Search Console

Upload your GSC data for ranking insights:

1. Go to [Google Search Console](https://search.google.com/search-console)
2. Export Performance data as CSV
3. Upload via the web wizard or place CSVs in `gsc/<project>/`

Query data no longer needs the export: connect your Google account with `seo-intel auth google` and run `seo-intel gsc-fetch <project>`, which pulls page×query, page and query rows straight from the Search Analytics API — every page at once, with real dates — and `page-contract` reads those first. Search Console links still come from the CSV export (`backlink-import`), because the Search Console API has no Links endpoint. The automated alternative is Bing Webmaster Tools' API: `seo-intel bing-links <project>` fetches the inbound links Bing reports, each with the target page and the anchor text the export never had. Bing's links come from Bing's own index, so they are a different sample from Google's and just as partial. `backlink-audit` reads rows from both sources, and a link both report is corroborated. And `seo-intel gsc-inspect <project>` asks Google the question no crawl can answer — has it indexed this page? — storing the URL Inspection verdict, coverage state and chosen canonical for your busiest pages first, within the API's 2,000-a-day quota, so `review` and `list_problems` show Google's fact rather than the crawl's inference. And `seo-intel demand <project>` turns the fetched rows into quick wins and long tails — the queries already within reach whose snippet or page-two position is leaving clicks behind, and the phrases people search that no page of yours answers — replacing the keyword-volume estimates a paid index sells with the demand Google actually measured for your site; `review` lists them under opportunities.

## License

### Free Tier
- **Unlimited projects and unlimited pages per domain** — no caps
- Everything about your own site: crawl, local AI extraction, AI Citability Audit
  (AEO), keyword intelligence, dashboards, site graph, Site Watch,
  technical audit, Search Console insights, demand quick wins, backlink audit from Search Console and Bing, and 27 of the 39 MCP tools

### Solo (€19.99/mo · €199.99/yr · 14-day free trial)
- Competitor synthesis — gap analysis, positioning, keyword battleground,
  shallow/decay/entity/friction attacks, competitor exports and digests
- Automation — the smart scheduler (`run`)
- History and trends — crawl change brief, publishing velocity, Search Console traffic trends (`trends`)
- Content production — AEO blog drafts (`blog-draft`) and the content loop (`loop`)

```bash
# Set your license key
echo "SEO_INTEL_LICENSE=SI-xxxx-xxxx-xxxx-xxxx" >> .env
```

Get a key at [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/)

## Updates

```bash
seo-intel update              # check for updates
seo-intel update --apply      # auto-apply via npm
```

Updates are checked automatically in the background and shown at the end of `seo-intel status`.

## Security

- All data stays local — no telemetry, no cloud sync
- Scraped content is HTML-stripped and sanitized before reaching any model
- Extraction outputs are validated against schema before DB insert
- API keys are stored in `.env` (gitignored)
- OAuth tokens stored owner-only (`0600`) in `~/.seo-intel/tokens/`, outside the package directory and any git checkout

## Agent Harness Integration

If you have the Agent Harness installed (it plugs into Hermes, Claude Code, Cursor, or any MCP host):

```bash
seo-intel setup              # auto-detects gateway, uses agent
seo-intel setup --agent      # require agent setup
seo-intel setup --classic    # force manual wizard
```

The Agent Harness provides:
- Conversational setup with real-time troubleshooting
- Automatic dependency installation
- Smart model recommendations
- Security update notifications

---

Built by [ukkometa.fi](https://ukkometa.fi) — local-first SEO intelligence.

## Hermes

The `hermes/seo-intel/` folder is an Agent Plugins v1 package, so Hermes installs SEO Intel straight from GitHub. It is a folder of its own rather than the repository root because Hermes security-scans the whole plugin root at install time, and a crawler codebase is not a plugin:

- **Hermes Desktop** — Capabilities → Plugins → Install from Git, paste `https://github.com/Ukkometa/seo-intel/tree/main/hermes/seo-intel`
- **Hermes CLI** — `hermes plugins install Ukkometa/seo-intel/hermes/seo-intel --enable`
- **From an npm install** — `seo-intel hermes install`

Hermes detects both halves. The agent half registers the SEO Intel skill and the MCP server (`npx -y seo-intel-mcp`). The desktop half adds a Search Review pane and a status-bar chip; each item has a copyable fix and a "Send to agent" button that queues a Hermes brief. Enable the agent half (`hermes plugins enable seo-intel`) and switch the desktop half on under Capabilities → Plugins. The pane's backend shells out to your local `seo-intel` CLI, found through `~/.seo-intel/install.json`, `PATH`, or `npx`. See [hermes/README.md](hermes/README.md).
