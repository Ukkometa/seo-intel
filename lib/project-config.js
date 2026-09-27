/**
 * lib/project-config — reading config/<project>.json, the one place a project
 * name turns into a file path.
 *
 * cli.js and agent-harness.js each carried a loader. They parsed the same
 * file, but only the harness checked the name first, so the CLI would read
 * whatever `config/${project}.json` resolved to — `../../some/file` included —
 * and the local web server hands its /api/crawl body straight to `cli.js crawl`
 * as that name. The name guard (letters, digits, '-' and '_', which is what
 * setup's slugify and the scan command's `_scan-<domain>` produce) is the
 * harness's fix, and it now applies to every caller. A name outside it is not
 * a project, whatever is on disk: readProjectConfig says null, the same answer
 * as a missing or malformed file, and the caller decides how loud to be about
 * it. The CLI exits with a hint; the harness and the MCP tools return an error
 * an agent can relay.
 *
 * The one thing the CLI did beyond parsing is the domain hint (BUG-001): people
 * type `seo-intel crawl acme.io` for a project called `acme`. A name with a dot
 * can never pass the guard, so findProjectByDomain looks the input up among the
 * configured target, owned and competitor domains and returns the project name
 * to suggest. It does not load that project on the user's behalf: guessing
 * which of two projects tracking the same competitor they meant is worse than
 * asking.
 *
 * example.json ships with the package as a template. It is never a project: it
 * is left out of the listing and out of the domain lookup, so `crawl
 * example.com` is not answered with "did you mean example?".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** config/ at the repository root, where setup writes one JSON file per project. */
export const CONFIG_DIR = fileURLToPath(new URL('../config', import.meta.url));

const PROJECT_NAME = /^[a-z0-9_-]+$/i;
const TEMPLATE_FILE = 'example.json';

/** True when `project` is a name readProjectConfig will look up. */
export function isValidProjectName(project) {
  return typeof project === 'string' && PROJECT_NAME.test(project);
}

/**
 * Load a project's config.
 *
 * @param {string} project
 * @param {{ configDir?: string }} [opts]
 * @returns {object|null} the parsed config, or null when the name fails the
 *                        guard, the file is missing, or it is not valid JSON
 */
export function readProjectConfig(project, { configDir = CONFIG_DIR } = {}) {
  if (!isValidProjectName(project)) return null;
  try {
    return JSON.parse(readFileSync(join(configDir, `${project}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Project names in the config dir (every *.json but the template), sorted; [] when the dir is unreadable. */
function projectFileNames(configDir) {
  let files;
  try { files = readdirSync(configDir); } catch { return []; }
  return files
    .filter(f => f.endsWith('.json') && f !== TEMPLATE_FILE)
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * Every configured project, for `status`, list_projects and the CLI's
 * "available projects" hint. Sorted by name: readdir order is whatever the
 * filesystem keeps (hash order on ext4), and an agent comparing two `status`
 * calls should not see the list reshuffle.
 *
 * A file whose name fails the guard, or that does not parse, is still listed —
 * it is on disk and the user should see it — with null/[] domains, because
 * readProjectConfig will not load it.
 *
 * @param {{ configDir?: string }} [opts]
 * @returns {Array<{ name: string, targetDomain: string|null, competitors: string[] }>}
 */
export function listProjectConfigs({ configDir = CONFIG_DIR } = {}) {
  return projectFileNames(configDir).map(name => {
    const config = readProjectConfig(name, { configDir });
    return {
      name,
      targetDomain: config?.target?.domain || null,
      competitors: (config?.competitors || []).map(c => c.domain),
    };
  });
}

/**
 * The project whose config tracks `input` as its target, an owned domain or a
 * competitor — for "that looks like a domain, did you mean the project?".
 * `input` may carry a scheme and a path (https://acme.io/pricing); www. is
 * matched either way round. Returns null for anything without a dot, since a
 * bare word is a project name, not a domain.
 *
 * Only loadable projects are suggested. A file named acme.io.json tracking
 * acme.io would otherwise answer `crawl acme.io` with "did you mean acme.io?",
 * a hint that fails the same way when followed.
 *
 * @param {string} input
 * @param {{ configDir?: string }} [opts]
 * @returns {string|null} the first matching project name, in name order
 */
export function findProjectByDomain(input, { configDir = CONFIG_DIR } = {}) {
  if (typeof input !== 'string' || !input.includes('.')) return null;
  const inputDomain = input.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  for (const name of projectFileNames(configDir)) {
    const cfg = readProjectConfig(name, { configDir });
    if (!cfg) continue;
    const domains = [
      cfg.target?.domain,
      ...(cfg.owned || []).map(o => o.domain),
      ...(cfg.competitors || []).map(c => c.domain),
    ].filter(Boolean);
    if (domains.some(d => d === inputDomain || d === `www.${inputDomain}` || inputDomain === `www.${d}`)) {
      return name;
    }
  }
  return null;
}
