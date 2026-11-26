import { BoundedLruMap } from './lru.js'

/**
 * Bounded 2-tier external session watcher (hot opened sessions + warm sidebar list sessions).
 * Replaces duplicated polling timers & unbounded Maps across Claude, WorkBuddy, Codex, and Antigravity.
 *
 * Guarantees:
 *  - `watched` capped at `maxWatched` (default 8) via LRU
 *  - `tracked` capped at `maxTracked` (default 40) via LRU
 *  - Single-flight re-entrancy lock so slow polls never pile up
 *  - Auto-pauses interval when both maps are empty, `.unref()` timer, clean `dispose()`
 */
export class SessionExternalWatcher {
  constructor({
    pollMs = 2_000,
    maxWatched = 8,
    maxTracked = 40,
    watchTtlMs = 20 * 60_000,
    listWatchTtlMs = 15 * 60_000,
    onPoll,
  }) {
    this.pollMs = Math.max(250, Math.floor(Number(pollMs) || 2_000))
    this.watchTtlMs = watchTtlMs
    this.listWatchTtlMs = listWatchTtlMs
    this.onPoll = onPoll

    this.watched = new BoundedLruMap(maxWatched)
    this.tracked = new BoundedLruMap(maxTracked)
    this.lastClientListAt = 0
    this.timer = null
    this.inFlight = false
    this.disposed = false
  }

  markListActive(now = Date.now()) {
    this.lastClientListAt = now
  }

  isListExpired(now = Date.now()) {
    return now - this.lastClientListAt > this.listWatchTtlMs
  }

  rememberWatched(nativeId, descriptor) {
    if (this.disposed || !nativeId) return
    this.watched.set(nativeId, {
      ...descriptor,
      nativeId,
      lastSeenAt: descriptor?.lastSeenAt || Date.now(),
    })
    this.ensureRunning()
  }

  rememberTracked(nativeId, descriptor) {
    if (this.disposed || !nativeId) return
    this.tracked.set(nativeId, {
      ...descriptor,
      nativeId,
    })
    this.ensureRunning()
  }

  ensureRunning() {
    if (this.disposed || this.timer) return
    if (this.watched.size === 0 && this.tracked.size === 0) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollMs)
    this.timer.unref?.()
  }

  async tick() {
    if (this.disposed || this.inFlight) return
    this.inFlight = true
    try {
      await this.onPoll?.({
        now: Date.now(),
        watched: this.watched,
        tracked: this.tracked,
        isListExpired: (now) => this.isListExpired(now),
      })
    } catch {
      // Polling errors must never kill future poll ticks
    } finally {
      this.inFlight = false
      if (this.watched.size === 0 && this.tracked.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose() {
    this.disposed = true
    this.stop()
    this.watched.clear()
    this.tracked.clear()
  }
}
