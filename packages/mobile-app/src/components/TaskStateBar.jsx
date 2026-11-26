import React, { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  FileText,
  ListChecks,
  Loader2,
  MinusCircle,
  Target,
  X,
  XCircle,
} from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import { fetchE2eeDeliverableFile } from '../lib/e2eeFiles.js'

const LazyMarkdownView = lazy(() =>
  import('../lib/markdown.jsx').then((mod) => ({ default: mod.MarkdownView })),
)

function PlanDocModal({ planDoc, imageContext, onClose }) {
  const { bi } = useI18n()
  const [content, setContent] = useState(() => (typeof planDoc?.content === 'string' ? planDoc.content : ''))
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const imageContextRef = useRef(imageContext)
  imageContextRef.current = imageContext
  const isMacDesktop =
    typeof window !== 'undefined' &&
    Boolean(window.allinoneDesktop?.isDesktop) &&
    window.allinoneDesktop?.platform === 'darwin'

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (typeof planDoc?.content === 'string' && planDoc.content.trim()) {
      setContent(planDoc.content)
      setLoading(false)
      setErrorMsg('')
      return
    }
    if (!planDoc?.path) return
    let cancelled = false
    setLoading(true)
    setErrorMsg('')
    fetchE2eeDeliverableFile(planDoc.path, imageContextRef.current, { forceRefresh: true })
      .then((entry) => entry.blob.text())
      .then((txt) => {
        if (!cancelled) setContent(txt)
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(String(err?.message || err || bi('读取计划文档失败', 'Failed to load plan document')))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    planDoc?.path,
    planDoc?.content,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.e2eeKeyId,
    bi,
  ])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={planDoc?.title || 'Plan'}
      className="animate-fullscreen-in fixed inset-0 z-[92] flex flex-col bg-white dark:bg-[#16181F]"
    >
      <div
        className={`${
          isMacDesktop ? 'pt-9' : 'pt-safe'
        } shrink-0 border-b border-slate-200/80 bg-white px-4 pb-2.5 dark:border-slate-800 dark:bg-[#16181F]`}
      >
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 pt-1.5 lg:max-w-3xl">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                {planDoc?.title || bi('执行计划', 'Plan')}
              </div>
              {planDoc?.path && (
                <div className="truncate font-mono text-[10.5px] text-slate-400 dark:text-slate-500">
                  {planDoc.path}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            aria-label={bi('关闭计划预览', 'Close plan preview')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 active:scale-95 dark:text-slate-400 dark:hover:bg-[#252936] dark:hover:text-white"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
              <span>{bi('正在通过端到端加密通道加载计划文档...', 'Loading plan document via E2EE...')}</span>
            </div>
          ) : errorMsg ? (
            <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{errorMsg}</span>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
                </div>
              }
            >
              <LazyMarkdownView text={content} imageContext={imageContext} />
            </Suspense>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function StepStatusIcon({ status, running }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'in_progress':
      return running ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[#4D6BFE]" />
      ) : (
        <span className="mt-1.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          <span className="h-2 w-2 rounded-full bg-[#4D6BFE]" />
        </span>
      )
    case 'failed':
      return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
    case 'skipped':
      return <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
    default:
      return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-slate-600" />
  }
}

function formatGoalStatusBadge(status, bi) {
  switch (status) {
    case 'complete':
      return {
        label: bi('已完成', 'Done'),
        cls: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
      }
    case 'paused':
      return {
        label: bi('已暂停', 'Paused'),
        cls: 'bg-slate-200/80 text-slate-600 dark:bg-slate-700/70 dark:text-slate-300',
      }
    case 'blocked':
      return {
        label: bi('需介入', 'Blocked'),
        cls: 'bg-rose-500/12 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300',
      }
    case 'limited':
      return {
        label: bi('已达上限', 'Limited'),
        cls: 'bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
      }
    default:
      return {
        label: bi('进行中', 'Active'),
        cls: 'bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
      }
  }
}

/**
 * Minimal, collapsible sticky Plan / Goal / Steps status bar pinned cleanly above the chat stream.
 * Renders ONLY while a plan/goal/checklist is active or actionable, and auto-hides cleanly once finished.
 */
export function TaskStateBar({ sessionId = '', taskState = null, running = false, imageContext }) {
  const { bi } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [justCompleted, setJustCompleted] = useState(false)
  const wasActionableRef = useRef(false)
  const hideTimerRef = useRef(null)

  const mode = taskState?.mode === 'plan' || taskState?.mode === 'goal' ? taskState.mode : ''
  const focus = String(taskState?.focus || '').trim()
  const goal = taskState?.goal?.objective ? taskState.goal : null
  const steps = Array.isArray(taskState?.steps) ? taskState.steps : []
  const planDoc =
    taskState?.planDoc && (taskState.planDoc.path || taskState.planDoc.content) ? taskState.planDoc : null

  const totalSteps = steps.length
  const doneSteps = steps.filter((s) => s.status === 'done').length
  const failedSteps = steps.filter((s) => s.status === 'failed').length
  const pendingOrRunningSteps = steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').length
  const activeStep = steps.find((s) => s.status === 'in_progress') || null
  const allDone = totalSteps > 0 && steps.every((s) => s.status === 'done' || s.status === 'skipped')
  const hasActiveGoal = Boolean(goal && goal.status !== 'complete')
  const hasActivePlanMode = mode === 'plan' && !allDone
  const hasActiveGoalMode = mode === 'goal' && (!goal || goal.status !== 'complete')
  const isActionable =
    pendingOrRunningSteps > 0 ||
    failedSteps > 0 ||
    hasActivePlanMode ||
    hasActiveGoal ||
    hasActiveGoalMode
  const hasLiveFocusOnly = Boolean(running && totalSteps === 0 && focus)

  // Always auto-collapse and reset completion flash when switching conversations
  useEffect(() => {
    setExpanded(false)
    setPlanOpen(false)
    setJustCompleted(false)
    wasActionableRef.current = false
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [sessionId])

  // Show a brief completion confirmation when transitioning live from active -> allDone, then auto-hide
  useEffect(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    if (isActionable) {
      wasActionableRef.current = true
      setJustCompleted(false)
      return
    }
    if (allDone && wasActionableRef.current) {
      setJustCompleted(true)
      if (!running && !expanded && !planOpen) {
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null
          wasActionableRef.current = false
          setJustCompleted(false)
        }, 2500)
      }
      return
    }
    wasActionableRef.current = false
    setJustCompleted(false)
  }, [sessionId, isActionable, allDone, running, expanded, planOpen])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  const shouldShow =
    isActionable ||
    hasLiveFocusOnly ||
    justCompleted ||
    ((expanded || planOpen) && Boolean(mode || focus || goal || totalSteps > 0 || planDoc))

  if (!shouldShow) {
    return null
  }

  const progressPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

  const summaryText = (() => {
    if (activeStep) return activeStep.title
    if (focus && !allDone) return focus
    if (allDone) return bi(`已完成 ${doneSteps}/${totalSteps} 步`, `Completed ${doneSteps}/${totalSteps} steps`)
    if (goal?.objective) return goal.objective
    if (steps[0]) return steps[0].title
    if (planDoc) return planDoc.title
    if (mode === 'plan') return bi('Plan 规划模式', 'Plan Mode')
    return bi('Goal 目标模式', 'Goal Mode')
  })()

  const canExpand =
    totalSteps > 0 ||
    Boolean(goal) ||
    Boolean(planDoc) ||
    Boolean(focus && activeStep && focus !== activeStep.title)

  const goalBadge = goal ? formatGoalStatusBadge(goal.status, bi) : null

  return (
    <div className="shrink-0 border-b border-slate-200/75 bg-slate-50/90 backdrop-blur-md dark:border-slate-800/80 dark:bg-[#1A1C24]/95">
      <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
        {/* Collapsed slim single-line header */}
        <div className="flex items-center gap-1.5 px-3.5 py-1.5">
          <button
            type="button"
            disabled={!canExpand}
            onClick={() => canExpand && setExpanded((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
          >
            {running && !allDone ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#4D6BFE]" />
            ) : failedSteps > 0 ? (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            ) : allDone ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : mode === 'goal' || goal ? (
              <Target className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            ) : (
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
            )}

            {mode === 'plan' && (
              <span className="shrink-0 rounded-full bg-[#4D6BFE]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[#3552E8] dark:bg-[#4D6BFE]/22 dark:text-[#9AB0FF]">
                Plan
              </span>
            )}
            {mode === 'goal' && (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                Goal
              </span>
            )}

            <span
              className={`min-w-0 flex-1 truncate text-xs font-medium ${
                allDone
                  ? 'text-slate-500 dark:text-slate-400'
                  : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              {summaryText}
            </span>

            {totalSteps > 0 && (
              <span
                className={`shrink-0 font-mono text-[11px] font-semibold ${
                  allDone
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {doneSteps}/{totalSteps}
              </span>
            )}

            {canExpand && (
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${
                  expanded ? 'rotate-180' : ''
                }`}
              />
            )}
          </button>

          {planDoc && !expanded && (
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200/80 bg-white px-2 py-0.5 text-[10.5px] font-medium text-slate-600 transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-300"
              title={planDoc.title}
            >
              <FileText className="h-3 w-3 text-[#4D6BFE]" />
              <span>{bi('计划', 'Plan')}</span>
            </button>
          )}
        </div>

        {/* Expanded detail drawer */}
        {expanded && canExpand && (
          <div className="animate-reveal-down space-y-2 border-t border-slate-200/60 px-3.5 pt-2 pb-2.5 dark:border-slate-800/80">
            {goal && (
              <div className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${goalBadge.cls}`}>
                  {goalBadge.label}
                </span>
                <span className="min-w-0 flex-1 leading-relaxed text-slate-700 dark:text-slate-200">
                  {goal.objective}
                </span>
              </div>
            )}

            {focus && (!activeStep || focus !== activeStep.title) && (!goal || focus !== goal.objective) && (
              <div className="text-[11.5px] leading-snug text-slate-500 dark:text-slate-400">
                {focus}
              </div>
            )}

            {totalSteps > 0 && (
              <div className="max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
                {steps.map((step, idx) => (
                  <div key={step.id || `step-${idx}`} className="flex items-start gap-2 text-xs">
                    <StepStatusIcon status={step.status} running={running} />
                    <span
                      className={`min-w-0 flex-1 leading-snug ${
                        step.status === 'done' || step.status === 'skipped'
                          ? 'text-slate-400 line-through decoration-slate-300 dark:text-slate-500 dark:decoration-slate-600'
                          : step.status === 'in_progress'
                            ? 'font-semibold text-slate-900 dark:text-white'
                            : step.status === 'failed'
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {step.title}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {planDoc && (
              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={() => setPlanOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200/85 bg-white px-2.5 py-1 text-[11.5px] font-medium text-slate-700 transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-200"
                >
                  <FileText className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span className="max-w-[240px] truncate">{bi(`查看计划：${planDoc.title}`, `View Plan: ${planDoc.title}`)}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subtle 2px progress track along bottom edge when steps exist */}
      {totalSteps > 0 && (
        <div className="h-[2px] w-full bg-slate-200/70 dark:bg-slate-800/80">
          <div
            className={`h-full transition-all duration-300 ${
              failedSteps > 0
                ? 'bg-rose-500'
                : allDone
                  ? 'bg-emerald-500'
                  : 'bg-[#4D6BFE]'
            }`}
            style={{ width: `${Math.max(allDone ? 100 : 4, progressPct)}%` }}
          />
        </div>
      )}

      {planOpen && planDoc && (
        <PlanDocModal
          planDoc={planDoc}
          imageContext={imageContext}
          onClose={() => setPlanOpen(false)}
        />
      )}
    </div>
  )
}
