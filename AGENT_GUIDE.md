# SEO Intel — Agent Integration Guide

Machine-readable guide for AI agents using SEO Intel as a module.

## Quick Start

```javascript
import { run, capabilities, pipeline } from 'seo-intel/froggo';

// Run any command — always returns structured JSON
const result = await run('aeo', 'myproject');
// → { ok: true, command: 'aeo', project: 'myproject', timestamp: '...', data: { scores, summary } }

// List all available capabilities
capabilities.forEach(c => console.log(c.id, c.description));

// Check dependency order
pipeline.graph['gap-intel']; // → ['crawl', 'extract']
```

## Pipeline Order

SEO Intel follows a strict dependency pipeline. Agents must respect this order:

```
Phase 1: COLLECT    crawl → pages + structure stored in SQLite
Phase 2: EXTRACT    extract → keywords, entities, intent, CTAs (requires Ollama)
Phase 3: ANALYZE    aeo, shallow, decay, entities, schemas, friction, etc.
Phase 4: REPORT     brief, velocity
Phase 5: CREATE     blog-draft, gap-intel
```

**Rules:**
- `crawl` must run before ANY analysis
- `extract` must run before: orphans, entities, friction, gap-intel, blog-draft
- `aeo` only needs crawl data (no extraction needed)
- `schemas` only needs crawl data
- Most analysis commands are independent — can run in parallel after dependencies met

## Model Selection Guidance

Use the right model tier for each phase — don't over-allocate:

| Phase | Task type | Recommended model | Why |
|-------|-----------|-------------------|-----|
| Extract | Structured data extraction | Light local: `gemma4:e2b` or `gemma4:e4b` | Pattern matching, not reasoning |
| Analyze (local) | AEO, schemas, decay, shallow | No model needed | Pure heuristics on crawl data |
| Analyze (LLM) | gap-intel, entities, friction | Light local: `gemma4:e4b` | Topic clustering, not deep reasoning |
| Synthesize | Strategic analysis, action plans | Cloud: Opus, Sonnet, GPT-4 | Needs real reasoning |
| Create | Blog drafts, content briefs | Cloud: Sonnet or equivalent | Creative + strategic |

**Principle:** Extraction is structured data work — use the lightest model that produces clean output. Reserve heavy models for synthesis and strategic reasoning.

## Command Reference

### Collect Phase

**`run('crawl', project)`**
Crawl target + competitor domains. Stores pages, metadata, schemas in SQLite.
- Requires: Playwright (browser automation)
- Options: `{ stealth: true, maxPages: 100, scope: 'full|new|sitemap' }`
- Note: Long-running (minutes). Returns when complete.

**`run('extract', project)`**
Extract SEO signals from crawled pages using local LLM.
- Requires: Ollama running with gemma4:e4b (or configured model)
- Options: `{ model: 'gemma4:e4b' }`
- Note: Processes all un-extracted pages. Can take 5-60 minutes.
- **Model guidance:** Use the lightest model that produces acceptable extraction quality. `gemma4:e2b` (6.7 GB) is sufficient for most extraction tasks and runs at ~47 t/s. `gemma4:e4b` (8.9 GB) is the balanced default. For cloud-based extraction, use the lightest available model — extraction is structured data work, not reasoning. Reserve heavier models (Opus, Sonnet, GPT-4) for analysis and gap synthesis.

### Analyze Phase

**`run('aeo', project)`** — AI Citability Audit
- Returns: `{ target: PageScore[], competitors: Map, summary: { avgScore, tierCounts, weakestSignals } }`
- Use when: Agent needs to know which pages AI search engines will/won't cite

**`run('shallow', project, { maxWords: 700 })`** — Shallow Champion Attack
- Returns: `{ targets: Page[], totalTargets }`
- Use when: Finding easy wins — thin competitor pages you can outwrite

**`run('decay', project, { months: 18 })`** — Content Decay
- Returns: `{ confirmedStale: Page[], unknownFreshness: Page[] }`
- Use when: Finding stale competitor content to replace with fresh versions

**`run('orphans', project)`** — Orphan Entity Attack
- Returns: `{ orphans: [{ entity, domains, suggestedUrl }] }`
- Use when: Finding content opportunities — entities competitors mention but nobody owns
- Requires: extraction data

**`run('entities', project)`** — Entity Coverage Map
- Returns: `{ gaps, shared, unique, summary }`
- Use when: Understanding semantic coverage vs competitors
- Requires: extraction data

**`run('schemas', project)`** — Schema Intelligence
- Returns: `{ coverageMatrix, gaps, exclusives, ratings, pricing, actions }`
- Use when: Auditing structured data / rich results competitive position

**`run('friction', project)`** — Intent Friction Analysis
- Returns: `{ targets: FrictionTarget[], totalAnalyzed }`
- Use when: Finding competitor pages with mismatched CTA/intent
- Requires: extraction data

**`run('velocity', project, { days: 30 })`** — Content Velocity
- Returns: `{ velocities: DomainVelocity[], period }`
- Use when: Comparing publishing rates across domains

**`run('gap-intel', project, { vs: ['competitor.com'] })`** — Topic Gap Analysis
- Returns: `{ report: 'markdown string with prioritised gaps' }`
- Use when: Finding what topics competitors cover that you don't
- Requires: Ollama for topic extraction

### Report Phase

**`run('brief', project, { days: 7 })`** — Weekly Intel Brief
- Returns: `{ competitorMoves, keywordGaps, schemaGaps, actions, period }`
- Use when: Getting a summary of what changed recently

### Export Phase

**`run('export-actions', project)`** — Technical fix list
**`run('competitive-actions', project)`** — Competitive action list
**`run('suggest-usecases', project)`** — AI-suggested pages to build
- All return: `{ actions: Action[] }` where Action has id, type, priority, title, why, evidence, implementationHints

### Create Phase

**`run('blog-draft', project, { topic: '...', lang: 'en' })`** — Blog Draft Generator
- Returns: `{ context, prompt }` — context is gathered data, prompt is ready for LLM

### Utility

**`run('insights', project)`** — Get active Intelligence Ledger items
**`run('status')`** — List all configured projects

## Agent Orchestration Patterns

### Full Site Audit
```javascript
// 1. Crawl
await run('crawl', project);
// 2. Extract (if Ollama available)
await run('extract', project);
// 3. Run all analyses in parallel
const [aeo, schemas, shallow, decay, entities, friction] = await Promise.all([
  run('aeo', project),
  run('schemas', project),
  run('shallow', project),
  run('decay', project),
  run('entities', project),
  run('friction', project),
]);
// 4. Generate actions
const actions = await run('export-actions', project);
// 5. Brief
const brief = await run('brief', project);
```

### Quick Competitive Check
```javascript
await run('crawl', project);
const [schemas, velocity] = await Promise.all([
  run('schemas', project),
  run('velocity', project),
]);
```

### Content Gap Discovery
```javascript
await run('crawl', project);
await run('extract', project);
const [gaps, orphans, entities] = await Promise.all([
  run('gap-intel', project, { vs: ['competitor1.com', 'competitor2.com'] }),
  run('orphans', project),
  run('entities', project),
]);
```

## Error Handling

Every `run()` call returns `{ ok: boolean }`. Check it:
```javascript
const result = await run('aeo', 'nonexistent');
if (!result.ok) {
  console.error(result.error); // "Project "nonexistent" not configured..."
}
```

## Dashboard Embedding

```javascript
import { getDashboardHtml } from 'seo-intel/froggo';
const { html } = await getDashboardHtml('myproject');
// Render in iframe, panel, or webview
```

## Data Persistence

All data is stored in SQLite (`seo-intel.db`). The database persists across runs.
Agents can run analyses multiple times — results accumulate, insights deduplicate.
The Intelligence Ledger (`insights` table) is the canonical source of active findings.
