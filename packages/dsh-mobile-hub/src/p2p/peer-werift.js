import { RTCPeerConnection, RTCIceCandidate } from 'werift'
import { sendWithBackpressure } from '@allinone/shared/p2p-mux'

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
  let closed = false
  let pcClosed = false
  let teardownPromise = null
  let lastTransport = ''
  let remoteDescSet = false
  const pendingIce = []

  const teardown = () => {
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
    try { onTransportChange?.(nextTransport) } catch {}
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
  })

  pc.connectionStateChange.subscribe((st) => {
    if (closed) return
    try { onStateChange?.(String(st || '')) } catch {}
    if (st === 'failed' || st === 'closed') {
      fireClosed()
      return
    }
    void detectIceTransport()
  })

  const bindChannel = (dc) => {
    const label = String(dc.label || '')
    if (label === 'aio-ctrl') {
      ctrlDc = dc
      const notifyOpen = () => {
        if (!closed) {
          try { onCtrlOpen?.() } catch {}
          void detectIceTransport()
        }
      }
      if (dc.readyState === 'open') notifyOpen()
      dc.stateChanged.subscribe((s) => {
        if (s === 'open') notifyOpen()
        else if (s === 'closed') fireClosed()
      })
      dc.onMessage.subscribe((msg) => {
        if (closed) return
        const text = typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8')
        try { onCtrlMessage?.(text) } catch {}
      })
    } else if (label === 'aio-bulk') {
      bulkDc = dc
      try { dc.bufferedAmountLowThreshold = 512 * 1024 } catch {}
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
    sendCtrl(text) {
      if (closed || !ctrlDc || ctrlDc.readyState !== 'open') return false
      try {
        ctrlDc.send(String(text))
        return true
      } catch {
        return false
      }
    },
    async sendBulk(bytes, opts = {}) {
      if (closed || !bulkDc || bulkDc.readyState !== 'open') {
        throw new Error('Bulk DataChannel is not open')
      }
      const buf = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      await sendWithBackpressure(bulkDc, buf, opts)
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
