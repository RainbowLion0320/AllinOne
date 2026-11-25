import { resolve, sep } from 'node:path'

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
