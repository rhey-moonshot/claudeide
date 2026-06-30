'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Secure bridge: the renderer never touches Node directly. It only gets this
// narrow surface for talking to the PTY manager in the main process.
contextBridge.exposeInMainWorld('hydra', {
  createPty: (args) => ipcRenderer.invoke('pty:create', args),
  input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty:kill', { id }),
  envInfo: () => ipcRenderer.invoke('env:info'),
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  listDir: (arg) => ipcRenderer.invoke('fs:listDir', arg),
  testConn: (target) => ipcRenderer.invoke('conn:test', target),
  // Resolve the absolute filesystem path of a dropped/pasted File. Uses the
  // modern webUtils API (File.path was removed in Electron 32); falls back to
  // the legacy property so older builds keep working.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (_e) { return (file && file.path) || ''; }
  },
  // Pull copied files / a screenshot off the Windows clipboard (WSLg can't see
  // them in the renderer). Returns an array of Windows paths, possibly empty.
  grabClipboard: () => ipcRenderer.invoke('clipboard:grab'),
  gitInfo: (args) => ipcRenderer.invoke('git:info', args),
  setNativeTheme: (mode) => ipcRenderer.send('theme:native', mode),
  // Text zoom. action: 'in' | 'out' | 'reset' | 'set' (with value). Returns the
  // new zoom level. onZoom fires whenever the level changes (incl. accelerators).
  zoom: (action, value) => ipcRenderer.invoke('zoom', { action, value }),
  onZoom: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('zoom:changed', fn);
    return () => ipcRenderer.removeListener('zoom:changed', fn);
  },
  // Saved theme passed via additionalArguments — read synchronously so the
  // renderer can theme the chrome before the first paint.
  initialTheme: (process.argv.find((a) => a.startsWith('--hydra-theme=')) || '').split('=')[1] || 'dark',

  // Custom title-bar window controls.
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('win:close'),
  // Manual title-bar dragging (WSLg swallows mouse events on -webkit-app-region
  // drag regions, so we move the window ourselves from screen-coord deltas).
  dragStart: (x, y) => ipcRenderer.send('win:drag-start', { x, y }),
  dragMove: (x, y) => ipcRenderer.send('win:drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('win:drag-end'),
  onWindowState: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('win:state', fn);
    return () => ipcRenderer.removeListener('win:state', fn);
  },

  onFocusPane: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('focus-pane', fn);
    return () => ipcRenderer.removeListener('focus-pane', fn);
  },

  onData: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:data', fn);
    return () => ipcRenderer.removeListener('pty:data', fn);
  },
  onExit: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('pty:exit', fn);
    return () => ipcRenderer.removeListener('pty:exit', fn);
  },
});
