const { contextBridge, ipcRenderer } = require('electron')

const initInfo = ipcRenderer.sendSync('desktop:get-init') || {}

contextBridge.exposeInMainWorld('allinoneDesktop', {
  isDesktop: true,
  platform: initInfo.platform || process.platform,
  hostname: initInfo.hostname || '',
  clientUid: initInfo.clientUid || '',
  version: initInfo.version || '1.0.16',
  defaultServerUrl: initInfo.defaultServerUrl || '',
  initialLang: initInfo.lang || '',
  setLanguage: (lang) => ipcRenderer.invoke('desktop:set-language', lang),
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  syncAccount: (account) => ipcRenderer.invoke('bridge:sync-account', account),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  toggleBridge: () => ipcRenderer.invoke('bridge:toggle'),
  getE2eeInfo: (roomId) => ipcRenderer.invoke('bridge:e2ee-get', roomId),
  setE2eeKey: (roomId, key) => ipcRenderer.invoke('bridge:e2ee-set', roomId, key),
  rotateE2eeKey: (roomId) => ipcRenderer.invoke('bridge:e2ee-rotate', roomId),
  toggleAutoLaunch: () => ipcRenderer.invoke('desktop:toggle-auto-launch'),
  openLog: () => ipcRenderer.invoke('bridge:open-log'),
  openDeliverable: (filePath, cwd) => ipcRenderer.invoke('desktop:open-deliverable', filePath, cwd),
  revealDeliverable: (filePath, cwd) => ipcRenderer.invoke('desktop:reveal-deliverable', filePath, cwd),
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
