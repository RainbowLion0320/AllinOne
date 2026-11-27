import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_TOKENS = 128
const DEFAULT_FILE_EXPIRE_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB
const UNKNOWN_SIZE_RESERVE_FLOOR_BYTES = 1024 * 1024 // 1 MB floor when declaredSize === 0

/**
 * Single authoritative owner of PC-side `inboundDir` P2P uploads:
 *  - Path containment & symlink verification (`isPathInside`)
 *  - Unified disk quota accounting (eliminates double-counting active files on disk + `size=0` bypass)
 *  - Opaque single-use `p2p_*` upload token registry (clientId-scoped, burn-with-rollback)
 *  - Periodic expired file pruning
 */
export class InboundAttachmentStore {
  constructor({
    inboundDir,
    maxDiskBytes = DEFAULT_MAX_DISK_BYTES,
    tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
    fileExpireMs = DEFAULT_FILE_EXPIRE_MS,
    maxTokens = DEFAULT_MAX_TOKENS,
    log = console,
  }) {
    this.inboundDir = resolve(String(inboundDir || ''))
    this.maxDiskBytes =
      Number.isFinite(Number(maxDiskBytes)) && Number(maxDiskBytes) > 0
        ? Math.floor(Number(maxDiskBytes))
        : DEFAULT_MAX_DISK_BYTES
    this.tokenTtlMs = tokenTtlMs
    this.fileExpireMs = fileExpireMs
    this.maxTokens = maxTokens
    this.log = log

    /** @type {Map<string, { clientId: string, localPath: string, filename: string, mimeType: string, size: number, createdAt: number }>} */
    this.tokens = new Map()
    /** @type {Map<string, { localPath: string, reservedBytes: number, receivedBytes: number, writtenBytes: number, effectiveBytes: number }>} */
    this.inFlight = new Map()
    this._inFlightUploadBytes = 0
    this._settledDiskBytes = 0
    this._settledDiskBytesCachedAt = 0
    this._lastPruneAt = 0
  }

  get inFlightUploadBytes() {
    return this._inFlightUploadBytes
  }

  _syncEntryEffectiveBytes(entry) {
    if (!entry) return
    const next = Math.max(entry.reservedBytes, entry.receivedBytes, entry.writtenBytes)
    if (next !== entry.effectiveBytes) {
      this._inFlightUploadBytes = Math.max(0, this._inFlightUploadBytes + (next - entry.effectiveBytes))
      entry.effectiveBytes = next
    }
  }

  ensureDir() {
    mkdirSync(this.inboundDir, { recursive: true, mode: 0o700 })
    try { chmodSync(this.inboundDir, 0o700) } catch {}
  }

  isPathInside(filePath, { requireExists = true } = {}) {
    const raw = String(filePath || '').trim()
    if (!raw || !this.inboundDir) return false
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    const cmp = (p) => (caseInsensitive ? p.toLowerCase() : p)
    const baseDir = resolve(this.inboundDir)
    const cleanPath = resolve(raw)
    const basePrefix = cmp(baseDir).endsWith(sep) ? cmp(baseDir) : `${cmp(baseDir)}${sep}`
    if (!cmp(cleanPath).startsWith(basePrefix)) return false
    if (existsSync(cleanPath)) {
      try {
        const realBase = realpathSync(baseDir)
        const realPath = realpathSync(cleanPath)
        const realPrefix = cmp(realBase).endsWith(sep) ? cmp(realBase) : `${cmp(realBase)}${sep}`
        return cmp(realPath).startsWith(realPrefix)
      } catch {
        return false
      }
    }
    return !requireExists
  }

  _collectDiskStats() {
    const activePaths = new Set()
    for (const entry of this.inFlight.values()) {
      if (entry.localPath) activePaths.add(resolve(entry.localPath))
    }

    let settledDiskBytes = 0
    const files = []
    try {
      if (this.inboundDir && existsSync(this.inboundDir)) {
        for (const name of readdirSync(this.inboundDir)) {
          const fp = resolve(join(this.inboundDir, name))
          if (activePaths.has(fp)) continue // Avoid double-counting active streams!
          try {
            const st = statSync(fp)
            if (st.isFile()) {
              settledDiskBytes += st.size
              files.push({ fp, size: st.size, mtimeMs: st.mtimeMs })
            }
          } catch {}
        }
      }
    } catch {}

    let inFlightBytes = 0
    for (const entry of this.inFlight.values()) {
      inFlightBytes += Math.max(entry.reservedBytes, entry.receivedBytes || 0, entry.writtenBytes)
    }

    return { settledDiskBytes, inFlightBytes, files }
  }

  /**
   * Return current settled on-disk usage + live atomic in-flight upload reservation bytes.
   */
  getDiskUsage({ refresh = false, now = Date.now() } = {}) {
    if (refresh || this._settledDiskBytesCachedAt === 0 || now - this._settledDiskBytesCachedAt > 2_000) {
      const stats = this._collectDiskStats()
      this._settledDiskBytes = stats.settledDiskBytes
      this._settledDiskBytesCachedAt = now
    }
    const inFlightBytes = this._inFlightUploadBytes
    return {
      settledBytes: this._settledDiskBytes,
      inFlightBytes,
      totalBytes: this._settledDiskBytes + inFlightBytes,
      maxDiskBytes: this.maxDiskBytes,
    }
  }

  /**
   * Reserve quota before starting an inbound stream, pruning expired files oldest-first if needed.
   */
  reserveUploadSpace(reservationKey, declaredBytes = 0, now = Date.now()) {
    const cleanDeclared = Number.isFinite(Number(declaredBytes)) && Number(declaredBytes) > 0
      ? Math.floor(Number(declaredBytes))
      : UNKNOWN_SIZE_RESERVE_FLOOR_BYTES

    const existing = this.inFlight.get(reservationKey)
    if (existing) {
      this._inFlightUploadBytes = Math.max(0, this._inFlightUploadBytes - (existing.effectiveBytes || 0))
      this.inFlight.delete(reservationKey)
    }

    const stats = this._collectDiskStats()
    let { settledDiskBytes } = stats
    const { files } = stats
    const inFlightBytes = this._inFlightUploadBytes

    if (settledDiskBytes + inFlightBytes + cleanDeclared > this.maxDiskBytes && files.length > 0) {
      const expired = files
        .filter((f) => now - f.mtimeMs > this.fileExpireMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const f of expired) {
        if (settledDiskBytes + inFlightBytes + cleanDeclared <= this.maxDiskBytes) break
        try {
          unlinkSync(f.fp)
          settledDiskBytes = Math.max(0, settledDiskBytes - f.size)
        } catch {}
      }
    }

    this._settledDiskBytes = settledDiskBytes
    this._settledDiskBytesCachedAt = now

    if (settledDiskBytes + inFlightBytes + cleanDeclared > this.maxDiskBytes) {
      return {
        ok: false,
        usedBytes: settledDiskBytes,
        inFlightBytes,
        quotaBytes: this.maxDiskBytes,
      }
    }

    const entry = {
      localPath: '',
      reservedBytes: cleanDeclared,
      receivedBytes: 0,
      writtenBytes: 0,
      effectiveBytes: cleanDeclared,
    }
    this.inFlight.set(reservationKey, entry)
    this._inFlightUploadBytes += cleanDeclared

    return {
      ok: true,
      usedBytes: settledDiskBytes,
      inFlightBytes: this._inFlightUploadBytes,
      quotaBytes: this.maxDiskBytes,
    }
  }

  attachLocalPath(reservationKey, localPath) {
    const entry = this.inFlight.get(reservationKey)
    if (entry) entry.localPath = resolve(String(localPath || ''))
  }

  /**
   * Atomically account for incoming wire bytes as bulk frames arrive so concurrent `size=0`
   * uploads can never overshoot `maxDiskBytes` even before chunk decryption flushes to disk.
   */
  recordReceivedBytes(reservationKey, receivedBytes) {
    const entry = this.inFlight.get(reservationKey)
    if (entry) {
      const next = Math.max(0, Math.floor(Number(receivedBytes) || 0))
      if (next > entry.receivedBytes) {
        entry.receivedBytes = next
        this._syncEntryEffectiveBytes(entry)
      }
    }
    return this.getDiskUsage().totalBytes <= this.maxDiskBytes
  }

  /**
   * Live quota check during streaming writes (blocks `declaredSize = 0` or under-reported quota bypasses,
   * and always incorporates live settled disk usage across concurrent completed uploads).
   */
  updateWrittenAndCheckQuota(reservationKey, writtenBytes, baseSettledBytes = null) {
    const entry = this.inFlight.get(reservationKey)
    if (entry) {
      entry.writtenBytes = Math.max(0, Math.floor(Number(writtenBytes) || 0))
      this._syncEntryEffectiveBytes(entry)
    }
    const usage = this.getDiskUsage()
    const settled = baseSettledBytes != null
      ? Math.max(Math.floor(Number(baseSettledBytes) || 0), usage.settledBytes)
      : usage.settledBytes
    return settled + this._inFlightUploadBytes <= this.maxDiskBytes
  }

  releaseUploadSpace(reservationKey, { settledSize = 0 } = {}) {
    const entry = this.inFlight.get(reservationKey)
    if (entry) {
      this._inFlightUploadBytes = Math.max(0, this._inFlightUploadBytes - (entry.effectiveBytes || 0))
      this.inFlight.delete(reservationKey)
    }
    const cleanSettled = Math.max(0, Math.floor(Number(settledSize) || 0))
    if (cleanSettled > 0) {
      this._settledDiskBytes += cleanSettled
    }
    // Force fresh disk tally on next quota check so completed/unlinked files are reflected immediately
    this._settledDiskBytesCachedAt = 0
  }

  allocateFilePath(rawFilename = 'upload.bin') {
    this.ensureDir()
    const rawBase = basename(String(rawFilename || 'upload.bin'))
    const safeName =
      rawBase
        .replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 100) || 'upload.bin'
    const localPath = join(this.inboundDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`)
    return { localPath, safeName }
  }

  registerUpload({ clientId = '', localPath, filename, mimeType = 'application/octet-stream', size = 0 } = {}) {
    const now = Date.now()
    for (const [tok, rec] of this.tokens.entries()) {
      if (now - rec.createdAt > this.tokenTtlMs) this.tokens.delete(tok)
    }
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value
      if (!oldest) break
      this.tokens.delete(oldest)
    }
    const cleanPath = resolve(String(localPath || ''))
    if (!this.isPathInside(cleanPath, { requireExists: false })) {
      throw new Error('Rejected P2P upload path outside inbound directory')
    }
    const token = `p2p_${randomUUID().replace(/-/g, '')}`
    this.tokens.set(token, {
      clientId: String(clientId || '').trim(),
      localPath: cleanPath,
      filename: String(filename || basename(cleanPath)),
      mimeType: String(mimeType || 'application/octet-stream'),
      size: Number(size || 0),
      createdAt: now,
    })
    return token
  }

  pruneExpiredFiles(maxAgeMs = this.fileExpireMs) {
    const now = Date.now()
    if (now - this._lastPruneAt < 10 * 60_000) return
    this._lastPruneAt = now
    const activePaths = new Set()
    for (const entry of this.inFlight.values()) {
      if (entry.localPath) activePaths.add(resolve(entry.localPath))
    }
    try {
      if (!existsSync(this.inboundDir)) return
      for (const name of readdirSync(this.inboundDir)) {
        const fp = resolve(join(this.inboundDir, name))
        if (activePaths.has(fp)) continue
        try {
          const st = statSync(fp)
          if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
            unlinkSync(fp)
            this._settledDiskBytesCachedAt = 0
          }
        } catch {}
      }
    } catch {}
  }

  restoreTokens(burned = []) {
    if (!Array.isArray(burned)) return
    for (const item of burned) {
      if (item?.token && item?.rec?.localPath && this.isPathInside(item.rec.localPath)) {
        this.tokens.set(item.token, item.rec)
      }
    }
  }

  materializeAttachments(attachments = [], { clientId = '', strict = false, _burnedOut = null } = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return []
    this.pruneExpiredFiles()
    const now = Date.now()
    const callerClientId = String(clientId || '').trim()
    const out = []
    let rejectedTokens = 0

    for (const att of attachments.slice(0, 12)) {
      if (!att || typeof att !== 'object') continue
      const token = String(att.p2pToken || '').trim()
      if (!token || !token.startsWith('p2p_')) {
        this.log.warn?.('mobile-hub: rejected untrusted attachment without valid p2pToken')
        continue
      }
      const rec = this.tokens.get(token)
      if (!rec || now - rec.createdAt > this.tokenTtlMs || !existsSync(rec.localPath)) {
        this.tokens.delete(token)
        this.log.warn?.('mobile-hub: rejected expired or unknown p2pToken')
        rejectedTokens += 1
        continue
      }
      if (rec.clientId && rec.clientId !== callerClientId) {
        this.log.warn?.('mobile-hub: rejected cross-client p2pToken attempt')
        rejectedTokens += 1
        continue
      }
      this.tokens.delete(token)
      if (Array.isArray(_burnedOut)) {
        _burnedOut.push({ token, rec })
      }
      out.push({
        id: att.id || token,
        filename: rec.filename,
        mimeType: rec.mimeType,
        size: rec.size,
        localPath: rec.localPath,
      })
    }

    if (strict && rejectedTokens > 0) {
      this.restoreTokens(_burnedOut)
      if (Array.isArray(_burnedOut)) _burnedOut.length = 0
      const err = new Error('部分附件上传凭证已过期或失效，请重新上传附件后再发送')
      err.code = 'ATTACHMENT_EXPIRED'
      throw err
    }
    return out
  }
}
