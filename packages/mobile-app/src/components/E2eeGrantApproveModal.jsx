import React, { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react'
import {
  computeGrantPubKeyFp,
  deriveGrantSas,
  encryptGrantPayload,
  formatE2eeFingerprint,
  generateGrantKeyPair,
} from '@allinone/shared/e2ee'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Approval modal shown on an ALREADY-UNLOCKED device (e.g. Phone B) when a newly signed-in
 * device (e.g. Computer C) requests zero-knowledge E2EE keyring sync.
 *
 * Two MITM-proof verification paths:
 *  - `qrVerified = true` (Phone B scanned Computer C's Reverse-Auth QR code):
 *      64-bit `pubKeyFp` was already verified out-of-band via camera -> 1-tap instant approval!
 *  - `qrVerified = false` (Remote real-time push without camera):
 *      2-party ECDH P-256 SAS -> Phone B sends ephemeral `pubB` (`offer`), both screens display
 *      the exact same 6-digit SAS code (`482-917`), user confirms match and approves!
 */
export function E2eeGrantApproveModal({
  open,
  grant = null, // { reqId, roomId, deviceName, clientKind, ip, pubKey, wantedKeyId, qrVerified?, qrPubKeyFp? }
  e2eeKeys = {},
  preferredKeyId = '',
  client = null,
  onDone = null,
  onClose = null,
}) {
  const { bi } = useI18n()
  const [step, setStep] = useState('prompt') // 'prompt' | 'sas' | 'sending' | 'done'
  const [sasCode, setSasCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pairRef = useRef(null)
  const closeTimerRef = useRef(null)
  const stepRef = useRef(step)
  stepRef.current = step
  const rejectedOrDoneRef = useRef(false)

  const grantReqId = grant?.reqId || ''
  const qrVerified = Boolean(grant?.qrVerified)

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  useEffect(() => {
    clearCloseTimer()
    rejectedOrDoneRef.current = false
    if (!open || !grantReqId) {
      setStep('prompt')
      setSasCode('')
      setBusy(false)
      setError('')
      pairRef.current = null
      return
    }
    setStep('prompt')
    setSasCode('')
    setBusy(false)
    setError('')
    pairRef.current = null
    return () => {
      clearCloseTimer()
      if (stepRef.current === 'sas' && !rejectedOrDoneRef.current) {
        rejectedOrDoneRef.current = true
        try {
          client?.sendGrantReject?.({ reqId: grantReqId })
        } catch {}
      }
    }
  }, [open, grantReqId, client])

  if (!open || !grant) return null

  const normalizedKeys = {}
  for (const [keyId, key] of Object.entries(e2eeKeys || {})) {
    const cleanKid = String(keyId || '').trim().toLowerCase()
    if (cleanKid && typeof key === 'string' && key.length >= 42) {
      normalizedKeys[cleanKid] = key
    }
  }
  const keyEntries = Object.entries(normalizedKeys).map(([keyId, key]) => ({ keyId, key }))
  const wantedKid = String(grant.wantedKeyId || '').trim().toLowerCase()
  const prefKid = String(preferredKeyId || '').trim().toLowerCase()
  const hasWantedKey = !wantedKid || Boolean(normalizedKeys[wantedKid])
  const isDesktopRequester = grant.clientKind === 'desktop' || /desktop|桌面|mac|win/i.test(grant.deviceName || '')

  const handleReject = () => {
    clearCloseTimer()
    rejectedOrDoneRef.current = true
    try {
      client?.sendGrantReject?.({ reqId: grant.reqId })
    } catch {}
    onClose?.()
  }

  const handleDismiss = () => {
    clearCloseTimer()
    if (stepRef.current === 'sas' && !rejectedOrDoneRef.current && grant?.reqId) {
      rejectedOrDoneRef.current = true
      try {
        client?.sendGrantReject?.({ reqId: grant.reqId })
      } catch {}
    }
    onClose?.()
  }

  const handleStartSasVerification = async () => {
    if (busy || !client) return
    if (keyEntries.length === 0) {
      setError(bi('本设备暂无可同步的端到端密钥', 'This device has no E2EE keys to share.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const pair = await generateGrantKeyPair()
      pairRef.current = pair
      const sas = await deriveGrantSas({
        requesterPubKey: grant.pubKey,
        approverPubKey: pair.publicKeyRaw,
        reqId: grant.reqId,
        roomId: grant.roomId,
      })
      const sent = client.sendGrantOffer({
        reqId: grant.reqId,
        approverPubKey: pair.publicKeyRaw,
      })
      if (!sent) {
        throw new Error(bi('当前未连接到中转服务器，请稍后重试', 'Not connected to relay server.'))
      }
      setSasCode(sas)
      setStep('sas')
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const handleDeliverKeyring = async () => {
    if (busy || !client) return
    if (keyEntries.length === 0) {
      setError(bi('本设备暂无可同步的端到端密钥', 'This device has no E2EE keys to share.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      // For QR-verified path, double-check the 64-bit out-of-band public-key commitment right before encrypting
      if (qrVerified && grant.qrPubKeyFp) {
        const computedFp = await computeGrantPubKeyFp(grant.pubKey)
        if (computedFp !== String(grant.qrPubKeyFp).toLowerCase()) {
          throw new Error(
            bi(
              '安全校验失败：请求方公钥指纹与扫码内容不符，可能存在中间人篡改，已中止授权！',
              'Security mismatch: requester public key fingerprint does not match scanned QR code. Aborted.',
            ),
          )
        }
      }

      const pair = pairRef.current || (await generateGrantKeyPair())
      pairRef.current = pair
      const resolvedPreferred =
        (wantedKid && normalizedKeys[wantedKid] ? wantedKid : '') ||
        (prefKid && normalizedKeys[prefKid] ? prefKid : '') ||
        keyEntries[0]?.keyId ||
        ''

      const envelope = await encryptGrantPayload({
        approverPrivateKey: pair.privateKey,
        approverPubKeyRaw: pair.publicKeyRaw,
        requesterPubKeyRaw: grant.pubKey,
        reqId: grant.reqId,
        roomId: grant.roomId,
        payload: {
          keys: keyEntries,
          preferredKeyId: resolvedPreferred,
          sentAt: Date.now(),
        },
      })
      setStep('sending')
      const sent = client.sendGrantDeliver({ reqId: grant.reqId, envelope })
      if (!sent) {
        throw new Error(bi('发送授权密文失败，请检查网络连接', 'Failed to deliver encrypted keyring.'))
      }
      rejectedOrDoneRef.current = true
      setStep('done')
      onDone?.(grant)
      clearCloseTimer()
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        onClose?.()
      }, 900)
    } catch (err) {
      setStep(qrVerified ? 'prompt' : 'sas')
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={handleDismiss}
    >
      <div
        className="pb-safe w-full max-w-sm rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl dark:bg-[#1B1D23]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                step === 'done'
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : qrVerified
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-[#4D6BFE]/15 text-[#4D6BFE]'
              }`}
            >
              {step === 'done' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : isDesktopRequester ? (
                <Monitor className="h-5 w-5" />
              ) : (
                <Smartphone className="h-5 w-5" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-[15px] font-bold text-slate-900 dark:text-white">
                {step === 'done'
                  ? bi('已授权同步', 'Authorized')
                  : bi('授权新设备', 'Authorize New Device')}
              </h3>
              {qrVerified && step !== 'done' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="h-3 w-3" />
                  <span>{bi('扫码已验证', 'QR Verified')}</span>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={bi('关闭', 'Close')}
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Requester summary card */}
        <div className="mt-4 space-y-1.5 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3 text-xs dark:border-slate-800 dark:bg-[#14171F]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400">{bi('设备', 'Device')}</span>
            <span className="font-semibold text-slate-900 dark:text-white">
              {grant.deviceName || bi('未知设备', 'Unknown Device')}
            </span>
          </div>
          {grant.ip && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">{bi('来源 IP', 'IP')}</span>
              <span className="font-mono text-[11.5px] text-slate-700 dark:text-slate-300">{grant.ip}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400">{bi('同步密钥', 'Keys')}</span>
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {bi(`${keyEntries.length} 把`, `${keyEntries.length}`)}
            </span>
          </div>
          {grant.wantedKeyId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">{bi('目标指纹', 'Fingerprint')}</span>
              <span className={`font-mono text-[11px] font-semibold ${hasWantedKey ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500'}`}>
                {formatE2eeFingerprint(grant.wantedKeyId)}
              </span>
            </div>
          )}
        </div>

        {!hasWantedKey && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              {bi(
                '本设备暂未存有该目标指纹，仅同步已有密钥。',
                'This device lacks that fingerprint; only existing keys will be synced.',
              )}
            </span>
          </div>
        )}

        {step === 'sas' && sasCode && (
          <div className="mt-3.5 rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] px-4 py-3.5 text-center dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]">
            <div className="text-[11.5px] font-medium text-slate-600 dark:text-slate-300">
              {bi('核对新设备上的 6 位安全码', 'Match 6-digit code on new device')}
            </div>
            <div className="mt-1.5 font-mono text-3xl font-extrabold tracking-[0.22em] text-[#2842C9] dark:text-white">
              {sasCode.replace('-', ' · ')}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </div>
        )}

        {/* Actions */}
        {step === 'done' ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 py-2.5 text-center text-xs font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            {bi('已授权同步', 'Authorized')}
          </div>
        ) : qrVerified ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleReject}
              className="rounded-2xl border border-slate-200 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {bi('拒绝', 'Decline')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDeliverKeyring}
              className="flex items-center justify-center gap-1.5 rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span>{bi('确认授权', 'Approve')}</span>
            </button>
          </div>
        ) : step === 'prompt' ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleReject}
              className="rounded-2xl border border-slate-200 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {bi('拒绝', 'Decline')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleStartSasVerification}
              className="flex items-center justify-center gap-1.5 rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span>{bi('验证授权', 'Verify')}</span>
            </button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleReject}
              className="rounded-2xl border border-rose-200 py-2.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-950/30"
            >
              {bi('不符 · 拒绝', 'Mismatch')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDeliverKeyring}
              className="flex items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-sm shadow-emerald-600/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              <span>{bi('确认一致', 'Confirm Match')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
