import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod as chmodAsync, rename as renameAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Zero-dependency per-room tiered sliding-window & monthly traffic guard for AllinOne Relay Server.
 *
 * Four user tiers:
 *  - `free` (普通用户):
 *      - Calendar month quota:  1 GB / month (RELAY_ROOM_TRAFFIC_MONTH_MB, default 1024 MB, persisted to disk)
 *      - 24-hour daily quota:   500 MB (RELAY_ROOM_TRAFFIC_DAY_MB)
 *      - 10-minute burst quota: 120 MB (RELAY_ROOM_TRAFFIC_10M_MB)
 *      - /api/uploads rate:      20 uploads / minute (RELAY_ROOM_UPLOAD_PER_MIN)
 *  - `pro` (Pro 用户):
 *      - Calendar month quota:  5 GB / month (RELAY_PRO_TRAFFIC_MONTH_MB, default 5120 MB, persisted to disk)
 *      - 24-hour daily quota:   10x normal daily limit (default 5000 MB ≈ 5 GB / 24h)
 *      - 10-minute burst quota: 10x normal burst limit (default 1200 MB)
 *      - /api/uploads rate:      5x normal upload rate (default 100 / min)
 *  - `ultra` (Ultra 用户):
 *      - Unlimited traffic (still metered for /admin visibility; no admin privileges)
 *  - `admin` (管理员):
 *      - Unlimited traffic by default (still metered for /admin visibility)
 *
 * Normal small text chat (< 256 KB) stays online even after soft quota is reached,
 * and only triggers hard disconnect at 2x quota to stop automated flood scripts.
 */

const MINUTE_MS = 60_000
const BURST_WINDOW_MINUTES = 10
const DAILY_WINDOW_MINUTES = 24 * 60
const MAX_TRACKED_ROOMS = 2000
const LARGE_FRAME_THRESHOLD_BYTES = 256 * 1024
const DEFAULT_SAVE_DEBOUNCE_MS = 30_000

const VALID_TIERS = new Set(['free', 'pro', 'ultra', 'admin'])

function normalizeTier(raw, isAdmin = false) {
  const t = String(raw || '').trim().toLowerCase()
  if (VALID_TIERS.has(t)) return t
  return isAdmin ? 'admin' : 'free'
}

function formatYearMonth(ts) {
  const d = new Date(Number(ts) || Date.now())
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

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
    monthlyLimitBytes = parseNonNegativeMb(process.env.RELAY_ROOM_TRAFFIC_MONTH_MB, 1024),
    uploadMaxPerMinute = parseNonNegativeInt(process.env.RELAY_ROOM_UPLOAD_PER_MIN, 20),
    proMonthlyLimitBytes = parseNonNegativeMb(process.env.RELAY_PRO_TRAFFIC_MONTH_MB, 5120),
    proDailyMultiplier = 10,
    proBurstMultiplier = 10,
    proUploadRateMultiplier = 5,
    adminExempt = String(process.env.RELAY_ADMIN_TRAFFIC_EXEMPT ?? 'true').toLowerCase() !== 'false',
    largeFrameThresholdBytes = LARGE_FRAME_THRESHOLD_BYTES,
    hardDisconnectMultiplier = 2,
    stateFile = '',
    saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
    nowFn = () => Date.now(),
  } = {}) {
    this.burstLimitBytes = Math.max(0, Number(burstLimitBytes) || 0)
    this.dailyLimitBytes = Math.max(0, Number(dailyLimitBytes) || 0)
    this.monthlyLimitBytes = Math.max(0, Number(monthlyLimitBytes) || 0)
    this.uploadMaxPerMinute = Math.max(0, Number(uploadMaxPerMinute) || 0)
    this.proMonthlyLimitBytes = Math.max(0, Number(proMonthlyLimitBytes) || 0)
    this.proDailyMultiplier = Math.max(1, Number(proDailyMultiplier) || 10)
    this.proBurstMultiplier = Math.max(1, Number(proBurstMultiplier) || 10)
    this.proUploadRateMultiplier = Math.max(1, Number(proUploadRateMultiplier) || 5)
    this.adminExempt = Boolean(adminExempt)
    this.largeFrameThresholdBytes = Math.max(1024, Number(largeFrameThresholdBytes) || LARGE_FRAME_THRESHOLD_BYTES)
    this.hardDisconnectMultiplier = Math.max(1.2, Number(hardDisconnectMultiplier) || 2)
    this.stateFile = typeof stateFile === 'string' ? stateFile.trim() : ''
    this.saveDebounceMs = Math.max(50, Number(saveDebounceMs) || DEFAULT_SAVE_DEBOUNCE_MS)
    this.nowFn = nowFn

    /**
     * @type {Map<string, {
     *   minuteBuckets: Map<number, number>,
     *   uploadTimestamps: number[],
     *   monthKey: string,
     *   bytesMonth: number,
     *   totalBytes: number,
     *   throttledCount: number,
     *   lastTrafficAt: number,
     *   lastThrottledAt: number,
     * }>}
     */
    this.rooms = new Map()
    this.totalThrottledCount = 0

    this._saveTimer = null
    this._saveDirty = false
    this._asyncSaveInFlight = null

    if (this.stateFile) {
      this._loadState()
    }
  }

  _loadState() {
    if (!this.stateFile || !existsSync(this.stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return
      const currentYm = formatYearMonth(this.nowFn())
      if (parsed.ym !== currentYm) {
        // Calendar month rolled over while offline — start fresh for the new month
        return
      }
      const roomsObj = parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {}
      for (const [rid, entry] of Object.entries(roomsObj)) {
        const cleanRid = String(rid || '').trim()
        const bytes = Math.max(0, Math.floor(Number(entry?.bytes) || 0))
        if (!cleanRid || bytes <= 0) continue
        const rec = this.getOrCreateRoom(cleanRid)
        rec.monthKey = currentYm
        rec.bytesMonth = bytes
        rec.totalBytes = Math.max(rec.totalBytes, bytes)
        rec.lastTrafficAt = Math.max(rec.lastTrafficAt, Number(entry?.updatedAt) || 0)
      }
    } catch (err) {
      console.warn(`[traffic-guard] Failed to load persisted monthly usage (${this.stateFile}): ${err?.message || err}`)
    }
  }

  _serializeState() {
    const currentYm = formatYearMonth(this.nowFn())
    const rooms = {}
    for (const [rid, rec] of this.rooms.entries()) {
      if (rec.monthKey === currentYm && rec.bytesMonth > 0) {
        rooms[rid] = {
          bytes: rec.bytesMonth,
          updatedAt: rec.lastTrafficAt || 0,
        }
      }
    }
    return JSON.stringify({ version: 1, ym: currentYm, rooms }, null, 2)
  }

  _saveStateSync() {
    if (!this.stateFile) return
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    this._saveDirty = false
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const payload = this._serializeState()
    const tmpPath = `${this.stateFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmpPath, 0o600) } catch {}
      renameSync(tmpPath, this.stateFile)
      try { chmodSync(this.stateFile, 0o600) } catch {}
    } catch (err) {
      try { unlinkSync(tmpPath) } catch {}
      console.warn(`[traffic-guard] Sync save failed: ${err?.message || err}`)
    }
  }

  async _drainAsyncSave() {
    if (!this.stateFile || this._asyncSaveInFlight) return this._asyncSaveInFlight
    this._asyncSaveInFlight = (async () => {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      while (this._saveDirty) {
        this._saveDirty = false
        const payload = this._serializeState()
        const tmpPath = `${this.stateFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
        try {
          await writeFileAsync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
          try { await chmodAsync(tmpPath, 0o600) } catch {}
          await renameAsync(tmpPath, this.stateFile)
          try { await chmodAsync(this.stateFile, 0o600) } catch {}
        } catch (err) {
          try { await unlinkAsync(tmpPath) } catch {}
          console.warn(`[traffic-guard] Async save failed: ${err?.message || err}`)
          break
        }
      }
    })().finally(() => {
      this._asyncSaveInFlight = null
      if (this._saveDirty) {
        this._scheduleSave()
      }
    })
    return this._asyncSaveInFlight
  }

  _scheduleSave() {
    if (!this.stateFile) return
    this._saveDirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this._drainAsyncSave()
    }, this.saveDebounceMs)
    this._saveTimer.unref?.()
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this.stateFile && this._saveDirty) {
      this._saveStateSync()
    }
  }

  getLimitsForTier(rawTier = 'free', isAdmin = false) {
    const tier = normalizeTier(rawTier, isAdmin)
    if (tier === 'ultra') {
      return {
        tier: 'ultra',
        unlimited: true,
        burst10mBytes: 0,
        daily24hBytes: 0,
        monthlyBytes: 0,
        uploadPerMin: 0,
      }
    }
    if (tier === 'admin') {
      if (this.adminExempt) {
        return {
          tier: 'admin',
          unlimited: true,
          burst10mBytes: 0,
          daily24hBytes: 0,
          monthlyBytes: 0,
          uploadPerMin: 0,
        }
      }
      return {
        tier: 'admin',
        unlimited: false,
        burst10mBytes: this.burstLimitBytes,
        daily24hBytes: this.dailyLimitBytes,
        monthlyBytes: this.monthlyLimitBytes,
        uploadPerMin: this.uploadMaxPerMinute,
      }
    }
    if (tier === 'pro') {
      return {
        tier: 'pro',
        unlimited: false,
        burst10mBytes: this.burstLimitBytes > 0 ? this.burstLimitBytes * this.proBurstMultiplier : 0,
        daily24hBytes: this.dailyLimitBytes > 0 ? this.dailyLimitBytes * this.proDailyMultiplier : 0,
        monthlyBytes: this.proMonthlyLimitBytes,
        uploadPerMin: this.uploadMaxPerMinute > 0 ? this.uploadMaxPerMinute * this.proUploadRateMultiplier : 0,
      }
    }
    return {
      tier: 'free',
      unlimited: false,
      burst10mBytes: this.burstLimitBytes,
      daily24hBytes: this.dailyLimitBytes,
      monthlyBytes: this.monthlyLimitBytes,
      uploadPerMin: this.uploadMaxPerMinute,
    }
  }

  getLimits() {
    const free = this.getLimitsForTier('free')
    const pro = this.getLimitsForTier('pro')
    const ultra = this.getLimitsForTier('ultra')
    const admin = this.getLimitsForTier('admin')
    return {
      burst10mBytes: free.burst10mBytes,
      daily24hBytes: free.daily24hBytes,
      monthlyBytes: free.monthlyBytes,
      uploadPerMin: free.uploadPerMin,
      proBurst10mBytes: pro.burst10mBytes,
      proDaily24hBytes: pro.daily24hBytes,
      proMonthlyBytes: pro.monthlyBytes,
      proUploadPerMin: pro.uploadPerMin,
      adminExempt: this.adminExempt,
      tiers: { free, pro, ultra, admin },
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
        monthKey: formatYearMonth(this.nowFn()),
        bytesMonth: 0,
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
    const currentYm = formatYearMonth(now)
    if (rec.monthKey !== currentYm) {
      rec.monthKey = currentYm
      rec.bytesMonth = 0
      if (this.stateFile) this._scheduleSave()
    }
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
    return { currentMin, currentYm, bytes10m, bytes24h, bytesMonth: rec.bytesMonth }
  }

  /**
   * Check and record an HTTP POST /api/uploads attempt (count rate limit + byte quota).
   */
  consumeUploadPost(roomId, bytes, { tier = '', isAdmin = false } = {}) {
    const rid = String(roomId || '').trim()
    const size = Math.max(0, Number(bytes) || 0)
    const now = this.nowFn()
    const rec = this.getOrCreateRoom(rid)
    const { currentMin, currentYm, bytes10m, bytes24h, bytesMonth } = this.pruneAndSum(rec, now)
    const limits = this.getLimitsForTier(tier, isAdmin)

    if (!limits.unlimited && limits.uploadPerMin > 0 && rec.uploadTimestamps.length >= limits.uploadPerMin) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      const oldest = rec.uploadTimestamps[0] || now
      const retryAfterSec = Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000))
      return {
        allowed: false,
        code: 'UPLOAD_RATE_LIMIT',
        quotaWindow: 'upload_rate',
        retryAfterSec,
        message: `上传过于频繁（每分钟最多 ${limits.uploadPerMin} 次），请 ${retryAfterSec} 秒后重试`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm),
      }
    }

    const quotaCheck = this.evaluateByteQuota(rec, bytes10m, bytes24h, bytesMonth, size, {
      limits,
      currentYm,
      now,
      enforceBlock: true,
    })
    if (!quotaCheck.allowed) {
      return quotaCheck
    }

    rec.uploadTimestamps.push(now)
    if (size > 0) {
      rec.minuteBuckets.set(currentMin, (rec.minuteBuckets.get(currentMin) || 0) + size)
      rec.bytesMonth += size
      rec.totalBytes += size
      rec.lastTrafficAt = now
      this._scheduleSave()
    }
    return {
      allowed: true,
      usage: this.buildRoomUsage(rec, bytes10m + size, bytes24h + size, rec.bytesMonth, limits, currentYm),
    }
  }

  /**
   * Check and record an HTTP GET /api/uploads/<id> download.
   */
  consumeUploadGet(roomId, bytes, { tier = '', isAdmin = false } = {}) {
    return this.consumeBytes(roomId, bytes, { tier, isAdmin, strictBlock: true })
  }

  /**
   * Check and record WebSocket traffic bytes.
   * - If `strictBlock` is true (e.g. large WS frame > 256 KB or HTTP download), reject as soon as
   *   burst (10m), daily (24h), or monthly quota is exceeded.
   * - If `strictBlock` is false (small control/text chat frame), allow normal chat to stay alive
   *   until 2x quota (`hardKick: true`), preventing malicious flood scripts from abusing small frames.
   */
  consumeBytes(roomId, bytes, { tier = '', isAdmin = false, strictBlock = null } = {}) {
    const rid = String(roomId || '').trim()
    const size = Math.max(0, Number(bytes) || 0)
    const now = this.nowFn()
    const rec = this.getOrCreateRoom(rid)
    const { currentMin, currentYm, bytes10m, bytes24h, bytesMonth } = this.pruneAndSum(rec, now)
    const limits = this.getLimitsForTier(tier, isAdmin)
    const enforceBlock = strictBlock === null ? size >= this.largeFrameThresholdBytes : Boolean(strictBlock)

    const quotaCheck = this.evaluateByteQuota(rec, bytes10m, bytes24h, bytesMonth, size, {
      limits,
      currentYm,
      now,
      enforceBlock,
    })
    if (!quotaCheck.allowed) {
      return quotaCheck
    }

    if (size > 0) {
      rec.minuteBuckets.set(currentMin, (rec.minuteBuckets.get(currentMin) || 0) + size)
      rec.bytesMonth += size
      rec.totalBytes += size
      rec.lastTrafficAt = now
      this._scheduleSave()
    }
    return {
      allowed: true,
      hardKick: false,
      usage: this.buildRoomUsage(rec, bytes10m + size, bytes24h + size, rec.bytesMonth, limits, currentYm),
    }
  }

  evaluateByteQuota(
    rec,
    bytes10m,
    bytes24h,
    bytesMonth,
    incomingBytes,
    { limits, currentYm, now = Date.now(), enforceBlock = true } = {},
  ) {
    if (!limits || limits.unlimited) return { allowed: true, hardKick: false }

    const projected10m = bytes10m + incomingBytes
    const projected24h = bytes24h + incomingBytes
    const projectedMonth = bytesMonth + incomingBytes

    const hardBurst = limits.burst10mBytes > 0 && projected10m > limits.burst10mBytes * this.hardDisconnectMultiplier
    const hardDaily = limits.daily24hBytes > 0 && projected24h > limits.daily24hBytes * this.hardDisconnectMultiplier
    const hardMonthly = limits.monthlyBytes > 0 && projectedMonth > limits.monthlyBytes * this.hardDisconnectMultiplier
    if (hardBurst || hardDaily || hardMonthly) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      const quotaWindow = hardMonthly ? 'month' : hardBurst ? '10m' : '24h'
      const message = hardMonthly
        ? `本月传输流量已大幅超限（月上限 ${formatBytesShort(limits.monthlyBytes)}），连接已临时限制`
        : hardBurst
          ? `当前 10 分钟传输流量已大幅超限（上限 ${formatBytesShort(limits.burst10mBytes)}），连接已临时限制`
          : `今日传输流量已大幅超限（每日上限 ${formatBytesShort(limits.daily24hBytes)}），连接已临时限制`
      return {
        allowed: false,
        hardKick: true,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        quotaWindow,
        retryAfterSec: hardBurst ? 600 : 3600,
        message,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm),
      }
    }

    if (!enforceBlock) {
      return { allowed: true, hardKick: false }
    }

    if (limits.monthlyBytes > 0 && projectedMonth > limits.monthlyBytes) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: false,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        quotaWindow: 'month',
        retryAfterSec: 3600,
        message: `本月文件传输流量已达上限（${formatBytesShort(limits.monthlyBytes)}），次月 1 日自动重置（文字聊天不受影响）`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm),
      }
    }

    if (limits.burst10mBytes > 0 && projected10m > limits.burst10mBytes) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: false,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        quotaWindow: '10m',
        retryAfterSec: 300,
        message: `近 10 分钟文件传输流量已达上限（${formatBytesShort(limits.burst10mBytes)}），请稍后再试（文字聊天不受影响）`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm),
      }
    }

    if (limits.daily24hBytes > 0 && projected24h > limits.daily24hBytes) {
      rec.throttledCount += 1
      rec.lastThrottledAt = now
      this.totalThrottledCount += 1
      return {
        allowed: false,
        hardKick: false,
        code: 'TRAFFIC_QUOTA_EXCEEDED',
        quotaWindow: '24h',
        retryAfterSec: 3600,
        message: `今日文件传输流量已达上限（${formatBytesShort(limits.daily24hBytes)}），请明日再试（文字聊天不受影响）`,
        usage: this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm),
      }
    }

    return { allowed: true, hardKick: false }
  }

  buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, monthKey) {
    return {
      tier: limits.tier,
      unlimited: limits.unlimited,
      monthKey,
      bytes10m,
      bytes24h,
      bytesMonth,
      totalBytes: rec.totalBytes,
      throttledCount: rec.throttledCount,
      lastTrafficAt: rec.lastTrafficAt,
      lastThrottledAt: rec.lastThrottledAt,
      limit10mBytes: limits.burst10mBytes,
      limit24hBytes: limits.daily24hBytes,
      limitMonthBytes: limits.monthlyBytes,
      limitUploadPerMin: limits.uploadPerMin,
    }
  }

  getRoomUsage(roomId, tier = 'free') {
    const rid = String(roomId || '').trim()
    const now = this.nowFn()
    const currentYm = formatYearMonth(now)
    const limits = this.getLimitsForTier(tier)
    const rec = this.rooms.get(rid)
    if (!rec) {
      return {
        tier: limits.tier,
        unlimited: limits.unlimited,
        monthKey: currentYm,
        bytes10m: 0,
        bytes24h: 0,
        bytesMonth: 0,
        totalBytes: 0,
        throttledCount: 0,
        lastTrafficAt: 0,
        lastThrottledAt: 0,
        limit10mBytes: limits.burst10mBytes,
        limit24hBytes: limits.daily24hBytes,
        limitMonthBytes: limits.monthlyBytes,
        limitUploadPerMin: limits.uploadPerMin,
      }
    }
    const { bytes10m, bytes24h, bytesMonth } = this.pruneAndSum(rec, now)
    return this.buildRoomUsage(rec, bytes10m, bytes24h, bytesMonth, limits, currentYm)
  }

  getGlobalSummary() {
    const now = this.nowFn()
    const currentYm = formatYearMonth(now)
    let totalBytes10m = 0
    let totalBytes24h = 0
    let totalBytesMonth = 0
    let totalBytesLifetime = 0
    for (const rec of this.rooms.values()) {
      const { bytes10m, bytes24h, bytesMonth } = this.pruneAndSum(rec, now)
      totalBytes10m += bytes10m
      totalBytes24h += bytes24h
      totalBytesMonth += bytesMonth
      totalBytesLifetime += rec.totalBytes
    }
    return {
      monthKey: currentYm,
      totalBytes10m,
      totalBytes24h,
      totalBytesMonth,
      totalBytesLifetime,
      totalThrottledCount: this.totalThrottledCount,
      limits: this.getLimits(),
    }
  }
}
