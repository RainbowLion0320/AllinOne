/**
 * End-to-end smoke test verifying:
 *  1. Relay Server startup + HMAC auth login
 *  2. PC Bridge (dsh-mobile-hub standalone) outbound WS connection
 *  3. Mobile WS client connection + RPC routing across DSH, Codex, Claude, Antigravity
 *  4. Reading real local sessions from all 4 apps
 *  5. DSH Cordis plugin `apply(ctx, config)` + 6 Master Dispatch tools registration
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createRelayServer } from '../packages/relay-server/src/index.js'
import { startStandaloneBridge } from '../packages/dsh-mobile-hub/standalone.js'
import { apply as applyDshPlugin } from '../packages/dsh-mobile-hub/index.js'
import { RPC } from '../packages/shared/src/protocol.js'

const TEST_PASS = 'smoke-test-pass-123'
const TEST_BRIDGE_SECRET = 'smoke-test-bridge-456'

async function main() {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'allinone-smoke-'))
  // 1. Start Relay Server on ephemeral port
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    clientAccessToken: TEST_PASS,
    bridgeSecret: TEST_BRIDGE_SECRET,
    roomsFile: join(tmpDir, 'rooms.json'),
    uploadDir: join(tmpDir, 'uploads'),
  })
  const { port } = await relay.start()
  const httpBase = `http://127.0.0.1:${port}`
  const wsBridgeUrl = `ws://127.0.0.1:${port}/ws/bridge`

  // 2. Start Standalone PC Bridge (Owner room)
  const bridge = startStandaloneBridge({
    relayUrl: wsBridgeUrl,
    secret: TEST_BRIDGE_SECRET,
    bridgeId: 'smoke-pc',
  })

  let friendBridgeA = null
  let portableChild = null

  try {
    // Wait up to 5s for bridge to connect
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList('owner').some((b) => b.online)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(relay.hub.getBridgeList('owner').length, 1, 'PC bridge should be registered in owner room')
    assert.equal(relay.hub.getBridgeList('owner')[0].online, true, 'PC bridge should be online')
    console.log('[smoke] 1/6 Relay + Owner PC Bridge connected OK')

    // 3. Login as mobile client
    const loginRes = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASS, deviceName: 'smoke-phone' }),
    })
    assert.equal(loginRes.status, 200)
    const loginData = await loginRes.json()
    assert.equal(loginData.ok, true)
    assert.ok(loginData.token, 'Should receive signed session token')

    // Reject wrong password
    const badRes = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })
    assert.equal(badRes.status, 401)
    console.log('[smoke] 2/5 Mobile auth & rejection OK')

    // 4. Connect mobile WS client & exercise RPCs across all 4 apps
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(loginData.token)}`)
    let reqId = 1
    const pending = new Map()

    await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'hello') resolve()
        if (msg.type === 'rpc.res') {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            if (msg.ok) p.resolve(msg.result)
            else p.reject(new Error(msg.error?.message || 'RPC error'))
          }
        }
      })
      ws.on('error', reject)
    })

    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = `t-${reqId++}`
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ type: 'rpc.req', id, method, params }))
      })

    const statusRes = await rpc(RPC.APPS_STATUS)
    assert.equal(statusRes.apps.length, 4, 'Should report status for all 4 apps')
    console.log(
      '[smoke] 3/5 Apps status:',
      statusRes.apps.map((a) => `${a.app}(avail=${a.available},rw=${a.writable})`).join(', '),
    )

    const wsRes = await rpc(RPC.WORKSPACES_LIST)
    assert.ok(Array.isArray(wsRes.workspaces))

    const modelsRes = await rpc(RPC.MODELS_LIST)
    assert.ok(modelsRes?.catalog, 'Should return per-app models catalog')
    for (const app of ['dsh', 'codex', 'claude', 'antigravity']) {
      assert.ok(Array.isArray(modelsRes.catalog[app]?.models), `catalog[${app}].models should be array`)
      assert.ok(modelsRes.catalog[app].models.length > 0, `catalog[${app}] should have >=1 models`)
    }
    console.log(
      '[smoke] 3.5/5 Models catalog:',
      ['dsh', 'codex', 'claude', 'antigravity']
        .map((a) => `${a}=${modelsRes.catalog[a].models.length}(def:${modelsRes.catalog[a].defaultModel})`)
        .join(', '),
    )

    const listRes = await rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 40 })
    assert.ok(Array.isArray(listRes.sessions))
    const byApp = {}
    for (const s of listRes.sessions) {
      byApp[s.app] = (byApp[s.app] || 0) + 1
    }
    console.log('[smoke] 4/5 Sessions listed:', listRes.sessions.length, 'breakdown:', byApp)

    // Read 1 real session from each app that has sessions + test cursor pagination if hasMore
    for (const app of ['dsh', 'codex', 'claude', 'antigravity']) {
      const sample = listRes.sessions.find((s) => s.app === app)
      if (!sample) continue
      const readRes = await rpc(RPC.SESSION_READ, { id: sample.id, limit: 10 })
      assert.equal(readRes.session.app, app)
      assert.ok(Array.isArray(readRes.session.messages))
      let pageInfo = `hasMore=${Boolean(readRes.session.hasMore)}`
      if (readRes.session.hasMore && readRes.session.nextCursor) {
        const olderRes = await rpc(RPC.SESSION_READ, {
          id: sample.id,
          limit: 10,
          cursor: readRes.session.nextCursor,
        })
        assert.ok(Array.isArray(olderRes.session.messages))
        pageInfo += `, page2=${olderRes.session.messages.length} msgs`
      }
      console.log(`  - read ${sample.id}: "${sample.title.slice(0, 32)}" (${readRes.session.messages.length} msgs, ${pageInfo})`)
    }

    // 4.5 Verify authenticated PC local image proxy (/api/bridge-file) & non-image security guardrail
    const imgUrl = `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&token=${encodeURIComponent(loginData.token)}`
    const imgRes = await fetch(imgUrl)
    assert.equal(imgRes.status, 200, 'Bridge image proxy should return 200 OK for valid PNG')
    assert.equal(imgRes.headers.get('content-type'), 'image/png')
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    assert.ok(imgBuf.length > 1000 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50, 'Should return valid PNG binary')

    const blockedRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('package.json')}&cwd=${encodeURIComponent(process.cwd())}&token=${encodeURIComponent(loginData.token)}`,
    )
    assert.equal(blockedRes.status, 403, 'Non-image files must be blocked with 403')

    const unauthImgRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}`,
    )
    assert.equal(unauthImgRes.status, 401, 'Unauthenticated image requests must return 401')
    console.log(`[smoke] 4.5/5 Bridge local image proxy OK (${imgBuf.length} bytes PNG, non-image blocked)`)

    ws.close()

    // 5. Verify DSH Cordis plugin registration registers all 6 master dispatch tools
    const registeredTools = []
    const effects = []
    const mockCtx = {
      agents: { get: () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: (name) => {
        if (name === 'tools') {
          return {
            register: (def) => {
              registeredTools.push(def.name)
              return () => {}
            },
          }
        }
        return undefined
      },
      effect: (fn) => {
        const clean = fn()
        if (typeof clean === 'function') effects.push(clean)
      },
    }

    applyDshPlugin(mockCtx, { enableDispatchTools: true })
    assert.deepEqual(registeredTools.sort(), [
      'allinone_apps_status',
      'allinone_dispatch_task',
      'allinone_interrupt_session',
      'allinone_list_sessions',
      'allinone_read_session',
      'allinone_task_status',
    ])
    for (const fn of effects) await fn()
    console.log('[smoke] 5/6 DSH Cordis plugin & 6 master dispatch tools OK')

    // 6. Strict Multi-Tenant Room Isolation & Portable Bridge Bundle Test
    const pubHealth = await (await fetch(`${httpBase}/api/health`)).json()
    assert.equal(pubHealth.ok, true)
    assert.equal(pubHealth.bridges, undefined, 'Public /api/health must NOT leak bridge list')

    // Register Room A and Room B
    const regA = await (await fetch(`${httpBase}/api/rooms/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Friend-A-PC' }),
    })).json()
    assert.equal(regA.ok, true)
    assert.ok(regA.roomId.startsWith('rm_'))
    assert.match(regA.pairCode, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)

    const regB = await (await fetch(`${httpBase}/api/rooms/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Friend-B-PC' }),
    })).json()
    assert.equal(regB.ok, true)
    assert.notEqual(regA.roomId, regB.roomId)

    // Verify rooms.json stores ONLY hashes, never plaintext secrets/tokens
    const persistedRooms = readFileSync(join(tmpDir, 'rooms.json'), 'utf8')
    assert.equal(persistedRooms.includes(regA.bridgeSecret), false, 'rooms.json must NOT store plaintext bridgeSecret')
    assert.equal(persistedRooms.includes(regA.pairToken), false, 'rooms.json must NOT store plaintext pairToken')

    // Connect Friend Bridge A
    friendBridgeA = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: regA.bridgeSecret,
      roomId: regA.roomId,
      bridgeId: 'friend-a-pc',
      quiet: true,
    })
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList(regA.roomId).some((b) => b.online)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(relay.hub.getBridgeList(regA.roomId).length, 1)
    assert.equal(relay.hub.getBridgeList('owner').length, 1, 'Owner room must still see ONLY 1 bridge')
    assert.equal(relay.hub.getBridgeList('owner')[0].bridgeId, 'smoke-pc')

    // Pair Phone A via lowercase no-hyphen pairCode
    const pairARes = await (await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: regA.pairCode.replace('-', '').toLowerCase() }),
    })).json()
    assert.equal(pairARes.ok, true)
    assert.equal(pairARes.roomId, regA.roomId)
    assert.equal(pairARes.bridges.length, 1)
    assert.equal(pairARes.bridges[0].bridgeId, 'friend-a-pc')

    // Pair Phone B via pairToken (no bridge connected in Room B)
    const pairBRes = await (await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairToken: regB.pairToken }),
    })).json()
    assert.equal(pairBRes.ok, true)
    assert.equal(pairBRes.roomId, regB.roomId)
    assert.equal(pairBRes.bridges.length, 0, 'Room B must NOT see Owner or Room A bridges')

    // Verify WS hello isolation for Phone A
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(pairARes.token)}`)
    const helloA = await new Promise((resolve, reject) => {
      wsA.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.type === 'hello') resolve(m)
      })
      wsA.on('error', reject)
    })
    assert.equal(helloA.roomId, regA.roomId)
    assert.equal(helloA.bridges.length, 1)
    assert.equal(helloA.bridges[0].bridgeId, 'friend-a-pc')
    wsA.close()

    // Cross-room upload isolation check
    const ownerUpload = await (await fetch(`${httpBase}/api/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({
        filename: 'secret.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('owner-private-data').toString('base64'),
      }),
    })).json()
    assert.equal(ownerUpload.ok, true)
    const ownerDl = await fetch(`${httpBase}${ownerUpload.upload.url}`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })
    assert.equal(ownerDl.status, 200)
    const crossPhoneDl = await fetch(`${httpBase}${ownerUpload.upload.url}`, {
      headers: { Authorization: `Bearer ${pairARes.token}` },
    })
    assert.equal(crossPhoneDl.status, 403, 'Friend Phone A must be blocked (403) from Owner uploads')
    const crossBridgeDl = await fetch(`${httpBase}${ownerUpload.upload.url}`, {
      headers: { 'X-Room-Id': regA.roomId, 'X-Bridge-Secret': regA.bridgeSecret },
    })
    assert.equal(crossBridgeDl.status, 403, 'Friend Bridge A must be blocked (403) from Owner uploads')

    // Cross-room bridge-file isolation check: Phone B (no bridge) cannot read Owner or Room A files
    const crossImgRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&token=${encodeURIComponent(pairBRes.token)}`,
    )
    assert.equal(crossImgRes.status, 503, 'Room B with no bridge must get 503 (never fall back to Owner/Room A bridge)')

    // Refresh pair code invalidates old code and issues new code
    const badRefresh = await fetch(`${httpBase}/api/rooms/pair-code`, {
      method: 'POST',
      headers: { 'X-Room-Id': regA.roomId, 'X-Bridge-Secret': 'wrong-secret' },
    })
    assert.equal(badRefresh.status, 401)
    const goodRefresh = await (await fetch(`${httpBase}/api/rooms/pair-code`, {
      method: 'POST',
      headers: { 'X-Room-Id': regA.roomId, 'X-Bridge-Secret': regA.bridgeSecret },
    })).json()
    assert.equal(goodRefresh.ok, true)
    assert.notEqual(goodRefresh.pairCode, regA.pairCode)
    const oldCodeTry = await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: regA.pairCode }),
    })
    assert.equal(oldCodeTry.status, 401, 'Old pairCode must be invalidated after refresh')

    // Live test of bundled single-file portable bridge (if built)
    const bundlePath = join(process.cwd(), 'packages/mobile-app/public/downloads/allinone-bridge.mjs')
    if (existsSync(bundlePath)) {
      const portableStateDir = join(tmpDir, 'portable-home')
      portableChild = spawn(process.execPath, [
        bundlePath,
        '--server', httpBase,
        '--state-dir', portableStateDir,
        '--name', 'Portable-Test-PC',
        '--no-browser',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      portableChild.stdout.on('data', (d) => { out += String(d) })
      portableChild.stderr.on('data', (d) => { out += String(d) })
      for (let i = 0; i < 60; i++) {
        if (existsSync(join(portableStateDir, 'pair.html')) && out.includes('已加密连接到中转服务器')) break
        await new Promise((r) => setTimeout(r, 150))
      }
      assert.ok(existsSync(join(portableStateDir, 'config.json')), 'Portable bundle should write config.json')
      const pairHtml = readFileSync(join(portableStateDir, 'pair.html'), 'utf8')
      assert.ok(pairHtml.includes('<svg xmlns="http://www.w3.org/2000/svg"'), 'pair.html should embed offline SVG QR code')
      assert.ok(out.includes('已加密连接到中转服务器'), `Portable bundle should connect to relay (output: ${out.slice(0, 300)})`)
      portableChild.kill()
      portableChild = null
      console.log('[smoke] 6/6 Multi-tenant room isolation + single-file portable bundle OK')
    } else {
      console.log('[smoke] 6/6 Multi-tenant room isolation OK (portable bundle not built yet)')
    }

    console.log('\nALL SMOKE TESTS PASSED!')
  } finally {
    if (portableChild) {
      try { portableChild.kill() } catch {}
    }
    if (friendBridgeA) await friendBridgeA.stop()
    await bridge.stop()
    await relay.close()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
