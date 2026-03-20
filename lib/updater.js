/**
 * SEO Intel — Update Checker
 *
 * Non-blocking version check that runs in the background.
 * Never slows down CLI startup. Caches results for 24 hours.
 *
 * Two update channels:
 *   - npm registry (public installs via `npm install -g seo-intel`)
 *   - froggo.pro   (direct downloads / pro users)
 *
 * Usage:
 *   import { checkForUpdates, printUpdateNotice } from './updater.js';
 *   // At CLI startup (non-blocking):
 *   checkForUpdates();
 *   // At end of command output:
 *   printUpdateNotice();
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Version source of truth ────────────────────────────────────────────────

let _currentVersion = null;

export function getCurrentVersion() {
  if (_currentVersion) return _currentVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    _currentVersion = pkg.version;
  } catch {
    _currentVersion = '0.0.0';
  }
  return _currentVersion;
}

// ── Cache file ─────────────────────────────────────────────────────────────

const CACHE_DIR = join(ROOT, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function readCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - data.checkedAt > CACHE_TTL_MS) return null; // expired
    return data;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({
      ...data,
      checkedAt: Date.now(),
    }, null, 2));
  } catch {
    // Best-effort — no crash if write fails
  }
}

// ── Version comparison ─────────────────────────────────────────────────────

/**
 * Compare semver strings. Returns:
 *   1  if a > b
 *   0  if a === b
 *  -1  if a < b
 */
export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

// ── Update sources ─────────────────────────────────────────────────────────

/**
 * Check npm registry for latest version.
 * Uses the abbreviated metadata endpoint (fast, no auth needed).
 */
async function checkNpm() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch('https://registry.npmjs.org/seo-intel/latest', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check froggo.pro for latest version.
 * Endpoint returns { version, changelog?, downloadUrl? }
 */
async function checkFroggo() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch('https://froggo.pro/api/seo-intel/version', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      version: data.version || null,
      changelog: data.changelog || null,
      downloadUrl: data.downloadUrl || null,
      security: data.security || false,
      securitySeverity: data.securitySeverity || null,
      updatePolicy: data.updatePolicy || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main check ─────────────────────────────────────────────────────────────

let _updateResult = null;
let _checkPromise = null;

/**
 * Start a background update check.
 * Non-blocking — fires and forgets. Call printUpdateNotice() later to show results.
 */
export function checkForUpdates() {
  // Use cached result if fresh
  const cached = readCache();
  if (cached) {
    _updateResult = cached;
    return;
  }

  // Fire background check — never await this
  _checkPromise = (async () => {
    try {
      const current = getCurrentVersion();

      // Check both sources in parallel
      const [npmVersion, froggoData] = await Promise.all([
        checkNpm(),
        checkFroggo(),
      ]);

      const froggoVersion = froggoData?.version || null;

      // Determine the highest available version
      let latestVersion = current;
      let source = 'current';
      let changelog = null;
      let downloadUrl = null;

      if (npmVersion && compareSemver(npmVersion, latestVersion) > 0) {
        latestVersion = npmVersion;
        source = 'npm';
      }
      if (froggoVersion && compareSemver(froggoVersion, latestVersion) > 0) {
        latestVersion = froggoVersion;
        source = 'froggo';
        changelog = froggoData.changelog;
        downloadUrl = froggoData.downloadUrl;
      }

      const hasUpdate = compareSemver(latestVersion, current) > 0;

      _updateResult = {
        current,
        latest: latestVersion,
        hasUpdate,
        source,
        changelog,
        downloadUrl,
        npmVersion,
        froggoVersion,
        security: froggoData?.security || false,
        securitySeverity: froggoData?.securitySeverity || null,
        updatePolicy: froggoData?.updatePolicy || null,
      };

      writeCache(_updateResult);
    } catch {
      // Silent fail — updates are non-critical
      _updateResult = null;
    }
  })();
}

/**
 * Print update notification if a newer version is available.
 * Call at end of command output so it doesn't interfere with results.
 *
 * Returns true if an update notice was printed.
 */
export async function printUpdateNotice() {
  // Wait for background check to finish (with timeout)
  if (_checkPromise) {
    const timeout = new Promise(resolve => setTimeout(resolve, 2000));
    await Promise.race([_checkPromise, timeout]);
  }

  if (!_updateResult || !_updateResult.hasUpdate) return false;

  const { current, latest, source, changelog, downloadUrl, security, securitySeverity } = _updateResult;

  const GOLD = '\x1b[38;5;214m';
  const RED = '\x1b[31m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  const CYAN = '\x1b[36m';

  // Security updates get a red urgent banner
  const COLOR = security ? RED : GOLD;
  const PREFIX = security ? '🔒 SECURITY UPDATE' : 'Update available';

  console.log('');
  console.log(`${COLOR}${BOLD}  ╭─────────────────────────────────────────╮${RESET}`);
  if (security) {
    console.log(`${RED}${BOLD}  │  🔒 SECURITY UPDATE: ${DIM}${current}${RESET}${RED}${BOLD} → ${CYAN}${latest}${RESET}${RED}${BOLD}${' '.repeat(Math.max(0, 10 - current.length - latest.length))}│${RESET}`);
    if (securitySeverity) {
      console.log(`${RED}${BOLD}  │  Severity: ${securitySeverity.toUpperCase()}${' '.repeat(Math.max(0, 28 - securitySeverity.length))}│${RESET}`);
    }
  } else {
    console.log(`${GOLD}${BOLD}  │  Update available: ${DIM}${current}${RESET}${GOLD}${BOLD} → ${CYAN}${latest}${RESET}${GOLD}${BOLD}${' '.repeat(Math.max(0, 16 - current.length - latest.length))}│${RESET}`);
  }

  if (changelog) {
    // Show first line of changelog
    const firstLine = changelog.split('\n')[0].slice(0, 35);
    console.log(`${GOLD}${BOLD}  │  ${DIM}${firstLine}${' '.repeat(Math.max(0, 38 - firstLine.length))}${RESET}${GOLD}${BOLD}│${RESET}`);
  }

  // Show appropriate update command
  if (source === 'npm') {
    console.log(`${COLOR}${BOLD}  │  ${RESET}${DIM}npm update -g seo-intel${' '.repeat(16)}${COLOR}${BOLD}│${RESET}`);
  } else if (downloadUrl) {
    console.log(`${COLOR}${BOLD}  │  ${RESET}${CYAN}${downloadUrl.slice(0, 37)}${' '.repeat(Math.max(0, 38 - downloadUrl.length))}${COLOR}${BOLD}│${RESET}`);
  } else {
    console.log(`${COLOR}${BOLD}  │  ${RESET}${DIM}npm update -g seo-intel${' '.repeat(16)}${COLOR}${BOLD}│${RESET}`);
  }

  if (security) {
    console.log(`${RED}${BOLD}  │  ${RESET}${DIM}or: seo-intel update --apply${' '.repeat(11)}${RED}${BOLD}│${RESET}`);
  }

  console.log(`${COLOR}${BOLD}  ╰─────────────────────────────────────────╯${RESET}`);
  console.log('');

  return true;
}

// ── For web/API ────────────────────────────────────────────────────────────

/**
 * Get update info as JSON (for web wizard / dashboard API).
 * Awaits the background check with a short timeout.
 */
export async function getUpdateInfo() {
  if (_checkPromise) {
    const timeout = new Promise(resolve => setTimeout(resolve, 3000));
    await Promise.race([_checkPromise, timeout]);
  }

  if (!_updateResult) {
    return {
      current: getCurrentVersion(),
      hasUpdate: false,
    };
  }

  return { ..._updateResult };
}

/**
 * Force a fresh update check (ignores cache).
 * Used by `seo-intel update` command.
 */
export async function forceUpdateCheck() {
  // Clear cache
  try {
    if (existsSync(CACHE_FILE)) {
      const { unlinkSync } = await import('fs');
      unlinkSync(CACHE_FILE);
    }
  } catch { /* ok */ }

  _updateResult = null;
  _checkPromise = null;

  checkForUpdates();

  // Actually wait for result
  if (_checkPromise) await _checkPromise;

  return _updateResult || { current: getCurrentVersion(), hasUpdate: false };
}
