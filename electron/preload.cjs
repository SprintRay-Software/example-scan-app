// Preload — the only bridge between the sandboxed renderer and the main process.
// contextIsolation is on, so the renderer sees exactly this `scanpro` API and nothing else.
// CommonJS (.cjs) so it loads regardless of the package's "type": "module".

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanpro', {
  // config prefill from .env
  getDefaults: () => ipcRenderer.invoke('defaults:get'),

  // OS URL-scheme handler status / claim
  getSchemeStatus: () => ipcRenderer.invoke('scheme:status'),
  setDefaultScheme: () => ipcRenderer.invoke('scheme:setDefault'),

  // decode a launch URL without hitting the network (preview)
  decodePayload: (launchUrl) => ipcRenderer.invoke('payload:decode', launchUrl),

  // choose a scan file to upload instead of the bundled fixture
  pickFile: () => ipcRenderer.invoke('file:pick'),

  // raw bytes of a bundled scan ('upper' | 'lower') for the demo skin's 3D view — a file://
  // page cannot read them itself
  readFixture: (arch) => ipcRenderer.invoke('fixture:read', arch),

  // raw bytes of one file from a stored scan, addressed by the case key and file name that came
  // in on the launch's `history` entry — the renderer never names a path
  readHistoryFile: (caseKey, fileName) => ipcRenderer.invoke('history:read', caseKey, fileName),

  // run the device-login + upload flow; events stream via onFlowEvent
  runFlow: (params) => ipcRenderer.invoke('flow:run', params),

  // step out of the way and let the browser back in front (the demo skin's end of a case)
  hideWindow: () => ipcRenderer.invoke('window:hide'),

  // subscribe to streamed flow events; returns an unsubscribe fn
  onFlowEvent: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on('flow:event', listener);
    return () => ipcRenderer.removeListener('flow:event', listener);
  },

  // a launch payload arrived — { url, source, history } where source is 'os' (the URL scheme)
  // or 'local-server' (POST /scanpro/v1/start on 127.0.0.1), and history is the stored session
  // for this case, or null when there is none to open
  onLaunch: (cb) => {
    const listener = (_event, launch) => cb(launch);
    ipcRenderer.on('launch', listener);
    return () => ipcRenderer.removeListener('launch', listener);
  },

  // local HTTP service: current state, plus pushes when it changes
  getLocalServerState: () => ipcRenderer.invoke('localserver:get'),
  onLocalServerState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('localserver:state', listener);
    return () => ipcRenderer.removeListener('localserver:state', listener);
  },
});
