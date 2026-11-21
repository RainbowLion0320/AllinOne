import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { RPC } from '@allinone/shared'
import { createAuthManager } from './auth.js'
import { RelayHub } from './hub.js'
import { createRoomStore } from './rooms.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** Load simple .env file if present (no extra dependency needed). */
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv(resolve(__dirname, '../.env'))
loadDotEnv(resolve(__dirname, '../../../.env'))

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
  '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // 15MB

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectPromise(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text.length > 0 ? JSON.parse(text) : {})
      } catch (err) {
        rejectPromise(err)
      }
    })
    req.on('error', rejectPromise)
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function setCors(req, res) {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Secret, X-Room-Id')
}

export function createRelayServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8787)
  const host = String(options.host ?? process.env.HOST ?? '0.0.0.0')
  const clientAccessToken = String(options.clientAccessToken ?? process.env.CLIENT_ACCESS_TOKEN ?? 'allinone-dev-pass')
  const bridgeSecret = String(options.bridgeSecret ?? process.env.BRIDGE_SECRET ?? 'allinone-dev-bridge')
  const jwtSecret = String(options.jwtSecret ?? process.env.JWT_SECRET ?? '')
  const publicRelayUrl = String(options.publicRelayUrl ?? process.env.PUBLIC_RELAY_URL ?? '').trim().replace(/\/+$/, '')
  const staticDir = resolve(
    options.staticDir ?? (process.env.STATIC_DIR || resolve(__dirname, '../../mobile-app/dist')),
  )
  const uploadDir = resolve(
    options.uploadDir ?? (process.env.UPLOAD_DIR || resolve(__dirname, '../data/uploads')),
  )
  const roomsFile = resolve(
    options.roomsFile ?? (process.env.ROOMS_FILE || resolve(__dirname, '../data/rooms.json')),
  )
  mkdirSync(uploadDir, { recursive: true })

  const auth = createAuthManager({ clientAccessToken, bridgeSecret, jwtSecret })
  const rooms = createRoomStore({ filePath: roomsFile })
  const hub = new RelayHub()

  // Small in-memory LRU cache for bridged PC images (strictly namespaced by roomId)
  const BRIDGE_IMG_CACHE_MAX_ITEMS = 32
  const BRIDGE_IMG_CACHE_MAX_BYTES = 48 * 1024 * 1024
  const BRIDGE_IMG_CACHE_TTL_MS = 5 * 60 * 1000
  const bridgeImgCache = new Map()
  let bridgeImgCacheBytes = 0

  function getCachedBridgeImage(key) {
    const entry = bridgeImgCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.cachedAt > BRIDGE_IMG_CACHE_TTL_MS) {
      bridgeImgCache.delete(key)
      bridgeImgCacheBytes -= entry.buf.length
      return null
    }
    bridgeImgCache.delete(key)
    bridgeImgCache.set(key, entry)
    return entry
  }

  function setCachedBridgeImage(key, entry) {
    if (entry.buf.length > BRIDGE_IMG_CACHE_MAX_BYTES / 2) return
    const existing = bridgeImgCache.get(key)
    if (existing) {
      bridgeImgCache.delete(key)
      bridgeImgCacheBytes -= existing.buf.length
    }
    while (
      bridgeImgCache.size >= BRIDGE_IMG_CACHE_MAX_ITEMS ||
      bridgeImgCacheBytes + entry.buf.length > BRIDGE_IMG_CACHE_MAX_BYTES
    ) {
      const oldestKey = bridgeImgCache.keys().next().value
      if (!oldestKey) break
      const oldest = bridgeImgCache.get(oldestKey)
      bridgeImgCache.delete(oldestKey)
      if (oldest) bridgeImgCacheBytes -= oldest.buf.length
    }
    bridgeImgCache.set(key, entry)
    bridgeImgCacheBytes += entry.buf.length
  }

  // Periodic cleanup of uploaded temporary files older than 24h
  const cleanupTimer = setInterval(() => {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const file of readdirSync(uploadDir)) {
        const fp = join(uploadDir, file)
        const st = statSync(fp)
        if (st.mtimeMs < cutoff) unlinkSync(fp)
      }
    } catch {}
  }, 60 * 60 * 1000)
  cleanupTimer.unref()

  function extractBearer(req, urlObj) {
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) return header.slice(7).trim()
    return urlObj.searchParams.get('token') || ''
  }

  function getClientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .split(',')[0]
      .trim()
  }

  /** Authenticate a PC Bridge request and return its authoritative `roomId` or null. */
  function authenticateBridge(req, urlObj) {
    const secret = String(req.headers['x-bridge-secret'] || urlObj.searchParams.get('secret') || urlObj.searchParams.get('bridgeSecret') || '').trim()
    const requestedRoom = String(req.headers['x-room-id'] || urlObj.searchParams.get('roomId') || '').trim()
    if (!secret) return null
    if (!requestedRoom || requestedRoom === 'owner') {
      return auth.verifyBridgeSecret(secret) ? 'owner' : null
    }
    return rooms.verifyBridge(requestedRoom, secret) ? requestedRoom : null
  }

  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = urlObj.pathname

    // Health check (privacy-safe: only exposes own room bridges when authenticated)
    if (pathname === '/api/health' && req.method === 'GET') {
      const user = auth.verifySessionToken(extractBearer(req, urlObj))
      sendJson(res, 200, {
        ok: true,
        ...(user ? { roomId: user.room, bridges: hub.getBridgeList(user.room) } : {}),
        onlineBridges: hub.getOnlineBridgeCount(),
        clients: hub.clients.size,
        rooms: rooms.count() + 1,
        uptimeSec: Math.round(process.uptime()),
      })
      return
    }

    // Multi-tenant: Register a brand-new isolated room for a friend's PC
    if (pathname === '/api/rooms/register' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRegisterLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '创建设备过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const created = rooms.registerRoom({ label: body.label || body.hostname || 'My PC' })
        sendJson(res, 200, { ok: true, ...created })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Multi-tenant: Refresh 15-min pairing code for an existing PC bridge room
    if (pathname === '/api/rooms/pair-code' && req.method === 'POST') {
      const secret = String(req.headers['x-bridge-secret'] || '').trim()
      const roomId = String(req.headers['x-room-id'] || '').trim()
      if (!roomId || !secret || roomId === 'owner') {
        sendJson(res, 401, { ok: false, error: '未授权的房间凭证' })
        return
      }
      const refreshed = rooms.refreshPairCode(roomId, secret)
      if (!refreshed) {
        sendJson(res, 401, { ok: false, error: '房间密钥无效' })
        return
      }
      sendJson(res, 200, { ok: true, ...refreshed })
      return
    }

    // Multi-tenant: Mobile pairing via 8-char Pairing Code or QR pairToken -> room-scoped 30-day JWT
    if (pathname === '/api/auth/pair' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const result = rooms.exchangePair({
          pairCode: body.pairCode || body.code || '',
          pairToken: body.pairToken || body.token || '',
        })
        if (!result.ok) {
          auth.recordFailure(ip)
          sendJson(res, 401, { ok: false, error: result.error })
          return
        }
        auth.clearFailure(ip)
        const token = auth.signSessionToken(result.roomId, body.deviceName || 'mobile', result.roomId)
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: result.roomId,
          label: result.label,
          bridges: hub.getBridgeList(result.roomId),
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Owner mobile login -> signed session token strictly scoped to `room = 'owner'`
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (!auth.verifyAccessPassword(body.password || body.token || '')) {
          auth.recordFailure(ip)
          sendJson(res, 401, { ok: false, error: '访问密钥不正确' })
          return
        }
        auth.clearFailure(ip)
        const token = auth.signSessionToken('owner', body.deviceName || 'mobile', 'owner')
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: 'owner',
          bridges: hub.getBridgeList('owner'),
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Verify existing session token
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req, urlObj))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      const roomMeta = rooms.getRoomMeta(payload.room)
      sendJson(res, 200, {
        ok: true,
        user: payload,
        roomId: payload.room,
        label: roomMeta?.label || '',
        bridges: hub.getBridgeList(payload.room),
      })
      return
    }

    // Attachment upload (scoped strictly to caller's roomId)
    if (pathname === '/api/uploads' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req, urlObj))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      try {
        const body = await readJsonBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.45))
        const rawBase64 = String(body.dataBase64 || '')
        const cleanBase64 = rawBase64.includes(',') ? rawBase64.split(',').pop() : rawBase64
        const buf = Buffer.from(cleanBase64, 'base64')
        if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
          sendJson(res, 400, { ok: false, error: '文件为空或超过 15MB 限制' })
          return
        }
        const safeName = String(body.filename || 'upload.bin').replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_').slice(0, 100)
        const id = randomUUID()
        const meta = {
          id,
          roomId: payload.room || 'owner',
          filename: safeName,
          mimeType: String(body.mimeType || 'application/octet-stream'),
          size: buf.length,
          createdAt: Date.now(),
        }
        writeFileSync(join(uploadDir, `${id}.bin`), buf)
        writeFileSync(join(uploadDir, `${id}.json`), JSON.stringify(meta))
        sendJson(res, 200, {
          ok: true,
          upload: {
            id: meta.id,
            filename: meta.filename,
            mimeType: meta.mimeType,
            size: meta.size,
            createdAt: meta.createdAt,
            url: `/api/uploads/${id}`,
          },
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `上传失败：${String(err.message || err)}` })
      }
      return
    }

    // Proxy local PC image files strictly through the authenticated user's OWN room bridge
    if (pathname === '/api/bridge-file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const payload = auth.verifySessionToken(extractBearer(req, urlObj))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      const roomId = payload.room || 'owner'
      const filePath = urlObj.searchParams.get('path') || ''
      const cwd = urlObj.searchParams.get('cwd') || ''
      const bridgeId = urlObj.searchParams.get('bridgeId') || undefined
      const asDownload = urlObj.searchParams.get('download') === '1'
      if (!filePath.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        return
      }

      const cacheKey = `${roomId}|${bridgeId || 'primary'}|${cwd}|${filePath}`
      try {
        let entry = getCachedBridgeImage(cacheKey)
        if (!entry) {
          const result = await hub.callBridge(
            roomId,
            RPC.FILE_READ,
            { path: filePath, cwd },
            { bridgeId, timeoutMs: 25_000 },
          )
          if (!result?.dataBase64 || !String(result.mimeType || '').startsWith('image/')) {
            sendJson(res, 403, { ok: false, error: '仅支持预览图片文件' })
            return
          }
          const buf = Buffer.from(result.dataBase64, 'base64')
          entry = {
            buf,
            mimeType: result.mimeType,
            filename: result.filename || 'image.png',
            cachedAt: Date.now(),
          }
          setCachedBridgeImage(cacheKey, entry)
        }

        const headers = {
          'Content-Type': entry.mimeType,
          'Content-Length': entry.buf.length,
          'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        }
        if (entry.mimeType === 'image/svg+xml') {
          headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
        }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else res.end(entry.buf)
      } catch (err) {
        const msg = String(err?.message || err)
        const status = err?.code === 'BRIDGE_OFFLINE'
          ? 503
          : /找不到/.test(msg)
            ? 404
            : /仅允许|不支持/.test(msg)
              ? 403
              : 500
        sendJson(res, status, { ok: false, error: msg })
      }
      return
    }

    // Attachment download (strictly isolated to the owning roomId!)
    if (pathname.startsWith('/api/uploads/') && req.method === 'GET') {
      const bridgeRoom = authenticateBridge(req, urlObj)
      const clientUser = auth.verifySessionToken(extractBearer(req, urlObj))
      const callerRoom = bridgeRoom || clientUser?.room || null
      if (!callerRoom) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      const id = pathname.slice('/api/uploads/'.length).replace(/[^a-zA-Z0-9-]/g, '')
      const binPath = join(uploadDir, `${id}.bin`)
      const metaPath = join(uploadDir, `${id}.json`)
      if (!existsSync(binPath) || !existsSync(metaPath)) {
        sendJson(res, 404, { ok: false, error: '文件不存在或已过期' })
        return
      }
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      const fileRoom = meta.roomId || 'owner'
      if (fileRoom !== callerRoom) {
        sendJson(res, 403, { ok: false, error: '无权访问其他房间的文件' })
        return
      }
      const data = readFileSync(binPath)
      res.writeHead(200, {
        'Content-Type': meta.mimeType || 'application/octet-stream',
        'Content-Length': data.length,
        'Content-Disposition': `inline; filename="${encodeURIComponent(meta.filename)}"`,
      })
      res.end(data)
      return
    }

    // Static PWA, installer scripts (.ps1/.sh/.mjs), & APK serving
    if ((req.method === 'GET' || req.method === 'HEAD') && existsSync(staticDir)) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const candidate = resolve(staticDir, normalize(rel))
      let target = null
      if (candidate.startsWith(staticDir) && existsSync(candidate) && statSync(candidate).isFile()) {
        target = candidate
      } else if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws/') && !pathname.startsWith('/downloads/')) {
        const indexHtml = join(staticDir, 'index.html')
        if (existsSync(indexHtml)) target = indexHtml
      }
      if (target) {
        const ext = extname(target).toLowerCase()
        const isMutable =
          ext === '.html' ||
          ext === '.ps1' ||
          ext === '.sh' ||
          ext === '.mjs' ||
          target.endsWith('sw.js') ||
          target.endsWith('registerSW.js') ||
          target.endsWith('manifest.webmanifest')

        // Dynamically inject this server's public URL into setup.ps1 / setup.sh so the public repo stays 100% generic
        if (ext === '.ps1' || ext === '.sh') {
          const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
          const inferredOrigin = req.headers.host ? `${proto}://${req.headers.host}` : ''
          const effectiveUrl = publicRelayUrl || inferredOrigin
          let scriptBody = readFileSync(target, 'utf8')
          if (effectiveUrl) {
            scriptBody = scriptBody.replaceAll('https://your-relay.example.com', effectiveUrl)
          }
          const buf = Buffer.from(scriptBody, 'utf8')
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8',
            'Content-Length': buf.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          })
          if (req.method === 'HEAD') res.end()
          else res.end(buf)
          return
        }

        const st = statSync(target)
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': isMutable ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
        })
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(readFileSync(target))
        }
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' })
  })

  // WebSocket server handling both /ws/bridge and /ws/client (32MB supports high-res PC screenshots)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = urlObj.pathname

    if (pathname === '/ws/bridge') {
      const roomId = authenticateBridge(req, urlObj)
      if (!roomId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const meta = {
        roomId,
        bridgeId: urlObj.searchParams.get('bridgeId') || 'home-pc',
        hostname: urlObj.searchParams.get('hostname') || 'PC',
        platform: urlObj.searchParams.get('platform') || 'win32',
        mode: urlObj.searchParams.get('mode') || 'dsh-plugin',
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.registerBridge(ws, meta)
      })
      return
    }

    if (pathname === '/ws/client') {
      const token = extractBearer(req, urlObj)
      const user = auth.verifySessionToken(token)
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const lastSeq = Number(urlObj.searchParams.get('lastSeq') || 0)
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.registerClient(ws, user, { lastSeq })
      })
      return
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  })

  const start = () =>
    new Promise((resolveStart) => {
      server.listen(port, host, () => {
        const addr = server.address()
        const boundPort = typeof addr === 'object' && addr ? addr.port : port
        console.log(`[relay] AllinOne Relay Server listening on http://${host}:${boundPort}`)
        console.log(`[relay] Static PWA dir: ${staticDir} (${existsSync(staticDir) ? 'ready' : 'not built yet'})`)
        if (clientAccessToken === 'allinone-dev-pass' || bridgeSecret === 'allinone-dev-bridge') {
          console.warn('[relay] WARNING: Using default dev secrets! Please set CLIENT_ACCESS_TOKEN and BRIDGE_SECRET in .env before deploying publicly.')
        }
        resolveStart({ port: boundPort, host })
      })
    })

  const close = () =>
    new Promise((resolveClose) => {
      clearInterval(cleanupTimer)
      hub.shutdown()
      wss.close(() => {
        server.close(() => resolveClose())
      })
    })

  return { server, wss, hub, rooms, start, close }
}

// Run directly when invoked as main script
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const app = createRelayServer()
  app.start()
  const shutdown = () => {
    app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
