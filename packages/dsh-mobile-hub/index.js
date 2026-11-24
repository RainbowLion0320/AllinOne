/**
 * DeepSeek Harness Cordis Plugin: `dsh-mobile-hub`
 *
 * 1) Exposes an authenticated localhost-only IPC server (127.0.0.1 + 256-bit Bearer token + SSE)
 *    so All in One Desktop App / portable bridge controls DeepSeek Harness in full RW mode.
 * 2) Optionally registers 6 native DSH Master Dispatch tools (`allinone_*`) when `enableDispatchTools: true`.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { APPS } from './src/protocol.js'
import { MultiAppOrchestrator } from './src/orchestrator.js'
import { registerDshDispatchTools } from './src/dsh-tools.js'
import { startDshLocalIpcServer } from './src/dsh-local-ipc.js'

export const name = 'mobile-hub'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const log = {
    info: (m) => ctx.logger?.info ? ctx.logger.info(m) : console.log(m),
    warn: (m) => ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m),
    error: (m) => ctx.logger?.error ? ctx.logger.error(m) : console.error(m),
    debug: (m) => ctx.logger?.debug?.(m),
  }

  const statusFile = String(config.statusFile ?? '').trim()
  // Pure zero-invasion bridge mode by default: do NOT inject extra tools into DSH's prompt/tools list
  const enableDispatchTools = config.enableDispatchTools === true
  const enableLocalIpc = config.enableLocalIpc !== false

  let ipcServer = null
  let ipcDisposed = false

  const orchestrator = new MultiAppOrchestrator({
    ctx,
    config: { ...config, relayUrl: '', secret: '' },
    log,
    onEvent: (event, payload) => {
      ipcServer?.emitEvent?.(event, payload)
    },
  })

  if (enableDispatchTools) {
    registerDshDispatchTools(ctx, orchestrator, log)
    log.info('mobile-hub: registered 6 DSH cross-app master dispatch tools (allinone_*)')
  }

  let startPromise = null
  if (enableLocalIpc) {
    const dshAdapter = orchestrator.adapters[APPS.DSH]
    startPromise = startDshLocalIpcServer({
      dshAdapter,
      dshHome: config.dshHome || '',
      log,
    })
      .then(async (srv) => {
        if (ipcDisposed) {
          await srv.close().catch(() => {})
          return null
        }
        ipcServer = srv
        if (statusFile) {
          try {
            mkdirSync(dirname(statusFile), { recursive: true })
            writeFileSync(
              statusFile,
              JSON.stringify(
                { state: 'ipc-ready', mode: 'local-ipc', port: srv.port, pid: process.pid, at: new Date().toISOString() },
                null,
                2,
              ),
            )
          } catch {}
        }
        return srv
      })
      .catch((err) => {
        log.warn?.(`mobile-hub: failed to start DSH local IPC server: ${String(err)}`)
        return null
      })
  }

  log.info('mobile-hub: serving DeepSeek Harness via authenticated local IPC for All in One Desktop App.')

  ctx.effect(() => async () => {
    ipcDisposed = true
    const srv = ipcServer || (startPromise ? await startPromise.catch(() => null) : null)
    ipcServer = null
    if (srv) {
      await srv.close().catch(() => {})
    }
    await orchestrator.dispose()
  })
}
