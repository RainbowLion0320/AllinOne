import React from 'react'
import { HelpCircle } from 'lucide-react'
import { translate } from '../../lib/i18n.js'

export function formatRelativeSeen(ts, lang) {
  if (!ts) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return translate(lang, 'time.justNow')
  if (diffSec < 3600) return translate(lang, 'time.minsAgo', { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return translate(lang, 'time.hoursAgo', { n: Math.floor(diffSec / 3600) })
  return translate(lang, 'time.daysAgo', { n: Math.floor(diffSec / 86400) })
}

export function formatClientDeviceLabel(name, kind, lang) {
  const raw = String(name || '').trim()
  if (lang === 'en') {
    if (raw) return raw
    if (kind === 'desktop') return 'Desktop App'
    if (kind === 'mobile') return 'Mobile App'
    return 'Web Client'
  }
  if (/^Windows Desktop(?:\s*·\s*(.+))?$/i.test(raw)) {
    const host = raw.replace(/^Windows Desktop(?:\s*·\s*)?/i, '').trim()
    return host ? `Windows 桌面端 · ${host}` : 'Windows 桌面端'
  }
  if (/^macOS Desktop(?:\s*·\s*(.+))?$/i.test(raw)) {
    const host = raw.replace(/^macOS Desktop(?:\s*·\s*)?/i, '').trim()
    return host ? `macOS 桌面端 · ${host}` : 'macOS 桌面端'
  }
  if (/^Linux Desktop(?:\s*·\s*(.+))?$/i.test(raw)) {
    const host = raw.replace(/^Linux Desktop(?:\s*·\s*)?/i, '').trim()
    return host ? `Linux 桌面端 · ${host}` : 'Linux 桌面端'
  }
  if (/^Desktop App$/i.test(raw)) return '桌面端'
  if (/^Android App$/i.test(raw)) return 'Android 客户端'
  if (/^iOS App$/i.test(raw)) return 'iOS 客户端'
  if (/^Web Client$/i.test(raw)) return '网页浏览器'
  if (raw) return raw
  if (kind === 'desktop') return '桌面端'
  if (kind === 'mobile') return '手机端'
  return '网页浏览器'
}

export function ToggleSwitch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-[#4D6BFE]' : 'bg-slate-300 dark:bg-slate-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-xs transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

export function HelpButton({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-expanded={active}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition ${
        active
          ? 'text-[#4D6BFE] bg-[#4D6BFE]/12'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200'
      }`}
    >
      <HelpCircle className="h-3.5 w-3.5" />
    </button>
  )
}

export function HelpCallout({ show, children }) {
  if (!show) return null
  return (
    <div className="mt-2 rounded-xl border border-slate-200/70 bg-slate-50/90 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700/70 dark:bg-[#171921] dark:text-slate-400">
      {children}
    </div>
  )
}
