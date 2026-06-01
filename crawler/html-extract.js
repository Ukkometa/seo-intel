/**
 * Lightweight HTML extractor — pure string/regex parsing. No DOM, no browser.
 *
 * Powers the fetch-based light crawler (crawler/light.js) so ANY Claude user can
 * crawl + analyze a site with zero browser environment installed. Consistent
 * with schema-parser.js's regex approach ("no DOM parser needed").
 *
 * Trade-off: not as bulletproof as a full DOM parse on adversarial markup, but
 * more than good enough for SEO/AEO metadata (title, meta, headings, links,
 * JSON-LD, dates). The full Playwright crawler stays the heavyweight option.
 */

import { stripHtml } from './sanitize.js';
import { parseJsonLd } from './schema-parser.js';

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .trim();
}

const collapse = (s) => decodeEntities(stripHtml(s || '').replace(/\s+/g, ' '));

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ')) : '';
}

// Find a <meta> tag by attribute (name|property) = value, then read its content.
function metaContent(html, attr, value) {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return '';
  const c = tag[0].match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i);
  return c ? decodeEntities(c[1]) : '';
}

export function extractMetaDescription(html) {
  return metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description');
}

export function extractMetaRobots(html) {
  return metaContent(html, 'name', 'robots').toLowerCase();
}

export function extractCanonical(html, baseUrl) {
  const tag = html.match(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/i);
  if (!tag) return '';
  const h = tag[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
  if (!h) return '';
  try { return new URL(h[1], baseUrl).toString(); } catch { return h[1]; }
}

export function extractHeadings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = collapse(m[2]);
    if (text) out.push({ level: Number(m[1]), text: text.slice(0, 300) });
    if (out.length >= 300) break;
  }
  return out;
}

export function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  let base; try { base = new URL(baseUrl); } catch { base = null; }
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (!href) continue;
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs;
    try { abs = base ? new URL(href, base).toString() : href; } catch { continue; }
    abs = abs.split('#')[0];
    if (seen.has(abs)) continue;
    seen.add(abs);
    let internal = false;
    try { internal = !!base && new URL(abs).hostname === base.hostname; } catch { /* keep false */ }
    out.push({ href: abs, text: collapse(m[2]).slice(0, 120), internal });
    if (out.length >= 1000) break;
  }
  return out;
}

/**
 * Parse one fetched HTML document into the structured shape the rest of
 * SEO Intel speaks (mirrors the Playwright crawler's per-page object).
 * @param {string} html
 * @param {string} url - the (final) URL this HTML was fetched from
 */
export function extractPageData(html, url) {
  const schemas = parseJsonLd(html) || [];
  const schemaTypes = [...new Set(schemas.map(s => s.type).filter(Boolean))];
  let published = null, modified = null;
  for (const s of schemas) {
    if (!published && s.datePublished) published = s.datePublished;
    if (!modified && s.dateModified) modified = s.dateModified;
  }
  const bodyText = stripHtml(html);
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const robots = extractMetaRobots(html);

  return {
    url,
    title: extractTitle(html),
    meta_desc: extractMetaDescription(html),
    canonical: extractCanonical(html, url),
    robots,
    is_indexable: !/\bnoindex\b/.test(robots),
    headings: extractHeadings(html),
    links: extractLinks(html, url),
    schema_types: schemaTypes,
    schemas,
    word_count: wordCount,
    body_text: bodyText.slice(0, 20000),
    published_date: published,
    modified_date: modified,
  };
}
