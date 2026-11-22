#!/usr/bin/env node
/**
 * All in One — Portable PC Bridge CLI (Zero-Install Single-File Edition)
 *
 * Friends run a 1-line setup command on their PC; this CLI:
 *  1. Auto-registers an isolated private room on the Relay Server (saved in ~/.allinone-bridge/config.json)
 *  2. Connects outbound via WSS (no public IP, no router config, no firewall rules needed)
 *  3. Auto-detects locally installed AI coding agents (Codex / Claude Code / Antigravity / DeepSeek Harness)
 *  4. Generates a 100% offline SVG QR code + 8-char pairing code so the friend's phone connects in 3 seconds
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { RelayBridgeLink } from './src/ws-client.js'
import { renderQrSvg } from './src/helpers/qr-svg.js'
import { autoCompleteHalfInstalledClis } from './src/helpers/env-autofix.js'

const DEFAULT_SERVER_URL =
  (typeof __ALLINONE_DEFAULT_SERVER__ === 'string' && __ALLINONE_DEFAULT_SERVER__) ||
  'http://127.0.0.1:8787'
const CONFIGURED_APK_URL = String(process.env.ALLINONE_APK_URL || '').trim()
const BRIDGE_VERSION = '0.3.0'

function parseArgs(argv) {
  const opts = {
    server: process.env.ALLINONE_SERVER || DEFAULT_SERVER_URL,
    cwd: process.env.ALLINONE_CWD || os.homedir(),
    label: process.env.ALLINONE_PC_NAME || os.hostname() || 'My-PC',
    stateDir: process.env.ALLINONE_HOME || join(os.homedir(), '.allinone-bridge'),
    username: process.env.ALLINONE_USERNAME || '',
    password: process.env.ALLINONE_PASSWORD || '',
    inviteCode: process.env.ALLINONE_INVITE || '',
    logout: false,
    legacyPair: false,
    reset: false,
    noBrowser: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--server' || a === '-s') opts.server = argv[++i] || opts.server
    else if (a.startsWith('--server=')) opts.server = a.slice('--server='.length)
    else if (a === '--cwd' || a === '-c') opts.cwd = argv[++i] || opts.cwd
    else if (a.startsWith('--cwd=')) opts.cwd = a.slice('--cwd='.length)
    else if (a === '--name' || a === '-n') opts.label = argv[++i] || opts.label
    else if (a.startsWith('--name=')) opts.label = a.slice('--name='.length)
    else if (a === '--username' || a === '-u') opts.username = argv[++i] || opts.username
    else if (a.startsWith('--username=')) opts.username = a.slice('--username='.length)
    else if (a === '--password' || a === '-p') opts.password = argv[++i] || opts.password
    else if (a.startsWith('--password=')) opts.password = a.slice('--password='.length)
    else if (a === '--state-dir') opts.stateDir = argv[++i] || opts.stateDir
    else if (a.startsWith('--state-dir=')) opts.stateDir = a.slice('--state-dir='.length)
    else if (a === '--invite') opts.inviteCode = argv[++i] || opts.inviteCode
    else if (a.startsWith('--invite=')) opts.inviteCode = a.slice('--invite='.length)
    else if (a === '--logout' || a === '--login') opts.logout = true
    else if (a === '--legacy-pair') opts.legacyPair = true
    else if (a === '--reset') opts.reset = true
    else if (a === '--no-browser') opts.noBrowser = true
    else if (a === '--help' || a === '-h') opts.help = true
  }
  opts.server = String(opts.server || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '')
  return opts
}

function toBridgeWsUrl(httpBase) {
  const u = new URL(`${httpBase}/ws/bridge`)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (parsed?.roomId && parsed?.bridgeSecret) return parsed
  } catch {}
  return null
}

function saveConfig(configPath, cfg) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8')
  try { chmodSync(configPath, 0o600) } catch {}
}

async function loginDeviceWithAccount(serverUrl, { username, password, label }) {
  const res = await fetch(`${serverUrl}/api/account/device-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(username || '').trim(),
      password: String(password ?? ''),
      label: String(label || os.hostname() || 'My PC').trim(),
      hostname: os.hostname() || 'My-PC',
      platform: process.platform,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `账号登录失败 (HTTP ${res.status})`)
  }
  return data
}

async function fetchDeviceAccountStatus(serverUrl, roomId, bridgeSecret) {
  const res = await fetch(`${serverUrl}/api/account/device-status`, {
    method: 'GET',
    headers: {
      'X-Room-Id': roomId,
      'X-Bridge-Secret': bridgeSecret,
    },
  })
  if (res.status === 401) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `查询设备状态失败 (HTTP ${res.status})`)
  }
  return data
}

function promptText(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (ans) => {
      rl.close()
      resolve(String(ans || '').trim())
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

    const onData = (buf) => {
      const str = buf.toString('utf8')
      for (const ch of str) {
        if (ch === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(wasRaw)
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          process.exit(130)
        } else if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw)
          stdin.removeListener('data', onData)
          stdin.pause()
          process.stdout.write('\n')
          resolve(value)
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
  console.log(`  没有账号？请先用管理员分享的一次性邀请码在 ${serverUrl}/ 注册`)
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
      const bound = await loginDeviceWithAccount(serverUrl, { username, password, label })
      console.log(`  ✓ 绑定成功！欢迎 @${bound.username}（设备标识: ${bound.bridgeId}）`)
      return bound
    } catch (err) {
      console.error(`  [!] ${String(err?.message || err)} (第 ${attempt}/5 次)\n`)
    }
  }
  throw new Error('连续多次账号验证失败，已退出。')
}

function printAccountBanner({ serverUrl, username, roomId, bridgeId, label, apps, devices = [] }) {
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
  if (appSummary) console.log(`  本机 AI    : ${appSummary}`)
  if (devices.length > 0) {
    const onlineCount = devices.filter((d) => d.online).length
    console.log(`  账号下电脑 : 共 ${devices.length} 台绑定（当前 ${Math.max(1, onlineCount)} 台在线）`)
  }
  console.log('--------------------------------------------------------------')
  console.log('  ★ 手机端打开 App / 网页登录同一账号，即可自动连接本机！')
  console.log('  ★ 保持本窗口运行即可远程操控本机 AI（可最小化）')
  if (process.stdin.isTTY) {
    console.log('  操作提示：[S] 查看全部电脑  |  [R] 踢出全部手机  |  [Ctrl+C] 退出')
  }
  console.log('==============================================================')
  console.log('')
}

async function registerNewRoom(serverUrl, label, inviteCode = '') {
  const headers = { 'Content-Type': 'application/json' }
  if (inviteCode) headers['X-Invite-Code'] = inviteCode
  const res = await fetch(`${serverUrl}/api/rooms/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label, ...(inviteCode ? { inviteCode } : {}) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `注册设备房间失败 (HTTP ${res.status})`)
  }
  return data
}

async function revokeRoomSessions(serverUrl, roomId, bridgeSecret) {
  const res = await fetch(`${serverUrl}/api/rooms/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Id': roomId,
      'X-Bridge-Secret': bridgeSecret,
    },
    body: '{}',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `吊销设备会话失败 (HTTP ${res.status})`)
  }
  return data
}

async function refreshRoomPairCode(serverUrl, roomId, bridgeSecret) {
  const res = await fetch(`${serverUrl}/api/rooms/pair-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Id': roomId,
      'X-Bridge-Secret': bridgeSecret,
    },
    body: '{}',
  })
  if (res.status === 401) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `刷新配对码失败 (HTTP ${res.status})`)
  }
  return data
}

function openFileInBrowser(filePath) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', filePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [filePath], { detached: true, stdio: 'ignore' })
      child.unref()
    } else {
      const child = spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' })
      child.unref()
    }
  } catch {}
}

function buildPairHtml({ serverUrl, roomId, label, pairCode, pairToken, pairExpiresAt, apps = [] }) {
  const pairUrl = `${serverUrl}/?pair=${encodeURIComponent(pairToken)}`
  const apkUrl = CONFIGURED_APK_URL
    ? (/^https?:\/\//i.test(CONFIGURED_APK_URL) ? CONFIGURED_APK_URL : `${serverUrl}/${CONFIGURED_APK_URL.replace(/^\/+/, '')}`)
    : ''
  const qrSvg = renderQrSvg(pairUrl, { pixelSize: 220, quietZone: 4, darkColor: '#0B1220', lightColor: '#FFFFFF' })

  const appNames = {
    codex: 'Codex',
    claude: 'Claude Code',
    antigravity: 'Antigravity',
    dsh: 'DeepSeek Harness',
  }
  const appPills = apps.length > 0
    ? apps.map((a) => {
        const ready = a.available && a.writable
        const ro = a.available && !a.writable
        const cls = ready ? 'pill-on' : ro ? 'pill-ro' : 'pill-off'
        const tag = ready ? '可用' : ro ? '只读' : '未安装'
        return `<span class="pill ${cls}">${escapeHtml(appNames[a.app] || a.app)} · ${tag}</span>`
      }).join('')
    : '<span class="pill pill-ro">正在检测本机 AI 工具...</span>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>All in One · 扫码连接你的电脑</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; color: #F1F5F9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(circle at 50% 0%, #172554 0%, #090C15 55%, #05070C 100%);
  }
  .card {
    width: 100%; max-width: 460px; border-radius: 28px; padding: 28px 26px 24px;
    background: rgba(18, 22, 34, 0.92); border: 1px solid rgba(148, 163, 184, 0.16);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55); text-align: center;
  }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .sub { font-size: 13px; color: #94A3B8; margin: 6px 0 18px; }
  .qr-wrap {
    display: inline-flex; padding: 14px; border-radius: 22px; background: #FFFFFF;
    box-shadow: 0 10px 30px rgba(77, 107, 254, 0.25);
  }
  .code-box {
    margin: 18px auto 0; padding: 14px 16px; border-radius: 18px;
    background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(99, 102, 241, 0.28);
  }
  .code-label { font-size: 11.5px; color: #94A3B8; margin-bottom: 6px; }
  .code-row { display: flex; align-items: center; justify-content: center; gap: 10px; }
  .code-val {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 28px; font-weight: 800; letter-spacing: 0.12em; color: #FFFFFF;
  }
  .btn {
    border: 0; border-radius: 10px; padding: 7px 12px; font-size: 12px; font-weight: 600;
    background: #4D6BFE; color: #FFFFFF; cursor: pointer;
  }
  .btn:hover { background: #3B5BFE; }
  .timer { margin-top: 8px; font-size: 12px; color: #60A5FA; }
  .timer.expired { color: #FB7185; font-weight: 600; }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 16px; }
  .pill { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid transparent; }
  .pill-on { background: rgba(16, 185, 129, 0.14); color: #6EE7B7; border-color: rgba(16, 185, 129, 0.3); }
  .pill-ro { background: rgba(245, 158, 11, 0.14); color: #FCD34D; border-color: rgba(245, 158, 11, 0.3); }
  .pill-off { background: rgba(148, 163, 184, 0.1); color: #64748B; }
  .steps {
    margin-top: 18px; padding: 12px 14px; border-radius: 16px; text-align: left;
    background: rgba(15, 23, 42, 0.72); font-size: 12px; line-height: 1.65; color: #CBD5E1;
  }
  .steps a { color: #818CF8; text-decoration: none; }
  .steps a:hover { text-decoration: underline; }
  .foot { margin-top: 14px; font-size: 11px; color: #64748B; }
</style>
</head>
<body>
  <div class="card">
    <h1 class="brand">All in One · 电脑已就绪</h1>
    <p class="sub">${escapeHtml(label)} · 手机扫码或输入下方配对码即可连接</p>

    <div class="qr-wrap">${qrSvg}</div>

    <div class="code-box">
      <div class="code-label">8 位一次性配对码（Android App / 浏览器通用）</div>
      <div class="code-row">
        <span class="code-val" id="pairCode">${escapeHtml(pairCode)}</span>
        <button class="btn" id="copyBtn" type="button">复制</button>
      </div>
      <div class="timer" id="timer">有效期计算中...</div>
    </div>

    <div class="pills">${appPills}</div>

    <div class="steps">
      <div><strong>方式 1（最快捷）：</strong>手机浏览器扫码直接进入（建议「添加到主屏幕」作为 PWA 使用）。</div>
      ${apkUrl ? `<div><strong>方式 2（Android APK）：</strong>安装 <a href="${escapeHtml(apkUrl)}" target="_blank">All in One Android 版</a>，打开后输入上方 8 位配对码即可。</div>` : ''}
      <div><strong>提示：</strong>请保持电脑端命令行窗口运行（可最小化），关闭后手机将暂停连接。</div>
    </div>

    <div class="foot">独立隔离房间 ${escapeHtml(roomId)} · 二维码 100% 本地生成，不会上传第三方</div>
  </div>
<script>
  const expiresAt = ${Number(pairExpiresAt) || 0};
  const codeText = ${JSON.stringify(pairCode)};
  document.getElementById('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(codeText); } catch {}
    const btn = document.getElementById('copyBtn');
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  });
  function tick() {
    const el = document.getElementById('timer');
    const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    if (left <= 0) {
      el.className = 'timer expired';
      el.textContent = '配对码已过期 — 请回到命令行窗口按回车 (Enter) 刷新后，再刷新本页';
      return;
    }
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, '0');
    el.textContent = '一次性配对码剩余有效期 ' + m + ':' + s + '（配对成功即失效，已配对手机不受影响）';
  }
  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>`
}

function printBanner({ serverUrl, roomId, label, pairCode, pairToken, pairHtmlPath, apps }) {
  const pairUrl = `${serverUrl}/?pair=${encodeURIComponent(pairToken)}`
  const appSummary = (apps || [])
    .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
    .join(' | ')

  console.log('')
  console.log('==============================================================')
  console.log(`  All in One 电脑端桥接 v${BRIDGE_VERSION}  [${label}]`)
  console.log('==============================================================')
  console.log(`  中转服务器 : ${serverUrl}`)
  console.log(`  独立房间号 : ${roomId} (与其他用户完全隔离)`)
  if (appSummary) console.log(`  本机 AI    : ${appSummary}`)
  console.log('--------------------------------------------------------------')
  console.log(`  ★ 8 位配对码 :  ${pairCode}   (一次性有效，15 分钟过期)`)
  console.log(`  ★ 扫码直连   :  ${pairUrl}`)
  console.log(`  ★ 二维码页面 :  ${pairHtmlPath}`)
  console.log('--------------------------------------------------------------')
  console.log('  保持本窗口运行即可在手机远程操控本机 AI（可最小化）')
  if (process.stdin.isTTY) {
    console.log('  操作提示：[Enter] 刷新配对码  |  [O] 打开二维码页  |  [R] 踢出所有手机  |  [Ctrl+C] 退出')
  }
  console.log('==============================================================')
  console.log('')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(`All in One Portable PC Bridge v${BRIDGE_VERSION}

用法:
  node allinone-bridge.mjs [选项]

选项:
  --server <url>      中转服务器地址 (默认: ${DEFAULT_SERVER_URL})
  --name <label>      本机显示名称 (默认: 本机主机名)
  --cwd <dir>         默认工作目录 (默认: 用户主目录)
  -u, --username <u>  账号用户名（用于无交互自动绑定本机）
  -p, --password <p>  账号密码（仅用于首次换取单机密钥，绝不落盘）
  --logout            退出当前账号绑定并重新登录
  --legacy-pair       使用旧版匿名独立房间 + 二维码配对模式
  --invite <code>     旧版房间注册邀请码
  --reset             清除本地配置并重新绑定
  --no-browser        不自动打开本地二维码网页
  -h, --help          显示帮助
`)
    process.exit(0)
  }

  mkdirSync(opts.stateDir, { recursive: true })
  try { chmodSync(opts.stateDir, 0o700) } catch {}

  const configPath = join(opts.stateDir, 'config.json')
  const pairHtmlPath = join(opts.stateDir, 'pair.html')

  let cfg = (opts.reset || opts.logout) ? null : readConfig(configPath)
  if (cfg && cfg.serverUrl !== opts.server) {
    cfg = null
  }

  let accountDevices = []
  let pairInfo = null

  const bindAndSaveAccount = async (bound) => {
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
      createdAt: Date.now(),
    }
    saveConfig(configPath, cfg)
  }

  if (opts.username && opts.password) {
    console.log(`[allinone] 正在使用账号 @${opts.username} 绑定本机到 ${opts.server}...`)
    const bound = await loginDeviceWithAccount(opts.server, {
      username: opts.username,
      password: opts.password,
      label: opts.label,
    })
    await bindAndSaveAccount(bound)
  } else if (cfg && String(cfg.roomId || '').startsWith('usr_')) {
    console.log(`[allinone] 已加载本机账号绑定 @${cfg.username || cfg.roomId} (${cfg.bridgeId})...`)
    try {
      const st = await fetchDeviceAccountStatus(opts.server, cfg.roomId, cfg.bridgeSecret)
      if (!st) {
        console.log('[allinone] ⚠ 本机绑定凭证已失效或已在手机端解绑，需要重新登录账号。')
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
  } else if (cfg && String(cfg.roomId || '').startsWith('rm_') && !opts.legacyPair) {
    console.log(`[allinone] 已加载旧版独立房间 ${cfg.roomId}，正在获取新配对码...`)
    console.log('[allinone] 提示：加 --logout 重启可切换为新版「账号登录」模式（手机登一次账号自动同步所有电脑）。')
    pairInfo = await refreshRoomPairCode(opts.server, cfg.roomId, cfg.bridgeSecret)
    if (!pairInfo) {
      console.log('[allinone] 原房间已失效，将进入账号登录绑定...')
      cfg = null
    }
  }

  if (!cfg) {
    if (opts.legacyPair) {
      console.log(`[allinone] 正在向 ${opts.server} 申请旧版独立隔离房间...`)
      const created = await registerNewRoom(opts.server, opts.label, opts.inviteCode)
      cfg = {
        mode: 'legacy',
        serverUrl: opts.server,
        roomId: created.roomId,
        bridgeSecret: created.bridgeSecret,
        bridgeId: opts.label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'my-pc',
        label: created.label,
        createdAt: Date.now(),
      }
      saveConfig(configPath, cfg)
      pairInfo = created
    } else if (process.stdin.isTTY) {
      const bound = await interactiveAccountLogin(opts.server, opts.label)
      await bindAndSaveAccount(bound)
    } else {
      throw new Error(
        '尚未登录账号绑定本机。请在交互式终端运行以输入用户名和密码，或通过 --username <用户名> --password <密码> 绑定。',
      )
    }
  }

  const isAccountMode = String(cfg.roomId || '').startsWith('usr_')

  let detectedApps = []
  const writePairPage = (openNow = false) => {
    if (isAccountMode || !pairInfo) return
    const html = buildPairHtml({
      serverUrl: opts.server,
      roomId: cfg.roomId,
      label: cfg.label || opts.label,
      pairCode: pairInfo.pairCode,
      pairToken: pairInfo.pairToken,
      pairExpiresAt: pairInfo.pairExpiresAt,
      apps: detectedApps,
    })
    writeFileSync(pairHtmlPath, html, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(pairHtmlPath, 0o600) } catch {}
    if (openNow && !opts.noBrowser) {
      openFileInBrowser(pairHtmlPath)
    }
  }

  let connectedOnce = false
  const wsBridgeUrl = toBridgeWsUrl(opts.server)
  let link = null
  const quietLog = {
    info: () => {},
    log: () => {},
    warn: (msg) => console.warn(`[allinone] ${msg}`),
    error: (msg) => console.error(`[allinone] ${msg}`),
  }
  const orchestrator = new MultiAppOrchestrator({
    ctx: null,
    config: {
      relayUrl: wsBridgeUrl,
      secret: cfg.bridgeSecret,
      roomId: cfg.roomId,
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
    mode: 'portable',
    log: quietLog,
    onRpc: (method, params) => orchestrator.handleRpc(method, params),
    onState: (state, detail) => {
      if (state === 'connected') {
        if (!connectedOnce) {
          connectedOnce = true
          console.log('[allinone] ✓ 已加密连接到中转服务器，手机端现在可以实时操控本机！')
        } else {
          console.log('[allinone] ✓ 网络已恢复，重新连接成功。')
        }
      } else if (state === 'unauthorized') {
        console.error(`[allinone] ✖ 本机已被解绑或凭证失效 (${detail})，请加 --logout 重新登录账号绑定。`)
      } else if (state === 'disconnected') {
        console.log(`[allinone] ⚠ 连接暂时中断 (${detail})，正在自动重连...`)
      } else if (state === 'error' && detail) {
        console.log(`[allinone] ⚠ 连接异常: ${detail}`)
      }
    },
  })
  link.start()

  const appsReadyPromise = orchestrator.getAppsStatus().then((apps) => {
    link.setAppsMeta(apps)
    return apps
  })

  const bridge = {
    appsReadyPromise,
    stop: async () => {
      link.stop()
      await orchestrator.dispose()
    },
  }

  // Wait briefly for local AI tool detection so the status banner / QR page shows accurate tool availability
  detectedApps = await Promise.race([
    bridge.appsReadyPromise,
    new Promise((r) => setTimeout(() => r([]), 3500)),
  ])

  if (isAccountMode) {
    printAccountBanner({
      serverUrl: opts.server,
      username: cfg.username || cfg.roomId,
      roomId: cfg.roomId,
      bridgeId: cfg.bridgeId,
      label: cfg.label || opts.label,
      apps: detectedApps,
      devices: accountDevices,
    })
  } else {
    writePairPage(true)
    printBanner({
      serverUrl: opts.server,
      roomId: cfg.roomId,
      label: cfg.label || opts.label,
      pairCode: pairInfo.pairCode,
      pairToken: pairInfo.pairToken,
      pairHtmlPath,
      apps: detectedApps,
    })
    // Update pair.html once full app detection completes if it took >3.5s
    bridge.appsReadyPromise.then((apps) => {
      if (detectedApps.length === 0 && apps?.length > 0) {
        detectedApps = apps
        writePairPage(false)
      }
    }).catch(() => {})
  }

  // Silently detect & auto-complete any half-installed AI CLIs in the background
  // (e.g. Antigravity.app installed without `agy`, or ~/.claude/projects without `claude`)
  // and hot-refresh adapter readiness + models with zero user prompts.
  void bridge.appsReadyPromise
    .catch(() => [])
    .then(() =>
      autoCompleteHalfInstalledClis({
        stateDir: opts.stateDir,
        log: {
          info: (msg) => console.log(`[allinone] ${msg}`),
          warn: (msg) => console.warn(`[allinone] ${msg}`),
        },
        onProgress: (ev) => {
          if (ev.phase === 'installing') {
            console.log(`[allinone] [autofix:progress] 正在自动补全 ${ev.displayName}...`)
          } else if (ev.phase === 'idle') {
            console.log('[allinone] [autofix:idle]')
          }
        },
        onInstalled: async () => {
          orchestrator.refreshEnvironment()
          const freshApps = await orchestrator.getAppsStatus()
          detectedApps = freshApps
          link.setAppsMeta(freshApps)
          const appSummary = freshApps
            .map((a) => `${a.app}:${a.available ? (a.writable ? '就绪' : '只读') : '未安装'}`)
            .join(' | ')
          console.log(`  本机 AI    : ${appSummary}`)
          if (!isAccountMode) {
            try { writePairPage(false) } catch {}
          }
        },
      }),
    )
    .catch(() => {})

  // Interactive terminal controls
  let rl = null
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', async (line) => {
      const cmd = line.trim().toLowerCase()
      if (isAccountMode && (cmd === 's' || cmd === 'status' || cmd === '')) {
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
      if (!isAccountMode && (cmd === 'o' || cmd === 'open')) {
        openFileInBrowser(pairHtmlPath)
        console.log('[allinone] 已在浏览器中打开二维码配对页面。')
        return
      }
      if (cmd === 'r' || cmd === 'revoke') {
        try {
          const res = await revokeRoomSessions(opts.server, cfg.roomId, cfg.bridgeSecret)
          console.log('')
          console.log(
            `[allinone] ✓ 已吊销所有已登录手机凭证（已断开 ${res.disconnectedClients || 0} 个在线连接）！`,
          )
          if (!isAccountMode) {
            console.log('[allinone]   按回车 (Enter) 可生成新的配对码重新配对手机。')
          } else {
            console.log('[allinone]   手机端需重新使用账号密码登录。')
          }
          console.log('')
        } catch (err) {
          console.error(`[allinone] 吊销手机会话失败: ${String(err?.message || err)}`)
        }
        return
      }
      if (cmd === 'q' || cmd === 'exit') {
        await shutdown()
        return
      }
      if (!isAccountMode) {
        try {
          const fresh = await refreshRoomPairCode(opts.server, cfg.roomId, cfg.bridgeSecret)
          if (!fresh) throw new Error('房间凭证已失效，请加 --reset 重启')
          pairInfo = fresh
          writePairPage(false)
          console.log('')
          console.log(`[allinone] ✓ 已生成新配对码：${pairInfo.pairCode}（一次性有效，15 分钟过期）`)
          console.log(`[allinone]   扫码直连：${opts.server}/?pair=${encodeURIComponent(pairInfo.pairToken)}`)
          console.log('[allinone]   提示：刷新二维码网页 (F5) 或输入 O 回车即可查看新二维码')
          console.log('')
        } catch (err) {
          console.error(`[allinone] 刷新配对码失败: ${String(err?.message || err)}`)
        }
      }
    })
  }

  let exiting = false
  async function shutdown() {
    if (exiting) return
    exiting = true
    console.log('\n[allinone] 正在断开桥接并安全退出...')
    try { rl?.close() } catch {}
    await bridge.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (err) => {
    console.error('[allinone] ⚠ 捕获到未处理异常（桥接保持在线）:', err?.stack || String(err))
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[allinone] ⚠ 捕获到未处理的异步异常（桥接保持在线）:', reason?.stack || String(reason))
  })
}

main().catch((err) => {
  console.error('\n[allinone] 启动失败：', String(err?.message || err))
  process.exit(1)
})
