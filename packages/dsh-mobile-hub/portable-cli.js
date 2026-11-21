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

const DEFAULT_SERVER_URL =
  (typeof __ALLINONE_DEFAULT_SERVER__ === 'string' && __ALLINONE_DEFAULT_SERVER__) ||
  'http://127.0.0.1:8787'
const APK_FILENAME = 'All-in-One-v0.1.7.apk'
const BRIDGE_VERSION = '0.1.18'

function parseArgs(argv) {
  const opts = {
    server: process.env.ALLINONE_SERVER || DEFAULT_SERVER_URL,
    cwd: process.env.ALLINONE_CWD || os.homedir(),
    label: process.env.ALLINONE_PC_NAME || os.hostname() || 'My-PC',
    stateDir: process.env.ALLINONE_HOME || join(os.homedir(), '.allinone-bridge'),
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
    else if (a === '--state-dir') opts.stateDir = argv[++i] || opts.stateDir
    else if (a.startsWith('--state-dir=')) opts.stateDir = a.slice('--state-dir='.length)
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

async function registerNewRoom(serverUrl, label) {
  const res = await fetch(`${serverUrl}/api/rooms/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `注册设备房间失败 (HTTP ${res.status})`)
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
  const apkUrl = `${serverUrl}/${APK_FILENAME}`
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
      <div><strong>方式 1（最快捷）：</strong>手机浏览器 / 微信扫码，自动免密进入你的专属房间。</div>
      <div><strong>方式 2（Android APK）：</strong>安装 <a href="${escapeHtml(apkUrl)}" target="_blank">All-in-One Android 版</a>，打开后输入上方 8 位配对码即可（一次配对 30 天免登录）。</div>
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
    el.textContent = '配对码剩余有效期 ' + m + ':' + s + '（已配对的手机不受影响）';
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
  console.log(`  ★ 8 位配对码 :  ${pairCode}   (15 分钟有效)`)
  console.log(`  ★ 扫码直连   :  ${pairUrl}`)
  console.log(`  ★ 二维码页面 :  ${pairHtmlPath}`)
  console.log('--------------------------------------------------------------')
  console.log('  保持本窗口运行即可在手机远程操控本机 AI（可最小化）')
  if (process.stdin.isTTY) {
    console.log('  操作提示：[Enter] 刷新配对码  |  [O] 打开二维码页  |  [Ctrl+C] 退出')
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
  --server <url>    中转服务器地址 (默认: ${DEFAULT_SERVER_URL})
  --name <label>    本机显示名称 (默认: 本机主机名)
  --cwd <dir>       默认工作目录 (默认: 用户主目录)
  --reset           重新申请一个全新隔离房间
  --no-browser      不自动打开本地二维码网页
  -h, --help        显示帮助
`)
    process.exit(0)
  }

  mkdirSync(opts.stateDir, { recursive: true })
  try { chmodSync(opts.stateDir, 0o700) } catch {}

  const configPath = join(opts.stateDir, 'config.json')
  const pairHtmlPath = join(opts.stateDir, 'pair.html')

  let cfg = opts.reset ? null : readConfig(configPath)
  if (cfg && cfg.serverUrl !== opts.server) {
    cfg = null
  }

  let pairInfo = null
  if (!cfg) {
    console.log(`[allinone] 正在向 ${opts.server} 申请独立隔离房间...`)
    const created = await registerNewRoom(opts.server, opts.label)
    cfg = {
      serverUrl: opts.server,
      roomId: created.roomId,
      bridgeSecret: created.bridgeSecret,
      bridgeId: opts.label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'my-pc',
      label: created.label,
      createdAt: Date.now(),
    }
    saveConfig(configPath, cfg)
    pairInfo = created
  } else {
    console.log(`[allinone] 已加载本机房间 ${cfg.roomId}，正在获取新配对码...`)
    pairInfo = await refreshRoomPairCode(opts.server, cfg.roomId, cfg.bridgeSecret)
    if (!pairInfo) {
      console.log('[allinone] 原房间已失效，正在自动重新注册新房间...')
      const created = await registerNewRoom(opts.server, opts.label)
      cfg = {
        serverUrl: opts.server,
        roomId: created.roomId,
        bridgeSecret: created.bridgeSecret,
        bridgeId: opts.label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'my-pc',
        label: created.label,
        createdAt: Date.now(),
      }
      saveConfig(configPath, cfg)
      pairInfo = created
    }
  }

  let detectedApps = []
  const writePairPage = (openNow = false) => {
    const html = buildPairHtml({
      serverUrl: opts.server,
      roomId: cfg.roomId,
      label: cfg.label || opts.label,
      pairCode: pairInfo.pairCode,
      pairToken: pairInfo.pairToken,
      pairExpiresAt: pairInfo.pairExpiresAt,
      apps: detectedApps,
    })
    writeFileSync(pairHtmlPath, html, 'utf8')
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

  // Wait briefly for local AI tool detection so the QR page shows accurate tool availability
  detectedApps = await Promise.race([
    bridge.appsReadyPromise,
    new Promise((r) => setTimeout(() => r([]), 3500)),
  ])
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

  // Interactive terminal controls: Enter refreshes pairing code, O re-opens QR page
  let rl = null
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', async (line) => {
      const cmd = line.trim().toLowerCase()
      if (cmd === 'o' || cmd === 'open') {
        openFileInBrowser(pairHtmlPath)
        console.log('[allinone] 已在浏览器中打开二维码配对页面。')
        return
      }
      if (cmd === 'q' || cmd === 'exit') {
        await shutdown()
        return
      }
      try {
        const fresh = await refreshRoomPairCode(opts.server, cfg.roomId, cfg.bridgeSecret)
        if (!fresh) throw new Error('房间凭证已失效，请加 --reset 重启')
        pairInfo = fresh
        writePairPage(false)
        console.log('')
        console.log(`[allinone] ✓ 已生成新配对码：${pairInfo.pairCode}（15 分钟有效）`)
        console.log(`[allinone]   扫码直连：${opts.server}/?pair=${encodeURIComponent(pairInfo.pairToken)}`)
        console.log('[allinone]   提示：刷新二维码网页 (F5) 或输入 O 回车即可查看新二维码')
        console.log('')
      } catch (err) {
        console.error(`[allinone] 刷新配对码失败: ${String(err?.message || err)}`)
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
