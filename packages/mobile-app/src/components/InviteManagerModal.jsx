import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Check,
  Copy,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Ticket,
  Users,
  X,
} from 'lucide-react'
import {
  DEFAULT_PROD_SERVER,
  adminCreateInvites,
  adminListInvites,
  adminRevokeInvite,
  normalizeBaseUrl,
} from '../lib/wsClient.js'

const APK_FILENAME = 'All-in-One-v0.1.8.apk'

function formatTimeShort(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
  } catch {
    return ''
  }
}

async function copyClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {}
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch {}
  document.body.removeChild(ta)
}

export function InviteManagerModal({ open, onClose, baseUrl, token }) {
  const [invites, setInvites] = useState([])
  const [stats, setStats] = useState({ total: 0, active: 0, used: 0, revoked: 0 })
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const [count, setCount] = useState(1)
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'active' | 'used' | 'revoked'
  const [showUsers, setShowUsers] = useState(false)
  const [copiedKey, setCopiedKey] = useState('')

  const cleanBase = normalizeBaseUrl(baseUrl || DEFAULT_PROD_SERVER)

  const loadInvites = useCallback(async () => {
    if (!baseUrl || !token) return
    setLoading(true)
    setError('')
    try {
      const res = await adminListInvites(baseUrl, token)
      setInvites(res.invites)
      setStats(res.stats)
      setUsers(res.users)
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }, [baseUrl, token])

  useEffect(() => {
    if (open) {
      void loadInvites()
    }
  }, [open, loadInvites])

  const filtered = useMemo(() => {
    if (filter === 'all') return invites
    return invites.filter((i) => i.status === filter)
  }, [invites, filter])

  if (!open) return null

  const doCopy = async (key, text) => {
    await copyClipboard(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? '' : cur)), 1800)
  }

  const buildShareText = (inv) => {
    const regUrl = `${cleanBase}/?invite=${encodeURIComponent(inv.code)}`
    const apkUrl = `${cleanBase}/${APK_FILENAME}`
    return [
      '给你分享一个 All in One 一次性注册邀请码（仅限 1 人使用）：',
      `邀请码：${inv.code}`,
      `注册直达链接：${regUrl}`,
      `Android App 下载：${apkUrl}`,
      '',
      '注册完账号后，在自己电脑终端运行 1 行命令并登录同一账号即可自动连接所有电脑：',
      `• macOS / Linux: curl -fsSL ${cleanBase}/setup.sh | bash`,
      `• Windows (PowerShell): irm ${cleanBase}/setup.ps1 | iex`,
    ].join('\n')
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!baseUrl || !token || creating) return
    setCreating(true)
    setError('')
    try {
      await adminCreateInvites(baseUrl, token, { count, note })
      setNote('')
      setFilter('active')
      await loadInvites()
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (inv) => {
    if (!baseUrl || !token) return
    setError('')
    try {
      await adminRevokeInvite(baseUrl, token, { id: inv.id })
      await loadInvites()
    } catch (err) {
      setError(String(err?.message || err))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe flex max-h-[90vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pt-4.5 pb-3.5 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8.5 w-8.5 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Ticket className="h-4 w-4" />
            </div>
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">
              邀请码
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={loadInvites}
              aria-label="刷新邀请码"
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭邀请码管理"
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2 px-4 pt-3">
          <div className="rounded-2xl bg-emerald-50/80 px-3 py-2 text-center dark:bg-emerald-950/30">
            <div className="text-base font-bold text-emerald-600 dark:text-emerald-300">{stats.active}</div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">可用</div>
          </div>
          <div className="rounded-2xl bg-slate-100/90 px-3 py-2 text-center dark:bg-[#232631]">
            <div className="text-base font-bold text-slate-700 dark:text-slate-200">{stats.used}</div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">已用</div>
          </div>
          <button
            type="button"
            onClick={() => setShowUsers((v) => !v)}
            className="rounded-2xl bg-[#EEF2FF] px-3 py-2 text-center transition hover:bg-[#E2E9FF] dark:bg-[#222942]"
          >
            <div className="inline-flex items-center justify-center gap-1 text-base font-bold text-[#4D6BFE] dark:text-[#96AEFF]">
              <Users className="h-3.5 w-3.5" />
              <span>{users.length}</span>
            </div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">用户</div>
          </button>
        </div>

        {/* Optional registered users panel */}
        {showUsers && (
          <div className="mx-4 mt-2.5 max-h-32 overflow-y-auto rounded-2xl border border-slate-200/80 bg-slate-50/80 p-2.5 text-xs dark:border-slate-800 dark:bg-[#14171F]">
            {users.length === 0 ? (
              <div className="py-2 text-center text-slate-400">暂无注册用户</div>
            ) : (
              <div className="space-y-1.5">
                {users.map((u) => (
                  <div key={u.userId} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate font-semibold text-slate-800 dark:text-slate-100">@{u.username}</span>
                      {u.role === 'admin' && (
                        <span className="rounded bg-[#4D6BFE]/15 px-1.5 py-0.2 text-[10px] font-semibold text-[#4D6BFE]">
                          管理员
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {u.deviceCount} 台电脑
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Generate Form */}
        <form onSubmit={handleCreate} className="mx-4 mt-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#151821]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">生成数量</span>
            <div className="flex items-center gap-1">
              {[1, 3, 5, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                    count === n
                      ? 'bg-[#4D6BFE] text-white shadow-xs'
                      : 'bg-white text-slate-600 hover:bg-slate-200/60 dark:bg-[#232631] dark:text-slate-300'
                  }`}
                >
                  {n}个
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={40}
              placeholder="备注（可选）"
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1C1F28] dark:text-white"
            />
            <button
              type="submit"
              disabled={creating}
              className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25 active:scale-95 disabled:opacity-60"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span>生成</span>
            </button>
          </div>
        </form>

        {error && (
          <div className="mx-4 mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex items-center gap-1.5 px-4 pt-3 pb-1.5 text-[11px]">
          {[
            { id: 'all', label: `全部 (${stats.total})` },
            { id: 'active', label: `可用 (${stats.active})` },
            { id: 'used', label: `已用 (${stats.used})` },
            { id: 'revoked', label: `作废 (${stats.revoked})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`rounded-lg px-2.5 py-1 font-medium transition ${
                filter === tab.id
                  ? 'bg-[#4D6BFE]/12 text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Invite code list */}
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pt-1.5 pb-4">
          {loading && invites.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-xs text-slate-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#4D6BFE]" />
              加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              暂无邀请码
            </div>
          ) : (
            filtered.map((inv) => {
              const isActive = inv.status === 'active'
              const isUsed = inv.status === 'used'
              const regUrl = `${cleanBase}/?invite=${encodeURIComponent(inv.code)}`
              return (
                <div
                  key={inv.id}
                  className={`rounded-2xl border p-3 ${
                    isActive
                      ? 'border-emerald-200/80 bg-white dark:border-emerald-900/50 dark:bg-[#171A22]'
                      : 'border-slate-200/60 bg-slate-50/70 opacity-75 dark:border-slate-800 dark:bg-[#14161D]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-sm font-bold tracking-wider ${
                            inv.status === 'revoked'
                              ? 'text-slate-400 line-through'
                              : isUsed
                                ? 'text-slate-500 dark:text-slate-400'
                                : 'text-slate-900 dark:text-white'
                          }`}
                        >
                          {inv.code}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                            isActive
                              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300'
                              : isUsed
                                ? 'bg-slate-200/80 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                                : 'bg-rose-50 text-rose-500 dark:bg-rose-950/40 dark:text-rose-300'
                          }`}
                        >
                          {isActive ? '可用' : isUsed ? '已使用' : '已作废'}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10.5px] text-slate-400">
                        {inv.note && <span className="text-slate-600 dark:text-slate-300">{inv.note}</span>}
                        {isUsed && inv.usedByUsername && (
                          <span className="text-[#4D6BFE]">由 @{inv.usedByUsername} 注册</span>
                        )}
                        <span>{formatTimeShort(isUsed ? inv.usedAt : inv.createdAt)}</span>
                      </div>
                    </div>

                    {isActive && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(inv)}
                        title="作废此邀请码"
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {isActive && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => doCopy(`code:${inv.id}`, inv.code)}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200/70 active:scale-95 dark:bg-[#232631] dark:text-slate-200"
                      >
                        {copiedKey === `code:${inv.id}` ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        <span>{copiedKey === `code:${inv.id}` ? '已复制' : '复制码'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => doCopy(`link:${inv.id}`, regUrl)}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200/70 active:scale-95 dark:bg-[#232631] dark:text-slate-200"
                      >
                        {copiedKey === `link:${inv.id}` ? <Check className="h-3 w-3 text-emerald-500" /> : <Link2 className="h-3 w-3" />}
                        <span>{copiedKey === `link:${inv.id}` ? '已复制' : '链接'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => doCopy(`msg:${inv.id}`, buildShareText(inv))}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#4D6BFE]/12 px-2.5 py-1 text-[11px] font-semibold text-[#4D6BFE] hover:bg-[#4D6BFE]/20 active:scale-95 dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]"
                      >
                        {copiedKey === `msg:${inv.id}` ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        <span>{copiedKey === `msg:${inv.id}` ? '已复制' : '分享'}</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
