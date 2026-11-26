import React, { useEffect, useState } from 'react'
import {
  Check,
  ExternalLink,
  HelpCircle,
  Loader2,
  Send,
  ShieldAlert,
} from 'lucide-react'
import { VendorBadge } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'

function initDraftAnswers(questions = []) {
  const init = {}
  for (const q of questions) {
    const def = q?.defaultValue
    if (Array.isArray(def)) {
      init[q.id] = { selected: def.map(String), custom: '' }
    } else if (def !== undefined && def !== null && def !== '') {
      const hasOpt = Array.isArray(q.options) && q.options.some((o) => String(o.value) === String(def))
      init[q.id] = hasOpt
        ? { selected: [String(def)], custom: '' }
        : { selected: [], custom: String(def) }
    } else {
      init[q.id] = { selected: [], custom: '' }
    }
  }
  return init
}

export function InteractivePromptCard({ prompt, onResolve }) {
  const { bi } = useI18n()
  const isQuestion = prompt?.kind === 'question' && Array.isArray(prompt.questions) && prompt.questions.length > 0
  const isUrlMode = prompt?.kind === 'url_elicitation'
  const isDesktopLocked = prompt?.readOnlyHint === 'desktop-running'
  const questions = isQuestion ? prompt.questions : []

  const [answers, setAnswers] = useState(() => initDraftAnswers(questions))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setAnswers(initDraftAnswers(prompt?.questions || []))
    setSubmitting(false)
  }, [prompt?.id])

  if (!prompt) return null

  const runResolve = async (payload) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onResolve?.(prompt.id, payload)
    } finally {
      setSubmitting(false)
    }
  }

  if (isQuestion) {
    const toggleOption = (q, optValue) => {
      setAnswers((prev) => {
        const cur = prev[q.id] || { selected: [], custom: '' }
        if (q.multiSelect) {
          const exists = cur.selected.includes(optValue)
          const nextSel = exists
            ? cur.selected.filter((v) => v !== optValue)
            : [...cur.selected, optValue]
          return { ...prev, [q.id]: { ...cur, selected: nextSel } }
        }
        const already = cur.selected.length === 1 && cur.selected[0] === optValue
        return {
          ...prev,
          [q.id]: { selected: already ? [] : [optValue], custom: '' },
        }
      })
    }

    const updateCustom = (q, value) => {
      setAnswers((prev) => {
        const cur = prev[q.id] || { selected: [], custom: '' }
        return {
          ...prev,
          [q.id]: {
            selected: !q.multiSelect && value.trim().length > 0 ? [] : cur.selected,
            custom: value,
          },
        }
      })
    }

    const hasAnyAnswer = questions.some((q) => {
      const cur = answers[q.id]
      return (cur?.selected?.length || 0) > 0 || Boolean(cur?.custom?.trim())
    })

    const missingRequired = questions.some((q) => {
      if (!q.required) return false
      const cur = answers[q.id]
      return (cur?.selected?.length || 0) === 0 && !cur?.custom?.trim()
    })

    const canSubmit = !submitting && !isDesktopLocked && hasAnyAnswer && !missingRequired

    const handleSubmit = (e) => {
      e?.preventDefault?.()
      if (!canSubmit) return
      const payloadAnswers = {}
      for (const q of questions) {
        const cur = answers[q.id] || { selected: [], custom: '' }
        payloadAnswers[q.id] = {
          selected: cur.selected || [],
          ...(cur.custom?.trim() ? { custom: cur.custom.trim() } : {}),
        }
      }
      void runResolve({ decision: 'submit', answers: payloadAnswers })
    }

    return (
      <form
        onSubmit={handleSubmit}
        className="animate-msg-in rounded-2xl border border-[#4D6BFE]/40 bg-[#F4F7FF]/95 p-3.5 shadow-sm dark:border-[#4D6BFE]/45 dark:bg-[#1C2338]/90"
      >
        <div className="flex items-center gap-2">
          {prompt.app ? (
            <VendorBadge app={prompt.app} size="xs" />
          ) : (
            <HelpCircle className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-900 dark:text-white">
            {prompt.title || bi('需要你的选择', 'Input Needed')}
          </span>
          {questions.length > 1 && (
            <span className="shrink-0 rounded-full bg-[#4D6BFE]/14 px-2 py-0.5 text-[10px] font-semibold text-[#4D6BFE] dark:text-[#9CB2FF]">
              {bi(`${questions.length} 个问题`, `${questions.length} questions`)}
            </span>
          )}
        </div>

        {prompt.detail && (
          <div
            className={`mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed ${
              isDesktopLocked
                ? 'rounded-xl border border-amber-300/70 bg-amber-50/90 px-2.5 py-1.5 text-[11.5px] font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            {prompt.detail}
          </div>
        )}

        <div className="mt-3 space-y-3">
          {questions.map((q, idx) => {
            const cur = answers[q.id] || { selected: [], custom: '' }
            const opts = Array.isArray(q.options) ? q.options : []
            const showInput = q.allowOther !== false || opts.length === 0
            return (
              <div
                key={q.id}
                className="rounded-xl border border-slate-200/80 bg-white/90 p-3 dark:border-slate-700/80 dark:bg-[#141824]/90"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {questions.length > 1 && (
                    <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-md bg-[#4D6BFE]/12 px-1 text-[10px] font-bold text-[#4D6BFE]">
                      {idx + 1}
                    </span>
                  )}
                  {q.header && (
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {q.header}
                    </span>
                  )}
                  {q.multiSelect && (
                    <span className="rounded-md bg-[#4D6BFE]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#4D6BFE]">
                      {bi('多选', 'Multi')}
                    </span>
                  )}
                </div>

                <div className="mt-1.5 text-[13px] font-semibold leading-snug text-slate-900 dark:text-white">
                  {q.question}
                </div>
                {q.description && (
                  <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {q.description}
                  </div>
                )}

                {opts.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    {opts.map((opt) => {
                      const selected = cur.selected.includes(opt.value)
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={submitting}
                          onClick={() => toggleOption(q, opt.value)}
                          className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition active:scale-[0.99] disabled:opacity-60 ${
                            selected
                              ? 'border-[#4D6BFE] bg-[#EEF2FF] dark:border-[#4D6BFE] dark:bg-[#232D4D]'
                              : 'border-slate-200/90 bg-slate-50/70 hover:border-slate-300 dark:border-slate-700/80 dark:bg-[#1B2030] dark:hover:border-slate-600'
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition ${
                              q.multiSelect ? 'rounded-md' : 'rounded-full'
                            } ${
                              selected
                                ? 'border-[#4D6BFE] bg-[#4D6BFE] text-white'
                                : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-transparent'
                            }`}
                          >
                            {selected &&
                              (q.multiSelect ? (
                                <Check className="h-3 w-3 stroke-[3]" />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                              ))}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div
                              className={`text-xs font-semibold leading-snug ${
                                selected ? 'text-[#2842C9] dark:text-white' : 'text-slate-800 dark:text-slate-100'
                              }`}
                            >
                              {opt.label}
                            </div>
                            {opt.description && (
                              <div className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                                {opt.description}
                              </div>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}

                {showInput && (
                  <input
                    type={q.isSecret ? 'password' : q.inputType === 'number' ? 'number' : 'text'}
                    value={cur.custom}
                    disabled={submitting}
                    onChange={(e) => updateCustom(q, e.target.value)}
                    placeholder={
                      opts.length > 0
                        ? bi('或输入其他回答...', 'Or type another answer...')
                        : bi('输入回答...', 'Type your answer...')
                    }
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#1A1E2B] dark:text-white dark:placeholder:text-slate-500 dark:focus:border-[#4D6BFE] dark:focus:bg-[#1E2333]"
                  />
                )}
              </div>
            )
          })}
        </div>

        {!isDesktopLocked && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void runResolve({ decision: 'cancel', answers: {} })}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 active:scale-95 disabled:opacity-50 dark:border-slate-700 dark:bg-[#232736] dark:text-slate-300 dark:hover:bg-[#2C3144]"
          >
            {prompt.cancelLabel || bi('跳过', 'Skip')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-4 py-1.5 text-xs font-semibold text-white shadow-xs shadow-[#4D6BFE]/25 transition active:scale-95 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            <span>{prompt.submitLabel || bi('提交', 'Submit')}</span>
          </button>
        </div>
        )}
      </form>
    )
  }

  // URL elicitation or standard command / file_change / permissions approval card
  return (
    <div className="animate-msg-in rounded-2xl border border-amber-300/80 bg-amber-50/90 p-3.5 shadow-sm dark:border-amber-700/60 dark:bg-amber-950/35">
      <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-200">
        {prompt.app ? (
          <VendorBadge app={prompt.app} size="xs" />
        ) : (
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
        <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
      </div>

      {prompt.detail && (
        <pre className="mt-2 max-h-36 overflow-auto rounded-xl bg-white/80 p-2.5 font-mono text-[11px] whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-800 dark:bg-black/30 dark:text-slate-200">
          {prompt.detail}
        </pre>
      )}

      {isUrlMode && prompt.url && /^https?:\/\//i.test(prompt.url) && (
        <a
          href={prompt.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-xl bg-white/90 px-3 py-1.5 text-xs font-semibold text-[#4D6BFE] hover:underline dark:bg-black/30 dark:text-[#96AEFF]"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{prompt.url}</span>
        </a>
      )}

      {prompt.cwd && (
        <div className="mt-1 break-all text-[10.5px] text-amber-800/70 dark:text-amber-300/70">
          {bi('目录：', 'Directory: ')}{prompt.cwd}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {(prompt.options || []).map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={submitting}
            onClick={() => void runResolve(opt.value)}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition active:scale-95 disabled:opacity-55 ${
              opt.style === 'primary'
                ? 'bg-[#4D6BFE] text-white'
                : opt.style === 'danger'
                  ? 'bg-rose-500 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
