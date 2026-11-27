/**
 * Silent Automatic Completion for Half-Installed Local AI Environments.
 *
 * Philosophy:
 *  - NEVER install tools the user doesn't use (clean machine -> does nothing).
 *  - ONLY when a "half-installed" state is detected (the user clearly uses an AI tool
 *    via its desktop app or existing local session store, yet its companion CLI binary
 *    is missing), automatically install the official CLI in the background with zero
 *    user prompts or manual decisions required.
 *  - Hot-refreshes PATH and notifies the running bridge so the tool flips from
 *    read-only / unavailable to green & writable seamlessly.
 *  - Includes failure cooldown (6h) to prevent retry storms offline, per-step timeouts,
 *    system proxy inheritance (including macOS `scutil --proxy` for GUI Electron launches),
 *    and an opt-out escape hatch (`ALLINONE_NO_AUTOFIX=1`).
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  ensureRichPath,
  findExecutable,
  getAgyCandidates,
  getClaudeCandidates,
  getCodebuddyCandidates,
  getCodexCandidates,
  isExecutableFile,
  killProcessTree,
  sanitizeChildEnv,
  spawnCrossPlatform,
} from './bin-finder.js'

const TRUSTED_INSTALLER_HOSTS = new Set([
  'antigravity.google',
  'claude.ai',
  'www.codebuddy.cn',
])

const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000 // 6 hours after failed attempt
const INSTALL_TIMEOUT_MS = 180_000 // 3 minutes per official installer

let activeRunPromise = null

function readAutofixState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return {}
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAutofixState(stateFile, state) {
  if (!stateFile) return
  try {
    mkdirSync(join(stateFile, '..'), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    try { chmodSync(stateFile, 0o600) } catch {}
  } catch {}
}

/**
 * Detect active macOS system proxy (e.g., Clash / Surge / V2Ray) when launched from GUI
 * where terminal `HTTPS_PROXY` env vars are not inherited.
 */
export function detectSystemProxyEnv(baseEnv = process.env, platform = process.platform) {
  const env = { ...baseEnv }
  if (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) {
    return env
  }
  if (platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: sanitizeChildEnv(env),
      })
      const readField = (key) => {
        const m = out.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))
        return m ? m[1].trim() : ''
      }
      if (readField('HTTPSEnable') === '1') {
        const host = readField('HTTPSProxy')
        const port = readField('HTTPSPort')
        if (host && port) {
          env.HTTPS_PROXY = `http://${host}:${port}`
          env.https_proxy = env.HTTPS_PROXY
        }
      }
      if (readField('HTTPEnable') === '1') {
        const host = readField('HTTPProxy')
        const port = readField('HTTPPort')
        if (host && port) {
          env.HTTP_PROXY = `http://${host}:${port}`
          env.http_proxy = env.HTTP_PROXY
        }
      }
      if (!env.HTTPS_PROXY && readField('SOCKSEnable') === '1') {
        const host = readField('SOCKSProxy')
        const port = readField('SOCKSPort')
        if (host && port) {
          env.ALL_PROXY = `socks5h://${host}:${port}`
          env.all_proxy = env.ALL_PROXY
        }
      }
    } catch {}
  }
  return env
}

function hasAnyPath(paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return true
  }
  return false
}

function defaultCheckBin(names, candidates) {
  return findExecutable(names, candidates)
}

/**
 * Detect ONLY half-installed AI environments (desktop app or local session/auth state exists,
 * while its companion CLI binary is missing).
 */
export function detectHalfInstalledClis({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
  checkBin = defaultCheckBin,
  checkSystemApps = true,
} = {}) {
  const missing = []
  const localApp = env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local')

  // 1. Antigravity: desktop app or ~/.gemini/antigravity exists, but `agy` CLI is missing
  const agyDataEvidence = [
    join(homeDir, '.gemini', 'antigravity'),
    join(homeDir, 'Applications', 'Antigravity.app'),
  ]
  if (checkSystemApps) {
    if (platform === 'darwin') agyDataEvidence.push('/Applications/Antigravity.app')
    else if (platform === 'win32') {
      agyDataEvidence.push(
        join(localApp, 'Programs', 'Antigravity'),
        join(localApp, 'Antigravity'),
      )
    } else {
      agyDataEvidence.push('/usr/share/applications/antigravity.desktop')
    }
  }
  if (hasAnyPath(agyDataEvidence)) {
    const agyNames = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy']
    const agyBin = checkBin(agyNames, getAgyCandidates(homeDir, platform, env))
    if (!agyBin) {
      missing.push({
        app: 'antigravity',
        displayName: 'Antigravity CLI (agy)',
        reason: '检测到本机已有 Antigravity 应用/会话数据，但缺少 agy 命令行工具',
        steps:
          platform === 'win32'
            ? [
                {
                  label: 'official-ps1',
                  kind: 'remote-script',
                  requiresConfirmation: true,
                  scriptUrl: 'https://antigravity.google/cli/install.ps1',
                  shell: 'powershell',
                  manualCommand: 'irm https://antigravity.google/cli/install.ps1 | iex',
                },
              ]
            : [
                {
                  label: 'official-sh',
                  kind: 'remote-script',
                  requiresConfirmation: true,
                  scriptUrl: 'https://antigravity.google/cli/install.sh',
                  shell: 'bash',
                  manualCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
                },
              ],
        verify: () => {
          ensureRichPath(true)
          return Boolean(findExecutable(agyNames, getAgyCandidates(homeDir, platform, env)))
        },
      })
    }
  }

  // 2. Claude Code: ~/.claude/projects or credentials/settings exist, but `claude` CLI is missing
  const claudeEvidence = [
    join(homeDir, '.claude', 'projects'),
    join(homeDir, '.claude', '.credentials.json'),
    join(homeDir, '.claude', 'settings.json'),
  ]
  if (hasAnyPath(claudeEvidence)) {
    const claudeNames = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
    const claudeBin = checkBin(claudeNames, getClaudeCandidates(homeDir, platform, env))
    if (!claudeBin) {
      const steps = []
      const npmBin = checkBin(platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'], [])
      if (npmBin) {
        steps.push({
          label: 'npm-global',
          cmd: npmBin,
          args: ['install', '-g', '@anthropic-ai/claude-code'],
        })
      }
      steps.push(
        platform === 'win32'
          ? {
              label: 'official-ps1',
              kind: 'remote-script',
              requiresConfirmation: true,
              scriptUrl: 'https://claude.ai/install.ps1',
              shell: 'powershell',
              manualCommand: 'irm https://claude.ai/install.ps1 | iex',
            }
          : {
              label: 'official-sh',
              kind: 'remote-script',
              requiresConfirmation: true,
              scriptUrl: 'https://claude.ai/install.sh',
              shell: 'bash',
              manualCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
            },
      )
      missing.push({
        app: 'claude',
        displayName: 'Claude Code CLI (claude)',
        reason: '检测到本机已有 Claude Code 会话/配置，但缺少 claude 命令行工具',
        steps,
        verify: () => {
          ensureRichPath(true)
          return Boolean(findExecutable(claudeNames, getClaudeCandidates(homeDir, platform, env)))
        },
      })
    }
  }

  // 3. ChatGPT (formerly Codex): ~/.codex sessions/auth/config or ChatGPT/Codex desktop app exists, but `codex` binary is missing
  const codexEvidence = [
    join(homeDir, '.codex', 'sessions'),
    join(homeDir, '.codex', 'auth.json'),
    join(homeDir, '.codex', 'config.toml'),
    join(homeDir, 'Applications', 'ChatGPT.app'),
    join(homeDir, 'Applications', 'Codex.app'),
  ]
  if (checkSystemApps) {
    if (platform === 'darwin') codexEvidence.push('/Applications/ChatGPT.app', '/Applications/Codex.app')
    else if (platform === 'win32') {
      codexEvidence.push(join(localApp, 'Programs', 'ChatGPT'), join(localApp, 'Programs', 'Codex'))
    }
  }
  if (hasAnyPath(codexEvidence)) {
    const codexNames = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
    const codexBin = checkBin(codexNames, getCodexCandidates(homeDir, platform, env))
    if (!codexBin) {
      const steps = []
      const npmBin = checkBin(platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'], [])
      if (npmBin) {
        steps.push({
          label: 'npm-global',
          cmd: npmBin,
          args: ['install', '-g', '@openai/codex'],
        })
      }
      if (platform === 'darwin') {
        const brewBin = checkBin(['brew'], ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'])
        if (brewBin) {
          steps.push({
            label: 'homebrew',
            cmd: brewBin,
            args: ['install', 'codex'],
          })
        }
      }
      if (steps.length > 0) {
        missing.push({
          app: 'codex',
          displayName: 'ChatGPT CLI (codex)',
          reason: '检测到本机已有 ChatGPT (Codex) 会话/配置，但缺少 codex 命令行工具',
          steps,
          verify: () => {
            ensureRichPath(true)
            return Boolean(findExecutable(codexNames, getCodexCandidates(homeDir, platform, env)))
          },
        })
      }
    }
  }

  // 4. WorkBuddy: ~/.workbuddy or ~/.codebuddy or WorkBuddy desktop app exists, but standalone `codebuddy` CLI is missing
  const workbuddyEvidence = [
    join(homeDir, '.workbuddy', 'workbuddy.db'),
    join(homeDir, '.workbuddy', 'projects'),
    join(homeDir, '.codebuddy', 'projects'),
    join(homeDir, 'Applications', 'WorkBuddy.app'),
  ]
  if (checkSystemApps) {
    if (platform === 'darwin') workbuddyEvidence.push('/Applications/WorkBuddy.app')
    else if (platform === 'win32') {
      workbuddyEvidence.push(
        join(localApp, 'WorkBuddy'),
        join(localApp, 'Programs', 'WorkBuddy'),
      )
    }
  }
  if (hasAnyPath(workbuddyEvidence)) {
    const cbNames = platform === 'win32'
      ? ['codebuddy.exe', 'codebuddy.cmd', 'cbc.exe', 'cbc.cmd', 'codebuddy', 'cbc']
      : ['codebuddy', 'cbc']
    const cbBin = checkBin(cbNames, getCodebuddyCandidates(homeDir, platform, env))
    if (!cbBin) {
      const steps = []
      const npmBin = checkBin(platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'], [])
      if (npmBin) {
        steps.push({
          label: 'npm-global',
          cmd: npmBin,
          args: ['install', '-g', '@tencent-ai/codebuddy-code'],
        })
      }
      steps.push(
        platform === 'win32'
          ? {
              label: 'official-ps1',
              kind: 'remote-script',
              requiresConfirmation: true,
              scriptUrl: 'https://www.codebuddy.cn/cli/install.ps1',
              shell: 'powershell',
              manualCommand: 'irm https://www.codebuddy.cn/cli/install.ps1 | iex',
            }
          : {
              label: 'official-sh',
              kind: 'remote-script',
              requiresConfirmation: true,
              scriptUrl: 'https://www.codebuddy.cn/cli/install.sh',
              shell: 'bash',
              manualCommand: 'curl -fsSL https://www.codebuddy.cn/cli/install.sh | bash',
            },
      )
      missing.push({
        app: 'workbuddy',
        displayName: 'CodeBuddy CLI (codebuddy)',
        reason: '检测到本机已有 WorkBuddy 应用/会话数据，但缺少 codebuddy 官方命令行工具',
        steps,
        verify: () => {
          ensureRichPath(true)
          return Boolean(findExecutable(cbNames, getCodebuddyCandidates(homeDir, platform, env)))
        },
      })
    }
  }

  return missing
}

/**
 * On-demand single-app official CLI installer (explicitly user-triggered from 1-click UI setup buttons).
 */
export async function installSingleAppCli(
  appName,
  { log = console, timeoutMs = INSTALL_TIMEOUT_MS, allowRemoteScripts = true } = {},
) {
  ensureRichPath(true)
  const item = detectHalfInstalledClis().find((m) => m.app === appName)
  if (!item) {
    return { ok: true, alreadyInstalled: true }
  }
  const env = sanitizeChildEnv(
    detectSystemProxyEnv({
      ...process.env,
      PATH: ensureRichPath(true),
      CI: '1',
      NONINTERACTIVE: '1',
    }),
  )
  let lastErr = ''
  for (const step of item.steps) {
    if (step.requiresConfirmation && !allowRemoteScripts) {
      lastErr = `需要用户确认后执行官方安装命令：${step.manualCommand || step.scriptUrl}`
      continue
    }
    log.info?.(`[autofix] 正在通过官方方式 (${step.label}) 安装 ${item.displayName}...`)
    const res = await runInstallStep(step, env, timeoutMs)
    if ((res.ok && item.verify()) || item.verify()) {
      ensureRichPath(true)
      return { ok: true, installed: true }
    }
    lastErr = res.error || res.output.split(/\r?\n/).pop() || 'unknown error'
  }
  return { ok: false, error: lastErr || `安装 ${item.displayName} 失败` }
}

function runSpawnStep(cmd, args, env, timeoutMs = INSTALL_TIMEOUT_MS) {
  return new Promise((resolveDone) => {
    let settled = false
    let proc = null
    let outputTail = ''
    const appendOut = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-4000)
    }
    const finish = (ok, code, error = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveDone({ ok, code, error, output: outputTail.trim() })
    }

    const timer = setTimeout(() => {
      if (proc) {
        killProcessTree(proc, { force: false, graceMs: 2_000 })
      }
      finish(false, -1, `安装超时 (${Math.round(timeoutMs / 1000)}s)`)
    }, timeoutMs)
    timer.unref?.()

    try {
      const execCmd =
        process.platform !== 'win32' && cmd === '/bin/bash' && !isExecutableFile('/bin/bash')
          ? 'bash'
          : cmd
      proc = spawnCrossPlatform(execCmd, args, {
        cwd: os.homedir(),
        env: sanitizeChildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', appendOut)
      proc.stderr?.on('data', appendOut)
      proc.on('error', (err) => finish(false, -1, String(err?.message || err)))
      proc.on('close', (code) => finish(code === 0, code ?? -1, code === 0 ? '' : `exit code ${code}`))
    } catch (err) {
      finish(false, -1, String(err?.message || err))
    }
  })
}

async function runRemoteInstallerScriptStep(step, env, timeoutMs = INSTALL_TIMEOUT_MS) {
  let urlObj
  try {
    urlObj = new URL(String(step.scriptUrl || ''))
  } catch {
    return { ok: false, code: -1, error: '无效的官方安装脚本 URL', output: '' }
  }
  if (urlObj.protocol !== 'https:' || !TRUSTED_INSTALLER_HOSTS.has(urlObj.hostname.toLowerCase())) {
    return { ok: false, code: -1, error: `拒绝下载未在白名单中的安装脚本来源 (${urlObj.hostname})`, output: '' }
  }

  // Download to a private local file first instead of piping `curl | bash` / `irm | iex`
  const ac = new AbortController()
  const fetchTimer = setTimeout(() => ac.abort(), Math.min(30_000, timeoutMs))
  fetchTimer.unref?.()
  let scriptBody = ''
  try {
    const res = await fetch(urlObj.toString(), { method: 'GET', signal: ac.signal })
    if (!res.ok) {
      return { ok: false, code: res.status, error: `下载官方安装脚本失败 (HTTP ${res.status})`, output: '' }
    }
    scriptBody = await res.text()
  } catch (err) {
    return { ok: false, code: -1, error: `下载官方安装脚本异常: ${String(err?.message || err)}`, output: '' }
  } finally {
    clearTimeout(fetchTimer)
  }

  const trimmed = scriptBody.trim()
  if (!trimmed || trimmed.length > 2 * 1024 * 1024 || /^<!doctype\s+html|^<html\b/i.test(trimmed)) {
    return { ok: false, code: -1, error: '官方安装脚本校验失败（内容为空、过大或返回了 HTML 页面）', output: '' }
  }

  const ext = step.shell === 'powershell' ? 'ps1' : 'sh'
  const scriptDir = join(os.tmpdir(), 'allinone-installer')
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 })
  try { chmodSync(scriptDir, 0o700) } catch {}
  const scriptPath = join(scriptDir, `install-${process.pid}-${randomBytes(6).toString('hex')}.${ext}`)
  try {
    writeFileSync(scriptPath, scriptBody, { encoding: 'utf8', mode: 0o700 })
    try { chmodSync(scriptPath, 0o700) } catch {}
    if (step.shell === 'powershell') {
      return await runSpawnStep(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        env,
        timeoutMs,
      )
    }
    return await runSpawnStep('/bin/bash', [scriptPath], env, timeoutMs)
  } finally {
    try { unlinkSync(scriptPath) } catch {}
  }
}

function runInstallStep(step, env, timeoutMs = INSTALL_TIMEOUT_MS) {
  if (step.kind === 'remote-script') {
    return runRemoteInstallerScriptStep(step, env, timeoutMs)
  }
  return runSpawnStep(step.cmd, step.args, env, timeoutMs)
}

/**
 * Automatically detect and silently complete all half-installed CLIs in the background.
 * Safe to call on every startup: zero-cost when everything is already installed.
 * By default only runs package-manager steps (`npm`/`brew`); remote installer scripts require
 * explicit opt-in (`allowRemoteScripts: true` or `ALLINONE_ALLOW_REMOTE_AUTOFIX=1`).
 */
export async function autoCompleteHalfInstalledClis({
  stateDir = join(os.homedir(), '.allinone-bridge'),
  log = console,
  onProgress = () => {},
  onInstalled = async () => {},
  force = false,
  allowRemoteScripts = String(process.env.ALLINONE_ALLOW_REMOTE_AUTOFIX || '').trim() === '1',
  cooldownMs = FAILURE_COOLDOWN_MS,
} = {}) {
  const noAutofix = String(process.env.ALLINONE_NO_AUTOFIX || '').trim()
  if (noAutofix === '1' || noAutofix.toLowerCase() === 'true') {
    return { skipped: true, reason: 'disabled', installed: [], failed: [] }
  }
  if (activeRunPromise) {
    return activeRunPromise
  }

  activeRunPromise = (async () => {
    ensureRichPath(true)
    const missing = detectHalfInstalledClis()
    if (missing.length === 0) {
      return { skipped: false, installed: [], failed: [] }
    }

    const stateFile = stateDir ? join(stateDir, 'autofix-state.json') : ''
    const state = readAutofixState(stateFile)
    const now = Date.now()
    const env = sanitizeChildEnv(
      detectSystemProxyEnv({
        ...process.env,
        PATH: ensureRichPath(true),
        CI: '1',
        NONINTERACTIVE: '1',
      }),
    )

    const installed = []
    const failed = []

    for (const item of missing) {
      const eligibleSteps = item.steps.filter((s) => !s.requiresConfirmation || allowRemoteScripts)
      if (eligibleSteps.length === 0) {
        const hint = item.steps.find((s) => s.manualCommand)?.manualCommand || ''
        log.info?.(
          `[autofix] ${item.reason}；出于安全策略，已跳过自动执行远程安装脚本${hint ? `，请手动确认安装：${hint}` : ''}`,
        )
        continue
      }

      const prev = state[item.app]
      if (!force && prev?.lastFailedAt && now - prev.lastFailedAt < cooldownMs) {
        log.info?.(
          `[autofix] 跳过 ${item.displayName}（上次自动补装失败于 ${Math.round((now - prev.lastFailedAt) / 60_000)} 分钟前，冷却中）`,
        )
        continue
      }

      log.info?.(`[autofix] ${item.reason}，正在后台自动补齐 ${item.displayName}...`)
      try {
        onProgress({ phase: 'installing', app: item.app, displayName: item.displayName })
      } catch {}

      let ok = false
      let lastErr = ''
      for (const step of eligibleSteps) {
        const res = await runInstallStep(step, env)
        if (res.ok && item.verify()) {
          ok = true
          break
        }
        // Even if installer returned non-zero (e.g., shell profile notice), verify binary directly
        if (item.verify()) {
          ok = true
          break
        }
        lastErr = res.error || res.output.split(/\r?\n/).pop() || 'unknown error'
      }

      if (ok) {
        installed.push(item.app)
        state[item.app] = { lastSuccessAt: Date.now(), lastFailedAt: 0, lastError: '' }
        writeAutofixState(stateFile, state)
        log.info?.(`[autofix] ✓ 已自动补齐 ${item.displayName}，正在热刷新本机桥接...`)
        try {
          onProgress({ phase: 'installed', app: item.app, displayName: item.displayName })
        } catch {}
        try {
          await onInstalled(item)
        } catch (err) {
          log.warn?.(`[autofix] 热刷新回调异常 (${item.app}): ${String(err?.message || err)}`)
        }
      } else {
        failed.push({ app: item.app, error: lastErr })
        state[item.app] = { lastFailedAt: Date.now(), lastError: String(lastErr).slice(0, 300) }
        writeAutofixState(stateFile, state)
        log.warn?.(`[autofix] ⚠ 自动补齐 ${item.displayName} 未完成: ${lastErr}`)
        try {
          onProgress({ phase: 'failed', app: item.app, displayName: item.displayName, error: lastErr })
        } catch {}
      }
    }

    try {
      onProgress({ phase: 'idle', installed, failed })
    } catch {}
    return { skipped: false, installed, failed }
  })()

  try {
    return await activeRunPromise
  } finally {
    activeRunPromise = null
  }
}
