// The app-OTA simulation end to end over real HTTP: a local package server stands in for the CDN
// (no internet), the local service runs on a throw-away port range and state dir, and every
// assertion is made through the same routes the Scan tab calls.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applySimPatch, defaultSim, startScanProLocalServer } from '../src/local-server/index.js';
import { reportServiceEvent } from '../src/telemetry.js';

// A range of its own, well clear of 29083–29183, so a running app on this machine does not interfere.
const RANGE = { portRangeStart: 39291, portRangeEnd: 39340 };
const FROM = '1.0.44.9';
const TO = '1.0.45.0';

// ---------------------------------------------------------------------------
// The package source
// ---------------------------------------------------------------------------
const PACKAGE = randomBytes(256 * 1024);
const PACKAGE_MD5 = createHash('md5').update(PACKAGE).digest('hex');
let pkgServer;
let pkgBase;

before(async () => {
  pkgServer = createServer((req, res) => {
    if (req.url.startsWith('/ScanOS_')) {
      // In 16 KB pieces, like a CDN over a real link — one 256 KB write would arrive as a single
      // chunk on loopback and the progress would jump straight from 0 to 100.
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': PACKAGE.length });
      let offset = 0;
      res.on('error', () => {}); // the downloader may hang up mid-file (a killed service)
      const pump = () => {
        if (res.destroyed) return;
        if (offset >= PACKAGE.length) return res.end();
        res.write(PACKAGE.subarray(offset, offset + 16 * 1024));
        offset += 16 * 1024;
        setImmediate(pump);
      };
      pump();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => pkgServer.listen(0, '127.0.0.1', r));
  pkgBase = `http://127.0.0.1:${pkgServer.address().port}`;
});

after(() => pkgServer.close());

const pkg = (over = {}) => ({ version: TO, url: `${pkgBase}/ScanOS_${TO}.exe`, md5: PACKAGE_MD5, ...over });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
// Every switch goes through applySimPatch, the same validation the CLI, the panel and /_sim use.
function fastSim(over = {}) {
  return applySimPatch(defaultSim(), {
    downloadMode: 'real',
    allowHttpPackageUrl: true,
    downloadBytesPerSec: 0,
    verifyMs: 20,
    installMs: 40,
    restartingHoldMs: 100,
    restartDelayMs: 150,
    ...over,
  });
}

async function startService({ stateDir, sim = fastSim(), scanPro = {}, control = true } = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'ota-test-'));
  const events = [];
  const state = { installed: true, running: false, version: FROM, ...scanPro };
  const srv = await startScanProLocalServer({
    service: { getStatus: () => ({ ...state }), start: () => ({ started: true }) },
    options: { ...RANGE, stateDir: dir },
    ota: { sim, stateDir: dir, control, emitTelemetry: (name, data, opts) => events.push({ name, data, opts }) },
  });
  assert.equal(srv.ok, true);
  return { srv, dir, events, state, sim };
}

// node:http with no agent, i.e. a fresh connection per call. fetch() pools keep-alive sockets per
// origin, and since every test reuses the same port, a pooled socket from the previous (closed)
// server would surface as ECONNRESET — and a pooled socket is not what a restarted service sees anyway.
function rawRequest(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: `/scanpro/v1${path}`,
        agent: false,
        headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function call(srv, method, path, body, headers = {}) {
  const res = await rawRequest(srv.port, method, path, body, headers);
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null };
}

const post = (srv, body) => call(srv, 'POST', '/update', body);
const status = async (srv) => (await call(srv, 'GET', '/update/status')).body;

// Poll /update/status like the Scan tab does, riding out the restart window.
async function waitForPhase(srv, phases, timeoutMs = 5000) {
  const want = [].concat(phases);
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (srv.port) {
        last = await status(srv);
        if (want.includes(last.phase)) return last;
      }
    } catch {
      // the service is down while it is being replaced — expected, keep polling
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${want.join('|')}; last status ${JSON.stringify(last)}`);
}

const packageFiles = (dir) => {
  const d = join(dir, 'ota', 'packages', 'app');
  return existsSync(d) ? readdirSync(d) : [];
};

async function download(srv, p = pkg()) {
  const res = await post(srv, { action: 'download', target: 'app', package: p });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return waitForPhase(srv, ['downloaded', 'failed']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('happy path', () => {
  test('download → downloaded → install → completed, and /status reports the new version', async () => {
    const { srv, dir, events } = await startService();
    try {
      assert.deepEqual(await status(srv), {
        action: null, target: null, phase: 'idle', percent: null, fromVersion: null,
        toVersion: null, startedAt: null, updatedAt: null, error: null,
      });

      const dl = await post(srv, { action: 'download', target: 'app', package: pkg() });
      assert.deepEqual(dl.body, { action: 'download', target: 'app', phase: 'downloading', fromVersion: FROM, toVersion: TO });

      const done = await waitForPhase(srv, ['downloaded', 'failed']);
      assert.equal(done.phase, 'downloaded');
      assert.equal(done.percent, 100);
      assert.match(done.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
      assert.equal(packageFiles(dir).length, 1);

      const inst = await post(srv, { action: 'install', target: 'app', package: pkg() });
      assert.deepEqual(inst.body, { action: 'install', target: 'app', phase: 'verifying', fromVersion: FROM, toVersion: TO });

      await waitForPhase(srv, 'restarting');
      const completed = await waitForPhase(srv, ['completed', 'failed']);
      assert.equal(completed.phase, 'completed', JSON.stringify(completed));
      assert.equal(completed.percent, 100);
      assert.equal(completed.fromVersion, FROM);
      assert.equal(completed.toVersion, TO);

      const st = await call(srv, 'GET', '/status');
      assert.equal(st.body.version, TO);
      assert.equal(packageFiles(dir).length, 0, 'a successful install deletes the package');

      const names = events.map((e) => e.name);
      assert.deepEqual(names, ['app.exited', 'app.updated']);
      assert.equal(events[0].data.reason, 'update');
      assert.equal(typeof events[0].data.uptimeSec, 'number');
      const updated = events[1].data;
      assert.equal(updated.result, 'success');
      assert.equal(updated.trigger, 'sprintray');
      assert.equal(updated.fromVersion, FROM);
      assert.equal(updated.toVersion, TO);
      assert.ok(updated.durationMs >= 150, 'durationMs spans the restart');
      assert.equal(updated.errorCode, undefined);
    } finally {
      await srv.close();
    }
  });

  test('the same package already downloaded answers phase = downloaded at once', async () => {
    const { srv } = await startService();
    try {
      await download(srv);
      const again = await post(srv, { action: 'download', target: 'app', package: pkg() });
      assert.equal(again.status, 200);
      assert.equal(again.body.phase, 'downloaded');
      assert.equal((await status(srv)).phase, 'downloaded');
    } finally {
      await srv.close();
    }
  });

  test('simulated download mode needs no network', async () => {
    const sim = fastSim({ downloadMode: 'simulated', allowHttpPackageUrl: false, simulatedSizeBytes: 1000, downloadBytesPerSec: 5000 });
    const { srv, dir } = await startService({ sim });
    try {
      const done = await download(srv, { version: TO, url: 'https://cdn.invalid/ScanOS_1.0.45.0.exe', md5: PACKAGE_MD5 });
      assert.equal(done.phase, 'downloaded');
      assert.equal(packageFiles(dir).length, 1, 'a placeholder package is on disk');
    } finally {
      await srv.close();
    }
  });
});

describe('verification and retention', () => {
  test('MD5 mismatch fails with E_VERIFY_FAILED and deletes the file', async () => {
    const { srv, dir } = await startService();
    try {
      const done = await download(srv, pkg({ md5: '0'.repeat(32) }));
      assert.equal(done.phase, 'failed');
      assert.equal(done.error.code, 'E_VERIFY_FAILED');
      assert.equal(packageFiles(dir).length, 0);
    } finally {
      await srv.close();
    }
  });

  test('a package that changed on disk fails the install verification', async () => {
    const { srv, dir } = await startService();
    try {
      await download(srv);
      writeFileSync(join(dir, 'ota', 'packages', 'app', packageFiles(dir)[0]), 'tampered');
      await post(srv, { action: 'install', target: 'app', package: pkg() });
      const st = await waitForPhase(srv, ['failed', 'completed']);
      assert.equal(st.error.code, 'E_VERIFY_FAILED');
      assert.equal(packageFiles(dir).length, 0);
    } finally {
      await srv.close();
    }
  });

  test('E_PACKAGE_NOT_DOWNLOADED when the install package differs from the downloaded one', async () => {
    const { srv } = await startService();
    try {
      const none = await post(srv, { action: 'install', target: 'app', package: pkg() });
      assert.equal(none.status, 400);
      assert.equal(none.body.error.code, 'E_PACKAGE_NOT_DOWNLOADED');

      await download(srv);
      for (const other of [pkg({ version: '1.0.46.0' }), pkg({ md5: null }), pkg({ url: `${pkgBase}/ScanOS_other.exe` })]) {
        const res = await post(srv, { action: 'install', target: 'app', package: other });
        assert.equal(res.body.error.code, 'E_PACKAGE_NOT_DOWNLOADED', JSON.stringify(other));
      }
      // MD5 compares case-insensitively (§4.3): the same package in upper case is still the same.
      const upper = await post(srv, { action: 'install', target: 'app', package: pkg({ md5: PACKAGE_MD5.toUpperCase() }) });
      assert.equal(upper.status, 200);
      await waitForPhase(srv, ['completed', 'failed']);
    } finally {
      await srv.close();
    }
  });

  test('a refused POST leaves the last status alone', async () => {
    const { srv } = await startService();
    try {
      await download(srv);
      const before = await status(srv);
      await post(srv, { action: 'install', target: 'app', package: pkg({ version: '1.0.46.0' }) });
      assert.deepEqual(await status(srv), before);
    } finally {
      await srv.close();
    }
  });
});

describe('request errors', () => {
  test('E_INVALID_ARGUMENT for every malformed request', async () => {
    const { srv } = await startService({ sim: fastSim({ allowHttpPackageUrl: false }) });
    try {
      const bad = [
        'not json',
        { action: 'upgrade', target: 'app', package: pkg() },
        { action: 'download', target: 'scanner', package: pkg() },
        { action: 'download', target: 'app' },
        { action: 'download', target: 'app', package: { url: 'https://x/y.exe' } },
        { action: 'download', target: 'app', package: { version: TO, url: '' } },
        { action: 'download', target: 'app', package: { version: TO, url: '/relative.exe' } },
        { action: 'download', target: 'app', package: { version: TO, url: 'http://cdn.example.com/a.exe' } },
        { action: 'download', target: 'app', package: { version: TO, url: 'https://cdn.example.com/a.exe', md5: 'abc' } },
      ];
      for (const body of bad) {
        const res = await post(srv, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.error.code, 'E_INVALID_ARGUMENT', JSON.stringify(body));
        assert.equal(typeof res.body.error.message, 'string');
      }
    } finally {
      await srv.close();
    }
  });

  test('target = firmware is not simulated: E_UPDATE_UNSUPPORTED', async () => {
    const { srv } = await startService();
    try {
      for (const action of ['download', 'install']) {
        const res = await post(srv, { action, target: 'firmware', package: pkg() });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'E_UPDATE_UNSUPPORTED');
      }
    } finally {
      await srv.close();
    }
  });

  test('E_SCAN_NOT_INSTALLED, E_UPDATE_UNSUPPORTED, E_ALREADY_UP_TO_DATE', async () => {
    const a = await startService({ scanPro: { installed: false } });
    try {
      assert.equal((await post(a.srv, { action: 'download', target: 'app', package: pkg() })).body.error.code, 'E_SCAN_NOT_INSTALLED');
    } finally {
      await a.srv.close();
    }

    const b = await startService({ sim: fastSim({ unsupported: true }) });
    try {
      assert.equal((await post(b.srv, { action: 'download', target: 'app', package: pkg() })).body.error.code, 'E_UPDATE_UNSUPPORTED');
    } finally {
      await b.srv.close();
    }

    const c = await startService({ scanPro: { version: '1.0.45' } }); // 1.0.45 = 1.0.45.0
    try {
      const res = await post(c.srv, { action: 'download', target: 'app', package: pkg() });
      assert.equal(res.body.error.code, 'E_ALREADY_UP_TO_DATE');
    } finally {
      await c.srv.close();
    }
  });

  test('E_UPDATE_IN_PROGRESS while a step runs', async () => {
    const { srv } = await startService({ sim: fastSim({ downloadBytesPerSec: 256 * 1024 }) });
    try {
      await post(srv, { action: 'download', target: 'app', package: pkg() });
      for (const body of [
        { action: 'download', target: 'app', package: pkg() },
        { action: 'install', target: 'app', package: pkg() },
        { action: 'download', target: 'firmware', package: pkg() }, // refused anyway, but not as in-progress
      ]) {
        const res = await post(srv, body);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, body.target === 'firmware' ? 'E_UPDATE_UNSUPPORTED' : 'E_UPDATE_IN_PROGRESS');
      }
      assert.equal((await waitForPhase(srv, ['downloaded', 'failed'], 8000)).phase, 'downloaded');
    } finally {
      await srv.close();
    }
  });

  test('E_SCAN_ALREADY_RUNNING on install; download works while running', async () => {
    const { srv, state } = await startService({ scanPro: { running: true } });
    try {
      assert.equal((await download(srv)).phase, 'downloaded');
      const res = await post(srv, { action: 'install', target: 'app', package: pkg() });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'E_SCAN_ALREADY_RUNNING');

      state.running = false;
      assert.equal((await post(srv, { action: 'install', target: 'app', package: pkg() })).status, 200);
      assert.equal((await waitForPhase(srv, ['completed', 'failed'])).phase, 'completed');
    } finally {
      await srv.close();
    }
  });

  test('CORS preflight for POST /update passes, Private Network Access included', async () => {
    const { srv } = await startService();
    try {
      const res = await rawRequest(srv.port, 'OPTIONS', '/update', undefined, {
        Origin: 'https://designservice.sprintray.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Private-Network': 'true',
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers['access-control-allow-origin'], 'https://designservice.sprintray.com');
      assert.match(res.headers['access-control-allow-methods'], /POST/);
      assert.equal(res.headers['access-control-allow-headers'], 'content-type');
      assert.equal(res.headers['access-control-allow-private-network'], 'true');
    } finally {
      await srv.close();
    }
  });
});

describe('persistence and the service being replaced', () => {
  test('a downloaded package survives a restart of the service and can be installed', async () => {
    const first = await startService();
    await download(first.srv);
    await first.srv.close();

    const second = await startService({ stateDir: first.dir });
    try {
      const st = await status(second.srv);
      assert.equal(st.phase, 'downloaded');
      assert.equal(st.toVersion, TO);
      assert.equal((await post(second.srv, { action: 'install', target: 'app', package: pkg() })).status, 200);
      assert.equal((await waitForPhase(second.srv, ['completed', 'failed'])).phase, 'completed');
    } finally {
      await second.srv.close();
    }
  });

  test('a service killed mid-install comes back failed with E_INSTALL_FAILED and keeps the package', async () => {
    const first = await startService({ sim: fastSim({ installMs: 5000 }) });
    await download(first.srv);
    await post(first.srv, { action: 'install', target: 'app', package: pkg() });
    await waitForPhase(first.srv, 'installing');
    await first.srv.close();

    const second = await startService({ stateDir: first.dir });
    try {
      const st = await status(second.srv);
      assert.equal(st.phase, 'failed');
      assert.equal(st.error.code, 'E_INSTALL_FAILED');
      assert.equal(packageFiles(first.dir).length, 1);
      assert.equal(second.events.at(-1).name, 'app.updated');
      assert.equal(second.events.at(-1).data.result, 'failed');
    } finally {
      await second.srv.close();
    }
  });

  test('a service killed mid-download comes back failed with E_DOWNLOAD_FAILED under interruptedDownload=fail', async () => {
    const first = await startService({ sim: fastSim({ downloadBytesPerSec: 64 * 1024, interruptedDownload: 'fail' }) });
    await post(first.srv, { action: 'download', target: 'app', package: pkg() });
    await waitForPhase(first.srv, 'downloading');
    await first.srv.close();

    const second = await startService({ stateDir: first.dir, sim: fastSim({ interruptedDownload: 'fail' }) });
    try {
      const st = await status(second.srv);
      assert.equal(st.phase, 'failed');
      assert.equal(st.error.code, 'E_DOWNLOAD_FAILED');
      assert.equal(packageFiles(first.dir).length, 0);
    } finally {
      await second.srv.close();
    }
  });

  test('the service closes during restarting and comes back on another port', async () => {
    const restarts = [];
    const dir = mkdtempSync(join(tmpdir(), 'ota-test-'));
    const sim = fastSim({ portSwitch: true, restartDelayMs: 300 });
    const srv = await startScanProLocalServer({
      service: { getStatus: () => ({ installed: true, running: false, version: FROM }), start: () => ({}) },
      options: { ...RANGE, stateDir: dir },
      ota: { sim, stateDir: dir, emitTelemetry: () => {} },
      onRestart: (e) => restarts.push(e),
    });
    try {
      const firstPort = srv.port;
      await download(srv);
      await post(srv, { action: 'install', target: 'app', package: pkg() });
      await waitForPhase(srv, 'restarting');

      // Down: the old port refuses connections.
      await new Promise((r) => setTimeout(r, 120));
      await assert.rejects(rawRequest(firstPort, 'GET', '/status'));

      await srv.whenRestarted();
      assert.notEqual(srv.port, firstPort);
      assert.ok(srv.port >= RANGE.portRangeStart && srv.port <= RANGE.portRangeEnd);
      assert.deepEqual(restarts.map((e) => e.type), ['down', 'up']);
      const st = await status(srv);
      assert.equal(st.phase, 'completed');
      assert.equal((await call(srv, 'GET', '/status')).body.version, TO);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The download and the install run in the local server, not in the page: the Scan tab can be
// closed and reopened at any point and must find the step where it is (brief "Requirement",
// spec §5.4 "Page load"). Each check below uses a FRESH client — it knows no port and no prior
// state, probes the range like the Scan tab does, and reads /update/status once.
async function freshClientStatus() {
  for (let port = RANGE.portRangeStart; port <= RANGE.portRangeEnd; port++) {
    try {
      const st = await rawRequest(port, 'GET', '/status');
      if (st.status === 200 && JSON.parse(st.text).service === 'SprintRayScanService') {
        const up = await rawRequest(port, 'GET', '/update/status');
        return { port, ...JSON.parse(up.text) };
      }
    } catch {
      // nothing on this port (or the service is between runs) — try the next one
    }
  }
  return null;
}

const idle = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the web page closes and reopens (no client polling)', () => {
  test('a download advances with nobody polling, and a new client reads it mid-way and at the end', async () => {
    // 256 KB at 128 KB/s ≈ 2 s.
    const { srv } = await startService({ sim: fastSim({ downloadBytesPerSec: 128 * 1024 }) });
    try {
      assert.equal((await post(srv, { action: 'download', target: 'app', package: pkg() })).status, 200);
      // The page that started it is gone: not a single request for a while.
      await idle(700);
      const mid = await freshClientStatus();
      assert.equal(mid.phase, 'downloading');
      assert.equal(mid.action, 'download');
      assert.equal(mid.toVersion, TO);
      assert.ok(mid.percent > 0 && mid.percent < 100, `percent ${mid.percent}`);

      await idle(500);
      const later = await freshClientStatus();
      assert.ok(later.percent > mid.percent || later.phase !== 'downloading', 'progress moved without polling');

      await idle(2000);
      const end = await freshClientStatus();
      assert.equal(end.phase, 'downloaded');
      assert.equal(end.percent, 100);
      assert.equal(end.startedAt, mid.startedAt, 'the same step, not a new one');
    } finally {
      await srv.close();
    }
  });

  test('a new client finds the install mid-way, and finds it completed on the new port after the restart', async () => {
    const sim = fastSim({ installMs: 600, restartingHoldMs: 200, restartDelayMs: 300, portSwitch: true });
    const { srv } = await startService({ sim });
    try {
      await download(srv);
      const firstPort = srv.port;
      assert.equal((await post(srv, { action: 'install', target: 'app', package: pkg() })).status, 200);

      await idle(250);
      const mid = await freshClientStatus();
      assert.ok(['verifying', 'installing'].includes(mid.phase), mid.phase);
      assert.equal(mid.action, 'install');
      assert.equal(mid.toVersion, TO);

      // No requests through installing, restarting and the service coming back elsewhere.
      await idle(1800);
      const end = await freshClientStatus();
      assert.ok(end, 'the service is found again by probing');
      assert.notEqual(end.port, firstPort);
      assert.equal(end.phase, 'completed');
      assert.equal(end.toVersion, TO);
      assert.equal(end.startedAt, mid.startedAt);
      const st = await rawRequest(end.port, 'GET', '/status');
      assert.equal(JSON.parse(st.text).version, TO);
    } finally {
      await srv.close();
    }
  });

  test('a download survives a restart of the simulator itself and carries on', async () => {
    // Simulated: 10 MB at 4 MB/s ≈ 2.5 s, so the restart lands mid-way.
    const sim = () => fastSim({ downloadMode: 'simulated', simulatedSizeBytes: 10 * 1024 * 1024, downloadBytesPerSec: 4 * 1024 * 1024 });
    const first = await startService({ sim: sim() });
    await post(first.srv, { action: 'download', target: 'app', package: pkg() });
    await idle(900);
    const before = await freshClientStatus();
    assert.equal(before.phase, 'downloading');
    await first.srv.close();

    const second = await startService({ stateDir: first.dir, sim: sim() });
    try {
      const after = await freshClientStatus();
      assert.equal(after.phase, 'downloading');
      assert.equal(after.toVersion, TO);
      assert.equal(after.startedAt, before.startedAt);
      assert.ok(after.percent >= before.percent, `resumed at ${after.percent}%, was ${before.percent}%`);

      await idle(2500);
      assert.equal((await freshClientStatus()).phase, 'downloaded');
      assert.equal(packageFiles(first.dir).length, 1);
    } finally {
      await second.srv.close();
    }
  });
});

describe('fault injection (simulator only)', () => {
  test('a forced E_INSTALL_FAILED keeps the package; the retry installs it', async () => {
    const { srv, dir, events } = await startService({ sim: fastSim({ failOnce: 'installing:E_INSTALL_FAILED' }) });
    try {
      await download(srv);
      await post(srv, { action: 'install', target: 'app', package: pkg() });
      const failed = await waitForPhase(srv, ['failed', 'completed']);
      assert.equal(failed.error.code, 'E_INSTALL_FAILED');
      assert.equal(packageFiles(dir).length, 1);
      assert.equal(events.at(-1).data.errorCode, 'E_INSTALL_FAILED');

      assert.equal((await post(srv, { action: 'install', target: 'app', package: pkg() })).status, 200);
      assert.equal((await waitForPhase(srv, ['completed', 'failed'])).phase, 'completed');
    } finally {
      await srv.close();
    }
  });

  test('a forced download failure keeps the percent it failed at', async () => {
    const { srv } = await startService({ sim: fastSim({ fail: 'downloading:E_DOWNLOAD_FAILED@50', downloadBytesPerSec: 1024 * 1024 }) });
    try {
      const st = await download(srv);
      assert.equal(st.phase, 'failed');
      assert.equal(st.error.code, 'E_DOWNLOAD_FAILED');
      // `percent` stays where the bar was when it failed: past 0, short of the 50 % trigger.
      assert.ok(st.percent > 0 && st.percent < 50, `percent ${st.percent}`);
    } finally {
      await srv.close();
    }
  });

  test('an invalid Authenticode signature is E_VERIFY_FAILED and deletes the package', async () => {
    const { srv, dir } = await startService({ sim: fastSim({ signatureInvalid: true }) });
    try {
      await download(srv);
      await post(srv, { action: 'install', target: 'app', package: pkg() });
      const st = await waitForPhase(srv, ['failed', 'completed']);
      assert.equal(st.error.code, 'E_VERIFY_FAILED');
      assert.equal(packageFiles(dir).length, 0);
    } finally {
      await srv.close();
    }
  });

  test('a version mismatch after the restart is E_INSTALL_FAILED', async () => {
    const { srv } = await startService({ sim: fastSim({ versionMismatch: true }) });
    try {
      await download(srv);
      await post(srv, { action: 'install', target: 'app', package: pkg() });
      await srv.whenRestarted();
      const st = await waitForPhase(srv, ['failed', 'completed']);
      assert.equal(st.error.code, 'E_INSTALL_FAILED');
      assert.match(st.error.message, /reporting version 1\.0\.44\.9/);
      assert.equal((await call(srv, 'GET', '/status')).body.version, FROM);
    } finally {
      await srv.close();
    }
  });

  test('a stall freezes progress and updatedAt until it is cleared', async () => {
    const { srv } = await startService({ sim: fastSim({ downloadBytesPerSec: 512 * 1024, stall: 'downloading' }) });
    try {
      await post(srv, { action: 'download', target: 'app', package: pkg() });
      await new Promise((r) => setTimeout(r, 400));
      const a = await status(srv);
      await new Promise((r) => setTimeout(r, 300));
      const b = await status(srv);
      assert.equal(a.phase, 'downloading');
      assert.equal(b.updatedAt, a.updatedAt);
      assert.equal(b.percent, a.percent);

      const cleared = await call(srv, 'POST', '/_sim', { stall: null });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.sim.stall, null);
      assert.equal((await waitForPhase(srv, ['downloaded', 'failed'])).phase, 'downloaded');
    } finally {
      await srv.close();
    }
  });

  test('an older local server without /update answers 404', async () => {
    const { srv } = await startService({ sim: fastSim({ noUpdateRoute: true }) });
    try {
      assert.equal((await post(srv, { action: 'download', target: 'app', package: pkg() })).status, 404);
      assert.equal((await call(srv, 'GET', '/update/status')).status, 404);
      assert.equal((await call(srv, 'GET', '/status')).status, 200);
    } finally {
      await srv.close();
    }
  });

  test('an inactive session answers 503 on every path, OPTIONS included, with no CORS headers', async () => {
    const { srv } = await startService({ sim: fastSim({ inactiveSession: true }) });
    try {
      for (const [method, path] of [['GET', '/status'], ['GET', '/update/status'], ['OPTIONS', '/update']]) {
        const res = await rawRequest(srv.port, method, path, undefined, { Origin: 'https://x.sprintray.com' });
        assert.equal(res.status, 503, `${method} ${path}`);
        assert.equal(res.headers['access-control-allow-origin'], undefined);
        assert.equal(JSON.parse(res.text).error.code, 'E_INACTIVE_SESSION');
      }
    } finally {
      await srv.close();
    }
  });

  test('the control route is off unless enabled, refuses unknown switches, and resets', async () => {
    const off = await startService({ control: false });
    try {
      assert.equal((await call(off.srv, 'GET', '/_sim')).status, 404);
    } finally {
      await off.srv.close();
    }

    const { srv, dir } = await startService();
    try {
      assert.equal((await call(srv, 'POST', '/_sim', { nope: true })).status, 400);
      assert.equal((await call(srv, 'POST', '/_sim', { fail: 'installing:E_SCANNER_BATTERY_LOW' })).status, 400, 'firmware codes are not simulated');
      assert.equal((await call(srv, 'POST', '/_sim', { scanPro: { running: true } })).body.sim.scanPro.running, true);
      assert.equal((await call(srv, 'GET', '/status')).body.running, true);

      await download(srv);
      const reset = await call(srv, 'POST', '/_sim/reset');
      assert.equal(reset.body.status.phase, 'idle');
      assert.equal(packageFiles(dir).length, 0);
    } finally {
      await srv.close();
    }
  });
});

test('service telemetry skips quietly without an endpoint or key', async () => {
  const r = await reportServiceEvent({
    url: '',
    apiKey: '',
    appVersion: TO,
    installPath: '/tmp',
    deviceId: 'd',
    eventName: 'app.updated',
    eventData: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.skipped ?? '', /endpoint|os\.platform/);
});
