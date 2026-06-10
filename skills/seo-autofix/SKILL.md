---
name: seo-autofix
description: >
  Autonomously fix a website's SEO/AEO problems with no human in the loop, using
  SEO Intel as the problem source and verifier. Use when the user wants an AI agent
  to "fix my SEO", "improve my site's AI citability", "remediate technical SEO",
  or run an automated audit→fix→verify loop on a codebase they have checked out.
  SEO Intel reports each problem with a concrete fix and a verification recipe;
  this skill drives the loop: fix the safe ones, verify against a local preview
  before deploying, and hand the judgment-heavy ones back to the human.
---

# SEO Autofix — autonomous audit → fix → verify loop

SEO Intel tells you exactly what's wrong with a site and how to confirm it's fixed.
This skill turns that into a closed loop an AI code agent runs against a repo it has
checked out. **The human stays in exactly one place: merging + deploying the branch.**

## Prerequisites
- The site's **source repo** is checked out and you can edit + build it locally.
- SEO Intel is installed and the site is configured as a project (`seo-intel setup`),
  OR use `crawl_site` ad-hoc for a one-off. The SEO Intel MCP tools are available
  (`list_problems`, `run_crawl`, `crawl_site`, `mark_problem_status`,
  `run_citability_audit`, `tech_audit`).

## The autonomy gate — only fix what's safe without judgment
Every problem carries `fix_difficulty` (1=trivial → 5=deep work). **Autonomously fix
only `fix_difficulty ≤ 2`** — deterministic, structural fixes (missing meta
description, missing title, missing JSON-LD, orphan internal links, noindex
conflicts). Anything `≥ 3` (positioning, content rewrites, strategy) is **summarized
for the human, never auto-applied.** When unsure, treat it as ≥3.

## The loop

```
1. run_crawl(project)                          # fresh audit of the deployed site
   (or crawl_site(url) for an ad-hoc, unconfigured site)
2. list_problems(project, max_fix_difficulty=2, severity order)
3. For each problem, in severity order:
   a. MAP affected_url → source.  Grep the repo for the slug/route/title to find the
      template, component, or content file that produces that page. State which file
      you're editing and why before editing.
   b. APPLY fix_template to the source.  Follow it literally — it's written to be
      actioned (e.g. "add JSON-LD; keep 5–10 fields", "add an FAQ section with
      FAQPage schema", "add concrete numbers/dates").
   c. VERIFY BEFORE DEPLOY (the key step):
        - build the site locally (e.g. `npm run build`) and serve it
          (e.g. `npm run preview` / a static server)
        - crawl_site("http://localhost:<port>/<affected path>")
        - confirm the problem signal is gone (schema present, meta filled,
          score risen). For a configured project you can instead point a crawl at
          the preview origin and re-run list_problems.
      If cleared → keep the edit.  If not → REVERT it and leave the problem for the
      human.  Never keep an unverified edit.
4. Collect all verified edits onto ONE new branch.  Do NOT push to main.  Do NOT
   deploy.  Do NOT post anywhere.  The branch is the handoff.
5. For each confirmed fix, mark_problem_status(project, problem_id, "fixed").
   Run list_problems again to show the before/after delta.
6. Summarize the fix_difficulty ≥3 problems you did NOT touch, with their
   fix_template, so the human can decide on those.
```

## Hard rules
- **Verify every fix against a local preview before trusting it.** A fix_template is
  guidance; the crawl is proof. An edit that doesn't clear the signal gets reverted.
- **One branch, no deploy, no push to main.** This loop produces a reviewable branch.
  The human merges and deploys. That is the only human step — and it is non-negotiable.
- **Difficulty gate is a safety boundary, not a suggestion.** Don't autonomously
  rewrite copy, change positioning, or touch anything judgment-heavy.
- **Map before you edit.** Don't guess which file owns a URL — find it and say so.

## Why this is safe to run unattended
The loop only applies deterministic structural fixes, proves each one against a real
crawl of a local build, reverts anything that doesn't verify, and never touches
production. The blast radius is a branch the human reviews. Everything risky
(deploying, publishing, content/strategy decisions) stays with the human.

## Typical invocation
> "Run seo-autofix on this repo for the `ukkometa` project — fix the safe technical
> and schema problems, verify against a local preview, and open a branch."

Then: `run_crawl(ukkometa)` → `list_problems(ukkometa, max_fix_difficulty=2)` → loop.
