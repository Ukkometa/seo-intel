/**
 * Google Search Console CSV data loader
 * Reads GSC export folders from seo-intel/gsc/<project>*/
import { readdirSync, readFileSync, existsSync } from 'fs';
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

// ── Load GSC data for a project ─────────────────────────────────────────────
export function loadGscData(project) {
  if (!existsSync(GSC_DIR)) return null;

  const folders = readdirSync(GSC_DIR).filter(f =>
    f.toLowerCase().startsWith(project.toLowerCase()) &&
    !f.startsWith('.')
  );
  if (!folders.length) return null;

  // Use most recent folder (alphabetically last)
  const folder = join(GSC_DIR, folders.sort().pop());

  function loadCSV(filename) {
    const filepath = join(folder, filename);
    if (!existsSync(filepath)) return [];
    return parseCSVContent(readFileSync(filepath, 'utf8'));
  }

  // ── Chart (daily time series) ──
  const chartRaw = loadCSV('Chart.csv');
  const chart = chartRaw.map(r => ({
    date: r.Date,
    clicks: parseNum(r.Clicks),
    impressions: parseNum(r.Impressions),
    ctr: parseNum(r.CTR),
    position: parseNum(r.Position),
  })).sort((a, b) => a.date.localeCompare(b.date));

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
    chart,
    queries,
    pages,
    countries,
    devices,
    summary: { totalClicks, totalImpressions, avgPosition, avgCtr, dateRange },
    folder: folders.sort().pop(),
  };
}
