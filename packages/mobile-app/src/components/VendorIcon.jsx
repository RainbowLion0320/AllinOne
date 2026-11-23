import React from 'react'
import { APP_META } from '@allinone/shared'
import { bi, getCurrentLang, translate } from '../lib/i18n.js'

export const EFFORT_LABELS = {
  off: '关闭',
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: 'Ultra',
}

export function formatEffortLabel(effort, lang = getCurrentLang()) {
  if (!effort) return ''
  const key = String(effort).toLowerCase()
  const dictKey = `effort.${key}`
  const val = translate(lang, dictKey)
  return val === dictKey ? (EFFORT_LABELS[key] || effort) : val
}

export function formatModelShort(modelId, modelName, lang = getCurrentLang()) {
  const raw = String(modelName || modelId || '').trim()
  if (!raw) return bi(lang, '默认模型', 'Default')
  if (raw === 'default' || raw.startsWith('默认模型')) return bi(lang, '默认', 'Default')
  return raw
    .replace(/\s*\(Alias\)\s*/gi, '')
    .replace(/^Claude\s+/i, '')
    .replace(/^DeepSeek\s+/i, 'DS ')
    .replace(/^deepseek-/i, 'DS-')
    .slice(0, 22)
}

/**
 * Crisp vendor brand icons for DeepSeek (DSH), OpenAI (Codex), Anthropic (Claude), and Google Antigravity.
 */
export function VendorIcon({ app, size = 18, className = '', mono = false }) {
  const color = mono ? 'currentColor' : APP_META[app]?.color || '#4D6BFE'

  if (app === 'all') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" fill="currentColor" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" fill="currentColor" opacity="0.72" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" fill="currentColor" opacity="0.72" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" fill="currentColor" opacity="0.45" />
      </svg>
    )
  }

  // DeepSeek minimalist whale emblem
  if (app === 'dsh') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M21.3 8.1c-.4-.3-.9-.2-1.3.1-.7.6-1.4 1.2-2.2 1.2-.2-2.2-1.7-4.5-4.3-5.2-2.1-.6-4.7-.1-6.5 1.4-.5.4-.9.9-1.3 1.4-.7-.3-1.6-.4-2.4-.1-.4.1-.6.6-.4 1 .4.9 1.2 1.5 2 1.9-.6 1.5-.6 3.3.1 4.9 1.1 2.7 3.9 4.5 7.2 4.5 3.6 0 6.5-2.1 7.6-5.2.9-1.2 1.6-2.8 1.9-4.7.1-.5-.1-.9-.4-1.2Zm-8.5 7.7c-2.2 0-4.1-1.3-4.8-3.2-.2-.5.2-1 .7-.9 1.2.3 2.5.4 3.8.2 1.6-.2 3-.9 4.1-1.9.4-.4 1.1-.1 1 .5-.5 3-2.5 5.3-4.8 5.3Z"
          fill={color}
        />
        <circle cx="9.8" cy="9.6" r="1.15" fill={mono ? 'white' : '#FFFFFF'} fillOpacity="0.95" />
      </svg>
    )
  }

  // OpenAI / Codex iconic 6-lobe geometric blossom knot
  if (app === 'codex') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          fill={color}
          d="M21.52 9.86a5.5 5.5 0 0 0-.47-4.52 5.57 5.57 0 0 0-6-2.66 5.5 5.5 0 0 0-4.15-1.85 5.57 5.57 0 0 0-5.32 3.87 5.5 5.5 0 0 0-3.68 2.66 5.57 5.57 0 0 0 .69 6.53 5.5 5.5 0 0 0 .47 4.52 5.57 5.57 0 0 0 6 2.66 5.5 5.5 0 0 0 4.15 1.85 5.57 5.57 0 0 0 5.32-3.87 5.5 5.5 0 0 0 3.68-2.66 5.57 5.57 0 0 0-.69-6.53Zm-8.31 11.49a4.13 4.13 0 0 1-2.65-.96l.13-.08 4.4-2.54a.72.72 0 0 0 .36-.62v-6.2l1.86 1.07a.07.07 0 0 1 .04.05v5.14a4.15 4.15 0 0 1-4.14 4.14ZM4.3 17.55a4.13 4.13 0 0 1-.5-2.78l.13.08 4.4 2.54a.72.72 0 0 0 .72 0l5.37-3.1v2.15a.07.07 0 0 1-.03.06l-4.45 2.57a4.15 4.15 0 0 1-5.64-1.52ZM3.14 7.93a4.13 4.13 0 0 1 2.16-1.82v5.23a.72.72 0 0 0 .36.62l5.37 3.1-1.86 1.07a.07.07 0 0 1-.07 0L4.65 13.56a4.15 4.15 0 0 1-1.51-5.63Zm15.27 3.55-5.37-3.1 1.86-1.07a.07.07 0 0 1 .07 0l4.45 2.57a4.14 4.14 0 0 1-.64 7.47v-5.25a.72.72 0 0 0-.37-.62Zm1.85-2.79-.13-.08-4.4-2.54a.72.72 0 0 0-.72 0l-5.37 3.1V7.02a.07.07 0 0 1 .03-.06l4.45-2.57a4.15 4.15 0 0 1 6.14 4.3ZM8.62 12.5l-1.86-1.07a.07.07 0 0 1-.04-.05V6.24a4.15 4.15 0 0 1 6.8-3.18l-.13.08-4.4 2.54a.72.72 0 0 0-.37.62v6.2Zm1.01-2.18 2.39-1.38 2.39 1.38v2.76l-2.39 1.38-2.39-1.38v-2.76Z"
        />
      </svg>
    )
  }

  // Anthropic / Claude iconic organic radial starburst spark
  if (app === 'claude') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M12 2.4v6.2M12 15.4v6.2M2.4 12h6.2M15.4 12h6.2M5.2 5.2l4.4 4.4M14.4 14.4l4.4 4.4M18.8 5.2l-4.4 4.4M9.6 14.4l-4.4 4.4M8.3 3.1l2.3 5.6M13.4 15.3l2.3 5.6M20.9 8.3l-5.6 2.3M8.7 13.4l-5.6 2.3"
          stroke={color}
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="2.1" fill={color} />
      </svg>
    )
  }

  // Google Antigravity floating prism / delta-A emblem
  if (app === 'antigravity') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M12 3.2c.65 0 1.24.38 1.52.97l6.45 13.78c.46.98-.46 2.02-1.48 1.66-2.1-.74-4.27-2.66-6.49-2.66s-4.39 1.92-6.49 2.66c-1.02.36-1.94-.68-1.48-1.66L10.48 4.17c.28-.59.87-.97 1.52-.97Z"
          stroke={color}
          strokeWidth="2.2"
          strokeLinejoin="round"
          fill={color}
          fillOpacity="0.16"
        />
        <circle cx="12" cy="11.6" r="2" fill={color} />
      </svg>
    )
  }

  return (
    <span
      className="inline-block rounded-full"
      style={{ width: size * 0.6, height: size * 0.6, backgroundColor: color }}
    />
  )
}

const BADGE_SIZES = {
  xs: { box: 'h-5.5 w-5.5 rounded-lg', icon: 13 },
  sm: { box: 'h-6 w-6 rounded-lg', icon: 14 },
  md: { box: 'h-7 w-7 rounded-xl', icon: 16 },
  lg: { box: 'h-8.5 w-8.5 rounded-xl', icon: 19 },
}

const VENDOR_TINTS = {
  dsh: 'bg-[#4D6BFE]/12 ring-[#4D6BFE]/25 dark:bg-[#4D6BFE]/20 dark:ring-[#4D6BFE]/35',
  codex: 'bg-[#10A37F]/12 ring-[#10A37F]/25 dark:bg-[#10A37F]/20 dark:ring-[#10A37F]/35',
  claude: 'bg-[#D97757]/12 ring-[#D97757]/25 dark:bg-[#D97757]/20 dark:ring-[#D97757]/35',
  antigravity: 'bg-[#7C5CFF]/12 ring-[#7C5CFF]/25 dark:bg-[#7C5CFF]/20 dark:ring-[#7C5CFF]/35',
}

/**
 * Sleek tinted icon tile replacing old text badges ("DSH", "CDX", "CLD", "AGY").
 */
export function VendorBadge({ app, size = 'sm', className = '' }) {
  const cfg = BADGE_SIZES[size] || BADGE_SIZES.sm
  const tint = VENDOR_TINTS[app] || VENDOR_TINTS.dsh
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${cfg.box} ${tint} ${className}`}
      title={APP_META[app]?.name || app}
    >
      <VendorIcon app={app} size={cfg.icon} />
    </span>
  )
}
