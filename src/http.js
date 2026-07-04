// Full request/response logging for every backend call the simulator makes, so an
// integrator can see exactly what is sent and received on the wire. No dependencies.

import { info } from './log.js';

/**
 * Log a complete outgoing request: method, full URL (including any query string),
 * all headers, and the body.
 * @param {{ label: string, method: string, url: string, headers?: object, body?: any, bodyNote?: string }} r
 *   bodyNote — use instead of body for non-printable bodies (e.g. `<binary N bytes>`).
 */
export function logRequest({ label, method, url, headers = {}, body, bodyNote }) {
  info(`▶ REQUEST — ${label}`);
  info(`    ${method} ${url}`);
  info(`    headers: ${JSON.stringify(headers)}`);
  if (bodyNote !== undefined) info(`    body: ${bodyNote}`);
  else if (body === undefined || body === null) info(`    body: (none)`);
  else info(`    body: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
}

/**
 * Log a complete response: status, all headers, and the body. Consumes the body stream
 * and RETURNS the body text — the caller must use the returned text (a body reads once).
 * @returns {Promise<string>}
 */
export async function logResponse(label, res) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    text = `(could not read body: ${err.message})`;
  }
  info(`◀ RESPONSE — ${label}`);
  info(`    status: ${res.status} ${res.statusText}`);
  info(`    headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
  info(`    body: ${text === '' ? '(empty)' : text}`);
  return text;
}
