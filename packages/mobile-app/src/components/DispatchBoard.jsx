import React, { useEffect, useState } from 'react'
import { APP_LIST, APP_META } from '@allinone/shared'
import {
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Loader2,
  RefreshCw,
  Send,
  X,
  XCircle,
} from 'lucide-react'
import { VendorBadge, VendorIcon } from './VendorIcon.jsx'

export function DispatchBoard({
  open,
  onClose,
  appsStatus,
  workspaces,
  dispatches,
  onRefresh,
  onDirectDispatch,
  onJumpToSession,
}) {
  const [targetApp, setTargetApp] = useState('codex')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!cwd && workspaces?.[0]?.path) {
      setCwd(workspaces[0].path)
    }
    const curOk = appsStatus.find((a) => a.app === targetApp && a.writable)
    if (!curOk) {
      const firstWritable = ['codex', 'antigravity', 'claude', 'dsh'].find((id) =>
        appsStatus.find((a) => a.app === id && a.writable),
      )
      if (firstWritable) setTargetApp(firstWritable)
    }
  }, [open, workspaces, appsStatus])

  if (!open) return null

  const handleDispatch = async (e) => {
    e.preventDefault()
    if (!prompt.trim()) return
    setSubmitting(true)
    try {
      await onDirectDispatch({ app: targetApp, cwd: cwd.trim(), prompt: prompt.trim() })
      setPrompt('')
    } catch (err) {
      alert(String(err?.message || err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center">
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-[#F8F9FC] shadow-2xl sm:rounded-3xl dark:bg-[#1B1D23]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200/80 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-[#4D6BFE]" />
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">全端总控调度台</h3>
              <p className="text-[11px] text-slate-500">管理 4 个应用在线状态 & 并行跨应用派单</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-xl p-2 text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-slate-500 hover:bg-slate-200/60 dark:hover:bg-slate-800"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        <div className="pb-safe flex-1 space-y-4 overflow-y-auto p-4">
          {/* 4-App Health Grid */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {APP_LIST.map((appId) => {
              const meta = APP_META[appId]
              const st = appsStatus.find((a) => a.app === appId)
              return (
                <div
                  key={appId}
                  className="rounded-2xl border border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-[#232630]"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <VendorBadge app={appId} size="sm" />
                      <span className="text-xs font-bold text-slate-800 dark:text-white">
                        {meta.name}
                      </span>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        st?.writable
                          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : st?.available
                            ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                      }`}
                    >
                      {st?.writable ? '读写就绪' : st?.available ? '仅只读' : '未就绪'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {st?.detail || '检测中...'}
                  </p>
                </div>
              )
            })}
          </div>

          {/* Quick Direct Dispatch Form */}
          <form
            onSubmit={handleDispatch}
            className="rounded-2xl border border-[#4D6BFE]/25 bg-white p-3.5 dark:border-[#4D6BFE]/30 dark:bg-[#232630]"
          >
            <div className="mb-2.5 text-xs font-bold text-slate-800 dark:text-white">
              快速后台派单（支持多应用并行干活）
            </div>
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {APP_LIST.map((appId) => {
                const meta = APP_META[appId]
                const active = targetApp === appId
                return (
                  <button
                    key={appId}
                    type="button"
                    onClick={() => setTargetApp(appId)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                      active
                        ? 'text-white shadow-xs'
                        : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                    style={active ? { backgroundColor: meta.color } : undefined}
                  >
                    <VendorIcon app={appId} size={13} mono={active} />
                    <span>{meta.shortName}</span>
                  </button>
                )
              })}
            </div>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="工作目录（留空则使用电脑默认目录）"
              className="mb-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-[11px] text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-slate-200"
            />
            {workspaces?.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {workspaces.slice(0, 5).map((w) => (
                  <button
                    key={w.id || w.path}
                    type="button"
                    onClick={() => setCwd(w.path)}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {w.title || w.name || w.path}
                  </button>
                ))}
              </div>
            )}
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`输入要派发给 ${APP_META[targetApp]?.shortName} 的任务指令...`}
              className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
            />
            <div className="mt-2.5 flex justify-end">
              <button
                type="submit"
                disabled={submitting || !prompt.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-4 py-2 text-xs font-semibold text-white active:scale-95 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                <span>派发到后台执行</span>
              </button>
            </div>
          </form>

          {/* Dispatched Tasks Feed */}
          <div>
            <div className="mb-2 text-xs font-bold text-slate-600 dark:text-slate-300">
              最近跨应用派单记录（含 DSH 总控自动派单）
            </div>
            {dispatches.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400 dark:border-slate-700">
                暂无派单记录。你可以在上方直接派单，或在 DSH 对话中一句话指挥其他应用。
              </div>
            ) : (
              <div className="space-y-2">
                {dispatches.map((t) => {
                  const meta = APP_META[t.app] || APP_META.dsh
                  return (
                    <div
                      key={t.taskId}
                      className="rounded-2xl border border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-[#232630]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <VendorBadge app={t.app} size="xs" />
                          {t.status === 'running' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#4D6BFE]">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              执行中
                            </span>
                          ) : t.status === 'completed' ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                              <CheckCircle2 className="h-3 w-3" />
                              已完成
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-500">
                              <XCircle className="h-3 w-3" />
                              {t.status}
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            onJumpToSession(t.sessionId)
                            onClose()
                          }}
                          className="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-[#EEF2FF] hover:text-[#4D6BFE] dark:bg-slate-800 dark:text-slate-200"
                        >
                          <span>进入对话</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-xs text-slate-800 dark:text-slate-100">
                        {t.prompt}
                      </div>
                      {(t.result || t.error) && (
                        <div className="mt-1.5 line-clamp-3 rounded-xl bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-600 dark:bg-[#16171A] dark:text-slate-300">
                          {t.result || t.error}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
