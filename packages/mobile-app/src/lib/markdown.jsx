import React, { useState } from 'react'
import { Check, Copy, Image as ImageIcon } from 'lucide-react'
import { useI18n } from './i18n.jsx'
import {
  getImageLabel,
  isImageTarget,
  resolveImageSrc,
  scanMarkdownLinks,
} from './imageUrls.js'

function CodeBlock({ language, code }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }

  return (
    <div className="my-2.5 overflow-hidden rounded-2xl border border-slate-200/80 bg-[#F7F9FC] dark:border-slate-700/80 dark:bg-[#1E2028]">
      <div className="flex items-center justify-between border-b border-slate-200/70 px-3.5 py-1.5 text-[11px] font-medium text-slate-500 dark:border-slate-700/70 dark:text-slate-400">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? t('common.copied') : t('common.copy')}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-[13px] leading-relaxed text-slate-800 dark:text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderPlainTokens(segment, imageContext, keyRef) {
  const parts = []
  const regex =
    /(`[^`]+`|\*\*[^*]+\*\*|file:\/\/\/[^\s"'`<>\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif)|[A-Za-z]:[\\/][^\s`"'<>|*?\[\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif))/gi
  let lastIndex = 0
  let match

  while ((match = regex.exec(segment)) !== null) {
    if (match.index > lastIndex) {
      parts.push(segment.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('`')) {
      const inner = token.slice(1, -1)
      if (imageContext && isImageTarget(inner)) {
        const src = resolveImageSrc(inner, imageContext)
        const label = getImageLabel(inner)
        parts.push(
          <button
            key={`imgc-${keyRef.n++}`}
            type="button"
            onClick={() =>
              src &&
              imageContext.onOpenImage?.({
                images: [{ src, label, rawPath: inner }],
                index: 0,
              })
            }
            className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-[#EEF2FF] px-1.5 py-0.5 align-baseline font-mono text-[0.86em] text-[#3552E8] hover:bg-[#E0E7FF] dark:bg-[#273154] dark:text-[#96AEFF]"
          >
            <ImageIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </button>,
        )
      } else {
        parts.push(
          <code
            key={`c-${keyRef.n++}`}
            className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.88em] text-[#3552E8] dark:bg-slate-800 dark:text-[#8CA3FF]"
          >
            {inner}
          </code>,
        )
      }
    } else if (token.startsWith('**')) {
      parts.push(
        <strong key={`b-${keyRef.n++}`} className="font-semibold text-slate-900 dark:text-white">
          {token.slice(2, -2)}
        </strong>,
      )
    } else if (imageContext && isImageTarget(token)) {
      const src = resolveImageSrc(token, imageContext)
      const label = getImageLabel(token)
      parts.push(
        <button
          key={`imgp-${keyRef.n++}`}
          type="button"
          onClick={() =>
            src &&
            imageContext.onOpenImage?.({
              images: [{ src, label, rawPath: token }],
              index: 0,
            })
          }
          className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg bg-[#EEF2FF] px-2 py-0.5 align-baseline text-[13px] font-medium text-[#3552E8] transition hover:bg-[#E0E7FF] active:scale-95 dark:bg-[#273154] dark:text-[#96AEFF]"
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>,
      )
    } else {
      parts.push(token)
    }
    lastIndex = regex.lastIndex
  }
  if (lastIndex < segment.length) {
    parts.push(segment.slice(lastIndex))
  }
  return parts
}

function renderInline(text, imageContext) {
  const srcText = String(text || '')
  const links = scanMarkdownLinks(srcText)
  const keyRef = { n: 0 }

  if (links.length === 0) {
    return renderPlainTokens(srcText, imageContext, keyRef)
  }

  const parts = []
  let cursor = 0

  for (const item of links) {
    if (item.start > cursor) {
      parts.push(...renderPlainTokens(srcText.slice(cursor, item.start), imageContext, keyRef))
    }

    const isImg = item.isImage || isImageTarget(item.dest)
    if (isImg && imageContext) {
      const src = resolveImageSrc(item.dest, imageContext)
      const label = item.label || getImageLabel(item.dest)
      parts.push(
        <button
          key={`imgl-${keyRef.n++}`}
          type="button"
          onClick={() =>
            src &&
            imageContext.onOpenImage?.({
              images: [{ src, label, rawPath: item.dest }],
              index: 0,
            })
          }
          className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg bg-[#EEF2FF] px-2 py-0.5 align-baseline text-[13px] font-medium text-[#3552E8] transition hover:bg-[#E0E7FF] active:scale-95 dark:bg-[#273154] dark:text-[#96AEFF]"
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>,
      )
    } else if (/^https?:\/\//i.test(item.dest)) {
      parts.push(
        <a
          key={`a-${keyRef.n++}`}
          href={item.dest}
          target="_blank"
          rel="noreferrer"
          className="text-[#4D6BFE] underline underline-offset-2"
        >
          {item.label || item.dest}
        </a>,
      )
    } else {
      // Non-image local file link (e.g. [app.js](file:///...)) -> clean inline code label
      parts.push(
        <code
          key={`fl-${keyRef.n++}`}
          className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.88em] text-[#3552E8] dark:bg-slate-800 dark:text-[#8CA3FF]"
        >
          {item.label || item.dest}
        </code>,
      )
    }

    cursor = item.end
  }

  if (cursor < srcText.length) {
    parts.push(...renderPlainTokens(srcText.slice(cursor), imageContext, keyRef))
  }

  return parts
}

/**
 * Lightweight, XSS-safe Markdown renderer styled to match DeepSeek Mobile typography.
 * Supports balanced-parenthesis image links (e.g. `屏幕截图(1).png`) and inline lightbox chips.
 */
export function MarkdownView({ text, streaming = false, imageContext = null }) {
  if (!text) return null
  const blocks = []
  const lines = String(text).split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const codeLines = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push(<CodeBlock key={blocks.length} language={lang} code={codeLines.join('\n')} />)
      continue
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (hMatch) {
      const level = hMatch[1].length
      const sizes = {
        1: 'text-lg font-bold mt-3.5 mb-1.5',
        2: 'text-base font-bold mt-3 mb-1.5',
        3: 'text-[15px] font-semibold mt-2.5 mb-1',
        4: 'text-sm font-semibold mt-2 mb-1',
      }
      blocks.push(
        <div key={blocks.length} className={`${sizes[level]} text-slate-900 dark:text-white`}>
          {renderInline(hMatch[2], imageContext)}
        </div>,
      )
      i += 1
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i += 1
      }
      blocks.push(
        <blockquote
          key={blocks.length}
          className="my-2 border-l-3 border-[#4D6BFE]/50 pl-3 text-[14px] text-slate-600 dark:text-slate-300"
        >
          {quoteLines.map((ql, idx) => (
            <p key={idx} className="my-0.5">{renderInline(ql, imageContext)}</p>
          ))}
        </blockquote>,
      )
      continue
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''))
        i += 1
      }
      blocks.push(
        <ul key={blocks.length} className="my-1.5 list-disc space-y-1 pl-5 text-[15px] leading-relaxed">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, imageContext)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      blocks.push(
        <ol key={blocks.length} className="my-1.5 list-decimal space-y-1 pl-5 text-[15px] leading-relaxed">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, imageContext)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={blocks.length} className="my-3 border-slate-200 dark:border-slate-700" />)
      i += 1
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    // Paragraph
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !lines[i].startsWith('> ') &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    blocks.push(
      <p key={blocks.length} className="my-1.5 whitespace-pre-wrap text-[15px] leading-[1.7] text-slate-800 dark:text-slate-100">
        {renderInline(para.join('\n'), imageContext)}
      </p>,
    )
  }

  return <div className={streaming ? 'stream-caret' : ''}>{blocks}</div>
}
