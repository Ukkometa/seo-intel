/**
 * lib/bing-api.js — the one place that knows Bing Webmaster API endpoints.
 *
 * Search Console's Links report has no API: its links reach seo-intel only as
 * a CSV a person exports by hand (lib/backlink-import.js). Bing Webmaster
 * Tools does have one, and its link reports carry what that export lacks —
 * which page of yours is linked, and the anchor text. So this module is the
 * transport for a second, independent sample of your inbound links: the ones
 * Bing's own crawler has seen, from Bing's own index. That is a different
 * sample from Google's, also capped and lagging. Neither source, nor both
 * together, is a complete link profile.
 *
 * THE SHAPES BELOW ARE UNVERIFIED. The Microsoft documentation was not
 * reachable when this was written, so every endpoint, method name, parameter
 * name and response field comes from prior knowledge of the API, not from a
 * live response. Three things follow from that:
 *   - every name lives in ONE constants block (BING_API), so a correction is a
 *     one-line edit rather than a hunt through the code;
 *   - fields are read case-insensitively, with the payload accepted either
 *     under "d" (the WCF JSON wrapper Bing's .svc endpoints use) or at the top
 *     level, so the two most likely drifts cost nothing;
 *   - a response that still does not fit fails loudly (BingApiError kind
 *     'shape', with the first 500 characters of the body), never as an empty
 *     result. A run that silently stored nothing would read as "Bing sees no
 *     links to you", which is a finding, and a false one.
 * To verify against the live API, run `seo-intel bing-links <project> --debug`
 * (runBingLinks' debugDir): it writes the first raw body of each method it
 * calls (GetUserSites, GetLinkCounts, GetUrlLinks) to disk, and a person
 * compares them with BING_API.fields. The hook (onRaw) runs inside bingGet
 * on every 2xx answer before anything reads it, so the body that caused a
 * shape miss is the one on disk, even when it is not JSON at all.
 *
 * This module knows:
 *   - the URL scheme: GET <base>/<Method>?apikey=<KEY>&<params> (buildBingUrl)
 *   - how to turn a failure into something a person can act on (BingApiError:
 *     its kind says whether to fix the key, wait for the quota, or report a
 *     shape change, and its hint says how)
 *   - how to read each answer (readUserSites, readLinkCounts, readUrlLinks)
 *   - how to pick the account's site for a configured domain (matchBingSite)
 * It knows nothing about the database or about analyses. Every network call
 * takes an injectable fetch so tests never touch the real API, and every
 * transformation is a pure function so it can be tested on fixtures.
 *
 * The API key travels in the query string — that is Bing's scheme, not a
 * choice — so no URL is ever put into an error message or a debug file.
 */

/**
 * Every name the API is spoken in. Field entries are candidate lists, tried in
 * order and case-insensitively; add a spelling here when the live API turns
 * out to use another one.
 */
export const BING_API = {
  base: 'https://ssl.bing.com/webmaster/api.svc/json',
  keyParam: 'apikey',
  keyEnv: 'BING_WEBMASTER_API_KEY',
  methods: {
    userSites: 'GetUserSites',
    linkCounts: 'GetLinkCounts',
    urlLinks: 'GetUrlLinks',
  },
  params: {
    siteUrl: 'siteUrl',
    link: 'link',
    page: 'page',            // 0-based
  },
  fields: {
    wrapper: ['d'],                          // WCF JSON wraps the payload in { d: ... }
    siteUrl: ['Url'],                        // GetUserSites item
    siteVerified: ['IsVerified'],            // GetUserSites item
    links: ['Links'],                        // GetLinkCounts: the list of your linked pages
    linkUrl: ['Url'],                        // ... a page of YOUR site
    linkCount: ['Count'],                    // ... inbound links to it
    details: ['Details'],                    // GetUrlLinks: the pages linking to one of yours
    detailUrl: ['Url'],                      // ... the linking page
    anchor: ['AnchorText'],                  // ... its anchor text
    totalPages: ['TotalPages'],              // both paged lists
    errorCode: ['ErrorCode'],                // error body
    errorMessage: ['Message'],               // error body
  },
  // ErrorCode values that mean "no error", compared case-insensitively as
  // strings: 0 as a number, or the enum name if WCF serialises it by name.
  noErrorCodes: ['0', 'None'],
};

const BODY_EXCERPT = 500;

const KEY_HINT = `Set ${BING_API.keyEnv} to an API key from Bing Webmaster Tools → Settings → API access.`;
const AUTH_HINT = `Bing rejected the API key, or the site is not verified in the key's account. Check ${BING_API.keyEnv} `
  + '(Bing Webmaster Tools → Settings → API access) and that the site is verified in that same account.';
const QUOTA_HINT = 'Bing Webmaster API quota exhausted for this key. What was stored is kept; run again later '
  + '(the quota is daily), or spend fewer requests per run.';
const SHAPE_HINT = 'Bing answered in a shape this module does not expect. The field names in BING_API (lib/bing-api.js) '
  + 'are unverified against the live API: run with --debug to write the first raw response of each method, compare '
  + 'them and the excerpt above with BING_API.fields, and add the spelling Bing actually uses.';

export class BingApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: number|string, kind?: 'auth'|'quota'|'shape'|'server'|'transport'|'config',
   *           hint?: string, body?: string }} [details]
   */
  constructor(message, { status, code, kind, hint, body } = {}) {
    super(message);
    this.name = 'BingApiError';
    this.status = status ?? null;
    this.code = code ?? null;
    this.kind = kind ?? 'server';
    this.hint = hint ?? '';
    this.body = body ?? '';
  }
}

/** The first BODY_EXCERPT characters of a body, whatever it is. */
function excerpt(body) {
  if (body === undefined || body === null) return '';
  let text;
  if (typeof body === 'string') text = body;
  else {
    try { text = JSON.stringify(body); } catch { text = String(body); }
  }
  return String(text ?? '').slice(0, BODY_EXCERPT);
}

function shapeError(what, body) {
  const text = excerpt(body);
  return new BingApiError(`Bing Webmaster API: ${what}. Body: ${text || '(empty)'}`, {
    kind: 'shape', hint: SHAPE_HINT, body: text,
  });
}

/**
 * GET <base>/<method>?apikey=<key>&<params>. PURE. Params with an undefined
 * or null value are left out; everything is percent-encoded, which matters
 * because siteUrl and link are themselves URLs.
 */
export function buildBingUrl(method, params = {}, apiKey = '') {
  const parts = [`${BING_API.keyParam}=${encodeURIComponent(String(apiKey ?? ''))}`];
  for (const [name, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return `${BING_API.base}/${encodeURIComponent(String(method))}?${parts.join('&')}`;
}

/**
 * A WCF JSON date to epoch ms. PURE. "/Date(1690000000000)/" and
 * "/Date(1690000000000-0700)/" are the same instant: the number is already
 * UTC milliseconds and the offset only says which zone the server displayed
 * it in. An ISO-8601 string is accepted too, in case the API is ever moved to
 * it; anything else is null.
 */
export function parseWcfDate(s) {
  if (s === null || s === undefined) return null;
  const text = String(s).trim();
  const m = /^\/?Date\((-?\d+)(?:[+-]\d{4})?\)\/?$/i.exec(text);
  if (m) {
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Read a field by its candidate names: an exact key first, then a
 * case-insensitive match. PURE. Undefined when none is present.
 */
export function readField(obj, candidates) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  for (const name of candidates) if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const keys = Object.keys(obj);
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const key = keys.find(k => k.toLowerCase() === lower);
    if (key !== undefined) return obj[key];
  }
  return undefined;
}

/** The payload inside the WCF wrapper, or the body itself when unwrapped. PURE. */
export function unwrap(json) {
  return readField(json, BING_API.fields.wrapper) ?? json;
}

/**
 * The list a paged answer carries: under its field name, or the payload
 * itself when Bing returns the list bare. Undefined when neither.
 */
function listOf(payload, candidates) {
  if (Array.isArray(payload)) return payload;
  const list = readField(payload, candidates);
  return Array.isArray(list) ? list : undefined;
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s || null;
}

function toBool(value) {
  if (typeof value === 'string') return !/^(false|0|no)$/i.test(value.trim());
  return Boolean(value);
}

/**
 * TotalPages, or 1 when the answer does not say: the page in hand is then
 * the only one this module can know about.
 */
function totalPagesOf(payload) {
  const n = Number(readField(payload, BING_API.fields.totalPages));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/**
 * Items to rows, failing when a non-empty list has no item that yields a URL:
 * that is a renamed field, and reading it as "no links" would be a lie.
 */
function mapItems(list, urlFields, map, what, body) {
  const out = [];
  for (const item of list) {
    const url = stringOrNull(readField(item, urlFields));
    if (url) out.push(map(item, url));
  }
  if (list.length && !out.length) {
    throw shapeError(`${what}: ${list.length} item(s) but none has a ${urlFields.join('/')} field`, body);
  }
  return out;
}

/**
 * GetUserSites → [{ url, verified }]. PURE. An item without an IsVerified
 * field is taken as verified: the field's absence says nothing, and refusing
 * every site for it would block the run on a spelling.
 */
export function readUserSites(json) {
  const payload = unwrap(json);
  if (!Array.isArray(payload)) throw shapeError('GetUserSites: expected a list of sites', json);
  return mapItems(payload, BING_API.fields.siteUrl, (item, url) => {
    const v = readField(item, BING_API.fields.siteVerified);
    return { url, verified: v === undefined || v === null ? true : toBool(v) };
  }, 'GetUserSites', json);
}

/** GetLinkCounts → { links: [{ url, count }], totalPages }. PURE. */
export function readLinkCounts(json) {
  const payload = unwrap(json);
  const list = listOf(payload, BING_API.fields.links);
  if (!list) throw shapeError(`GetLinkCounts: no ${BING_API.fields.links.join('/')} list`, json);
  const links = mapItems(list, BING_API.fields.linkUrl, (item, url) => {
    const n = Number(readField(item, BING_API.fields.linkCount));
    return { url, count: Number.isFinite(n) ? n : null };
  }, 'GetLinkCounts', json);
  return { links, totalPages: Array.isArray(payload) ? 1 : totalPagesOf(payload) };
}

/** GetUrlLinks → { details: [{ url, anchor }], totalPages }. PURE. */
export function readUrlLinks(json) {
  const payload = unwrap(json);
  const list = listOf(payload, BING_API.fields.details);
  if (!list) throw shapeError(`GetUrlLinks: no ${BING_API.fields.details.join('/')} list`, json);
  const details = mapItems(list, BING_API.fields.detailUrl, (item, url) => ({
    url,
    anchor: stringOrNull(readField(item, BING_API.fields.anchor)),
  }), 'GetUrlLinks', json);
  return { details, totalPages: Array.isArray(payload) ? 1 : totalPagesOf(payload) };
}

/**
 * Whether an ErrorCode reports a failure: present, and not one of
 * BING_API.noErrorCodes. A body can carry ErrorCode 0 beside its payload.
 */
function isFailureCode(code) {
  if (code === undefined || code === null) return false;
  const s = String(code).trim().toLowerCase();
  return s !== '' && !BING_API.noErrorCodes.some(c => c.toLowerCase() === s);
}

/**
 * Whether a body carries something a reader can read: a list at the payload
 * (GetUserSites), or one of the paged lists under its field name. Looked for
 * under "d" and at the top level alike, as the readers do.
 */
function carriesPayload(json) {
  const payload = unwrap(json);
  if (Array.isArray(payload)) return true;
  return [BING_API.fields.links, BING_API.fields.details].some(f => Array.isArray(readField(payload, f)));
}

/** { code, message } from an error body, looked for under "d" and at the top. */
function readApiError(json) {
  if (!json || typeof json !== 'object') return null;
  for (const obj of [json, unwrap(json)]) {
    const code = readField(obj, BING_API.fields.errorCode);
    const message = readField(obj, BING_API.fields.errorMessage);
    if (code !== undefined || message !== undefined) {
      return {
        code: code ?? null,
        message: message === undefined || message === null ? '' : String(message),
      };
    }
  }
  return null;
}

/** The key never leaves this module inside a message: Bing echoing a URL would otherwise leak it. */
function redact(text, apiKey) {
  const s = String(text ?? '');
  return apiKey && s.includes(apiKey) ? s.split(apiKey).join('***') : s;
}

const QUOTA_RE = /quota|throttl/i;
const AUTH_RE = /api\s*key|apikey|unauthori[sz]ed|not authori[sz]ed|access denied|forbidden|not verified|unverified|verif(y|ication)/i;

/**
 * The kind of a failure, from status, Bing's JSON Message and the body. PURE.
 *
 * Quota is checked first, on all three: a throttled key answers 403 or 400
 * as often as 429, "wait" is the fix whatever the status, and a plain-text
 * "The request was throttled" behind a 503 is as much a quota answer as a
 * JSON one. Read as a server error it would send every remaining target's
 * request into the same wall, spending what is left of the quota for nothing.
 *
 * Auth is read from the status and the JSON Message only, never from a raw
 * body. An error page or stack trace can say "verify" or "access" in passing,
 * and a false auth aborts the run with "fix your key"; a real key or
 * verification failure answers 401/403 or a JSON Message that says so, and
 * is caught on the first list page either way.
 */
export function classifyFailure(status, message = '', body = '') {
  const s = Number(status);
  if (s === 429 || QUOTA_RE.test(message) || QUOTA_RE.test(body)) return 'quota';
  if (s === 401 || s === 403 || AUTH_RE.test(message)) return 'auth';
  return 'server';
}

function hintFor(kind, message) {
  if (kind === 'quota') return QUOTA_HINT;
  if (kind === 'auth') return AUTH_HINT;
  return message || 'Bing Webmaster API error; retry later.';
}

/**
 * One GET. Returns the parsed JSON body, whole (callers unwrap it). Every
 * failure is a BingApiError whose kind the caller can branch on:
 *   config     no API key
 *   auth       401/403, or Bing's Message is about the key or verification
 *   quota      429, or Bing's Message or the body itself mentions quota or
 *              throttling (a plain-text error has no Message to read)
 *   server     any other non-2xx, carrying Bing's Message (or the body)
 *   transport  timeout (AbortError) or network failure
 *   shape      a 2xx whose body is not JSON
 *
 * A 2xx whose body carries a failing ErrorCode (not 0/None) and nothing a
 * reader could read is treated as the failure it describes: WCF services are
 * known to answer errors that way. ErrorCode 0 beside a Links list is a
 * success that happens to say so, at the top level or under "d".
 *
 * onRaw(json, text), when given, sees every 2xx answer that is not an error
 * before anyone reads it: json is the parsed body (undefined when it is not
 * JSON) and text the raw body with the key redacted. It runs before the
 * not-JSON shape check, so a --debug run keeps the body that broke it.
 */
export async function bingGet({ method, params, apiKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000, onRaw } = {}) {
  if (!apiKey) {
    throw new BingApiError(`No Bing Webmaster API key for ${method}.`, { kind: 'config', hint: KEY_HINT });
  }
  const url = buildBingUrl(method, params, apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text = '';
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
    if (typeof res.text === 'function') text = await res.text();
    else if (typeof res.json === 'function') text = JSON.stringify(await res.json());
  } catch (err) {
    if (err instanceof BingApiError) throw err;
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new BingApiError(`Bing Webmaster API ${method}: no answer within ${Math.round(timeoutMs / 1000)}s`, {
        kind: 'transport',
        hint: 'Bing did not answer in time. Check network access to ssl.bing.com, then retry.',
      });
    }
    throw new BingApiError(`Bing Webmaster API ${method}: ${redact(err?.message || err, apiKey)}`, {
      kind: 'transport',
      hint: 'Could not reach ssl.bing.com. Check the network connection and any proxy, then retry.',
    });
  } finally {
    clearTimeout(timer);
  }

  let json;
  let parsed = false;
  try { json = JSON.parse(text); parsed = true; } catch { /* not JSON */ }

  const apiError = parsed ? readApiError(json) : null;
  const errorOnly = res.ok && apiError !== null && isFailureCode(apiError.code) && !carriesPayload(json);
  if (!res.ok || errorOnly) {
    const message = redact(apiError?.message || '', apiKey);
    // Redacted before it is cut: a key straddling the cut would survive as a prefix.
    const body = excerpt(redact(text, apiKey));
    const detail = message || body;
    const kind = classifyFailure(res.ok ? 0 : res.status, message, body);
    throw new BingApiError(`Bing Webmaster API ${res.status} for ${method}${detail ? `: ${detail}` : ''}`, {
      status: res.status, code: apiError?.code ?? null, kind, hint: hintFor(kind, message), body,
    });
  }
  if (typeof onRaw === 'function') onRaw(parsed ? json : undefined, redact(text, apiKey));
  if (!parsed) throw shapeError(`${method}: the body is not JSON`, redact(text, apiKey));
  return json;
}

/*
 * The three methods. Each takes an optional onRaw(json, text), handed to
 * bingGet, which calls it with every 2xx answer before it is read (see
 * bingGet): a caller keeps the body even when the read then fails on shape,
 * or when the body is not JSON at all.
 */

/** Every site the key's account can see: [{ url, verified }]. */
export async function listUserSites({ apiKey, fetch, timeoutMs, onRaw } = {}) {
  const json = await bingGet({ method: BING_API.methods.userSites, params: {}, apiKey, fetch, timeoutMs, onRaw });
  return readUserSites(json);
}

/** One page (0-based) of GetLinkCounts: which of your pages have inbound links, and how many. */
export async function getLinkCounts({ siteUrl, page = 0, apiKey, fetch, timeoutMs, onRaw } = {}) {
  if (!siteUrl) throw new BingApiError('getLinkCounts: siteUrl is required', { kind: 'config' });
  const { siteUrl: pSite, page: pPage } = BING_API.params;
  const json = await bingGet({
    method: BING_API.methods.linkCounts, params: { [pSite]: siteUrl, [pPage]: page }, apiKey, fetch, timeoutMs, onRaw,
  });
  return readLinkCounts(json);
}

/** One page (0-based) of GetUrlLinks: the pages linking to `link`, with anchors. */
export async function getUrlLinks({ siteUrl, link, page = 0, apiKey, fetch, timeoutMs, onRaw } = {}) {
  if (!siteUrl) throw new BingApiError('getUrlLinks: siteUrl is required', { kind: 'config' });
  if (!link) throw new BingApiError('getUrlLinks: link is required', { kind: 'config' });
  const { siteUrl: pSite, link: pLink, page: pPage } = BING_API.params;
  const json = await bingGet({
    method: BING_API.methods.urlLinks, params: { [pSite]: siteUrl, [pLink]: link, [pPage]: page }, apiKey, fetch, timeoutMs, onRaw,
  });
  return readUrlLinks(json);
}

/** Accept "example.com", "www.example.com" or a full URL; return a lowercase host. */
function domainHost(domain) {
  const raw = String(domain || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0];
  }
}

/** A site URL compared as Bing means it: scheme and host case-insensitive, the trailing slash optional. */
function siteKey(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/**
 * Pick the account's site for a configured domain. PURE. The same rules as
 * lib/gsc-api.js matchProperty, for the one kind of site Bing has — a URL
 * prefix with a trailing slash:
 *
 * A configured site is trusted when there is no list to check it against, or
 * when the account has it (spelled as the account spells it). One the account
 * has but has not verified, or does not have at all, is refused with the
 * list of what it has: Bing answers nothing for either.
 *
 * Without one, sites on the domain or its www/bare variant rank https before
 * http, then the exact host before its variant, then shorter before longer.
 * The host outranks length because a prefix covers only URLs under it: for a
 * site canonical on www, https://example.com/ holds no links at all. https
 * outranks the host because a migrated site leaves its old http site behind.
 * Unverified sites never qualify.
 *
 * @param {Array<{ url: string, verified?: boolean }>|null} sites
 * @param {{ domain?: string, configured?: string }} wanted
 * @returns {{ site: string|null, reason: string, available?: string[] }}
 */
export function matchBingSite(sites, { domain, configured } = {}) {
  const all = Array.isArray(sites) ? sites.filter(s => s && s.url) : [];
  const verified = all.filter(s => s.verified !== false);
  const available = all.map(s => s.url);

  if (configured) {
    const wanted = String(configured).trim();
    if (!all.length) return { site: wanted, reason: 'configured' };
    const key = siteKey(wanted);
    const hit = verified.find(s => siteKey(s.url) === key);
    if (hit) return { site: hit.url, reason: 'configured' };
    if (all.some(s => siteKey(s.url) === key)) {
      return { site: null, reason: 'configured site is unverified in this account', available };
    }
    return { site: null, reason: 'configured site not in the account', available };
  }

  const host = domainHost(domain);
  if (!host) return { site: null, reason: 'no domain to match', available };
  const bare = host.replace(/^www\./, '');
  const hosts = new Set([host, bare, `www.${bare}`]);
  const ranked = [];
  for (const s of verified) {
    let u;
    try { u = new URL(s.url); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const hostname = u.hostname.toLowerCase();
    if (!hosts.has(hostname)) continue;
    ranked.push({
      url: s.url,
      https: u.protocol === 'https:' ? 0 : 1,
      exact: hostname === host ? 0 : 1,
      len: s.url.length,
    });
  }
  ranked.sort((a, b) => a.https - b.https || a.exact - b.exact || a.len - b.len || a.url.localeCompare(b.url));
  if (ranked.length) return { site: ranked[0].url, reason: 'url-prefix site' };
  return { site: null, reason: `no site matches ${host}`, available };
}
