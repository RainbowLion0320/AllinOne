import { useCallback } from 'react'
import { computeGrantPubKeyFp, formatE2eeFingerprint } from '@allinone/shared/e2ee'
import { clearE2eeMediaCache } from '../lib/e2eeMedia.js'
import { upsertDeviceE2eeKey } from '../lib/deviceStore.js'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

/**
 * E2EE key management & grant QR scanning actions.
 *
 * Always reads live `activeDeviceRef.current` across `await` boundaries so switching
 * accounts or devices mid-operation never writes keys into the wrong device entry.
 */
export function useE2eeActions({
  activeDeviceRef,
  clientRef,
  desktopApi,
  setDeviceState,
  setDesktopBridge,
  setPendingGrantPopup,
  showToast,
}) {
  const handleImportE2eeKey = useCallback(
    async (rawKey, keyId, { applyToDesktopBridge = false } = {}) => {
      const startDev = activeDeviceRef.current
      if (!startDev?.id || !rawKey || !keyId) return
      const targetDeviceId = startDev.id
      const targetRoomId = startDev.roomId || ''

      let finalKey = rawKey
      let finalKeyId = String(keyId).trim().toLowerCase()
      if (applyToDesktopBridge && desktopApi?.setE2eeKey && targetRoomId) {
        const res = await desktopApi.setE2eeKey(targetRoomId, rawKey)
        if (res?.key && res?.keyId) {
          finalKey = res.key
          finalKeyId = String(res.keyId).trim().toLowerCase()
        }
        const st = await desktopApi.getBridgeStatus?.().catch(() => null)
        if (st) setDesktopBridge(st)
      }

      const liveDev = activeDeviceRef.current
      if (liveDev?.id === targetDeviceId) {
        clientRef.current?.setE2eeKeys({
          ...(liveDev.e2eeKeys || {}),
          [finalKeyId]: finalKey,
        })
      }
      setDeviceState((prev) => upsertDeviceE2eeKey(prev, targetDeviceId, finalKeyId, finalKey))
      showToast(
        biLang(
          getCurrentLang(),
          `端到端密钥已同步 (${formatE2eeFingerprint(finalKeyId).slice(0, 9)})`,
          `E2EE key synced (${formatE2eeFingerprint(finalKeyId).slice(0, 9)})`,
        ),
      )
    },
    [activeDeviceRef, clientRef, desktopApi, setDeviceState, setDesktopBridge, showToast],
  )

  const handleImportE2eeKeyring = useCallback(
    async (entries = [], preferredKeyId = '', { applyToDesktopBridge = false, approverName = '' } = {}) => {
      const startDev = activeDeviceRef.current
      if (!startDev?.id || !Array.isArray(entries) || entries.length === 0) return
      const targetDeviceId = startDev.id
      const targetRoomId = startDev.roomId || ''
      const validEntries = entries
        .filter((e) => e?.keyId && e?.key)
        .map((e) => ({ keyId: String(e.keyId).trim().toLowerCase(), key: e.key }))
      if (validEntries.length === 0) return

      const normPreferred = String(preferredKeyId || '').trim().toLowerCase()
      const preferred = validEntries.find((e) => e.keyId === normPreferred) || validEntries[0]

      let desktopKeyEntry = null
      if (applyToDesktopBridge && desktopApi?.setE2eeKey && targetRoomId && preferred?.key) {
        const res = await desktopApi.setE2eeKey(targetRoomId, preferred.key)
        if (res?.key && res?.keyId) {
          const desktopKid = String(res.keyId).trim().toLowerCase()
          desktopKeyEntry = { keyId: desktopKid, key: res.key }
        }
        const st = await desktopApi.getBridgeStatus?.().catch(() => null)
        if (st) setDesktopBridge(st)
      }

      const liveDev = activeDeviceRef.current
      if (liveDev?.id === targetDeviceId) {
        const nextKeys = { ...(liveDev.e2eeKeys || {}) }
        for (const item of validEntries) {
          delete nextKeys[item.keyId]
          nextKeys[item.keyId] = item.key
        }
        if (desktopKeyEntry) {
          delete nextKeys[desktopKeyEntry.keyId]
          nextKeys[desktopKeyEntry.keyId] = desktopKeyEntry.key
        }
        clientRef.current?.setE2eeKeys(nextKeys)
      }

      setDeviceState((prev) => {
        let next = prev
        for (const item of validEntries) {
          next = upsertDeviceE2eeKey(next, targetDeviceId, item.keyId, item.key)
        }
        if (desktopKeyEntry) {
          next = upsertDeviceE2eeKey(next, targetDeviceId, desktopKeyEntry.keyId, desktopKeyEntry.key)
        }
        if (preferred?.keyId && preferred?.key) {
          next = upsertDeviceE2eeKey(next, targetDeviceId, preferred.keyId, preferred.key)
        }
        return next
      })

      showToast(
        approverName
          ? biLang(
              getCurrentLang(),
              `已通过「${approverName}」安全同步 ${validEntries.length} 把端到端密钥`,
              `Synced ${validEntries.length} E2EE key(s) via ${approverName}`,
            )
          : biLang(
              getCurrentLang(),
              `已安全同步 ${validEntries.length} 把端到端密钥`,
              `Synced ${validEntries.length} E2EE key(s)`,
            ),
      )
    },
    [activeDeviceRef, clientRef, desktopApi, setDeviceState, setDesktopBridge, showToast],
  )

  const handleScanGrantQr = useCallback(
    async (grantQr) => {
      if (!grantQr?.reqId || !grantQr?.pubKeyFp || !clientRef.current) return false
      const list = await clientRef.current.listGrantRequests(5000)
      const match = (Array.isArray(list) ? list : []).find((g) => g.reqId === grantQr.reqId)
      if (!match || !match.pubKey) return false
      const curRoomId = activeDeviceRef.current?.roomId || ''
      if (curRoomId && match.roomId && match.roomId !== curRoomId) {
        throw new Error(biLang(getCurrentLang(), '该授权请求属于其他账号', 'Grant request belongs to a different account'))
      }
      const computedFp = await computeGrantPubKeyFp(match.pubKey)
      if (computedFp !== String(grantQr.pubKeyFp).toLowerCase()) {
        throw new Error(
          biLang(
            getCurrentLang(),
            '安全校验失败：二维码公钥指纹不匹配，可能存在中间人攻击，已拒绝授权！',
            'Security verification failed: QR public key fingerprint mismatch!',
          ),
        )
      }
      setPendingGrantPopup({
        ...match,
        qrVerified: true,
        qrPubKeyFp: grantQr.pubKeyFp,
        qrGrantSecret: grantQr.grantSecret || '',
      })
      return true
    },
    [activeDeviceRef, clientRef, setPendingGrantPopup],
  )

  const handleRotateDesktopE2eeKey = useCallback(async () => {
    const startDev = activeDeviceRef.current
    if (!desktopApi?.rotateE2eeKey || !startDev?.id || !startDev?.roomId) return
    const targetDeviceId = startDev.id
    const targetRoomId = startDev.roomId
    const res = await desktopApi.rotateE2eeKey(targetRoomId)
    if (res?.key && res?.keyId) {
      const nextKid = String(res.keyId).trim().toLowerCase()
      const liveDev = activeDeviceRef.current
      if (liveDev?.id === targetDeviceId) {
        clientRef.current?.setE2eeKeys({
          ...(liveDev.e2eeKeys || {}),
          [nextKid]: res.key,
        })
      }
      setDeviceState((prev) => upsertDeviceE2eeKey(prev, targetDeviceId, nextKid, res.key))
    }
    const st = await desktopApi.getBridgeStatus?.().catch(() => null)
    if (st) setDesktopBridge(st)
    void clearE2eeMediaCache({ persistent: true, roomId: targetRoomId })
    showToast(biLang(getCurrentLang(), '已轮换端到端密钥并重启本机桥接', 'Rotated E2EE key and restarted local bridge'))
  }, [activeDeviceRef, clientRef, desktopApi, setDeviceState, setDesktopBridge, showToast])

  return {
    handleImportE2eeKey,
    handleImportE2eeKeyring,
    handleScanGrantQr,
    handleRotateDesktopE2eeKey,
  }
}
