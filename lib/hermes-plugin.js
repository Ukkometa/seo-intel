import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_NAME = 'seo-intel';
const SOURCE_DIR = join(ROOT, 'hermes', PLUGIN_NAME);

function hermesHome() {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}

export function installHermesPlugin({ remove = false, targetDir = null } = {}) {
  const destination = targetDir || join(hermesHome(), 'plugins', PLUGIN_NAME);

  if (remove) {
    rmSync(destination, { recursive: true, force: true });
    return { ok: true, action: 'removed', destination };
  }

  if (!existsSync(SOURCE_DIR)) {
    return { ok: false, error: `Missing Hermes plugin source: ${relative(ROOT, SOURCE_DIR)}` };
  }

  rmSync(destination, { recursive: true, force: true });
  copyTree(SOURCE_DIR, destination);

  // Keep Hermes' source resolver generic: this is not a credential, just the
  // package's current install/checkout location. plugin_api.py also falls back
  // to ~/.seo-intel/install.json and PATH, so this file is a convenience only.
  mkdirSync(join(homedir(), '.seo-intel'), { recursive: true });
  writeFileSync(join(homedir(), '.seo-intel', 'install.json'), JSON.stringify({
    root: ROOT,
    updatedAt: new Date().toISOString(),
  }, null, 2));

  return { ok: true, action: 'installed', destination };
}
