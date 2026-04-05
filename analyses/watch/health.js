/**
 * Site Watch — Health Score Calculator
 *
 * Pure function: evaluates site health from current page data.
 * Zero I/O, zero side effects.
 */

/**
 * @param {object[]} pages - { url, status_code, title, h1, meta_desc, word_count, is_indexable }
 * @returns {object} { score, errors, warnings, notices, details }
 */
export function calculateHealthScore(pages) {
  if (!pages.length) return { score: 100, errors: 0, warnings: 0, notices: 0, details: [] };

  const details = [];
  let errorPages = 0;

  // Track duplicates
  const titleCounts = new Map();
  for (const p of pages) {
    if (p.title && p.status_code < 400) {
      const t = p.title.trim().toLowerCase();
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
  }

  for (const p of pages) {
    let hasError = false;

    // ── Errors (reduce health score) ───────────────────────────────────────
    if (p.status_code >= 400) {
      details.push({ url: p.url, severity: 'error', issue: `${p.status_code} error` });
      hasError = true;
    }

    if (p.status_code < 400 && (!p.title || !p.title.trim())) {
      details.push({ url: p.url, severity: 'error', issue: 'Missing title' });
      hasError = true;
    }

    if (p.status_code < 400 && (!p.h1 || !p.h1.trim())) {
      details.push({ url: p.url, severity: 'error', issue: 'Missing H1' });
      hasError = true;
    }

    if (hasError) errorPages++;

    // ── Warnings (tracked, don't reduce score) ────────────────────────────
    if (p.status_code >= 300 && p.status_code < 400) {
      details.push({ url: p.url, severity: 'warning', issue: `${p.status_code} redirect` });
    }

    if (p.status_code < 400 && (!p.meta_desc || !p.meta_desc.trim())) {
      details.push({ url: p.url, severity: 'warning', issue: 'Missing meta description' });
    }

    if (p.title && p.status_code < 400) {
      const t = p.title.trim().toLowerCase();
      if (titleCounts.get(t) > 1) {
        details.push({ url: p.url, severity: 'warning', issue: 'Duplicate title' });
      }
    }

    // ── Notices ────────────────────────────────────────────────────────────
    if (p.status_code < 400 && (p.word_count || 0) < 100 && (p.word_count || 0) > 0) {
      details.push({ url: p.url, severity: 'notice', issue: 'Thin content (<100 words)' });
    }
  }

  const errors = details.filter(d => d.severity === 'error').length;
  const warnings = details.filter(d => d.severity === 'warning').length;
  const notices = details.filter(d => d.severity === 'notice').length;

  // Health score = % of pages without errors
  const score = Math.round(((pages.length - errorPages) / pages.length) * 100);

  return { score, errors, warnings, notices, details };
}
