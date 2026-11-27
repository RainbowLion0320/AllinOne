/**
 * Cross-platform executable discovery & login-shell PATH enrichment.
 * Ensures macOS / Linux users launching via `curl | bash` or Finder `.command`
 * automatically find Homebrew, NVM, fnm, Volta, bun, Codex.app, Antigravity.app, Claude CLI, etc.
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

let pathEnriched = false
let cachedLoginShellPath = null
let cachedLoginShellPathAt = 0
let loginShellPathPromise = null
const LOGIN_SHELL_REFRESH_DEDUPE_MS = 5_000

function listNewestVersionBins(baseDir, subPath = 'bin') {
  if (!existsSync(baseDir)) return []
  try {
    const entries = readdirSync(baseDir)
      .filter((name) => !name.startsWith('.'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    const bins = []
    for (const name of entries.slice(0, 6)) {
      const candidate = join(baseDir, name, subPath)
      if (existsSync(candidate)) bins.push(candidate)
    }
    return bins
  } catch {
    return []
  }
}

function getUnixCandidateShells() {
  const shells = [
    process.env.SHELL,
    process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/zsh',
    '/bin/bash',
  ].filter(Boolean)
  const seen = new Set()
  const out = []
  for (const sh of shells) {
    if (seen.has(sh) || !existsSync(sh)) continue
    seen.add(sh)
    out.push(sh)
  }
  return out
}

function readUnixLoginShellPath(force = false) {
  if (process.platform === 'win32') return ''
  const now = Date.now()
  if (cachedLoginShellPath !== null) {
    if (!force || now - cachedLoginShellPathAt < LOGIN_SHELL_REFRESH_DEDUPE_MS) {
      return cachedLoginShellPath
    }
  }
  for (const sh of getUnixCandidateShells()) {
    try {
      const out = execFileSync(sh, ['-lc', 'printf "%s" "$PATH"'], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out && out.includes('/')) {
        cachedLoginShellPath = out
        cachedLoginShellPathAt = Date.now()
        return out
      }
    } catch {}
  }
  cachedLoginShellPath = ''
  cachedLoginShellPathAt = Date.now()
  return ''
}

/**
 * Non-blocking login-shell PATH warmer for startup / background refreshes.
 */
export function warmLoginShellPathAsync({ force = false } = {}) {
  if (process.platform === 'win32') return Promise.resolve(ensureRichPath(force))
  if (!force && loginShellPathPromise) return loginShellPathPromise
  const shells = getUnixCandidateShells()
  loginShellPathPromise = (async () => {
    for (const sh of shells) {
      const out = await new Promise((resolveOut) => {
        execFile(
          sh,
          ['-lc', 'printf "%s" "$PATH"'],
          { timeout: 1500, encoding: 'utf8', maxBuffer: 256 * 1024 },
          (err, stdout) => {
            if (err) return resolveOut('')
            const s = String(stdout || '').trim()
            resolveOut(s && s.includes('/') ? s : '')
          },
        )
      })
      if (out) {
        cachedLoginShellPath = out
        cachedLoginShellPathAt = Date.now()
        break
      }
    }
    if (cachedLoginShellPath === null) {
      cachedLoginShellPath = ''
      cachedLoginShellPathAt = Date.now()
    }
    // Login-shell PATH was just refreshed asynchronously above; skip redundant sync execFileSync
    return ensureRichPath(true, { refreshLoginShell: false })
  })().finally(() => {
    loginShellPathPromise = null
  })
  return loginShellPathPromise
}

/**
 * Enrich `process.env.PATH` with login-shell PATH + common macOS/Linux/Windows tool locations.
 * Pass `forceRefresh = true` after installing a new CLI so freshly created bin dirs are picked up immediately.
 */
export function ensureRichPath(forceRefresh = false, { refreshLoginShell = forceRefresh } = {}) {
  if (pathEnriched && !forceRefresh) return process.env.PATH || ''
  pathEnriched = true

  const home = homedir()
  const existing = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  const extras = []

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    extras.push(
      join(appData, 'npm'),
      join(localApp, 'agy', 'bin'),
      join(home, '.codex', '.sandbox-bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.cargo', 'bin'),
    )
  } else {
    const loginPath = readUnixLoginShellPath(Boolean(refreshLoginShell))
    if (loginPath) {
      extras.push(...loginPath.split(delimiter).filter(Boolean))
    }
    extras.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      join(home, '.local', 'bin'),
      join(home, '.npm-global', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, 'Library', 'pnpm'),
      join(home, '.local', 'share', 'pnpm'),
      join(home, '.antigravity', 'antigravity', 'bin'),
      join(home, '.antigravity', 'bin'),
      join(home, '.agy', 'bin'),
      join(home, '.claude', 'local'),
      join(home, '.codebuddy', 'bin'),
      ...listNewestVersionBins(join(home, '.nvm', 'versions', 'node'), 'bin'),
      ...listNewestVersionBins(join(home, '.fnm', 'node-versions'), join('installation', 'bin')),
      ...listNewestVersionBins(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), join('installation', 'bin')),
    )
    if (process.platform === 'darwin') {
      extras.push(
        '/Applications/Antigravity.app/Contents/Resources/app/bin',
        join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin'),
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin',
        join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
        '/Applications/Codex.app/Contents/Resources/codex-cli/bin',
        join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
        '/Applications/Codex.app/Contents/Resources',
        join(home, 'Applications', 'Codex.app', 'Contents', 'Resources'),
      )
    }
  }

  const merged = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir) return
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return
    seen.add(key)
    merged.push(dir)
  }

  for (const d of existing) add(d)
  for (const d of extras) {
    if (existsSync(d)) add(d)
  }

  process.env.PATH = merged.join(delimiter)
  return process.env.PATH
}

const SENSITIVE_CHILD_ENV_KEYS = [
  'ALLINONE_E2EE_KEY',
  'ALLINONE_BRIDGE_SECRET',
  'ALLINONE_WEBRTC_PROXY_PORT',
  'ALLINONE_WEBRTC_PROXY_TOKEN',
  'ALLINONE_PASSWORD',
  'ELECTRON_RUN_AS_NODE',
]

export function sanitizeChildEnv(baseEnv = process.env) {
  const out = { ...(baseEnv || process.env) }
  for (const k of SENSITIVE_CHILD_ENV_KEYS) {
    delete out[k]
  }
  return out
}

export function isExecutableFile(filePath) {
  if (!filePath || !existsSync(filePath)) return false
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    if (process.platform === 'win32') {
      return /\.(exe|cmd|bat|com)$/i.test(filePath)
    }
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find the first existing executable matching either explicit absolute candidates
 * or any of `names` across the enriched `process.env.PATH`.
 */
export function findExecutable(names = [], extraCandidates = []) {
  ensureRichPath()

  for (const candidate of extraCandidates) {
    if (candidate && isExecutableFile(candidate)) return candidate
  }

  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  const nameList = Array.isArray(names) ? names : [names]
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : ['']

  for (const dir of dirs) {
    for (const rawName of nameList) {
      if (!rawName) continue
      const hasExt = process.platform === 'win32' && /\.(exe|cmd|bat|com)$/i.test(rawName)
      const tryExts = hasExt ? [''] : exts
      for (const ext of tryExts) {
        const full = join(dir, `${rawName}${ext}`)
        if (isExecutableFile(full)) return full
      }
    }
  }
  return null
}

function escapeCmdMeta(str) {
  return str.replace(/([()%!^"<>&|])/g, '^$1')
}

function escapeWinCmdArg(arg) {
  let s = String(arg ?? '')
  s = s.replace(/(\\*)"/g, '$1$1\\"')
  s = s.replace(/(\\*)$/, '$1$1')
  s = `"${s}"`
  // Double-escape cmd.exe metacharacters: cmd.exe parses once for /c and again when expanding %* inside .cmd/.bat
  return escapeCmdMeta(escapeCmdMeta(s))
}

function resolveNpmCmdShim(cmdPath) {
  try {
    if (!cmdPath || !existsSync(cmdPath)) return null
    const st = statSync(cmdPath)
    if (!st.isFile() || st.size > 16_384) return null
    const content = readFileSync(cmdPath, 'utf8')
    const m = content.match(/"%(?:~)?dp0%\\([^"\r\n]+\.(?:js|cjs|mjs))"\s+%\*/i)
    if (!m) return null
    const dir = dirname(cmdPath)
    const entryScript = join(dir, m[1])
    if (!existsSync(entryScript)) return null
    const localNode = join(dir, 'node.exe')
    let nodeBin = existsSync(localNode) ? localNode : ''
    if (!nodeBin && !process.versions.electron && process.execPath && /node(?:\.exe)?$/i.test(process.execPath)) {
      nodeBin = process.execPath
    }
    if (!nodeBin) {
      nodeBin = findExecutable(['node.exe', 'node']) || ''
    }
    if (!nodeBin) return null
    return { nodeBin, entryScript }
  } catch {
    return null
  }
}

const UNSAFE_CMD_SHIM_CHAR_RE = /[\r\n\0]/

/**
 * Safely spawn a Windows `.cmd`/`.bat` shim with spaces in paths and arbitrary JSON/metacharacter args.
 * Resolves standard npm JS shims directly to `node.exe` when possible, and otherwise invokes
 * `cmd.exe /d /s /c` with `windowsVerbatimArguments: true` and properly quoted/escaped arguments.
 */
export function spawnCmdShim(bin, args = [], options = {}) {
  const binStr = String(bin ?? '')
  if (!binStr || UNSAFE_CMD_SHIM_CHAR_RE.test(binStr)) {
    throw new Error('Rejected unsafe control character in executable path')
  }
  const argList = Array.isArray(args) ? args : []
  for (const arg of argList) {
    if (UNSAFE_CMD_SHIM_CHAR_RE.test(String(arg ?? ''))) {
      throw new Error('Rejected unsafe control character in command argument')
    }
  }
  const safeOpts = { ...options, env: sanitizeChildEnv(options.env || process.env) }
  const shim = resolveNpmCmdShim(binStr)
  if (shim) {
    return spawn(shim.nodeBin, [shim.entryScript, ...argList], safeOpts)
  }
  const cleanBin = `"${binStr.replace(/"/g, '')}"`
  const escapedArgs = argList.map(escapeWinCmdArg)
  const commandLine = `"${[cleanBin, ...escapedArgs].join(' ')}"`
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    ...safeOpts,
    windowsVerbatimArguments: true,
  })
}

/**
 * Spawn an executable safely across platforms (wrapping `.cmd`/`.bat` on Windows via `spawnCmdShim`,
 * and starting a dedicated POSIX process group on macOS/Linux so `killProcessTree` cleanly reaps grandchildren).
 */
export function spawnCrossPlatform(bin, args = [], options = {}) {
  ensureRichPath()
  const safeOpts = {
    ...options,
    env: sanitizeChildEnv(options.env || process.env),
    ...(process.platform !== 'win32' && options.detached === undefined ? { detached: true } : {}),
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return spawnCmdShim(bin, args, safeOpts)
  }
  return spawn(bin, args, safeOpts)
}

/**
 * Terminate a child process and its full process tree across platforms:
 *  - Windows (`win32`): NEVER call `proc.kill('SIGTERM')` before `taskkill /T` (Node's `SIGTERM`
 *    on Windows calls `TerminateProcess` on the parent alone, severing the tree and orphaning children).
 *    Instead, run `taskkill /PID <pid> /T /F` when `force: true` (falling back to `proc.kill('SIGKILL')`
 *    only if `taskkill` errors/exits non-zero), or graceful `taskkill /PID <pid> /T` first when
 *    `force: false`, escalating to `taskkill /PID <pid> /T /F` after `graceMs` if still alive.
 *  - POSIX: sends `SIGTERM` to process group `-proc.pid` (falling back to `proc.pid`) and escalates
 *    to `SIGKILL` after `graceMs` when `force: false`, or immediately sends `SIGKILL` when `force: true`.
 */
export function killProcessTree(proc, { force = false, graceMs = 2_000 } = {}) {
  if (!proc) return
  const isExited = () =>
    (proc.exitCode !== null && proc.exitCode !== undefined) ||
    (proc.signalCode !== null && proc.signalCode !== undefined)
  const cleanGraceMs = Number.isFinite(Number(graceMs)) && Number(graceMs) > 0 ? Math.floor(Number(graceMs)) : 0

  if (process.platform === 'win32') {
    const pid = Number(proc.pid)
    if (Number.isInteger(pid) && pid > 0) {
      const runTaskkill = (withForce, onFail = null) => {
        const args = withForce ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']
        try {
          const tk = spawn('taskkill', args, {
            stdio: 'ignore',
            windowsHide: true,
          })
          let failed = false
          const handleFail = () => {
            if (failed) return
            failed = true
            onFail?.()
          }
          tk.on('error', handleFail)
          tk.on('close', (code) => {
            if (code !== 0) handleFail()
          })
          return tk
        } catch {
          onFail?.()
          return null
        }
      }

      const forceFallback = () => {
        if (!isExited()) {
          try { proc.kill('SIGKILL') } catch {}
        }
      }

      if (force) {
        runTaskkill(true, forceFallback)
        return
      }

      runTaskkill(false)
      if (cleanGraceMs > 0 && !isExited()) {
        const timer = setTimeout(() => {
          if (isExited()) return
          runTaskkill(true, forceFallback)
        }, cleanGraceMs)
        timer.unref?.()
        const cancelTimer = () => clearTimeout(timer)
        proc.once?.('close', cancelTimer)
        proc.once?.('exit', cancelTimer)
      }
      return
    }
    try { proc.kill(force ? 'SIGKILL' : 'SIGTERM') } catch {}
    return
  }

  const sendPosixSignal = (sig) => {
    const pid = Number(proc.pid)
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(-pid, sig)
        return
      } catch {}
      try {
        process.kill(pid, sig)
        return
      } catch {}
    }
    try {
      proc.kill(sig)
    } catch {}
  }

  if (force) {
    sendPosixSignal('SIGKILL')
    return
  }

  sendPosixSignal('SIGTERM')
  if (cleanGraceMs > 0 && !isExited()) {
    const timer = setTimeout(() => {
      if (isExited()) return
      sendPosixSignal('SIGKILL')
    }, cleanGraceMs)
    timer.unref?.()
    const cancelTimer = () => clearTimeout(timer)
    proc.once?.('close', cancelTimer)
    proc.once?.('exit', cancelTimer)
  }
}

/**
 * Unified candidate executable paths for Antigravity CLI (`agy`).
 */
export function getAgyCandidates(home = homedir(), platform = process.platform, env = process.env, configuredBin = '') {
  const list = [configuredBin, env?.AGY_BIN]
  if (platform === 'win32') {
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(
      join(localApp, 'agy', 'bin', 'agy.exe'),
      join(home, '.local', 'bin', 'agy.exe'),
      join(home, '.agy', 'bin', 'agy.exe'),
      join(localApp, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      join(localApp, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'agy.cmd'),
    )
  } else {
    list.push(
      join(home, '.local', 'bin', 'agy'),
      join(home, '.agy', 'bin', 'agy'),
      join(home, '.antigravity', 'antigravity', 'bin', 'agy'),
      join(home, '.antigravity', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    )
    if (platform === 'darwin') {
      list.push(
        '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
        join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'agy'),
      )
    }
  }
  return list.filter(Boolean)
}

/**
 * Unified candidate executable paths for Claude Code CLI (`claude`).
 */
export function getClaudeCandidates(home = homedir(), platform = process.platform, env = process.env, configuredBin = '') {
  const list = [configuredBin, env?.CLAUDE_BIN]
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
    list.push(
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe'),
      join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd'),
    )
  } else {
    list.push(
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    )
  }
  return list.filter(Boolean)
}

function listNewestCodexDesktopBins(localApp) {
  const baseDir = join(localApp, 'OpenAI', 'Codex', 'bin')
  if (!existsSync(baseDir)) return []
  try {
    const found = []
    for (const name of readdirSync(baseDir)) {
      if (!name || name.startsWith('.')) continue
      const candidate = join(baseDir, name, 'codex.exe')
      if (!existsSync(candidate)) continue
      try {
        const st = statSync(candidate)
        if (st.isFile()) found.push({ path: candidate, mtimeMs: st.mtimeMs || 0 })
      } catch {}
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return found.map((x) => x.path)
  } catch {
    return []
  }
}

/**
 * Unified candidate executable paths for OpenAI Codex CLI (`codex`).
 */
export function getCodexCandidates(home = homedir(), platform = process.platform, env = process.env, configuredBin = '') {
  const list = [
    configuredBin,
    env?.CODEX_BIN,
  ]
  if (platform === 'win32') {
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(...listNewestCodexDesktopBins(localApp))
  }
  if (platform === 'win32') {
    list.push(join(home, '.codex', '.sandbox-bin', 'codex.exe'))
  } else {
    list.push(join(home, '.codex', '.sandbox-bin', 'codex'))
  }
  if (platform === 'darwin') {
    list.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
      join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
      '/Applications/Codex.app/Contents/Resources/bin/codex',
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'bin', 'codex'),
    )
  } else if (platform === 'win32') {
    const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(
      join(appData, 'npm', 'codex.cmd'),
      join(appData, 'npm', 'codex.exe'),
      join(localApp, 'Programs', 'ChatGPT', 'resources', 'codex-cli', 'codex.exe'),
      join(localApp, 'Programs', 'Codex', 'resources', 'codex.exe'),
    )
  }
  return list.filter(Boolean)
}

/**
 * Unified candidate executable paths for Tencent CodeBuddy Code CLI (`codebuddy` / `cbc`),
 * the official standalone CLI sharing account & Credits quota with WorkBuddy Desktop.
 */
export function getCodebuddyCandidates(home = homedir(), platform = process.platform, env = process.env, configuredBin = '') {
  const list = [
    configuredBin,
    env?.WORKBUDDY_CLI_BIN,
    env?.CODEBUDDY_BIN,
  ]
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(
      join(appData, 'npm', 'codebuddy.cmd'),
      join(appData, 'npm', 'codebuddy.exe'),
      join(appData, 'npm', 'cbc.cmd'),
      join(appData, 'npm', 'cbc.exe'),
      join(home, '.local', 'bin', 'codebuddy.exe'),
      join(home, '.codebuddy', 'bin', 'codebuddy.exe'),
      join(localApp, 'Programs', 'CodeBuddy', 'bin', 'codebuddy.cmd'),
    )
  } else {
    list.push(
      join(home, '.local', 'bin', 'codebuddy'),
      join(home, '.codebuddy', 'bin', 'codebuddy'),
      join(home, '.npm-global', 'bin', 'codebuddy'),
      '/opt/homebrew/bin/codebuddy',
      '/usr/local/bin/codebuddy',
      join(home, '.local', 'bin', 'cbc'),
      '/opt/homebrew/bin/cbc',
      '/usr/local/bin/cbc',
    )
  }
  return list.filter(Boolean)
}

/**
 * Candidate resource roots / entry scripts for Zhipu ZCode (Desktop bundled `zcode.cjs` + standalone `zcode` CLI).
 */
export function getZCodeResourceRoots(home = homedir(), platform = process.platform, env = process.env) {
  const roots = []
  if (platform === 'win32') {
    const programFiles = env?.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = env?.['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    roots.push(
      join(programFiles, 'ZCode', 'resources'),
      join(localApp, 'Programs', 'ZCode', 'resources'),
      join(localApp, 'ZCode', 'resources'),
      join(programFilesX86, 'ZCode', 'resources'),
    )
  } else if (platform === 'darwin') {
    roots.push(
      '/Applications/ZCode.app/Contents/Resources',
      join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources'),
    )
  } else {
    roots.push(
      '/opt/ZCode/resources',
      '/usr/lib/zcode/resources',
      '/usr/share/zcode/resources',
      join(home, '.local', 'share', 'zcode', 'resources'),
    )
  }
  return roots.filter(Boolean)
}

export function getZCodeCandidates(home = homedir(), platform = process.platform, env = process.env, configuredBin = '') {
  const list = [
    configuredBin,
    env?.ZCODE_BIN,
    env?.ZCODE_CLI_BIN,
  ]
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(
      join(appData, 'npm', 'zcode.cmd'),
      join(appData, 'npm', 'zcode.exe'),
      join(home, '.local', 'bin', 'zcode.exe'),
      join(localApp, 'zcode', 'bin', 'zcode.exe'),
    )
  } else {
    list.push(
      join(home, '.local', 'bin', 'zcode'),
      join(home, '.zcode', 'bin', 'zcode'),
      join(home, '.npm-global', 'bin', 'zcode'),
      '/opt/homebrew/bin/zcode',
      '/usr/local/bin/zcode',
    )
  }
  return list.filter(Boolean)
}

/**
 * Find the newest cached `zcode-builtin.json` under `~/.zcode/v2/runtime/provider`,
 * falling back to the desktop app's bundled `resources/config/provider/zcode-builtin.json`.
 */
export function findZCodeBuiltinConfig(zcodeHome, resourceRoot = '') {
  const runtimeProviderDir = join(zcodeHome, 'v2', 'runtime', 'provider')
  const cached = []
  const scanDir = (dir, depth = 0) => {
    if (depth > 4 || !existsSync(dir)) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        scanDir(full, depth + 1)
      } else if (st.isFile() && name === 'zcode-builtin.json' && st.size > 100) {
        cached.push({ path: full, mtimeMs: st.mtimeMs || 0 })
      }
    }
  }
  scanDir(runtimeProviderDir, 0)
  if (cached.length > 0) {
    cached.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return cached[0].path
  }
  if (resourceRoot) {
    const bundled = join(resourceRoot, 'config', 'provider', 'zcode-builtin.json')
    if (existsSync(bundled)) return bundled
  }
  return ''
}

/**
 * Locate Zhipu ZCode's executable launcher (standalone `zcode` CLI or desktop-bundled `resources/glm/zcode.cjs` + Node runtime).
 */
export function findZCodeLauncher({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  configuredBin = '',
  zcodeHome = '',
} = {}) {
  const effectiveHome = String(zcodeHome || env?.ZCODE_HOME || '').trim() || join(home, '.zcode')
  const explicit = String(configuredBin || env?.ZCODE_BIN || env?.ZCODE_CLI_BIN || '').trim()

  const resolveNodeBin = (glmDir = '') => {
    const candidates = []
    if (glmDir) {
      if (platform === 'win32') {
        candidates.push(join(glmDir, 'node-runtime', 'node.exe'))
      } else {
        candidates.push(
          join(glmDir, 'node-runtime', 'bin', 'node'),
          join(glmDir, 'node-runtime', 'node'),
        )
      }
    }
    if (!process.versions.electron && process.execPath && /node(?:\.exe)?$/i.test(process.execPath)) {
      candidates.push(process.execPath)
    }
    return findExecutable(platform === 'win32' ? ['node.exe', 'node'] : ['node'], candidates) || ''
  }

  // 1. Explicit `.cjs`/`.js` script path
  if (explicit && /\.(?:cjs|mjs|js)$/i.test(explicit) && existsSync(explicit)) {
    const glmDir = dirname(explicit)
    const nodeBin = resolveNodeBin(glmDir)
    if (nodeBin) {
      const resRoot = dirname(glmDir)
      return {
        bin: nodeBin,
        baseArgs: [explicit],
        entryScript: explicit,
        resourceRoot: resRoot,
        builtinConfigPath: findZCodeBuiltinConfig(effectiveHome, resRoot),
        kind: 'bundled-script',
      }
    }
  }

  // 2. Standalone CLI binary (`zcode` / `zcode.exe` / `zcode.cmd`)
  const cliNames = platform === 'win32' ? ['zcode.exe', 'zcode.cmd', 'zcode'] : ['zcode']
  const standaloneBin = findExecutable(cliNames, getZCodeCandidates(home, platform, env, explicit))
  if (standaloneBin) {
    let builtinConfigPath = findZCodeBuiltinConfig(effectiveHome, '')
    if (!builtinConfigPath) {
      for (const r of getZCodeResourceRoots(home, platform, env)) {
        const candidate = join(r, 'config', 'provider', 'zcode-builtin.json')
        if (existsSync(candidate)) {
          builtinConfigPath = candidate
          break
        }
      }
    }
    return {
      bin: standaloneBin,
      baseArgs: [],
      entryScript: '',
      resourceRoot: '',
      builtinConfigPath,
      kind: 'standalone-cli',
    }
  }

  // 3. ZCode Desktop bundled `resources/glm/zcode.cjs` + Node runtime
  for (const resRoot of getZCodeResourceRoots(home, platform, env)) {
    const glmDir = join(resRoot, 'glm')
    const scriptPath = join(glmDir, 'zcode.cjs')
    if (!existsSync(scriptPath)) continue
    const nodeBin = resolveNodeBin(glmDir)
    if (!nodeBin) continue
    return {
      bin: nodeBin,
      baseArgs: [scriptPath],
      entryScript: scriptPath,
      resourceRoot: resRoot,
      builtinConfigPath: findZCodeBuiltinConfig(effectiveHome, resRoot),
      kind: 'desktop-bundled',
    }
  }

  return null
}

/**
 * Candidate data roots for Moonshot Kimi Desktop (`daimon-share/daimon`) and standalone Daimon (`~/.kimi/daimon`).
 */
export function getKimiDataDirCandidates(
  home = homedir(),
  platform = process.platform,
  env = process.env,
  configuredDir = '',
) {
  const list = [
    configuredDir,
    env?.KIMI_DAIMON_DIR,
    env?.KIMI_DATA_DIR,
  ]
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    list.push(
      join(appData, 'kimi-desktop', 'daimon-share', 'daimon'),
      join(localApp, 'kimi-desktop', 'daimon-share', 'daimon'),
    )
  } else if (platform === 'darwin') {
    list.push(
      join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon'),
      join(home, 'Library', 'Application Support', 'Kimi', 'daimon-share', 'daimon'),
    )
  } else {
    const xdgConfig = env?.XDG_CONFIG_HOME || join(home, '.config')
    const xdgData = env?.XDG_DATA_HOME || join(home, '.local', 'share')
    list.push(
      join(xdgConfig, 'kimi-desktop', 'daimon-share', 'daimon'),
      join(xdgData, 'kimi-desktop', 'daimon-share', 'daimon'),
    )
  }
  list.push(join(home, '.kimi', 'daimon'))
  return list.filter(Boolean)
}

/**
 * Locate the active Moonshot Kimi Desktop data directory (`daimon-share/daimon`).
 * Prefers a candidate containing a live `agents/main/runner.state.json`, then `config.json` or SQLite history.
 */
export function findKimiDataDir({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  configuredDir = '',
} = {}) {
  const explicit = String(configuredDir || '').trim()
  if (explicit) {
    return existsSync(explicit) ? explicit : ''
  }
  const candidates = getKimiDataDirCandidates(home, platform, env, '')
  for (const dir of candidates) {
    if (existsSync(join(dir, 'agents', 'main', 'runner.state.json'))) return dir
  }
  for (const dir of candidates) {
    if (
      existsSync(join(dir, 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite')) ||
      existsSync(join(dir, 'config.json'))
    ) {
      return dir
    }
  }
  return ''
}

/**
 * Locate Kimi Desktop's log directory (`logs/main.log`) used for passive subscription quota parsing.
 */
export function findKimiDesktopLogDir({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  kimiDataDir = '',
  strict = false,
} = {}) {
  const candidates = []
  if (kimiDataDir) {
    // `<kimi-desktop>/daimon-share/daimon` -> `<kimi-desktop>/logs`
    candidates.push(join(dirname(dirname(kimiDataDir)), 'logs'))
  }
  if (!strict) {
    if (platform === 'win32') {
      const appData = env?.APPDATA || join(home, 'AppData', 'Roaming')
      candidates.push(join(appData, 'kimi-desktop', 'logs'))
    } else if (platform === 'darwin') {
      candidates.push(
        join(home, 'Library', 'Logs', 'kimi-desktop'),
        join(home, 'Library', 'Application Support', 'kimi-desktop', 'logs'),
      )
    } else {
      const xdgConfig = env?.XDG_CONFIG_HOME || join(home, '.config')
      candidates.push(join(xdgConfig, 'kimi-desktop', 'logs'))
    }
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'main.log'))) return dir
  }
  return ''
}
