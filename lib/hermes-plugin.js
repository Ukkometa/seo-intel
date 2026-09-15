import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { dirname, join, relative } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_NAME = 'seo-intel';

// hermes/seo-intel/ is the Hermes package (Agent Plugins v1). It is a folder of
// its own, not the repository root, because Hermes security-scans the whole
// plugin root at install time and a crawler codebase is not a plugin.
// Installing from GitHub clones the same folder (Ukkometa/seo-intel/hermes/seo-intel);
// this helper produces an identical folder from an npm install, offline.
//   plugin.json   portable manifest — the agent half
//   mcp.json      registers the MCP server (`npx -y seo-intel-mcp`) with the agent
//   skills/       the seo-intel skill, mirrored from skill/ by scripts/sync-plugin.js
//   dashboard/    Python backend (plugin_api.py) the desktop pane talks to
//   desktop/      desktop half — the Search Review pane and status-bar chip
const SOURCE_DIR = join(ROOT, 'hermes', PLUGIN_NAME);
const PACKAGE_ENTRIES = ['plugin.json', 'mcp.json', 'skills', 'dashboard', 'desktop'];

function hermesHome() {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

export function installHermesPlugin({ remove = false, targetDir = null } = {}) {
  const destination = targetDir || join(hermesHome(), 'plugins', PLUGIN_NAME);

  if (remove) {
    rmSync(destination, { recursive: true, force: true });
    return { ok: true, action: 'removed', destination };
  }

  const missing = PACKAGE_ENTRIES.filter(e => !existsSync(join(SOURCE_DIR, e)));
  if (missing.length) {
    return { ok: false, error: `Hermes package incomplete in ${relative(ROOT, SOURCE_DIR)}: missing ${missing.join(', ')}` };
  }

  // Installs before 1.7.1 kept the Hermes-side task queue inside the package
  // folder. Move it to Hermes's per-package data root before the folder is
  // replaced, so a reinstall never loses queued briefs.
  const legacyTasks = join(destination, 'agent_tasks.json');
  const dataTasks = join(hermesHome(), 'plugin-data', PLUGIN_NAME, 'agent_tasks.json');
  if (existsSync(legacyTasks) && !existsSync(dataTasks)) {
    mkdirSync(join(hermesHome(), 'plugin-data', PLUGIN_NAME), { recursive: true });
    renameSync(legacyTasks, dataTasks);
  }

  rmSync(destination, { recursive: true, force: true });
  copyTree(SOURCE_DIR, destination);

  // The CLI already registered this checkout in ~/.seo-intel/install.json at
  // startup (cli.js registerInstallLocation); plugin_api.py resolves the CLI
  // through that file, PATH, or npx — nothing else to write here.
  return { ok: true, action: 'installed', destination, entries: PACKAGE_ENTRIES };
}
