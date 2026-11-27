#!/usr/bin/env node
/**
 * All in One — Portable PC Bridge CLI (Zero-Install Single-File Edition)
 *
 * Run on any PC to bind it to your All in One account:
 *  1. Authenticates with your account and saves a per-device credential in ~/.allinone-bridge/config.json
 *  2. Maintains an outbound Control-Plane WSS link + direct E2EE WebRTC P2P data channels (no public IP or port forwarding)
 *  3. Auto-detects locally installed AI coding agents (ChatGPT / Claude Code / Antigravity / DeepSeek Harness / WorkBuddy / ZCode)
 *  4. Generates a 100% offline SVG QR code to sync your 256-bit E2EE room key to phones & browsers
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { ensureDefaultWorkspaceCwd, getDefaultWorkspaceCwd } from './src/protocol.js'
import { RelayBridgeLink } from './src/ws-client.js'
import { renderQrSvg } from '@allinone/shared/qr-svg'
import { autoCompleteHalfInstalledClis } from './src/helpers/env-autofix.js'
import { warmLoginShellPathAsync } from './src/helpers/bin-finder.js'
import { ensureDshLocalIpcPlugin } from './src/helpers/dsh-ipc-installer.js'
import {
  computeE2eeKeyId,
  encodeE2eeQrUri,
  formatE2eeFingerprint,
  generateE2eeKey,
  normalizeE2eeKey,
} from '@allinone/shared/e2ee'

const DEFAULT_SERVER_URL =
  (typeof __ALLINONE_DEFAULT_SERVER__ === 'string' && __ALLINONE_DEFAULT_SERVER__) ||
  'http://127.0.0.1:8787'

function resolveBridgeVersion() {
  if (typeof __ALLINONE_VERSION__ === 'string' && __ALLINONE_VERSION__.trim()) {
    return __ALLINONE_VERSION__.trim()
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))
    if (pkg?.version) return String(pkg.version).trim()
  } catch {}
  return '0.0.0'
}

const BRIDGE_VERSION = resolveBridgeVersion()

// Capture sensitive bootstrap env vars once at process startup, then scrub them from process.env
// so spawned AI CLIs (codex/claude/agy) and user shell commands never inherit decrypted secrets
// or ELECTRON_RUN_AS_NODE=1.
const BOOTSTRAP_ENV = {
  bridgeSecret: String(process.env.ALLINONE_BRIDGE_SECRET || '').trim(),
  e2eeKey: String(process.env.ALLINONE_E2EE_KEY || '').trim(),
  password: String(process.env.ALLINONE_PASSWORD || ''),
  webrtcProxyPort: Number(process.env.ALLINONE_WEBRTC_PROXY_PORT || 0),
  webrtcProxyToken: String(process.env.ALLINONE_WEBRTC_PROXY_TOKEN || '').trim(),
  hadDesktopSecrets: Boolean(
    String(process.env.ALLINONE_BRIDGE_SECRET || '').trim() ||
    String(process.env.ALLINONE_E2EE_KEY || '').trim() ||
    Number(process.env.ALLINONE_WEBRTC_PROXY_PORT || 0) > 0,
  ),
}
for (const secretKey of [
  'ALLINONE_BRIDGE_SECRET',
  'ALLINONE_E2EE_KEY',
  'ALLINONE_PASSWORD',
  'ALLINONE_WEBRTC_PROXY_PORT',
  'ALLINONE_WEBRTC_PROXY_TOKEN',
  'ELECTRON_RUN_AS_NODE',
]) {
  delete process.env[secretKey]
}

function normalizeServerUrl(raw) {
  const trimmed = String(raw || DEFAULT_SERVER_URL).trim()
  try {
    const u = new URL(trimmed)
    if (u.protocol === 'wss:') u.protocol = 'https:'
    else if (u.protocol === 'ws:') u.protocol = 'http:'
    u.pathname = u.pathname.replace(/\/ws\/bridge\/?$/i, '').replace(/\/+$/, '')
    u.search = ''
    u.hash = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return trimmed
      .replace(/[?#].*$/, '')
      .replace(/\/ws\/bridge\/?$/i, '')
      .replace(/\/+$/, '')
  }
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true
  return false
}

function assertSecureServerUrl(serverUrl, { allowInsecureHttp = false } = {}) {
  let u
  try {
    u = new URL(serverUrl)
  } catch {
    throw new Error(`无效的中转服务器地址：${serverUrl}`)
  }
  const proto = u.protocol.toLowerCase()
  if (proto !== 'https:' && proto !== 'http:' && proto !== 'wss:' && proto !== 'ws:') {
    throw new Error(`不支持的服务器协议：${proto}（请使用 https:// 或 wss://）`)
  }
  if ((proto === 'http:' || proto === 'ws:') && !isLoopbackHostname(u.hostname) && !allowInsecureHttp) {
    throw new Error(
      `出于安全限制，拒绝通过明文 ${proto}// 连接到非本机服务器（${u.hostname}）。请改用 https://，或仅在受信任局域网调试时显式传入 --allow-insecure-http。`,
    )
  }
}

function parseArgs(argv) {
  const envCwd = String(process.env.ALLINONE_CWD || '').trim()
  const opts = {
    server: process.env.ALLINONE_SERVER || DEFAULT_SERVER_URL,
    cwd: envCwd || getDefaultWorkspaceCwd(),
    cwdIsDefault: !envCwd,
    label: process.env.ALLINONE_PC_NAME || os.hostname() || 'My-PC',
    stateDir: process.env.ALLINONE_HOME || join(os.homedir(), '.allinone-bridge'),
    username: process.env.ALLINONE_USERNAME || '',
    password: BOOTSTRAP_ENV.password || '',
    e2eeKey: BOOTSTRAP_ENV.e2eeKey || '',
    e2eeKeyFromCli: false,
    allowInsecureHttp: false,
    machineIpc: false,
    logout: false,
    reset: false,
    noBrowser: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--server' || a === '-s') opts.server = argv[++i] || opts.server
    else if (a.startsWith('--server=')) opts.server = a.slice('--server='.length)
    else if (a === '--cwd' || a === '-c') {
      const next = argv[++i]
      if (next) {
        opts.cwd = next
        opts.cwdIsDefault = false
      }
    } else if (a.startsWith('--cwd=')) {
      const next = a.slice('--cwd='.length)
      if (next) {
        opts.cwd = next
        opts.cwdIsDefault = false
      }
    }
    else if (a === '--name' || a === '-n') opts.label = argv[++i] || opts.label
    else if (a.startsWith('--name=')) opts.label = a.slice('--name='.length)
    else if (a === '--username' || a === '-u') opts.username = argv[++i] || opts.username
    else if (a.startsWith('--username=')) opts.username = a.slice('--username='.length)
    else if (a === '--password' || a === '-p') opts.password = argv[++i] || opts.password
    else if (a.startsWith('--password=')) opts.password = a.slice('--password='.length)
    else if (a === '--state-dir') opts.stateDir = argv[++i] || opts.stateDir
    else if (a.startsWith('--state-dir=')) opts.stateDir = a.slice('--state-dir='.length)
    else if (a === '--e2ee-key') {
      opts.e2eeKey = argv[++i] ?? ''
      opts.e2eeKeyFromCli = true
    } else if (a.startsWith('--e2ee-key=')) {
      opts.e2eeKey = a.slice('--e2ee-key='.length)
      opts.e2eeKeyFromCli = true
    } else if (a === '--allow-insecure-http') opts.allowInsecureHttp = true
    else if (a === '--machine-ipc') opts.machineIpc = true
    else if (a === '--logout' || a === '--login') opts.logout = true
    else if (a === '--reset') opts.reset = true
    else if (a === '--no-browser') opts.noBrowser = true
    else if (a === '--help' || a === '-h') opts.help = true
  }
  opts.server = normalizeServerUrl(opts.server || DEFAULT_SERVER_URL)
  return opts
}

function toBridgeWsUrl(httpBase) {
  const u = new URL(httpBase)
  u.protocol = (u.protocol === 'https:' || u.protocol === 'wss:') ? 'wss:' : 'ws:'
  u.pathname = `${u.pathname.replace(/\/ws\/bridge\/?$/i, '').replace(/\/+$/, '')}/ws/bridge`
  u.search = ''
  u.hash = ''
  return u.toString()
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function readRawConfig(configPath) {
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function readConfig(configPath) {
  const parsed = readRawConfig(configPath)
  if (!parsed) return null
  const envSecret = BOOTSTRAP_ENV.bridgeSecret
  const envE2eeKey = normalizeE2eeKey(BOOTSTRAP_ENV.e2eeKey || '')
  if (parsed.roomId && (parsed.bridgeSecret || envSecret)) {
    return {
      ...parsed,
      bridgeSecret: parsed.bridgeSecret || envSecret,
      e2eeKey: normalizeE2eeKey(parsed.e2eeKey || '') || envE2eeKey || '',
    }
  }
  return null
}

function saveConfig(configPath, cfg) {
  const toPersist = { ...cfg }
  // Never downgrade Electron safeStorage encrypted config back to plaintext on label/username sync
  if (toPersist.bridgeSecretEnc && BOOTSTRAP_ENV.bridgeSecret) {
    delete toPersist.bridgeSecret
  }
  if (toPersist.e2eeKeyEnc && BOOTSTRAP_ENV.e2eeKey) {
    delete toPersist.e2eeKey
  }
  const payload = JSON.stringify(toPersist, null, 2)
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmpPath, 0o600) } catch {}
  try {
    renameSync(tmpPath, configPath)
  } catch {
    writeFileSync(configPath, payload, { encoding: 'utf8', mode: 0o600 })
    try { unlinkSync(tmpPath) } catch {}
  }
  try { chmodSync(configPath, 0o600) } catch {}
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function loginDeviceWithAccount(serverUrl, { username, password, label, emailCode = '' }) {
  const res = await fetchWithTimeout(`${serverUrl}/api/account/device-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(username || '').trim(),
      password: String(password ?? ''),
      label: String(label || os.hostname() || 'My PC').trim(),
      hostname: os.hostname() || 'My-PC',
      platform: process.platform,
      ...(emailCode ? { emailCode: String(emailCode).trim() } : {}),
    }),
  }, 15_000)
  const data = await res.json().catch(() => ({}))
  if (res.ok && data?.requires2fa) {
    return data
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `账号登录失败 (HTTP ${res.status})`)
  }
  return data
}

async function fetchDeviceAccountStatus(serverUrl, roomId, bridgeSecret) {
  const res = await fetchWithTimeout(`${serverUrl}/api/account/device-status`, {
    method: 'GET',
    headers: {
      'X-Room-Id': roomId,
      'X-Bridge-Secret': bridgeSecret,
    },
  }, 8_000)
  if (res.status === 401) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `查询设备状态失败 (HTTP ${res.status})`)
  }
  return data
}

function promptText(question) {
  return new Promise((resolve) => {
    let settled = false
    const done = (val) => {
      if (settled) return
      settled = true
      resolve(String(val || '').trim())
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.once('close', () => done(''))
    rl.once('SIGINT', () => {
      try { rl.close() } catch {}
      process.stdout.write('\n')
      process.exit(130)
    })
    rl.question(question, (ans) => {
      try { rl.close() } catch {}
      done(ans)
    })
  })
}

function promptPassword(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      promptText(question).then(resolve)
      return
    }
    process.stdout.write(question)
    const stdin = process.stdin
    const wasRaw = Boolean(stdin.isRaw)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    let settled = false

    const cleanup = () => {
      try { stdin.setRawMode(wasRaw) } catch {}
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEof)
      stdin.removeListener('close', onEof)
      stdin.pause()
    }

    const finish = (val) => {
      if (settled) return
      settled = true
      cleanup()
      process.stdout.write('\n')
      resolve(val)
    }

    const onEof = () => finish(value)

    const onData = (buf) => {
      const str = buf.toString('utf8')
      for (const ch of str) {
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup()
          process.stdout.write('\n')
          process.exit(130)
        } else if (ch === '\u0004') {
          // Ctrl+D / EOF
          finish(value)
          return
        } else if (ch === '\r' || ch === '\n') {
          finish(value)
          return
        } else if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          value += ch
          process.stdout.write('*')
        }
      }
    }

    stdin.on('data', onData)
    stdin.once('end', onEof)
    stdin.once('close', onEof)
  })
}

async function interactiveAccountLogin(serverUrl, label) {
  console.log('')
  console.log('==============================================================')
  console.log(`  All in One 电脑端桥接 v${BRIDGE_VERSION} · 账号登录绑定`)
  console.log('==============================================================')
  console.log(`  中转服务器 : ${serverUrl}`)
  console.log(`  本机名称   : ${label}`)
  console.log('  提示：登录后本机仅保存单机专属密钥（绝不保存密码），')
  console.log('        手机端登录同一账号即可自动连接你名下全部电脑！')
  console.log(`  没有账号？请先在 ${serverUrl}/ 直接注册账号`)
  console.log('--------------------------------------------------------------')

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const username = await promptText('  用户名: ')
    if (!username) {
      console.log('  [!] 用户名不能为空，请重试。\n')
      continue
    }
    const password = await promptPassword('  密  码: ')
    if (!password) {
      console.log('  [!] 密码不能为空，请重试。\n')
      continue
    }
    try {
      console.log('  正在验证账号并绑定本机...')
      let bound = await loginDeviceWithAccount(serverUrl, { username, password, label })
      if (bound?.requires2fa) {
        console.log(`  [2FA] ${bound.message || `已向 ${bound.maskedEmail || '绑定邮箱'} 发送 6 位登录验证码`}`)
        const otp = await promptText('  邮箱验证码: ')
        if (!otp) {
          console.log('  [!] 验证码不能为空，请重试。\n')
          continue
        }
        bound = await loginDeviceWithAccount(serverUrl, { username, password, label, emailCode: otp })
        if (bound?.requires2fa || !bound?.ok) {
          console.log('  [!] 邮箱验证码验证未通过，请重试。\n')
          continue
        }
      }
      console.log(`  ✓ 绑定成功！欢迎 @${bound.username}（设备标识: ${bound.bridgeId}）`)
      return bound
    } catch (err) {
      console.error(`  [!] ${String(err?.message || err)} (第 ${attempt}/5 次)\n`)
    }
  }
  throw new Error('连续多次账号验证失败，已退出。')
}

function printAccountBanner({ serverUrl, username, roomId, bridgeId, label, apps, devices = [], e2eeFingerprint = '' }) {
  const appSummary = (apps || [])
    .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
    .join(' | ')

  console.log('')
  console.log('==============================================================')
  console.log(`  All in One 电脑端桥接 v${BRIDGE_VERSION}  [${label}]`)
  console.log('==============================================================')
  console.log(`  中转服务器 : ${serverUrl}`)
  console.log(`  登录账号   : @${username} (${roomId})`)
  console.log(`  本机标识   : ${bridgeId}`)
  if (e2eeFingerprint) {
    console.log(`  端到端加密 : 已开启 (AES-256-GCM · 指纹 ${e2eeFingerprint})`)
  }
  if (appSummary) console.log(`  本机 AI    : ${appSummary}`)
  if (devices.length > 0) {
    const onlineCount = devices.filter((d) => d.online).length
    console.log(`  账号下电脑 : 共 ${devices.length} 台绑定（当前 ${Math.max(1, onlineCount)} 台在线）`)
  }
  console.log('--------------------------------------------------------------')
  console.log('  ★ 手机端打开 App / 网页登录同一账号，即可自动连接本机！')
  if (e2eeFingerprint) {
    console.log('  ★ 首次在新手机连接时，输入 [K] 回车扫码同步本机端到端密钥')
  }
  console.log('  ★ 保持本窗口运行即可远程操控本机 AI（可最小化）')
  if (process.stdin.isTTY) {
    console.log('  操作提示：[K] 密钥二维码  |  [S] 查看电脑  |  [Q] 退出  |  [Ctrl+C] 退出')
  }
  console.log('==============================================================')
  console.log('')
}

function buildE2eeKeyHtml({ username, roomId, label, e2eeKey, e2eeFingerprint }) {
  const qrUri = encodeE2eeQrUri({ key: e2eeKey, roomId })
  const qrSvg = renderQrSvg(qrUri, { pixelSize: 260, darkColor: '#0F172A', lightColor: '#FFFFFF' })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>All in One · 端到端加密密钥同步</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0F172A; color:#F8FAFC; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC',sans-serif; padding:24px; }
  .card { max-width:420px; width:100%; background:#1E293B; border:1px solid #334155; border-radius:24px; padding:28px; text-align:center; box-shadow:0 24px 60px rgba(0,0,0,.45); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { color:#94A3B8; font-size:13px; margin:0 0 20px; }
  .qr { display:inline-block; background:#fff; padding:16px; border-radius:18px; }
  .fp { margin:16px 0 8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; color:#38BDF8; letter-spacing:1px; }
  .key { margin-top:12px; background:#0F172A; border:1px solid #334155; border-radius:12px; padding:10px 12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; word-break:break-all; color:#E2E8F0; user-select:all; }
  .warn { margin-top:14px; font-size:12px; color:#FBBF24; line-height:1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>端到端加密密钥同步</h1>
    <p class="sub">${escapeHtml(label)} · @${escapeHtml(username || roomId)}</p>
    <div class="qr">${qrSvg}</div>
    <div class="fp">密钥指纹：${escapeHtml(e2eeFingerprint)}</div>
    <div class="key">${escapeHtml(e2eeKey)}</div>
    <p class="warn">请使用手机端 All in One 扫描上方二维码同步密钥。此密钥仅保存在你的本地设备，中转服务器永远不会获取，请勿泄露给他人。</p>
  </div>
</body>
</html>`
}

function openFileInBrowser(filePath) {
  try {
    let child = null
    if (process.platform === 'win32') {
      // Pass path through environment variable to avoid any cmd.exe / shell metacharacter injection
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          'Start-Process -FilePath $env:ALLINONE_OPEN_FILE',
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ALLINONE_OPEN_FILE: String(filePath || '') },
        },
      )
    } else if (process.platform === 'darwin') {
      child = spawn('open', [filePath], { detached: true, stdio: 'ignore' })
    } else {
      child = spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' })
    }
    child?.on('error', () => {})
    child?.unref()
  } catch {}
}

let isMachineIpcMode = process.argv.includes('--machine-ipc')

function emitMachineEvent(event, data = {}) {
  if (!isMachineIpcMode) return
  try {
    process.stdout.write(`${JSON.stringify({ type: 'bridge.ipc', event, ...data })}\n`)
  } catch {}
}

/**
 * Unified `--machine-ipc` / embedded desktop stdin line reader + EOF detector attached
 * IMMEDIATELY at startup (before async auth/adapter probing) so early `quit`/`probe` commands
 * and parent EOF are never lost and never orphan the bridge process.
 */
function attachMachineIpcStdin({ bootstrapTimeoutMs = 5_000, onCommand, onEof } = {}) {
  let ctrlBuf = ''
  let bootstrapResolved = false
  let bootstrapResolver = null
  let bootstrapTimer = null
  const pendingCommands = []
  let commandHandler = onCommand || null
  let eofHandler = onEof || null
  let eofSeen = false
  let quitRequested = false

  const resolveBootstrap = (val) => {
    if (bootstrapResolved) return
    bootstrapResolved = true
    if (bootstrapTimer) {
      clearTimeout(bootstrapTimer)
      bootstrapTimer = null
    }
    const r = bootstrapResolver
    bootstrapResolver = null
    r?.(val)
  }

  const bootstrapPromise = new Promise((resolveFrame) => {
    bootstrapResolver = resolveFrame
    bootstrapTimer = setTimeout(() => resolveBootstrap(null), bootstrapTimeoutMs)
    bootstrapTimer.unref?.()
  })

  const dispatchCommand = (cmd) => {
    if (!cmd) return
    if (cmd === 'quit' || cmd === 'stop') {
      quitRequested = true
      resolveBootstrap(null)
    }
    if (commandHandler) {
      try { commandHandler(cmd) } catch {}
    } else if (!pendingCommands.includes(cmd) && pendingCommands.length < 16) {
      pendingCommands.push(cmd)
    }
  }

  const handleRawLine = (rawLine) => {
    if (!rawLine) return
    if (rawLine.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawLine)
        if (parsed && typeof parsed === 'object') {
          if (parsed.type === 'bootstrap') {
            resolveBootstrap(parsed)
            return
          }
          const cmd = String(parsed.type || parsed.cmd || '').trim().toLowerCase()
          if (cmd) dispatchCommand(cmd)
          return
        }
      } catch {}
    }
    const cmd = rawLine.trim().toLowerCase()
    if (cmd) dispatchCommand(cmd)
  }

  const handleEof = () => {
    if (eofSeen) return
    eofSeen = true
    quitRequested = true
    resolveBootstrap(null)
    if (eofHandler) {
      try { eofHandler() } catch {}
    }
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    ctrlBuf += String(chunk || '')
    if (ctrlBuf.length > 64 * 1024) ctrlBuf = ctrlBuf.slice(-4096)
    let nl
    while ((nl = ctrlBuf.indexOf('\n')) !== -1) {
      const rawLine = ctrlBuf.slice(0, nl).trim()
      ctrlBuf = ctrlBuf.slice(nl + 1)
      handleRawLine(rawLine)
    }
  })
  process.stdin.on('end', handleEof)
  process.stdin.on('close', handleEof)
  process.stdin.resume()

  return {
    bootstrapPromise,
    isQuitRequested: () => quitRequested || eofSeen,
    setHandlers({ onCommand: nextOnCommand, onEof: nextOnEof } = {}) {
      commandHandler = nextOnCommand || null
      eofHandler = nextOnEof || null
      if (eofSeen) {
        try { eofHandler?.() } catch {}
        return
      }
      while (pendingCommands.length > 0) {
        const cmd = pendingCommands.shift()
        try { commandHandler?.(cmd) } catch {}
      }
    },
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  isMachineIpcMode = Boolean(opts.machineIpc)
  if (opts.help) {
    console.log(`All in One Portable PC Bridge v${BRIDGE_VERSION}

用法:
  node allinone-bridge.mjs [选项]

选项:
  --server <url>      中转服务器地址 (默认: ${DEFAULT_SERVER_URL})
  --name <label>      本机显示名称 (默认: 本机主机名)
  --cwd <dir>         默认工作目录 (默认: ${getDefaultWorkspaceCwd()})
  -u, --username <u>  账号用户名（用于无交互自动绑定本机）
  -p, --password <p>  账号密码（仅用于首次换取单机密钥，绝不落盘）
  --e2ee-key <key>      指定 256-bit 端到端加密密钥（留空自动生成）
  --allow-insecure-http 允许通过明文 http:// 连接非本机服务器（仅限受信任局域网调试）
  --machine-ipc         结构化 JSON-Lines IPC 模式（供桌面端内嵌管理）
  --logout              退出当前账号绑定并重新登录
  --reset               清除本地配置并重新绑定
  --no-browser          不自动打开本地二维码网页
  -h, --help            显示帮助
`)
    process.exit(0)
  }

  let orchestrator = null
  let link = null
  let rl = null
  let dshIpcWatchTimer = null
  let exiting = false
  let e2eeHtmlCleanupTimer = null
  let removeTempE2eeKeyPage = () => {}

  async function shutdown(exitCode = 0) {
    if (exiting) return
    exiting = true
    try { removeTempE2eeKeyPage() } catch {}
    const forceTimer = setTimeout(() => process.exit(exitCode), 5_000)
    forceTimer.unref?.()
    if (dshIpcWatchTimer) {
      clearInterval(dshIpcWatchTimer)
      dshIpcWatchTimer = null
    }
    console.log('\n[allinone] 正在断开桥接并安全退出...')
    try { rl?.close() } catch {}
    try { await link?.close?.() } catch {}
    try { await orchestrator?.dispose?.() } catch {}
    clearTimeout(forceTimer)
    process.exit(exitCode)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  // Attach --machine-ipc stdin line reader + EOF handler IMMEDIATELY at startup (before async I/O)
  let machineStdin = null
  if (!process.stdin.isTTY && (opts.machineIpc || BOOTSTRAP_ENV.hadDesktopSecrets)) {
    machineStdin = attachMachineIpcStdin({
      bootstrapTimeoutMs: 5_000,
      onCommand: (cmd) => {
        if (cmd === 'quit' || cmd === 'stop') {
          void shutdown(0)
        }
      },
      onEof: () => {
        void shutdown(0)
      },
    })
  }

  if (opts.machineIpc && machineStdin) {
    const boot = await machineStdin.bootstrapPromise
    if (machineStdin.isQuitRequested()) {
      await shutdown(0)
      return
    }
    if (boot) {
      if (boot.bridgeSecret) BOOTSTRAP_ENV.bridgeSecret = String(boot.bridgeSecret).trim()
      if (boot.e2eeKey) {
        BOOTSTRAP_ENV.e2eeKey = String(boot.e2eeKey).trim()
        if (!opts.e2eeKey) opts.e2eeKey = BOOTSTRAP_ENV.e2eeKey
      }
      if (Number(boot.webrtcProxyPort || 0) > 0) BOOTSTRAP_ENV.webrtcProxyPort = Number(boot.webrtcProxyPort)
      if (boot.webrtcProxyToken) BOOTSTRAP_ENV.webrtcProxyToken = String(boot.webrtcProxyToken).trim()
      BOOTSTRAP_ENV.hadDesktopSecrets = true
    }
  }

  if (opts.cwdIsDefault) {
    opts.cwd = ensureDefaultWorkspaceCwd()
  }

  void warmLoginShellPathAsync().catch(() => {})
  assertSecureServerUrl(opts.server, { allowInsecureHttp: opts.allowInsecureHttp })

  mkdirSync(opts.stateDir, { recursive: true })
  try { chmodSync(opts.stateDir, 0o700) } catch {}

  const configPath = join(opts.stateDir, 'config.json')
  const rawExisting = readRawConfig(configPath)
  const hasDesktopEncryptedConfig = Boolean(
    rawExisting?.bridgeSecretEnc &&
    !rawExisting?.bridgeSecret &&
    !BOOTSTRAP_ENV.bridgeSecret,
  )
  if (hasDesktopEncryptedConfig) {
    if (!opts.reset) {
      throw new Error(
        `检测到 ${configPath} 为 All in One 桌面端加密保存的配置（bridgeSecretEnc），当前 CLI 模式无法解密系统钥匙串凭据。为避免覆盖桌面端配置与端到端加密密钥，已中止本次操作；请通过 All in One 桌面端运行桥接，或使用 --state-dir <独立目录> / --reset 显式覆盖。`,
      )
    }
    console.warn(
      `[allinone] ⚠ 警告：${configPath} 包含 All in One 桌面端加密配置（bridgeSecretEnc），已按 --reset 要求覆盖。`,
    )
  }

  let cfg = (opts.reset || opts.logout) ? null : readConfig(configPath)
  if (cfg && (normalizeServerUrl(cfg.serverUrl) !== opts.server || !String(cfg.roomId || '').startsWith('usr_'))) {
    cfg = null
  }

  let accountDevices = []
  let authRevoked = false

  const bindAndSaveAccount = async (bound) => {
    const existingCfg = opts.reset ? null : readConfig(configPath)
    const preservedE2eeKey =
      existingCfg && existingCfg.roomId === bound.roomId
        ? normalizeE2eeKey(existingCfg.e2eeKey || '')
        : ''
    cfg = {
      mode: 'account',
      serverUrl: opts.server,
      userId: bound.userId,
      username: bound.username,
      roomId: bound.roomId,
      deviceId: bound.deviceId,
      bridgeId: bound.bridgeId,
      bridgeSecret: bound.deviceSecret,
      label: bound.label,
      ...(preservedE2eeKey ? { e2eeKey: preservedE2eeKey } : {}),
      createdAt: Date.now(),
    }
    saveConfig(configPath, cfg)
  }

  if (opts.username && opts.password) {
    console.log(`[allinone] 正在使用账号 @${opts.username} 绑定本机到 ${opts.server}...`)
    let bound = await loginDeviceWithAccount(opts.server, {
      username: opts.username,
      password: opts.password,
      label: opts.label,
    })
    if (bound?.requires2fa) {
      if (!process.stdin.isTTY) {
        throw new Error('该账号已开启登录邮箱二次验证，请在交互终端运行并输入验证码')
      }
      console.log(`[allinone] [2FA] ${bound.message || `已向 ${bound.maskedEmail || '绑定邮箱'} 发送 6 位登录验证码`}`)
      let verified = null
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const emailCode = await promptText('  邮箱验证码: ')
        if (!emailCode) {
          console.log('  [!] 验证码不能为空，请重试。')
          continue
        }
        try {
          const next = await loginDeviceWithAccount(opts.server, {
            username: opts.username,
            password: opts.password,
            label: opts.label,
            emailCode,
          })
          if (next?.requires2fa) {
            console.log(`  [!] 验证码校验未完成，请重试 (第 ${attempt}/5 次)`)
            continue
          }
          verified = next
          break
        } catch (err) {
          console.error(`  [!] ${String(err?.message || err)} (第 ${attempt}/5 次)`)
        }
      }
      if (!verified) {
        throw new Error('邮箱验证码验证失败，请稍后重试。')
      }
      bound = verified
    }
    if (!bound?.ok || !bound?.roomId || !bound?.deviceSecret) {
      throw new Error(bound?.error || '账号登录绑定未返回有效的设备凭证')
    }
    await bindAndSaveAccount(bound)
  } else if (cfg && String(cfg.roomId || '').startsWith('usr_')) {
    console.log(`[allinone] 已加载本机账号绑定 @${cfg.username || cfg.roomId} (${cfg.bridgeId})...`)
    try {
      const st = await fetchDeviceAccountStatus(opts.server, cfg.roomId, cfg.bridgeSecret)
      if (!st) {
        console.error('[allinone] ⚠ 本机绑定凭证已失效或已在手机端解绑，需要重新登录账号。')
        authRevoked = true
        cfg = null
      } else {
        accountDevices = st.devices || []
        if (st.label && st.label !== cfg.label) {
          cfg.label = st.label
          saveConfig(configPath, cfg)
        }
        if (st.username && !cfg.username) {
          cfg.username = st.username
          saveConfig(configPath, cfg)
        }
      }
    } catch (err) {
      console.warn(`[allinone] ⚠ 暂无法验证绑定状态（将自动尝试重连）：${String(err?.message || err)}`)
    }
  }

  if (!cfg) {
    if (process.stdin.isTTY) {
      const bound = await interactiveAccountLogin(opts.server, opts.label)
      await bindAndSaveAccount(bound)
    } else if (authRevoked) {
      console.error('[allinone] ✖ 本机绑定凭证已被吊销 (HTTP 401)，退出码 41。')
      process.exit(41)
    } else {
      throw new Error(
        '尚未登录账号绑定本机。请在交互式终端运行以输入用户名和密码，或通过 --username <用户名> --password <密码> 绑定。',
      )
    }
  }

  const e2eeHtmlPath = join(opts.stateDir, 'e2ee-key.html')

  let activeE2eeKey = ''
  const explicitKeyInput = String(opts.e2eeKey || '').trim()
  if (opts.e2eeKeyFromCli || explicitKeyInput) {
    const parsedExplicitKey = normalizeE2eeKey(explicitKeyInput)
    if (!parsedExplicitKey) {
      throw new Error('无效的端到端加密密钥（--e2ee-key 应为 256-bit Base64URL 密钥），请检查输入是否有误。')
    }
    activeE2eeKey = parsedExplicitKey
    if (opts.e2eeKeyFromCli) {
      cfg.e2eeKey = activeE2eeKey
      delete cfg.e2eeKeyEnc
      saveConfig(configPath, cfg)
    } else if (!cfg.e2eeKey && !cfg.e2eeKeyEnc && !BOOTSTRAP_ENV.e2eeKey) {
      cfg.e2eeKey = activeE2eeKey
      saveConfig(configPath, cfg)
    }
  } else {
    activeE2eeKey = normalizeE2eeKey(cfg.e2eeKey || '')
    if (!activeE2eeKey) {
      activeE2eeKey = generateE2eeKey()
      cfg.e2eeKey = activeE2eeKey
      delete cfg.e2eeKeyEnc
      saveConfig(configPath, cfg)
    }
  }
  const e2eeKeyId = await computeE2eeKeyId(activeE2eeKey)
  const e2eeFingerprint = formatE2eeFingerprint(e2eeKeyId)

  removeTempE2eeKeyPage = () => {
    if (e2eeHtmlCleanupTimer) {
      clearTimeout(e2eeHtmlCleanupTimer)
      e2eeHtmlCleanupTimer = null
    }
    if (existsSync(e2eeHtmlPath)) {
      try { unlinkSync(e2eeHtmlPath) } catch {}
    }
  }

  const writeE2eeKeyPage = (openNow = false) => {
    const html = buildE2eeKeyHtml({
      username: cfg.username || cfg.roomId,
      roomId: cfg.roomId,
      label: cfg.label || opts.label,
      e2eeKey: activeE2eeKey,
      e2eeFingerprint,
    })
    writeFileSync(e2eeHtmlPath, html, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(e2eeHtmlPath, 0o600) } catch {}
    if (e2eeHtmlCleanupTimer) clearTimeout(e2eeHtmlCleanupTimer)
    // Auto-unlink ephemeral QR page after 2 minutes so plaintext key does not linger on disk
    e2eeHtmlCleanupTimer = setTimeout(() => {
      e2eeHtmlCleanupTimer = null
      try { unlinkSync(e2eeHtmlPath) } catch {}
    }, 2 * 60 * 1000)
    e2eeHtmlCleanupTimer.unref?.()
    if (openNow && !opts.noBrowser) {
      openFileInBrowser(e2eeHtmlPath)
    }
  }

  // Never auto-write persistent plaintext e2ee-key.html on startup; delete any leftover file in desktop-managed mode
  const isDesktopManaged = Boolean(cfg.e2eeKeyEnc || opts.noBrowser || BOOTSTRAP_ENV.hadDesktopSecrets)
  if (isDesktopManaged && existsSync(e2eeHtmlPath)) {
    try { unlinkSync(e2eeHtmlPath) } catch {}
  }

  // Ensure DeepSeek Harness local IPC plugin is installed BEFORE initial getAppsStatus()
  const dshLog = {
    info: (msg) => console.log(msg.startsWith('[allinone]') ? msg : `[allinone] ${msg}`),
    warn: (msg) => console.warn(msg.startsWith('[allinone]') ? msg : `[allinone] ${msg}`),
  }
  try {
    ensureDshLocalIpcPlugin({ log: dshLog })
  } catch {}

  if (machineStdin?.isQuitRequested()) {
    await shutdown(0)
    return
  }

  let detectedApps = []

  let connectedOnce = false
  const wsBridgeUrl = toBridgeWsUrl(opts.server)
  let bridge = null

  const quietLog = {
    info: () => {},
    log: () => {},
    warn: (msg) => console.warn(`[allinone] ${msg}`),
    error: (msg) => console.error(`[allinone] ${msg}`),
  }
  orchestrator = new MultiAppOrchestrator({
    ctx: null,
    config: {
      cwd: opts.cwd,
      inboundDir: join(opts.stateDir, 'uploads'),
    },
    log: quietLog,
    onEvent: (event, payload) => link?.pushEvent(event, payload),
  })
  link = new RelayBridgeLink({
    relayUrl: wsBridgeUrl,
    secret: cfg.bridgeSecret,
    roomId: cfg.roomId,
    bridgeId: cfg.bridgeId,
    mode: opts.machineIpc ? 'desktop' : 'portable',
    bridgeVersion: BRIDGE_VERSION,
    e2eeKey: activeE2eeKey,
    inboundDir: orchestrator.inboundDir,
    inboundStore: orchestrator.inboundStore,
    log: quietLog,
    onRpc: (method, params, ctx) => orchestrator.handleRpc(method, params, ctx),
    onRegisterP2pUpload: (info) => orchestrator.registerP2pUpload(info),
    webrtcProxy:
      BOOTSTRAP_ENV.webrtcProxyPort > 0 && BOOTSTRAP_ENV.webrtcProxyToken
        ? { port: BOOTSTRAP_ENV.webrtcProxyPort, token: BOOTSTRAP_ENV.webrtcProxyToken }
        : null,
    onState: (state, detail) => {
      emitMachineEvent('state', { state, detail: String(detail || '') })
      if (state === 'connected') {
        if (!connectedOnce) {
          connectedOnce = true
          console.log('[allinone] ✓ 已加密连接到中转服务器，手机端现在可以实时操控本机！')
        } else {
          console.log('[allinone] ✓ 网络已恢复，重新连接成功。')
        }
      } else if (state === 'unauthorized' || state === 'fatal') {
        console.error(`[allinone] ✖ 本机连接被服务器拒绝 (${detail})，退出码 41。`)
        void shutdown(41)
      } else if (state === 'disconnected') {
        console.log(`[allinone] ⚠ 连接暂时中断 (${detail})，正在自动重连...`)
      } else if (state === 'error' && detail) {
        console.log(`[allinone] ⚠ 连接异常: ${detail}`)
      }
    },
  })

  const appsReadyPromise = orchestrator
    .getAppsStatus()
    .then((apps) => {
      link.setAppsMeta(apps)
      emitMachineEvent('apps', {
        apps: apps.map((a) => ({
          app: a.app,
          available: Boolean(a.available),
          writable: Boolean(a.writable),
        })),
      })
      return apps
    })
    .catch(() => [])

  bridge = {
    appsReadyPromise,
    stop: async () => {
      await link.stop()
      await orchestrator.dispose()
    },
  }
  if (machineStdin?.isQuitRequested() || exiting) {
    await shutdown(0)
    return
  }
  link.start()
  if (machineStdin) {
    // Wire live command handler and flush any buffered early `probe` / `quit` commands immediately
    machineStdin.setHandlers({
      onCommand: (cmd) => {
        if (cmd === 'resume' || cmd === 'probe' || cmd === 'reconnect') {
          link?.probeOrReconnect('system-resume')
        } else if (cmd === 'quit' || cmd === 'stop') {
          void shutdown(0)
        }
      },
      onEof: () => {
        void shutdown(0)
      },
    })
  }

  // Wait briefly for local AI tool detection so the status banner shows accurate tool availability
  detectedApps = await Promise.race([
    bridge.appsReadyPromise,
    new Promise((r) => setTimeout(() => r([]), 3500)),
  ])
  const bannerPrintedApps = detectedApps.length > 0

  printAccountBanner({
    serverUrl: opts.server,
    username: cfg.username || cfg.roomId,
    roomId: cfg.roomId,
    bridgeId: cfg.bridgeId,
    label: cfg.label || opts.label,
    apps: detectedApps,
    devices: accountDevices,
    e2eeFingerprint,
  })

  let lastDshWritable = null
  dshIpcWatchTimer = setInterval(async () => {
    try {
      const dshStatus = await orchestrator.adapters.dsh?.getStatus?.()
      if (!dshStatus) return
      const nowWritable = Boolean(dshStatus.writable)
      if (lastDshWritable !== null && nowWritable !== lastDshWritable) {
        const freshApps = await orchestrator.getAppsStatus()
        detectedApps = freshApps
        link.setAppsMeta(freshApps)
        emitMachineEvent('apps', {
          apps: freshApps.map((a) => ({ app: a.app, available: Boolean(a.available), writable: Boolean(a.writable) })),
        })
        const appSummary = freshApps
          .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
          .join(' | ')
        console.log(`  本机 AI    : ${appSummary}`)
      }
      lastDshWritable = nowWritable
    } catch {}
  }, 10_000)
  dshIpcWatchTimer.unref?.()

  void bridge.appsReadyPromise
    .catch(() => [])
    .then((apps) => {
      if (!bannerPrintedApps && Array.isArray(apps) && apps.length > 0) {
        detectedApps = apps
        const appSummary = apps
          .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
          .join(' | ')
        console.log(`  本机 AI    : ${appSummary}`)
      }
      const dshApp = Array.isArray(apps) ? apps.find((a) => a.app === 'dsh') : null
      if (dshApp) lastDshWritable = Boolean(dshApp.writable)
      return autoCompleteHalfInstalledClis({
        stateDir: opts.stateDir,
        log: {
          info: (msg) => console.log(`[allinone] ${msg}`),
          warn: (msg) => console.warn(`[allinone] ${msg}`),
        },
        onProgress: (ev) => {
          if (ev.phase === 'installing') {
            emitMachineEvent('autofix', { phase: 'installing', message: `正在自动补全 ${ev.displayName}...` })
            console.log(`[allinone] [autofix:progress] 正在自动补全 ${ev.displayName}...`)
          } else if (ev.phase === 'idle') {
            emitMachineEvent('autofix', { phase: 'idle', message: '' })
            console.log('[allinone] [autofix:idle]')
          }
        },
        onInstalled: async () => {
          orchestrator.refreshEnvironment()
          const freshApps = await orchestrator.getAppsStatus()
          detectedApps = freshApps
          link.setAppsMeta(freshApps)
          emitMachineEvent('apps', {
            apps: freshApps.map((a) => ({ app: a.app, available: Boolean(a.available), writable: Boolean(a.writable) })),
          })
          const appSummary = freshApps
            .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
            .join(' | ')
          console.log(`  本机 AI    : ${appSummary}`)
        },
      })
    })
    .catch(() => {})

  // Interactive terminal controls
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => {
      void shutdown(0)
    })
    rl.on('line', async (line) => {
      const cmd = line.trim().toLowerCase()
      if (cmd === 'k' || cmd === 'key' || cmd === 'e2ee') {
        writeE2eeKeyPage(true)
        console.log('')
        console.log(`[allinone] 端到端加密密钥指纹：${e2eeFingerprint}`)
        console.log(`[allinone] 恢复密钥（仅本机与手机保存）：${activeE2eeKey}`)
        console.log(`[allinone] 已生成临时离线二维码页面（2 分钟后或退出时自动销毁）：${e2eeHtmlPath}`)
        console.log('')
        return
      }
      if (cmd === 's' || cmd === 'status' || cmd === '') {
        try {
          const st = await fetchDeviceAccountStatus(opts.server, cfg.roomId, cfg.bridgeSecret)
          if (!st) {
            console.log('[allinone] ⚠ 本机绑定凭证已失效，请加 --logout 重新登录。')
            return
          }
          console.log(`\n[allinone] 账号 @${st.username} 绑定的电脑列表：`)
          for (const d of st.devices || []) {
            const flag = d.online ? '● 在线' : '○ 离线'
            const selfTag = d.bridgeId === cfg.bridgeId ? ' (本机)' : ''
            console.log(`  ${flag}  ${d.label} [${d.bridgeId}] (${d.platform})${selfTag}`)
          }
          console.log('')
        } catch (err) {
          console.error(`[allinone] 查询状态失败: ${String(err?.message || err)}`)
        }
        return
      }
      if (cmd === 'q' || cmd === 'exit') {
        await shutdown(0)
      }
    })
  }

  process.on('uncaughtException', (err) => {
    console.error('[allinone] ✖ 捕获到未处理致命异常，正在安全退出:', err?.stack || String(err))
    emitMachineEvent('fatal', { message: String(err?.message || err) })
    void shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[allinone] ⚠ 捕获到未处理的异步异常:', reason?.stack || String(reason))
  })
}

main().catch((err) => {
  const message = String(err?.message || err)
  emitMachineEvent('fatal', { message })
  console.error('\n[allinone] 启动失败：', message)
  process.exit(1)
})
