/**
 * Site Watch — Orchestrator
 *
 * Gathers current page state, diffs against previous snapshot,
 * persists results, and feeds significant changes into the Intelligence Ledger.
 */

import { diffPages } from './diff.js';
import { calculateHealthScore } from './health.js';
import {
  getLatestWatchSnapshot,
  getWatchPageStates,
  getWatchEvents,
  getWatchHistory,
} from '../../db/db.js';

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run site watch analysis for a project.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @param {object} [opts] - { log: function }
 * @returns {object} { snapshot, events, healthScore, previousHealthScore, trend, isBaseline }
 */
export function runWatch(db, project, opts = {}) {
  const log = opts.log || console.log;

  // ── Gather current page state ──────────────────────────────────────────
  const currentPages = db.prepare(`
    SELECT
      p.url, p.status_code, p.title, p.meta_desc, p.word_count,
      p.is_indexable, p.content_hash,
      (SELECT text FROM headings WHERE page_id = p.id AND level = 1 ORDER BY id LIMIT 1) as h1
    FROM pages p
    JOIN domains d ON d.id = p.domain_id
    WHERE d.project = ? AND d.role IN ('target', 'owned')
    ORDER BY p.url
  `).all(project);

  if (!currentPages.length) {
    log('  No crawled pages found. Run crawl first.');
    return { snapshot: null, events: [], healthScore: 0, previousHealthScore: null, trend: 0, isBaseline: false };
  }

  // ── Health score ───────────────────────────────────────────────────────
  const health = calculateHealthScore(currentPages);

  // ── Load previous snapshot ─────────────────────────────────────────────
  const prevSnapshot = getLatestWatchSnapshot(db, project);
  let events = [];
  let isBaseline = false;

  if (prevSnapshot) {
    const prevPages = getWatchPageStates(db, prevSnapshot.id);
    events = diffPages(currentPages, prevPages);
    log(`  Compared ${currentPages.length} pages against snapshot from ${new Date(prevSnapshot.created_at).toLocaleDateString()}`);
  } else {
    isBaseline = true;
    log(`  Baseline snapshot — ${currentPages.length} pages captured`);
  }

  // ── Persist new snapshot ───────────────────────────────────────────────
  const now = Date.now();
  const criticalCount = events.filter(e => e.severity === 'critical').length;
  const warningCount = events.filter(e => e.severity === 'warning').length;
  const noticeCount = events.filter(e => e.severity === 'notice').length;

  const snapshotResult = db.prepare(`
    INSERT INTO watch_snapshots (project, created_at, total_pages, health_score, errors_count, warnings_count, notices_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(project, now, currentPages.length, health.score, criticalCount, warningCount, noticeCount);

  const snapshotId = Number(db.prepare('SELECT last_insert_rowid() as id').get().id);

  // ── Persist page states ────────────────────────────────────────────────
  const stateStmt = db.prepare(`
    INSERT INTO watch_page_states (snapshot_id, url, status_code, title, h1, meta_desc, word_count, is_indexable, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const p of currentPages) {
      stateStmt.run(snapshotId, p.url, p.status_code, p.title, p.h1, p.meta_desc, p.word_count, p.is_indexable ? 1 : 0, p.content_hash);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // ── Persist events ─────────────────────────────────────────────────────
  if (events.length) {
    const eventStmt = db.prepare(`
      INSERT INTO watch_events (snapshot_id, event_type, severity, url, old_value, new_value, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      for (const e of events) {
        eventStmt.run(snapshotId, e.event_type, e.severity, e.url, e.old_value, e.new_value, e.details);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Feed Intelligence Ledger (critical + warning only) ─────────────────
  const significant = events.filter(e => e.severity === 'critical' || e.severity === 'warning');
  if (significant.length) {
    _upsertWatchInsights(db, project, significant, now);
  }

  const previousHealthScore = prevSnapshot?.health_score ?? null;
  const trend = previousHealthScore !== null ? health.score - previousHealthScore : 0;

  const snapshot = {
    id: snapshotId,
    project,
    created_at: now,
    total_pages: currentPages.length,
    health_score: health.score,
    errors_count: criticalCount,
    warnings_count: warningCount,
    notices_count: noticeCount,
  };

  return {
    snapshot,
    events,
    healthScore: health.score,
    healthDetails: health,
    previousHealthScore,
    trend,
    isBaseline,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD DATA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get watch data for dashboard rendering.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} project
 * @returns {object|null} { current, previous, events, trend }
 */
export function getWatchData(db, project) {
  const history = getWatchHistory(db, project, 2);
  if (!history.length) return null;

  const current = history[0];
  const previous = history[1] || null;
  const events = getWatchEvents(db, current.id);
  const trend = previous ? current.health_score - previous.health_score : 0;

  return { current, previous, events, trend };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function _upsertWatchInsights(db, project, events, timestamp) {
  const upsertStmt = db.prepare(`
    INSERT INTO insights (project, type, status, fingerprint, first_seen, last_seen, source_analysis_id, data)
    VALUES (?, 'site_watch', 'active', ?, ?, ?, NULL, ?)
    ON CONFLICT(project, type, fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      data = excluded.data
  `);

  db.exec('BEGIN');
  try {
    for (const e of events) {
      const raw = `${e.url || ''}::${e.event_type || ''}`;
      const fp = raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      if (!fp) continue;

      const data = {
        url: e.url,
        event_type: e.event_type,
        severity: e.severity,
        old_value: e.old_value,
        new_value: e.new_value,
        summary: _eventSummary(e),
      };

      upsertStmt.run(project, fp, timestamp, timestamp, JSON.stringify(data));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[watch] insight upsert failed:', err.message);
  }
}

function _eventSummary(e) {
  switch (e.event_type) {
    case 'new_error':            return `${e.url} returned ${e.new_value} (was ${e.old_value})`;
    case 'status_changed':       return `${e.url} status ${e.old_value} → ${e.new_value}`;
    case 'page_removed':         return `${e.url} disappeared from crawl`;
    case 'indexability_changed':  return `${e.url} became ${e.new_value}`;
    default:                     return `${e.event_type.replace(/_/g, ' ')} on ${e.url}`;
  }
}
