import { existsSync, readFileSync } from 'node:fs'
import { EVENTS } from '../protocol.js'
import { atomicWriteJsonSync } from './io-utils.js'

/**
 * Unified single-flight quota cache & background refresher for AI adapters.
 * Supports TTL caching, error backoff, optional atomic disk persistence, and `BRIDGE_STATUS` pushes.
 */
export class QuotaCacheManager {
  constructor({
    app,
    ttlMs = 60_000,
    errorBackoffMs = 20_000,
    diskCachePath = '',
    diskTtlMs = 60 * 60_000,
    emitEvent = null,
    fetcher = null,
    isValid = null,
    parseDisk = null,
  }) {
    this.app = app
    this.ttlMs = ttlMs
    this.errorBackoffMs = errorBackoffMs
    this.diskCachePath = diskCachePath
    this.diskTtlMs = diskTtlMs
    this.emitEvent = emitEvent || (() => {})
    this.fetcher = fetcher
    this.isValidFn = isValid || ((q, now) => Boolean(q && (!q.resetsAt || now <= q.resetsAt + 60_000)))
    this.parseDisk = parseDisk || null

    this.quota = null
    this.fetchedAt = 0
    this.failedAt = 0
    this.inFlight = null
    this.disposed = false

    if (this.diskCachePath) {
      this.loadFromDisk()
    }
  }

  loadFromDisk(now = Date.now()) {
    if (!this.diskCachePath || !existsSync(this.diskCachePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.diskCachePath, 'utf8'))
      const q = this.parseDisk ? this.parseDisk(parsed, now) : parsed?.quota || parsed
      if (!q || typeof q !== 'object') return null
      const savedAt = Number(parsed?.savedAt || q.updatedAt || 0)
      if (savedAt > 0 && now - savedAt > this.diskTtlMs) return null
      if (!this.isValidFn(q, now)) return null
      this.quota = q
      this.fetchedAt = savedAt || now
      return q
    } catch {
      return null
    }
  }

  persistToDisk(quota = this.quota) {
    if (!this.diskCachePath || !quota) return
    try {
      atomicWriteJsonSync(this.diskCachePath, { savedAt: Date.now(), quota }, { mode: 0o600 })
    } catch {}
  }

  getValid(now = Date.now()) {
    if (!this.quota) return null
    return this.isValidFn(this.quota, now) ? this.quota : null
  }

  set(quota, { persist = true, emit = true } = {}) {
    if (!quota) return null
    this.quota = quota
    this.fetchedAt = Date.now()
    this.failedAt = 0
    if (persist) this.persistToDisk(quota)
    if (emit && !this.disposed) {
      this.emitEvent(EVENTS.BRIDGE_STATUS, {
        type: 'quota.updated',
        app: this.app,
        quota,
      })
    }
    return quota
  }

  refreshInBackground({ force = false } = {}) {
    if (this.disposed || typeof this.fetcher !== 'function') return Promise.resolve(this.getValid())
    const now = Date.now()
    if (this.inFlight) return this.inFlight
    if (!force && this.quota && now - this.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.getValid(now))
    }
    if (!force && this.failedAt && now - this.failedAt < this.errorBackoffMs) {
      return Promise.resolve(this.getValid(now))
    }

    const p = Promise.resolve()
      .then(() => this.fetcher({ force }))
      .then((fresh) => {
        if (this.disposed) return null
        if (fresh) {
          return this.set(fresh, { persist: true, emit: true })
        }
        this.failedAt = Date.now()
        return this.getValid()
      })
      .catch(() => {
        this.failedAt = Date.now()
        return this.getValid()
      })
      .finally(() => {
        if (this.inFlight === p) this.inFlight = null
      })

    this.inFlight = p
    return p
  }

  dispose() {
    this.disposed = true
  }
}
