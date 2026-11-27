/**
 * Embedded PC Bridge Lifecycle Manager for All in One Desktop App.
 *
 * Zero-terminal experience:
 *  - Reuses existing ~/.allinone-bridge/config.json if already bound to the same account & server
 *  - Otherwise auto-binds this PC via POST /api/account/devices/register using the logged-in JWT
 *  - Runs the bundled single-file bridge in an isolated child process using Electron's embedded Node runtime
 *    (zero Node.js installation required on the user's computer!)
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateE2eeKey, normalizeE2eeKey } from '@allinone/shared/e2ee'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_LOG_BYTES = 1024 * 1024 // 1 MB rolling cap
const MAX_STDIO_LINE_BUF = 64 * 1024
const RESTART_CIRCUIT_WINDOW_MS = 2 * 60 * 1000
const RESTART_CIRCUIT_MAX = 5
const RESTART_STABILITY_WINDOW_MS = 15_000
const GRACEFUL_QUIT_TIMEOUT_MS = 3_500

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '')
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function computeDesktopE2eeKeyId(rawKey) {
  const key = normalizeE2eeKey(rawKey)
  if (!key) return ''
  const rawBytes = Buffer.from(key, 'base64url')
  return createHash('sha256')
    .update('allinone-e2ee-v1-id:')
    .update(rawBytes)
    .digest('hex')
    .slice(0, 16)
}

const KEYCHAIN_DECRYPT_ERROR =
  '无法解密本机桥接配置与端到端密钥，请先解锁系统钥匙串后重试 (Unable to decrypt local bridge config; please unlock OS Keychain and retry)'

function isSecretStoreAvailable(secretStore) {
  if (!secretStore || typeof secretStore.encrypt !== 'function' || typeof secretStore.decrypt !== 'function') {
    return false
  }
  if (typeof secretStore.getSelectedStorageBackend === 'function') {
    try {
      if (secretStore.getSelectedStorageBackend() === 'basic_text') return false
    } catch {
      return false
    }
  }
  if (typeof secretStore.isAvailable === 'function') {
    try {
      return Boolean(secretStore.isAvailable())
    } catch {
      return false
    }
  }
  return true
}

export function saveConfigSecure(filePath, data, secretStore = null) {
  const payload = { ...data }
  const storeAvail = isSecretStoreAvailable(secretStore)
  if (payload.bridgeSecret) {
    let encrypted = false
    if (storeAvail) {
      try {
        const enc = secretStore.encrypt(String(payload.bridgeSecret))
        if (enc) {
          payload.bridgeSecretEnc = enc
          delete payload.bridgeSecret
          encrypted = true
        }
      } catch {}
    }
    if (!encrypted) {
      delete payload.bridgeSecretEnc
    }
  }
  if (payload.e2eeKey) {
    let encrypted = false
    if (storeAvail) {
      try {
        const enc = secretStore.encrypt(String(payload.e2eeKey))
        if (enc) {
          payload.e2eeKeyEnc = enc
          delete payload.e2eeKey
          encrypted = true
        }
      } catch {}
    }
    if (!encrypted) {
      delete payload.e2eeKeyEnc
    }
  }
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(tmpPath, 0o600) } catch {}
    renameSync(tmpPath, filePath)
    try { chmodSync(filePath, 0o600) } catch {}
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

export function loadConfigWithStatus(filePath, secretStore = null) {
  const raw = readJsonSafe(filePath)
  if (!raw || typeof raw !== 'object') {
    return { status: 'missing', config: null }
  }
  const out = { ...raw }
  const storeAvail = isSecretStoreAvailable(secretStore)
  let shouldMigrate = false

  if (out.bridgeSecretEnc && !out.bridgeSecret) {
    if (!storeAvail) {
      return { status: 'decrypt-error', config: null }
    }
    try {
      const dec = secretStore.decrypt(out.bridgeSecretEnc)
      if (!dec) return { status: 'decrypt-error', config: null }
      out.bridgeSecret = dec
    } catch {
      return { status: 'decrypt-error', config: null }
    }
  } else if (out.bridgeSecret && storeAvail) {
    shouldMigrate = true
  }

  if (out.e2eeKeyEnc && !out.e2eeKey) {
    if (!storeAvail) {
      return { status: 'decrypt-error', config: null }
    }
    try {
      const dec = secretStore.decrypt(out.e2eeKeyEnc)
      const norm = dec ? normalizeE2eeKey(dec) : ''
      if (!norm) return { status: 'decrypt-error', config: null }
      out.e2eeKey = norm
    } catch {
      return { status: 'decrypt-error', config: null }
    }
  } else if (out.e2eeKey) {
    out.e2eeKey = normalizeE2eeKey(out.e2eeKey)
    if (out.e2eeKey && storeAvail) shouldMigrate = true
  }

  // Auto-encrypt any plaintext credentials on disk into OS keychain / DPAPI storage
  if (shouldMigrate && storeAvail) {
    try {
      saveConfigSecure(filePath, out, secretStore)
    } catch {}
  }
  return { status: 'ok', config: out }
}

export function loadConfigDecrypted(filePath, secretStore = null) {
  const res = loadConfigWithStatus(filePath, secretStore)
  return res.status === 'ok' ? res.config : null
}

function resolveBridgeScriptPath(isPackaged) {
  const candidates = []
  if (isPackaged && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'bridge-runtime', 'allinone-bridge.mjs'))
  }
  candidates.push(
    join(__dirname, '..', 'bridge-runtime', 'allinone-bridge.mjs'),
    join(__dirname, '..', '..', 'mobile-app', 'public', 'downloads', 'allinone-bridge.mjs'),
  )
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('找不到内置桥接程序 (allinone-bridge.mjs)')
}

export class DesktopBridgeManager extends EventEmitter {
  constructor({ isPackaged = false, getAutoLaunch = () => false, secretStore = null, getWebRtcProxyInfo = null } = {}) {
    super()
    this.isPackaged = isPackaged
    this.getAutoLaunch = getAutoLaunch
    this.secretStore = secretStore
    this.getWebRtcProxyInfo = typeof getWebRtcProxyInfo === 'function' ? getWebRtcProxyInfo : null
    this.stateDir = join(os.homedir(), '.allinone-bridge')
    this.workspaceDir = join(os.homedir(), 'AllinOne-Workspace')
    this.configPath = join(this.stateDir, 'config.json')
    this.logPath = join(this.stateDir, 'desktop-bridge.log')

    this.proc = null
    this.killPromise = null
    this.restartTimer = null
    this.stabilityTimer = null
    this.restartAttempts = 0
    this.restartTimestamps = []
    this._logQueue = []
    this._flushingLog = false
    this.disposed = false
    this.authRevoked = false

    this.enabled = true
    this.state = 'idle' // 'idle' | 'binding' | 'starting' | 'connected' | 'paused' | 'error'
    this.error = ''
    this.activeAccount = null // { baseUrl, token, roomId, username }
    this.deviceMeta = null // { label, bridgeId, roomId, username, serverUrl }
    this.appsSummary = ''
    this.autofixText = ''
    this.syncSeq = 0
    this.spawnSeq = 0
  }

  ensureStateDir() {
    mkdirSync(this.stateDir, { recursive: true })
    try { chmodSync(this.stateDir, 0o700) } catch {}
  }

  ensureWorkspaceDir() {
    const dir = this.workspaceDir || join(os.homedir(), 'AllinOne-Workspace')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
    return existsSync(dir) ? dir : os.homedir()
  }

  clearStabilityTimer() {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
  }

  appendLog(line) {
    const entry = `[${new Date().toISOString()}] ${line}\n`
    if (this._logQueue.length < 256) {
      this._logQueue.push(entry)
    }
    if (!this._flushingLog) {
      this._flushingLog = true
      void this._flushLogQueue()
    }
  }

  async _flushLogQueue() {
    try {
      this.ensureStateDir()
      while (this._logQueue.length > 0) {
        const batch = this._logQueue.splice(0, 64).join('')
        try {
          const st = await stat(this.logPath).catch(() => null)
          if (st && st.size > MAX_LOG_BYTES) {
            const existing = await readFile(this.logPath, 'utf8').catch(() => '')
            await writeFile(this.logPath, existing.slice(-200_000), 'utf8')
          }
          await appendFile(this.logPath, batch, 'utf8')
        } catch {}
      }
    } catch {} finally {
      this._flushingLog = false
      if (this._logQueue.length > 0) {
        this._flushingLog = true
        void this._flushLogQueue()
      }
    }
  }

  getStatus() {
    return {
      state: this.state,
      enabled: this.enabled,
      autoLaunch: Boolean(this.getAutoLaunch?.()),
      secretStoreWarning: !isSecretStoreAvailable(this.secretStore),
      label: this.deviceMeta?.label || os.hostname() || 'My PC',
      bridgeId: this.deviceMeta?.bridgeId || '',
      username: this.deviceMeta?.username || this.activeAccount?.username || '',
      serverUrl: this.deviceMeta?.serverUrl || this.activeAccount?.baseUrl || '',
      e2eeKeyId: this.deviceMeta?.e2eeKeyId || '',
      appsSummary: this.appsSummary,
      autofixText: this.autofixText,
      error: this.error,
      logPath: this.logPath,
    }
  }

  emitStatus() {
    this.emit('status', this.getStatus())
  }

  async verifyExistingConfig(cfg) {
    if (!cfg?.serverUrl || !cfg?.roomId || !cfg?.bridgeSecret) return { valid: false, networkError: false }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const res = await fetch(`${normalizeBaseUrl(cfg.serverUrl)}/api/account/device-status`, {
        method: 'GET',
        headers: {
          'X-Room-Id': cfg.roomId,
          'X-Bridge-Secret': cfg.bridgeSecret,
        },
        signal: controller.signal,
      })
      if (res.status === 401) return { valid: false, networkError: false }
      if (!res.ok) return { valid: false, networkError: true }
      const data = await res.json().catch(() => ({}))
      return { valid: Boolean(data.ok), data, networkError: false }
    } catch {
      return { valid: false, networkError: true }
    } finally {
      clearTimeout(timer)
    }
  }

  async registerDeviceWithJwt({ baseUrl, token, existingBridgeId = '' }) {
    const label = os.hostname() || 'My-PC'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    timer.unref?.()
    let res
    try {
      res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/account/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          label,
          hostname: label,
          platform: process.platform,
          ...(existingBridgeId ? { bridgeId: existingBridgeId } : {}),
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok || !data.deviceSecret) {
      throw new Error(data.error || `自动绑定本机失败 (HTTP ${res.status})`)
    }
    return data
  }

  /**
   * Called automatically whenever Desktop UI signs into or switches an account.
   */
  async syncAccount(account) {
    if (this.disposed) return this.getStatus()
    const baseUrl = normalizeBaseUrl(account?.baseUrl)
    const token = String(account?.token || '').trim()
    const roomId = String(account?.roomId || '').trim()
    const username = String(account?.username || '').trim()

    if (!baseUrl || !token || !roomId.startsWith('usr_')) {
      await this.stop({ nextState: 'idle' })
      return this.getStatus()
    }

    const sameRunning =
      this.proc &&
      !this.proc.killed &&
      this.proc.exitCode === null &&
      !this.authRevoked &&
      this.deviceMeta?.roomId === roomId &&
      normalizeBaseUrl(this.deviceMeta?.serverUrl) === baseUrl &&
      this.enabled

    this.activeAccount = { baseUrl, token, roomId, username }
    if (sameRunning) {
      return this.getStatus()
    }

    if (!this.enabled) {
      this.state = 'paused'
      this.error = ''
      this.emitStatus()
      return this.getStatus()
    }

    const mySeq = ++this.syncSeq
    this.authRevoked = false
    this.restartAttempts = 0
    this.restartTimestamps = []
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.state = 'binding'
    this.error = ''
    this.emitStatus()

    try {
      this.ensureStateDir()
      const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
      if (cfgRes.status === 'decrypt-error') {
        if (mySeq !== this.syncSeq) return this.getStatus()
        this.state = 'error'
        this.error = KEYCHAIN_DECRYPT_ERROR
        this.appendLog(`syncAccount blocked: ${this.error}`)
        this.emitStatus()
        return this.getStatus()
      }
      const cfg = cfgRes.config
      let readyCfg = null

      if (
        cfg &&
        cfg.mode === 'account' &&
        cfg.roomId === roomId &&
        normalizeBaseUrl(cfg.serverUrl) === baseUrl &&
        cfg.bridgeSecret
      ) {
        const check = await this.verifyExistingConfig(cfg)
        if (mySeq !== this.syncSeq) return this.getStatus()
        if (check.valid || check.networkError) {
          const hadAutoStartDisabled = Boolean(cfg.autoStartDisabled)
          readyCfg = {
            ...cfg,
            label: check.data?.label || cfg.label || os.hostname() || 'My-PC',
            username: check.data?.username || cfg.username || username,
          }
          delete readyCfg.autoStartDisabled
          let needsSave = hadAutoStartDisabled
          if (!normalizeE2eeKey(readyCfg.e2eeKey)) {
            readyCfg.e2eeKey = generateE2eeKey()
            needsSave = true
          }
          if (needsSave) {
            saveConfigSecure(this.configPath, readyCfg, this.secretStore)
          }
        }
      }

      if (!readyCfg) {
        const sameRoomRebind = Boolean(cfg && cfg.mode === 'account' && cfg.roomId === roomId)
        const existingBridgeId = sameRoomRebind ? String(cfg.bridgeId || '').trim() : ''
        const preservedE2eeKey = sameRoomRebind ? normalizeE2eeKey(cfg.e2eeKey) : ''
        this.appendLog(
          `Auto-registering this PC into account @${username || roomId} on ${baseUrl}${existingBridgeId ? ` (rebind bridgeId=${existingBridgeId})` : ''}...`,
        )
        const bound = await this.registerDeviceWithJwt({ baseUrl, token, existingBridgeId })
        if (mySeq !== this.syncSeq) return this.getStatus()
        readyCfg = {
          mode: 'account',
          serverUrl: baseUrl,
          roomId: bound.roomId || roomId,
          userId: bound.userId || roomId,
          username: bound.username || username,
          deviceId: bound.deviceId,
          bridgeId: bound.bridgeId,
          bridgeSecret: bound.deviceSecret,
          e2eeKey: preservedE2eeKey || generateE2eeKey(),
          label: bound.label || os.hostname() || 'My-PC',
          createdAt: Date.now(),
        }
        saveConfigSecure(this.configPath, readyCfg, this.secretStore)
        this.appendLog(`Bound PC successfully: bridgeId=${readyCfg.bridgeId}`)
      }

      if (mySeq !== this.syncSeq) return this.getStatus()
      this.deviceMeta = {
        label: readyCfg.label || os.hostname() || 'My-PC',
        bridgeId: readyCfg.bridgeId || readyCfg.label || os.hostname() || 'My-PC',
        roomId: readyCfg.roomId,
        username: readyCfg.username || username,
        serverUrl: readyCfg.serverUrl,
        e2eeKeyId: computeDesktopE2eeKeyId(readyCfg.e2eeKey),
      }

      await this.spawnBridgeProcess(readyCfg)
    } catch (err) {
      if (mySeq !== this.syncSeq) return this.getStatus()
      this.state = 'error'
      this.error = String(err?.message || err)
      this.appendLog(`syncAccount error: ${this.error}`)
      this.emitStatus()
    }

    return this.getStatus()
  }

  /**
   * Auto-start on Desktop App boot if ~/.allinone-bridge/config.json already has a valid account binding.
   */
  async startFromSavedConfigIfPresent() {
    if (this.disposed || !this.enabled || this.proc) return this.getStatus()
    const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
    if (cfgRes.status === 'decrypt-error') {
      this.state = 'error'
      this.error = KEYCHAIN_DECRYPT_ERROR
      this.appendLog(`startFromSavedConfigIfPresent blocked: ${this.error}`)
      this.emitStatus()
      return this.getStatus()
    }
    const cfg = cfgRes.config
    if (
      !cfg ||
      cfg.autoStartDisabled ||
      cfg.mode !== 'account' ||
      !cfg.roomId?.startsWith('usr_') ||
      !cfg.bridgeSecret ||
      !cfg.serverUrl
    ) {
      return this.getStatus()
    }
    if (!normalizeE2eeKey(cfg.e2eeKey)) {
      cfg.e2eeKey = generateE2eeKey()
      saveConfigSecure(this.configPath, cfg, this.secretStore)
    }
    this.deviceMeta = {
      label: cfg.label || os.hostname() || 'My-PC',
      bridgeId: cfg.bridgeId || cfg.label || os.hostname() || 'My-PC',
      roomId: cfg.roomId,
      username: cfg.username || '',
      serverUrl: normalizeBaseUrl(cfg.serverUrl),
      e2eeKeyId: computeDesktopE2eeKeyId(cfg.e2eeKey),
    }
    try {
      await this.spawnBridgeProcess(cfg)
    } catch (err) {
      this.state = 'error'
      this.error = String(err?.message || err)
      this.emitStatus()
    }
    return this.getStatus()
  }

  /**
   * Called on OS sleep/resume or screen-unlock to promptly recover the embedded bridge.
   */
  async handleSystemResume() {
    if (this.disposed || !this.enabled) return this.getStatus()
    this.restartAttempts = 0
    this.restartTimestamps = []
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.authRevoked || this.state === 'binding') {
      return this.getStatus()
    }
    const childAlive = Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null)
    if (childAlive && (this.state === 'connected' || this.state === 'starting')) {
      if (this.state === 'connected') {
        // Prompt running embedded bridge to immediately probe/reconnect its control WS after OS wake
        try {
          if (this.proc.stdin && !this.proc.stdin.destroyed && this.proc.stdin.writable) {
            this.proc.stdin.write(`${JSON.stringify({ type: 'probe' })}\n`)
          }
        } catch {}
      }
      return this.getStatus()
    }

    const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
    if (cfgRes.status === 'decrypt-error') {
      this.state = 'error'
      this.error = KEYCHAIN_DECRYPT_ERROR
      this.appendLog(`handleSystemResume blocked: ${this.error}`)
      this.emitStatus()
      return this.getStatus()
    }
    const cfg = cfgRes.config
    if (
      cfg &&
      !cfg.autoStartDisabled &&
      cfg.mode === 'account' &&
      cfg.roomId?.startsWith('usr_') &&
      cfg.bridgeSecret &&
      cfg.serverUrl
    ) {
      this.appendLog('System resumed/unlocked; restarting embedded bridge...')
      if (!normalizeE2eeKey(cfg.e2eeKey)) {
        cfg.e2eeKey = generateE2eeKey()
        saveConfigSecure(this.configPath, cfg, this.secretStore)
      }
      this.deviceMeta = {
        label: cfg.label || os.hostname() || 'My-PC',
        bridgeId: cfg.bridgeId || cfg.label || os.hostname() || 'My-PC',
        roomId: cfg.roomId,
        username: cfg.username || this.activeAccount?.username || '',
        serverUrl: normalizeBaseUrl(cfg.serverUrl),
        e2eeKeyId: computeDesktopE2eeKeyId(cfg.e2eeKey),
      }
      try {
        await this.spawnBridgeProcess(cfg)
      } catch (err) {
        this.state = 'error'
        this.error = String(err?.message || err)
        this.emitStatus()
      }
      return this.getStatus()
    }

    if (this.activeAccount) {
      return this.syncAccount(this.activeAccount)
    }
    return this.getStatus()
  }

  async spawnBridgeProcess(cfg) {
    const mySpawnSeq = ++this.spawnSeq
    await this.killChild()
    if (this.disposed || !this.enabled || mySpawnSeq !== this.spawnSeq) return

    const scriptPath = resolveBridgeScriptPath(this.isPackaged)
    const serverUrl = normalizeBaseUrl(cfg.serverUrl)
    const label = cfg.label || os.hostname() || 'My-PC'

    this.authRevoked = false
    this.state = 'starting'
    this.error = ''
    this.emitStatus()
    this.appendLog(`Starting embedded bridge: script=${scriptPath} server=${serverUrl} bridgeId=${cfg.bridgeId || label}`)

    const webrtcProxyInfo = this.getWebRtcProxyInfo?.() || null
    const workspaceDir = this.ensureWorkspaceDir()
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        '--server', serverUrl,
        '--state-dir', this.stateDir,
        '--name', label,
        '--no-browser',
        '--machine-ipc',
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ALLINONE_SERVER: serverUrl,
          ALLINONE_HOME: this.stateDir,
          ALLINONE_PC_NAME: label,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    child.stdin?.on('error', () => {})
    // Deliver bootstrap secrets over private stdin pipe instead of process environment variables
    try {
      child.stdin?.write(
        `${JSON.stringify({
          type: 'bootstrap',
          bridgeSecret: cfg.bridgeSecret || '',
          e2eeKey: cfg.e2eeKey || '',
          webrtcProxyPort: webrtcProxyInfo?.port || 0,
          webrtcProxyToken: webrtcProxyInfo?.token || '',
        })}\n`,
      )
    } catch {}

    this.proc = child
    let childAuthRevoked = false

    const handleMachineEvent = (ev) => {
      if (!ev || ev.type !== 'bridge.ipc') return false
      if (ev.event === 'state') {
        if (ev.state === 'connected') {
          this.state = 'connected'
          this.error = ''
          this.emitStatus()
          if (!this.stabilityTimer) {
            this.stabilityTimer = setTimeout(() => {
              this.stabilityTimer = null
              if (this.proc === child && this.state === 'connected') {
                this.restartAttempts = 0
                this.restartTimestamps = []
              }
            }, RESTART_STABILITY_WINDOW_MS)
            this.stabilityTimer.unref?.()
          }
        } else if (ev.state === 'disconnected') {
          this.clearStabilityTimer()
          if (!childAuthRevoked && this.state !== 'error') {
            this.state = 'starting'
            this.emitStatus()
          }
        } else if (ev.state === 'unauthorized') {
          this.clearStabilityTimer()
          childAuthRevoked = true
          this.authRevoked = true
          this.error = '本机绑定凭证已失效，请重新登录'
          this.state = 'error'
          this.emitStatus()
        } else if (ev.state === 'fatal') {
          this.clearStabilityTimer()
          this.error = String(ev.message || '桥接发生异常')
          this.state = 'error'
          this.emitStatus()
        }
        return true
      }
      if (ev.event === 'apps' && Array.isArray(ev.apps)) {
        this.appsSummary = ev.apps
          .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
          .join(' | ')
        this.emitStatus()
        return true
      }
      if (ev.event === 'autofix') {
        this.autofixText = ev.phase === 'installing' ? String(ev.message || '') : ''
        this.emitStatus()
        return true
      }
      if (ev.event === 'fatal') {
        this.clearStabilityTimer()
        this.error = String(ev.message || '桥接发生异常')
        this.state = 'error'
        this.emitStatus()
        return true
      }
      return true
    }

    const handleLine = (raw) => {
      const line = String(raw || '').trim()
      if (!line) return
      if (line.startsWith('{') && line.includes('"bridge.ipc"')) {
        try {
          const parsed = JSON.parse(line)
          if (parsed?.type === 'bridge.ipc') {
            if (this.proc === child) handleMachineEvent(parsed)
            return
          }
        } catch {}
      }
      this.appendLog(line)
    }

    let outBuf = ''
    child.stdout?.on('data', (chunk) => {
      outBuf += chunk.toString('utf8')
      let nl
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        handleLine(outBuf.slice(0, nl))
        outBuf = outBuf.slice(nl + 1)
      }
      if (outBuf.length > MAX_STDIO_LINE_BUF) {
        outBuf = outBuf.slice(-4096)
      }
    })
    child.stdout?.on('end', () => {
      if (outBuf.trim()) {
        handleLine(outBuf)
        outBuf = ''
      }
    })

    let errBuf = ''
    child.stderr?.on('data', (chunk) => {
      errBuf += chunk.toString('utf8')
      let nl
      while ((nl = errBuf.indexOf('\n')) !== -1) {
        handleLine(`[stderr] ${errBuf.slice(0, nl)}`)
        errBuf = errBuf.slice(nl + 1)
      }
      if (errBuf.length > MAX_STDIO_LINE_BUF) {
        errBuf = errBuf.slice(-4096)
      }
    })
    child.stderr?.on('end', () => {
      if (errBuf.trim()) {
        handleLine(`[stderr] ${errBuf}`)
        errBuf = ''
      }
    })

    child.on('error', (err) => {
      if (this.proc !== child) return
      this.clearStabilityTimer()
      this.proc = null
      this.state = 'error'
      this.error = String(err?.message || err)
      this.appendLog(`Child process error: ${this.error}`)
      this.emitStatus()
    })

    child.on('exit', (code, signal) => {
      if (outBuf.trim()) {
        handleLine(outBuf)
        outBuf = ''
      }
      if (errBuf.trim()) {
        handleLine(`[stderr] ${errBuf}`)
        errBuf = ''
      }
      if (this.proc !== child) return
      this.clearStabilityTimer()
      this.proc = null
      this.autofixText = ''
      this.appendLog(`Bridge exited (code=${code}, signal=${signal})`)

      if (this.disposed || !this.enabled) {
        this.state = this.enabled ? 'idle' : 'paused'
        this.emitStatus()
        return
      }

      if (code === 41) {
        childAuthRevoked = true
      }
      if (childAuthRevoked) {
        this.authRevoked = true
        this.state = 'error'
        if (!this.error) {
          this.error = '本机绑定凭证已失效，请重新登录'
        }
        this.appendLog('Bridge device credentials revoked/unbound; disabling auto-restart until re-login')
        this.emitStatus()
        return
      }

      const now = Date.now()
      this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < RESTART_CIRCUIT_WINDOW_MS)
      this.restartTimestamps.push(now)
      if (this.restartTimestamps.length >= RESTART_CIRCUIT_MAX) {
        this.state = 'error'
        this.error = '本机桥接连续异常退出，已暂停自动重启，请查看日志后重试'
        this.appendLog(`Restart circuit breaker tripped (${this.restartTimestamps.length} exits in 2 min)`)
        this.emitStatus()
        return
      }

      this.state = 'starting'
      this.restartAttempts += 1
      const delayMs = Math.min(20_000, 2000 * Math.min(this.restartAttempts, 8))
      this.appendLog(`Scheduling auto-restart in ${delayMs}ms (attempt #${this.restartAttempts})`)
      this.emitStatus()

      clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        if (this.disposed || !this.enabled || this.authRevoked || mySpawnSeq !== this.spawnSeq) return
        const latestRes = loadConfigWithStatus(this.configPath, this.secretStore)
        if (latestRes.status === 'decrypt-error') {
          this.state = 'error'
          this.error = KEYCHAIN_DECRYPT_ERROR
          this.appendLog(`Auto-restart blocked: ${this.error}`)
          this.emitStatus()
          return
        }
        const latestCfg = latestRes.config || cfg
        if (latestCfg?.autoStartDisabled) return
        void this.spawnBridgeProcess(latestCfg).catch((err) => {
          this.state = 'error'
          this.error = String(err?.message || err)
          this.appendLog(`Auto-restart spawn failed: ${this.error}`)
          this.emitStatus()
        })
      }, delayMs)
    })
  }

  async killChild() {
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.clearStabilityTimer()
    while (this.killPromise || this.proc) {
      if (this.killPromise) {
        await this.killPromise
        continue
      }
      const child = this.proc
      if (!child) break
      this.proc = null
      const p = new Promise((resolveDone) => {
        let settled = false
        let forceTimer = null
        let killTimer = null
        const done = () => {
          if (settled) return
          settled = true
          if (killTimer) clearTimeout(killTimer)
          if (forceTimer) clearTimeout(forceTimer)
          resolveDone()
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          done()
          return
        }
        child.once('exit', done)

        const escalateForceKill = () => {
          if (settled) return
          if (process.platform === 'win32' && child.pid) {
            try {
              execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
            } catch {}
          }
          try {
            child.kill('SIGKILL')
          } catch {}
          forceTimer = setTimeout(done, 500)
          forceTimer.unref?.()
        }

        killTimer = setTimeout(escalateForceKill, GRACEFUL_QUIT_TIMEOUT_MS)
        killTimer.unref?.()

        // Request graceful cross-platform shutdown over stdin IPC first (works cleanly on Windows & POSIX)
        let sentGracefulQuit = false
        try {
          if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
            child.stdin.write(`${JSON.stringify({ type: 'quit' })}\n`)
            sentGracefulQuit = true
          }
        } catch {}

        if (!sentGracefulQuit && process.platform !== 'win32') {
          try {
            child.kill('SIGTERM')
          } catch {
            done()
          }
        }
      }).finally(() => {
        if (this.killPromise === p) {
          this.killPromise = null
        }
      })
      this.killPromise = p
      await p
    }
  }

  async stop({ nextState = 'idle', clearAccount = nextState === 'idle' } = {}) {
    this.syncSeq += 1
    const mySpawnSeq = ++this.spawnSeq
    this.appendLog(`Stopping embedded bridge (nextState=${nextState})`)
    if (clearAccount) {
      this.activeAccount = null
      this.deviceMeta = null
      this.appsSummary = ''
      this.autofixText = ''
      this.authRevoked = false
      try {
        const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
        if (cfgRes.status === 'ok' && cfgRes.config) {
          saveConfigSecure(
            this.configPath,
            { ...cfgRes.config, autoStartDisabled: true },
            this.secretStore,
          )
        }
      } catch {}
    }
    await this.killChild()
    if (mySpawnSeq !== this.spawnSeq) return this.getStatus()
    this.state = nextState
    this.error = ''
    this.emitStatus()
    return this.getStatus()
  }

  async toggleEnabled() {
    this.enabled = !this.enabled
    if (!this.enabled) {
      return this.stop({ nextState: 'paused' })
    }
    this.restartAttempts = 0
    this.restartTimestamps = []
    if (this.activeAccount) {
      return this.syncAccount(this.activeAccount)
    }
    return this.startFromSavedConfigIfPresent()
  }

  getE2eeInfo(expectedRoomId = '') {
    const cleanExpected = String(expectedRoomId || '').trim()
    if (!cleanExpected || !cleanExpected.startsWith('usr_')) {
      return { enabled: false, key: '', keyId: '', roomId: '', error: '缺少有效的账号标识' }
    }
    const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
    if (cfgRes.status === 'decrypt-error') {
      this.state = 'error'
      this.error = KEYCHAIN_DECRYPT_ERROR
      this.emitStatus()
      return { enabled: false, key: '', keyId: '', roomId: '', error: KEYCHAIN_DECRYPT_ERROR }
    }
    const cfg = cfgRes.config
    if (!cfg || cfg.mode !== 'account' || !cfg.roomId) {
      return { enabled: false, key: '', keyId: '', roomId: '' }
    }
    if (cfg.roomId !== cleanExpected) {
      return { enabled: false, key: '', keyId: '', roomId: cfg.roomId }
    }
    let key = normalizeE2eeKey(cfg.e2eeKey)
    let generatedNew = false
    if (!key) {
      key = generateE2eeKey()
      cfg.e2eeKey = key
      saveConfigSecure(this.configPath, cfg, this.secretStore)
      generatedNew = true
    }
    const keyId = computeDesktopE2eeKeyId(key)
    if (this.deviceMeta && this.deviceMeta.roomId === cfg.roomId) {
      this.deviceMeta.e2eeKeyId = keyId
    }
    if (generatedNew && this.proc && !this.proc.killed && this.enabled && !this.disposed) {
      this.appendLog(`Generated new local E2EE key (fingerprint=${keyId}); restarting embedded bridge...`)
      void this.spawnBridgeProcess(cfg).catch((err) => {
        this.state = 'error'
        this.error = String(err?.message || err)
        this.emitStatus()
      })
    }
    return {
      enabled: true,
      key,
      keyId,
      roomId: cfg.roomId,
      bridgeId: cfg.bridgeId || this.deviceMeta?.bridgeId || '',
    }
  }

  async setE2eeKey(expectedRoomId = '', rawKey = '') {
    const cleanExpected = String(expectedRoomId || '').trim()
    if (!cleanExpected || !cleanExpected.startsWith('usr_')) {
      throw new Error('缺少有效的账号标识，无法更新端到端密钥')
    }
    this.syncSeq += 1
    const normalized = normalizeE2eeKey(rawKey)
    if (!normalized) {
      throw new Error('无效的端到端密钥格式（应为 43 位 Base64URL 密钥）')
    }
    const cfgRes = loadConfigWithStatus(this.configPath, this.secretStore)
    if (cfgRes.status === 'decrypt-error') {
      this.state = 'error'
      this.error = KEYCHAIN_DECRYPT_ERROR
      this.emitStatus()
      throw new Error(KEYCHAIN_DECRYPT_ERROR)
    }
    const cfg = cfgRes.config
    if (!cfg || cfg.mode !== 'account' || !cfg.roomId) {
      throw new Error('本机尚未绑定账号，请先登录')
    }
    if (cfg.roomId !== cleanExpected) {
      throw new Error('当前登录账号与本机桥接账号不一致')
    }
    const prevCfg = { ...cfg }
    const prevDeviceMeta = this.deviceMeta ? { ...this.deviceMeta } : null
    const nextCfg = { ...cfg, e2eeKey: normalized }
    if (this.enabled && !this.disposed) {
      delete nextCfg.autoStartDisabled
    }
    saveConfigSecure(this.configPath, nextCfg, this.secretStore)
    const keyId = computeDesktopE2eeKeyId(normalized)
    this.deviceMeta = {
      ...(this.deviceMeta || {}),
      label: nextCfg.label || os.hostname() || 'My-PC',
      bridgeId: nextCfg.bridgeId || nextCfg.label || os.hostname() || 'My-PC',
      roomId: nextCfg.roomId,
      username: nextCfg.username || '',
      serverUrl: normalizeBaseUrl(nextCfg.serverUrl),
      e2eeKeyId: keyId,
    }
    this.appendLog(`Updated local E2EE key (fingerprint=${keyId}); restarting embedded bridge...`)
    if (this.enabled && !this.disposed) {
      try {
        await this.spawnBridgeProcess(nextCfg)
      } catch (err) {
        try {
          saveConfigSecure(this.configPath, prevCfg, this.secretStore)
        } catch {}
        this.deviceMeta = prevDeviceMeta
        this.state = 'error'
        this.error = String(err?.message || err)
        this.appendLog(`setE2eeKey failed to restart bridge; rolled back config: ${this.error}`)
        this.emitStatus()
        throw err
      }
    } else {
      this.emitStatus()
    }
    return {
      ok: true,
      key: normalized,
      keyId,
      roomId: nextCfg.roomId,
      bridgeId: nextCfg.bridgeId || '',
    }
  }

  async rotateE2eeKey(expectedRoomId = '') {
    this.syncSeq += 1
    return this.setE2eeKey(expectedRoomId, generateE2eeKey())
  }

  async dispose() {
    this.disposed = true
    this.syncSeq += 1
    this.spawnSeq += 1
    await this.killChild()
  }
}
