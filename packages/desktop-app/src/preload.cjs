const { contextBridge, ipcRenderer } = require('electron')

const initInfo = ipcRenderer.sendSync('desktop:get-init') || {}

contextBridge.exposeInMainWorld('allinoneDesktop', {
  isDesktop: true,
  platform: initInfo.platform || process.platform,
  version: initInfo.version || '0.3.3',
  defaultServerUrl: initInfo.defaultServerUrl || '',
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  syncAccount: (account) => ipcRenderer.invoke('bridge:sync-account', account),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  toggleBridge: () => ipcRenderer.invoke('bridge:toggle'),
  toggleAutoLaunch: () => ipcRenderer.invoke('desktop:toggle-auto-launch'),
  openLog: () => ipcRenderer.invoke('bridge:open-log'),
  onBridgeStatus: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, payload) => {
      try { callback(payload) } catch {}
    }
    ipcRenderer.on('bridge:status-changed', handler)
    return () => ipcRenderer.removeListener('bridge:status-changed', handler)
  },
  onMenuAction: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, action) => {
      try { callback(action) } catch {}
    }
    ipcRenderer.on('desktop:menu-action', handler)
    return () => ipcRenderer.removeListener('desktop:menu-action', handler)
  },
})
