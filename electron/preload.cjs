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

  // run the device-login + upload flow; events stream via onFlowEvent
  runFlow: (params) => ipcRenderer.invoke('flow:run', params),

  // subscribe to streamed flow events; returns an unsubscribe fn
  onFlowEvent: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on('flow:event', listener);
    return () => ipcRenderer.removeListener('flow:event', listener);
  },

  // a launch payload arrived — { url, source } where source is 'os' (the URL scheme)
  // or 'local-server' (POST /scanpro/v1/start on 127.0.0.1)
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
