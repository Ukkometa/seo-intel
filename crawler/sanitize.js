/**
 * Sanitize scraped text before sending to any AI model.
 * Defense against prompt injection from malicious web content.
 */

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
