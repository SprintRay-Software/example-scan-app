// Instrumented networking. Every backend/S3 call goes through here so the reporter
// sees the complete request (method, URL, headers, body) and the complete response
// (status, headers, body) plus the wall-clock duration — nothing is hidden. Uses
// global fetch (Node/Electron >= 18). No dependencies.

let txCounter = 0;
// Stable, monotonic id so a UI can pair the httpStart with its httpEnd.
function nextTxId() {
  txCounter += 1;
  return `tx-${txCounter}`;
}

// Join a base URL and a path safely (path may or may not have a leading slash).
export function joinUrl(baseUrl, path) {
  const b = String(baseUrl).replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  return `${b}/${p}`;
}

function headersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

/**
 * A JSON-ish request with a printable body (or none). Reads the response body as text
 * and reports the full transaction. Returns { res, text } — the body is already read,
 * so callers must use the returned text (a body reads once).
 * @param {import('./reporter.js').createReporter} reporter
 * @param {{ label: string, method: string, url: string, headers?: object, body?: any }} opts
 */
export async function httpJson(reporter, { label, method, url, headers = {}, body }) {
  const id = nextTxId();
  const printableBody =
    body === undefined || body === null
      ? undefined
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);

  reporter.httpStart({ id, label, method, url, headers, body: printableBody });

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : printableBody,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    reporter.httpError({ id, label, message: err.message, durationMs });
    throw new Error(`${label}: network error contacting ${url} — ${err.message}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    text = `(could not read body: ${err.message})`;
  }
  const durationMs = Date.now() - startedAt;

  reporter.httpEnd({
    id,
    label,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
    body: text,
    durationMs,
  });

  return { res, text };
}

/**
 * PUT raw bytes with a streamed body so upload progress can be reported. The request
 * body is non-printable, so it is reported as a note (`<binary N bytes>`). No auth
 * header — the presigned URL is self-authorizing.
 * @param {import('./reporter.js').createReporter} reporter
 * @param {{ label: string, url: string, headers?: object, bytes: Buffer|Uint8Array, onProgress?: (sent:number,total:number)=>void }} opts
 */
export async function httpPutStream(reporter, { label, url, headers = {}, bytes, onProgress }) {
  const id = nextTxId();
  const total = bytes.length;
  const fullHeaders = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), ...headers };

  reporter.httpStart({
    id,
    label,
    method: 'PUT',
    url,
    headers: fullHeaders,
    bodyNote: `<binary ${total} bytes> (streamed)`,
  });

  let sent = 0;
  const CHUNK = 256 * 1024;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const end = Math.min(sent + CHUNK, total);
      controller.enqueue(bytes.subarray(sent, end));
      sent = end;
      if (onProgress) onProgress(sent, total);
    },
  });

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'PUT', headers: fullHeaders, body: stream, duplex: 'half' });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    reporter.httpError({ id, label, message: err.message, durationMs });
    throw new Error(`${label}: network error PUTting to ${url} — ${err.message}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    text = `(could not read body: ${err.message})`;
  }
  const durationMs = Date.now() - startedAt;

  reporter.httpEnd({
    id,
    label,
    ok: res.status === 200 || res.status === 204,
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
    body: text,
    durationMs,
  });

  return { res, text };
}
