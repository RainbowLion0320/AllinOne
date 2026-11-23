import React, { useEffect, useMemo, useRef, useState } from 'react'
import { APP_LIST, APP_META } from '@allinone/shared'
import { ChevronRight, FolderOpen, Loader2, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { VendorIcon, formatEffortLabel } from './VendorIcon.jsx'
import { ModelPickerSheet } from './ModelPickerSheet.jsx'
import { useI18n } from '../lib/i18n.jsx'

export function NewChatModal({
  open,
  initialCwd = '',
  initialApp = '',
  onClose,
  workspaces,
  appsStatus,
  modelsCatalog = {},
  onCreate,
}) {
  const { lang, bi, t } = useI18n()
  const [app, setApp] = useState('dsh')
  const [cwd, setCwd] = useState(initialCwd || '')
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const prevOpenRef = useRef(false)

  const appCatalog = modelsCatalog?.[app] || null
  const appModels = appCatalog?.models || []

  useEffect(() => {
    const justOpened = open && !prevOpenRef.current
    prevOpenRef.current = open
    if (!open) return

    if (justOpened) {
      if (initialCwd) {
        setCwd(initialCwd)
      } else if (!cwd && workspaces?.[0]?.path) {
        setCwd(workspaces[0].path)
      }
      if (initialApp && APP_LIST.includes(initialApp)) {
        setApp(initialApp)
      } else {
        const curWritable = appsStatus.find((a) => a.app === app && a.writable)
        if (!curWritable) {
          const firstWritable = ['dsh', 'codex', 'claude', 'antigravity'].find((id) =>
            appsStatus.find((a) => a.app === id && a.writable),
          )
          if (firstWritable) setApp(firstWritable)
        }
      }
      return
    }

    if (!cwd && workspaces?.[0]?.path) {
      setCwd(workspaces[0].path)
    }
  }, [open, initialApp, initialCwd, workspaces, appsStatus, app, cwd])

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
            <h3 className="text-base font-bold text-slate-900 dark:text-white">{t('common.newChat')}</h3>
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
                  {bi('应用', 'Tool')}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                  <span>{selectedAppMeta.shortName}</span>
                  {!selectedAppStatus?.writable && (
                    <>
                      <span className="text-slate-300 dark:text-slate-600">·</span>
                      <span className={selectedAppStatus?.available ? 'text-amber-500' : 'text-slate-400'}>
                        {selectedAppStatus?.available ? bi('只读', 'Read-only') : bi('未就绪', 'Unavailable')}
                      </span>
                    </>
                  )}
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
                      title={`${meta.name} (${status?.writable ? bi('可读写', 'Read/Write') : status?.available ? bi('仅只读', 'Read-only') : bi('未就绪', 'Unavailable')})`}
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
              <div className="mb-2 flex items-center">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  {bi('模型', 'Model')}
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
                    {activeModelObj?.name || model || bi('默认模型', 'Default Model')}
                  </div>
                  {activeModelObj?.providerName && (
                    <div className="text-[10.5px] text-slate-400">
                      {activeModelObj.providerName}
                    </div>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
              </button>

              {activeEfforts.length > 0 && (
                <div className="mt-2.5">
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                    <Sparkles className="h-3 w-3 text-[#4D6BFE]" />
                    <span>{bi('推理强度', 'Reasoning Effort')}</span>
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
                          {formatEffortLabel(eff, lang)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Workspace picker */}
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                <FolderOpen className="h-3.5 w-3.5 text-[#4D6BFE]" />
                {bi('工作目录', 'Working Directory')}
              </label>
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={bi('默认目录', 'Default directory')}
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
                {bi('标题（可选）', 'Title (optional)')}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={bi('自动命名', 'Auto-generated')}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-slate-100"
              />
            </div>

            <button
              type="submit"
              disabled={creating}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 active:scale-[0.98] disabled:opacity-60"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{creating ? bi('创建中...', 'Creating...') : bi('开始对话', 'Start Chat')}</span>
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
