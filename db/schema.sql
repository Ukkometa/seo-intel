-- SEO Intel Database Schema

CREATE TABLE IF NOT EXISTS domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT UNIQUE NOT NULL,
  project     TEXT NOT NULL,  -- e.g. 'mysite'
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
  first_seen_at  INTEGER,            -- epoch ms when this URL was first discovered
  published_date TEXT,               -- ISO string or null
  modified_date  TEXT,               -- ISO string or null
  content_hash   TEXT,               -- SHA-256 of body text for incremental crawling
  title          TEXT,               -- page <title>
  meta_desc      TEXT,               -- meta description
  body_text      TEXT,               -- cleaned body text for extraction (stored at crawl time)
  final_url      TEXT,               -- URL after redirects (page.url() post-nav)
  redirect_chain TEXT,               -- JSON array of [{url, status}] hops, empty array if none
  x_robots_tag   TEXT,               -- X-Robots-Tag response header value (raw)
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
  intent_scores    TEXT,             -- JSON object: {"commercial":70,"informational":20,"comparison":10}
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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  generated_at    INTEGER NOT NULL,
  model           TEXT NOT NULL,
  keyword_gaps    TEXT,  -- JSON array
  long_tails      TEXT,  -- JSON array
  quick_wins      TEXT,  -- JSON array
  new_pages       TEXT,  -- JSON array
  content_gaps    TEXT,  -- JSON array
  positioning     TEXT,
  technical_gaps  TEXT,  -- JSON array
  raw             TEXT   -- full model response
);

-- Intelligence Ledger: individual insights accumulated across analysis runs
CREATE TABLE IF NOT EXISTS insights (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project             TEXT NOT NULL,
  type                TEXT NOT NULL,   -- keyword_gap | long_tail | quick_win | new_page | content_gap | technical_gap | positioning | keyword_inventor
  status              TEXT NOT NULL DEFAULT 'active',  -- active | done | dismissed
  fingerprint         TEXT NOT NULL,   -- normalised dedup key
  first_seen          INTEGER NOT NULL, -- epoch ms
  last_seen           INTEGER NOT NULL, -- epoch ms
  source_analysis_id  INTEGER,         -- FK to analyses.id (NULL for keyword_inventor)
  data                TEXT NOT NULL,   -- JSON blob for the individual item
  UNIQUE(project, type, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_insights_project_status ON insights(project, status);
CREATE INDEX IF NOT EXISTS idx_insights_project_type ON insights(project, type);

CREATE TABLE IF NOT EXISTS page_schemas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id     INTEGER NOT NULL REFERENCES pages(id),
  schema_type TEXT NOT NULL,            -- '@type' value: Organization, Product, Article, FAQ, etc.
  name        TEXT,                     -- schema name field
  description TEXT,                     -- schema description field
  rating      REAL,                     -- aggregateRating.ratingValue
  rating_count INTEGER,                -- aggregateRating.reviewCount or ratingCount
  price       TEXT,                     -- offers.price or priceRange
  currency    TEXT,                     -- offers.priceCurrency
  author      TEXT,                     -- author.name
  date_published TEXT,                  -- datePublished from schema
  date_modified  TEXT,                  -- dateModified from schema
  image_url   TEXT,                     -- image or image.url
  raw_json    TEXT NOT NULL,            -- full JSON-LD object for future queries
  extracted_at INTEGER NOT NULL
);

-- Template analysis tables
CREATE TABLE IF NOT EXISTS template_groups (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project                   TEXT NOT NULL,
  domain                    TEXT NOT NULL,
  pattern                   TEXT NOT NULL,
  url_count                 INTEGER NOT NULL,
  sample_size               INTEGER NOT NULL DEFAULT 0,
  avg_word_count            REAL,
  content_similarity        REAL,
  dom_similarity            REAL,
  gsc_urls_with_impressions INTEGER DEFAULT 0,
  gsc_total_clicks          INTEGER DEFAULT 0,
  gsc_total_impressions     INTEGER DEFAULT 0,
  gsc_avg_position          REAL,
  indexation_efficiency     REAL,
  score                     INTEGER,
  verdict                   TEXT,
  recommendation            TEXT,
  analyzed_at               INTEGER NOT NULL,
  UNIQUE(project, domain, pattern)
);

CREATE TABLE IF NOT EXISTS template_samples (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        INTEGER NOT NULL REFERENCES template_groups(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  sample_role     TEXT NOT NULL,
  status_code     INTEGER,
  word_count      INTEGER,
  title           TEXT,
  meta_desc       TEXT,
  has_canonical   INTEGER DEFAULT 0,
  has_schema      INTEGER DEFAULT 0,
  is_indexable    INTEGER DEFAULT 1,
  dom_fingerprint TEXT,
  content_hash    TEXT,
  body_text       TEXT,
  crawled_at      INTEGER,
  UNIQUE(group_id, url)
);

CREATE INDEX IF NOT EXISTS idx_template_groups_project ON template_groups(project);
CREATE INDEX IF NOT EXISTS idx_template_samples_group ON template_samples(group_id);

-- AEO / AI Citability scores (one per page, re-scorable)
CREATE TABLE IF NOT EXISTS citability_scores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id           INTEGER UNIQUE NOT NULL REFERENCES pages(id),
  score             INTEGER NOT NULL,           -- composite 0-100
  entity_authority  INTEGER NOT NULL DEFAULT 0,
  structured_claims INTEGER NOT NULL DEFAULT 0,
  answer_density    INTEGER NOT NULL DEFAULT 0,
  qa_proximity      INTEGER NOT NULL DEFAULT 0,
  freshness         INTEGER NOT NULL DEFAULT 0,
  schema_coverage   INTEGER NOT NULL DEFAULT 0,
  ai_intents        TEXT,                       -- JSON array: synthesis, decision_support, etc.
  tier              TEXT NOT NULL DEFAULT 'poor', -- excellent | good | needs_work | poor
  scored_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_citability_page ON citability_scores(page_id);

-- Sitemap URL inventory (one row per URL declared in a sitemap)
CREATE TABLE IF NOT EXISTS sitemap_urls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id      INTEGER NOT NULL REFERENCES domains(id),
  url            TEXT NOT NULL,
  sitemap_source TEXT,                         -- which sitemap file this came from
  discovered_at  INTEGER NOT NULL,
  head_status    INTEGER,                      -- HTTP status from HEAD check (null until audit runs)
  head_location  TEXT,                         -- Location header when redirected
  head_checked_at INTEGER,
  UNIQUE(domain_id, url)
);

CREATE INDEX IF NOT EXISTS idx_sitemap_urls_domain ON sitemap_urls(domain_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain_id);
CREATE INDEX IF NOT EXISTS idx_keywords_page ON keywords(page_id);
CREATE INDEX IF NOT EXISTS idx_keywords_kw ON keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_id);
CREATE INDEX IF NOT EXISTS idx_headings_page ON headings(page_id);
CREATE INDEX IF NOT EXISTS idx_page_schemas_page ON page_schemas(page_id);
CREATE INDEX IF NOT EXISTS idx_page_schemas_type ON page_schemas(schema_type);
