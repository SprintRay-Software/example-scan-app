// Simulator switches for the OTA part of the local server.
//
// NONE of this is in the contract. A real SprintRayScanService has no such knobs; they exist so
// DS can drive the Scan tab through every branch of ScanPro_OTA_API.md on demand — a failure code
// at a chosen phase, a progress bar that stops moving, a service that comes back on another port,
// an old service with no /update at all — without waiting for real networks and installers to
// misbehave.
//
// One mutable object holds them. It outlives a simulated service restart (it belongs to the
// simulator, not to the "process" being replaced), and it is changed from three places through the
// one `applySimPatch` below: CLI flags / env at startup, the Electron developer skin's OTA panel,
// and the opt-in `/scanpro/v1/_sim` control route.

// The contract's `phase = failed` codes that can occur for `target = app`. The firmware-only ones
// (E_ALREADY_UP_TO_DATE as a status code, E_SCANNER_*, E_FIRMWARE_FLASH_FAILED) are left out:
// firmware OTA is not simulated.
export const FAILURE_CODES = Object.freeze([
  'E_DOWNLOAD_FAILED',
  'E_INSUFFICIENT_DISK_SPACE',
  'E_VERIFY_FAILED',
  'E_INSTALL_FAILED',
  'E_USER_CANCELLED',
  'E_TIMEOUT',
  'E_UNKNOWN',
]);

// Phases a failure can be forced at. `restarting` means "the new service comes back and finds the
// install did not take" — the only way the contract's restarting phase ends in failure.
export const FAULT_PHASES = Object.freeze(['downloading', 'verifying', 'installing', 'restarting']);
// Phases progress can be frozen in. Not `restarting`: the service is down then, so there is no
// one to answer a poll and nothing to freeze — lengthen the restart with restartDelayMs instead.
export const STALL_PHASES = Object.freeze(['downloading', 'verifying', 'installing']);

// A code that describes a precondition, not something that breaks halfway: forced while
// downloading it fires at 0 % rather than mid-way, which is where the real service would notice it.
const PRECONDITION_CODES = new Set(['E_INSUFFICIENT_DISK_SPACE']);

export const DOWNLOAD_MODES = Object.freeze(['simulated', 'real']);

// The real ScanOS installer is ~2.1 GB; the simulated download pretends to fetch that much, at a
// speed that keeps a demo watchable (≈ 35 s) while still crossing every percent.
export const DEFAULT_SIMULATED_SIZE_BYTES = 2_254_857_830;
export const DEFAULT_SIMULATED_BYTES_PER_SEC = 64 * 1024 * 1024;

export function defaultSim() {
  return {
    downloadMode: 'simulated',
    simulatedSizeBytes: DEFAULT_SIMULATED_SIZE_BYTES,
    // Simulated: the pretend speed. Real: a throttle (0 = as fast as the network goes).
    downloadBytesPerSec: DEFAULT_SIMULATED_BYTES_PER_SEC,
    verifyMs: 1500,
    installMs: 4000,
    // How long `restarting` is visible before the server goes down. The Scan tab polls every 2 s,
    // so anything shorter could slip between two polls and the phase would never be seen.
    restartingHoldMs: 2500,
    // How long the service stays down while it is "replaced".
    restartDelayMs: 5000,
    // Come back from the OTA restart on another port in the range (the next free one up).
    portSwitch: false,
    // Or on exactly this port. Wins over portSwitch.
    restartPort: null,
    // Authenticode check of the app installer fails → E_VERIFY_FAILED at the install's verifying.
    signatureInvalid: false,
    // The installer "succeeds" but the new service still reports the old version → E_INSTALL_FAILED.
    versionMismatch: false,
    // The installed ScanPro is older than the first OTA-capable version → E_UPDATE_UNSUPPORTED.
    unsupported: false,
    // An older local server with no OTA routes at all: /update and /update/status answer 404.
    noUpdateRoute: false,
    // The server belongs to another desktop session → every route, OPTIONS too, answers 503.
    inactiveSession: false,
    // Accept http:// package URLs (the contract requires https://) — for a local package server.
    allowHttpPackageUrl: false,
    // { action: 'download'|'install'|null, phase, code, atPercent: number|null, remaining: number|null }
    fail: null,
    // { action, phase, untilMs: number|null } — progress freezes in that phase; null untilMs = until cleared
    stall: null,
    // What /status reports about ScanPro, over the host's own answer. null = leave it to the host.
    scanPro: { installed: null, running: null },
  };
}

// "[download.|install.]phase" → { action, phase }
function parsePhaseRef(text, allowed, what) {
  const m = /^(?:(download|install)\.)?([a-z_]+)$/.exec(String(text).trim());
  if (!m || !allowed.includes(m[2])) {
    throw new Error(`${what}: expected [download.|install.]<phase> with phase one of ${allowed.join(', ')}; got "${text}"`);
  }
  return { action: m[1] ?? null, phase: m[2] };
}

/**
 * Parse a failure spec: `[download.|install.]<phase>:<E_CODE>[@<percent>]`.
 * e.g. `downloading:E_DOWNLOAD_FAILED@30`, `install.verifying:E_VERIFY_FAILED`.
 */
export function parseFailSpec(spec, { once = false } = {}) {
  if (spec === null || spec === undefined || spec === '' || spec === false) return null;
  if (typeof spec === 'object') return normalizeFail(spec);
  const m = /^([a-z._]+):([A-Z_]+)(?:@(\d{1,3}))?$/.exec(String(spec).trim());
  if (!m) throw new Error(`fail: expected [download.|install.]<phase>:<E_CODE>[@percent]; got "${spec}"`);
  const { action, phase } = parsePhaseRef(m[1], FAULT_PHASES, 'fail');
  return normalizeFail({ action, phase, code: m[2], atPercent: m[3] === undefined ? null : Number(m[3]), remaining: once ? 1 : null });
}

function normalizeFail(f) {
  const { action, phase } = parsePhaseRef(`${f.action ? `${f.action}.` : ''}${f.phase}`, FAULT_PHASES, 'fail');
  if (!FAILURE_CODES.includes(f.code)) {
    throw new Error(`fail: unknown failure code "${f.code}" — one of ${FAILURE_CODES.join(', ')}`);
  }
  const atPercent = f.atPercent === null || f.atPercent === undefined ? null : Math.max(0, Math.min(100, Number(f.atPercent)));
  const remaining = f.remaining === null || f.remaining === undefined ? null : Math.max(0, Number(f.remaining));
  return { action, phase, code: f.code, atPercent, remaining };
}

/** Parse a stall spec: `[download.|install.]<phase>[:<seconds>]`. */
export function parseStallSpec(spec) {
  if (spec === null || spec === undefined || spec === '' || spec === false) return null;
  if (typeof spec === 'object') {
    const { action, phase } = parsePhaseRef(`${spec.action ? `${spec.action}.` : ''}${spec.phase}`, STALL_PHASES, 'stall');
    return { action, phase, untilMs: spec.untilMs ?? null };
  }
  const [ref, seconds] = String(spec).trim().split(':');
  const { action, phase } = parsePhaseRef(ref, STALL_PHASES, 'stall');
  if (seconds !== undefined && !/^\d+$/.test(seconds)) throw new Error(`stall: seconds must be an integer; got "${seconds}"`);
  return { action, phase, untilMs: seconds === undefined ? null : Number(seconds) * 1000 };
}

/** The percent a forced failure fires at in a progress phase. */
export function failPercent(fail) {
  if (fail.atPercent !== null && fail.atPercent !== undefined) return fail.atPercent;
  return PRECONDITION_CODES.has(fail.code) ? 0 : 40;
}

/** Does a fault apply to this step and phase? */
export function faultMatches(fault, action, phase) {
  return Boolean(fault) && fault.phase === phase && (!fault.action || fault.action === action);
}

const BOOL_KEYS = ['portSwitch', 'signatureInvalid', 'versionMismatch', 'unsupported', 'noUpdateRoute', 'inactiveSession', 'allowHttpPackageUrl'];
const INT_KEYS = ['simulatedSizeBytes', 'downloadBytesPerSec', 'verifyMs', 'installMs', 'restartingHoldMs', 'restartDelayMs'];

/**
 * Apply a partial update to the switches, validating every key. Unknown keys are refused so a
 * typo in a control-route call fails loudly instead of silently doing nothing.
 * @returns {object} the same `sim` object, changed
 */
export function applySimPatch(sim, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('expected a JSON object of switches');
  const next = { ...sim, scanPro: { ...sim.scanPro } };
  for (const [key, value] of Object.entries(patch)) {
    if (BOOL_KEYS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
      next[key] = value;
    } else if (INT_KEYS.includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
      next[key] = Math.round(n);
    } else if (key === 'downloadMode') {
      if (!DOWNLOAD_MODES.includes(value)) throw new Error(`downloadMode must be one of ${DOWNLOAD_MODES.join(', ')}`);
      next.downloadMode = value;
    } else if (key === 'restartPort') {
      if (value !== null && !(Number.isInteger(value) && value > 0 && value < 65536)) throw new Error('restartPort must be a port number or null');
      next.restartPort = value;
    } else if (key === 'fail') {
      next.fail = parseFailSpec(value);
    } else if (key === 'failOnce') {
      next.fail = parseFailSpec(value, { once: true });
    } else if (key === 'stall') {
      next.stall = parseStallSpec(value);
    } else if (key === 'scanPro') {
      if (!value || typeof value !== 'object') throw new Error('scanPro must be an object { installed?, running? }');
      for (const [k, v] of Object.entries(value)) {
        if (!['installed', 'running'].includes(k)) throw new Error(`scanPro.${k} is not a switch (installed, running)`);
        if (v !== null && typeof v !== 'boolean') throw new Error(`scanPro.${k} must be true, false or null`);
        next.scanPro[k] = v;
      }
    } else {
      throw new Error(`unknown simulator switch "${key}"`);
    }
  }
  Object.assign(sim, next);
  return sim;
}

/** Human-readable one-liner of the switches that differ from the defaults, for logs. */
export function describeSim(sim) {
  const d = defaultSim();
  const parts = [];
  for (const key of Object.keys(d)) {
    if (key === 'scanPro') {
      for (const [k, v] of Object.entries(sim.scanPro)) if (v !== null) parts.push(`scanPro.${k}=${v}`);
    } else if (key === 'fail' && sim.fail) {
      const f = sim.fail;
      parts.push(`fail=${f.action ? `${f.action}.` : ''}${f.phase}:${f.code}@${failPercent(f)}${f.remaining !== null ? ` (x${f.remaining})` : ''}`);
    } else if (key === 'stall' && sim.stall) {
      const s = sim.stall;
      parts.push(`stall=${s.action ? `${s.action}.` : ''}${s.phase}${s.untilMs !== null ? `:${s.untilMs / 1000}s` : ''}`);
    } else if (JSON.stringify(sim[key]) !== JSON.stringify(d[key])) {
      parts.push(`${key}=${sim[key]}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'defaults';
}
