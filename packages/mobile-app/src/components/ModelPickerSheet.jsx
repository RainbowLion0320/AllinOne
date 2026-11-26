import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_META } from '@allinone/shared'
import { Check, Loader2, Sparkles, X } from 'lucide-react'
import { EffortSignalIcon, VendorBadge, formatEffortLabel, getEffortMeta } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'

function ReasoningEffortSlider({ efforts = [], value = '', lang = 'zh', bi, onChange }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const lastStepIdxRef = useRef(-1)
  const [dragRatio, setDragRatio] = useState(null)

  const count = efforts.length
  const maxIdx = Math.max(0, count - 1)
  const rawIdx = efforts.indexOf(value)
  const activeIdx = rawIdx >= 0 ? rawIdx : 0
  const activeEffort = efforts[activeIdx] || ''
  const meta = getEffortMeta(activeEffort, lang)
  const isMuted = meta.level === 0

  const snappedRatio = maxIdx > 0 ? activeIdx / maxIdx : 1
  const displayRatio = dragRatio !== null ? dragRatio : snappedRatio
  const pct = Math.max(0, Math.min(100, displayRatio * 100))

  const updateFromClientX = useCallback(
    (clientX, { snapOnly = false } = {}) => {
      const el = trackRef.current
      if (!el || count === 0) return
      const rect = el.getBoundingClientRect()
      const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0
      const nextIdx = maxIdx > 0 ? Math.round(ratio * maxIdx) : 0
      if (!snapOnly) {
        setDragRatio(ratio)
      }
      if (nextIdx !== lastStepIdxRef.current) {
        lastStepIdxRef.current = nextIdx
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(6)
          }
        } catch {}
      }
      const nextEffort = efforts[nextIdx]
      if (nextEffort && nextEffort !== value) {
        onChange?.(nextEffort)
      }
    },
    [count, maxIdx, efforts, value, onChange],
  )

  const handlePointerDown = (e) => {
    if (count === 0) return
    e.preventDefault()
    draggingRef.current = true
    lastStepIdxRef.current = activeIdx
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {}
    updateFromClientX(e.clientX)
  }

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return
    e.preventDefault()
    updateFromClientX(e.clientX)
  }

  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {}
    setDragRatio(null)
  }

  const handleKeyDown = (e) => {
    if (maxIdx <= 0) return
    let nextIdx = activeIdx
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      nextIdx = Math.min(maxIdx, activeIdx + 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      nextIdx = Math.max(0, activeIdx - 1)
    } else if (e.key === 'Home') {
      nextIdx = 0
    } else if (e.key === 'End') {
      nextIdx = maxIdx
    } else {
      return
    }
    e.preventDefault()
    if (nextIdx !== activeIdx && efforts[nextIdx]) {
      onChange?.(efforts[nextIdx])
    }
  }

  if (count === 0) return null

  const fillBackground = isMuted
    ? '#94A3B8'
    : `linear-gradient(90deg, #38BDF8 0%, #4D6BFE 55%, ${meta.color} 100%)`

  return (
    <div className="mb-3 rounded-2xl border border-slate-200/80 bg-white/95 px-3.5 pt-3 pb-2.5 shadow-2xs dark:border-slate-700/75 dark:bg-[#222530]/95">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
          <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
          <span>{bi('推理强度', 'Reasoning Effort')}</span>
        </div>
        <div
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${meta.pillClass}`}
        >
          <EffortSignalIcon effort={activeEffort} className="shrink-0" />
          <span>{formatEffortLabel(activeEffort, lang)}</span>
          <span className="opacity-45">·</span>
          <span className="font-medium opacity-85">{meta.hint}</span>
        </div>
      </div>

      {/* Interactive Slider Track */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={bi('推理强度', 'Reasoning Effort')}
        aria-valuemin={0}
        aria-valuemax={maxIdx}
        aria-valuenow={activeIdx}
        aria-valuetext={formatEffortLabel(activeEffort, lang)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className="group relative mx-2.5 cursor-pointer py-3 touch-none select-none outline-none"
      >
        <div ref={trackRef} className="relative h-1.5 w-full rounded-full bg-slate-200/90 dark:bg-slate-700/85">
          {/* Active gradient fill */}
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${
              dragRatio !== null ? '' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{
              width: `${pct}%`,
              background: fillBackground,
            }}
          />

          {/* Discrete detent dots */}
          {efforts.map((eff, idx) => {
            const stopPct = maxIdx > 0 ? (idx / maxIdx) * 100 : 100
            const passed = idx <= activeIdx
            const isCurrent = idx === activeIdx
            return (
              <span
                key={eff}
                className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150 ${
                  isCurrent
                    ? 'h-2.5 w-2.5 opacity-0'
                    : passed
                      ? 'h-2.5 w-2.5 border-2 border-white bg-white/90 shadow-2xs dark:border-[#222530] dark:bg-white/95'
                      : 'h-2 w-2 border-[1.5px] border-slate-300 bg-white dark:border-slate-500 dark:bg-[#222530]'
                }`}
                style={{ left: `${stopPct}%` }}
              />
            )
          })}

          {/* Tactile sliding thumb */}
          <span
            className={`pointer-events-none absolute top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[2.5px] bg-white shadow-[0_2px_8px_rgba(15,23,42,0.22)] dark:bg-[#F8FAFC] ${
              dragRatio !== null
                ? 'scale-115'
                : 'transition-[left,transform,border-color] duration-150 ease-out group-hover:scale-105 group-focus-visible:ring-4 group-focus-visible:ring-[#4D6BFE]/25'
            }`}
            style={{
              left: `${pct}%`,
              borderColor: meta.color,
              boxShadow:
                dragRatio !== null
                  ? `0 0 0 5px ${meta.color}26, 0 3px 10px rgba(15,23,42,0.28)`
                  : '0 2px 8px rgba(15,23,42,0.22)',
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full transition-colors"
              style={{ backgroundColor: meta.color }}
            />
          </span>
        </div>
      </div>

      {/* Edge-aligned clickable stop labels */}
      <div className="relative mx-2.5 mt-0.5 h-5">
        {efforts.map((eff, idx) => {
          const stopPct = maxIdx > 0 ? (idx / maxIdx) * 100 : 50
          const active = idx === activeIdx
          const alignStyle =
            maxIdx === 0
              ? { left: '50%', transform: 'translateX(-50%)' }
              : idx === 0
                ? { left: '0%', transform: 'translateX(0%)' }
                : idx === maxIdx
                  ? { left: '100%', transform: 'translateX(-100%)' }
                  : { left: `${stopPct}%`, transform: 'translateX(-50%)' }
          return (
            <button
              key={eff}
              type="button"
              onClick={() => onChange?.(eff)}
              style={{
                ...alignStyle,
                ...(active ? { color: meta.color } : {}),
              }}
              className={`absolute top-0 whitespace-nowrap rounded px-0.5 py-0.5 text-[11px] leading-none transition active:scale-95 ${
                active
                  ? 'font-bold'
                  : 'font-medium text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
              }`}
            >
              {formatEffortLabel(eff, lang)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ModelPickerSheet({
  open,
  app,
  catalog,
  loading = false,
  value = {},
  onClose,
  onApply,
}) {
  const { lang, bi, t } = useI18n()
  const appMeta = APP_META[app] || APP_META.dsh
  const models = catalog?.models || []
  const providers = catalog?.providers || []

  const [selectedProvider, setSelectedProvider] = useState('all')
  const [pickedModel, setPickedModel] = useState('')
  const [pickedProvider, setPickedProvider] = useState('')
  const [pickedEffort, setPickedEffort] = useState('')
  const userPickedRef = useRef(false)
  const initializedKeyRef = useRef('')

  useEffect(() => {
    if (!open) {
      userPickedRef.current = false
      initializedKeyRef.current = ''
      return
    }
    const initKey = `${app}|${value?.model || ''}|${value?.provider || ''}|${value?.reasoningEffort || ''}`
    const isFreshInit = initializedKeyRef.current !== initKey
    if (!isFreshInit && userPickedRef.current) return

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
    if (isFreshInit) {
      initializedKeyRef.current = initKey
      userPickedRef.current = false
      setSelectedProvider('all')
    }
  }, [open, app, catalog, value?.model, value?.provider, value?.reasoningEffort])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const activeModelObj = useMemo(() => {
    return (
      models.find(
        (m) => m.id === pickedModel && (!pickedProvider || !m.provider || m.provider === pickedProvider),
      ) || models.find((m) => m.id === pickedModel) || null
    )
  }, [models, pickedModel, pickedProvider])

  const filteredModels = useMemo(() => {
    if (selectedProvider === 'all') return models
    return models.filter((m) => m.provider === selectedProvider)
  }, [models, selectedProvider])

  if (!open) return null

  const handleSelectModel = (m) => {
    userPickedRef.current = true
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

        {/* Provider filter (when multiple providers exist) */}
        {providers.length > 1 && (
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800/80">
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
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelectModel(m)}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                      isSelected
                        ? 'border-[#4D6BFE] bg-[#F1F5FF] dark:border-[#4D6BFE] dark:bg-[#252E4D]'
                        : 'border-transparent hover:bg-slate-100/70 dark:hover:bg-[#242733]'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                        {m.name || m.id}
                      </span>
                      {isDefault && (
                        <span className="shrink-0 rounded-md bg-[#4D6BFE]/12 px-1.5 py-0.5 text-[9.5px] font-semibold text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]">
                          {t('common.default')}
                        </span>
                      )}
                      {providers.length > 1 && selectedProvider === 'all' && m.providerName && (
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {m.providerName}
                        </span>
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

        {/* Sticky Reasoning Effort slider (only when supported) + Confirm */}
        <div className="pb-safe border-t border-slate-100 bg-slate-50/80 px-4 pt-3 pb-4 dark:border-slate-800 dark:bg-[#171920]">
          {activeEfforts.length > 0 && (
            <ReasoningEffortSlider
              efforts={activeEfforts}
              value={pickedEffort}
              lang={lang}
              bi={bi}
              onChange={(eff) => {
                userPickedRef.current = true
                setPickedEffort(eff)
              }}
            />
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
