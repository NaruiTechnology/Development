const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Map();
const modeListeners = new Set();
let latestMode = null;
ipcRenderer.on('scanner:event', (_event, packet) => listeners.get(packet.id)?.(packet));
ipcRenderer.on('desktop:mode-change', (_event, mode) => {
  latestMode = mode;
  for (const listener of modeListeners) listener(mode);
});
contextBridge.exposeInMainWorld('ionbeamScanner', {
  subscribe: (id, callback) => { listeners.set(id, callback); },
  unsubscribe: id => { listeners.delete(id); },
  start: command => ipcRenderer.invoke('scanner:start', command),
  stop: id => ipcRenderer.invoke('scanner:stop', id),
  ack: id => ipcRenderer.send('scanner:ack', id),
  onModeChange: callback => {
    modeListeners.add(callback);
    if (latestMode) callback(latestMode);
    return () => modeListeners.delete(callback);
  },
});
