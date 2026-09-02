// The telemetry this app sends SprintRay — `POST /telemetry/<brand>/events`, see
// SprintRay-Telemetry-API_CN.md. Two events, from the two moments a desktop scanner app has
// something to say before any doctor is signed in:
//
//   scanner.connected              every time the app is launched with a case (§6.2). A launch
//                                  means the scanner is at the chair and about to be used, so
//                                  this is what makes a case in SprintRay line up with the
//                                  machine and the firmware that captured it. Stamped when the
//                                  launch arrives, sent once the launch's code has been
//                                  exchanged — that is when the doctor's `userId` exists.
//   local_server.port_unavailable  every port in the range is taken, so the resident service
//                                  never starts and the web app's probe finds nothing. To the
//                                  doctor that looks like "clicking Scan does nothing" — see
//                                  ScanPro_Local_HTTP_Server.md §4 and the spec's §6.2.
//
// Rules this file follows from the telemetry spec:
//   - `app.name` is always `ScanPro`, whichever part of the app reports (§4).
//   - `userId` is the doctor's SprintRay id, verbatim off the access token's `sub` claim, and
//     it belongs to the launch that produced it — never filled in later from whoever happens
//     to be signed in at flush time (§5.4). local_server.port_unavailable has no user at all
//     (the service starts before anyone signs in) and sends none: absent beats a placeholder.
//   - `scanner` travels with `scanner.*` events and only with them — a batch carrying one
//     without it is rejected with SCANNER_REQUIRED (§5.3).
//   - Silent, never blocking, 10 s timeout (§9).

import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';

import { loadTelemetryConfig, telemetryEndpoint } from './config.js';
import { httpJson } from './core/net.js';
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
 *
 * With a `reporter` the call goes through the instrumented HTTP path, so the request and the
 * response show up in the desktop UI's traffic pane and in the CLI log like every other call —
 * an integrator should be able to read the exact batch this app sent, not take it on trust.
 * Without one (the resident service, which has no run to report into) it is a plain fetch.
 *
 * @returns {Promise<{ ok: boolean, status?: number, body?: string, error?: string, skipped?: string }>}
 */
export async function sendTelemetryBatch({ url, apiKey, app, device, scanner, events, reporter }) {
  // Name the missing piece. Both are derived from settings the app needs anyway, so "not
  // configured" on its own sends the reader looking for a telemetry setting that is not there.
  if (!url) return { ok: false, skipped: 'no endpoint to send to (SCANPRO_BASE_URL is not set)' };
  if (!apiKey) return { ok: false, skipped: 'no api key (SCANPRO_API_KEY is not set)' };

  // `scanner` is sent only when the batch needs it: it is required by scanner.* / scan.*
  // events and pointless on the others, and the batch describes exactly one scanner (§5.3).
  const batch = { sentAt: isoWithOffset(), app, device, ...(scanner ? { scanner } : {}), events };
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'x-api-key': apiKey };

  if (reporter) {
    try {
      const { res, text } = await httpJson(reporter, {
        label: `telemetry ${events[0]?.eventName ?? 'batch'}`,
        method: 'POST',
        url,
        headers,
        body: batch,
      });
      return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
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
 * Report `scanner.connected` — the scanner is on the desk, ready for the case that just
 * arrived, and the doctor behind that case is known. See SprintRay-Telemetry-API_CN.md §6.2.
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
 * @param {string} [opts.userId]       the doctor's SprintRay id, verbatim; omitted when unknown
 * @param {{ eventId: string, occurredAt: string, sessionId: string }} [opts.event]
 *   the event minted when the launch arrived; a fresh one is stamped when it is absent
 * @param {{ serialNumber?: string, model?: string, firmwareVersion?: string, connection?: string }} [opts.scanner]
 * @param {object} [opts.reporter]     instrument the POST into the run's traffic log
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
  userId,
  event = newScannerConnectedEvent(),
  scanner = {},
  reporter,
}) {
  if (!telemetryPlatform()) {
    return { ok: false, skipped: `os.platform enum has no value for ${platform()}` };
  }

  const firmwareVersion = scanner.firmwareVersion || DEFAULT_SCANNER_FIRMWARE_VERSION;
  const connection = scanner.connection || DEFAULT_SCANNER_CONNECTION;

  return sendTelemetryBatch({
    url,
    apiKey,
    reporter,
    app: buildApp({ appVersion, installPath, installationId, build, channel }),
    device: await buildDevice(deviceId),
    scanner: {
      serialNumber: scanner.serialNumber || exampleSerialNumber(deviceId),
      model: scanner.model || DEFAULT_SCANNER_MODEL,
      firmwareVersion,
      connection,
    },
    events: [
      {
        ...event,
        // Omitted rather than sent empty when there is no signed-in doctor: an id that is not
        // real is worse than a missing one, since it silently attributes the event (§5.4).
        ...(userId ? { userId } : {}),
        // The link speed the scanner actually negotiated and the firmware it is running — the
        // two things that explain "it feels slow" and "this firmware fails more often" later.
        eventData: { connection, firmwareVersion },
      },
    ],
  });
}

/**
 * Stamp the `scanner.connected` event for one launch — identity and time only, no send.
 *
 * The two halves are deliberately separate. The launch is when the scanner connected, so that
 * is the `occurredAt` this app has to keep; but the event's `userId` does not exist yet, since
 * the doctor is only known once the launch's one-time code has been exchanged for a token. So
 * the launch stamps the event and the exchange sends it — the spec's rule (§5.4) is that the
 * id is captured for the event it belongs to, not filled in from whoever is signed in later,
 * and here that is one and the same launch.
 */
export function newScannerConnectedEvent() {
  return {
    eventId: randomUUID(),
    eventName: SCANNER_CONNECTED_EVENT,
    occurredAt: isoWithOffset(),
    sessionId: SESSION_ID,
  };
}

/**
 * The launch half: stamp the event now and hand back the one call that sends it. Every launch
 * path builds one of these — the OS URL scheme, the local service's /start, and the CLI
 * handling a launch URL — and the flow sends it as soon as the token exchange names the doctor.
 *
 * `send()` never throws and answers at most once: one launch is one event, even if the tester
 * runs the same launch payload twice.
 *
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{ appVersion?: string, installPath?: string, stateDir?: string }} [opts.defaults]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ event: object, sent: boolean, send: (opts: { userId?: string, reporter?: object }) => Promise<object> }}
 */
export function createLaunchTelemetry({ env, defaults = {}, log = () => {} } = {}) {
  const event = newScannerConnectedEvent();
  const launch = { event, sent: false };

  launch.send = async ({ userId, reporter, baseUrl } = {}) => {
    if (launch.sent) return { ok: false, skipped: 'already sent for this launch' };
    launch.sent = true;

    try {
      const config = loadTelemetryConfig(env, defaults);
      // Telemetry follows the gateway the run actually used, which is not always the one in the
      // env file: the desktop UI lets a tester point the origin field somewhere else per run.
      // An explicit SCANPRO_TELEMETRY_URL still wins over both.
      const url =
        String((env ?? process.env).SCANPRO_TELEMETRY_URL ?? '').trim() ||
        telemetryEndpoint(baseUrl, (env ?? process.env).SCANPRO_TELEMETRY_BRAND) ||
        config.url;
      const identity = await loadIdentity(config.stateDir);
      const result = await reportScannerConnected({
        ...config,
        url,
        installationId: identity.installationId,
        deviceId: identity.deviceId,
        userId,
        event,
        reporter,
      });

      if (result.skipped) log(`${SCANNER_CONNECTED_EVENT} skipped — ${result.skipped}`);
      else if (result.ok) log(`reported ${SCANNER_CONNECTED_EVENT} (HTTP ${result.status})`);
      else log(`${SCANNER_CONNECTED_EVENT} failed — ${result.error ?? `HTTP ${result.status}`}`);

      return result;
    } catch (err) {
      log(`${SCANNER_CONNECTED_EVENT} failed — ${err.message}`);
      return { ok: false, error: err.message };
    }
  };

  return launch;
}
