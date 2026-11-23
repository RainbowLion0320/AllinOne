import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  computeE2eeKeyId,
  encodeE2eeQrUri,
  formatE2eeFingerprint,
  parseE2eeQrInput,
} from '@allinone/shared/e2ee'
import { renderQrDataUrl } from '@allinone/shared/qr-svg'
import { QrScannerModal } from './QrScannerModal.jsx'
import { useI18n } from '../lib/i18n.jsx'

export function E2eeSyncModal({
  open,
  onClose,
  roomId = '',
  username = '',
  bridgeName = '',
  bridgeE2ee = null,
  activeKey = '',
  activeKeyId = '',
  isDesktopApp = false,
  initialTab = 'auto', // 'auto' | 'show' | 'import'
  autoOpenScanner = false,
  onImportKey = null,
  onRotateDesktopKey = null,
}) {
  const { bi, t } = useI18n()
  const isLocked = Boolean(bridgeE2ee?.enabled && !activeKey)
  const resolvedDefaultTab =
    initialTab === 'show' || initialTab === 'import'
      ? initialTab
      : activeKey
        ? 'show'
        : 'import'

  const [tab, setTab] = useState(resolvedDefaultTab)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [manualInput, setManualInput] = useState('')
  const [applyToDesktop, setApplyToDesktop] = useState(true)
  const [showPlainKey, setShowPlainKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  useEffect(() => {
    if (!open) {
      setScannerOpen(false)
      setManualInput('')
      setShowPlainKey(false)
      setCopied(false)
      setConfirmRotate(false)
      setError('')
      setInfo('')
      return
    }
    const nextTab =
      initialTab === 'show' || initialTab === 'import'
        ? initialTab
        : activeKey
          ? 'show'
          : 'import'
    setTab(nextTab)
    if (autoOpenScanner && nextTab === 'import') {
      setScannerOpen(true)
    }
  }, [open, initialTab, activeKey, autoOpenScanner])

  const qrDataUrl = useMemo(() => {
    if (!activeKey) return ''
    try {
      const uri = encodeE2eeQrUri({ key: activeKey, roomId })
      return renderQrDataUrl(uri, { pixelSize: 240, darkColor: '#0F172A', lightColor: '#FFFFFF' })
    } catch {
      return ''
    }
  }, [activeKey, roomId])

  if (!open) return null

  const expectedFp = formatE2eeFingerprint(bridgeE2ee?.keyId || '')
  const activeFp = formatE2eeFingerprint(activeKeyId || bridgeE2ee?.keyId || '')

  const handleCopyKey = async () => {
    if (!activeKey) return
    try {
      await navigator.clipboard.writeText(activeKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {}
  }

  const processImportedText = async (rawText) => {
    setError('')
    setInfo('')
    const parsed = parseE2eeQrInput(rawText)
    if (!parsed?.key) {
      setError(bi('未识别到有效的端到端密钥，请扫描电脑端二维码或粘贴 43 位恢复密钥', 'Invalid E2EE key or QR code.'))
      return
    }
    if (parsed.roomId && roomId && parsed.roomId !== roomId) {
      setError(bi('该密钥属于其他账号，无法导入当前账号', 'This key belongs to a different account.'))
      return
    }
    setBusy(true)
    try {
      const importedKeyId = await computeE2eeKeyId(parsed.key)
      const shouldUpdateDesktop = Boolean(isDesktopApp && applyToDesktop)
      if (
        !shouldUpdateDesktop &&
        bridgeE2ee?.enabled &&
        bridgeE2ee?.keyId &&
        importedKeyId !== bridgeE2ee.keyId
      ) {
        // Still save to key ring if user has multiple PCs, but warn clearly that it didn't match the currently selected PC!
        await onImportKey?.(parsed.key, importedKeyId, { applyToDesktopBridge: false })
        setError(
          bi(
            `已保存该密钥（指纹 ${formatE2eeFingerprint(importedKeyId)}），但与当前电脑「${bridgeName}」所需指纹（${expectedFp}）不匹配，请扫描这台电脑的二维码。`,
            `Key saved (${formatE2eeFingerprint(importedKeyId)}), but it does not match ${bridgeName} (${expectedFp}). Scan that computer's QR code.`,
          ),
        )
        return
      }
      await onImportKey?.(parsed.key, importedKeyId, { applyToDesktopBridge: shouldUpdateDesktop })
      setManualInput('')
      onClose?.()
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const handleManualSubmit = async (e) => {
    e.preventDefault()
    await processImportedText(manualInput)
  }

  const handleRotate = async () => {
    if (!onRotateDesktopKey || busy) return
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await onRotateDesktopKey()
      setConfirmRotate(false)
      setInfo(bi('已生成全新 256-bit 密钥并重启本机桥接，旧手机需重新扫码同步。', 'Generated a new 256-bit key and restarted local bridge. Re-scan on other devices.'))
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4"
        onClick={onClose}
      >
        <div
          className="pb-safe flex max-h-[90vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1B1D23]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200/80 px-4 py-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div
                className={`flex h-7.5 w-7.5 items-center justify-center rounded-xl ${
                  isLocked
                    ? 'bg-amber-500/15 text-amber-500'
                    : activeKey
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'bg-[#4D6BFE]/12 text-[#4D6BFE]'
                }`}
              >
                {isLocked ? <Lock className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              </div>
              <div>
                <h2 className="text-[14.5px] font-bold text-slate-900 dark:text-white">
                  {bi('端到端加密 (E2EE)', 'End-to-End Encryption')}
                </h2>
                <p className="text-[11px] text-slate-400">
                  {bridgeName || (username ? `@${username}` : 'AES-256-GCM')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={bi('关闭', 'Close')}
              className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          {activeKey && (
            <div className="px-4 pt-3">
              <div className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-[#14161C]">
                <button
                  type="button"
                  onClick={() => {
                    setTab('show')
                    setError('')
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold transition ${
                    tab === 'show'
                      ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                  }`}
                >
                  <QrCode className="h-3.5 w-3.5" />
                  <span>{bi('同步二维码', 'Sync QR')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('import')
                    setError('')
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-xs font-semibold transition ${
                    tab === 'import'
                      ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                  }`}
                >
                  <ScanLine className="h-3.5 w-3.5" />
                  <span>{bi('扫码 / 导入', 'Scan / Import')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
            {tab === 'show' && activeKey ? (
              <>
                <div className="flex flex-col items-center rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 text-center dark:border-slate-800 dark:bg-[#14171F]">
                  {qrDataUrl && (
                    <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70">
                      <img
                        src={qrDataUrl}
                        alt="E2EE Sync QR"
                        className="h-48 w-48 select-none"
                      />
                    </div>
                  )}
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>AES-256-GCM · {activeFp}</span>
                  </div>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {bi(
                      '用新手机打开 All in One 扫描上方二维码即可同步密钥。密钥仅保存在你的本地设备，中转服务器无法查看任何对话、代码与图片。',
                      'Scan this QR code from another signed-in device to sync your 256-bit key. Keys never leave your devices; the relay server only forwards opaque ciphertext.',
                    )}
                  </p>
                </div>

                {/* Recovery key box */}
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-[#22252E]">
                  <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
                      <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                      <span>{bi('恢复密钥（手动同步备用）', 'Recovery Key')}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setShowPlainKey((v) => !v)}
                        className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        title={showPlainKey ? bi('隐藏密钥', 'Hide key') : bi('显示密钥', 'Show key')}
                      >
                        {showPlainKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={handleCopyKey}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200/80 dark:bg-slate-800 dark:text-slate-200"
                      >
                        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                        <span>{copied ? t('common.copied') : t('common.copy')}</span>
                      </button>
                    </div>
                  </div>
                  <div className="break-all rounded-xl bg-slate-50 px-2.5 py-2 font-mono text-[11px] text-slate-700 select-all dark:bg-[#14171F] dark:text-slate-200">
                    {showPlainKey
                      ? activeKey
                      : `${activeKey.slice(0, 6)}•••••••••••••••••••••••••••••••${activeKey.slice(-6)}`}
                  </div>
                </div>

                {/* Desktop key rotation */}
                {isDesktopApp && onRotateDesktopKey && (
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-[#22252E]">
                    {!confirmRotate ? (
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                            {bi('轮换 / 重置本机密钥', 'Rotate Local Key')}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {bi('设备遗失时可立即作废旧密钥，不影响本机历史对话', 'Revokes old devices immediately without losing local chats')}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmRotate(true)}
                          className="shrink-0 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-700 hover:border-amber-400 hover:text-amber-600 dark:border-slate-700 dark:text-slate-200"
                        >
                          {bi('轮换密钥', 'Rotate')}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2 text-xs">
                        <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            {bi(
                              '确认生成全新随机密钥？所有已同步的手机端需重新扫描新二维码才能继续访问本电脑。',
                              'Generate a brand-new random key? All synced phones will need to scan the new QR code.',
                            )}
                          </span>
                        </div>
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setConfirmRotate(false)}
                            className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={handleRotate}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
                          >
                            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                            <span>{bi('确认轮换', 'Confirm Rotate')}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {isLocked && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/60 bg-amber-50/90 px-3.5 py-3 text-xs text-amber-800 dark:border-amber-500/35 dark:bg-amber-950/35 dark:text-amber-200">
                    <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div className="space-y-1">
                      <div className="font-semibold">
                        {bi(`需要同步「${bridgeName || '目标电脑'}」的端到端密钥`, `Sync E2EE key for ${bridgeName || 'this computer'}`)}
                      </div>
                      {expectedFp && (
                        <div className="font-mono text-[11px] opacity-85">
                          {bi('目标指纹：', 'Expected fingerprint: ')}{expectedFp}
                        </div>
                      )}
                      <div className="text-[11px] opacity-85">
                        {bi(
                          '请在电脑端「设置 → 端到端加密」（或 CLI 按 K 键）打开同步二维码，用本设备扫描即可解锁。',
                          'Open Settings → End-to-End Encryption on your computer (or press K in CLI) and scan its QR code.',
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError('')
                    setScannerOpen(true)
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] px-3.5 py-3 text-left transition hover:border-[#4D6BFE] hover:bg-[#E9EEFF] active:scale-[0.99] disabled:opacity-60 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE] text-white">
                      <ScanLine className="h-4.5 w-4.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold text-[#2842C9] dark:text-white">
                        {bi('扫一扫电脑端密钥二维码', 'Scan E2EE Key QR Code')}
                      </div>
                      <div className="truncate text-[11px] text-slate-500 dark:text-slate-300">
                        {bi('100% 本地扫码，密钥不经过服务器', '100% local scan — key never touches server')}
                      </div>
                    </div>
                  </div>
                  <QrCode className="h-4.5 w-4.5 shrink-0 text-[#4D6BFE]" />
                </button>

                <form onSubmit={handleManualSubmit} className="space-y-2.5 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171F]">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('或手动粘贴恢复密钥', 'Or paste recovery key')}</span>
                  </label>
                  <input
                    type="text"
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder={bi('粘贴 43 位恢复密钥或 allinone-e2ee://...', 'Paste 43-char key or allinone-e2ee://...')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none placeholder:font-sans focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1C1F28] dark:text-white"
                  />

                  {isDesktopApp && (
                    <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={applyToDesktop}
                        onChange={(e) => setApplyToDesktop(e.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-[#4D6BFE]"
                      />
                      <span>
                        {bi(
                          '同时应用到本机电脑桥接（多台电脑共用一把密钥）',
                          'Also apply to this computer bridge (share one key across PCs)',
                        )}
                      </span>
                    </label>
                  )}

                  <button
                    type="submit"
                    disabled={busy || !manualInput.trim()}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#4D6BFE] py-2 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/20 transition active:scale-[0.99] disabled:opacity-55"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    <span>{bi('导入并解锁', 'Import & Unlock')}</span>
                  </button>
                </form>
              </>
            )}

            {info && (
              <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                {info}
              </div>
            )}

            {error && (
              <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <QrScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(raw) => {
          setScannerOpen(false)
          void processImportedText(raw)
        }}
      />
    </>
  )
}
