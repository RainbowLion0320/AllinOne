const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('allinoneWebrtcWorker', {
  sendControl: (msg) => ipcRenderer.send('webrtc-worker:control', msg),
  sendBinary: (peerId, role, bytes) => ipcRenderer.send('webrtc-worker:binary', { peerId, role, bytes }),
  onCommand: (fn) => {
    const listener = (_ev, cmd) => fn(cmd)
    ipcRenderer.on('webrtc-worker:cmd', listener)
    return () => ipcRenderer.removeListener('webrtc-worker:cmd', listener)
  },
  onBinary: (fn) => {
    const listener = (_ev, payload) => {
      if (payload?.bytes) fn(payload.peerId, payload.role, payload.bytes)
    }
    ipcRenderer.on('webrtc-worker:send-binary', listener)
    return () => ipcRenderer.removeListener('webrtc-worker:send-binary', listener)
  },
})
