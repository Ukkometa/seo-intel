/**
 * lib/gsc-import.js — persist Search Console query exports into the database.
 *
 * Until now GSC CSVs were parsed at dashboard-render time and thrown away, so
 * nothing downstream could reason about demand: an agent asking "what does this
 * page need?" could only be told about structure, which is why its answers kept
 * drifting toward schema regardless of the question.
 *
 * Every export folder under gsc/<project>* is imported with the scope its own
 * Filters.csv declares. A page-filtered export becomes page-level evidence; an
 * unfiltered one is property-wide and is explicitly NOT treated as evidence
 * about any individual page.
 */

import { loadGscData, listGscExports } from '../reports/gsc-loader.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @returns {{ imported: number, exports: {folder:string,scope:string,pageFilter:string|null,dateRange:string|null,rows:number}[] }}
 */
export function importGscQueries(db, project) {
  const folders = listGscExports(project);
  const summary = [];
  let imported = 0;

  let stmt;
  try {
    stmt = db.prepare(`
      INSERT INTO gsc_queries (project, page_url, query, clicks, impressions, ctr, position, date_range, source, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, COALESCE(page_url, ''), query, date_range) DO UPDATE SET
        clicks = excluded.clicks, impressions = excluded.impressions,
        ctr = excluded.ctr, position = excluded.position,
        source = excluded.source, imported_at = excluded.imported_at
    `);
  } catch { return { imported: 0, exports: [] }; }

  const ts = Date.now();
  for (const { name } of folders) {
    const data = loadGscData(project, { folder: name });
    if (!data?.queries?.length) continue;
    const pageUrl = data.pageFilter || null;
    const range = data.dateRange || 'unknown';
    try {
      db.exec('BEGIN');
      for (const q of data.queries) {
        if (!q.query) continue;
        stmt.run(project, pageUrl, q.query, q.clicks | 0, q.impressions | 0, q.ctr ?? null, q.position ?? null, range, name, ts);
        imported++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`[gsc] import of ${name} failed:`, e.message);
      continue;
    }
    summary.push({ folder: name, scope: data.scope, pageFilter: pageUrl, dateRange: range, rows: data.queries.length });
  }
  return { imported, exports: summary };
}

/** Normalize a URL for comparison: scheme-agnostic, www-agnostic, no trailing slash. */
export function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./i, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

/**
 * Query rows recorded for one page, plus whether any page-scoped export exists.
 * The distinction matters: no rows because nobody exported page-filtered data is
 * a different state from no rows because the page genuinely gets no impressions.
 */
export function getPageQueryEvidence(db, project, url) {
  const key = normalizeUrlKey(url);
  let rows = [];
  let anyPageScoped = 0;
  try {
    rows = db.prepare(
      'SELECT * FROM gsc_queries WHERE project = ? AND page_url IS NOT NULL ORDER BY impressions DESC'
    ).all(project).filter(r => normalizeUrlKey(r.page_url) === key);
    anyPageScoped = db.prepare(
      'SELECT COUNT(*) c FROM gsc_queries WHERE project = ? AND page_url IS NOT NULL'
    ).get(project).c;
  } catch { return { rows: [], hasPageScopedExports: false, dateRanges: [] }; }
  return {
    rows,
    hasPageScopedExports: anyPageScoped > 0,
    dateRanges: [...new Set(rows.map(r => r.date_range))],
  };
}
