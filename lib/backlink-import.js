/**
 * lib/backlink-import.js — import Search Console's external-links export.
 *
 * Google's Links report exports two views, "Latest links" and "More sample
 * links". On a site under the export cap they contain the same URLs; Latest
 * adds a `Last crawled` column, so it is a strict superset and the one to use.
 *
 * The export carries only the linking URL. It says nothing about which of your
 * pages was linked, what the anchor text was, or whether the link is followed —
 * all of which the linking page itself will tell you. That recovery is the
 * --live pass in analyses/backlinks.
 *
 * This is a capped, lagging sample of what Google attributes to you, never a
 * complete link profile, and the audit says so rather than implying otherwise.
 *
 * Bing Webmaster Tools is a second source for the same table
 * (analyses/bing-links), so every row this import touches gains 'gsc' in its
 * origin set: a row Bing reported first becomes 'bing,gsc', corroborated by
 * both engines. The existing origin is read and merged in JS (mergeOrigin in
 * db/db.js) rather than in SQL, because a sorted union of comma lists is one
 * line there and a CASE ladder here that would be wrong for the next source.
 * A table older than the origin column still imports, without it.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeOrigin } from '../db/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINKS_DIR = join(__dirname, '..', 'links');

/** Minimal RFC4180 reader — link URLs routinely contain commas. */
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Every links CSV for a project: links/<project>*.csv, newest first. */
export function listLinkExports(project) {
  if (!existsSync(LINKS_DIR)) return [];
  const p = project.toLowerCase();
  return readdirSync(LINKS_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes(p))
    .map(name => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(LINKS_DIR, name)).mtimeMs; } catch { /* ignore */ }
      return { name, path: join(LINKS_DIR, name), mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ file?: string }} opts  Import one specific CSV instead of the links/ folder.
 */
export function importBacklinks(db, project, opts = {}) {
  const files = opts.file
    ? [{ name: basename(opts.file), path: opts.file }]
    : listLinkExports(project);
  if (!files.length) return { imported: 0, files: [], domains: 0 };

  // Origin-aware when the table has the column (every database getDb()
  // opened); the plain upsert otherwise, so an older table still imports.
  let stmt;
  let findOrigin = null;
  try {
    findOrigin = db.prepare('SELECT origin FROM backlinks WHERE project = ? AND linking_url = ?');
    stmt = db.prepare(`
      INSERT INTO backlinks (project, linking_url, linking_domain, last_crawled, source, imported_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, linking_url) DO UPDATE SET
        last_crawled = COALESCE(excluded.last_crawled, backlinks.last_crawled),
        source = excluded.source, imported_at = excluded.imported_at,
        origin = excluded.origin
    `);
  } catch {
    findOrigin = null;
    try {
      stmt = db.prepare(`
        INSERT INTO backlinks (project, linking_url, linking_domain, last_crawled, source, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, linking_url) DO UPDATE SET
          last_crawled = COALESCE(excluded.last_crawled, backlinks.last_crawled),
          source = excluded.source, imported_at = excluded.imported_at
      `);
    } catch { return { imported: 0, files: [], domains: 0 }; }
  }

  const ts = Date.now();
  const summary = [];
  let imported = 0;

  for (const f of files) {
    let rows;
    try { rows = parseCsv(readFileSync(f.path, 'utf8')); } catch { continue; }
    if (rows.length < 2) continue;
    const header = rows[0].map(h => h.trim().toLowerCase());
    const urlCol = header.findIndex(h => h.includes('linking page') || h.includes('url') || h.includes('link'));
    const dateCol = header.findIndex(h => h.includes('crawled') || h.includes('date'));
    if (urlCol < 0) continue;

    let n = 0;
    try {
      db.exec('BEGIN');
      for (const r of rows.slice(1)) {
        const url = (r[urlCol] || '').trim();
        const host = hostOf(url);
        if (!url || !host) continue;
        const args = [project, url, host, dateCol >= 0 ? (r[dateCol] || '').trim() || null : null, f.name, ts];
        if (findOrigin) args.push(mergeOrigin(findOrigin.get(project, url)?.origin ?? null, 'gsc'));
        stmt.run(...args);
        n++; imported++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`[links] import of ${f.name} failed:`, e.message);
      continue;
    }
    summary.push({ file: f.name, rows: n, hasDates: dateCol >= 0 });
  }

  let domains = 0;
  try {
    domains = db.prepare('SELECT COUNT(DISTINCT linking_domain) c FROM backlinks WHERE project = ?').get(project).c;
  } catch { /* ignore */ }
  return { imported, files: summary, domains };
}
