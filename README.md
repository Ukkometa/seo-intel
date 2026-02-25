# seo-intel

Local Ahrefs-style SEO competitor intelligence.
**Crawl → SQLite → Cloud analysis.** No subscriptions.

## Architecture

```
Web pages (Playwright)
    ↓ sanitize / strip HTML
Qwen3-4B (local) → structured JSON extraction
    ↓
SQLite database
    ↓ keyword matrix + gap analysis
Gemini (1M ctx) → keyword gaps, long-tails, recommendations
    ↓
JSON report
```

## Setup

```bash
cd seo-intel
npm install
npx playwright install chromium
cp .env.example .env
# Fill in GEMINI_API_KEY if not using gemini CLI auth
```

## Usage

```bash
# Crawl Carbium + all competitors
node cli.js crawl carbium

# Crawl target only
node cli.js crawl carbium --target-only

# Crawl one specific domain
node cli.js crawl carbium --domain helius.dev

# Run analysis (sends to Gemini)
node cli.js analyze carbium

# Print latest report
node cli.js report carbium

# Ukkometa
node cli.js crawl ukkometa
node cli.js analyze ukkometa
```

## Projects

| Project | Target | Competitors |
|---|---|---|
| `carbium` | carbium.io | helius, quicknode, triton, alchemy, birdeye, vybe, jup, drift, okx |
| `ukkometa` | ukkometa.fi | Finnish web design agencies (update config/ukkometa.json) |

## Analysis outputs

- **keyword_gaps** — topics competitors cover, target doesn't
- **long_tails** — 25-40 long-tail phrases ranked by priority
- **content_gaps** — entire topic clusters missing
- **quick_wins** — existing pages to improve fast
- **new_pages** — specific new pages to create
- **technical_gaps** — schema, meta, structured data missing
- **positioning** — competitive positioning map + open angle

## Security (prompt injection)

Scraped content is:
1. HTML-stripped before reaching any model
2. Regex-sanitized for injection patterns
3. Wrapped in `<page_content>` delimiters
4. Qwen constrained to JSON output schema only
5. All outputs validated against schema before DB insert

## Model config

Edit `.env` to change local extraction model:
```
OLLAMA_URL=http://192.168.0.227:11434
OLLAMA_MODEL=qwen3:4b
OLLAMA_CTX=16384
```
