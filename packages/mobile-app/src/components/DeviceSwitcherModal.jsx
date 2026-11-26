import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  User,
  X,
} from 'lucide-react'
import {
  formatPlatformLabel,
  getDeviceDisplayName,
} from '../lib/deviceStore.js'
import { probeDeviceStatus } from '../lib/wsClient.js'
import { useI18n } from '../lib/i18n.jsx'
import { translate } from '../lib/i18n.js'
import { copyTextToClipboard, formatSafeSetupCmd } from '../lib/clientHelpers.js'

function StatusPill({ status, onlineCount = 0 }) {
  const { bi, t } = useI18n()
  if (status === 'probing' || status === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-600 dark:bg-amber-950/50 dark:text-amber-300">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>{status === 'connecting' ? t('common.connecting') : bi('检测中', 'Checking')}</span>
      </span>
    )
  }
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>{onlineCount > 1 ? bi(`${onlineCount} 在线`, `${onlineCount} online`) : t('common.online')}</span>
      </span>
    )
  }
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        <span>{t('common.expired')}</span>
      </span>
    )
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        <span>{t('common.error')}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      <span>{t('common.offline')}</span>
    </span>
  )
}

function formatRelativeSeen(ts, lang) {
  if (!ts) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return translate(lang, 'time.justNow')
  if (diffSec < 3600) return translate(lang, 'time.minsAgo', { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return translate(lang, 'time.hoursAgo', { n: Math.floor(diffSec / 3600) })
  return translate(lang, 'time.daysAgo', { n: Math.floor(diffSec / 86400) })
}

export function DeviceSwitcherModal({
  open,
  onClose,
  devices = [],
  activeDeviceId = null,
  activeBridgeId = '',
  activeConnState = 'disconnected',
  accountDevices = [],
  onSelectDevice,
  onAddDevice,
  onRemoveDevice,
  onSyncDeviceMeta,
  onRenameAccountDevice,
  onRemoveAccountDevice,
  onRefreshAccountDevices,
}) {
  const { lang, bi, t } = useI18n()
  const [probes, setProbes] = useState({})
  const [probingAll, setProbingAll] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [copiedCmd, setCopiedCmd] = useState('')
  const [showCliBind, setShowCliBind] = useState(false)
  const copiedCmdTimerRef = useRef(null)

  const devicesRef = useRef(devices)
  devicesRef.current = devices

  const activeEntry = devices.find((d) => d.id === activeDeviceId) || null
  const otherEntries = devices.filter((d) => d.id !== activeDeviceId)

  const runProbeAll = useCallback(async (list) => {
    const targets = (list || []).filter((d) => d.id !== activeDeviceId)
    setProbingAll(true)
    await onRefreshAccountDevices?.().catch(() => {})
    if (targets.length === 0) {
      setProbingAll(false)
      return
    }
    setProbes((prev) => {
      const next = { ...prev }
      for (const d of targets) {
        next[d.id] = { ...(next[d.id] || {}), status: 'probing' }
      }
      return next
    })
    try {
      await Promise.all(
        targets.map(async (d) => {
          const result = await probeDeviceStatus(d, 5000)
          setProbes((prev) => ({ ...prev, [d.id]: result }))
          const firstOnline = result.bridges.find((b) => b.online) || result.bridges[0] || null
          if (firstOnline || result.label || result.username || result.email || result.role || result.tier) {
            onSyncDeviceMeta?.(d.id, {
              ...(result.label ? { label: result.label } : {}),
              ...(result.username ? { username: result.username } : {}),
              ...(result.email !== undefined ? { email: result.email } : {}),
              ...(result.role ? { role: result.role } : {}),
              ...(result.tier ? { tier: result.tier } : {}),
              ...(firstOnline?.hostname ? { lastHostname: firstOnline.hostname } : {}),
              ...(firstOnline?.platform ? { lastPlatform: firstOnline.platform } : {}),
            })
          }
        }),
      )
    } finally {
      setProbingAll(false)
    }
  }, [activeDeviceId, onRefreshAccountDevices, onSyncDeviceMeta])

  useEffect(() => {
    return () => {
      if (copiedCmdTimerRef.current) clearTimeout(copiedCmdTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setConfirmDeleteId(null)
      setShowCliBind(false)
      return
    }
    void runProbeAll(devicesRef.current)
  }, [open, devices.length, runProbeAll])

  if (!open) return null

  const copyBindCmd = async (kind, cmd) => {
    await copyTextToClipboard(cmd)
    setCopiedCmd(kind)
    if (copiedCmdTimerRef.current) clearTimeout(copiedCmdTimerRef.current)
    copiedCmdTimerRef.current = setTimeout(() => {
      copiedCmdTimerRef.current = null
      setCopiedCmd((cur) => (cur === kind ? '' : cur))
    }, 1800)
  }

  const startRename = (id, currentName) => {
    setConfirmDeleteId(null)
    setEditingId(id)
    setEditDraft(currentName || '')
  }

  const commitRename = async (id) => {
    const clean = editDraft.trim()
    setEditingId(null)
    setEditDraft('')
    if (!clean) return
    await onRenameAccountDevice?.(id, clean)
  }

  const onlineAcctCount = accountDevices.filter((pc) => pc.online).length
  const acctServerBase = String(activeEntry?.baseUrl || '').replace(/\/+$/, '')
  const activeUsername = activeEntry
    ? `@${activeEntry.username || activeEntry.label?.replace(/^@/, '') || activeEntry.roomId}`
    : ''
  const unixBindCmd = formatSafeSetupCmd(acctServerBase, 'unix')
  const winBindCmd = formatSafeSetupCmd(acctServerBase, 'win')
  const bindCmdRows = unixBindCmd && winBindCmd
    ? [
        { key: 'unix', label: 'Mac/Linux', cmd: unixBindCmd },
        { key: 'win', label: 'Windows', cmd: winBindCmd },
      ]
    : []

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe flex max-h-[85vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pt-4.5 pb-3.5 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8.5 w-8.5 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Laptop className="h-4 w-4" />
            </div>
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">
              {bi('我的电脑', 'My Computers')}
              <span className="ml-1.5 text-xs font-medium text-slate-400">
                ({accountDevices.length})
              </span>
            </h2>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => runProbeAll(devices)}
              aria-label={bi('刷新设备在线状态', 'Refresh online status')}
              title={bi('刷新在线状态', 'Refresh status')}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <RefreshCw className={`h-4 w-4 ${probingAll ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={bi('关闭电脑列表', 'Close computers list')}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
          {/* Active Account Computers */}
          {activeEntry && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-1 text-[11px] font-semibold text-slate-400">
                <span className="truncate">{activeUsername}</span>
                {accountDevices.length > 0 && (
                  <span className="shrink-0">
                    {bi(`${onlineAcctCount}/${accountDevices.length} 在线`, `${onlineAcctCount}/${accountDevices.length} online`)}
                  </span>
                )}
              </div>

              {activeConnState === 'unauthorized' && (
                <div className="flex items-center justify-between gap-2 rounded-2xl border border-rose-200/80 bg-rose-50 px-3 py-2 text-[11.5px] text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
                  <span>{bi('当前账号登录已失效，请重新登录', 'Session expired. Please sign in again.')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onAddDevice?.(activeEntry.baseUrl)
                    }}
                    className="shrink-0 rounded-xl bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                  >
                    {bi('重新登录', 'Sign In')}
                  </button>
                </div>
              )}

              {accountDevices.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center dark:border-slate-700/80 dark:bg-[#151820]">
                  <Terminal className="mx-auto mb-2 h-6 w-6 text-[#4D6BFE]" />
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {bi('尚未绑定电脑', 'No Computers Linked')}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {lang === 'en' ? (
                      <>
                        Run the command below on your computer and sign in as <strong>{activeUsername}</strong>
                      </>
                    ) : (
                      <>
                        在电脑终端运行下方命令并登录 <strong>{activeUsername}</strong>
                      </>
                    )}
                  </p>
                  <div className="mt-2.5 space-y-1.5 text-left">
                    {bindCmdRows.map((row) => (
                      <div key={row.key} className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-2.5 py-2 font-mono text-[10px] text-slate-100">
                        <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-sans text-[9.5px] text-slate-300">{row.label}</span>
                        <span className="flex-1 truncate">{row.cmd}</span>
                        <button
                          type="button"
                          onClick={() => copyBindCmd(row.key, row.cmd)}
                          className="shrink-0 rounded-lg bg-white/10 p-1 text-white hover:bg-white/20"
                        >
                          {copiedCmd === row.key ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                accountDevices.map((pc) => {
                  const isSelected = pc.bridgeId === activeBridgeId
                  const editKey = `pc:${pc.deviceId}`
                  const isEditing = editingId === editKey
                  const isConfirmingUnbind = confirmDeleteId === editKey
                  const platformLabel = formatPlatformLabel(pc.platform)
                  return (
                    <div
                      key={pc.deviceId}
                      className={`rounded-2xl border p-3 transition ${
                        isSelected
                          ? 'border-[#4D6BFE]/60 bg-[#F4F7FF] shadow-xs dark:border-[#4D6BFE]/50 dark:bg-[#20273B]'
                          : 'border-slate-200/80 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-[#171920] dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <button
                          type="button"
                          disabled={isEditing}
                          onClick={() => {
                            if (isEditing) return
                            onSelectDevice?.(activeEntry.id, pc.bridgeId)
                            onClose()
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                        >
                          <div
                            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                              isSelected
                                ? 'bg-[#4D6BFE] text-white'
                                : pc.online
                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : 'bg-slate-100 text-slate-400 dark:bg-slate-800'
                            }`}
                          >
                            <Monitor className="h-4.5 w-4.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                                {pc.label || pc.hostname || pc.bridgeId}
                              </span>
                              <StatusPill status={pc.online ? 'online' : 'offline'} />
                            </div>
                            {(platformLabel || (!pc.online && pc.lastSeenAt > 0)) && (
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
                                {platformLabel && <span>{platformLabel}</span>}
                                {!pc.online && pc.lastSeenAt > 0 && (
                                  <>
                                    {platformLabel && <span>·</span>}
                                    <span>{formatRelativeSeen(pc.lastSeenAt, lang)}</span>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </button>

                        {!isEditing && !isConfirmingUnbind && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => startRename(editKey, pc.label || pc.hostname)}
                              title={bi('重命名电脑', 'Rename computer')}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/70 dark:hover:text-slate-200"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null)
                                setConfirmDeleteId(editKey)
                              }}
                              title={bi('解绑此电脑', 'Unlink computer')}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      {isEditing && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault()
                            void commitRename(pc.deviceId)
                          }}
                          className="mt-2.5 flex items-center gap-1.5"
                        >
                          <input
                            type="text"
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            autoFocus
                            maxLength={40}
                            placeholder={bi('输入备注名', 'Enter nickname')}
                            className="min-w-0 flex-1 rounded-xl border border-[#4D6BFE] bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none dark:bg-[#14161D] dark:text-white"
                          />
                          <button
                            type="submit"
                            className="inline-flex h-7.5 items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 text-xs font-semibold text-white"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>{t('common.save')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingId(null); setEditDraft('') }}
                            className="rounded-xl p-1.5 text-slate-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      )}

                      {isConfirmingUnbind && (
                        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                          <span>{bi('解绑此电脑？', 'Unlink this computer?')}</span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                            >
                              {t('common.cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null)
                                void onRemoveAccountDevice?.(pc.deviceId, pc.bridgeId)
                              }}
                              className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                            >
                              {bi('确认解绑', 'Unlink')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}

              {accountDevices.length > 0 && bindCmdRows.length > 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/50 dark:border-slate-800 dark:bg-[#151820]/70">
                  <button
                    type="button"
                    onClick={() => setShowCliBind((v) => !v)}
                    aria-expanded={showCliBind}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[11.5px] font-medium text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
                      <span>{bi('命令行绑定其他电脑', 'Link another PC via CLI')}</span>
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-slate-400 transition-transform ${showCliBind ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {showCliBind && (
                    <div className="space-y-1.5 px-3 pb-3">
                      <p className="text-[10.5px] text-slate-400">
                        {lang === 'en' ? (
                          <>
                            Run on another PC / Linux server and sign in as <strong>{activeUsername}</strong>
                          </>
                        ) : (
                          <>
                            在另一台电脑或 Linux 服务器运行并登录 <strong>{activeUsername}</strong>
                          </>
                        )}
                      </p>
                      {bindCmdRows.map((row) => (
                        <div key={row.key} className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-2.5 py-2 font-mono text-[10px] text-slate-100">
                          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-sans text-[9.5px] text-slate-300">{row.label}</span>
                          <span className="flex-1 truncate">{row.cmd}</span>
                          <button
                            type="button"
                            onClick={() => copyBindCmd(row.key, row.cmd)}
                            className="shrink-0 rounded-lg bg-white/10 p-1 text-white hover:bg-white/20"
                          >
                            {copiedCmd === row.key ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Other saved accounts (shown only when multi-account) */}
          {otherEntries.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="px-1 text-[11px] font-semibold text-slate-400">
                {bi('其他账号', 'Other Accounts')}
              </div>
              {otherEntries.map((device) => {
                const probe = probes[device.id]
                const bridges = probe?.bridges || []
                const onlineBridges = bridges.filter((b) => b.online)
                const primaryBridge =
                  onlineBridges.find((b) => b.bridgeId === device.selectedBridgeId) ||
                  onlineBridges[0] ||
                  null

                const status = probe ? probe.status : 'probing'
                const displayName = getDeviceDisplayName(device, primaryBridge, lang)
                const platformLabel = formatPlatformLabel(primaryBridge?.platform || device.lastPlatform)
                const isConfirmingDelete = confirmDeleteId === device.id

                return (
                  <div
                    key={device.id}
                    className="rounded-2xl border border-slate-200/80 bg-white p-3 transition hover:border-slate-300 dark:border-slate-800 dark:bg-[#171920] dark:hover:border-slate-700"
                  >
                    <div className="flex items-start gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectDevice?.(device.id, primaryBridge?.bridgeId || device.selectedBridgeId || '')
                          onClose()
                        }}
                        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                      >
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                          <User className="h-4.5 w-4.5" />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                              {device.username ? `@${device.username}` : displayName}
                            </span>
                            <StatusPill status={status} onlineCount={onlineBridges.length} />
                          </div>

                          {platformLabel && (
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
                              <span>{platformLabel}</span>
                            </div>
                          )}
                        </div>
                      </button>

                      {!isConfirmingDelete && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null)
                              setConfirmDeleteId(device.id)
                            }}
                            title={t('common.remove')}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {isConfirmingDelete && (
                      <div className="mt-2.5 space-y-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                        <div className="flex items-center justify-between gap-2">
                          <span>{bi('移除此账号并清空本地缓存？', 'Remove account and clear local cache?')}</span>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null)
                              onRemoveDevice?.(device.id, { revokeAll: false })
                            }}
                            className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-600 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                          >
                            {bi('仅移除本机', 'This Device Only')}
                          </button>
                          {status !== 'expired' && (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null)
                                onRemoveDevice?.(device.id, { revokeAll: true })
                              }}
                              className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                            >
                              {bi('移除并吊销全部设备', 'Remove & Revoke All')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {status === 'expired' && !isConfirmingDelete && (
                      <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50/70 px-3 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/35 dark:text-rose-300">
                        <span>{bi('登录已过期，重新登录即可恢复', 'Session expired. Sign in again to reconnect.')}</span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose()
                            onAddDevice?.(device.baseUrl)
                          }}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1 font-semibold text-white"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>{bi('重新登录', 'Sign In')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer CTA */}
        <div className="border-t border-slate-100 px-4 pt-3 pb-3.5 dark:border-slate-800">
          <button
            type="button"
            onClick={() => {
              onClose()
              onAddDevice?.('')
            }}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" />
            <span>{bi('添加账号', 'Add Account')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
