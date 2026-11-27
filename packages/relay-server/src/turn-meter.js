import {
  openSync,
  readSync,
  closeSync,
  fstatSync,
  statSync,
  watch,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DEFAULT_TURN_QUOTA_MB } from '@allinone/shared'

const MB = 1024 * 1024
const MAX_BYTES_PER_TICK = 512 * 1024
const MAX_REMAINDER_BYTES = 64 * 1024

export { DEFAULT_TURN_QUOTA_MB }

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
  cursorPath = '',
  onUsage = null,
  pollIntervalMs = 3_000,
  startFromBeginning = false,
  log = console,
} = {}) {
  const cleanPath = String(logPath || '').trim()
  const cleanCursorPath = String(cursorPath || '').trim()
  let offset = 0
  let currentIno = null
  let hadInitialStat = false
  let remainder = ''
  let utf8Decoder = new StringDecoder('utf8')
  let watcher = null
  let timer = null
  let catchupTimer = null
  let reading = false
  let started = false
  let stopped = false
  let lastError = ''
  let lastCursorSavedAt = 0
  let cursorWriteSeq = 0

  function loadPersistedCursor() {
    if (!cleanCursorPath) return null
    try {
      const raw = JSON.parse(readFileSync(cleanCursorPath, 'utf8'))
      if (raw && raw.logPath === cleanPath && raw.ino != null && Number.isFinite(Number(raw.offset))) {
        return { ino: BigInt(String(raw.ino)), offset: Math.max(0, Math.floor(Number(raw.offset))) }
      }
    } catch {}
    return null
  }

  function persistCursor(force = false) {
    if (!cleanCursorPath || currentIno === null) return
    const now = Date.now()
    if (!force && now - lastCursorSavedAt < 5_000) return
    lastCursorSavedAt = now
    const tmp = `${cleanCursorPath}.tmp.${process.pid}.${++cursorWriteSeq}`
    try {
      mkdirSync(dirname(cleanCursorPath), { recursive: true })
      writeFileSync(
        tmp,
        JSON.stringify({ logPath: cleanPath, ino: currentIno.toString(), offset, updatedAt: now }),
        { mode: 0o600 },
      )
      renameSync(tmp, cleanCursorPath)
    } catch {
      try { unlinkSync(tmp) } catch {}
    }
  }

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
      watcher = watch(cleanPath, (eventType) => {
        if (eventType === 'rename') {
          // On logrotate rename/create, release the old inode watcher so pollOnce re-stats and re-attaches cleanly
          closeWatcher()
        }
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
      const persisted = loadPersistedCursor()
      if (!startFromBeginning && persisted && persisted.ino === st.ino && persisted.offset <= Number(st.size)) {
        currentIno = st.ino
        offset = persisted.offset
      } else {
        currentIno = st.ino
        offset = startFromBeginning ? 0 : Number(st.size)
      }
      lastError = ''
    } catch (err) {
      hadInitialStat = false
      currentIno = null
      offset = 0
      if (err?.code && err.code !== 'ENOENT') {
        lastError = String(err.message || err.code)
        log.warn?.(`[turn-meter] Unable to stat ${cleanPath}: ${lastError}`)
      }
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
    let progressed = false
    let rotatedOrReset = false
    try {
      const st = statSync(cleanPath, { bigint: true })
      let size = Number(st.size)
      if (currentIno === null) {
        currentIno = st.ino
        offset = !hadInitialStat || startFromBeginning ? 0 : size
        remainder = ''
        utf8Decoder = new StringDecoder('utf8')
        hadInitialStat = true
        rotatedOrReset = true
        if (started && !watcher) attachWatcher()
      } else if (st.ino !== currentIno) {
        // Flush any buffered UTF-8 remainder before resetting for rotated inode
        const tail = utf8Decoder.end()
        if (tail) processChunkText(`${tail}\n`)
        currentIno = st.ino
        offset = 0
        remainder = ''
        utf8Decoder = new StringDecoder('utf8')
        rotatedOrReset = true
        if (started) attachWatcher()
      } else if (size < offset) {
        // Log truncated in place (`copytruncate`) — reset cleanly to start of file
        offset = 0
        remainder = ''
        utf8Decoder = new StringDecoder('utf8')
        rotatedOrReset = true
        if (started && !watcher) attachWatcher()
      } else if (started && !watcher) {
        attachWatcher()
      }
      lastError = ''
      if (size > offset) {
        fd = openSync(cleanPath, 'r')
        // Re-stat the opened descriptor to catch any logrotate inode swap between statSync and openSync
        const fdSt = fstatSync(fd, { bigint: true })
        size = Number(fdSt.size)
        if (fdSt.ino !== currentIno) {
          const tail = utf8Decoder.end()
          if (tail) processChunkText(`${tail}\n`)
          currentIno = fdSt.ino
          offset = 0
          remainder = ''
          utf8Decoder = new StringDecoder('utf8')
          rotatedOrReset = true
          if (started) attachWatcher()
        } else if (size < offset) {
          offset = 0
          remainder = ''
          utf8Decoder = new StringDecoder('utf8')
          rotatedOrReset = true
        }
        const MAX_BATCH = 256 * 1024
        let tickBytes = 0
        while (offset < size && tickBytes < MAX_BYTES_PER_TICK) {
          const toRead = Math.min(MAX_BATCH, size - offset, MAX_BYTES_PER_TICK - tickBytes)
          const buf = Buffer.allocUnsafe(toRead)
          const bytesRead = readSync(fd, buf, 0, toRead, offset)
          if (bytesRead <= 0) break
          offset += bytesRead
          tickBytes += bytesRead
          progressed = true
          processChunkText(utf8Decoder.write(buf.subarray(0, bytesRead)))
        }
        hasMoreBacklog = offset < size
      }
    } catch (err) {
      if (err?.code === 'ENOENT') {
        closeWatcher()
      } else if (err?.code) {
        const msg = String(err.message || err.code)
        if (msg !== lastError) {
          lastError = msg
          log.warn?.(`[turn-meter] Read error on ${cleanPath}: ${msg}`)
        }
      }
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
      }
      reading = false
    }
    if (rotatedOrReset) persistCursor(true)
    else if (progressed) persistCursor(false)
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
    if (startFromBeginning || (currentIno !== null && offset >= 0)) {
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
    persistCursor(true)
  }

  function getStats() {
    return {
      enabled: Boolean(cleanPath),
      healthy: Boolean(cleanPath && !lastError),
      lastError,
      offset,
    }
  }

  return { start, stop, pollOnce, getStats }
}
