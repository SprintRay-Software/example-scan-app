// The endpoints of the ScanPro local HTTP service, as specified in ScanPro_Local_HTTP_Server.md §3
// and, for the app update, ScanPro_OTA_API.md §4:
//
//   GET  /scanpro/v1/status         -> { service, installed, running, version }
//   POST /scanpro/v1/start          -> { argument: <base64 JSON> } -> { status, started }
//   POST /scanpro/v1/update         -> { action, target, package } -> { action, target, phase, fromVersion, toVersion }
//   GET  /scanpro/v1/update/status  -> { action, target, phase, percent, fromVersion, toVersion, startedAt, updatedAt, error }
//
// Plus, only when explicitly enabled, the simulator's own control route — NOT part of any
// contract, see handleSimControl below:
//
//   GET  /scanpro/v1/_sim          -> switches + OTA snapshot
//   POST /scanpro/v1/_sim          -> change switches
//   POST /scanpro/v1/_sim/reset    -> forget every update, package and OTA-installed version
//
// The routes are pure HTTP plumbing: what "installed", "running" and "start" actually mean
// is supplied by the caller as a `service` object, so the Electron app (where this example
// app itself plays ScanPro) and the headless CLI can both mount the same contract.
//
// Two additions to the spec, both flagged in its §5 "open questions" and both harmless to a
// client that ignores them:
//   - `service: "SprintRayScanService"` in /status, so port probing can tell this service
//     apart from any other program that happens to answer with a `version` field (§5.2);
//   - a fixed error envelope `{ error: { code, message } }` on 4xx/5xx, with `code` a stable
//     constant rather than localized prose (§5.1).

import { Buffer } from 'node:buffer';

import { decodeArgument } from './argument.js';
import { OtaRequestError } from './ota/errors.js';

export const API_PREFIX = '/scanpro/v1';
export const SERVICE_NAME = 'SprintRayScanService';

// A launch payload is a few KB. Anything larger is a client bug, not a big request.
const MAX_BODY_BYTES = 256 * 1024;
const PREFLIGHT_MAX_AGE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: { code, message } }, headers);
}

// ---------------------------------------------------------------------------
// CORS
//
// The caller is the SprintRay web app — an HTTPS page reaching into http://127.0.0.1, which
// is cross-origin, so without these headers the browser drops every response. Chrome's
// Private Network Access rules add a preflight even for otherwise-simple requests, and that
// preflight only passes if it is answered with Access-Control-Allow-Private-Network.
// ---------------------------------------------------------------------------
function corsHeaders(req, allowedOrigins) {
  // Vary regardless: the answer depends on Origin even when we send no ACAO header.
  const headers = { Vary: 'Origin' };
  const origin = req.headers.origin;
  if (!origin) return headers; // non-browser client (curl, the desktop app itself)
  if (allowedOrigins && !allowedOrigins.includes(origin)) return headers; // denied: no ACAO
  headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function handlePreflight(req, res, allowedOrigins) {
  const headers = {
    ...corsHeaders(req, allowedOrigins),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type',
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
  };
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  res.writeHead(204, headers);
  res.end();
}

// ---------------------------------------------------------------------------
// DNS-rebinding guard
//
// The service is unauthenticated and trusts the loopback interface. That trust only holds
// while the request really was addressed to loopback: a page on attacker.com whose DNS name
// resolves to 127.0.0.1 reaches this socket with `Host: attacker.com`. Rejecting a foreign
// Host closes that hole and costs a real client nothing.
// ---------------------------------------------------------------------------
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 client; the socket is loopback-bound anyway
  const hostname = String(hostHeader)
    .replace(/:\d+$/, '') // strip the port
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------
function tooLarge(limit) {
  const err = new Error(`request body exceeds ${limit} bytes`);
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    // A declared Content-Length over the limit is refused before a single byte is read.
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isInteger(declared) && declared > limit) {
      reject(tooLarge(limit));
      return;
    }

    const chunks = [];
    let size = 0;
    let stopped = false;
    req.on('data', (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > limit) {
        // Stop reading, but leave the socket alive: destroying it here would kill the
        // 413 before the client could read it. The caller closes the connection instead.
        stopped = true;
        req.pause();
        reject(tooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!stopped) reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleStatus(res, service, ota, cors) {
  const base = await service.getStatus();
  // With the OTA simulation on, /status reports what an update left installed and what the
  // simulator switches say about ScanPro — the Scan tab's success check reads `version` here.
  const status = ota ? ota.decorateStatus(base) : base;
  sendJson(
    res,
    200,
    {
      service: SERVICE_NAME,
      running: Boolean(status.running),
      installed: Boolean(status.installed),
      version: String(status.version ?? ''),
    },
    cors
  );
}

async function handleStart(req, res, service, cors, log) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      // The client may still be uploading; close once the 413 is on the wire so it stops.
      res.on('finish', () => req.socket?.destroy());
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, { ...cors, Connection: 'close' });
    } else {
      sendError(res, 400, 'BODY_READ_FAILED', err.message, cors);
    }
    return;
  }

  let body;
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (err) {
    sendError(res, 400, 'INVALID_JSON', `request body is not valid JSON: ${err.message}`, cors);
    return;
  }

  const argument = body?.argument;
  if (typeof argument !== 'string' || argument.trim() === '') {
    sendError(res, 400, 'ARGUMENT_REQUIRED', '`argument` is required and must be a non-empty string', cors);
    return;
  }

  // The real service hands `argument` to ScanPro untouched. This example app decodes it and
  // rejects malformed input on the spot — that is the point of an integration simulator: the
  // caller finds out here that its base64/JSON is wrong, not from a silently idle scanner.
  let decoded;
  try {
    decoded = decodeArgument(argument);
  } catch (err) {
    sendError(res, 400, 'ARGUMENT_NOT_BASE64_JSON', err.message, cors);
    return;
  }

  try {
    const result = (await service.start({ argument, decoded })) ?? {};
    const started = result.started !== false;
    const payload = { status: started, started };
    // `status` is the field the contract defines today; `started` is the clearer name the
    // spec's §5.6 suggests. Both are sent so either reading works.
    if (!started) {
      payload.errorCode = result.errorCode ?? 'START_FAILED';
      payload.message = result.message ?? 'ScanPro could not be started';
    }
    sendJson(res, 200, payload, cors);
  } catch (err) {
    log(`/start failed: ${err.message}`);
    sendError(res, 500, 'START_ERROR', err.message, cors);
  }
}

// Read a JSON object body. Answers the error itself and resolves to undefined when it cannot.
async function readJsonBody(req, res, cors, invalidCode) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      res.on('finish', () => req.socket?.destroy());
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', err.message, { ...cors, Connection: 'close' });
    } else {
      sendError(res, 400, invalidCode, `could not read the request body: ${err.message}`, cors);
    }
    return undefined;
  }
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (err) {
    sendError(res, 400, invalidCode, `request body is not valid JSON: ${err.message}`, cors);
    return undefined;
  }
}

// POST /scanpro/v1/update (ScanPro_OTA_API.md §4.4). Answers at once; the step runs on in the
// background and is followed through /update/status. Every refusal uses the contract's E_ codes.
async function handleUpdate(req, res, ota, cors, log) {
  const body = await readJsonBody(req, res, cors, 'E_INVALID_ARGUMENT');
  if (body === undefined) return;
  try {
    sendJson(res, 200, await ota.handlePost(body), cors);
  } catch (err) {
    if (err instanceof OtaRequestError) {
      log(`/update refused: ${err.code} — ${err.message}`);
      sendError(res, err.status, err.code, err.message, cors);
      return;
    }
    log(`/update failed: ${err.message}`);
    sendError(res, 500, 'E_UNKNOWN', err.message, cors);
  }
}

// The simulator's control route. Off unless the host turns it on (`serve --sim-control`), because a
// loopback route that changes behaviour is exactly the kind of thing a real service must not have.
async function handleSimControl(req, res, pathname, control, cors) {
  const sub = pathname.slice(`${API_PREFIX}/_sim`.length);
  if (sub === '' && req.method === 'GET') {
    sendJson(res, 200, control.snapshot(), cors);
    return;
  }
  if (sub === '' && req.method === 'POST') {
    const body = await readJsonBody(req, res, cors, 'INVALID_JSON');
    if (body === undefined) return;
    try {
      control.patch(body);
    } catch (err) {
      sendError(res, 400, 'INVALID_SWITCH', err.message, cors);
      return;
    }
    sendJson(res, 200, control.snapshot(), cors);
    return;
  }
  if (sub === '/reset' && req.method === 'POST') {
    control.reset();
    sendJson(res, 200, control.snapshot(), cors);
    return;
  }
  sendError(res, 404, 'NOT_FOUND', `no simulator control route for ${req.method} ${pathname}`, cors);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/**
 * Build the node:http request handler for the service.
 *
 * @param {object} opts
 * @param {{ getStatus: () => object|Promise<object>, start: (arg: { argument: string, decoded: object }) => object|Promise<object> }} opts.service
 * @param {string[]|null} [opts.allowedOrigins]  null = echo any Origin; a list = allowlist
 * @param {boolean} [opts.checkHost]  reject non-loopback Host headers (default true)
 * @param {(msg: string) => void} [opts.log]
 * @param {() => object|null} [opts.getOta]  the current OTA controller (it is replaced on every
 *   simulated restart, hence a getter); null/absent = no OTA routes, like a pre-OTA service
 * @param {object|null} [opts.sim]  the simulator switches (see ota/sim.js)
 * @param {{ snapshot: () => object, patch: (p: object) => void, reset: () => void }|null} [opts.control]
 *   the /_sim control route's backing; null keeps the route off (the default)
 */
export function createRequestHandler({
  service,
  allowedOrigins = null,
  checkHost = true,
  log = () => {},
  getOta = () => null,
  sim = null,
  control = null,
}) {
  return function handleRequest(req, res) {
    // req.url is a path here (an origin-form request target), so any base works.
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    const isControl = control && (pathname === `${API_PREFIX}/_sim` || pathname.startsWith(`${API_PREFIX}/_sim/`));

    // A server that belongs to another desktop session answers every path — OPTIONS included —
    // with 503 BEFORE any CORS handling (ScanPro_OTA_API.md §4.1), so the browser sees no
    // Access-Control-Allow-Origin at all. Simulated by a switch; the control route stays usable so
    // the switch can be turned off again.
    if (sim?.inactiveSession && !isControl) {
      log(`${req.method} ${pathname} → 503 E_INACTIVE_SESSION (simulated)`);
      sendError(res, 503, 'E_INACTIVE_SESSION', 'this service does not belong to the active desktop session');
      return;
    }

    const cors = corsHeaders(req, allowedOrigins);

    if (checkHost && !isLoopbackHost(req.headers.host)) {
      log(`rejected request with non-loopback Host: ${req.headers.host}`);
      sendError(res, 403, 'HOST_NOT_ALLOWED', 'this service only answers requests addressed to loopback', cors);
      return;
    }

    // Preflights pass for every path, /update included: POST /update carries a JSON body, so the
    // browser always preflights it, and Chrome adds the Private Network Access question on top.
    if (req.method === 'OPTIONS') {
      handlePreflight(req, res, allowedOrigins);
      return;
    }

    log(`${req.method} ${pathname}`);

    if (isControl) {
      handleSimControl(req, res, pathname, control, cors).catch((err) =>
        sendError(res, 500, 'SIM_CONTROL_ERROR', err.message, cors)
      );
      return;
    }

    // An older local server simply has no OTA routes; the Scan tab treats that 404 as "fall back to
    // the manual download" (spec §5.3). `noUpdateRoute` reproduces it.
    const ota = sim?.noUpdateRoute ? null : getOta();

    if (ota && pathname === `${API_PREFIX}/update`) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', { ...cors, Allow: 'POST, OPTIONS' });
        return;
      }
      handleUpdate(req, res, ota, cors, log).catch((err) => sendError(res, 500, 'E_UNKNOWN', err.message, cors));
      return;
    }

    if (ota && pathname === `${API_PREFIX}/update/status`) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', { ...cors, Allow: 'GET, OPTIONS' });
        return;
      }
      sendJson(res, 200, ota.getStatus(), cors);
      return;
    }

    if (pathname === `${API_PREFIX}/status`) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', { ...cors, Allow: 'GET, OPTIONS' });
        return;
      }
      handleStatus(res, service, getOta(), cors).catch((err) =>
        sendError(res, 500, 'STATUS_ERROR', err.message, cors)
      );
      return;
    }

    if (pathname === `${API_PREFIX}/start`) {
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST', { ...cors, Allow: 'POST, OPTIONS' });
        return;
      }
      handleStart(req, res, service, cors, log).catch((err) =>
        sendError(res, 500, 'START_ERROR', err.message, cors)
      );
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `no route for ${req.method} ${pathname}`, cors);
  };
}
