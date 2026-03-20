/**
 * Sanitize scraped text before sending to any AI model.
 * Defense against prompt injection from malicious web content.
 */
import TurndownService from 'turndown';

// Patterns that look like prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all|prior)\s+instructions?/gi,
  /forget\s+(everything|all|prior|previous)/gi,
  /you\s+are\s+now\s+a/gi,
  /new\s+instructions?:/gi,
  /system\s*:/gi,
  /assistant\s*:/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /###\s*(instruction|system|human|assistant)/gi,
];

/**
 * Strip HTML tags and extract clean visible text.
 */
export function stripHtml(html) {
  return html
    // Remove script + style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Remove remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove prompt injection patterns from text.
 * Replaces suspicious phrases with [REMOVED].
 */
export function removeInjections(text) {
  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REMOVED]');
  }
  return cleaned;
}

/**
 * Truncate text to a safe token limit (rough estimate: 4 chars/token).
 */
export function truncate(text, maxTokens = 2000) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[TRUNCATED]';
}

/**
 * Full sanitization pipeline for scraped content.
 */
export function sanitize(rawHtml, maxTokens = 2000) {
  const text = stripHtml(rawHtml);
  const cleaned = removeInjections(text);
  return truncate(cleaned, maxTokens);
}

/**
 * Extract only text from specific CSS selectors (safer than full page).
 * Pass the Playwright page object and a list of selectors.
 */
export async function extractSelective(page, selectors = ['h1', 'h2', 'h3', 'p', 'li', 'title']) {
  const parts = [];
  for (const sel of selectors) {
    try {
      const texts = await page.$$eval(sel, els => els.map(e => e.innerText?.trim()).filter(Boolean));
      parts.push(...texts);
    } catch {}
  }
  return removeInjections(parts.join('\n').replace(/\s{3,}/g, '\n\n').trim());
}

/**
 * Extract page content as clean Markdown via Turndown.
 * Tries <main> or <article> first for focused content, falls back to <body>.
 * Strips nav/footer/header/aside/script/style before conversion.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
// Skip images in markdown output (no value for SEO text extraction)
turndown.addRule('removeImages', { filter: 'img', replacement: () => '' });

export async function extractAsMarkdown(page) {
  // Get focused content HTML — prefer <main> or <article>, fall back to <body>
  const html = await page.evaluate(() => {
    const el = document.querySelector('main') || document.querySelector('article') || document.body;
    if (!el) return '';
    // Clone to avoid mutating the live DOM
    const clone = el.cloneNode(true);
    // Strip non-content elements
    for (const tag of ['nav', 'footer', 'header', 'aside', 'script', 'style', 'noscript', 'iframe']) {
      clone.querySelectorAll(tag).forEach(n => n.remove());
    }
    return clone.innerHTML;
  }).catch(() => '');

  if (!html) return '';

  const md = turndown.turndown(html);
  const cleaned = removeInjections(md);
  return truncate(cleaned, 2000);
}
