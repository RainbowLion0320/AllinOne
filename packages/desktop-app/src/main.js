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
  session,
  shell,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SANDBOX_PREVIEW_CSP } from '@allinone/shared'
import { DesktopBridgeManager } from './bridge-manager.js'
import { DesktopUpdater } from './updater.js'
import { DesktopWebRtcProxy } from './webrtc-proxy.js'

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
    return normalizeLang(app.getLocale()) || 'en'
  } catch {
    return 'en'
  }
}

function saveLangPref(lang) {
  const norm = normalizeLang(lang) || 'en'
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

function loadOrCreateDesktopClientUid() {
  try {
    const dir = app.getPath('userData')
    const p = join(dir, 'prefs.json')
    let cur = {}
    try {
      if (existsSync(p)) cur = JSON.parse(readFileSync(p, 'utf8')) || {}
    } catch {}
    const existing = String(cur?.clientUid || '').trim()
    if (/^[a-zA-Z0-9._-]{8,64}$/.test(existing)) return existing
    const fresh = `cli_${randomBytes(12).toString('hex')}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify({ ...cur, clientUid: fresh }, null, 2), 'utf8')
    return fresh
  } catch {
    return ''
  }
}

let currentLang = 'en'
function bi(zh, en) {
  return currentLang === 'zh' ? zh : en
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
      if (!safeStorage?.isEncryptionAvailable?.()) return false
      if (
        typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text'
      ) {
        return false
      }
      return true
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

const webrtcProxy = new DesktopWebRtcProxy({
  BrowserWindow,
  ipcMain,
  srcDir: __dirname,
})

const bridgeManager = new DesktopBridgeManager({
  isPackaged: app.isPackaged,
  getAutoLaunch: getAutoLaunchEnabled,
  secretStore: desktopSecretStore,
  getWebRtcProxyInfo: () => (webrtcProxy.port > 0 ? { port: webrtcProxy.port, token: webrtcProxy.token } : null),
})

function disposeBridgeOnce() {
  if (isDisposed) return Promise.resolve()
  if (!disposePromise) {
    const work = (async () => {
      try {
        await bridgeManager.dispose()
      } catch {}
      try {
        await webrtcProxy.dispose()
      } catch {}
    })()
    let timeoutHandle = null
    const hardTimeout = new Promise((resolveTimeout) => {
      timeoutHandle = setTimeout(resolveTimeout, 6_000)
      timeoutHandle.unref?.()
    })
    disposePromise = Promise.race([work, hardTimeout]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
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

let boundsSaveTimer = null
function saveWindowBoundsNow(win) {
  if (boundsSaveTimer) {
    clearTimeout(boundsSaveTimer)
    boundsSaveTimer = null
  }
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'window-bounds.json'), JSON.stringify(win.getBounds()), 'utf8')
  } catch {}
}

function saveWindowBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    saveWindowBoundsNow(win)
  }, 300)
  boundsSaveTimer.unref?.()
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

function triggerCheckForUpdatesFromMenu() {
  sendMenuAction('settings')
  const curStatus = updater.getState().status
  if (curStatus !== 'downloading' && curStatus !== 'downloaded' && curStatus !== 'installing') {
    void updater.checkForUpdates()
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
    saveWindowBoundsNow(win)
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('resized', () => saveWindowBounds(win))
  win.on('moved', () => saveWindowBounds(win))

  // Recover gracefully from Chromium renderer crashes / hangs (capped to prevent crash loops)
  let crashReloads = 0
  let lastCrashAt = 0
  win.webContents.on('render-process-gone', (_ev, details) => {
    if (isQuitting || win.isDestroyed()) return
    const reason = String(details?.reason || 'gone')
    if (reason === 'clean-exit') return
    const now = Date.now()
    if (now - lastCrashAt > 60_000) crashReloads = 0
    lastCrashAt = now
    crashReloads += 1
    console.warn(`[desktop] renderer process ${reason} (attempt ${crashReloads})`)
    if (crashReloads <= 3) {
      setTimeout(() => {
        if (!isQuitting && !win.isDestroyed()) {
          void win.loadURL(devUrl || 'app://allinone/index.html').catch(() => {})
        }
      }, 600)
    }
  })
  win.on('unresponsive', () => {
    console.warn('[desktop] main window became unresponsive')
  })

  let devUrl = ''
  let devOrigin = ''
  if (!app.isPackaged) {
    const rawDevUrl = String(process.env.ALLINONE_DESKTOP_DEV_URL || '').trim()
    if (rawDevUrl) {
      try {
        const parsedDev = new URL(rawDevUrl)
        const host = parsedDev.hostname.toLowerCase()
        if (
          (parsedDev.protocol === 'http:' || parsedDev.protocol === 'https:') &&
          (host === '127.0.0.1' || host === 'localhost')
        ) {
          devUrl = parsedDev.toString()
          devOrigin = parsedDev.origin
        }
      } catch {}
    }
  }

  const isAllowedAppUrl = (url) => {
    const s = String(url || '')
    if (s === 'about:blank' || s.startsWith('app://allinone/')) return true
    if (devOrigin) {
      try {
        if (new URL(s).origin === devOrigin) return true
      } catch {}
    }
    return false
  }

  // Open external http/https links in the system browser, never inside Electron.
  // Sandboxed HTML preview iframes omit `allow-popups` (blocked by Chromium before reaching here);
  // also deny POST form popups and any sandbox-preview referrer as defense-in-depth.
  win.webContents.setWindowOpenHandler((details) => {
    const url = String(details?.url || '')
    const referrerUrl = String(details?.referrer?.url || '').toLowerCase()
    if (details?.postBody || referrerUrl.includes('sandbox-preview.html')) {
      return { action: 'deny' }
    }
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        void shell.openExternal(url)
      }
    } catch {}
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault()
      try {
        const u = new URL(url)
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          void shell.openExternal(url)
        }
      } catch {}
    }
  })

  // Also block subframe / sandboxed-iframe navigations away from our app origin (e.g. location.href or <form>)
  win.webContents.on('will-frame-navigate', (details) => {
    if (details?.isMainFrame) return
    if (!isAllowedAppUrl(details?.url)) {
      details.preventDefault()
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
      click: triggerCheckForUpdatesFromMenu,
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
                click: triggerCheckForUpdatesFromMenu,
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
          click: triggerCheckForUpdatesFromMenu,
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
        ...(!app.isPackaged || process.env.ALLINONE_DEBUG === '1'
          ? [{ role: 'toggleDevTools', label: bi('开发者工具', 'Developer Tools') }]
          : []),
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
  protocol.handle('app', async (request) => {
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
        isFile = (await stat(target)).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) {
        if (extname(reqPath) === '') {
          target = join(RENDERER_DIR, 'index.html')
          try {
            if (!(await stat(target)).isFile()) {
              return new Response('Not Found', { status: 404 })
            }
          } catch {
            return new Response('Not Found', { status: 404 })
          }
        } else {
          return new Response('Not Found', { status: 404 })
        }
      }
      const buf = await readFile(target)
      const mime = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream'
      const headers = {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
      }
      if (extname(target).toLowerCase() === '.html') {
        const isSandboxFrame = basename(target).toLowerCase() === 'sandbox-preview.html'
        headers['Content-Security-Policy'] = isSandboxFrame
          ? `sandbox allow-scripts allow-forms; ${SANDBOX_PREVIEW_CSP}`
          : "default-src 'self' app:; script-src 'self' app:; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data: blob: https:; font-src 'self' app: data:; connect-src 'self' app: https: http: ws: wss:; object-src 'none'; base-uri 'self'"
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

function assertTrustedIpcEvent(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event?.sender !== mainWindow.webContents ||
    event?.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Unauthorized IPC sender')
  }
}

function registerPermissionHandlers() {
  const ALLOWED_PERMISSIONS = new Set([
    'media',
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
  ])
  const isTrustedOrigin = (rawOrigin) => {
    try {
      const u = new URL(String(rawOrigin || ''))
      if (u.protocol === 'app:' && u.hostname === 'allinone') return true
      if (!app.isPackaged && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true
      return false
    } catch {
      return false
    }
  }
  const isAllowed = (webContents, permission, originCandidate, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false
    if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return false
    const secOrigin = String(details?.securityOrigin || originCandidate || '')
    const reqUrl = String(details?.requestingUrl || '')
    if (
      secOrigin === 'null' ||
      details?.isMainFrame === false ||
      reqUrl.toLowerCase().includes('sandbox-preview.html')
    ) {
      return false
    }
    return isTrustedOrigin(secOrigin || reqUrl || webContents?.getURL?.() || '')
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowed(webContents, permission, '', details))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return isAllowed(webContents, permission, requestingOrigin, details)
  })
}

function registerIpc() {
  const desktopClientUid = loadOrCreateDesktopClientUid()
  const desktopHostname = String(hostname() || '').trim().slice(0, 40)

  ipcMain.on('desktop:get-init', (event) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event?.sender !== mainWindow.webContents ||
      event?.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      event.returnValue = {}
      return
    }
    event.returnValue = {
      platform: process.platform,
      hostname: desktopHostname,
      clientUid: desktopClientUid,
      version: app.getVersion(),
      defaultServerUrl: DEFAULT_SERVER_URL,
      lang: currentLang,
    }
  })

  ipcMain.handle('desktop:set-language', (event, lang) => {
    assertTrustedIpcEvent(event)
    const next = saveLangPref(lang)
    if (next !== currentLang) {
      currentLang = next
      buildAppMenu()
      refreshTrayMenu()
    }
    return currentLang
  })

  ipcMain.handle('bridge:status', (event) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.getStatus()
  })

  ipcMain.handle('bridge:sync-account', async (event, account) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.syncAccount(account)
  })

  ipcMain.handle('bridge:stop', async (event) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.stop({ nextState: 'idle' })
  })

  ipcMain.handle('bridge:toggle', async (event) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.toggleEnabled()
  })

  ipcMain.handle('bridge:e2ee-get', (event, roomId) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.getE2eeInfo(roomId)
  })

  ipcMain.handle('bridge:e2ee-set', async (event, roomId, key) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.setE2eeKey(roomId, key)
  })

  ipcMain.handle('bridge:e2ee-rotate', async (event, roomId) => {
    assertTrustedIpcEvent(event)
    return bridgeManager.rotateE2eeKey(roomId)
  })

  ipcMain.handle('desktop:toggle-auto-launch', (event) => {
    assertTrustedIpcEvent(event)
    const next = !getAutoLaunchEnabled()
    setAutoLaunchEnabled(next)
    bridgeManager.emitStatus()
    refreshTrayMenu()
    return bridgeManager.getStatus()
  })

  ipcMain.handle('bridge:open-log', (event) => {
    assertTrustedIpcEvent(event)
    bridgeManager.ensureStateDir()
    if (existsSync(bridgeManager.logPath)) {
      return shell.openPath(bridgeManager.logPath)
    }
    return shell.openPath(bridgeManager.stateDir)
  })

  const SAFE_DELIVERABLE_EXTS = new Set([
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.csv',
    '.ppt',
    '.pptx',
    '.md',
    '.markdown',
    '.txt',
    '.rtf',
    '.epub',
    '.zip',
  ])
  const SAFE_REVEAL_DELIVERABLE_EXTS = new Set([
    ...SAFE_DELIVERABLE_EXTS,
    '.html',
    '.htm',
  ])
  const isSafeWindowsLocalPath = (candidate) =>
    !/^\\\\/.test(candidate) && /^[A-Za-z]:\\[^:]+$/.test(candidate)

  const resolveSafeDesktopDeliverable = (rawPath, cwd = '', { allowHtml = false } = {}) => {
    const allowedExts = allowHtml ? SAFE_REVEAL_DELIVERABLE_EXTS : SAFE_DELIVERABLE_EXTS
    let p = String(rawPath || '').trim()
    if (!p || p.includes('\0')) return { ok: false, error: '缺少文件路径' }
    if ((p.startsWith('<') && p.endsWith('>')) || (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1).trim()
    }
    if (/^file:\/\//i.test(p)) {
      p = p.replace(/[?#].*$/, '').replace(/^file:\/\/(?:localhost)?/i, '')
      try { p = decodeURIComponent(p) } catch {}
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = join(homedir(), p.slice(2))
    }
    if (process.platform === 'win32') {
      // Block Windows UNC paths (\\host\share) and device namespaces (\\?\, \\.\) to prevent NTLMv2 leaks & remote opens
      if (/^(?:\\\\|\/\/)/.test(p)) {
        return { ok: false, error: '出于安全限制，禁止直接打开网络共享 (UNC) 或设备路径' }
      }
      p = p.replace(/\//g, '\\')
      if (/^\\\\/.test(p)) {
        return { ok: false, error: '出于安全限制，禁止直接打开网络共享 (UNC) 或设备路径' }
      }
    }
    const baseDir = String(cwd || '').trim() || homedir()
    const resolved = isAbsolute(p) ? resolve(p) : resolve(baseDir, p)
    if (process.platform === 'win32' && !isSafeWindowsLocalPath(resolved)) {
      return { ok: false, error: '出于安全限制，仅允许打开本地磁盘上的交付文件' }
    }
    const ext = extname(resolved).toLowerCase()
    if (!allowedExts.has(ext)) {
      return { ok: false, error: `不支持直接打开该格式（${ext || '未知格式'}）` }
    }
    if (!existsSync(resolved)) {
      return { ok: false, error: `找不到本机文件：${resolved}` }
    }
    let realPath = ''
    try {
      realPath = realpathSync(resolved)
    } catch (err) {
      return { ok: false, error: `无法访问本机文件：${String(err?.message || err)}` }
    }
    if (process.platform === 'win32' && !isSafeWindowsLocalPath(realPath)) {
      return { ok: false, error: '出于安全限制，符号链接目标仅允许指向本地磁盘文件' }
    }
    const realExt = extname(realPath).toLowerCase()
    if (!allowedExts.has(realExt)) {
      return { ok: false, error: `符号链接目标格式不受支持（${realExt || '未知格式'}）` }
    }
    let isFile = false
    try {
      isFile = statSync(realPath).isFile()
    } catch (err) {
      return { ok: false, error: `无法读取文件信息：${String(err?.message || err)}` }
    }
    if (!isFile) {
      return { ok: false, error: '目标路径不是文件' }
    }
    // Constrain deliverable opens to cwd or user home/temp while blocking sensitive dot-directories & OS roots
    const isUnderDir = (candidate, root) => {
      if (!root) return false
      try {
        const rr = realpathSync(root)
        const normC = process.platform === 'win32' ? candidate.toLowerCase() : candidate
        const normR = process.platform === 'win32' ? rr.toLowerCase() : rr
        return normC === normR || normC.startsWith(normR + sep)
      } catch {
        return false
      }
    }
    const homeDir = homedir()
    const sensitiveSubdirs = [
      '.ssh',
      '.gnupg',
      '.aws',
      '.kube',
      '.allinone-bridge',
      '.dsh',
      '.codex',
      '.claude',
      '.workbuddy',
      '.codebuddy',
      '.gemini',
    ]
    for (const sub of sensitiveSubdirs) {
      if (isUnderDir(realPath, join(homeDir, sub))) {
        return { ok: false, error: '出于安全限制，禁止直接打开敏感配置目录中的文件' }
      }
    }
    const allowedRoots = [cwd ? String(cwd).trim() : '', homeDir, app.getPath('temp')].filter(Boolean)
    if (!allowedRoots.some((r) => isUnderDir(realPath, r))) {
      return { ok: false, error: '出于安全限制，仅允许打开工作区或用户目录内的交付文件' }
    }
    return { ok: true, realPath, ext: realExt }
  }

  ipcMain.handle('desktop:open-deliverable', async (event, rawPath, cwd = '') => {
    assertTrustedIpcEvent(event)
    const check = resolveSafeDesktopDeliverable(rawPath, cwd, { allowHtml: false })
    if (!check.ok) return check
    // Reveal archives in Finder/Explorer instead of auto-extracting untrusted .zip payloads
    if (check.ext === '.zip') {
      shell.showItemInFolder(check.realPath)
      return { ok: true, path: check.realPath, revealed: true }
    }
    const err = await shell.openPath(check.realPath)
    return err ? { ok: false, error: err } : { ok: true, path: check.realPath }
  })

  ipcMain.handle('desktop:reveal-deliverable', (event, rawPath, cwd = '') => {
    assertTrustedIpcEvent(event)
    const check = resolveSafeDesktopDeliverable(rawPath, cwd, { allowHtml: true })
    if (!check.ok) return check
    shell.showItemInFolder(check.realPath)
    return { ok: true, path: check.realPath }
  })

  ipcMain.handle('updater:state', (event) => {
    assertTrustedIpcEvent(event)
    return updater.getState()
  })
  ipcMain.handle('updater:check', (event) => {
    assertTrustedIpcEvent(event)
    return updater.checkForUpdates({ silent: false })
  })
  ipcMain.handle('updater:download', (event) => {
    assertTrustedIpcEvent(event)
    return updater.downloadUpdate()
  })
  ipcMain.handle('updater:cancel', (event) => {
    assertTrustedIpcEvent(event)
    return updater.cancelDownload()
  })
  ipcMain.handle('updater:install', async (event) => {
    assertTrustedIpcEvent(event)
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
    registerPermissionHandlers()
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

    // Start local loopback WebRTC proxy (lazy worker window, 0MB idle RAM) before creating UI or starting bridge
    try {
      await webrtcProxy.start()
    } catch (err) {
      console.warn('[desktop] WebRTC proxy failed to start (will fall back to werift):', err?.message || err)
    }

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

    // Quietly check GitHub Releases for a newer version shortly after startup,
    // then periodically every 4 hours so tray-resident users still get notified.
    const UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000
    const startupCheckTimer = setTimeout(() => {
      if (!isQuitting) {
        void updater.checkForUpdates({ silent: true })
      }
    }, 8_000)
    startupCheckTimer.unref?.()

    const periodicCheckTimer = setInterval(() => {
      if (isQuitting) return
      const st = updater.getState?.()
      if (st && (st.status === 'downloading' || st.status === 'downloaded' || st.status === 'installing')) return
      void updater.checkForUpdates({ silent: true })
    }, UPDATE_POLL_INTERVAL_MS)
    periodicCheckTimer.unref?.()

    app.once('before-quit', () => {
      clearTimeout(startupCheckTimer)
      clearInterval(periodicCheckTimer)
    })
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

  const handleExitSignal = () => {
    isQuitting = true
    void disposeBridgeOnce().finally(() => {
      app.quit()
    })
  }
  process.on('SIGINT', handleExitSignal)
  process.on('SIGTERM', handleExitSignal)
}
