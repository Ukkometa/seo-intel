/**
 * Google Search Console CSV data loader
 * Reads GSC export folders from seo-intel/gsc/<project>*/
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GSC_DIR = join(__dirname, '..', 'gsc');

// ── Robust CSV parser (handles quoted fields with commas/newlines) ──────────
function parseCSVContent(content) {
  const rows = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      const trimmed = current.replace(/\r$/, '');
      if (trimmed) rows.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current.replace(/\r$/, ''));

  if (rows.length < 2) return [];

  const headers = splitCSVRow(rows[0]);
  return rows.slice(1).map(row => {
    const values = splitCSVRow(row);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] || '').trim();
    });
    return obj;
  });
}

function splitCSVRow(row) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

// ── Parse numeric GSC fields ────────────────────────────────────────────────
function parseNum(val) {
  if (!val || val === '') return 0;
  return parseFloat(val.replace('%', '').replace(',', '')) || 0;
}

/** Every GSC export folder belonging to a project, newest first. */
export function listGscExports(project) {
  if (!existsSync(GSC_DIR)) return [];
  return readdirSync(GSC_DIR)
    .filter(f => f.toLowerCase().startsWith(project.toLowerCase()) && !f.startsWith('.'))
    .map(name => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(GSC_DIR, name)).mtimeMs; } catch { /* ignore */ }
      return { name, mtimeMs };
    })
    .filter(f => statSync(join(GSC_DIR, f.name)).isDirectory())
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── Load GSC data for a project ─────────────────────────────────────────────
export function loadGscData(project, opts = {}) {
  if (!existsSync(GSC_DIR)) return null;

  const folders = readdirSync(GSC_DIR).filter(f =>
    f.toLowerCase().startsWith(project.toLowerCase()) &&
    !f.startsWith('.')
  );
  if (!folders.length) return null;

  // Use most recently modified matching folder.
  // This avoids stale picks like "carbium-2" winning over a freshly uploaded "carbium".
  const selectedFolder = (opts.folder ? folders.filter(f => f === opts.folder) : [...folders])
    .map(name => {
      const path = join(GSC_DIR, name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { /* ignore */ }
      return { name, path, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0];
  if (!selectedFolder) return null;

  const folder = selectedFolder.path;

  function loadCSV(filename) {
    const filepath = join(folder, filename);
    if (!existsSync(filepath)) return [];
    return parseCSVContent(readFileSync(filepath, 'utf8'));
  }

  // ── Chart (daily time series) ──
  const chartRaw = loadCSV('Chart.csv');
  // GSC exports use 'Date' for daily exports and 'Time (UTC...)' for hourly exports
  // Normalize: extract YYYY-MM-DD from whatever the date/time column is
  const dateKey = Object.keys(chartRaw[0] || {}).find(k =>
    k === 'Date' || k.startsWith('Time')
  ) || 'Date';
  // Aggregate hourly rows to daily
  const dailyMap = new Map();
  for (const r of chartRaw) {
    const rawDate = r[dateKey] || '';
    const date = rawDate.includes('T') ? rawDate.slice(0, 10) : rawDate; // trim to YYYY-MM-DD
    if (!date) continue;
    const existing = dailyMap.get(date) || { clicks: 0, impressions: 0, ctrSum: 0, posSum: 0, count: 0 };
    existing.clicks += parseNum(r.Clicks);
    existing.impressions += parseNum(r.Impressions);
    existing.ctrSum += parseNum(r.CTR);
    existing.posSum += parseNum(r.Position);
    existing.count += 1;
    dailyMap.set(date, existing);
  }
  const chart = Array.from(dailyMap.entries()).map(([date, v]) => ({
    date,
    clicks: v.clicks,
    impressions: v.impressions,
    ctr: v.count > 0 ? v.ctrSum / v.count : 0,
    position: v.count > 0 ? v.posSum / v.count : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // ── Filters — what scope this export actually covers ──
  //
  // GSC writes the applied filters into Filters.csv. An export taken with a
  // page filter yields a Queries.csv scoped to that one page; without it the
  // rows are property-wide. Reading this is what lets us tell page-level
  // evidence from site-level evidence instead of assuming.
  const filterRaw = loadCSV('Filters.csv');
  const filters = {};
  for (const r of filterRaw) {
    const k = (r.Filter || '').trim().toLowerCase();
    if (k) filters[k] = (r.Value || '').trim();
  }
  const pageFilter = filters.page || filters['landing page'] || filters.url || null;

  // ── Queries ──
  const queriesRaw = loadCSV('Queries.csv');
  const queries = queriesRaw.map(r => ({
    query: r['Top queries'] || r.Query || '',
    clicks: parseNum(r.Clicks),
    impressions: parseNum(r.Impressions),
    ctr: parseNum(r.CTR),
    position: parseNum(r.Position),
  })).sort((a, b) => b.impressions - a.impressions);

  // ── Pages ──
  const pagesRaw = loadCSV('Pages.csv');
  const pages = pagesRaw.map(r => ({
    url: r['Top pages'] || r.Page || '',
    clicks: parseNum(r.Clicks),
    impressions: parseNum(r.Impressions),
    ctr: parseNum(r.CTR),
    position: parseNum(r.Position),
  })).sort((a, b) => b.impressions - a.impressions);

  // ── Countries ──
  const countriesRaw = loadCSV('Countries.csv');
  const countries = countriesRaw.map(r => ({
    country: r.Country || '',
    clicks: parseNum(r.Clicks),
    impressions: parseNum(r.Impressions),
    ctr: parseNum(r.CTR),
    position: parseNum(r.Position),
  })).sort((a, b) => b.impressions - a.impressions);

  // ── Devices ──
  const devicesRaw = loadCSV('Devices.csv');
  const devices = devicesRaw.map(r => ({
    device: r.Device || '',
    clicks: parseNum(r.Clicks),
    impressions: parseNum(r.Impressions),
    ctr: parseNum(r.CTR),
    position: parseNum(r.Position),
  }));

  // ── Summary stats ──
  const totalClicks = chart.reduce((s, d) => s + d.clicks, 0);
  const totalImpressions = chart.reduce((s, d) => s + d.impressions, 0);
  const avgPosition = chart.length
    ? (chart.reduce((s, d) => s + d.position, 0) / chart.length).toFixed(1)
    : 0;
  const avgCtr = totalImpressions > 0
    ? ((totalClicks / totalImpressions) * 100).toFixed(2)
    : 0;
  const dateRange = chart.length
    ? `${chart[0].date} → ${chart[chart.length - 1].date}`
    : '';

  return {
    scope: pageFilter ? 'page' : 'property',
    pageFilter,
    dateRange: filters.date || null,
    filters,
    sourceFolder: selectedFolder.name,
    chart,
    queries,
    pages,
    countries,
    devices,
    summary: { totalClicks, totalImpressions, avgPosition, avgCtr, dateRange },
    folder: selectedFolder.name,
  };
}
