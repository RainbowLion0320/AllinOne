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
import { DshAdapter } from '../packages/dsh-mobile-hub/src/adapters/dsh.js'
import { startDshLocalIpcServer } from '../packages/dsh-mobile-hub/src/dsh-local-ipc.js'
import { ensureDshLocalIpcPlugin } from '../packages/dsh-mobile-hub/src/helpers/dsh-ipc-installer.js'
import { autoCompleteHalfInstalledClis, detectHalfInstalledClis } from '../packages/dsh-mobile-hub/src/helpers/env-autofix.js'
import { AntigravityAdapter, normalizeAntigravityQuota, parseAgyTranscriptContent } from '../packages/dsh-mobile-hub/src/adapters/antigravity.js'
import {
  CodexAdapter,
  buildCodexQuestionReplyText,
  extractPendingCodexAsyncQuestionFromRollout,
  formatCodexQuestionReplyForDisplay,
  normalizeCodexAsyncQuestionCard,
  normalizeCodexQuota,
  normalizeCodexTurns,
  parseCodexQuestionReply,
  probeCodexRolloutStatus,
  readCodexRolloutTail,
} from '../packages/dsh-mobile-hub/src/adapters/codex.js'
import {
  ClaudeAdapter,
  normalizeClaudeQuota,
  probeClaudeExternalStatus,
  probeClaudeTranscriptTail,
} from '../packages/dsh-mobile-hub/src/adapters/claude.js'
import { MultiAppOrchestrator } from '../packages/dsh-mobile-hub/src/orchestrator.js'
import { RelayBridgeLink } from '../packages/dsh-mobile-hub/src/ws-client.js'
import {
  parseCompositeId as hubParseCompositeId,
  toEpochMs as hubToEpochMs,
} from '../packages/dsh-mobile-hub/src/protocol.js'
import {
  answersToElicitationContent,
  elicitationSchemaToQuestions,
} from '../packages/dsh-mobile-hub/src/helpers/interactive-schema.js'
import { EVENTS, RPC, parseCompositeId, toEpochMs } from '../packages/shared/src/protocol.js'
import {
  E2EE_METHOD_MARKER,
  base64UrlToBytes,
  bytesToBase64,
  computeE2eeKeyId,
  computeGrantPubKeyFp,
  decryptBytes,
  decryptGrantPayload,
  decryptJson,
  deriveGrantSas,
  encodeE2eeGrantQrUri,
  encodeE2eeQrUri,
  encryptBytes,
  encryptGrantPayload,
  encryptJson,
  formatE2eeFingerprint,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantReqId,
  parseE2eeGrantQrInput,
  parseE2eeQrInput,
} from '../packages/shared/src/e2ee.js'
import { renderQrSvg as renderSharedQrSvg } from '../packages/shared/src/qr-svg.js'
import {
  DEVICES_STORAGE_KEY,
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  renameDevice,
  saveDeviceState,
  selectDevice,
  upsertDevice,
  upsertDeviceE2eeKey,
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
  DesktopBridgeManager,
  loadConfigDecrypted,
  loadConfigWithStatus,
  saveConfigSecure,
} from '../packages/desktop-app/src/bridge-manager.js'
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

const TEST_BOOTSTRAP_TOKEN = 'smoke-bootstrap-token-123'
const SMOKE_ADMIN_PASS = 'SmokeAdminPass99!'

async function openTicketClientWs(httpBase, port, token, { deviceName = 'smoke-client', clientKind = 'web' } = {}) {
  const ticketRes = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceName, clientKind }),
  })).json()
  assert.equal(ticketRes.ok, true, 'POST /api/auth/ws-ticket should succeed')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
  const pending = new Map()
  const events = []
  let hello = null
  let closedCode = null
  await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'hello') {
        hello = msg
        resolve()
        return
      }
      if (msg.type === 'rpc.res') {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.resolve(msg)
        }
      } else if (msg.type === 'event') {
        events.push(msg)
      }
    })
    ws.on('close', (code) => { closedCode = code })
    ws.on('error', reject)
  })
  let reqSeq = 1
  const sendEncryptedRpc = async (method, params = {}, { e2eeKey, roomId, bridgeId = '' } = {}) => {
    const id = `t-${reqSeq++}`
    const env = await encryptJson(
      e2eeKey,
      { method, params, cid: id, ts: Date.now() },
      { kind: 'rpc.req', roomId },
    )
    const rawRes = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, 20_000)
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
      ws.send(JSON.stringify({
        type: 'rpc.req',
        id,
        method: E2EE_METHOD_MARKER,
        e2ee: env,
        ...(bridgeId ? { bridgeId } : {}),
      }))
    })
    if (rawRes.e2ee) {
      const dec = await decryptJson(e2eeKey, rawRes.e2ee, { kind: 'rpc.res', roomId })
      assert.equal(dec.cid, id, 'Decrypted RPC response cid must match request id')
      if (dec.ok) return dec.result
      const err = new Error(dec.error?.message || 'RPC error')
      err.code = dec.error?.code || 'RPC_ERROR'
      throw err
    }
    const err = new Error(rawRes.error?.message || 'RPC error')
    err.code = rawRes.error?.code || 'RPC_ERROR'
    throw err
  }
  return { ws, hello, events, sendEncryptedRpc, getClosedCode: () => closedCode }
}

async function main() {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'allinone-smoke-'))
  // 1. Start Relay Server on ephemeral port (strict Account Mode + mandatory E2EE)
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    jwtSecret: 'smoke-test-jwt-secret-0123456789',
    adminBootstrapToken: TEST_BOOTSTRAP_TOKEN,
    accountsFile: join(tmpDir, 'accounts.json'),
    uploadDir: join(tmpDir, 'uploads'),
  })
  const { port } = await relay.start()
  const httpBase = `http://127.0.0.1:${port}`
  const wsBridgeUrl = `ws://127.0.0.1:${port}/ws/bridge`

  let bridge = null
  let friendBridgeA = null
  let ownerBridge2 = null
  let acctPortableChild = null
  let acctBridge2 = null

  try {
    // Bootstrap primary admin account & bind primary E2EE PC Bridge
    const smokeAdmin = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'smoke_admin',
        password: SMOKE_ADMIN_PASS,
        inviteCode: TEST_BOOTSTRAP_TOKEN,
        deviceName: 'smoke-phone',
      }),
    })).json()
    assert.equal(smokeAdmin.ok, true)
    assert.equal(smokeAdmin.user.role, 'admin')
    assert.ok(smokeAdmin.roomId.startsWith('usr_'))

    // Verify account login & wrong password rejection
    const loginRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'smoke-phone' }),
    })
    assert.equal(loginRes.status, 200)
    const loginData = await loginRes.json()
    assert.equal(loginData.ok, true)
    assert.ok(loginData.token, 'Should receive signed session token')

    const badRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: 'wrong-password' }),
    })
    assert.equal(badRes.status, 401)
    console.log('[smoke] 1/6 Account auth & wrong-password rejection OK')

    // 2. Register & start Standalone PC Bridge with mandatory E2EE
    const smokeDev = await (await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ label: 'Smoke-PC-1', hostname: 'smoke-pc', platform: process.platform }),
    })).json()
    assert.equal(smokeDev.ok, true)
    const primaryE2eeKey = generateE2eeKey()

    bridge = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: smokeDev.deviceSecret,
      roomId: smokeAdmin.roomId,
      bridgeId: smokeDev.bridgeId,
      e2eeKey: primaryE2eeKey,
    })

    // Wait up to 5s for E2EE bridge to connect
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList(smokeAdmin.roomId).some((b) => b.online && b.e2ee?.enabled)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(relay.hub.getBridgeList(smokeAdmin.roomId).length, 1, 'PC bridge should be registered in account room')
    assert.equal(relay.hub.getBridgeList(smokeAdmin.roomId)[0].online, true, 'PC bridge should be online')
    assert.equal(relay.hub.getBridgeList(smokeAdmin.roomId)[0].e2ee?.enabled, true, 'PC bridge must advertise E2EE')
    console.log('[smoke] 2/6 Relay + E2EE PC Bridge connected OK')

    // 4. Connect mobile WS client via single-use ticket & exercise E2EE RPCs across all 4 apps
    const cli = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'smoke-phone' })
    const rpc = (method, params = {}) =>
      cli.sendEncryptedRpc(method, params, {
        e2eeKey: primaryE2eeKey,
        roomId: smokeAdmin.roomId,
        bridgeId: smokeDev.bridgeId,
      })

    const statusRes = await rpc(RPC.APPS_STATUS)
    assert.equal(statusRes.apps.length, 4, 'Should report status for all 4 apps')
    console.log(
      '[smoke] 3/6 Apps status (E2EE):',
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
      '[smoke] 3.5/6 Models catalog:',
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
    console.log('[smoke] 4/6 Sessions listed:', listRes.sessions.length, 'breakdown:', byApp)

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

    // 4.5 Verify E2EE RPC.FILE_READ image loading, non-image security guardrail & deleted /api/bridge-file (404)
    const fileRes = await rpc(RPC.FILE_READ, {
      path: 'packages/mobile-app/public/icon-192.png',
      cwd: process.cwd(),
    })
    assert.equal(fileRes.mimeType, 'image/png')
    const imgBuf = Buffer.from(fileRes.dataBase64, 'base64')
    assert.ok(imgBuf.length > 1000 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50, 'Should return valid PNG binary over E2EE')

    await assert.rejects(
      () => rpc(RPC.FILE_READ, { path: 'package.json', cwd: process.cwd() }),
      /出于安全限制/,
      'Non-image files must be blocked on RPC.FILE_READ',
    )

    const removedProxyRes = await fetch(
      `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}`,
    )
    assert.equal(removedProxyRes.status, 404, 'Legacy /api/bridge-file endpoint must be permanently removed (404)')
    console.log(`[smoke] 4.5/6 E2EE RPC.FILE_READ OK (${imgBuf.length} bytes PNG, non-image blocked, /api/bridge-file=404)`)

    cli.ws.close()

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

    applyDshPlugin(mockCtx, { enableDispatchTools: true, enableLocalIpc: false })
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

    // 6. Strict Multi-Tenant Account Isolation, Deleted Legacy Routes & Encrypted Upload Isolation
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

    const adminHealth = await (await fetch(`${httpBase}/api/health`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    assert.equal(adminHealth.ok, true)
    assert.equal(adminHealth.roomId, smokeAdmin.roomId)
    assert.ok(adminHealth.onlineBridges >= 1)

    // Verify all legacy owner-key & room-pair endpoints are permanently removed (404)
    for (const [method, path] of [
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/pair'],
      ['POST', '/api/rooms/register'],
      ['POST', '/api/rooms/pair-code'],
      ['POST', '/api/rooms/revoke'],
      ['GET', '/api/bridge-file'],
    ]) {
      const r = await fetch(`${httpBase}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? '{}' : undefined,
      })
      assert.equal(r.status, 404, `Removed legacy endpoint ${method} ${path} must return 404`)
    }

    // Create 2 isolated accounts (Friend A and Friend B) via admin invites
    const invAB = await (await fetch(`${httpBase}/api/admin/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ count: 2, note: 'multi-tenant-isolation' }),
    })).json()
    assert.equal(invAB.ok, true)
    assert.equal(invAB.invites.length, 2)

    const friendA = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_a', password: 'FriendAPass99!', inviteCode: invAB.invites[0].code }),
    })).json()
    assert.equal(friendA.ok, true)
    assert.ok(friendA.roomId.startsWith('usr_'))

    const friendB = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_b', password: 'FriendBPass99!', inviteCode: invAB.invites[1].code }),
    })).json()
    assert.equal(friendB.ok, true)
    assert.notEqual(friendA.roomId, friendB.roomId)

    // Bind & connect Friend Bridge A with mandatory E2EE
    const friendDevA = await (await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${friendA.token}` },
      body: JSON.stringify({ label: 'Friend-A-PC', hostname: 'friend-a-pc', platform: 'darwin' }),
    })).json()
    assert.equal(friendDevA.ok, true)
    const friendE2eeKeyA = generateE2eeKey()

    friendBridgeA = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: friendDevA.deviceSecret,
      roomId: friendA.roomId,
      bridgeId: friendDevA.bridgeId,
      e2eeKey: friendE2eeKeyA,
      quiet: true,
    })
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList(friendA.roomId).some((b) => b.online && b.e2ee?.enabled)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(relay.hub.getBridgeList(friendA.roomId).length, 1)
    assert.equal(relay.hub.getBridgeList(smokeAdmin.roomId).length, 1, 'Admin account must still see ONLY 1 bridge')
    assert.equal(relay.hub.getBridgeList(friendB.roomId).length, 0, 'Friend B must NOT see Admin or Friend A bridges')

    // Verify WS hello isolation for Friend A (via single-use ticket)
    const wsACli = await openTicketClientWs(httpBase, port, friendA.token, { deviceName: 'friend-a-phone' })
    assert.equal(wsACli.hello.roomId, friendA.roomId)
    assert.equal(wsACli.hello.bridges.length, 1)
    assert.equal(wsACli.hello.bridges[0].bridgeId, friendDevA.bridgeId)
    wsACli.ws.close()

    // Plaintext /api/uploads must be rejected with 400 E2EE_UPLOAD_REQUIRED
    const plainUploadRes = await fetch(`${httpBase}/api/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({
        filename: 'plain.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('not-encrypted').toString('base64'),
      }),
    })
    assert.equal(plainUploadRes.status, 400, 'Plaintext /api/uploads must be rejected with 400')
    const plainUploadJson = await plainUploadRes.json()
    assert.equal(plainUploadJson.code, 'E2EE_UPLOAD_REQUIRED')

    // Cross-account encrypted upload isolation check
    const encAdminBlob = await encryptBytes(primaryE2eeKey, Buffer.from('admin-private-data', 'utf8'), {
      kind: 'upload',
      roomId: smokeAdmin.roomId,
    })
    const adminUpload = await (await fetch(`${httpBase}/api/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({
        filename: 'secret.txt',
        mimeType: 'text/plain',
        encrypted: true,
        dataBase64: bytesToBase64(encAdminBlob.ciphertext),
      }),
    })).json()
    assert.equal(adminUpload.ok, true)

    const adminMediaTok = await (await fetch(`${httpBase}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    const friendAMediaTok = await (await fetch(`${httpBase}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${friendA.token}` },
    })).json()

    const adminDl = await fetch(`${httpBase}${adminUpload.upload.url}?mt=${encodeURIComponent(adminMediaTok.mediaToken)}`)
    assert.equal(adminDl.status, 200)
    const crossPhoneDl = await fetch(`${httpBase}${adminUpload.upload.url}?mt=${encodeURIComponent(friendAMediaTok.mediaToken)}`)
    assert.equal(crossPhoneDl.status, 403, 'Friend A media token must be blocked (403) from Admin uploads')
    const crossBridgeDl = await fetch(`${httpBase}${adminUpload.upload.url}`, {
      headers: { 'X-Room-Id': friendA.roomId, 'X-Bridge-Secret': friendDevA.deviceSecret },
    })
    assert.equal(crossBridgeDl.status, 403, 'Friend Bridge A must be blocked (403) from Admin uploads')

    const bundlePath = join(process.cwd(), 'packages/mobile-app/public/downloads/allinone-bridge.mjs')
    console.log('[smoke] 6/6 Multi-tenant isolation, deleted legacy routes & encrypted upload isolation OK')

    // 7. Multi-device switching, /api/auth/me status probing, strict bridgeId routing, & scoped cache isolation
    const meA = await (await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${friendA.token}` },
    })).json()
    assert.equal(meA.ok, true)
    assert.equal(meA.roomId, friendA.roomId)
    assert.equal(meA.username, 'friend_a')
    assert.equal(meA.bridges.length, 1)
    assert.equal(meA.bridges[0].online, true)

    const meB = await (await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${friendB.token}` },
    })).json()
    assert.equal(meB.ok, true)
    assert.equal(meB.username, 'friend_b')
    assert.equal(meB.bridges.length, 0)

    // Strict bridgeId routing with 2 simultaneous E2EE bridges in smoke_admin account
    const smokeDev2 = await (await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ label: 'Smoke-PC-2', hostname: 'smoke-pc-2', platform: process.platform }),
    })).json()
    assert.equal(smokeDev2.ok, true)
    const secondE2eeKey = generateE2eeKey()

    ownerBridge2 = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: smokeDev2.deviceSecret,
      roomId: smokeAdmin.roomId,
      bridgeId: smokeDev2.bridgeId,
      e2eeKey: secondE2eeKey,
      quiet: true,
    })
    for (let i = 0; i < 50; i++) {
      if (relay.hub.getBridgeList(smokeAdmin.roomId).filter((b) => b.online).length >= 2) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(
      relay.hub.getBridgeList(smokeAdmin.roomId).filter((b) => b.online).length,
      2,
      'Account room should support 2 simultaneous online E2EE bridges',
    )

    const wsMulti = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'smoke-multi' })
    assert.equal(wsMulti.hello.bridges.length, 2)
    const okRes2 = await wsMulti.sendEncryptedRpc(RPC.APPS_STATUS, {}, {
      e2eeKey: secondE2eeKey,
      roomId: smokeAdmin.roomId,
      bridgeId: smokeDev2.bridgeId,
    })
    assert.equal(okRes2.apps.length, 4, 'Encrypted RPC targeting online smoke-pc-2 should succeed')
    await assert.rejects(
      () => wsMulti.sendEncryptedRpc(RPC.APPS_STATUS, {}, {
        e2eeKey: secondE2eeKey,
        roomId: smokeAdmin.roomId,
        bridgeId: 'offline-pc-999',
      }),
      (err) => err.code === 'BRIDGE_OFFLINE',
      'RPC targeting offline bridgeId must fail strictly with BRIDGE_OFFLINE',
    )
    wsMulti.ws.close()

    // Mobile multi-account store: legacy owner/rm_* entries auto-purged + multi-account coexist + isolated cache
    const memStore = new Map()
    const fakeStorage = {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    }
    fakeStorage.setItem(DEVICES_STORAGE_KEY, JSON.stringify({
      activeDeviceId: 'stale-owner',
      devices: [
        { id: 'stale-owner', baseUrl: httpBase, token: 'old-owner-tok', roomId: 'owner', label: 'Legacy Owner' },
        { id: 'stale-room', baseUrl: httpBase, token: 'old-rm-tok', roomId: 'rm_legacy1234', label: 'Legacy Room' },
        { baseUrl: httpBase, token: friendA.token, roomId: friendA.roomId, username: 'friend_a', label: 'Friend-A-PC', bridges: meA.bridges },
      ],
    }))
    let dState = loadDeviceState(fakeStorage)
    assert.equal(dState.devices.length, 1, 'Legacy owner and rm_* entries must be purged automatically on load')
    assert.equal(dState.devices[0].roomId, friendA.roomId)

    // Rename Account A and add Account B -> both coexist
    const devAId = dState.devices[0].id
    dState = renameDevice(dState, devAId, '公司 Mac')
    const addedB = upsertDevice(dState, {
      baseUrl: httpBase,
      token: friendB.token,
      roomId: friendB.roomId,
      username: 'friend_b',
      label: '家里 Windows',
      bridges: [],
      authMode: 'account',
    })
    assert.equal(addedB.isNew, true)
    dState = addedB.state
    assert.equal(dState.devices.length, 2, 'Adding 2nd account must preserve 1st account')
    assert.equal(getActiveDevice(dState).id, addedB.device.id)
    assert.equal(getDeviceDisplayName(dState.devices[0]), '公司 Mac')

    // Re-logging into Account A refreshes token in-place and preserves customName
    const repairedA = upsertDevice(dState, {
      baseUrl: httpBase,
      token: `${friendA.token}-refreshed`,
      roomId: friendA.roomId,
      username: 'friend_a',
      label: 'Friend-A-PC',
      bridges: meA.bridges,
      authMode: 'account',
    })
    assert.equal(repairedA.isNew, false)
    dState = repairedA.state
    assert.equal(dState.devices.length, 2)
    assert.equal(getDeviceDisplayName(dState.devices[0]), '公司 Mac', 'Re-login must keep custom nickname')
    assert.equal(dState.devices[0].token, `${friendA.token}-refreshed`)

    // Switch back to Account B and verify save/reload persistence
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

    // Clearing Account A cache prefix leaves Account B cache untouched
    await clearSessionCache(dState.devices[0].id, { prefix: true })
    assert.equal(await loadCachedSession('codex:shared-id', scopeA), null)
    assert.equal((await loadCachedSession('codex:shared-id', scopeB)).messages[0].text, 'from Win')
    await clearSessionCache()

    // Removing Account B auto-falls back to Account A
    dState = removeDevice(dState, addedB.device.id)
    assert.equal(dState.devices.length, 1)
    assert.equal(dState.activeDeviceId, devAId)

    // Image URL helper only signs `/api/uploads/...` with short-lived `mt=` mediaToken; local paths never fall back to removed `/api/bridge-file`
    const uploadImgSrc = resolveImageSrc({ url: '/api/uploads/sample-id' }, {
      baseUrl: httpBase,
      mediaToken: 'mtok',
      token: 'master-tok',
    })
    assert.ok(uploadImgSrc.includes('mt=mtok') && !uploadImgSrc.includes('master-tok'), 'resolveImageSrc must use mt= mediaToken only')
    const localImgSrc = resolveImageSrc('/tmp/shot.png', { baseUrl: httpBase, mediaToken: 'mtok' })
    assert.equal(localImgSrc, '', 'Local paths must never build removed /api/bridge-file URLs')
    console.log('[smoke] 7/8 Multi-device store, status probe, strict bridgeId routing & scoped cache OK')

    // 8. Comprehensive Security Hardening Suite
    // 8.1 Production missing/weak JWT_SECRET refusal
    assert.throws(
      () =>
        createRelayServer({
          port: 0,
          host: '127.0.0.1',
          nodeEnv: 'production',
          jwtSecret: 'too-short',
          accountsFile: join(tmpDir, 'prod-accounts.json'),
          uploadDir: join(tmpDir, 'prod-uploads'),
        }),
      /Refusing to start in production/,
      'Production server must refuse to start without a strong JWT_SECRET (>= 16 chars)',
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

    // 8.3 Single-use WS ticket, CSWSH origin block & legacy ?token= query rejection
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const legacyTokWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(loginData.token)}`)
          legacyTokWs.on('open', () => { legacyTokWs.close(); resolve() })
          legacyTokWs.on('error', reject)
        }),
      'Legacy /ws/client?token= query string must be strictly rejected',
    )

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

    // 8.4 Scoped read-only media token (works ONLY for /api/uploads/:id; master session token rejected on media endpoint & media token rejected on session APIs)
    const mtUploadRes = await fetch(
      `${httpBase}${adminUpload.upload.url}?mt=${encodeURIComponent(adminMediaTok.mediaToken)}`,
    )
    assert.equal(mtUploadRes.status, 200, 'Scoped mediaToken must authorize GET /api/uploads/:id')
    const rawSessionOnUpload = await fetch(
      `${httpBase}${adminUpload.upload.url}?mt=${encodeURIComponent(loginData.token)}`,
    )
    assert.equal(rawSessionOnUpload.status, 401, 'Master session JWT must NOT be accepted on scoped media endpoint')
    const mtOnMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${adminMediaTok.mediaToken}` },
    })
    assert.equal(mtOnMe.status, 401, 'Media token must NOT work as a full session token on /api/auth/me')
    const mtOnTicket = await fetch(`${httpBase}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminMediaTok.mediaToken}` },
    })
    assert.equal(mtOnTicket.status, 401, 'Media token must NOT mint WS tickets')

    // 8.5 Bridge URL query secret rejection + ephemeral consume on encrypted upload + safe headers
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const qsBridge = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?room=${encodeURIComponent(smokeAdmin.roomId)}&secret=${encodeURIComponent(smokeDev.deviceSecret)}`)
          qsBridge.on('open', () => { qsBridge.close(); resolve() })
          qsBridge.on('error', reject)
        }),
      'Bridge WS must reject ?secret= in URL query string',
    )
    const qsUploadTry = await fetch(`${httpBase}${adminUpload.upload.url}?secret=${encodeURIComponent(smokeDev.deviceSecret)}`)
    assert.equal(qsUploadTry.status, 401, 'Upload download must reject ?secret= in URL query string')

    const bridgeConsumeRes = await fetch(`${httpBase}${adminUpload.upload.url}?consume=1`, {
      headers: { 'X-Room-Id': smokeAdmin.roomId, 'X-Bridge-Secret': smokeDev.deviceSecret },
    })
    assert.equal(bridgeConsumeRes.status, 200)
    assert.ok(String(bridgeConsumeRes.headers.get('content-disposition') || '').startsWith('attachment'))
    assert.equal(bridgeConsumeRes.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    const afterConsumeRes = await fetch(`${httpBase}${adminUpload.upload.url}?mt=${encodeURIComponent(adminMediaTok.mediaToken)}`)
    assert.equal(afterConsumeRes.status, 404, 'Consumed encrypted upload must be deleted immediately from relay disk')

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
        { url: `http://127.0.0.1:${attackerPort}/steal`, filename: 'evil.txt', mimeType: 'text/plain', e2ee: { iv: 'AAAAAAAAAAAAAAAA' } },
        { url: '/api/uploads/../../etc/passwd', filename: 'trav.txt', mimeType: 'text/plain', e2ee: { iv: 'AAAAAAAAAAAAAAAA' } },
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
    await assert.rejects(
      () => bridge.orchestrator.readLocalFile({ path: symlinkPath }),
      /出于安全限制/,
      'Symlink pointing to non-image file must be blocked in readLocalFile',
    )

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

    // 8.9 Token revocation (`POST /api/auth/sessions/revoke-all`) kicks active WS with 4401 and invalidates JWT + mediaToken
    const encFriendBlob = await encryptBytes(friendE2eeKeyA, Buffer.from('friend-a-file', 'utf8'), {
      kind: 'upload',
      roomId: friendA.roomId,
    })
    const friendUpload = await (await fetch(`${httpBase}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${friendA.token}` },
      body: JSON.stringify({
        filename: 'a.txt',
        mimeType: 'text/plain',
        encrypted: true,
        dataBase64: bytesToBase64(encFriendBlob.ciphertext),
      }),
    })).json()
    assert.equal(friendUpload.ok, true)

    const wsRevokeCli = await openTicketClientWs(httpBase, port, friendA.token, { deviceName: 'revoke-test-phone' })
    const closeCodePromise = new Promise((resolve) => {
      wsRevokeCli.ws.on('close', (code) => resolve(code))
    })

    const revokeRes = await (await fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${friendA.token}` },
    })).json()
    assert.equal(revokeRes.ok, true)
    assert.equal(revokeRes.disconnectedClients, 1)
    assert.equal(await closeCodePromise, 4401, 'Revoked WS client must be kicked with code 4401')

    const revokedMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${friendA.token}` },
    })
    assert.equal(revokedMe.status, 401, 'Revoked JWT must return 401 on /api/auth/me')
    const revokedMedia = await fetch(
      `${httpBase}${friendUpload.upload.url}?mt=${encodeURIComponent(friendAMediaTok.mediaToken)}`,
    )
    assert.equal(revokedMedia.status, 401, 'Revoked account mediaToken must return 401')

    // Re-logging in after revocation issues a fresh working token (tv=1)
    const postRevokeLogin = await (await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_a', password: 'FriendAPass99!' }),
    })).json()
    assert.equal(postRevokeLogin.ok, true)
    const freshMe = await fetch(`${httpBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${postRevokeLogin.token}` },
    })
    assert.equal(freshMe.status, 200, 'Re-logged token after revocation must succeed')

    // 8.10 X-Forwarded-For spoofing resistance (uses rightmost trusted-proxy IP, ignores spoofed leftmost)
    for (let i = 0; i < 15; i += 1) {
      const r = await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `1.2.3.${i + 1}, 203.0.113.9`,
        },
        body: JSON.stringify({ username: `nonexistent_user_${i}`, password: 'bad-password' }),
      })
      assert.equal(r.status, 401)
    }
    const throttled = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '9.9.9.9, 203.0.113.9',
      },
      body: JSON.stringify({ username: 'nonexistent_user_16', password: 'bad-password' }),
    })
    assert.equal(throttled.status, 429, 'Spoofing leftmost X-Forwarded-For must NOT bypass rate limit')

    // 8.11 Mandatory E2EE bridge enforcement: plaintext bridge without e2ee.enabled is closed with code 4008
    const nonE2eeCloseCode = await new Promise((resolveCode, rejectCode) => {
      const qs = new URLSearchParams({
        roomId: smokeAdmin.roomId,
        bridgeId: smokeDev2.bridgeId,
        hostname: 'plain-pc',
        platform: 'darwin',
      })
      const rawBr = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?${qs.toString()}`, {
        headers: { 'X-Room-Id': smokeAdmin.roomId, 'X-Bridge-Secret': smokeDev2.deviceSecret },
      })
      rawBr.on('open', () => {
        rawBr.send(JSON.stringify({ type: 'bridge.meta', meta: { apps: [] } }))
      })
      rawBr.on('close', (code) => resolveCode(code))
      rawBr.on('error', rejectCode)
    })
    assert.equal(nonE2eeCloseCode, 4008, 'Bridge sending bridge.meta without E2EE must be closed with code 4008')

    console.log('[smoke] 8/9 Security hardening suite OK (11 checks passed)')

    // 9. Account System, Single-Use Invite Codes & Auto Multi-PC Discovery (fresh server bootstrap test)
    {
      const acctRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'acct-test-jwt-secret-0123456789',
        adminBootstrapToken: TEST_BOOTSTRAP_TOKEN,
        accountsFile: join(tmpDir, 'acct-accounts.json'),
        uploadDir: join(tmpDir, 'acct-uploads'),
      })
      const { port: acctPort } = await acctRelay.start()
      const acctHttpBase = `http://127.0.0.1:${acctPort}`
      const acctWsBridgeUrl = `ws://127.0.0.1:${acctPort}/ws/bridge`
      try {
        const bootBefore = await (await fetch(`${acctHttpBase}/api/account/bootstrap-status`)).json()
        assert.equal(bootBefore.ok, true)
        assert.equal(bootBefore.hasUsers, false, 'Fresh server should report hasUsers=false before first admin')

        // Reject registration without valid invite
        const badReg = await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'nobody', password: 'Password123!', inviteCode: 'INV-AAAA-BBBB' }),
        })
        assert.equal(badReg.status, 400, 'Registration with invalid invite code must fail')

        // Bootstrap first admin account using server ADMIN_BOOTSTRAP_TOKEN
        const alicePass = 'AliceStrongPass99!'
        const aliceReg = await (await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: alicePass, inviteCode: TEST_BOOTSTRAP_TOKEN }),
        })).json()
        assert.equal(aliceReg.ok, true)
        assert.equal(aliceReg.user.role, 'admin', 'First bootstrapped user must be admin')
        assert.ok(aliceReg.roomId.startsWith('usr_'))

        const bootAfter = await (await fetch(`${acctHttpBase}/api/account/bootstrap-status`)).json()
        assert.equal(bootAfter.hasUsers, true)

        // Bootstrap token must NO LONGER work once 1st user exists
        const secondBootTry = await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'intruder', password: 'Password123!', inviteCode: TEST_BOOTSTRAP_TOKEN }),
        })
        assert.equal(secondBootTry.status, 400, 'ADMIN_BOOTSTRAP_TOKEN must only work for the very first user')

        // Admin generates 2 single-use invite codes
        const invCreate = await (await fetch(`${acctHttpBase}/api/admin/invites`, {
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
        const bobReg = await (await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'BobPassword88!', inviteCode: inv1.code.toLowerCase() }),
        })).json()
        assert.equal(bobReg.ok, true)
        assert.equal(bobReg.user.role, 'user')

        // Reusing invite #1 for Charlie must FAIL (strictly 1 user per invite code!)
        const reuseInv1 = await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'charlie', password: 'CharliePass77!', inviteCode: inv1.code }),
        })
        assert.equal(reuseInv1.status, 400, 'Single-use invite code must reject a 2nd user')

        // Non-admin Bob cannot list or create invite codes
        const bobAdminTry = await fetch(`${acctHttpBase}/api/admin/invites`, {
          headers: { Authorization: `Bearer ${bobReg.token}` },
        })
        assert.equal(bobAdminTry.status, 403, 'Non-admin user must receive 403 on /api/admin/invites')

        // Admin revokes unused invite #2 -> Charlie cannot use it
        const revokeInv2 = await (await fetch(`${acctHttpBase}/api/admin/invites/revoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${aliceReg.token}`,
          },
          body: JSON.stringify({ id: inv2.id }),
        })).json()
        assert.equal(revokeInv2.ok, true)
        assert.equal(revokeInv2.invite.status, 'revoked')
        const revokedInvTry = await fetch(`${acctHttpBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'charlie', password: 'CharliePass77!', inviteCode: inv2.code }),
        })
        assert.equal(revokedInvTry.status, 400, 'Revoked invite code must be rejected')

        // Verify accounts.json NEVER stores plaintext passwords
        const persistedAccounts = readFileSync(join(tmpDir, 'acct-accounts.json'), 'utf8')
        assert.equal(persistedAccounts.includes(alicePass), false, 'accounts.json must NOT store plaintext password')

        // Bind PC-1 via portable single-file CLI in account mode (verifying password is NEVER written & e2eeKey is auto-generated!)
        if (existsSync(bundlePath)) {
          const acctStateDir = join(tmpDir, 'portable-account-home')
          const childEnv = { ...process.env, ALLINONE_NO_AUTOFIX: '1' }
          delete childEnv.ALLINONE_E2EE_KEY
          delete childEnv.ALLINONE_BRIDGE_SECRET
          acctPortableChild = spawn(process.execPath, [
            bundlePath,
            '--server', acctHttpBase,
            '--state-dir', acctStateDir,
            '--name', 'Alice-Mac',
            '--username', 'alice',
            '--password', alicePass,
            '--no-browser',
          ], {
            env: childEnv,
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
          assert.ok(pcCfgRaw.includes('"e2eeKey"'), 'PC config.json must auto-generate mandatory e2eeKey')
        }

        // Bind PC-2 via /api/account/device-login and connect via standalone bridge (with mandatory E2EE)
        const boundPc2 = await (await fetch(`${acctHttpBase}/api/account/device-login`, {
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
          readFileSync(join(tmpDir, 'acct-accounts.json'), 'utf8').includes(boundPc2.deviceSecret),
          false,
          'accounts.json must NOT store plaintext deviceSecret',
        )

        acctBridge2 = startStandaloneBridge({
          relayUrl: acctWsBridgeUrl,
          secret: boundPc2.deviceSecret,
          roomId: boundPc2.roomId,
          bridgeId: boundPc2.bridgeId,
          e2eeKey: generateE2eeKey(),
          quiet: true,
        })
        const expectedCount = existsSync(bundlePath) ? 2 : 1
        for (let i = 0; i < 50; i++) {
          if (acctRelay.hub.getBridgeList(aliceReg.roomId).filter((b) => b.online).length >= expectedCount) break
          await new Promise((r) => setTimeout(r, 100))
        }

        // Mobile login as Alice automatically discovers ALL bound online PCs!
        const aliceLogin = await (await fetch(`${acctHttpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: alicePass }),
        })).json()
        assert.equal(aliceLogin.ok, true)
        assert.equal(aliceLogin.devices.length, expectedCount)
        assert.ok(aliceLogin.devices.every((d) => d.online), 'All connected Alice PCs should show online automatically')

        // Bob's account is strictly isolated (0 devices)
        const bobLogin = await (await fetch(`${acctHttpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'BobPassword88!' }),
        })).json()
        assert.equal(bobLogin.ok, true)
        assert.equal(bobLogin.devices.length, 0, 'Bob must NEVER see Alice devices')

        // Rename & then unbind PC-2 -> immediately invalidates PC-2 deviceSecret while PC-1 stays online
        const renamedPc2 = await (await fetch(`${acctHttpBase}/api/account/devices/rename`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${aliceLogin.token}`,
          },
          body: JSON.stringify({ deviceId: boundPc2.deviceId, label: '家里游戏主机' }),
        })).json()
        assert.equal(renamedPc2.ok, true)
        assert.equal(renamedPc2.device.label, '家里游戏主机')

        const removedPc2 = await (await fetch(`${acctHttpBase}/api/account/devices/remove`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${aliceLogin.token}`,
          },
          body: JSON.stringify({ deviceId: boundPc2.deviceId }),
        })).json()
        assert.equal(removedPc2.ok, true)

        const pc2StatusAfterRemove = await fetch(`${acctHttpBase}/api/account/device-status`, {
          headers: { 'X-Room-Id': boundPc2.roomId, 'X-Bridge-Secret': boundPc2.deviceSecret },
        })
        assert.equal(pc2StatusAfterRemove.status, 401, 'Unbound PC deviceSecret must immediately return 401')
        if (existsSync(bundlePath)) {
          assert.equal(
            acctRelay.hub.getBridgeList(aliceReg.roomId).filter((b) => b.online).length,
            1,
            'PC-1 must stay online after unbinding PC-2',
          )
        }

        // Desktop App JWT-authenticated device registration (`POST /api/account/devices/register`) + `app://allinone` CORS
        const desktopRegRes = await fetch(`${acctHttpBase}/api/account/devices/register`, {
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
      } finally {
        if (acctPortableChild) {
          try { acctPortableChild.kill() } catch {}
          acctPortableChild = null
        }
        if (acctBridge2) {
          await acctBridge2.stop()
          acctBridge2 = null
        }
        await acctRelay.close()
      }
    }

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
      jwtSecret: 'email-jwt-secret-0123456789',
      adminBootstrapToken: 'email-bootstrap-secret-99',
      uploadDir: join(tmpDir, 'email-uploads'),
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
    console.log('[smoke] 15/16 Bilingual i18n (zh/en detection, persistence & dictionary parity) OK')

    // 16. Active controlling devices monitor, live WS push, per-device kick & revoke-others token rotation
    {
      const sessRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'sess-jwt-secret-0123456789',
        adminBootstrapToken: 'sess-owner-pass',
        accountsFile: join(tmpDir, 'sess-accounts.json'),
        uploadDir: join(tmpDir, 'sess-uploads'),
      })
      const { port: sPort } = await sessRelay.start()
      const sBase = `http://127.0.0.1:${sPort}`
      const openClientWs = (token, deviceName, clientKind) =>
        new Promise((resolveWs, rejectWs) => {
          fetch(`${sBase}/api/auth/ws-ticket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ deviceName, clientKind }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!d.ok || !d.ticket) throw new Error('ws-ticket failed')
              const ws = new WebSocket(`ws://127.0.0.1:${sPort}/ws/client?ticket=${encodeURIComponent(d.ticket)}`)
              const events = []
              let hello = null
              let closedCode = null
              ws.on('message', (raw) => {
                const msg = JSON.parse(String(raw))
                if (msg.type === 'hello') {
                  hello = msg
                  resolveWs({ ws, hello, events, getClosedCode: () => closedCode })
                } else if (msg.type === 'event') {
                  events.push(msg)
                }
              })
              ws.on('close', (code) => {
                closedCode = code
              })
              ws.on('error', rejectWs)
            })
            .catch(rejectWs)
        })

      const sockets = []
      try {
        // Register bootstrap account (Device A: Windows Desktop)
        const regRes = await fetch(`${sBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'alice_sec',
            password: 'Password123!',
            inviteCode: 'sess-owner-pass',
            deviceName: 'Windows Desktop',
            clientKind: 'desktop',
          }),
        }).then((r) => r.json())
        assert.equal(regRes.ok, true)
        const tokA = regRes.token

        // Login Device B (Android App) and Device C (suspicious browser)
        const loginB = await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'alice_sec',
            password: 'Password123!',
            deviceName: 'Android App',
            clientKind: 'mobile',
          }),
        }).then((r) => r.json())
        assert.equal(loginB.ok, true)
        const tokB = loginB.token

        const loginC = await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'alice_sec',
            password: 'Password123!',
            deviceName: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0',
          }),
        }).then((r) => r.json())
        assert.equal(loginC.ok, true)
        const tokC = loginC.token

        const cliA = await openClientWs(tokA, 'Windows Desktop', 'desktop')
        sockets.push(cliA.ws)
        assert.equal(cliA.hello.onlineClientCount, 1)

        const cliB = await openClientWs(tokB, 'Android App', 'mobile')
        sockets.push(cliB.ws)
        const cliC = await openClientWs(tokC, 'macOS · Chrome', 'web')
        sockets.push(cliC.ws)
        await new Promise((r) => setTimeout(r, 120))

        // Device A must have received live `clients.status` push reaching 3 online clients
        const livePush = cliA.events.filter((e) => e.event === 'clients.status')
        assert.ok(livePush.some((e) => e.payload?.onlineCount === 3), 'Device A must receive live 3-client push')

        // GET /api/auth/sessions returns all 3 sessions with clean metadata & isCurrent flag
        const sessList = await fetch(`${sBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${tokA}` },
        }).then((r) => r.json())
        assert.equal(sessList.ok, true)
        assert.equal(sessList.onlineCount, 3)
        assert.equal(sessList.totalCount, 3)
        assert.equal(sessList.sessions.find((s) => s.isCurrent)?.deviceName, 'Windows Desktop')
        const sessB = sessList.sessions.find((s) => s.deviceName === 'Android App')
        assert.ok(sessB?.sid, 'Device B must have a revocable sid')

        // Single-device kick: Device A kicks Device B -> B closes with 4401 & token permanently rejected, A & C remain alive
        const kickB = await fetch(`${sBase}/api/auth/sessions/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
          body: JSON.stringify({ sid: sessB.sid, clientId: sessB.clientId, currentClientId: cliA.hello.clientId }),
        }).then((r) => r.json())
        assert.equal(kickB.ok, true)
        assert.equal(kickB.revokedPermanent, true)
        assert.equal(kickB.onlineCount, 2)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(cliB.getClosedCode(), 4401, 'Kicked Device B must close with 4401')

        const bAfterKick = await fetch(`${sBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${tokB}` },
        })
        assert.equal(bAfterKick.status, 401, 'Revoked Device B token must be permanently rejected')

        // Nuclear kick: Device A revokes all other devices -> C kicked with 4401, old tokA invalidated, freshToken works seamlessly!
        const kickOthers = await fetch(`${sBase}/api/auth/sessions/revoke-others`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}` },
          body: JSON.stringify({ currentClientId: cliA.hello.clientId, deviceName: 'Windows Desktop', clientKind: 'desktop' }),
        }).then((r) => r.json())
        assert.equal(kickOthers.ok, true)
        assert.ok(kickOthers.token && kickOthers.token !== tokA, 'revoke-others must issue a rotated fresh token')
        assert.equal(kickOthers.onlineCount, 1)
        assert.equal(kickOthers.totalCount, 1)
        await new Promise((r) => setTimeout(r, 100))
        assert.equal(cliC.getClosedCode(), 4401, 'Device C must be kicked with 4401')

        const cAfterNuke = await fetch(`${sBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${tokC}` },
        })
        assert.equal(cAfterNuke.status, 401, 'Device C token must be rejected after revoke-others')

        const aFreshCheck = await fetch(`${sBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${kickOthers.token}` },
        }).then((r) => r.json())
        assert.equal(aFreshCheck.ok, true)
        assert.equal(aFreshCheck.onlineCount, 1)
        assert.equal(aFreshCheck.sessions[0]?.isCurrent, true)
      } finally {
        for (const ws of sockets) {
          try { ws.close() } catch {}
        }
        await sessRelay.close()
      }
    }
    console.log('[smoke] 16/17 Active controlling devices monitor, live WS push, per-device kick & revoke-others OK')

    // 17. Lightweight Admin Monitoring Dashboard (/admin, /api/admin/overview, bridge disconnect, session kick & revoke-all)
    {
      const monRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'mon-jwt-secret-0123456789',
        adminBootstrapToken: 'mon-owner-secret',
        accountsFile: join(tmpDir, 'mon-accounts.json'),
        uploadDir: join(tmpDir, 'mon-uploads'),
      })
      const { port: mPort } = await monRelay.start()
      const mBase = `http://127.0.0.1:${mPort}`
      const mSockets = []

      const connectClientWs = (token, deviceName, clientKind) =>
        new Promise((resolveWs, rejectWs) => {
          fetch(`${mBase}/api/auth/ws-ticket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ deviceName, clientKind }),
          })
            .then((r) => r.json())
            .then((d) => {
              const ws = new WebSocket(`ws://127.0.0.1:${mPort}/ws/client?ticket=${encodeURIComponent(d.ticket)}`)
              let closedCode = null
              ws.on('message', (raw) => {
                const msg = JSON.parse(String(raw))
                if (msg.type === 'hello') resolveWs({ ws, hello: msg, getClosedCode: () => closedCode })
              })
              ws.on('close', (code) => { closedCode = code })
              ws.on('error', rejectWs)
            })
            .catch(rejectWs)
        })

      const connectBridgeWs = ({ roomId, deviceSecret, bridgeId, hostname, platform, apps }) =>
        new Promise((resolveBr, rejectBr) => {
          const qs = new URLSearchParams({ roomId, bridgeId, hostname, platform, mode: 'desktop' })
          const ws = new WebSocket(`ws://127.0.0.1:${mPort}/ws/bridge?${qs.toString()}`, {
            headers: { 'X-Room-Id': roomId, 'X-Bridge-Secret': deviceSecret },
          })
          let closedCode = null
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'bridge.meta', meta: { apps, e2ee: { enabled: true, v: 1, keyId: '0123456789abcdef' } } }))
            resolveBr({ ws, getClosedCode: () => closedCode })
          })
          ws.on('close', (code) => { closedCode = code })
          ws.on('error', rejectBr)
        })

      try {
        // 17.1 Static /admin dashboard serving, subpath-safe relative asset links & strict CSP headers
        const adminHtmlRes = await fetch(`${mBase}/admin`)
        assert.equal(adminHtmlRes.status, 200, 'GET /admin must serve dashboard HTML')
        assert.match(String(adminHtmlRes.headers.get('content-type') || ''), /text\/html/)
        assert.match(String(adminHtmlRes.headers.get('cache-control') || ''), /no-store/)
        assert.match(String(adminHtmlRes.headers.get('content-security-policy') || ''), /script-src 'self'/)
        const adminHtml = await adminHtmlRes.text()
        assert.ok(adminHtml.includes('src="admin/app.js"') && adminHtml.includes('href="admin/styles.css"'), 'GET /admin must use subpath-safe relative admin/* asset URLs')
        assert.equal(adminHtml.includes('href="/admin/'), false, 'GET /admin must not hardcode root-absolute /admin/ paths')

        const adminSlashRes = await fetch(`${mBase}/admin/`)
        assert.equal(adminSlashRes.status, 200, 'GET /admin/ must serve dashboard HTML')
        const adminSlashHtml = await adminSlashRes.text()
        assert.ok(adminSlashHtml.includes('src="./app.js"') && adminSlashHtml.includes('href="./styles.css"'), 'GET /admin/ must use subpath-safe ./* asset URLs')

        const adminJsRes = await fetch(`${mBase}/admin/app.js`)
        assert.equal(adminJsRes.status, 200)
        const adminCssRes = await fetch(`${mBase}/admin/styles.css`)
        assert.equal(adminCssRes.status, 200)
        const admin404Res = await fetch(`${mBase}/admin/does-not-exist`)
        assert.equal(admin404Res.status, 404)

        // 17.2 Unauthenticated /api/admin/overview must return 401
        const unauthMon = await fetch(`${mBase}/api/admin/overview`)
        assert.equal(unauthMon.status, 401, 'Unauthenticated /api/admin/overview must return 401')

        // 17.3 Bootstrap admin + 2 regular users (bob active, carol offline)
        const admReg = await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'mon_admin',
            password: 'Password123!',
            inviteCode: 'mon-owner-secret',
            deviceName: 'Windows Desktop',
            clientKind: 'desktop',
          }),
        }).then((r) => r.json())
        assert.equal(admReg.ok, true)

        const invRes = await fetch(`${mBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ count: 2, note: 'monitor test' }),
        }).then((r) => r.json())
        assert.equal(invRes.invites.length, 2)

        const bobReg = await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'mon_bob',
            password: 'Password123!',
            inviteCode: invRes.invites[0].code,
            deviceName: 'iPhone · Safari',
            clientKind: 'mobile',
          }),
        }).then((r) => r.json())
        assert.equal(bobReg.ok, true)

        const carolReg = await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'mon_carol',
            password: 'Password123!',
            inviteCode: invRes.invites[1].code,
            deviceName: 'macOS · Chrome',
            clientKind: 'web',
          }),
        }).then((r) => r.json())
        assert.equal(carolReg.ok, true)

        // Non-admin Bob must get 403 on /api/admin/overview and admin action routes
        const bobOverview = await fetch(`${mBase}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${bobReg.token}` },
        })
        assert.equal(bobOverview.status, 403, 'Non-admin user must receive 403 on /api/admin/overview')

        // Bind a PC for Bob and bring both Bob's PC bridge and Bob's phone WS online; bring Admin's bridge only online
        const bobPc = await fetch(`${mBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobReg.token}` },
          body: JSON.stringify({ label: 'Bob-MacBook', hostname: 'bob-mbp', platform: 'darwin' }),
        }).then((r) => r.json())
        assert.equal(bobPc.ok, true)

        const admPc = await fetch(`${mBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ label: 'Admin-WinPC', hostname: 'admin-pc', platform: 'win32' }),
        }).then((r) => r.json())
        assert.equal(admPc.ok, true)

        const bobBr = await connectBridgeWs({
          roomId: bobReg.roomId,
          deviceSecret: bobPc.deviceSecret,
          bridgeId: bobPc.bridgeId,
          hostname: 'bob-mbp',
          platform: 'darwin',
          apps: [
            { app: 'codex', available: true, writable: true },
            { app: 'claude', available: true, writable: true },
          ],
        })
        mSockets.push(bobBr.ws)

        const admBr = await connectBridgeWs({
          roomId: admReg.roomId,
          deviceSecret: admPc.deviceSecret,
          bridgeId: admPc.bridgeId,
          hostname: 'admin-pc',
          platform: 'win32',
          apps: [{ app: 'antigravity', available: true, writable: true }],
        })
        mSockets.push(admBr.ws)

        const bobCli = await connectClientWs(bobReg.token, 'iPhone · Safari', 'mobile')
        mSockets.push(bobCli.ws)
        await new Promise((r) => setTimeout(r, 100))

        // 17.4 Fetch /api/admin/overview as admin and validate counts, statuses, telemetry & zero secret leakage
        const ovRes = await fetch(`${mBase}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${admReg.token}` },
        })
        assert.equal(ovRes.status, 200)
        const ovRaw = await ovRes.text()
        assert.equal(ovRaw.includes('passwordHash'), false, 'Overview must NEVER expose passwordHash')
        assert.equal(ovRaw.includes('secretHash'), false, 'Overview must NEVER expose device secretHash')
        assert.equal(ovRaw.includes(bobPc.deviceSecret), false, 'Overview must NEVER expose deviceSecret')
        const ov = JSON.parse(ovRaw)
        assert.equal(ov.ok, true)
        assert.equal(ov.legacyRooms, undefined, 'Overview must NOT include removed legacyRooms field')
        assert.equal(ov.summary.totalUsers, 3)
        assert.equal(ov.summary.activeUsers, 1, 'Bob should be active (PC + client online)')
        assert.equal(ov.summary.bridgeOnlyUsers, 1, 'Admin should be bridge_only (PC online, no client WS)')
        assert.equal(ov.summary.offlineUsers, 1, 'Carol should be offline')
        assert.equal(ov.summary.onlineBridges, 2)
        assert.equal(ov.summary.onlineClients, 1)
        assert.equal(ov.distributions.apps.codex.writable, 1)
        assert.equal(ov.distributions.apps.antigravity.writable, 1)
        assert.equal(ov.distributions.bridgePlatforms.darwin, 1, 'darwin platform must not be misclassified as win32')
        assert.equal(ov.distributions.bridgePlatforms.win32, 1)
        assert.ok(ov.server.node.rssBytes > 0 && ov.server.host.totalMemBytes > 0)
        assert.ok(ov.activity.length >= 4, 'Activity ring buffer should capture register/bridge/client events')

        const bobRow = ov.users.find((u) => u.username === 'mon_bob')
        assert.equal(bobRow.status, 'active')
        assert.equal(bobRow.devices[0].online, true)
        assert.equal(bobRow.sessions[0].online, true)

        // 17.5 Admin disconnects Bob's bridge & kicks Bob's session & prevents self-lockout
        const selfRevokeTry = await fetch(`${mBase}/api/admin/users/revoke-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ userId: admReg.roomId }),
        })
        assert.equal(selfRevokeTry.status, 400, 'Admin must not be able to force-revoke themselves from monitor')

        const discRes = await fetch(`${mBase}/api/admin/bridges/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ roomId: bobReg.roomId, bridgeId: bobPc.bridgeId }),
        }).then((r) => r.json())
        assert.equal(discRes.ok, true)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(bobBr.getClosedCode(), 4000, 'Admin bridge disconnect should close WS with 4000')

        const kickBobRes = await fetch(`${mBase}/api/admin/users/revoke-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ userId: bobReg.roomId }),
        }).then((r) => r.json())
        assert.equal(kickBobRes.ok, true)
        assert.equal(kickBobRes.disconnectedClients, 1)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(bobCli.getClosedCode(), 4401, 'Force sign-out must close Bob client WS with 4401')

        const bobAfterRevoke = await fetch(`${mBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${bobReg.token}` },
        })
        assert.equal(bobAfterRevoke.status, 401, 'Bob token must be rejected after admin force sign-out')
      } finally {
        for (const ws of mSockets) {
          try { ws.close() } catch {}
        }
        await monRelay.close()
      }
    }
    console.log('[smoke] 17/18 Admin monitoring dashboard (/admin, /api/admin/overview, disconnect & kick) OK')

    // 18. Security Hardening v0.4.0:
    //     - Strict HTML CSP header
    //     - Permanently removed legacy owner/room endpoints (404) & owner WS bridge (401)
    //     - New-IP login alert emails & optional Account Email Login 2FA
    //     - Per-account distributed multi-IP brute-force lockout & /ws/bridge auth rate limit
    //     - Electron safeStorage encrypted bridgeSecret & legacy plaintext auto-migration
    //     - DesktopUpdater mandatory SHA-256 & pre-install TOCTOU tamper detection
    {
      // 18.1 Electron safeStorage config encryption + legacy plaintext auto-migration
      const encDir = join(tmpDir, 'bridge-sec')
      mkdirSync(encDir, { recursive: true })
      const cfgFile = join(encDir, 'config.json')
      const mockSecretStore = {
        encrypt: (plain) => `enc_v1:${Buffer.from(plain, 'utf8').toString('base64')}`,
        decrypt: (enc) => {
          if (!String(enc || '').startsWith('enc_v1:')) throw new Error('bad cipher')
          return Buffer.from(enc.slice(7), 'base64').toString('utf8')
        },
      }
      saveConfigSecure(cfgFile, { mode: 'account', roomId: 'usr_sec', bridgeSecret: 'dv_top_secret_99' }, mockSecretStore)
      const rawEncJson = JSON.parse(readFileSync(cfgFile, 'utf8'))
      assert.equal(rawEncJson.bridgeSecret, undefined, 'Plaintext bridgeSecret must not be saved when secretStore is active')
      assert.ok(String(rawEncJson.bridgeSecretEnc || '').startsWith('enc_v1:'))
      const decCfg = loadConfigDecrypted(cfgFile, mockSecretStore)
      assert.equal(decCfg.bridgeSecret, 'dv_top_secret_99')

      // Legacy plaintext config auto-migrates to encrypted storage on load
      const legacyFile = join(encDir, 'legacy.json')
      writeFileSync(legacyFile, JSON.stringify({ mode: 'account', roomId: 'usr_old', bridgeSecret: 'dv_legacy_plain' }), 'utf8')
      const migratedCfg = loadConfigDecrypted(legacyFile, mockSecretStore)
      assert.equal(migratedCfg.bridgeSecret, 'dv_legacy_plain')
      const afterMigrateDisk = JSON.parse(readFileSync(legacyFile, 'utf8'))
      assert.equal(afterMigrateDisk.bridgeSecret, undefined, 'Legacy plaintext config must auto-migrate to encrypted storage')
      assert.ok(String(afterMigrateDisk.bridgeSecretEnc || '').startsWith('enc_v1:'))

      // 18.2 DesktopUpdater mandatory SHA-256 + pre-install TOCTOU tamper detection
      const secPayload = Buffer.alloc(32 * 1024, 0x42)
      const secSha = createHash('sha256').update(secPayload).digest('hex')
      const secUpdServer = http.createServer((req, res) => {
        const base = `http://127.0.0.1:${secUpdServer.address().port}`
        if (req.url === '/no-digest') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v0.4.1',
            assets: [{ name: 'All.in.One.Setup.0.4.1.exe', size: secPayload.length, browser_download_url: `${base}/bin` }],
          }))
          return
        }
        if (req.url === '/with-digest') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v0.4.1',
            assets: [{ name: 'All.in.One.Setup.0.4.1.exe', size: secPayload.length, digest: `sha256:${secSha}`, browser_download_url: `${base}/bin` }],
          }))
          return
        }
        if (req.url === '/bin') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(secPayload.length) })
          res.end(secPayload)
          return
        }
        res.writeHead(404)
        res.end('not found')
      })
      await new Promise((r) => secUpdServer.listen(0, '127.0.0.1', r))
      const secUpdPort = secUpdServer.address().port
      const secUpdDir = join(tmpDir, 'sec-updater-dir')
      try {
        // Missing SHA-256 digest must be blocked by default (requireSha256=true)
        const noDigestUpd = new DesktopUpdater({
          currentVersion: '0.4.0',
          platform: 'win32',
          arch: 'x64',
          downloadDir: secUpdDir,
          apiUrl: `http://127.0.0.1:${secUpdPort}/no-digest`,
          allowLocalhost: true,
        })
        await noDigestUpd.checkForUpdates()
        const noDigestDl = await noDigestUpd.downloadUpdate()
        assert.equal(noDigestDl.status, 'error', 'Missing SHA-256 digest must fail download by default')
        assert.match(noDigestDl.error, /SHA-256/)

        // Pre-install TOCTOU tampering must fail installAndRestart() and delete tampered file
        const toctouUpd = new DesktopUpdater({
          currentVersion: '0.4.0',
          platform: 'win32',
          arch: 'x64',
          downloadDir: secUpdDir,
          apiUrl: `http://127.0.0.1:${secUpdPort}/with-digest`,
          allowLocalhost: true,
        })
        await toctouUpd.checkForUpdates()
        const okDl = await toctouUpd.downloadUpdate()
        assert.equal(okDl.status, 'downloaded')
        assert.ok(existsSync(okDl.downloadedPath))
        // Tamper 1 byte on disk after download completes
        const tampered = Buffer.from(secPayload)
        tampered[0] ^= 0xff
        writeFileSync(okDl.downloadedPath, tampered)
        const instRes = await toctouUpd.installAndRestart({
          exePath: 'C:\\fake\\All in One.exe',
          isPackaged: true,
          onQuit: () => {},
        })
        assert.equal(instRes.status, 'error', 'Tampered installer must be rejected before launch')
        assert.match(instRes.error, /SHA-256/)
        assert.equal(instRes.downloadedPath, '')
        assert.equal(existsSync(okDl.downloadedPath), false, 'Tampered installer file must be deleted from disk')
      } finally {
        try { secUpdServer.closeAllConnections?.() } catch {}
        await new Promise((r) => secUpdServer.close(r))
      }

      // 18.3 Hardened Relay: CSP, Legacy Kill-Switches, New-IP Alert Email, Email 2FA, Distributed Lockout & WS Rate-Limit
      const secInbox = []
      const secSmtp = net.createServer((sock) => {
        let buf = ''
        let state = 'cmd'
        let cur = { rcptTo: '', rawData: '' }
        sock.write('220 sec-smtp.local ESMTP Ready\r\n')
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8')
          while (true) {
            if (state === 'data') {
              const endIdx = buf.indexOf('\r\n.\r\n')
              if (endIdx === -1) break
              cur.rawData = buf.slice(0, endIdx)
              buf = buf.slice(endIdx + 5)
              const b64Match = cur.rawData.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)
              const decodedText = b64Match ? Buffer.from(b64Match[1].replace(/\r?\n/g, ''), 'base64').toString('utf8') : cur.rawData
              const codeMatch = decodedText.match(/\b(\d{6})\b/)
              secInbox.push({ ...cur, decodedText, code: codeMatch ? codeMatch[1] : '' })
              cur = { rcptTo: '', rawData: '' }
              state = 'cmd'
              sock.write('250 OK\r\n')
              continue
            }
            const nl = buf.indexOf('\n')
            if (nl === -1) break
            const line = buf.slice(0, nl).replace(/\r$/, '')
            buf = buf.slice(nl + 1)
            if (state === 'auth_user') { state = 'auth_pass'; sock.write('334 UGFzc3dvcmQ6\r\n') }
            else if (state === 'auth_pass') { state = 'cmd'; sock.write('235 OK\r\n') }
            else if (/^EHLO /i.test(line)) sock.write('250-sec-smtp.local\r\n250-AUTH LOGIN\r\n250 OK\r\n')
            else if (/^AUTH LOGIN$/i.test(line)) { state = 'auth_user'; sock.write('334 VXNlcm5hbWU6\r\n') }
            else if (/^RCPT TO:/i.test(line)) { cur.rcptTo = line.slice(8).trim(); sock.write('250 OK\r\n') }
            else if (/^DATA$/i.test(line)) { state = 'data'; sock.write('354 Go\r\n') }
            else if (/^QUIT$/i.test(line)) { sock.write('221 Bye\r\n'); sock.end() }
            else sock.write('250 OK\r\n')
          }
        })
      })
      await new Promise((r) => secSmtp.listen(0, '127.0.0.1', r))
      const secSmtpPort = secSmtp.address().port

      const secStaticDir = join(tmpDir, 'sec-static')
      mkdirSync(secStaticDir, { recursive: true })
      writeFileSync(join(secStaticDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8')

      const secRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'sec-jwt-secret-0123456789',
        adminBootstrapToken: 'sec-bootstrap-pass-123',
        staticDir: secStaticDir,
        uploadDir: join(tmpDir, 'sec-uploads'),
        accountsFile: join(tmpDir, 'sec-accounts.json'),
        smtpHost: '127.0.0.1',
        smtpPort: secSmtpPort,
        smtpSecure: false,
        smtpStarttls: false,
        smtpUser: 'sec@example.com',
        smtpPass: 'sec-pass',
        smtpFrom: 'All in One <sec@example.com>',
        emailCodeOptions: { cooldownMs: 500 },
      })
      try {
        const { port: secPort } = await secRelay.start()
        const sBase = `http://127.0.0.1:${secPort}`

        // 18.3a Strict HTML CSP header
        const htmlRes = await fetch(`${sBase}/`)
        assert.equal(htmlRes.status, 200)
        const csp = htmlRes.headers.get('content-security-policy') || ''
        assert.ok(csp.includes("script-src 'self'"), `Expected strict script-src CSP, got: ${csp}`)
        assert.ok(csp.includes("frame-ancestors 'none'"), `Expected frame-ancestors none CSP, got: ${csp}`)
        assert.equal(csp.includes('unsafe-eval'), false)

        // 18.3b Removed legacy routes return 404 and owner WS bridge is permanently rejected with 401
        const legOwnerRes = await fetch(`${sBase}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'sec-bootstrap-pass-123' }),
        })
        assert.equal(legOwnerRes.status, 404, 'Removed /api/auth/login must return 404')

        const legRoomRes = await fetch(`${sBase}/api/rooms/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'legacy-pc' }),
        })
        assert.equal(legRoomRes.status, 404, 'Removed /api/rooms/register must return 404')

        const ownerBridgeStatus = await new Promise((resolveStatus) => {
          const ws = new WebSocket(`ws://127.0.0.1:${secPort}/ws/bridge?room=owner&secret=sec-owner-bridge-123&id=legacy-pc`)
          ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
          ws.on('open', () => { ws.close(); resolveStatus(101) })
          ws.on('error', () => {})
        })
        assert.equal(ownerBridgeStatus, 401, 'Owner bridge WS must always be rejected with 401')

        // 18.3c Register admin with bound email -> login from NEW IP triggers security alert email
        const codeRes = await (await fetch(`${sBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'register', email: 'secadmin@example.com', inviteCode: 'sec-bootstrap-pass-123' }),
        })).json()
        assert.equal(codeRes.ok, true)
        assert.equal(secInbox.length, 1)

        const secAdm = await (await fetch(`${sBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({
            username: 'secadmin',
            password: 'SecAdminPassword1!',
            inviteCode: 'sec-bootstrap-pass-123',
            email: 'secadmin@example.com',
            emailCode: secInbox[0].code,
            deviceName: 'MacBook-Pro',
          }),
        })).json()
        assert.equal(secAdm.ok, true)

        // Login from a brand-new IP -> triggers new-device/new-IP security alert email!
        const newIpLogin = await (await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
          body: JSON.stringify({ username: 'secadmin', password: 'SecAdminPassword1!', deviceName: 'Unknown-Browser' }),
        })).json()
        assert.equal(newIpLogin.ok, true)
        // Wait briefly for fire-and-forget alert SMTP delivery
        await new Promise((r) => setTimeout(r, 150))
        assert.equal(secInbox.length, 2, 'New-IP login must send a security alert email')
        assert.ok(secInbox[1].decodedText.includes('203.0.113.77'), 'Alert email must include the new login IP')
        assert.ok(secInbox[1].decodedText.includes('Unknown-Browser'), 'Alert email must include the device name')

        // 18.3d Enable optional Email Login 2FA -> login requires 6-digit OTP
        const enable2fa = await (await fetch(`${sBase}/api/account/security/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secAdm.token}` },
          body: JSON.stringify({ enabled: true }),
        })).json()
        assert.equal(enable2fa.ok, true)
        assert.equal(enable2fa.user.loginEmail2fa, true)

        const me2fa = await (await fetch(`${sBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${secAdm.token}` },
        })).json()
        assert.equal(me2fa.loginEmail2fa, true)

        // Step 1 of 2FA login (no emailCode) -> 200 { ok: false, requires2fa: true } + dispatches 6-digit OTP email
        const step1Res = await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
          body: JSON.stringify({ username: 'secadmin', password: 'SecAdminPassword1!' }),
        })
        assert.equal(step1Res.status, 200)
        const step1Data = await step1Res.json()
        assert.equal(step1Data.ok, false)
        assert.equal(step1Data.requires2fa, true)
        assert.ok(step1Data.maskedEmail.includes('@example.com'))
        assert.equal(secInbox.length, 3, '2FA challenge must send a 6-digit OTP email')
        const otp2fa = secInbox[2].code
        assert.match(otp2fa, /^\d{6}$/)

        // Wrong 2FA code -> 401
        const bad2fa = await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
          body: JSON.stringify({ username: 'secadmin', password: 'SecAdminPassword1!', emailCode: '000000' }),
        })
        assert.equal(bad2fa.status, 401)

        // Correct 2FA code -> 200 ok + token
        const ok2fa = await (await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
          body: JSON.stringify({ username: 'secadmin', password: 'SecAdminPassword1!', emailCode: otp2fa }),
        })).json()
        assert.equal(ok2fa.ok, true)
        assert.ok(ok2fa.token)

        // 18.3e Distributed multi-IP per-account brute-force lockout (10 bad attempts across 10 different IPs -> 11th blocked with 429!)
        for (let i = 1; i <= 10; i += 1) {
          const r = await fetch(`${sBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${10 + i}` },
            body: JSON.stringify({ username: 'secadmin', password: `WrongPass-${i}!` }),
          })
          assert.equal(r.status, 401, `Attempt ${i} should return 401`)
        }
        const lockedRes = await fetch(`${sBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.250' },
          body: JSON.stringify({ username: 'secadmin', password: 'SecAdminPassword1!' }),
        })
        assert.equal(lockedRes.status, 429, 'Per-account distributed brute-force lockout must return 429 even from a fresh IP')

        // 18.3f /ws/bridge auth failure rate-limiting (isolated per (ip, roomId) so one bogus room never blocks valid usr_* on same NAT IP)
        let bridge429 = false
        for (let i = 0; i < 16; i += 1) {
          const status = await new Promise((resolveStatus) => {
            const ws = new WebSocket(`ws://127.0.0.1:${secPort}/ws/bridge?roomId=usr_bogus00000000&bridgeId=stale-pc`, {
              headers: {
                'X-Real-IP': '198.51.100.222',
                'X-Room-Id': 'usr_bogus00000000',
                'X-Bridge-Secret': 'wrong',
              },
            })
            ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
            ws.on('open', () => { ws.close(); resolveStatus(101) })
            ws.on('error', () => {})
          })
          if (status === 429) {
            bridge429 = true
            break
          }
        }
        assert.equal(bridge429, true, 'Repeated /ws/bridge auth failures for one room must hit 429 rate limit')

        // A valid account bridge on the EXACT SAME IP must NOT be locked out by the bogus room!
        const validDev = await (await fetch(`${sBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secAdm.token}` },
          body: JSON.stringify({ label: 'Nat-Safe-PC', hostname: 'Nat-Safe-PC', platform: 'win32' }),
        })).json()
        assert.equal(validDev.ok, true)
        const sameIpValidStatus = await new Promise((resolveStatus) => {
          const ws = new WebSocket(`ws://127.0.0.1:${secPort}/ws/bridge?roomId=${validDev.roomId}&bridgeId=${validDev.bridgeId}`, {
            headers: {
              'X-Real-IP': '198.51.100.222',
              'X-Room-Id': validDev.roomId,
              'X-Bridge-Secret': validDev.deviceSecret,
            },
          })
          ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
          ws.on('open', () => { ws.close(); resolveStatus(101) })
          ws.on('error', () => {})
        })
        assert.equal(sameIpValidStatus, 101, 'Bogus room 429 must NEVER block a valid usr_* bridge on the same IP')
      } finally {
        await secRelay.close()
        await new Promise((r) => secSmtp.close(r))
      }
    }
    console.log('[smoke] 18/19 Security hardening (CSP, legacy kill-switches, new-IP alert, email 2FA, distributed lockout, safeStorage & TOCTOU SHA-256) OK')

    // 19. DeepSeek Harness authenticated localhost IPC bridge + zero-dep auto-installer
    {
      const ipcDshHome = join(tmpDir, 'dsh-ipc-home')
      mkdirSync(join(ipcDshHome, 'storages'), { recursive: true })

      // Mock live DSH Cordis ctx with a single synthetic agent supporting followup + ownEvents + abort
      const mockSessions = new Map()
      let seqCounter = 1
      const createMockAgent = (sid, cwd) => {
        const events = []
        let aborted = false
        let idleResolve = null
        let idlePromise = Promise.resolve()
        const session = {
          id: sid,
          meta: { cwd },
          get seq() { return seqCounter },
          ownEvents: () => events,
        }
        const agent = {
          id: sid,
          session,
          followup: (userMsg) => {
            const promptText = userMsg?.content?.[0]?.text || ''
            events.push({ seq: ++seqCounter, type: 'user/message', data: { message: userMsg }, timestamp: Date.now() })
            // Inject synthetic DSH runtime/system user/message events (must be filtered out of chat history!)
            events.push({
              seq: ++seqCounter,
              type: 'user/message',
              data: {
                id: `sys-rt-${seqCounter}`,
                role: 'user',
                source: { kind: 'runtime-context', form: 'snapshot' },
                content: [{ type: 'text', text: '<system-reminder>Runtime context info</system-reminder>' }],
              },
              timestamp: Date.now(),
            })
            events.push({
              seq: ++seqCounter,
              type: 'user/message',
              data: {
                id: `sys-sk-${seqCounter}`,
                role: 'user',
                source: { kind: 'skill-catalog', form: 'catalog' },
                content: [{ type: 'text', text: '<system-reminder><available_skills>secret</available_skills></system-reminder>' }],
              },
              timestamp: Date.now(),
            })
            events.push({
              seq: ++seqCounter,
              type: 'user/message',
              data: {
                id: `sys-tm-${seqCounter}`,
                role: 'user',
                source: { kind: 'time-context', form: 'snapshot' },
                content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-23T18:09:37+08:00' }],
              },
              timestamp: Date.now(),
            })
            idlePromise = new Promise((r) => {
              idleResolve = r
              setTimeout(() => {
                events.push({
                  seq: ++seqCounter,
                  type: 'assistant/message',
                  data: {
                    message: {
                      id: `a-msg-${seqCounter}`,
                      content: [
                        { type: 'thinking', thinking: 'Checking IPC path...' },
                        { type: 'text', text: `DSH IPC Reply to: ${promptText}` },
                      ],
                    },
                  },
                  timestamp: Date.now(),
                })
                r()
              }, 80)
            })
          },
          whenIdle: () => idlePromise,
          abort: async () => { aborted = true; idleResolve?.() },
          isAborted: () => aborted,
        }
        mockSessions.set(sid, { agent, session, title: sid })
        return agent
      }

      const mockDshCtx = {
        agents: {
          get: (sid) => mockSessions.get(sid)?.agent,
          create: async ({ sessionId, meta }) => {
            const agent = createMockAgent(sessionId, meta?.cwd || process.cwd())
            return { agent, dispose: async () => {} }
          },
        },
        get: (name) => {
          if (name === 'sessions') {
            return {
              get: (sid) => mockSessions.get(sid)?.session,
              values: () => [...mockSessions.values()].map((x) => x.session),
            }
          }
          if (name === 'sessionTitle') {
            return {
              get: (sess) => ({ title: mockSessions.get(sess?.id)?.title || sess?.id }),
              rename: (sess, t) => {
                const row = mockSessions.get(sess?.id)
                if (row) row.title = t
              },
            }
          }
          return undefined
        },
      }

      let ipcSrv = null
      const liveDsh = new DshAdapter({
        ctx: mockDshCtx,
        config: { dshHome: ipcDshHome, cwd: process.cwd() },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        emitEvent: (ev, payload) => ipcSrv?.emitEvent(ev, payload),
      })

      const receivedEvents = []
      const standaloneDsh = new DshAdapter({
        ctx: null,
        config: { dshHome: ipcDshHome, cwd: process.cwd() },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        emitEvent: (ev, payload) => receivedEvents.push({ ev, payload }),
      })

      try {
        // Before IPC starts, standalone DSH adapter is read-only
        const stBefore = await standaloneDsh.getStatus()
        assert.equal(stBefore.available, true)
        assert.equal(stBefore.writable, false)
        assert.equal(stBefore.mode, 'standalone-readonly')

        // Start authenticated loopback IPC server inside mock DSH
        ipcSrv = await startDshLocalIpcServer({
          dshAdapter: liveDsh,
          dshHome: ipcDshHome,
          log: { info: () => {}, warn: () => {}, error: () => {} },
        })
        assert.ok(ipcSrv.port > 0 && ipcSrv.token.length === 64)
        assert.ok(existsSync(ipcSrv.ipcFile))

        // Security checks: missing/wrong token -> 401; browser Origin header -> 403
        const noAuthRes = await fetch(`http://127.0.0.1:${ipcSrv.port}/health`)
        assert.equal(noAuthRes.status, 401, 'DSH local IPC must reject missing Bearer token with 401')
        const crossOriginRes = await fetch(`http://127.0.0.1:${ipcSrv.port}/health`, {
          headers: { Authorization: `Bearer ${ipcSrv.token}`, Origin: 'https://evil.example' },
        })
        assert.equal(crossOriginRes.status, 403, 'DSH local IPC must reject browser Origin header with 403')

        // Standalone DSH adapter automatically discovers IPC & flips to RW!
        const stLive = await standaloneDsh.getStatus()
        assert.equal(stLive.available, true)
        assert.equal(stLive.writable, true)
        assert.equal(stLive.mode, 'dsh-local-ipc')

        // Create session + send message + verify real-time SSE events arrive on standalone adapter!
        const created = await standaloneDsh.createSession({ cwd: process.cwd(), title: 'IPC Test Chat' })
        assert.equal(created.app, 'dsh')
        assert.equal(created.writable, true)
        assert.equal(created.title, 'IPC Test Chat')

        const reply = await standaloneDsh.sendMessage(created.nativeId, { text: 'Hello DSH over IPC!' })
        assert.ok(reply.finalText.includes('DSH IPC Reply to: Hello DSH over IPC!'))
        // Wait briefly for final SSE frame flush
        await new Promise((r) => setTimeout(r, 80))
        const evTypes = receivedEvents.map((e) => e.ev)
        assert.ok(evTypes.includes(EVENTS.STREAM_START), `Expected STREAM_START over SSE, got ${evTypes.join(',')}`)
        assert.ok(evTypes.includes(EVENTS.STREAM_THINKING), 'Expected STREAM_THINKING over SSE')
        assert.ok(evTypes.includes(EVENTS.STREAM_DELTA), 'Expected STREAM_DELTA over SSE')
        assert.ok(evTypes.includes(EVENTS.STREAM_DONE), 'Expected STREAM_DONE over SSE')

        const readBack = await standaloneDsh.readSession(created.nativeId)
        assert.equal(readBack.writable, true)
        const userMsgs = readBack.messages.filter((m) => m.role === 'user')
        assert.equal(userMsgs.length, 1, 'Synthetic DSH runtime-context/skill-catalog/time-context events must be filtered out')
        assert.equal(userMsgs[0].text, 'Hello DSH over IPC!')
        assert.ok(readBack.messages.some((m) => m.role === 'assistant' && m.text.includes('Hello DSH over IPC!')))

        // Closing IPC server cleanly removes descriptor & flips standalone back to read-only
        await ipcSrv.close()
        ipcSrv = null
        assert.equal(existsSync(join(ipcDshHome, 'allinone-dsh-ipc.json')), false)
        const stAfter = await standaloneDsh.getStatus()
        assert.equal(stAfter.writable, false)
        assert.equal(stAfter.mode, 'standalone-readonly')
      } finally {
        await standaloneDsh.dispose()
        if (ipcSrv) await ipcSrv.close()
        await liveDsh.dispose()
      }

      // Auto-installer idempotency & opt-out tests
      const noDshRes = ensureDshLocalIpcPlugin({ dshHome: join(tmpDir, 'nonexistent-dsh'), env: {}, log: { info: () => {}, warn: () => {} } })
      assert.equal(noDshRes.status, 'no-dsh-profile')

      const fakeDshHome = join(tmpDir, 'fake-dsh-install')
      const fakeProfileDir = join(fakeDshHome, 'profiles', 'desktop')
      mkdirSync(fakeProfileDir, { recursive: true })
      writeFileSync(
        join(fakeProfileDir, 'package.json'),
        JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2),
        'utf8',
      )
      const optOutRes = ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: { ALLINONE_NO_AUTOFIX: '1' }, log: { info: () => {}, warn: () => {} } })
      assert.equal(optOutRes.status, 'skipped-opt-out')

      const inst1 = ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } })
      assert.equal(inst1.status, 'installed')
      assert.ok(existsSync(join(fakeProfileDir, 'package.json.bak-before-allinone')))
      assert.ok(existsSync(join(fakeProfileDir, 'node_modules', 'allinone-dsh-ipc', 'index.js')))
      assert.ok(existsSync(join(fakeProfileDir, 'node_modules', 'allinone-dsh-ipc', 'cordis.patch.yml')))
      const updatedPkg = JSON.parse(readFileSync(join(fakeProfileDir, 'package.json'), 'utf8'))
      assert.ok(updatedPkg.dsh.profile.bundles.includes('allinone-dsh-ipc'))

      const inst2 = ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } })
      assert.equal(inst2.status, 'up-to-date')

      // Existing dsh-mobile-hub profile must be left untouched
      const hubDshHome = join(tmpDir, 'hub-dsh-home')
      const hubProfileDir = join(hubDshHome, 'profiles', 'desktop')
      mkdirSync(hubProfileDir, { recursive: true })
      writeFileSync(
        join(hubProfileDir, 'package.json'),
        JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-mobile-hub'] } } }, null, 2),
        'utf8',
      )
      const hubRes = ensureDshLocalIpcPlugin({ dshHome: hubDshHome, env: {}, log: { info: () => {}, warn: () => {} } })
      assert.equal(hubRes.status, 'already-using-dsh-mobile-hub')

      // Codex autonomous multi-milestone turn separation & tail-seek JSONL fallback (giant/corrupt rollout guard)
      const autoMsgs = normalizeCodexTurns([
        {
          id: 'auto-turn-1',
          startedAt: Date.now(),
          items: [
            { id: 'cmd1', type: 'commandExecution', command: 'echo step1', status: 'completed', aggregatedOutput: 'step1' },
            { id: 'am1', type: 'agentMessage', text: 'Milestone 1 reached.' },
            { id: 'cmd2', type: 'commandExecution', command: 'echo step2', status: 'completed', aggregatedOutput: 'step2' },
            { id: 'am2', type: 'agentMessage', text: 'Milestone 2 reached.' },
          ],
        },
      ])
      assert.equal(autoMsgs.length, 2, 'Autonomous multi-step Codex turns must keep each agentMessage milestone separate')
      assert.equal(autoMsgs[0].text, 'Milestone 1 reached.')
      assert.equal(autoMsgs[1].text, 'Milestone 2 reached.')
      assert.notEqual(autoMsgs[0].branchEpoch, autoMsgs[1].branchEpoch)

      const fakeRollout = join(tmpDir, 'rollout-giant.jsonl')
      writeFileSync(
        fakeRollout,
        [
          '{corrupt-old-line',
          JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'Start goal' }] } }),
          JSON.stringify({ timestamp: '2026-11-23T10:01:00Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: 'ls' } }),
          JSON.stringify({ timestamp: '2026-11-23T10:02:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'Round 460 done' }] } }),
        ].join('\n'),
        'utf8',
      )
      const tailMsgs = readCodexRolloutTail(`\\\\?\\${fakeRollout}`, { limit: 10 })
      assert.equal(tailMsgs.length, 2)
      assert.equal(tailMsgs[0].text, 'Start goal')
      assert.equal(tailMsgs[1].text, 'Round 460 done')
      assert.equal(tailMsgs[1].toolCount, 1)
    }
    console.log('[smoke] 19/20 DeepSeek Harness IPC, auto-installer & Codex autonomous/giant rollout resilience OK')

    // 20. Zero-Knowledge End-to-End Encryption (AES-256-GCM, Random Key + QR Sync, Replay Defense, Blind Relay & Encrypted Uploads)
    {
      // 20a. Key generation, fingerprint, QR URI round-trip & AAD/tamper integrity
      const e2eeKey = generateE2eeKey()
      const e2eeKeyId = await computeE2eeKeyId(e2eeKey)
      assert.match(e2eeKeyId, /^[0-9a-f]{16}$/)
      assert.match(formatE2eeFingerprint(e2eeKeyId), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

      const qrUri = encodeE2eeQrUri({ key: e2eeKey, roomId: smokeAdmin.roomId })
      assert.ok(qrUri.startsWith('allinone-e2ee://v1?'))
      const parsedUri = parseE2eeQrInput(qrUri)
      assert.equal(parsedUri.key, e2eeKey)
      assert.equal(parsedUri.roomId, smokeAdmin.roomId)
      const parsedRaw = parseE2eeQrInput(e2eeKey)
      assert.equal(parsedRaw.key, e2eeKey)
      const sharedQrSvg = renderSharedQrSvg(qrUri)
      assert.ok(sharedQrSvg.includes('<svg xmlns="http://www.w3.org/2000/svg"'))

      const sampleEnv = await encryptJson(e2eeKey, { secret: 'hello-e2ee' }, { kind: 'rpc.req', roomId: smokeAdmin.roomId })
      const decOk = await decryptJson(e2eeKey, sampleEnv, { kind: 'rpc.req', roomId: smokeAdmin.roomId })
      assert.equal(decOk.secret, 'hello-e2ee')
      // Wrong AAD kind or roomId must fail GCM authentication
      await assert.rejects(
        () => decryptJson(e2eeKey, sampleEnv, { kind: 'rpc.res', roomId: smokeAdmin.roomId }),
        /解密失败/,
      )
      await assert.rejects(
        () => decryptJson(e2eeKey, sampleEnv, { kind: 'rpc.req', roomId: 'usr_other_room' }),
        /解密失败/,
      )
      // 1-char tamper in ciphertext must fail GCM authentication
      const tamperedCt = (sampleEnv.ct[0] === 'A' ? 'B' : 'A') + sampleEnv.ct.slice(1)
      await assert.rejects(
        () => decryptJson(e2eeKey, { ...sampleEnv, ct: tamperedCt }, { kind: 'rpc.req', roomId: smokeAdmin.roomId }),
        /解密失败/,
      )

      // 20b. Desktop safeStorage config encryption for e2eeKey
      const mockSafeStore = {
        encrypt: (plain) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
        decrypt: (b64) => {
          const s = Buffer.from(b64, 'base64').toString('utf8')
          return s.startsWith('ENC:') ? s.slice(4) : ''
        },
      }
      const secCfgPath = join(tmpDir, 'desktop-e2ee-config.json')
      saveConfigSecure(
        secCfgPath,
        { mode: 'account', roomId: smokeAdmin.roomId, bridgeSecret: 'dv_secret_123', e2eeKey },
        mockSafeStore,
      )
      const rawDiskCfg = readFileSync(secCfgPath, 'utf8')
      assert.equal(rawDiskCfg.includes(e2eeKey), false, 'Desktop config.json must NOT store plaintext e2eeKey when safeStorage is active')
      assert.equal(rawDiskCfg.includes('dv_secret_123'), false)
      const loadedCfg = loadConfigDecrypted(secCfgPath, mockSafeStore)
      assert.equal(loadedCfg.e2eeKey, e2eeKey)
      assert.equal(loadedCfg.bridgeSecret, 'dv_secret_123')

      // 20c. Live E2EE PC Bridge connected to Relay Server (blind relay verification!)
      const e2eeDevice = await (await fetch(`${httpBase}/api/account/device-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'smoke_admin',
          password: SMOKE_ADMIN_PASS,
          label: 'Smoke-E2EE-PC',
          hostname: 'SMOKE-E2EE',
          platform: 'darwin',
          bridgeId: 'smoke-e2ee-pc',
        }),
      })).json()
      assert.equal(e2eeDevice.ok, true)

      const e2eeBridge = startStandaloneBridge({
        relayUrl: wsBridgeUrl,
        secret: e2eeDevice.deviceSecret,
        roomId: e2eeDevice.roomId,
        bridgeId: e2eeDevice.bridgeId,
        e2eeKey,
        inboundDir: join(tmpDir, 'e2ee-inbound'),
        quiet: true,
      })

      let e2eeWs = null
      try {
        for (let i = 0; i < 50; i++) {
          const list = relay.hub.getBridgeList(e2eeDevice.roomId)
          const found = list.find((b) => b.bridgeId === e2eeDevice.bridgeId && b.e2ee?.enabled)
          if (found) break
          await new Promise((r) => setTimeout(r, 100))
        }
        const e2eeMeta = relay.hub.getBridgeList(e2eeDevice.roomId).find((b) => b.bridgeId === e2eeDevice.bridgeId)
        assert.ok(e2eeMeta?.e2ee?.enabled, 'Bridge metadata must advertise E2EE enabled')
        assert.equal(e2eeMeta.e2ee.keyId, e2eeKeyId)
        assert.equal(JSON.stringify(e2eeMeta).includes(e2eeKey), false, 'Relay must NEVER receive raw e2eeKey')

        // Legacy plaintext /api/bridge-file is permanently removed (404)
        const relayPlainImg = await fetch(
          `${httpBase}/api/bridge-file?path=${encodeURIComponent('packages/mobile-app/public/icon-192.png')}&cwd=${encodeURIComponent(process.cwd())}&bridgeId=${encodeURIComponent(e2eeDevice.bridgeId)}`,
        )
        assert.equal(relayPlainImg.status, 404, 'Legacy /api/bridge-file must be permanently deleted (404)')

        // Open client WS via single-use ticket and test: plaintext rejection, wrong-key rejection, encrypted FILE_READ, replay block, encrypted event
        const e2eeTicket = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${loginData.token}` },
        })).json()
        assert.equal(e2eeTicket.ok, true)
        const capturedWireFrames = []
        e2eeWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(e2eeTicket.ticket)}`)
        const pendingMap = new Map()
        const rawEvents = []
        await new Promise((resolve, reject) => {
          e2eeWs.on('message', (raw) => {
            const text = String(raw)
            capturedWireFrames.push(text)
            const msg = JSON.parse(text)
            if (msg.type === 'hello') {
              resolve()
              return
            }
            if (msg.type === 'rpc.res') {
              const p = pendingMap.get(msg.id)
              if (p) {
                pendingMap.delete(msg.id)
                p.resolve(msg)
              }
            } else if (msg.type === 'event') {
              rawEvents.push(msg)
            }
          })
          e2eeWs.on('error', reject)
        })

        const sendWsFrame = (frame) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`WS timeout ${frame.id}`)), 15_000)
            pendingMap.set(frame.id, {
              resolve: (m) => {
                clearTimeout(timer)
                resolve(m)
              },
            })
            e2eeWs.send(JSON.stringify(frame))
          })

        // 1) Plaintext RPC rejected with E2EE_KEY_REQUIRED
        const plainTry = await sendWsFrame({
          type: 'rpc.req',
          id: 'e2ee-plain-1',
          bridgeId: e2eeDevice.bridgeId,
          method: RPC.APPS_STATUS,
          params: {},
        })
        assert.equal(plainTry.ok, false)
        assert.equal(plainTry.error?.code, 'E2EE_KEY_REQUIRED')

        // 2) Wrong key rejected with E2EE_KEY_MISMATCH
        const wrongKey = generateE2eeKey()
        const wrongEnv = await encryptJson(
          wrongKey,
          { method: RPC.APPS_STATUS, params: {}, cid: 'e2ee-wrong-1', ts: Date.now() },
          { kind: 'rpc.req', roomId: e2eeDevice.roomId },
        )
        const wrongTry = await sendWsFrame({
          type: 'rpc.req',
          id: 'e2ee-wrong-1',
          bridgeId: e2eeDevice.bridgeId,
          method: E2EE_METHOD_MARKER,
          e2ee: wrongEnv,
        })
        assert.equal(wrongTry.ok, false)
        assert.equal(wrongTry.error?.code, 'E2EE_KEY_MISMATCH')

        // 3) Valid E2EE encrypted RPC.FILE_READ (verifies image bytes & path stay opaque on relay!)
        const fileReqEnv = await encryptJson(
          e2eeKey,
          {
            method: RPC.FILE_READ,
            params: { path: 'packages/mobile-app/public/icon-192.png', cwd: process.cwd() },
            cid: 'e2ee-file-1',
            ts: Date.now(),
          },
          { kind: 'rpc.req', roomId: e2eeDevice.roomId },
        )
        const encFileRes = await sendWsFrame({
          type: 'rpc.req',
          id: 'e2ee-file-1',
          bridgeId: e2eeDevice.bridgeId,
          method: E2EE_METHOD_MARKER,
          e2ee: fileReqEnv,
        })
        assert.equal(encFileRes.ok, true)
        assert.ok(encFileRes.e2ee?.ct, 'RPC response must be an E2EE ciphertext envelope')
        assert.equal(encFileRes.result, undefined, 'Encrypted RPC response must not include plaintext result')
        assert.equal(JSON.stringify(encFileRes).includes('image/png'), false, 'Ciphertext must not expose mimeType')
        const decFileRes = await decryptJson(e2eeKey, encFileRes.e2ee, {
          kind: 'rpc.res',
          roomId: e2eeDevice.roomId,
        })
        assert.equal(decFileRes.ok, true)
        assert.equal(decFileRes.cid, 'e2ee-file-1')
        assert.equal(decFileRes.result.mimeType, 'image/png')
        assert.ok(Buffer.from(decFileRes.result.dataBase64, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))

        // Verify relay room stats NEVER recorded plaintext RPC method name
        assert.equal(relay.hub.getRoomStats(e2eeDevice.roomId).lastRpcMethod, E2EE_METHOD_MARKER)

        // 4) Replaying exact same encrypted rpc.req envelope must be rejected by bridge
        const replayRes = await sendWsFrame({
          type: 'rpc.req',
          id: 'e2ee-replay-1',
          bridgeId: e2eeDevice.bridgeId,
          method: E2EE_METHOD_MARKER,
          e2ee: fileReqEnv,
        })
        assert.equal(replayRes.ok, false)
        assert.equal(replayRes.error?.code, 'E2EE_REPLAY_DETECTED', 'Replayed ciphertext IV must be rejected')

        // 5) Encrypted streaming event -> Relay buffer contains ONLY ciphertext, client decrypts secret token!
        const secretToken = 'ZERO_KNOWLEDGE_SECRET_DELTA_987654'
        e2eeBridge.link.pushEvent(EVENTS.STREAM_DELTA, { sessionId: 'codex:s1', delta: secretToken })
        for (let i = 0; i < 30; i++) {
          if (rawEvents.some((e) => e.bridgeId === e2eeDevice.bridgeId && e.e2ee?.ct)) break
          await new Promise((r) => setTimeout(r, 50))
        }
        const encEvent = rawEvents.find((e) => e.bridgeId === e2eeDevice.bridgeId && e.e2ee?.ct)
        assert.ok(encEvent, 'Client must receive E2EE-wrapped streaming event')
        assert.equal(encEvent.event, '__e2ee__')
        assert.equal(
          JSON.stringify(relay.hub.getRoomEventState(e2eeDevice.roomId).buffer).includes(secretToken),
          false,
          'Relay event catch-up buffer must NEVER contain plaintext streaming tokens',
        )
        const decEvent = await decryptJson(e2eeKey, encEvent.e2ee, {
          kind: 'event',
          roomId: e2eeDevice.roomId,
        })
        assert.equal(decEvent.event, EVENTS.STREAM_DELTA)
        assert.equal(decEvent.payload.delta, secretToken)

        // 6) Encrypted Attachment Upload -> relay disk holds ONLY ciphertext & generic metadata, bridge decrypts cleanly!
        const secretFileText = 'TOP_SECRET_ATTACHMENT_CONTENT_ALPHA_2026'
        const encUpload = await encryptBytes(e2eeKey, Buffer.from(secretFileText, 'utf8'), {
          kind: 'upload',
          roomId: e2eeDevice.roomId,
        })
        const upRes = await (await fetch(`${httpBase}/api/uploads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginData.token}`,
          },
          body: JSON.stringify({
            filename: 'secret-note.txt',
            mimeType: 'text/plain',
            encrypted: true,
            dataBase64: bytesToBase64(encUpload.ciphertext),
          }),
        })).json()
        assert.equal(upRes.ok, true)
        assert.equal(upRes.upload.filename, 'encrypted.bin', 'Relay must strip original filename for encrypted uploads')
        assert.equal(upRes.upload.mimeType, 'application/octet-stream')
        const relayBinDisk = readFileSync(join(tmpDir, 'uploads', `${upRes.upload.id}.bin`))
        const relayMetaDisk = readFileSync(join(tmpDir, 'uploads', `${upRes.upload.id}.json`), 'utf8')
        assert.equal(relayBinDisk.toString('utf8').includes(secretFileText), false, 'Relay disk .bin must hold ciphertext only')
        assert.equal(relayMetaDisk.includes('secret-note.txt'), false, 'Relay disk .json must not store original filename')

        const materialized = await e2eeBridge.orchestrator.materializeAttachments([
          {
            id: upRes.upload.id,
            url: upRes.upload.url,
            filename: 'secret-note.txt',
            mimeType: 'text/plain',
            e2ee: { v: encUpload.v, kid: encUpload.kid, iv: encUpload.iv },
          },
        ])
        assert.equal(materialized.length, 1)
        assert.equal(readFileSync(materialized[0].localPath, 'utf8'), secretFileText)
        assert.ok(materialized[0].localPath.endsWith('secret-note.txt'))

        // Relay strictly rejects plaintext upload (400 E2EE_UPLOAD_REQUIRED) AND bridge rejects attachments missing `att.e2ee`
        const plainUpResp = await fetch(`${httpBase}/api/uploads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${loginData.token}`,
          },
          body: JSON.stringify({
            filename: 'plain.txt',
            mimeType: 'text/plain',
            dataBase64: Buffer.from('unencrypted-data', 'utf8').toString('base64'),
          }),
        })
        assert.equal(plainUpResp.status, 400)
        const plainUpJson = await plainUpResp.json()
        assert.equal(plainUpJson.code, 'E2EE_UPLOAD_REQUIRED')

        const rejectedPlainAtt = await e2eeBridge.orchestrator.materializeAttachments([
          { id: upRes.upload.id, url: upRes.upload.url, filename: 'plain.txt', mimeType: 'text/plain' },
        ])
        assert.equal(rejectedPlainAtt.length, 0)
      } finally {
        if (e2eeWs) try { e2eeWs.close() } catch {}
        await e2eeBridge.stop()
      }
    }
    console.log('[smoke] 20/21 Zero-Knowledge E2EE (AES-256-GCM, QR sync, replay defense, blind relay & encrypted uploads) OK')

    // 21. Zero-Knowledge Device-to-Device Key Grant (Phone B -> Computer C via ECDH P-256 + HKDF + AES-256-GCM + 6-digit SAS + Reverse QR)
    {
      // 21.1 Cryptographic & MITM unit tests
      const roomKeyA = generateE2eeKey()
      const roomKeyAId = await computeE2eeKeyId(roomKeyA)
      const pairC = await generateGrantKeyPair()
      const pairB = await generateGrantKeyPair()
      const pairEvil = await generateGrantKeyPair()
      const reqId1 = generateGrantReqId()
      const testRoomId = 'usr_grant_crypto_unit'

      assert.equal(pairC.publicKeyFp.length, 16)
      assert.equal(await computeGrantPubKeyFp(pairC.publicKeyRaw), pairC.publicKeyFp)
      const grantUri = encodeE2eeGrantQrUri({ reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp })
      const parsedGrantQr = parseE2eeGrantQrInput(grantUri)
      assert.deepEqual(parsedGrantQr, { reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp })

      const sasFromC = await deriveGrantSas({
        requesterPubKey: pairC.publicKeyRaw,
        approverPubKey: pairB.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
      })
      const sasFromB = await deriveGrantSas({
        requesterPubKey: pairC.publicKeyRaw,
        approverPubKey: pairB.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
      })
      assert.match(sasFromC, /^\d{3}-\d{3}$/)
      assert.equal(sasFromC, sasFromB, 'Both devices must independently derive the exact same 6-digit SAS')

      const sasMitm = await deriveGrantSas({
        requesterPubKey: pairEvil.publicKeyRaw,
        approverPubKey: pairB.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
      })
      assert.notEqual(sasMitm, sasFromC, 'Substituted MITM public key must alter SAS')

      const env1 = await encryptGrantPayload({
        approverPrivateKey: pairB.privateKey,
        approverPubKeyRaw: pairB.publicKeyRaw,
        requesterPubKeyRaw: pairC.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
        payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
      })
      assert.equal(JSON.stringify(env1).includes(roomKeyA), false, 'Grant envelope must NEVER contain plaintext E2EE key')
      const dec1 = await decryptGrantPayload({
        requesterPrivateKey: pairC.privateKey,
        requesterPubKeyRaw: pairC.publicKeyRaw,
        envelope: env1,
        roomId: testRoomId,
        expectedApproverPubKey: pairB.publicKeyRaw,
      })
      assert.equal(dec1.keys[0].key, roomKeyA)
      assert.equal(dec1.preferredKeyId, roomKeyAId)

      // Mismatched approverPubKey, wrong roomId, and tampered ciphertext must all fail
      await assert.rejects(
        () => decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: testRoomId,
          expectedApproverPubKey: pairEvil.publicKeyRaw,
        }),
        /E2EE_GRANT_PUBKEY_MISMATCH|安全码/,
      )
      await assert.rejects(
        () => decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: 'usr_wrong_room',
        }),
        /解密授权密钥包失败/,
      )
      await assert.rejects(
        () => decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: { ...env1, ct: `${env1.ct.slice(0, -2)}AA` },
          roomId: testRoomId,
        }),
        /解密授权密钥包失败/,
      )

      // 21.2 Full Live Relay Signaling E2E: SAS Push Flow, Reverse-QR Lookup Flow, Cross-Room Isolation, Single-Use Burn & Disconnect Auto-Cancel
      const grantRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'grant-smoke-jwt-secret-0123456789',
        adminBootstrapToken: 'grant-bootstrap-99',
        accountsFile: join(tmpDir, 'grant-accounts.json'),
        uploadDir: join(tmpDir, 'grant-uploads'),
      })
      const grantSockets = []
      const openGrantWs = async (gBase, token, devName, kind = 'web') => {
        const tRes = await (await fetch(`${gBase}/api/auth/ws-ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ dev: devName, kind }),
        })).json()
        assert.equal(tRes.ok, true)
        const wsUrl = `${gBase.replace(/^http/, 'ws')}/ws/client?ticket=${encodeURIComponent(tRes.ticket)}`
        const inbox = []
        const waiters = []
        const ws = new WebSocket(wsUrl)
        grantSockets.push(ws)
        ws.on('message', (raw) => {
          const msg = JSON.parse(String(raw))
          inbox.push(msg)
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            if (waiters[i].pred(msg)) {
              const w = waiters.splice(i, 1)[0]
              clearTimeout(w.timer)
              w.resolve(msg)
            }
          }
        })
        const waitFor = (pred, timeoutMs = 4000) => {
          const existing = inbox.find(pred)
          if (existing) return Promise.resolve(existing)
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs)
            waiters.push({ pred, resolve, timer })
          })
        }
        const hello = await waitFor((m) => m.type === 'hello')
        return { ws, hello, inbox, waitFor }
      }

      try {
        const { port: gPort } = await grantRelay.start()
        const gBase = `http://127.0.0.1:${gPort}`

        // Bootstrap Alice (owns PC A, Phone B, Computer C) + register separate user Mallory (Account D attacker)
        const aliceReg = await (await fetch(`${gBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'grant_alice', password: 'AliceGrantPassword1!', inviteCode: 'grant-bootstrap-99' }),
        })).json()
        assert.equal(aliceReg.ok, true)
        const invRes = await (await fetch(`${gBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceReg.token}` },
          body: JSON.stringify({ count: 1, note: 'mallory' }),
        })).json()
        const malloryReg = await (await fetch(`${gBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'grant_mallory', password: 'MalloryGrantPassword1!', inviteCode: invRes.invites[0].code }),
        })).json()
        assert.equal(malloryReg.ok, true)

        // Computer C connects & initiates a grant request BEFORE Phone B opens the app!
        const compC = await openGrantWs(gBase, aliceReg.token, 'Windows Desktop', 'desktop')
        const cPair1 = await generateGrantKeyPair()
        const liveReqId1 = generateGrantReqId()
        compC.ws.send(JSON.stringify({
          type: 'e2ee.grant.req',
          reqId: liveReqId1,
          pubKey: cPair1.publicKeyRaw,
          wantedKeyId: roomKeyAId,
        }))
        await new Promise((r) => setTimeout(r, 60))

        // Mallory (different account!) connects -> MUST see 0 pending grants & forged deliver/reject MUST be ignored!
        const malloryWs = await openGrantWs(gBase, malloryReg.token, 'Attacker Browser', 'web')
        assert.equal(malloryWs.hello.pendingGrants.length, 0, 'Other account must NEVER see Alice pending grants')
        malloryWs.ws.send(JSON.stringify({ type: 'e2ee.grant.list', id: 'm-list-1' }))
        const mList = await malloryWs.waitFor((m) => m.type === 'e2ee.grant.list.res' && m.id === 'm-list-1')
        assert.equal(mList.grants.length, 0)
        // Mallory tries to reject/hijack Alice's reqId -> must be silently dropped!
        malloryWs.ws.send(JSON.stringify({ type: 'e2ee.grant.reject', reqId: liveReqId1 }))
        malloryWs.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId: liveReqId1, approverPubKey: pairEvil.publicKeyRaw }))
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(compC.inbox.some((m) => m.event === EVENTS.E2EE_GRANT_REJECT || m.event === EVENTS.E2EE_GRANT_OFFER), false, 'Cross-account grant injection must be strictly blocked')

        // Phone B opens AFTER Computer C created the request -> hello.pendingGrants delivers it immediately!
        const phoneB = await openGrantWs(gBase, aliceReg.token, 'Android App', 'mobile')
        assert.equal(phoneB.hello.pendingGrants.length, 1, 'Phone B must receive pending grant in hello frame')
        assert.equal(phoneB.hello.pendingGrants[0].reqId, liveReqId1)
        assert.equal(phoneB.hello.pendingGrants[0].pubKey, cPair1.publicKeyRaw)

        // Path A: 2-party SAS Remote Push flow
        const bPair1 = await generateGrantKeyPair()
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId: liveReqId1, approverPubKey: bPair1.publicKeyRaw }))
        const offerEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_OFFER && m.payload?.reqId === liveReqId1)
        assert.equal(offerEv.payload.approverPubKey, bPair1.publicKeyRaw)
        const liveSasC = await deriveGrantSas({
          requesterPubKey: cPair1.publicKeyRaw,
          approverPubKey: offerEv.payload.approverPubKey,
          reqId: liveReqId1,
          roomId: aliceReg.roomId,
        })
        const liveSasB = await deriveGrantSas({
          requesterPubKey: cPair1.publicKeyRaw,
          approverPubKey: bPair1.publicKeyRaw,
          reqId: liveReqId1,
          roomId: aliceReg.roomId,
        })
        assert.equal(liveSasC, liveSasB)

        // Phone B encrypts PC A's key & delivers; Computer C decrypts!
        const liveEnv1 = await encryptGrantPayload({
          approverPrivateKey: bPair1.privateKey,
          approverPubKeyRaw: bPair1.publicKeyRaw,
          requesterPubKeyRaw: cPair1.publicKeyRaw,
          reqId: liveReqId1,
          roomId: aliceReg.roomId,
          payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
        })
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
        const deliverEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId1)
        const unlocked1 = await decryptGrantPayload({
          requesterPrivateKey: cPair1.privateKey,
          requesterPubKeyRaw: cPair1.publicKeyRaw,
          envelope: deliverEv.payload.envelope,
          roomId: aliceReg.roomId,
          expectedApproverPubKey: offerEv.payload.approverPubKey,
        })
        assert.equal(unlocked1.keys[0].key, roomKeyA)

        // Single-use burn: replaying deliver on liveReqId1 must be dropped!
        const beforeReplayCount = compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length, beforeReplayCount, 'Burned reqId must ignore replay')

        // Path B: Reverse-QR out-of-band 1-tap delivery (no offer step needed) + Disconnect auto-cancel
        const cPair2 = await generateGrantKeyPair()
        const liveReqId2 = generateGrantReqId()
        const qrUri2 = encodeE2eeGrantQrUri({ reqId: liveReqId2, roomId: aliceReg.roomId, pubKeyFp: cPair2.publicKeyFp })
        const parsedQr2 = parseE2eeGrantQrInput(qrUri2)
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId2, pubKey: cPair2.publicKeyRaw }))
        await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === liveReqId2)

        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.list', id: 'b-list-2' }))
        const bList2 = await phoneB.waitFor((m) => m.type === 'e2ee.grant.list.res' && m.id === 'b-list-2')
        const found2 = bList2.grants.find((g) => g.reqId === parsedQr2.reqId)
        assert.ok(found2)
        assert.equal(await computeGrantPubKeyFp(found2.pubKey), parsedQr2.pubKeyFp, 'Out-of-band QR fingerprint must match')

        const bPair2 = await generateGrantKeyPair()
        const liveEnv2 = await encryptGrantPayload({
          approverPrivateKey: bPair2.privateKey,
          approverPubKeyRaw: bPair2.publicKeyRaw,
          requesterPubKeyRaw: found2.pubKey,
          reqId: liveReqId2,
          roomId: aliceReg.roomId,
          payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
        })
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId2, envelope: liveEnv2 }))
        const deliverEv2 = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId2)
        const unlocked2 = await decryptGrantPayload({
          requesterPrivateKey: cPair2.privateKey,
          requesterPubKeyRaw: cPair2.publicKeyRaw,
          envelope: deliverEv2.payload.envelope,
          roomId: aliceReg.roomId,
        })
        assert.equal(unlocked2.keys[0].key, roomKeyA)

        // Disconnect auto-cancel: Computer C opens a 3rd grant & closes WS -> Phone B receives E2EE_GRANT_CANCEL!
        const cPair3 = await generateGrantKeyPair()
        const liveReqId3 = generateGrantReqId()
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId3, pubKey: cPair3.publicKeyRaw }))
        await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === liveReqId3)
        compC.ws.close()
        const cancelEv3 = await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_CANCEL && m.payload?.reqId === liveReqId3)
        assert.equal(cancelEv3.payload.reason, 'disconnected')
      } finally {
        for (const ws of grantSockets) {
          try { ws.close() } catch {}
        }
        await grantRelay.close()
      }
    }
    console.log('[smoke] 21/22 Zero-Knowledge Device-to-Device Key Grant (ECDH P-256, 6-digit SAS, Reverse-QR, MITM defense & cross-room isolation) OK')

    // 22. Interactive Multi-Question Q&A & Approvals across all 4 AI adapters (Codex, DSH + Local IPC, Antigravity ACP, Claude Code) & Orchestrator
    {
      // 22.1 JSON Schema elicitation normalization + answer serialization
      const testSchema = {
        type: 'object',
        required: ['framework', 'port'],
        properties: {
          framework: {
            type: 'string',
            title: 'Framework',
            description: 'Choose frontend framework',
            oneOf: [
              { const: 'react', title: 'React' },
              { const: 'vue', title: 'Vue' },
            ],
          },
          features: {
            type: 'array',
            title: 'Features',
            items: {
              anyOf: [
                { const: 'i18n', title: 'i18n' },
                { const: 'pwa', title: 'PWA' },
              ],
            },
          },
          useTs: { type: 'boolean', title: 'TypeScript', default: true },
          port: { type: 'integer', title: 'Port' },
          note: { type: 'string', title: 'Extra Note' },
        },
      }
      const qs = elicitationSchemaToQuestions(testSchema, 'Fallback')
      assert.equal(qs.length, 5)
      assert.equal(qs[0].id, 'framework')
      assert.equal(qs[0].multiSelect, false)
      assert.equal(qs[0].required, true)
      assert.equal(qs[1].id, 'features')
      assert.equal(qs[1].multiSelect, true)
      assert.equal(qs[2].inputType, 'boolean')
      assert.equal(qs[3].inputType, 'number')
      assert.equal(qs[4].inputType, 'text')
      const content = answersToElicitationContent(testSchema, {
        framework: { selected: ['react'] },
        features: { selected: ['i18n', 'pwa'] },
        useTs: { selected: ['false'] },
        port: { custom: '8080' },
        note: { custom: 'Ship fast' },
      })
      assert.deepEqual(content, {
        framework: 'react',
        features: ['i18n', 'pwa'],
        useTs: false,
        port: 8080,
        note: 'Ship fast',
      })

      // 22.2 CodexAdapter: requestUserInput + permissions/requestApproval + mcpServer/elicitation (form & url)
      {
        const cdxCards = []
        const cdxEvents = []
        const cdxSent = []
        const mockWriter = { sendRaw: (obj) => cdxSent.push(obj) }
        const cdxAdapter = new CodexAdapter({
          config: { codexHome: join(tmpDir, 'codex-qna') },
          log: { warn() {}, log() {} },
          emitEvent: (ev, payload) => cdxEvents.push({ ev, payload }),
          onApprovalRequest: (req) => cdxCards.push(req),
        })

        // (a) item/tool/requestUserInput with 2 questions (1 option select + 1 custom isOther)
        cdxAdapter.handleServerRequest(mockWriter, {
          id: 101,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thr-qna-1',
            questions: [
              {
                id: 'db',
                header: 'Database',
                question: 'Which DB?',
                options: [
                  { label: 'PostgreSQL', description: 'Relational' },
                  { label: 'SQLite', description: 'Embedded' },
                ],
                isOther: true,
              },
              {
                id: 'branch',
                header: 'Branch',
                question: 'Target branch name?',
                options: [],
                isOther: true,
              },
            ],
          },
        })
        assert.equal(cdxCards.length, 1)
        assert.equal(cdxCards[0].kind, 'question')
        assert.equal(cdxCards[0].sessionId, 'codex:thr-qna-1')
        assert.equal(cdxCards[0].questions.length, 2)
        await cdxAdapter.resolveApproval(cdxCards[0].id, {
          decision: 'submit',
          answers: {
            db: { selected: ['PostgreSQL'] },
            branch: { custom: 'feat/qna' },
          },
        })
        assert.deepEqual(cdxSent[0], {
          jsonrpc: '2.0',
          id: 101,
          result: {
            answers: {
              db: { answers: ['PostgreSQL'] },
              branch: { answers: ['feat/qna'] },
            },
          },
        })

        // (b) item/permissions/requestApproval with session scope
        cdxAdapter.handleServerRequest(mockWriter, {
          id: 102,
          method: 'item/permissions/requestApproval',
          params: {
            threadId: 'thr-qna-1',
            reason: 'Need network access',
            permissions: { network: { enabled: true } },
          },
        })
        assert.equal(cdxCards[1].kind, 'permissions')
        await cdxAdapter.resolveApproval(cdxCards[1].id, 'acceptForSession')
        assert.deepEqual(cdxSent[1], {
          jsonrpc: '2.0',
          id: 102,
          result: { permissions: { network: { enabled: true } }, scope: 'session' },
        })

        // (c) mcpServer/elicitation/request (form + url)
        cdxAdapter.handleServerRequest(mockWriter, {
          id: 103,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'thr-qna-1',
            serverName: 'github',
            mode: 'form',
            message: 'Select repo options',
            requestedSchema: {
              type: 'object',
              properties: {
                visibility: { type: 'string', enum: ['public', 'private'] },
              },
            },
          },
        })
        assert.equal(cdxCards[2].kind, 'question')
        await cdxAdapter.resolveApproval(cdxCards[2].id, {
          decision: 'submit',
          answers: { visibility: { selected: ['private'] } },
        })
        assert.deepEqual(cdxSent[2], {
          jsonrpc: '2.0',
          id: 103,
          result: { action: 'accept', content: { visibility: 'private' } },
        })

        cdxAdapter.handleServerRequest(mockWriter, {
          id: 104,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'thr-qna-1',
            serverName: 'oauth',
            mode: 'url',
            message: 'Authorize OAuth',
            url: 'https://example.com/auth',
          },
        })
        assert.equal(cdxCards[3].kind, 'url_elicitation')
        assert.equal(cdxCards[3].url, 'https://example.com/auth')
        await cdxAdapter.resolveApproval(cdxCards[3].id, 'decline')
        assert.deepEqual(cdxSent[3], {
          jsonrpc: '2.0',
          id: 104,
          result: { action: 'decline' },
        })
        assert.equal(cdxEvents.filter((e) => e.ev === EVENTS.APPROVAL_RESOLVED).length, 4)
      }

      // 22.3 DshAdapter Cordis waterfall hooks + authenticated Local IPC (listApprovals + resolveApproval + desktop-first race)
      {
        const ipcQnaHome = join(tmpDir, 'dsh-qna-ipc')
        mkdirSync(ipcQnaHome, { recursive: true })
        const hooks = new Map()
        const mockCtx = {
          agents: {},
          get(key) {
            return key === 'agents' || key === 'sessionController' ? {} : null
          },
          on(eventName, fn) {
            hooks.set(eventName, fn)
            return () => hooks.delete(eventName)
          },
        }
        const dshLiveEvents = []
        const dshLiveCards = []
        let ipcQnaSrv = null
        const dshLive = new DshAdapter({
          ctx: mockCtx,
          config: { dshHome: ipcQnaHome },
          log: { info() {}, warn() {}, error() {} },
          emitEvent: (ev, payload) => {
            dshLiveEvents.push({ ev, payload })
            ipcQnaSrv?.emitEvent?.(ev, payload)
          },
          onApprovalRequest: (req) => {
            dshLiveCards.push(req)
            ipcQnaSrv?.emitEvent?.(EVENTS.APPROVAL_REQUEST, req)
          },
        })
        const dshClientEvents = []
        const dshClientCards = []
        const dshStandalone = new DshAdapter({
          ctx: null,
          config: { dshHome: ipcQnaHome },
          log: { info() {}, warn() {}, error() {} },
          emitEvent: (ev, payload) => dshClientEvents.push({ ev, payload }),
          onApprovalRequest: (req) => dshClientCards.push(req),
        })

        try {
          ipcQnaSrv = await startDshLocalIpcServer({
            dshAdapter: dshLive,
            dshHome: ipcQnaHome,
            log: { info() {}, warn() {}, error() {} },
          })

          // (a) Headless DSH `user-questions/request` (next() rejects with NO_PROVIDER) -> listed & answered via IPC!
          const uqHook = hooks.get('user-questions/request')
          assert.equal(typeof uqHook, 'function', 'DshAdapter must hook Cordis user-questions/request')
          const noProviderErr = Object.assign(new Error('No desktop UI'), { code: 'NO_PROVIDER' })
          const uqPromise = uqHook(
            {
              agent: { session: { id: 'dsh-sess-q1' } },
              questions: [
                {
                  id: 'q1',
                  header: 'Deploy',
                  question: 'Deploy target?',
                  multiSelect: false,
                  options: [{ label: 'Staging' }, { label: 'Production' }],
                },
                {
                  id: 'q2',
                  header: 'Extras',
                  question: 'Extra options?',
                  multiSelect: true,
                  options: [{ label: 'Cache' }, { label: 'CDN' }],
                },
              ],
            },
            () => Promise.reject(noProviderErr),
          )

          const pendingViaIpc = await dshStandalone.listPendingApprovals()
          assert.equal(pendingViaIpc.length, 1, 'Standalone bridge must see live DSH question via IPC listApprovals')
          assert.equal(pendingViaIpc[0].kind, 'question')
          assert.equal(pendingViaIpc[0].sessionId, 'dsh:dsh-sess-q1')

          const ipcRes = await dshStandalone.resolveApproval(pendingViaIpc[0].id, {
            decision: 'submit',
            answers: {
              q1: { selected: ['Staging'] },
              q2: { selected: ['Cache'], custom: 'Edge' },
            },
          })
          assert.equal(ipcRes.resolved, true)
          const uqOutcome = await uqPromise
          assert.deepEqual(uqOutcome, {
            answers: [
              { id: 'q1', selected: ['Staging'] },
              { id: 'q2', selected: ['Cache'], custom: 'Edge' },
            ],
          })

          // (b) `approval/request` resolved via Mobile IPC
          const aprHook = hooks.get('approval/request')
          assert.equal(typeof aprHook, 'function', 'DshAdapter must hook Cordis approval/request')
          const aprPromise = aprHook(
            {
              agent: { session: { id: 'dsh-sess-q1', meta: { cwd: ipcQnaHome } } },
              toolName: 'bash',
              reason: 'npm test',
            },
            () => Promise.resolve('unavailable'),
          )
          const aprList = await dshStandalone.listPendingApprovals()
          assert.equal(aprList.length, 1)
          await dshStandalone.resolveApproval(aprList[0].id, 'allowed-once')
          assert.equal(await aprPromise, 'allowed-once')

          // (c) Desktop-first race: DSH Desktop UI resolves `next()` first -> emits APPROVAL_RESOLVED & clears pending
          const racePromise = uqHook(
            {
              agent: { session: { id: 'dsh-sess-q2' } },
              questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'Yes' }] }],
            },
            () => new Promise((r) => setTimeout(() => r({ answers: [{ id: 'confirm', selected: ['Yes'] }] }), 25)),
          )
          const raceResult = await racePromise
          assert.deepEqual(raceResult, { answers: [{ id: 'confirm', selected: ['Yes'] }] })
          assert.equal((await dshLive.listPendingApprovals()).length, 0)
          assert.ok(
            dshLiveEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.payload?.decision === 'desktop'),
            'Desktop-first resolution must emit APPROVAL_RESOLVED to clear mobile card',
          )
        } finally {
          await dshStandalone.dispose()
          await dshLive.dispose()
          if (ipcQnaSrv) await ipcQnaSrv.close()
        }
      }

      // 22.4 AntigravityAdapter: elicitation/create (form) + session/request_permission (manual approval)
      {
        const agyCards = []
        const agyEvents = []
        const agySent = []
        const mockClient = { sendRaw: (obj) => agySent.push(obj) }
        const agyAdapter = new AntigravityAdapter({
          config: { agyHome: join(tmpDir, 'agy-qna'), agyAutoApprove: false },
          log: { warn() {}, log() {} },
          emitEvent: (ev, payload) => agyEvents.push({ ev, payload }),
          onApprovalRequest: (req) => agyCards.push(req),
        })
        try {
          const fakeEntry = { sessionId: 'agy-conv-1', cwd: tmpDir, lastActivityAt: 0 }
          agyAdapter.handleServerRequest(fakeEntry, mockClient, {
            id: 201,
            method: 'elicitation/create',
            params: {
              sessionId: 'agy-conv-1',
              mode: 'form',
              message: 'Pick release channel',
              requestedSchema: {
                type: 'object',
                required: ['channel'],
                properties: {
                  channel: {
                    type: 'string',
                    title: 'Channel',
                    oneOf: [
                      { const: 'stable', title: 'Stable' },
                      { const: 'canary', title: 'Canary' },
                    ],
                  },
                },
              },
            },
          })
          assert.equal(agyCards.length, 1)
          assert.equal(agyCards[0].kind, 'question')
          assert.equal(agyCards[0].sessionId, 'antigravity:agy-conv-1')
          await agyAdapter.resolveApproval(agyCards[0].id, {
            decision: 'submit',
            answers: { channel: { selected: ['stable'] } },
          })
          assert.deepEqual(agySent[0], {
            jsonrpc: '2.0',
            id: 201,
            result: { action: 'accept', content: { channel: 'stable' } },
          })

          agyAdapter.handleServerRequest(fakeEntry, mockClient, {
            id: 202,
            method: 'session/request_permission',
            params: {
              sessionId: 'agy-conv-1',
              toolCall: { title: 'Run shell', rawInput: { cmd: 'git status' } },
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
          })
          assert.equal(agyCards.length, 2)
          assert.equal(agyCards[1].kind, 'command')
          await agyAdapter.resolveApproval(agyCards[1].id, 'allow_once')
          assert.deepEqual(agySent[1], {
            jsonrpc: '2.0',
            id: 202,
            result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
          })
          assert.equal(agyEvents.filter((e) => e.ev === EVENTS.APPROVAL_RESOLVED).length, 2)
        } finally {
          await agyAdapter.dispose()
        }
      }

      // 22.5 ClaudeAdapter: bidirectional stream-json control_request / control_response (AskUserQuestion, ExitPlanMode, Bash)
      {
        const cldCards = []
        const cldEvents = []
        const cldWritten = []
        const mockProc = {
          stdin: {
            writable: true,
            write: (chunk) => cldWritten.push(JSON.parse(String(chunk).trim())),
          },
        }
        const cldAdapter = new ClaudeAdapter({
          config: { claudeHome: join(tmpDir, 'claude-qna') },
          log: { warn() {}, log() {} },
          emitEvent: (ev, payload) => cldEvents.push({ ev, payload }),
          onApprovalRequest: (req) => cldCards.push(req),
        })

        // (a) AskUserQuestion (single-select + multi-select)
        const askInput = {
          questions: [
            {
              header: 'Auth',
              question: 'Which auth provider?',
              multiSelect: false,
              options: [{ label: 'JWT' }, { label: 'OAuth' }],
            },
            {
              header: 'Targets',
              question: 'Target platforms?',
              multiSelect: true,
              options: [{ label: 'Web' }, { label: 'Android' }, { label: 'Desktop' }],
            },
          ],
        }
        cldAdapter.handleControlRequest(mockProc, 'cld-s1', 'claude:cld-s1', tmpDir, {
          type: 'control_request',
          request_id: 'req-ask-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: askInput,
          },
        })
        assert.equal(cldCards.length, 1)
        assert.equal(cldCards[0].kind, 'question')
        assert.equal(cldCards[0].questions.length, 2)
        await cldAdapter.resolveApproval(cldCards[0].id, {
          decision: 'submit',
          answers: {
            [cldCards[0].questions[0].id]: { selected: ['JWT'] },
            [cldCards[0].questions[1].id]: { selected: ['Web', 'Android'] },
          },
        })
        assert.equal(cldWritten[0].type, 'control_response')
        assert.equal(cldWritten[0].response.request_id, 'req-ask-1')
        assert.equal(cldWritten[0].response.response.behavior, 'allow')
        assert.deepEqual(cldWritten[0].response.response.updatedInput.answers, {
          'Which auth provider?': 'JWT',
          'Target platforms?': 'Web, Android',
        })

        // (b) ExitPlanMode allow
        cldAdapter.handleControlRequest(mockProc, 'cld-s1', 'claude:cld-s1', tmpDir, {
          type: 'control_request',
          request_id: 'req-plan-2',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'ExitPlanMode',
            input: { plan: '1. Edit files\n2. Run tests' },
          },
        })
        assert.equal(cldCards[1].kind, 'permissions')
        await cldAdapter.resolveApproval(cldCards[1].id, 'allow')
        assert.equal(cldWritten[1].response.request_id, 'req-plan-2')
        assert.equal(cldWritten[1].response.response.behavior, 'allow')

        // (c) Bash deny
        cldAdapter.handleControlRequest(mockProc, 'cld-s1', 'claude:cld-s1', tmpDir, {
          type: 'control_request',
          request_id: 'req-bash-3',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'rm -rf /tmp/demo' },
          },
        })
        assert.equal(cldCards[2].kind, 'command')
        await cldAdapter.resolveApproval(cldCards[2].id, 'deny')
        assert.equal(cldWritten[2].response.request_id, 'req-bash-3')
        assert.equal(cldWritten[2].response.response.behavior, 'deny')
        assert.equal(cldEvents.filter((e) => e.ev === EVENTS.APPROVAL_RESOLVED).length, 3)
      }

      // 22.6 MultiAppOrchestrator RPC.APPROVAL_LIST + RPC.APPROVAL_RESOLVE ({ id, decision, answers }) + APPROVAL_RESOLVED cleanup
      {
        const orchEvents = []
        const orch = new MultiAppOrchestrator({
          config: {
            dshHome: join(tmpDir, 'orch-dsh'),
            codexHome: join(tmpDir, 'orch-codex'),
            claudeHome: join(tmpDir, 'orch-claude'),
            agyHome: join(tmpDir, 'orch-agy'),
          },
          log: { info() {}, warn() {}, error() {} },
          onEvent: (ev, payload) => orchEvents.push({ ev, payload }),
        })
        try {
          const mockWriter = { sendRaw: (obj) => mockWriter.sent.push(obj), sent: [] }
          orch.adapters.codex.handleServerRequest(mockWriter, {
            id: 301,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'orch-thr-1',
              questions: [{ id: 'env', question: 'Env?', options: [{ label: 'dev' }, { label: 'prod' }] }],
            },
          })
          const listed = await orch.handleRpc(RPC.APPROVAL_LIST, {})
          assert.equal(listed.approvals.length, 1)
          const aprId = listed.approvals[0].id
          assert.equal(listed.approvals[0].kind, 'question')

          const resolved = await orch.handleRpc(RPC.APPROVAL_RESOLVE, {
            id: aprId,
            decision: 'submit',
            answers: { env: { selected: ['prod'] } },
          })
          assert.equal(resolved.resolved, true)
          assert.deepEqual(mockWriter.sent[0].result, { answers: { env: { answers: ['prod'] } } })
          const afterList = await orch.handleRpc(RPC.APPROVAL_LIST, {})
          assert.equal(afterList.approvals.length, 0)
          assert.ok(orchEvents.some((e) => e.ev === EVENTS.APPROVAL_REQUEST && e.payload?.id === aprId))
          assert.ok(orchEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.payload?.id === aprId))
        } finally {
          await orch.dispose()
        }
      }
    }
    console.log('[smoke] 22/23 Interactive Multi-Question Q&A & Approvals across Codex, DSH (+IPC), Antigravity ACP, Claude Code & Orchestrator OK')

    // 23. Codex external running-state detection (zero-OOM rollout tail probe + giant line resilience + live external watcher)
    {
      const cdxDir = join(tmpDir, 'codex-live-watch')
      mkdirSync(cdxDir, { recursive: true })
      const emptyFile = join(cdxDir, 'empty-thread.jsonl')
      const activeFile = join(cdxDir, 'active-thread.jsonl')
      const giantFile = join(cdxDir, 'giant-screenshot.jsonl')
      const doneFile = join(cdxDir, 'done-thread.jsonl')
      const abortedFile = join(cdxDir, 'aborted-thread.jsonl')

      // (a) Brand-new empty thread (session_meta only) -> idle
      writeFileSync(emptyFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 't-empty' } })}\n`)
      assert.equal(probeCodexRolloutStatus(emptyFile).running, false, 'Empty thread with only session_meta must be idle')

      // (b) Completed thread ending with task_complete (even with trailing metadata rename) -> idle
      writeFileSync(doneFile, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'thread_name_updated', name: 'Renamed' } }),
      ].join('\n') + '\n')
      assert.equal(probeCodexRolloutStatus(doneFile).running, false, 'Completed thread must be idle even after rename metadata')

      // (c) Aborted thread ending with turn_aborted -> idle
      writeFileSync(abortedFile, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' } }),
      ].join('\n') + '\n')
      assert.equal(probeCodexRolloutStatus(abortedFile).running, false, 'Aborted thread must be idle')

      // (d) Active thread mid-tool-execution -> running; stale beyond maxIdleMs -> idle
      writeFileSync(activeFile, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count' } }),
      ].join('\n') + '\n')
      assert.equal(probeCodexRolloutStatus(activeFile).running, true, 'Active thread mid-turn must be detected as running')
      assert.equal(
        probeCodexRolloutStatus(activeFile, { now: Date.now() + 30 * 60_000, maxIdleMs: 20 * 60_000 }).running,
        false,
        'Stale crashed rollout beyond maxIdleMs must never report running',
      )

      // (e) Giant >64KB line (e.g., base64 screenshot) + trailing token_count -> running; once task_complete appended -> idle
      const bigPayload = 'A'.repeat(90 * 1024)
      writeFileSync(giantFile, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: bigPayload } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count' } }),
      ].join('\n') + '\n')
      assert.equal(probeCodexRolloutStatus(giantFile).running, true, 'Giant rollout after >64KB screenshot must still detect running')
      writeFileSync(giantFile, [
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: bigPayload } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count' } }),
        JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
      ].join('\n') + '\n')
      assert.equal(probeCodexRolloutStatus(giantFile).running, false, 'Giant rollout must flip idle immediately on task_complete')

      // (f) Live external watcher on CodexAdapter: watched open chat + tracked sidebar thread transitions
      const cdxWatchEvents = []
      const cdxWatch = new CodexAdapter({
        config: { watchPollIntervalMs: 200 },
        log: { info() {}, warn() {}, debug() {} },
        emitEvent: (ev, payload) => cdxWatchEvents.push({ ev, payload }),
      })
      try {
        cdxWatch.rememberWatchedSession('thr-watch-open', { path: doneFile, title: 'Open Chat', cwd: cdxDir })
        cdxWatch.rememberTrackedListSession('thr-watch-side', { path: abortedFile, title: 'Sidebar Chat', cwd: cdxDir })

        // Desktop starts a task in both threads!
        await new Promise((r) => setTimeout(r, 60))
        writeFileSync(doneFile, [
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } }),
        ].join('\n') + '\n')
        writeFileSync(abortedFile, [
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' } }),
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
        ].join('\n') + '\n')

        for (let i = 0; i < 20; i += 1) {
          const openHit = cdxWatchEvents.some(
            (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === 'thr-watch-open' && e.payload?.session?.status === 'running',
          )
          const sideHit = cdxWatchEvents.some(
            (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === 'thr-watch-side' && e.payload?.session?.status === 'running',
          )
          if (openHit && sideHit) break
          await new Promise((r) => setTimeout(r, 100))
        }
        const openStartEv = cdxWatchEvents.find(
          (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === 'thr-watch-open' && e.payload?.session?.status === 'running',
        )
        const sideStartEv = cdxWatchEvents.find(
          (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === 'thr-watch-side' && e.payload?.session?.status === 'running',
        )
        assert.ok(openStartEv, 'Watched Codex chat must emit SESSION_UPDATED(running) when Desktop starts a turn')
        assert.equal(openStartEv.payload.historyChanged, true)
        assert.equal(openStartEv.payload.statusChanged, true)
        assert.equal(openStartEv.payload.session.syncState?.externalRunning, true)
        assert.ok(sideStartEv, 'Sidebar tracked Codex thread must emit SESSION_UPDATED(running) when Desktop starts a turn')
        assert.equal(sideStartEv.payload.statusChanged, true)

        // Desktop finishes the open chat -> must flip back to idle automatically!
        await new Promise((r) => setTimeout(r, 60))
        writeFileSync(doneFile, [
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
          JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
        ].join('\n') + '\n')
        for (let i = 0; i < 20; i += 1) {
          if (
            cdxWatchEvents.some(
              (e) =>
                e.ev === EVENTS.SESSION_UPDATED &&
                e.payload?.session?.nativeId === 'thr-watch-open' &&
                e.payload?.session?.status === 'idle',
            )
          ) {
            break
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        const openDoneEv = cdxWatchEvents.find(
          (e) =>
            e.ev === EVENTS.SESSION_UPDATED &&
            e.payload?.session?.nativeId === 'thr-watch-open' &&
            e.payload?.session?.status === 'idle',
        )
        assert.ok(openDoneEv, 'Watched Codex chat must flip back to idle automatically on task_complete')
        assert.equal(openDoneEv.payload.session.syncState?.externalRunning, false)
      } finally {
        await cdxWatch.dispose()
      }
    }
    console.log('[smoke] 23/24 Codex external running-state detection (zero-OOM rollout tail probe + giant file + live watcher) OK')

    // 24. Full-Stack v0.5.0 Regression Suite (Relay crash/injection defense, strict E2EE/Base64URL, Desktop Keychain & Intel Mac guard, Mobile 16-key LRU & Codex cache safety)
    {
      // 24.1 Relay HTTP malformed Host must return 400 without crashing relay, and /api/admin/invites returns 401 on missing token
      const badHostStatus = await new Promise((resolveStatus, rejectStatus) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.write('GET /api/health HTTP/1.1\r\nHost: bad:port\r\nConnection: close\r\n\r\n')
        })
        let resp = ''
        sock.on('data', (c) => { resp += c.toString('utf8') })
        sock.on('end', () => resolveStatus(resp.split('\r\n')[0] || ''))
        sock.on('error', rejectStatus)
      })
      assert.match(badHostStatus, /400/, 'Malformed Host header must return HTTP 400 without crashing relay')
      const aliveAfterBadHost = await (await fetch(`${httpBase}/api/health`)).json()
      assert.equal(aliveAfterBadHost.ok, true, 'Relay must stay alive after malformed Host header')
      const noAuthInv = await fetch(`${httpBase}/api/admin/invites`)
      assert.equal(noAuthInv.status, 401, '/api/admin/invites must return 401 without token')

      // 24.2 Strict shared E2EE Base64URL, protocol helpers, and extended QR v11+
      const sampleKey = generateE2eeKey()
      assert.equal(base64UrlToBytes(`${sampleKey}=GARBAGE`), null, 'Trailing garbage after = must be rejected')
      assert.equal(base64UrlToBytes(`${sampleKey}==`), null, 'Extra = padding must be rejected')
      assert.equal(base64UrlToBytes('===='), null, 'Padding-only string must be rejected')
      assert.equal(toEpochMs(new Date('invalid')), 0, 'Invalid Date must return 0, not NaN')
      assert.deepEqual(parseCompositeId({ app: 'codex', sessionId: 'thr-1' }), { app: 'codex', sessionId: 'thr-1' })
      const longQrSvg = renderSharedQrSvg(`https://example.com/${'a'.repeat(240)}`)
      assert.ok(longQrSvg.startsWith('<svg'), 'QR encoder must support >213 byte payloads (Version 11+)')

      // 24.3 Desktop safeStorage decrypt-error protection & Intel Mac ARM64 bricking guard
      const cfgPath = join(tmpDir, 'keychain-locked-cfg.json')
      const workingStore = {
        isAvailable: () => true,
        encrypt: (s) => Buffer.from(`enc:${s}`).toString('base64'),
        decrypt: (b) => {
          const s = Buffer.from(b, 'base64').toString('utf8')
          if (!s.startsWith('enc:')) throw new Error('locked')
          return s.slice(4)
        },
      }
      saveConfigSecure(cfgPath, { roomId: 'usr_demo', bridgeSecret: 'sec123', e2eeKey: sampleKey }, workingStore)
      const lockedStore = {
        isAvailable: () => true,
        encrypt: () => { throw new Error('Keychain locked') },
        decrypt: () => { throw new Error('Keychain locked') },
      }
      const lockedRes = loadConfigWithStatus(cfgPath, lockedStore)
      assert.equal(lockedRes.status, 'decrypt-error', 'Locked keychain must return decrypt-error instead of missing')
      assert.equal(
        pickReleaseAsset([{ name: 'All.in.One-0.5.0-arm64.dmg', browser_download_url: 'https://x/a.dmg' }], 'darwin', 'x64'),
        null,
        'Intel Mac x64 must NEVER fall back to arm64 DMG',
      )

      // 24.4 Mobile 16-key LRU keyring retention, blob preview stripping & Codex cache >120 safety
      let { state: ringState, device: ringDev } = upsertDevice(loadDeviceState(), {
        baseUrl: 'https://example.com/dsh',
        token: 'tok-ring',
        roomId: 'usr_ring',
        username: 'ringuser',
      })
      const ringDevId = ringDev.id
      const addedKids = []
      for (let i = 0; i < 18; i += 1) {
        const k = generateE2eeKey()
        const kid = await computeE2eeKeyId(k)
        addedKids.push(kid)
        ringState = upsertDeviceE2eeKey(ringState, ringDevId, kid, k)
      }
      const ringTarget = ringState.devices.find((d) => d.id === ringDevId)
      const finalKeys = Object.keys(ringTarget?.e2eeKeys || {})
      assert.equal(finalKeys.length, 16, 'Keyring must stay capped at 16 entries')
      assert.ok(finalKeys.includes(addedKids[17]), 'Newest key #18 must be retained in LRU keyring')
      assert.ok(finalKeys.includes(addedKids[16]), 'Newest key #17 must be retained in LRU keyring')
      assert.equal(finalKeys.includes(addedKids[0]), false, 'Oldest key #1 must be evicted')

      const draftKey24 = makeDraftKey('dev24::pc24', 'codex:t24', 'codex')
      saveDraft(draftKey24, {
        text: 'hello',
        attachments: [null, { id: 'a1', filename: 'p.png', mimeType: 'image/png', url: '/api/uploads/a1', localPreviewUrl: 'blob:https://x/123' }],
      })
      const loadedDraft24 = loadDraft(draftKey24)
      assert.equal(loadedDraft24.attachments.length, 1, 'Invalid null attachments must be filtered')
      assert.equal(loadedDraft24.attachments[0].localPreviewUrl, undefined, 'blob: localPreviewUrl must never be persisted')

      const manyCodexMsgs = Array.from({ length: 130 }, (_, idx) => ({ id: `cdx-m-${idx}`, role: idx % 2 ? 'assistant' : 'user', text: `msg ${idx}`, ts: Date.now() + idx }))
      await saveCachedSession('codex:t-over-120', {
        meta: { app: 'codex', id: 'codex:t-over-120' },
        messages: manyCodexMsgs,
        hasMore: false,
        nextCursor: null,
      }, 'scope24')
      const cachedCodex24 = await loadCachedSession('codex:t-over-120', 'scope24')
      assert.equal(cachedCodex24.messages.length, 120)
      assert.equal(cachedCodex24.nextCursor, null, 'Codex >120 cache must NEVER fabricate a numeric cursor')
      assert.equal(cachedCodex24.hasMore, false)
    }
    console.log('[smoke] 24/25 Full-Stack v0.5.0 Regression Suite (Relay crash defense, strict E2EE, Keychain/Intel Mac guard, 16-key LRU & Codex cache) OK')

    // 25. Full-Stack v0.5.1 Regression Suite (401 WS stop, protocol/E2EE parity, Desktop E2EE & autoStartDisabled, setup scripts LF/UTF-8, loginEmail2fa, sessionCache scope & password TOCTOU)
    {
      // 25.1 RelayBridgeLink must stop cleanly on HTTP 401 upgrade rejection (no infinite reconnect loop)
      const unauthStates = []
      const badBridge = new RelayBridgeLink({
        relayUrl: wsBridgeUrl,
        bridgeId: 'revoked-pc',
        roomId: 'usr_nonexistent_room',
        secret: 'invalid-secret-xyz',
        e2eeKey: generateE2eeKey(),
        onRpc: async () => ({}),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        onState: (st, detail) => unauthStates.push({ st, detail }),
      })
      badBridge.start()
      const unauthDeadline = Date.now() + 5_000
      while (Date.now() < unauthDeadline && !unauthStates.some((x) => x.st === 'unauthorized')) {
        await new Promise((r) => setTimeout(r, 30))
      }
      assert.ok(unauthStates.some((x) => x.st === 'unauthorized'), 'Bridge hitting HTTP 401 on /ws/bridge must emit unauthorized')
      assert.equal(badBridge.reconnectTimer, null, 'Unauthorized bridge must NOT schedule reconnect')
      badBridge.stop()

      // 25.2 Shared E2EE whitespace rejection + dsh-mobile-hub protocol.js parity
      assert.equal(base64UrlToBytes('abcd efgh'), null, 'Shared base64UrlToBytes must reject embedded whitespace')
      assert.equal(hubToEpochMs(new Date('invalid')), 0, 'dsh-mobile-hub toEpochMs(Invalid Date) must return 0')
      assert.equal(hubToEpochMs(-123), 0, 'dsh-mobile-hub toEpochMs(negative) must return 0')
      assert.notEqual(hubToEpochMs('2026'), 2026000, 'dsh-mobile-hub toEpochMs("2026") must not treat 4-digit year as epoch seconds')
      assert.deepEqual(
        hubParseCompositeId({ app: 'codex', sessionId: 'thr-25' }),
        { app: 'codex', sessionId: 'thr-25' },
        'dsh-mobile-hub parseCompositeId must support object input',
      )

      // 25.3 DesktopBridgeManager strict E2EE validation & setE2eeKey clearing autoStartDisabled
      const deskStateDir = join(tmpDir, 'desk-25')
      mkdirSync(deskStateDir, { recursive: true })
      const deskCfgPath = join(deskStateDir, 'config.json')
      const deskKey1 = generateE2eeKey()
      const deskKey2 = generateE2eeKey()
      saveConfigSecure(deskCfgPath, {
        mode: 'account',
        roomId: 'usr_desk25',
        bridgeId: 'pc-25',
        bridgeSecret: 'sec-25',
        serverUrl: httpBase,
        e2eeKey: deskKey1,
        autoStartDisabled: true,
      }, null)
      const dm25 = new DesktopBridgeManager({ secretStore: null })
      dm25.stateDir = deskStateDir
      dm25.configPath = deskCfgPath
      dm25.logPath = join(deskStateDir, 'desktop-bridge.log')
      dm25.enabled = true
      dm25.spawnBridgeProcess = async () => {}
      await assert.rejects(
        () => dm25.setE2eeKey('usr_desk25', `${deskKey2}=GARBAGE`),
        /无效的端到端密钥格式/,
        'DesktopBridgeManager.setE2eeKey must reject malformed E2EE key padding',
      )
      await dm25.setE2eeKey('usr_desk25', deskKey2)
      const afterDeskCfg = loadConfigDecrypted(deskCfgPath, null)
      assert.equal(afterDeskCfg.e2eeKey, deskKey2)
      assert.equal(afterDeskCfg.autoStartDisabled, undefined, 'setE2eeKey must clear autoStartDisabled when bridge is enabled')

      // 25.4 Setup scripts LF/UTF-8 & Node 20+ check + unused icon.svg removed
      const distSetupSh = readFileSync(join(process.cwd(), 'packages/mobile-app/dist/setup.sh'))
      assert.equal(distSetupSh.includes(0x0d), false, 'dist/setup.sh must have zero CR (\\r) bytes')
      assert.match(distSetupSh.toString('utf8'), /-lt 20/, 'setup.sh must enforce Node.js v20+')
      const distSetupPs1 = readFileSync(join(process.cwd(), 'packages/mobile-app/dist/setup.ps1'), 'utf8')
      assert.match(distSetupPs1, /UTF8Encoding/, 'setup.ps1 must write Desktop .cmd using UTF-8 (non-ASCII safe)')
      assert.match(distSetupPs1, /-lt 20/, 'setup.ps1 must enforce Node.js v20+')
      assert.equal(existsSync(join(process.cwd(), 'packages/mobile-app/dist/icon.svg')), false, 'Unused icon.svg must not exist in dist/')

      // 25.5 Mobile upsertDevice loginEmail2fa preservation & sessionCache unbridged scope safety
      let st25 = loadDeviceState()
      let r25 = upsertDevice(st25, {
        baseUrl: 'https://example.com/dsh',
        token: 'tok-25a',
        roomId: 'usr_25',
        username: 'u25',
        loginEmail2fa: false,
      })
      r25 = upsertDevice(r25.state, {
        baseUrl: 'https://example.com/dsh',
        token: 'tok-25b',
        roomId: 'usr_25',
        username: 'u25',
        loginEmail2fa: true,
      })
      assert.equal(r25.device.loginEmail2fa, true, 'upsertDevice must update loginEmail2fa on re-login')

      await saveCachedSession('codex:s-unbridged', { meta: { app: 'codex', id: 'codex:s-unbridged' }, messages: [{ id: 'm1', role: 'user', text: 'a', ts: 1 }] }, 'acct25')
      await saveCachedSession('codex:s-bridged', { meta: { app: 'codex', id: 'codex:s-bridged' }, messages: [{ id: 'm2', role: 'user', text: 'b', ts: 2 }] }, 'acct25::pc-1')
      await clearSessionCache('acct25', { prefix: false })
      assert.equal(await loadCachedSession('codex:s-unbridged', 'acct25'), null, 'Unbridged scope must be cleared')
      assert.ok(await loadCachedSession('codex:s-bridged', 'acct25::pc-1'), 'Unbridged non-prefix clear must NOT wipe bridged caches')

      // 25.6 Relay changePasswordAsync TOCTOU protection against concurrent revoke-all
      const inv25 = await (await fetch(`${httpBase}/api/admin/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ note: 'toctou-25' }),
      })).json()
      const reg25 = await (await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'toctou_u25', password: 'InitPassword25!', inviteCode: inv25.invites[0].code }),
      })).json()
      assert.equal(reg25.ok, true)
      const [pwRaceRes, revokeRaceRes] = await Promise.all([
        fetch(`${httpBase}/api/account/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg25.token}` },
          body: JSON.stringify({ currentPassword: 'InitPassword25!', newPassword: 'HijackPassword25!' }),
        }),
        new Promise((resolveRev) =>
          setTimeout(() => {
            resolveRev(
              fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg25.token}` },
                body: JSON.stringify({}),
              }),
            )
          }, 5),
        ),
      ])
      if (revokeRaceRes.status === 200) {
        assert.equal(pwRaceRes.status, 401, 'Stale password change finishing after revoke-all must return 401')
        const verifyOrig = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'toctou_u25', password: 'InitPassword25!' }),
        })).json()
        assert.equal(verifyOrig.ok, true, 'Original password must remain intact after rejected TOCTOU change')
      }
    }
    console.log('[smoke] 25/26 Full-Stack v0.5.1 Regression Suite (401 WS stop, protocol/E2EE parity, Desktop E2EE, LF/UTF-8 scripts, scope safety & password TOCTOU) OK')

    // 26. Claude Desktop (Cowork + Desktop Code) Discovery, Live External Running State, Watcher & Read-Only Guard
    {
      const claudeRoot26 = join(tmpDir, 'claude-desktop-26')
      const claudeHome26 = join(tmpDir, 'claude-home-26')
      const wsDir26 = join(tmpDir, 'ws-civ6')
      mkdirSync(wsDir26, { recursive: true })
      const acctDir = join(claudeRoot26, 'local-agent-mode-sessions', 'org-1', 'acct-1')
      const sessUuid = '5931e05f-6a35-4063-8476-8b305db38304'
      const cliSid = 'fe312cf1-0b14-48b9-a991-7198d20c17d4'
      const sessDir = join(acctDir, '5931e05f')
      const projDir = join(sessDir, '.claude', 'projects', 'session')
      const pidDir = join(sessDir, '.claude', 'sessions')
      mkdirSync(projDir, { recursive: true })
      mkdirSync(pidDir, { recursive: true })

      // Write Cowork metadata + spaces.json + native transcript + active audit.jsonl + live busy PID
      writeFileSync(
        join(acctDir, 'spaces.json'),
        JSON.stringify({ spaces: [{ id: 'sp-1', name: 'Civ6Space', folders: [{ path: wsDir26 }] }] }),
      )
      writeFileSync(
        join(acctDir, `local_${sessUuid}.json`),
        JSON.stringify({
          sessionId: `local_${sessUuid}`,
          cliSessionId: cliSid,
          title: 'Desktop Cowork Live Task',
          initialMessage: 'Run scenario solver',
          model: 'claude-opus-5-5',
          isArchived: false,
          userSelectedFolders: [wsDir26],
          folderMountNames: { [wsDir26]: 'CivilizationVI' },
          spaceId: 'sp-1',
          createdAt: Date.now() - 60_000,
          lastActivityAt: Date.now() - 5_000,
        }),
      )
      // Archived session must be hidden
      writeFileSync(
        join(acctDir, 'local_archived-1111-2222-3333-444444444444.json'),
        JSON.stringify({
          sessionId: 'local_archived-1111-2222-3333-444444444444',
          title: 'Archived Should Hide',
          isArchived: true,
        }),
      )
      const projJsonl = join(projDir, `${cliSid}.jsonl`)
      writeFileSync(
        projJsonl,
        [
          JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run scenario solver' } }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              model: 'claude-opus-5-5',
              content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__workspace__bash', input: { command: 'python run.py' } }],
            },
          }),
        ].join('\n') + '\n',
      )
      const auditJsonl = join(sessDir, 'audit.jsonl')
      writeFileSync(
        auditJsonl,
        [
          JSON.stringify({ type: 'user', uuid: 'u1', client_platform: 'desktop_app', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run scenario solver' } }),
          JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run scenario solver' } }),
          JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', timestamp: new Date().toISOString() }),
          JSON.stringify({ type: 'system', subtype: 'permission_request', uuid: 'perm-1', tool_name: 'mcp__cowork__request_cowork_directory', timestamp: new Date().toISOString() }),
        ].join('\n') + '\n',
      )
      writeFileSync(
        join(pidDir, '999999.json'),
        JSON.stringify({ pid: 999999, sessionId: cliSid, status: 'busy', updatedAt: Date.now(), statusUpdatedAt: Date.now() }),
      )

      // Also verify Desktop Code session merges with ~/.claude/projects and stays writable
      const cliProjDir = join(claudeHome26, 'projects', 'demo-proj')
      mkdirSync(cliProjDir, { recursive: true })
      const codeCliId = '11111111-2222-3333-4444-555555555555'
      writeFileSync(
        join(cliProjDir, `${codeCliId}.jsonl`),
        [
          JSON.stringify({ type: 'user', uuid: 'cu1', cwd: wsDir26, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello code tab' } }),
          JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi from code' }] } }),
        ].join('\n') + '\n',
      )
      const codeAcctDir = join(claudeRoot26, 'claude-code-sessions', 'org-1', 'acct-1')
      mkdirSync(codeAcctDir, { recursive: true })
      writeFileSync(
        join(codeAcctDir, 'local_aaaa1111-2222-3333-4444-555555555555.json'),
        JSON.stringify({
          sessionId: 'local_aaaa1111-2222-3333-4444-555555555555',
          cliSessionId: codeCliId,
          title: 'Desktop Code Enriched Title',
          cwd: wsDir26,
          createdAt: Date.now() - 30_000,
          lastActivityAt: Date.now() - 10_000,
        }),
      )

      const tailProbe = probeClaudeTranscriptTail(auditJsonl)
      assert.equal(tailProbe.running, true, 'audit.jsonl with status=requesting must probe as running')
      assert.equal(tailProbe.waitingPermission, true, 'Unanswered permission_request must set waitingPermission=true')
      assert.equal(tailProbe.permissionTool, 'mcp__cowork__request_cowork_directory')

      const extEvents26 = []
      let fakePidAlive = true
      const claudeDesk = new ClaudeAdapter({
        config: {
          claudeHome: claudeHome26,
          claudeDesktopRoots: [claudeRoot26],
          claudeWatchPollMs: 120,
          checkPidAlive: (pid) => pid === 999999 && fakePidAlive,
        },
        emitEvent: (ev, payload) => extEvents26.push({ ev, payload }),
      })
      try {
        const listed = await claudeDesk.listSessions({ limit: 20 })
        assert.equal(listed.length, 2, 'Must list 1 active Cowork + 1 deduplicated Desktop Code session (hiding archived)')
        const coworkItem = listed.find((s) => s.nativeId === `local_${sessUuid}`)
        assert.ok(coworkItem, 'Cowork session must be discovered')
        assert.equal(coworkItem.title, 'Desktop Cowork Live Task')
        assert.equal(coworkItem.workspace, 'CivilizationVI')
        assert.equal(coworkItem.source, 'claude-desktop-cowork')
        assert.equal(coworkItem.writable, false)
        assert.equal(coworkItem.status, 'running')
        assert.equal(coworkItem.syncState?.externalRunning, true)
        assert.equal(coworkItem.syncState?.waitingPermission, true)

        const codeItem = listed.find((s) => s.nativeId === codeCliId)
        assert.ok(codeItem, 'Desktop Code session must merge with CLI transcript by cliSessionId')
        assert.equal(codeItem.title, 'Desktop Code Enriched Title')
        assert.equal(codeItem.source, 'claude-desktop-code')
        assert.equal(codeItem.writable, true)
        assert.equal(codeItem.status, 'idle')

        const ws26 = await claudeDesk.listWorkspaces()
        assert.ok(ws26.some((w) => w.path === wsDir26), 'Claude Desktop folders must appear in workspaces')

        // Option 1: Cowork session must reject direct sendMessage cleanly with SESSION_READONLY
        await assert.rejects(
          () => claudeDesk.sendMessage(`local_${sessUuid}`, { text: 'should block' }),
          (err) => err?.code === 'SESSION_READONLY',
          'Cowork read-only mirror must reject sendMessage with SESSION_READONLY',
        )

        // Open Cowork session to register watcher, then append completion to audit.jsonl & mark PID idle -> must push SESSION_UPDATED(idle)
        const opened = await claudeDesk.readSession(`local_${sessUuid}`, { limit: 20 })
        assert.equal(opened.status, 'running')
        assert.equal(opened.writable, false)
        assert.equal(opened.messages.length, 2)

        fakePidAlive = false
        writeFileSync(
          auditJsonl,
          readFileSync(auditJsonl, 'utf8') +
            JSON.stringify({ type: 'system', subtype: 'permission_response', uuid: 'perm-1', granted: true, timestamp: new Date().toISOString() }) + '\n' +
            JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Achievement unlocked!' }] } }) + '\n' +
            JSON.stringify({ type: 'result', subtype: 'success', timestamp: new Date().toISOString() }) + '\n',
        )
        const deadline26 = Date.now() + 3_000
        while (
          Date.now() < deadline26 &&
          !extEvents26.some(
            (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === `local_${sessUuid}` && e.payload?.session?.status === 'idle',
          )
        ) {
          await new Promise((r) => setTimeout(r, 60))
        }
        const doneEv26 = extEvents26.find(
          (e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.session?.nativeId === `local_${sessUuid}` && e.payload?.session?.status === 'idle',
        )
        assert.ok(doneEv26, 'Claude Desktop watcher must emit SESSION_UPDATED(idle) when Cowork turn completes')
        assert.equal(doneEv26.payload.session.syncState?.externalRunning, false)
        assert.equal(doneEv26.payload.session.syncState?.waitingPermission, undefined)
      } finally {
        await claudeDesk.dispose()
      }
      assert.equal(probeClaudeExternalStatus({ auditPath: auditJsonl }).running, false)
    }
    console.log('[smoke] 26/27 Claude Desktop (Cowork + Code) discovery, live external running/permission state, watcher & read-only guard OK')

    // 27. Subscription Weekly Quota Normalization (Codex Pro/Plus + Claude rate_limit_event) & Zero-Knowledge Relay Stripping
    {
      const futureResetSec = Math.floor(Date.now() / 1000) + 3 * 86400
      const proQuota = normalizeCodexQuota({
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: futureResetSec },
          secondary: null,
        },
      })
      assert.equal(proQuota.remainingPercent, 82, 'Codex Pro weekly remaining percent must be 100 - 18 = 82')
      assert.equal(proQuota.windowKind, 'weekly')
      assert.equal(proQuota.planType, 'pro')

      // Plus/Team plan: primary is 5h (300m), secondary is 7d (10080m) -> weekly must be primary display, 5h in shortWindow
      const plusQuota = normalizeCodexQuota({
        rateLimits: {
          planType: 'plus',
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: futureResetSec },
          secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: futureResetSec },
        },
      })
      assert.equal(plusQuota.remainingPercent, 36, 'Codex Plus must select 7-day weekly secondary window as main display')
      assert.equal(plusQuota.windowKind, 'weekly')
      assert.equal(plusQuota.shortWindow?.remainingPercent, 90, 'Codex Plus 5h window must be preserved in shortWindow')
      assert.equal(normalizeCodexQuota({ rateLimits: { primary: null, secondary: null } }), null, 'Missing quota must normalize to null')

      // Claude rate_limit_event (fraction 0..1)
      const claudeWeekly = normalizeClaudeQuota({ rateLimitType: 'seven_day', utilization: 0.27, resetsAt: futureResetSec })
      assert.equal(claudeWeekly.remainingPercent, 73)
      assert.equal(claudeWeekly.windowKind, 'weekly')
      assert.equal(normalizeClaudeQuota({ rateLimitType: 'seven_day', status: 'allowed' }), null, 'Missing numeric utilization must return null')

      // Zero-knowledge check: RelayBridgeLink.setAppsMeta must strip `quota` before sending plaintext bridge.meta
      const zkLink = new RelayBridgeLink({
        relayUrl: wsBridgeUrl,
        bridgeId: 'zk-quota-pc',
        roomId: 'usr_zk_test',
        secret: 'sec',
        e2eeKey: generateE2eeKey(),
        onRpc: async () => ({}),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      zkLink.sendBridgeMeta = async () => {}
      zkLink.setAppsMeta([{ app: 'codex', available: true, writable: true, quota: proQuota }])
      assert.equal(zkLink.metaApps[0].quota, undefined, 'Plaintext bridge.meta.apps sent to Relay must NEVER include subscription quota')
    }
    console.log('[smoke] 27/27 Subscription weekly quota normalization (Codex Pro/Plus + Claude) & zero-knowledge Relay stripping OK')

    // 28. Antigravity Gemini-Only Weekly Quota Normalization & Disk Cache Hydration
    {
      const futureIso = new Date(Date.now() + 5 * 86400 * 1000).toISOString()
      const future5hIso = new Date(Date.now() + 3 * 3600 * 1000).toISOString()
      const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString()

      const agyQuota = normalizeAntigravityQuota({
        quota: {
          '3p-5h': { remaining_fraction: 1, disabled: true },
          '3p-weekly': { remaining_fraction: 0 },
          'gemini-5h': { remaining_fraction: 0.8405911, reset_time: future5hIso },
          'gemini-weekly': { remaining_fraction: 0.92589515, reset_time: futureIso },
        },
      })
      assert.ok(agyQuota, 'Valid Antigravity statusLine payload must normalize')
      assert.equal(agyQuota.remainingPercent, 93, 'Must strictly pick gemini-weekly (93%), ignoring 3p-weekly (0%)')
      assert.equal(agyQuota.usedPercent, 7)
      assert.equal(agyQuota.windowKind, 'weekly')
      assert.equal(agyQuota.bucketLabel, 'Gemini')
      assert.equal(agyQuota.shortWindow?.remainingPercent, 84, 'gemini-5h must be preserved in shortWindow for tooltip')

      // Only 3p buckets without gemini-weekly -> must return null
      assert.equal(
        normalizeAntigravityQuota({ quota: { '3p-weekly': { remaining_fraction: 0.5 } } }),
        null,
        'Missing gemini-weekly bucket must return null',
      )
      // Disabled gemini-weekly -> must return null
      assert.equal(
        normalizeAntigravityQuota({ quota: { 'gemini-weekly': { remaining_fraction: 0.9, disabled: true } } }),
        null,
        'Disabled gemini-weekly bucket must return null',
      )
      // Expired gemini-weekly -> must return null
      assert.equal(
        normalizeAntigravityQuota({ quota: { 'gemini-weekly': { remaining_fraction: 0.5, reset_time: pastIso } } }),
        null,
        'Expired gemini-weekly bucket must return null',
      )

      // Disk cache hydration in AntigravityAdapter.getStatus() without blocking
      const agyCachePath28 = join(tmpDir, 'agy-quota-cache-28.json')
      writeFileSync(agyCachePath28, JSON.stringify(agyQuota), 'utf8')
      const agyAdapter28 = new AntigravityAdapter({
        config: {
          agyHome: join(tmpDir, 'agy-home-28'),
          agyQuotaCachePath: agyCachePath28,
          disableAgyQuotaProbe: true,
        },
      })
      try {
        const st28 = await agyAdapter28.getStatus()
        assert.equal(st28.quota?.remainingPercent, 93, 'AntigravityAdapter.getStatus() must hydrate cached Gemini weekly quota immediately')
        assert.equal(st28.quota?.bucketLabel, 'Gemini')
      } finally {
        await agyAdapter28.dispose()
      }
    }
    console.log('[smoke] 28/28 Antigravity Gemini-only weekly quota normalization & non-blocking disk cache OK')

    // 29. DSH Two-Way Prompt Sync: answering in All in One must abort DSH Desktop's downstream `next()` signal without aborting the parent Turn
    {
      const dshSyncCards = []
      const dshSyncEvents = []
      const listeners = new Map()
      const mockCtx = {
        agents: {},
        on: (name, fn) => {
          listeners.set(name, fn)
          return () => listeners.delete(name)
        },
      }
      const dshSync = new DshAdapter({
        ctx: mockCtx,
        config: { dshHome: join(tmpDir, 'dsh-sync-29') },
        log: { info() {}, warn() {}, error() {} },
        emitEvent: (ev, payload) => dshSyncEvents.push({ ev, payload }),
        onApprovalRequest: (card) => dshSyncCards.push(card),
      })

      try {
        // 29.1 Legacy user-questions/request: mobile answers first -> downstream desktop signal aborts cleanly, parent signal stays intact
        const parentAc1 = new AbortController()
        const req1 = {
          agent: { id: 'sync-s1', session: { id: 'sync-s1' } },
          signal: parentAc1.signal,
          questions: [
            {
              id: 'choice',
              question: 'Pick a target',
              options: [{ label: 'Alpha' }, { label: 'Beta' }],
            },
          ],
        }
        let desktopSignal1 = null
        let desktopCancelCount1 = 0
        const qPromise1 = listeners.get('user-questions/request')(req1, () => new Promise((_, reject) => {
          desktopSignal1 = req1.signal
          desktopSignal1.addEventListener('abort', () => {
            desktopCancelCount1 += 1
            reject(new Error('cancelled by host'))
          }, { once: true })
        }))
        await new Promise((r) => setTimeout(r, 15))
        assert.ok(desktopSignal1 && desktopSignal1 !== parentAc1.signal, 'Downstream next() must receive a child AbortSignal')
        assert.equal(desktopSignal1.aborted, false)
        const card1 = dshSyncCards.pop()
        await dshSync.resolveApproval(card1.id, { decision: 'submit', answers: { choice: { selected: ['Beta'] } } })
        const res1 = await qPromise1
        assert.deepEqual(res1, { answers: [{ id: 'choice', selected: ['Beta'] }] })
        assert.equal(desktopSignal1.aborted, true, 'DSH Desktop downstream signal MUST abort when All in One answers')
        assert.equal(desktopCancelCount1, 1, 'DSH Desktop cancel listener must fire exactly once')
        assert.equal(parentAc1.signal.aborted, false, 'Parent Turn signal must NEVER be aborted when mobile answers')
        await new Promise((r) => setTimeout(r, 15))
        assert.equal(req1.signal, parentAc1.signal, 'request.signal must be restored to original parent signal')

        // 29.2 Non-timed question with wait.callId: desktop cancel fires BEFORE promise resolves (so Desktop reconcile removes card!)
        const parentAc2 = new AbortController()
        const req2 = {
          agent: { id: 'sync-s2', session: { id: 'sync-s2' } },
          signal: parentAc2.signal,
          wait: { callId: 'call-sync-2' },
          questions: [{ id: 'q2', question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }
        const order2 = []
        const qPromise2 = listeners.get('user-questions/request')(req2, () => new Promise((_, reject) => {
          req2.signal.addEventListener('abort', () => {
            order2.push('desktop-cancel')
            reject(new Error('cancelled'))
          }, { once: true })
        })).then((res) => {
          order2.push('tool-resolved')
          return res
        })
        await new Promise((r) => setTimeout(r, 15))
        const card2 = dshSyncCards.pop()
        await dshSync.resolveApproval(card2.id, { decision: 'submit', answers: { q2: { selected: ['Yes'] } } })
        const res2 = await qPromise2
        assert.deepEqual(res2, { answers: [{ id: 'q2', selected: ['Yes'] }] })
        assert.deepEqual(order2, ['desktop-cancel', 'tool-resolved'], 'Desktop cancel must fire before tool resolution')
        assert.equal(req2.signal, parentAc2.signal)

        // 29.3 approval/request: mobile approves first -> downstream desktop approval signal aborts cleanly, parent stays intact
        const parentAc3 = new AbortController()
        const req3 = {
          agent: { id: 'sync-s3', session: { id: 'sync-s3', meta: { cwd: tmpDir } } },
          signal: parentAc3.signal,
          toolName: 'bash',
          reason: 'run build',
        }
        let desktopSignal3 = null
        const aprPromise3 = listeners.get('approval/request')(req3, () => new Promise((_, reject) => {
          desktopSignal3 = req3.signal
          desktopSignal3.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }))
        await new Promise((r) => setTimeout(r, 15))
        assert.ok(desktopSignal3 && desktopSignal3 !== parentAc3.signal)
        const card3 = dshSyncCards.pop()
        await dshSync.resolveApproval(card3.id, 'allowed-once')
        const res3 = await aprPromise3
        assert.equal(res3, 'allowed-once')
        assert.equal(desktopSignal3.aborted, true, 'DSH Desktop approval signal MUST abort when All in One resolves')
        assert.equal(parentAc3.signal.aborted, false, 'Parent approval signal must stay intact')

        // 29.4 Reverse direction: parent abort must propagate to DSH Desktop AND clear All in One card
        const parentAc4 = new AbortController()
        const req4 = {
          agent: { id: 'sync-s4', session: { id: 'sync-s4' } },
          signal: parentAc4.signal,
          questions: [{ id: 'q4', question: 'Abort me', options: [{ label: 'A' }] }],
        }
        let desktopSignal4 = null
        const qPromise4 = listeners.get('user-questions/request')(req4, () => new Promise(() => {
          desktopSignal4 = req4.signal
        }))
        await new Promise((r) => setTimeout(r, 15))
        const card4 = dshSyncCards.pop()
        parentAc4.abort(new Error('turn stopped'))
        await assert.rejects(() => qPromise4, /turn stopped/)
        assert.equal(desktopSignal4.aborted, true, 'Parent abort must propagate to DSH Desktop child signal')
        assert.ok(
          dshSyncEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.payload?.id === card4.id),
          'Parent abort must emit APPROVAL_RESOLVED to clear All in One card',
        )
      } finally {
        await dshSync.dispose()
      }
    }
    console.log('[smoke] 29/29 DSH two-way prompt & approval sync (downstream Desktop cancel on remote answer + parent abort propagation) OK')

    // 30. Codex Async Questions (`request_user_input_async`), `turn/steer` delivery, rollout extraction & pretty reply formatting
    {
      const callId30 = 'call_async_smoke_30'
      const card30 = normalizeCodexAsyncQuestionCard('thr-async-30', {
        id: callId30,
        delivery: 'async',
        questions: [{ title: '今晚的菜单，你想走哪种口味？', options: ['香辣下饭', '清淡鲜甜', '酸甜开胃'] }],
      })
      assert.ok(card30)
      assert.equal(card30.id, `cdx-aq-${callId30}`)
      assert.equal(card30.kind, 'question')
      assert.equal(card30.questions.length, 1)
      assert.deepEqual(card30.questions[0].options.map((o) => o.label), ['香辣下饭', '清淡鲜甜', '酸甜开胃'])
      assert.equal(card30.readOnlyHint, undefined)

      const lockedCard30 = normalizeCodexAsyncQuestionCard(
        'thr-async-30',
        { id: callId30, questions: [{ title: 'Pick one', options: ['A', 'B'] }] },
        { externalRunning: true },
      )
      assert.equal(lockedCard30.readOnlyHint, 'desktop-running')
      assert.ok(lockedCard30.detail.includes('电脑端'))

      const replyWire = buildCodexQuestionReplyText(callId30, card30.questions, { q_0: { selected: ['香辣下饭'] } })
      const parsedReply = parseCodexQuestionReply(replyWire)
      assert.ok(parsedReply)
      assert.equal(parsedReply.entries[0].answer, '香辣下饭')
      assert.equal(parsedReply.callIds.has(callId30), true)
      assert.equal(formatCodexQuestionReplyForDisplay(replyWire), '已选择：香辣下饭')

      // Rollout tail extraction: unanswered -> detected; after reply -> cleared
      const rollout30 = join(tmpDir, 'rollout-async-30.jsonl')
      writeFileSync(
        rollout30,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'AgentMessage',
              id: callId30,
              delivery: 'async',
              content: [{ type: 'Text', text: '今晚的菜单？\n- 香辣下饭' }],
              questions: [{ title: '今晚的菜单，你想走哪种口味？', options: ['香辣下饭', '清淡鲜甜'] }],
            },
          },
        }) + '\n',
      )
      const pending30 = extractPendingCodexAsyncQuestionFromRollout(rollout30)
      assert.equal(pending30?.id, callId30, 'Unanswered async question in rollout must be extracted')

      writeFileSync(
        rollout30,
        readFileSync(rollout30, 'utf8') +
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              item: {
                type: 'UserMessage',
                id: 'u-reply-30',
                content: [{ type: 'text', text: replyWire }],
              },
            },
          }) + '\n',
      )
      assert.equal(
        extractPendingCodexAsyncQuestionFromRollout(rollout30),
        null,
        'Answered async question must no longer be pending',
      )

      // Live CodexAdapter `item/completed` -> `turn/steer` when active, and post-turn `sendMessage` / `cancel` when idle
      const asyncCards = []
      const asyncEvents = []
      const cdxAsync = new CodexAdapter({
        config: {},
        log: { info() {}, warn() {}, error() {} },
        emitEvent: (ev, payload) => asyncEvents.push({ ev, payload }),
        onApprovalRequest: (c) => asyncCards.push(c),
      })
      try {
        const steeredCalls = []
        cdxAsync.activeTurns.set('thr-live-30', {
          writer: {
            rpc: async (method, params) => {
              steeredCalls.push({ method, params })
              return { ok: true }
            },
          },
          turnId: 'turn-live-30',
          cwd: tmpDir,
          textBuffer: '',
          aborted: false,
          settled: false,
        })
        cdxAsync.handleNotification('item/completed', {
          threadId: 'thr-live-30',
          item: {
            type: 'agentMessage',
            id: 'call_live_steer_30',
            delivery: 'async',
            text: 'Choose flavor',
            questions: [{ title: 'Choose flavor', options: ['Spicy', 'Mild'] }],
          },
        })
        assert.equal(asyncCards.length, 1)
        const liveCard = asyncCards[0]
        const steerRes = await cdxAsync.resolveApproval(liveCard.id, {
          decision: 'submit',
          answers: { q_0: { selected: ['Spicy'] } },
        })
        assert.equal(steerRes.resolved, true)
        assert.equal(steerRes.steered, true)
        assert.equal(steeredCalls.length, 1)
        assert.equal(steeredCalls[0].method, 'turn/steer')
        assert.equal(steeredCalls[0].params.expectedTurnId, 'turn-live-30')
        assert.ok(steeredCalls[0].params.input[0].text.includes('<send_user_message_question_reply>'))
        assert.ok(steeredCalls[0].params.input[0].text.includes('Spicy'))

        // Idle post-turn async question: Skip dismisses locally without sending a turn
        cdxAsync.activeTurns.delete('thr-live-30')
        cdxAsync.registerAsyncQuestionPrompt('thr-idle-30', {
          id: 'call_idle_skip_30',
          questions: [{ title: 'Optional?', options: ['A', 'B'] }],
        })
        const idleCard = asyncCards.find((c) => c.callId === 'call_idle_skip_30')
        assert.ok(idleCard)
        const skipRes = await cdxAsync.resolveApproval(idleCard.id, { decision: 'cancel', answers: {} })
        assert.equal(skipRes.resolved, true)
        assert.equal(cdxAsync.dismissedAsyncQuestions.has('call_idle_skip_30'), true)
        assert.ok(asyncEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.payload?.id === idleCard.id))
      } finally {
        await cdxAsync.dispose()
      }
    }
    console.log('[smoke] 30/30 Codex async questions (request_user_input_async), turn/steer delivery, rollout extraction & pretty reply OK')

    // 31. Mobile-to-Desktop E2EE QR Scan Nudge (same-room delivery, rate limit, room isolation & disconnect cleanup)
    {
      const nudgePc = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'Smoke-Desktop', clientKind: 'desktop' })
      const nudgePhone = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'iPhone · Safari', clientKind: 'mobile' })
      const nudgeOther = await openTicketClientWs(httpBase, port, friendB.token, { deviceName: 'Other-Account-PC', clientKind: 'desktop' })
      try {
        const waitForNudge = (cli, predicate, timeoutMs = 3000) =>
          new Promise((resolve, reject) => {
            const start = Date.now()
            const check = () => {
              const hit = cli.events.find((e) => e.event === EVENTS.E2EE_QR_NUDGE && predicate(e.payload || {}))
              if (hit) {
                resolve(hit.payload)
                return
              }
              if (Date.now() - start > timeoutMs) {
                reject(new Error('Timed out waiting for e2ee.qr.nudge'))
                return
              }
              setTimeout(check, 25)
            }
            check()
          })

        // 31a. Mobile sends scanning nudge -> same-room PC receives it, sender & other account do NOT
        nudgePhone.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: '0123456789abcdef' }))
        const received = await waitForNudge(nudgePc, (p) => p.action === 'scanning')
        assert.equal(received.deviceName, 'iPhone · Safari')
        assert.equal(received.wantedKeyId, '0123456789abcdef')
        assert.equal(received.requesterClientId, nudgePhone.hello.clientId)

        // 31b. Rapid duplicate scanning nudge within 4s is rate-limited; invalid wantedKeyId is ignored
        nudgePhone.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: '0123456789abcdef' }))
        nudgePhone.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: 'not-valid-hex!' }))
        await new Promise((r) => setTimeout(r, 120))
        const pcScanningNudges = nudgePc.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE && e.payload?.action === 'scanning')
        assert.equal(pcScanningNudges.length, 1, 'Duplicate rapid scanning nudges must be rate-limited')
        assert.equal(
          nudgePhone.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE).length,
          0,
          'Sender must never receive its own QR nudge echo',
        )
        assert.equal(
          nudgeOther.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE).length,
          0,
          'Cross-account clients must NEVER receive another account QR nudge',
        )

        // 31c. Disconnecting the nudging mobile client automatically sends `action: done` to PC
        nudgePhone.ws.close()
        const donePayload = await waitForNudge(nudgePc, (p) => p.action === 'done')
        assert.equal(donePayload.requesterClientId, nudgePhone.hello.clientId)
      } finally {
        try { nudgePc.ws.close() } catch {}
        try { nudgePhone.ws.close() } catch {}
        try { nudgeOther.ws.close() } catch {}
      }
    }
    console.log('[smoke] 31/31 Mobile-to-Desktop E2EE QR scan nudge (isolation, rate limit & disconnect cleanup) OK')

    console.log('\nALL SMOKE TESTS PASSED!')
  } finally {
    if (acctPortableChild) {
      try { acctPortableChild.kill() } catch {}
    }
    if (acctBridge2) await acctBridge2.stop()
    if (ownerBridge2) await ownerBridge2.stop()
    if (friendBridgeA) await friendBridgeA.stop()
    if (bridge) await bridge.stop()
    await relay.close()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
