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
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createRelayServer } from '../packages/relay-server/src/index.js'
import { startStandaloneBridge } from '../packages/dsh-mobile-hub/standalone.js'
import { apply as applyDshPlugin } from '../packages/dsh-mobile-hub/index.js'
import { autoCompleteHalfInstalledClis, detectHalfInstalledClis } from '../packages/dsh-mobile-hub/src/helpers/env-autofix.js'
import { AntigravityAdapter, parseAgyTranscriptContent } from '../packages/dsh-mobile-hub/src/adapters/antigravity.js'
import { EVENTS, RPC } from '../packages/shared/src/protocol.js'
import {
  DEVICES_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  renameDevice,
  saveDeviceState,
  selectDevice,
  upsertDevice,
} from '../packages/mobile-app/src/lib/deviceStore.js'
import {
  clearSessionCache,
  getSessionCacheStats,
  loadCachedSession,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from '../packages/mobile-app/src/lib/sessionCache.js'
import { resolveImageSrc } from '../packages/mobile-app/src/lib/imageUrls.js'
import {
  clearDraft,
  clearDraftsForScope,
  loadDraft,
  loadLastSessionId,
  loadLastWorkspace,
  makeDraftKey,
  saveDraft,
  saveLastSessionId,
  saveLastWorkspace,
} from '../packages/mobile-app/src/lib/draftStore.js'
import {
  DesktopUpdater,
  buildWindowsUpdateScripts,
  compareSemver,
  pickReleaseAsset,
} from '../packages/desktop-app/src/updater.js'
import {
  LANG_STORAGE_KEY,
  MESSAGES,
  bi,
  detectInitialLang,
  loadSavedLang,
  normalizeLang,
  saveLang,
  translate,
} from '../packages/mobile-app/src/lib/i18n.js'

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
    accountsFile: join(tmpDir, 'accounts.json'),
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
  let ownerBridge2 = null
  let portableChild = null
  let acctPortableChild = null
  let acctBridge2 = null

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
      const appInfo = statusRes.apps.find((a) => a.app === app)
      if (appInfo?.writable || app === 'dsh') {
        assert.ok(modelsRes.catalog[app].models.length > 0, `catalog[${app}] should have >=1 models when writable`)
      }
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
    const pubHealthRes = await fetch(`${httpBase}/api/health`)
    const pubHealth = await pubHealthRes.json()
    assert.equal(pubHealth.ok, true)
    assert.equal(pubHealth.bridges, undefined, 'Public /api/health must NOT leak bridge list')
    assert.equal(pubHealth.onlineBridges, undefined, 'Public /api/health must NOT leak onlineBridges count')
    assert.equal(pubHealth.clients, undefined, 'Public /api/health must NOT leak active client count')
    assert.equal(pubHealth.rooms, undefined, 'Public /api/health must NOT leak room count')
    assert.equal(pubHealthRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(pubHealthRes.headers.get('x-frame-options'), 'DENY')
    assert.equal(pubHealthRes.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(String(pubHealthRes.headers.get('permissions-policy') || '').includes('camera=(self)'))

    const ownerHealth = await (await fetch(`${httpBase}/api/health`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    assert.equal(ownerHealth.ok, true)
    assert.equal(ownerHealth.roomId, 'owner')
    assert.ok(ownerHealth.onlineBridges >= 1)

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

    // Pair Phone A via lowercase no-hyphen pairCode (strictly single-use!)
    const pairARes = await (await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: regA.pairCode.replace('-', '').toLowerCase() }),
    })).json()
    assert.equal(pairARes.ok, true)
    assert.equal(pairARes.roomId, regA.roomId)
    assert.equal(pairARes.bridges.length, 1)
    assert.equal(pairARes.bridges[0].bridgeId, 'friend-a-pc')

    // Second redemption of the same pairCode OR pairToken must fail immediately (single-use burn)
    const replayCodeRes = await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: regA.pairCode }),
    })
    assert.equal(replayCodeRes.status, 401, 'Reusing an already-redeemed pairCode must return 401')
    const replayTokRes = await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairToken: regA.pairToken }),
    })
    assert.equal(replayTokRes.status, 401, 'Reusing an already-redeemed pairToken must return 401')

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

    // Live test of bundled single-file portable bridge in legacy pair mode (if built)
    const bundlePath = join(process.cwd(), 'packages/mobile-app/public/downloads/allinone-bridge.mjs')
    if (existsSync(bundlePath)) {
      const portableStateDir = join(tmpDir, 'portable-home')
      portableChild = spawn(process.execPath, [
        bundlePath,
        '--server', httpBase,
        '--state-dir', portableStateDir,
        '--name', 'Portable-Test-PC',
        '--legacy-pair',
        '--no-browser',
      ], {
        env: { ...process.env, ALLINONE_NO_AUTOFIX: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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

    // 7. Multi-device switching, /api/auth/me status probing, strict bridgeId routing, & scoped cache isolation
    const meA = await (await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${pairARes.token}` },
    })).json()
    assert.equal(meA.ok, true)
    assert.equal(meA.roomId, regA.roomId)
    assert.equal(meA.label, 'Friend-A-PC', '/api/auth/me should return room label')
    assert.equal(meA.bridges.length, 1)
    assert.equal(meA.bridges[0].online, true)

    const meB = await (await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${pairBRes.token}` },
    })).json()
    assert.equal(meB.ok, true)
    assert.equal(meB.label, 'Friend-B-PC')
    assert.equal(meB.bridges.length, 0)

    // Strict bridgeId routing with 2 simultaneous bridges in owner room
    ownerBridge2 = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: TEST_BRIDGE_SECRET,
      bridgeId: 'smoke-pc-2',
      quiet: true,
    })
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList('owner').filter((b) => b.online).length >= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(relay.hub.getBridgeList('owner').filter((b) => b.online).length, 2, 'Owner room should support 2 simultaneous online bridges')

    const imgBridge2 = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&bridgeId=smoke-pc-2&token=${encodeURIComponent(loginData.token)}`,
    )
    assert.equal(imgBridge2.status, 200, 'Explicit online bridgeId should succeed')

    const imgOfflineBridge = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&bridgeId=offline-pc-999&token=${encodeURIComponent(loginData.token)}`,
    )
    assert.equal(imgOfflineBridge.status, 503, 'Explicit offline bridgeId must return 503 and NEVER fall back to another online PC')

    const wsMulti = new WebSocket(`ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(loginData.token)}`)
    const multiPending = new Map()
    await new Promise((resolve, reject) => {
      wsMulti.on('message', (raw) => {
        const m = JSON.parse(String(raw))
        if (m.type === 'hello') {
          assert.equal(m.bridges.length, 2)
          resolve()
        }
        if (m.type === 'rpc.res') {
          const p = multiPending.get(m.id)
          if (p) {
            multiPending.delete(m.id)
            p.resolve(m)
          }
        }
      })
      wsMulti.on('error', reject)
    })
    const rpcWithBridge = (bridgeId) =>
      new Promise((resolve) => {
        const id = `mb-${Math.random().toString(36).slice(2, 8)}`
        multiPending.set(id, { resolve })
        wsMulti.send(JSON.stringify({ type: 'rpc.req', id, method: RPC.APPS_STATUS, params: {}, bridgeId }))
      })
    const okRes2 = await rpcWithBridge('smoke-pc-2')
    assert.equal(okRes2.ok, true, 'RPC targeting online smoke-pc-2 should succeed')
    const failOffline = await rpcWithBridge('offline-pc-999')
    assert.equal(failOffline.ok, false)
    assert.equal(failOffline.error?.code, 'BRIDGE_OFFLINE', 'RPC targeting offline bridgeId must fail strictly with BRIDGE_OFFLINE')
    wsMulti.close()

    // Mobile multi-device store + legacy v1 migration + isolated cache test
    const memStore = new Map()
    const fakeStorage = {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    }
    fakeStorage.setItem(LEGACY_AUTH_STORAGE_KEY, JSON.stringify({
      baseUrl: httpBase,
      token: pairARes.token,
      roomId: regA.roomId,
      label: 'Friend-A-PC',
      bridges: pairARes.bridges,
    }))
    let dState = loadDeviceState(fakeStorage)
    assert.equal(dState.devices.length, 1, 'Legacy v1 auth should migrate into v2 device list')
    assert.equal(memStore.has(DEVICES_STORAGE_KEY), true)
    assert.equal(memStore.has(LEGACY_AUTH_STORAGE_KEY), false)

    // Rename Device A and pair Device B (independent room) -> both coexist
    const devAId = dState.devices[0].id
    dState = renameDevice(dState, devAId, '公司 Mac')
    const addedB = upsertDevice(dState, {
      baseUrl: httpBase,
      token: pairBRes.token,
      roomId: regB.roomId,
      label: '家里 Windows',
      bridges: [],
      authMode: 'pair',
    })
    assert.equal(addedB.isNew, true)
    dState = addedB.state
    assert.equal(dState.devices.length, 2, 'Pairing 2nd PC must preserve 1st PC')
    assert.equal(getActiveDevice(dState).id, addedB.device.id)
    assert.equal(getDeviceDisplayName(dState.devices[0]), '公司 Mac')

    // Re-pairing Device A refreshes token in-place and preserves customName
    const repairedA = upsertDevice(dState, {
      baseUrl: httpBase,
      token: `${pairARes.token}-refreshed`,
      roomId: regA.roomId,
      label: 'Friend-A-PC',
      bridges: pairARes.bridges,
      authMode: 'pair',
    })
    assert.equal(repairedA.isNew, false)
    dState = repairedA.state
    assert.equal(dState.devices.length, 2)
    assert.equal(getDeviceDisplayName(dState.devices[0]), '公司 Mac', 'Re-pairing must keep custom nickname')
    assert.equal(dState.devices[0].token, `${pairARes.token}-refreshed`)

    // Switch back to Device B and verify save/reload persistence
    dState = selectDevice(dState, addedB.device.id)
    saveDeviceState(dState, fakeStorage)
    const reloaded = loadDeviceState(fakeStorage)
    assert.equal(reloaded.devices.length, 2)
    assert.equal(reloaded.activeDeviceId, addedB.device.id)

    // Verify per-device isolated session cache (same sessionId on 2 PCs must NEVER collide)
    await clearSessionCache()
    const scopeA = getCacheScopeKey(dState.devices[0], 'friend-a-pc')
    const scopeB = getCacheScopeKey(dState.devices[1], 'home-win')
    await saveCachedSession('codex:shared-id', { messages: [{ id: 'm1', role: 'user', text: 'from Mac' }] }, scopeA)
    await saveCachedSession('codex:shared-id', { messages: [{ id: 'm1', role: 'user', text: 'from Win' }] }, scopeB)
    assert.equal((await loadCachedSession('codex:shared-id', scopeA)).messages[0].text, 'from Mac')
    assert.equal((await loadCachedSession('codex:shared-id', scopeB)).messages[0].text, 'from Win')
    assert.equal((await getSessionCacheStats(scopeA)).sessionCount, 1)
    assert.equal((await getSessionCacheStats(scopeB)).sessionCount, 1)

    // Clearing Device A cache prefix leaves Device B cache untouched
    await clearSessionCache(dState.devices[0].id, { prefix: true })
    assert.equal(await loadCachedSession('codex:shared-id', scopeA), null)
    assert.equal((await loadCachedSession('codex:shared-id', scopeB)).messages[0].text, 'from Win')
    await clearSessionCache()

    // Removing Device B auto-falls back to Device A
    dState = removeDevice(dState, addedB.device.id)
    assert.equal(dState.devices.length, 1)
    assert.equal(dState.activeDeviceId, devAId)

    // Image URL helper propagates bridgeId and prefers short-lived mediaToken (`mt=`) over master `token=`
    const imgSrc = resolveImageSrc('/tmp/shot.png', {
      baseUrl: httpBase,
      mediaToken: 'mtok',
      token: 'master-tok',
      cwd: '/work',
      bridgeId: 'smoke-pc-2',
    })
    assert.ok(imgSrc.includes('bridgeId=smoke-pc-2'), 'resolveImageSrc must include bridgeId query param')
    assert.ok(imgSrc.includes('mt=mtok') && !imgSrc.includes('master-tok'), 'resolveImageSrc must prefer mt= mediaToken over master token')
    console.log('[smoke] 7/8 Multi-device store, status probe, strict bridgeId routing & scoped cache OK')

    // 8. Comprehensive Security Hardening Suite
    // 8.1 Production default-secret refusal
    assert.throws(
      () =>
        createRelayServer({
          port: 0,
          host: '127.0.0.1',
          nodeEnv: 'production',
          clientAccessToken: 'allinone-dev-pass',
          bridgeSecret: 'allinone-dev-bridge',
          roomsFile: join(tmpDir, 'prod-rooms.json'),
          uploadDir: join(tmpDir, 'prod-uploads'),
        }),
      /Refusing to start in production/,
      'Production server must refuse to start with default dev secrets',
    )

    // 8.2 Strict CORS & WebSocket CSWSH Origin allowlist
    const evilCorsRes = await fetch(`${httpBase}/api/health`, {
      headers: { Origin: 'https://evil.example.com' },
    })
    assert.equal(evilCorsRes.headers.get('access-control-allow-origin'), null, 'Untrusted origin must not receive ACAO')
    const evilPreflight = await fetch(`${httpBase}/api/auth/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })
    assert.equal(evilPreflight.status, 403, 'Untrusted origin OPTIONS preflight must be rejected with 403')
    const capCorsRes = await fetch(`${httpBase}/api/health`, {
      headers: { Origin: 'https://localhost' },
    })
    assert.equal(capCorsRes.headers.get('access-control-allow-origin'), 'https://localhost')

    // 8.3 Single-use WS ticket & CSWSH origin block
    const ticketRes = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    assert.equal(ticketRes.ok, true)
    assert.ok(ticketRes.ticket.startsWith('tk_'))

    // Evil origin WS upgrade must fail with 403 (and must NOT consume ticket or allow connection)
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const evilWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`, {
            headers: { Origin: 'https://evil.example.com' },
          })
          evilWs.on('open', () => { evilWs.close(); resolve() })
          evilWs.on('error', reject)
        }),
      'Evil Origin WS upgrade must be rejected',
    )

    // Valid ticket connects cleanly once, then fails on 2nd use
    const wsTicketConn = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
    await new Promise((resolve, reject) => {
      wsTicketConn.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'hello') resolve()
      })
      wsTicketConn.on('error', reject)
    })
    wsTicketConn.close()
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const replayWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
          replayWs.on('open', () => { replayWs.close(); resolve() })
          replayWs.on('error', reject)
        }),
      'Reusing a single-use WS ticket must be rejected',
    )

    // 8.4 Scoped read-only media token (works for images/uploads, rejected on session/WS/upload APIs)
    const mediaTokRes = await (await fetch(`${httpBase}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    assert.equal(mediaTokRes.ok, true)
    assert.ok(mediaTokRes.mediaToken)

    const mtImgRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&mt=${encodeURIComponent(mediaTokRes.mediaToken)}`,
    )
    assert.equal(mtImgRes.status, 200, 'Media token must authorize GET /api/bridge-file')
    const mtOnMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${mediaTokRes.mediaToken}` },
    })
    assert.equal(mtOnMe.status, 401, 'Media token must NOT work as a full session token on /api/auth/me')
    const mtOnTicket = await fetch(`${httpBase}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mediaTokRes.mediaToken}` },
    })
    assert.equal(mtOnTicket.status, 401, 'Media token must NOT mint WS tickets')
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const mtWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(mediaTokRes.mediaToken)}`)
          mtWs.on('open', () => { mtWs.close(); resolve() })
          mtWs.on('error', reject)
        }),
      'Media token must NOT open /ws/client',
    )

    // 8.5 Bridge URL query secret rejection + ephemeral consume on non-image upload + safe headers
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const qsBridge = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?secret=${encodeURIComponent(TEST_BRIDGE_SECRET)}`)
          qsBridge.on('open', () => { qsBridge.close(); resolve() })
          qsBridge.on('error', reject)
        }),
      'Bridge WS must reject ?secret= in URL query string',
    )
    const qsUploadTry = await fetch(`${httpBase}${ownerUpload.upload.url}?secret=${encodeURIComponent(TEST_BRIDGE_SECRET)}`)
    assert.equal(qsUploadTry.status, 401, 'Upload download must reject ?secret= in URL query string')

    const bridgeConsumeRes = await fetch(`${httpBase}${ownerUpload.upload.url}?consume=1`, {
      headers: { 'X-Bridge-Secret': TEST_BRIDGE_SECRET },
    })
    assert.equal(bridgeConsumeRes.status, 200)
    assert.ok(String(bridgeConsumeRes.headers.get('content-disposition') || '').startsWith('attachment'))
    assert.equal(bridgeConsumeRes.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    const afterConsumeRes = await fetch(`${httpBase}${ownerUpload.upload.url}`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })
    assert.equal(afterConsumeRes.status, 404, 'Consumed non-image upload must be deleted immediately from relay disk')

    // 8.6 SSRF & X-Bridge-Secret leak defense in materializeAttachments
    let attackerHits = 0
    const attackerServer = http.createServer((req, res) => {
      attackerHits += 1
      res.writeHead(200)
      res.end('nope')
    })
    await new Promise((r) => attackerServer.listen(0, '127.0.0.1', r))
    const attackerPort = attackerServer.address().port
    try {
      const matResult = await bridge.orchestrator.materializeAttachments([
        { url: `http://127.0.0.1:${attackerPort}/steal`, filename: 'evil.txt', mimeType: 'text/plain' },
        { url: '/api/uploads/../../etc/passwd', filename: 'trav.txt', mimeType: 'text/plain' },
        { localPath: '/etc/passwd', filename: 'passwd', mimeType: 'text/plain' },
      ])
      assert.equal(matResult.length, 0, 'Untrusted URLs and caller-supplied localPath must all be rejected')
      assert.equal(attackerHits, 0, 'Bridge must NEVER send fetch or X-Bridge-Secret to external/attacker URLs')
    } finally {
      await new Promise((r) => attackerServer.close(r))
    }

    // 8.7 Symlink image bypass defense in readLocalFile
    const symlinkPath = join(tmpDir, 'disguised-secret.png')
    symlinkSync(join(process.cwd(), 'package.json'), symlinkPath)
    const symlinkRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent(symlinkPath)}&mt=${encodeURIComponent(mediaTokRes.mediaToken)}`,
    )
    assert.equal(symlinkRes.status, 403, 'Symlink pointing to non-image file must be blocked with 403')

    // 8.8 Session ID path traversal & CLI argument injection defense
    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'dsh:../../etc/passwd' }), /非法的/)
    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'claude:../../etc/passwd' }), /非法的/)
    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'antigravity:../../etc/passwd' }), /非法的/)
    await assert.rejects(
      () => bridge.orchestrator.sendMessage({ id: 'claude:--malicious-flag', text: 'hi' }),
      /非法的/,
    )
    await assert.rejects(
      () => bridge.orchestrator.sendMessage({ id: 'claude:safe-id-1', text: 'hi', model: 'opus & calc.exe' }),
      /非法的/,
    )

    // 8.9 Token revocation (`POST /api/rooms/revoke`) kicks active WS with 4401 and invalidates JWT + mediaToken
    const mediaTokA = await (await fetch(`${httpBase}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairARes.token}` },
    })).json()
    assert.equal(mediaTokA.ok, true)

    const ticketA = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairARes.token}` },
    })).json()
    const wsRevoke = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketA.ticket)}`)
    await new Promise((resolve, reject) => {
      wsRevoke.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'hello') resolve()
      })
      wsRevoke.on('error', reject)
    })
    const closeCodePromise = new Promise((resolve) => {
      wsRevoke.on('close', (code) => resolve(code))
    })

    const revokeRes = await (await fetch(`${httpBase}/api/rooms/revoke`, {
      method: 'POST',
      headers: { 'X-Room-Id': regA.roomId, 'X-Bridge-Secret': regA.bridgeSecret },
    })).json()
    assert.equal(revokeRes.ok, true)
    assert.equal(revokeRes.disconnectedClients, 1)
    assert.equal(await closeCodePromise, 4401, 'Revoked WS client must be kicked with code 4401')

    const revokedMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${pairARes.token}` },
    })
    assert.equal(revokedMe.status, 401, 'Revoked JWT must return 401 on /api/auth/me')
    const revokedMedia = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&mt=${encodeURIComponent(mediaTokA.mediaToken)}`,
    )
    assert.equal(revokedMedia.status, 401, 'Revoked room mediaToken must return 401')

    // Re-pairing after revocation issues a fresh working token (tv=1)
    const postRevokeRefresh = await (await fetch(`${httpBase}/api/rooms/pair-code`, {
      method: 'POST',
      headers: { 'X-Room-Id': regA.roomId, 'X-Bridge-Secret': regA.bridgeSecret },
    })).json()
    const postRevokePair = await (await fetch(`${httpBase}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode: postRevokeRefresh.pairCode }),
    })).json()
    assert.equal(postRevokePair.ok, true)
    const freshMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${postRevokePair.token}` },
    })
    assert.equal(freshMe.status, 200, 'Re-paired token after revocation must succeed')

    // 8.10 X-Forwarded-For spoofing resistance (uses rightmost trusted-proxy IP, ignores spoofed leftmost)
    for (let i = 0; i < 15; i += 1) {
      const r = await fetch(`${httpBase}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `1.2.3.${i + 1}, 203.0.113.9`,
        },
        body: JSON.stringify({ password: 'bad-password' }),
      })
      assert.equal(r.status, 401)
    }
    const throttled = await fetch(`${httpBase}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '9.9.9.9, 203.0.113.9',
      },
      body: JSON.stringify({ password: 'bad-password' }),
    })
    assert.equal(throttled.status, 429, 'Spoofing leftmost X-Forwarded-For must NOT bypass rate limit')

    // 8.11 Optional REGISTER_INVITE_CODE gating
    const gatedRelay = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      clientAccessToken: TEST_PASS,
      bridgeSecret: TEST_BRIDGE_SECRET,
      registerInviteCode: 'invite-top-secret',
      roomsFile: join(tmpDir, 'gated-rooms.json'),
      uploadDir: join(tmpDir, 'gated-uploads'),
    })
    const gatedAddr = await gatedRelay.start()
    try {
      const noInv = await fetch(`http://127.0.0.1:${gatedAddr.port}/api/rooms/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Uninvited' }),
      })
      assert.equal(noInv.status, 403, 'Gated server must reject room registration without invite code')
      const withInv = await fetch(`http://127.0.0.1:${gatedAddr.port}/api/rooms/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Invite-Code': 'invite-top-secret' },
        body: JSON.stringify({ label: 'Invited-PC' }),
      })
      assert.equal(withInv.status, 200, 'Gated server must accept valid invite code')
    } finally {
      await gatedRelay.close()
    }

    console.log('[smoke] 8/9 Security hardening suite OK (11 checks passed)')

    // 9. Account System, Single-Use Invite Codes & Auto Multi-PC Discovery
    const bootBefore = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootBefore.ok, true)
    assert.equal(bootBefore.hasUsers, false, 'Fresh server should report hasUsers=false before first admin')

    // Reject registration without valid invite
    const badReg = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'Password123!', inviteCode: 'INV-AAAA-BBBB' }),
    })
    assert.equal(badReg.status, 400, 'Registration with invalid invite code must fail')

    // Bootstrap first admin account using server CLIENT_ACCESS_TOKEN
    const alicePass = 'AliceStrongPass99!'
    const aliceReg = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: alicePass, inviteCode: TEST_PASS }),
    })).json()
    assert.equal(aliceReg.ok, true)
    assert.equal(aliceReg.user.role, 'admin', 'First bootstrapped user must be admin')
    assert.ok(aliceReg.roomId.startsWith('usr_'))

    const bootAfter = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootAfter.hasUsers, true)

    // Bootstrap key must NO LONGER work once 1st user exists
    const secondBootTry = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'intruder', password: 'Password123!', inviteCode: TEST_PASS }),
    })
    assert.equal(secondBootTry.status, 400, 'CLIENT_ACCESS_TOKEN bootstrap must only work for the very first user')

    // Admin generates 2 single-use invite codes
    const invCreate = await (await fetch(`${httpBase}/api/admin/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceReg.token}`,
      },
      body: JSON.stringify({ count: 2, note: 'smoke-friends' }),
    })).json()
    assert.equal(invCreate.ok, true)
    assert.equal(invCreate.invites.length, 2)
    const inv1 = invCreate.invites[0]
    const inv2 = invCreate.invites[1]
    assert.match(inv1.code, /^INV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)

    // Bob registers with invite #1 -> succeeds as non-admin user
    const bobReg = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword88!', inviteCode: inv1.code.toLowerCase() }),
    })).json()
    assert.equal(bobReg.ok, true)
    assert.equal(bobReg.user.role, 'user')

    // Reusing invite #1 for Charlie must FAIL (strictly 1 user per invite code!)
    const reuseInv1 = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'CharliePass77!', inviteCode: inv1.code }),
    })
    assert.equal(reuseInv1.status, 400, 'Single-use invite code must reject a 2nd user')

    // Non-admin Bob cannot list or create invite codes
    const bobAdminTry = await fetch(`${httpBase}/api/admin/invites`, {
      headers: { Authorization: `Bearer ${bobReg.token}` },
    })
    assert.equal(bobAdminTry.status, 403, 'Non-admin user must receive 403 on /api/admin/invites')

    // Admin revokes unused invite #2 -> Charlie cannot use it
    const revokeInv2 = await (await fetch(`${httpBase}/api/admin/invites/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceReg.token}`,
      },
      body: JSON.stringify({ id: inv2.id }),
    })).json()
    assert.equal(revokeInv2.ok, true)
    assert.equal(revokeInv2.invite.status, 'revoked')
    const revokedInvTry = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'CharliePass77!', inviteCode: inv2.code }),
    })
    assert.equal(revokedInvTry.status, 400, 'Revoked invite code must be rejected')

    // Verify accounts.json NEVER stores plaintext passwords
    const persistedAccounts = readFileSync(join(tmpDir, 'accounts.json'), 'utf8')
    assert.equal(persistedAccounts.includes(alicePass), false, 'accounts.json must NOT store plaintext password')

    // Bind PC-1 via portable single-file CLI in account mode (verifying password is NEVER written to config.json!)
    if (existsSync(bundlePath)) {
      const acctStateDir = join(tmpDir, 'portable-account-home')
      acctPortableChild = spawn(process.execPath, [
        bundlePath,
        '--server', httpBase,
        '--state-dir', acctStateDir,
        '--name', 'Alice-Mac',
        '--username', 'alice',
        '--password', alicePass,
        '--no-browser',
      ], {
        env: { ...process.env, ALLINONE_NO_AUTOFIX: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let acctOut = ''
      acctPortableChild.stdout.on('data', (d) => { acctOut += String(d) })
      acctPortableChild.stderr.on('data', (d) => { acctOut += String(d) })
      for (let i = 0; i < 60; i++) {
        if (existsSync(join(acctStateDir, 'config.json')) && acctOut.includes('已加密连接到中转服务器')) break
        await new Promise((r) => setTimeout(r, 150))
      }
      assert.ok(acctOut.includes('已加密连接到中转服务器'), `Account portable CLI should connect (${acctOut.slice(0, 300)})`)
      const pcCfgRaw = readFileSync(join(acctStateDir, 'config.json'), 'utf8')
      assert.equal(pcCfgRaw.includes(alicePass), false, 'PC config.json must NEVER store account password!')
      assert.ok(pcCfgRaw.includes('"mode": "account"'))
    }

    // Bind PC-2 via /api/account/device-login and connect via standalone bridge
    const boundPc2 = await (await fetch(`${httpBase}/api/account/device-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice',
        password: alicePass,
        label: 'Alice-Win-Desktop',
        hostname: 'WIN-HOME',
        platform: 'win32',
      }),
    })).json()
    assert.equal(boundPc2.ok, true)
    assert.ok(boundPc2.deviceSecret.startsWith('dv_'))
    assert.equal(
      readFileSync(join(tmpDir, 'accounts.json'), 'utf8').includes(boundPc2.deviceSecret),
      false,
      'accounts.json must NOT store plaintext deviceSecret',
    )

    acctBridge2 = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: boundPc2.deviceSecret,
      roomId: boundPc2.roomId,
      bridgeId: boundPc2.bridgeId,
      quiet: true,
    })
    const expectedCount = existsSync(bundlePath) ? 2 : 1
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList(aliceReg.roomId).filter((b) => b.online).length >= expectedCount) break
      await new Promise((r) => setTimeout(r, 100))
    }

    // Mobile login as Alice automatically discovers ALL bound online PCs!
    const aliceLogin = await (await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: alicePass }),
    })).json()
    assert.equal(aliceLogin.ok, true)
    assert.equal(aliceLogin.devices.length, expectedCount)
    assert.ok(aliceLogin.devices.every((d) => d.online), 'All connected Alice PCs should show online automatically')

    // Bob's account is strictly isolated (0 devices)
    const bobLogin = await (await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'BobPassword88!' }),
    })).json()
    assert.equal(bobLogin.ok, true)
    assert.equal(bobLogin.devices.length, 0, 'Bob must NEVER see Alice devices')

    // Rename & then unbind PC-2 -> immediately invalidates PC-2 deviceSecret while PC-1 stays online
    const renamedPc2 = await (await fetch(`${httpBase}/api/account/devices/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceLogin.token}`,
      },
      body: JSON.stringify({ deviceId: boundPc2.deviceId, label: '家里游戏主机' }),
    })).json()
    assert.equal(renamedPc2.ok, true)
    assert.equal(renamedPc2.device.label, '家里游戏主机')

    const removedPc2 = await (await fetch(`${httpBase}/api/account/devices/remove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceLogin.token}`,
      },
      body: JSON.stringify({ deviceId: boundPc2.deviceId }),
    })).json()
    assert.equal(removedPc2.ok, true)

    const pc2StatusAfterRemove = await fetch(`${httpBase}/api/account/device-status`, {
      headers: { 'X-Room-Id': boundPc2.roomId, 'X-Bridge-Secret': boundPc2.deviceSecret },
    })
    assert.equal(pc2StatusAfterRemove.status, 401, 'Unbound PC deviceSecret must immediately return 401')
    if (existsSync(bundlePath)) {
      assert.equal(
        relay.hub.getBridgeList(aliceReg.roomId).filter((b) => b.online).length,
        1,
        'PC-1 must stay online after unbinding PC-2',
      )
    }

    // Desktop App JWT-authenticated device registration (`POST /api/account/devices/register`) + `app://allinone` CORS
    const desktopRegRes = await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceLogin.token}`,
        Origin: 'app://allinone',
      },
      body: JSON.stringify({
        label: 'Alice-Desktop-App',
        hostname: 'ALICE-MBP',
        platform: 'darwin',
      }),
    })
    assert.equal(desktopRegRes.status, 200)
    assert.equal(desktopRegRes.headers.get('access-control-allow-origin'), 'app://allinone')
    const desktopBound = await desktopRegRes.json()
    assert.equal(desktopBound.ok, true)
    assert.ok(desktopBound.deviceSecret.startsWith('dv_'))
    assert.equal(desktopBound.roomId, aliceReg.roomId)

    console.log('[smoke] 9/10 Account system, single-use invite codes, desktop auto-bind & multi-PC discovery OK')

    // 10. Half-installed CLI detection & opt-out guard (never installs unused tools; detects partial installs accurately)
    const emptyFakeHome = join(tmpDir, 'fake-home-empty')
    mkdirSync(emptyFakeHome, { recursive: true })
    const emptyMissing = detectHalfInstalledClis({
      homeDir: emptyFakeHome,
      platform: 'darwin',
      env: {},
      checkBin: () => null,
      checkSystemApps: false,
    })
    assert.equal(emptyMissing.length, 0, 'Clean machine with no AI apps/data must NOT trigger any CLI auto-install')

    const partialFakeHome = join(tmpDir, 'fake-home-partial')
    mkdirSync(join(partialFakeHome, '.gemini', 'antigravity'), { recursive: true })
    mkdirSync(join(partialFakeHome, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(partialFakeHome, '.codex', 'sessions'), { recursive: true })
    const partialMissing = detectHalfInstalledClis({
      homeDir: partialFakeHome,
      platform: 'darwin',
      env: {},
      checkBin: (names) => (names.includes('npm') ? '/usr/local/bin/npm' : null),
      checkSystemApps: false,
    })
    assert.deepEqual(
      partialMissing.map((m) => m.app).sort(),
      ['antigravity', 'claude', 'codex'],
      'Half-installed environments (data exists, CLI missing) must be detected automatically',
    )

    // When CLIs ARE present, nothing is flagged as half-installed
    const completeResult = detectHalfInstalledClis({
      homeDir: partialFakeHome,
      platform: 'darwin',
      env: {},
      checkBin: () => '/usr/local/bin/mock-bin',
      checkSystemApps: false,
    })
    assert.equal(completeResult.length, 0, 'Complete environments must not trigger auto-install')

    // ALLINONE_NO_AUTOFIX=1 opt-out guard
    const prevOptOut = process.env.ALLINONE_NO_AUTOFIX
    process.env.ALLINONE_NO_AUTOFIX = '1'
    try {
      const optOutRes = await autoCompleteHalfInstalledClis({ stateDir: join(tmpDir, 'autofix-optout') })
      assert.equal(optOutRes.skipped, true)
      assert.equal(optOutRes.reason, 'disabled')
    } finally {
      if (prevOptOut === undefined) delete process.env.ALLINONE_NO_AUTOFIX
      else process.env.ALLINONE_NO_AUTOFIX = prevOptOut
    }
    console.log('[smoke] 10/11 Half-installed CLI auto-completion detector & opt-out guard OK')

    // 11. Antigravity split-brain transcript resilience, unique branch IDs, cache reconciliation & live external watcher
    const splitJsonl = [
      JSON.stringify({ step_index: 10, type: 'USER_INPUT', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nTrunk Q\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 11, type: 'PLANNER_RESPONSE', created_at: '2026-11-21T10:00:05Z', content: 'Trunk A' }),
      JSON.stringify({ step_index: 12, type: 'USER_INPUT', created_at: '2026-11-21T11:00:00Z', content: '<USER_REQUEST>\nACP Branch Q\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 13, type: 'PLANNER_RESPONSE', created_at: '2026-11-21T11:00:05Z', content: 'ACP Branch A' }),
      // Desktop resumed stale RAM at step 11 -> wrote step 12 & 13 again!
      JSON.stringify({ step_index: 12, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: '<USER_REQUEST>\nDesktop Fresh Q\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 13, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T10:00:05Z', content: 'Desktop Fresh A' }),
    ].join('\n')

    const parsedSplit = parseAgyTranscriptContent(splitJsonl)
    assert.equal(parsedSplit.messages.length, 6, 'All 6 messages across both branches must be preserved without overwriting')
    assert.ok(parsedSplit.divergence, 'step_index regression must be flagged as divergence')
    assert.equal(parsedSplit.divergence.lastFromStep, 13)
    assert.equal(parsedSplit.divergence.lastToStep, 12)
    const uniqueIds = new Set(parsedSplit.messages.map((m) => m.id))
    assert.equal(uniqueIds.size, 6, 'All message IDs must be strictly unique even when step_index regresses')
    assert.equal(parsedSplit.messages[0].id, 'agy-u-10', 'Branch 0 IDs stay backward compatible')
    assert.equal(parsedSplit.messages[4].id, 'agy-u-b1-12', 'Regressed branch must receive distinct branch-scoped ID')
    assert.equal(parsedSplit.messages[5].text, 'Desktop Fresh A', 'Latest Desktop message must stay at the bottom')

    // Cache reconciliation must drop trailing synthetic msg-u/msg-a bubbles without duplicating persisted history
    const cachedWithOptimistic = {
      messages: [
        parsedSplit.messages[0],
        parsedSplit.messages[1],
        parsedSplit.messages[2],
        parsedSplit.messages[3],
        { id: 'msg-u-999999', role: 'user', text: 'Desktop Fresh Q', ts: parsedSplit.messages[4].ts },
        { id: 'msg-a-999999', role: 'assistant', text: 'Desktop Fresh A', ts: parsedSplit.messages[5].ts },
      ],
      hasMore: true,
      nextCursor: '10',
      totalCount: 16,
    }
    const reconciled = reconcileCachedWithFreshPage(cachedWithOptimistic, {
      messages: parsedSplit.messages.slice(2),
      hasMore: true,
      nextCursor: '12',
      totalCount: 18,
    })
    assert.equal(reconciled.messages.length, 6, 'Reconciliation must replace synthetic bubbles cleanly with zero duplicates')
    assert.equal(reconciled.messages[reconciled.messages.length - 1].id, 'agy-a-b1-13')

    // Live external watcher: modifying a watched transcript.jsonl emits EVENTS.SESSION_UPDATED with historyChanged=true
    const fakeAgyHome = join(tmpDir, 'fake-agy-home')
    const fakeConvId = '11111111-2222-3333-4444-555555555555'
    const fakeLogDir = join(fakeAgyHome, 'brain', fakeConvId, '.system_generated', 'logs')
    mkdirSync(fakeLogDir, { recursive: true })
    const fakeTranscriptPath = join(fakeLogDir, 'transcript.jsonl')
    writeFileSync(
      fakeTranscriptPath,
      `${JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: 'hi' })}\n`,
    )
    const watchEvents = []
    const watchAdapter = new AntigravityAdapter({
      config: { agyHome: fakeAgyHome, watchPollIntervalMs: 220 },
      log: { warn() {}, log() {} },
      emitEvent: (ev, payload) => watchEvents.push({ ev, payload }),
    })
    try {
      const initSess = await watchAdapter.readSession(fakeConvId, { limit: 15 })
      assert.equal(initSess.messages.length, 1)
      await new Promise((r) => setTimeout(r, 80))
      writeFileSync(
        fakeTranscriptPath,
        [
          JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: 'hi' }),
          JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T10:00:02Z', content: 'hello from desktop!' }),
        ].join('\n') + '\n',
      )
      for (let i = 0; i < 25; i++) {
        if (watchEvents.some((e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.historyChanged)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const hit = watchEvents.find((e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.historyChanged)
      assert.ok(hit, 'External transcript.jsonl write must trigger EVENTS.SESSION_UPDATED(historyChanged=true)')
      assert.equal(hit.payload.session.nativeId, fakeConvId)
      const afterSess = await watchAdapter.readSession(fakeConvId, { limit: 15 })
      assert.equal(afterSess.messages.length, 2)
      assert.equal(afterSess.messages[1].text, 'hello from desktop!')
    } finally {
      await watchAdapter.dispose()
    }
    // Per-conversation local draft isolation (text + pending attachments)
    const dkA = makeDraftKey('dev1::pc1', 'codex:sess-a', 'codex')
    const dkB = makeDraftKey('dev1::pc1', 'antigravity:sess-b', 'antigravity')
    const dkNew = makeDraftKey('dev1::pc1', '', 'claude')
    saveDraft(dkA, { text: 'Draft for Codex A', attachments: [{ id: 'att1', filename: 'a.png' }] })
    saveDraft(dkB, { text: 'Draft for Agy B', attachments: [] })
    saveDraft(dkNew, { text: 'New Claude chat draft', attachments: [] })
    assert.equal(loadDraft(dkA).text, 'Draft for Codex A')
    assert.equal(loadDraft(dkA).attachments.length, 1)
    assert.equal(loadDraft(dkB).text, 'Draft for Agy B')
    assert.equal(loadDraft(dkB).attachments.length, 0)
    assert.equal(loadDraft(dkNew).text, 'New Claude chat draft')
    clearDraft(dkA)
    assert.equal(loadDraft(dkA).text, '')
    assert.equal(loadDraft(dkB).text, 'Draft for Agy B', 'Clearing session A draft must not touch session B')
    saveLastSessionId('dev1::pc1', 'codex:sess-a')
    saveLastWorkspace('dev1::pc1', '/Users/demo/AllinOne')
    assert.equal(loadLastSessionId('dev1::pc1'), 'codex:sess-a')
    assert.equal(loadLastWorkspace('dev1::pc1'), '/Users/demo/AllinOne')
    clearDraftsForScope('dev1')
    assert.equal(loadDraft(dkB).text, '')
    assert.equal(loadDraft(dkNew).text, '')
    assert.equal(loadLastSessionId('dev1::pc1'), '')
    assert.equal(loadLastWorkspace('dev1::pc1'), '')

    console.log('[smoke] 11/12 Antigravity split-brain transcript resilience, cache reconciliation, live watcher & per-session drafts OK')

    // 12. Optional email binding (zero-dependency SMTP), email login, post-login bind & self-service password reset
    const noEmailBootstrap = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(noEmailBootstrap.emailEnabled, false, 'Unconfigured relay must report emailEnabled=false')
    const noEmailSendRes = await fetch(`${httpBase}/api/account/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'reset', email: 'test@example.com' }),
    })
    assert.equal(noEmailSendRes.status, 503, 'Unconfigured relay must reject send-code with 503')

    const smtpInbox = []
    const mockSmtp = net.createServer((sock) => {
      let buf = ''
      let state = 'cmd' // 'cmd' | 'auth_user' | 'auth_pass' | 'data'
      let cur = { authUser: '', authPass: '', mailFrom: '', rcptTo: '', rawData: '' }
      sock.write('220 mock-smtp.local ESMTP Ready\r\n')
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        while (true) {
          if (state === 'data') {
            const endIdx = buf.indexOf('\r\n.\r\n')
            if (endIdx === -1) break
            cur.rawData = buf.slice(0, endIdx)
            buf = buf.slice(endIdx + 5)
            // Decode UTF-8 base64 plain-text part to extract 6-digit code
            const b64Match = cur.rawData.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)
            const decodedText = b64Match ? Buffer.from(b64Match[1].replace(/\r?\n/g, ''), 'base64').toString('utf8') : cur.rawData
            const codeMatch = decodedText.match(/\b(\d{6})\b/)
            smtpInbox.push({ ...cur, decodedText, code: codeMatch ? codeMatch[1] : '' })
            cur = { authUser: cur.authUser, authPass: cur.authPass, mailFrom: '', rcptTo: '', rawData: '' }
            state = 'cmd'
            sock.write('250 2.0.0 OK queued\r\n')
            continue
          }
          const nl = buf.indexOf('\n')
          if (nl === -1) break
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (state === 'auth_user') {
            cur.authUser = Buffer.from(line, 'base64').toString('utf8')
            state = 'auth_pass'
            sock.write('334 UGFzc3dvcmQ6\r\n')
          } else if (state === 'auth_pass') {
            cur.authPass = Buffer.from(line, 'base64').toString('utf8')
            state = 'cmd'
            sock.write('235 2.7.0 Authentication successful\r\n')
          } else if (/^EHLO /i.test(line)) {
            sock.write('250-mock-smtp.local\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n')
          } else if (/^AUTH LOGIN$/i.test(line)) {
            state = 'auth_user'
            sock.write('334 VXNlcm5hbWU6\r\n')
          } else if (/^MAIL FROM:/i.test(line)) {
            cur.mailFrom = line.slice(10).trim()
            sock.write('250 OK\r\n')
          } else if (/^RCPT TO:/i.test(line)) {
            cur.rcptTo = line.slice(8).trim()
            sock.write('250 OK\r\n')
          } else if (/^DATA$/i.test(line)) {
            state = 'data'
            sock.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          } else if (/^QUIT$/i.test(line)) {
            sock.write('221 Bye\r\n')
            sock.end()
          } else {
            sock.write('250 OK\r\n')
          }
        }
      })
    })
    await new Promise((r) => mockSmtp.listen(0, '127.0.0.1', r))
    const mockSmtpPort = mockSmtp.address().port

    const emailRelay = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      clientAccessToken: 'email-bootstrap-secret-99',
      bridgeSecret: 'email-bridge-secret-99',
      uploadDir: join(tmpDir, 'email-uploads'),
      roomsFile: join(tmpDir, 'email-rooms.json'),
      accountsFile: join(tmpDir, 'email-accounts.json'),
      smtpHost: '127.0.0.1',
      smtpPort: mockSmtpPort,
      smtpSecure: false,
      smtpStarttls: false,
      smtpUser: 'noreply@example.com',
      smtpPass: 'smtp-auth-secret',
      smtpFrom: 'All in One <noreply@example.com>',
      emailCodeOptions: { cooldownMs: 1200 },
    })
    try {
      const { port: emailRelayPort } = await emailRelay.start()
      const emailHttpBase = `http://127.0.0.1:${emailRelayPort}`

      const bsEmail = await (await fetch(`${emailHttpBase}/api/account/bootstrap-status`)).json()
      assert.equal(bsEmail.emailEnabled, true, 'SMTP-configured relay must report emailEnabled=true')
      assert.equal(bsEmail.hasUsers, false)

      // 12a. Bootstrap admin WITHOUT email (email is strictly optional during registration)
      const evaReg = await (await fetch(`${emailHttpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'eva',
          password: 'EvaAdminPassword1!',
          inviteCode: 'email-bootstrap-secret-99',
        }),
      })).json()
      assert.equal(evaReg.ok, true)
      assert.equal(evaReg.user.email, '')
      assert.equal(evaReg.user.emailVerified, false)

      // Generate 2 invites
      const invBatch = await (await fetch(`${emailHttpBase}/api/admin/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${evaReg.token}`,
        },
        body: JSON.stringify({ count: 2, note: 'email-test' }),
      })).json()
      const [invEmail1, invEmail2] = invBatch.invites

      // 12b. Invalid invite code must NOT trigger SMTP send (protects free SMTP quota)
      const badInvSend = await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: 'INV-FAKE-0000' }),
      })
      assert.equal(badInvSend.status, 400)
      assert.equal(smtpInbox.length, 0, 'Invalid invite code must never send an SMTP email')

      // 12c. Valid invite -> real SMTP delivery + AUTH LOGIN verification + cooldown guard
      const regCodeRes = await (await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: invEmail1.code }),
      })).json()
      assert.equal(regCodeRes.ok, true)
      assert.equal(smtpInbox.length, 1)
      assert.equal(smtpInbox[0].authUser, 'noreply@example.com')
      assert.equal(smtpInbox[0].authPass, 'smtp-auth-secret')
      assert.equal(smtpInbox[0].rcptTo, '<dave@example.com>')
      assert.match(smtpInbox[0].code, /^\d{6}$/)
      assert.ok(smtpInbox[0].decodedText.includes('注册账号'))

      // Immediate resend hits 429 cooldown
      const cooldownRes = await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: invEmail1.code }),
      })
      assert.equal(cooldownRes.status, 429, 'Immediate resend must be rate-limited by cooldown')

      // 12d. Register Dave WITH verified email
      const daveReg = await (await fetch(`${emailHttpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'dave',
          password: 'DavePassword123!',
          inviteCode: invEmail1.code,
          email: 'dave@example.com',
          emailCode: smtpInbox[0].code,
        }),
      })).json()
      assert.equal(daveReg.ok, true)
      assert.equal(daveReg.user.email, 'dave@example.com')
      assert.equal(daveReg.user.emailVerified, true)

      // 12e. Login via bound EMAIL works on both /api/account/login and /api/account/device-login
      const daveEmailLogin = await (await fetch(`${emailHttpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'DAVE@Example.com', password: 'DavePassword123!' }),
      })).json()
      assert.equal(daveEmailLogin.ok, true)
      assert.equal(daveEmailLogin.user.username, 'dave')
      assert.equal(daveEmailLogin.user.email, 'dave@example.com')

      const daveDeviceLogin = await (await fetch(`${emailHttpBase}/api/account/device-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dave@example.com', password: 'DavePassword123!', label: 'Dave-PC' }),
      })).json()
      assert.equal(daveDeviceLogin.ok, true)
      assert.equal(daveDeviceLogin.username, 'dave')

      // 12f. Register Frank WITHOUT email, then bind email post-login via /api/account/email/bind
      const frankReg = await (await fetch(`${emailHttpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'frank',
          password: 'FrankPassword123!',
          inviteCode: invEmail2.code,
        }),
      })).json()
      assert.equal(frankReg.ok, true)
      assert.equal(frankReg.user.email, '')

      // Duplicate email rejected on bind
      const dupBindSend = await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${frankReg.token}`,
        },
        body: JSON.stringify({ purpose: 'bind', email: 'dave@example.com' }),
      })
      assert.equal(dupBindSend.status, 400, 'Already-bound email must be rejected')

      const bindSendRes = await (await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${frankReg.token}`,
        },
        body: JSON.stringify({ purpose: 'bind', email: 'frank@example.com' }),
      })).json()
      assert.equal(bindSendRes.ok, true)
      assert.equal(smtpInbox.length, 2)

      const bindConfirm = await (await fetch(`${emailHttpBase}/api/account/email/bind`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${frankReg.token}`,
        },
        body: JSON.stringify({ email: 'frank@example.com', code: smtpInbox[1].code }),
      })).json()
      assert.equal(bindConfirm.ok, true)
      assert.equal(bindConfirm.user.email, 'frank@example.com')
      assert.equal(bindConfirm.user.emailVerified, true)

      const frankMe = await (await fetch(`${emailHttpBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${frankReg.token}` },
      })).json()
      assert.equal(frankMe.email, 'frank@example.com')
      assert.equal(frankMe.emailVerified, true)
      assert.equal(frankMe.emailEnabled, true)

      // 12g. Self-service password reset: unbound email sends 0 SMTP messages; bound email resets & revokes old JWT!
      const unknownResetSend = await (await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'reset', email: 'nobody@example.com' }),
      })).json()
      assert.equal(unknownResetSend.ok, true, 'Unbound reset request must return neutral ok response')
      assert.equal(smtpInbox.length, 2, 'Unbound email must NOT send any SMTP message')

      const daveResetSend = await (await fetch(`${emailHttpBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'reset', email: 'dave@example.com' }),
      })).json()
      assert.equal(daveResetSend.ok, true)
      assert.equal(smtpInbox.length, 3)

      const daveResetConfirm = await (await fetch(`${emailHttpBase}/api/account/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dave@example.com',
          code: smtpInbox[2].code,
          newPassword: 'DaveNewPassword99!',
        }),
      })).json()
      assert.equal(daveResetConfirm.ok, true)
      assert.equal(daveResetConfirm.username, 'dave')

      // Old JWT is immediately revoked after password reset
      const oldTokenMe = await fetch(`${emailHttpBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${daveEmailLogin.token}` },
      })
      assert.equal(oldTokenMe.status, 401, 'Old session token must be revoked after password reset')

      // Old password fails, new password succeeds via email login
      const oldPassTry = await fetch(`${emailHttpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dave@example.com', password: 'DavePassword123!' }),
      })
      assert.equal(oldPassTry.status, 401)
      const newPassLogin = await (await fetch(`${emailHttpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'dave@example.com', password: 'DaveNewPassword99!' }),
      })).json()
      assert.equal(newPassLogin.ok, true)
      assert.equal(newPassLogin.user.username, 'dave')
    } finally {
      await emailRelay.close()
      await new Promise((r) => mockSmtp.close(r))
    }

    console.log('[smoke] 12/13 Zero-dependency SMTP mailer, optional email register, email login, bind & password reset OK')

    // 13. Static React Rules-of-Hooks guard across all mobile/desktop JSX components
    {
      const scanJsx = (dir) => {
        const out = []
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name)
          if (ent.isDirectory()) out.push(...scanJsx(p))
          else if (ent.name.endsWith('.jsx')) out.push(p)
        }
        return out
      }
      const violations = []
      for (const f of scanJsx(join(process.cwd(), 'packages/mobile-app/src'))) {
        const lines = readFileSync(f, 'utf8').split(/\r?\n/)
        let curComp = ''
        let compDepth = -1
        let earlyReturnLine = -1
        let depth = 0
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]
          const clean = line.replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`|\/\/.*$/g, '')
          if (!curComp) {
            const m = clean.match(/^(?:export\s+)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=\s*(?:React\.)?memo\s*\(\s*function\s*\w*)/)
            if (m) {
              curComp = m[1] || m[2]
              compDepth = depth
              earlyReturnLine = -1
            }
          }
          if (curComp && depth === compDepth + 1) {
            if (/^\s*if\s*\(/.test(clean) && (/\breturn\b/.test(clean) || (lines[i + 1] && /^\s+return\b/.test(lines[i + 1])))) {
              if (earlyReturnLine === -1) earlyReturnLine = i + 1
            }
            if (earlyReturnLine !== -1 && /\buse(State|Effect|Memo|Callback|Ref|LayoutEffect|Context|Reducer)\s*\(/.test(clean)) {
              violations.push(`${f}:${i + 1} (${curComp}) hook after early return at L${earlyReturnLine}`)
            }
          }
          for (const ch of clean) {
            if (ch === '{') depth += 1
            else if (ch === '}') {
              depth -= 1
              if (curComp && depth === compDepth) {
                curComp = ''
                compDepth = -1
                earlyReturnLine = -1
              }
            }
          }
        }
      }
      assert.deepEqual(violations, [], `React hook order violations found:\n${violations.join('\n')}`)
    }
    console.log('[smoke] 13/14 React Rules-of-Hooks static guard across all JSX components OK')

    // 14. Built-in Desktop Auto-Updater (semver, asset selection, streamed download, SHA-256 verification, cache reuse)
    {
      assert.equal(compareSemver('0.3.4', '0.3.3'), 1)
      assert.equal(compareSemver('v0.10.0', '0.3.9'), 1)
      assert.equal(compareSemver('0.3.3', 'v0.3.3'), 0)
      assert.equal(compareSemver('0.3.4', '0.3.4-beta.1'), 1)
      assert.equal(compareSemver('0.3.2', '0.3.3'), -1)

      const sampleAssets = [
        { name: 'All-in-One-Android.apk', browser_download_url: 'https://github.com/a/b/All-in-One-Android.apk' },
        { name: 'All.in.One-0.3.4-arm64.dmg', browser_download_url: 'https://github.com/a/b/All.in.One-0.3.4-arm64.dmg' },
        { name: 'All.in.One.Setup.0.3.4.exe', browser_download_url: 'https://github.com/a/b/All.in.One.Setup.0.3.4.exe' },
      ]
      assert.equal(pickReleaseAsset(sampleAssets, 'win32', 'x64')?.name, 'All.in.One.Setup.0.3.4.exe')
      assert.equal(pickReleaseAsset(sampleAssets, 'darwin', 'arm64')?.name, 'All.in.One-0.3.4-arm64.dmg')

      // Verify Windows silent updater scripts use WScript (SW_HIDE=0) + PowerShell, never cmd/tasklist/find
      const winScripts = buildWindowsUpdateScripts({
        installerPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\All.in.One.Setup.0.3.7.exe',
        exePath: 'C:\\Users\\张三\\AppData\\Local\\Programs\\all-in-one\\All in One.exe',
        pid: 12345,
        isPackaged: true,
        logPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\last-update.log',
        ps1Path: 'C:\\Users\\张三\\AppData\\Local\\Temp\\apply-update.ps1',
      })
      assert.ok(winScripts.vbsScript.includes('sh.Run cmd, 0, True'), 'VBScript wrapper must run PowerShell hidden (SW_HIDE=0)')
      assert.ok(winScripts.psScript.includes('Get-Process -Id $oldPid'), 'PowerShell helper must wait via Get-Process')
      assert.ok(winScripts.psScript.includes('ArgumentList "/S"'), 'PowerShell helper must invoke NSIS silent /S')
      assert.equal(winScripts.psScript.includes('tasklist'), false, 'Must not use console tasklist/find')

      const fakePayload = Buffer.alloc(64 * 1024, 0x5a)
      const validSha = createHash('sha256').update(fakePayload).digest('hex')
      let downloadHits = 0
      const mockReleaseServer = http.createServer((req, res) => {
        const base = `http://127.0.0.1:${mockReleaseServer.address().port}`
        if (req.url === '/releases/latest') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v0.3.4',
            html_url: 'https://github.com/RainbowLion0320/AllinOne/releases/tag/v0.3.4',
            body: 'Built-in updater release',
            published_at: '2026-11-23T00:00:00Z',
            assets: [
              {
                name: 'All.in.One.Setup.0.3.4.exe',
                size: fakePayload.length,
                digest: `sha256:${validSha}`,
                browser_download_url: `${base}/download/All.in.One.Setup.0.3.4.exe`,
              },
            ],
          }))
          return
        }
        if (req.url === '/releases/corrupt') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v0.3.5',
            html_url: 'https://github.com/RainbowLion0320/AllinOne/releases/tag/v0.3.5',
            assets: [
              {
                name: 'All.in.One.Setup.0.3.5.exe',
                size: fakePayload.length,
                digest: `sha256:${'0'.repeat(64)}`,
                browser_download_url: `${base}/download/All.in.One.Setup.0.3.4.exe`,
              },
            ],
          }))
          return
        }
        if (req.url === '/download/All.in.One.Setup.0.3.4.exe') {
          downloadHits += 1
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(fakePayload.length),
          })
          res.write(fakePayload.subarray(0, 32 * 1024))
          setTimeout(() => {
            res.end(fakePayload.subarray(32 * 1024))
          }, 20)
          return
        }
        res.writeHead(404)
        res.end('not found')
      })

      await new Promise((r) => mockReleaseServer.listen(0, '127.0.0.1', r))
      const updPort = mockReleaseServer.address().port
      const updDir = join(tmpDir, 'updater-cache')
      try {
        // 14.1 Check -> available -> download -> SHA-256 verified -> cached reuse
        const updater = new DesktopUpdater({
          currentVersion: '0.3.3',
          platform: 'win32',
          arch: 'x64',
          downloadDir: updDir,
          apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
          allowLocalhost: true,
        })
        const seenStatuses = []
        updater.on('state', (s) => seenStatuses.push(s.status))

        const chk = await updater.checkForUpdates()
        assert.equal(chk.status, 'available')
        assert.equal(chk.latestVersion, '0.3.4')
        assert.equal(chk.expectedSha256, validSha)

        const dl = await updater.downloadUpdate()
        assert.equal(dl.status, 'downloaded')
        assert.equal(dl.percent, 100)
        assert.ok(existsSync(dl.downloadedPath), 'Downloaded installer must exist on disk')
        assert.equal(Buffer.compare(readFileSync(dl.downloadedPath), fakePayload), 0)
        assert.ok(seenStatuses.includes('downloading'), 'Must emit downloading state')
        assert.equal(downloadHits, 1)

        // Second check on a fresh updater instance reuses verified cached installer
        const updaterReuse = new DesktopUpdater({
          currentVersion: '0.3.3',
          platform: 'win32',
          arch: 'x64',
          downloadDir: updDir,
          apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
          allowLocalhost: true,
        })
        const reused = await updaterReuse.checkForUpdates()
        assert.equal(reused.status, 'downloaded', 'Verified cached installer should be reused immediately')
        assert.equal(downloadHits, 1)

        // 14.2 Corrupted SHA-256 digest must fail and discard partial file
        const corruptUpdater = new DesktopUpdater({
          currentVersion: '0.3.3',
          platform: 'win32',
          arch: 'x64',
          downloadDir: updDir,
          apiUrl: `http://127.0.0.1:${updPort}/releases/corrupt`,
          allowLocalhost: true,
        })
        const corruptChk = await corruptUpdater.checkForUpdates()
        assert.equal(corruptChk.status, 'available')
        const corruptDl = await corruptUpdater.downloadUpdate()
        assert.equal(corruptDl.status, 'error')
        assert.match(corruptDl.error, /SHA-256/)
        assert.equal(existsSync(join(updDir, 'All.in.One.Setup.0.3.5.exe')), false)
        assert.equal(existsSync(join(updDir, 'All.in.One.Setup.0.3.5.exe.part')), false)

        // 14.3 Already up-to-date
        const upToDateUpdater = new DesktopUpdater({
          currentVersion: '0.3.4',
          platform: 'win32',
          arch: 'x64',
          downloadDir: updDir,
          apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
          allowLocalhost: true,
        })
        const same = await upToDateUpdater.checkForUpdates()
        assert.equal(same.status, 'up-to-date')

        // 14.4 Reject untrusted download host when allowLocalhost=false
        const strictUpdater = new DesktopUpdater({
          currentVersion: '0.3.3',
          platform: 'win32',
          downloadDir: updDir,
          allowLocalhost: false,
        })
        strictUpdater.setState({
          status: 'available',
          assetName: 'evil.exe',
          downloadUrl: 'https://evil.example.com/evil.exe',
        })
        const blocked = await strictUpdater.downloadUpdate()
        assert.equal(blocked.status, 'error')
        assert.match(blocked.error, /不受信任/)
      } finally {
        try { mockReleaseServer.closeAllConnections?.() } catch {}
        await new Promise((r) => mockReleaseServer.close(r))
      }
    }
    console.log('[smoke] 14/15 Built-in desktop auto-updater (semver, download, SHA-256, cache reuse & host guard) OK')

    // 15. Bilingual i18n store (zh/en detection, persistence, dictionary parity & interpolation)
    {
      assert.equal(normalizeLang('zh-CN'), 'zh')
      assert.equal(normalizeLang('en-US'), 'en')
      assert.equal(normalizeLang('EN'), 'en')
      assert.equal(normalizeLang('fr-FR'), null)

      const mem = new Map()
      const langStorage = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
      }
      assert.equal(detectInitialLang(langStorage, { language: 'en-US' }), 'en')
      assert.equal(detectInitialLang(langStorage, { language: 'zh-Hans-CN' }), 'zh')
      saveLang('en', langStorage)
      assert.equal(langStorage.getItem(LANG_STORAGE_KEY), 'en')
      assert.equal(loadSavedLang(langStorage), 'en')
      assert.equal(detectInitialLang(langStorage, { language: 'zh-CN' }), 'en', 'Saved language must override browser locale')

      assert.deepEqual(
        Object.keys(MESSAGES.zh).sort(),
        Object.keys(MESSAGES.en).sort(),
        'zh and en dictionaries must have identical key sets',
      )
      assert.equal(translate('zh', 'time.minsAgo', { n: 5 }), '5 分钟前')
      assert.equal(translate('en', 'time.minsAgo', { n: 5 }), '5m ago')
      assert.equal(bi('zh', '设置', 'Settings'), '设置')
      assert.equal(bi('en', '设置', 'Settings'), 'Settings')
      assert.equal(getDeviceDisplayName(null, null, 0, 'en'), 'No Computer')
      assert.equal(getDeviceDisplayName(null, null, 0, 'zh'), '未选择电脑')
      // Restore cache to default zh for clean test end
      saveLang('zh', langStorage)
    }
    console.log('[smoke] 15/15 Bilingual i18n (zh/en detection, persistence & dictionary parity) OK')

    console.log('\nALL SMOKE TESTS PASSED!')
  } finally {
    if (acctPortableChild) {
      try { acctPortableChild.kill() } catch {}
    }
    if (acctBridge2) await acctBridge2.stop()
    if (portableChild) {
      try { portableChild.kill() } catch {}
    }
    if (ownerBridge2) await ownerBridge2.stop()
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
