import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { APP_META } from '@allinone/shared'
import { ArrowUp, ChevronDown, Loader2, Paperclip, SlidersHorizontal, Square, X } from 'lucide-react'
import { VendorIcon, formatEffortLabel, formatModelShort } from './VendorIcon.jsx'
import { resolveImageSrc } from '../lib/imageUrls.js'
import { clearDraft, loadDraft, saveDraft } from '../lib/draftStore.js'

export function Composer({
  draftKey = '',
  activeApp,
  streaming,
  disabled,
  needsWorkspace = false,
  targetWorkspaceName = '',
  onSwitchAppClick,
  modelPref,
  modelDisplayName,
  onOpenModelPicker,
  imageContext,
  onUploadFile,
  onSend,
  onInterrupt,
}) {
  const [text, setText] = useState(() => loadDraft(draftKey).text)
  const [attachments, setAttachments] = useState(() => loadDraft(draftKey).attachments)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const textareaRef = useRef(null)
  const draftKeyRef = useRef(draftKey)
  const textRef = useRef(text)
  const attachmentsRef = useRef(attachments)
  textRef.current = text
  attachmentsRef.current = attachments

  const meta = APP_META[activeApp] || APP_META.dsh

  const autoResize = (el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  // Save outgoing conversation's draft and restore incoming conversation's draft whenever draftKey changes
  useEffect(() => {
    const prevKey = draftKeyRef.current
    if (prevKey === draftKey) return
    saveDraft(prevKey, { text: textRef.current, attachments: attachmentsRef.current })
    draftKeyRef.current = draftKey
    const nextDraft = loadDraft(draftKey)
    setText(nextDraft.text)
    setAttachments(nextDraft.attachments)
  }, [draftKey])

  // Keep textarea height synced cleanly after switching to a restored draft (or empty box)
  useLayoutEffect(() => {
    autoResize(textareaRef.current)
  }, [draftKey, text])

  const updateText = (nextText) => {
    setText(nextText)
    saveDraft(draftKeyRef.current, { text: nextText, attachments: attachmentsRef.current })
  }

  const updateAttachments = (updater) => {
    setAttachments((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saveDraft(draftKeyRef.current, { text: textRef.current, attachments: next })
      return next
    })
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !onUploadFile) return
    const targetKey = draftKeyRef.current
    setUploading(true)
    try {
      const uploaded = await onUploadFile(file)
      if (draftKeyRef.current === targetKey) {
        updateAttachments((prev) => [...prev, uploaded])
      } else {
        // User switched conversations mid-upload: keep attachment scoped to the original conversation's draft
        const existing = loadDraft(targetKey)
        saveDraft(targetKey, {
          text: existing.text,
          attachments: [...existing.attachments, uploaded],
        })
      }
    } catch (err) {
      alert(`上传失败：${err.message || err}`)
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (disabled || streaming || needsWorkspace) return
    const curKey = draftKeyRef.current
    onSend({ text: trimmed, attachments })
    clearDraft(curKey)
    setText('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled && !uploading && !needsWorkspace
  const placeholderText = needsWorkspace
    ? '请先在上方选择目标项目目录...'
    : targetWorkspaceName
      ? `在 ${targetWorkspaceName} 给 ${meta.shortName} 发送消息...`
      : `给 ${meta.shortName} 发送消息...`

  return (
    <div className="pb-safe shrink-0 bg-white/90 px-3 pt-2 backdrop-blur-md dark:bg-[#16171A]/90">
      <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
        {/* Pending attachment chips (with image thumbnails!) */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((att) => {
              const isImg = String(att.mimeType || '').startsWith('image/')
              const thumbSrc = isImg ? resolveImageSrc({ url: att.url }, imageContext) : ''
              return isImg && thumbSrc ? (
                <div
                  key={att.id}
                  className="relative h-14 w-14 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-2xs dark:border-slate-700 dark:bg-[#232630]"
                >
                  <img src={thumbSrc} alt={att.filename} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => updateAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                    className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/65 text-white hover:bg-rose-500"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <span
                  key={att.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-200"
                >
                  <span className="max-w-[140px] truncate">{att.filename}</span>
                  <button
                    type="button"
                    onClick={() => updateAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                    className="text-slate-400 hover:text-rose-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              )
            })}
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
            {/* Left app & model pills */}
            <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={onSwitchAppClick}
                title={`当前应用：${meta.name}（点击新建或切换应用）`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 active:scale-95 dark:border-slate-700 dark:bg-[#181A20] dark:text-slate-200"
              >
                <VendorIcon app={activeApp} size={14} />
                <span>{meta.shortName}</span>
              </button>

              {onOpenModelPicker && (
                <button
                  type="button"
                  onClick={onOpenModelPicker}
                  title="切换模型与推理强度"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-[#4D6BFE]/50 active:scale-95 dark:border-slate-700 dark:bg-[#181A20] dark:text-slate-200"
                >
                  <SlidersHorizontal className="h-3 w-3 shrink-0 text-[#4D6BFE]" />
                  <span className="max-w-[136px] truncate">
                    {formatModelShort(modelPref?.model, modelDisplayName)}
                  </span>
                  {modelPref?.reasoningEffort && (
                    <span className="shrink-0 rounded-full bg-[#4D6BFE]/12 px-1.5 py-0.2 text-[10px] font-semibold text-[#3552E8] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]">
                      {formatEffortLabel(modelPref.reasoningEffort)}
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
                aria-label="上传图片或文件"
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
                  aria-label="停止生成"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500 text-white shadow-xs transition active:scale-95"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={handleSubmit}
                  aria-label="发送"
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
