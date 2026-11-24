import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { APP_META } from '@allinone/shared'
import { ArrowUp, ChevronDown, Loader2, Paperclip, SlidersHorizontal, Square, X } from 'lucide-react'
import { VendorIcon, formatEffortLabel, formatModelShort } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { isRelayUploadTarget, resolveImageSrc } from '../lib/imageUrls.js'
import { loadE2eeImageUrl, needsE2eeMediaLoad } from '../lib/e2eeMedia.js'
import { clearDraft, loadDraft, saveDraft } from '../lib/draftStore.js'

function revokeAttachmentPreview(att) {
  const url = att?.localPreviewUrl
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url) } catch {}
  }
}

function ComposerAttachmentChip({ att, imageContext, onRemove }) {
  const isImg = String(att?.mimeType || '').startsWith('image/')
  const [previewFailed, setPreviewFailed] = useState(false)
  const [decryptedSrc, setDecryptedSrc] = useState('')
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    setPreviewFailed(false)
    setDecryptedSrc('')
    setLoadError(false)
  }, [att?.id, att?.url, att?.localPreviewUrl])

  const effectiveAtt = previewFailed ? { ...att, localPreviewUrl: '' } : att
  const needsE2ee = isImg && needsE2eeMediaLoad(effectiveAtt, imageContext)
  const directSrc =
    isImg && !needsE2ee
      ? effectiveAtt.localPreviewUrl || resolveImageSrc({ url: effectiveAtt.url }, imageContext)
      : ''
  const e2eeKeysSig = imageContext?.e2eeKeys
    ? Object.keys(imageContext.e2eeKeys).sort().join(',')
    : ''

  useEffect(() => {
    if (!needsE2ee) {
      setDecryptedSrc('')
      return
    }
    const targetUrl = String(effectiveAtt?.url || '').trim()
    if (isRelayUploadTarget(targetUrl) && effectiveAtt?.e2ee?.iv && imageContext?.baseUrl && !imageContext?.mediaToken) {
      return
    }
    let cancelled = false
    setLoadError(false)
    loadE2eeImageUrl(effectiveAtt, imageContext)
      .then((blobUrl) => {
        if (cancelled) return
        if (blobUrl) setDecryptedSrc(blobUrl)
        else setLoadError(true)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [
    needsE2ee,
    effectiveAtt?.url,
    effectiveAtt?.e2ee?.iv,
    effectiveAtt?.e2ee?.kid,
    imageContext?.baseUrl,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.mediaToken,
    imageContext?.e2eeKey,
    imageContext?.e2eeKeyId,
    e2eeKeysSig,
  ])

  const thumbSrc = needsE2ee ? decryptedSrc : directSrc

  if (isImg && !loadError && (thumbSrc || needsE2ee)) {
    return (
      <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-2xs dark:border-slate-700 dark:bg-[#232630]">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={att.filename}
            onError={() => {
              if (!previewFailed && att.localPreviewUrl) {
                setPreviewFailed(true)
              } else {
                setLoadError(true)
              }
            }}
            className="h-full w-full object-cover"
          />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
        )}
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
  onSwitchAppClick,
  modelPref,
  modelDisplayName,
  onOpenModelPicker,
  imageContext,
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
  const fileRef = useRef(null)
  const textareaRef = useRef(null)
  const draftKeyRef = useRef(draftKey)
  const textRef = useRef(text)
  const attachmentsRef = useRef(attachments)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  textRef.current = text
  attachmentsRef.current = attachments

  const meta = APP_META[activeApp] || APP_META.dsh

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
  }, [draftKey])

  // Keep textarea height synced cleanly after switching to a restored draft (or empty box)
  useLayoutEffect(() => {
    autoResize(textareaRef.current)
  }, [draftKey, text])

  const updateText = (nextText) => {
    textRef.current = nextText
    setText(nextText)
    saveDraft(draftKeyRef.current, { text: nextText, attachments: attachmentsRef.current })
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
      if (mountedRef.current && draftKeyRef.current === originDraftKey) {
        if (textRef.current === '' && attachmentsRef.current.length === 0) {
          textRef.current = rawText
          attachmentsRef.current = curAttachments
          setText(rawText)
          setAttachments(curAttachments)
        }
        saveDraft(originDraftKey, { text: textRef.current, attachments: attachmentsRef.current })
      } else {
        for (const att of curAttachments) {
          revokeAttachmentPreview(att)
        }
        if (originDraftKey.includes('::__new__::')) {
          clearDraft(originDraftKey)
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
      <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
        {inlineError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-1.5 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
            <span className="min-w-0 flex-1 truncate">{inlineError}</span>
            <button type="button" onClick={() => setInlineError('')} className="shrink-0 p-0.5 hover:opacity-75">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* Pending attachment chips (with E2EE-capable image thumbnails!) */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((att, idx) => (
              <ComposerAttachmentChip
                key={att?.id || att?.url || `att-${idx}`}
                att={att}
                imageContext={imageContext}
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
            {/* Left app & model pills */}
            <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={onSwitchAppClick}
                title={bi(`当前应用：${meta.name}（点击新建或切换应用）`, `Current app: ${meta.name} (click to start or switch)`)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 active:scale-95 dark:border-slate-700 dark:bg-[#181A20] dark:text-slate-200"
              >
                <VendorIcon app={activeApp} size={14} />
                <span>{meta.shortName}</span>
              </button>

              {onOpenModelPicker && (
                <button
                  type="button"
                  onClick={onOpenModelPicker}
                  title={bi('切换模型与推理强度', 'Switch model & reasoning effort')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-[#4D6BFE]/50 active:scale-95 dark:border-slate-700 dark:bg-[#181A20] dark:text-slate-200"
                >
                  <SlidersHorizontal className="h-3 w-3 shrink-0 text-[#4D6BFE]" />
                  <span className="max-w-[136px] truncate">
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
