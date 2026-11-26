import { openSync, readSync, closeSync, statSync, watch } from 'node:fs'

const MB = 1024 * 1024
const MAX_BYTES_PER_TICK = 512 * 1024
const MAX_REMAINDER_BYTES = 64 * 1024

export const DEFAULT_TURN_QUOTA_MB = Object.freeze({
  free: 1024,    // 1 GB / month
  pro: 10240,    // 10 GB / month
  ultra: 51200,  // 50 GB / month (shared identically by admin)
})

function parseNonNegNumber(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * Resolve per-tier monthly TURN relay quotas (in bytes).
 * `admin` strictly shares the exact same quota rule as `ultra`.
 * Setting a tier's MB value to `0` means unlimited.
 */
export function resolveTurnQuotaConfig(options = {}, env = process.env) {
  const freeMb = parseNonNegNumber(options.turnQuotaFreeMb ?? env.TURN_QUOTA_FREE_MB, DEFAULT_TURN_QUOTA_MB.free)
  const proMb = parseNonNegNumber(options.turnQuotaProMb ?? env.TURN_QUOTA_PRO_MB, DEFAULT_TURN_QUOTA_MB.pro)
  const ultraMb = parseNonNegNumber(options.turnQuotaUltraMb ?? env.TURN_QUOTA_ULTRA_MB, DEFAULT_TURN_QUOTA_MB.ultra)
  return {
    freeMb,
    proMb,
    ultraMb,
    adminMb: ultraMb,
    freeBytes: freeMb * MB,
    proBytes: proMb * MB,
    ultraBytes: ultraMb * MB,
    adminBytes: ultraMb * MB,
  }
}

/**
 * Return monthly TURN relay byte cap for a user tier (`0` = unlimited).
 * `admin` and `ultra` strictly share the same cap.
 */
export function getTurnQuotaBytesForTier(tier, config = resolveTurnQuotaConfig()) {
  const t = String(tier || 'free').trim().toLowerCase()
  if (t === 'admin' || t === 'ultra') return config.ultraBytes
  if (t === 'pro') return config.proBytes
  return config.freeBytes
}

export function buildTurnQuotaSnapshot({ tier = 'free', month = '', usedBytes = 0, config = resolveTurnQuotaConfig() } = {}) {
  const cleanTier = String(tier || 'free').trim().toLowerCase()
  const normTier = cleanTier === 'admin' || cleanTier === 'ultra' || cleanTier === 'pro' ? cleanTier : 'free'
  const quotaBytes = getTurnQuotaBytesForTier(normTier, config)
  const used = Math.max(0, Math.floor(Number(usedBytes) || 0))
  const unlimited = quotaBytes <= 0
  const remainingBytes = unlimited ? null : Math.max(0, quotaBytes - used)
  const exceeded = !unlimited && used >= quotaBytes
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / quotaBytes) * 1000) / 10)
  return {
    tier: normTier,
    month: String(month || ''),
    usedBytes: used,
    quotaBytes,
    remainingBytes,
    unlimited,
    exceeded,
    pct,
  }
}

/**
 * Parse a single `coturn` verbose session accounting line:
 *   `4: : session 001000000000000002: usage: realm=<allinone>, username=<1795581100:usr_abc123>, rp=21, rb=2606, sp=19, sb=2528`
 *
 * Strictly ignores `peer usage:` lines to prevent double counting.
 * Computes `Math.ceil((rb + sb) / 2)` so dual-TURN allocations sum to exact server egress
 * while single-TURN uploads and downloads are both accurately metered.
 */
const USAGE_LINE_RE =
  /session\s+[0-9a-f]+:\s+usage:\s+.*username=<[^:>]*:([^>]+)>.*?\brb=(\d+)\b.*?\bsb=(\d+)\b/i

export function parseCoturnUsageLine(line) {
  if (!line || !line.includes(': usage:')) return null
  if (line.includes('peer usage:')) return null
  const m = USAGE_LINE_RE.exec(line)
  if (!m) return null
  const userId = String(m[1] || '').trim()
  const rb = Number(m[2]) || 0
  const sb = Number(m[3]) || 0
  if (!userId.startsWith('usr_') || (rb <= 0 && sb <= 0)) return null
  const billedBytes = Math.ceil((rb + sb) / 2)
  return { userId, rb, sb, billedBytes }
}

/**
 * Lightweight, zero-dependency incremental tailer for `/var/log/coturn/turn.log`.
 * - Starts at EOF on boot so restarts never double-count historical lines already persisted in accounts.json.
 * - Tracks inode + byte offset to seamlessly handle `logrotate` (`copytruncate` or `create`).
 */
export function createTurnLogMeter({
  logPath = '',
  onUsage = null,
  pollIntervalMs = 3_000,
  startFromBeginning = false,
  log = console,
} = {}) {
  const cleanPath = String(logPath || '').trim()
  let offset = 0
  let currentIno = null
  let hadInitialStat = false
  let remainder = ''
  let watcher = null
  let timer = null
  let catchupTimer = null
  let reading = false
  let started = false
  let stopped = false

  function clearCatchupTimer() {
    if (catchupTimer) {
      clearTimeout(catchupTimer)
      catchupTimer = null
    }
  }

  function closeWatcher() {
    if (watcher) {
      try { watcher.close() } catch {}
      watcher = null
    }
  }

  function attachWatcher() {
    closeWatcher()
    if (!started || stopped || !cleanPath) return
    try {
      watcher = watch(cleanPath, () => {
        pollOnce()
      })
      watcher.on('error', () => {
        closeWatcher()
      })
      watcher.unref?.()
    } catch {
      watcher = null
    }
  }

  function initCursor() {
    if (!cleanPath) return
    try {
      const st = statSync(cleanPath, { bigint: true })
      hadInitialStat = true
      currentIno = st.ino
      offset = startFromBeginning ? 0 : Number(st.size)
    } catch {
      hadInitialStat = false
      currentIno = null
      offset = 0
    }
  }

  function processChunkText(text) {
    const combined = remainder + text
    const lines = combined.split(/\r?\n/)
    const nextRemainder = lines.pop() || ''
    remainder = nextRemainder.length > MAX_REMAINDER_BYTES ? nextRemainder.slice(-MAX_REMAINDER_BYTES) : nextRemainder
    for (const line of lines) {
      const parsed = parseCoturnUsageLine(line)
      if (parsed && typeof onUsage === 'function') {
        try {
          onUsage(parsed)
        } catch (err) {
          log.warn?.(`[turn-meter] onUsage callback error: ${String(err?.message || err)}`)
        }
      }
    }
  }

  function pollOnce() {
    if (stopped || reading || !cleanPath) return
    reading = true
    let fd = null
    let hasMoreBacklog = false
    try {
      const st = statSync(cleanPath, { bigint: true })
      const size = Number(st.size)
      if (currentIno === null) {
        currentIno = st.ino
        offset = !hadInitialStat || startFromBeginning ? 0 : size
        remainder = ''
        hadInitialStat = true
        if (started && !watcher) attachWatcher()
      } else if (st.ino !== currentIno) {
        // Log rotated via `create` (new inode) — reset cleanly and re-attach watcher to new file
        currentIno = st.ino
        offset = 0
        remainder = ''
        if (started) attachWatcher()
      } else if (size < offset) {
        // Log truncated in place (`copytruncate`) — reset cleanly to start of file
        offset = 0
        remainder = ''
        if (started && !watcher) attachWatcher()
      } else if (started && !watcher) {
        attachWatcher()
      }
      if (size <= offset) return

      fd = openSync(cleanPath, 'r')
      const MAX_BATCH = 256 * 1024
      let tickBytes = 0
      while (offset < size && tickBytes < MAX_BYTES_PER_TICK) {
        const toRead = Math.min(MAX_BATCH, size - offset, MAX_BYTES_PER_TICK - tickBytes)
        const buf = Buffer.allocUnsafe(toRead)
        const bytesRead = readSync(fd, buf, 0, toRead, offset)
        if (bytesRead <= 0) break
        offset += bytesRead
        tickBytes += bytesRead
        processChunkText(buf.subarray(0, bytesRead).toString('utf8'))
      }
      hasMoreBacklog = offset < size
    } catch {
      // Log file may not exist yet or be mid-rotation
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
      }
      reading = false
    }
    if (hasMoreBacklog && started && !stopped && !catchupTimer) {
      catchupTimer = setTimeout(() => {
        catchupTimer = null
        pollOnce()
      }, 50)
      catchupTimer.unref?.()
    }
  }

  function start() {
    if (!cleanPath || stopped) return
    started = true
    initCursor()
    if (currentIno !== null) {
      attachWatcher()
    }
    if (startFromBeginning) {
      pollOnce()
    }
    timer = setInterval(pollOnce, Math.max(500, Number(pollIntervalMs) || 3_000))
    timer.unref?.()
  }

  function stop() {
    stopped = true
    started = false
    clearCatchupTimer()
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    closeWatcher()
  }

  return { start, stop, pollOnce }
}
