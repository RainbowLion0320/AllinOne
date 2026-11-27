import { readJsonObjectBody, sendJson, sendRouteError } from '../http-utils.js'

export function buildMergedAccountDevices(accounts, hub, roomId, liveBridges = null) {
  if (!String(roomId || '').startsWith('usr_')) return undefined
  const bound = accounts.listUserDevices(roomId)
  const live = liveBridges || hub.getBridgeList(roomId)
  const liveByBridgeId = new Map(live.map((b) => [b.bridgeId, b]))
  const merged = bound.map((dev) => {
    const b = liveByBridgeId.get(dev.bridgeId)
    return {
      deviceId: dev.deviceId,
      bridgeId: dev.bridgeId,
      label: dev.label || b?.hostname || dev.hostname || dev.bridgeId,
      hostname: b?.hostname || dev.hostname || dev.bridgeId,
      platform: b?.platform || dev.platform || 'unknown',
      online: Boolean(b?.online),
      apps: b?.apps || [],
      e2ee: b?.e2ee || null,
      mode: b?.mode || 'portable',
      connectedAt: b?.connectedAt || 0,
      lastSeenAt: b?.lastSeen || dev.lastSeenAt || dev.createdAt || 0,
      createdAt: dev.createdAt || 0,
    }
  })
  // Online devices first, then most recently seen
  merged.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
  return merged
}

export function buildMergedClientSessions(accounts, hub, roomId, { currentSid = '', currentClientId = '' } = {}) {
  const rid = String(roomId || '').trim()
  const liveClients = hub.getClientList(rid)
  const persisted = accounts.listUserSessions(rid)
  const liveBySid = new Map()

  for (const c of liveClients) {
    if (!c.sid) continue
    const arr = liveBySid.get(c.sid) || []
    arr.push(c)
    liveBySid.set(c.sid, arr)
  }

  const sessions = []
  const seenSids = new Set()

  for (const p of persisted) {
    seenSids.add(p.sid)
    const conns = liveBySid.get(p.sid) || []
    const newestConn = conns[0] || null
    const isCurrent = Boolean(
      (currentSid && p.sid === currentSid) ||
      (currentClientId && conns.some((c) => c.clientId === currentClientId)),
    )
    sessions.push({
      sid: p.sid,
      clientId: newestConn?.clientId || '',
      clientIds: conns.map((c) => c.clientId),
      connectionCount: conns.length,
      deviceName: newestConn?.deviceName || p.deviceName || 'Web Client',
      clientKind: newestConn?.clientKind || p.clientKind || 'web',
      ip: newestConn?.ip || p.ip || '',
      online: conns.length > 0,
      isCurrent,
      createdAt: p.createdAt || newestConn?.connectedAt || 0,
      lastSeenAt: newestConn?.lastSeenAt || p.lastSeenAt || p.createdAt || 0,
    })
  }

  for (const [sid, conns] of liveBySid.entries()) {
    if (seenSids.has(sid)) continue
    const newestConn = conns[0]
    const isCurrent = Boolean(
      (currentSid && sid === currentSid) ||
      (currentClientId && conns.some((c) => c.clientId === currentClientId)),
    )
    sessions.push({
      sid,
      clientId: newestConn.clientId,
      clientIds: conns.map((c) => c.clientId),
      connectionCount: conns.length,
      deviceName: newestConn.deviceName || 'Web Client',
      clientKind: newestConn.clientKind || 'web',
      ip: newestConn.ip || '',
      online: true,
      isCurrent,
      createdAt: newestConn.connectedAt || 0,
      lastSeenAt: newestConn.lastSeenAt || newestConn.connectedAt || 0,
    })
  }

  sessions.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      Number(b.online) - Number(a.online) ||
      (b.lastSeenAt || 0) - (a.lastSeenAt || 0),
  )

  return {
    sessions,
    onlineCount: liveClients.length,
    onlineDeviceCount: sessions.filter((s) => s.online).length,
    totalCount: sessions.length,
  }
}

/**
 * Bound PC device & bridge status routes (`/api/account/device-status`, `/api/account/devices*`).
 */
export function createDeviceRoutes({
  auth,
  accounts,
  hub,
  extractBearer,
  checkUserActionRateLimit,
  getClientIp,
  authenticateBridgeInfo,
  getMergedAccountDevices,
  observeRequestHost = () => '',
  log = console,
}) {
  async function handleDeviceRoute(req, res, pathname, urlObj) {
    // Bridge-authenticated device status check
    if (pathname === '/api/account/device-status' && req.method === 'GET') {
      const ip = getClientIp(req)
      const requestedRoom = String(req.headers['x-room-id'] || urlObj.searchParams.get('roomId') || '').trim()
      const roomExists = Boolean(requestedRoom.startsWith('usr_') && accounts.getUserById(requestedRoom))
      if (!auth.checkBridgeRateLimit(ip, requestedRoom, { roomExists })) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      const info = authenticateBridgeInfo(req, urlObj)
      if (!info || !info.roomId.startsWith('usr_')) {
        auth.recordBridgeFailure(ip, requestedRoom, { recordRoom: roomExists })
        sendJson(res, 401, { ok: false, error: '电脑绑定凭证无效或已被解绑' })
        return true
      }
      // Clear ONLY the per-(ip, room) bucket — never reset the global IP failure counter
      if (requestedRoom) auth.clearBridgeFailure(ip, requestedRoom)
      observeRequestHost(req, info.roomId)
      sendJson(res, 200, {
        ok: true,
        userId: info.userId,
        username: info.username,
        deviceId: info.deviceId,
        bridgeId: info.bridgeId,
        label: info.label,
        devices: getMergedAccountDevices(info.roomId),
      })
      return true
    }

    // List all bound PCs for the authenticated account
    if (pathname === '/api/account/devices' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return true
      }
      if (!checkUserActionRateLimit('read', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      sendJson(res, 200, {
        ok: true,
        devices: getMergedAccountDevices(payload.room),
        bridges: hub.getBridgeList(payload.room),
      })
      return true
    }

    // Register / bind this PC using an authenticated account JWT
    if (pathname === '/api/account/devices/register' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        let bound
        try {
          bound = accounts.bindDevice({
            userId: payload.room,
            label: body.label || body.hostname || 'My PC',
            hostname: body.hostname || body.label || 'My-PC',
            platform: body.platform || 'unknown',
            bridgeId: body.bridgeId || '',
          })
        } catch (bindErr) {
          if (bindErr?.code === 'MAX_DEVICES_EXCEEDED') {
            sendJson(res, 400, { ok: false, error: String(bindErr.message) })
            return true
          }
          throw bindErr
        }
        if (!bound) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return true
        }
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          ...bound,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Rename a bound PC inside the authenticated user's account
    if (pathname === '/api/account/devices/rename' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const updated = accounts.renameUserDevice(payload.room, body.deviceId, body.label)
        if (!updated) {
          sendJson(res, 404, { ok: false, error: '找不到目标电脑或名称为空' })
          return true
        }
        hub.updateBridgeLabel(payload.room, updated.bridgeId, updated.label)
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          device: updated,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Unbind a PC from the authenticated user's account
    if (pathname === '/api/account/devices/remove' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const removed = accounts.removeUserDevice(payload.room, body.deviceId)
        if (!removed) {
          sendJson(res, 404, { ok: false, error: '找不到目标电脑' })
          return true
        }
        hub.disconnectBridge(payload.room, removed.bridgeId, 4401, 'Device unbound')
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          removed,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    return false
  }

  return { handleDeviceRoute }
}
