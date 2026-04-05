/**
 * Site Watch — Diff Engine
 *
 * Pure function: compares two page snapshots and returns change events.
 * Zero I/O, zero side effects — deterministic and testable.
 */

/**
 * @param {object[]} currentPages  - { url, status_code, title, h1, meta_desc, word_count, is_indexable, content_hash }
 * @param {object[]} previousPages - same shape, from previous snapshot
 * @returns {object[]} Array of { event_type, severity, url, old_value, new_value, details }
 */
export function diffPages(currentPages, previousPages) {
  const events = [];

  const currentMap = new Map(currentPages.map(p => [p.url, p]));
  const previousMap = new Map(previousPages.map(p => [p.url, p]));

  // ── Pages added ──────────────────────────────────────────────────────────
  for (const [url, page] of currentMap) {
    if (!previousMap.has(url)) {
      events.push({
        event_type: 'page_added',
        severity: 'notice',
        url,
        old_value: null,
        new_value: String(page.status_code || 200),
        details: JSON.stringify({ title: page.title, word_count: page.word_count }),
      });
    }
  }

  // ── Pages removed ────────────────────────────────────────────────────────
  for (const [url, page] of previousMap) {
    if (!currentMap.has(url)) {
      events.push({
        event_type: 'page_removed',
        severity: 'warning',
        url,
        old_value: String(page.status_code || 200),
        new_value: null,
        details: JSON.stringify({ title: page.title, word_count: page.word_count }),
      });
    }
  }

  // ── Per-page field comparisons ───────────────────────────────────────────
  for (const [url, curr] of currentMap) {
    const prev = previousMap.get(url);
    if (!prev) continue;

    // Status code change
    if (curr.status_code !== prev.status_code) {
      const isNewError = prev.status_code < 400 && curr.status_code >= 400;
      const isRecovery = prev.status_code >= 400 && curr.status_code < 400;
      const severity = isNewError ? 'critical'
        : curr.status_code >= 400 ? 'critical'
        : isRecovery ? 'notice'
        : 'warning';

      events.push({
        event_type: isNewError ? 'new_error' : 'status_changed',
        severity,
        url,
        old_value: String(prev.status_code),
        new_value: String(curr.status_code),
        details: null,
      });
    }

    // Title change
    if (normalise(curr.title) !== normalise(prev.title)) {
      events.push({
        event_type: 'title_changed',
        severity: 'notice',
        url,
        old_value: prev.title || '',
        new_value: curr.title || '',
        details: null,
      });
    }

    // H1 change
    if (normalise(curr.h1) !== normalise(prev.h1)) {
      events.push({
        event_type: 'h1_changed',
        severity: 'notice',
        url,
        old_value: prev.h1 || '',
        new_value: curr.h1 || '',
        details: null,
      });
    }

    // Meta description change
    if (normalise(curr.meta_desc) !== normalise(prev.meta_desc)) {
      events.push({
        event_type: 'meta_desc_changed',
        severity: 'notice',
        url,
        old_value: prev.meta_desc || '',
        new_value: curr.meta_desc || '',
        details: null,
      });
    }

    // Word count significant change (>20%)
    const prevWc = prev.word_count || 0;
    const currWc = curr.word_count || 0;
    if (prevWc > 0 && Math.abs(currWc - prevWc) / prevWc > 0.2) {
      events.push({
        event_type: 'word_count_changed',
        severity: 'notice',
        url,
        old_value: String(prevWc),
        new_value: String(currWc),
        details: JSON.stringify({ delta_pct: Math.round(((currWc - prevWc) / prevWc) * 100) }),
      });
    }

    // Indexability change
    const prevIdx = prev.is_indexable ? 1 : 0;
    const currIdx = curr.is_indexable ? 1 : 0;
    if (currIdx !== prevIdx) {
      events.push({
        event_type: 'indexability_changed',
        severity: currIdx === 0 ? 'critical' : 'notice',
        url,
        old_value: prevIdx ? 'indexable' : 'non-indexable',
        new_value: currIdx ? 'indexable' : 'non-indexable',
        details: null,
      });
    }

    // Content hash change (body text changed)
    if (curr.content_hash && prev.content_hash && curr.content_hash !== prev.content_hash) {
      events.push({
        event_type: 'content_changed',
        severity: 'notice',
        url,
        old_value: prev.content_hash?.slice(0, 8) || '',
        new_value: curr.content_hash?.slice(0, 8) || '',
        details: null,
      });
    }
  }

  // Sort: critical first, then warning, then notice
  const severityOrder = { critical: 0, warning: 1, notice: 2 };
  events.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return events;
}

/** Normalise a string for comparison (null-safe, trimmed, lowercased). */
function normalise(s) {
  return (s || '').trim().toLowerCase();
}
