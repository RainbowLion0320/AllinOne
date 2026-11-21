import React, { useCallback, useEffect, useState } from 'react'
import {
  Check,
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import {
  formatPlatformLabel,
  formatServerHost,
  getDeviceDisplayName,
} from '../lib/deviceStore.js'
import { probeDeviceStatus } from '../lib/wsClient.js'

function StatusPill({ status, onlineCount = 0 }) {
  if (status === 'probing' || status === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-600 dark:bg-amber-950/50 dark:text-amber-300">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>{status === 'connecting' ? '连接中' : '检测中'}</span>
      </span>
    )
  }
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>{onlineCount > 1 ? `${onlineCount} 台在线` : '在线'}</span>
      </span>
    )
  }
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        <span>凭证已过期</span>
      </span>
    )
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        <span>连接异常</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      <span>电脑离线</span>
    </span>
  )
}

export function DeviceSwitcherModal({
  open,
  onClose,
  devices = [],
  activeDeviceId = null,
  activeBridgeId = '',
  activeConnState = 'disconnected',
  activeBridges = [],
  onSelectDevice,
  onAddDevice,
  onRenameDevice,
  onRemoveDevice,
  onSyncDeviceMeta,
}) {
  const [probes, setProbes] = useState({})
  const [probingAll, setProbingAll] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const runProbeAll = useCallback(async (list) => {
    const targets = (list || []).filter((d) => d.id !== activeDeviceId)
    if (targets.length === 0) return
    setProbingAll(true)
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
          if (firstOnline || result.label) {
            onSyncDeviceMeta?.(d.id, {
              ...(result.label ? { label: result.label } : {}),
              ...(firstOnline?.hostname ? { lastHostname: firstOnline.hostname } : {}),
              ...(firstOnline?.platform ? { lastPlatform: firstOnline.platform } : {}),
            })
          }
        }),
      )
    } finally {
      setProbingAll(false)
    }
  }, [activeDeviceId, onSyncDeviceMeta])

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setConfirmDeleteId(null)
      return
    }
    void runProbeAll(devices)
  }, [open, devices.length, runProbeAll])

  if (!open) return null

  const startRename = (device, displayName) => {
    setConfirmDeleteId(null)
    setEditingId(device.id)
    setEditDraft(device.customName || displayName || '')
  }

  const commitRename = (deviceId) => {
    onRenameDevice?.(deviceId, editDraft)
    setEditingId(null)
    setEditDraft('')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pt-5 pb-3.5 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Laptop className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">
                我的电脑
                <span className="ml-1.5 text-xs font-medium text-slate-400">
                  ({devices.length})
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">一键切换远程控制的电脑</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {devices.length > 1 && (
              <button
                type="button"
                onClick={() => runProbeAll(devices)}
                aria-label="刷新设备在线状态"
                title="刷新在线状态"
                className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <RefreshCw className={`h-4 w-4 ${probingAll ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭电脑列表"
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {/* Device List */}
        <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3.5">
          {devices.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              尚未配对任何电脑，点击下方按钮添加你的第一台电脑
            </div>
          ) : (
            devices.map((device) => {
              const isActive = device.id === activeDeviceId
              const probe = probes[device.id]
              const bridges = isActive ? activeBridges : probe?.bridges || []
              const onlineBridges = bridges.filter((b) => b.online)
              const primaryBridge =
                (isActive
                  ? onlineBridges.find((b) => b.bridgeId === activeBridgeId)
                  : onlineBridges.find((b) => b.bridgeId === device.selectedBridgeId)) ||
                onlineBridges[0] ||
                null

              let status = 'offline'
              if (isActive) {
                if (activeConnState === 'unauthorized') status = 'expired'
                else if (activeConnState === 'connecting') status = 'connecting'
                else if (activeConnState === 'connected') status = onlineBridges.length > 0 ? 'online' : 'offline'
                else status = 'unreachable'
              } else if (probe) {
                status = probe.status
              } else {
                status = 'probing'
              }

              const displayName = getDeviceDisplayName(device, primaryBridge, 1)
              const platformLabel = formatPlatformLabel(primaryBridge?.platform || device.lastPlatform)
              const serverHost = formatServerHost(device.baseUrl)
              const isEditing = editingId === device.id
              const isConfirmingDelete = confirmDeleteId === device.id

              return (
                <div
                  key={device.id}
                  className={`rounded-2xl border p-3 transition ${
                    isActive
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
                        onSelectDevice?.(device.id, primaryBridge?.bridgeId || device.selectedBridgeId || '')
                        onClose()
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <div
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          isActive
                            ? 'bg-[#4D6BFE] text-white'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'
                        }`}
                      >
                        <Monitor className="h-4.5 w-4.5" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                            {displayName}
                          </span>
                          {isActive && (
                            <span className="rounded-md bg-[#4D6BFE]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]">
                              当前
                            </span>
                          )}
                          <StatusPill status={status} onlineCount={onlineBridges.length} />
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-400">
                          {device.customName && (primaryBridge?.hostname || device.lastHostname) && (
                            <span className="truncate max-w-[120px]">
                              {primaryBridge?.hostname || device.lastHostname}
                            </span>
                          )}
                          {platformLabel && (
                            <>
                              {device.customName && (primaryBridge?.hostname || device.lastHostname) && <span>·</span>}
                              <span>{platformLabel}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{device.roomId === 'owner' ? '管理员房间' : '独立加密房间'}</span>
                        </div>

                        {serverHost && (
                          <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400/80">
                            {serverHost}
                          </div>
                        )}
                      </div>
                    </button>

                    {/* Action buttons */}
                    {!isEditing && !isConfirmingDelete && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => startRename(device, displayName)}
                          title="重命名电脑"
                          aria-label={`重命名 ${displayName}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/70 dark:hover:text-slate-200"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null)
                            setConfirmDeleteId(device.id)
                          }}
                          title="移除电脑"
                          aria-label={`移除 ${displayName}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Inline rename editor */}
                  {isEditing && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        commitRename(device.id)
                      }}
                      className="mt-2.5 flex items-center gap-1.5"
                    >
                      <input
                        type="text"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setEditingId(null)
                            setEditDraft('')
                          }
                        }}
                        autoFocus
                        maxLength={40}
                        placeholder="输入备注名（如：公司 Mac / 家里台式机）"
                        className="min-w-0 flex-1 rounded-xl border border-[#4D6BFE] bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none dark:bg-[#14161D] dark:text-white"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-7.5 items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 text-xs font-semibold text-white"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>保存</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null)
                          setEditDraft('')
                        }}
                        className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-700"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  )}

                  {/* Inline remove confirmation */}
                  {isConfirmingDelete && (
                    <div className="mt-2.5 space-y-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                      <div className="flex items-center justify-between gap-2">
                        <span>移除此电脑并清空其本地缓存？</span>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                        >
                          取消
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null)
                            onRemoveDevice?.(device.id, { revokeAll: false })
                          }}
                          className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-600 active:scale-95 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                        >
                          仅移除本机
                        </button>
                        {status !== 'expired' && (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null)
                              onRemoveDevice?.(device.id, { revokeAll: true })
                            }}
                            className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white active:scale-95"
                          >
                            移除并踢出全部手机
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Expired credential quick re-pair CTA */}
                  {status === 'expired' && !isConfirmingDelete && (
                    <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50/70 px-3 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/35 dark:text-rose-300">
                      <span>配对登录已过期，重新配对即可恢复</span>
                      <button
                        type="button"
                        onClick={() => {
                          onClose()
                          onAddDevice?.(device.baseUrl)
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1 font-semibold text-white active:scale-95"
                      >
                        <KeyRound className="h-3 w-3" />
                        <span>重新配对</span>
                      </button>
                    </div>
                  )}

                  {/* Same-room multi-bridge selector (when >= 2 PCs share one room, or active pinned bridge is offline while another is online) */}
                  {(onlineBridges.length > 1 || (isActive && !activeBridgeId && onlineBridges.length === 1)) && !isConfirmingDelete && (
                    <div className="mt-2.5 border-t border-slate-200/70 pt-2 dark:border-slate-700/70">
                      <div className="mb-1.5 text-[10.5px] font-medium text-slate-400">
                        {onlineBridges.length > 1 ? '该房间内同时在线的电脑（点击切换）：' : '该房间内其他在线电脑（点击切换）：'}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {onlineBridges.map((b) => {
                          const isSelectedBridge = isActive && b.bridgeId === activeBridgeId
                          return (
                            <button
                              key={b.bridgeId}
                              type="button"
                              onClick={() => {
                                onSelectDevice?.(device.id, b.bridgeId)
                                onClose()
                              }}
                              className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11.5px] font-medium transition active:scale-95 ${
                                isSelectedBridge
                                  ? 'border-[#4D6BFE] bg-[#4D6BFE] text-white'
                                  : 'border-slate-200 bg-white text-slate-700 hover:border-[#4D6BFE]/50 dark:border-slate-700 dark:bg-[#232734] dark:text-slate-200'
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isSelectedBridge ? 'bg-white' : 'bg-emerald-500'
                                }`}
                              />
                              <span className="max-w-[140px] truncate">{b.hostname || b.bridgeId}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer CTA */}
        <div className="border-t border-slate-100 px-4 pt-3 pb-3.5 dark:border-slate-800">
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose()
                onAddDevice?.('', { openScanner: true })
              }}
              className="col-span-3 flex items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
            >
              <ScanLine className="h-4.5 w-4.5" />
              <span>扫码添加电脑</span>
            </button>

            <button
              type="button"
              onClick={() => {
                onClose()
                onAddDevice?.('', { openScanner: false })
              }}
              className="col-span-2 flex items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-[0.98] dark:border-slate-700 dark:bg-[#232631] dark:text-slate-200 dark:hover:bg-[#2B2F3D]"
            >
              <Plus className="h-4 w-4" />
              <span>输配对码</span>
            </button>
          </div>

          <div className="mt-2 flex items-center justify-center gap-1 text-[10.5px] text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            <span>每台电脑独立加密房间与隔离缓存，互不可见</span>
          </div>
        </div>
      </div>
    </div>
  )
}
