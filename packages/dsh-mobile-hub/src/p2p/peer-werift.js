import { RTCPeerConnection, RTCIceCandidate } from 'werift'
import { createSerializedChannelWriter } from '@allinone/shared/p2p-mux'

const CTRL_HIGH_WATER_BYTES = 1024 * 1024
const CTRL_LOW_WATER_BYTES = 256 * 1024

/**
 * Wrap a `werift` RTCDataChannel with a browser-compatible EventTarget + Buffer-converting `send()`
 * surface so `createSerializedChannelWriter` / `waitForChannelDrain` receive immediate `bufferedamountlow`
 * and `close` notifications without racing or throwing on `Uint8Array` views.
 */
function wrapWeriftDataChannel(dc, isPeerClosed) {
  const subsByType = {
    bufferedamountlow: new Map(),
    close: new Map(),
  }

  return {
    get readyState() {
      return isPeerClosed() ? 'closed' : dc.readyState
    },
    get bufferedAmount() {
      return Number(dc.bufferedAmount || 0)
    },
    get bufferedAmountLowThreshold() {
      return dc.bufferedAmountLowThreshold
    },
    set bufferedAmountLowThreshold(v) {
      try {
        dc.bufferedAmountLowThreshold = v
      } catch {}
    },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return
      if (type === 'bufferedamountlow' && dc.bufferedAmountLow && typeof dc.bufferedAmountLow.subscribe === 'function') {
        if (subsByType.bufferedamountlow.has(fn)) return
        const sub = dc.bufferedAmountLow.subscribe(() => fn())
        subsByType.bufferedamountlow.set(fn, sub)
      } else if (type === 'close' && dc.stateChanged && typeof dc.stateChanged.subscribe === 'function') {
        if (subsByType.close.has(fn)) return
        const sub = dc.stateChanged.subscribe((s) => {
          if (s === 'closed' || s === 'closing') fn()
        })
        subsByType.close.set(fn, sub)
      }
    },
    removeEventListener(type, fn) {
      const bucket = subsByType[type]
      if (!bucket) return
      const sub = bucket.get(fn)
      if (sub) {
        bucket.delete(fn)
        try { sub.unsubscribe?.() } catch {}
      }
    },
    send(data) {
      if (isPeerClosed() || dc.readyState !== 'open') {
        throw new Error('DataChannel closed')
      }
      if (typeof data === 'string') {
        dc.send(data)
        return
      }
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      dc.send(buf)
    },
  }
}

/**
 * Pure-JS `werift` WebRTC Peer backend for standalone CLI / headless Node.js bridges.
 * Zero C++ native bindings; implements the exact same interface as `peer-electron.js`.
 */
export function createWeriftPeer({
  iceServers = [],
  onIceCandidate,
  onStateChange,
  onTransportChange,
  onCtrlOpen,
  onCtrlMessage,
  onBulkOpen,
  onBulkMessage,
  onClose,
} = {}) {
  const normalizedIce = Array.isArray(iceServers)
    ? iceServers.map((s) => (typeof s === 'string' ? { urls: s } : s)).filter((s) => s?.urls)
    : []

  const pc = new RTCPeerConnection({
    iceServers: normalizedIce,
    // Cap per-interface STUN gather wait at 1.5s (seconds) so virtual/isolated NICs
    // (Docker, WSL, Hyper-V) never stall Answer generation for 5-40s.
    iceStunGatherTimeout: 1.5,
  })
  let ctrlDc = null
  let bulkDc = null
  let ctrlChannel = null
  let bulkChannel = null
  let closed = false
  let pcClosed = false
  let teardownPromise = null
  let lastTransport = ''
  let remoteDescSet = false
  const pendingIce = []
  const detectTimers = new Set()

  const ctrlWriter = createSerializedChannelWriter(null, {
    highWaterMark: CTRL_HIGH_WATER_BYTES,
    lowWaterMark: CTRL_LOW_WATER_BYTES,
    timeoutMs: 30_000,
  })
  const bulkWriter = createSerializedChannelWriter()

  const clearDetectTimers = () => {
    for (const t of detectTimers) clearTimeout(t)
    detectTimers.clear()
  }

  const teardown = () => {
    clearDetectTimers()
    ctrlWriter.close()
    bulkWriter.close()
    if (pcClosed) return teardownPromise || Promise.resolve()
    pcClosed = true
    teardownPromise = (async () => {
      try { ctrlDc?.close?.() } catch {}
      try { bulkDc?.close?.() } catch {}
      try { await pc.close() } catch {}
    })()
    return teardownPromise
  }

  const fireClosed = () => {
    void teardown()
    if (closed) return
    closed = true
    try { onClose?.() } catch {}
  }

  const reportTransport = (nextTransport) => {
    if (closed || !nextTransport || nextTransport === lastTransport) return
    lastTransport = nextTransport
    clearDetectTimers()
    try { onTransportChange?.(nextTransport) } catch {}
  }

  const scheduleTransportRetries = () => {
    if (closed || lastTransport) return
    for (const delay of [300, 1000, 2500]) {
      const t = setTimeout(() => {
        detectTimers.delete(t)
        if (!closed && !lastTransport) void detectIceTransport()
      }, delay)
      t.unref?.()
      detectTimers.add(t)
    }
  }

  const detectIceTransport = async () => {
    if (closed) return
    try {
      const transport = pc.iceTransports?.[0]
      const pair = transport?.getSelectedCandidatePair?.()
      const localCandidate = pair?.localCandidate || pair?.local
      const remoteCandidate = pair?.remoteCandidate || pair?.remote
      if (localCandidate || remoteCandidate) {
        const localType = localCandidate?.type || localCandidate?.candidateType
        const remoteType = remoteCandidate?.type || remoteCandidate?.candidateType
        reportTransport(localType === 'relay' || remoteType === 'relay' ? 'relay' : 'direct')
        return
      }
    } catch {}

    if (typeof pc.getStats !== 'function') return
    try {
      const stats = await pc.getStats()
      if (closed || !stats) return
      let pair = null
      stats.forEach((rep) => {
        if (rep?.type === 'transport' && rep.selectedCandidatePairId) {
          pair = stats.get(rep.selectedCandidatePairId) || pair
        }
      })
      if (!pair) {
        stats.forEach((rep) => {
          if (rep?.type === 'candidate-pair' && (rep.selected || (rep.nominated && rep.state === 'succeeded'))) {
            pair = rep
          }
        })
      }
      if (!pair) return
      const lc = pair.localCandidateId ? stats.get(pair.localCandidateId) : null
      const rc = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null
      if (!lc && !rc) return
      const isRelay =
        (lc?.candidateType || lc?.type) === 'relay' ||
        (rc?.candidateType || rc?.type) === 'relay'
      reportTransport(isRelay ? 'relay' : 'direct')
    } catch {}
  }

  pc.onIceCandidate.subscribe((cand) => {
    if (closed || !cand) return
    const json = typeof cand.toJSON === 'function' ? cand.toJSON() : cand
    if (!json?.candidate) return
    try { onIceCandidate?.(json) } catch {}
  })

  pc.iceConnectionStateChange.subscribe((st) => {
    if (closed) return
    try { onStateChange?.(String(st || '')) } catch {}
    if (st === 'failed' || st === 'closed') {
      fireClosed()
      return
    }
    void detectIceTransport()
    if (st === 'connected' || st === 'completed') scheduleTransportRetries()
  })

  pc.connectionStateChange.subscribe((st) => {
    if (closed) return
    try { onStateChange?.(String(st || '')) } catch {}
    if (st === 'failed' || st === 'closed') {
      fireClosed()
      return
    }
    void detectIceTransport()
    if (st === 'connected') scheduleTransportRetries()
  })

  const bindChannel = (dc) => {
    const label = String(dc.label || '')
    if (label === 'aio-ctrl') {
      ctrlDc = dc
      ctrlChannel = wrapWeriftDataChannel(dc, () => closed)
      ctrlWriter.setChannel(ctrlChannel)
      const notifyOpen = () => {
        if (!closed) {
          try { onCtrlOpen?.() } catch {}
          void detectIceTransport()
          scheduleTransportRetries()
        }
      }
      if (dc.readyState === 'open') notifyOpen()
      dc.stateChanged.subscribe((s) => {
        if (s === 'open') notifyOpen()
        else if (s === 'closed') fireClosed()
      })
      dc.onMessage.subscribe((msg) => {
        if (closed) return
        const bytes =
          msg instanceof Uint8Array
            ? msg
            : Buffer.isBuffer(msg)
              ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
              : new Uint8Array(Buffer.from(String(msg), 'utf8'))
        try { onCtrlMessage?.(bytes) } catch {}
      })
    } else if (label === 'aio-bulk') {
      bulkDc = dc
      try { dc.bufferedAmountLowThreshold = 512 * 1024 } catch {}
      bulkChannel = wrapWeriftDataChannel(dc, () => closed)
      bulkWriter.setChannel(bulkChannel)
      const notifyOpen = () => {
        if (!closed) {
          try { onBulkOpen?.() } catch {}
        }
      }
      if (dc.readyState === 'open') notifyOpen()
      dc.stateChanged.subscribe((s) => {
        if (s === 'open') notifyOpen()
      })
      dc.onMessage.subscribe((msg) => {
        if (closed) return
        const bytes =
          msg instanceof Uint8Array
            ? msg
            : Buffer.isBuffer(msg)
              ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
              : new Uint8Array(Buffer.from(String(msg), 'utf8'))
        try { onBulkMessage?.(bytes) } catch {}
      })
    }
  }

  pc.onDataChannel.subscribe(bindChannel)

  return {
    engine: 'werift',
    ctrlWriter,
    bulkWriter,
    getCtrlChannel() {
      return ctrlChannel
    },
    getBulkChannel() {
      return bulkChannel
    },
    async handleOffer(sdp) {
      if (closed) throw new Error('WebRTC peer closed')
      await pc.setRemoteDescription({ type: 'offer', sdp: String(sdp || '') })
      if (closed) throw new Error('WebRTC peer closed')
      remoteDescSet = true
      while (pendingIce.length > 0 && !closed) {
        const c = pendingIce.shift()
        try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch {}
      }
      if (closed) throw new Error('WebRTC peer closed')
      const answer = await pc.createAnswer()
      if (closed) throw new Error('WebRTC peer closed')
      await pc.setLocalDescription(answer)
      return { type: 'answer', sdp: pc.localDescription?.sdp || answer.sdp }
    },
    async addIceCandidate(cand) {
      if (closed || !cand || !cand.candidate) return
      if (!remoteDescSet) {
        pendingIce.push(cand)
        return
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand))
      } catch {}
    },
    isCtrlOpen() {
      return !closed && Boolean(ctrlDc && ctrlDc.readyState === 'open')
    },
    isBulkOpen() {
      return !closed && Boolean(bulkDc && bulkDc.readyState === 'open')
    },
    sendCtrl(data) {
      if (closed || !ctrlDc || ctrlDc.readyState !== 'open') return false
      try {
        if (typeof data === 'string') {
          ctrlDc.send(data)
        } else {
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          ctrlDc.send(buf)
        }
        return true
      } catch {
        return false
      }
    },
    async sendBulk(bytes, opts = {}) {
      if (closed || !bulkDc || bulkDc.readyState !== 'open') {
        throw new Error('Bulk DataChannel is not open')
      }
      await bulkWriter.send(bytes, opts)
    },
    async close() {
      const shouldNotify = !closed
      closed = true
      await teardown()
      if (shouldNotify) {
        try { onClose?.() } catch {}
      }
    },
  }
}
