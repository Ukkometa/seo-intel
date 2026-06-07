/**
 * AI Crawler Access — robots.txt analysis for AEO citability.
 *
 * The single biggest AEO failure mode is invisible to on-page scoring: a page
 * can be perfectly structured and still be uncitable because robots.txt blocks
 * the AI assistants' crawlers. This module parses robots.txt and reports which
 * answer-engine / AI crawlers are allowed to read the site.
 *
 * `analyzeAiAccess` is a pure function (robots text → verdict). `fetchAiAccess`
 * is the only thing that touches the network — callers that want to keep the
 * AEO core network-free can fetch robots.txt themselves and pass the text in.
 */

// Known AI / answer-engine crawlers. `tier: citation` = used for live grounding
// and citation in assistant answers (blocking these directly kills citability);
// `tier: training` = primarily corpus/training crawlers (blocking hurts long-term
// model familiarity but not live citation as hard).
export const AI_BOTS = [
  { ua: 'ClaudeBot',          vendor: 'Anthropic — Claude',             tier: 'citation' },
  { ua: 'Claude-Web',         vendor: 'Anthropic — Claude',             tier: 'citation' },
  { ua: 'anthropic-ai',       vendor: 'Anthropic — Claude',             tier: 'citation' },
  { ua: 'GPTBot',             vendor: 'OpenAI — ChatGPT',               tier: 'citation' },
  { ua: 'OAI-SearchBot',      vendor: 'OpenAI — ChatGPT Search',        tier: 'citation' },
  { ua: 'ChatGPT-User',       vendor: 'OpenAI — ChatGPT (browse)',      tier: 'citation' },
  { ua: 'PerplexityBot',      vendor: 'Perplexity',                     tier: 'citation' },
  { ua: 'Perplexity-User',    vendor: 'Perplexity (browse)',            tier: 'citation' },
  { ua: 'Google-Extended',    vendor: 'Google — Gemini / AI Overviews', tier: 'citation' },
  { ua: 'Amazonbot',          vendor: 'Amazon — Alexa / Rufus',         tier: 'citation' },
  { ua: 'DuckAssistBot',      vendor: 'DuckDuckGo — DuckAssist',        tier: 'citation' },
  { ua: 'Applebot-Extended',  vendor: 'Apple Intelligence',             tier: 'training'  },
  { ua: 'CCBot',              vendor: 'Common Crawl (feeds many LLMs)', tier: 'training'  },
  { ua: 'Bytespider',         vendor: 'ByteDance — Doubao',             tier: 'training'  },
  { ua: 'Meta-ExternalAgent', vendor: 'Meta AI',                        tier: 'training'  },
  { ua: 'cohere-ai',          vendor: 'Cohere',                         tier: 'training'  },
];

// ── robots.txt parsing ──────────────────────────────────────────────────────

/**
 * Parse robots.txt into user-agent groups. A group is one-or-more consecutive
 * `User-agent` lines followed by the rules that apply to them (per RFC 9309: a
 * new User-agent after a rule line starts a fresh group).
 */
function parseRobots(txt) {
  const groups = [];
  let current = null;
  let lastWasRule = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || lastWasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        lastWasRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
      current.rules.push({ type: field, path: value });
      lastWasRule = true;
    }
  }
  return groups;
}

/** Pick the group that governs `ua`: exact match wins, else the `*` group. */
function groupFor(groups, ua) {
  const lc = ua.toLowerCase();
  return groups.find(g => g.agents.includes(lc))
    || groups.find(g => g.agents.includes('*'))
    || null;
}

/** Does this group block the site root (`/`)? `Disallow: /` blocks all; an
 *  explicit `Allow: /` overrides; empty `Disallow:` means allow-all. */
function blocksRoot(group) {
  if (!group) return false;
  let blocked = false;
  for (const r of group.rules) {
    if (r.type === 'disallow' && (r.path === '/' || r.path === '/*')) blocked = true;
    else if (r.type === 'allow' && r.path === '/') blocked = false;
  }
  return blocked;
}

// ── Verdict ─────────────────────────────────────────────────────────────────

/**
 * Analyze robots.txt for AI-crawler access. Pure function.
 *
 * @param {string} robotsTxt - raw robots.txt body ('' if none/unavailable)
 * @param {object} [opts] - { fetched: boolean } — false when robots couldn't be read
 * @returns {object} {
 *   score, blocked, verdict, blockedBots[], allowedCount, citationBlocked[],
 *   aiTrainSignal, fetched, detail
 * }
 */
export function analyzeAiAccess(robotsTxt, opts = {}) {
  const fetched = opts.fetched ?? true;

  // No robots.txt (or unreadable) → crawlers default-allow. Open, but flagged.
  if (!fetched || !robotsTxt || !robotsTxt.trim()) {
    return {
      score: 100, blocked: false, verdict: 'open',
      blockedBots: [], citationBlocked: [], allowedCount: AI_BOTS.length,
      aiTrainSignal: null, fetched,
      detail: fetched
        ? 'No robots.txt rules — all AI crawlers default-allowed.'
        : 'robots.txt unavailable — assuming open (crawlers default-allow when absent).',
    };
  }

  const groups = parseRobots(robotsTxt);
  const aiTrainSignal = /content-signal\s*:[^\n]*\bai-train\s*=\s*no\b/i.test(robotsTxt)
    ? 'ai-train=no' : null;

  const blockedBots = [];
  for (const bot of AI_BOTS) {
    if (blocksRoot(groupFor(groups, bot.ua))) blockedBots.push(bot);
  }
  const citationBlocked = blockedBots.filter(b => b.tier === 'citation');

  let penalty = 0;
  for (const b of blockedBots) penalty += b.tier === 'citation' ? 18 : 7;
  if (aiTrainSignal) penalty += 8;
  const score = Math.max(0, 100 - penalty);

  // `blocked` = the hard-reality gate: any live citation crawler is locked out.
  const blocked = citationBlocked.length > 0;
  let verdict;
  if (citationBlocked.length >= 3 || score < 40) verdict = 'blocked';
  else if (blockedBots.length > 0 || aiTrainSignal) verdict = 'partial';
  else verdict = 'open';

  const names = citationBlocked.map(b => b.ua);
  const detail = verdict === 'blocked'
    ? `robots.txt blocks ${citationBlocked.length} answer-engine crawler(s) (${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}) — these pages cannot be cited by the assistants developers actually use.`
    : verdict === 'partial'
      ? `Some AI crawlers blocked${aiTrainSignal ? ' and Content-Signal ai-train=no set' : ''}; live citation still possible but reduced.`
      : 'All major AI crawlers allowed.';

  return {
    score, blocked, verdict,
    blockedBots: blockedBots.map(b => ({ ua: b.ua, vendor: b.vendor, tier: b.tier })),
    citationBlocked: citationBlocked.map(b => b.ua),
    allowedCount: AI_BOTS.length - blockedBots.length,
    aiTrainSignal, fetched, detail,
  };
}

// ── Network fetch (the only I/O in this module) ─────────────────────────────

/**
 * Fetch + analyze robots.txt for a site. Best-effort: any failure degrades to
 * an "assume open" verdict rather than throwing.
 *
 * @param {string} siteUrl - origin or any URL on the site
 * @param {object} [opts] - { timeoutMs }
 */
export async function fetchAiAccess(siteUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let origin;
  try {
    origin = new URL(/^https?:\/\//.test(siteUrl) ? siteUrl : `https://${siteUrl}`).origin;
  } catch {
    return { ...analyzeAiAccess('', { fetched: false }), origin: null };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'seo-intel-aeo (+https://ukkometa.fi/seo-intel)' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ...analyzeAiAccess('', { fetched: true }), origin, httpStatus: res.status };
    }
    const txt = await res.text();
    return { ...analyzeAiAccess(txt), origin, httpStatus: res.status };
  } catch (e) {
    return { ...analyzeAiAccess('', { fetched: false }), origin, error: e.message };
  }
}

/**
 * Fetch AI access for many domains in parallel. Returns Map<domain, verdict>.
 * Domains can be bare ("docs.carbium.sh") or full URLs.
 */
export async function fetchAiAccessForDomains(domains, opts = {}) {
  const map = new Map();
  await Promise.all([...new Set(domains)].map(async (d) => {
    const verdict = await fetchAiAccess(d, opts);
    // key by bare host so it matches the `domains.domain` column
    let host = d;
    try { host = new URL(/^https?:\/\//.test(d) ? d : `https://${d}`).hostname; } catch { /* keep */ }
    map.set(host, verdict);
    map.set(host.replace(/^www\./, ''), verdict);
  }));
  return map;
}
