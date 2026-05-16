/**
 * lib/progress.js — Single source of truth for the seo-intel job progress file.
 *
 * The CLI's crawl/extract/analyze/aeo/... commands all write their state to
 * `.extraction-progress.json` in the project root. Server.js, mcp/server.js,
 * and any future consumer can read job status from here without spawning a
 * subprocess.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROGRESS_FILE = join(__dirname, '..', '.extraction-progress.json');

/**
 * Read the current job progress, with PID liveness detection so a "running"
 * job whose process died gets re-tagged as "crashed".
 *
 * @returns {object|null}
 */
export function readProgress() {
  try {
    if (!existsSync(PROGRESS_FILE)) return null;
    const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    if (data.status === 'running' && data.pid) {
      try { process.kill(data.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') {
          data.status = 'crashed';
          data.crashed_at = data.updated_at;
        }
      }
    }
    return data;
  } catch { return null; }
}
