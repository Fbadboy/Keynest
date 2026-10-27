'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('keynest', {
  status: () => invoke('vault:status'),
  create: (password) => invoke('vault:create', password),
  unlock: (password) => invoke('vault:unlock', password),
  unlockBiometric: () => invoke('vault:unlock-biometric'),
  lock: () => invoke('vault:lock'),
  touch: () => invoke('vault:touch'),
  setBiometric: (enabled) => invoke('vault:biometric', enabled),
  changePassword: (payload) => invoke('vault:change-password', payload),

  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),

  snapshot: () => invoke('data:snapshot'),

  createFolder: (payload) => invoke('folder:create', payload),
  renameFolder: (payload) => invoke('folder:rename', payload),
  deleteFolder: (payload) => invoke('folder:delete', payload),

  createEntry: (payload) => invoke('entry:create', payload),
  updateEntry: (payload) => invoke('entry:update', payload),
  deleteEntry: (payload) => invoke('entry:delete', payload),

  copy: (payload) => invoke('clipboard:write', payload),

  onLocked: (callback) => {
    ipcRenderer.on('vault:locked', (_event, payload) => callback(payload || {}));
  },
});
