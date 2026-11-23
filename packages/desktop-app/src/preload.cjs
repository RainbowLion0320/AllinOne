const { contextBridge, ipcRenderer } = require('electron')

const initInfo = ipcRenderer.sendSync('desktop:get-init') || {}

contextBridge.exposeInMainWorld('allinoneDesktop', {
  isDesktop: true,
  platform: initInfo.platform || process.platform,
  version: initInfo.version || '0.3.9',
  defaultServerUrl: initInfo.defaultServerUrl || '',
  initialLang: initInfo.lang || '',
  setLanguage: (lang) => ipcRenderer.invoke('desktop:set-language', lang),
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  syncAccount: (account) => ipcRenderer.invoke('bridge:sync-account', account),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  toggleBridge: () => ipcRenderer.invoke('bridge:toggle'),
  toggleAutoLaunch: () => ipcRenderer.invoke('desktop:toggle-auto-launch'),
  openLog: () => ipcRenderer.invoke('bridge:open-log'),
  getUpdateState: () => ipcRenderer.invoke('updater:state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('updater:cancel'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, payload) => {
      try { callback(payload) } catch {}
    }
    ipcRenderer.on('updater:state-changed', handler)
    return () => ipcRenderer.removeListener('updater:state-changed', handler)
  },
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
