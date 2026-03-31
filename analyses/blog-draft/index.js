/**
 * AEO Blog Draft Generator — Data Gathering & Prompt Builder
 *
 * Pulls intelligence from the Ledger (keyword gaps, long-tails, citability gaps,
 * entities, positioning) and builds a prompt that produces a publish-ready,
 * AEO-optimised blog post in .md format with YAML frontmatter.
 */

import { getActiveInsights } from '../../db/db.js';

// ── Data Gathering ──────────────────────────────────────────────────────────

export function gatherBlogDraftContext(db, project, topic = null) {
  const insights = getActiveInsights(db, project);

  // citability_gap insights — not in getActiveInsights grouped return
  let citabilityGaps = [];
  try {
    citabilityGaps = db.prepare(
      `SELECT data FROM insights WHERE project = ? AND type = 'citability_gap' AND status = 'active' ORDER BY last_seen DESC LIMIT 15`
    ).all(project).map(r => JSON.parse(r.data));
  } catch { /* table may not exist yet */ }

  // Top entities across target pages
  let entityRows = [];
  try {
    entityRows = db.prepare(`
      SELECT e.primary_entities, p.title, p.url
      FROM extractions e
      JOIN pages p ON p.id = e.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned')
        AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]'
      ORDER BY p.word_count DESC LIMIT 20
    `).all(project);
  } catch { /* extraction may not have run */ }

  // Best AEO-scoring pages (content to emulate)
  let topCitablePages = [];
  try {
    topCitablePages = db.prepare(`
      SELECT p.url, p.title, cs.total_score as score, cs.ai_intents, cs.tier
      FROM citability_scores cs
      JOIN pages p ON p.id = cs.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND (d.role = 'target' OR d.role = 'owned') AND cs.total_score >= 55
      ORDER BY cs.total_score DESC LIMIT 5
    `).all(project);
  } catch { /* AEO may not have run */ }

  // Filter by topic if given
  const matchesTopic = (text) => {
    if (!topic || !text) return true;
    return text.toLowerCase().includes(topic.toLowerCase());
  };

  const kwInventor = insights.keyword_inventor
    .filter(k => matchesTopic(k.phrase) || matchesTopic(k.cluster))
    .slice(0, 30);

  const longTails = topic
    ? [
        ...insights.long_tails.filter(lt => matchesTopic(lt.phrase)).slice(0, 20),
        ...insights.long_tails.filter(lt => !matchesTopic(lt.phrase)).slice(0, 10),
      ]
    : insights.long_tails.slice(0, 30);

  const keywordGaps = topic
    ? [
        ...insights.keyword_gaps.filter(kg => matchesTopic(kg.keyword)).slice(0, 15),
        ...insights.keyword_gaps.filter(kg => !matchesTopic(kg.keyword)).slice(0, 10),
      ]
    : insights.keyword_gaps.filter(kg => kg.priority === 'high').slice(0, 25);

  const contentGaps = (insights.content_gaps || []).slice(0, 8);

  return {
    insights,
    citabilityGaps,
    entityRows,
    topCitablePages,
    kwInventor,
    longTails,
    keywordGaps,
    contentGaps,
    topic,
  };
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

export function buildBlogDraftPrompt(context, { config, lang = 'en', topic = null }) {
  const { longTails, keywordGaps, citabilityGaps, entityRows, topCitablePages, kwInventor, contentGaps, insights } = context;
  const isFi = lang === 'fi';

  // Extract unique entities from extraction data
  const allEntities = new Set();
  for (const row of entityRows) {
    try {
      const ents = JSON.parse(row.primary_entities);
      if (Array.isArray(ents)) ents.forEach(e => allEntities.add(typeof e === 'string' ? e : e.name || e));
    } catch { /* skip */ }
  }
  const topEntities = [...allEntities].slice(0, 15);

  // ── Section 1: Role ──
  let prompt = `You are an expert content strategist and copywriter specialising in AEO (Answer Engine Optimisation).

Your task: write a complete, publish-ready blog post draft in ${isFi ? 'Finnish' : 'English'}.
The post must score 70+ on the AEO citability scale (entity authority, structured claims, answer density, Q&A proximity, freshness signals, schema coverage).

`;

  // ── Section 2: Site intelligence ──
  prompt += `## Site Context

- **Site:** ${config.context?.siteName || config.target?.domain} (${config.target?.url})
- **Industry:** ${config.context?.industry || 'N/A'}
- **Audience:** ${config.context?.audience || 'N/A'}
- **Goal:** ${config.context?.goal || 'N/A'}
`;

  if (insights.positioning) {
    prompt += `- **Positioning:** ${typeof insights.positioning === 'string' ? insights.positioning : JSON.stringify(insights.positioning)}\n`;
  }

  if (topEntities.length) {
    prompt += `- **Core entities:** ${topEntities.join(', ')}\n`;
  }

  if (topCitablePages.length) {
    prompt += `\n### Highest-scoring pages on the site (emulate their structure)\n`;
    for (const p of topCitablePages) {
      prompt += `- ${p.url} — AEO score: ${p.score}/100 (${p.tier})\n`;
    }
  }

  // ── Section 3: Topic focus ──
  prompt += `\n## Topic\n\n`;
  if (topic) {
    prompt += `Primary focus: **${topic}**. All keyword and gap data below has been filtered to this topic. Build the entire post around this subject.\n`;
  } else {
    prompt += `Select the highest-opportunity topic from the gaps below. Choose the gap that: (a) has the most keyword_gap entries or (b) is flagged as a high priority long-tail. Explain your topic choice in the frontmatter \`topic_selection_rationale\` field.\n`;
  }

  // ── Section 4: Intelligence data ──
  if (keywordGaps.length) {
    prompt += `\n## Keyword Gaps to Target (include these as primary/secondary keywords)\n\n`;
    prompt += `| Keyword | Priority | Notes |\n|---|---|---|\n`;
    for (const kg of keywordGaps) {
      prompt += `| ${kg.keyword || kg.phrase || '—'} | ${kg.priority || 'medium'} | ${(kg.notes || '').slice(0, 80)} |\n`;
    }
  }

  if (longTails.length) {
    prompt += `\n## Long-tail Phrases to Answer (each should have a direct answer in the post)\n\n`;
    prompt += `| Phrase | Intent | Priority |\n|---|---|---|\n`;
    for (const lt of longTails) {
      prompt += `| ${lt.phrase || '—'} | ${lt.intent || '—'} | ${lt.priority || 'medium'} |\n`;
    }
  }

  if (kwInventor.length) {
    prompt += `\n## Keyword Inventor Phrases (weave these naturally into headings/body)\n\n`;
    for (const kw of kwInventor.slice(0, 20)) {
      prompt += `- "${kw.phrase}" (${kw.type || 'traditional'}, ${kw.intent || '—'})\n`;
    }
  }

  if (citabilityGaps.length) {
    prompt += `\n## Citability Gaps (pages scoring <60 on AEO — model the fix in this post)\n\n`;
    prompt += `| URL | Score | Weakest Signals |\n|---|---|---|\n`;
    for (const cg of citabilityGaps) {
      prompt += `| ${cg.url || '—'} | ${cg.score || '—'} | ${cg.weakest || cg.weakest_signal || '—'} |\n`;
    }
  }

  if (contentGaps.length) {
    prompt += `\n## Content Gaps (topics competitors cover that you don't)\n\n`;
    for (const cg of contentGaps) {
      const desc = typeof cg === 'string' ? cg : (cg.topic || cg.description || cg.gap || JSON.stringify(cg));
      prompt += `- ${desc}\n`;
    }
  }

  // ── Section 5: AEO structural requirements ──
  prompt += `
## AEO Structural Requirements

The draft MUST include:
1. YAML frontmatter with: title, slug, description (155 chars max), primary_keyword, secondary_keywords[], date (${new Date().toISOString().slice(0, 10)}), updated (same), lang (${lang}), tags[]${!topic ? ', topic_selection_rationale' : ''}
2. An H1 that contains the primary keyword
3. A 2-3 sentence summary immediately after the H1 (answer-first structure — inverted pyramid). This paragraph will be cited by AI assistants.
4. Minimum 6 H2 subheadings
5. At least 3 H2s phrased as direct questions (What is / How to / Why / When)
6. At least one numbered or bulleted list with 4+ items
7. At least one "X is Y because Z" definitional sentence per major concept
8. A FAQ section at the end with minimum 4 Q&A pairs (### H3 questions, 2-4 sentence answers)
9. A closing CTA paragraph referencing ${config.context?.siteName || config.target?.domain}
10. Word count: 1,200-2,000 words
11. Internal link suggestions: include 2-3 \`[anchor text](URL)\` links back to the site where natural
`;

  // ── Section 6: Language ──
  if (isFi) {
    prompt += `
## Language: Finnish

Write in Finnish. Use informal, direct register (sinuttelu where natural). Avoid marketing clichés common in Finnish B2B copy. Prefer short sentences. Finnish SEO keywords must appear in their exact searched base form in headings — Finnish inflection reduces exact-match keyword presence.
`;
  } else {
    prompt += `
## Language: English

Write in clear, direct international English. No filler phrases. No "in today's digital landscape" or "it's no secret that" openers. Every sentence should contain a fact, insight, or actionable point.
`;
  }

  // ── Section 7: Output format ──
  prompt += `
## Output Format

Respond with ONLY the complete markdown document. Start with --- (YAML frontmatter open fence). End with the FAQ section and CTA. No explanation before or after. No triple backticks wrapping the response.
`;

  return prompt;
}
