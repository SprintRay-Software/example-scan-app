// Telemetry for the one failure the machine cannot see by itself: every port in the range is
// taken, so the service never starts and the web app's probe finds nothing. To the doctor that
// looks like "clicking Scan does nothing" — see ScanPro_Local_HTTP_Server.md §4 and
// SprintRay-Telemetry-API_CN.md §6.2 (`local_server.port_unavailable`).
//
// Rules this file follows from the telemetry spec:
//   - `app.name` is always `ScanPro`, even though the reporter is the resident service (§4).
//   - No `userId`: the service starts before anyone logs in, and a placeholder is worse than
//     nothing (§5.4).
//   - No `scanner` object: this failure has nothing to do with the scanner (§5.3).
//   - Silent, never blocking, 10 s timeout (§9).

import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';

import { run } from '../scheme/exec.js';

const TELEMETRY_TIMEOUT_MS = 10_000;
export const APP_NAME = 'ScanPro';
export const PORT_UNAVAILABLE_EVENT = 'local_server.port_unavailable';

// ISO-8601 with a timezone offset — the spec rejects a bare UTC "Z"-less local time and wants
// the real local offset, so build it rather than using toISOString().
export function isoWithOffset(date = new Date()) {
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  );
}

// `os.platform` is an enum of exactly windows|macos; anything else cannot be reported.
export function telemetryPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return null;
}

// os.release() is the kernel version on macOS (25.6.0), not the product version the spec wants.
async function osVersion() {
  if (process.platform === 'darwin') {
    try {
      const r = await run('sw_vers', ['-productVersion']);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    } catch {
      // fall through to the kernel version
    }
  }
  return release();
}

async function buildDevice(deviceId) {
  const os = { platform: telemetryPlatform(), version: await osVersion() };
  // The architecture enum only covers these two; omit anything else rather than fail schema.
  if (arch() === 'x64' || arch() === 'arm64') os.architecture = arch();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone) os.timeZone = timeZone;
  return { deviceId, os };
}

/**
 * POST one batch. Never throws — telemetry must not affect the app.
 * @returns {Promise<{ ok: boolean, status?: number, body?: string, error?: string, skipped?: string }>}
 */
export async function sendTelemetryBatch({ url, apiKey, app, device, events }) {
  if (!url || !apiKey) return { ok: false, skipped: 'telemetry endpoint or api key not configured' };

  const batch = { sentAt: isoWithOffset(), app, device, events };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-api-key': apiKey },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Report `local_server.port_unavailable`.
 *
 * @param {object} opts
 * @param {string} opts.url            telemetry endpoint
 * @param {string} opts.apiKey         x-api-key
 * @param {string} opts.appVersion     product version reported as app.version
 * @param {string} opts.installPath    app install path, reported as-is
 * @param {string} [opts.installationId]
 * @param {string} opts.deviceId
 * @param {string} [opts.build]        CI build number or short sha
 * @param {string} [opts.channel]      release | beta | internal | dev
 * @param {{ portRangeStart: number, portRangeEnd: number, attempted: number, lastErrorCode: string }} opts.failure
 */
export async function reportPortUnavailable({
  url,
  apiKey,
  appVersion,
  installPath,
  installationId,
  deviceId,
  build,
  channel,
  failure,
}) {
  if (!telemetryPlatform()) {
    return { ok: false, skipped: `os.platform enum has no value for ${platform()}` };
  }

  const app = { name: APP_NAME, version: appVersion, installPath };
  if (installationId) app.installationId = installationId;
  if (build) app.build = build;
  if (channel) app.channel = channel;

  const event = {
    eventId: randomUUID(),
    eventName: PORT_UNAVAILABLE_EVENT,
    occurredAt: isoWithOffset(),
    severity: 'error',
    eventData: {
      portRangeStart: failure.portRangeStart,
      portRangeEnd: failure.portRangeEnd,
      attempted: failure.attempted,
      lastErrorCode: failure.lastErrorCode,
    },
  };

  return sendTelemetryBatch({
    url,
    apiKey,
    app,
    device: await buildDevice(deviceId),
    events: [event],
  });
}
