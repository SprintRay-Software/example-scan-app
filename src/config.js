// Reads and validates required env vars. Exits(1) with a clear message if any missing.
// Env is expected to be loaded via `node --env-file=.env` (Node 20.6+); no dotenv dependency.

import { fail } from './log.js';

const REQUIRED = ['SCANPRO_BASE_URL', 'SCANPRO_CLIENT_ID', 'SCANPRO_CLIENT_SECRET'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || String(env[k]).trim() === '');

  if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`);
    fail('Copy .env.example to .env and fill in the values, then run:');
    fail('  node --env-file=.env src/index.js ...');
    process.exit(1);
  }

  return {
    // Normalize to an origin: strip a trailing slash and a trailing /api — API paths
    // already include /api, so the base must be the origin only (avoids a doubled /api).
    baseUrl: normalizeBaseUrl(env.SCANPRO_BASE_URL),
    clientId: String(env.SCANPRO_CLIENT_ID).trim(),
    clientSecret: String(env.SCANPRO_CLIENT_SECRET).trim(),
  };
}

export function normalizeBaseUrl(value) {
  return String(value)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}
