/**
 * SEO Intel — OAuth Manager
 *
 * Handles OAuth 2.0 flows for services that require user authorization:
 *   - Google Search Console (GSC)
 *   - Google Analytics (future)
 *   - Slack notifications (future)
 *
 * Architecture:
 *   - Tokens stored in .tokens/ directory (gitignored)
 *   - Local callback server on configurable port for OAuth redirects
 *   - Refresh tokens auto-renewed before expiry
 *   - Works alongside API key auth (users can choose either)
 *
 * Flow:
 *   1. User runs `seo-intel auth google` or clicks "Connect" in web wizard
 *   2. Opens browser to Google consent screen
 *   3. Google redirects to localhost:PORT/oauth/callback
 *   4. We exchange code for tokens, store them
 *   5. Subsequent API calls use the stored access token (auto-refresh)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOKENS_DIR = join(ROOT, '.tokens');

// ── Provider Configs ───────────────────────────────────────────────────────

const PROVIDERS = {
  google: {
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/webmasters.readonly',   // Search Console
      'https://www.googleapis.com/auth/analytics.readonly',     // Analytics (future)
    ],
    // Client ID/Secret come from .env or project config
    envClientId: 'GOOGLE_CLIENT_ID',
    envClientSecret: 'GOOGLE_CLIENT_SECRET',
  },
  // Future providers:
  // slack: { ... },
  // github: { ... },
};

// ── Token Storage ──────────────────────────────────────────────────────────

function ensureTokenDir() {
  if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });
}

function tokenPath(provider) {
  return join(TOKENS_DIR, `${provider}.json`);
}

/**
 * Read stored tokens for a provider.
 * @param {string} provider - e.g. 'google'
 * @returns {{ accessToken, refreshToken, expiresAt, scopes } | null}
 */
export function getTokens(provider) {
  try {
    const path = tokenPath(provider);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

/**
 * Save tokens for a provider.
 */
function saveTokens(provider, tokens) {
  ensureTokenDir();
  writeFileSync(tokenPath(provider), JSON.stringify({
    ...tokens,
    savedAt: Date.now(),
  }, null, 2));
}

/**
 * Delete stored tokens (disconnect).
 */
export function clearTokens(provider) {
  try {
    const p = tokenPath(provider);
    if (existsSync(p)) unlinkSync(p);
  } catch { /* ok */ }
}

/**
 * Check if a provider is connected (has valid-looking tokens).
 */
export function isConnected(provider) {
  const tokens = getTokens(provider);
  return !!(tokens?.accessToken && tokens?.refreshToken);
}

// ── Client Credentials ─────────────────────────────────────────────────────

/**
 * Get OAuth client credentials from .env.
 * For Google, users create a project at console.cloud.google.com
 * and paste client_id + client_secret.
 */
function getClientCredentials(provider) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);

  const clientId = process.env[config.envClientId];
  const clientSecret = process.env[config.envClientSecret];

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

// ── OAuth Flow ─────────────────────────────────────────────────────────────

const DEFAULT_CALLBACK_PORT = 9876;

/**
 * Build the OAuth authorization URL.
 * @param {string} provider
 * @param {object} [opts]
 * @param {number} [opts.port] - callback port (default 9876)
 * @param {string[]} [opts.scopes] - override default scopes
 * @returns {{ url: string, state: string }}
 */
export function getAuthUrl(provider, opts = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);

  const creds = getClientCredentials(provider);
  if (!creds) {
    throw new Error(
      `Missing ${config.envClientId} and ${config.envClientSecret} in .env.\n` +
      `  → Set up OAuth credentials at https://console.cloud.google.com/apis/credentials`
    );
  }

  const port = opts.port || DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const scopes = opts.scopes || config.scopes;
  const state = Math.random().toString(36).slice(2, 14);

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',       // get refresh token
    prompt: 'consent',            // always show consent to ensure refresh token
    state,
  });

  return {
    url: `${config.authUrl}?${params.toString()}`,
    state,
    redirectUri,
    port,
  };
}

/**
 * Exchange authorization code for tokens.
 * @param {string} provider
 * @param {string} code - authorization code from callback
 * @param {string} redirectUri
 * @returns {Promise<{ accessToken, refreshToken, expiresAt, scopes }>}
 */
async function exchangeCode(provider, code, redirectUri) {
  const config = PROVIDERS[provider];
  const creds = getClientCredentials(provider);

  const body = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000, // 1min buffer
    scopes: data.scope?.split(' ') || [],
    tokenType: data.token_type,
  };

  saveTokens(provider, tokens);
  return tokens;
}

/**
 * Refresh an expired access token.
 * @param {string} provider
 * @returns {Promise<string>} new access token
 */
export async function refreshAccessToken(provider) {
  const config = PROVIDERS[provider];
  const creds = getClientCredentials(provider);
  const stored = getTokens(provider);

  if (!stored?.refreshToken) {
    throw new Error(`No refresh token for ${provider}. Re-authenticate with: seo-intel auth ${provider}`);
  }

  const body = new URLSearchParams({
    refresh_token: stored.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();

  const tokens = {
    ...stored,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000,
  };

  // Google doesn't always return a new refresh token
  if (data.refresh_token) {
    tokens.refreshToken = data.refresh_token;
  }

  saveTokens(provider, tokens);
  return tokens.accessToken;
}

/**
 * Get a valid access token (auto-refreshes if expired).
 * @param {string} provider
 * @returns {Promise<string>} access token ready to use
 */
export async function getAccessToken(provider) {
  const tokens = getTokens(provider);
  if (!tokens) {
    throw new Error(`Not connected to ${provider}. Run: seo-intel auth ${provider}`);
  }

  // Refresh if expired (or within 1min of expiry)
  if (Date.now() >= tokens.expiresAt) {
    return refreshAccessToken(provider);
  }

  return tokens.accessToken;
}

// ── Local Callback Server ──────────────────────────────────────────────────

/**
 * Start a temporary local server to handle the OAuth callback.
 * Returns a promise that resolves with the auth code.
 *
 * @param {string} provider
 * @param {string} expectedState
 * @param {number} port
 * @returns {Promise<{ code: string }>}
 */
function startCallbackServer(provider, expectedState, port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html><body style="font-family:system-ui;text-align:center;padding:60px;">
              <h2 style="color:#e74c3c;">❌ Authorization failed</h2>
              <p>${error}</p>
              <p style="color:#888;">You can close this tab.</p>
            </body></html>
          `);
          server.close();
          reject(new Error(`OAuth denied: ${error}`));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h2>State mismatch — possible CSRF. Try again.</h2>');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:60px;">
            <h2 style="color:#2ecc71;">✅ Connected to ${PROVIDERS[provider]?.name || provider}!</h2>
            <p style="color:#888;">You can close this tab and return to the terminal.</p>
          </body></html>
        `);

        server.close();
        resolve({ code });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, () => {
      // Server ready
    });

    // Auto-timeout after 3 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out (3 minutes). Try again.'));
    }, 180000);
  });
}

// ── Public API: Full OAuth Flow ────────────────────────────────────────────

/**
 * Run the full OAuth flow for a provider.
 * Opens browser → waits for callback → exchanges code → stores tokens.
 *
 * @param {string} provider - e.g. 'google'
 * @param {object} [opts]
 * @param {number} [opts.port] - callback port
 * @param {boolean} [opts.openBrowser] - auto-open browser (default true)
 * @returns {Promise<{ success: boolean, provider: string, scopes: string[] }>}
 */
export async function startOAuthFlow(provider, opts = {}) {
  const { url, state, redirectUri, port } = getAuthUrl(provider, opts);

  // Start callback server BEFORE opening browser
  const callbackPromise = startCallbackServer(provider, state, port);

  // Open browser
  if (opts.openBrowser !== false) {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open' :
                process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} "${url}"`);
  }

  // Wait for callback
  const { code } = await callbackPromise;

  // Exchange code for tokens
  const tokens = await exchangeCode(provider, code, redirectUri);

  return {
    success: true,
    provider,
    scopes: tokens.scopes,
  };
}

// ── Provider Status ────────────────────────────────────────────────────────

/**
 * Get connection status for all providers.
 * Useful for the web wizard and status command.
 */
export function getAllConnectionStatus() {
  const statuses = {};
  for (const [key, config] of Object.entries(PROVIDERS)) {
    const tokens = getTokens(key);
    const creds = getClientCredentials(key);
    statuses[key] = {
      name: config.name,
      connected: !!(tokens?.accessToken && tokens?.refreshToken),
      hasCredentials: !!creds,
      expiresAt: tokens?.expiresAt || null,
      scopes: tokens?.scopes || [],
      needsSetup: !creds,
    };
  }
  return statuses;
}

/**
 * Available providers and their required env vars.
 * Shown in setup wizard to guide users.
 */
export function getProviderRequirements() {
  return Object.entries(PROVIDERS).map(([key, config]) => ({
    id: key,
    name: config.name,
    envVars: [config.envClientId, config.envClientSecret],
    scopes: config.scopes,
    setupUrl: key === 'google' ? 'https://console.cloud.google.com/apis/credentials' : null,
  }));
}
