// Electron main process for the ScanPro desktop-integration simulator UI.
//
// It wraps the SAME instrumented flow the CLI runs (src/core/flow.js): the renderer
// collects config + input, the main process runs the flow with an IPC reporter that
// forwards every event (steps, decoded payload, full HTTP request/response, progress)
// to the window. It also registers the app as the OS handler for the launch URL scheme,
// so clicking "OR Scan" in the browser can open this app directly with the deep link.
//
// On startup it additionally brings up the ScanPro local HTTP service on 127.0.0.1
// (src/local-server) — the second way the web app can reach a desktop scanner. Both
// transports carry the same base64 launch payload and land in the same UI.

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { normalizeBaseUrl, loadLocalServerConfig } from '../src/config.js';
import { runFlow, decodeLaunch } from '../src/core/flow.js';
import { createReporter } from '../src/core/reporter.js';
import { startScanProLocalServer, summarizeArgument } from '../src/local-server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_DIR = resolve(__dirname, '..');

// Packaged, the app tree lives inside app.asar. `fixtures/` is unpacked (see the build config)
// so the scan files are real files on disk that a stream can read.
const FIXTURES_DIR = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'fixtures')
  : resolve(SIM_DIR, 'fixtures');

// In development the .env sits in the repo. A packaged app cannot have one written into its
// read-only bundle, so look beside the executable first (the natural place for a tester to
// drop one), then in the per-user data directory.
function resolveEnvFile() {
  if (!app.isPackaged) return resolve(SIM_DIR, '.env');
  const candidates = [
    join(dirname(app.getPath('exe')), '.env'),
    join(app.getPath('userData'), '.env'),
    join(process.resourcesPath, '.env'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[1];
}

const ENV_FILE = resolveEnvFile();

// ---------------------------------------------------------------------------
// .env — read (never write to process.env) so the UI can prefill config fields.
// A missing or partial .env is fine; the tester can fill the fields in the UI.
// ---------------------------------------------------------------------------
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const ENV = parseEnvFile(ENV_FILE);
const URL_SCHEME = (ENV.SCANPRO_URL_SCHEME || 'openScanPro').trim();

function defaults() {
  return {
    // Which skin the window opens in. The demo skin is the default — this app is shown to
    // integrators far more often than it is debugged — and SCANPRO_UI_MODE=dev is the way a
    // developer machine skips it without touching the d-d-d-d-d gesture every launch. The shell
    // wins over .env here so a one-off `SCANPRO_UI_MODE=dev npm run app` does what it looks like.
    uiMode:
      (process.env.SCANPRO_UI_MODE ?? ENV.SCANPRO_UI_MODE ?? '').trim().toLowerCase() === 'dev'
        ? 'dev'
        : 'demo',
    baseUrl: ENV.SCANPRO_BASE_URL || 'https://apx.sprintray.com',
    apiKey: ENV.SCANPRO_API_KEY || '',
    clientId: ENV.SCANPRO_CLIENT_ID || '',
    clientSecret: ENV.SCANPRO_CLIENT_SECRET || '',
    urlScheme: URL_SCHEME,
    envFileFound: existsSync(ENV_FILE),
    envFilePath: ENV_FILE,
    fixtures: { upper: join(FIXTURES_DIR, 'upper.stl'), lower: join(FIXTURES_DIR, 'lower.stl') },
  };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;
// Whether the renderer has finished loading and can receive IPC. Tracked explicitly rather
// than read off webContents.isLoading(): loadFile() is asynchronous, so immediately after
// createWindow() the contents are not "loading" yet either, and a launch sent in that window
// of time reaches a renderer with no listeners and is lost.
let rendererReady = false;
// A launch may arrive before the renderer is ready; hold the latest one.
// Shape: { url, source, resolve } — source is 'os' (URL scheme) or 'local-server' (/start).
let pendingLaunch = null;

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    title: 'ScanPro Desktop Integration Simulator',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    mainWindow.webContents.send('localserver:state', localServerState);

    const queued = pendingLaunch;
    pendingLaunch = null;
    if (queued) {
      mainWindow.webContents.send('launch', { url: queued.url, source: queued.source });
      // A launch that had to wait for the window still has to end up in front of the user.
      revealWindow(mainWindow);
      queued.resolve(true);
    }
  });

  mainWindow.on('closed', () => {
    rendererReady = false;
    mainWindow = null;
  });

  // Open external links in the OS browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Launch handling — the OS URL scheme (openScanPro://<base64>) and the local
// service's POST /start both end here, since they carry the same payload.
// ---------------------------------------------------------------------------

// Put the window in front of whatever the user is looking at.
//
// `win.focus()` on its own is not enough, and the gap is invisible in testing because it only
// shows up when the app is NOT the frontmost one — exactly the situation a launch arrives in.
// On macOS a background app has to activate itself first, otherwise the window is raised only
// within that app and stays behind the frontmost one; with every window closed the app is also
// off the dock's active state. On Windows the OS refuses a focus steal from a background
// process and just flashes the taskbar button, so the window has to be raised explicitly.
function revealWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (process.platform === 'darwin') {
    app.dock?.show();
    // app.hide() (how the demo skin steps back to the browser) hides the whole application, and
    // showing one of its windows does not undo that — app.show() is its counterpart. Without
    // this, the launch after a return never puts the window back on screen.
    app.show();
    app.focus({ steal: true });
  }
  win.moveTop();
  win.focus();
}

// How long a launch waits for a freshly created window to finish loading before it is
// reported as failed. /start blocks on this, so it needs a bound.
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Hand a launch payload to the window, creating and revealing it as needed.
 * @returns {Promise<boolean>} true once the renderer has actually received it
 */
function deliverLaunch(url, source = 'os') {
  if (!url) return Promise.resolve(false);

  if (mainWindow && rendererReady) {
    mainWindow.webContents.send('launch', { url, source });
    revealWindow(mainWindow);
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingLaunch?.resolve === settle) pendingLaunch = null;
      resolve(false);
    }, LAUNCH_TIMEOUT_MS);

    function settle(ok) {
      clearTimeout(timer);
      resolve(ok);
    }

    pendingLaunch = { url, source, resolve: settle };
    // Only build the window once Electron is ready. A cold launch through the URL scheme
    // delivers open-url BEFORE whenReady on macOS, and constructing a BrowserWindow at that
    // point throws and takes the process down — the app dies on the very launch it was
    // started for. When it is not ready yet, whenReady creates the window and did-finish-load
    // flushes this queued launch.
    if (app.isReady() && !mainWindow) createWindow();
  });
}

// Pull the first custom-scheme URL out of a process argv (Windows/Linux launch path).
function deepLinkFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${URL_SCHEME}://`)) || null;
}

// Single-instance: a second launch (e.g. the OS opening the scheme) forwards its argv here.
//
// Not on macOS. There, requestSingleInstanceLock() validates code signatures, and for a build
// that is not signed with a Developer ID it cannot read the task port of the launching process
// when that process is launchd:
//
//   ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)
//
// The call then returns false, the app takes itself for a second instance and quits — so every
// launch from Finder, from the URL scheme, or from the local service's /start dies within a
// second, while running the binary from a terminal (parent = the shell) works fine. The lock
// buys nothing here anyway: LaunchServices already keeps one instance per bundle and delivers
// a repeat launch to it as open-url.
const gotLock = process.platform === 'darwin' || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    deliverLaunch(deepLinkFromArgv(argv));
  });

  // macOS delivers the scheme via open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverLaunch(url);
  });

  app.whenReady().then(() => {
    // Make this app the OS handler for the launch scheme. In dev (`electron .`) macOS
    // registration is best-effort; a packaged build registers reliably. Pasting a launch
    // URL into the UI works regardless.
    try {
      app.setAsDefaultProtocolClient(URL_SCHEME);
    } catch {
      // non-fatal
    }

    createWindow();

    // First-launch deep link on Windows/Linux arrives in the initial argv.
    if (process.platform !== 'darwin') {
      const initial = deepLinkFromArgv(process.argv);
      if (initial) pendingLaunch = { url: initial, source: 'os' };
    }

    // The local service comes up alongside the window, never in front of it: a failure to
    // bind must not keep the app from starting, so this is deliberately not awaited.
    startLocalService();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  localServer?.close().catch(() => {});
  localServer = null;
});

// ---------------------------------------------------------------------------
// Local HTTP service (127.0.0.1) — the transport the web app probes when it does not
// want to go through the OS URL scheme. Here the Electron app itself plays ScanPro, so
// /status reports this app's state and /start focuses the window with the payload loaded.
// ---------------------------------------------------------------------------
let localServer = null;
let localServerState = { enabled: true, status: 'starting' };

function setLocalServerState(next) {
  localServerState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('localserver:state', localServerState);
  }
}

function localServiceLog(msg) {
  console.log(`[local-server] ${msg}`);
}

const scanProService = {
  // The example app IS the "installed ScanPro" here; it is running whenever a window exists.
  getStatus: () => ({
    installed: true,
    running: BrowserWindow.getAllWindows().length > 0,
    version: app.getVersion(),
  }),

  async start({ argument, decoded }) {
    localServiceLog(`/start — ${summarizeArgument(decoded)}`);
    // "Starting ScanPro" for this app means: have a window, put it in front of the user, and
    // hand it the payload. Awaiting that is what makes the response honest — the contract's
    // blocking /start must not answer `true` while nothing has appeared on screen.
    const started = await deliverLaunch(`${URL_SCHEME}://${argument}`, 'local-server');
    if (!started) {
      localServiceLog('/start — window did not become ready in time');
      return {
        started: false,
        errorCode: 'WINDOW_NOT_READY',
        message: `the app window did not finish loading within ${LAUNCH_TIMEOUT_MS} ms`,
      };
    }
    return { started: true };
  },
};

async function startLocalService() {
  const options = loadLocalServerConfig(
    { ...process.env, ...ENV },
    {
      appVersion: app.getVersion(),
      installPath: app.isPackaged ? dirname(app.getPath('exe')) : SIM_DIR,
      stateDir: app.getPath('userData'),
    }
  );

  if (!options.enabled) {
    localServiceLog('disabled by SCANPRO_LOCAL_SERVER=0');
    setLocalServerState({ enabled: false, status: 'disabled' });
    return;
  }

  const result = await startScanProLocalServer({
    service: scanProService,
    options,
    log: localServiceLog,
  });

  if (result.ok) {
    localServer = result;
    localServiceLog(`listening on ${result.url}`);
    setLocalServerState({
      enabled: true,
      status: 'listening',
      port: result.port,
      url: result.url,
      endpoints: result.endpoints,
    });
  } else {
    setLocalServerState({
      enabled: true,
      status: 'failed',
      error: result.error.message,
      portRangeStart: options.portRangeStart,
      portRangeEnd: options.portRangeEnd,
      telemetrySent: Boolean(result.telemetry?.ok),
    });
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('defaults:get', () => defaults());

ipcMain.handle('localserver:get', () => localServerState);

ipcMain.handle('scheme:status', () => ({
  scheme: URL_SCHEME,
  isDefault: app.isDefaultProtocolClient(URL_SCHEME),
}));

ipcMain.handle('scheme:setDefault', () => {
  try {
    app.setAsDefaultProtocolClient(URL_SCHEME);
  } catch {
    // non-fatal
  }
  return { scheme: URL_SCHEME, isDefault: app.isDefaultProtocolClient(URL_SCHEME) };
});

ipcMain.handle('payload:decode', (_event, launchUrl) => {
  try {
    return { ok: true, ...decodeLaunch(launchUrl) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('file:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a scan file to upload',
    properties: ['openFile'],
    filters: [
      { name: 'Scans', extensions: ['stl', 'ply', 'obj', 'dcm', 'zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: res.filePaths[0] };
});

// The demo skin renders the bundled arches in a WebGL view. The renderer is a file:// page
// under a strict CSP and cannot read them itself, so the bytes come across IPC.
ipcMain.handle('fixture:read', (_event, arch) => {
  const name = arch === 'lower' ? 'lower.stl' : 'upper.stl';
  try {
    // Uint8Array survives the structured clone; a Buffer would arrive as one anyway.
    return { ok: true, bytes: new Uint8Array(readFileSync(join(FIXTURES_DIR, name))) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// "Return to the browser" — what a desktop scanner app does once the case is on its way: get
// out of the way so whatever the doctor came from is in front again. Hiding the app (macOS) or
// minimizing the window (Windows/Linux) is what actually puts the previous app back on top;
// the next launch reveals this one again through revealWindow().
ipcMain.handle('window:hide', () => {
  if (process.platform === 'darwin') app.hide();
  else mainWindow?.minimize();
  return true;
});

ipcMain.handle('flow:run', async (event, params) => {
  const { config: rawConfig, input } = params;
  const config = {
    baseUrl: normalizeBaseUrl(rawConfig.baseUrl),
    apiKey: String(rawConfig.apiKey || '').trim(),
    clientId: String(rawConfig.clientId || '').trim(),
    clientSecret: String(rawConfig.clientSecret || '').trim(),
    // The integration's scan vocabulary comes from the .env, not from the renderer: it belongs
    // to the integration rather than to a run, so there is no UI field for it. Unset is fine —
    // the flow falls back to this example's own default names.
    scanMode: (ENV.SCANPRO_SCAN_MODE || '').trim() || undefined,
    scanFileTypes: {
      upper: (ENV.SCANPRO_SCAN_FILE_TYPE_UPPER || '').trim() || undefined,
      lower: (ENV.SCANPRO_SCAN_FILE_TYPE_LOWER || '').trim() || undefined,
    },
  };

  const send = (type, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('flow:event', { type, payload });
  };

  // An IPC reporter: forward every flow event to the renderer verbatim.
  const reporter = createReporter({
    phase: (stage, status, detail) => send('phase', { stage, status, detail }),
    step: (msg) => send('step', { msg }),
    ok: (msg) => send('ok', { msg }),
    fail: (msg) => send('fail', { msg }),
    info: (msg) => send('info', { msg }),
    payload: (p) => send('payload', p),
    httpStart: (p) => send('httpStart', p),
    httpEnd: (p) => send('httpEnd', p),
    httpError: (p) => send('httpError', p),
    progress: (p) => send('progress', p),
    result: (p) => send('result', p),
  });

  try {
    const summary = await runFlow(reporter, { config, input, fixturesDir: FIXTURES_DIR });
    return { ok: true, summary };
  } catch (err) {
    send('fail', { msg: err.message });
    return { ok: false, error: err.message };
  }
});
