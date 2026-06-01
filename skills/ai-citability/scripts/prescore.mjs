/**
 * AEO Pre-Scorer — scores a generated markdown draft against citability signals
 *
 * Uses the same scorePage() function as the full AEO audit, but constructs
 * synthetic inputs from the markdown text instead of reading from the DB.
 *
 * Freshness always scores 0 (no publish date yet) — the reported score
 * accounts for this by adding +10 for "what it will score once published."
 */

// VENDORED for the standalone ai-citability skill — source of truth:
// seo-intel/analyses/blog-draft/prescorer.js (kept in sync via smoke-test).
import { scorePage } from './aeo-scorer.mjs';

/**
 * Recover a draft's subject from its own output when no explicit topic was
 * given — so the agentic-loop write-back (F1) can still match Ledger gaps.
 * Prefers YAML frontmatter `title:`, falls back to the first markdown H1.
 * Shared by CLI `blog-draft` and the MCP `prescore_draft` tool.
 * @param {string} draft
 * @returns {string|null}
 */
export function extractDraftTopic(draft) {
  if (!draft) return null;
  const fm = draft.match(/^\s*---\s*[\s\S]*?\btitle\s*:\s*["']?(.+?)["']?\s*$/im);
  if (fm && fm[1]) return fm[1].trim();
  const h1 = draft.match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (h1 && h1[1]) return h1[1].replace(/[#*_`]/g, '').trim();
  return null;
}

export function prescore(markdownText) {
  // Strip YAML frontmatter
  const bodyMatch = markdownText.match(/^---[\s\S]*?---\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : markdownText;

  // Extract headings
  const headings = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim() });
  }

  // Word count
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  // Extract frontmatter fields
  let fmSchemaType = null;
  const fmMatch = markdownText.match(/^---([\s\S]*?)---/);
  if (fmMatch) {
    const schemaLine = fmMatch[1].match(/schema_type:\s*(.+)/);
    if (schemaLine) fmSchemaType = schemaLine[1].trim();
  }

  // Build synthetic page object
  const syntheticPage = {
    body_text: body,
    word_count: wordCount,
    published_date: null,   // not published yet — freshness = 0
    modified_date: null,
  };

  // Extract entity candidates from headings (capitalised noun phrases)
  const entityCandidates = headings
    .filter(h => h.level <= 3)
    .flatMap(h => h.text.match(/\b[A-ZÄÖÅ][a-zäöå]+(?:\s+[A-ZÄÖÅ][a-zäöå]+)*/g) || []);
  const entities = [...new Set(entityCandidates)].slice(0, 8);

  const schemaTypes = fmSchemaType ? [fmSchemaType] : [];
  const schemas = [];

  const result = scorePage(syntheticPage, headings, entities, schemaTypes, schemas, 'Informational');

  return {
    ...result,
    wordCount,
    headingCount: headings.length,
  };
}
