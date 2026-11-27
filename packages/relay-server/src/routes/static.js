import { createReadStream, existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { SANDBOX_PREVIEW_CSP } from '@allinone/shared'
import { resolveSafePublicScriptUrl, sendJson } from '../http-utils.js'

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
  '.dmg': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
}

const APP_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

const ADMIN_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

const ADMIN_FILE_MAP = Object.freeze({
  '/admin': 'index.html',
  '/admin/': 'index.html',
  '/admin/index.html': 'index.html',
  '/admin/styles.css': 'styles.css',
  '/admin/app.js': 'app.js',
})

/**
 * Async static PWA, setup script templating, and Admin Dashboard asset handler.
 * Uses `fs/promises` + `realpath` symlink containment and caches immutable admin assets in memory.
 */
export function createStaticHandler({
  staticDir,
  adminDashboardDir,
  relayVersion,
  publicRelayUrl,
  isTrustedProxy,
}) {
  /** @type {Map<string, { mtimeMs: number, buf: Buffer }>} */
  const adminCache = new Map()
  let resolvedStaticRoot = null

  async function getStaticRoot() {
    if (resolvedStaticRoot !== null) return resolvedStaticRoot
    try {
      resolvedStaticRoot = await realpath(staticDir)
    } catch {
      resolvedStaticRoot = resolve(staticDir)
    }
    return resolvedStaticRoot
  }

  async function handleAdminAsset(req, res, pathname) {
    const mapped = ADMIN_FILE_MAP[pathname]
    if (!mapped) {
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return true
    }
    const adminTarget = join(adminDashboardDir, mapped)
    try {
      const st = await stat(adminTarget)
      if (!st.isFile()) {
        sendJson(res, 404, { ok: false, error: 'Not Found' })
        return true
      }
      const cacheKey = `${pathname}`
      const cached = adminCache.get(cacheKey)
      let buf
      const ext = extname(adminTarget).toLowerCase()
      if (cached && cached.mtimeMs === st.mtimeMs) {
        buf = cached.buf
      } else {
        buf = await readFile(adminTarget)
        if (ext === '.html') {
          let html = buf.toString('utf8').replaceAll('__RELAY_VERSION__', relayVersion)
          if (pathname === '/admin') {
            html = html
              .replaceAll('href="./styles.css"', 'href="admin/styles.css"')
              .replaceAll('src="./app.js"', 'src="admin/app.js"')
              .replaceAll('href="../"', 'href="./"')
          }
          buf = Buffer.from(html, 'utf8')
        }
        adminCache.set(cacheKey, { mtimeMs: st.mtimeMs, buf })
      }
      const headers = {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }
      if (ext === '.html') {
        headers['Content-Security-Policy'] = ADMIN_HTML_CSP
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') res.end()
      else res.end(buf)
      return true
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return true
    }
  }

  async function handleStaticRequest(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false

    if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) {
      return handleAdminAsset(req, res, pathname)
    }

    if (!existsSync(staticDir)) return false

    let decodedPathname = pathname
    try {
      decodedPathname = decodeURIComponent(pathname)
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad Request' })
      return true
    }
    if (decodedPathname.includes('\0')) {
      sendJson(res, 400, { ok: false, error: 'Bad Request' })
      return true
    }

    const staticRoot = await getStaticRoot()
    const rel = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '')
    const candidate = resolve(staticRoot, normalize(rel))
    let target = null
    let targetStat = null

    const isInside = (p) => p === staticRoot || p.startsWith(`${staticRoot}${sep}`)
    if (isInside(candidate)) {
      try {
        const real = await realpath(candidate)
        if (isInside(real)) {
          const st = await stat(real)
          if (st.isFile()) {
            target = real
            targetStat = st
          }
        }
      } catch {}
    }

    if (
      !target &&
      !decodedPathname.startsWith('/api/') &&
      !decodedPathname.startsWith('/ws/') &&
      !decodedPathname.startsWith('/downloads/') &&
      !decodedPathname.startsWith('/admin')
    ) {
      const indexHtml = join(staticRoot, 'index.html')
      try {
        const real = await realpath(indexHtml)
        if (isInside(real)) {
          const st = await stat(real)
          if (st.isFile()) {
            target = real
            targetStat = st
          }
        }
      } catch {}
    }

    if (!target || !targetStat) return false

    try {
      const ext = extname(target).toLowerCase()
      const fileBase = basename(target)
      const relPosix = target.slice(staticRoot.length).replace(/\\/g, '/')

      if (ext === '.ps1' || ext === '.sh') {
        const effectiveUrl = resolveSafePublicScriptUrl(req, publicRelayUrl, isTrustedProxy)
        let scriptBody = await readFile(target, 'utf8')
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
        return true
      }

      const isNoStore =
        ext === '.html' ||
        fileBase === 'sw.js' ||
        fileBase === 'registerSW.js' ||
        fileBase === 'manifest.webmanifest'

      // Strictly opt-in `immutable` ONLY for content-hashed bundles under `/assets/*`.
      // Unhashed downloads/binaries/icons/manifests (`.apk`, `.dmg`, `.exe`, `icon-*.png`,
      // `All-in-One-WebBundle.json`, `allinone-bridge.mjs`, etc.) revalidate cleanly.
      const isHashedAsset =
        relPosix.startsWith('/assets/') &&
        /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i.test(fileBase)

      const cacheControl = isNoStore
        ? 'no-cache, no-store, must-revalidate'
        : isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300, must-revalidate'

      const staticHeaders = {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': targetStat.size,
        'Cache-Control': cacheControl,
      }
      if (ext === '.html') {
        const isSandboxPreview = basename(target).toLowerCase() === 'sandbox-preview.html'
        staticHeaders['Content-Security-Policy'] = isSandboxPreview ? SANDBOX_PREVIEW_CSP : APP_HTML_CSP
        if (isSandboxPreview) {
          staticHeaders['X-Frame-Options'] = 'SAMEORIGIN'
        }
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, staticHeaders)
        res.end()
        return true
      }

      const stream = createReadStream(target)
      stream.on('open', () => {
        if (!res.headersSent) {
          res.writeHead(200, staticHeaders)
        }
        stream.pipe(res)
      })
      stream.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 404, { ok: false, error: 'Not Found' })
        } else {
          try { res.destroy() } catch {}
        }
      })
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy()
      })
      return true
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return true
    }
  }

  return { handleStaticRequest }
}
