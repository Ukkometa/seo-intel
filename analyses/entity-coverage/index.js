/**
 * analyses/entity-coverage — the competitor crawl read at the level of
 * concepts rather than keywords: which entities the market talks about, which
 * of those you talk about too, and which of them nobody has given a page.
 *
 * Where the entities come from. The extractor (extractor/qwen.js) asks the
 * local model for 3-7 high-level concepts per page — "Smart Contracts", not
 * "buy sol" — and stores them as a JSON array of strings in
 * extractions.primary_entities. Nothing in this module asks a model anything:
 * both functions read those arrays back and count domains. An entity is its
 * text lowercased and trimmed, so "Solana" on one site and "solana " on
 * another are one concept; "DAS API" and "Digital Asset Standard" stay two,
 * because nothing here can know they are the same thing. Counts are distinct
 * DOMAINS, never mentions: a competitor that names a concept on forty pages is
 * one competitor talking about it, and a count of forty would let one noisy
 * site outvote the market. Not to be confused with analyses/entity, which
 * audits the site's own Organization markup and sameAs links.
 *
 * Why one module. Both commands were written twice — inline in cli.js and again
 * in agent-harness.js run(), which is what the MCP tool get_entity_coverage
 * calls — and orphans a third time in reports/generate-html.js for the
 * dashboard's Orphan Entities card. The copies drifted. The harness dropped the
 * CLI's second dedicated-page test and slugged its suggested URL differently,
 * so an agent could be told to build /solutions/caf for "café" while the
 * terminal and the dashboard said /solutions/café, or be sent to build a page
 * on an entity the CLI had found a competitor page for; and it never sorted
 * the shared list, so the MCP tool returned it in row order and the terminal
 * by competitor count. The dashboard's orphans skipped one-character entities,
 * which neither orphans copy did. Row selection now lives here once; the CLI
 * renders the result, the harness returns a projection of it, the dashboard
 * reads the same lists.
 * Where the copies differed the CLI's version won: it is the surface people
 * read and pay for, the dashboard already agreed with it on orphans, and no
 * harness difference was a fix.
 *
 * Orphan entities. A concept at least two competitor domains name among their
 * page entities, for which none of those competitors has a URL — the market
 * keeps mentioning it and nobody owns the page, so a focused page on it has no
 * incumbent to displace. Only competitor pages are read, for the mentions and
 * for the URLs: whether the target mentions the entity, or already has a page
 * for it, does not change the list — the list is about the competitors' gap,
 * and building the page is the recommendation. "Has a URL" is a substring
 * test on the lowercased competitor URLs, with two spellings of the entity:
 * the slug (whitespace runs to '-', then everything outside a-z0-9- dropped)
 * and the entity with its whitespace runs as path separators ("das api" found
 * at /das/api). The test is deliberately loose, and it has known false
 * positives, kept because changing them changes the list and belongs in its
 * own change with its own before/after:
 *   - a short slug is found inside longer words, so "rpc" counts as having a
 *     page when a competitor has /grpc-streams;
 *   - the slug drops non-ASCII letters, so "café" is looked for as "caf";
 *   - an entity made only of dropped characters has an empty slug, which every
 *     URL contains, so it is never an orphan.
 * The suggested URL is /solutions/ plus the entity with whitespace runs
 * hyphenated and nothing else changed — a suggestion a person edits, which is
 * why it keeps "café" and "node.js" readable rather than slugging them.
 *
 * Entity coverage. Every entity lands in at most one bucket by which side
 * names it. A gap: minMentions or more competitor domains and never you. Shared:
 * at least one competitor and you. Unique: you and no competitor. "You" is the
 * target and every owned domain — a docs subdomain, or the www host a target
 * redirect gets crawled under — and every role that is neither target nor
 * owned counts as a competitor. An entity fewer than minMentions competitors
 * name, and you never do, is in no bucket but still counts toward
 * summary.totalEntities, which is every distinct entity seen; the three counts
 * do not sum to it and are not meant to. Entities shorter than two characters
 * are skipped here (a stray "x" or "&" is extraction noise, not a concept), and
 * not in orphans, where a one-character slug is inside nearly every URL anyway.
 *
 * Order. Gaps and shared by competitor-domain count, most first; ties, the
 * unique list and every domain list keep the order the rows were read in
 * (first mention first). The queries carry no ORDER BY, as in every copy, so
 * "row order" is SQLite's scan order — stable for a given database, and
 * adding one here would reorder the ties everyone has been reading.
 *
 * Malformed rows. The extractor only ever stores an array of strings
 * (sanitizeArray, then db.insertExtraction), so this matters only for rows
 * written some other way. A value that does not parse, or parses to anything
 * but an array, contributes nothing; a non-string element is skipped. The
 * copies threw on a JSON null or number (for...of) and on a non-string element
 * (toLowerCase), taking the whole command down with one bad row, and walked a
 * JSON string character by character. This, and an explicit minMentions of 0
 * (below), are the two places this module answers differently from every
 * copy; this one only on rows the extractor never writes.
 *
 * minMentions keeps the CLI's name (--min-mentions; the MCP tool maps
 * min_mentions onto it) and accepts a string or a number. A value that is not
 * an integer takes the default of 2. Zero is an integer and is kept — it and
 * any smaller number mean "any competitor", the same as 1 — where both copies
 * read `parseInt(x) || 2` and turned an explicit 0 into 2.
 */

/**
 * minMentions  entities: distinct competitor domains an entity needs before
 *              you not naming it is a gap
 */
export const DEFAULTS = Object.freeze({
  minMentions: 2,
});

/**
 * The fixed bounds, named so the header's reasoning has something to point at.
 * None is an option on any surface today.
 */
export const BOUNDS = Object.freeze({
  orphanMinDomains: 2,        // inclusive: competitor domains naming an orphan
  entityMinLength: 2,         // inclusive, entities only: shorter keys are noise
});

/** Where an orphan's suggested page goes. */
export const SUGGESTED_URL_PREFIX = '/solutions/';

/**
 * An integer option, or the fallback. parseInt so '3' from commander and 3
 * from MCP read the same; Number.isFinite so 0 survives and a missing or
 * garbled value takes the default. Always base 10: both copies' bare parseInt
 * read '0x10' as 16, which is now 0.
 */
export function intOpt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** The identity of an entity: its text lowercased, then trimmed. */
export function entityKey(entity) {
  return entity.toLowerCase().trim();
}

/**
 * The entity keys stored on one extractions.primary_entities value, in stored
 * order, duplicates kept (callers count domains, so a repeat is harmless).
 * Anything that is not a JSON array of strings yields [] or skips the element;
 * see "Malformed rows" above.
 *
 * @param {string|null} json
 * @returns {string[]}
 */
export function parseEntities(json) {
  let list;
  try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const keys = [];
  for (const entity of list) {
    if (typeof entity === 'string') keys.push(entityKey(entity));
  }
  return keys;
}

/** An entity key as a URL slug: whitespace runs to '-', then only a-z, 0-9 and '-' kept. */
export function entitySlug(key) {
  return key.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * True when any of `urls` (lowercased) contains the entity's slug or the
 * entity with whitespace runs as '/'. Loose on purpose; the header lists what
 * that costs.
 *
 * @param {string} key   an entityKey
 * @param {string[]} urls lowercased URLs
 */
export function hasDedicatedPage(key, urls) {
  const slug = entitySlug(key);
  const asPath = key.replace(/\s+/g, '/');
  return urls.some(u => u.includes(slug) || u.includes(asPath));
}

/** The page an orphan's recommendation names: /solutions/ plus the entity, whitespace hyphenated. */
export function suggestedUrl(key) {
  return SUGGESTED_URL_PREFIX + key.replace(/\s+/g, '-').toLowerCase();
}

/**
 * Orphan entities. Returns
 *   orphans          [{ entity, domains, domainCount, suggestedUrl }], most
 *                    competitor domains first; domains in first-mention order
 *   totalOrphans     orphans.length
 *   extractionCount  extracted pages in the project, any role, whose entity
 *                    list is not empty — 0 means extraction has not run, which
 *                    is the CLI's "run extract" hint
 *   entityCount      distinct entities the competitor pages name — 0 with
 *                    extractionCount > 0 means competitors were extracted to
 *                    nothing, or not extracted at all
 * The harness and the CLI's --format json both return { orphans, totalOrphans }.
 * opts is accepted for the common signature; nothing in it is read.
 */
export function findOrphanEntities(db, project, opts = {}) {
  const { c: extractionCount } = db.prepare(`
    SELECT COUNT(*) AS c FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]' AND e.primary_entities != ''
  `).get(project);

  const rows = db.prepare(`
    SELECT e.primary_entities, p.url, d.domain
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
      AND e.primary_entities IS NOT NULL AND e.primary_entities != ''
  `).all(project);

  const domainsByEntity = new Map();
  for (const row of rows) {
    for (const key of parseEntities(row.primary_entities)) {
      if (!domainsByEntity.has(key)) domainsByEntity.set(key, new Set());
      domainsByEntity.get(key).add(row.domain);
    }
  }

  const competitorUrls = db.prepare(`
    SELECT p.url FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role = 'competitor'
  `).all(project).map(r => r.url.toLowerCase());

  const orphans = [];
  for (const [entity, domains] of domainsByEntity) {
    if (domains.size < BOUNDS.orphanMinDomains) continue;
    if (hasDedicatedPage(entity, competitorUrls)) continue;
    orphans.push({ entity, domains: [...domains], domainCount: domains.size, suggestedUrl: suggestedUrl(entity) });
  }
  orphans.sort((a, b) => b.domainCount - a.domainCount);

  return { orphans, totalOrphans: orphans.length, extractionCount, entityCount: domainsByEntity.size };
}

/**
 * Entity coverage. Returns
 *   gaps       [{ entity, competitorCount, domains }], most competitors first
 *   shared     [{ entity, competitorCount, targetDomains, competitorDomains }],
 *              most competitors first
 *   unique     [{ entity, targetDomains }], first-mention order
 *   summary    { totalEntities, gapCount, sharedCount, uniqueCount }
 *   gapPages   { [entity]: [{ domain, url, role }] } for every gap, every page
 *              naming it in row order (the CLI shows the first two competitor
 *              pages as examples)
 *   minMentions      the threshold used
 *   extractionCount  extraction rows read (0: extraction has not run)
 * targetDomains lists target domains before owned ones. The harness and the
 * CLI's --format json both return { gaps, shared, unique, summary } exactly as
 * shaped here; gapPages, minMentions and extractionCount are the renderer's.
 */
export function getEntityCoverage(db, project, opts = {}) {
  const minMentions = intOpt(opts.minMentions, DEFAULTS.minMentions);

  const rows = db.prepare(`
    SELECT e.primary_entities, d.domain, d.role, p.url
    FROM extractions e
    JOIN pages p ON p.id = e.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
      AND e.primary_entities IS NOT NULL AND e.primary_entities != '[]' AND e.primary_entities != ''
  `).all(project);

  const byEntity = new Map();
  for (const row of rows) {
    for (const key of parseEntities(row.primary_entities)) {
      if (key.length < BOUNDS.entityMinLength) continue;
      let e = byEntity.get(key);
      if (!e) byEntity.set(key, e = { target: new Set(), owned: new Set(), competitor: new Set(), pages: [] });
      if (row.role === 'target') e.target.add(row.domain);
      else if (row.role === 'owned') e.owned.add(row.domain);
      else e.competitor.add(row.domain);
      e.pages.push({ domain: row.domain, url: row.url, role: row.role });
    }
  }

  const gaps = [];
  const shared = [];
  const unique = [];
  const gapPages = [];
  for (const [entity, e] of byEntity) {
    const competitorCount = e.competitor.size;
    const yours = e.target.size > 0 || e.owned.size > 0;
    if (competitorCount >= minMentions && !yours) {
      gaps.push({ entity, competitorCount, domains: [...e.competitor] });
      gapPages.push([entity, e.pages]);
    } else if (competitorCount > 0 && yours) {
      shared.push({ entity, competitorCount, targetDomains: [...e.target, ...e.owned], competitorDomains: [...e.competitor] });
    } else if (competitorCount === 0 && yours) {
      unique.push({ entity, targetDomains: [...e.target, ...e.owned] });
    }
  }
  gaps.sort((a, b) => b.competitorCount - a.competitorCount);
  shared.sort((a, b) => b.competitorCount - a.competitorCount);

  return {
    gaps,
    shared,
    unique,
    summary: { totalEntities: byEntity.size, gapCount: gaps.length, sharedCount: shared.length, uniqueCount: unique.length },
    // fromEntries defines own properties, so an entity called "__proto__" is a key like any other.
    gapPages: Object.fromEntries(gapPages),
    minMentions,
    extractionCount: rows.length,
  };
}
