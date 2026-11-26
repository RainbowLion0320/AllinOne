import dgram from 'node:dgram'

/**
 * Zero-dependency, stateless RFC 5389 STUN Binding Server (UDP).
 *
 * Strictly implements STUN Binding Request (0x0001) -> Binding Success Response (0x0101)
 * with XOR-MAPPED-ADDRESS (0x0020) for IPv4 & IPv6.
 * NEVER relays data (NOT TURN): 20-byte request -> 32/44-byte response, zero session state.
 */

const STUN_BINDING_REQUEST = 0x0001
const STUN_BINDING_RESPONSE = 0x0101
const STUN_MAGIC_COOKIE = 0x2112a442
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
const STUN_HEADER_BYTES = 20
const STUN_MAX_PACKET_BYTES = 1024
const DEFAULT_MAX_PPS_PER_IP = 60
const DEFAULT_MAX_PPS_GLOBAL = 2000
const MAX_TRACKED_STUN_IPS = 4096

function parseIpv4Bytes(ip) {
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const parts = clean.split('.')
  if (parts.length !== 4) return null
  const out = Buffer.allocUnsafe(4)
  for (let i = 0; i < 4; i += 1) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out[i] = n
  }
  return out
}

function parseIpv6Bytes(ip) {
  const clean = String(ip || '').split('%')[0]
  if (!clean.includes(':')) return null
  const halves = clean.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const missing = 8 - (left.length + right.length)
  if (halves.length === 1 && missing !== 0) return null
  if (halves.length === 2 && missing < 1) return null
  const groups = [...left, ...new Array(Math.max(0, missing)).fill('0'), ...right]
  if (groups.length !== 8) return null
  const out = Buffer.allocUnsafe(16)
  for (let i = 0; i < 8; i += 1) {
    const val = parseInt(groups[i], 16)
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) return null
    out.writeUInt16BE(val, i * 2)
  }
  return out
}

/**
 * Build an RFC 5389 Binding Success Response for a valid Binding Request buffer.
 * Returns null if the incoming datagram is not a valid STUN Binding Request.
 */
export function buildStunBindingResponse(msg, remoteAddress, remotePort) {
  if (!Buffer.isBuffer(msg) || msg.length < STUN_HEADER_BYTES) return null
  const msgType = msg.readUInt16BE(0)
  if (msgType !== STUN_BINDING_REQUEST) return null
  const magic = msg.readUInt32BE(4)
  if (magic !== STUN_MAGIC_COOKIE) return null
  const declaredLen = msg.readUInt16BE(2)
  if (declaredLen + STUN_HEADER_BYTES > msg.length) return null

  const txId = msg.subarray(8, 20)
  const port = Number(remotePort) & 0xffff
  const xPort = port ^ (STUN_MAGIC_COOKIE >>> 16)

  const ipv4 = parseIpv4Bytes(String(remoteAddress || ''))
  if (ipv4) {
    // 20B STUN header + 12B XOR-MAPPED-ADDRESS (4B attr header + 8B value)
    const res = Buffer.allocUnsafe(32)
    res.writeUInt16BE(STUN_BINDING_RESPONSE, 0)
    res.writeUInt16BE(12, 2)
    res.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(res, 8)
    res.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 20)
    res.writeUInt16BE(8, 22)
    res[24] = 0x00
    res[25] = 0x01 // IPv4
    res.writeUInt16BE(xPort, 26)
    res[28] = ipv4[0] ^ 0x21
    res[29] = ipv4[1] ^ 0x12
    res[30] = ipv4[2] ^ 0xa4
    res[31] = ipv4[3] ^ 0x42
    return res
  }

  const ipv6 = parseIpv6Bytes(String(remoteAddress || ''))
  if (ipv6) {
    // 20B STUN header + 24B XOR-MAPPED-ADDRESS (4B attr header + 20B value)
    const res = Buffer.allocUnsafe(44)
    res.writeUInt16BE(STUN_BINDING_RESPONSE, 0)
    res.writeUInt16BE(24, 2)
    res.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    txId.copy(res, 8)
    res.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 20)
    res.writeUInt16BE(20, 22)
    res[24] = 0x00
    res[25] = 0x02 // IPv6
    res.writeUInt16BE(xPort, 26)
    const mask = msg.subarray(4, 20) // 4B magic cookie + 12B txId
    for (let i = 0; i < 16; i += 1) {
      res[28 + i] = ipv6[i] ^ mask[i]
    }
    return res
  }

  return null
}

/**
 * Create a lightweight stateless UDP STUN server.
 */
export function createStunServer({
  port = 3478,
  host = '0.0.0.0',
  maxPpsPerIp = DEFAULT_MAX_PPS_PER_IP,
  maxPpsGlobal = DEFAULT_MAX_PPS_GLOBAL,
  log = console,
} = {}) {
  let socket = null
  let boundPort = 0
  let requests = 0
  let dropped = 0
  let started = false
  const ipCap = Math.max(1, Number(maxPpsPerIp) || DEFAULT_MAX_PPS_PER_IP)
  const globalCap = Math.max(ipCap, Number(maxPpsGlobal) || DEFAULT_MAX_PPS_GLOBAL)
  let windowSec = Math.floor(Date.now() / 1000)
  let globalCount = 0
  const ipCounts = new Map()

  function allowPacket(ip) {
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec !== windowSec) {
      windowSec = nowSec
      globalCount = 0
      ipCounts.clear()
    }
    if (globalCount >= globalCap) {
      dropped += 1
      return false
    }
    const cleanIp = String(ip || '')
    const cur = ipCounts.get(cleanIp) || 0
    if (cur >= ipCap) {
      dropped += 1
      return false
    }
    if (!ipCounts.has(cleanIp) && ipCounts.size >= MAX_TRACKED_STUN_IPS) {
      dropped += 1
      return false
    }
    globalCount += 1
    ipCounts.set(cleanIp, cur + 1)
    return true
  }

  const start = () =>
    new Promise((resolveStart, rejectStart) => {
      if (started) {
        resolveStart({ port: boundPort, host })
        return
      }
      const isIpv6Bind = host === '::' || host.includes(':')
      const sock = dgram.createSocket({ type: isIpv6Bind ? 'udp6' : 'udp4', reuseAddr: true })
      socket = sock

      const onStartupError = (err) => {
        try { sock.close() } catch {}
        socket = null
        rejectStart(err)
      }
      sock.once('error', onStartupError)

      let lastErrorLogAt = 0
      sock.on('message', (msg, rinfo) => {
        if (!Buffer.isBuffer(msg) || msg.length < STUN_HEADER_BYTES || msg.length > STUN_MAX_PACKET_BYTES) return
        // Validate RFC 5389 Binding Request header BEFORE charging rate-limit quotas so UDP garbage cannot DoS STUN
        if (
          msg.readUInt16BE(0) !== STUN_BINDING_REQUEST ||
          msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE ||
          msg.readUInt16BE(2) + STUN_HEADER_BYTES > msg.length
        ) {
          return
        }
        if (!allowPacket(rinfo.address)) return
        const reply = buildStunBindingResponse(msg, rinfo.address, rinfo.port)
        if (!reply) return
        requests += 1
        try {
          sock.send(reply, rinfo.port, rinfo.address, () => {})
        } catch {}
      })

      sock.bind(port, host, () => {
        sock.off('error', onStartupError)
        sock.on('error', (err) => {
          const now = Date.now()
          if (now - lastErrorLogAt >= 10_000) {
            lastErrorLogAt = now
            log.warn?.(`[stun] UDP socket error: ${err?.message || err}`)
          }
        })
        const addr = sock.address()
        boundPort = typeof addr === 'object' && addr ? addr.port : port
        started = true
        resolveStart({ port: boundPort, host })
      })
    })

  const close = () =>
    new Promise((resolveClose) => {
      if (!socket) {
        started = false
        resolveClose()
        return
      }
      const s = socket
      socket = null
      started = false
      try {
        s.close(() => resolveClose())
      } catch {
        resolveClose()
      }
    })

  const getStats = () => ({
    enabled: started,
    port: boundPort,
    requests,
    dropped,
  })

  return { start, close, getStats }
}
