/**
 * SEO Intel — License System
 *
 * Validation flow:
 *   1. SEO_INTEL_LICENSE → activate/validate against Lemon Squeezy License API
 *   2. No key → Free tier
 *
 * Local cache: ~/.seo-intel/license-cache.json
 *   - LS keys: cache 24h, stale up to 7 days if API unreachable
 *   - Beyond stale limit → degrade to free tier + warn
 *
 * Activation flow (Lemon Squeezy):
 *   - First run: POST /v1/licenses/activate → stores instance_id locally
 *   - Subsequent runs: POST /v1/licenses/validate with instance_id
 *   - Machine-specific: instance_name = "seo-intel-<machineId>"
 *
 * Free tier: crawl + raw HTML export only. No AI extraction or analysis.
 * Solo (€19.99/mo or €199.99/yr): Full AI extraction + analysis, all commands.
 * Agency: Later phase — not sold yet.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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
    try { chmodSync(CACHE_PATH, 0o600); } catch {}
  } catch { /* best-effort */ }
}

function getTierFromVariantName(variantName) {
  const normalized = (variantName || '').toLowerCase();
  if (!normalized.includes('agency') && !normalized.includes('solo') && !normalized.includes('pro')) {
    console.warn(`[license] Unknown variant name: "${normalized}" — defaulting to solo`);
  }
  return normalized.includes('agency') ? 'agency' : 'solo';
}

/**
 * Check if cached validation is still usable.
 * Returns { valid, tier, stale } or null if cache is expired/missing.
 */
function checkCache(key) {
  const cache = readCache();
  if (!cache || cache.key !== key) return null;

  const age = Date.now() - (cache.validatedAt || 0);

  if (age < LS_CACHE_TTL) {
    return { valid: true, tier: cache.tier, stale: false, source: 'lemon-squeezy', instanceId: cache.instanceId };
  }
  if (age < LS_STALE_LIMIT) {
    return { valid: true, tier: cache.tier, stale: true, source: 'lemon-squeezy', instanceId: cache.instanceId };
  }
  return null; // Expired beyond stale limit
}

// ── Lemon Squeezy License API ────────────────────────────────────────────

/**
 * Activate a license key against Lemon Squeezy.
 * POST https://api.lemonsqueezy.com/v1/licenses/activate
 * Params: license_key, instance_name
 * Returns instance_id on success.
 */
async function activateWithLS(key) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const body = new URLSearchParams({
      license_key: key,
      instance_name: `seo-intel-${getMachineId()}`,
    });

    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body,
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.activated) {
      const variantName = (data.meta?.variant_name || '').toLowerCase();
      const tier = getTierFromVariantName(variantName);
      return {
        valid: true,
        tier,
        instanceId: data.instance?.id || null,
        meta: data.meta,
      };
    }

    // Already at activation limit? Try validate instead (might be same machine re-activating)
    if (data.error && data.error.includes('activation limit')) {
      return { valid: false, error: data.error, activationLimitReached: true };
    }

    return { valid: false, error: data.error || 'Activation failed' };
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}`, offline: true };
  }
}

/**
 * Validate a license key against Lemon Squeezy.
 * POST https://api.lemonsqueezy.com/v1/licenses/validate
 * Params: license_key, instance_id (optional)
 */
async function validateWithLS(key, instanceId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const params = { license_key: key };
    if (instanceId) params.instance_id = instanceId;
    const body = new URLSearchParams(params);

    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body,
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.valid) {
      const variantName = (data.meta?.variant_name || '').toLowerCase();
      const tier = getTierFromVariantName(variantName);
      return {
        valid: true,
        tier,
        instanceId: data.instance?.id || instanceId,
        status: data.license_key?.status,
        meta: data.meta,
      };
    }

    return { valid: false, error: data.error || 'License key not valid', status: data.license_key?.status };
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}`, offline: true };
  }
}

/**
 * Deactivate a license key instance.
 * POST https://api.lemonsqueezy.com/v1/licenses/deactivate
 * Params: license_key, instance_id
 */
export async function deactivateLicense() {
  const keyInfo = readKeyFromEnv();
  if (!keyInfo) return { deactivated: false, error: 'No license key found' };

  const cache = readCache();
  const instanceId = cache?.instanceId;
  if (!instanceId) return { deactivated: false, error: 'No active instance to deactivate' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const body = new URLSearchParams({
      license_key: keyInfo.value,
      instance_id: instanceId,
    });

    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/deactivate', {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body,
    });

    clearTimeout(timeout);
    const data = await res.json();

    if (data.deactivated) {
      // Clear local cache
      writeCache({});
      _cachedLicense = undefined;
      return { deactivated: true };
    }

    return { deactivated: false, error: data.error || 'Deactivation failed' };
  } catch (err) {
    return { deactivated: false, error: `Network error: ${err.message}` };
  }
}

// ── License Loading ─────────────────────────────────────────────────────────

let _cachedLicense = undefined;

/**
 * Read the license key from environment or .env file.
 * Returns { type, value } or null.
 */
function readKeyFromEnv() {
  let lsKey = process.env.SEO_INTEL_LICENSE;

  // Check .env file
  if (!lsKey) {
    const envPath = join(ROOT, '.env');
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf8');
        const match = content.match(/^SEO_INTEL_LICENSE=(.+)$/m);
        if (match) lsKey = match[1].trim().replace(/^["']|["']$/g, '');
      } catch { /* ok */ }
    }
  }

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
 * Async license activation — validates against Lemon Squeezy and caches result.
 *
 * Flow:
 *   1. If we have a cached instanceId → validate with it
 *   2. If no instanceId → activate (creates new instance)
 *   3. If activation limit reached → validate without instanceId (key-level check)
 *
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

  // Check if we already have an instanceId from a previous activation
  const cache = readCache();
  const existingInstanceId = (cache && cache.key === keyInfo.value) ? cache.instanceId : null;

  let result;

  if (existingInstanceId) {
    // We have a stored instance — validate it
    result = await validateWithLS(keyInfo.value, existingInstanceId);
  } else {
    // No stored instance — try to activate
    result = await activateWithLS(keyInfo.value);

    // If activation limit reached, fall back to key-level validate
    if (!result.valid && result.activationLimitReached) {
      result = await validateWithLS(keyInfo.value);
    }
  }

  if (result.valid) {
    // Cache the successful validation with instanceId
    writeCache({
      key: keyInfo.value,
      tier: result.tier,
      validatedAt: Date.now(),
      source: 'lemon-squeezy',
      instanceId: result.instanceId || existingInstanceId,
      machineId: getMachineId(),
    });

    const tierData = TIERS[result.tier] || TIERS.solo;
    _cachedLicense = { active: true, tier: result.tier, key: keyInfo.value, source: 'lemon-squeezy', ...tierData };
    return _cachedLicense;
  }

  if (result.offline) {
    // Network error — check if we have any stale cache at all
    if (cache && cache.key === keyInfo.value) {
      const tierData = TIERS[cache.tier] || TIERS.solo;
      _cachedLicense = { active: true, tier: cache.tier, key: keyInfo.value, source: 'lemon-squeezy', stale: true, ...tierData };
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
