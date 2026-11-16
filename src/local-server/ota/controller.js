// The OTA state machine of the local server — ScanPro_OTA_API.md §4, Allied Star's side of it.
//
//   POST /scanpro/v1/update { action, target, package }   → handlePost()
//   GET  /scanpro/v1/update/status                         → getStatus()
//
// download   downloading ─▶ verifying ─▶ downloaded                     (failed on the way)
// install    verifying ─▶ installing ─▶ restarting ─▶ [service replaced] ─▶ completed | failed
//
// Only `target = app` is simulated. Firmware OTA is out of scope for this simulator (Weimin,
// 2026-11-16): a `target = firmware` request is valid per the contract but answers
// 400 E_UPDATE_UNSUPPORTED, the code a real service gives when it cannot do the update.
//
// One controller is one run of SprintRayScanService. Installing the app replaces that service, so
// at `restarting` this controller hands over to the host (`requestRestart`): the HTTP server goes
// down, and after a delay a NEW controller is built from what is on disk and `resume()`s — it
// compares the installed version with the persisted `toVersion`, exactly the check §4.5 asks the
// real new service to make. Nothing crosses the restart in memory except the simulator switches.
//
// The rules the code follows, all from the contract:
//   - one download or install at a time (§4.1) — the rest get E_UPDATE_IN_PROGRESS;
//   - a refused POST leaves the last status alone; an accepted one replaces it (§4.5 "until the next POST");
//   - one package per target, deleted after a successful install or a verify failure, kept after any
//     other install failure so the install can be retried as is (§4.4 "包的保留");
//   - telemetry on the install step only (§4.6).

import { isoWithOffset } from '../../telemetry.js';
import { OtaAborted, OtaFailure, OtaRequestError } from './errors.js';
import { md5File, realDownload, simulatedDownload, sleep } from './download.js';
import { failPercent, faultMatches } from './sim.js';
import { compareVersions } from './versions.js';

// `updating_firmware` is a contract phase too, but firmware is not simulated, so it never occurs.
export const ACTIVE_PHASES = new Set(['downloading', 'verifying', 'installing', 'restarting']);
const ACTIONS = ['download', 'install'];
const TARGETS = ['app', 'firmware'];
const MD5_RE = /^[0-9a-f]{32}$/i;
// Progress phases stall here, mid-bar, where a real stuck transfer would show — not at 0 %.
const STALL_PERCENT = 30;

// ---------------------------------------------------------------------------
// Request validation — everything §4.4 lists under E_INVALID_ARGUMENT
// ---------------------------------------------------------------------------
const invalid = (message) => new OtaRequestError(400, 'E_INVALID_ARGUMENT', message);

/**
 * @returns {{ action: string, target: string, pkg: { version: string, url: string, md5: string|null } }}
 * @throws {OtaRequestError} E_INVALID_ARGUMENT
 */
export function validateUpdateRequest(body, { allowHttp = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('the request body must be a JSON object');
  const { action, target } = body;
  if (!ACTIONS.includes(action)) throw invalid('`action` must be "download" or "install"');
  if (!TARGETS.includes(target)) throw invalid('`target` must be "app" or "firmware"');

  const p = body.package;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw invalid('`package` is required and must be an object');
  if (typeof p.version !== 'string' || p.version.trim() === '') throw invalid('`package.version` is required and must be a non-empty string');
  if (typeof p.url !== 'string' || p.url.trim() === '') throw invalid('`package.url` is required and must be a non-empty string');

  let url;
  try {
    url = new URL(p.url);
  } catch {
    throw invalid('`package.url` must be an absolute https:// URL');
  }
  const okScheme = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!okScheme) {
    throw invalid(
      allowHttp ? '`package.url` must be an absolute http(s):// URL' : '`package.url` must be an absolute https:// URL'
    );
  }

  if (p.md5 !== undefined && p.md5 !== null && !(typeof p.md5 === 'string' && MD5_RE.test(p.md5))) {
    throw invalid('`package.md5` must be 32 hexadecimal characters, or null / omitted');
  }

  return {
    action,
    target,
    // MD5 compares case-insensitively (§4.3), so it is kept lower-case from here on.
    pkg: { version: p.version, url: p.url, md5: p.md5 ? p.md5.toLowerCase() : null },
  };
}

/** The install's package must be the download's package: same version, url and md5 (§4.3/§4.4). */
export function samePackage(a, b) {
  return Boolean(a && b) && a.version === b.version && a.url === b.url && (a.md5 ?? null) === (b.md5 ?? null);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {ReturnType<import('./store.js').openOtaStore>} opts.store
 * @param {object} opts.sim  live simulator switches (see sim.js); shared, may change at any time
 * @param {{ getStatus: () => object|Promise<object> }} opts.scanPro  the host's ScanPro model
 * @param {(opts: { delayMs: number, portSwitch: boolean, restartPort: number|null }) => void} [opts.requestRestart]
 * @param {(eventName: string, eventData: object, opts?: object) => void} [opts.emitTelemetry]
 * @param {(msg: string) => void} [opts.log]
 */
export function createOtaController({
  store,
  sim,
  scanPro,
  requestRestart,
  emitTelemetry = () => {},
  log = () => {},
}) {
  const abort = new AbortController();
  const signal = abort.signal;
  const serviceStartedAt = Date.now();
  let job = null;

  const data = () => store.data;

  // ---- what this machine has installed ------------------------------------------------------
  function effectiveScanPro(base = {}) {
    return {
      installed: sim.scanPro.installed ?? Boolean(base.installed),
      running: sim.scanPro.running ?? Boolean(base.running),
      // An OTA-installed version wins over the configured one: after a simulated update, /status
      // has to report the new version or the Scan tab's success check (§5 "完成") can never pass.
      version: data().installed.app ?? (base.version ? String(base.version) : null),
    };
  }

  // ---- status ---------------------------------------------------------------------------------
  // `updatedAt` moves only when something visible changes — it is what the Scan tab uses to tell
  // "slow" from "stuck" (§5 "卡住判断"), so a stall must leave it frozen.
  function setStatus(patch) {
    Object.assign(data().status, patch, { updatedAt: isoWithOffset() });
    store.save();
  }

  function replaceStatus(status, run) {
    const now = isoWithOffset();
    data().status = { error: null, percent: null, ...status, startedAt: now, updatedAt: now };
    data().run = run;
    store.save();
  }

  // ---- fault injection ------------------------------------------------------------------------
  function consumeFault() {
    const f = sim.fail;
    if (f.remaining !== null) {
      f.remaining -= 1;
      if (f.remaining <= 0) sim.fail = null;
    }
    return f;
  }

  function throwIfForced(action, phase, percent) {
    const f = sim.fail;
    if (!faultMatches(f, action, phase)) return;
    if (percent !== null && percent < failPercent(f)) return;
    consumeFault();
    throw new OtaFailure(f.code, `simulated failure: ${f.code} forced at ${action}/${phase} (simulator switch, not a real fault)`);
  }

  async function maybeStall(action, phase, percent) {
    if (!faultMatches(sim.stall, action, phase)) return;
    if (percent !== null && percent < STALL_PERCENT) return;
    const untilMs = sim.stall.untilMs ?? null;
    log(`OTA: stalling at ${action}/${phase}${untilMs !== null ? ` for ${untilMs / 1000}s` : ' until the stall switch is cleared'}`);
    const started = Date.now();
    while (faultMatches(sim.stall, action, phase)) {
      if (untilMs !== null && Date.now() - started >= untilMs) {
        sim.stall = null; // a timed stall happens once
        break;
      }
      await sleep(200, signal);
    }
    log(`OTA: resuming ${action}/${phase}`);
  }

  // Every progress tick passes through here: the place faults are injected and progress recorded.
  async function checkpoint(action, phase, percent) {
    if (signal.aborted) throw new OtaAborted();
    throwIfForced(action, phase, percent);
    const st = data().status;
    if (st.phase !== phase || st.percent !== percent) setStatus({ phase, percent });
    await maybeStall(action, phase, percent);
  }

  // A phase with no measurable progress (verifying, installing): it lasts `ms`, and a fault or a
  // stall lands halfway through it.
  async function timedPhase(action, phase, ms) {
    if (data().status.phase !== phase) setStatus({ phase, percent: null });
    await sleep(ms / 2, signal);
    await checkpoint(action, phase, null);
    await sleep(ms / 2, signal);
  }

  // ---- telemetry (§4.6) -------------------------------------------------------------------------
  function installTelemetry(result, errorCode) {
    const st = data().status;
    const eventData = {
      ...(st.fromVersion ? { fromVersion: st.fromVersion } : {}),
      toVersion: st.toVersion,
      durationMs: Math.max(0, Date.now() - (data().run?.installStartedAtMs ?? Date.now())),
      result,
      ...(errorCode ? { errorCode } : {}),
      trigger: 'sprintray',
    };
    emitTelemetry('app.updated', eventData, {
      severity: result === 'success' ? 'info' : 'error',
      appVersion: effectiveScanPro().version ?? undefined,
    });
  }

  // ---- failure --------------------------------------------------------------------------------
  function failStep(err, { action, target }) {
    if (err instanceof OtaAborted || signal.aborted) return; // the "process" is gone; persist nothing
    const failure = err instanceof OtaFailure ? err : new OtaFailure('E_UNKNOWN', err?.message ?? String(err));
    // A failed download leaves nothing worth keeping; an install keeps its package for a retry
    // unless the package itself is what failed verification.
    if (action === 'download' || failure.code === 'E_VERIFY_FAILED') store.deletePackage(target);
    setStatus({ phase: 'failed', error: { code: failure.code, message: failure.message } });
    log(`OTA: ${action} ${target} failed — ${failure.code}: ${failure.message}`);
    if (action === 'install') installTelemetry('failed', failure.code);
  }

  // ---- download -------------------------------------------------------------------------------
  async function runDownload({ target, pkg }) {
    const action = 'download';
    try {
      store.ensureTargetDir(target);
      const dest = store.packagePath(target, pkg.url);
      const cp = (percent) => checkpoint(action, 'downloading', percent);
      const result =
        sim.downloadMode === 'real'
          ? await realDownload({ url: pkg.url, dest, signal, bytesPerSec: sim.downloadBytesPerSec, checkpoint: cp })
          : await simulatedDownload({
              url: pkg.url,
              version: pkg.version,
              dest,
              signal,
              sizeBytes: sim.simulatedSizeBytes,
              bytesPerSec: sim.downloadBytesPerSec,
              checkpoint: cp,
            });

      await timedPhase(action, 'verifying', sim.verifyMs);
      // A simulated download has no real bytes to hash against `package.md5`; force
      // `download.verifying:E_VERIFY_FAILED` to exercise the mismatch path in that mode.
      if (pkg.md5 && !result.simulated && result.md5 !== pkg.md5) {
        throw new OtaFailure('E_VERIFY_FAILED', `MD5 mismatch: package.md5 is ${pkg.md5}, the downloaded file is ${result.md5}`);
      }

      data().packages[target] = {
        package: pkg,
        path: dest,
        size: result.size,
        md5: result.md5,
        simulated: Boolean(result.simulated),
        verifiedAt: isoWithOffset(),
      };
      setStatus({ phase: 'downloaded', percent: 100 });
      log(`OTA: downloaded ${target} ${pkg.version} (${result.simulated ? 'simulated' : `${result.size} bytes, md5 ${result.md5}`})`);
    } catch (err) {
      failStep(err, { action, target });
    }
  }

  // ---- install --------------------------------------------------------------------------------
  // The second verification of §4.3: the file must still be the one that was verified after the
  // download, still match `package.md5`, and carry the Alliedstar Authenticode signature.
  async function verifyForInstall(rec) {
    await timedPhase('install', 'verifying', sim.verifyMs);
    const actual = await md5File(rec.path);
    if (actual !== rec.md5) {
      throw new OtaFailure('E_VERIFY_FAILED', `the package changed on disk since it was downloaded (MD5 ${actual}, verified as ${rec.md5})`);
    }
    if (rec.package.md5 && !rec.simulated && actual !== rec.package.md5) {
      throw new OtaFailure('E_VERIFY_FAILED', `MD5 mismatch: package.md5 is ${rec.package.md5}, the file is ${actual}`);
    }
    if (sim.signatureInvalid) {
      throw new OtaFailure('E_VERIFY_FAILED', 'the installer is not signed with the Alliedstar Authenticode certificate (simulated)');
    }
  }

  async function runAppInstall({ pkg }) {
    const target = 'app';
    try {
      await verifyForInstall(store.downloadedPackage(target));
      await timedPhase('install', 'installing', sim.installMs);

      // The installer has run. Whether it took is decided by the NEW service after the restart,
      // from the version on disk — so a forced restarting failure or a version mismatch simply
      // leaves the old version in place, and resume() finds it there.
      let failAfterRestart = null;
      if (faultMatches(sim.fail, 'install', 'restarting')) {
        const f = consumeFault();
        failAfterRestart = { code: f.code, message: `simulated failure: ${f.code} forced at install/restarting (simulator switch, not a real fault)` };
      }
      if (!sim.versionMismatch && !failAfterRestart) data().installed.app = pkg.version;
      data().run.failAfterRestart = failAfterRestart;
      setStatus({ phase: 'restarting', percent: null });
      await sleep(sim.restartingHoldMs, signal);

      emitTelemetry(
        'app.exited',
        { reason: 'update', uptimeSec: Math.round((Date.now() - serviceStartedAt) / 1000) },
        { appVersion: data().status.fromVersion ?? undefined }
      );
      log(`OTA: installer finished; the service is being replaced (back in ${sim.restartDelayMs} ms${sim.restartPort ? ` on port ${sim.restartPort}` : sim.portSwitch ? ' on another port' : ''})`);

      if (requestRestart) {
        requestRestart({ delayMs: sim.restartDelayMs, portSwitch: sim.portSwitch, restartPort: sim.restartPort });
      } else {
        // No host to restart us (a bare controller in a test): settle in place, as a new service would.
        await sleep(sim.restartDelayMs, signal);
        await resume();
      }
    } catch (err) {
      failStep(err, { action: 'install', target });
    }
  }

  // ---- public ---------------------------------------------------------------------------------
  const busy = () => job !== null || ACTIVE_PHASES.has(data().status.phase);

  /**
   * POST /scanpro/v1/update.
   * @returns {Promise<{ action, target, phase, fromVersion, toVersion }>} the 200 body
   * @throws {OtaRequestError}
   */
  async function handlePost(body) {
    const { action, target, pkg } = validateUpdateRequest(body, { allowHttp: sim.allowHttpPackageUrl });
    const sp = effectiveScanPro(await scanPro.getStatus());

    // In the order of the contract's error table.
    if (!sp.installed) {
      throw new OtaRequestError(400, 'E_SCAN_NOT_INSTALLED', 'ScanPro is not installed, or its install path is invalid');
    }
    // Firmware OTA is not simulated. The contract's answer for "this service cannot do this
    // update" is E_UPDATE_UNSUPPORTED, which sends the Scan tab to its manual fallback.
    if (target === 'firmware') {
      throw new OtaRequestError(400, 'E_UPDATE_UNSUPPORTED', 'firmware OTA is not implemented by this simulator; only target "app" is simulated');
    }
    if (sim.unsupported) {
      throw new OtaRequestError(400, 'E_UPDATE_UNSUPPORTED', `the installed ScanPro (${sp.version ?? 'unknown version'}) does not support OTA updates`);
    }
    if (busy()) {
      const st = data().status;
      throw new OtaRequestError(400, 'E_UPDATE_IN_PROGRESS', `a ${st.action} of ${st.target} is already in progress (phase ${st.phase})`);
    }
    const cmp = compareVersions(sp.version, pkg.version);
    if (cmp !== null && cmp >= 0) {
      throw new OtaRequestError(400, 'E_ALREADY_UP_TO_DATE', `ScanPro ${sp.version} is already at or above ${pkg.version}`);
    }
    const fromVersion = sp.version;

    if (action === 'install') {
      const rec = store.downloadedPackage(target);
      if (!rec || !samePackage(rec.package, pkg)) {
        throw new OtaRequestError(
          400,
          'E_PACKAGE_NOT_DOWNLOADED',
          rec
            ? `the downloaded ${target} package is ${rec.package.version} (${rec.package.url}); download this package first`
            : `no downloaded ${target} package; download it first`
        );
      }
      if (sp.running) {
        throw new OtaRequestError(400, 'E_SCAN_ALREADY_RUNNING', 'ScanPro is running; close it before installing');
      }

      replaceStatus(
        { action, target, phase: 'verifying', fromVersion, toVersion: pkg.version },
        { action, target, package: pkg, installStartedAtMs: Date.now() }
      );
      log(`OTA: install ${target} ${fromVersion ?? '?'} → ${pkg.version}`);
      job = runAppInstall({ pkg }).finally(() => {
        job = null;
      });
      return { action, target, phase: 'verifying', fromVersion, toVersion: pkg.version };
    }

    // download
    const rec = store.downloadedPackage(target);
    if (rec && samePackage(rec.package, pkg)) {
      replaceStatus(
        { action, target, phase: 'downloaded', percent: 100, fromVersion, toVersion: pkg.version },
        { action, target, package: pkg }
      );
      log(`OTA: ${target} ${pkg.version} is already downloaded and verified`);
      return { action, target, phase: 'downloaded', fromVersion, toVersion: pkg.version };
    }
    // One package per target: a different one replaces it, and the old one goes first.
    if (rec) store.deletePackage(target);

    replaceStatus(
      { action, target, phase: 'downloading', percent: 0, fromVersion, toVersion: pkg.version },
      { action, target, package: pkg }
    );
    log(`OTA: download ${target} ${pkg.version} from ${pkg.url} (${sim.downloadMode})`);
    job = runDownload({ target, pkg }).finally(() => {
      job = null;
    });
    return { action, target, phase: 'downloading', fromVersion, toVersion: pkg.version };
  }

  /**
   * What a freshly started service does with the state it finds on disk (§4.5 "状态持久化").
   * A step that was still active when the previous service went away is settled here: an app
   * install by comparing versions, anything else as interrupted.
   */
  async function resume() {
    const st = data().status;
    if (!ACTIVE_PHASES.has(st.phase)) return;
    const run = data().run ?? {};

    if (st.action === 'download') {
      store.deletePackage(st.target);
      setStatus({ phase: 'failed', error: { code: 'E_DOWNLOAD_FAILED', message: 'the service stopped while the package was downloading; download it again' } });
      log('OTA: resumed an interrupted download as failed');
      return;
    }

    // An app install: the new service decides by the version it finds installed.
    const installed = effectiveScanPro(await scanPro.getStatus()).version;
    const cmp = compareVersions(installed, st.toVersion);
    const matches = cmp === null ? installed === st.toVersion : cmp === 0;
    if (st.phase === 'restarting' && !run.failAfterRestart && matches) {
      store.deletePackage('app');
      setStatus({ phase: 'completed', percent: 100 });
      log(`OTA: the new service reports ${installed} — install completed`);
      // "Success: when the new version first starts" (§4.6) — that is now.
      installTelemetry('success');
      return;
    }
    const error =
      run.failAfterRestart ??
      (st.phase === 'restarting'
        ? { code: 'E_INSTALL_FAILED', message: `the service restarted reporting version ${installed ?? 'null'}, expected ${st.toVersion}` }
        : { code: 'E_INSTALL_FAILED', message: `the service stopped during ${st.phase}; install again` });
    // The package survives anything but a verify failure, so the install can be retried as is.
    if (error.code === 'E_VERIFY_FAILED') store.deletePackage('app');
    setStatus({ phase: 'failed', error });
    log(`OTA: install did not take — ${error.code}: ${error.message}`);
    installTelemetry('failed', error.code);
  }

  return {
    handlePost,
    resume,
    /** GET /scanpro/v1/update/status */
    getStatus: () => ({ ...data().status, error: data().status.error ? { ...data().status.error } : null }),
    /** /status as the simulator reports it: OTA-installed version and switch overrides applied. */
    decorateStatus: (base) => ({ ...base, ...effectiveScanPro(base) }),
    busy,
    /** Everything the developer skin / control route shows. */
    snapshot: () => ({
      status: data().status,
      packages: data().packages,
      installed: { app: data().installed.app ?? null },
      busy: busy(),
    }),
    /** Back to a never-updated install. Abandons whatever step is running. */
    reset() {
      abort.abort();
      store.reset();
    },
    /** The simulated process goes away: running steps stop, nothing more is written. */
    dispose() {
      abort.abort();
    },
    /** Resolves once the running step (if any) has ended — for tests. */
    idle: () => job ?? Promise.resolve(),
  };
}
