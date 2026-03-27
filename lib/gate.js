/**
 * SEO Intel — Feature Gates
 *
 * Friendly enforcement layer on top of lib/license.js.
 * Premium features show clear upgrade messages instead of cryptic errors.
 *
 * Usage in CLI commands:
 *   import { requirePro, enforceLimits } from '../lib/gate.js';
 *   // At top of paid command:
 *   if (!requirePro('analyze')) return;
 *   // Before crawling:
 *   const maxPages = enforceLimits().maxPages;
 *
 * Usage in report generation:
 *   import { gateSection } from '../lib/gate.js';
 *   const insights = gateSection('gsc-insights') ? getGscInsights(...) : null;
 */

import { loadLicense, isPro, isFree, getMaxPages, getMaxProjects } from './license.js';

// ── Styled console output ───────────────────────────────────────────────────

const GOLD = '\x1b[38;5;214m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

function printUpgradeMessage(feature) {
  console.log('');
  console.log(`${GOLD}${BOLD}  ⭐ Paid Feature: ${feature}${RESET}`);
  console.log(`${DIM}  This feature requires SEO Intel Solo (€19.99/mo).${RESET}`);
  console.log('');
  console.log(`${DIM}  Get your license at ${CYAN}https://ukkometa.fi/en/seo-intel/${RESET}`);
  console.log(`${DIM}  Then add your key: ${CYAN}SEO_INTEL_LICENSE=SI-xxxx-xxxx-xxxx-xxxx${RESET} ${DIM}in .env${RESET}`);
  console.log('');
}

// ── Feature name → display name map ─────────────────────────────────────────

const FEATURE_NAMES = {
  'extract':          'AI Data Extraction (Ollama/Cloud)',
  'analyze':          'Competitive Gap Analysis',
  'keywords':         'AI Keyword Intelligence',
  'run':              'Smart Scheduler',
  'brief':            'Crawl Change Brief',
  'velocity':         'Publishing Velocity',
  'shallow':          'Shallow Content Audit',
  'decay':            'Content Decay Detection',
  'headings-audit':   'Heading Structure Audit',
  'orphans':          'Orphan Page Detection',
  'entities':         'Entity Coverage Analysis',
  'friction':         'Friction Point Analysis',
  'js-delta':         'JS Rendering Delta',
  'templates':        'Programmatic Template Intelligence',
  'html':             'HTML Dashboard',
  'html-all':         'HTML Dashboard (All Projects)',
  'gsc-insights':     'GSC Intelligence & Insights',
  'competitive':      'Competitive Landscape Sections',
  'unlimited-pages':  'Unlimited Crawl Pages',
  'unlimited-projects': 'Unlimited Projects',
};

// ── CLI Gate — blocks command and shows upgrade message ──────────────────────

/**
 * Check if a pro feature is available. If not, print upgrade message.
 * Returns true if allowed, false if blocked.
 *
 * @param {string} feature - Feature key (e.g., 'analyze', 'keywords')
 * @returns {boolean}
 */
export function requirePro(feature) {
  if (isPro()) return true;

  const displayName = FEATURE_NAMES[feature] || feature;
  printUpgradeMessage(displayName);
  process.exit(1);
}

// ── Section Gate — for report/dashboard sections ────────────────────────────

/**
 * Check if a dashboard/report section should be rendered.
 * Returns true if allowed (pro), false if should show upgrade placeholder.
 *
 * @param {string} section - Section key (e.g., 'gsc-insights', 'competitive')
 * @returns {boolean}
 */
export function gateSection(section) {
  return isPro();
}

/**
 * Get HTML placeholder for a gated premium section in dashboards.
 * Shows a tasteful "upgrade to unlock" card instead of the actual content.
 */
export function getPremiumPlaceholder(section) {
  const displayName = FEATURE_NAMES[section] || section;
  return `
    <div class="card" style="text-align:center; padding: 32px 24px; opacity: 0.7;">
      <div style="font-size: 1.5rem; margin-bottom: 8px;">⭐</div>
      <h3 style="font-size: 0.85rem; margin-bottom: 6px;">${displayName}</h3>
      <p style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 12px;">
        This section requires SEO Intel Solo (€19.99/mo)
      </p>
      <a href="https://ukkometa.fi/en/seo-intel/" target="_blank"
         style="color: var(--accent-gold); font-size: 0.72rem; text-decoration: underline;">
        Upgrade to unlock →
      </a>
    </div>
  `;
}

// ── Limit Enforcement ───────────────────────────────────────────────────────

/**
 * Get enforced limits for the current tier.
 * Use these values to cap crawl pages, project count, etc.
 */
export function enforceLimits() {
  const license = loadLicense();
  return {
    maxPages: license.maxPagesPerDomain,
    maxProjects: license.maxProjects,
    tier: license.tier,
    tierName: license.name,
  };
}

/**
 * Check if adding a new project would exceed the tier limit.
 * Pass the current project count.
 * Returns { allowed: boolean, limit: number, current: number }
 */
export function checkProjectLimit(currentCount) {
  const max = getMaxProjects();
  return {
    allowed: currentCount < max,
    limit: max,
    current: currentCount,
  };
}

/**
 * Cap page count to tier limit.
 * Returns the effective max pages.
 */
export function capPages(requestedPages) {
  const max = getMaxPages();
  if (!Number.isFinite(max)) return requestedPages;
  return Math.min(requestedPages, max);
}

// ── License Status Display ──────────────────────────────────────────────────

/**
 * Print license status to console (for CLI status command / startup).
 */
export function printLicenseStatus() {
  const license = loadLicense();

  const sourceLabel = license.source === 'lemon-squeezy' ? ' (LS)' : '';

  if (license.tier === 'agency') {
    console.log(`${GOLD}${BOLD}  ⭐ SEO Intel Agency${RESET}`);
    console.log(`${DIM}  License: ${license.key?.slice(0, 7)}...${license.key?.slice(-4)}${sourceLabel}${RESET}`);
    console.log(`${DIM}  All features + white-label + team access${RESET}`);
    if (license.stale) console.log(`\x1b[33m  ⚠ License cache stale — will re-validate on next network access${RESET}`);
  } else if (license.tier === 'solo') {
    console.log(`${GOLD}${BOLD}  ⭐ SEO Intel Solo${RESET}`);
    console.log(`${DIM}  License: ${license.key?.slice(0, 7)}...${license.key?.slice(-4)}${sourceLabel}${RESET}`);
    console.log(`${DIM}  All features unlocked${RESET}`);
    if (license.stale) console.log(`\x1b[33m  ⚠ License cache stale — will re-validate on next network access${RESET}`);
  } else {
    console.log(`${DIM}  SEO Intel Free${RESET}`);
    console.log(`${DIM}  Unlimited crawl · Raw SQLite data · No AI analysis · No dashboard${RESET}`);
    if (license.invalidKey) {
      console.log(`\x1b[33m  ⚠ ${license.reason}${RESET}`);
    }
    if (license.needsActivation) {
      console.log(`\x1b[33m  ⚠ License key found but not yet validated — run any command to activate${RESET}`);
    }
    console.log(`${DIM}  Upgrade: ${CYAN}https://ukkometa.fi/en/seo-intel/${RESET} ${DIM}— Solo €19.99/mo · €199.99/yr${RESET}`);
  }
  console.log('');
}

// ── Tier info for web/API ───────────────────────────────────────────────────

/**
 * Get tier info as JSON (for web wizard / API responses).
 */
export function getLicenseInfo() {
  const license = loadLicense();
  return {
    tier: license.tier,
    name: license.name,
    active: license.active,
    maxProjects: Number.isFinite(license.maxProjects) ? license.maxProjects : null,
    maxPages: Number.isFinite(license.maxPagesPerDomain) ? license.maxPagesPerDomain : null,
    features: license.features === 'all' ? 'all' : [...license.features],
    upgradeUrl: 'https://ukkometa.fi/en/seo-intel/',
  };
}
