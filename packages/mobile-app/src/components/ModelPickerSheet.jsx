import React, { useEffect, useMemo, useState } from 'react'
import { APP_META } from '@allinone/shared'
import { Check, Loader2, Search, Sparkles, X } from 'lucide-react'
import { VendorBadge, formatEffortLabel } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'

export function ModelPickerSheet({
  open,
  app,
  catalog,
  loading = false,
  value = {},
  mode = 'midchat', // 'midchat' | 'newchat'
  onClose,
  onApply,
}) {
  const { lang, bi, t } = useI18n()
  const appMeta = APP_META[app] || APP_META.dsh
  const models = catalog?.models || []
  const providers = catalog?.providers || []

  const [selectedProvider, setSelectedProvider] = useState('all')
  const [search, setSearch] = useState('')
  const [pickedModel, setPickedModel] = useState('')
  const [pickedProvider, setPickedProvider] = useState('')
  const [pickedEffort, setPickedEffort] = useState('')

  useEffect(() => {
    if (!open) return
    const initModel = value?.model || catalog?.defaultModel || models[0]?.id || ''
    const matched = models.find(
      (m) => m.id === initModel && (!value?.provider || !m.provider || m.provider === value.provider),
    ) || models.find((m) => m.id === initModel) || models[0]

    setPickedModel(matched?.id || initModel)
    setPickedProvider(value?.provider || matched?.provider || catalog?.defaultProvider || '')
    const allowed = matched?.efforts || []
    const initEffort = value?.reasoningEffort || matched?.defaultEffort || catalog?.defaultEffort || ''
    if (allowed.length === 0) {
      setPickedEffort('')
    } else if (allowed.includes(initEffort)) {
      setPickedEffort(initEffort)
    } else {
      setPickedEffort(matched?.defaultEffort || allowed[0] || '')
    }
    setSelectedProvider('all')
    setSearch('')
  }, [open, app, catalog, value?.model, value?.provider, value?.reasoningEffort])

  const activeModelObj = useMemo(() => {
    return (
      models.find(
        (m) => m.id === pickedModel && (!pickedProvider || !m.provider || m.provider === pickedProvider),
      ) || models.find((m) => m.id === pickedModel) || null
    )
  }, [models, pickedModel, pickedProvider])

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase()
    return models.filter((m) => {
      if (selectedProvider !== 'all' && m.provider !== selectedProvider) return false
      if (!q) return true
      return (
        String(m.name || '').toLowerCase().includes(q) ||
        String(m.id || '').toLowerCase().includes(q) ||
        String(m.providerName || '').toLowerCase().includes(q)
      )
    })
  }, [models, selectedProvider, search])

  if (!open) return null

  const handleSelectModel = (m) => {
    setPickedModel(m.id)
    setPickedProvider(m.provider || '')
    const allowed = m.efforts || []
    if (allowed.length === 0) {
      setPickedEffort('')
    } else if (!allowed.includes(pickedEffort)) {
      setPickedEffort(m.defaultEffort || allowed[0] || '')
    }
  }

  const handleConfirm = () => {
    onApply({
      model: pickedModel,
      provider: pickedProvider || undefined,
      reasoningEffort: activeModelObj?.efforts?.length ? pickedEffort : '',
    })
    onClose()
  }

  const activeEfforts = activeModelObj?.efforts || []

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[84vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1C1E26]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pt-4 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <VendorBadge app={app} size="sm" />
            <h3 className="text-[15px] font-bold text-slate-900 dark:text-white">
              {bi(`${appMeta.shortName} 模型`, `${appMeta.shortName} Models`)}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Provider filter & Search (when applicable) */}
        {(providers.length > 1 || models.length > 8) && (
          <div className="space-y-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800/80">
            {providers.length > 1 && (
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setSelectedProvider('all')}
                  className={`shrink-0 rounded-full px-3 py-1 text-[11.5px] font-medium transition ${
                    selectedProvider === 'all'
                      ? 'bg-[#4D6BFE] text-white'
                      : 'bg-slate-100 text-slate-600 dark:bg-[#262934] dark:text-slate-300'
                  }`}
                >
                  {t('common.all')} ({models.length})
                </button>
                {providers.map((p) => {
                  const cnt = models.filter((m) => m.provider === p.id).length
                  const active = selectedProvider === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedProvider(p.id)}
                      className={`shrink-0 rounded-full px-3 py-1 text-[11.5px] font-medium transition ${
                        active
                          ? 'bg-[#4D6BFE] text-white'
                          : 'bg-slate-100 text-slate-600 dark:bg-[#262934] dark:text-slate-300'
                      }`}
                    >
                      {p.name} ({cnt})
                    </button>
                  )
                })}
              </div>
            )}

            {models.length > 8 && (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={bi('搜索模型名称或 ID...', 'Search model name or ID...')}
                  className="w-full rounded-xl border border-slate-200/80 bg-slate-50 py-1.5 pr-3 pl-8 text-xs text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#14161C] dark:text-slate-100"
                />
              </div>
            )}
          </div>
        )}

        {/* Model list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading && models.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
              <span>{bi('加载模型中...', 'Loading models...')}</span>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs leading-relaxed text-slate-400">
              {models.length === 0 ? (catalog?.hint || bi('暂无可用模型', 'No models available')) : bi('没有匹配的模型', 'No matching models')}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredModels.map((m) => {
                const key = `${m.provider || ''}:${m.id}`
                const isSelected =
                  m.id === pickedModel && (!m.provider || !pickedProvider || m.provider === pickedProvider)
                const isDefault =
                  m.id === catalog?.defaultModel &&
                  (!catalog?.defaultProvider || !m.provider || m.provider === catalog.defaultProvider)
                const effortHint =
                  m.efforts?.length > 0
                    ? `${formatEffortLabel(m.efforts[0], lang)}~${formatEffortLabel(m.efforts[m.efforts.length - 1], lang)}`
                    : ''
                const hasSubMeta = Boolean(m.providerName || (m.name && m.name !== m.id) || effortHint)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelectModel(m)}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition ${
                      isSelected
                        ? 'border-[#4D6BFE] bg-[#F1F5FF] dark:border-[#4D6BFE] dark:bg-[#252E4D]'
                        : 'border-transparent hover:bg-slate-100/70 dark:hover:bg-[#242733]'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-slate-900 dark:text-white">
                          {m.name || m.id}
                        </span>
                        {isDefault && (
                          <span className="shrink-0 rounded-md bg-[#4D6BFE]/12 px-1.5 py-0.5 text-[9.5px] font-semibold text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]">
                            {t('common.default')}
                          </span>
                        )}
                      </div>
                      {hasSubMeta && (
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-slate-400">
                          {m.providerName && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.2 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                              {m.providerName}
                            </span>
                          )}
                          {m.name && m.name !== m.id && (
                            <span className="truncate font-mono">{m.id}</span>
                          )}
                          {effortHint && <span className="shrink-0">· {effortHint}</span>}
                        </div>
                      )}
                    </div>

                    <div
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ${
                        isSelected
                          ? 'border-[#4D6BFE] bg-[#4D6BFE] text-white'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Sticky Reasoning Effort selector (only when supported) + Confirm */}
        <div className="pb-safe border-t border-slate-100 bg-slate-50/80 px-4 pt-3 pb-4 dark:border-slate-800 dark:bg-[#171920]">
          {activeEfforts.length > 0 && (
            <div className="mb-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>{bi('推理强度', 'Reasoning Effort')}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {activeEfforts.map((eff) => {
                  const active = pickedEffort === eff
                  return (
                    <button
                      key={eff}
                      type="button"
                      onClick={() => setPickedEffort(eff)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition active:scale-95 ${
                        active
                          ? 'bg-[#4D6BFE] text-white shadow-xs shadow-[#4D6BFE]/30'
                          : 'border border-slate-200 bg-white text-slate-600 hover:border-[#4D6BFE]/40 dark:border-slate-700 dark:bg-[#222530] dark:text-slate-300'
                      }`}
                    >
                      {formatEffortLabel(eff, lang)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!pickedModel && models.length > 0}
            className="flex w-full items-center justify-center rounded-2xl bg-[#4D6BFE] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 active:scale-[0.98] disabled:opacity-50"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
