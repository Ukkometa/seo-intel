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
  try { _db.exec('ALTER TABLE pages ADD COLUMN final_url TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN redirect_chain TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE pages ADD COLUMN x_robots_tag TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE analyses ADD COLUMN technical_gaps TEXT'); } catch { /* already exists */ }
  try { _db.exec('ALTER TABLE extractions ADD COLUMN intent_scores TEXT'); } catch { /* already exists */ }

  // Backfill first_seen_at from crawled_at for existing rows
  _db.exec('UPDATE pages SET first_seen_at = crawled_at WHERE first_seen_at IS NULL');

  // Site Watch tables
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS watch_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project        TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        total_pages    INTEGER NOT NULL DEFAULT 0,
        health_score   INTEGER,
        errors_count   INTEGER NOT NULL DEFAULT 0,
        warnings_count INTEGER NOT NULL DEFAULT 0,
        notices_count  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_watch_snapshots_project ON watch_snapshots(project, created_at DESC);

      CREATE TABLE IF NOT EXISTS watch_page_states (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id  INTEGER NOT NULL REFERENCES watch_snapshots(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        status_code  INTEGER,
        title        TEXT,
        h1           TEXT,
        meta_desc    TEXT,
        word_count   INTEGER,
        is_indexable INTEGER DEFAULT 1,
        content_hash TEXT,
        UNIQUE(snapshot_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_watch_page_states_snapshot ON watch_page_states(snapshot_id);

      CREATE TABLE IF NOT EXISTS watch_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id  INTEGER NOT NULL REFERENCES watch_snapshots(id) ON DELETE CASCADE,
        event_type   TEXT NOT NULL,
        severity     TEXT NOT NULL,
        url          TEXT NOT NULL,
        old_value    TEXT,
        new_value    TEXT,
        details      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_watch_events_snapshot ON watch_events(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_watch_events_type ON watch_events(event_type);
    `);
  } catch { /* tables already exist */ }

  // Migrate existing analyses → insights (one-time)
  _migrateAnalysesToInsights(_db);

  return _db;
}

// ── Insight fingerprinting ──────────────────────────────────────────────────

function _insightFingerprint(type, item) {
  let raw;
  switch (type) {
    case 'keyword_gap':       raw = item.keyword || ''; break;
    case 'long_tail':         raw = item.phrase || ''; break;
    case 'quick_win':         raw = `${item.page || ''}::${item.issue || ''}`; break;
    case 'new_page':          raw = item.target_keyword || item.title || ''; break;
    case 'content_gap':       raw = item.topic || ''; break;
    case 'technical_gap':     raw = item.gap || ''; break;
    case 'positioning':       raw = 'positioning'; break;
    case 'keyword_inventor':  raw = item.phrase || ''; break;
    case 'citability_gap':    raw = item.url || ''; break;
    case 'site_watch':        raw = `${item.url || ''}::${item.event_type || ''}`; break;
    default:                  raw = JSON.stringify(item);
  }
  return raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Migrate all historical analyses into insights ───────────────────────────

function _migrateAnalysesToInsights(db) {
  const count = db.prepare('SELECT COUNT(*) as n FROM insights').get().n;
  if (count > 0) return; // already migrated

  const rows = db.prepare('SELECT * FROM analyses ORDER BY generated_at ASC').all();
  if (!rows.length) return;

  const safeJsonParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const ts = row.generated_at;
      const fields = [
        ['keyword_gap',   safeJsonParse(row.keyword_gaps)],
        ['long_tail',     safeJsonParse(row.long_tails)],
        ['quick_win',     safeJsonParse(row.quick_wins)],
        ['new_page',      safeJsonParse(row.new_pages)],
        ['content_gap',   safeJsonParse(row.content_gaps)],
        ['technical_gap', safeJsonParse(row.technical_gaps)],
      ];
      for (const [type, items] of fields) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const fp = _insightFingerprint(type, item);
          if (!fp) continue;
          upsertStmt.run(row.project, type, fp, ts, ts, row.id, JSON.stringify(item));
        }
      }
      // positioning is a singleton object, not an array
      const pos = safeJsonParse(row.positioning);
      if (pos && typeof pos === 'object' && Object.keys(pos).length) {
        const fp = _insightFingerprint('positioning', pos);
        upsertStmt.run(row.project, 'positioning', fp, ts, ts, row.id, JSON.stringify(pos));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] insights migration failed:', e.message);
  }
}

// ── Insight upsert (called after each analyze/keywords run) ─────────────────

export function upsertInsightsFromAnalysis(db, project, analysisId, analysis, timestamp) {
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `);

  const ts = timestamp || Date.now();
  db.exec('BEGIN');
  try {
    const fields = [
      ['keyword_gap',   analysis.keyword_gaps],
      ['long_tail',     analysis.long_tails],
      ['quick_win',     analysis.quick_wins],
      ['new_page',      analysis.new_pages],
      ['content_gap',   analysis.content_gaps],
      ['technical_gap', analysis.technical_gaps],
    ];
    for (const [type, items] of fields) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const fp = _insightFingerprint(type, item);
        if (!fp) continue;
        upsertStmt.run(project, type, fp, ts, ts, analysisId, JSON.stringify(item));
      }
    }
    if (analysis.positioning && typeof analysis.positioning === 'object') {
      const fp = _insightFingerprint('positioning', analysis.positioning);
      upsertStmt.run(project, 'positioning', fp, ts, ts, analysisId, JSON.stringify(analysis.positioning));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] insight upsert failed:', e.message);
  }
}

export function upsertInsightsFromKeywords(db, project, keywordsReport) {
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data)
    VALUES (?, 'keyword_inventor', 'active', ?, ?, ?, NULL, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `);

  const ts = Date.now();
  const allClusters = keywordsReport.keyword_clusters || [];
  const allKws = allClusters.flatMap(c => (c.keywords || []).map(k => ({ ...k, cluster: c.topic })));

  db.exec('BEGIN');
  try {
    for (const kw of allKws) {
      const fp = _insightFingerprint('keyword_inventor', kw);
      if (!fp) continue;
      upsertStmt.run(project, fp, ts, ts, JSON.stringify(kw));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] keyword insight upsert failed:', e.message);
  }
}

// ── Read active insights (accumulated across all runs) ──────────────────────

export function getActiveInsights(db, project) {
  const rows = db.prepare(
    `SELECT * FROM insights WHERE project = ? AND status = 'active' ORDER BY type, last_seen DESC`
  ).all(project);

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.type]) grouped[row.type] = [];
    const parsed = JSON.parse(row.data);
    parsed._insight_id = row.id;
    parsed._first_seen = row.first_seen;
    parsed._last_seen = row.last_seen;
    grouped[row.type].push(parsed);
  }

  return {
    keyword_gaps: grouped.keyword_gap || [],
    long_tails: grouped.long_tail || [],
    quick_wins: grouped.quick_win || [],
    new_pages: grouped.new_page || [],
    content_gaps: grouped.content_gap || [],
    technical_gaps: grouped.technical_gap || [],
    positioning: grouped.positioning?.[0] || null,
    keyword_inventor: grouped.keyword_inventor || [],
    site_watch: grouped.site_watch || [],
    generated_at: rows.length ? Math.max(...rows.map(r => r.last_seen)) : null,
  };
}

export function updateInsightStatus(db, id, status) {
  db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id);
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

function normalizePageUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';                              // strip fragments (#pricing, #faq, etc.)
    let path = u.pathname;
    path = path.replace(/\/index\.html?$/i, '/');  // /en/index.html → /en/
    u.pathname = path;
    return u.toString();
  } catch { return rawUrl; }
}

export function upsertPage(db, { domainId, url, statusCode, wordCount, loadMs, isIndexable, clickDepth = 0, publishedDate = null, modifiedDate = null, contentHash = null, title = null, metaDesc = null, bodyText = null, finalUrl = null, redirectChain = null, xRobotsTag = null }) {
  url = normalizePageUrl(url);
  const now = Date.now();
  const redirectChainJson = redirectChain ? JSON.stringify(redirectChain) : null;
  db.prepare(`
    INSERT INTO pages (domain_id, url, crawled_at, first_seen_at, status_code, word_count, load_ms, is_indexable, click_depth, published_date, modified_date, content_hash, title, meta_desc, body_text, final_url, redirect_chain, x_robots_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      body_text      = excluded.body_text,
      final_url      = excluded.final_url,
      redirect_chain = excluded.redirect_chain,
      x_robots_tag   = excluded.x_robots_tag
  `).run(domainId, url, now, now, statusCode, wordCount, loadMs, isIndexable ? 1 : 0, clickDepth, publishedDate, modifiedDate, contentHash, title || null, metaDesc || null, bodyText || null, finalUrl || null, redirectChainJson, xRobotsTag || null);
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
       tech_stack, schema_types, search_intent, intent_scores, primary_entities, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pageId, data.title, data.meta_desc, data.h1,
    data.product_type, data.pricing_tier, data.cta_primary,
    JSON.stringify(data.tech_stack || []),
    JSON.stringify(data.schema_types || []),
    data.search_intent || 'Informational',
    JSON.stringify(data.intent_scores || {}),
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
    for (const l of links) stmt.run(sourceId, normalizePageUrl(l.url), l.anchor, l.isInternal ? 1 : 0);
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
  // target + owned rows are merged into a single 'target' row.
  // This handles the common case where the target domain (e.g. dgents.ai) redirects
  // to www.dgents.ai, which gets crawled as an owned subdomain — the parallel crawl
  // race means pages end up under 'owned', leaving the target with 0 pages.
  return db.prepare(`
    SELECT
      d.domain,
      CASE WHEN d.role IN ('target', 'owned') THEN 'target' ELSE d.role END AS role,
      COUNT(DISTINCT p.id) as page_count,
      AVG(p.word_count) as avg_word_count,
      GROUP_CONCAT(DISTINCT e.product_type) as product_types,
      GROUP_CONCAT(DISTINCT e.pricing_tier) as pricing_tiers,
      GROUP_CONCAT(DISTINCT e.cta_primary) as ctas
    FROM domains d
    JOIN pages p ON p.domain_id = d.id
    LEFT JOIN extractions e ON e.page_id = p.id
    WHERE d.project = ?
    GROUP BY
      CASE WHEN d.role IN ('target', 'owned') THEN 'target-group' ELSE d.domain END,
      CASE WHEN d.role IN ('target', 'owned') THEN 'target' ELSE d.role END
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

// ── Sitemap URL inventory ─────────────────────────────────────────────────

export function upsertSitemapUrls(db, domainId, urls, sitemapSource = null) {
  if (!urls || !urls.length) return 0;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO sitemap_urls (domain_id, url, sitemap_source, discovered_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(domain_id, url) DO UPDATE SET
      sitemap_source = COALESCE(excluded.sitemap_source, sitemap_urls.sitemap_source),
      discovered_at = excluded.discovered_at
  `);
  db.exec('BEGIN');
  try {
    for (const u of urls) {
      const normalized = normalizePageUrl(u);
      stmt.run(domainId, normalized, sitemapSource, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return urls.length;
}

export function getSitemapUrlsForDomain(db, domainId) {
  return db.prepare(
    'SELECT * FROM sitemap_urls WHERE domain_id = ?'
  ).all(domainId);
}

export function updateSitemapHeadResult(db, id, { status, location }) {
  db.prepare(
    'UPDATE sitemap_urls SET head_status = ?, head_location = ?, head_checked_at = ? WHERE id = ?'
  ).run(status ?? null, location ?? null, Date.now(), id);
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
        try { db.prepare(`DELETE FROM citability_scores WHERE page_id IN (${placeholders})`).run(...pageIds); } catch { /* table may not exist */ }
        db.prepare(`DELETE FROM pages WHERE domain_id = ?`).run(id);
      }

      // Sitemap URLs for this domain
      try { db.prepare('DELETE FROM sitemap_urls WHERE domain_id = ?').run(id); } catch { /* table may not exist */ }

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

// ── Site Watch ────────────────────────────────────────────────────────────

export function getLatestWatchSnapshot(db, project) {
  return db.prepare(
    'SELECT * FROM watch_snapshots WHERE project = ? ORDER BY created_at DESC LIMIT 1'
  ).get(project) || null;
}

export function getWatchPageStates(db, snapshotId) {
  return db.prepare(
    'SELECT * FROM watch_page_states WHERE snapshot_id = ?'
  ).all(snapshotId);
}

export function getWatchEvents(db, snapshotId) {
  return db.prepare(
    'SELECT * FROM watch_events WHERE snapshot_id = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END, event_type'
  ).all(snapshotId);
}

export function getWatchHistory(db, project, limit = 10) {
  return db.prepare(
    'SELECT * FROM watch_snapshots WHERE project = ? ORDER BY created_at DESC LIMIT ?'
  ).all(project, limit);
}
