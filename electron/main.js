// Electron main process for the ScanPro desktop-integration simulator UI.
//
// It wraps the SAME instrumented flow the CLI runs (src/core/flow.js): the renderer
// collects config + input, the main process runs the flow with an IPC reporter that
// forwards every event (steps, decoded payload, full HTTP request/response, progress)
// to the window. It also registers the app as the OS handler for the launch URL scheme,
// so clicking "OR Scan" in the browser can open this app directly with the deep link.

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { normalizeBaseUrl } from '../src/config.js';
import { runFlow, decodeLaunch } from '../src/core/flow.js';
import { createReporter } from '../src/core/reporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_DIR = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(SIM_DIR, 'fixtures');
const ENV_FILE = resolve(SIM_DIR, '.env');

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
    baseUrl: ENV.SCANPRO_BASE_URL || 'https://dashboard.sprintray.com',
    clientId: ENV.SCANPRO_CLIENT_ID || '',
    clientSecret: ENV.SCANPRO_CLIENT_SECRET || '',
    urlScheme: URL_SCHEME,
    envFileFound: existsSync(ENV_FILE),
    fixtures: { upper: join(FIXTURES_DIR, 'upper.stl'), lower: join(FIXTURES_DIR, 'lower.stl') },
  };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;
// A deep link may arrive before the window/renderer is ready; hold the latest one.
let pendingDeepLink = null;

function createWindow() {
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
    if (pendingDeepLink) {
      mainWindow.webContents.send('deeplink', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  // Open external links in the OS browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Deep-link handling (openScanPro://<base64>)
// ---------------------------------------------------------------------------
function deliverDeepLink(url) {
  if (!url) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('deeplink', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingDeepLink = url;
  }
}

// Pull the first custom-scheme URL out of a process argv (Windows/Linux launch path).
function deepLinkFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${URL_SCHEME}://`)) || null;
}

// Single-instance: a second launch (e.g. the OS opening the scheme) forwards its argv here.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    deliverDeepLink(deepLinkFromArgv(argv));
  });

  // macOS delivers the scheme via open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
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
      if (initial) pendingDeepLink = initial;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('defaults:get', () => defaults());

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

ipcMain.handle('flow:run', async (event, params) => {
  const { config: rawConfig, input } = params;
  const config = {
    baseUrl: normalizeBaseUrl(rawConfig.baseUrl),
    clientId: String(rawConfig.clientId || '').trim(),
    clientSecret: String(rawConfig.clientSecret || '').trim(),
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
