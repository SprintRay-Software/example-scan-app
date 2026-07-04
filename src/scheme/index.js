// Platform dispatcher for OS URL-scheme registration.
//
// Picks the registrar for the current OS and fills in the common launch context
// (which node, where the simulator lives, where handler logs go). Each platform
// module turns `<scheme>://…` opens into a run of `node src/index.js <url>`:
//   - darwin: an AppleScript .app whose `on open location` forwards the URL (TESTED)
//   - win32:  HKCU\Software\Classes keys; the URL arrives as %1
//   - linux:  a ~/.local/share/applications .desktop; the URL arrives as %u

import * as darwin from './darwin.js';
import * as win32 from './win32.js';
import * as linux from './linux.js';

const IMPLS = { darwin, win32, linux };

function impl() {
  const m = IMPLS[process.platform];
  if (!m) {
    throw new Error(
      `URL-scheme registration is not implemented for platform "${process.platform}" ` +
        `(supported: ${Object.keys(IMPLS).join(', ')})`
    );
  }
  return m;
}

export function platformName() {
  return process.platform;
}

/**
 * Register the OS handler for `scheme`, pointing it at this simulator checkout.
 * darwin bundles a snapshot from simDir; win32/linux run indexJs from the checkout.
 * @param {{ scheme: string, simDir: string, indexJs: string, envFile: string, headless?: boolean }} opts
 */
export function registerScheme(opts) {
  return impl().register({ ...opts, nodeBin: process.execPath });
}

export function unregisterScheme(scheme) {
  return impl().unregister(scheme);
}

export function schemeStatus(scheme) {
  return impl().status(scheme);
}
