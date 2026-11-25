import { RTCPeerConnection, RTCIceCandidate } from 'werift'
import { sendWithBackpressure } from '../helpers/p2p-mux.js'

/**
 * Pure-JS `werift` WebRTC Peer backend for standalone CLI / headless Node.js bridges.
 * Zero C++ native bindings; implements the exact same interface as `peer-electron.js`.
 */
export function createWeriftPeer({
  iceServers = [],
  onIceCandidate,
  onStateChange,
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
  let remoteDescSet = false
  const pendingIce = []

  const fireClosed = () => {
    if (closed) return
    closed = true
    try { onClose?.() } catch {}
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
    }
  })

  pc.connectionStateChange.subscribe((st) => {
    if (closed) return
    try { onStateChange?.(String(st || '')) } catch {}
    if (st === 'failed' || st === 'closed') {
      fireClosed()
    }
  })

  const bindChannel = (dc) => {
    const label = String(dc.label || '')
    if (label === 'aio-ctrl') {
      ctrlDc = dc
      const notifyOpen = () => {
        if (!closed) {
          try { onCtrlOpen?.() } catch {}
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
      await pc.setRemoteDescription({ type: 'offer', sdp: String(sdp || '') })
      remoteDescSet = true
      while (pendingIce.length > 0) {
        const c = pendingIce.shift()
        try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch {}
      }
      const answer = await pc.createAnswer()
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
      if (closed) return
      closed = true
      try { ctrlDc?.close?.() } catch {}
      try { bulkDc?.close?.() } catch {}
      try { await pc.close() } catch {}
      try { onClose?.() } catch {}
    },
  }
}
