// Starts the ScanPro local HTTP service and owns the one thing that can go wrong at startup:
// the whole port range being taken. That case is not an app error — the app keeps running,
// it just has no local service — so it resolves to `{ ok: false }` after firing the
// `local_server.port_unavailable` telemetry event, instead of throwing at the caller.

import { API_PREFIX, createRequestHandler } from './routes.js';
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  PortRangeExhaustedError,
  startLocalServer,
} from './server.js';
import { loadIdentity } from './identity.js';
import { reportPortUnavailable } from './telemetry.js';

export { API_PREFIX, SERVICE_NAME } from './routes.js';
export { DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START } from './server.js';
export { decodeArgument, encodeArgument, summarizeArgument } from './argument.js';

/** The paths a caller can reach, for logging and for the UI. */
export function describeEndpoints(baseUrl) {
  return [`GET ${baseUrl}${API_PREFIX}/status`, `POST ${baseUrl}${API_PREFIX}/start`];
}

/**
 * @param {object} opts
 * @param {object} opts.service  see createRequestHandler — { getStatus, start }
 * @param {object} [opts.options] parsed local-server config (see loadLocalServerConfig)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<
 *   { ok: true, port: number, url: string, endpoints: string[], close: () => Promise<void> } |
 *   { ok: false, reason: string, error: Error, telemetry: object }
 * >}
 */
export async function startScanProLocalServer({ service, options = {}, log = () => {} }) {
  const {
    portRangeStart = DEFAULT_PORT_RANGE_START,
    portRangeEnd = DEFAULT_PORT_RANGE_END,
    allowedOrigins = null,
    checkHost = true,
    telemetry = {},
    stateDir,
  } = options;

  const requestHandler = createRequestHandler({ service, allowedOrigins, checkHost, log });

  try {
    const started = await startLocalServer({
      requestHandler,
      portRangeStart,
      portRangeEnd,
      onPortBusy: (port, code) => log(`port ${port} unavailable (${code}), trying the next one`),
    });
    return {
      ok: true,
      port: started.port,
      url: started.url,
      endpoints: describeEndpoints(started.url),
      close: started.close,
    };
  } catch (err) {
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
}
