#!/usr/bin/env node
/**
 * Prepares icons, bundled renderer UI, and embedded portable PC bridge for @allinone/desktop-app.
 * Works on macOS (generates .icns + .ico + tray PNGs) and Windows/Linux (.ico + tray PNGs).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const MOBILE_ROOT = join(REPO_ROOT, 'packages', 'mobile-app')
const MOBILE_DIST = join(MOBILE_ROOT, 'dist')
const MOBILE_PUBLIC = join(MOBILE_ROOT, 'public')
const BUILD_DIR = join(DESKTOP_ROOT, 'build')
const RENDERER_DIR = join(DESKTOP_ROOT, 'renderer')
const BRIDGE_DIR = join(DESKTOP_ROOT, 'bridge-runtime')

// ---------------------------------------------------------------------------
// Minimal pure-Node PNG encoder for crisp monochrome macOS Tray Template Icons
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodeRgbaPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * (width * 4 + 1)
    raw[rowOff] = 0 // filter: None
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    makePngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Draw crisp concentric-ring "All in One" monochrome template icon for macOS menu bar.
 * Black pixels with anti-aliased alpha so macOS auto-renders white on dark bar & black on light bar.
 */
function renderTrayTemplatePng(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const outerR = size * 0.42
  const outerW = Math.max(1.4, size * 0.095)
  const innerR = size * 0.20
  const innerW = Math.max(1.2, size * 0.085)
  const dotR = size * 0.075

  const smoothAlpha = (dist, targetR, halfW) => {
    const d = Math.abs(dist - targetR)
    const edge = halfW - d
    return Math.max(0, Math.min(1, edge + 0.65))
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy)
      const aOuter = smoothAlpha(dist, outerR, outerW / 2)
      const aInner = smoothAlpha(dist, innerR, innerW / 2)
      const aDot = Math.max(0, Math.min(1, dotR - dist + 0.65))
      const alpha = Math.max(aOuter, aInner, aDot)
      const idx = (y * size + x) * 4
      rgba[idx] = 0
      rgba[idx + 1] = 0
      rgba[idx + 2] = 0
      rgba[idx + 3] = Math.round(alpha * 255)
    }
  }
  return encodeRgbaPng(size, size, rgba)
}

/**
 * Wrap PNG buffers into a valid Windows .ico file (PNG-compressed entries supported since Vista+).
 */
function buildIcoFromPngBuffers(entries) {
  const count = entries.length
  const header = Buffer.alloc(6 + count * 16)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: ICO
  header.writeUInt16LE(count, 4)

  let offset = header.length
  const chunks = [header]
  for (let i = 0; i < count; i += 1) {
    const { size, buf } = entries[i]
    const entryOff = 6 + i * 16
    header[entryOff] = size >= 256 ? 0 : size
    header[entryOff + 1] = size >= 256 ? 0 : size
    header[entryOff + 2] = 0 // color palette
    header[entryOff + 3] = 0 // reserved
    header.writeUInt16LE(1, entryOff + 4) // planes
    header.writeUInt16LE(32, entryOff + 6) // bit count
    header.writeUInt32LE(buf.length, entryOff + 8)
    header.writeUInt32LE(offset, entryOff + 12)
    offset += buf.length
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function resizePngWithSips(srcPath, destPath, size) {
  execFileSync('sips', ['-z', String(size), String(size), srcPath, '--out', destPath], {
    stdio: 'ignore',
  })
}

function generateIcons() {
  mkdirSync(BUILD_DIR, { recursive: true })
  const srcIcon512 = join(MOBILE_PUBLIC, 'icon-512.png')
  if (!existsSync(srcIcon512)) {
    throw new Error(`Missing source app icon: ${srcIcon512}`)
  }

  copyFileSync(srcIcon512, join(BUILD_DIR, 'icon.png'))
  writeFileSync(join(BUILD_DIR, 'trayTemplate.png'), renderTrayTemplatePng(18))
  writeFileSync(join(BUILD_DIR, 'trayTemplate@2x.png'), renderTrayTemplatePng(36))

  if (process.platform === 'darwin') {
    const iconsetDir = join(BUILD_DIR, 'icon.iconset')
    rmSync(iconsetDir, { recursive: true, force: true })
    mkdirSync(iconsetDir, { recursive: true })

    const sizes = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
    ]
    for (const [sz, filename] of sizes) {
      resizePngWithSips(srcIcon512, join(iconsetDir, filename), sz)
    }
    copyFileSync(srcIcon512, join(iconsetDir, 'icon_512x512@2x.png'))
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', join(BUILD_DIR, 'icon.icns')], {
      stdio: 'inherit',
    })

    // Windows tray icon (32x32 color PNG)
    resizePngWithSips(srcIcon512, join(BUILD_DIR, 'tray-icon.png'), 32)

    // Multi-resolution Windows .ico (16, 32, 48, 64, 128, 256)
    const icoSizes = [16, 32, 48, 64, 128, 256]
    const icoEntries = icoSizes.map((sz) => {
      const tmp = join(iconsetDir, `ico_${sz}.png`)
      resizePngWithSips(srcIcon512, tmp, sz)
      return { size: sz, buf: readFileSync(tmp) }
    })
    writeFileSync(join(BUILD_DIR, 'icon.ico'), buildIcoFromPngBuffers(icoEntries))
    rmSync(iconsetDir, { recursive: true, force: true })
  } else {
    // Fallback on non-macOS hosts: embed 512px PNG into .ico and use icon-192.png for tray
    const icoEntries = [{ size: 256, buf: readFileSync(srcIcon512) }]
    writeFileSync(join(BUILD_DIR, 'icon.ico'), buildIcoFromPngBuffers(icoEntries))
    const src192 = join(MOBILE_PUBLIC, 'icon-192.png')
    copyFileSync(existsSync(src192) ? src192 : srcIcon512, join(BUILD_DIR, 'tray-icon.png'))
  }
}

function buildCorePackages() {
  const skipBuild = process.env.ALLINONE_SKIP_CORE_BUILD === '1'
  if (skipBuild && existsSync(join(MOBILE_DIST, 'index.html'))) {
    return
  }
  const relayUrl = String(process.env.PUBLIC_RELAY_URL || process.env.VITE_RELAY_URL || '').trim().replace(/\/+$/, '')
  const env = {
    ...process.env,
    ...(relayUrl ? { PUBLIC_RELAY_URL: relayUrl, VITE_RELAY_URL: relayUrl } : {}),
  }
  console.log(`[desktop:prepare] Building portable bridge + UI (relay=${relayUrl || 'default'})...`)
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-portable-bridge.mjs')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  execFileSync(npmCmd, ['--workspace=@allinone/mobile-app', 'run', 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
}

function stageRendererAndBridge() {
  rmSync(RENDERER_DIR, { recursive: true, force: true })
  mkdirSync(RENDERER_DIR, { recursive: true })

  // Copy ONLY clean UI runtime files (never copy APKs, wallpapers, SW precache, or installer downloads into desktop asar)
  const copyItems = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon.svg', 'assets']
  for (const item of copyItems) {
    const src = join(MOBILE_DIST, item)
    if (existsSync(src)) {
      cpSync(src, join(RENDERER_DIR, item), { recursive: true })
    }
  }

  // Strip VitePWA registerSW.js tag from desktop renderer index.html so Electron doesn't try to register a service worker on app://
  const indexPath = join(RENDERER_DIR, 'index.html')
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8').replace(
      /<script[^>]+registerSW\.js[^>]*><\/script>\s*/gi,
      '',
    )
    writeFileSync(indexPath, html, 'utf8')
  }

  rmSync(BRIDGE_DIR, { recursive: true, force: true })
  mkdirSync(BRIDGE_DIR, { recursive: true })
  const builtBridge = join(MOBILE_PUBLIC, 'downloads', 'allinone-bridge.mjs')
  if (!existsSync(builtBridge)) {
    throw new Error(`Missing built portable bridge: ${builtBridge}`)
  }
  copyFileSync(builtBridge, join(BRIDGE_DIR, 'allinone-bridge.mjs'))

  const defaultServerUrl = String(process.env.PUBLIC_RELAY_URL || process.env.VITE_RELAY_URL || '')
    .trim()
    .replace(/\/+$/, '')
  writeFileSync(
    join(DESKTOP_ROOT, 'runtime-config.json'),
    JSON.stringify({ defaultServerUrl }, null, 2),
    'utf8',
  )
}

buildCorePackages()
generateIcons()
stageRendererAndBridge()
console.log('[desktop:prepare] Desktop assets, icons, renderer, and embedded bridge ready!')
