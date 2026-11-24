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

  const grantReqId = grant?.reqId || ''
  const qrVerified = Boolean(grant?.qrVerified)

  useEffect(() => {
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
  }, [open, grantReqId])

  if (!open || !grant) return null

  const keyEntries = Object.entries(e2eeKeys || {})
    .filter(([, k]) => typeof k === 'string' && k.length >= 42)
    .map(([keyId, key]) => ({ keyId, key }))
  const hasWantedKey = !grant.wantedKeyId || Boolean(e2eeKeys?.[grant.wantedKeyId])
  const isDesktopRequester = grant.clientKind === 'desktop' || /desktop|桌面|mac|win/i.test(grant.deviceName || '')

  const handleReject = () => {
    try {
      client?.sendGrantReject?.({ reqId: grant.reqId })
    } catch {}
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
        (grant.wantedKeyId && e2eeKeys?.[grant.wantedKeyId] ? grant.wantedKeyId : '') ||
        (preferredKeyId && e2eeKeys?.[preferredKeyId] ? preferredKeyId : '') ||
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
      setStep('done')
      onDone?.(grant)
      setTimeout(() => {
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
      onClick={onClose}
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
            <div>
              <h3 className="text-[15px] font-bold text-slate-900 dark:text-white">
                {step === 'done'
                  ? bi('已安全授权并同步密钥', 'Authorized & Synced')
                  : bi('新设备请求同步加密密钥', 'New Device Requests E2EE Key')}
              </h3>
              <p className="text-[11.5px] text-slate-500 dark:text-slate-400">
                {bi('零知识端到端移交 · 服务器不可见', 'Zero-knowledge ECDH handoff')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={bi('关闭', 'Close')}
            className="rounded-xl p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Requester summary card */}
        <div className="mt-4 space-y-1.5 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3 text-xs dark:border-slate-800 dark:bg-[#14171F]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400">{bi('请求设备', 'Device')}</span>
            <span className="font-semibold text-slate-900 dark:text-white">
              {grant.deviceName || bi('未知设备', 'Unknown Device')}
            </span>
          </div>
          {grant.ip && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">{bi('来源 IP', 'IP Address')}</span>
              <span className="font-mono text-[11.5px] text-slate-700 dark:text-slate-300">{grant.ip}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400">{bi('同步范围', 'Scope')}</span>
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {bi(`账号下 ${keyEntries.length} 把端到端密钥`, `${keyEntries.length} E2EE key(s) in keyring`)}
            </span>
          </div>
          {grant.wantedKeyId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500 dark:text-slate-400">{bi('目标指纹', 'Requested Key')}</span>
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
                '提示：本设备暂未包含对方请求的指纹，但仍可将本设备已有的密钥同步给对方。',
                'Note: this device does not hold that specific fingerprint, but can still sync its existing keys.',
              )}
            </span>
          </div>
        )}

        {/* QR verified badge OR 6-digit SAS code box */}
        {qrVerified && step !== 'done' && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl border border-emerald-200/80 bg-emerald-50/80 px-3.5 py-2.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/35 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
            <span>
              {bi(
                '已通过二维码验证对方设备公钥指纹，防中间人校验通过，可直接一键授权。',
                'Device public key verified via QR code. Safe to approve in one tap.',
              )}
            </span>
          </div>
        )}

        {step === 'sas' && sasCode && (
          <div className="mt-3.5 rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] px-4 py-3.5 text-center dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]">
            <div className="text-[11.5px] font-medium text-slate-600 dark:text-slate-300">
              {bi('请核对新设备屏幕上的 6 位安全码是否完全一致', 'Confirm this 6-digit code matches the new device')}
            </div>
            <div className="mt-1.5 font-mono text-3xl font-extrabold tracking-[0.22em] text-[#2842C9] dark:text-white">
              {sasCode.replace('-', ' · ')}
            </div>
            <div className="mt-1 text-[10.5px] text-slate-500 dark:text-slate-400">
              {bi('若数字不一致或非本人操作，请立即点拒绝', 'Reject immediately if codes differ or you did not initiate this')}
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
            {bi('✓ 加密密钥已安全移交，新设备已解锁', '✓ Encrypted keyring delivered')}
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
              <span>{bi('确认授权并同步', 'Approve & Sync')}</span>
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
              {bi('不是本人 · 拒绝', 'Not Me · Reject')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleStartSasVerification}
              className="flex items-center justify-center gap-1.5 rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white shadow-sm shadow-[#4D6BFE]/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span>{bi('验证并授权', 'Verify & Approve')}</span>
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
              {bi('不符 · 拒绝', 'Mismatch · Reject')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDeliverKeyring}
              className="flex items-center justify-center gap-1.5 rounded-2xl bg-emerald-600 py-2.5 text-xs font-semibold text-white shadow-sm shadow-emerald-600/25 transition active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              <span>{bi('安全码一致，同步', 'Codes Match · Sync')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
