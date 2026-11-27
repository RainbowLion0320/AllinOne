import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createRelayServer } from '../../packages/relay-server/src/index.js'
import { CTRL_FRAG_LIMIT_BYTES, createCtrlCodec } from '../../packages/shared/src/p2p-mux.js'
import { startStandaloneBridge } from '../../packages/dsh-mobile-hub/standalone.js'
import { RelayBridgeLink } from '../../packages/dsh-mobile-hub/src/ws-client.js'
import {
  parseCompositeId as hubParseCompositeId,
  toEpochMs as hubToEpochMs,
} from '../../packages/dsh-mobile-hub/src/protocol.js'
import { EVENTS, RPC, parseCompositeId, toEpochMs } from '../../packages/shared/src/protocol.js'
import {
  base64UrlToBytes,
  computeE2eeKeyId,
  decryptBinaryJson,
  decryptJson,
  encodeE2eeQrUri,
  encryptBinaryJson,
  encryptJson,
  formatE2eeFingerprint,
  generateE2eeKey,
  parseE2eeQrInput,
} from '../../packages/shared/src/e2ee.js'
import { renderQrSvg as renderSharedQrSvg } from '../../packages/shared/src/qr-svg.js'
import {
  SMOKE_ADMIN_PASS,
  TEST_BOOTSTRAP_TOKEN,
  connectMockBridgeWs,
  createIsolatedRelayEnv,
  openTicketClientWs,
} from './harness.mjs'

test('Suite 1: Account bootstrap, open registration, daily cap, multi-tenant isolation, device lifecycle & portable CLI', async () => {
  const env = await createIsolatedRelayEnv('allinone-int-01-acct-')
  const { tmpDir, accountsFile, relay, port, httpBase } = env

  try {
    const bootBefore = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootBefore.ok, true)
    assert.equal(bootBefore.hasUsers, false, 'Fresh server should report hasUsers=false')
    assert.equal(bootBefore.hasAdmin, false, 'Fresh server should report hasAdmin=false')
    assert.equal(bootBefore.needsBootstrapToken, true, 'Server with ADMIN_BOOTSTRAP_TOKEN must require bootstrapToken')
    assert.equal(bootBefore.openRegistration, true)
    assert.equal(bootBefore.dailyRegistrationLimit, 20, 'Default daily registration limit must be 20')
    assert.equal(bootBefore.dailyRegistrationsUsed, 0)
    assert.equal(bootBefore.dailyRegistrationRemaining, 20)
    assert.equal(bootBefore.emailEnabled, false, 'Unconfigured relay must report emailEnabled=false')

    const noEmailSendRes = await fetch(`${httpBase}/api/account/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'reset', email: 'test@example.com' }),
    })
    assert.equal(noEmailSendRes.status, 503, 'Unconfigured relay must reject send-code with 503')

    const badReg = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'Password123!', bootstrapToken: 'WRONG-TOKEN' }),
    })
    assert.equal(badReg.status, 400, 'First-admin registration with invalid bootstrapToken must fail')

    const smokeAdmin = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'smoke_admin',
          password: SMOKE_ADMIN_PASS,
          bootstrapToken: TEST_BOOTSTRAP_TOKEN,
          deviceName: 'smoke-phone',
        }),
      })
    ).json()
    assert.equal(smokeAdmin.ok, true)
    assert.equal(smokeAdmin.user.role, 'admin')
    assert.ok(smokeAdmin.roomId.startsWith('usr_'))

    const bootAfter = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootAfter.hasUsers, true)
    assert.equal(bootAfter.hasAdmin, true)
    assert.equal(bootAfter.needsBootstrapToken, false)
    assert.equal(bootAfter.dailyRegistrationsUsed, 1)
    assert.equal(bootAfter.dailyRegistrationRemaining, 19)
    const accountsDbFile = accountsFile.replace(/\.json$/i, '.db')
    const readAccountsStorageBytes = () =>
      Buffer.concat(
        [accountsDbFile, `${accountsDbFile}-wal`]
          .filter((p) => existsSync(p))
          .map((p) => readFileSync(p)),
      )
    assert.equal(
      readAccountsStorageBytes().includes(Buffer.from(SMOKE_ADMIN_PASS)),
      false,
      'SQLite accounts.db must never store plaintext password',
    )

    // Login & wrong-password rejection
    const loginRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'smoke-phone' }),
    })
    assert.equal(loginRes.status, 200)
    const loginData = await loginRes.json()
    assert.equal(loginData.ok, true)
    assert.ok(loginData.token)

    const badPassRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: 'wrong-password' }),
    })
    assert.equal(badPassRes.status, 401)

    // Public /api/health zero-leakage & security headers
    const pubHealthRes = await fetch(`${httpBase}/api/health`)
    const pubHealth = await pubHealthRes.json()
    assert.equal(pubHealth.ok, true)
    assert.equal(pubHealth.bridges, undefined)
    assert.equal(pubHealth.onlineBridges, undefined)
    assert.equal(pubHealth.clients, undefined)
    assert.equal(pubHealth.rooms, undefined)
    assert.equal(pubHealthRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(pubHealthRes.headers.get('x-frame-options'), 'DENY')
    assert.equal(pubHealthRes.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(String(pubHealthRes.headers.get('permissions-policy') || '').includes('camera=(self)'))

    // Removed legacy invite endpoints must return 404
    assert.equal(
      (await fetch(`${httpBase}/api/admin/invites`, { headers: { Authorization: `Bearer ${loginData.token}` } })).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${httpBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
          body: JSON.stringify({ count: 1 }),
        })
      ).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${httpBase}/api/admin/invites/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
          body: JSON.stringify({ id: 'inv_1' }),
        })
      ).status,
      404,
    )

    // Open registration creates regular free users with isolated rooms; admin routes reject non-admins (403)
    const friendA = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'friend_a', password: 'FriendAPass99!' }),
      })
    ).json()
    assert.equal(friendA.ok, true)
    assert.equal(friendA.user.role, 'user')
    assert.equal(friendA.user.tier, 'free')

    const nonAdminOv = await fetch(`${httpBase}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${friendA.token}` },
    })
    assert.equal(nonAdminOv.status, 403, 'Non-admin user must receive 403 on /api/admin/overview')

    const friendB = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'friend_b', password: 'FriendBPass99!' }),
      })
    ).json()
    assert.equal(friendB.ok, true)
    assert.equal(friendB.user.role, 'user')
    assert.notEqual(friendA.roomId, friendB.roomId)

    // Daily registration cap enforcement + first-user auto-admin (no bootstrap token) + concurrent burst race defense
    {
      const capRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'smoke-cap-jwt-secret-0123456',
        accountsFile: join(tmpDir, 'cap-accounts.json'),
        stunEnabled: false,
        maxDailyRegistrations: 2,
      })
      const { port: capPort } = await capRelay.start()
      const capBase = `http://127.0.0.1:${capPort}`
      try {
        const capBoot = await (await fetch(`${capBase}/api/account/bootstrap-status`)).json()
        assert.equal(capBoot.hasAdmin, false)
        assert.equal(capBoot.needsBootstrapToken, false)
        assert.equal(capBoot.dailyRegistrationLimit, 2)
        assert.equal(capBoot.dailyRegistrationsUsed, 0)
        assert.equal(capBoot.dailyRegistrationRemaining, 2)

        const firstAutoAdmin = await (
          await fetch(`${capBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'cap_admin', password: 'CapPassword123!' }),
          })
        ).json()
        assert.equal(firstAutoAdmin.ok, true)
        assert.equal(firstAutoAdmin.user.role, 'admin')

        // Fire 4 concurrent open registrations when only 1 daily slot remains -> strictly 1 succeeds, 3 hit 429
        const burstResults = await Promise.all(
          [1, 2, 3, 4].map(async (i) => {
            const r = await fetch(`${capBase}/api/account/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: `cap_user_${i}`, password: 'CapPassword123!' }),
            })
            return { status: r.status, body: await r.json() }
          }),
        )
        const okCount = burstResults.filter((x) => x.status === 200 && x.body.ok === true).length
        const cap429 = burstResults.filter((x) => x.status === 429 && x.body.code === 'DAILY_REGISTRATION_LIMIT')
        assert.equal(okCount, 1, 'Exactly 1 concurrent open registration must fill the last daily slot')
        assert.equal(cap429.length, 3, 'All excess concurrent registrations must fail with 429 DAILY_REGISTRATION_LIMIT')

        const capBootFull = await (await fetch(`${capBase}/api/account/bootstrap-status`)).json()
        assert.equal(capBootFull.dailyRegistrationsUsed, 2)
        assert.equal(capBootFull.dailyRegistrationRemaining, 0)
      } finally {
        await capRelay.close()
      }
    }

    // Device registration (`app://allinone` CORS), `device-login`, rename, unbind & multi-tenant bridge isolation
    const smokeDevRes = await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
        Origin: 'app://allinone',
      },
      body: JSON.stringify({ label: 'Smoke-PC-1', hostname: 'smoke-pc', platform: process.platform }),
    })
    assert.equal(smokeDevRes.status, 200)
    assert.equal(smokeDevRes.headers.get('access-control-allow-origin'), 'app://allinone')
    const smokeDev = await smokeDevRes.json()
    assert.equal(smokeDev.ok, true)
    assert.ok(smokeDev.deviceSecret.startsWith('dv_'))
    assert.equal(
      readAccountsStorageBytes().includes(Buffer.from(smokeDev.deviceSecret)),
      false,
      'SQLite accounts.db must never store plaintext deviceSecret',
    )

    const tempPc = await (
      await fetch(`${httpBase}/api/account/device-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'smoke_admin',
          password: SMOKE_ADMIN_PASS,
          label: 'Temp-Desktop',
          hostname: 'TEMP-WIN',
          platform: 'win32',
        }),
      })
    ).json()
    assert.equal(tempPc.ok, true)
    const renamedPc = await (
      await fetch(`${httpBase}/api/account/devices/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ deviceId: tempPc.deviceId, label: 'Home-Workstation' }),
      })
    ).json()
    assert.equal(renamedPc.device.label, 'Home-Workstation')

    const removedPc = await (
      await fetch(`${httpBase}/api/account/devices/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ deviceId: tempPc.deviceId }),
      })
    ).json()
    assert.equal(removedPc.ok, true)
    const statusAfterRemove = await fetch(`${httpBase}/api/account/device-status`, {
      headers: { 'X-Room-Id': tempPc.roomId, 'X-Bridge-Secret': tempPc.deviceSecret },
    })
    assert.equal(statusAfterRemove.status, 401, 'Unbound PC deviceSecret must immediately return 401')

    // Multi-tenant isolation using a lightweight mock bridge for Friend A
    const friendDevA = await (
      await fetch(`${httpBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${friendA.token}` },
        body: JSON.stringify({ label: 'Friend-A-PC', hostname: 'friend-a-pc', platform: 'darwin' }),
      })
    ).json()
    const friendBrA = await connectMockBridgeWs(port, {
      roomId: friendA.roomId,
      deviceSecret: friendDevA.deviceSecret,
      bridgeId: friendDevA.bridgeId,
      hostname: 'friend-a-pc',
      platform: 'darwin',
    })
    try {
      for (let i = 0; i < 30; i += 1) {
        if (relay.hub.getBridgeList(friendA.roomId).some((b) => b.online && b.e2ee?.enabled)) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.equal(relay.hub.getBridgeList(friendA.roomId).length, 1)
      assert.equal(relay.hub.getBridgeList(friendB.roomId).length, 0, 'Friend B must never see Friend A bridges')
      const meA = await (
        await fetch(`${httpBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${friendA.token}` },
        })
      ).json()
      assert.equal(meA.username, 'friend_a')
      assert.equal(meA.bridges.length, 1)
      assert.equal(meA.bridges[0].online, true)
      const wsA = await openTicketClientWs(httpBase, port, friendA.token, { deviceName: 'friend-a-phone' })
      assert.equal(wsA.hello.roomId, friendA.roomId)
      assert.equal(wsA.hello.bridges[0].bridgeId, friendDevA.bridgeId)
      await wsA.closeAll()
    } finally {
      try { friendBrA.ws.close() } catch {}
    }

    // Portable single-file CLI bundle smoke check (never persists password; auto-generates mandatory e2eeKey)
    const bundlePath = join(process.cwd(), 'packages/mobile-app/public/downloads/allinone-bridge.mjs')
    if (existsSync(bundlePath)) {
      const cliStateDir = join(tmpDir, 'portable-account-home')
      const childEnv = { ...process.env, ALLINONE_NO_AUTOFIX: '1' }
      delete childEnv.ALLINONE_E2EE_KEY
      delete childEnv.ALLINONE_BRIDGE_SECRET
      const child = spawn(
        process.execPath,
        [
          bundlePath,
          '--server',
          httpBase,
          '--state-dir',
          cliStateDir,
          '--name',
          'FriendB-Mac',
          '--username',
          'friend_b',
          '--password',
          'FriendBPass99!',
          '--no-browser',
        ],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      try {
        let out = ''
        child.stdout.on('data', (d) => {
          out += String(d)
        })
        child.stderr.on('data', (d) => {
          out += String(d)
        })
        for (let i = 0; i < 60; i += 1) {
          if (existsSync(join(cliStateDir, 'config.json')) && out.includes('已加密连接到中转服务器')) break
          await new Promise((r) => setTimeout(r, 100))
        }
        assert.ok(out.includes('已加密连接到中转服务器'), `Portable CLI should connect (${out.slice(0, 300)})`)
        const cfgRaw = readFileSync(join(cliStateDir, 'config.json'), 'utf8')
        assert.equal(cfgRaw.includes('FriendBPass99!'), false, 'PC config.json must never store account password')
        assert.ok(cfgRaw.includes('"mode": "account"'))
        assert.ok(cfgRaw.includes('"e2eeKey"'), 'PC config.json must auto-generate mandatory e2eeKey')
      } finally {
        try { child.kill() } catch {}
      }
    }
  } finally {
    await env.cleanup()
  }
})

describe('Suites 2-4: Live E2EE Bridge, Core Security Hardening & WebRTC P2P', () => {
  let env = null
  let bridge = null
  let smokeAdmin = null
  let loginData = null
  let smokeDev = null
  let smokeDev2 = null
  let primaryE2eeKey = ''
  let primaryE2eeKeyId = ''

  before(async () => {
    env = await createIsolatedRelayEnv('allinone-int-01-p2p-')
    const { tmpDir, relay, httpBase, wsBridgeUrl } = env

    smokeAdmin = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'smoke_admin',
          password: SMOKE_ADMIN_PASS,
          bootstrapToken: TEST_BOOTSTRAP_TOKEN,
          deviceName: 'smoke-phone',
        }),
      })
    ).json()
    assert.equal(smokeAdmin.ok, true)

    loginData = await (
      await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'smoke-phone' }),
      })
    ).json()
    assert.equal(loginData.ok, true)

    smokeDev = await (
      await fetch(`${httpBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ label: 'Smoke-PC-1', hostname: 'smoke-pc', platform: process.platform }),
      })
    ).json()
    assert.equal(smokeDev.ok, true)

    smokeDev2 = await (
      await fetch(`${httpBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ label: 'Smoke-PC-2', hostname: 'smoke-pc-2', platform: 'darwin' }),
      })
    ).json()
    assert.equal(smokeDev2.ok, true)

    primaryE2eeKey = generateE2eeKey()
    primaryE2eeKeyId = await computeE2eeKeyId(primaryE2eeKey)
    bridge = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: smokeDev.deviceSecret,
      roomId: smokeAdmin.roomId,
      bridgeId: smokeDev.bridgeId,
      e2eeKey: primaryE2eeKey,
      inboundDir: join(tmpDir, 'bridge-inbound'),
    })
    for (let i = 0; i < 50; i += 1) {
      if (relay.hub.getBridgeList(smokeAdmin.roomId).some((b) => b.online && b.e2ee?.enabled)) break
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(async () => {
    try {
      if (bridge) await bridge.stop()
    } finally {
      if (env) await env.cleanup()
    }
  })

  test('Suite 2: Live E2EE PC Bridge, multi-PC routing & 5-app RPCs (apps, models, sessions, E2EE FILE_READ)', async () => {
    const { relay, port, httpBase } = env

    const primaryBridgeMeta = relay.hub.getBridgeList(smokeAdmin.roomId).find((b) => b.bridgeId === smokeDev.bridgeId)
    assert.ok(primaryBridgeMeta?.online && primaryBridgeMeta.e2ee?.enabled)
    assert.equal(primaryBridgeMeta.e2ee.keyId, primaryE2eeKeyId)
    assert.equal(JSON.stringify(primaryBridgeMeta).includes(primaryE2eeKey), false, 'Relay must never receive raw e2eeKey')

    const adminHealth = await (
      await fetch(`${httpBase}/api/health`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      })
    ).json()
    assert.equal(adminHealth.roomId, smokeAdmin.roomId)
    assert.ok(adminHealth.onlineBridges >= 1)

    // Connect a 2nd lightweight bridge to verify multi-PC discovery & strict bridgeId targeting
    const mockBr2 = await connectMockBridgeWs(port, {
      roomId: smokeAdmin.roomId,
      deviceSecret: smokeDev2.deviceSecret,
      bridgeId: smokeDev2.bridgeId,
      hostname: 'smoke-pc-2',
      platform: 'darwin',
    })

    const cli = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'smoke-phone' })
    try {
      assert.equal(cli.hello.bridges.length, 2, 'Account room must support multiple simultaneous online E2EE bridges')
      const rpc = (method, params = {}) =>
        cli.sendEncryptedRpc(method, params, {
          e2eeKey: primaryE2eeKey,
          roomId: smokeAdmin.roomId,
          bridgeId: smokeDev.bridgeId,
        })

      // Offline bridgeId must fail strictly with BRIDGE_OFFLINE
      await assert.rejects(
        () =>
          cli.sendEncryptedRpc(RPC.APPS_STATUS, {}, {
            e2eeKey: primaryE2eeKey,
            roomId: smokeAdmin.roomId,
            bridgeId: 'offline-pc-999',
          }),
        (err) => err.code === 'BRIDGE_OFFLINE',
      )

      const statusRes = await rpc(RPC.APPS_STATUS)
      assert.equal(statusRes.apps.length, 5)

      const wsRes = await rpc(RPC.WORKSPACES_LIST)
      assert.ok(Array.isArray(wsRes.workspaces))

      const modelsRes = await rpc(RPC.MODELS_LIST)
      for (const app of ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy']) {
        assert.ok(Array.isArray(modelsRes.catalog[app]?.models))
        const appInfo = statusRes.apps.find((a) => a.app === app)
        if (appInfo?.writable || app === 'dsh') {
          assert.ok(modelsRes.catalog[app].models.length > 0)
        }
      }

      const listRes = await rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 40 })
      assert.ok(Array.isArray(listRes.sessions))
      for (const app of ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy']) {
        const sample = listRes.sessions.find((s) => s.app === app)
        if (!sample) continue
        const readRes = await rpc(RPC.SESSION_READ, { id: sample.id, limit: 10 })
        assert.equal(readRes.session.app, app)
        assert.ok(Array.isArray(readRes.session.messages))
        if (readRes.session.hasMore && readRes.session.nextCursor) {
          const olderRes = await rpc(RPC.SESSION_READ, { id: sample.id, limit: 10, cursor: readRes.session.nextCursor })
          assert.ok(Array.isArray(olderRes.session.messages))
        }
      }

      // E2EE RPC.FILE_READ image loading over binary aio-bulk + non-image guardrail
      const filePeer = await cli.connectP2p({
        bridgeId: smokeDev.bridgeId,
        e2eeKey: primaryE2eeKey,
        roomId: smokeAdmin.roomId,
      })
      const fileRes = await filePeer.sendEncryptedRpc(RPC.FILE_READ, {
        path: 'packages/mobile-app/public/icon-192.png',
        cwd: process.cwd(),
      })
      assert.equal(fileRes.mimeType, 'image/png')
      assert.equal(fileRes.transferMode, 'p2p-bulk')
      assert.equal(fileRes.dataBase64, undefined)
      assert.ok(fileRes.streamId > 0)
      const imgBuf = await filePeer.downloadBulkStream(fileRes.streamId)
      assert.ok(imgBuf.length > 1000 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50)
      await assert.rejects(
        () => rpc(RPC.FILE_READ, { path: 'package.json', cwd: process.cwd() }),
        /出于安全限制/,
      )
    } finally {
      await cli.closeAll()
      try { mockBr2.ws.close() } catch {}
    }
  })

  test('Suite 3: Core control plane & bridge security hardening (JWT, CORS/CSWSH, E2EE 4008, 401 stop, SSRF/symlink/traversal, XFF & TOCTOU)', async () => {
    const { tmpDir, port, httpBase, wsBridgeUrl } = env

    // 3a. Production weak JWT_SECRET refusal
    assert.throws(
      () =>
        createRelayServer({
          port: 0,
          host: '127.0.0.1',
          nodeEnv: 'production',
          jwtSecret: 'too-short',
          accountsFile: join(tmpDir, 'prod-accounts.json'),
        }),
      /Refusing to start in production/,
    )

    // 3b. Strict CORS allowlist
    const evilCorsRes = await fetch(`${httpBase}/api/health`, { headers: { Origin: 'https://evil.example.com' } })
    assert.equal(evilCorsRes.headers.get('access-control-allow-origin'), null)
    const evilPreflight = await fetch(`${httpBase}/api/auth/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })
    assert.equal(evilPreflight.status, 403)
    const capCorsRes = await fetch(`${httpBase}/api/health`, { headers: { Origin: 'https://localhost' } })
    assert.equal(capCorsRes.headers.get('access-control-allow-origin'), 'https://localhost')

    // 3c. Single-use WS ticket, CSWSH evil Origin block & ticket replay rejection
    const ticketRes = await (
      await fetch(`${httpBase}/api/auth/ws-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginData.token}` },
      })
    ).json()
    assert.ok(ticketRes.ticket.startsWith('tk_'))

    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`, {
            headers: { Origin: 'https://evil.example.com' },
          })
          ws.on('open', () => {
            ws.close()
            resolve()
          })
          ws.on('error', reject)
        }),
      'Evil Origin WS upgrade must be rejected',
    )

    const validTicketWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
    await new Promise((resolve, reject) => {
      validTicketWs.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'hello') resolve()
      })
      validTicketWs.on('error', reject)
    })
    validTicketWs.close()

    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
          ws.on('open', () => {
            ws.close()
            resolve()
          })
          ws.on('error', reject)
        }),
      'Reusing a single-use WS ticket must be rejected',
    )

    // 3d. Bridge WS header-only auth, mandatory E2EE enforcement (4008) & RelayBridgeLink 401 clean stop
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${port}/ws/bridge?room=${encodeURIComponent(smokeAdmin.roomId)}&secret=${encodeURIComponent(smokeDev.deviceSecret)}`,
          )
          ws.on('open', () => {
            ws.close()
            resolve()
          })
          ws.on('error', reject)
        }),
      'Bridge WS must reject ?secret= in query string',
    )

    const nonE2eeCloseCode = await new Promise((resolveCode, rejectCode) => {
      const qs = new URLSearchParams({
        roomId: smokeAdmin.roomId,
        bridgeId: smokeDev2.bridgeId,
        hostname: 'plain',
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
    assert.equal(nonE2eeCloseCode, 4008, 'Bridge sending bridge.meta without E2EE must close with 4008')

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
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(unauthStates.some((x) => x.st === 'unauthorized'))
    assert.equal(badBridge.reconnectTimer, null, 'Unauthorized bridge must not schedule reconnect')
    badBridge.stop()

    // 3e. Malformed HTTP Host crash defense & unauthenticated /api/admin/overview 401
    const badHostStatus = await new Promise((resolveStatus, rejectStatus) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /api/health HTTP/1.1\r\nHost: bad:port\r\nConnection: close\r\n\r\n')
      })
      let resp = ''
      sock.on('data', (c) => {
        resp += c.toString('utf8')
      })
      sock.on('end', () => resolveStatus(resp.split('\r\n')[0] || ''))
      sock.on('error', rejectStatus)
    })
    assert.match(badHostStatus, /400/)
    assert.equal((await (await fetch(`${httpBase}/api/health`)).json()).ok, true)
    assert.equal((await fetch(`${httpBase}/api/admin/overview`)).status, 401)

    // 3f. SSRF, forged p2pToken, symlink bypass, session ID path traversal & CLI arg injection
    let attackerHits = 0
    const attackerServer = http.createServer((_req, res) => {
      attackerHits += 1
      res.writeHead(200)
      res.end('nope')
    })
    await new Promise((r) => attackerServer.listen(0, '127.0.0.1', r))
    try {
      const matResult = await bridge.orchestrator.materializeAttachments([
        { url: `http://127.0.0.1:${attackerServer.address().port}/steal`, filename: 'evil.txt', mimeType: 'text/plain' },
        { localPath: '/etc/passwd', filename: 'passwd', mimeType: 'text/plain' },
        { p2pToken: 'p2p_forged_token', filename: 'forged.txt', mimeType: 'text/plain' },
      ])
      assert.equal(matResult.length, 0)
      assert.equal(attackerHits, 0)
    } finally {
      await new Promise((r) => attackerServer.close(r))
    }

    const symlinkPath = join(tmpDir, 'disguised-secret.png')
    symlinkSync(join(process.cwd(), 'package.json'), symlinkPath)
    await assert.rejects(() => bridge.orchestrator.readLocalFile({ path: symlinkPath }), /出于安全限制/)

    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'dsh:../../etc/passwd' }), /非法的/)
    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'claude:../../etc/passwd' }), /非法的/)
    await assert.rejects(() => bridge.orchestrator.readSession({ id: 'antigravity:../../etc/passwd' }), /非法的/)
    await assert.rejects(() => bridge.orchestrator.sendMessage({ id: 'claude:--malicious-flag', text: 'hi' }), /非法的/)
    await assert.rejects(
      () => bridge.orchestrator.sendMessage({ id: 'claude:safe-id-1', text: 'hi', model: 'opus & calc.exe' }),
      /非法的/,
    )

    // 3g. X-Forwarded-For spoofing resistance (uses rightmost trusted-proxy IP)
    for (let i = 0; i < 15; i += 1) {
      const r = await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.${i + 1}, 203.0.113.9` },
        body: JSON.stringify({ username: `nonexistent_user_${i}`, password: 'bad-password' }),
      })
      assert.equal(r.status, 401)
    }
    const throttled = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9, 203.0.113.9' },
      body: JSON.stringify({ username: 'nonexistent_user_16', password: 'bad-password' }),
    })
    assert.equal(throttled.status, 429)

    // 3h. changePasswordAsync TOCTOU protection against concurrent revoke-all
    const regToctou = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'toctou_u', password: 'InitPassword25!' }),
      })
    ).json()
    const [pwRaceRes, revokeRaceRes] = await Promise.all([
      fetch(`${httpBase}/api/account/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regToctou.token}` },
        body: JSON.stringify({ currentPassword: 'InitPassword25!', newPassword: 'HijackPassword25!' }),
      }),
      new Promise((resolveRev) =>
        setTimeout(() => {
          resolveRev(
            fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regToctou.token}` },
              body: JSON.stringify({}),
            }),
          )
        }, 5),
      ),
    ])
    if (revokeRaceRes.status === 200) {
      assert.equal(pwRaceRes.status, 401)
      const verifyOrig = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'toctou_u', password: 'InitPassword25!' }),
        })
      ).json()
      assert.equal(verifyOrig.ok, true)
    }
  })

  test('Suite 4: Full-duplex ZK E2EE & WebRTC P2P (replay/wrong-key defense, 5MB AIO2 bulk, 48KB frag & instant revocation)', async () => {
    const { port, httpBase } = env

    // 4a. Crypto, Base64URL strictness, QR (including Version 11+), protocol parity & 48KB SCTP ctrl fragmentation
    const unitKey = generateE2eeKey()
    const unitKeyId = await computeE2eeKeyId(unitKey)
    assert.match(unitKeyId, /^[0-9a-f]{16}$/)
    assert.match(formatE2eeFingerprint(unitKeyId), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

    const qrUri = encodeE2eeQrUri({ key: unitKey, roomId: smokeAdmin.roomId })
    assert.ok(qrUri.startsWith('allinone-e2ee://v1?'))
    const parsedQr = parseE2eeQrInput(qrUri)
    assert.equal(parsedQr.key, unitKey)
    assert.equal(parsedQr.roomId, smokeAdmin.roomId)
    assert.equal(parsedQr.isUri, true)
    assert.equal(parseE2eeQrInput(unitKey).key, unitKey)
    assert.ok(renderSharedQrSvg(qrUri).includes('<svg xmlns="http://www.w3.org/2000/svg"'))
    assert.ok(renderSharedQrSvg(`https://example.com/${'a'.repeat(240)}`).startsWith('<svg'))

    assert.equal(base64UrlToBytes(`${unitKey}=GARBAGE`), null)
    assert.equal(base64UrlToBytes(`${unitKey}==`), null)
    assert.equal(base64UrlToBytes('===='), null)
    assert.equal(base64UrlToBytes('abcd efgh'), null)

    assert.equal(toEpochMs(new Date('invalid')), 0)
    assert.deepEqual(parseCompositeId({ app: 'codex', sessionId: 'thr-1' }), { app: 'codex', sessionId: 'thr-1' })
    assert.equal(hubToEpochMs(new Date('invalid')), 0)
    assert.equal(hubToEpochMs(-123), 0)
    assert.notEqual(hubToEpochMs('2026'), 2026000)
    assert.deepEqual(hubParseCompositeId({ app: 'codex', sessionId: 'thr-2' }), { app: 'codex', sessionId: 'thr-2' })

    const sampleEnv = await encryptJson(unitKey, { secret: 'hello-e2ee' }, { kind: 'rpc.req', roomId: smokeAdmin.roomId })
    assert.equal((await decryptJson(unitKey, sampleEnv, { kind: 'rpc.req', roomId: smokeAdmin.roomId })).secret, 'hello-e2ee')
    await assert.rejects(() => decryptJson(unitKey, sampleEnv, { kind: 'rpc.res', roomId: smokeAdmin.roomId }), /解密失败/)
    await assert.rejects(() => decryptJson(unitKey, sampleEnv, { kind: 'rpc.req', roomId: 'usr_other' }), /解密失败/)
    const tamperedCt = (sampleEnv.ct[0] === 'A' ? 'B' : 'A') + sampleEnv.ct.slice(1)
    await assert.rejects(
      () => decryptJson(unitKey, { ...sampleEnv, ct: tamperedCt }, { kind: 'rpc.req', roomId: smokeAdmin.roomId }),
      /解密失败/,
    )

    const encCodec = createCtrlCodec()
    const decCodec = createCtrlCodec()
    const bigCtrl = { type: 'rpc.res', id: 'frag-1', blob: 'X'.repeat(150 * 1024) }
    const frames = encCodec.encode(bigCtrl)
    assert.ok(frames.length >= 4)
    let reassembled = null
    for (const f of frames) {
      assert.ok(f instanceof Uint8Array && f.byteLength <= CTRL_FRAG_LIMIT_BYTES)
      reassembled = decCodec.decode(f)
    }
    assert.deepEqual(reassembled, bigCtrl)

    // 4b. Live P2P E2EE enforcement, encrypted streaming events, 5MB PC<->Phone AIO2 bulk & instant revocation
    const p2pDir = join(bridge.orchestrator.inboundDir, 'p2p-bulk-workspace')
    mkdirSync(p2pDir, { recursive: true })
    const bigPdfBuf = Buffer.alloc(5 * 1024 * 1024 + 200_000)
    for (let i = 0; i < bigPdfBuf.length; i += 1) bigPdfBuf[i] = (i * 31 + 17) & 0xff
    const bigPdfPath = join(p2pDir, 'annual-report.pdf')
    writeFileSync(bigPdfPath, bigPdfBuf)
    const expectedPdfSha = createHash('sha256').update(bigPdfBuf).digest('hex')

    const p2pCli = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'p2p-bulk-phone' })
    try {
      const peer = await p2pCli.connectP2p({
        bridgeId: smokeDev.bridgeId,
        e2eeKey: primaryE2eeKey,
        roomId: smokeAdmin.roomId,
      })

      // Plaintext RPC -> E2EE_KEY_REQUIRED
      const plainTry = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-plain', method: RPC.APPS_STATUS, params: {} })
      assert.equal(plainTry.error?.code, 'E2EE_KEY_REQUIRED')

      // Wrong key -> E2EE_KEY_MISMATCH
      const wrongEnc = await encryptBinaryJson(
        generateE2eeKey(),
        { method: RPC.APPS_STATUS, params: {}, cid: 'e2ee-wrong', ts: Date.now() },
        { kind: 'rpc.req', roomId: smokeAdmin.roomId },
      )
      const wrongTry = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-wrong', bin: wrongEnc.bytes })
      assert.equal(wrongTry.error?.code, 'E2EE_KEY_MISMATCH')

      // Valid encrypted FILE_READ + exact ciphertext replay rejection
      const fileReqEnc = await encryptBinaryJson(
        primaryE2eeKey,
        {
          method: RPC.FILE_READ,
          params: { path: 'packages/mobile-app/public/icon-192.png', cwd: process.cwd() },
          cid: 'e2ee-file-1',
          ts: Date.now(),
        },
        { kind: 'rpc.req', roomId: smokeAdmin.roomId },
      )
      const encFileRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-file-1', bin: fileReqEnc.bytes })
      assert.equal(encFileRes.ok, true)
      assert.equal(encFileRes.result, undefined)
      assert.ok(encFileRes.bin instanceof Uint8Array)
      assert.equal(Buffer.from(encFileRes.bin).includes(Buffer.from('image/png')), false)
      const decFileRes = await decryptBinaryJson(primaryE2eeKey, encFileRes.bin, { kind: 'rpc.res', roomId: smokeAdmin.roomId })
      assert.equal(decFileRes.result.mimeType, 'image/png')
      assert.equal(decFileRes.result.transferMode, 'p2p-bulk')

      const replayRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-replay', bin: fileReqEnc.bytes })
      assert.equal(replayRes.error?.code, 'E2EE_REPLAY_DETECTED')

      // Streaming event pushed over P2P aio-ctrl (0 frames via Control Server WS)
      const controlEventsBefore = p2pCli.events.length
      const secretToken = 'ZERO_KNOWLEDGE_SECRET_DELTA_987654'
      bridge.link.pushEvent(EVENTS.STREAM_DELTA, { sessionId: 'codex:s1', delta: secretToken })
      let decEv = null
      for (let i = 0; i < 30 && !decEv; i += 1) {
        for (const e of p2pCli.p2pEvents) {
          if (e.bridgeId !== smokeDev.bridgeId || !e.bin) continue
          try {
            const cand = await decryptBinaryJson(primaryE2eeKey, e.bin, { kind: 'event', roomId: smokeAdmin.roomId })
            if (cand?.event === EVENTS.STREAM_DELTA && cand?.payload?.delta === secretToken) {
              decEv = cand
              break
            }
          } catch {}
        }
        if (!decEv) await new Promise((r) => setTimeout(r, 40))
      }
      assert.ok(decEv, 'Expected encrypted STREAM_DELTA over P2P aio-ctrl')
      assert.equal(p2pCli.events.length, controlEventsBefore, 'Streaming event must not traverse Control WS')
      assert.equal(decEv.event, EVENTS.STREAM_DELTA)
      assert.equal(decEv.payload.delta, secretToken)

      // 5.2MB PC -> Phone AIO2 bulk download
      const metaRes = await peer.sendEncryptedRpc(RPC.FILE_READ, { path: bigPdfPath, cwd: p2pDir, mode: 'document' })
      assert.equal(metaRes.transferMode, 'p2p-bulk')
      assert.equal(metaRes._localRealPath, undefined)
      const downloadedBuf = await peer.downloadBulkStream(metaRes.streamId)
      assert.equal(downloadedBuf.length, bigPdfBuf.length)
      assert.equal(createHash('sha256').update(downloadedBuf).digest('hex'), expectedPdfSha)

      // 5.1MB Phone -> PC AIO2 bulk upload + client-scoped single-use p2pToken
      const bigUpBuf = Buffer.alloc(5 * 1024 * 1024 + 100_000)
      for (let i = 0; i < bigUpBuf.length; i += 1) bigUpBuf[i] = (i * 19 + 7) & 0xff
      const expectedUpSha = createHash('sha256').update(bigUpBuf).digest('hex')

      const upDone = await peer.uploadFileBulk(bigUpBuf, {
        filename: 'phone-capture.bin',
        mimeType: 'application/octet-stream',
      })
      assert.ok(upDone.p2pToken?.startsWith('p2p_'))
      assert.equal(upDone.size, bigUpBuf.length)

      // Cross-client hijack rejected
      const stolenMat = await bridge.orchestrator.materializeAttachments(
        [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
        { clientId: 'attacker-client-id' },
      )
      assert.equal(stolenMat.length, 0)

      // Legitimate client materializes exact 5.1MB file, then single-use replay is rejected
      const okMat = await bridge.orchestrator.materializeAttachments(
        [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
        { clientId: p2pCli.hello.clientId },
      )
      assert.equal(okMat.length, 1)
      assert.equal(createHash('sha256').update(readFileSync(okMat[0].localPath)).digest('hex'), expectedUpSha)
      const replayMat = await bridge.orchestrator.materializeAttachments(
        [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
        { clientId: p2pCli.hello.clientId },
      )
      assert.equal(replayMat.length, 0)

      // Instant revocation (client.revoked): revoking a live P2P session destroys DataChannel in <1s
      const kickLogin = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'victim-phone' }),
        })
      ).json()
      const victimCli = await openTicketClientWs(httpBase, port, kickLogin.token, { deviceName: 'victim-phone' })
      try {
        const victimPeer = await victimCli.connectP2p({
          bridgeId: smokeDev.bridgeId,
          e2eeKey: primaryE2eeKey,
          roomId: smokeAdmin.roomId,
        })
        assert.equal((await victimPeer.sendEncryptedRpc(RPC.APPS_STATUS)).apps.length, 5)
        assert.ok(bridge.link.p2p.sessions.has(victimCli.hello.clientId))

        const kickStarted = Date.now()
        const kickRes = await (
          await fetch(`${httpBase}/api/auth/sessions/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
            body: JSON.stringify({ sid: victimCli.hello.sid, clientId: victimCli.hello.clientId }),
          })
        ).json()
        assert.equal(kickRes.ok, true)

        for (let i = 0; i < 50; i += 1) {
          if (!bridge.link.p2p.sessions.has(victimCli.hello.clientId)) break
          await new Promise((r) => setTimeout(r, 20))
        }
        assert.equal(bridge.link.p2p.sessions.has(victimCli.hello.clientId), false)
        assert.ok(Date.now() - kickStarted < 1000)
        assert.ok(bridge.link.p2p.revokedClients.has(victimCli.hello.clientId))
      } finally {
        await victimCli.closeAll()
      }
    } finally {
      await p2pCli.closeAll()
    }
  })
})
