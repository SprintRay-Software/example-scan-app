// The two endpoints of the ScanPro local HTTP service, exactly as specified in
// ScanPro_Local_HTTP_Server.md §3:
//
//   GET  /scanpro/v1/status   -> { service, installed, running, version }
//   POST /scanpro/v1/start    -> { argument: <base64 JSON> } -> { status, started }
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
async function handleStatus(res, service, cors) {
  const status = await service.getStatus();
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
 */
export function createRequestHandler({ service, allowedOrigins = null, checkHost = true, log = () => {} }) {
  return function handleRequest(req, res) {
    const cors = corsHeaders(req, allowedOrigins);

    if (checkHost && !isLoopbackHost(req.headers.host)) {
      log(`rejected request with non-loopback Host: ${req.headers.host}`);
      sendError(res, 403, 'HOST_NOT_ALLOWED', 'this service only answers requests addressed to loopback', cors);
      return;
    }

    if (req.method === 'OPTIONS') {
      handlePreflight(req, res, allowedOrigins);
      return;
    }

    // req.url is a path here (an origin-form request target), so any base works.
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    log(`${req.method} ${pathname}`);

    if (pathname === `${API_PREFIX}/status`) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use GET', { ...cors, Allow: 'GET, OPTIONS' });
        return;
      }
      handleStatus(res, service, cors).catch((err) =>
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
