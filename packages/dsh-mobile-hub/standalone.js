/**
 * Standalone runner for `dsh-mobile-hub` (for local debugging or headless bridging without restarting DSH).
 * Note: In standalone mode, Codex / Claude / Antigravity are fully active, while DSH sessions are read-only
 * until mounted as a Cordis plugin inside DeepSeek Harness Desktop.
 */

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { RelayBridgeLink } from './src/ws-client.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const k = trimmed.slice(0, eq).trim()
    let v = trimmed.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(k in process.env)) process.env[k] = v
  }
}

loadDotEnv(resolve(__dirname, '../../.env'))
loadDotEnv(resolve(__dirname, '../relay-server/.env'))

export function startStandaloneBridge(options = {}) {
  const relayUrl = options.relayUrl || process.env.RELAY_URL || 'ws://127.0.0.1:8787/ws/bridge'
  const secret = options.secret || process.env.DSH_MOBILE_BRIDGE_SECRET || process.env.BRIDGE_SECRET || 'allinone-dev-bridge'
  const roomId = options.roomId || process.env.ROOM_ID || ''
  const defaultBridgeId = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'home-pc'
  const bridgeId = options.bridgeId || process.env.BRIDGE_ID || defaultBridgeId
  const mode = options.mode || 'standalone'
  const cwd = options.cwd || process.env.DEFAULT_CWD || resolve(__dirname, '../..')
  const log = options.log || console

  let link = null
  const orchestrator = new MultiAppOrchestrator({
    ctx: null,
    config: {
      relayUrl,
      secret,
      roomId,
      cwd,
      ...(options.inboundDir ? { inboundDir: options.inboundDir } : {}),
    },
    log,
    onEvent: (event, payload) => link?.pushEvent(event, payload),
  })

  link = new RelayBridgeLink({
    relayUrl,
    secret,
    roomId,
    bridgeId,
    mode,
    log,
    onRpc: (method, params) => orchestrator.handleRpc(method, params),
    onState: (state, detail) => {
      options.onState?.(state, detail)
      if (!options.quiet) {
        log.log?.(`[bridge] state=${state} ${detail ? `(${detail})` : ''}`)
      }
    },
  })

  link.start()
  const appsReadyPromise = orchestrator.getAppsStatus().then((apps) => {
    link.setAppsMeta(apps)
    if (!options.quiet) {
      log.log?.('[bridge] App readiness:', apps.map((a) => `${a.app}:${a.available ? (a.writable ? 'RW' : 'RO') : 'OFF'}`).join(' | '))
    }
    return apps
  })

  const stop = async () => {
    link.stop()
    await orchestrator.dispose()
  }

  return { orchestrator, link, appsReadyPromise, stop }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const bridge = startStandaloneBridge()
  const shutdown = () => bridge.stop().then(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
