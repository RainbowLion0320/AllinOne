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

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  sanitizeChildEnv,
  spawnCmdShim,
} from './bin-finder.js'

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
                  cmd: 'powershell',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'irm https://antigravity.google/cli/install.ps1 | iex',
                  ],
                },
              ]
            : [
                {
                  label: 'official-sh',
                  cmd: '/bin/bash',
                  args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
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
      const steps =
        platform === 'win32'
          ? [
              {
                label: 'official-ps1',
                cmd: 'powershell',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'irm https://claude.ai/install.ps1 | iex',
                ],
              },
            ]
          : [
              {
                label: 'official-sh',
                cmd: '/bin/bash',
                args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'],
              },
            ]
      const npmBin = checkBin(platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'], [])
      if (npmBin) {
        steps.push({
          label: 'npm-global',
          cmd: npmBin,
          args: ['install', '-g', '@anthropic-ai/claude-code'],
        })
      }
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

  // 3. Codex: ~/.codex sessions/auth/config or Codex.app exists, but `codex` binary is missing
  const codexEvidence = [
    join(homeDir, '.codex', 'sessions'),
    join(homeDir, '.codex', 'auth.json'),
    join(homeDir, '.codex', 'config.toml'),
    join(homeDir, 'Applications', 'Codex.app'),
  ]
  if (checkSystemApps) {
    if (platform === 'darwin') codexEvidence.push('/Applications/Codex.app')
    else if (platform === 'win32') codexEvidence.push(join(localApp, 'Programs', 'Codex'))
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
          displayName: 'Codex CLI (codex)',
          reason: '检测到本机已有 Codex 会话/配置，但缺少 codex 命令行工具',
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
      const steps =
        platform === 'win32'
          ? [
              {
                label: 'official-ps1',
                cmd: 'powershell',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'irm https://www.codebuddy.cn/cli/install.ps1 | iex',
                ],
              },
            ]
          : [
              {
                label: 'official-sh',
                cmd: '/bin/bash',
                args: ['-lc', 'curl -fsSL https://www.codebuddy.cn/cli/install.sh | bash'],
              },
            ]
      const npmBin = checkBin(platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'], [])
      if (npmBin) {
        steps.push({
          label: 'npm-global',
          cmd: npmBin,
          args: ['install', '-g', '@tencent-ai/codebuddy-code'],
        })
      }
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
 * On-demand single-app official CLI installer (used by 1-click UI setup buttons like WorkBuddy RW activation).
 */
export async function installSingleAppCli(appName, { log = console, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
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
    log.info?.(`[autofix] 正在通过官方脚本 (${step.label}) 安装 ${item.displayName}...`)
    const res = await runInstallStep(step, env, timeoutMs)
    if ((res.ok && item.verify()) || item.verify()) {
      ensureRichPath(true)
      return { ok: true, installed: true }
    }
    lastErr = res.error || res.output.split(/\r?\n/).pop() || 'unknown error'
  }
  return { ok: false, error: lastErr || `安装 ${item.displayName} 失败` }
}

function runInstallStep(step, env, timeoutMs = INSTALL_TIMEOUT_MS) {
  return new Promise((resolveDone) => {
    let settled = false
    let proc = null
    let outputTail = ''
    const appendOut = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-4000)
    }
    let forceKillTimer = null
    const finish = (ok, code, error = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      resolveDone({ ok, code, error, output: outputTail.trim() })
    }

    const timer = setTimeout(() => {
      if (process.platform === 'win32' && proc?.pid) {
        try {
          const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            env: sanitizeChildEnv(env),
          })
          tk.on('error', () => {})
        } catch {}
      }
      try { proc?.kill('SIGTERM') } catch {}
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null
        try { proc?.kill('SIGKILL') } catch {}
      }, 2000)
      forceKillTimer.unref?.()
      finish(false, -1, `安装超时 (${Math.round(timeoutMs / 1000)}s)`)
    }, timeoutMs)
    timer.unref?.()

    try {
      const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(step.cmd)
      const spawnOpts = {
        cwd: os.homedir(),
        env: sanitizeChildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
      if (isWinCmd) {
        proc = spawnCmdShim(step.cmd, step.args, spawnOpts)
      } else {
        const execCmd =
          process.platform !== 'win32' && step.cmd === '/bin/bash' && !isExecutableFile('/bin/bash')
            ? 'bash'
            : step.cmd
        proc = spawn(execCmd, step.args, spawnOpts)
      }
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

/**
 * Automatically detect and silently complete all half-installed CLIs in the background.
 * Safe to call on every startup: zero-cost when everything is already installed.
 */
export async function autoCompleteHalfInstalledClis({
  stateDir = join(os.homedir(), '.allinone-bridge'),
  log = console,
  onProgress = () => {},
  onInstalled = async () => {},
  force = false,
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
      for (const step of item.steps) {
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
