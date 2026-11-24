/**
 * Zero-dependency per-room sliding-window traffic & upload rate guard for AllinOne Relay Server.
 *
 * Prevents a compromised or abusive account from exhausting the server's monthly bandwidth
 * or saturating public egress via repeated WS FILE_READ transfers or /api/uploads loops,
 * while remaining completely invisible to normal daily usage:
 *  - Default 10-minute burst quota: 120 MB per account room
 *  - Default 24-hour daily quota:   500 MB per account room
 *  - Default /api/uploads rate:      20 uploads / minute per account room
 *  - Admin accounts are exempted from blocking by default (still metered for visibility)
 *  - Normal small text chat (< 256 KB) stays online unless a room exceeds 2x quota (hard kick)
 */

const MINUTE_MS = 60_000
const BURST_WINDOW_MINUTES = 10
const DAILY_WINDOW_MINUTES = 24 * 60
const MAX_TRACKED_ROOMS = 2000
const LARGE_FRAME_THRESHOLD_BYTES = 256 * 1024

function parseNonNegativeMb(raw, fallbackMb) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallbackMb * 1024 * 1024
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallbackMb * 1024 * 1024
  return Math.floor(n * 1024 * 1024)
}

function parseNonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

export function formatBytesShort(bytes) {
  const n = Number(bytes || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export class RelayTrafficGuard {
  constructor({
    burstLimitBytes = parseNonNegativeMb(process.env.RELAY_ROOM_TRAFFIC_10M_MB, 120),
    dailyLimitBytes = parseNonNegativeMb(process.env.RELAY_ROOM_TRAFFIC_DAY_MB, 500),
    uploadMaxPerMinute = parseNonNegativeInt(process.env.RELAY_ROOM_UPLOAD_PER_MIN, 20),
    adminExempt = String(process.env.RELAY_ADMIN_TRAFFIC_EXEMPT ?? 'true').toLowerCase() !== 'false',
    largeFrameThresholdBytes = LARGE_FRAME_THRESHOLD_BYTES,
    hardDisconnectMultiplier = 2,
    nowFn = () => Date.now(),
  } = {}) {
    this.burstLimitBytes = Math.max(0, Number(burstLimitBytes) || 0)
    this.dailyLimitBytes = Math.max(0, Number(dailyLimitBytes) || 0)
    this.uploadMaxPerMinute = Math.max(0, Number(uploadMaxPerMinute) || 0)
    this.adminExempt = Boolean(adminExempt)
    this.largeFrameThresholdBytes = Math.max(1024, Number(largeFrameThresholdBytes) || LARGE_FRAME_THRESHOLD_BYTES)
    this.hardDisconnectMultiplier = Math.max(1.2, Number(hardDisconnectMultiplier) || 2)
    this.nowFn = nowFn

    /**
     * @type {Map<string, {
     *   minuteBuckets: Map<number, number>,
     *   uploadTimestamps: number[],
     *   totalBytes: number,
     *   throttledCount: number,
     *   lastTrafficAt: number,
     *   lastThrottledAt: number,
     * }>}
     */
    this.rooms = new Map()
    this.totalThrottledCount = 0
  }

  getLimits() {
    return {
      burst10mBytes: this.burstLimitBytes,
      daily24hBytes: this.dailyLimitBytes,
      uploadPerMin: this.uploadMaxPerMinute,
      adminExempt: this.adminExempt,
    }
  }

  getOrCreateRoom(roomId) {
    const rid = String(roomId || '').trim()
    let rec = this.rooms.get(rid)
    if (!rec) {
      if (this.rooms.size >= MAX_TRACKED_ROOMS) {
        const oldestKey = this.rooms.keys().next().value
        if (oldestKey) this.rooms.delete(oldestKey)
      }
      rec = {
        minuteBuckets: new Map(),
        uploadTimestamps: [],
        totalBytes: 0,
        throttledCount: 0,
        lastTrafficAt: 0,
        lastThrottledAt: 0,
      }
      this.rooms.set(rid, rec)
    } else {
      // Touch LRU order
      this.rooms.delete(rid)
      this.rooms.set(rid, rec)
    }
    return rec
  }

  pruneAndSum(rec, now) {
    const currentMin = Math.floor(now / MINUTE_MS)
    const minDaily = currentMin - DAILY_WINDOW_MINUTES + 1
    const minBurst = currentMin - BURST_WINDOW_MINUTES + 1
    let bytes10m = 0
    let bytes24h = 0
    for (const [mKey, val] of rec.minuteBuckets.entries()) {
      if (mKey < minDaily) {
        rec.minuteBuckets.delete(mKey)
        continue
      }
      bytes24h += val
      if (mKey >= minBurst) {
        bytes10m += val
      }
    }
    const cutoffUpload = now - MINUTE_MS
    while (rec.uploadTimestamps.length > 0 && rec.uploadTimestamps[0] <= cutoffUpload) {
      rec.uploadTimestamps.shift()
    }
    return { currentMin, bytes10m, bytes24h }
  }

  /**
   * Check and record an HTTP POST /api/uploads attempt (count rate limit + byte quota).
   */
  consumeUploadPost(roomId, bytes, { isAdmin = false } = {}) {
    const rid = String(roomId || '').trim()
    const size = Math.max(0, Number(bytes) || 0)
    const now = this.nowFn()
    const rec = this.getOrCreateRoom(rid)
    const { currentMin, bytes10m, bytes24h } = this.pruneAndSum(rec, now)
    const exempt = Boolean(isAdmin && this.adminExempt)

    if (!exempt && this.uploadMaxPerMinute > 0 && rec.uploadTimestamps.length >= this.uploadMaxPerMinute) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      const oldest = rec.uploadTimestamps[0] || now
      const retryAfterSec = Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000))
      return {
        allowed: false,
        code: 'UPLOAD_RATE_LIMIT',
        retryAfterSec,
        message: `上传过于频繁（每分钟最多 ${this.uploadMaxPerMinute} 次），请 ${retryAfterSec} 秒后重试`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h),
      }
    }

    const quotaCheck = this.evaluateByteQuota(rec, bytes10m, bytes24h, size, { exempt, now })
    if (!quotaCheck.allowed) {
      return quotaCheck
    }

    rec.uploadTimestamps.push(now)
    rec.minuteBuckets.set(currentMin, (rec.minuteBuckets.get(currentMin) || 0) + size)
    rec.totalBytes += size
    rec.lastTrafficAt = now
    return {
      allowed: true,
      usage: this.buildRoomUsage(rec, bytes10m + size, bytes24h + size),
    }
  }

  /**
   * Check and record an HTTP GET /api/uploads/<id> download.
   */
  consumeUploadGet(roomId, bytes, { isAdmin = false } = {}) {
    return this.consumeBytes(roomId, bytes, { isAdmin, strictBlock: true })
  }

  /**
   * Check and record WebSocket traffic bytes.
   * - If `strictBlock` is true (e.g. large WS frame > 256 KB or HTTP download), reject as soon as
   *   burst (10m) or daily (24h) quota is exceeded.
   * - If `strictBlock` is false (small control/text chat frame), allow normal chat to stay alive
   *   until 2x quota (`hardKick: true`), preventing malicious flood scripts from abusing small frames.
   */
  consumeBytes(roomId, bytes, { isAdmin = false, strictBlock = null } = {}) {
    const rid = String(roomId || '').trim()
    const size = Math.max(0, Number(bytes) || 0)
    const now = this.nowFn()
    const rec = this.getOrCreateRoom(rid)
    const { currentMin, bytes10m, bytes24h } = this.pruneAndSum(rec, now)
    const exempt = Boolean(isAdmin && this.adminExempt)
    const enforceBlock = strictBlock === null ? size >= this.largeFrameThresholdBytes : Boolean(strictBlock)

    const quotaCheck = this.evaluateByteQuota(rec, bytes10m, bytes24h, size, {
      exempt,
      now,
      enforceBlock,
    })
    if (!quotaCheck.allowed) {
      return quotaCheck
    }

    if (size > 0) {
      rec.minuteBuckets.set(currentMin, (rec.minuteBuckets.get(currentMin) || 0) + size)
      rec.totalBytes += size
      rec.lastTrafficAt = now
    }
    return {
      allowed: true,
      hardKick: false,
      usage: this.buildRoomUsage(rec, bytes10m + size, bytes24h + size),
    }
  }

  evaluateByteQuota(rec, bytes10m, bytes24h, incomingBytes, { exempt = false, now = Date.now(), enforceBlock = true } = {}) {
    if (exempt) return { allowed: true, hardKick: false }

    const projected10m = bytes10m + incomingBytes
    const projected24h = bytes24h + incomingBytes

    const hardBurst = this.burstLimitBytes > 0 && projected10m > this.burstLimitBytes * this.hardDisconnectMultiplier
    const hardDaily = this.dailyLimitBytes > 0 && projected24h > this.dailyLimitBytes * this.hardDisconnectMultiplier
    if (hardBurst || hardDaily) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: true,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        retryAfterSec: hardBurst ? 600 : 3600,
        message: hardBurst
          ? `当前 10 分钟传输流量已大幅超限（上限 ${formatBytesShort(this.burstLimitBytes)}），连接已临时限制`
          : `今日传输流量已大幅超限（每日上限 ${formatBytesShort(this.dailyLimitBytes)}），连接已临时限制`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h),
      }
    }

    if (!enforceBlock) {
      return { allowed: true, hardKick: false }
    }

    if (this.burstLimitBytes > 0 && projected10m > this.burstLimitBytes) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: false,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        retryAfterSec: 300,
        message: `近 10 分钟文件传输流量已达上限（${formatBytesShort(this.burstLimitBytes)}），请稍后再试（文字聊天不受影响）`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h),
      }
    }

    if (this.dailyLimitBytes > 0 && projected24h > this.dailyLimitBytes) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: false,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        retryAfterSec: 3600,
        message: `今日文件传输流量已达上限（${formatBytesShort(this.dailyLimitBytes)}），请明日再试（文字聊天不受影响）`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h),
      }
    }

    return { allowed: true, hardKick: false }
  }

  buildRoomUsage(rec, bytes10m, bytes24h) {
    return {
      bytes10m,
      bytes24h,
      totalBytes: rec.totalBytes,
      throttledCount: rec.throttledCount,
      lastTrafficAt: rec.lastTrafficAt,
      lastThrottledAt: rec.lastThrottledAt,
      limit10mBytes: this.burstLimitBytes,
      limit24hBytes: this.dailyLimitBytes,
    }
  }

  getRoomUsage(roomId) {
    const rid = String(roomId || '').trim()
    const rec = this.rooms.get(rid)
    if (!rec) {
      return {
        bytes10m: 0,
        bytes24h: 0,
        totalBytes: 0,
        throttledCount: 0,
        lastTrafficAt: 0,
        lastThrottledAt: 0,
        limit10mBytes: this.burstLimitBytes,
        limit24hBytes: this.dailyLimitBytes,
      }
    }
    const { bytes10m, bytes24h } = this.pruneAndSum(rec, this.nowFn())
    return this.buildRoomUsage(rec, bytes10m, bytes24h)
  }

  getGlobalSummary() {
    const now = this.nowFn()
    let totalBytes10m = 0
    let totalBytes24h = 0
    let totalBytesLifetime = 0
    for (const rec of this.rooms.values()) {
      const { bytes10m, bytes24h } = this.pruneAndSum(rec, now)
      totalBytes10m += bytes10m
      totalBytes24h += bytes24h
      totalBytesLifetime += rec.totalBytes
    }
    return {
      totalBytes10m,
      totalBytes24h,
      totalBytesLifetime,
      totalThrottledCount: this.totalThrottledCount,
      limits: this.getLimits(),
    }
  }
}
