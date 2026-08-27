/**
 * lib/brand.js — branded vs non-branded query classification.
 *
 * The branded split decides whether a page has proven category demand or only
 * navigation traffic, so getting it wrong quietly corrupts every decision built
 * on top. Terms are therefore *derived from the site's own data* — the
 * registrable domain and the names in its Organization / WebSite / Product
 * markup — and the derived list is returned so a human can see and correct it,
 * rather than a model deciding case by case what "sounds branded".
 *
 * One trap this guards against: schema `name` fields are often generic. Carbium
 * ships an Organization named "Solana Swap Aggregator"; accepting that as a
 * brand term would mark real category demand as navigation and hide the very
 * gap the audit exists to find.
 */

// Words that describe a category, not a company. A candidate made only of these
// is a description, not a brand.
const GENERIC_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'by', 'with', 'in', 'on',
  'api', 'apis', 'rpc', 'sdk', 'app', 'application', 'platform', 'service',
  'services', 'solution', 'solutions', 'software', 'tool', 'tools', 'suite',
  'blog', 'docs', 'documentation', 'guide', 'guides', 'reference', 'home',
  'data', 'node', 'nodes', 'network', 'infrastructure', 'cloud', 'server',
  'swap', 'aggregator', 'exchange', 'wallet', 'token', 'tokens', 'chain',
  'solana', 'ethereum', 'bitcoin', 'crypto', 'web3', 'defi', 'nft', 'dex',
  'fast', 'best', 'free', 'pro', 'plus', 'premium', 'official', 'inc', 'llc',
  'ltd', 'gmbh', 'oy', 'ab', 'company', 'labs', 'studio', 'group',
]);

const norm = v => String(v || '').toLowerCase().replace(/[’']/g, '').trim();

/** The registrable label of a host: docs.carbium.io -> carbium */
export function registrableName(host) {
  const parts = norm(host).replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  // Handle two-part public suffixes (example.co.uk) without a full PSL.
  const twoPart = /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]);
  return parts[parts.length - (twoPart ? 3 : 2)] || '';
}

function isGeneric(name) {
  const tokens = norm(name).split(/[\s\-_/]+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(t => GENERIC_TOKENS.has(t));
}

/**
 * Derive brand terms for a project from its own crawl data.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string[]} extra Terms from config that cannot be derived (a product
 *        name that appears nowhere in schema, for example).
 * @returns {{ terms: string[], core: string, sources: Record<string,string[]> }}
 */
export function deriveBrandTerms(db, project, extra = []) {
  const sources = { domain: [], schema: [], config: [] };

  let domains = [];
  try {
    domains = db.prepare(
      "SELECT domain FROM domains WHERE project = ? AND role IN ('target', 'owned')"
    ).all(project).map(d => d.domain);
  } catch { /* no domains table */ }

  const core = registrableName(domains[0] || '');
  if (core) sources.domain.push(core);

  let names = [];
  try {
    names = db.prepare(`
      SELECT DISTINCT ps.name FROM page_schemas ps
      JOIN pages p ON p.id = ps.page_id
      JOIN domains d ON d.id = p.domain_id
      WHERE d.project = ? AND d.role IN ('target', 'owned')
        AND ps.schema_type IN ('Organization', 'WebSite', 'Product', 'SoftwareApplication')
        AND ps.name IS NOT NULL AND ps.name != ''
    `).all(project).map(r => r.name);
  } catch { /* no schema table */ }

  for (const name of names) {
    const n = norm(name);
    if (!n || n.length < 3) continue;
    // Keep a schema name only if it carries the core brand or is not purely a
    // category description. "Carbium RPC" stays; "Solana Swap Aggregator" goes.
    const carriesCore = core && n.includes(core);
    if (!carriesCore && isGeneric(name)) continue;
    sources.schema.push(n);
  }

  for (const e of extra) {
    const n = norm(e);
    if (n) sources.config.push(n);
  }

  const terms = [...new Set([...sources.domain, ...sources.schema, ...sources.config])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return { terms, core, sources };
}

/**
 * Is this query branded? A query counts as branded when it contains a brand
 * term, or a spaced/condensed variant of one ("spiderswap" ~ "spider swap").
 */
export function isBrandedQuery(query, terms) {
  const q = norm(query);
  if (!q) return false;
  const condensed = q.replace(/[\s\-_.]/g, '');
  for (const term of terms) {
    if (!term) continue;
    if (q.includes(term)) return true;
    const t = term.replace(/[\s\-_.]/g, '');
    if (t.length >= 4 && condensed.includes(t)) return true;
  }
  return false;
}

/** Split rows with a `query` field into branded and non-branded buckets. */
export function splitBranded(rows, terms) {
  const branded = [];
  const nonBranded = [];
  for (const r of rows || []) {
    (isBrandedQuery(r.query, terms) ? branded : nonBranded).push(r);
  }
  return { branded, nonBranded };
}
