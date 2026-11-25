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
import { useI18n } from '../lib/i18n.jsx'
import { RELEASES_URL, copyTextToClipboard, resolveApkUrl } from '../lib/clientHelpers.js'

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

export function InviteManagerModal({ open, onClose, baseUrl, token }) {
  const { isEn, bi, t } = useI18n()
  const [invites, setInvites] = useState([])
  const [stats, setStats] = useState({ total: 0, active: 0, used: 0, revoked: 0 })
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const [count, setCount] = useState(1)
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'active' | 'used' | 'revoked'
  const [showUsers, setShowUsers] = useState(false)
  const [copiedKey, setCopiedKey] = useState('')

  const currentAdminRoom = useMemo(() => {
    try {
      const part = String(token || '').split('.')[1]
      if (!part) return ''
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(atob(b64))
      return String(payload?.room || '')
    } catch {
      return ''
    }
  }, [token])

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
    await copyTextToClipboard(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? '' : cur)), 1800)
  }

  const buildShareText = (inv) => {
    const regUrl = `${cleanBase}/?invite=${encodeURIComponent(inv.code)}`
    const apkUrl = resolveApkUrl(cleanBase)
    return (isEn
      ? [
          'Here is a single-use All in One invite code (1 user only):',
          `Invite Code: ${inv.code}`,
          `Sign-up Link: ${regUrl}`,
          `Installers (Windows / macOS / Android): ${RELEASES_URL}`,
          ...(apkUrl && apkUrl !== RELEASES_URL ? [`Android Direct Link: ${apkUrl}`] : []),
          '',
          'After signing up, install the desktop app on your PC or run 1 command and sign in with the same account:',
          `• macOS / Linux: curl -fsSL ${cleanBase}/setup.sh | bash`,
          `• Windows (PowerShell): irm ${cleanBase}/setup.ps1 | iex`,
        ]
      : [
          '给你分享一个 All in One 一次性注册邀请码（仅限 1 人使用）：',
          `邀请码：${inv.code}`,
          `注册直达链接：${regUrl}`,
          `客户端安装包（Windows / macOS / Android）：${RELEASES_URL}`,
          ...(apkUrl && apkUrl !== RELEASES_URL ? [`Android 直链：${apkUrl}`] : []),
          '',
          '注册完账号后，在自己电脑安装桌面端或运行 1 行命令并登录同一账号即可自动连接所有电脑：',
          `• macOS / Linux: curl -fsSL ${cleanBase}/setup.sh | bash`,
          `• Windows (PowerShell): irm ${cleanBase}/setup.ps1 | iex`,
        ]
    ).join('\n')
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!baseUrl || !token || creating) return
    setCreating(true)
    setError('')
    try {
      await adminCreateInvites(baseUrl, token, { count, note, grantAdmin })
      setNote('')
      setGrantAdmin(false)
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
              {bi('邀请码', 'Invite Codes')}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={loadInvites}
              aria-label={bi('刷新邀请码', 'Refresh invite codes')}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={bi('关闭邀请码管理', 'Close invite manager')}
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
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">{bi('可用', 'Active')}</div>
          </div>
          <div className="rounded-2xl bg-slate-100/90 px-3 py-2 text-center dark:bg-[#232631]">
            <div className="text-base font-bold text-slate-700 dark:text-slate-200">{stats.used}</div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">{bi('已用', 'Used')}</div>
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
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">{bi('用户', 'Users')}</div>
          </button>
        </div>

        {/* Optional registered users panel */}
        {showUsers && (
          <div className="mx-4 mt-2.5 max-h-56 overflow-y-auto rounded-2xl border border-slate-200/80 bg-slate-50/80 p-2.5 text-xs dark:border-slate-800 dark:bg-[#14171F]">
            {users.length === 0 ? (
              <div className="py-2 text-center text-slate-400">{bi('暂无注册用户', 'No registered users')}</div>
            ) : (
              <div className="space-y-2">
                {users.map((u) => {
                  const isAdm = u.role === 'admin'
                  const isSelf = Boolean(currentAdminRoom && currentAdminRoom === u.userId)
                  return (
                    <div key={u.userId} className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate font-semibold text-slate-800 dark:text-slate-100">@{u.username}</span>
                          {isSelf && (
                            <span className="shrink-0 rounded bg-slate-200/70 px-1 py-0.5 text-[9.5px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                              {bi('当前', 'You')}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[10px] text-slate-400">
                          {bi(`${u.deviceCount} 台电脑`, `${u.deviceCount} PC${u.deviceCount === 1 ? '' : 's'}`)}
                          {u.email ? ` · ${u.email}` : ''}
                        </div>
                      </div>
                      {isAdm ? (
                        <span className="shrink-0 rounded-lg border border-[#4D6BFE]/40 bg-[#4D6BFE]/12 px-2 py-0.5 text-[10.5px] font-semibold text-[#4D6BFE] dark:text-[#96AEFF]">
                          Admin
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:border-slate-700 dark:bg-[#1C1F28] dark:text-slate-400">
                          {bi('成员', 'User')}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Generate Form */}
        <form onSubmit={handleCreate} className="mx-4 mt-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#151821]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{bi('生成数量', 'Quantity')}</span>
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
                  {bi(`${n}个`, `${n}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{bi('账号角色', 'Role')}</span>
            <select
              value={grantAdmin ? 'admin' : 'user'}
              onChange={(e) => setGrantAdmin(e.target.value === 'admin')}
              className="rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1C1F28] dark:text-slate-100"
            >
              <option value="user">{bi('普通用户 (P2P 直连不限流)', 'Standard User (Direct P2P)')}</option>
              <option value="admin">{bi('管理员 (Admin)', 'Administrator')}</option>
            </select>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={40}
              placeholder={bi('备注（可选）', 'Note (optional)')}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1C1F28] dark:text-white"
            />
            <button
              type="submit"
              disabled={creating}
              className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25 active:scale-95 disabled:opacity-60"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              <span>{bi('生成', 'Create')}</span>
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
            { id: 'all', label: `${t('common.all')} (${stats.total})` },
            { id: 'active', label: `${bi('可用', 'Active')} (${stats.active})` },
            { id: 'used', label: `${bi('已用', 'Used')} (${stats.used})` },
            { id: 'revoked', label: `${bi('作废', 'Revoked')} (${stats.revoked})` },
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
              {t('common.loading')}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              {bi('暂无邀请码', 'No invite codes')}
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
                        {inv.grantAdmin ? (
                          <span className="rounded-full bg-[#4D6BFE]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#4D6BFE] dark:text-[#96AEFF]">
                            ADMIN
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                            isActive
                              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300'
                              : isUsed
                                ? 'bg-slate-200/80 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                                : 'bg-rose-50 text-rose-500 dark:bg-rose-950/40 dark:text-rose-300'
                          }`}
                        >
                          {isActive ? bi('可用', 'Active') : isUsed ? bi('已使用', 'Used') : bi('已作废', 'Revoked')}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10.5px] text-slate-400">
                        {inv.note && <span className="text-slate-600 dark:text-slate-300">{inv.note}</span>}
                        {isUsed && inv.usedByUsername && (
                          <span className="text-[#4D6BFE]">{bi(`由 @${inv.usedByUsername} 注册`, `Used by @${inv.usedByUsername}`)}</span>
                        )}
                        <span>{formatTimeShort(isUsed ? inv.usedAt : inv.createdAt)}</span>
                      </div>
                    </div>

                    {isActive && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(inv)}
                        title={bi('作废此邀请码', 'Revoke invite code')}
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
                        <span>{copiedKey === `code:${inv.id}` ? t('common.copied') : bi('复制码', 'Code')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => doCopy(`link:${inv.id}`, regUrl)}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200/70 active:scale-95 dark:bg-[#232631] dark:text-slate-200"
                      >
                        {copiedKey === `link:${inv.id}` ? <Check className="h-3 w-3 text-emerald-500" /> : <Link2 className="h-3 w-3" />}
                        <span>{copiedKey === `link:${inv.id}` ? t('common.copied') : bi('链接', 'Link')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => doCopy(`msg:${inv.id}`, buildShareText(inv))}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#4D6BFE]/12 px-2.5 py-1 text-[11px] font-semibold text-[#4D6BFE] hover:bg-[#4D6BFE]/20 active:scale-95 dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]"
                      >
                        {copiedKey === `msg:${inv.id}` ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        <span>{copiedKey === `msg:${inv.id}` ? t('common.copied') : bi('分享', 'Share')}</span>
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
