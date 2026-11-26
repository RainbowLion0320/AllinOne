/**
 * Lightweight zero-dependency bilingual i18n (Simplified Chinese `zh` & English `en`)
 * Works cleanly in both browser/Electron renderer and Node.js unit tests.
 */

export const LANG_STORAGE_KEY = 'allinone_lang_v1'

let activeLangCache = null

export function normalizeLang(input) {
  const raw = String(input || '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'zh' || raw.startsWith('zh-') || raw.startsWith('zh_')) return 'zh'
  if (raw === 'en' || raw.startsWith('en-') || raw.startsWith('en_')) return 'en'
  return null
}

function getDefaultStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {}
  return null
}

export function loadSavedLang(storage = getDefaultStorage()) {
  try {
    if (!storage) return null
    return normalizeLang(storage.getItem(LANG_STORAGE_KEY))
  } catch {
    return null
  }
}

export function saveLang(lang, storage = getDefaultStorage()) {
  const normalized = normalizeLang(lang) || 'en'
  activeLangCache = normalized
  try {
    if (storage) storage.setItem(LANG_STORAGE_KEY, normalized)
  } catch {}
  return normalized
}

export function detectInitialLang(
  storage = getDefaultStorage(),
  nav = typeof navigator !== 'undefined' ? navigator : null,
) {
  const saved = loadSavedLang(storage)
  if (saved) {
    activeLangCache = saved
    return saved
  }
  try {
    const desktopLang = normalizeLang(globalThis.window?.allinoneDesktop?.initialLang)
    if (desktopLang) {
      activeLangCache = desktopLang
      return desktopLang
    }
  } catch {}

  const candidates = []
  if (Array.isArray(nav?.languages)) candidates.push(...nav.languages)
  if (nav?.language) candidates.push(nav.language)
  for (const c of candidates) {
    const norm = normalizeLang(c)
    if (norm) {
      activeLangCache = norm
      return norm
    }
  }
  activeLangCache = 'en'
  return 'en'
}

export function getCurrentLang(storage = getDefaultStorage()) {
  if (activeLangCache) return activeLangCache
  return detectInitialLang(storage)
}

export function setCurrentLangCache(lang) {
  activeLangCache = normalizeLang(lang) || 'en'
  return activeLangCache
}

export function bi(lang, zh, en) {
  return normalizeLang(lang) === 'zh' ? zh : en
}

export const MESSAGES = {
  zh: {
    'common.cancel': '取消',
    'common.confirm': '确认',
    'common.save': '保存',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.retry': '重试',
    'common.loading': '加载中...',
    'common.all': '全部',
    'common.default': '默认',
    'common.admin': '管理员',
    'common.online': '在线',
    'common.offline': '离线',
    'common.connecting': '连接中',
    'common.expired': '已过期',
    'common.error': '异常',
    'common.settings': '设置',
    'common.newChat': '新对话',
    'common.switch': '切换',
    'common.back': '返回',
    'common.remove': '移除',
    'effort.off': '关闭',
    'effort.none': '关闭',
    'effort.minimal': '极低',
    'effort.low': '低',
    'effort.medium': '中',
    'effort.high': '高',
    'effort.xhigh': '极高',
    'effort.max': '最大',
    'effort.ultra': 'Ultra',
    'time.today': '今天',
    'time.yesterday': '昨天',
    'time.week': '近 7 天',
    'time.older': '更早',
    'time.justNow': '刚刚在线',
    'time.minsAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.daysAgo': '{n} 天前',
  },
  en: {
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.save': 'Save',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.retry': 'Retry',
    'common.loading': 'Loading...',
    'common.all': 'All',
    'common.default': 'Default',
    'common.admin': 'Admin',
    'common.online': 'Online',
    'common.offline': 'Offline',
    'common.connecting': 'Connecting',
    'common.expired': 'Expired',
    'common.error': 'Error',
    'common.settings': 'Settings',
    'common.newChat': 'New Chat',
    'common.switch': 'Switch',
    'common.back': 'Back',
    'common.remove': 'Remove',
    'effort.off': 'Off',
    'effort.none': 'Off',
    'effort.minimal': 'Min',
    'effort.low': 'Low',
    'effort.medium': 'Med',
    'effort.high': 'High',
    'effort.xhigh': 'XHigh',
    'effort.max': 'Max',
    'effort.ultra': 'Ultra',
    'time.today': 'Today',
    'time.yesterday': 'Yesterday',
    'time.week': 'Last 7 Days',
    'time.older': 'Earlier',
    'time.justNow': 'Just now',
    'time.minsAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.daysAgo': '{n}d ago',
  },
}

export function translate(lang, key, params = null) {
  const code = normalizeLang(lang) || 'en'
  const dict = MESSAGES[code] || MESSAGES.en
  let text = dict[key] ?? MESSAGES.en[key] ?? key
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v ?? ''))
    }
  }
  return text
}
