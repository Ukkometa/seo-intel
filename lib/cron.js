/**
 * lib/cron.js — Install / remove the daily `seo-intel notify` cron entry.
 *
 * The "user forgets to check SEO" defense from v1.5.34's delivery brainstorm.
 * Adds a single managed crontab line tagged with a marker comment so we can
 * find and replace/remove our own entry without touching the user's other
 * cron jobs.
 *
 * macOS + Linux: uses crontab(1). On macOS the first install will prompt the
 * user to approve calendar/automation access via the system permission dialog
 * — that's normal, nothing we can do about it.
 *
 * Windows: returns ok:false with a hint pointing at Task Scheduler. Out of
 * scope for v1.5.40.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NODE_BIN = process.execPath;
const MARKER = '# managed-by-seo-intel';

export const DEFAULT_SCHEDULE = '0 9 * * *'; // 9am every day

function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout || '';
  // status !== 0 typically means "no crontab for user yet" — return empty
  return '';
}

function writeCrontab(content) {
  const text = (content || '').replace(/\n*$/, '\n'); // ensure single trailing newline
  const r = spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`crontab write failed: ${r.stderr || 'unknown error'}`);
  }
}

function isWindows() { return process.platform === 'win32'; }

/**
 * @returns {{ installed: boolean, line: string|null, schedule: string|null, platform: string }}
 */
export function getNotifyCronStatus() {
  if (isWindows()) return { installed: false, line: null, schedule: null, platform: 'win32' };
  const lines = readCrontab().split('\n').filter(l => l.includes(MARKER));
  if (!lines.length) return { installed: false, line: null, schedule: null, platform: process.platform };
  const line = lines[0];
  // Schedule is the first 5 space-separated fields
  const parts = line.trim().split(/\s+/);
  const schedule = parts.slice(0, 5).join(' ');
  return { installed: true, line, schedule, platform: process.platform };
}

/**
 * Install (or replace) the managed cron line.
 *
 * @param {object} [opts]
 * @param {string} [opts.schedule]  Cron schedule, default DEFAULT_SCHEDULE (9am daily)
 * @param {boolean} [opts.openOnFire]  Append `--open` flag so the dashboard opens when fired
 * @returns {{ ok: boolean, line?: string, schedule?: string, error?: string, hint?: string }}
 */
export function installNotifyCron({ schedule = DEFAULT_SCHEDULE, openOnFire = false } = {}) {
  if (isWindows()) {
    return {
      ok: false,
      error: 'Windows not supported — use Task Scheduler manually',
      hint: `Create a daily task running:  ${NODE_BIN} "${join(ROOT, 'cli.js')}" notify`,
    };
  }
  // Sanity-check schedule (5 fields, no shell metachars)
  if (!/^[-*\/0-9, ]+$/.test(schedule) || schedule.trim().split(/\s+/).length !== 5) {
    return { ok: false, error: `Invalid cron schedule "${schedule}". Expected 5 fields, e.g. "0 9 * * *".` };
  }
  const cmd = `cd ${ROOT} && ${NODE_BIN} cli.js notify${openOnFire ? ' --open' : ''}`;
  const newLine = `${schedule} ${cmd}  ${MARKER}`;
  const current = readCrontab();
  const kept = current.split('\n').filter(l => l && !l.includes(MARKER));
  kept.push(newLine);
  try {
    writeCrontab(kept.join('\n'));
    return { ok: true, line: newLine, schedule };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Remove the managed cron line (if any). Idempotent.
 * @returns {{ ok: boolean, removed: boolean, error?: string }}
 */
export function removeNotifyCron() {
  if (isWindows()) return { ok: true, removed: false }; // nothing to remove
  const current = readCrontab();
  const before = current.split('\n').filter(Boolean).length;
  const kept = current.split('\n').filter(l => l && !l.includes(MARKER));
  if (kept.length === before) return { ok: true, removed: false };
  try {
    writeCrontab(kept.join('\n'));
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, removed: false, error: e.message };
  }
}
