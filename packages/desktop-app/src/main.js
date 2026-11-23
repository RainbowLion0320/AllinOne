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
  protocol,
  shell,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const bridgeManager = new DesktopBridgeManager({
  isPackaged: app.isPackaged,
  getAutoLaunch: getAutoLaunchEnabled,
})

const devUpdateApiUrl = !app.isPackaged
  ? String(process.env.ALLINONE_UPDATE_API_URL || '').trim()
  : ''

const updater = new DesktopUpdater({
  currentVersion: app.getVersion(),
  downloadDir: join(app.getPath('temp'), 'allinone-updates'),
  ...(devUpdateApiUrl ? { apiUrl: devUpdateApiUrl, allowLocalhost: true } : {}),
})

function loadWindowBounds() {
  try {
    const p = join(app.getPath('userData'), 'window-bounds.json')
    if (existsSync(p)) {
      const b = JSON.parse(readFileSync(p, 'utf8'))
      if (Number.isFinite(b.width) && Number.isFinite(b.height)) {
        return {
          width: Math.max(760, Math.min(2400, Math.round(b.width))),
          height: Math.max(560, Math.min(1600, Math.round(b.height))),
          ...(Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: Math.round(b.x), y: Math.round(b.y) } : {}),
        }
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
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendMenuAction(action) {
  showMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:menu-action', action)
  }
}

function createMainWindow() {
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
    win.show()
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

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://allinone/')) {
      event.preventDefault()
      try {
        const u = new URL(url)
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          void shell.openExternal(url)
        }
      } catch {}
    }
  })

  const devUrl = String(process.env.ALLINONE_DESKTOP_DEV_URL || '').trim()
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
      ? `● 本机在线 · ${st.label}`
      : st.state === 'starting' || st.state === 'binding'
        ? `◐ 连接中 · ${st.label}`
        : st.state === 'paused'
          ? `○ 本机桥接已暂停`
          : st.state === 'error'
            ? `✕ 桥接异常`
            : `○ 未登录账号`

  tray.setToolTip(`All in One — ${stateLabel}`)

  const menu = Menu.buildFromTemplate([
    { label: stateLabel, enabled: false },
    ...(st.autofixText ? [{ label: `↻ ${st.autofixText}`, enabled: false }] : []),
    ...(st.username ? [{ label: `账号：@${st.username}`, enabled: false }] : []),
    { type: 'separator' },
    { label: '打开 All in One', click: () => showMainWindow() },
    { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
    { label: '切换电脑', accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('devices') },
    { label: '设置...', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
    {
      label:
        updater.getState().status === 'available' || updater.getState().status === 'downloaded'
          ? `发现新版本 v${updater.getState().latestVersion}`
          : '检查更新...',
      click: () => {
        sendMenuAction('settings')
        if (updater.getState().status !== 'downloading') {
          void updater.checkForUpdates()
        }
      },
    },
    { type: 'separator' },
    {
      label: st.enabled ? '暂停本机远程桥接' : '开启本机远程桥接',
      click: () => {
        void bridgeManager.toggleEnabled()
      },
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: getAutoLaunchEnabled(),
      click: (item) => {
        setAutoLaunchEnabled(item.checked)
        bridgeManager.emitStatus()
        refreshTrayMenu()
      },
    },
    {
      label: '查看桥接日志',
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
      label: '退出 All in One',
      click: () => {
        isQuitting = true
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
              { role: 'about', label: '关于 All in One' },
              {
                label: '检查更新...',
                click: () => {
                  sendMenuAction('settings')
                  void updater.checkForUpdates()
                },
              },
              { type: 'separator' },
              { label: '设置...', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 All in One' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              {
                label: '退出 All in One',
                accelerator: 'CmdOrCtrl+Q',
                click: () => {
                  isQuitting = true
                  app.quit()
                },
              },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-chat') },
        { label: '切换电脑', accelerator: 'CmdOrCtrl+K', click: () => sendMenuAction('devices') },
        { label: '设置...', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') },
        {
          label: '检查更新...',
          click: () => {
            sendMenuAction('settings')
            void updater.checkForUpdates()
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerStaticProtocol() {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url)
      let reqPath = decodeURIComponent(url.pathname || '/')
      if (!reqPath || reqPath === '/') reqPath = '/index.html'
      const normalized = normalize(reqPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
      let target = resolve(RENDERER_DIR, normalized)
      if (!target.startsWith(RENDERER_DIR + sep) && target !== RENDERER_DIR) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(target)) {
        target = join(RENDERER_DIR, 'index.html')
      }
      const buf = readFileSync(target)
      const mime = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream'
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': mime },
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
    }
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
        try { await bridgeManager.dispose() } catch {}
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

    refreshTrayMenu()
    createMainWindow()

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

  app.on('before-quit', async (e) => {
    if (isQuitting) return
    isQuitting = true
    e.preventDefault()
    try {
      await bridgeManager.dispose()
    } catch {}
    app.quit()
  })
}
