// Device-login token exchange + refresh against the Design-Service backend.
// Uses global fetch (Node >=18). No dependencies. Every call is fully logged via http.js.

import { step, ok, info } from './log.js';
import { logRequest, logResponse } from './http.js';

// Join a base URL and a path safely (path may or may not have a leading slash).
function joinUrl(baseUrl, path) {
  const b = String(baseUrl).replace(/\/+$/, '');
  const p = String(path).replace(/^\/+/, '');
  return `${b}/${p}`;
}

// Map an error status + body to a clear, actionable message.
function describeError(status, context, body) {
  const snippet = body ? ` — ${body.slice(0, 800)}` : '';
  switch (status) {
    case 400:
      return `${context}: 400 invalid_grant — the code is missing, expired, or already used${snippet}`;
    case 401:
      return `${context}: 401 unauthorized — bad client credentials (clientId/clientSecret)${snippet}`;
    case 502:
      return `${context}: 502 bad gateway — upstream identity provider token error${snippet}`;
    default:
      return `${context}: unexpected HTTP ${status}${snippet}`;
  }
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context}: response body was not valid JSON`);
  }
}

function assertTokens(tokens, context) {
  if (!tokens || typeof tokens !== 'object' || !tokens.access_token) {
    throw new Error(`${context}: response did not include an access_token`);
  }
  return tokens;
}

/**
 * Exchange a device-login code for tokens.
 * POST {baseUrl}{tokenPath}  body { code, clientId, clientSecret }
 * tokenPath comes from the launch payload (a path such as /api/integration/device-login-token).
 */
export async function exchangeCodeForTokens({ baseUrl, tokenPath, code, clientId, clientSecret }) {
  const url = joinUrl(baseUrl, tokenPath);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const body = { code, clientId, clientSecret };

  step('Exchanging device-login code for tokens');
  logRequest({ label: 'token exchange', method: 'POST', url, headers, body });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`token exchange: network error contacting ${url} — ${err.message}`);
  }

  const text = await logResponse('token exchange', res);
  if (!res.ok) throw new Error(describeError(res.status, 'token exchange', text));

  const tokens = assertTokens(parseJson(text, 'token exchange'), 'token exchange');
  ok(`Token exchange succeeded (token_type=${tokens.token_type ?? 'n/a'}, expires_in=${tokens.expires_in ?? 'n/a'})`);
  return tokens;
}

/**
 * Refresh tokens (optional demo path).
 * POST {baseUrl}/api/integration/device-login-token/refresh  body { refreshToken, clientId, clientSecret }
 */
export async function refreshTokens({ baseUrl, refreshToken, clientId, clientSecret }) {
  const url = joinUrl(baseUrl, 'api/integration/device-login-token/refresh');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const body = { refreshToken, clientId, clientSecret };

  step('Refreshing tokens');
  if (!refreshToken) throw new Error('refresh: no refresh_token available to refresh');
  logRequest({ label: 'token refresh', method: 'POST', url, headers, body });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`refresh: network error contacting ${url} — ${err.message}`);
  }

  const text = await logResponse('token refresh', res);
  if (!res.ok) throw new Error(describeError(res.status, 'refresh', text));

  const tokens = assertTokens(parseJson(text, 'refresh'), 'refresh');
  ok('Token refresh succeeded');
  info(`new access_token expires_in=${tokens.expires_in ?? 'n/a'}`);
  return tokens;
}
