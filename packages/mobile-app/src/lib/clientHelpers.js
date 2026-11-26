export const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'

const DEFAULT_RELEASES_URL = 'https://github.com/RainbowLion0320/AllinOne/releases/latest'
export const RELEASES_URL =
  String(import.meta.env?.VITE_RELEASES_URL || '').trim() || DEFAULT_RELEASES_URL

const CONFIGURED_APK_URL = String(import.meta.env?.VITE_APK_URL || '').trim()

export function resolveApkUrl(base) {
  if (!CONFIGURED_APK_URL) return ''
  if (/^https?:\/\//i.test(CONFIGURED_APK_URL)) return CONFIGURED_APK_URL
  const cleanBase = String(base || '').replace(/\/+$/, '')
  return `${cleanBase}/${CONFIGURED_APK_URL.replace(/^\/+/, '')}`
}

export async function copyTextToClipboard(text) {
  const str = String(text ?? '')
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str)
      return true
    }
  } catch {}
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = str
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '-9999px'
    ta.style.fontSize = '16px' // prevents iOS Safari auto-zoom
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
    if (isIOS) {
      const range = document.createRange()
      range.selectNodeContents(ta)
      const sel = window.getSelection?.()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      ta.setSelectionRange(0, str.length)
    } else {
      ta.focus({ preventScroll: true })
      ta.select()
      ta.setSelectionRange(0, str.length)
    }
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}

export function extractPathBasename(rawPath) {
  const clean = String(rawPath || '').trim().replace(/[\\/]+$/, '')
  if (!clean) return ''
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || clean
}

export function resolveSessionWorkspaceLabel(session, workspaces = []) {
  if (!session || typeof session !== 'object') return ''
  const cwd = String(session.cwd || '').trim()
  const rawWs = String(session.workspace || '').trim()
  if (rawWs && (!cwd || !/^(?:antigravity|claude)$/i.test(rawWs))) {
    return rawWs
  }
  if (cwd) {
    const lower = cwd.toLowerCase()
    const hit = Array.isArray(workspaces)
      ? workspaces.find((w) => w && typeof w.path === 'string' && w.path.trim().toLowerCase() === lower)
      : null
    const hitLabel = String(hit?.name || hit?.title || '').trim()
    if (hitLabel) return hitLabel
    const base = extractPathBasename(cwd)
    if (base) return base
  }
  return rawWs
}

export function enrichSessionMeta(nextSession, prevSession = null, workspaces = []) {
  if (!nextSession || typeof nextSession !== 'object') return nextSession
  const sameId = Boolean(prevSession && prevSession.id && prevSession.id === nextSession.id)
  const nextCwd = String(nextSession.cwd || '').trim()
  const prevCwd = sameId ? String(prevSession.cwd || '').trim() : ''
  const cwd = nextCwd || prevCwd
  const cwdChanged = Boolean(sameId && nextCwd && prevCwd && nextCwd.toLowerCase() !== prevCwd.toLowerCase())
  const explicitWs = String(nextSession.workspace || '').trim()
  const inheritedWs = sameId && !cwdChanged ? String(prevSession.workspace || '').trim() : ''
  const workspace = resolveSessionWorkspaceLabel(
    { ...nextSession, cwd, workspace: explicitWs || inheritedWs },
    workspaces,
  )
  const title =
    String(nextSession.title || '').trim() ||
    (sameId ? String(prevSession.title || '').trim() : '') ||
    nextSession.id ||
    ''
  return {
    ...nextSession,
    ...(cwd ? { cwd } : {}),
    ...(workspace ? { workspace } : {}),
    ...(title ? { title } : {}),
  }
}
