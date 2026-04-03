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

# Run the setup wizard (auto-detects OpenClaw for agent-powered setup)
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
seo-intel setup              # agent-powered if OpenClaw is running
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

### Free

| Command | Description |
|---------|-------------|
| `setup` | First-time wizard — auto-detects OpenClaw for agent-powered setup |
| `crawl <project>` | Crawl target + competitor sites |
| `status` | System status, crawl freshness, license info |
| `html <project>` | Generate crawl-only dashboard |
| `serve` | Start local dashboard server (port 3000) |
| `export-actions <project> --scope technical` | Technical SEO audit from crawl data |
| `schemas <project>` | Schema.org coverage analysis |
| `update` | Check for updates |

### Solo (€19.99/mo · [ukkometa.fi/seo-intel](https://ukkometa.fi/en/seo-intel/))

| Command | Description |
|---------|-------------|
| `extract <project>` | Local AI extraction via Ollama |
| `analyze <project>` | Full competitive gap analysis |
| `export-actions <project>` | All export scopes (technical + competitive + suggestive) |
| `competitive-actions <project>` | Competitive gap export with `--vs domain` filter |
| `suggest-usecases <project>` | Infer what pages/features to build from competitor data |
| `keywords <project>` | Keyword gap matrix |
| `run <project>` | Full pipeline: crawl → extract → analyze → report |
| `brief <project>` | AI content briefs for gap topics |
| `velocity <project>` | Content publishing velocity tracker |
| `shallow <project>` | Find "shallow champion" pages to outrank |
| `decay <project>` | Find stale competitor content |
| `headings-audit <project>` | H1-H6 structure analysis |
| `orphans <project>` | Orphaned pages detection |
| `entities <project>` | Entity coverage gap analysis |
| `friction <project>` | Conversion friction detection |
| `js-delta <project>` | JS-rendered vs raw HTML comparison |

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

If [OpenClaw](https://openclaw.ai) is running, you'll see an option for **agent-powered setup** that handles everything conversationally — including troubleshooting, dependency installation, and OAuth configuration.

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
- 1 project, 500 pages/domain
- Crawl, extract, setup, basic reports

### Solo (€19.99/mo · €199.99/yr)
- Unlimited projects and pages
- All analysis commands, GSC insights, scheduling

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

## OpenClaw Integration

If you have [OpenClaw](https://openclaw.ai) installed:

```bash
seo-intel setup              # auto-detects gateway, uses agent
seo-intel setup --agent      # require agent setup
seo-intel setup --classic    # force manual wizard
```

The OpenClaw agent provides:
- Conversational setup with real-time troubleshooting
- Automatic dependency installation
- Smart model recommendations
- Security update notifications

---

Built by [ukkometa.fi](https://ukkometa.fi) — local-first SEO intelligence.
