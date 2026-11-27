import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export {
  APPS,
  APP_LIST,
  EVENTS,
  RPC,
  makeCompositeId,
  parseCompositeId,
  toEpochMs,
} from '@allinone/shared'

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9._:@-]{1,128}$/
const SAFE_CLI_TOKEN_RE = /^[a-zA-Z0-9._:@/+=-]{1,120}$/

const SENSITIVE_CWD_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.npm',
  '.allinone',
  '.allinone-bridge',
  '.dsh-mobile',
  '.dsh',
  '.codex',
  '.claude',
  '.workbuddy',
  '.codebuddy',
  '.gemini',
  '.kimi',
  '.kimi-webbridge',
  '.kimi-work',
  'codebuddyextension',
  'keychains',
])

const SENSITIVE_POSIX_SYSTEM_ROOTS = [
  '/etc',
  '/private/etc',
  '/proc',
  '/sys',
  '/dev',
  '/system',
  '/boot',
  '/private/var/db',
]

const SENSITIVE_SUBPATH_PREFIXES = [
  '/.gemini/config',
  '/.dsh/profiles',
  '/.dsh/storages',
  '/.dsh/config',
  '/.zcode/v2',
  '/.zcode/cli',
  '/.zcode/certs',
  '/appdata/roaming/kimi-desktop',
  '/appdata/local/kimi-desktop',
  '/library/application support/kimi-desktop',
  '/.config/kimi-desktop',
  '/library/application support/google/chrome',
  '/library/application support/microsoft edge',
  '/library/application support/firefox',
  '/library/application support/codebuddyextension',
  '/appdata/local/google/chrome',
  '/appdata/local/microsoft/edge',
  '/appdata/roaming/mozilla',
  '/appdata/roaming/codebuddyextension',
]

const DEFAULT_WORKSPACE_DIR_NAME = 'AllinOne-Workspace'

/**
 * Return the dedicated safe default workspace directory (`~/AllinOne-Workspace`).
 * Never returns `os.homedir()` itself so `assertSafeWorkspaceCwd` always accepts it.
 */
export function getDefaultWorkspaceCwd() {
  return join(homedir(), DEFAULT_WORKSPACE_DIR_NAME)
}

/**
 * Ensure the dedicated safe default workspace directory exists on disk and return its path.
 */
export function ensureDefaultWorkspaceCwd() {
  const dir = getDefaultWorkspaceCwd()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

function getNormalizedHomePath() {
  try {
    const h = existsSync(homedir()) ? realpathSync(homedir()) : homedir()
    return String(h || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  } catch {
    return String(homedir() || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * Return normalized lowercase forward-slash path of Windows SystemRoot (e.g. `c:/windows`).
 */
export function getWindowsSystemRootNorm() {
  const raw = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows').trim()
  const norm = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm || 'c:/windows'
}

function isSensitiveOrSystemCwdPath(absPath) {
  const rawNorm = String(absPath || '').replace(/\\/g, '/').toLowerCase()
  const norm = rawNorm.replace(/\/+$/, '')
  if (!norm || norm === '/' || /^[a-z]:$/.test(norm)) return true

  const homeNorm = getNormalizedHomePath()
  if (homeNorm && norm === homeNorm) return true

  const winSysRoot = getWindowsSystemRootNorm()
  if (
    norm === winSysRoot ||
    norm.startsWith(`${winSysRoot}/`) ||
    norm === 'c:/windows' ||
    norm.startsWith('c:/windows/')
  ) {
    return true
  }

  for (const sysRoot of SENSITIVE_POSIX_SYSTEM_ROOTS) {
    if (norm === sysRoot || norm.startsWith(`${sysRoot}/`)) return true
  }

  const segments = norm.split('/').filter(Boolean)
  if (segments.some((seg) => SENSITIVE_CWD_SEGMENTS.has(seg))) return true

  for (const sub of SENSITIVE_SUBPATH_PREFIXES) {
    if (norm.endsWith(sub) || norm.includes(`${sub}/`)) return true
  }
  return false
}

/**
 * Validate a remote-supplied working directory (`cwd`) against filesystem roots,
 * OS system directories (`SystemRoot`, `/etc`, `/proc`, `/sys`), and credential dirs.
 */
export function assertSafeWorkspaceCwd(rawCwd, { allowEmpty = true } = {}) {
  const raw = String(rawCwd ?? '').trim()
  if (!raw) {
    if (allowEmpty) return ''
    throw new Error('缺少工作目录 cwd')
  }
  if (/[\0\r\n]/.test(raw)) {
    throw new Error('出于安全限制，工作目录包含非法控制字符')
  }
  let expanded = raw
  if (expanded === '~') {
    expanded = homedir()
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = join(homedir(), expanded.slice(2))
  }
  const homeNorm = getNormalizedHomePath()
  const rejectSensitive = (candidatePath) => {
    const candNorm = String(candidatePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (homeNorm && candNorm === homeNorm) {
      throw new Error(
        `出于安全限制，不允许将用户主目录直接设为工作目录，请指定具体项目子目录（或使用默认目录 ${getDefaultWorkspaceCwd()}）`,
      )
    }
    throw new Error('出于安全限制，不允许将系统敏感目录或凭据目录设为工作目录')
  }
  if (isSensitiveOrSystemCwdPath(expanded)) {
    rejectSensitive(expanded)
  }
  const resolved = resolve(expanded)
  if (isSensitiveOrSystemCwdPath(resolved)) {
    rejectSensitive(resolved)
  }
  if (existsSync(resolved)) {
    try {
      const real = realpathSync(resolved)
      if (isSensitiveOrSystemCwdPath(real)) {
        rejectSensitive(real)
      }
    } catch (err) {
      if (String(err?.message || '').includes('出于安全限制')) throw err
    }
  }
  return resolved
}

/**
 * Validate session/thread/conversation IDs against path traversal (`../`, `/`, `\`)
 * and CLI option injection (leading `-`, shell metacharacters, null bytes).
 */
export function assertSafeSessionId(value, label = 'sessionId') {
  const s = String(value ?? '').trim()
  if (!s || s.startsWith('-') || s.includes('..') || !SAFE_SESSION_ID_RE.test(s)) {
    throw new Error(`非法的 ${label} 格式`)
  }
  return s
}

/**
 * Validate remote-supplied CLI option values (e.g. model ID, effort, permission mode)
 * against Windows cmd.exe / POSIX shell metacharacters and leading-dash option injection.
 */
export function assertSafeCliToken(value, label = '参数', { allowEmpty = true } = {}) {
  const s = String(value ?? '').trim()
  if (!s) {
    if (allowEmpty) return ''
    throw new Error(`缺少 ${label}`)
  }
  if (s.startsWith('-') || s.includes('..') || !SAFE_CLI_TOKEN_RE.test(s)) {
    throw new Error(`非法的 ${label} 参数值`)
  }
  return s
}

/** Ensure `targetPath` resolves strictly inside `baseDir`. */
export function assertPathWithinDir(targetPath, baseDir, label = '路径') {
  const base = resolve(baseDir)
  const target = resolve(targetPath)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`非法的 ${label}：超出允许目录范围`)
  }
  return target
}
