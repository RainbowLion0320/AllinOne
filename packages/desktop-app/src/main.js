/**
 * All in One Desktop — Electron Main Process
 *
 * Combines:
 *  1. Full Desktop Control UI (dual-pane layout, keyboard shortcuts, controls ALL PCs in your account)
 *  2. Built-in PC Bridge running seamlessly in the background (zero terminal commands, zero Node install)
 *  3. Native macOS Menu Bar / Windows System Tray + Close-to-Tray + Launch-at-Login
 */

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  shell,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopBridgeManager } from './bridge-manager.js'
import { DesktopUpdater } from './updater.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(__dirname, '..')
const RENDERER_DIR = join(APP_ROOT, 'renderer')
const BUILD_DIR = join(APP_ROOT, 'build')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// Register fixed secure custom scheme `app://allinone` so localStorage & IndexedDB persist across launches
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function readRuntimeConfig() {
  try {
    const p = join(APP_ROOT, 'runtime-config.json')
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  } catch {}
  return {}
}

const runtimeConfig = readRuntimeConfig()
const DEFAULT_SERVER_URL = String(
  process.env.ALLINONE_SERVER ||
  process.env.PUBLIC_RELAY_URL ||
  process.env.VITE_RELAY_URL ||
  runtimeConfig.defaultServerUrl ||
  '',
).trim().replace(/\/+$/, '')

let mainWindow = null
let tray = null
let isQuitting = false
let isDisposed = false
let disposePromise = null
let quitAfterDisposeScheduled = false

function normalizeLang(input) {
  const raw = String(input || '').trim().toLowerCase()
  if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en_')) return 'en'
  if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh_')) return 'zh'
  return ''
}

function loadSavedLangPref() {
  try {
    const p = join(app.getPath('userData'), 'prefs.json')
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      const norm = normalizeLang(parsed?.lang)
      if (norm) return norm
    }
  } catch {}
  try {
    return normalizeLang(app.getLocale()) || 'zh'
  } catch {
    return 'zh'
  }
}

function saveLangPref(lang) {
  const norm = normalizeLang(lang) || 'zh'
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'prefs.json')
    let cur = {}
    try {
      if (existsSync(p)) cur = JSON.parse(readFileSync(p, 'utf8')) || {}
    } catch {}
    writeFileSync(p, JSON.stringify({ ...cur, lang: norm }, null, 2), 'utf8')
  } catch {}
  return norm
}

let currentLang = 'zh'
function bi(zh, en) {
  return currentLang === 'en' ? en : zh
}

function getAutoLaunchEnabled() {
  try {
    return Boolean(app.getLoginItemSettings()?.openAtLogin)
  } catch {
    return false
  }
}

function setAutoLaunchEnabled(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: process.platform === 'darwin',
    })
  } catch {}
  return getAutoLaunchEnabled()
}

const desktopSecretStore = {
  isAvailable() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.())
    } catch {
      return false
    }
  },
  encrypt(plaintext) {
    if (!this.isAvailable()) return ''
    return safeStorage.encryptString(String(plaintext)).toString('base64')
  },
  decrypt(base64Cipher) {
    if (!this.isAvailable() || !base64Cipher) return ''
    return safeStorage.decryptString(Buffer.from(String(base64Cipher), 'base64'))
  },
}

const bridgeManager = new DesktopBridgeManager({
  isPackaged: app.isPackaged,
  getAutoLaunch: getAutoLaunchEnabled,
  secretStore: desktopSecretStore,
})

function disposeBridgeOnce() {
  if (isDisposed) return Promise.resolve()
  if (!disposePromise) {
    disposePromise = Promise.resolve()
      .then(() => bridgeManager.dispose())
      .catch(() => {})
      .finally(() => {
        isDisposed = true
      })
  }
  return disposePromise
}

const devUpdateApiUrl = !app.isPackaged
  ? String(process.env.ALLINONE_UPDATE_API_URL || '').trim()
  : ''

const updater = new DesktopUpdater({
  currentVersion: app.getVersion(),
  downloadDir: join(app.getPath('userData'), 'updates'),
  getLang: () => currentLang,
  ...(devUpdateApiUrl ? { apiUrl: devUpdateApiUrl, allowLocalhost: true } : {}),
})

function isBoundsVisibleOnAnyDisplay(bounds) {
  try {
    const displays = screen.getAllDisplays()
    if (!Array.isArray(displays) || displays.length === 0) return true
    const minVisible = 40
    return displays.some((d) => {
      const wa = d?.workArea
      if (!wa) return false
      const overlapX = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x)
      const overlapY = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y)
      return overlapX >= minVisible && overlapY >= minVisible
    })
  } catch {
    return true
  }
}

function loadWindowBounds() {
  try {
    const p = join(app.getPath('userData'), 'window-bounds.json')
    if (existsSync(p)) {
      const b = JSON.parse(readFileSync(p, 'utf8'))
      if (Number.isFinite(b.width) && Number.isFinite(b.height)) {
        const width = Math.max(760, Math.min(2400, Math.round(b.width)))
        const height = Math.max(560, Math.min(1600, Math.round(b.height)))
        const result = { width, height }
        if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
          const candidate = { x: Math.round(b.x), y: Math.round(b.y), width, height }
          if (isBoundsVisibleOnAnyDisplay(candidate)) {
            result.x = candidate.x
            result.y = candidate.y
          }
        }
        return result
      }
    }
  } catch {}
  return { width: 1180, height: 780 }
}

function saveWindowBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'window-bounds.json'), JSON.stringify(win.getBounds()), 'utf8')
  } catch {}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ showOnReady: true })
    if (process.platform === 'darwin') {
      try { app.focus({ steal: true }) } catch {}
    }
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') {
    try { app.focus({ steal: true }) } catch {}
  }
}

function sendMenuAction(action) {
  const wasMissing = !mainWindow || mainWindow.isDestroyed()
  showMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  const targetWin = mainWindow
  if (wasMissing || targetWin.webContents.isLoading()) {
    targetWin.webContents.once('did-finish-load', () => {
      if (!targetWin.isDestroyed()) {
        targetWin.webContents.send('desktop:menu-action', action)
      }
    })
  } else {
    targetWin.webContents.send('desktop:menu-action', action)
  }
}

function createMainWindow({ showOnReady = true } = {}) {
  const bounds = loadWindowBounds()
  const iconPath = join(BUILD_DIR, 'icon.png')

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 560,
    title: 'All in One',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: '#16171A',
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {
          autoHideMenuBar: true,
        }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })

  mainWindow = win

  win.once('ready-to-show', () => {
    if (!showOnReady) return
    win.show()
    if (process.platform === 'darwin') {
      try { app.focus({ steal: true }) } catch {}
    }
  })

  // Keep local PC bridge alive when closing window (hide to tray instead of quitting)
  win.on('close', (e) => {
    saveWindowBounds(win)
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('resized', () => saveWindowBounds(win))
  win.on('moved', () => saveWindowBounds(win))

  // Open external http/https links in the system browser, never inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {}
    return { action: 'deny' }
  })

  const devUrl = String(process.env.ALLINONE_DESKTOP_DEV_URL || '').trim()
  let devOrigin = ''
  if (devUrl) {
    try {
      devOrigin = new URL(devUrl).origin
    } catch {}
  }

  win.webContents.on('will-navigate', (event, url) => {
    let allowed = url.startsWith('app://allinone/')
    if (!allowed && devOrigin) {
      try {
        if (new URL(url).origin === devOrigin) allowed = true
      } catch {}
    }
    if (!allowed) {
      event.preventDefault()
      try {
        const u = new URL(url)
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          void shell.openExternal(url)
        }
      } catch {}
    }
  })

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadURL('app://allinone/index.html')
  }

  return win
}

function createTrayIcon() {
  if (process.platform === 'darwin') {
    const tplPath = join(BUILD_DIR, 'trayTemplate.png')
    if (existsSync(tplPath)) {
      const img = nativeImage.createFromPath(tplPath)
      img.setTemplateImage(true)
      return img
    }
  }
  const winIcon = join(BUILD_DIR, 'tray-icon.png')
  if (existsSync(winIcon)) {
    return nativeImage.createFromPath(winIcon)
  }
  const fallback = join(BUILD_DIR, 'icon.png')
  return nativeImage.createFromPath(fallback).resize({ width: 18, height: 18 })
}

function refreshTrayMenu() {
  if (!tray) return
  const st = bridgeManager.getStatus()
  const stateLabel =
    st.state === 'connected'
      ? bi(`● 本机在线 · ${st.label}`, `● Local PC Online · ${st.label}`)
      : st.state === 'starting' || st.state === 'binding'
        ? bi(`◐ 连接中 · ${st.label}`, `◐ Connecting · ${st.label}`)
        : st.state === 'paused'
          ? bi('○ 本机桥接已暂停', '○ Local Bridge Paused')
          : st.state === 'error'
            ? bi('✕ 桥接异常', '✕ Bridge Error')
            : bi('○ 未登录账号', '○ Not Signed In')

  tray.setToolTip(`All in One — ${stateLabel}`)

  const updState = updater.getState()
  const menu = Menu.buildFromTemplate([
    { label: stateLabel, enabled: false },
    ...(st.autofixText ? [{ label: `↻ ${st.autofixText}`, enabled: false }] : []),
    ...(st.username ? [{ label: bi(`账号：@${st.username}`, `Account: @${st.username}`), enabled: false }] : []),
    { type: 'separator' },
    { label: bi('打开 All in One', 'Open All in One'), click: () => showMainWindow() },
    { label: bi('新建对话', 'New Chat'), accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
    { label: bi('切换电脑', 'Switch Computer'), accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('devices') },
    { label: bi('设置...', 'Settings...'), accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
    {
      label:
        updState.status === 'available' || updState.status === 'downloaded'
          ? bi(`发现新版本 v${updState.latestVersion}`, `Update Available (v${updState.latestVersion})`)
          : bi('检查更新...', 'Check for Updates...'),
      click: () => {
        sendMenuAction('settings')
        const curStatus = updater.getState().status
        if (curStatus !== 'downloading' && curStatus !== 'downloaded' && curStatus !== 'installing') {
          void updater.checkForUpdates()
        }
      },
    },
    { type: 'separator' },
    {
      label: st.enabled
        ? bi('暂停本机远程桥接', 'Pause Local Bridge')
        : bi('开启本机远程桥接', 'Enable Local Bridge'),
      click: () => {
        void bridgeManager.toggleEnabled()
      },
    },
    {
      label: bi('开机自动启动', 'Launch at Login'),
      type: 'checkbox',
      checked: getAutoLaunchEnabled(),
      click: (item) => {
        setAutoLaunchEnabled(item.checked)
        bridgeManager.emitStatus()
        refreshTrayMenu()
      },
    },
    {
      label: bi('查看桥接日志', 'Open Bridge Logs'),
      click: () => {
        bridgeManager.ensureStateDir()
        if (existsSync(bridgeManager.logPath)) {
          void shell.openPath(bridgeManager.logPath)
        } else {
          void shell.openPath(bridgeManager.stateDir)
        }
      },
    },
    { type: 'separator' },
    {
      label: bi('退出 All in One', 'Quit All in One'),
      click: () => {
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: bi('关于 All in One', 'About All in One') },
              {
                label: bi('检查更新...', 'Check for Updates...'),
                click: () => {
                  sendMenuAction('settings')
                  const curStatus = updater.getState().status
                  if (curStatus !== 'downloading' && curStatus !== 'downloaded' && curStatus !== 'installing') {
                    void updater.checkForUpdates()
                  }
                },
              },
              { type: 'separator' },
              { label: bi('设置...', 'Settings...'), accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
              { type: 'separator' },
              { role: 'hide', label: bi('隐藏 All in One', 'Hide All in One') },
              { role: 'hideOthers', label: bi('隐藏其他', 'Hide Others') },
              { role: 'unhide', label: bi('显示全部', 'Show All') },
              { type: 'separator' },
              {
                label: bi('退出 All in One', 'Quit All in One'),
                accelerator: 'CmdOrCtrl+Q',
                click: () => {
                  app.quit()
                },
              },
            ],
          },
        ]
      : []),
    {
      label: bi('文件', 'File'),
      submenu: [
        { label: bi('新建对话', 'New Chat'), accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
        { label: bi('切换电脑', 'Switch Computer'), accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('devices') },
        { label: bi('设置...', 'Settings...'), accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
        {
          label: bi('检查更新...', 'Check for Updates...'),
          click: () => {
            sendMenuAction('settings')
            const curStatus = updater.getState().status
            if (curStatus !== 'downloading' && curStatus !== 'downloaded' && curStatus !== 'installing') {
              void updater.checkForUpdates()
            }
          },
        },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: bi('关闭窗口', 'Close Window') }
          : { role: 'quit', label: bi('退出', 'Quit') },
      ],
    },
    {
      label: bi('编辑', 'Edit'),
      submenu: [
        { role: 'undo', label: bi('撤销', 'Undo') },
        { role: 'redo', label: bi('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: bi('剪切', 'Cut') },
        { role: 'copy', label: bi('拷贝', 'Copy') },
        { role: 'paste', label: bi('粘贴', 'Paste') },
        { role: 'selectAll', label: bi('全选', 'Select All') },
      ],
    },
    {
      label: bi('视图', 'View'),
      submenu: [
        { role: 'reload', label: bi('重新加载', 'Reload') },
        { role: 'toggleDevTools', label: bi('开发者工具', 'Developer Tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: bi('实际大小', 'Actual Size') },
        { role: 'zoomIn', label: bi('放大', 'Zoom In') },
        { role: 'zoomOut', label: bi('缩小', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: bi('进入全屏幕', 'Toggle Full Screen') },
      ],
    },
    {
      label: bi('窗口', 'Window'),
      submenu: [
        { role: 'minimize', label: bi('最小化', 'Minimize') },
        { role: 'zoom', label: bi('缩放', 'Zoom') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerStaticProtocol() {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'allinone') {
        return new Response('Not Found', { status: 404 })
      }
      let reqPath = decodeURIComponent(url.pathname || '/')
      if (!reqPath || reqPath === '/') reqPath = '/index.html'
      const normalized = normalize(reqPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
      let target = resolve(RENDERER_DIR, normalized)
      if (!target.startsWith(RENDERER_DIR + sep) && target !== RENDERER_DIR) {
        return new Response('Forbidden', { status: 403 })
      }
      let isFile = false
      try {
        isFile = existsSync(target) && statSync(target).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) {
        if (extname(reqPath) === '') {
          target = join(RENDERER_DIR, 'index.html')
          if (!existsSync(target) || !statSync(target).isFile()) {
            return new Response('Not Found', { status: 404 })
          }
        } else {
          return new Response('Not Found', { status: 404 })
        }
      }
      const buf = readFileSync(target)
      const mime = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream'
      const headers = {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
      }
      if (extname(target).toLowerCase() === '.html') {
        headers['Content-Security-Policy'] =
          "default-src 'self' app:; script-src 'self' app:; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data: blob: https: http:; font-src 'self' app: data:; connect-src 'self' app: https: http: ws: wss:; object-src 'none'; base-uri 'self'"
      }
      return new Response(buf, {
        status: 200,
        headers,
      })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}

function registerIpc() {
  ipcMain.on('desktop:get-init', (event) => {
    event.returnValue = {
      platform: process.platform,
      version: app.getVersion(),
      defaultServerUrl: DEFAULT_SERVER_URL,
      lang: currentLang,
    }
  })

  ipcMain.handle('desktop:set-language', (_event, lang) => {
    const next = saveLangPref(lang)
    if (next !== currentLang) {
      currentLang = next
      buildAppMenu()
      refreshTrayMenu()
    }
    return currentLang
  })

  ipcMain.handle('bridge:status', () => bridgeManager.getStatus())

  ipcMain.handle('bridge:sync-account', async (_event, account) => {
    return bridgeManager.syncAccount(account)
  })

  ipcMain.handle('bridge:stop', async () => {
    return bridgeManager.stop({ nextState: 'idle' })
  })

  ipcMain.handle('bridge:toggle', async () => {
    return bridgeManager.toggleEnabled()
  })

  ipcMain.handle('bridge:e2ee-get', (_event, roomId) => {
    return bridgeManager.getE2eeInfo(roomId)
  })

  ipcMain.handle('bridge:e2ee-set', async (_event, roomId, key) => {
    return bridgeManager.setE2eeKey(roomId, key)
  })

  ipcMain.handle('bridge:e2ee-rotate', async (_event, roomId) => {
    return bridgeManager.rotateE2eeKey(roomId)
  })

  ipcMain.handle('desktop:toggle-auto-launch', () => {
    const next = !getAutoLaunchEnabled()
    setAutoLaunchEnabled(next)
    bridgeManager.emitStatus()
    refreshTrayMenu()
    return bridgeManager.getStatus()
  })

  ipcMain.handle('bridge:open-log', () => {
    bridgeManager.ensureStateDir()
    if (existsSync(bridgeManager.logPath)) {
      return shell.openPath(bridgeManager.logPath)
    }
    return shell.openPath(bridgeManager.stateDir)
  })

  ipcMain.handle('updater:state', () => updater.getState())
  ipcMain.handle('updater:check', () => updater.checkForUpdates({ silent: false }))
  ipcMain.handle('updater:download', () => updater.downloadUpdate())
  ipcMain.handle('updater:cancel', () => updater.cancelDownload())
  ipcMain.handle('updater:install', async () => {
    return updater.installAndRestart({
      exePath: app.getPath('exe'),
      pid: process.pid,
      isPackaged: app.isPackaged,
      openExternalPath: (p) => shell.openPath(p),
      onQuit: async () => {
        isQuitting = true
        await disposeBridgeOnce()
        app.quit()
      },
    })
  })
}

// Single-instance guard
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    app.setName('All in One')
    currentLang = loadSavedLangPref()
    registerStaticProtocol()
    registerIpc()
    buildAppMenu()

    tray = new Tray(createTrayIcon())
    tray.on('click', () => {
      if (process.platform !== 'darwin') {
        showMainWindow()
      }
    })
    tray.on('double-click', () => showMainWindow())

    bridgeManager.on('status', (st) => {
      refreshTrayMenu()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge:status-changed', st)
      }
    })

    updater.on('state', (st) => {
      refreshTrayMenu()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:state-changed', st)
      }
    })

    const onSystemResume = () => {
      if (isQuitting) return
      void bridgeManager.handleSystemResume()
    }
    powerMonitor.on('resume', onSystemResume)
    powerMonitor.on('unlock-screen', onSystemResume)

    refreshTrayMenu()
    let openedAsHidden = false
    if (process.platform === 'darwin') {
      try {
        openedAsHidden = Boolean(app.getLoginItemSettings()?.wasOpenedAsHidden)
      } catch {}
    }
    createMainWindow({ showOnReady: !openedAsHidden })

    // Immediately resume background bridge if this PC already has an account binding
    void bridgeManager.startFromSavedConfigIfPresent()

    // Quietly check GitHub Releases for a newer version shortly after startup
    const startupCheckTimer = setTimeout(() => {
      if (!isQuitting) {
        void updater.checkForUpdates({ silent: true })
      }
    }, 8_000)
    startupCheckTimer.unref?.()
  })

  app.on('activate', () => {
    showMainWindow()
  })

  app.on('before-quit', (e) => {
    isQuitting = true
    if (isDisposed) return
    e.preventDefault()
    if (!quitAfterDisposeScheduled) {
      quitAfterDisposeScheduled = true
      void disposeBridgeOnce().finally(() => {
        app.quit()
      })
    }
  })
}
