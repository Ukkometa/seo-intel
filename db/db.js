import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb(dbPath = './seo-intel.db') {
  if (_db) return _db;
  _db = new DatabaseSync(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 10000');
  _db.exec('PRAGMA foreign_keys = ON');

  // Apply schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);

  // Migrations for existing databases
  try { _db.exec('ALTER TABLE pages ADD COLUMN content_hash TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN first_seen_at INTEGER'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN title TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN meta_desc TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN body_text TEXT'); } catch { /* already exists */ }

  // Backfill first_seen_at from crawled_at for existing rows
  _db.exec('UPDATE pages SET first_seen_at = crawled_at WHERE first_seen_at IS NULL');

  // page_schemas table is created by schema.sql — no migration needed (new table)

  return _db;
}

export function upsertDomain(db, { domain, project, role }) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO domains (domain, project, role, first_seen, last_crawled)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      project = excluded.project,
      role = excluded.role,
      last_crawled = excluded.last_crawled
  `).run(domain, project, role, now, now);
}

export function upsertPage(db, { domainId, url, statusCode, wordCount, loadMs, isIndexable, clickDepth = 0, publishedDate = null, modifiedDate = null, contentHash = null, title = null, metaDesc = null, bodyText = null }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO pages (domain_id, url, crawled_at, first_seen_at, status_code, word_count, load_ms, is_indexable, click_depth, published_date, modified_date, content_hash, title, meta_desc, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      crawled_at     = excluded.crawled_at,
      status_code    = excluded.status_code,
      word_count     = excluded.word_count,
      load_ms        = excluded.load_ms,
      click_depth    = excluded.click_depth,
      published_date = excluded.published_date,
      modified_date  = excluded.modified_date,
      content_hash   = excluded.content_hash,
      title          = excluded.title,
      meta_desc      = excluded.meta_desc,
      body_text      = excluded.body_text
  `).run(domainId, url, now, now, statusCode, wordCount, loadMs, isIndexable ? 1 : 0, clickDepth, publishedDate, modifiedDate, contentHash, title || null, metaDesc || null, bodyText || null);
  // first_seen_at is NOT in the ON CONFLICT UPDATE — it stays from original INSERT
  return db.prepare('SELECT id FROM pages WHERE url = ?').get(url);
}

export function upsertTechnical(db, { pageId, hasCanonical, hasOgTags, hasSchema, hasRobots, isMobileOk = 0 }) {
  db.prepare(`
    INSERT INTO technical (page_id, has_canonical, has_og_tags, has_schema, has_robots, is_mobile_ok)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      has_canonical = excluded.has_canonical,
      has_og_tags   = excluded.has_og_tags,
      has_schema    = excluded.has_schema,
      has_robots    = excluded.has_robots,
      is_mobile_ok  = excluded.is_mobile_ok
  `).run(pageId, hasCanonical ? 1 : 0, hasOgTags ? 1 : 0, hasSchema ? 1 : 0, hasRobots ? 1 : 0, isMobileOk ? 1 : 0);
}

export function getPageHash(db, url) {
  return db.prepare('SELECT content_hash FROM pages WHERE url = ?').get(url)?.content_hash || null;
}

export function insertExtraction(db, { pageId, data }) {
  if (!pageId) {
    console.warn('[db] insertExtraction skipped: pageId is missing');
    return null;
  }
  return db.prepare(`
    INSERT OR REPLACE INTO extractions
      (page_id, title, meta_desc, h1, product_type, pricing_tier, cta_primary,
       tech_stack, schema_types, search_intent, primary_entities, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pageId, data.title, data.meta_desc, data.h1,
    data.product_type, data.pricing_tier, data.cta_primary,
    JSON.stringify(data.tech_stack || []),
    JSON.stringify(data.schema_types || []),
    data.search_intent || 'Informational',
    JSON.stringify(data.primary_entities || []),
    Date.now()
  );
}

export function insertKeywords(db, pageId, keywords) {
  const stmt = db.prepare(`INSERT INTO keywords (page_id, keyword, location) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const kw of keywords) stmt.run(pageId, kw.keyword.toLowerCase(), kw.location);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertHeadings(db, pageId, headings) {
  const stmt = db.prepare(`INSERT INTO headings (page_id, level, text) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const h of headings) stmt.run(pageId, h.level, h.text);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertLinks(db, sourceId, links) {
  const stmt = db.prepare(`INSERT INTO links (source_id, target_url, anchor_text, is_internal) VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const l of links) stmt.run(sourceId, l.url, l.anchor, l.isInternal ? 1 : 0);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertPageSchemas(db, pageId, schemas) {
  // Clear old schemas for this page (re-crawl overwrites)
  db.prepare('DELETE FROM page_schemas WHERE page_id = ?').run(pageId);
  if (!schemas || schemas.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO page_schemas
      (page_id, schema_type, name, description, rating, rating_count,
       price, currency, author, date_published, date_modified, image_url,
       raw_json, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const s of schemas) {
      stmt.run(
        pageId,
        s.type,
        s.name || null,
        s.description?.slice(0, 500) || null,
        s.rating ?? null,
        s.ratingCount ?? null,
        s.price || null,
        s.currency || null,
        s.author || null,
        s.datePublished || null,
        s.dateModified || null,
        s.imageUrl || null,
        JSON.stringify(s.raw),
        Date.now()
      );
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getSchemasByProject(db, project) {
  return db.prepare(`
    SELECT
      d.domain, d.role, p.url,
      ps.schema_type, ps.name, ps.description,
      ps.rating, ps.rating_count,
      ps.price, ps.currency,
      ps.author, ps.date_published, ps.date_modified,
      ps.image_url, ps.raw_json
    FROM page_schemas ps
    JOIN pages p ON p.id = ps.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    ORDER BY d.domain, ps.schema_type
  `).all(project);
}

export function getCompetitorSummary(db, project) {
  return db.prepare(`
    SELECT
      d.domain,
      d.role,
      COUNT(DISTINCT p.id) as page_count,
      AVG(p.word_count) as avg_word_count,
      GROUP_CONCAT(DISTINCT e.product_type) as product_types,
      GROUP_CONCAT(DISTINCT e.pricing_tier) as pricing_tiers,
      GROUP_CONCAT(DISTINCT e.cta_primary) as ctas
    FROM domains d
    JOIN pages p ON p.domain_id = d.id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ?
    GROUP BY d.domain, d.role
  `).all(project);
}

export function getKeywordMatrix(db, project) {
  return db.prepare(`
    SELECT
      k.keyword,
      d.domain,
      d.role,
      k.location,
      COUNT(*) as freq
    FROM keywords k
    JOIN pages p ON p.id = k.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    GROUP BY k.keyword, d.domain
    ORDER BY freq DESC
  `).all(project);
}

// ── Template analysis ─────────────────────────────────────────────────────

export function upsertTemplateGroup(db, g) {
  return db.prepare(`
    INSERT INTO template_groups
      (project, domain, pattern, url_count, sample_size,
       avg_word_count, content_similarity, dom_similarity,
       gsc_urls_with_impressions, gsc_total_clicks, gsc_total_impressions,
       gsc_avg_position, indexation_efficiency, score, verdict, recommendation,
       analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, domain, pattern) DO UPDATE SET
      url_count = excluded.url_count,
      sample_size = excluded.sample_size,
      avg_word_count = excluded.avg_word_count,
      content_similarity = excluded.content_similarity,
      dom_similarity = excluded.dom_similarity,
      gsc_urls_with_impressions = excluded.gsc_urls_with_impressions,
      gsc_total_clicks = excluded.gsc_total_clicks,
      gsc_total_impressions = excluded.gsc_total_impressions,
      gsc_avg_position = excluded.gsc_avg_position,
      indexation_efficiency = excluded.indexation_efficiency,
      score = excluded.score,
      verdict = excluded.verdict,
      recommendation = excluded.recommendation,
      analyzed_at = excluded.analyzed_at
  `).run(
    g.project, g.domain, g.pattern, g.urlCount, g.sampleSize || 0,
    g.avgWordCount ?? null, g.contentSimilarity ?? null, g.domSimilarity ?? null,
    g.gscUrlsWithImpressions || 0, g.gscTotalClicks || 0, g.gscTotalImpressions || 0,
    g.gscAvgPosition ?? null, g.indexationEfficiency ?? null,
    g.score ?? null, g.verdict || null, JSON.stringify(g.recommendation || []),
    g.analyzedAt || Date.now()
  );
}

export function getTemplateGroupId(db, project, domain, pattern) {
  return db.prepare(
    'SELECT id FROM template_groups WHERE project = ? AND domain = ? AND pattern = ?'
  ).get(project, domain, pattern)?.id;
}

export function upsertTemplateSample(db, s) {
  db.prepare(`
    INSERT INTO template_samples
      (group_id, url, sample_role, status_code, word_count,
       title, meta_desc, has_canonical, has_schema, is_indexable,
       dom_fingerprint, content_hash, body_text, crawled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, url) DO UPDATE SET
      sample_role = excluded.sample_role,
      status_code = excluded.status_code,
      word_count = excluded.word_count,
      title = excluded.title,
      meta_desc = excluded.meta_desc,
      has_canonical = excluded.has_canonical,
      has_schema = excluded.has_schema,
      is_indexable = excluded.is_indexable,
      dom_fingerprint = excluded.dom_fingerprint,
      content_hash = excluded.content_hash,
      body_text = excluded.body_text,
      crawled_at = excluded.crawled_at
  `).run(
    s.groupId, s.url, s.sampleRole, s.statusCode ?? null, s.wordCount ?? null,
    s.title || null, s.metaDesc || null,
    s.hasCanonical ? 1 : 0, s.hasSchema ? 1 : 0, s.isIndexable ? 1 : 0,
    s.domFingerprint || null, s.contentHash || null, s.bodyText || null,
    s.crawledAt || Date.now()
  );
}

export function getTemplateGroups(db, project) {
  return db.prepare(
    'SELECT * FROM template_groups WHERE project = ? ORDER BY url_count DESC'
  ).all(project);
}

export function getTemplateSamples(db, groupId) {
  return db.prepare(
    'SELECT * FROM template_samples WHERE group_id = ? ORDER BY sample_role, url'
  ).all(groupId);
}

// ── Domain sync / prune ───────────────────────────────────────────────────

/**
 * Remove DB domains (+ all child data) that no longer exist in config.
 * Returns array of pruned domain names.
 */
export function pruneStaleDomains(db, project, configDomains) {
  // configDomains = Set or array of domain strings currently in config
  const validSet = new Set(configDomains);

  const dbDomains = db.prepare(
    'SELECT id, domain FROM domains WHERE project = ?'
  ).all(project);

  const stale = dbDomains.filter(d => !validSet.has(d.domain));
  if (!stale.length) return [];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const { id, domain } of stale) {
      // Delete all child tables referencing pages in this domain
      const pageIds = db.prepare(
        'SELECT id FROM pages WHERE domain_id = ?'
      ).all(id).map(r => r.id);

      if (pageIds.length) {
        const placeholders = pageIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM links WHERE source_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM technical WHERE page_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM headings WHERE page_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM page_schemas WHERE page_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM extractions WHERE page_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM keywords WHERE page_id IN (${placeholders})`).run(...pageIds);
        db.prepare(`DELETE FROM pages WHERE domain_id = ?`).run(id);
      }

      // Template groups for this domain
      db.prepare(
        'DELETE FROM template_samples WHERE group_id IN (SELECT id FROM template_groups WHERE project = ? AND domain = ?)'
      ).run(project, domain);
      db.prepare(
        'DELETE FROM template_groups WHERE project = ? AND domain = ?'
      ).run(project, domain);

      db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  return stale.map(d => d.domain);
}

export function getHeadingStructure(db, project) {
  return db.prepare(`
    SELECT d.domain, d.role, h.level, h.text
    FROM headings h
    JOIN pages p ON p.id = h.page_id
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ?
    ORDER BY d.domain, h.level
  `).all(project);
}
