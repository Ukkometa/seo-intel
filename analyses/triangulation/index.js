/**
 * Content Triangulation Scanner
 *
 * Scores docs and posts against three independently useful proof surfaces:
 * embedded YouTube video, active GitHub reference, and a technical/code schema.
 * The local scan is deterministic; `live` confirms iframe embedding. Optional
 * YouTube metadata checks require an owner-provided YOUTUBE_API_KEY.
 */

import { mapLimit, LIVE_CONCURRENCY } from '../../lib/concurrency.js';
import { upsertInsights } from '../../db/db.js';

const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;
const GITHUB_HOST_RE = /(^|\.)github\.com$/i;

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function parseJson(raw) { try { return JSON.parse(raw); } catch { return null; } }
function hasSchema(raw, names) {
  const text = JSON.stringify(raw || '');
  return names.some(name => text.includes(`"${name}"`));
}

async function fetchHtml(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'SEO-Intel/1.5 triangulation (+https://ukkometa.fi/seo-intel)' } });
    return { status: res.status, finalUrl: res.url, html: (await res.text()).slice(0, 1_500_000) };
  } finally { clearTimeout(timer); }
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const match = u.pathname.match(/^\/(?:embed|shorts)\/([^/?#]+)/);
    return match?.[1] || null;
  } catch { return null; }
}

async function youtubeMetadata(videoIds, targetHost, githubUrls, apiKey) {
  if (!videoIds.length) return { status: 'not_applicable', videos: [] };
  if (!apiKey) return { status: 'not_configured', reason: 'Set YOUTUBE_API_KEY to verify video descriptions through the YouTube Data API.', videos: [] };
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoIds.join(','))}&key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: 'error', reason: `YouTube Data API returned ${res.status}`, videos: [] };
    const data = await res.json();
    const normalizedGithub = githubUrls.map(v => v.replace(/\/$/, '').toLowerCase());
    const videos = (data.items || []).map(item => {
      const description = item.snippet?.description || '';
      const lower = description.toLowerCase();
      return {
        id: item.id,
        title: item.snippet?.title || null,
        hasCanonicalWebLink: lower.includes(targetHost.toLowerCase()),
        hasGithubLink: normalizedGithub.some(url => lower.includes(url)),
      };
    });
    return { status: 'ok', videos };
  } catch (error) {
    return { status: 'error', reason: error.message, videos: [] };
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
export async function runTriangulationScan(db, project, opts = {}) {
  const target = db.prepare("SELECT domain FROM domains WHERE project = ? AND role = 'target' LIMIT 1").get(project)?.domain || null;
  const rows = db.prepare(`
    SELECT p.id, p.url, p.title, d.role
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned') AND p.is_indexable = 1
    ORDER BY p.url
  `).all(project);

  const pages = [];
  const schemaStmt = db.prepare('SELECT raw_json FROM page_schemas WHERE page_id = ?');
  // Links are read per page rather than GROUP_CONCAT'd: the concatenated form
  // is comma-joined, and real URLs contain commas, so splitting it back apart
  // shreds them. SQLite has no custom separator for GROUP_CONCAT(DISTINCT x).
  const linkStmt = db.prepare('SELECT DISTINCT target_url FROM links WHERE source_id = ?');
  const videoIds = new Set();
  const githubUrls = new Set();

  for (const row of rows) {
    const links = linkStmt.all(row.id).map(r => r.target_url).filter(Boolean);
    const github = links.filter(url => GITHUB_HOST_RE.test(hostOf(url)) && !/\/issues(?:\/|$)/.test(url));
    const youtubeLinks = links.filter(url => YOUTUBE_HOST_RE.test(hostOf(url)));
    const schemas = schemaStmt.all(row.id).map(item => parseJson(item.raw_json)).filter(Boolean);
    const technicalSchema = schemas.some(raw => hasSchema(raw, ['SoftwareSourceCode', 'TechArticle']));
    github.forEach(url => githubUrls.add(url));
    youtubeLinks.map(youtubeId).filter(Boolean).forEach(id => videoIds.add(id));

    pages.push({
      id: row.id, url: row.url, title: row.title || null,
      githubLinks: github,
      youtubeLinks,
      technicalSchema,
      live: null,
    });
  }

  if (opts.live) {
    await mapLimit(pages, opts.concurrency || LIVE_CONCURRENCY, async (page) => {
      try {
        const res = await fetchHtml(page.url);
        const iframeVideo = /<iframe\b[^>]+(?:youtube(?:-nocookie)?\.com|youtu\.be)[^>]*>/i.test(res.html);
        const githubInHtml = /(?:https?:)?\/\/github\.com\//i.test(res.html);
        page.live = { status: res.status, finalUrl: res.finalUrl, iframeVideo, githubInHtml };
      } catch (error) {
        page.live = { error: error.name === 'AbortError' ? 'timeout' : error.message };
      }
    });
  }

  for (const page of pages) {
    const videoEmbedded = page.live?.iframeVideo === true;
    const githubActive = page.githubLinks.length > 0 && (page.live ? page.live.githubInHtml : true);
    const score = (videoEmbedded ? 35 : 0) + (githubActive ? 35 : 0) + (page.technicalSchema ? 30 : 0);
    page.signals = { videoEmbedded, githubActive, technicalSchema: page.technicalSchema };
    page.score = score;
    page.status = score === 100 ? 'triangulated' : score >= 65 ? 'partial' : 'missing_proof';
    page.actions = [];
    if (!videoEmbedded) page.actions.push(opts.live ? 'Embed a relevant YouTube video iframe, not only a text link.' : 'Run with --live to verify whether a relevant YouTube iframe is embedded.');
    if (!githubActive) page.actions.push('Link directly to the active GitHub repository, source file, or runnable snippet.');
    if (!page.technicalSchema) page.actions.push('Add matching visible technical content, then consider TechArticle or SoftwareSourceCode schema where it accurately applies.');
  }

  const metadata = opts.videoMetadata
    ? await youtubeMetadata([...videoIds], target || '', [...githubUrls], process.env.YOUTUBE_API_KEY)
    : { status: 'not_requested', videos: [] };
  const scored = pages.filter(p => p.githubLinks.length || p.youtubeLinks.length || p.technicalSchema);

  // Only pages short of full proof are worth carrying forward.
  upsertInsights(db, project, 'triangulation_gap', scored
    .filter(p => p.status !== 'triangulated')
    .map(p => ({
      fingerprint: p.url.toLowerCase().replace(/\/+$/, ''),
      data: {
        url: p.url, title: p.title, score: p.score, status: p.status,
        missing: Object.entries(p.signals).filter(([, v]) => !v).map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()),
        recommendation: p.actions.join(' '),
      },
    })));

  return {
    project, targetDomain: target, live: !!opts.live,
    pages: scored,
    videoMetadata: metadata,
    summary: {
      eligiblePages: scored.length,
      fullyTriangulated: scored.filter(p => p.score === 100).length,
      averageScore: scored.length ? Math.round(scored.reduce((sum, p) => sum + p.score, 0) / scored.length) : 0,
      pagesNeedingLiveVideoCheck: scored.filter(p => p.youtubeLinks.length && !opts.live).length,
    },
  };
}
