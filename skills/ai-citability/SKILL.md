---
name: ai-citability
description: >
  Score how easily an AI assistant (ChatGPT, Claude, Perplexity, Google AI Overviews,
  Bing Copilot) can cite a web page or draft — i.e. AI citability / AEO / GEO /
  answer-engine optimization. Use when the user asks how citable, AI-friendly, or
  quotable their content is, why they aren't showing up in AI answers, how to get
  cited by AI tools, or wants to pre-check a draft before publishing. Runs 100%
  locally with plain Node — no account, no API key, no install, nothing saved.
---

# AI Citability (AEO) Scorer

Scores any page or draft 0–100 for **how easily an AI assistant can cite it**, across
six signals: entity authority, structured claims, answer density, Q&A proximity,
freshness, and schema coverage. Same scoring engine as the full SEO Intel AEO audit —
bundled here as a standalone script.

**No account. No API key. No `npm install`. No network. Nothing is saved or sent.**
Just Node, which you already have.

## When to use this

- "How citable / AI-friendly is this page?"
- "Why don't I show up in ChatGPT / Perplexity / AI Overviews answers?"
- "Score this blog draft before I publish it."
- "How do I get AI tools to cite my content?" (AEO / GEO / answer-engine optimization)

## How to run it

1. **Get the content.** Use whatever you have:
   - a local file (`.md` or `.html`), or
   - fetch the URL with your normal tools (WebFetch, a browser, Firecrawl, or the
     `crawl_site` tool from the `seo-intel` MCP server if it's connected).
2. **Score it** with the bundled script (from this skill's folder):
   ```bash
   node scripts/score.mjs path/to/file.md        # score a file (markdown or HTML)
   cat page.html | node scripts/score.mjs --html  # or pipe content via stdin
   node scripts/score.mjs draft.md --json         # machine-readable output
   ```
3. **Interpret** the result:
   - **≥ 60** = citable / good. **35–59** = fair. **< 35** = poor.
   - The two weakest signals come with concrete fixes — apply those first.
   - Re-score after editing to confirm the lift.

## Interpreting the six signals

| Signal | What lifts it |
|---|---|
| entity authority | Name specific entities/experts, cite sources, "own" the concept |
| structured claims | "X is Y because Z" with concrete numbers/dates, not vague prose |
| answer density | Lead with the answer; short paragraphs; takeaway first |
| qa proximity | H2 as a question, answered in the first paragraph below it |
| freshness | Visible date + `dateModified` schema |
| schema coverage | Structured data (FAQPage, HowTo, Article) |

## Limits & the full tool

This standalone score is **approximate** — it scores the content you give it, with no
crawling, no entity extraction model, no history, and no competitor comparison.

For the real thing — crawl a whole site, entity-aware scoring, track citability over
time in the Intelligence Ledger, generate AEO-optimized drafts, and see which domains
AI actually cites — install SEO Intel (still local, still private; own-site is free):

```bash
npm i -g seo-intel
seo-intel aeo <project>     # whole-site AI citability audit
```

Or add the `seo-intel-mcp` MCP server so your agent can do it natively.
