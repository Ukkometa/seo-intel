/**
 * SEO Intel — License System
 *
 * Validation priority:
 *   1. FROGGO_TOKEN → validate against Froggo API
 *   2. SEO_INTEL_LICENSE → validate against Lemon Squeezy API
 *   3. No key → Free tier
 *
 * Local cache: ~/.seo-intel/license-cache.json
 *   - LS keys: cache 24h, stale up to 7 days if API unreachable
 *   - Froggo tokens: cache 24h, stale up to 24h if API unreachable
 *   - Beyond stale limit → degrade to free tier + warn
 *
 * Free tier: crawl + raw HTML export only. No AI extraction or analysis.
 * Solo (€19.99/mo or €199/yr via LS, $9.99/mo via Froggo): Full AI extraction + analysis, all commands.
 * Agency: Later phase — not sold yet.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname, userInfo, platform } from 'os';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Cache location: ~/.seo-intel/license-cache.json
const CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.seo-intel');
const CACHE_PATH = join(CACHE_DIR, 'license-cache.json');

// Stale limits (ms)
const LS_CACHE_TTL = 24 * 60 * 60 * 1000;        // 24h fresh
const LS_STALE_LIMIT = 7 * 24 * 60 * 60 * 1000;   // 7 days stale max
const FROGGO_CACHE_TTL = 24 * 60 * 60 * 1000;      // 24h fresh
const FROGGO_STALE_LIMIT = 24 * 60 * 60 * 1000;    // 24h stale max

// ── Tiers ──────────────────────────────────────────────────────────────────

export const TIERS = {
  free: {
    name: 'Free',
    maxProjects: Infinity,
    maxPagesPerDomain: Infinity,
    features: [
      'crawl', 'setup', 'serve', 'status',
      'report', 'html', 'guide', 'schemas', 'schemas-backfill',
      'competitors', 'update',
    ],
  },
  solo: {
    name: 'Solo',
    maxProjects: Infinity,
    maxPagesPerDomain: Infinity,
    features: 'all',
  },
  agency: {
    name: 'Agency',
    maxProjects: Infinity,
    maxPagesPerDomain: Infinity,
    features: 'all',
    whiteLabel: true,
    teamAccess: true,
    dockerDeployment: true,
  },
};

// ── Machine ID ─────────────────────────────────────────────────────────────

function getMachineId() {
  try {
    const data = `${hostname()}:${userInfo().username}:${platform()}`;
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

// ── Local Cache ────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Check if cached validation is still usable.
 * Returns { valid, tier, stale } or null if cache is expired/missing.
 */
function checkCache(key) {
  const cache = readCache();
  if (!cache || cache.key !== key) return null;

  const age = Date.now() - (cache.validatedAt || 0);
  const ttl = cache.source === 'froggo' ? FROGGO_CACHE_TTL : LS_CACHE_TTL;
  const staleLimit = cache.source === 'froggo' ? FROGGO_STALE_LIMIT : LS_STALE_LIMIT;

  if (age < ttl) {
    return { valid: true, tier: cache.tier, stale: false, source: cache.source };
  }
  if (age < staleLimit) {
    return { valid: true, tier: cache.tier, stale: true, source: cache.source };
  }
  return null; // Expired beyond stale limit
}

// ── Lemon Squeezy Validation ───────────────────────────────────────────────

/**
 * Validate a license key against Lemon Squeezy API.
 * Returns { valid, tier, error? } — never throws.
 */
async function validateWithLS(key) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        license_key: key,
        instance_name: `seo-intel-${getMachineId()}`,
      }),
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.valid) {
      // Determine tier from LS metadata
      // Convention: product variant name contains "solo" or "agency"
      const variantName = (data.meta?.variant_name || data.license_key?.key_data?.variant || '').toLowerCase();
      const tier = variantName.includes('agency') ? 'agency' : 'solo';
      return { valid: true, tier };
    }

    return { valid: false, error: data.error || 'License key not valid' };
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}`, offline: true };
  }
}

// ── Froggo Token Validation ────────────────────────────────────────────────

/**
 * Validate a Froggo marketplace token.
 * Returns { valid, tier, error? } — never throws.
 */
async function validateWithFroggo(token) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://api.froggo.pro/v1/licenses/validate', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        token,
        product: 'seo-intel',
      }),
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.valid) {
      const tier = (data.tier || 'solo').toLowerCase();
      return { valid: true, tier: tier === 'agency' ? 'agency' : 'solo' };
    }

    return { valid: false, error: data.error || 'Token not valid' };
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}`, offline: true };
  }
}

// ── License Loading ─────────────────────────────────────────────────────────

let _cachedLicense = undefined;

/**
 * Read the license key / token from environment or .env file.
 * Returns { type, value } or null.
 */
function readKeyFromEnv() {
  // 1. Check Froggo token first (marketplace priority)
  let froggoToken = process.env.FROGGO_TOKEN;
  let lsKey = process.env.SEO_INTEL_LICENSE;

  // 2. Check .env file
  if (!froggoToken || !lsKey) {
    const envPath = join(ROOT, '.env');
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf8');
        if (!froggoToken) {
          const match = content.match(/^FROGGO_TOKEN=(.+)$/m);
          if (match) froggoToken = match[1].trim().replace(/^["']|["']$/g, '');
        }
        if (!lsKey) {
          const match = content.match(/^SEO_INTEL_LICENSE=(.+)$/m);
          if (match) lsKey = match[1].trim().replace(/^["']|["']$/g, '');
        }
      } catch { /* ok */ }
    }
  }

  if (froggoToken) return { type: 'froggo', value: froggoToken };
  if (lsKey) return { type: 'lemon-squeezy', value: lsKey };
  return null;
}

/**
 * Load and validate the license.
 * Synchronous — uses cache. Call activateLicense() for async network validation.
 */
export function loadLicense() {
  if (_cachedLicense !== undefined) return _cachedLicense;

  const keyInfo = readKeyFromEnv();

  if (!keyInfo) {
    _cachedLicense = { active: false, tier: 'free', ...TIERS.free };
    return _cachedLicense;
  }

  // Check local cache first (fast, offline)
  const cached = checkCache(keyInfo.value);
  if (cached && !cached.stale) {
    const tierData = TIERS[cached.tier] || TIERS.solo;
    _cachedLicense = { active: true, tier: cached.tier, key: keyInfo.value, source: cached.source, ...tierData };
    return _cachedLicense;
  }

  if (cached && cached.stale) {
    // Stale but within limit — use it but flag for re-validation
    const tierData = TIERS[cached.tier] || TIERS.solo;
    _cachedLicense = { active: true, tier: cached.tier, key: keyInfo.value, source: cached.source, stale: true, ...tierData };
    return _cachedLicense;
  }

  // No valid cache — need network validation
  // For synchronous loadLicense(), degrade to free with a flag
  _cachedLicense = { active: false, tier: 'free', needsActivation: true, key: keyInfo.value, keyType: keyInfo.type, ...TIERS.free };
  return _cachedLicense;
}

/**
 * Async license activation — validates against remote API and caches result.
 * Call this at startup or when loadLicense() returns needsActivation: true.
 * Returns the validated license object.
 */
export async function activateLicense() {
  clearLicenseCache();

  const keyInfo = readKeyFromEnv();
  if (!keyInfo) {
    _cachedLicense = { active: false, tier: 'free', ...TIERS.free };
    return _cachedLicense;
  }

  let result;
  if (keyInfo.type === 'froggo') {
    result = await validateWithFroggo(keyInfo.value);
  } else {
    result = await validateWithLS(keyInfo.value);
  }

  if (result.valid) {
    // Cache the successful validation
    writeCache({
      key: keyInfo.value,
      tier: result.tier,
      validatedAt: Date.now(),
      source: keyInfo.type,
      machineId: getMachineId(),
    });

    const tierData = TIERS[result.tier] || TIERS.solo;
    _cachedLicense = { active: true, tier: result.tier, key: keyInfo.value, source: keyInfo.type, ...tierData };
    return _cachedLicense;
  }

  if (result.offline) {
    // Network error — check if we have any stale cache at all
    const cache = readCache();
    if (cache && cache.key === keyInfo.value) {
      const tierData = TIERS[cache.tier] || TIERS.solo;
      _cachedLicense = { active: true, tier: cache.tier, key: keyInfo.value, source: cache.source, stale: true, ...tierData };
      return _cachedLicense;
    }
  }

  // Validation failed
  _cachedLicense = {
    active: false,
    tier: 'free',
    invalidKey: true,
    reason: result.error || 'License validation failed',
    ...TIERS.free,
  };
  return _cachedLicense;
}

/**
 * Clear cached license (for testing or after key changes).
 */
export function clearLicenseCache() {
  _cachedLicense = undefined;
}

// ── Tier Queries ────────────────────────────────────────────────────────────

/** Returns true for any paid tier (solo or agency). */
export function isPro() {
  // Debug: SEO_INTEL_FORCE_FREE=1 simulates free tier for dashboard preview
  if (process.env.SEO_INTEL_FORCE_FREE === '1') return false;
  return loadLicense().tier !== 'free';
}

/** Reset cached license — used by debug tier override */
export function _resetLicenseCache() { _cachedLicense = undefined; }

export function isFree() {
  return loadLicense().tier === 'free';
}

export function isSolo() {
  return loadLicense().tier === 'solo';
}

export function isAgency() {
  return loadLicense().tier === 'agency';
}

export function getTier() {
  return loadLicense();
}

export function getMaxProjects() {
  return loadLicense().maxProjects;
}

export function getMaxPages() {
  return loadLicense().maxPagesPerDomain;
}

/**
 * Check if a specific feature/command is available on the current tier.
 */
export function isFeatureAvailable(featureName) {
  const license = loadLicense();
  if (license.features === 'all') return true;
  return license.features.includes(featureName);
}
