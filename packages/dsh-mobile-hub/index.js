/**
 * DeepSeek Harness Cordis Plugin: `dsh-mobile-hub`
 *
 * 1) Opens an outbound WSS long connection to your self-hosted AllinOne Relay Server.
 * 2) Exposes unified mobile remote control for DeepSeek Harness, Codex, Claude Code, and Antigravity.
 * 3) Registers 6 native DSH Master Dispatch tools (`allinone_*`) so DeepSeek Harness can orchestrate
 *    all other apps directly from any conversation.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname } from 'node:path'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { registerDshDispatchTools } from './src/dsh-tools.js'
import { RelayBridgeLink } from './src/ws-client.js'

export const name = 'mobile-hub'
export const inject = ['agents']

function resolveSecret(config, log) {
  const inline = String(config.secret ?? '').trim()
  if (inline) return inline
  const secretFile = String(config.secretFile ?? '').trim()
  if (secretFile) {
    try {
      const fromFile = readFileSync(secretFile, 'utf8').trim()
      if (fromFile) return fromFile
    } catch (err) {
      log.warn?.(`mobile-hub: cannot read secretFile ${secretFile}: ${String(err)}`)
    }
  }
  const secretEnv = String(config.secretEnv ?? 'DSH_MOBILE_BRIDGE_SECRET').trim()
  return String(process.env[secretEnv] ?? process.env.BRIDGE_SECRET ?? '').trim()
}

export function apply(ctx, config = {}) {
  const log = {
    info: (m) => ctx.logger?.info ? ctx.logger.info(m) : console.log(m),
    warn: (m) => ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m),
    error: (m) => ctx.logger?.error ? ctx.logger.error(m) : console.error(m),
    debug: (m) => ctx.logger?.debug?.(m),
  }

  const relayUrl = String(config.relayUrl ?? process.env.RELAY_URL ?? '').trim()
  const secret = resolveSecret(config, log)
  const defaultBridgeId = os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'home-pc'
  const bridgeId = String(config.bridgeId ?? process.env.BRIDGE_ID ?? '').trim() || defaultBridgeId
  const statusFile = String(config.statusFile ?? '').trim()
  // Pure zero-invasion bridge mode by default: do NOT inject extra tools into DSH's prompt/tools list
  const enableDispatchTools = config.enableDispatchTools === true

  let link = null

  const orchestrator = new MultiAppOrchestrator({
    ctx,
    config: { ...config, relayUrl, secret },
    log,
    onEvent: (event, payload) => {
      link?.pushEvent(event, payload)
    },
  })

  // Always register DSH Master Dispatch Tools even if relayUrl isn't configured yet,
  // so PC-side DSH conversations can already dispatch Codex / Claude / Antigravity!
  if (enableDispatchTools) {
    registerDshDispatchTools(ctx, orchestrator, log)
    log.info('mobile-hub: registered 6 DSH cross-app master dispatch tools (allinone_*)')
  }

  if (!relayUrl || !secret) {
    log.warn(
      'mobile-hub: relay long-connection paused — configure config.relayUrl and Bridge Secret ' +
      '(config.secretFile, config.secret, or env DSH_MOBILE_BRIDGE_SECRET) in cordis.patch.yml.',
    )
  } else {
    link = new RelayBridgeLink({
      relayUrl,
      secret,
      bridgeId,
      mode: 'dsh-plugin',
      log,
      onRpc: (method, params) => orchestrator.handleRpc(method, params),
      onState: (state, detail) => {
        if (!statusFile) return
        try {
          mkdirSync(dirname(statusFile), { recursive: true })
          writeFileSync(
            statusFile,
            JSON.stringify({ state, detail, bridgeId, relayUrl, at: new Date().toISOString() }, null, 2),
          )
        } catch {}
      },
    })

    // Refresh app status metadata once connected
    orchestrator.getAppsStatus().then((apps) => link?.setAppsMeta(apps)).catch(() => {})
    ctx.effect(() => link.start())
  }

  ctx.effect(() => async () => {
    await orchestrator.dispose()
  })
}
