import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Smartphone,
  X,
} from 'lucide-react'
import {
  computeE2eeKeyId,
  decryptGrantPayload,
  deriveGrantSas,
  encodeE2eeGrantQrUri,
  encodeE2eeQrUri,
  formatE2eeFingerprint,
  generateGrantKeyPair,
  generateGrantReqId,
  parseE2eeGrantQrInput,
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
  isBridgeLocked = false,
  activeKey = '',
  activeKeyId = '',
  isDesktopApp = false,
  client = null,
  onlineOtherClientCount = 0,
  initialTab = 'auto', // 'auto' | 'show' | 'request' | 'import'
  autoOpenScanner = false,
  onImportKey = null,
  onImportKeyring = null,
  onScanGrantQr = null,
  onRotateDesktopKey = null,
}) {
  const { bi, t } = useI18n()
  const isLocked = Boolean(isBridgeLocked || (bridgeE2ee?.enabled && !activeKey))
  // Strictly mutually exclusive: an unlocked device ONLY shows its own key QR;
  // a locked / keyless device ONLY shows the remote phone-approval request QR.
  const canShowMyKey = Boolean(activeKey && !isLocked)
  const canRequestGrant = Boolean(client && roomId && !canShowMyKey)

  const resolveInitialTab = useCallback(() => {
    if (initialTab === 'import') return 'import'
    if (initialTab === 'show' && canShowMyKey) return 'show'
    if (initialTab === 'request' && canRequestGrant) return 'request'
    if (canShowMyKey) return 'show'
    if (isDesktopApp && canRequestGrant) return 'request'
    return 'import'
  }, [initialTab, canShowMyKey, canRequestGrant, isDesktopApp])

  const [tab, setTab] = useState(resolveInitialTab)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [manualInput, setManualInput] = useState('')
  const [applyToDesktop, setApplyToDesktop] = useState(true)
  const [showPlainKey, setShowPlainKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // Reverse-Auth / Device-to-Device Grant state (Computer C waiting for Phone B)
  const [grantState, setGrantState] = useState(null)
  // { reqId, pubKeyRaw, pubKeyFp, qrDataUrl, expiresAt, phase: 'waiting'|'sas'|'rejected'|'expired', sasCode, approverDeviceName, approverIp, approverPubKey }
  const [grantCountdownSec, setGrantCountdownSec] = useState(0)
  const grantPrivateKeyRef = useRef(null)
  const grantStateRef = useRef(null)
  grantStateRef.current = grantState
  const applyToDesktopRef = useRef(applyToDesktop)
  applyToDesktopRef.current = applyToDesktop
  const didAutoOpenScannerRef = useRef(false)

  const cancelActiveGrant = useCallback(() => {
    const cur = grantStateRef.current
    if (cur?.reqId) {
      try {
        client?.sendGrantCancel?.({ reqId: cur.reqId })
      } catch {}
    }
    grantPrivateKeyRef.current = null
    setGrantState(null)
    setGrantCountdownSec(0)
  }, [client])

  const startGrantSession = useCallback(async () => {
    if (!client || !roomId) return
    cancelActiveGrant()
    setError('')
    setInfo('')
    try {
      const pair = await generateGrantKeyPair()
      const reqId = generateGrantReqId()
      const uri = encodeE2eeGrantQrUri({ reqId, roomId, pubKeyFp: pair.publicKeyFp })
      const qrDataUrl = renderQrDataUrl(uri, { pixelSize: 224, darkColor: '#0F172A', lightColor: '#FFFFFF' })
      const sent = client.sendGrantRequest({
        reqId,
        pubKey: pair.publicKeyRaw,
        wantedKeyId: bridgeE2ee?.keyId || '',
      })
      if (!sent) {
        setError(bi('尚未连接到中转服务器，请稍候重试', 'Not connected to relay server yet.'))
        return
      }
      grantPrivateKeyRef.current = pair.privateKey
      const expiresAt = Date.now() + 120_000
      setGrantState({
        reqId,
        pubKeyRaw: pair.publicKeyRaw,
        pubKeyFp: pair.publicKeyFp,
        qrDataUrl,
        expiresAt,
        phase: 'waiting',
        sasCode: '',
        approverDeviceName: '',
        approverIp: '',
        approverPubKey: '',
      })
      setGrantCountdownSec(120)
    } catch (err) {
      setError(String(err?.message || err))
    }
  }, [client, roomId, bridgeE2ee?.keyId, cancelActiveGrant, bi])

  useEffect(() => {
    if (!open) {
      didAutoOpenScannerRef.current = false
      cancelActiveGrant()
      setScannerOpen(false)
      setManualInput('')
      setShowPlainKey(false)
      setCopied(false)
      setConfirmRotate(false)
      setError('')
      setInfo('')
      return
    }
    const nextTab = resolveInitialTab()
    setTab(nextTab)
    if (autoOpenScanner && nextTab === 'import' && !didAutoOpenScannerRef.current) {
      didAutoOpenScannerRef.current = true
      setScannerOpen(true)
    }
  }, [open, resolveInitialTab, autoOpenScanner, cancelActiveGrant])

  // Auto-start Reverse-Auth grant session whenever entering the `request` tab
  useEffect(() => {
    if (!open || tab !== 'request' || !canRequestGrant) {
      if (grantStateRef.current) cancelActiveGrant()
      return
    }
    if (!grantStateRef.current) {
      void startGrantSession()
    }
    return () => {
      cancelActiveGrant()
    }
  }, [open, tab, canRequestGrant, startGrantSession, cancelActiveGrant])

  // Live countdown for pending grant session
  useEffect(() => {
    if (!open || !grantState || (grantState.phase !== 'waiting' && grantState.phase !== 'sas')) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((grantState.expiresAt - Date.now()) / 1000))
      setGrantCountdownSec(left)
      if (left <= 0) {
        setGrantState((prev) => (prev && prev.reqId === grantState.reqId ? { ...prev, phase: 'expired' } : prev))
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [open, grantState])

  // Listen for approver `offer`, `deliver`, `reject` events on this client
  useEffect(() => {
    if (!open || !client || tab !== 'request') return
    const unsub = client.onEvent(async (event, payload) => {
      const cur = grantStateRef.current
      if (!cur || !payload || payload.reqId !== cur.reqId) return

      if (event === 'e2ee.grant.offer' && payload.approverPubKey) {
        try {
          const sas = await deriveGrantSas({
            requesterPubKey: cur.pubKeyRaw,
            approverPubKey: payload.approverPubKey,
            reqId: cur.reqId,
            roomId,
          })
          setGrantState((prev) =>
            prev && prev.reqId === cur.reqId
              ? {
                  ...prev,
                  phase: 'sas',
                  sasCode: sas,
                  approverPubKey: payload.approverPubKey,
                  approverDeviceName: payload.approverDeviceName || bi('已授权设备', 'Authorized Device'),
                  approverIp: payload.approverIp || '',
                }
              : prev,
          )
        } catch {}
        return
      }

      if (event === 'e2ee.grant.reject') {
        grantPrivateKeyRef.current = null
        setGrantState((prev) =>
          prev && prev.reqId === cur.reqId
            ? {
                ...prev,
                phase: 'rejected',
                approverDeviceName: payload.approverDeviceName || bi('已授权设备', 'Authorized Device'),
              }
            : prev,
        )
        return
      }

      if (event === 'e2ee.grant.deliver' && payload.envelope) {
        const privKey = grantPrivateKeyRef.current
        if (!privKey) return
        setBusy(true)
        setError('')
        try {
          const decrypted = await decryptGrantPayload({
            requesterPrivateKey: privKey,
            requesterPubKeyRaw: cur.pubKeyRaw,
            envelope: payload.envelope,
            roomId,
            expectedApproverPubKey: cur.approverPubKey || '',
          })
          const rawKeys = Array.isArray(decrypted?.keys) ? decrypted.keys : []
          const verifiedKeys = []
          for (const entry of rawKeys) {
            if (!entry?.key) continue
            try {
              const cid = await computeE2eeKeyId(entry.key)
              if (!entry.keyId || entry.keyId === cid) {
                verifiedKeys.push({ keyId: cid, key: entry.key })
              }
            } catch {}
          }
          if (verifiedKeys.length === 0) {
            throw new Error(bi('授权包中未包含有效密钥', 'No valid keys in authorization payload'))
          }
          grantPrivateKeyRef.current = null
          setGrantState(null)
          const preferredKeyId =
            (bridgeE2ee?.keyId && verifiedKeys.some((k) => k.keyId === bridgeE2ee.keyId) ? bridgeE2ee.keyId : '') ||
            (decrypted?.preferredKeyId && verifiedKeys.some((k) => k.keyId === decrypted.preferredKeyId)
              ? decrypted.preferredKeyId
              : verifiedKeys[0].keyId)

          const shouldApplyDesktop = Boolean(isDesktopApp && applyToDesktopRef.current)
          if (onImportKeyring) {
            await onImportKeyring(verifiedKeys, preferredKeyId, {
              applyToDesktopBridge: shouldApplyDesktop,
              approverName: payload.approverDeviceName || '',
            })
          } else if (onImportKey) {
            for (const item of verifiedKeys) {
              await onImportKey(item.key, item.keyId, {
                applyToDesktopBridge: shouldApplyDesktop && item.keyId === preferredKeyId,
              })
            }
          }
          onClose?.()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }
    })
    return () => unsub?.()
  }, [open, client, tab, roomId, bridgeE2ee?.keyId, isDesktopApp, onImportKeyring, onImportKey, onClose, bi])

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

    // Dual-purpose QR detection: if user scanned a Reverse-Auth Grant QR (`allinone-e2ee-grant://v1?...`)
    const grantQr = parseE2eeGrantQrInput(rawText)
    if (grantQr) {
      if (!activeKey) {
        setError(
          bi(
            '这是新设备的「请求授权二维码」，请用已解锁的手机（持有密钥的设备）扫描它来完成授权。',
            'This is a new-device authorization request QR. Scan it from a device that already holds your E2EE key.',
          ),
        )
        return
      }
      if (grantQr.roomId && roomId && grantQr.roomId !== roomId) {
        setError(bi('该授权二维码属于其他账号，无法授权', 'This authorization QR belongs to a different account.'))
        return
      }
      if (onScanGrantQr) {
        setBusy(true)
        try {
          const ok = await onScanGrantQr(grantQr)
          if (ok) {
            onClose?.()
          } else {
            setError(bi('未找到对应的待授权请求（可能已过期或对方已关闭页面），请让对方刷新二维码后重试。', 'Pending request not found or expired. Ask the other device to refresh the QR code.'))
          }
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }
      return
    }

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
      setInfo(bi('已重置本机密钥，其他设备需重新扫码。', 'Key rotated. Re-scan on other devices.'))
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const tabs = []
  if (canShowMyKey) {
    tabs.push({ id: 'show', icon: QrCode, label: bi('本机密钥', 'My Key') })
  }
  if (canRequestGrant) {
    tabs.push({ id: 'request', icon: Smartphone, label: bi('请求手机授权', 'Approve via Phone') })
  }
  tabs.push({ id: 'import', icon: ScanLine, label: bi('扫码 / 导入', 'Scan / Import') })

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
                  {bi('端到端加密', 'End-to-End Encryption')}
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
          {tabs.length > 1 && (
            <div className="px-4 pt-3">
              <div
                className={`grid gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-[#14161C] ${
                  tabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
                }`}
              >
                {tabs.map((item) => {
                  const Icon = item.icon
                  const active = tab === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setTab(item.id)
                        setError('')
                        setInfo('')
                      }}
                      className={`flex items-center justify-center gap-1 rounded-xl py-1.5 text-[11.5px] font-semibold transition ${
                        active
                          ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Body */}
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
            {tab === 'show' && canShowMyKey ? (
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
                    <span>{activeFp}</span>
                  </div>
                </div>

                {/* Reverse-QR scanner shortcut for Phone B -> Computer C */}
                {onScanGrantQr && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError('')
                      setScannerOpen(true)
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] px-3.5 py-2.5 text-left transition hover:border-[#4D6BFE] hover:bg-[#E9EEFF] active:scale-[0.99] disabled:opacity-60 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE] text-white">
                        <ScanLine className="h-4 w-4" />
                      </div>
                      <span className="truncate text-xs font-bold text-[#2842C9] dark:text-white">
                        {bi('扫一扫授权新设备', 'Scan to Authorize New Device')}
                      </span>
                    </div>
                    <QrCode className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
                  </button>
                )}

                {/* Recovery key box */}
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3 dark:border-slate-800 dark:bg-[#22252E]">
                  <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
                      <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                      <span>{bi('恢复密钥', 'Recovery Key')}</span>
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
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                          {bi('重置本机密钥', 'Rotate Local Key')}
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmRotate(true)}
                          className="shrink-0 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-700 hover:border-amber-400 hover:text-amber-600 dark:border-slate-700 dark:text-slate-200"
                        >
                          {bi('重置', 'Rotate')}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2 text-xs">
                        <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            {bi(
                              '重置后，已同步的手机需重新扫码才能访问本电脑。',
                              'Synced devices will need to scan the new QR code after rotating.',
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
                            <span>{bi('确认重置', 'Confirm')}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : tab === 'request' && canRequestGrant ? (
              <>
                {grantState?.phase === 'sas' ? (
                  <div className="flex flex-col items-center rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] p-5 text-center dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]">
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1 text-[11px] font-semibold text-[#2842C9] shadow-xs dark:bg-[#14171F] dark:text-[#8DA2FF]">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{grantState.approverDeviceName}</span>
                    </div>
                    <div className="mt-4 font-mono text-4xl font-extrabold tracking-[0.22em] text-[#2842C9] dark:text-white">
                      {grantState.sasCode.replace('-', ' · ')}
                    </div>
                    <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">
                      {bi('核对手机上的 6 位数字一致后，在手机点击确认', 'Confirm this code matches your phone, then approve')}
                    </p>
                    {grantState.approverIp && (
                      <div className="mt-2 font-mono text-[11px] text-slate-400">
                        {grantState.approverIp} · {grantCountdownSec}s
                      </div>
                    )}
                  </div>
                ) : grantState?.phase === 'rejected' || grantState?.phase === 'expired' ? (
                  <div className="flex flex-col items-center rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 text-center dark:border-slate-800 dark:bg-[#14171F]">
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                    <div className="mt-2 text-sm font-bold text-slate-800 dark:text-white">
                      {grantState.phase === 'rejected'
                        ? bi(`已被「${grantState.approverDeviceName}」拒绝`, `Declined by ${grantState.approverDeviceName}`)
                        : bi('授权请求已过期', 'Request expired')}
                    </div>
                    <button
                      type="button"
                      onClick={() => void startGrantSession()}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>{bi('重新生成', 'Try Again')}</span>
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 text-center dark:border-slate-800 dark:bg-[#14171F]">
                    {grantState?.qrDataUrl ? (
                      <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70">
                        <img
                          src={grantState.qrDataUrl}
                          alt="E2EE Reverse Auth QR"
                          className="h-44 w-44 select-none"
                        />
                      </div>
                    ) : (
                      <div className="flex h-44 w-44 items-center justify-center rounded-2xl bg-white/60 dark:bg-[#1B1D23]">
                        <Loader2 className="h-6 w-6 animate-spin text-[#4D6BFE]" />
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="inline-flex items-center gap-1.5 rounded-full bg-[#4D6BFE]/12 px-2.5 py-1 text-[11px] font-semibold text-[#4D6BFE]">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>{bi(`等待授权 (${grantCountdownSec || 120}s)`, `Waiting (${grantCountdownSec || 120}s)`)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void startGrantSession()}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-[#4D6BFE] hover:bg-[#4D6BFE]/10"
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>{bi('刷新', 'Refresh')}</span>
                      </button>
                    </div>
                    <p className="mt-2 text-[11.5px] text-slate-500 dark:text-slate-400">
                      {bi('用已授权手机扫码，或直接确认手机弹窗', 'Scan with your phone, or approve the popup on it')}
                    </p>
                  </div>
                )}

                {isDesktopApp && (
                  <label className="flex cursor-pointer items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-3.5 py-2.5 text-[11.5px] text-slate-600 dark:border-slate-800 dark:bg-[#22252E] dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={applyToDesktop}
                      onChange={(e) => setApplyToDesktop(e.target.checked)}
                      className="h-3.5 w-3.5 rounded accent-[#4D6BFE]"
                    />
                    <span>{bi('同步至本机桌面桥接', 'Also apply to local bridge')}</span>
                  </label>
                )}
              </>
            ) : (
              <>
                {isLocked && expectedFp && (
                  <div className="flex items-center justify-between gap-2 rounded-2xl border border-amber-300/60 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-800 dark:border-amber-500/35 dark:bg-amber-950/35 dark:text-amber-200">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Lock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span>{bridgeName || bi('目标电脑', 'Target PC')}</span>
                    </span>
                    <span className="font-mono text-[11px] font-semibold">{expectedFp}</span>
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
                    <span className="truncate text-[13px] font-bold text-[#2842C9] dark:text-white">
                      {bi('扫一扫二维码', 'Scan QR Code')}
                    </span>
                  </div>
                  <QrCode className="h-4.5 w-4.5 shrink-0 text-[#4D6BFE]" />
                </button>

                <form onSubmit={handleManualSubmit} className="space-y-2.5 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171F]">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('恢复密钥', 'Recovery Key')}</span>
                  </label>
                  <input
                    type="text"
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder={bi('粘贴恢复密钥', 'Paste recovery key')}
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
                      <span>{bi('同步至本机桌面桥接', 'Also apply to local bridge')}</span>
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
