/**
 * GEO & LLM Retrieval Evaluator
 *
 * A deterministic content-shape audit for documents that need to be quoted or
 * reused by generative search. It measures inspectable extraction affordances,
 * not a claim that any particular model will cite the page.
 */

function firstWords(text, count = 220) {
  return (text || '').split(/\s+/).slice(0, count).join(' ');
}

function definitionSentence(text) {
  const sentences = (text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  return sentences.find(sentence =>
    sentence.length >= 35 && sentence.length <= 260 &&
    /\b(?:is|are|means|refers to|provides|offers|enables|allows)\b/i.test(sentence)
  ) || null;
}

function codeBlockStats(text) {
  const blocks = [...(text || '').matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
  const withLanguage = blocks.filter(m => /^[a-z0-9+#.-]{1,30}\s*$/i.test(m[1].trim())).length;
  return { count: blocks.length, withLanguage, withoutLanguage: blocks.length - withLanguage };
}

function listStats(text) {
  const bullets = [...(text || '').matchAll(/^(\s*)[-*+]\s+\S+/gm)];
  const nested = bullets.filter(m => m[1].length >= 2).length;
  return { count: bullets.length, nested, flat: bullets.length - nested, flatRatio: bullets.length ? (bullets.length - nested) / bullets.length : 0 };
}

async function copyControlCheck(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'SEO-Intel/1.5 geo (+https://ukkometa.fi/seo-intel)' } });
    const html = (await res.text()).slice(0, 1_500_000);
    const codeElements = (html.match(/<pre\b|<code\b/gi) || []).length;
    const copyControls = (html.match(/(?:aria-label|title|data-[\w-]+)=["'][^"']*copy[^"']*["']|>\s*copy\s*</gi) || []).length;
    return { status: res.status, checked: true, codeElements, copyControls, hasCopyControl: codeElements > 0 && copyControls > 0 };
  } catch (error) {
    return { checked: false, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}

function isDeveloperDocument(url, body) {
  try {
    const u = new URL(url);
    return /(^|\.)github\.com$/i.test(u.hostname) || /\/(?:docs?|guides?|reference|api|developer)/i.test(u.pathname) || /```/.test(body || '');
  } catch { return /```/.test(body || ''); }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export async function runGeoAudit(db, project, opts = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.url, p.title, p.body_text, p.word_count, d.domain, d.role
    FROM pages p JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned') AND p.is_indexable = 1
    ORDER BY p.url
  `).all(project);

  const pages = [];
  for (const row of rows) {
    const body = row.body_text || '';
    if (!isDeveloperDocument(row.url, body)) continue;
    const lead = firstWords(body);
    const definition = definitionSentence(lead);
    const lists = listStats(body);
    const code = codeBlockStats(body);
    let score = 0;
    if (definition) score += 30;
    if (lists.count >= 3 && lists.flatRatio >= 0.75) score += 20;
    else if (lists.count >= 1 && lists.flatRatio >= 0.5) score += 10;
    if (code.count >= 1) score += 15;
    if (code.withLanguage >= 1) score += 15;
    try { if (new URL(row.url).hostname.endsWith('github.com')) score += 20; } catch { /* ignore */ }

    const page = {
      id: row.id, url: row.url, title: row.title || null, wordCount: row.word_count || 0,
      score, definition, lists, code, copyControl: null, actions: [],
    };
    if (!definition) page.actions.push('Open with one concise, self-contained definition sentence that answers what this page or feature is.');
    if (lists.count && lists.flatRatio < 0.75) page.actions.push('Flatten deeply nested lists where possible so extraction preserves item meaning.');
    if (code.count && code.withoutLanguage) page.actions.push('Add a language identifier to every fenced code block (for example, ```ts).');
    if (!code.count && /(?:api|integration|sdk|request|response|endpoint)/i.test(body)) page.actions.push('Add a minimal syntax-highlighted, copyable code example for the primary implementation path.');
    pages.push(page);
  }

  if (opts.live) {
    for (const page of pages) {
      page.copyControl = await copyControlCheck(page.url);
      if (page.copyControl.checked && page.code.count && !page.copyControl.hasCopyControl) {
        page.actions.push('Expose a real copy control next to code examples; raw selectable code is still required as the baseline.');
      }
      if (page.copyControl?.hasCopyControl) page.score = Math.min(100, page.score + 5);
    }
  }

  return {
    project, live: !!opts.live, pages,
    summary: {
      auditedPages: pages.length,
      averageScore: pages.length ? Math.round(pages.reduce((sum, p) => sum + p.score, 0) / pages.length) : 0,
      missingDefinitions: pages.filter(p => !p.definition).length,
      codeWithoutLanguage: pages.reduce((sum, p) => sum + p.code.withoutLanguage, 0),
      missingCopyControls: opts.live ? pages.filter(p => p.code.count && p.copyControl?.checked && !p.copyControl.hasCopyControl).length : null,
    },
  };
}
