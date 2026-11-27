import { parseClientDeviceInfo } from '../hub.js'

/**
 * Pure control-plane WebSocket upgrade router (`/ws/bridge` and `/ws/client`)
 * with per-IP & global concurrent connection caps, origin CSWSH validation,
 * and per-(ip, room) bridge auth rate limiting.
 */
export function createWsUpgradeHandler({
  wss,
  auth,
  accounts,
  hub,
  ice,
  getClientIp,
  isAllowedOrigin,
  authenticateBridgeInfo,
  isDraining,
  maxWsPerIp = 120,
  maxWsGlobal = 10_000,
  log = console,
}) {
  let activeWsGlobal = 0
  const activeWsByIp = new Map()

  function tryAcquireWsSlot(ip) {
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    if (activeWsGlobal >= maxWsGlobal) {
      return { ok: false, statusLine: '503 Service Unavailable', release: null }
    }
    const curIp = activeWsByIp.get(cleanIp) || 0
    if (curIp >= maxWsPerIp) {
      return { ok: false, statusLine: '429 Too Many Requests', release: null }
    }
    activeWsGlobal += 1
    activeWsByIp.set(cleanIp, curIp + 1)
    let released = false
    return {
      ok: true,
      statusLine: '',
      release: () => {
        if (released) return
        released = true
        activeWsGlobal = Math.max(0, activeWsGlobal - 1)
        const next = (activeWsByIp.get(cleanIp) || 0) - 1
        if (next <= 0) activeWsByIp.delete(cleanIp)
        else activeWsByIp.set(cleanIp, next)
      },
    }
  }

  function handleUpgrade(req, socket, head) {
    const onUpgradeSocketError = () => {
      try { socket.destroy() } catch {}
    }
    socket.on('error', onUpgradeSocketError)

    const rejectUpgrade = (statusLine) => {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`)
        }
      } catch {}
      try { socket.destroy() } catch {}
    }

    if (isDraining()) {
      rejectUpgrade('503 Service Unavailable')
      return
    }

    let urlObj
    try {
      urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      rejectUpgrade('400 Bad Request')
      return
    }
    const pathname = urlObj.pathname

    if (pathname === '/ws/bridge') {
      const bridgeIp = getClientIp(req)
      const requestedRoom = String(req.headers['x-room-id'] || urlObj.searchParams.get('roomId') || '').trim()
      const roomExists = Boolean(requestedRoom.startsWith('usr_') && accounts.getUserById(requestedRoom))
      if (!auth.checkBridgeRateLimit(bridgeIp, requestedRoom, { roomExists })) {
        rejectUpgrade('429 Too Many Requests')
        return
      }
      if (!requestedRoom.startsWith('usr_')) {
        auth.recordBridgeFailure(bridgeIp, '', { recordRoom: false })
        rejectUpgrade('401 Unauthorized')
        return
      }
      const bridgeAuth = authenticateBridgeInfo(req, urlObj)
      if (!bridgeAuth) {
        auth.recordBridgeFailure(bridgeIp, requestedRoom, { recordRoom: roomExists })
        rejectUpgrade('401 Unauthorized')
        return
      }
      // Clear ONLY the per-(ip, room) bucket — never reset the global IP bridge failure counter
      auth.clearBridgeFailure(bridgeIp, requestedRoom)
      const slot = tryAcquireWsSlot(bridgeIp)
      if (!slot.ok) {
        rejectUpgrade(slot.statusLine)
        return
      }
      socket.once('close', slot.release)
      ice.observeRequestHost(req, bridgeAuth.roomId)
      const rawInitialKeyId = String(
        req.headers['x-e2ee-key-id'] || urlObj.searchParams.get('e2eeKeyId') || '',
      ).trim()
      const initialKeyId = /^[0-9a-f]{16}$/i.test(rawInitialKeyId) ? rawInitialKeyId.toLowerCase() : ''
      const meta = {
        roomId: bridgeAuth.roomId,
        bridgeId: String(bridgeAuth.bridgeId || urlObj.searchParams.get('bridgeId') || 'home-pc').trim().slice(0, 64) || 'home-pc',
        deviceId: String(bridgeAuth.deviceId || '').trim().slice(0, 64),
        label: String(bridgeAuth.label || '').trim().slice(0, 64),
        hostname: String(urlObj.searchParams.get('hostname') || bridgeAuth.hostname || 'PC').trim().slice(0, 64) || 'PC',
        platform: String(urlObj.searchParams.get('platform') || bridgeAuth.platform || 'win32').trim().slice(0, 32) || 'win32',
        mode: String(urlObj.searchParams.get('mode') || 'desktop').trim().slice(0, 32) || 'desktop',
        ...(initialKeyId ? { e2ee: { enabled: true, v: 1, keyId: initialKeyId } } : {}),
        ip: bridgeIp,
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener('error', onUpgradeSocketError)
        ws.once('close', slot.release)
        hub.registerBridge(ws, meta, { req })
      })
      return
    }

    if (pathname === '/ws/client') {
      if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
        rejectUpgrade('403 Forbidden')
        return
      }
      const clientIp = getClientIp(req)
      const slot = tryAcquireWsSlot(clientIp)
      if (!slot.ok) {
        rejectUpgrade(slot.statusLine)
        return
      }
      const ticket = String(urlObj.searchParams.get('ticket') || '').trim()
      const user = ticket ? auth.consumeWsTicket(ticket) : null
      if (!user) {
        slot.release()
        rejectUpgrade('401 Unauthorized')
        return
      }
      socket.once('close', slot.release)
      ice.observeRequestHost(req, user.room)
      const clientUa = String(req.headers['user-agent'] || '')
      const devInfo = parseClientDeviceInfo(user.dev || '', clientUa, user.kind || '')
      try {
        accounts.touchUserSession(user.room, user.sid, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip: clientIp,
        })
      } catch (err) {
        log.warn(`[control] Failed to persist touchUserSession on WS upgrade: ${err?.message || err}`)
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener('error', onUpgradeSocketError)
        ws.once('close', slot.release)
        hub.registerClient(ws, user, { ip: clientIp, userAgent: clientUa, req })
      })
      return
    }

    rejectUpgrade('404 Not Found')
  }

  return {
    handleUpgrade,
    getActiveWsCount: () => activeWsGlobal,
  }
}
