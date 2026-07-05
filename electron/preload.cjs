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

  // a deep link arrived from the OS (openScanPro://…)
  onDeepLink: (cb) => {
    const listener = (_event, url) => cb(url);
    ipcRenderer.on('deeplink', listener);
    return () => ipcRenderer.removeListener('deeplink', listener);
  },
});
