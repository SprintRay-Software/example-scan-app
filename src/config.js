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

// ---------------------------------------------------------------------------
// Local HTTP service (src/local-server) — all optional, all with working defaults, so the
// service comes up on a machine with no .env at all. Unlike the flow config above this never
// exits: a missing telemetry key only means the port-exhaustion event is not reported.
// ---------------------------------------------------------------------------

function boolEnv(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function intEnv(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * Parse the local-service settings out of an env-like object.
 * @param {Record<string, string|undefined>} env
 * @param {{ appVersion?: string, installPath?: string, stateDir?: string }} [defaults]
 */
export function loadLocalServerConfig(env = process.env, defaults = {}) {
  const origins = String(env.SCANPRO_LOCAL_SERVER_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    enabled: boolEnv(env.SCANPRO_LOCAL_SERVER, true),
    portRangeStart: intEnv(env.SCANPRO_LOCAL_SERVER_PORT_START, 29083),
    portRangeEnd: intEnv(env.SCANPRO_LOCAL_SERVER_PORT_END, 29183),
    // Empty = echo whatever Origin asks (open, and the easiest to test against). A non-empty
    // list is an allowlist: any other origin gets no Access-Control-Allow-Origin back.
    allowedOrigins: origins.length > 0 ? origins : null,
    checkHost: boolEnv(env.SCANPRO_LOCAL_SERVER_CHECK_HOST, true),
    // Version reported by /status. Real ScanPro reports its own; this app reports its own too.
    reportedVersion: String(env.SCANPRO_REPORTED_VERSION ?? defaults.appVersion ?? '0.0.0').trim(),
    stateDir: env.SCANPRO_STATE_DIR || defaults.stateDir,
    telemetry: {
      // No default: SprintRay issues the endpoint and the key per environment. Unset means
      // the port-exhaustion event is logged locally and not sent.
      url: String(env.SCANPRO_TELEMETRY_URL ?? '').trim(),
      apiKey: String(env.SCANPRO_TELEMETRY_API_KEY ?? '').trim(),
      appVersion: String(env.SCANPRO_REPORTED_VERSION ?? defaults.appVersion ?? '0.0.0').trim(),
      installPath: String(env.SCANPRO_INSTALL_PATH ?? defaults.installPath ?? process.cwd()).trim(),
      build: String(env.SCANPRO_BUILD ?? '').trim() || undefined,
      channel: String(env.SCANPRO_TELEMETRY_CHANNEL ?? 'dev').trim() || undefined,
    },
  };
}
