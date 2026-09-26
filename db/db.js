import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { INSIGHT_TYPES, INSIGHT_TYPE_KEYS, MODEL_INSIGHT_TYPES, insightMeta } from '../lib/insight-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

/**
 * Resolve the database file deterministically.
 *
 * This used to default to './seo-intel.db', which resolves against process.cwd().
 * The CLI run from the package directory and an MCP server launched from the
 * user's project therefore opened *different* databases — and the second one was
 * silently created empty rather than failing, so it read as "no data" instead of
 * "wrong file". Anchor on the package root so one install always means one
 * database, and let SEO_INTEL_DB override it for callers that want their own.
 */
export function resolveDbPath() {
  const fromEnv = process.env.SEO_INTEL_DB;
  if (fromEnv) return resolve(fromEnv);
  const local = join(__dirname, '..', 'seo-intel.db');
  if (existsSync(local)) return local;
  // No database here yet. A host that launches the MCP server through `npx`
  // (Hermes, the Claude Code plugin) runs a package copy in the npx cache —
  // creating an empty database there would split the user's data in two.
  // Every CLI run registers its own root in ~/.seo-intel/install.json; if
  // that root already holds a database, share it.
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), '.seo-intel', 'install.json'), 'utf8'));
    const shared = reg?.root && join(resolve(reg.root), 'seo-intel.db');
    if (shared && shared !== local && existsSync(shared)) return shared;
  } catch { /* no registry — fall through */ }
  return local;
}

export function getDb(dbPath = resolveDbPath()) {
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
  try { _db.exec("ALTER TABLE insights ADD COLUMN source TEXT DEFAULT 'cli'"); } catch { /* already exists */ }
  // Finding provenance (six columns plus the backfill of older rows), then the
  // boot-time expiry sweep. In this order: the sweep reads expires_at, which
  // the migration adds.
  migrateInsightProvenance(_db);
  expireInsights(_db);

  // Problem status tracking (v1.5.35) — agents/users mark items as fixed/wont_fix/snoozed
  _db.exec(`
    CREATE TABLE IF NOT EXISTS gsc_queries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project      TEXT NOT NULL,
      page_url     TEXT,              -- NULL = property-wide export, no page filter
      query        TEXT NOT NULL,
      clicks       INTEGER DEFAULT 0,
      impressions  INTEGER DEFAULT 0,
      ctr          REAL,              -- percent, as GSC exports it (0.93 = 0.93%)
      position     REAL,
      date_range   TEXT,              -- verbatim from the export's Filters.csv
      source       TEXT,              -- folder the rows came from
      imported_at  INTEGER NOT NULL,
      UNIQUE(project, page_url, query, date_range)
    );
    CREATE INDEX IF NOT EXISTS idx_gsc_queries_page ON gsc_queries(project, page_url);

    -- The UNIQUE(project, page_url, query, date_range) constraint above never
    -- fires for property-wide exports: page_url is NULL there, and SQLite treats
    -- NULLs as distinct in a unique index. Re-importing the same export appended
    -- duplicate rows and inflated impressions instead of updating in place. The
    -- expression index below closes that hole; the migration that collapses any
    -- rows already duplicated runs once, just after this block.

    -- Search Analytics API rows (lib/gsc-api.js). One row per (property, grain,
    -- day, page, query). Kept apart from gsc_queries on purpose: that table
    -- holds UI exports with ctr in PERCENT and a prose date_range, this one
    -- holds API rows with ctr as a 0-1 FRACTION and a real date. Mixing them
    -- would double one or halve the other in every aggregate.
    CREATE TABLE IF NOT EXISTS gsc_daily (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project      TEXT NOT NULL,
      property     TEXT NOT NULL,      -- Search Console siteUrl the rows came from
      grain        TEXT NOT NULL,      -- page_query | page | query
      search_type  TEXT NOT NULL DEFAULT 'web',
      date         TEXT NOT NULL,      -- YYYY-MM-DD as the API returns it
      page_url     TEXT,               -- NULL for the query grain
      query        TEXT,               -- NULL for the page grain
      clicks       INTEGER NOT NULL DEFAULT 0,
      impressions  INTEGER NOT NULL DEFAULT 0,
      ctr          REAL,               -- fraction 0-1 as the API returns it (gsc_queries stores PERCENT — do not mix)
      position     REAL,
      fetched_at   INTEGER NOT NULL
    );
    -- Identity over COALESCE so the NULL page_url of the query grain and the
    -- NULL query of the page grain still collide on re-fetch (see the
    -- gsc_queries note above for why a plain UNIQUE would not).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_daily_identity
      ON gsc_daily(project, property, grain, search_type, date, COALESCE(page_url,''), COALESCE(query,''));
    CREATE INDEX IF NOT EXISTS idx_gsc_daily_page ON gsc_daily(project, grain, page_url, date);
    CREATE INDEX IF NOT EXISTS idx_gsc_daily_date ON gsc_daily(project, grain, date);

    -- One row per API walk, so "what did we fetch, when, and was it cut short?"
    -- is answerable without re-deriving it from gsc_daily.
    CREATE TABLE IF NOT EXISTS gsc_fetches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      property    TEXT NOT NULL,
      grain       TEXT NOT NULL,
      search_type TEXT NOT NULL DEFAULT 'web',
      start_date  TEXT NOT NULL,
      end_date    TEXT NOT NULL,
      rows        INTEGER NOT NULL,
      requests    INTEGER NOT NULL,
      truncated   INTEGER NOT NULL DEFAULT 0,
      fetched_at  INTEGER NOT NULL
    );

    -- Google's own index verdict per URL (URL Inspection API, analyses/gsc-inspect).
    -- One row per (project, url): a fresh inspection replaces the old one,
    -- because the question is "what does Google say now", not a history. The
    -- crawl can only infer indexability from tags; this table holds the fact.
    CREATE TABLE IF NOT EXISTS gsc_inspections (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      project               TEXT NOT NULL,
      property              TEXT NOT NULL,
      url                   TEXT NOT NULL,        -- as inspected (the crawled spelling)
      inspected_at          INTEGER NOT NULL,
      verdict               TEXT,                 -- PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
      coverage_state        TEXT,                 -- Google's prose
      robots_txt_state      TEXT,
      indexing_state        TEXT,
      page_fetch_state      TEXT,
      last_crawl_time       TEXT,                 -- RFC3339 as Google returns it
      crawled_as            TEXT,
      google_canonical      TEXT,
      user_canonical        TEXT,
      sitemaps              TEXT,                 -- JSON array
      referring_urls        TEXT,                 -- JSON array
      rich_results_verdict  TEXT,
      raw                   TEXT,                 -- the full inspectionResult JSON
      UNIQUE(project, url)
    );
    CREATE INDEX IF NOT EXISTS idx_gsc_inspections_project ON gsc_inspections(project, inspected_at);

    CREATE TABLE IF NOT EXISTS backlinks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project        TEXT NOT NULL,
      linking_url    TEXT NOT NULL,
      linking_domain TEXT NOT NULL,
      last_crawled   TEXT,            -- as Search Console reported it
      source         TEXT,            -- export file the row came from
      imported_at    INTEGER NOT NULL,
      -- Filled in by the --live pass. NULL means "not checked", which is a
      -- different state from "checked and found missing".
      checked_at     INTEGER,
      http_status    INTEGER,
      verify_state   TEXT,            -- ok | blocked | gone | error
      link_present   INTEGER,         -- 1 | 0 | NULL when unverifiable
      rel_nofollow   INTEGER,         -- 1 when nofollow/ugc/sponsored
      target_url     TEXT,            -- recovered: GSC does not export it
      anchor_text    TEXT,            -- recovered
      UNIQUE(project, linking_url)
    );
    CREATE INDEX IF NOT EXISTS idx_backlinks_domain ON backlinks(project, linking_domain);

    CREATE TABLE IF NOT EXISTS problem_status (
      problem_id  TEXT PRIMARY KEY,                      -- matches lib/problems.js makeId() output
      project     TEXT NOT NULL,
      status      TEXT NOT NULL,                         -- fixed | wont_fix | snoozed
      marked_at   INTEGER NOT NULL,
      marked_by   TEXT,                                  -- 'agent:<name>' | 'cli' | 'dashboard'
      note        TEXT,
      expires_at  INTEGER                                -- for snoozed; NULL for fixed/wont_fix
    );
    CREATE INDEX IF NOT EXISTS idx_problem_status_project ON problem_status(project, status);
  `);

  // One-time (v1.6.2): collapse gsc_queries rows the NULL-defeated UNIQUE let
  // through, then enforce identity over COALESCE(page_url,''). Keeping the
  // highest id per identity matches what the upsert would have written.
  const hasGscIdentity = _db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_gsc_queries_identity'"
  ).get();
  if (!hasGscIdentity) {
    _db.exec(`
      DELETE FROM gsc_queries WHERE id NOT IN (
        SELECT MAX(id) FROM gsc_queries
        GROUP BY project, COALESCE(page_url, ''), query, date_range
      );
      CREATE UNIQUE INDEX idx_gsc_queries_identity
        ON gsc_queries(project, COALESCE(page_url, ''), query, date_range);
    `);
  }

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

// ── Finding provenance ──────────────────────────────────────────────────────
//
// Every Ledger row says where it came from, because two consumers need to
// know. The review (analyses/review) lets an agent act unattended only on a
// finding a deterministic rule produced; a model's finding is a hypothesis and
// goes to a person. And a model's guess must not live forever: a rule finding
// clears on its own when a complete run stops emitting it ('resolved'), but
// nothing re-checks a model's claim, so those expire 90 days after they were
// last emitted ('expired'). Both statuses are set by the data and undone by
// the data — a re-emitted fingerprint flips them back to active. done and
// dismissed are never flipped: a person decided those.

const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 90;
const SOURCE_KINDS = new Set(['rule', 'model', 'agent']);

/** Every status a Ledger row can hold. The last two are the data's; the middle three a person's. */
export const INSIGHT_STATUSES = ['active', 'done', 'dismissed', 'in_progress', 'resolved', 'expired'];

// The six provenance columns, in the order every writer below binds them.
const PROVENANCE_COLS = 'source_kind, model, prompt_version, rule_version, confidence, expires_at';

// The re-emission rule, shared by every writer so it cannot drift between
// them. A finding the data says is back returns to active; one a person closed
// (done, dismissed) or is working on (in_progress) keeps that status.
const REEMIT_UPDATE = `
      last_seen = excluded.last_seen,
      data = excluded.data,
      source_kind = excluded.source_kind,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      rule_version = excluded.rule_version,
      confidence = excluded.confidence,
      expires_at = excluded.expires_at,
      status = CASE WHEN insights.status IN ('resolved', 'expired') THEN 'active' ELSE insights.status END`;

/**
 * A confidence is a number in 0..1 or nothing. Anything else — a percentage,
 * a word, a boolean — is stored as NULL ("unknown") rather than clamped into a
 * value that would read as a real measurement.
 */
function normalizeConfidence(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Turn a writer's meta into the six column values. The registry supplies the
 * defaults (a type's usual source kind and rule version); explicit meta wins.
 * Fields that do not apply to a kind are forced NULL — a rule has no model, a
 * model has no rule version — so a reader can trust the columns to mean what
 * their names say regardless of which writer stamped them.
 *
 * `bind(confidence)` returns the values in PROVENANCE_COLS order, with the
 * per-item confidence taking precedence over the meta-level one.
 */
function resolveProvenance(type, meta = {}, ts = Date.now()) {
  const kind = SOURCE_KINDS.has(meta.sourceKind) ? meta.sourceKind : insightMeta(type).sourceKind;
  const isRule = kind === 'rule';
  const ttlDays = Number(meta.ttlDays) > 0 ? Number(meta.ttlDays) : DEFAULT_TTL_DAYS;
  const prov = {
    kind,
    model: isRule ? null : (meta.model ? String(meta.model) : null),
    promptVersion: kind === 'model' && meta.promptVersion != null ? String(meta.promptVersion) : null,
    ruleVersion: isRule ? String(meta.ruleVersion ?? insightMeta(type).ruleVersion ?? '1') : null,
    // A rule is certain by construction; a model or agent says how sure it is,
    // or nothing.
    defaultConfidence: isRule ? (normalizeConfidence(meta.confidence) ?? 1) : normalizeConfidence(meta.confidence),
    expiresAt: isRule ? null : ts + ttlDays * DAY_MS,
  };
  prov.bind = (confidence) => [
    prov.kind, prov.model, prov.promptVersion, prov.ruleVersion,
    normalizeConfidence(confidence) ?? prov.defaultConfidence, prov.expiresAt,
  ];
  return prov;
}

/**
 * Add the provenance columns to an insights table that predates them, and
 * classify the rows already there. Idempotent and cheap, so getDb() runs it on
 * every open: a database created by an older version is upgraded the first
 * time and untouched afterwards (the WHERE source_kind IS NULL guards see
 * nothing). Safe on a database without the table at all — every statement is
 * best-effort, because a fixture or a read-only handle is not a fault here.
 *
 * Classification of legacy rows, most specific signal first:
 *   source 'agent…'             → agent, model = the agent's name
 *   type in MODEL_INSIGHT_TYPES → model, model = the analyses row's model when
 *                                 the row still points at one
 *   everything else             → rule, rule_version '1', confidence 1.0
 * Agent rows are checked before type because an agent writes the model types
 * (AGENT_INSIGHT_TYPES); the source column is the only thing that tells them
 * apart, and losing it would say a model produced what an agent typed.
 * No expires_at is written for legacy model rows: they keep the "lives until
 * re-emitted" semantics they were stored under, and gain an expiry the first
 * time a run re-emits them.
 */
export function migrateInsightProvenance(db) {
  const columns = [
    ['source_kind', 'TEXT'], ['model', 'TEXT'], ['prompt_version', 'TEXT'],
    ['rule_version', 'TEXT'], ['confidence', 'REAL'], ['expires_at', 'INTEGER'],
  ];
  for (const [name, sqlType] of columns) {
    try { db.exec(`ALTER TABLE insights ADD COLUMN ${name} ${sqlType}`); } catch { /* already exists, or no table */ }
  }

  try {
    db.prepare(`
      UPDATE insights SET source_kind = 'agent',
        model = CASE WHEN source LIKE 'agent:%' THEN NULLIF(substr(source, 7), '') ELSE NULL END
      WHERE source_kind IS NULL AND source LIKE 'agent%'
    `).run();
  } catch { /* no source column: nothing here was written by an agent */ }

  const typeList = MODEL_INSIGHT_TYPES.map(() => '?').join(', ');
  try {
    db.prepare(`
      UPDATE insights SET source_kind = 'model',
        model = (SELECT a.model FROM analyses a WHERE a.id = insights.source_analysis_id)
      WHERE source_kind IS NULL AND type IN (${typeList})
    `).run(...MODEL_INSIGHT_TYPES);
  } catch {
    // No analyses table to take the model id from (a fixture): classify without it.
    try {
      db.prepare(`UPDATE insights SET source_kind = 'model' WHERE source_kind IS NULL AND type IN (${typeList})`)
        .run(...MODEL_INSIGHT_TYPES);
    } catch { /* no insights table */ }
  }

  try {
    db.prepare(`
      UPDATE insights SET source_kind = 'rule', rule_version = '1', confidence = 1.0
      WHERE source_kind IS NULL
    `).run();
  } catch { /* no insights table */ }
}

/**
 * Retire model and agent findings past their expiry. Only active rows are
 * touched: a person's done or dismissed stands, and a resolved row is already
 * closed. Runs at boot from getDb(); a scheduler may call it too.
 *
 * @returns {number} rows flipped to 'expired'; 0 when the table lacks the column
 */
export function expireInsights(db, now = Date.now()) {
  try {
    const res = db.prepare(`
      UPDATE insights SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now);
    return Number(res.changes) || 0;
  } catch {
    return 0;
  }
}

// ── Migrate all historical analyses into insights ───────────────────────────

function _migrateAnalysesToInsights(db) {
  const count = db.prepare('SELECT COUNT(*) as n FROM insights').get().n;
  if (count > 0) return; // already migrated

  const rows = db.prepare('SELECT * FROM analyses ORDER BY generated_at ASC').all();
  if (!rows.length) return;

  const safeJsonParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // Every analyses row is a model's output, and the row names the model. No
  // expiry is stamped: these are historical rows keeping the semantics they
  // were stored under; they gain one the first time a run re-emits them.
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, source_kind, model)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 'model', ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data,
      model = excluded.model
  `);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const ts = row.generated_at;
      const model = row.model || null;
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
          upsertStmt.run(row.project, type, fp, ts, ts, row.id, JSON.stringify(item), model);
        }
      }
      // positioning is a singleton object, not an array
      const pos = safeJsonParse(row.positioning);
      if (pos && typeof pos === 'object' && Object.keys(pos).length) {
        const fp = _insightFingerprint('positioning', pos);
        upsertStmt.run(row.project, 'positioning', fp, ts, ts, row.id, JSON.stringify(pos), model);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] insights migration failed:', e.message);
  }
}

// ── Insight upsert (called after each analyze/keywords run) ─────────────────

/**
 * Write one analyze run's findings. Every row is the model's: source_kind
 * 'model', the model id (from `meta.model`, else from the analyses row the
 * findings came from, so provenance never depends on which caller ran the
 * analysis), the prompt version when the caller knows it, and an expiry
 * `ttlDays` out — a keyword gap the model never repeats retires on its own.
 * Items carry no confidence today, so that column is NULL unless an item says.
 *
 * @param {{ model?: string, promptVersion?: string, ttlDays?: number }} [meta]
 */
export function upsertInsightsFromAnalysis(db, project, analysisId, analysis, timestamp, meta = {}) {
  const ts = timestamp || Date.now();
  let model = meta.model || null;
  if (!model && analysisId != null) {
    try { model = db.prepare('SELECT model FROM analyses WHERE id = ?').get(analysisId)?.model || null; } catch { /* no analyses table */ }
  }
  const prov = resolveProvenance(null, { ...meta, sourceKind: 'model', model }, ts);
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, ${PROVENANCE_COLS})
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET ${REEMIT_UPDATE}
  `);

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
        upsertStmt.run(project, type, fp, ts, ts, analysisId, JSON.stringify(item), ...prov.bind(item?.confidence));
      }
    }
    if (analysis.positioning && typeof analysis.positioning === 'object') {
      const fp = _insightFingerprint('positioning', analysis.positioning);
      upsertStmt.run(project, 'positioning', fp, ts, ts, analysisId, JSON.stringify(analysis.positioning),
        ...prov.bind(analysis.positioning.confidence));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] insight upsert failed:', e.message);
  }
}

/**
 * Write one keywords run's invented keywords. Model rows, like the analyze
 * ones above; `meta.model` names the model, since there is no analyses row to
 * take it from.
 *
 * @param {{ model?: string, promptVersion?: string, ttlDays?: number }} [meta]
 */
export function upsertInsightsFromKeywords(db, project, keywordsReport, meta = {}) {
  const ts = Date.now();
  const prov = resolveProvenance('keyword_inventor', { ...meta, sourceKind: 'model' }, ts);
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, ${PROVENANCE_COLS})
    VALUES (?, 'keyword_inventor', 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET ${REEMIT_UPDATE}
  `);

  const allClusters = keywordsReport.keyword_clusters || [];
  const allKws = allClusters.flatMap(c => (c.keywords || []).map(k => ({ ...k, cluster: c.topic })));

  db.exec('BEGIN');
  try {
    for (const kw of allKws) {
      const fp = _insightFingerprint('keyword_inventor', kw);
      if (!fp) continue;
      upsertStmt.run(project, fp, ts, ts, JSON.stringify(kw), ...prov.bind(kw.confidence));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] keyword insight upsert failed:', e.message);
  }
}

// ── Agent-ingested insight (write-back from MCP) ────────────────────────────

export const AGENT_INSIGHT_TYPES = ['keyword_gap', 'long_tail', 'quick_win', 'new_page', 'content_gap', 'technical_gap', 'positioning'];

/**
 * Insert a single insight on behalf of an external agent (e.g. via MCP).
 * Uses the same dedup contract as analyze-time inserts (UNIQUE on
 * project + type + fingerprint), so an agent repeating the same finding
 * across sessions updates `last_seen` instead of duplicating rows.
 *
 * Provenance: source_kind 'agent', model = the agent's name, the confidence
 * the agent gave (NULL when it gave none — never invented), and an expiry
 * `ttlDays` out. An agent's finding is a claim, not a measurement: the review
 * will not let another agent act on it unattended, and it retires unless the
 * agent repeats it.
 *
 * Returns { ok, id, fingerprint, deduped } — `deduped: true` when the row
 * already existed and we only refreshed last_seen.
 */
export function insertAgentInsight(db, { project, type, data, agentName, confidence, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!AGENT_INSIGHT_TYPES.includes(type)) {
    return { ok: false, error: `Unsupported type "${type}". Allowed: ${AGENT_INSIGHT_TYPES.join(', ')}` };
  }
  if (!project) return { ok: false, error: 'project is required' };
  if (!data || typeof data !== 'object') return { ok: false, error: 'data must be an object' };

  const fingerprint = _insightFingerprint(type, data);
  if (!fingerprint) {
    return { ok: false, error: `data is missing the identifier field this type needs (see _insightFingerprint in db/db.js for the per-type contract)` };
  }

  const source = agentName ? `agent:${agentName}` : 'agent';
  const ts = Date.now();
  const prov = resolveProvenance(type, { sourceKind: 'agent', model: agentName || null, confidence, ttlDays }, ts);

  // Stash provenance inside the data blob too — survives if/when the source
  // column is ever queried separately, but also keeps it visible to consumers
  // that only read `data`.
  const enriched = { ...data, _source: source, _ingested_at: new Date(ts).toISOString() };

  const existing = db.prepare(
    'SELECT id FROM insights WHERE project = ? AND type = ? AND fingerprint = ?'
  ).get(project, type, fingerprint);

  db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, source, ${PROVENANCE_COLS})
    VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      source = excluded.source, ${REEMIT_UPDATE}
  `).run(project, type, fingerprint, ts, ts, JSON.stringify(enriched), source, ...prov.bind(confidence));

  const row = db.prepare(
    'SELECT id FROM insights WHERE project = ? AND type = ? AND fingerprint = ?'
  ).get(project, type, fingerprint);

  return {
    ok: true, id: row.id, fingerprint, deduped: !!existing, source, last_seen: ts,
    source_kind: prov.kind, model: prov.model, confidence: prov.defaultConfidence, expires_at: prov.expiresAt,
  };
}

// ── Read active insights (accumulated across all runs) ──────────────────────

/**
 * Active findings for a project, grouped by type. A model or agent finding
 * past its expiry is left out even before the sweep has flipped it: what a
 * reader sees as active must be what would survive the sweep. Each item
 * carries its provenance under the same underscore convention as _insight_id,
 * NULL where the row predates the column.
 */
export function getActiveInsights(db, project, now = Date.now()) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT * FROM insights
      WHERE project = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY type, last_seen DESC
    `).all(project, now);
  } catch {
    // A table from before provenance (a fixture, or a handle opened without
    // running the migration) has no expires_at. Nothing in it can have
    // expired, so the old query is the right answer, not an error.
    rows = db.prepare(
      `SELECT * FROM insights WHERE project = ? AND status = 'active' ORDER BY type, last_seen DESC`
    ).all(project);
  }

  const byType = {};
  for (const row of rows) {
    let parsed;
    // A single malformed blob used to throw here and take the whole dashboard
    // with it. Skip the bad row instead.
    try { parsed = JSON.parse(row.data); } catch { continue; }
    if (!byType[row.type]) byType[row.type] = [];
    parsed._insight_id = row.id;
    parsed._first_seen = row.first_seen;
    parsed._last_seen = row.last_seen;
    parsed._source_kind = row.source_kind ?? null;
    parsed._model = row.model ?? null;
    parsed._confidence = row.confidence ?? null;
    parsed._expires_at = row.expires_at ?? null;
    byType[row.type].push(parsed);
  }

  // Shape comes from the registry rather than a hand-maintained list, so a new
  // insight type is reachable the moment it is declared. The group keys below
  // are the ones the dashboard already reads — the registry preserves them.
  const out = {};
  for (const key of INSIGHT_TYPE_KEYS) {
    const meta = INSIGHT_TYPES[key];
    const items = byType[key] || [];
    out[meta.groupKey] = meta.single ? (items[0] || null) : items;
  }
  // Rows written by a version whose registry differs from this one still come
  // through rather than being silently dropped.
  for (const [type, items] of Object.entries(byType)) {
    if (INSIGHT_TYPES[type]) continue;
    out[insightMeta(type).groupKey] = items;
  }

  out.byType = byType;
  out.generated_at = rows.length ? Math.max(...rows.map(r => r.last_seen)) : null;
  return out;
}

/**
 * Upsert a batch of insights of one type into the Intelligence Ledger.
 *
 * Dedup is by (project, type, fingerprint): a finding that recurs across runs
 * updates `last_seen` and its payload instead of creating a second row, which
 * is what makes the Ledger accumulate rather than churn. A user who marked a
 * row `done` or `dismissed` keeps that status — re-running an audit must not
 * silently resurrect something they already dealt with.
 *
 * A row the data itself had closed (`resolved`, `expired`) does come back:
 * the finding is there again, and nobody decided otherwise.
 *
 * Provenance comes from the registry unless `meta` says otherwise. The
 * own-site audits that call this are rules, so their rows get source_kind
 * 'rule', the type's rule_version, confidence 1 and no expiry. A model or
 * agent caller passes sourceKind/model/promptVersion/confidence and gets an
 * expiry `ttlDays` (default 90) out instead. An item's own `confidence`
 * overrides the meta-level one.
 *
 * `complete: true` says this run saw the whole site, so an active finding of
 * this type it did not emit is no longer detected and is marked 'resolved' in
 * the same transaction. That is the only way a rule finding clears — nothing
 * else re-checks it. An empty complete run resolves everything of the type,
 * which is the point: fixing the last issue must close it. A caller whose run
 * may be partial (a URL subset, an aborted crawl) must not pass it.
 *
 * Best-effort by design: an audit is still useful if the write fails, so this
 * reports and returns 0 rather than throwing into the caller.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string} type      A key from lib/insight-types.js
 * @param {{fingerprint: string, data: object, confidence?: number}[]} items
 * @param {{ sourceKind?: 'rule'|'model'|'agent', model?: string, promptVersion?: string, ruleVersion?: string,
 *           confidence?: number, ttlDays?: number, complete?: boolean }} [meta]
 * @returns {number} rows written (rows resolved by a complete run are not counted)
 */
export function upsertInsights(db, project, type, items, meta = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length && !meta.complete) return 0;
  let stmt, activeStmt, resolveStmt;
  // Prepared inside the guard: a caller working against a database without the
  // insights table (a fixture, or a read-only handle) must get 0 back, not an
  // exception thrown through the middle of an audit.
  try {
    stmt = db.prepare(`
      INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, ${PROVENANCE_COLS})
      VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, type, fingerprint) DO UPDATE SET ${REEMIT_UPDATE}
    `);
    if (meta.complete) {
      activeStmt = db.prepare(`SELECT id, fingerprint FROM insights WHERE project = ? AND type = ? AND status = 'active'`);
      resolveStmt = db.prepare(`UPDATE insights SET status = 'resolved' WHERE id = ?`);
    }
  } catch { return 0; }
  const ts = Date.now();
  const prov = resolveProvenance(type, meta, ts);
  try {
    db.exec('BEGIN');
    let n = 0;
    const seen = new Set();
    for (const item of list) {
      if (!item?.fingerprint) continue;
      const fp = String(item.fingerprint).slice(0, 300);
      stmt.run(project, type, fp, ts, ts, JSON.stringify(item.data ?? {}), ...prov.bind(item.confidence));
      seen.add(fp);
      n++;
    }
    if (meta.complete) {
      // The set difference is taken here rather than in a NOT IN (...) so a
      // site with thousands of findings cannot run into SQLite's bound-
      // variable limit. Rows written this run are active and in `seen`.
      for (const row of activeStmt.all(project, type)) {
        if (!seen.has(row.fingerprint)) resolveStmt.run(row.id);
      }
    }
    db.exec('COMMIT');
    return n;
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`[ledger] ${type} upsert failed:`, e.message);
    return 0;
  }
}

export function updateInsightStatus(db, id, status) {
  db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id);
}

// ── Agentic loop write-back (F1, v1.5.42) ───────────────────────────────────
//
// Closes the loop's memory gap: when a draft is actually produced, the Ledger
// should remember it. Two moves:
//   1. recordDraftCreated  — persist a `draft_created` insight (idempotent per
//      topic/type/lang) so "I drafted X" is durable and visible.
//   2. markGapsInProgress  — flip matching ACTIVE gap insights to 'in_progress'
//      so the same gap stops resurfacing in the next blog-draft pass.
// Both are best-effort and must never break draft generation.

/**
 * Record that a draft was created targeting this project's Ledger.
 * Idempotent: re-drafting the same (topic, content_type, lang) refreshes it.
 * @returns {string} the fingerprint used
 */
export function recordDraftCreated(db, project, { topic, score = null, tier = null, wordCount = null, lang = 'en', contentType = 'blog', savedPath = null } = {}) {
  const ts = Date.now();
  const normTopic = (topic || 'auto').toLowerCase().trim().slice(0, 120);
  const fp = `draft:${contentType}:${lang}:${normTopic}`.replace(/[^a-z0-9:_-]+/g, '-');
  const data = JSON.stringify({
    topic: topic || '(auto)', score, tier, word_count: wordCount,
    lang, content_type: contentType, saved_path: savedPath, created_at: ts,
  });
  // A record of something that happened, not a finding: stamped as a rule
  // (certain, never expiring) so the boot-time backfill has nothing to guess.
  db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data, ${PROVENANCE_COLS})
    VALUES (?, 'draft_created', 'active', ?, ?, ?, NULL, ?, 'rule', NULL, NULL, '1', 1.0, NULL)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `).run(project, fp, ts, ts, data);
  return fp;
}

/**
 * Flip ACTIVE gap insights matching `topic` to 'in_progress' so the loop stops
 * re-suggesting work that's already been drafted. Precise substring match on
 * each gap's key term (never a loose word-split that would over-match).
 * Only touches drafting-relevant gap types — never positioning/site_watch/etc.
 * @returns {number} count of insights marked
 */
export function markGapsInProgress(db, project, topic) {
  if (!topic || !topic.trim()) return 0;
  const needle = topic.toLowerCase().trim();
  const GAP_TYPES = ['keyword_gap', 'long_tail', 'content_gap', 'citability_gap', 'keyword_inventor'];
  const placeholders = GAP_TYPES.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, data FROM insights WHERE project = ? AND status = 'active' AND type IN (${placeholders})`
  ).all(project, ...GAP_TYPES);

  const upd = db.prepare(`UPDATE insights SET status = 'in_progress', last_seen = ? WHERE id = ?`);
  const ts = Date.now();
  let marked = 0;
  for (const r of rows) {
    let keyTerm = '', fullText = '';
    try {
      const d = JSON.parse(r.data);
      keyTerm = (d.keyword || d.phrase || d.topic || d.suggested_title || d.title || d.url || '').toLowerCase().trim();
      fullText = [d.keyword, d.phrase, d.topic, d.suggested_title, d.title, d.url]
        .filter(Boolean).join(' ').toLowerCase();
    } catch { continue; }
    const hit = (keyTerm && (needle.includes(keyTerm) || keyTerm.includes(needle))) || (fullText && fullText.includes(needle));
    if (hit) { upd.run(ts, r.id); marked++; }
  }
  return marked;
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
    // Drop a trailing slash on non-root paths so /docs and /docs/ are one page.
    // The URL constructor already forces the root to '/', so a site root keeps
    // its slash and only deeper paths collapse. Without this, a re-crawl wrote
    // a second row alongside the old one and every lookup kept reading the
    // stale copy — the fresh data was there and simply never found.
    if (path.length > 1) path = path.replace(/\/+$/, '');
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
  // Headings are a crawl snapshot, not history. Clear the prior snapshot so
  // repeated crawls cannot manufacture duplicate H1/H2 findings.
  const deleteStmt = db.prepare(`DELETE FROM headings WHERE page_id = ?`);
  const stmt = db.prepare(`INSERT INTO headings (page_id, level, text) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  try {
    deleteStmt.run(pageId);
    for (const h of headings) stmt.run(pageId, h.level, h.text);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function insertLinks(db, sourceId, links) {
  // Links are a crawl snapshot, not history. Retaining old rows makes pages
  // appear linked after links were removed and inflates graph metrics.
  const deleteStmt = db.prepare(`DELETE FROM links WHERE source_id = ?`);
  const stmt = db.prepare(`INSERT INTO links (source_id, target_url, anchor_text, is_internal) VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    deleteStmt.run(sourceId);
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

// ── Search Console API (gsc_daily / gsc_fetches) ─────────────────────────

/**
 * Write API rows (the shape lib/gsc-api.js rowsToDaily() produces) in one
 * transaction. A re-fetch of the same window replaces in place — Google
 * revises the last few days, so the newest fetch must win, never add.
 * Any failure rolls the whole batch back: a half-written day would read as
 * a real traffic dip.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} rows
 * @returns {number} rows written
 */
export function upsertGscDaily(db, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO gsc_daily (project, property, grain, search_type, date, page_url, query, clicks, impressions, ctr, position, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, property, grain, search_type, date, COALESCE(page_url,''), COALESCE(query,'')) DO UPDATE SET
      clicks = excluded.clicks, impressions = excluded.impressions,
      ctr = excluded.ctr, position = excluded.position, fetched_at = excluded.fetched_at
  `);
  const now = Date.now();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.project, r.property, r.grain, r.search_type || 'web', r.date,
        r.page_url ?? null, r.query ?? null,
        r.clicks | 0, r.impressions | 0, r.ctr ?? null, r.position ?? null,
        r.fetched_at ?? now,
      );
      count++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return count;
}

/**
 * Record one API walk. `truncated` marks a walk that hit its row cap, so a
 * later reader can tell "this is all the data" from "this is what fit".
 * @returns {number} the new gsc_fetches id
 */
export function recordGscFetch(db, { project, property, grain, searchType = 'web', startDate, endDate, rows, requests, truncated = false, fetchedAt }) {
  const res = db.prepare(`
    INSERT INTO gsc_fetches (project, property, grain, search_type, start_date, end_date, rows, requests, truncated, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project, property, grain, searchType || 'web', startDate, endDate, rows | 0, requests | 0, truncated ? 1 : 0, fetchedAt ?? Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * What gsc_daily holds for a project: which property, which dates, how many
 * distinct days. Null when nothing has been fetched (or the table predates
 * this schema), so callers can say "no API data yet" instead of "zero
 * traffic". When several properties have rows and none is asked for, the
 * most recently fetched one is described — that is the one a fresh fetch
 * would extend.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {{ grain?: string, property?: string }} [filter]
 * @returns {{ property: string, grain: string|null, min_date: string, max_date: string, days: number, rows: number, last_fetched_at: number } | null}
 */
export function getGscCoverage(db, project, { grain, property } = {}) {
  try {
    const grainSql = grain ? ' AND grain = ?' : '';
    const grainArgs = grain ? [grain] : [];
    let prop = property || null;
    if (!prop) {
      const newest = db.prepare(
        `SELECT property FROM gsc_daily WHERE project = ?${grainSql} ORDER BY fetched_at DESC, id DESC LIMIT 1`
      ).get(project, ...grainArgs);
      if (!newest) return null;
      prop = newest.property;
    }
    const row = db.prepare(`
      SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(DISTINCT date) AS days,
             COUNT(*) AS rows, MAX(fetched_at) AS last_fetched_at
      FROM gsc_daily WHERE project = ? AND property = ?${grainSql}
    `).get(project, prop, ...grainArgs);
    if (!row || !row.rows) return null;
    return {
      property: prop,
      grain: grain || null,
      min_date: row.min_date,
      max_date: row.max_date,
      days: row.days,
      rows: row.rows,
      last_fetched_at: row.last_fetched_at,
    };
  } catch {
    return null;
  }
}

// ── URL Inspection (gsc_inspections) ─────────────────────────────────────

const GSC_INSPECTION_COLUMNS = [
  'project', 'property', 'url', 'inspected_at', 'verdict', 'coverage_state',
  'robots_txt_state', 'indexing_state', 'page_fetch_state', 'last_crawl_time',
  'crawled_as', 'google_canonical', 'user_canonical', 'sitemaps', 'referring_urls',
  'rich_results_verdict', 'raw',
];

/**
 * Store one inspection (the shape lib/gsc-api.js inspectionToRow() produces).
 * A URL inspected again is replaced column for column, property included: the
 * newest answer from Google is the only one worth reading, and a stale verdict
 * left in place would be exactly the false green tick this table exists to
 * prevent. One statement, so there is no half-updated row to read.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row
 * @returns {number} rows affected (1)
 */
export function upsertGscInspection(db, row) {
  const cols = GSC_INSPECTION_COLUMNS;
  const updates = cols.filter(c => c !== 'project' && c !== 'url').map(c => `${c} = excluded.${c}`);
  const res = db.prepare(`
    INSERT INTO gsc_inspections (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(project, url) DO UPDATE SET ${updates.join(', ')}
  `).run(...cols.map(c => (c === 'inspected_at' ? (row[c] ?? Date.now()) : (row[c] ?? null))));
  return Number(res.changes);
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Every stored inspection for a project, newest first, with the JSON list
 * columns parsed back to arrays. A database that predates the table answers
 * with none: that is "nothing inspected yet", not a fault.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @returns {object[]}
 */
export function getGscInspections(db, project) {
  let rows;
  try {
    rows = db.prepare(
      'SELECT * FROM gsc_inspections WHERE project = ? ORDER BY inspected_at DESC, url'
    ).all(project);
  } catch {
    return [];
  }
  return rows.map(r => ({
    ...r,
    sitemaps: parseJsonArray(r.sitemaps),
    referring_urls: parseJsonArray(r.referring_urls),
  }));
}

/**
 * How many URLs of a property have an inspection stamped at or after
 * `sinceMs` — the quota already spent today when `sinceMs` is midnight. A URL
 * inspected twice in the day counts once, because the upsert kept one row;
 * that undercounts the true spend slightly and never the other way round
 * into refusing work the quota would allow. Missing table → 0.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {string} property
 * @param {number} sinceMs
 * @returns {number}
 */
export function countInspectionsSince(db, project, property, sinceMs) {
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM gsc_inspections WHERE project = ? AND property = ? AND inspected_at >= ?'
    ).get(project, property, Number(sinceMs) || 0);
    return Number(row?.c) || 0;
  } catch {
    return 0;
  }
}
