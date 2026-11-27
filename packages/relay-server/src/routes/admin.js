import { buildAdminOverview, collectServerHealth } from '../admin-monitor.js'
import { readJsonObjectBody, sendJson, sendRouteError } from '../http-utils.js'

/**
 * Modular Admin API route handler (`/api/admin/*`) with uniform admin auth,
 * per-admin action rate-limiting, plain-object JSON validation, and structured error handling.
 */
export function createAdminRoutes({
  requireAdmin,
  checkUserActionRateLimit,
  getClientIp,
  accounts,
  hub,
  mailer,
  stunServer,
  turnSecret,
  turnPort,
  turnTtlSec,
  turnLogFile,
  turnMeter,
  turnQuotaConfig,
  cfTurn,
  maxDailyRegistrations,
  startedAt,
  relayVersion,
  extractPublicHostname,
  buildUserTurnQuota,
  buildUserTurnQuotaReadOnly = buildUserTurnQuota,
  log = console,
}) {
  async function handleAdminRoute(req, res, pathname) {
    if (!pathname.startsWith('/api/admin/')) return false

    const payload = requireAdmin(req, res)
    if (!payload) return true

    const rateKey = req.method === 'GET' ? 'admin-read' : 'admin-write'
    const rateLimit = req.method === 'GET' ? 60 : 30
    if (!checkUserActionRateLimit(rateKey, payload.room, rateLimit)) {
      sendJson(res, 429, { ok: false, error: '管理接口请求过于频繁，请稍后再试' })
      return true
    }

    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      const dailyRegistration = accounts.getDailyRegistrationStats(maxDailyRegistrations)
      const meterStats = turnMeter?.getStats?.() || null
      const serverHealth = collectServerHealth({
        mailer,
        stun: stunServer?.getStats?.() || null,
        turn: {
          enabled: Boolean((turnSecret && extractPublicHostname(req)) || cfTurn.enabled),
          host: extractPublicHostname(req) || '',
          port: turnSecret ? turnPort : 0,
          ttlSec: turnTtlSec,
          meteringEnabled: Boolean(turnLogFile),
          meteringHealthy: meterStats ? meterStats.healthy : !turnLogFile,
          meteringError: meterStats?.lastError || '',
          cloudflare: cfTurn.getStats(),
          quotas: {
            freeMb: turnQuotaConfig.freeMb,
            proMb: turnQuotaConfig.proMb,
            ultraMb: turnQuotaConfig.ultraMb,
            adminMb: turnQuotaConfig.adminMb,
          },
        },
        dailyRegistration,
        startedAt,
        version: relayVersion,
      })
      const overview = buildAdminOverview({
        accounts,
        hub,
        serverHealth,
        dailyRegistration,
        getTurnQuota: (uid, user) => buildUserTurnQuotaReadOnly(user || uid),
        currentAdminRoom: payload.room || '',
        currentAdminSid: payload.sid || '',
      })
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, overview)
      return true
    }

    if (pathname === '/api/admin/users/set-tier' && req.method === 'POST') {
      try {
        const body = await readJsonObjectBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        const targetTier = String(body.tier || '').trim().toLowerCase()
        if (!targetRoom.startsWith('usr_') || !targetTier) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或等级参数' })
          return true
        }
        const changed = accounts.setUserTier(targetRoom, targetTier, { actorUserId: payload.room })
        if (!changed.ok) {
          sendJson(res, 400, { ok: false, error: changed.error })
          return true
        }
        const turnQuota = buildUserTurnQuota(targetRoom)
        hub.pushIceUpdate(targetRoom, { quotaExceeded: Boolean(turnQuota?.exceeded) })
        hub.recordActivity({
          type: 'admin.tier',
          roomId: targetRoom,
          label: `@${changed.user.username}`,
          detail: `${String(changed.prevTier || 'free').toUpperCase()} -> ${String(changed.tier).toUpperCase()}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, user: changed.user, tier: changed.tier, turnQuota })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    if (pathname === '/api/admin/users/reset-turn-usage' && req.method === 'POST') {
      try {
        const body = await readJsonObjectBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        if (!targetRoom.startsWith('usr_')) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户标识' })
          return true
        }
        const reset = accounts.resetTurnUsage(targetRoom)
        if (!reset.ok) {
          sendJson(res, 404, { ok: false, error: reset.error })
          return true
        }
        const turnQuota = buildUserTurnQuota(targetRoom)
        hub.pushIceUpdate(targetRoom, { quotaExceeded: false })
        hub.recordActivity({
          type: 'admin.quota_reset',
          roomId: targetRoom,
          label: `@${reset.user.username}`,
          detail: `Monthly TURN usage reset (${reset.turnUsage.month})`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, user: reset.user, turnQuota })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    if (pathname === '/api/admin/users/kick-session' && req.method === 'POST') {
      try {
        const body = await readJsonObjectBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        const targetSid = String(body.sid || '').trim()
        const targetClientId = String(body.clientId || '').trim()
        if (!targetRoom.startsWith('usr_') || (!targetSid && !targetClientId)) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或会话标识' })
          return true
        }
        if (targetRoom === payload.room && targetSid && payload.sid && targetSid === payload.sid) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前正在使用的管理员会话' })
          return true
        }
        const revokedPermanent = targetSid ? accounts.revokeUserSession(targetRoom, targetSid) : false
        const kickedConnections = hub.disconnectClient(
          targetRoom,
          { clientId: targetClientId, sid: targetSid },
          4401,
          'Session revoked by admin',
        )
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin revoked session (${kickedConnections} live)`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, revokedPermanent, kickedConnections })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    if (pathname === '/api/admin/users/revoke-all' && req.method === 'POST') {
      try {
        const body = await readJsonObjectBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        if (!targetRoom.startsWith('usr_')) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户标识' })
          return true
        }
        if (targetRoom === payload.room) {
          sendJson(res, 400, { ok: false, error: '不能在监控面板强制下线当前管理员自身' })
          return true
        }
        const revoked = accounts.revokeUserTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '找不到目标用户' })
          return true
        }
        const disconnectedClients = hub.disconnectRoomClients(targetRoom, 4401, 'All sessions revoked by admin')
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin signed out all terminals (${disconnectedClients} live)`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, {
          ok: true,
          roomId: revoked.roomId,
          tokenVersion: revoked.tokenVersion,
          disconnectedClients,
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    if (pathname === '/api/admin/bridges/disconnect' && req.method === 'POST') {
      try {
        const body = await readJsonObjectBody(req)
        const targetRoom = String(body.roomId || body.userId || '').trim()
        const targetBridgeId = String(body.bridgeId || '').trim()
        if (!targetRoom.startsWith('usr_') || !targetBridgeId) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或桥接标识' })
          return true
        }
        const disconnected = hub.disconnectBridge(targetRoom, targetBridgeId, 4000, 'Disconnected by admin')
        if (!disconnected) {
          sendJson(res, 404, { ok: false, error: '该电脑桥接当前不在线' })
          return true
        }
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin disconnected bridge ${targetBridgeId}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, disconnected })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    return false
  }

  return { handleAdminRoute }
}
