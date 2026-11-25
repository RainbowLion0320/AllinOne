import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { APP_META } from '@allinone/shared'
import {
  ArrowUp,
  BookOpen,
  ChevronDown,
  Clock,
  Eraser,
  FileCode,
  FileDiff,
  FileSearch,
  FoldVertical,
  Globe,
  ListTodo,
  Loader2,
  MessageSquarePlus,
  MessageSquareText,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
  Square,
  Timer,
  Users,
  X,
} from 'lucide-react'
import { formatEffortLabel, formatModelShort } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { clearDraft, loadDraft, saveDraft } from '../lib/draftStore.js'

// Native slash commands inherited from each AI tool (forwarded directly on send)
const NATIVE_SLASH_COMMANDS = {
  antigravity: [
    { cmd: '/plan', icon: ListTodo, zh: '计划模式 · 先规划步骤再执行', en: 'Plan step-by-step before executing' },
    { cmd: '/goal', icon: Timer, zh: '目标模式 · 持续推进直到完成', en: 'Run until the goal is completely finished' },
    { cmd: '/compact', icon: FoldVertical, zh: '压缩总结当前对话上下文', en: 'Compact & summarize conversation context' },
    { cmd: '/schedule', icon: Clock, zh: '设置定时或周期执行任务', en: 'Schedule recurring job or one-shot timer' },
    { cmd: '/browser', icon: Globe, zh: '调用浏览器 Agent 处理网页任务', en: 'Invoke browser agent for web tasks' },
    { cmd: '/btw', icon: MessageSquarePlus, zh: '顺便提问而不打断主对话', en: 'Ask a quick question without interrupting' },
    { cmd: '/grill-me', icon: MessageSquareText, zh: '交互式访谈对齐方案细节', en: 'Interactive interview to align on a plan' },
    { cmd: '/teamwork', icon: Users, zh: '多 Agent 协同处理复杂任务', en: 'Multi-agent teamwork for large projects' },
    { cmd: '/boost', icon: Sparkles, zh: '深度思考与多视角严格验证', en: 'Deep thinking & rigorous verification' },
    { cmd: '/learn', icon: BookOpen, zh: '固化经验偏好供后续复用', en: 'Persist learnings for future tasks' },
  ],
  codex: [
    { cmd: '/plan', icon: ListTodo, zh: '计划模式 · 先制定实施计划', en: 'Plan mode before executing changes' },
    { cmd: '/goal', icon: Timer, zh: '设定当前线程持续目标', en: 'Set an active goal for this thread' },
    { cmd: '/compact', icon: FoldVertical, zh: '压缩当前对话上下文', en: 'Compact conversation context' },
    { cmd: '/review', icon: FileSearch, zh: '审查当前代码改动', en: 'Review workspace changes' },
    { cmd: '/diff', icon: FileDiff, zh: '查看当前工作区改动', en: 'Inspect current workspace diff' },
  ],
  claude: [
    { cmd: '/plan', icon: ListTodo, zh: '计划模式 · 只读分析并制定方案', en: 'Enter read-only plan mode' },
    { cmd: '/compact', icon: FoldVertical, zh: '压缩当前对话上下文', en: 'Compact conversation context' },
    { cmd: '/review', icon: FileSearch, zh: '代码审查与风险检查', en: 'Review code changes' },
    { cmd: '/clear', icon: Eraser, zh: '清空当前上下文重新开始', en: 'Clear conversation history' },
    { cmd: '/init', icon: FileCode, zh: '初始化项目 CLAUDE.md 指引', en: 'Initialize project CLAUDE.md guide' },
  ],
  dsh: [
    { cmd: '/plan', icon: ListTodo, zh: '计划模式', en: 'Plan mode' },
    { cmd: '/compact', icon: FoldVertical, zh: '压缩对话上下文', en: 'Compact conversation context' },
  ],
}

function revokeAttachmentPreview(att) {
  const url = att?.localPreviewUrl
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url) } catch {}
  }
}

function ComposerAttachmentChip({ att, onRemove }) {
  const isImg = String(att?.mimeType || '').startsWith('image/')
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setLoadError(false)
  }, [att?.id, att?.localPreviewUrl])

  const thumbSrc = isImg && !loadError ? String(att?.localPreviewUrl || '') : ''

  if (isImg && thumbSrc) {
    return (
      <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-2xs dark:border-slate-700 dark:bg-[#232630]">
        <img
          src={thumbSrc}
          alt={att.filename}
          onError={() => setLoadError(true)}
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/65 text-white hover:bg-rose-500"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-200">
      <span className="max-w-[140px] truncate">{att.filename}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-slate-400 hover:text-rose-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}

export function Composer({
  draftKey = '',
  activeApp,
  streaming,
  disabled,
  needsWorkspace = false,
  targetWorkspaceName = '',
  modelPref,
  modelDisplayName,
  onOpenModelPicker,
  onUploadFile,
  onSend,
  onInterrupt,
  onError = null,
}) {
  const { lang, bi } = useI18n()
  const [text, setText] = useState(() => loadDraft(draftKey).text)
  const [attachments, setAttachments] = useState(() => loadDraft(draftKey).attachments)
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [inlineError, setInlineError] = useState('')
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)
  const fileRef = useRef(null)
  const textareaRef = useRef(null)
  const slashListRef = useRef(null)
  const draftKeyRef = useRef(draftKey)
  const textRef = useRef(text)
  const attachmentsRef = useRef(attachments)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  textRef.current = text
  attachmentsRef.current = attachments

  const meta = APP_META[activeApp] || APP_META.dsh

  // Match leading single slash token (e.g. "/", "/p", "/plan") before any space
  const slashMatch = !slashDismissed && !disabled && !needsWorkspace ? /^\/([^\s]*)$/.exec(text) : null
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null
  const slashOptions = useMemo(() => {
    if (slashQuery === null) return []
    const list = NATIVE_SLASH_COMMANDS[activeApp] || NATIVE_SLASH_COMMANDS.dsh
    if (!slashQuery) return list
    return list.filter((item) => item.cmd.slice(1).toLowerCase().includes(slashQuery))
  }, [activeApp, slashQuery])
  const showSlashMenu = slashQuery !== null && slashOptions.length > 0

  useEffect(() => {
    setSlashIdx(0)
  }, [slashQuery, activeApp])

  useEffect(() => {
    if (!showSlashMenu || !slashListRef.current) return
    const activeEl = slashListRef.current.children?.[slashIdx]
    activeEl?.scrollIntoView?.({ block: 'nearest' })
  }, [showSlashMenu, slashIdx])

  const autoResize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  // Revoke any unsent blob preview URLs on unmount (sent attachments are already cleared from ref)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const att of attachmentsRef.current) {
        revokeAttachmentPreview(att)
      }
    }
  }, [])

  // Save outgoing conversation's draft and restore incoming conversation's draft whenever draftKey changes
  useEffect(() => {
    const prevKey = draftKeyRef.current
    if (prevKey === draftKey) return
    if (!sendingRef.current) {
      saveDraft(prevKey, { text: textRef.current, attachments: attachmentsRef.current })
      for (const att of attachmentsRef.current) {
        revokeAttachmentPreview(att)
      }
    } else if (prevKey.includes('::__new__::')) {
      clearDraft(prevKey)
    }
    draftKeyRef.current = draftKey
    const nextDraft = loadDraft(draftKey)
    textRef.current = nextDraft.text
    attachmentsRef.current = nextDraft.attachments
    setText(nextDraft.text)
    setAttachments(nextDraft.attachments)
    setInlineError('')
    setSlashDismissed(false)
  }, [draftKey])

  // Keep textarea height synced cleanly after switching to a restored draft (or empty box)
  useLayoutEffect(() => {
    autoResize(textareaRef.current)
  }, [draftKey, text])

  const updateText = (nextText) => {
    textRef.current = nextText
    setText(nextText)
    setSlashDismissed(false)
    saveDraft(draftKeyRef.current, { text: nextText, attachments: attachmentsRef.current })
  }

  const applySlashCommand = (cmdStr) => {
    const next = `${cmdStr} `
    textRef.current = next
    setText(next)
    setSlashDismissed(true)
    saveDraft(draftKeyRef.current, { text: next, attachments: attachmentsRef.current })
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.length, next.length)
      autoResize(el)
    })
  }

  const updateAttachments = (updater) => {
    setAttachments((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      attachmentsRef.current = next
      saveDraft(draftKeyRef.current, { text: textRef.current, attachments: next })
      return next
    })
  }

  const handleRemoveAttachment = (attId) => {
    updateAttachments((prev) => {
      const removed = prev.find((x) => x.id === attId)
      if (removed) revokeAttachmentPreview(removed)
      return prev.filter((x) => x.id !== attId)
    })
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !onUploadFile) return
    const targetKey = draftKeyRef.current
    setUploading(true)
    setInlineError('')
    try {
      const uploaded = await onUploadFile(file)
      if (!uploaded || typeof uploaded !== 'object') return
      if (!mountedRef.current) {
        revokeAttachmentPreview(uploaded)
        const existing = loadDraft(targetKey)
        saveDraft(targetKey, {
          text: existing.text,
          attachments: [...existing.attachments, uploaded],
        })
        return
      }
      if (draftKeyRef.current === targetKey) {
        updateAttachments((prev) => [...prev, uploaded])
      } else {
        // User switched conversations mid-upload: revoke ephemeral blob URL and persist scoped metadata
        revokeAttachmentPreview(uploaded)
        const existing = loadDraft(targetKey)
        saveDraft(targetKey, {
          text: existing.text,
          attachments: [...existing.attachments, uploaded],
        })
      }
    } catch (err) {
      const msg = bi(`上传失败：${err?.message || err}`, `Upload failed: ${err?.message || err}`)
      if (onError) onError(msg)
      else if (mountedRef.current) setInlineError(msg)
    } finally {
      if (mountedRef.current) {
        setUploading(false)
      }
    }
  }

  const handleSubmit = async () => {
    const rawText = textRef.current
    const trimmed = rawText.trim()
    const curAttachments = attachmentsRef.current
    if (!trimmed && curAttachments.length === 0) return
    if (disabled || streaming || uploading || sendingRef.current || needsWorkspace) return
    const originDraftKey = draftKeyRef.current
    sendingRef.current = true
    setSending(true)
    setInlineError('')

    const restoreOnFailure = () => {
      const currentKey = draftKeyRef.current
      const originScopePrefix = originDraftKey.includes('::__new__::')
        ? `${originDraftKey.split('::__new__::')[0]}::`
        : ''
      const transitionedToCreatedSession = Boolean(
        originScopePrefix &&
          currentKey !== originDraftKey &&
          currentKey.startsWith(originScopePrefix) &&
          !currentKey.includes('::__new__::'),
      )

      if (mountedRef.current && (currentKey === originDraftKey || transitionedToCreatedSession)) {
        if (transitionedToCreatedSession) {
          clearDraft(originDraftKey)
        }
        if (textRef.current === '' && attachmentsRef.current.length === 0) {
          textRef.current = rawText
          attachmentsRef.current = curAttachments
          setText(rawText)
          setAttachments(curAttachments)
        } else {
          for (const att of curAttachments) {
            revokeAttachmentPreview(att)
          }
        }
        saveDraft(currentKey, { text: textRef.current, attachments: attachmentsRef.current })
      } else {
        for (const att of curAttachments) {
          revokeAttachmentPreview(att)
        }
        if (transitionedToCreatedSession) {
          clearDraft(originDraftKey)
          saveDraft(currentKey, { text: rawText, attachments: curAttachments })
        } else {
          saveDraft(originDraftKey, { text: rawText, attachments: curAttachments })
        }
      }
    }

    try {
      const result = await onSend({ text: trimmed, attachments: curAttachments })
      if (result === false) {
        restoreOnFailure()
        return
      }
      clearDraft(originDraftKey)
      if (mountedRef.current && draftKeyRef.current === originDraftKey) {
        textRef.current = ''
        attachmentsRef.current = []
        setText('')
        setAttachments([])
        setSlashDismissed(false)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
    } catch {
      restoreOnFailure()
    } finally {
      sendingRef.current = false
      if (mountedRef.current) {
        setSending(false)
      }
    }
  }

  const handleKeyDown = (e) => {
    if (showSlashMenu && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % slashOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + slashOptions.length) % slashOptions.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const picked = slashOptions[slashIdx] || slashOptions[0]
        if (picked) applySlashCommand(picked.cmd)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const picked = slashOptions[slashIdx] || slashOptions[0]
        // If user hasn't typed the exact command yet, Enter completes it; if exact command already typed (e.g. /compact), Enter sends directly
        if (picked && text.trim().toLowerCase() !== picked.cmd.toLowerCase()) {
          e.preventDefault()
          applySlashCommand(picked.cmd)
          return
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!uploading && !sendingRef.current) {
        void handleSubmit()
      }
    }
  }

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    !disabled &&
    !uploading &&
    !sending &&
    !needsWorkspace
  const placeholderText = needsWorkspace
    ? bi('请先在上方选择目标项目目录...', 'Select a project directory above first...')
    : targetWorkspaceName
      ? bi(`在 ${targetWorkspaceName} 给 ${meta.shortName} 发送消息...`, `Message ${meta.shortName} in ${targetWorkspaceName}...`)
      : bi(`给 ${meta.shortName} 发送消息...`, `Message ${meta.shortName}...`)

  return (
    <div className="pb-safe shrink-0 bg-white/90 px-3 pt-2 backdrop-blur-md dark:bg-[#16171A]/90">
      <div className="relative mx-auto w-full max-w-2xl lg:max-w-3xl">
        {/* Native Slash Command Popup (floats above composer with zero layout shift) */}
        {showSlashMenu && (
          <div
            ref={slashListRef}
            role="listbox"
            aria-label={bi('斜杠命令', 'Slash commands')}
            className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-slate-200/90 bg-white p-1.5 shadow-xl dark:border-slate-700/80 dark:bg-[#1C1E26]"
          >
            {slashOptions.map((item, idx) => {
              const active = idx === slashIdx
              const CmdIcon = item.icon
              return (
                <button
                  key={item.cmd}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSlashIdx(idx)}
                  onClick={() => applySlashCommand(item.cmd)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                    active
                      ? 'bg-[#4D6BFE]/12 dark:bg-[#4D6BFE]/22'
                      : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/70'
                  }`}
                >
                  {CmdIcon && (
                    <CmdIcon
                      className={`h-3.5 w-3.5 shrink-0 ${
                        active ? 'text-[#3552E8] dark:text-[#96AEFF]' : 'text-slate-400 dark:text-slate-400'
                      }`}
                    />
                  )}
                  <span
                    className={`shrink-0 font-mono text-xs font-semibold ${
                      active ? 'text-[#3552E8] dark:text-[#96AEFF]' : 'text-slate-800 dark:text-slate-100'
                    }`}
                  >
                    {item.cmd}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-500 dark:text-slate-400">
                    {bi(item.zh, item.en)}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {inlineError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-1.5 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
            <span className="min-w-0 flex-1 truncate">{inlineError}</span>
            <button type="button" onClick={() => setInlineError('')} className="shrink-0 p-0.5 hover:opacity-75">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Pending attachment chips */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((att, idx) => (
              <ComposerAttachmentChip
                key={att?.id || att?.url || `att-${idx}`}
                att={att}
                onRemove={() => handleRemoveAttachment(att?.id)}
              />
            ))}
          </div>
        )}

        {/* Floating DeepSeek-style pill composer */}
        <div className="rounded-[26px] border border-slate-200/90 bg-[#F4F6FA] px-3.5 pt-2.5 pb-2 shadow-xs transition focus-within:border-[#4D6BFE]/60 focus-within:bg-white dark:border-slate-700/80 dark:bg-[#21232B] dark:focus-within:bg-[#242731]">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => {
              updateText(e.target.value)
              autoResize(e.target)
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholderText}
            className="max-h-[140px] w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-slate-900 placeholder-slate-400 outline-none dark:text-white dark:placeholder-slate-500"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            {/* Left model picker only (clean, zero clutter) */}
            <div className="flex min-w-0 items-center">
              {onOpenModelPicker && (
                <button
                  type="button"
                  onClick={onOpenModelPicker}
                  title={bi('切换模型与推理强度', 'Switch model & reasoning effort')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-[#4D6BFE]/50 active:scale-95 dark:border-slate-700 dark:bg-[#181A20] dark:text-slate-200"
                >
                  <SlidersHorizontal className="h-3 w-3 shrink-0 text-[#4D6BFE]" />
                  <span className="max-w-[200px] truncate sm:max-w-[260px]">
                    {formatModelShort(modelPref?.model, modelDisplayName, lang)}
                  </span>
                  {modelPref?.reasoningEffort && (
                    <span className="shrink-0 rounded-full bg-[#4D6BFE]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[#3552E8] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]">
                      {formatEffortLabel(modelPref.reasoningEffort, lang)}
                    </span>
                  )}
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                </button>
              )}
            </div>

            {/* Right actions: Upload + Send / Stop */}
            <div className="flex shrink-0 items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                type="button"
                disabled={uploading || disabled}
                onClick={() => fileRef.current?.click()}
                aria-label={bi('上传图片或文件', 'Upload image or file')}
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200/70 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-700/60"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </button>

              {streaming ? (
                <button
                  type="button"
                  onClick={onInterrupt}
                  aria-label={bi('停止生成', 'Stop generating')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500 text-white shadow-xs transition active:scale-95"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={handleSubmit}
                  aria-label={bi('发送', 'Send')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[#4D6BFE] text-white shadow-xs transition active:scale-95 disabled:bg-slate-300 dark:disabled:bg-slate-700"
                >
                  <ArrowUp className="h-4.5 w-4.5 stroke-[2.5]" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
