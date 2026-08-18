// Device-login token exchange + refresh against the Design-Service backend.
// Every call is fully reported (request + response) via the injected reporter, so the
// same instrumented flow drives both the CLI console and the Electron UI.

import { httpJson, joinUrl } from './core/net.js';

// Map an error status + body to a clear, actionable message.
function describeError(status, context, body) {
  const snippet = body ? ` — ${body.slice(0, 800)}` : '';
  switch (status) {
    case 400:
      return `${context}: 400 invalid_grant — the code is missing, expired, or already used${snippet}`;
    case 401:
      return `${context}: 401 unauthorized — bad client credentials (clientId/clientSecret)${snippet}`;
    case 403:
      return `${context}: 403 forbidden — missing or invalid x-api-key; the API gateway rejected the call before it reached SprintRay (check SCANPRO_API_KEY)${snippet}`;
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
 * POST {baseUrl}{tokenPath}  x-api-key: <apiKey>  body { code, clientId, clientSecret }
 * tokenPath comes from the launch payload (a path such as /integration/device-login-token).
 */
export async function exchangeCodeForTokens(reporter, { baseUrl, apiKey, tokenPath, code, clientId, clientSecret }) {
  const url = joinUrl(baseUrl, tokenPath);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey };
  const body = { code, clientId, clientSecret };

  reporter.phase('exchange', 'active', 'Exchanging device-login code for tokens');
  reporter.step('Exchanging device-login code for tokens');

  const { res, text } = await httpJson(reporter, { label: 'token exchange', method: 'POST', url, headers, body });

  if (!res.ok) {
    reporter.phase('exchange', 'error', `HTTP ${res.status}`);
    throw new Error(describeError(res.status, 'token exchange', text));
  }

  const tokens = assertTokens(parseJson(text, 'token exchange'), 'token exchange');
  reporter.ok(
    `Token exchange succeeded (token_type=${tokens.token_type ?? 'n/a'}, expires_in=${tokens.expires_in ?? 'n/a'})`
  );
  reporter.phase('exchange', 'done', `token_type=${tokens.token_type ?? 'n/a'}, expires_in=${tokens.expires_in ?? 'n/a'}`);
  return tokens;
}

/**
 * Refresh tokens (optional demo path).
 * POST {baseUrl}/integration/device-login-token/refresh  x-api-key: <apiKey>
 * body { refreshToken, clientId, clientSecret }
 */
export async function refreshTokens(reporter, { baseUrl, apiKey, refreshToken, clientId, clientSecret }) {
  const url = joinUrl(baseUrl, 'integration/device-login-token/refresh');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey };
  const body = { refreshToken, clientId, clientSecret };

  reporter.phase('refresh', 'active', 'Refreshing tokens');
  reporter.step('Refreshing tokens');
  if (!refreshToken) {
    reporter.phase('refresh', 'error', 'no refresh_token available');
    throw new Error('refresh: no refresh_token available to refresh');
  }

  const { res, text } = await httpJson(reporter, { label: 'token refresh', method: 'POST', url, headers, body });

  if (!res.ok) {
    reporter.phase('refresh', 'error', `HTTP ${res.status}`);
    throw new Error(describeError(res.status, 'refresh', text));
  }

  const tokens = assertTokens(parseJson(text, 'refresh'), 'refresh');
  reporter.ok('Token refresh succeeded');
  reporter.info(`new access_token expires_in=${tokens.expires_in ?? 'n/a'}`);
  reporter.phase('refresh', 'done', `expires_in=${tokens.expires_in ?? 'n/a'}`);
  return tokens;
}
