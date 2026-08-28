// Reads and validates required env vars. Exits(1) with a clear message if any missing.
// Env is expected to be loaded via `node --env-file=.env` (Node 20.6+); no dotenv dependency.

import { fail } from './log.js';
import { DEFAULT_SCAN_MODE, DEFAULT_SCAN_FILE_TYPES } from './scan-report.js';

const REQUIRED = ['SCANPRO_BASE_URL', 'SCANPRO_API_KEY', 'SCANPRO_CLIENT_ID', 'SCANPRO_CLIENT_SECRET'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || String(env[k]).trim() === '');

  if (missing.length > 0) {
    fail(`Missing required environment variable(s): ${missing.join(', ')}`);
    if (missing.includes('SCANPRO_API_KEY')) {
      // Newly required by the move to the SprintRay API gateway, so an .env written before it
      // has every other value. Name the exact line to add rather than only the variable.
      fail('SCANPRO_API_KEY is the SprintRay API-gateway key, sent as x-api-key on every call');
      fail('to SprintRay. Add this line to your .env (SprintRay issues the key for your');
      fail('integration; it is not the client id or the client secret):');
      fail('  SCANPRO_API_KEY=your-gateway-api-key');
    }
    fail('A full template is in .env.example. Run with:');
    fail('  node --env-file=.env src/index.js ...');
    process.exit(1);
  }

  return {
    // Normalize to an origin: strip a trailing slash and a trailing /api. Gateway paths do
    // NOT carry an /api prefix, so the base must be the origin only.
    baseUrl: normalizeBaseUrl(env.SCANPRO_BASE_URL),
    // Sent as x-api-key on every SprintRay call; the gateway rejects with 403 without it.
    apiKey: String(env.SCANPRO_API_KEY).trim(),
    clientId: String(env.SCANPRO_CLIENT_ID).trim(),
    clientSecret: String(env.SCANPRO_CLIENT_SECRET).trim(),
    // The integration's own scan vocabulary — not SprintRay enums. These names are what
    // SprintRay registers for the integration on first sight and an admin maps once, so they
    // belong to the deployment rather than to a run. Optional: the defaults are what this
    // example calls its own scan types and mode.
    scanMode: String(env.SCANPRO_SCAN_MODE ?? '').trim() || DEFAULT_SCAN_MODE,
    scanFileTypes: {
      upper: String(env.SCANPRO_SCAN_FILE_TYPE_UPPER ?? '').trim() || DEFAULT_SCAN_FILE_TYPES.upper,
      lower: String(env.SCANPRO_SCAN_FILE_TYPE_LOWER ?? '').trim() || DEFAULT_SCAN_FILE_TYPES.lower,
    },
    // How many file uploads run at once. A run has at most two scans, so this is really the
    // ceiling for the mesh batch the finish call unlocks — up to 34 PUTs. Optional: unset
    // falls back to DEFAULT_UPLOAD_CONCURRENCY, and a non-positive value is ignored.
    uploadConcurrency: String(env.SCANPRO_UPLOAD_CONCURRENCY ?? '').trim() || undefined,
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
