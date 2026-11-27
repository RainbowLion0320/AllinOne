import { killProcessTree } from '../helpers/bin-finder.js'
import { BoundedLruMap, FileParseCache } from '../primitives/lru.js'

/**
 * Shared foundation for all PC AI App Adapters (`DSH`, `Codex`, `Claude`, `Antigravity`, `WorkBuddy`, `ZCode`).
 *
 * Centralizes:
 *  - Capability metadata so `MultiAppOrchestrator` queries capabilities instead of hardcoding app names
 *  - Lifecycle `disposed` guard + automatic child-process & timer cleanup
 *  - Bounded LRU maps (`sessionPrefs`, `sessionTaskStates`, `pendingCreated`) eliminating unbounded memory growth
 *  - Instance-scoped `FileParseCache` cleared on `dispose()`
 */
export class BaseAdapter {
  constructor(app, { config = {}, log = console, emitEvent, onApprovalRequest, capabilities = {} } = {}) {
    this.app = app
    this.config = config
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})
    this.disposed = false

    this.capabilities = {
      supportsWorkspaces: false,
      supportsSetup: false,
      supportsApproval: false,
      supportsMidChatSwitch: false,
      supportsAttachments: true,
      supportsQuota: false,
      ...capabilities,
    }

    /** @type {BoundedLruMap<string, any>} */
    this.sessionPrefs = new BoundedLruMap(256)
    /** @type {BoundedLruMap<string, any>} */
    this.sessionTaskStates = new BoundedLruMap(256)
    /** @type {BoundedLruMap<string, any>} */
    this.pendingCreated = new BoundedLruMap(128)
    /** @type {FileParseCache} */
    this.parseCache = new FileParseCache()

    /** @type {Set<import('node:child_process').ChildProcess>} */
    this._trackedProcs = new Set()
    /** @type {Set<any>} */
    this._trackedTimers = new Set()
  }

  trackChildProcess(proc) {
    if (!proc) return proc
    this._trackedProcs.add(proc)
    const cleanup = () => this._trackedProcs.delete(proc)
    proc.once?.('close', cleanup)
    proc.once?.('exit', cleanup)
    proc.once?.('error', cleanup)
    return proc
  }

  setTrackedTimeout(fn, delayMs) {
    const t = setTimeout(() => {
      this._trackedTimers.delete(t)
      fn()
    }, delayMs)
    t.unref?.()
    this._trackedTimers.add(t)
    return t
  }

  setTimeout(fn, delayMs) {
    return this.setTrackedTimeout(fn, delayMs)
  }

  setTrackedInterval(fn, intervalMs) {
    const t = setInterval(fn, intervalMs)
    t.unref?.()
    this._trackedTimers.add(t)
    return t
  }

  setInterval(fn, intervalMs) {
    return this.setTrackedInterval(fn, intervalMs)
  }

  clearTrackedTimer(t) {
    if (!t) return
    this._trackedTimers.delete(t)
    clearTimeout(t)
    clearInterval(t)
  }

  clearTimeout(t) {
    this.clearTrackedTimer(t)
  }

  clearInterval(t) {
    this.clearTrackedTimer(t)
  }

  isSessionBusy(sessionId) {
    if (!sessionId) return false
    if (this.activeTurns instanceof Map && this.activeTurns.has(sessionId)) return true
    if (this.activeProcs instanceof Map && this.activeProcs.has(sessionId)) return true
    if (this.runner && typeof this.runner.isSessionBusy === 'function' && this.runner.isSessionBusy(sessionId)) {
      return true
    }
    return false
  }

  disposeBase() {
    this.disposed = true
    for (const t of this._trackedTimers) {
      clearTimeout(t)
      clearInterval(t)
    }
    this._trackedTimers.clear()
    for (const proc of [...this._trackedProcs]) {
      killProcessTree(proc, { force: true })
    }
    this._trackedProcs.clear()
    this.parseCache.clear()
  }
}
