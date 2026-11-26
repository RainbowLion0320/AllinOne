/**
 * Bounded LRU Map (extends native Map so `instanceof Map` checks stay valid).
 * Automatically refreshes recency on `get`/`set` and evicts oldest entries past `maxSize`.
 */
export class BoundedLruMap extends Map {
  constructor(maxSize = 256, entries = undefined) {
    super()
    this.maxSize = Math.max(1, Math.floor(Number(maxSize) || 256))
    if (entries) {
      for (const [k, v] of entries) {
        this.set(k, v)
      }
    }
  }

  get(key) {
    if (!super.has(key)) return undefined
    const val = super.get(key)
    super.delete(key)
    super.set(key, val)
    return val
  }

  peek(key) {
    return super.get(key)
  }

  set(key, value) {
    if (super.has(key)) {
      super.delete(key)
    }
    super.set(key, value)
    while (this.size > this.maxSize) {
      const oldestKey = this.keys().next().value
      if (oldestKey === undefined) break
      super.delete(oldestKey)
    }
    return this
  }
}

/**
 * Instance-scoped, byte-budgeted LRU cache for parsed transcript / JSONL files.
 * Validates both `mtimeMs` and `size` so edited files immediately invalidate,
 * and clears completely on adapter `dispose()` (preventing cross-instance memory leaks).
 */
export class FileParseCache {
  constructor({ maxEntries = 160, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxEntries = Math.max(8, Math.floor(Number(maxEntries) || 160))
    this.maxBytes = Math.max(1024 * 1024, Math.floor(Number(maxBytes) || 32 * 1024 * 1024))
    /** @type {Map<string, { mtimeMs: number, size: number, bytes: number, value: any }>} */
    this._map = new Map()
    this._totalBytes = 0
  }

  get size() {
    return this._map.size
  }

  get totalBytes() {
    return this._totalBytes
  }

  get(key, mtimeMs, size) {
    const entry = this._map.get(key)
    if (!entry) return undefined
    if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
      this._totalBytes = Math.max(0, this._totalBytes - entry.bytes)
      this._map.delete(key)
      return undefined
    }
    this._map.delete(key)
    this._map.set(key, entry)
    return entry.value
  }

  set(key, mtimeMs, size, value, approxBytes = 0) {
    const bytes = Math.max(256, Math.floor(Number(approxBytes) || Number(size) || 4096))
    const prev = this._map.get(key)
    if (prev) {
      this._totalBytes = Math.max(0, this._totalBytes - prev.bytes)
      this._map.delete(key)
    }
    // Skip caching single entries that exceed half of total byte budget
    if (bytes > this.maxBytes * 0.5) {
      return
    }
    this._map.set(key, { mtimeMs, size, bytes, value })
    this._totalBytes += bytes
    while (this._map.size > this.maxEntries || this._totalBytes > this.maxBytes) {
      const oldestKey = this._map.keys().next().value
      if (oldestKey === undefined) break
      const evicted = this._map.get(oldestKey)
      this._map.delete(oldestKey)
      if (evicted) {
        this._totalBytes = Math.max(0, this._totalBytes - evicted.bytes)
      }
    }
  }

  delete(key) {
    const prev = this._map.get(key)
    if (!prev) return false
    this._totalBytes = Math.max(0, this._totalBytes - prev.bytes)
    return this._map.delete(key)
  }

  clear() {
    this._map.clear()
    this._totalBytes = 0
  }
}
