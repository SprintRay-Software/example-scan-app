// The telemetry this app sends SprintRay — `POST /telemetry/<brand>/events`, see
// SprintRay-Telemetry-API_CN.md. Two events, from the two moments a desktop scanner app has
// something to say before any doctor is signed in:
//
//   scanner.connected              every time the app is launched with a case (§6.2). A launch
//                                  means the scanner is at the chair and about to be used, so
//                                  this is what makes a case in SprintRay line up with the
//                                  machine and the firmware that captured it.
//   local_server.port_unavailable  every port in the range is taken, so the resident service
//                                  never starts and the web app's probe finds nothing. To the
//                                  doctor that looks like "clicking Scan does nothing" — see
//                                  ScanPro_Local_HTTP_Server.md §4 and the spec's §6.2.
//
// Rules this file follows from the telemetry spec:
//   - `app.name` is always `ScanPro`, whichever part of the app reports (§4).
//   - No `userId`: both events happen before the code is exchanged, and a placeholder is worse
//     than nothing (§5.4).
//   - `scanner` travels with `scanner.*` events and only with them — a batch carrying one
//     without it is rejected with SCANNER_REQUIRED (§5.3).
//   - Silent, never blocking, 10 s timeout (§9).

import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';

import { loadTelemetryConfig } from './config.js';
import { loadIdentity } from './identity.js';
import { run } from './scheme/exec.js';

const TELEMETRY_TIMEOUT_MS = 10_000;
export const APP_NAME = 'ScanPro';
export const PORT_UNAVAILABLE_EVENT = 'local_server.port_unavailable';
export const SCANNER_CONNECTED_EVENT = 'scanner.connected';

// What this example reports about the scanner it stands in for. A real app reads all four off
// the hardware it just enumerated; these only exist so the event has the right shape without
// a scanner on the desk, and any of them can be set in the .env (see .env.example).
export const DEFAULT_SCANNER_MODEL = 'ScanPro S1';
export const DEFAULT_SCANNER_FIRMWARE_VERSION = '1.0.0';
export const DEFAULT_SCANNER_CONNECTION = 'usb3';

// One application run, the way the spec groups events (§5.4). It stays the same across every
// launch this process handles — a resident app being handed a second case is still one run.
export const SESSION_ID = randomUUID();

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

// `app` is the same for every event this process sends; only the optional fields vary with
// what the .env supplied. An empty optional field is omitted rather than sent empty — the
// schema length-checks what it gets, and "" is not more informative than absent.
function buildApp({ appVersion, installPath, installationId, build, channel }) {
  const app = { name: APP_NAME, version: appVersion, installPath };
  if (installationId) app.installationId = installationId;
  if (build) app.build = build;
  if (channel) app.channel = channel;
  return app;
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
export async function sendTelemetryBatch({ url, apiKey, app, device, scanner, events }) {
  if (!url || !apiKey) return { ok: false, skipped: 'telemetry endpoint or api key not configured' };

  // `scanner` is sent only when the batch needs it: it is required by scanner.* / scan.*
  // events and pointless on the others, and the batch describes exactly one scanner (§5.3).
  const batch = { sentAt: isoWithOffset(), app, device, ...(scanner ? { scanner } : {}), events };

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
    app: buildApp({ appVersion, installPath, installationId, build, channel }),
    device: await buildDevice(deviceId),
    events: [event],
  });
}

// A stand-in serial for a machine with no scanner attached. Stable per install, since it is
// derived from the device id — a real app reports the serial the hardware gave it, verbatim
// and unhashed, because that is the only thing tying this data to a physical scanner (§5.3).
export function exampleSerialNumber(deviceId) {
  return `EXAMPLE-${String(deviceId).slice(0, 12).toUpperCase()}`;
}

/**
 * Report `scanner.connected` — the scanner is on the desk and ready for the case that just
 * arrived. See SprintRay-Telemetry-API_CN.md §6.2.
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
 * @param {string} [opts.sessionId]    groups this run's events; defaults to this process's
 * @param {{ serialNumber?: string, model?: string, firmwareVersion?: string, connection?: string }} [opts.scanner]
 */
export async function reportScannerConnected({
  url,
  apiKey,
  appVersion,
  installPath,
  installationId,
  deviceId,
  build,
  channel,
  sessionId = SESSION_ID,
  scanner = {},
}) {
  if (!telemetryPlatform()) {
    return { ok: false, skipped: `os.platform enum has no value for ${platform()}` };
  }

  const firmwareVersion = scanner.firmwareVersion || DEFAULT_SCANNER_FIRMWARE_VERSION;
  const connection = scanner.connection || DEFAULT_SCANNER_CONNECTION;

  const event = {
    eventId: randomUUID(),
    eventName: SCANNER_CONNECTED_EVENT,
    occurredAt: isoWithOffset(),
    sessionId,
    // The link speed the scanner actually negotiated and the firmware it is running — the two
    // things that explain "it feels slow" and "this firmware fails more often" later on.
    eventData: { connection, firmwareVersion },
  };

  return sendTelemetryBatch({
    url,
    apiKey,
    app: buildApp({ appVersion, installPath, installationId, build, channel }),
    device: await buildDevice(deviceId),
    scanner: {
      serialNumber: scanner.serialNumber || exampleSerialNumber(deviceId),
      model: scanner.model || DEFAULT_SCANNER_MODEL,
      firmwareVersion,
      connection,
    },
    events: [event],
  });
}

/**
 * Report `scanner.connected` for one launch: resolve the config and this install's identity,
 * send, and say what happened. Every launch path calls this — the OS URL scheme, the local
 * service's /start, and the CLI handling a launch URL — so one launch is one event, whichever
 * transport carried it.
 *
 * Never throws and never blocks the launch: telemetry that can hold up the scanner app is
 * worse than telemetry that is missing.
 *
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{ appVersion?: string, installPath?: string, stateDir?: string }} [opts.defaults]
 * @param {(msg: string) => void} [opts.log]
 */
export async function reportScannerConnectedOnLaunch({ env, defaults = {}, log = () => {} } = {}) {
  try {
    const config = loadTelemetryConfig(env, defaults);
    const identity = await loadIdentity(config.stateDir);
    const result = await reportScannerConnected({
      ...config,
      installationId: identity.installationId,
      deviceId: identity.deviceId,
    });

    if (result.skipped) log(`${SCANNER_CONNECTED_EVENT} skipped — ${result.skipped}`);
    else if (result.ok) log(`reported ${SCANNER_CONNECTED_EVENT} (HTTP ${result.status})`);
    else log(`${SCANNER_CONNECTED_EVENT} failed — ${result.error ?? `HTTP ${result.status}`}`);

    return result;
  } catch (err) {
    log(`${SCANNER_CONNECTED_EVENT} failed — ${err.message}`);
    return { ok: false, error: err.message };
  }
}
