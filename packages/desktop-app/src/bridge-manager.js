/**
 * Embedded PC Bridge Lifecycle Manager for All in One Desktop App.
 *
 * Zero-terminal experience:
 *  - Reuses existing ~/.allinone-bridge/config.json if already bound to the same account & server
 *  - Otherwise auto-binds this PC via POST /api/account/devices/register using the logged-in JWT
 *  - Runs the bundled single-file bridge in an isolated child process using Electron's embedded Node runtime
 *    (zero Node.js installation required on the user's computer!)
 *  - Auto-disables legacy com.allinone.bridge LaunchAgent on macOS to prevent duplicate bridge collisions
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_LOG_BYTES = 1024 * 1024 // 1 MB rolling cap

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

function normalizeDesktopE2eeKey(raw) {
  const clean = String(raw || '').trim().replace(/\s+/g, '')
  if (!clean || !/^[A-Za-z0-9+/_=-]+$/.test(clean)) return ''
  try {
    const std = clean.replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (std.length % 4)) % 4
    const buf = Buffer.from(`${std}${'='.repeat(pad)}`, 'base64')
    if (buf.length !== 32) return ''
    return buf.toString('base64url')
  } catch {
    return ''
  }
}

function generateDesktopE2eeKey() {
  return randomBytes(32).toString('base64url')
}

function computeDesktopE2eeKeyId(rawKey) {
  const key = normalizeDesktopE2eeKey(rawKey)
  if (!key) return ''
  const rawBytes = Buffer.from(key, 'base64url')
  return createHash('sha256')
    .update('allinone-e2ee-v1-id:')
    .update(rawBytes)
    .digest('hex')
    .slice(0, 16)
}

export function saveConfigSecure(filePath, data, secretStore = null) {
  const payload = { ...data }
  if (secretStore && payload.bridgeSecret) {
    try {
      const enc = secretStore.encrypt(String(payload.bridgeSecret))
      if (enc) {
        payload.bridgeSecretEnc = enc
        delete payload.bridgeSecret
      }
    } catch {}
  }
  if (secretStore && payload.e2eeKey) {
    try {
      const enc = secretStore.encrypt(String(payload.e2eeKey))
      if (enc) {
        payload.e2eeKeyEnc = enc
        delete payload.e2eeKey
      }
    } catch {}
  }
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
  try { chmodSync(filePath, 0o600) } catch {}
}

export function loadConfigDecrypted(filePath, secretStore = null) {
  const raw = readJsonSafe(filePath)
  if (!raw) return null
  const out = { ...raw }
  let shouldMigrate = false
  if (out.bridgeSecretEnc && !out.bridgeSecret && secretStore) {
    try {
      const dec = secretStore.decrypt(out.bridgeSecretEnc)
      if (!dec) return null
      out.bridgeSecret = dec
    } catch {
      return null
    }
  } else if (out.bridgeSecret && !out.bridgeSecretEnc && secretStore) {
    shouldMigrate = true
  }
  if (out.e2eeKeyEnc && !out.e2eeKey && secretStore) {
    try {
      const dec = secretStore.decrypt(out.e2eeKeyEnc)
      if (dec) out.e2eeKey = normalizeDesktopE2eeKey(dec)
    } catch {}
  } else if (out.e2eeKey && !out.e2eeKeyEnc && secretStore) {
    out.e2eeKey = normalizeDesktopE2eeKey(out.e2eeKey)
    if (out.e2eeKey) shouldMigrate = true
  }
  // Auto-encrypt any plaintext credentials on disk into OS keychain / DPAPI storage
  if (shouldMigrate) {
    try {
      saveConfigSecure(filePath, out, secretStore)
    } catch {}
  }
  return out
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
  constructor({ isPackaged = false, getAutoLaunch = () => false, secretStore = null } = {}) {
    super()
    this.isPackaged = isPackaged
    this.getAutoLaunch = getAutoLaunch
    this.secretStore = secretStore
    this.stateDir = join(os.homedir(), '.allinone-bridge')
    this.configPath = join(this.stateDir, 'config.json')
    this.logPath = join(this.stateDir, 'desktop-bridge.log')

    this.proc = null
    this.restartTimer = null
    this.restartAttempts = 0
    this.disposed = false

    this.enabled = true
    this.state = 'idle' // 'idle' | 'binding' | 'starting' | 'connected' | 'paused' | 'error'
    this.error = ''
    this.activeAccount = null // { baseUrl, token, roomId, username }
    this.deviceMeta = null // { label, bridgeId, roomId, username, serverUrl }
    this.appsSummary = ''
    this.autofixText = ''
    this.syncSeq = 0
  }

  ensureStateDir() {
    mkdirSync(this.stateDir, { recursive: true })
    try { chmodSync(this.stateDir, 0o700) } catch {}
  }

  appendLog(line) {
    try {
      this.ensureStateDir()
      if (existsSync(this.logPath)) {
        const st = statSync(this.logPath)
        if (st.size > MAX_LOG_BYTES) {
          const tail = readFileSync(this.logPath, 'utf8').slice(-200_000)
          writeFileSync(this.logPath, tail, 'utf8')
        }
      }
      appendFileSync(this.logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
    } catch {}
  }

  getStatus() {
    return {
      state: this.state,
      enabled: this.enabled,
      autoLaunch: Boolean(this.getAutoLaunch?.()),
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
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/account/devices/register`, {
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
    })
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
    this.state = 'binding'
    this.error = ''
    this.emitStatus()

    try {
      this.ensureStateDir()
      let cfg = loadConfigDecrypted(this.configPath, this.secretStore)
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
          readyCfg = {
            ...cfg,
            label: check.data?.label || cfg.label || os.hostname() || 'My-PC',
            username: check.data?.username || cfg.username || username,
          }
          if (!normalizeDesktopE2eeKey(readyCfg.e2eeKey)) {
            readyCfg.e2eeKey = generateDesktopE2eeKey()
            saveConfigSecure(this.configPath, readyCfg, this.secretStore)
          }
        }
      }

      if (!readyCfg) {
        this.appendLog(`Auto-registering this PC into account @${username || roomId} on ${baseUrl}...`)
        const bound = await this.registerDeviceWithJwt({ baseUrl, token })
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
          e2eeKey: generateDesktopE2eeKey(),
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
    const cfg = loadConfigDecrypted(this.configPath, this.secretStore)
    if (!cfg || cfg.mode !== 'account' || !cfg.roomId?.startsWith('usr_') || !cfg.bridgeSecret || !cfg.serverUrl) {
      return this.getStatus()
    }
    if (!normalizeDesktopE2eeKey(cfg.e2eeKey)) {
      cfg.e2eeKey = generateDesktopE2eeKey()
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

  async spawnBridgeProcess(cfg) {
    await this.killChild()
    if (this.disposed || !this.enabled) return

    const scriptPath = resolveBridgeScriptPath(this.isPackaged)
    const serverUrl = normalizeBaseUrl(cfg.serverUrl)
    const label = cfg.label || os.hostname() || 'My-PC'

    this.state = 'starting'
    this.error = ''
    this.emitStatus()
    this.appendLog(`Starting embedded bridge: script=${scriptPath} server=${serverUrl} bridgeId=${cfg.bridgeId || label}`)

    const child = spawn(
      process.execPath,
      [
        scriptPath,
        '--server', serverUrl,
        '--state-dir', this.stateDir,
        '--name', label,
        '--no-browser',
      ],
      {
        cwd: os.homedir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ALLINONE_SERVER: serverUrl,
          ALLINONE_HOME: this.stateDir,
          ALLINONE_PC_NAME: label,
          ...(cfg.bridgeSecret ? { ALLINONE_BRIDGE_SECRET: cfg.bridgeSecret } : {}),
          ...(cfg.e2eeKey ? { ALLINONE_E2EE_KEY: cfg.e2eeKey } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )

    this.proc = child

    const handleLine = (raw) => {
      const line = String(raw || '').trim()
      if (!line) return
      this.appendLog(line)
      if (line.includes('已加密连接到中转服务器')) {
        this.restartAttempts = 0
        this.state = 'connected'
        this.error = ''
        this.emitStatus()
      } else if (line.includes('本机 AI')) {
        const idx = line.indexOf(':')
        if (idx !== -1) {
          this.appsSummary = line.slice(idx + 1).trim()
          this.emitStatus()
        }
      } else if (line.includes('[autofix:progress]')) {
        const idx = line.indexOf('[autofix:progress]')
        this.autofixText = line.slice(idx + '[autofix:progress]'.length).trim()
        this.emitStatus()
      } else if (line.includes('[autofix:idle]')) {
        if (this.autofixText) {
          this.autofixText = ''
          this.emitStatus()
        }
      } else if (line.includes('已被解绑') || line.includes('凭证无效')) {
        this.error = '本机绑定凭证已失效，请重新登录'
        this.state = 'error'
        this.emitStatus()
      }
    }

    let outBuf = ''
    child.stdout?.on('data', (chunk) => {
      outBuf += chunk.toString('utf8')
      let nl
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        handleLine(outBuf.slice(0, nl))
        outBuf = outBuf.slice(nl + 1)
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
    })

    child.on('error', (err) => {
      if (this.proc !== child) return
      this.proc = null
      this.state = 'error'
      this.error = String(err?.message || err)
      this.appendLog(`Child process error: ${this.error}`)
      this.emitStatus()
    })

    child.on('exit', (code, signal) => {
      if (this.proc !== child) return
      this.proc = null
      this.autofixText = ''
      this.appendLog(`Bridge exited (code=${code}, signal=${signal})`)

      if (this.disposed || !this.enabled) {
        this.state = this.enabled ? 'idle' : 'paused'
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
        if (this.disposed || !this.enabled) return
        const latestCfg = loadConfigDecrypted(this.configPath, this.secretStore) || cfg
        void this.spawnBridgeProcess(latestCfg)
      }, delayMs)
    })
  }

  async killChild() {
    clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.proc
    if (!child) return
    this.proc = null
    await new Promise((resolveDone) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        resolveDone()
      }
      child.once('exit', done)
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        setTimeout(done, 150)
      }, 2500)
      try {
        child.kill('SIGTERM')
      } catch {
        done()
      }
    })
  }

  async stop({ nextState = 'idle' } = {}) {
    this.syncSeq += 1
    this.appendLog(`Stopping embedded bridge (nextState=${nextState})`)
    await this.killChild()
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
    if (this.activeAccount) {
      return this.syncAccount(this.activeAccount)
    }
    return this.startFromSavedConfigIfPresent()
  }

  getE2eeInfo(expectedRoomId = '') {
    const cfg = loadConfigDecrypted(this.configPath, this.secretStore)
    if (!cfg || cfg.mode !== 'account' || !cfg.roomId) {
      return { enabled: false, key: '', keyId: '', roomId: '' }
    }
    if (expectedRoomId && cfg.roomId !== expectedRoomId) {
      return { enabled: false, key: '', keyId: '', roomId: cfg.roomId }
    }
    let key = normalizeDesktopE2eeKey(cfg.e2eeKey)
    if (!key) {
      key = generateDesktopE2eeKey()
      cfg.e2eeKey = key
      saveConfigSecure(this.configPath, cfg, this.secretStore)
    }
    const keyId = computeDesktopE2eeKeyId(key)
    if (this.deviceMeta && this.deviceMeta.roomId === cfg.roomId) {
      this.deviceMeta.e2eeKeyId = keyId
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
    const normalized = normalizeDesktopE2eeKey(rawKey)
    if (!normalized) {
      throw new Error('无效的端到端密钥格式（应为 43 位 Base64URL 密钥）')
    }
    const cfg = loadConfigDecrypted(this.configPath, this.secretStore)
    if (!cfg || cfg.mode !== 'account' || !cfg.roomId) {
      throw new Error('本机尚未绑定账号，请先登录')
    }
    if (expectedRoomId && cfg.roomId !== expectedRoomId) {
      throw new Error('当前登录账号与本机桥接账号不一致')
    }
    cfg.e2eeKey = normalized
    saveConfigSecure(this.configPath, cfg, this.secretStore)
    const keyId = computeDesktopE2eeKeyId(normalized)
    this.deviceMeta = {
      ...(this.deviceMeta || {}),
      label: cfg.label || os.hostname() || 'My-PC',
      bridgeId: cfg.bridgeId || cfg.label || os.hostname() || 'My-PC',
      roomId: cfg.roomId,
      username: cfg.username || '',
      serverUrl: normalizeBaseUrl(cfg.serverUrl),
      e2eeKeyId: keyId,
    }
    this.appendLog(`Updated local E2EE key (fingerprint=${keyId}); restarting embedded bridge...`)
    if (this.enabled && !this.disposed) {
      await this.spawnBridgeProcess(cfg)
    } else {
      this.emitStatus()
    }
    return {
      ok: true,
      key: normalized,
      keyId,
      roomId: cfg.roomId,
      bridgeId: cfg.bridgeId || '',
    }
  }

  async rotateE2eeKey(expectedRoomId = '') {
    return this.setE2eeKey(expectedRoomId, generateDesktopE2eeKey())
  }

  async dispose() {
    this.disposed = true
    this.syncSeq += 1
    await this.killChild()
  }
}
