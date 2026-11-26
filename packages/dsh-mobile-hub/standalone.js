/**
 * Standalone runner for `dsh-mobile-hub` (for local debugging or headless bridging without restarting DSH).
 * Note: In standalone mode, Codex / Claude / Antigravity are fully active, while DSH sessions are read-only
 * until mounted as a Cordis plugin inside DeepSeek Harness Desktop.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { RelayBridgeLink } from './src/ws-client.js'
import { normalizeE2eeKey } from '@allinone/shared/e2ee'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const ALLOWED_STANDALONE_DOTENV_KEYS = new Set([
  'RELAY_URL',
  'ALLINONE_ROOM_ID',
  'BRIDGE_ID',
  'DEFAULT_CWD',
  'ALLINONE_BRIDGE_SECRET',
  'ALLINONE_E2EE_KEY',
])

function loadDotEnv(filePath, allowedKeys = ALLOWED_STANDALONE_DOTENV_KEYS) {
  if (!existsSync(filePath)) return
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const k = trimmed.slice(0, eq).trim()
    if (allowedKeys && !allowedKeys.has(k)) continue
    let v = trimmed.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(k in process.env)) process.env[k] = v
  }
}

loadDotEnv(resolve(__dirname, '../../.env'))

// Capture bootstrap secrets once, then scrub from process.env so child AI CLIs never inherit them
const BOOTSTRAP_ENV = {
  bridgeSecret: String(process.env.ALLINONE_BRIDGE_SECRET || '').trim(),
  e2eeKey: String(process.env.ALLINONE_E2EE_KEY || '').trim(),
}
for (const secretKey of [
  'ALLINONE_BRIDGE_SECRET',
  'ALLINONE_E2EE_KEY',
  'ALLINONE_PASSWORD',
]) {
  delete process.env[secretKey]
}

function normalizeRelayWsUrl(rawUrl) {
  const input = String(rawUrl || 'ws://127.0.0.1:8787/ws/bridge').trim()
  const u = new URL(input)
  if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol === 'http:') u.protocol = 'ws:'
  const cleanPath = u.pathname.replace(/\/+$/, '')
  u.pathname = cleanPath.endsWith('/ws/bridge') ? cleanPath : `${cleanPath}/ws/bridge`
  return u.toString()
}

export function startStandaloneBridge(options = {}) {
  const relayUrl = normalizeRelayWsUrl(options.relayUrl || process.env.RELAY_URL || 'ws://127.0.0.1:8787/ws/bridge')
  const secret = String(options.secret || process.env.ALLINONE_BRIDGE_SECRET || BOOTSTRAP_ENV.bridgeSecret || '').trim()
  const roomId = String(options.roomId || process.env.ALLINONE_ROOM_ID || '').trim()
  const defaultBridgeId = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'home-pc'
  const bridgeId = options.bridgeId || process.env.BRIDGE_ID || defaultBridgeId
  const mode = options.mode || 'standalone'
  const rawE2eeKey = String(options.e2eeKey ?? process.env.ALLINONE_E2EE_KEY ?? BOOTSTRAP_ENV.e2eeKey ?? '').trim()
  delete process.env.ALLINONE_BRIDGE_SECRET
  delete process.env.ALLINONE_E2EE_KEY
  delete process.env.ALLINONE_PASSWORD
  const e2eeKey = normalizeE2eeKey(rawE2eeKey)
  if (!roomId.startsWith('usr_') || !secret || !e2eeKey) {
    throw new Error('startStandaloneBridge requires account roomId (usr_*), device secret, and valid 256-bit e2eeKey')
  }
  const cwd = options.cwd || process.env.DEFAULT_CWD || resolve(__dirname, '../..')
  const log = options.log || console

  let link = null
  const orchestrator = new MultiAppOrchestrator({
    ctx: null,
    config: {
      cwd,
      ...(options.inboundDir ? { inboundDir: options.inboundDir } : {}),
    },
    log,
    onEvent: (event, payload) => link?.pushEvent(event, payload),
  })

  try {
    link = new RelayBridgeLink({
      relayUrl,
      secret,
      roomId,
      bridgeId,
      mode,
      e2eeKey,
      inboundDir: orchestrator.inboundDir,
      log,
      onRpc: (method, params, ctx) => orchestrator.handleRpc(method, params, ctx),
      onRegisterP2pUpload: (info) => orchestrator.registerP2pUpload(info),
      onState: (state, detail) => {
        options.onState?.(state, detail)
        if (!options.quiet) {
          log.log?.(`[bridge] state=${state} ${detail ? `(${detail})` : ''}`)
        }
      },
    })
  } catch (err) {
    void orchestrator.dispose().catch(() => {})
    throw err
  }

  link.start()
  const appsReadyPromise = orchestrator
    .getAppsStatus()
    .then((apps) => {
      link.setAppsMeta(apps)
      if (!options.quiet) {
        log.log?.('[bridge] App readiness:', apps.map((a) => `${a.app}:${a.available ? (a.writable ? 'RW' : 'RO') : 'OFF'}`).join(' | '))
      }
      return apps
    })
    .catch((err) => {
      log.warn?.(`[bridge] App readiness probe failed: ${String(err?.message || err)}`)
      return []
    })

  const stop = async () => {
    await link.stop()
    await orchestrator.dispose()
  }

  return { orchestrator, link, appsReadyPromise, stop }
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false
  try {
    const argvPath = realpathSync(resolve(process.argv[1]))
    const selfPath = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32'
      ? argvPath.toLowerCase() === selfPath.toLowerCase()
      : argvPath === selfPath
  } catch {
    const argvPath = resolve(process.argv[1])
    const selfPath = resolve(fileURLToPath(import.meta.url))
    return process.platform === 'win32'
      ? argvPath.toLowerCase() === selfPath.toLowerCase()
      : argvPath === selfPath
  }
}

if (isExecutedDirectly()) {
  const bridge = startStandaloneBridge()
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    const forceTimer = setTimeout(() => process.exit(0), 5_000)
    forceTimer.unref?.()
    bridge
      .stop()
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceTimer)
        process.exit(0)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
