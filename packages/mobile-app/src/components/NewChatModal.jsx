import React, { useEffect, useMemo, useState } from 'react'
import { APP_LIST, APP_META } from '@allinone/shared'
import { ChevronRight, FolderOpen, Loader2, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { VendorIcon, formatEffortLabel } from './VendorIcon.jsx'
import { ModelPickerSheet } from './ModelPickerSheet.jsx'

export function NewChatModal({
  open,
  initialCwd = '',
  onClose,
  workspaces,
  appsStatus,
  modelsCatalog = {},
  onCreate,
}) {
  const [app, setApp] = useState('dsh')
  const [cwd, setCwd] = useState(initialCwd || '')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)

  const appCatalog = modelsCatalog?.[app] || null
  const appModels = appCatalog?.models || []

  useEffect(() => {
    if (!open) return
    if (initialCwd) {
      setCwd(initialCwd)
    } else if (!cwd && workspaces?.[0]?.path) {
      setCwd(workspaces[0].path)
    }
    const curWritable = appsStatus.find((a) => a.app === app && a.writable)
    if (!curWritable) {
      const firstWritable = ['dsh', 'codex', 'claude', 'antigravity'].find((id) =>
        appsStatus.find((a) => a.app === id && a.writable),
      )
      if (firstWritable) setApp(firstWritable)
    }
  }, [open, initialCwd, workspaces, appsStatus])

  // Sync default model/provider/effort whenever app switches or catalog arrives
  useEffect(() => {
    if (!open) return
    const defModel = appCatalog?.defaultModel || appModels[0]?.id || ''
    const defProvider = appCatalog?.defaultProvider || ''
    const matched =
      appModels.find((m) => m.id === defModel && (!defProvider || !m.provider || m.provider === defProvider)) ||
      appModels.find((m) => m.id === defModel) ||
      appModels[0]
    setModel(matched?.id || defModel)
    setProvider(matched?.provider || defProvider)
    const allowed = matched?.efforts || []
    const defEffort = appCatalog?.defaultEffort || matched?.defaultEffort || ''
    setReasoningEffort(allowed.length === 0 ? '' : allowed.includes(defEffort) ? defEffort : allowed[0] || '')
  }, [open, app, appCatalog])

  const activeModelObj = useMemo(() => {
    return (
      appModels.find((m) => m.id === model && (!provider || !m.provider || m.provider === provider)) ||
      appModels.find((m) => m.id === model) ||
      null
    )
  }, [appModels, model, provider])

  if (!open) return null

  const activeEfforts = activeModelObj?.efforts || []
  const selectedAppMeta = APP_META[app] || APP_META.dsh
  const selectedAppStatus = appsStatus.find((a) => a.app === app)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      await onCreate({
        app,
        cwd: cwd.trim(),
        title: title.trim(),
        model: model || undefined,
        provider: provider || undefined,
        reasoningEffort: activeEfforts.length > 0 ? reasoningEffort || undefined : undefined,
      })
      setTitle('')
      onClose()
    } catch (err) {
      alert(String(err?.message || err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="pb-safe max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl dark:bg-[#1E2028]"
        >
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">开启新对话</h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {/* Compact 1-row 4-column icon-only app selector */}
            <div>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-slate-500 dark:text-slate-400">
                  选择应用
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                  <span>{selectedAppMeta.shortName}</span>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span
                    className={
                      selectedAppStatus?.writable
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : selectedAppStatus?.available
                          ? 'text-amber-500'
                          : 'text-slate-400'
                    }
                  >
                    {selectedAppStatus?.writable ? '可读写' : selectedAppStatus?.available ? '仅只读' : '未就绪'}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {APP_LIST.map((appId) => {
                  const meta = APP_META[appId]
                  const status = appsStatus.find((a) => a.app === appId)
                  const selected = app === appId
                  return (
                    <button
                      key={appId}
                      type="button"
                      title={`${meta.name} (${status?.writable ? '可读写' : status?.available ? '仅只读' : '未就绪'})`}
                      aria-label={meta.name}
                      onClick={() => setApp(appId)}
                      className={`relative flex h-12 items-center justify-center rounded-2xl border transition active:scale-95 ${
                        selected
                          ? 'shadow-xs'
                          : 'border-slate-200/80 bg-slate-50/80 hover:bg-slate-100 dark:border-slate-700/80 dark:bg-[#16171A] dark:hover:bg-[#232630]'
                      }`}
                      style={
                        selected
                          ? {
                              backgroundColor: `${meta.color}20`,
                              borderColor: `${meta.color}99`,
                            }
                          : undefined
                      }
                    >
                      <VendorIcon app={appId} size={22} />
                      <span
                        className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${
                          status?.writable
                            ? 'bg-emerald-500'
                            : status?.available
                              ? 'bg-amber-400'
                              : 'bg-slate-300 dark:bg-slate-600'
                        }`}
                      />
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Model & Reasoning Effort Selector (per-app native rules) */}
            <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700/80 dark:bg-[#16171A]">
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  模型与推理强度
                </span>
                <span className="text-[10.5px] text-slate-400">
                  {appModels.length > 0 ? `共 ${appModels.length} 个可选` : '使用默认配置'}
                </span>
              </div>

              <button
                type="button"
                disabled={appModels.length === 0}
                onClick={() => setPickerOpen(true)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white px-3 py-2 text-left transition hover:border-[#4D6BFE]/50 disabled:opacity-60 dark:border-slate-700 dark:bg-[#20232C]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                    {activeModelObj?.name || model || '默认模型'}
                  </div>
                  {activeModelObj?.providerName && (
                    <div className="text-[10.5px] text-slate-400">
                      通道：{activeModelObj.providerName}
                    </div>
                  )}
                </div>
                <div className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-[#4D6BFE]">
                  <span>切换</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </div>
              </button>

              {activeEfforts.length > 0 ? (
                <div className="mt-2.5">
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                    <Sparkles className="h-3 w-3 text-[#4D6BFE]" />
                    <span>推理强度</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {activeEfforts.map((eff) => {
                      const active = reasoningEffort === eff
                      return (
                        <button
                          key={eff}
                          type="button"
                          onClick={() => setReasoningEffort(eff)}
                          className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition active:scale-95 ${
                            active
                              ? 'bg-[#4D6BFE] text-white shadow-2xs'
                              : 'border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-[#20232C] dark:text-slate-300'
                          }`}
                        >
                          {formatEffortLabel(eff)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                appModels.length > 0 && (
                  <div className="mt-2 text-[11px] text-slate-400">
                    当前模型不支持单独调节推理强度
                  </div>
                )
              )}
            </div>

            {/* Workspace picker */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                <FolderOpen className="h-3.5 w-3.5 text-[#4D6BFE]" />
                电脑端工作目录
              </label>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="留空则使用电脑默认目录"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-slate-100"
              />
              {workspaces?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {workspaces.slice(0, 6).map((w) => (
                    <button
                      key={w.id || w.path}
                      type="button"
                      onClick={() => setCwd(w.path)}
                      className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                    >
                      {w.title || w.name || w.path}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Optional title */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500 dark:text-slate-400">
                对话名称（可选）
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="留空则自动命名"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-slate-100"
              />
            </div>

            <button
              type="submit"
              disabled={creating}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 active:scale-[0.98] disabled:opacity-60"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{creating ? '正在创建...' : `在 ${APP_META[app]?.shortName} 中开启对话`}</span>
            </button>
          </form>
        </div>
      </div>

      <ModelPickerSheet
        open={pickerOpen}
        app={app}
        catalog={appCatalog}
        value={{ model, provider, reasoningEffort }}
        mode="newchat"
        onClose={() => setPickerOpen(false)}
        onApply={(next) => {
          setModel(next.model || '')
          setProvider(next.provider || '')
          setReasoningEffort(next.reasoningEffort || '')
        }}
      />
    </>
  )
}
