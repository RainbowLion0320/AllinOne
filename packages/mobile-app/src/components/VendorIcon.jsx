import React from 'react'
import { APP_META } from '@allinone/shared'
import { bi, getCurrentLang, translate } from '../lib/i18n.js'
import deepseekSvg from '../assets/vendors/deepseek.svg'
import codexSvg from '../assets/vendors/codex.svg'
import claudeSvg from '../assets/vendors/claude.svg'
import antigravitySvg from '../assets/vendors/antigravity.svg'
import workbuddySvg from '../assets/vendors/workbuddy.svg'
import zcodeSvg from '../assets/vendors/zcode.svg'

const OFFICIAL_VENDOR_SVG = {
  dsh: deepseekSvg,
  codex: codexSvg,
  claude: claudeSvg,
  antigravity: antigravitySvg,
  workbuddy: workbuddySvg,
  zcode: zcodeSvg,
}

export function formatEffortLabel(effort, lang = getCurrentLang()) {
  if (!effort) return ''
  const key = String(effort).toLowerCase()
  const dictKey = `effort.${key}`
  const val = translate(lang, dictKey)
  return val === dictKey ? effort : val
}

export function getEffortMeta(effort) {
  const key = String(effort || '').trim().toLowerCase()
  if (key === 'off' || key === 'none' || key === 'disabled') {
    return {
      level: 0,
      color: '#64748B',
      pillClass: 'bg-slate-200/75 text-slate-600 dark:bg-slate-700/70 dark:text-slate-300',
    }
  }
  if (key === 'minimal' || key === 'low') {
    return {
      level: 1,
      color: '#0EA5E9',
      pillClass: 'bg-sky-500/12 text-sky-700 dark:bg-sky-400/20 dark:text-sky-300',
    }
  }
  if (key === 'medium' || key === 'enabled') {
    return {
      level: 2,
      color: '#4D6BFE',
      pillClass: 'bg-[#4D6BFE]/12 text-[#3552E8] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]',
    }
  }
  if (key === 'high') {
    return {
      level: 3,
      color: '#4F46E5',
      pillClass: 'bg-indigo-500/14 text-indigo-700 dark:bg-indigo-400/22 dark:text-indigo-300',
    }
  }
  if (key === 'xhigh') {
    return {
      level: 4,
      color: '#7C3AED',
      pillClass: 'bg-violet-500/14 text-violet-700 dark:bg-violet-400/22 dark:text-violet-300',
    }
  }
  return {
    level: 4,
    color: '#9333EA',
    pillClass: 'bg-purple-500/15 text-purple-700 dark:bg-purple-400/25 dark:text-purple-300',
  }
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
 * Official brand vector icons for DeepSeek (DSH), OpenAI ChatGPT, Anthropic Claude,
 * Google Antigravity, Tencent WorkBuddy, and Zhipu ZCode.
 */
export function VendorIcon({ app, size = 18, className = '', mono = false, active = false }) {
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

  const src = OFFICIAL_VENDOR_SVG[app]
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        decoding="async"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          ...(active ? { '--vendor-glow': APP_META[app]?.color || '#4D6BFE' } : {}),
        }}
        className={`inline-block shrink-0 select-none object-contain ${
          app === 'codex' || app === 'workbuddy' || app === 'zcode' ? 'rounded-[22%]' : ''
        } ${active ? 'vendor-icon-live' : ''} ${className}`}
      />
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
  xs: { box: 'h-5.5 w-5.5 rounded-lg', icon: 14 },
  sm: { box: 'h-6 w-6 rounded-lg', icon: 15 },
  md: { box: 'h-7 w-7 rounded-xl', icon: 17 },
  lg: { box: 'h-8.5 w-8.5 rounded-xl', icon: 20 },
}

const VENDOR_TINTS = {
  dsh: 'bg-[#4D6BFE]/12 ring-[#4D6BFE]/25 dark:bg-[#4D6BFE]/20 dark:ring-[#4D6BFE]/35',
  codex: 'bg-[#10A37F]/12 ring-[#10A37F]/25 dark:bg-[#10A37F]/18 dark:ring-[#10A37F]/32',
  claude: 'bg-[#D97757]/12 ring-[#D97757]/25 dark:bg-[#D97757]/20 dark:ring-[#D97757]/35',
  antigravity: 'bg-[#3186FF]/12 ring-[#3186FF]/25 dark:bg-[#3186FF]/18 dark:ring-[#3186FF]/35',
  workbuddy: 'bg-[#06C798]/12 ring-[#06C798]/25 dark:bg-[#06C798]/20 dark:ring-[#06C798]/35',
  zcode: 'bg-slate-900/10 ring-slate-900/20 dark:bg-white/10 dark:ring-white/20',
}

/**
 * Sleek tinted icon tile replacing old text badges ("DSH", "GPT", "CLD", "AGY", "WKB", "ZCD").
 * Pass `active={true}` for in-progress conversations to render a soft brand-colored breathing aura.
 */
export function VendorBadge({ app, size = 'sm', active = false, className = '' }) {
  const cfg = BADGE_SIZES[size] || BADGE_SIZES.sm
  const tint = VENDOR_TINTS[app] || VENDOR_TINTS.dsh
  const glowColor = APP_META[app]?.color || '#4D6BFE'
  return (
    <span
      style={active ? { '--vendor-glow': glowColor } : undefined}
      className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${cfg.box} ${tint} ${
        active ? 'vendor-badge-live' : ''
      } ${className}`}
      title={APP_META[app]?.name || app}
    >
      <VendorIcon app={app} size={cfg.icon} />
    </span>
  )
}
