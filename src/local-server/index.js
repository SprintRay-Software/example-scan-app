// Starts the ScanPro local HTTP service and owns the one thing that can go wrong at startup:
// the whole port range being taken. That case is not an app error — the app keeps running,
// it just has no local service — so it resolves to `{ ok: false }` after firing the
// `local_server.port_unavailable` telemetry event, instead of throwing at the caller.
//
// With `ota` options it also hosts the app-update simulation (./ota, ScanPro_OTA_API.md). That
// adds one more lifecycle duty: installing the app replaces SprintRayScanService.exe itself, so
// when the OTA controller reaches `restarting` this module closes the HTTP server (dropping
// connections, as a dying process would), waits, builds a NEW controller from the state on disk,
// and listens again — on another port when asked, the way the real service lands elsewhere when
// its old port was taken meanwhile. The returned object's `port` / `url` follow the restart.

import { API_PREFIX, createRequestHandler } from './routes.js';
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  PortRangeExhaustedError,
  startLocalServer,
} from './server.js';
import { createOtaController } from './ota/controller.js';
import { sleep } from './ota/download.js';
import { applySimPatch, defaultSim, describeSim } from './ota/sim.js';
import { openOtaStore } from './ota/store.js';
import { DEFAULT_STATE_DIR, loadIdentity } from '../identity.js';
import { reportPortUnavailable, reportServiceEvent } from '../telemetry.js';

export { API_PREFIX, SERVICE_NAME } from './routes.js';
export { DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START } from './server.js';
export { decodeArgument, encodeArgument, summarizeArgument } from './argument.js';
export { defaultSim, applySimPatch, describeSim } from './ota/sim.js';

/** The paths a caller can reach, for logging and for the UI. */
export function describeEndpoints(baseUrl, { ota = false, control = false } = {}) {
  const endpoints = [`GET ${baseUrl}${API_PREFIX}/status`, `POST ${baseUrl}${API_PREFIX}/start`];
  if (ota) endpoints.push(`POST ${baseUrl}${API_PREFIX}/update`, `GET ${baseUrl}${API_PREFIX}/update/status`);
  if (control) endpoints.push(`GET|POST ${baseUrl}${API_PREFIX}/_sim  (simulator control, not in the contract)`);
  return endpoints;
}

// The OTA events go out through the same sender as every other service event, and like those they
// are best-effort: no endpoint or key just means "skipped", logged and forgotten.
function createOtaTelemetry({ telemetry = {}, stateDir, log }) {
  return (eventName, eventData, { severity = 'info', appVersion } = {}) => {
    (async () => {
      const identity = await loadIdentity(telemetry.stateDir ?? stateDir);
      const result = await reportServiceEvent({
        ...telemetry,
        appVersion: appVersion ?? telemetry.appVersion,
        installationId: telemetry.installationId ?? identity.installationId,
        deviceId: identity.deviceId,
        eventName,
        eventData,
        severity,
      });
      if (result.skipped) log(`${eventName} telemetry skipped — ${result.skipped}`);
      else if (result.ok) log(`reported ${eventName} (HTTP ${result.status})`);
      else log(`${eventName} telemetry failed — ${result.error ?? `HTTP ${result.status}`}`);
    })().catch((err) => log(`${eventName} telemetry failed — ${err.message}`));
  };
}

// The port the service comes back on after an OTA restart when a port switch is asked for: the
// next one up from where it was, wrapping inside the range.
function nextPort(port, start, end) {
  return port >= end ? start : port + 1;
}

/**
 * @param {object} opts
 * @param {object} opts.service  see createRequestHandler — { getStatus, start }
 * @param {object} [opts.options] parsed local-server config (see loadLocalServerConfig)
 * @param {(msg: string) => void} [opts.log]
 * @param {object|false} [opts.ota]  enable the app-OTA simulation:
 *   { sim?: object (switches, see ota/sim.js; a shared object the caller may keep changing),
 *     stateDir?: string (where ota/state.json and packages live; default options.stateDir),
 *     control?: boolean (mount the /_sim control route),
 *     resetInstalledVersion?: boolean (forget an OTA-installed version — an explicit --version wins),
 *     emitTelemetry?: function (override, for tests) }
 * @param {(event: { type: 'down'|'up'|'failed', port?: number, url?: string, previousPort?: number, delayMs?: number, error?: Error }) => void} [opts.onRestart]
 * @returns {Promise<
 *   { ok: true, port: number, url: string, endpoints: string[], close: () => Promise<void>, ota: object|null } |
 *   { ok: false, reason: string, error: Error, telemetry: object }
 * >}
 */
export async function startScanProLocalServer({ service, options = {}, log = () => {}, ota = false, onRestart = () => {} }) {
  const {
    portRangeStart = DEFAULT_PORT_RANGE_START,
    portRangeEnd = DEFAULT_PORT_RANGE_END,
    allowedOrigins = null,
    checkHost = true,
    telemetry = {},
    stateDir,
  } = options;

  // ---- OTA ----------------------------------------------------------------------------------
  let controller = null;
  let sim = null;
  let otaApi = null;
  let restartFn = null;
  const lifetime = new AbortController();

  if (ota) {
    sim = ota.sim ?? defaultSim();
    const otaStateDir = ota.stateDir ?? stateDir ?? DEFAULT_STATE_DIR;
    const emitTelemetry = ota.emitTelemetry ?? createOtaTelemetry({ telemetry, stateDir: otaStateDir, log });

    // Each controller is one run of the service; it reopens the store so nothing in memory carries
    // over a restart — what the new service knows is what the old one wrote to disk.
    const makeController = () =>
      createOtaController({
        store: openOtaStore(otaStateDir),
        sim,
        scanPro: service,
        requestRestart: (opts) => restartFn?.(opts),
        emitTelemetry,
        log,
      });

    if (ota.resetInstalledVersion) {
      const store = openOtaStore(otaStateDir);
      delete store.data.installed.app;
      store.save();
    }
    controller = makeController();
    await controller.resume();

    otaApi = {
      sim,
      stateDir: otaStateDir,
      get controller() {
        return controller;
      },
      snapshot: () => ({ sim, ...(controller ? controller.snapshot() : { status: null }), port: current?.port ?? null }),
      patch: (patch) => {
        applySimPatch(sim, patch);
        log(`OTA simulator switches: ${describeSim(sim)}`);
      },
      reset: () => {
        controller?.reset();
        controller = makeController();
        log('OTA state reset: no update, no package, configured version');
      },
    };
    otaApi.makeController = makeController;
  }

  const requestHandler = createRequestHandler({
    service,
    allowedOrigins,
    checkHost,
    log,
    getOta: () => controller,
    sim,
    control: ota && ota.control ? otaApi : null,
  });

  let current;
  try {
    current = await startLocalServer({
      requestHandler,
      portRangeStart,
      portRangeEnd,
      onPortBusy: (port, code) => log(`port ${port} unavailable (${code}), trying the next one`),
    });
  } catch (err) {
    controller?.dispose();
    if (!(err instanceof PortRangeExhaustedError)) throw err;

    log(err.message);
    const identity = await loadIdentity(stateDir);
    const result = await reportPortUnavailable({
      ...telemetry,
      installationId: telemetry.installationId ?? identity.installationId,
      deviceId: identity.deviceId,
      failure: {
        portRangeStart: err.portRangeStart,
        portRangeEnd: err.portRangeEnd,
        attempted: err.attempted,
        lastErrorCode: err.lastErrorCode,
      },
    });

    if (result.skipped) log(`port_unavailable telemetry skipped — ${result.skipped}`);
    else if (result.ok) log(`reported local_server.port_unavailable (HTTP ${result.status})`);
    else log(`port_unavailable telemetry failed — ${result.error ?? `HTTP ${result.status}`}`);

    return { ok: false, reason: 'port_range_exhausted', error: err, telemetry: result };
  }

  // ---- the simulated replacement of the service (OTA `restarting`) ---------------------------
  let restarting = null;
  restartFn = ({ delayMs, portSwitch, restartPort }) => {
    if (restarting || lifetime.signal.aborted) return;
    restarting = (async () => {
      const previousPort = current.port;
      await controller?.dispose();
      await current.close({ force: true });
      current = null;
      log(`service down for the update (port ${previousPort} closed); back in ${delayMs} ms`);
      onRestart({ type: 'down', previousPort, delayMs });

      await sleep(delayMs, lifetime.signal);

      // The "new process": a fresh controller reading the persisted state settles the install
      // before the first request can reach it.
      controller = otaApi.makeController();
      await controller.resume();

      const startPort = restartPort ?? (portSwitch ? nextPort(previousPort, portRangeStart, portRangeEnd) : portRangeStart);
      try {
        current = await startLocalServer({
          requestHandler,
          portRangeStart,
          portRangeEnd,
          startPort,
          onPortBusy: (port, code) => log(`port ${port} unavailable (${code}), trying the next one`),
        });
      } catch (err) {
        log(`service could not come back after the update: ${err.message}`);
        onRestart({ type: 'failed', previousPort, error: err });
        return;
      }
      log(`service back on ${current.url}${current.port !== previousPort ? ` (was port ${previousPort})` : ''}`);
      onRestart({ type: 'up', port: current.port, url: current.url, previousPort });
    })()
      .catch((err) => {
        if (!lifetime.signal.aborted) log(`OTA restart failed: ${err.message}`);
      })
      .finally(() => {
        restarting = null;
      });
  };

  const endpointsFor = (url) => describeEndpoints(url, { ota: Boolean(ota), control: Boolean(ota && ota.control) });

  return {
    ok: true,
    get port() {
      return current?.port ?? null;
    },
    get url() {
      return current?.url ?? null;
    },
    get endpoints() {
      return current ? endpointsFor(current.url) : [];
    },
    ota: otaApi,
    /** Resolves once a pending OTA restart (if any) has finished — for tests. */
    whenRestarted: () => restarting ?? Promise.resolve(),
    close: async () => {
      lifetime.abort();
      await controller?.dispose();
      await restarting;
      await current?.close({ force: true });
      current = null;
    },
  };
}

