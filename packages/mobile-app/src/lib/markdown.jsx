import React, { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Image as ImageIcon,
  Info,
  Lightbulb,
  ShieldAlert,
  WrapText,
} from 'lucide-react'
import { useI18n } from './i18n.jsx'
import {
  getImageLabel,
  isImageTarget,
  isRelayUploadTarget,
  resolveImageSrc,
} from './imageUrls.js'
import { needsE2eeMediaLoad } from './e2eeMedia.js'
import { copyTextToClipboard } from './clientHelpers.js'

const HLJS_ALIASES = {
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  cpp: 'cpp',
  c: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  go: 'go',
  golang: 'go',
  ini: 'ini',
  toml: 'ini',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  python: 'python',
  py: 'python',
  rust: 'rust',
  rs: 'rust',
  sql: 'sql',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  html: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const HLJS_LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  css: () => import('highlight.js/lib/languages/css'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
}

const loadedHljsLangs = new Set()
const loadingHljsLangs = new Map()

function resolveCanonicalHljsLang(raw) {
  const clean = String(raw || '').trim().toLowerCase()
  return HLJS_ALIASES[clean] || ''
}

function ensureHljsLanguage(canonical) {
  if (!canonical) return Promise.resolve(false)
  if (loadedHljsLangs.has(canonical) || hljs.getLanguage(canonical)) {
    loadedHljsLangs.add(canonical)
    return Promise.resolve(true)
  }
  const existing = loadingHljsLangs.get(canonical)
  if (existing) return existing
  const loader = HLJS_LOADERS[canonical]
  if (!loader) return Promise.resolve(false)
  const job = loader()
    .then((mod) => {
      const def = mod?.default || mod
      if (typeof def === 'function') {
        hljs.registerLanguage(canonical, def)
        loadedHljsLangs.add(canonical)
        return true
      }
      return false
    })
    .catch(() => false)
    .finally(() => {
      loadingHljsLangs.delete(canonical)
    })
  loadingHljsLangs.set(canonical, job)
  return job
}

const REMARK_PLUGINS = [remarkGfm]

const ALERT_STYLES = {
  NOTE: {
    Icon: Info,
    labelZh: '说明',
    labelEn: 'Note',
    box: 'border-sky-200/90 bg-sky-50/80 text-sky-900 dark:border-sky-800/70 dark:bg-sky-950/35 dark:text-sky-100',
    title: 'text-sky-700 dark:text-sky-300',
  },
  TIP: {
    Icon: Lightbulb,
    labelZh: '提示',
    labelEn: 'Tip',
    box: 'border-emerald-200/90 bg-emerald-50/80 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/35 dark:text-emerald-100',
    title: 'text-emerald-700 dark:text-emerald-300',
  },
  IMPORTANT: {
    Icon: AlertCircle,
    labelZh: '重要',
    labelEn: 'Important',
    box: 'border-violet-200/90 bg-violet-50/80 text-violet-900 dark:border-violet-800/70 dark:bg-violet-950/35 dark:text-violet-100',
    title: 'text-violet-700 dark:text-violet-300',
  },
  WARNING: {
    Icon: AlertTriangle,
    labelZh: '注意',
    labelEn: 'Warning',
    box: 'border-amber-200/90 bg-amber-50/85 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100',
    title: 'text-amber-700 dark:text-amber-300',
  },
  CAUTION: {
    Icon: ShieldAlert,
    labelZh: '警告',
    labelEn: 'Caution',
    box: 'border-rose-200/90 bg-rose-50/85 text-rose-950 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-100',
    title: 'text-rose-700 dark:text-rose-300',
  },
}

function safeUrlTransform(url) {
  const trimmed = String(url || '').trim()
  if (!trimmed) return ''
  // Block dangerous script/HTML schemes while allowing http(s), mailto, tel, and file/local refs
  if (/^(?:javascript|vbscript|data:text\/html)/i.test(trimmed)) {
    return ''
  }
  return trimmed
}

/**
 * Normalize line endings and safely angle-bracket local `file:///` links containing spaces
 * so CommonMark parses them reliably without breaking code fences.
 */
function preprocessMarkdown(raw) {
  const normalized = String(raw || '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  let inFence = false
  const out = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    // Wrap `file:///...` links containing spaces in angle brackets so react-markdown parses them as links
    return line.replace(/(\[[^\]]+\])\((file:\/\/\/[^)\n]*\s[^)\n]*)\)/g, '$1(<$2>)')
  })
  return out.join('\n')
}

function extractPlainText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractPlainText).join('')
  if (React.isValidElement(node)) return extractPlainText(node.props?.children)
  return ''
}

function CodeBlock({ language, code }) {
  const { t, bi } = useI18n()
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const canonicalLang = resolveCanonicalHljsLang(language)
  const [langReady, setLangReady] = useState(() => Boolean(canonicalLang && hljs.getLanguage(canonicalLang)))

  useEffect(() => {
    if (!canonicalLang) {
      setLangReady(false)
      return
    }
    if (hljs.getLanguage(canonicalLang)) {
      setLangReady(true)
      return
    }
    let cancelled = false
    ensureHljsLanguage(canonicalLang).then((ok) => {
      if (!cancelled && ok) setLangReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [canonicalLang])

  const highlightedHtml = useMemo(() => {
    if (!code || !canonicalLang || !langReady) return ''
    try {
      if (hljs.getLanguage(canonicalLang)) {
        return hljs.highlight(code, { language: canonicalLang, ignoreIllegals: true }).value
      }
    } catch {}
    return ''
  }, [canonicalLang, code, langReady])

  const handleCopy = () => {
    void copyTextToClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-2xl border border-slate-200/85 bg-[#F7F9FC] dark:border-slate-700/80 dark:bg-[#191B23]">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/75 bg-slate-100/70 px-3.5 py-1.5 text-[11px] font-medium text-slate-500 dark:border-slate-700/70 dark:bg-[#20232E] dark:text-slate-400">
        <span className="truncate font-mono uppercase tracking-wide text-[10.5px]">
          {language || 'code'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setWrap((v) => !v)}
            title={wrap ? bi('取消自动换行', 'Disable wrap') : bi('自动换行', 'Wrap lines')}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition ${
              wrap
                ? 'bg-[#4D6BFE]/12 text-[#4D6BFE] dark:bg-[#4D6BFE]/20 dark:text-[#96AEFF]'
                : 'hover:bg-slate-200/70 dark:hover:bg-slate-700/60'
            }`}
          >
            <WrapText className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition hover:bg-slate-200/70 dark:hover:bg-slate-700/60"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
        </div>
      </div>
      <pre
        className={`max-w-full p-3.5 font-mono text-[12.5px] leading-relaxed text-slate-800 dark:text-slate-200 ${
          wrap ? 'overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'overflow-x-auto'
        }`}
      >
        {highlightedHtml ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  )
}

function ImageChip({ target, label, imageContext }) {
  const displayLabel = label || getImageLabel(target)
  const isUrlRef = /^(?:https?:\/\/|data:|blob:|\/api\/)/i.test(target) || isRelayUploadTarget(target)
  const item = {
    ...(isUrlRef ? { url: target } : { path: target }),
    raw: target,
    name: displayLabel,
  }
  const useE2ee = needsE2eeMediaLoad(item, imageContext || {})
  const src = useE2ee ? '' : resolveImageSrc(item, imageContext || {})
  return (
    <button
      type="button"
      onClick={() =>
        (src || useE2ee) &&
        imageContext?.onOpenImage?.({
          images: [{ item, src, label: displayLabel, rawPath: target }],
          index: 0,
        })
      }
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg bg-[#EEF2FF] px-2 py-0.5 align-baseline text-[13px] font-medium text-[#3552E8] transition hover:bg-[#E0E7FF] active:scale-95 dark:bg-[#273154] dark:text-[#96AEFF]"
    >
      <ImageIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{displayLabel}</span>
    </button>
  )
}

function RichBlockquote({ children }) {
  const { lang } = useI18n()
  const childArr = React.Children.toArray(children).filter(
    (child) => !(typeof child === 'string' && child.trim() === ''),
  )
  const firstText = extractPlainText(childArr[0]).trim()
  const alertMatch = firstText.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/s)

  if (alertMatch) {
    const kind = alertMatch[1]
    const spec = ALERT_STYLES[kind] || ALERT_STYLES.NOTE
    const Icon = spec.Icon
    const firstRest = alertMatch[2]
    const remainingChildren = childArr.slice(1)
    return (
      <div className={`my-2.5 rounded-2xl border px-3.5 py-2.5 text-[14px] leading-relaxed break-words [overflow-wrap:anywhere] ${spec.box}`}>
        <div className={`mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide ${spec.title}`}>
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span>{lang === 'en' ? spec.labelEn : spec.labelZh}</span>
        </div>
        {firstRest && <p className="my-0.5 whitespace-pre-wrap">{firstRest}</p>}
        {remainingChildren}
      </div>
    )
  }

  return (
    <blockquote className="my-2.5 rounded-r-xl border-l-3 border-[#4D6BFE]/60 bg-slate-50/75 py-1.5 pr-3 pl-3.5 text-[14px] leading-relaxed break-words [overflow-wrap:anywhere] text-slate-600 dark:bg-white/[0.025] dark:text-slate-300">
      {children}
    </blockquote>
  )
}

/**
 * Full GFM-compliant, XSS-safe Markdown renderer styled for both Mobile & Desktop:
 * - GFM tables (locally scrollable rounded cards with alignment & inline formatting)
 * - Syntax-highlighted code blocks (highlight.js) with copy & wrap toggle
 * - Nested lists, GFM task checklists, GitHub Alert callouts, strikethrough, italic, bold+code
 * - E2EE local image lightbox chips & safe local file path pills
 */
export function MarkdownView({ text, streaming = false, imageContext = null }) {
  const prepared = useMemo(() => preprocessMarkdown(text), [text])

  const components = useMemo(
    () => ({
      h1: ({ children }) => (
        <h1 className="mt-4 mb-2 border-b border-slate-200/80 pb-1.5 text-[18px] font-bold tracking-tight break-words [overflow-wrap:anywhere] text-slate-900 first:mt-0 dark:border-slate-700/70 dark:text-white">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="mt-3.5 mb-2 border-b border-slate-200/60 pb-1 text-[16.5px] font-bold tracking-tight break-words [overflow-wrap:anywhere] text-slate-900 first:mt-0 dark:border-slate-700/60 dark:text-white">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="mt-3 mb-1.5 text-[15.5px] font-semibold break-words [overflow-wrap:anywhere] text-slate-900 first:mt-0 dark:text-white">
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 className="mt-2.5 mb-1 text-[14.5px] font-semibold break-words [overflow-wrap:anywhere] text-slate-800 first:mt-0 dark:text-slate-100">
          {children}
        </h4>
      ),
      h5: ({ children }) => (
        <h5 className="mt-2 mb-1 text-sm font-semibold break-words [overflow-wrap:anywhere] text-slate-700 dark:text-slate-200">
          {children}
        </h5>
      ),
      h6: ({ children }) => (
        <h6 className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wide break-words [overflow-wrap:anywhere] text-slate-500 dark:text-slate-400">
          {children}
        </h6>
      ),
      p: ({ children }) => (
        <p className="my-2 text-[15px] leading-[1.72] break-words [overflow-wrap:anywhere] text-slate-800 first:mt-0 last:mb-0 dark:text-slate-100">
          {children}
        </p>
      ),
      strong: ({ children }) => (
        <strong className="font-semibold text-slate-950 dark:text-white">{children}</strong>
      ),
      em: ({ children }) => (
        <em className="italic text-slate-700 dark:text-slate-200">{children}</em>
      ),
      del: ({ children }) => (
        <del className="text-slate-400 line-through dark:text-slate-500">{children}</del>
      ),
      hr: () => <hr className="my-3.5 border-slate-200/90 dark:border-slate-700/80" />,
      ul: ({ className, children }) => (
        <ul
          className={`my-2 space-y-1.5 text-[15px] leading-[1.68] break-words [overflow-wrap:anywhere] text-slate-800 dark:text-slate-100 ${
            String(className || '').includes('contains-task-list')
              ? 'list-none pl-1'
              : 'list-disc pl-5 marker:text-slate-400 dark:marker:text-slate-500'
          }`}
        >
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-2 list-decimal space-y-1.5 pl-5 text-[15px] leading-[1.68] break-words [overflow-wrap:anywhere] text-slate-800 marker:font-medium marker:text-slate-400 dark:text-slate-100 dark:marker:text-slate-500">
          {children}
        </ol>
      ),
      li: ({ className, children }) => (
        <li
          className={
            String(className || '').includes('task-list-item')
              ? 'flex items-start gap-2'
              : 'pl-0.5 [&>ul]:my-1 [&>ol]:my-1 [&>p]:my-0.5'
          }
        >
          {children}
        </li>
      ),
      input: ({ type, checked }) => {
        if (type === 'checkbox') {
          return (
            <span
              aria-checked={Boolean(checked)}
              role="checkbox"
              className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                checked
                  ? 'border-[#4D6BFE] bg-[#4D6BFE] text-white'
                  : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-[#16171A]'
              }`}
            >
              {checked ? <Check className="h-3 w-3 stroke-[3]" /> : null}
            </span>
          )
        }
        return null
      },
      blockquote: ({ children }) => <RichBlockquote>{children}</RichBlockquote>,
      table: ({ children }) => (
        <div className="my-3 max-w-full overflow-x-auto rounded-2xl border border-slate-200/90 bg-white shadow-2xs dark:border-slate-700/80 dark:bg-[#1A1C24]">
          <table className="w-full min-w-full border-collapse text-[13px] leading-snug">
            {children}
          </table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="bg-slate-50/95 text-slate-600 dark:bg-[#232633] dark:text-slate-200">
          {children}
        </thead>
      ),
      tbody: ({ children }) => (
        <tbody className="divide-y divide-slate-200/70 text-slate-700 dark:divide-slate-700/60 dark:text-slate-200">
          {children}
        </tbody>
      ),
      tr: ({ children }) => (
        <tr className="even:bg-slate-50/45 hover:bg-[#4D6BFE]/[0.04] dark:even:bg-white/[0.015] dark:hover:bg-white/[0.03]">
          {children}
        </tr>
      ),
      th: ({ style, children }) => (
        <th
          style={style}
          className="border-b border-slate-200/90 px-3 py-2.5 text-left font-semibold whitespace-nowrap dark:border-slate-700/80"
        >
          {children}
        </th>
      ),
      td: ({ style, children }) => (
        <td
          style={style}
          className="max-w-[260px] px-3 py-2 align-top break-words [overflow-wrap:anywhere]"
        >
          {children}
        </td>
      ),
      pre: ({ children }) => {
        const codeEl = React.Children.toArray(children).find((c) => React.isValidElement(c))
        const className = String(codeEl?.props?.className || '')
        const langMatch = className.match(/language-([\w+-]+)/i)
        const rawCode = extractPlainText(codeEl?.props?.children ?? children).replace(/\n$/, '')
        return <CodeBlock language={langMatch ? langMatch[1] : ''} code={rawCode} />
      },
      code: ({ className, children }) => {
        const textVal = extractPlainText(children)
        if (className && /language-/i.test(className)) {
          return <code className={className}>{children}</code>
        }
        if (imageContext && isImageTarget(textVal)) {
          return <ImageChip target={textVal} label={getImageLabel(textVal)} imageContext={imageContext} />
        }
        return (
          <code className="rounded-md bg-slate-100/95 px-1.5 py-0.5 font-mono text-[0.86em] break-words [overflow-wrap:anywhere] text-[#3552E8] dark:bg-[#242836] dark:text-[#9AB0FF]">
            {children}
          </code>
        )
      },
      a: ({ href, children }) => {
        const dest = String(href || '').trim()
        const label = extractPlainText(children).trim()
        if (imageContext && isImageTarget(dest)) {
          return <ImageChip target={dest} label={label || getImageLabel(dest)} imageContext={imageContext} />
        }
        if (/^(?:https?:\/\/|mailto:|tel:)/i.test(dest)) {
          return (
            <a
              href={dest}
              target="_blank"
              rel="noreferrer"
              className="break-all font-medium text-[#4D6BFE] underline decoration-[#4D6BFE]/40 underline-offset-2 transition hover:decoration-[#4D6BFE] dark:text-[#7F98FF]"
            >
              {children}
            </a>
          )
        }
        // Local file links (e.g. [app.js](file:///...)) -> clean inline code badge
        return (
          <code className="rounded-md bg-[#EEF2FF] px-1.5 py-0.5 font-mono text-[0.86em] break-words [overflow-wrap:anywhere] text-[#3552E8] dark:bg-[#232B45] dark:text-[#9AB0FF]">
            {label || dest}
          </code>
        )
      },
      img: ({ src, alt }) => {
        const target = String(src || '').trim()
        if (!target) return null
        if (imageContext) {
          return <ImageChip target={target} label={alt || getImageLabel(target)} imageContext={imageContext} />
        }
        return (
          <img
            src={target}
            alt={alt || ''}
            loading="lazy"
            className="my-2 max-h-80 max-w-full rounded-xl border border-slate-200/80 object-contain dark:border-slate-700/80"
          />
        )
      },
    }),
    [imageContext],
  )

  if (!text) return null

  return (
    <div className={`min-w-0 max-w-full break-words [overflow-wrap:anywhere] ${streaming ? 'stream-caret' : ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  )
}
