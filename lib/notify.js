/**
 * lib/notify.js — Fire native OS notifications (macOS / Linux).
 *
 * Subtle nudge channel for the "user forgets to check SEO" problem.
 * Click action: opens the dashboard URL (configurable). No third-party
 * deps — uses built-in `osascript` on macOS and `notify-send` (libnotify)
 * on Linux. Falls through to console on Windows / unknown platforms.
 *
 * Designed to be safe in cron contexts: never throws, never blocks the
 * process, fire-and-forget via detached subprocess.
 */

import { spawn } from 'child_process';

/**
 * @param {object} opts
 * @param {string} opts.title       Headline shown bold in the notification
 * @param {string} opts.message     Body text
 * @param {string} [opts.subtitle]  macOS only — small subtitle below title
 * @param {string} [opts.sound]     macOS sound name (e.g. 'Glass', 'Tink'). Set false to silence.
 * @returns {boolean}  true if a native notification was fired; false on fallback
 */
export function notify({ title, message, subtitle, sound = false }) {
  if (!title || !message) return false;
  const platform = process.platform;
  try {
    if (platform === 'darwin') return notifyMacOS({ title, message, subtitle, sound });
    if (platform === 'linux')  return notifyLinux({ title, message });
  } catch { /* fall through */ }
  // Windows / unknown — print to console so cron jobs still leave a trace
  console.log(`[seo-intel notify] ${title}: ${message}`);
  return false;
}

function notifyMacOS({ title, message, subtitle, sound }) {
  // osascript can fire a notification but cannot wire click→URL natively.
  // For click-to-open we'd need terminal-notifier (third-party). Keeping
  // zero-dep here; the CLI's `--open` flag opens the dashboard alongside.
  const safe = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parts = [`display notification "${safe(message)}" with title "${safe(title)}"`];
  if (subtitle) parts.push(`subtitle "${safe(subtitle)}"`);
  if (sound) parts.push(`sound name "${safe(sound)}"`);
  const script = parts.join(' ');
  spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function notifyLinux({ title, message }) {
  // notify-send is shipped with libnotify on most Linux distros (GNOME, KDE,
  // XFCE). On minimal/headless installs it may be missing — we fail
  // silently and console-print in that case.
  const child = spawn('notify-send', [
    '--app-name=SEO Intel',
    '--icon=dialog-information',
    title,
    message,
  ], { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log(`[seo-intel notify] ${title}: ${message}`));
  child.unref();
  return true;
}

/**
 * Open a URL in the user's default browser. Cross-platform, fire-and-forget.
 * @param {string} url
 */
export function openUrl(url) {
  try {
    const platform = process.platform;
    if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (platform === 'linux') spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort */ }
}
