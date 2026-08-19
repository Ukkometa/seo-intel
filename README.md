# SEO Intel

Local-first competitive SEO intelligence. Point it at your site + competitors, get keyword gaps, content audits, and visual dashboards. All data stays on your machine.

**Crawl → Extract (local AI) → Analyze (cloud AI) → Dashboard**

```
Your site + competitors (Playwright crawler)
    ↓ structured extraction
Qwen 3.5 via Ollama (local, free)
    ↓ stored in
SQLite database (WAL mode)
    ↓ competitive analysis
Gemini / Claude / GPT (your API key)
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
- **One API key** for analysis: Gemini (recommended), Claude, OpenAI, or DeepSeek

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
seo-intel analyze myproject     # competitive gap analysis
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
analysis anyway. The paywall sits on what you structurally can't do alone:
competitor synthesis, automation, and history.

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
| `blog-draft <project>` | AEO-optimised blog draft from the Intelligence Ledger |
| `loop <project>` | Content loop: top gap → draft → prescore → queue |
| `html <project>` / `graph <project>` | Full dashboard and site-graph visualization |
| `watch <project>` | Site Watch — health score and change detection |
| `tech-audit <project>` | Technical SEO audit from crawl data |
| `templates` / `orphans` / `js-delta` | Template detection, orphan entities, JS-render delta |
| `schemas <project>` | Schema.org coverage analysis |
| `entity-audit <project>` | Organization / `sameAs` placement, canonical-profile, and reciprocal-link audit; add `--live` for redirect/profile checks |
| `triangulation <project>` | Proof matrix for embedded YouTube + GitHub source + `TechArticle`/`SoftwareSourceCode` schema |
| `gsc-platform <project> --input <file>` | Website vs verified platform-property query gaps; `--api` uses configured properties + `GSC_ACCESS_TOKEN` |
| `geo <project>` | LLM retrieval audit for definitions, flat lists, typed code blocks, and optional live copy-control checks |
| `intel <project> --for raw\|audit\|blog\|graph` | Agent-ready intelligence slices |
| `export` / `export-actions --scope technical` | Raw data and technical action exports |
| `serve` / `status` / `update` / `guide` | Dashboard server, status, updates, guided walkthrough |

### Solo (€19.99/mo · €199.99/yr · 14-day free trial · [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/))

| Command | Description |
|---------|-------------|
| **Competitors** | |
| `analyze <project>` | Full competitive gap analysis |
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

### Analysis (cloud, user's API key)

You need at least one API key in `.env`:

```bash
GEMINI_API_KEY=your-key          # recommended (~$0.01/analysis)
# or
ANTHROPIC_API_KEY=your-key       # highest quality
# or
OPENAI_API_KEY=your-key          # solid all-around
# or
DEEPSEEK_API_KEY=your-key        # budget option
```

## Google Search Console

Upload your GSC data for ranking insights:

1. Go to [Google Search Console](https://search.google.com/search-console)
2. Export Performance data as CSV
3. Upload via the web wizard or place CSVs in `gsc/<project>/`

## License

### Free Tier
- **Unlimited projects and unlimited pages per domain** — no caps
- Everything about your own site: crawl, local AI extraction, AI Citability Audit
  (AEO), keyword intelligence, blog drafts, dashboards, site graph, Site Watch,
  technical audit, Search Console insights, and 20 of the 22 MCP tools

### Solo (€19.99/mo · €199.99/yr · 14-day free trial)
- Competitor synthesis — gap analysis, positioning, keyword battleground,
  shallow/decay/entity/friction attacks, competitor exports and digests
- Automation — the smart scheduler (`run`)
- History and trends — crawl change brief, publishing velocity

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
- OAuth tokens stored in `.tokens/` (gitignored)

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
