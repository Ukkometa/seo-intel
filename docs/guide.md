# SEO Intel - Competitive Intelligence Dashboard

> Crawl, extract, analyze, and outrank. A local-first SEO intelligence platform that turns competitor websites into actionable strategy.

---

## Quick Start

```bash
# 1. Create a project config
node cli.js setup --project mysite

# 2. Crawl everything (target + competitors)
node cli.js crawl mysite

# 3. Generate your dashboard
node cli.js html mysite
```

Open `reports/mysite-dashboard.html` in your browser. Done.

---

## How It Works

```
Config (JSON)  -->  Crawl (Playwright)  -->  Extract (Qwen3)  -->  Analyze (rules + model judgments)
                         |                       |                      |
                     pages table            extractions table      analyses table
                     links table            keywords table
                     headings table
                                                                       |
                                                         HTML Dashboard + Attack Reports
```

Every domain (your site + competitors) goes through the same pipeline:

1. **Crawl** - BFS spider discovers pages, stores HTML, status codes, word counts, load times
2. **Extract** - Local Qwen3 model pulls structured SEO signals from each page (title, intent, entities, CTAs, tech stack)
3. **Analyze** - Keyword gaps and content-gap clusters are counted from the crawl, quick wins and long tails come from your Search Console rows, technical gaps from the audit; a model (whichever provider you configured) is asked only narrow, schema-validated questions about them — intent and priority, cluster names, pages to create, positioning
4. **Report** - Interactive HTML dashboard with charts, or targeted attack reports

---

## Project Configuration

Each project lives in `config/<project>.json`. A project = your site + its competitors.

### Minimal Config

```json
{
  "project": "mysite",
  "context": {
    "siteName": "My Site",
    "url": "https://mysite.com",
    "industry": "SaaS project management tools",
    "audience": "Small team leads and freelancers",
    "goal": "Rank for project management keywords",
    "maturity": "early stage"
  },
  "target": {
    "url": "https://mysite.com",
    "domain": "mysite.com",
    "role": "target"
  },
  "competitors": [
    { "url": "https://competitor1.com", "domain": "competitor1.com", "role": "competitor" },
    { "url": "https://competitor2.com", "domain": "competitor2.com", "role": "competitor" }
  ]
}
```

### Full Config (with owned properties)

If you have subdomains (blog, docs, etc.) that you also want crawled:

```json
{
  "project": "mysite",
  "context": {
    "siteName": "My Site",
    "url": "https://mysite.com",
    "industry": "SaaS project management tools",
    "audience": "Small team leads and freelancers",
    "goal": "Rank for project management keywords",
    "maturity": "growth stage",
    "site_architecture": {
      "note": "Subdomains don't pass domain authority to root",
      "properties": [
        {
          "id": "main",
          "url": "mysite.com",
          "platform": "Next.js",
          "best_for": "Landing pages, product pages",
          "difficulty": "high"
        },
        {
          "id": "blog",
          "url": "blog.mysite.com",
          "platform": "Ghost CMS",
          "best_for": "Articles, tutorials, guides",
          "difficulty": "low"
        },
        {
          "id": "docs",
          "url": "docs.mysite.com",
          "platform": "Docusaurus",
          "best_for": "API docs, integration guides",
          "difficulty": "low"
        }
      ]
    }
  },
  "target": {
    "url": "https://mysite.com",
    "domain": "mysite.com",
    "role": "target"
  },
  "owned": [
    { "url": "https://blog.mysite.com", "domain": "blog.mysite.com", "role": "owned" },
    { "url": "https://docs.mysite.com", "domain": "docs.mysite.com", "role": "owned" }
  ],
  "competitors": [
    { "url": "https://competitor1.com", "domain": "competitor1.com", "role": "competitor" },
    { "url": "https://competitor2.com", "domain": "competitor2.com", "role": "competitor" },
    { "url": "https://competitor3.com", "domain": "competitor3.com", "role": "competitor" }
  ]
}
```

### Config Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `project` | Yes | Unique identifier, used in filenames and DB |
| `context.siteName` | Yes | Display name for reports |
| `context.industry` | Yes | Given to the analysis model as project context, with `audience`, `goal` and `maturity` |
| `context.audience` | Yes | Target audience description |
| `context.goal` | Yes | Primary SEO objective |
| `context.maturity` | Yes | `pre-launch` / `early stage` / `growth stage` / `established` |
| `target` | Yes | Your main site (one per project) |
| `owned` | No | Additional properties you control (subdomains, microsites) |
| `gsc.property` | No | Search Console property `gsc-fetch` pulls from (`sc-domain:example.com` or `https://www.example.com/`); matched to `target.domain` when omitted |
| `competitors` | Yes | Sites you're competing against (2-10 recommended) |

---

## Running Multiple Projects

### Adding a New Project

```bash
# Interactive wizard
node cli.js setup --project newsite

# Or create config/newsite.json manually
```

### Crawling Individual Projects

```bash
# Full crawl (target + all competitors)
node cli.js crawl mysite

# Target site only (skip competitors)
node cli.js crawl mysite --target-only

# Specific domain from the config
node cli.js crawl mysite --domain competitor1.com

# Limit crawl scope
node cli.js crawl mysite --max-pages 50 --max-depth 3

# Crawl without running extraction (faster, extract later)
node cli.js crawl mysite --no-extract
```

### Generating Dashboards

```bash
# Single project dashboard
node cli.js html mysite
# Output: reports/mysite-dashboard.html

# All projects in one dashboard (dropdown switcher)
node cli.js html-all
# Output: reports/all-projects-dashboard.html
```

The multi-project dashboard includes a dropdown at the top to switch between projects instantly - no page reload. Charts and visualizations rebuild on switch.

---

## Commands Reference

### Core Pipeline

| Command | Description | Example |
|---------|-------------|---------|
| `setup` | Interactive project creation wizard | `node cli.js setup --project mysite` |
| `crawl <project>` | Crawl target + competitors | `node cli.js crawl mysite` |
| `extract <project>` | Run AI extraction on crawled pages | `node cli.js extract mysite` |
| `analyze <project>` | Competitive analysis: computed sections plus narrow model judgments. `--provider <name>` (anthropic, openai, gemini, deepseek, ollama, harness, gemini-cli), `--model <id or alias>`, `--no-model` (computed sections only, nothing asked) | `node cli.js analyze mysite --provider anthropic --model claude-opus-5` |
| `html <project>` | Generate single-project dashboard | `node cli.js html mysite` |
| `html-all` | Generate multi-project dashboard | `node cli.js html-all` |
| `serve` | Start dashboard web server with live controls | `node cli.js serve --port 3000` |

Which model judges: `--provider` wins; then a `--model` whose name points at a provider (`claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → the Gemini API when `GEMINI_API_KEY` is set and the Gemini CLI otherwise, `deepseek-*` → DeepSeek, an Ollama tag with a colon such as `gemma4:26b` or `deepseek-r1:14b` → Ollama; the aliases `claude`, `gpt`, `gemini`, `deepseek`, `ollama`, `harness` mean that provider's default model), so a one-off `--model claude` is honoured even though the wizard wrote `ANALYSIS_PROVIDER`; then `ANALYSIS_PROVIDER` in `.env`; then the shape of `ANALYSIS_MODEL`; with none of these, the first key in `.env` (Anthropic, OpenAI, Gemini, DeepSeek in that order), then the Agent Harness gateway, then the Gemini CLI. A request that takes longer than `ANALYSIS_TIMEOUT_MS` (120000 by default) fails with a hint to raise it. Set `ANALYSIS_PROVIDER` and `ANALYSIS_MODEL` once — the setup wizard writes both — and every command that asks a model uses them.

### Attack Strategies

| Command | What It Finds | Strategy |
|---------|--------------|----------|
| `shallow <project>` | Thin competitor pages (important but low word count) | Publish 1500+ word outrank pages |
| `decay <project>` | Stale competitor content (18+ months old) | Publish fresh 2026 alternatives |
| `orphans <project>` | Entities mentioned everywhere with no dedicated page | Build focused pillar pages |
| `friction <project>` | Competitor pages with CTA/intent mismatch | Build low-friction alternatives |
| `headings-audit <project>` | Competitor heading structures | Find content gaps in page structure |

### Research & Monitoring

| Command | Description | Example |
|---------|-------------|---------|
| `keywords <project>` | Generate keyword cluster matrix through the same provider layer as `analyze` (`--provider`, `--model`; the answer is held to a schema) | `node cli.js keywords mysite --count 120 --save` |
| `gsc-fetch <project>` | Pull your Search Console data from the API into the database (page×query 90 days; page and query daily 16 months); needs `seo-intel auth google` | `node cli.js gsc-fetch mysite --dry-run` |
| `gsc-inspect <project>` | Ask Google whether it has indexed your pages (URL Inspection API) and store each verdict, coverage state and chosen canonical; demand-first, 2,000 per property per day; `review` and `list_problems` read it | `node cli.js gsc-inspect mysite --url https://example.com/page` |
| `demand <project>` | Quick wins and long tails from your own Search Console rows (needs `gsc-fetch`): striking-distance queries whose CTR is under the position baseline or that sit on page two, and phrases of 3+ words with no page on page one; rule-sourced, so `review` lists them under opportunities | `node cli.js demand mysite --window 28 --format json` |
| `trends <project>` | Clicks decay and growth per page between the last two same-length windows of Search Console data; decays are filed as `gsc_decay` (Solo) | `node cli.js trends mysite --format json` |
| `report <project>` | Print latest analysis to terminal | `node cli.js report mysite` |
| `status` | Show crawl freshness + extraction progress | `node cli.js status` |
| `run` | Smart cron: crawl next stale domain | `node cli.js run` |

---

## Crawl Options

### Standard Crawl

```bash
node cli.js crawl mysite
```

- Respects `robots.txt`
- BFS discovery from homepage + sitemap
- Incremental: skips pages with unchanged content (SHA-256 hash)
- Automatic extraction via Qwen3 after crawling
- Exponential backoff on 429/503/403 responses

### Stealth Mode

For sites with aggressive bot detection (Cloudflare, Akamai, etc.):

```bash
# Full pipeline in stealth
node cli.js crawl mysite --stealth

# Extraction only in stealth (re-fetch known pages)
node cli.js extract mysite --stealth
```

Stealth mode includes:
- Persistent browser session with cookie accumulation
- Realistic browser fingerprint (WebGL, canvas, plugins)
- `navigator.webdriver` override
- Jittered delays (2-5 seconds between requests)
- Bypasses `robots.txt` (use responsibly)

**When to use stealth:**
- Sites returning 403 on standard crawl
- Cloudflare "checking your browser" pages
- Sites that serve different content to bots

---

## Automated Scheduling

### Cron Setup

The `run` command is designed for cron. It crawls one stale domain per invocation and exits:

```bash
# Every 6 hours - crawl next stale domain
0 */6 * * * cd /path/to/seo-intel && node cli.js run >> logs/cron.log 2>&1
```

This cycles through all domains across all projects, keeping everything fresh without hammering any single site.

### Monitoring

```bash
node cli.js status
```

Shows:
- Live extraction progress (if running)
- Process liveness via PID check
- Days since last crawl per domain
- Extraction coverage percentage
- Last job summary

---

## Output Files

### Reports Directory

| File | Size | Content |
|------|------|---------|
| `<project>-dashboard.html` | ~370KB | Interactive single-project dashboard |
| `all-projects-dashboard.html` | ~430KB | Multi-project dashboard with switcher |
| `<project>-analysis-<date>.json` | ~15KB | The analysis (keyword gaps, long tails, quick wins, content gaps, new pages, technical gaps, positioning) plus a `pipeline` receipt: provider, model, per-section source, judgments run, failures |
| `<project>-keywords-<ts>.json` | ~25KB | Keyword cluster matrix (traditional + AI) |
| `<project>-headings-audit-<ts>.md` | ~10KB | Competitor heading structure analysis |
| `<project>-judgments-<date>.json` | ~30KB | Every judgment's system prompt, prompt, answer or failure (for auditing what the model was asked and said) |

### Database

All data lives in `seo-intel.db` (SQLite). Key tables:

| Table | Purpose |
|-------|---------|
| `domains` | Registered domains with roles and freshness timestamps |
| `pages` | Every crawled URL with status, word count, load time, content hash |
| `extractions` | Qwen3 AI extraction per page (title, intent, entities, CTAs, pricing) |
| `keywords` | Keywords found per page with location (title, h1, h2, meta, body) |
| `headings` | Full heading tree per page (h1-h6) |
| `links` | Internal and external links with anchor text |
| `technical` | Technical SEO signals (canonical, OG, schema, mobile, CWV) |
| `analyses` | Analysis results per project; `model` records `provider:model` for the provider that answered, or `rules-only` |

---

## Typical Workflows

### New Project - Full Setup

```bash
# 1. Create config
node cli.js setup --project bakery

# 2. Edit config/bakery.json - add competitors
# 3. Initial crawl (takes 10-30 min depending on site sizes)
node cli.js crawl bakery

# 4. Check what we got
node cli.js status

# 5. Run the analysis (the configured provider judges; --no-model for the computed sections alone)
node cli.js analyze bakery

# 6. Generate dashboard
node cli.js html bakery

# 7. Find quick wins
node cli.js shallow bakery
node cli.js decay bakery
node cli.js friction bakery
```

### Adding a Competitor Mid-Flight

```bash
# 1. Edit config/bakery.json - add the new competitor to the array
# 2. Crawl just that domain
node cli.js crawl bakery --domain newcompetitor.com

# 3. Re-run analysis (now includes the new competitor)
node cli.js analyze bakery

# 4. Regenerate dashboard
node cli.js html bakery
```

### Re-Extracting After Model Upgrade

If you update Qwen3 or want to re-extract everything:

```bash
# Extraction reads from the already-crawled HTML
# No need to re-crawl
node cli.js extract bakery
```

### Keyword Research Sprint

```bash
# Generate 200 keywords, commercial focus, save to file
node cli.js keywords bakery --count 200 --intent commercial --save

# Output includes three keyword types:
#   traditional - "best bakery POS system" (Google search style)
#   perplexity  - "what POS system do bakeries use?" (AI search style)
#   agent       - "bakery POS with inventory sync under $100/mo" (agent query style)
```

---

## Multi-Project Dashboard

When managing multiple sites (e.g., your own portfolio or client sites), the multi-project dashboard gives you one HTML file with instant switching:

```bash
# Make sure all projects have been crawled
node cli.js crawl carbium
node cli.js crawl ukkometa
node cli.js crawl risunouto

# Generate the combined dashboard
node cli.js html-all
```

The dropdown at the top lists all projects found in `config/*.json`. Charts destroy and rebuild on switch to handle Chart.js canvas lifecycle correctly.

---

## Live Dashboard Server

The dashboard includes Crawl, Extract, and Stealth controls. To use them, start the built-in server:

```bash
node cli.js serve
# → http://localhost:3000

# Custom port
node cli.js serve --port 8080
```

**What you get:**
- Dashboard served at `http://localhost:3000` (auto-detects `all-projects-dashboard.html`)
- **Crawl button** — triggers `crawl <project>` as a background process
- **Extract button** — triggers `extract <project>` as a background process
- **Stealth toggle** — adds `--stealth` flag to either command
- **Live progress ticker** — polls every 2 seconds, updates the status bar in real-time (page count, current URL, completion)

**API endpoints (for custom integrations):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET /` | Serve the dashboard HTML |
| `GET /api/progress` | Current job status (running/completed/idle/crashed) |
| `GET /api/projects` | List configured projects |
| `POST /api/crawl` | Start crawl `{ "project": "mysite", "stealth": true }` |
| `POST /api/extract` | Start extract `{ "project": "mysite", "stealth": true }` |

**Static fallback:** When opened as a `file://` (double-click), the buttons gracefully degrade to show "Run `node cli.js serve` for live controls."

Only one job runs at a time. If you try to start a second crawl/extract while one is running, the server returns 409 Conflict.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CRAWL_MAX_PAGES` | 100 | Max pages to crawl per domain |
| `CRAWL_MAX_DEPTH` | 5 | Max BFS click depth from homepage |
| `ANALYSIS_PROVIDER` | inferred | Which provider answers the analysis judgments: `anthropic`, `openai`, `gemini`, `deepseek`, `ollama`, `harness`, `gemini-cli`. Unset: inferred from the model id, then the first key present, then the Agent Harness, then the Gemini CLI |
| `ANALYSIS_MODEL` | provider default | Model id (`claude-opus-5`, `gpt-4o-mini`, `gemini-2.0-flash`, `deepseek-chat`, an Ollama tag) or alias; the setup wizard writes it |
| `ANTHROPIC_FALLBACKS` | on | `off` keeps every Anthropic answer on the exact model named instead of letting a declined request run on a server-side fallback model |
| `ANALYSIS_TIMEOUT_MS` | `120000` | How long one model request may take, for every provider; raise it for a large local model. Unset, `GEMINI_TIMEOUT_MS` / `OPENCLAW_TIMEOUT_MS` still apply to the Gemini and Agent Harness transports |
| `OLLAMA_ANALYSIS_MODEL` | `gemma4:26b` | The Ollama tag for analysis judgments (distinct from `OLLAMA_MODEL`, the extraction model) |
| `OLLAMA_ANALYSIS_CTX` | 16384 | Context window (`num_ctx`) for Ollama analysis calls; the judgments are small |

Override per-run with flags:

```bash
node cli.js crawl mysite --max-pages 200 --max-depth 4
```

---

## Architecture

```
seo-intel/
  cli.js                    # Main CLI entry point (all commands)
  server.js                 # Dashboard web server (live controls API)
  seo-intel.db              # SQLite database (auto-created)
  config/
    carbium.json            # Project configs (one per site)
    ukkometa.json
    risunouto.json
  crawler/
    index.js                # BFS crawler (Playwright-based)
    stealth.js              # Stealth evasion module (16+ techniques)
  extraction/
    qwen-extract.js         # Qwen3 structured extraction
  analysis/
    run-analysis.js         # Assembles one analysis: computed sections + judgments, with a receipt per section
    deterministic.js        # Keyword gaps, content-gap clusters, Search Console sections, technical gaps (pure arithmetic)
    judgments.js            # The narrow model tasks, each with a closed JSON schema (JUDGMENT_VERSION)
  lib/
    providers.js            # The one place that calls a model: Anthropic, OpenAI, Gemini, DeepSeek, Ollama, Agent Harness, Gemini CLI
    schema-check.js         # One schema in every provider's dialect, and the client-side validation
  reports/
    generate-html.js        # Dashboard generator (single + multi-project)
    *.html                  # Generated dashboards
    *.json                  # Analysis and keyword outputs
  docs/
    guide.md                # This file
```

---

## Tips

- **Start small**: 2-3 competitors is enough. More competitors = longer crawls but richer analysis.
- **Use `--no-extract` for initial exploration**: Crawl first, check `status`, then extract when you're happy with coverage.
- **Stealth is a last resort**: Standard crawling respects sites and is faster. Only use `--stealth` when sites actively block you.
- **Re-analyze after fresh crawls**: Analysis quality depends on extraction freshness. Run `analyze` after significant new data.
- **The `run` command is your friend**: Set it on cron and forget. It rotates through all domains keeping everything fresh.
- **Keyword types matter**: Traditional keywords for Google SEO, perplexity keywords for AI search visibility, agent keywords for LLM-powered tool discovery.

---

*Built with Playwright, Qwen3, Chart.js, and SQLite; the analysis judgments go to whichever model you configure — a cloud provider with your key, or Ollama on your own machine. Designed to run locally with zero cloud dependencies for crawling and extraction.*
