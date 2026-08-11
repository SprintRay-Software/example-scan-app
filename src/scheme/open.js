// Hand a `<scheme>://…` URL to the OS so it launches whatever is registered for that scheme.
//
// This is how the headless service starts the desktop app: the real ScanPro service is a
// separate resident process that spawns ScanPro, and going through the OS handler reproduces
// that without hardcoding an install path — it launches whatever `register` (or a packaged
// build) claimed the scheme, exactly like the browser's deep link does.

import { run } from './exec.js';

// The launcher never runs a shell, so the URL is passed as an argv element and needs no
// escaping. On Windows `start` is a cmd builtin; its first quoted argument is the window
// title, hence the empty string before the URL.
function launcher(url) {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] };
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}

/**
 * Ask the OS to open a URL with its registered handler.
 * @param {string} url
 * @returns {Promise<{ ok: boolean, error?: string }>} never throws
 */
export async function openWithOsHandler(url) {
  const { cmd, args } = launcher(url);
  try {
    const r = await run(cmd, args);
    if (r.code === 0) return { ok: true };
    const detail = (r.stderr || r.stdout || '').trim();
    return { ok: false, error: detail || `${cmd} exited ${r.code}` };
  } catch (err) {
    return { ok: false, error: `failed to run ${cmd}: ${err.message}` };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is a process for this application path running?
 * @returns {Promise<boolean|null>} null when the platform cannot be asked
 */
export async function isApplicationRunning(applicationPath) {
  if (!applicationPath) return null;
  // Windows registry handlers are command strings, not clean paths, so there is nothing
  // reliable to match a process against; the caller falls back to the launcher's exit code.
  if (process.platform === 'win32') return null;
  try {
    const r = await run('pgrep', ['-f', applicationPath]);
    return r.code === 0 && r.stdout.trim() !== '';
  } catch {
    return null;
  }
}

/**
 * Wait for the launched application to actually be running.
 *
 * The launcher exiting 0 only means the OS accepted the request — a handler that is stale, or
 * that starts and immediately dies, still looks like success. Since /start's whole contract is
 * "the app is up", the answer has to be checked rather than assumed.
 *
 * @returns {Promise<boolean|null>} true/false, or null when it cannot be determined
 */
export async function waitForApplication(
  applicationPath,
  timeoutMs = 8000,
  intervalMs = 250,
  settleMs = 1500
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const running = await isApplicationRunning(applicationPath);
    if (running === null) return null;
    if (running) {
      // Seen alive is not the same as up: a stale handler can start and exit within a few
      // hundred milliseconds, which would otherwise pass as a successful launch. Give it a
      // moment and look again.
      await sleep(settleMs);
      return (await isApplicationRunning(applicationPath)) !== false;
    }
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return false;
}
