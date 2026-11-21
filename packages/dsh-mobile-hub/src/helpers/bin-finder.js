/**
 * Cross-platform executable discovery & login-shell PATH enrichment.
 * Ensures macOS / Linux users launching via `curl | bash` or Finder `.command`
 * automatically find Homebrew, NVM, fnm, Volta, bun, Codex.app, Antigravity.app, Claude CLI, etc.
 */

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

let pathEnriched = false

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

function readUnixLoginShellPath() {
  if (process.platform === 'win32') return ''
  const shells = [
    process.env.SHELL,
    process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/zsh',
    '/bin/bash',
  ].filter(Boolean)

  const seen = new Set()
  for (const sh of shells) {
    if (seen.has(sh) || !existsSync(sh)) continue
    seen.add(sh)
    try {
      const out = execFileSync(sh, ['-lc', 'printf "%s" "$PATH"'], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (out && out.includes('/')) return out
    } catch {}
  }
  return ''
}

/**
 * Enrich `process.env.PATH` once with login-shell PATH + common macOS/Linux/Windows tool locations.
 */
export function ensureRichPath() {
  if (pathEnriched) return process.env.PATH || ''
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

export function isExecutableFile(filePath) {
  if (!filePath || !existsSync(filePath)) return false
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    if (process.platform !== 'win32') {
      accessSync(filePath, constants.X_OK)
    }
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
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']

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

/**
 * Spawn an executable safely across platforms (wrapping `.cmd`/`.bat` on Windows via `cmd.exe`).
 */
export function spawnCrossPlatform(bin, args = [], options = {}) {
  ensureRichPath()
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], options)
  }
  return spawn(bin, args, options)
}
