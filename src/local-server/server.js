// The loopback HTTP server's lifecycle: pick a port out of the agreed range and listen
// on 127.0.0.1 only. This mirrors what ScanPro's resident service (SprintRayScanService.exe)
// does — see docs: ScanPro_Local_HTTP_Server.md §1.
//
// The range is scanned from the low end upwards and the FIRST port that accepts a listen
// wins, so a caller probing 29083, 29084, … in the same order finds the service quickly.
// When every port in the range is taken the service does NOT start; the caller is expected
// to report telemetry instead (see ../telemetry.js).
//
// Zero dependencies — node:http only.

import { createServer } from 'node:http';

export const DEFAULT_PORT_RANGE_START = 29083;
export const DEFAULT_PORT_RANGE_END = 29183;
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Thrown when no port in [portRangeStart, portRangeEnd] could be bound. Carries exactly the
 * fields the `local_server.port_unavailable` telemetry event needs.
 */
export class PortRangeExhaustedError extends Error {
  constructor({ portRangeStart, portRangeEnd, attempted, lastErrorCode }) {
    super(
      `no free port in ${portRangeStart}-${portRangeEnd} ` +
        `(tried ${attempted}, last error ${lastErrorCode ?? 'unknown'})`
    );
    this.name = 'PortRangeExhaustedError';
    this.portRangeStart = portRangeStart;
    this.portRangeEnd = portRangeEnd;
    this.attempted = attempted;
    this.lastErrorCode = lastErrorCode ?? 'UNKNOWN';
  }
}

// One listen attempt. Resolves when the socket is bound, rejects with the listen error.
// A server that failed to bind is discarded — the next attempt uses a fresh one.
function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // The backlog argument is left at the default; a loopback service sees no burst traffic.
    server.listen(port, host);
  });
}

function closeServer(server, { force = false } = {}) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets would hold close() open; drop them right away.
    server.closeIdleConnections?.();
    // A forced close is the process going away (the OTA restart): in-flight requests die with
    // it, exactly what a caller polling a service that is being replaced runs into.
    if (force) server.closeAllConnections?.();
  });
}

// The order ports are tried in: from `startPort` up to the end of the range, then wrapping round
// to the start. With the default `startPort` (the range start) that is plain low-to-high, which
// is what the real service does; a later start lets the simulator come back from an OTA restart
// on another port, the way the real one does when its old port was taken in the meantime.
function portOrder(portRangeStart, portRangeEnd, startPort) {
  const first = Number.isInteger(startPort) && startPort >= portRangeStart && startPort <= portRangeEnd
    ? startPort
    : portRangeStart;
  const ports = [];
  for (let port = first; port <= portRangeEnd; port++) ports.push(port);
  for (let port = portRangeStart; port < first; port++) ports.push(port);
  return ports;
}

/**
 * Bind the first free port in the range and return the running server.
 *
 * @param {object} opts
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} opts.requestHandler
 * @param {number} [opts.portRangeStart]
 * @param {number} [opts.portRangeEnd]
 * @param {string} [opts.host]  bind address; keep the loopback default in production
 * @param {number} [opts.startPort]  first port to try (default: the range start); wraps round
 * @param {(port: number, code: string) => void} [opts.onPortBusy]  called per failed attempt
 * @returns {Promise<{ port: number, host: string, url: string, server: import('node:http').Server, close: () => Promise<void> }>}
 * @throws {PortRangeExhaustedError} when the whole range is taken
 */
export async function startLocalServer({
  requestHandler,
  portRangeStart = DEFAULT_PORT_RANGE_START,
  portRangeEnd = DEFAULT_PORT_RANGE_END,
  host = LOOPBACK_HOST,
  startPort,
  onPortBusy,
}) {
  let attempted = 0;
  let lastErrorCode = null;

  for (const port of portOrder(portRangeStart, portRangeEnd, startPort)) {
    const server = createServer(requestHandler);
    attempted += 1;

    try {
      await listenOnce(server, port, host);
    } catch (err) {
      lastErrorCode = err.code || err.message || 'UNKNOWN';
      onPortBusy?.(port, lastErrorCode);
      continue;
    }

    return {
      port,
      host,
      url: `http://${host}:${port}`,
      server,
      close: (opts) => closeServer(server, opts),
    };
  }

  throw new PortRangeExhaustedError({ portRangeStart, portRangeEnd, attempted, lastErrorCode });
}
