// Stable ids the telemetry batch needs (SprintRay-Telemetry-API_CN.md §5.1/§5.2):
//
//   deviceId        one machine, stable across app restarts, app upgrades and OS upgrades.
//                   Reported as a SHA-256 of the OS machine id — the doc's recommendation —
//                   so no raw machine identifier leaves the host.
//   installationId  one install of this app, stable until it is reinstalled.
//
// Both are persisted next to each other in a small JSON file. A machine id we cannot read
// (locked-down host, unsupported platform) degrades to a persisted random uuid: still stable
// for this install, just not shared between reinstalls.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { run } from '../scheme/exec.js';

export const DEFAULT_STATE_DIR = join(homedir(), '.sprintray-scanpro-example');
const IDENTITY_FILE = 'identity.json';

// Read the OS machine id. Returns null when it cannot be determined.
async function readMachineId() {
  try {
    if (process.platform === 'darwin') {
      const r = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const m = r.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m ? m[1] : null;
    }
    if (process.platform === 'win32') {
      const r = await run('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid',
        '/reg:64',
      ]);
      const m = r.stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      return m ? m[1] : null;
    }
    // Linux is not a target platform for the service, but keep dev machines working.
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const text = await readFile(path, 'utf8');
        if (text.trim()) return text.trim();
      } catch {
        // try the next one
      }
    }
    return null;
  } catch {
    return null;
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Load (or create and persist) this install's identity.
 * @param {string} [stateDir] directory holding identity.json
 * @returns {Promise<{ installationId: string, deviceId: string, persisted: boolean }>}
 */
export async function loadIdentity(stateDir = DEFAULT_STATE_DIR) {
  const file = join(stateDir, IDENTITY_FILE);

  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved?.installationId && saved?.deviceId) {
      return { installationId: saved.installationId, deviceId: saved.deviceId, persisted: true };
    }
  } catch {
    // no usable file yet — fall through and create one
  }

  const machineId = await readMachineId();
  const identity = {
    installationId: randomUUID(),
    // Salted with a constant so the same machine id used elsewhere cannot be correlated
    // back to this hash, while staying stable for this app.
    deviceId: hash(`sprintray-scanpro-example:${machineId ?? randomUUID()}`),
  };

  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(identity, null, 2), 'utf8');
    return { ...identity, persisted: true };
  } catch {
    // Read-only home / no permission: the ids still work for this run, they just will not
    // survive a restart. Telemetry is best-effort by design, so this is not an error.
    return { ...identity, persisted: false };
  }
}
