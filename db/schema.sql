-- SEO Intel Database Schema

CREATE TABLE IF NOT EXISTS domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT UNIQUE NOT NULL,
  project     TEXT NOT NULL,  -- 'carbium' | 'ukkometa'
  role        TEXT NOT NULL,  -- 'target' | 'competitor'
  first_seen  INTEGER NOT NULL,
  last_crawled INTEGER
);

CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id     INTEGER NOT NULL REFERENCES domains(id),
  url           TEXT UNIQUE NOT NULL,
  crawled_at    INTEGER NOT NULL,
  status_code   INTEGER,
  word_count    INTEGER,
  load_ms       INTEGER,
  is_indexable  INTEGER DEFAULT 1,
  click_depth   INTEGER DEFAULT 0,   -- BFS depth from homepage (0 = homepage)
  published_date TEXT,               -- ISO string or null
  modified_date  TEXT,               -- ISO string or null
  FOREIGN KEY (domain_id) REFERENCES domains(id)
);

CREATE TABLE IF NOT EXISTS extractions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id          INTEGER UNIQUE NOT NULL REFERENCES pages(id),
  title            TEXT,
  meta_desc        TEXT,
  h1               TEXT,
  product_type     TEXT,
  pricing_tier     TEXT,             -- 'free' | 'freemium' | 'paid' | 'enterprise' | 'none'
  cta_primary      TEXT,
  tech_stack       TEXT,             -- JSON array
  schema_types     TEXT,             -- JSON array (Article, Product, FAQ, etc.)
  search_intent    TEXT,             -- 'Informational' | 'Navigational' | 'Commercial' | 'Transactional'
  primary_entities TEXT,             -- JSON array of 3-7 core concept strings
  extracted_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS headings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id   INTEGER NOT NULL REFERENCES pages(id),
  level     INTEGER NOT NULL,  -- 1-6
  text      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id             INTEGER NOT NULL REFERENCES pages(id),
  keyword             TEXT NOT NULL,
  location            TEXT NOT NULL,  -- 'title' | 'h1' | 'h2' | 'meta' | 'body'
  search_volume       INTEGER,        -- monthly search volume (null until API populated)
  keyword_difficulty  INTEGER         -- 0-100 (null until API populated)
);

CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES pages(id),
  target_url  TEXT NOT NULL,
  anchor_text TEXT,
  is_internal INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS technical (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         INTEGER UNIQUE NOT NULL REFERENCES pages(id),
  has_canonical   INTEGER DEFAULT 0,
  has_og_tags     INTEGER DEFAULT 0,
  has_schema      INTEGER DEFAULT 0,
  is_mobile_ok    INTEGER DEFAULT 0,
  has_sitemap     INTEGER DEFAULT 0,
  has_robots      INTEGER DEFAULT 0,
  core_web_vitals TEXT  -- JSON: { lcp, cls, fid }
);

CREATE TABLE IF NOT EXISTS analyses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  model         TEXT NOT NULL,
  keyword_gaps  TEXT,  -- JSON array
  long_tails    TEXT,  -- JSON array
  quick_wins    TEXT,  -- JSON array
  new_pages     TEXT,  -- JSON array
  content_gaps  TEXT,  -- JSON array
  positioning   TEXT,
  raw           TEXT   -- full model response
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain_id);
CREATE INDEX IF NOT EXISTS idx_keywords_page ON keywords(page_id);
CREATE INDEX IF NOT EXISTS idx_keywords_kw ON keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_headings_page ON headings(page_id);
