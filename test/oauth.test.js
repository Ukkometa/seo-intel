/**
 * OAuth token storage — home-scoped location, owner-only permissions, the
 * connect/disconnect round trip, and the one-time move of a legacy
 * <package root>/.tokens/ file. Everything runs against a throwaway HOME and a
 * throwaway legacy dir so the test can never read, move or delete a real token:
 * a developer who connected Google before the home store existed has a live
 * refresh token at <root>/.tokens/google.json, and the migration would
 * otherwise carry it into the temp HOME that gets deleted at the end.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// homedir() reads HOME on POSIX and USERPROFILE on Windows, and the legacy dir
// is fixed from SEO_INTEL_LEGACY_TOKENS_DIR. All of them must be set BEFORE
// lib/oauth.js resolves its constants, hence the dynamic import below.
const home = mkdtempSync(join(tmpdir(), 'seo-intel-oauth-'));
const legacyDir = join(home, 'legacy-tokens');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SEO_INTEL_LEGACY_TOKENS_DIR = legacyDir;

// The real legacy location. Never written here; recorded so the end of the
// test can prove the module did not touch it.
const realLegacy = join(dirname(fileURLToPath(import.meta.url)), '..', '.tokens', 'google.json');
const realLegacyBefore = existsSync(realLegacy) ? statSync(realLegacy).mtimeMs : null;

const { getTokens, saveTokens, clearTokens, isConnected } = await import('../lib/oauth.js');

const tokensDir = join(home, '.seo-intel', 'tokens');
const file = join(tokensDir, 'google.json');
const legacyFile = join(legacyDir, 'google.json');
const posix = process.platform !== 'win32';
const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: [] };

function writeLegacy(record = { ...tokens, savedAt: 123 }) {
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(legacyFile, typeof record === 'string' ? record : JSON.stringify(record, null, 2));
  if (posix) chmodSync(legacyFile, 0o644); // how older versions left it
}

try {
  // ── Fresh home ─────────────────────────────────────────────────────────────
  assert.equal(getTokens('google'), null, 'a fresh home has no tokens');
  assert.equal(isConnected('google'), false, 'not connected before saving');
  assert.ok(!existsSync(file), 'reading does not create the token file');
  assert.ok(!existsSync(legacyDir), 'reading does not create the legacy dir either');

  // ── Save → read back ───────────────────────────────────────────────────────
  saveTokens('google', tokens);
  const stored = getTokens('google');
  assert.equal(stored.accessToken, 'a');
  assert.equal(stored.refreshToken, 'r');
  assert.equal(stored.expiresAt, 1);
  assert.deepEqual(stored.scopes, []);
  assert.equal(typeof stored.savedAt, 'number', 'save stamps the record');
  assert.ok(existsSync(file), 'the token file lives under ~/.seo-intel/tokens/');
  assert.equal(isConnected('google'), true, 'connected once tokens are saved');

  // ── Permissions (POSIX only: Windows ignores modes) ───────────────────────
  if (posix) {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token file is owner-only');
    assert.equal(statSync(tokensDir).mode & 0o777, 0o700, 'tokens dir is owner-only');

    // A file left loose by an older version is tightened on the next save,
    // not just files created fresh.
    chmodSync(file, 0o644);
    saveTokens('google', tokens);
    assert.equal(statSync(file).mode & 0o777, 0o600, 're-saving tightens a pre-existing file');
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  clearTokens('google');
  assert.ok(!existsSync(file), 'clearTokens removes the file');
  assert.equal(getTokens('google'), null, 'nothing to read after clearing');
  assert.equal(isConnected('google'), false, 'disconnected after clearing');
  assert.doesNotThrow(() => clearTokens('google'), 'clearing twice is harmless');

  // ── Legacy migration: <root>/.tokens/google.json → home store ─────────────
  const legacyRecord = { ...tokens, savedAt: 123 };
  writeLegacy(legacyRecord);
  assert.deepEqual(getTokens('google'), legacyRecord, 'first read serves the legacy record verbatim');
  assert.ok(existsSync(file), 'the record now lives in the home store');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), legacyRecord, 'copied without changes (savedAt kept)');
  assert.ok(!existsSync(legacyFile), 'the legacy file is removed once the copy exists');
  if (posix) assert.equal(statSync(file).mode & 0o777, 0o600, 'the migrated copy is owner-only');
  assert.equal(isConnected('google'), true, 'connected through the migrated copy');
  clearTokens('google');

  // A malformed legacy file is left alone and reported as "not connected".
  writeLegacy('not json');
  assert.equal(getTokens('google'), null, 'malformed legacy file is not served');
  assert.ok(existsSync(legacyFile), 'malformed legacy file is left in place');
  assert.ok(!existsSync(file), 'nothing is written to the home store for it');
  rmSync(legacyFile);

  // Disconnecting removes a lingering legacy file too, so the migration cannot
  // resurrect the connection on the next read.
  saveTokens('google', tokens);
  writeLegacy(legacyRecord);
  clearTokens('google');
  assert.ok(!existsSync(file) && !existsSync(legacyFile), 'clearTokens removes both the home and the legacy file');
  assert.equal(getTokens('google'), null, 'nothing comes back after a full disconnect');

  // ── Unwritable home store: keep serving the legacy file ───────────────────
  // A plain file where the tokens dir should be makes every write fail with
  // ENOTDIR — unlike chmod this also works when the test runs as root.
  writeLegacy(legacyRecord);
  rmSync(tokensDir, { recursive: true, force: true });
  writeFileSync(tokensDir, '');
  assert.deepEqual(getTokens('google'), legacyRecord, 'legacy record is served when the home store cannot be written');
  assert.ok(existsSync(legacyFile), 'the legacy file is kept when the copy failed');
  assert.equal(isConnected('google'), true, 'still connected with a read-only home');
  rmSync(tokensDir);
  assert.deepEqual(getTokens('google'), legacyRecord, 'the migration is retried once the store is writable');
  assert.ok(existsSync(file) && !existsSync(legacyFile), 'and completes: home copy present, legacy file gone');
  clearTokens('google');

  // ── Hermetic: the real package root was never touched ─────────────────────
  const realLegacyAfter = existsSync(realLegacy) ? statSync(realLegacy).mtimeMs : null;
  assert.equal(realLegacyAfter, realLegacyBefore, `the test must not read from or write to ${realLegacy}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('oauth token storage: PASS');
