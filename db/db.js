import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb(dbPath = './seo-intel.db') {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Apply schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);

  return _db;
}

export function upsertDomain(db, { domain, project, role }) {
  return db.prepare(`
    INSERT INTO domains (domain, project, role, first_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET last_crawled = ?
  `).run(domain, project, role, Date.now(), Date.now());
}

export function upsertPage(db, { domainId, url, statusCode, wordCount, loadMs, isIndexable }) {
  return db.prepare(`
    INSERT INTO pages (domain_id, url, crawled_at, status_code, word_count, load_ms, is_indexable)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      crawled_at = excluded.crawled_at,
      status_code = excluded.status_code,
      word_count = excluded.word_count,
      load_ms = excluded.load_ms
  `).run(domainId, url, Date.now(), statusCode, wordCount, loadMs, isIndexable ? 1 : 0);
}

export function insertExtraction(db, { pageId, data }) {
  return db.prepare(`
    INSERT OR REPLACE INTO extractions
      (page_id, title, meta_desc, h1, product_type, pricing_tier, cta_primary, tech_stack, schema_types, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pageId, data.title, data.meta_desc, data.h1,
    data.product_type, data.pricing_tier, data.cta_primary,
    JSON.stringify(data.tech_stack || []),
    JSON.stringify(data.schema_types || []),
    Date.now()
  );
}

export function insertKeywords(db, pageId, keywords) {
  const stmt = db.prepare(`
    INSERT INTO keywords (page_id, keyword, location) VALUES (?, ?, ?)
  `);
  const insertMany = db.transaction((kws) => {
    for (const kw of kws) stmt.run(pageId, kw.keyword.toLowerCase(), kw.location);
  });
  insertMany(keywords);
}

export function insertHeadings(db, pageId, headings) {
  const stmt = db.prepare(`INSERT INTO headings (page_id, level, text) VALUES (?, ?, ?)`);
  const insertMany = db.transaction((hs) => {
    for (const h of hs) stmt.run(pageId, h.level, h.text);
  });
  insertMany(headings);
}

export function insertLinks(db, sourceId, links) {
  const stmt = db.prepare(`
    INSERT INTO links (source_id, target_url, anchor_text, is_internal) VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction((ls) => {
    for (const l of ls) stmt.run(sourceId, l.url, l.anchor, l.isInternal ? 1 : 0);
  });
  insertMany(links);
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
