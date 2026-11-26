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
let loginShellPathPromise = null

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
  if (!force && cachedLoginShellPath !== null) return cachedLoginShellPath
  for (const sh of getUnixCandidateShells()) {
    try {
      const out = execFileSync(sh, ['-lc', 'printf "%s" "$PATH"'], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out && out.includes('/')) {
        cachedLoginShellPath = out
        return out
      }
    } catch {}
  }
  cachedLoginShellPath = ''
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
        break
      }
    }
    if (cachedLoginShellPath === null) cachedLoginShellPath = ''
    return ensureRichPath(true)
  })().finally(() => {
    loginShellPathPromise = null
  })
  return loginShellPathPromise
}

/**
 * Enrich `process.env.PATH` with login-shell PATH + common macOS/Linux/Windows tool locations.
 * Pass `forceRefresh = true` after installing a new CLI so freshly created bin dirs are picked up immediately.
 */
export function ensureRichPath(forceRefresh = false) {
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
    const loginPath = readUnixLoginShellPath()
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
 *  - Windows: `taskkill /T /F` when forcing, plus `proc.kill`
 *  - POSIX: kills process group `-proc.pid` first (reaping spawned shells/subtools), falling back to `proc.kill`
 */
export function killProcessTree(proc, { force = false } = {}) {
  if (!proc) return
  const sig = force ? 'SIGKILL' : 'SIGTERM'
  if (process.platform === 'win32' && proc.pid) {
    if (force) {
      try {
        const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        tk.on('error', () => {})
      } catch {}
    }
    try { proc.kill(sig) } catch {}
    return
  }
  if (proc.pid && Number.isInteger(proc.pid) && proc.pid > 1) {
    try {
      process.kill(-proc.pid, sig)
      return
    } catch {}
  }
  try {
    proc.kill(sig)
  } catch {}
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
