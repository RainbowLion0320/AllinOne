import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, parse, resolve, sep } from 'node:path'

export const SAFE_DELIVERABLE_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.ppt',
  '.pptx',
  '.md',
  '.markdown',
  '.txt',
  '.rtf',
  '.epub',
  '.zip',
])

export const SAFE_REVEAL_DELIVERABLE_EXTS = new Set([
  ...SAFE_DELIVERABLE_EXTS,
  '.html',
  '.htm',
])

export const SENSITIVE_HOME_SUBDIRS = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.allinone-bridge',
  '.dsh',
  '.codex',
  '.claude',
  '.workbuddy',
  '.codebuddy',
  '.gemini',
  '.zcode',
])

export function isSafeWindowsLocalPath(candidate) {
  return !/^\\\\/.test(candidate) && /^[A-Za-z]:\\[^:]+$/.test(candidate)
}

export function resolveSafeDeliverableCwd(
  rawCwd,
  homeDir = homedir(),
  tempDir = tmpdir(),
  blockedDotDirs = SENSITIVE_HOME_SUBDIRS,
  geminiBrainDir = join(homeDir, '.gemini', 'antigravity', 'brain'),
) {
  let candidate = String(rawCwd || '').trim()
  if (!candidate || candidate.includes('\0')) return ''
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = join(homeDir, candidate.slice(2))
  }
  if (process.platform === 'win32') {
    if (/^(?:\\\\|\/\/)/.test(candidate)) return ''
    candidate = candidate.replace(/\//g, '\\')
    if (!isSafeWindowsLocalPath(candidate)) return ''
  }
  if (!isAbsolute(candidate)) return ''
  let realCwd = ''
  try {
    realCwd = realpathSync(candidate)
    if (!statSync(realCwd).isDirectory()) return ''
  } catch {
    return ''
  }
  if (process.platform === 'win32' && !isSafeWindowsLocalPath(realCwd)) return ''

  const normPath = (v) => {
    const trimmed = String(v || '').replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const isUnderNormalized = (child, root) => {
    if (!root) return false
    const nc = normPath(child)
    const nr = normPath(root)
    return nc === nr || nc.startsWith(nr + sep)
  }

  // Reject filesystem/drive roots (e.g. '/', 'C:\\') and shallow top-level dirs (e.g. '/Users', 'C:\\Users', '/etc')
  const parsedRoot = parse(realCwd).root
  if (normPath(realCwd) === normPath(parsedRoot)) return ''
  const relFromRoot = realCwd.slice(parsedRoot.length).split(/[\\/]+/).filter(Boolean)
  if (relFromRoot.length < 2) return ''

  // Reject homeDir itself (must be a specific user subdirectory)
  let realHome = homeDir
  try { realHome = realpathSync(homeDir) } catch {}
  if (normPath(realCwd) === normPath(realHome)) return ''

  // Allow temp subdirectories explicitly before rejecting POSIX /var
  let realTemp = tempDir
  try { realTemp = realpathSync(tempDir) } catch {}
  const inTemp = isUnderNormalized(realCwd, realTemp) && normPath(realCwd) !== normPath(realTemp)

  if (!inTemp) {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows'
      const winBlocked = [
        sysRoot,
        process.env.WINDIR || 'C:\\Windows',
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        process.env.ProgramData || 'C:\\ProgramData',
      ]
      if (winBlocked.some((b) => b && isUnderNormalized(realCwd, b))) return ''
    } else {
      const posixBlocked = [
        '/etc',
        '/private/etc',
        '/System',
        '/Library',
        '/usr',
        '/bin',
        '/sbin',
        '/boot',
        '/dev',
        '/proc',
        '/sys',
        '/root',
        '/var',
        '/private/var',
      ]
      if (posixBlocked.some((b) => isUnderNormalized(realCwd, b))) return ''
    }
  }

  // Reject sensitive dot-directories (except Antigravity brain artifacts and ZCode workspace dirs)
  let realGeminiBrain = ''
  try { realGeminiBrain = realpathSync(geminiBrainDir) } catch {}
  const inGeminiBrain = Boolean(realGeminiBrain && isUnderNormalized(realCwd, realGeminiBrain))
  let realZcodeWorkspace = ''
  try { realZcodeWorkspace = realpathSync(join(homeDir, '.zcode', 'workspace')) } catch {}
  const inZcodeWorkspace = Boolean(realZcodeWorkspace && isUnderNormalized(realCwd, realZcodeWorkspace))
  for (const sub of blockedDotDirs) {
    let realSub = ''
    try { realSub = realpathSync(join(homeDir, sub)) } catch { continue }
    if (isUnderNormalized(realCwd, realSub)) {
      if (sub === '.gemini' && inGeminiBrain) continue
      if (sub === '.zcode' && inZcodeWorkspace) continue
      return ''
    }
  }
  return realCwd
}

export function resolveSafeDesktopDeliverable(
  rawPath,
  cwd = '',
  { allowHtml = false, homeDir = homedir(), tempDir = tmpdir() } = {},
) {
  const allowedExts = allowHtml ? SAFE_REVEAL_DELIVERABLE_EXTS : SAFE_DELIVERABLE_EXTS
  const geminiBrainDir = join(homeDir, '.gemini', 'antigravity', 'brain')

  let p = String(rawPath || '').trim()
  if (!p || p.includes('\0')) return { ok: false, error: '缺少文件路径' }
  if ((p.startsWith('<') && p.endsWith('>')) || (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
  }
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/[?#].*$/, '').replace(/^file:\/\/(?:localhost)?/i, '')
    try { p = decodeURIComponent(p) } catch {}
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homeDir, p.slice(2))
  }
  if (process.platform === 'win32') {
    if (/^(?:\\\\|\/\/)/.test(p)) {
      return { ok: false, error: '出于安全限制，禁止直接打开网络共享 (UNC) 或设备路径' }
    }
    p = p.replace(/\//g, '\\')
    if (/^\\\\/.test(p)) {
      return { ok: false, error: '出于安全限制，禁止直接打开网络共享 (UNC) 或设备路径' }
    }
  }
  const safeCwd = resolveSafeDeliverableCwd(cwd, homeDir, tempDir, SENSITIVE_HOME_SUBDIRS, geminiBrainDir)
  const baseDir = safeCwd || join(homeDir, 'AllinOne-Workspace')
  const resolved = isAbsolute(p) ? resolve(p) : resolve(baseDir, p)
  if (process.platform === 'win32' && !isSafeWindowsLocalPath(resolved)) {
    return { ok: false, error: '出于安全限制，仅允许打开本地磁盘上的交付文件' }
  }
  const ext = extname(resolved).toLowerCase()
  if (!allowedExts.has(ext)) {
    return { ok: false, error: `不支持直接打开该格式（${ext || '未知格式'}）` }
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `找不到本机文件：${resolved}` }
  }
  let realPath = ''
  try {
    realPath = realpathSync(resolved)
  } catch (err) {
    return { ok: false, error: `无法访问本机文件：${String(err?.message || err)}` }
  }
  if (process.platform === 'win32' && !isSafeWindowsLocalPath(realPath)) {
    return { ok: false, error: '出于安全限制，符号链接目标仅允许指向本地磁盘文件' }
  }
  const realExt = extname(realPath).toLowerCase()
  if (!allowedExts.has(realExt)) {
    return { ok: false, error: `符号链接目标格式不受支持（${realExt || '未知格式'}）` }
  }
  let isFile = false
  try {
    isFile = statSync(realPath).isFile()
  } catch (err) {
    return { ok: false, error: `无法读取文件信息：${String(err?.message || err)}` }
  }
  if (!isFile) {
    return { ok: false, error: '目标路径不是文件' }
  }
  const isUnderDir = (candidate, root) => {
    if (!root) return false
    try {
      const rr = realpathSync(root)
      const normC = process.platform === 'win32' ? candidate.toLowerCase() : candidate
      const normR = process.platform === 'win32' ? rr.toLowerCase() : rr
      return normC === normR || normC.startsWith(normR + sep)
    } catch {
      return false
    }
  }
  const inGeminiBrain = isUnderDir(realPath, geminiBrainDir)
  const inZcodeWorkspace = isUnderDir(realPath, join(homeDir, '.zcode', 'workspace'))
  for (const sub of SENSITIVE_HOME_SUBDIRS) {
    if (isUnderDir(realPath, join(homeDir, sub))) {
      if ((sub === '.gemini' && inGeminiBrain) || (sub === '.zcode' && inZcodeWorkspace)) {
        const baseLower = basename(realPath).toLowerCase()
        if (
          baseLower.startsWith('.') ||
          baseLower.includes('oauth_creds') ||
          baseLower.includes('credentials') ||
          baseLower === 'settings.json' ||
          /\.(?:key|pem|p12|jks|env)$/i.test(baseLower)
        ) {
          return { ok: false, error: '出于安全限制，禁止直接打开敏感凭证或配置文件' }
        }
        continue
      }
      return { ok: false, error: '出于安全限制，禁止直接打开敏感配置目录中的文件' }
    }
  }
  const allowedRoots = [safeCwd, homeDir, tempDir].filter(Boolean)
  if (!allowedRoots.some((r) => isUnderDir(realPath, r))) {
    return { ok: false, error: '出于安全限制，仅允许打开工作区或用户目录内的交付文件' }
  }
  return { ok: true, realPath, ext: realExt }
}
