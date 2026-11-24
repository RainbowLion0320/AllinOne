/**
 * Lightweight, zero-dependency DeepSeek Harness Cordis plugin (`allinone-dsh-ipc`).
 *
 * Installed automatically into `~/.dsh/profiles/desktop` by All in One Desktop App
 * when DeepSeek Harness is detected on the user's machine. Exposes ONLY an authenticated
 * loopback IPC server (127.0.0.1 + 256-bit Bearer token + anti-Origin guard) so All in One
 * Desktop App can create, read, stream, and interrupt DSH conversations natively.
 */

import { DshAdapter } from './adapters/dsh.js'
import { startDshLocalIpcServer } from './dsh-local-ipc.js'

export const name = 'allinone-dsh-ipc'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const log = {
    info: (m) => (ctx.logger?.info ? ctx.logger.info(m) : console.log(m)),
    warn: (m) => (ctx.logger?.warn ? ctx.logger.warn(m) : console.warn(m)),
    error: (m) => (ctx.logger?.error ? ctx.logger.error(m) : console.error(m)),
  }

  let ipcServer = null
  let disposed = false

  const dshAdapter = new DshAdapter({
    ctx,
    config: {
      permissionPreset: config.permissionPreset || 'danger-full-access',
      ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    },
    log,
    emitEvent: (event, payload) => {
      ipcServer?.emitEvent?.(event, payload)
    },
    onApprovalRequest: (req) => {
      ipcServer?.emitEvent?.('approval.request', req)
    },
  })

  const startPromise = startDshLocalIpcServer({
    dshAdapter,
    dshHome: config.dshHome || '',
    log,
  })
    .then(async (srv) => {
      if (disposed) {
        await srv.close().catch(() => {})
        return null
      }
      ipcServer = srv
      return srv
    })
    .catch((err) => {
      log.warn?.(`allinone-dsh-ipc: failed to start local IPC server: ${String(err)}`)
      return null
    })

  ctx.effect(() => async () => {
    disposed = true
    const srv = ipcServer || (await startPromise.catch(() => null))
    ipcServer = null
    if (srv) {
      await srv.close().catch(() => {})
    }
    await dshAdapter.dispose().catch(() => {})
  })
}
