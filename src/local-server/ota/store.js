// What the OTA simulation keeps on disk, and why it has to: ScanPro_OTA_API.md §4.5 says the
// download and install state are written to disk, not held in memory, because installing the app
// replaces SprintRayScanService.exe itself (and the PC may reboot between download and install).
// The new service must still answer `/update/status` and still find the downloaded package.
//
//   <stateDir>/ota/state.json             the one state file (below)
//   <stateDir>/ota/packages/<target>/...  at most one downloaded package per target (only `app`
//                                         is simulated, but the layout follows the contract)
//
// state.json:
//   status     the body of GET /update/status, verbatim
//   run        bookkeeping for the step in progress / last finished: the request's package,
//              when the install call came in (durationMs is measured from it, across a restart)
//   packages   { app? } — the downloaded, verified package per target
//   installed  { app? } — the version an OTA install left behind; it wins over the
//              configured ones, so after a simulated update /status reports the new version
//
// Writes are synchronous and atomic (temp file + rename). The file is a few hundred bytes, and a
// crash or a kill halfway through a write must never leave a half-written state that the next
// start cannot parse — that is exactly the case this file exists for.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const STATE_FILE = 'state.json';
const SCHEMA = 1;

export const IDLE_STATUS = Object.freeze({
  action: null,
  target: null,
  phase: 'idle',
  percent: null,
  fromVersion: null,
  toVersion: null,
  startedAt: null,
  updatedAt: null,
  error: null,
});

function emptyState() {
  return { schema: SCHEMA, status: { ...IDLE_STATUS }, run: null, packages: {}, installed: {} };
}

// A URL's last path segment, reduced to characters that are safe in a file name on Windows too.
function packageFileName(url) {
  let name = 'package.bin';
  try {
    name = basename(new URL(url).pathname) || name;
  } catch {
    // not a URL — keep the fallback; validation rejects such a request before it gets here
  }
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'package.bin';
}

/**
 * Open (and create if needed) the OTA state under `stateDir`.
 * @param {string} stateDir
 */
export function openOtaStore(stateDir) {
  const dir = join(stateDir, 'ota');
  const packagesDir = join(dir, 'packages');
  const file = join(dir, STATE_FILE);
  mkdirSync(packagesDir, { recursive: true });

  let data = emptyState();
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.schema === SCHEMA && saved.status?.phase) {
      data = { ...emptyState(), ...saved, status: { ...IDLE_STATUS, ...saved.status } };
    }
  } catch {
    // no state yet, or unreadable — start from idle, as a fresh install would
  }

  const store = {
    dir,
    packagesDir,
    file,
    get data() {
      return data;
    },

    save() {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, file);
    },

    /** Where the package for `target` lives once downloaded. */
    packagePath(target, url) {
      return join(packagesDir, target, packageFileName(url));
    },

    ensureTargetDir(target) {
      mkdirSync(join(packagesDir, target), { recursive: true });
    },

    /** Remove the downloaded package for a target, file and record both. */
    deletePackage(target) {
      rmSync(join(packagesDir, target), { recursive: true, force: true });
      delete data.packages[target];
    },

    /** The record of a downloaded package, or null when the record or its file is gone. */
    downloadedPackage(target) {
      const rec = data.packages[target];
      if (!rec) return null;
      if (!rec.path || !existsSync(rec.path)) {
        // Deleted behind the service's back: the record alone is not a downloaded package.
        delete data.packages[target];
        return null;
      }
      return rec;
    },

    /** Back to a never-updated install: no status, no packages, no OTA-installed versions. */
    reset() {
      rmSync(packagesDir, { recursive: true, force: true });
      mkdirSync(packagesDir, { recursive: true });
      data = emptyState();
      store.save();
    },
  };

  return store;
}
