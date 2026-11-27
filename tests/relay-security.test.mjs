import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { EVENTS, WS_MSG } from '../packages/shared/src/protocol.js'
import {
  computeGrantCommitment,
  generateGrantKeyPair,
  generateGrantNonce,
  generateGrantReqId,
} from '../packages/shared/src/e2ee.js'
import { createAccountStore, resolveAccountsDbPath } from '../packages/relay-server/src/accounts.js'
import { createAuthManager } from '../packages/relay-server/src/auth.js'
import { RelayHub } from '../packages/relay-server/src/hub.js'
import { createRelayServer } from '../packages/relay-server/src/index.js'
import { createMailer } from '../packages/relay-server/src/mailer.js'
import { createStaticHandler } from '../packages/relay-server/src/routes/static.js'

test('AccountStore migrates legacy accounts.json into SQLite WAL, upgrades scrypt hash, and syncs live CLI edits', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-acct-unit-'))
  try {
    const legacyJsonPath = join(dir, 'accounts.json')
    const legacySalt = '0123456789abcdef0123456789abcdef'
    const legacyHash = scryptSync('MyLegacyPass!123', legacySalt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')
    writeFileSync(
      legacyJsonPath,
      JSON.stringify({
        version: 1,
        users: [
          {
            userId: 'usr_legacy01',
            username: 'legacy_user',
            usernameLower: 'legacy_user',
            role: 'admin',
            tier: 'admin',
            passwordSalt: legacySalt,
            passwordHash: legacyHash,
            tokenVersion: 1,
            createdAt: Date.now() - 10_000,
            devices: [],
            sessions: [],
          },
        ],
        dailyRegistrations: {},
      }),
      'utf8',
    )

    const store = createAccountStore({ filePath: legacyJsonPath })
    assert.equal(store.hasAnyUser(), true)
    const dbPath = resolveAccountsDbPath(legacyJsonPath)
    assert.equal(existsSync(dbPath), true)
    assert.equal(existsSync(legacyJsonPath), false)
    assert.equal(
      readdirSync(dir).some((name) => /^accounts\.json\.migrated\.\d+\.bak$/.test(name)),
      true,
    )

    // Authenticate with legacy scrypt (N=16384) -> succeeds & transparently upgrades to PHC $scrypt$N=32768
    const authOk = await store.authenticateUserAsync('legacy_user', 'MyLegacyPass!123')
    assert.ok(authOk)
    assert.equal(authOk.user.role, 'admin')
    const authBad = await store.authenticateUserAsync('legacy_user', 'WrongPass')
    assert.equal(authBad, null)

    // Register fresh user and confirm cross-instance WAL visibility (simulating admin-cli)
    const fresh = await store.registerUserAsync({ username: 'fresh_bob', password: 'FreshPassword99!' })
    assert.equal(fresh.ok, true)
    assert.equal(fresh.user.role, 'user')

    // Plaintext password must NEVER appear in SQLite DB or WAL
    const rawDb = readFileSync(dbPath)
    assert.equal(rawDb.includes(Buffer.from('FreshPassword99!')), false)
    assert.equal(rawDb.includes(Buffer.from('MyLegacyPass!123')), false)

    const store2 = createAccountStore({ filePath: legacyJsonPath })
    const seenByCli = store2.findUserByIdentifier('fresh_bob')
    assert.ok(seenByCli)
    assert.equal(seenByCli.userId, fresh.user.userId)

    store2.setUserTier(fresh.user.userId, 'pro')
    const updatedInPrimary = store.getUserById(fresh.user.userId)
    assert.equal(updatedInPrimary.tier, 'pro')

    store.close()
    store2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const silentLog = { info() {}, warn() {}, error() {} }

function httpRequestRaw({ port, method = 'GET', path = '/', headers = {}, body = null, chunked = false }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body !== null) {
      if (chunked) {
        req.useChunkedEncodingByDefault = true
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
        for (let off = 0; off < buf.length; off += 32 * 1024) {
          req.write(buf.subarray(off, off + 32 * 1024))
        }
        req.end()
      } else {
        req.end(body)
      }
    } else {
      req.end()
    }
  })
}

test('AccountStore SQLite WAL preserves concurrent admin-cli setUserTier alongside dirty telemetry and sets 0600 mode', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-acct-wal-'))
  try {
    const accountsFile = join(dir, 'accounts.json')
    const store1 = createAccountStore({ filePath: accountsFile })
    const adminReg = await store1.registerUserAsync({ username: 'wal_admin', password: 'AdminPassword!123' })
    assert.equal(adminReg.ok, true)
    const reg = await store1.registerUserAsync({ username: 'wal_alice', password: 'WalPassword!123' })
    assert.equal(reg.ok, true)
    const uid = reg.user.userId
    store1.recordUserSession(uid, {
      sid: 's_wal_1',
      deviceName: 'Old Phone',
      clientKind: 'mobile',
      ip: '198.51.100.1',
    })

    // Check 0600 permissions on SQLite DB file (POSIX)
    if (process.platform !== 'win32') {
      const mode = statSync(store1.dbPath).mode & 0o777
      assert.equal(mode, 0o600, `expected 0600 db permissions, got ${mode.toString(8)}`)
    }

    // Create dirty (unflushed) telemetry on primary store1
    store1.addTurnUsage(uid, 500_000)
    store1.touchUserSession(uid, 's_wal_1', { deviceName: 'New Phone', ip: '198.51.100.2' })

    // Concurrent admin-cli edit via second AccountStore instance
    const store2 = createAccountStore({ filePath: accountsFile })
    const tierRes1 = store2.setUserTier(uid, 'ultra')
    assert.equal(tierRes1.ok, true)

    // Reading on store1 triggers external data_version reload: MUST preserve BOTH CLI tier AND dirty telemetry
    const mergedBeforeFlush = store1.getUserById(uid)
    assert.equal(mergedBeforeFlush.tier, 'ultra')
    assert.equal(mergedBeforeFlush.turnUsage.bytes, 500_000)
    const sessionsBeforeFlush = store1.listUserSessions(uid)
    assert.equal(sessionsBeforeFlush[0].deviceName, 'New Phone')
    assert.equal(sessionsBeforeFlush[0].ip, '198.51.100.2')

    // Add more dirty telemetry, then another concurrent CLI tier edit BEFORE store1.flush()
    store1.addTurnUsage(uid, 250_000)
    const tierRes2 = store2.setUserTier(uid, 'pro')
    assert.equal(tierRes2.ok, true)

    // Flush primary store1 — must NOT clobber store2's 'pro' tier and must persist all 750_000 bytes + touched session
    store1.flush()

    // Reload from a brand-new third store instance to verify durable SQLite state
    const store3 = createAccountStore({ filePath: accountsFile })
    const durableUser = store3.getUserById(uid)
    assert.equal(durableUser.tier, 'pro')
    assert.equal(durableUser.turnUsage.bytes, 750_000)
    const durableSessions = store3.listUserSessions(uid)
    assert.equal(durableSessions[0].deviceName, 'New Phone')
    assert.equal(durableSessions[0].ip, '198.51.100.2')

    store1.close()
    store2.close()
    store3.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/metrics enforces loopback-only without proxy headers and timing-safe METRICS_TOKEN Bearer auth', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-metrics-sec-'))
  let srvNoToken = null
  let srvWithToken = null
  try {
    srvNoToken = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      stunEnabled: false,
      jwtSecret: 'metrics-test-jwt-secret-123456',
      metricsToken: '',
      accountsFile: join(dir, 'a1.json'),
      log: silentLog,
    })
    const { port: p1 } = await srvNoToken.start()

    const directOk = await httpRequestRaw({ port: p1, path: '/metrics' })
    assert.equal(directOk.status, 200)
    assert.ok(directOk.text.includes('allinone_up 1'))

    const withXff = await httpRequestRaw({
      port: p1,
      path: '/metrics',
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    })
    assert.equal(withXff.status, 403)

    const withRealIp = await httpRequestRaw({
      port: p1,
      path: '/metrics',
      headers: { 'X-Real-IP': '203.0.113.5' },
    })
    assert.equal(withRealIp.status, 403)

    const withForwarded = await httpRequestRaw({
      port: p1,
      path: '/metrics',
      headers: { Forwarded: 'for=203.0.113.5' },
    })
    assert.equal(withForwarded.status, 403)

    srvWithToken = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      stunEnabled: false,
      jwtSecret: 'metrics-test-jwt-secret-789012',
      metricsToken: 'super-secret-metrics-token-42',
      accountsFile: join(dir, 'a2.json'),
      log: silentLog,
    })
    const { port: p2 } = await srvWithToken.start()

    const missingTok = await httpRequestRaw({ port: p2, path: '/metrics' })
    assert.equal(missingTok.status, 401)

    const badTok = await httpRequestRaw({
      port: p2,
      path: '/metrics',
      headers: { Authorization: 'Bearer wrong-token' },
    })
    assert.equal(badTok.status, 401)

    const goodTok = await httpRequestRaw({
      port: p2,
      path: '/metrics',
      headers: {
        Authorization: 'Bearer super-secret-metrics-token-42',
        'X-Forwarded-For': '203.0.113.99',
      },
    })
    assert.equal(goodTok.status, 200)
    assert.ok(goodTok.text.includes('allinone_up 1'))
  } finally {
    if (srvNoToken) await srvNoToken.close()
    if (srvWithToken) await srvWithToken.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('password reset enforces (ip, email) lockout isolation and anti-enumeration across registered vs unregistered emails', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-reset-sec-'))
  const sentEmails = []
  let srv = null
  try {
    srv = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      stunEnabled: false,
      trustProxy: 'loopback',
      jwtSecret: 'reset-test-jwt-secret-123456',
      accountsFile: join(dir, 'accounts.json'),
      sendEmail: async (mail) => {
        sentEmails.push(mail)
        return { ok: true }
      },
      log: silentLog,
    })
    const { port } = await srv.start()

    const reg = await srv.accounts.registerUserAsync({
      username: 'victim_alice',
      password: 'OldPassword!123',
      email: 'alice@example.com',
      emailVerified: true,
    })
    assert.equal(reg.ok, true)

    // 10 bad codes from IP A for victim_alice lock out ONLY (IP A, alice@example.com)
    let lastBadReg = null
    for (let i = 0; i < 10; i += 1) {
      lastBadReg = await httpRequestRaw({
        port,
        method: 'POST',
        path: '/api/account/password/reset',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
        body: JSON.stringify({ email: 'alice@example.com', code: '000000', newPassword: 'AttackerPassword!1' }),
      })
      assert.equal(lastBadReg.status, 400)
    }
    const lockedIpA = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/password/reset',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ email: 'alice@example.com', code: '000000', newPassword: 'AttackerPassword!1' }),
    })
    assert.equal(lockedIpA.status, 429)

    // Unregistered email produces IDENTICAL 400 and 429 responses (zero enumeration oracle)
    let lastBadGhost = null
    for (let i = 0; i < 10; i += 1) {
      lastBadGhost = await httpRequestRaw({
        port,
        method: 'POST',
        path: '/api/account/password/reset',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.30' },
        body: JSON.stringify({ email: 'unregistered@example.com', code: '000000', newPassword: 'AttackerPassword!1' }),
      })
      assert.equal(lastBadGhost.status, 400)
    }
    assert.deepEqual(lastBadGhost.json, lastBadReg.json)
    const lockedGhost = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/password/reset',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.30' },
      body: JSON.stringify({ email: 'unregistered@example.com', code: '000000', newPassword: 'AttackerPassword!1' }),
    })
    assert.equal(lockedGhost.status, 429)
    assert.deepEqual(lockedGhost.json, lockedIpA.json)

    // Send reset code to registered vs unregistered email: HTTP status & response body must be identical
    const sendReg = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/email/send-code',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.20' },
      body: JSON.stringify({ purpose: 'reset', email: 'alice@example.com' }),
    })
    const sendGhost = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/email/send-code',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.21' },
      body: JSON.stringify({ purpose: 'reset', email: 'unregistered@example.com' }),
    })
    assert.equal(sendReg.status, 200)
    assert.equal(sendGhost.status, 200)
    assert.deepEqual(sendReg.json, sendGhost.json)
    assert.equal(sentEmails.length, 1)
    const codeMatch = sentEmails[0].text.match(/\b(\d{6})\b/)
    assert.ok(codeMatch, 'reset email must contain a 6-digit OTP')
    const realCode = codeMatch[1]

    // IP A is STILL locked out even with the freshly issued real code
    const stillLockedIpA = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/password/reset',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ email: 'alice@example.com', code: realCode, newPassword: 'AttackerPassword!2' }),
    })
    assert.equal(stillLockedIpA.status, 429)

    // Victim on IP B is NOT locked out and succeeds with the real code
    const okIpB = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/password/reset',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.20' },
      body: JSON.stringify({ email: 'alice@example.com', code: realCode, newPassword: 'NewStrongPassword!99' }),
    })
    assert.equal(okIpB.status, 200)
    assert.equal(okIpB.json.ok, true)
    assert.equal(okIpB.json.username, 'victim_alice')
  } finally {
    if (srv) await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auth.js IP failure self-reset prevention: clearFailure clears (ip, account) without resetting IP-wide failure count', () => {
  const auth = createAuthManager({ jwtSecret: 'unit-auth-secret-at-least-16-chars' })
  const ip = '198.51.100.77'
  const acct = 'usr_selfreset01'

  // Accumulate 14 IP-wide failures (1 shy of MAX_FAILS=15) and 6 account failures
  for (let i = 0; i < 14; i += 1) auth.recordFailure(ip)
  for (let i = 0; i < 6; i += 1) auth.recordAccountFailure(acct, ip)

  assert.equal(auth.checkRateLimit(ip), true)
  assert.equal(auth.checkAccountRateLimit(acct, ip), true)

  // Successful login calls clearFailure(ip, acct) / clearAccountFailure(acct, ip)
  auth.clearFailure(ip, acct)

  // Per-(ip, account) bucket WAS cleared (9 more failures still < MAX_ACCT_FAILS=10)
  for (let i = 0; i < 9; i += 1) auth.recordAccountFailure(acct, ip)
  assert.equal(auth.checkAccountRateLimit(acct, ip), true)
  auth.recordAccountFailure(acct, ip)
  assert.equal(auth.checkAccountRateLimit(acct, ip), false)

  // Global IP failure count was NOT cleared: 1 more failure hits MAX_FAILS=15 immediately
  auth.recordFailure(ip)
  assert.equal(auth.checkRateLimit(ip), false)
})

test('readJsonObjectBody returns clean HTTP 413 JSON (no ECONNRESET) and /api/auth/ws-ticket rejects invalid/oversized JSON', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-body-413-'))
  let srv = null
  try {
    srv = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      stunEnabled: false,
      jwtSecret: 'body-413-test-jwt-secret-123456',
      accountsFile: join(dir, 'accounts.json'),
      log: silentLog,
    })
    const { port } = await srv.start()

    // Register & obtain valid session Bearer token
    const regRes = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'body_tester', password: 'BodyPassword!123' }),
    })
    assert.equal(regRes.status, 200)
    const token = regRes.json.token
    assert.ok(token)

    // Oversized body (> 256 KB) with Content-Length -> clean HTTP 413 JSON (no ECONNRESET)
    const hugeBody = JSON.stringify({ username: 'body_tester', pad: 'x'.repeat(270 * 1024) })
    const res413Len = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/login',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(hugeBody) },
      body: hugeBody,
    })
    assert.equal(res413Len.status, 413)
    assert.equal(res413Len.json?.ok, false)
    assert.equal(res413Len.json?.code, 'PAYLOAD_TOO_LARGE')

    // Oversized chunked body (no Content-Length) -> clean HTTP 413 JSON
    const res413Chunked = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/login',
      headers: { 'Content-Type': 'application/json' },
      body: hugeBody,
      chunked: true,
    })
    assert.equal(res413Chunked.status, 413)
    assert.equal(res413Chunked.json?.ok, false)
    assert.equal(res413Chunked.json?.code, 'PAYLOAD_TOO_LARGE')

    // /api/auth/ws-ticket rejects invalid JSON (400), array JSON (400), and oversized >16 KB JSON (413)
    const invalidJson = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/auth/ws-ticket',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{not-valid-json',
    })
    assert.equal(invalidJson.status, 400)
    assert.equal(invalidJson.json?.ok, false)
    assert.equal(invalidJson.json?.code, 'INVALID_JSON')

    const arrayJson = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/auth/ws-ticket',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(['not', 'an', 'object']),
    })
    assert.equal(arrayJson.status, 400)
    assert.equal(arrayJson.json?.ok, false)
    assert.equal(arrayJson.json?.code, 'INVALID_JSON_OBJECT')

    const oversizedTicketBody = JSON.stringify({ deviceName: 'd'.repeat(20 * 1024) })
    const oversizedTicket = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/auth/ws-ticket',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: oversizedTicketBody,
    })
    assert.equal(oversizedTicket.status, 413)
    assert.equal(oversizedTicket.json?.ok, false)
    assert.equal(oversizedTicket.json?.code, 'PAYLOAD_TOO_LARGE')
  } finally {
    if (srv) await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/api/admin/overview makes zero outbound Cloudflare TURN HTTP calls for offline free users', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-admin-cf-'))
  let cfFetchCount = 0
  let srv = null
  try {
    srv = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      stunEnabled: false,
      jwtSecret: 'admin-overview-jwt-secret-123456',
      accountsFile: join(dir, 'accounts.json'),
      cfTurnTokenId: 'cf_tok_unit',
      cfTurnApiToken: 'cf_api_unit',
      cfTurnTiers: 'free',
      fetchFn: async () => {
        cfFetchCount += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            iceServers: {
              urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
              username: 'u',
              credential: 'c',
            },
          }),
        }
      },
      log: silentLog,
    })
    const { port } = await srv.start()
    const callsAfterStartup = cfFetchCount
    assert.equal(callsAfterStartup, 1, 'only the single startup warmup refresh should occur')

    // Bootstrap admin account via HTTP register to get admin Bearer JWT
    const adminReg = await httpRequestRaw({
      port,
      method: 'POST',
      path: '/api/account/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin_root', password: 'AdminPassword!123' }),
    })
    assert.equal(adminReg.status, 200)
    const adminToken = adminReg.json.token

    // Register 5 offline free users directly in store
    for (let i = 0; i < 5; i += 1) {
      const r = await srv.accounts.registerUserAsync({ username: `free_user_${i}`, password: 'UserPassword!123' })
      assert.equal(r.ok, true)
    }

    const overviewRes = await httpRequestRaw({
      port,
      method: 'GET',
      path: '/api/admin/overview',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    assert.equal(overviewRes.status, 200)
    assert.equal(overviewRes.json?.users?.length, 6)
    assert.equal(
      cfFetchCount,
      callsAfterStartup,
      '/api/admin/overview must trigger 0 outbound Cloudflare TURN HTTP calls for offline free users',
    )
  } finally {
    if (srv) await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hub.js Grant v2 multi-approver: claim cancels other approvers, rejects late offers with already_claimed, and isolates reject', async () => {
  const hub = new RelayHub({ log: silentLog })
  const makeFakeWs = () => {
    const ws = new EventEmitter()
    ws.readyState = 1
    ws.bufferedAmount = 0
    ws.sent = []
    ws.send = (raw) => ws.sent.push(JSON.parse(String(raw)))
    ws.close = () => {
      ws.readyState = 3
    }
    ws.terminate = () => {
      ws.readyState = 3
    }
    ws.ping = () => {}
    return ws
  }
  try {
    const roomId = 'usr_grant_multi'
    const wsReq = makeFakeWs()
    const wsApp1 = makeFakeWs()
    const wsApp2 = makeFakeWs()

    hub.registerClient(wsReq, { sub: roomId, room: roomId, sid: 's_req', dev: 'New Laptop', tv: 0 })
    hub.registerClient(wsApp1, { sub: roomId, room: roomId, sid: 's_app1', dev: 'Phone 1', tv: 0 })
    hub.registerClient(wsApp2, { sub: roomId, room: roomId, sid: 's_app2', dev: 'Phone 2', tv: 0 })

    const reqClientId = wsReq.sent.find((m) => m.type === WS_MSG.HELLO).clientId
    const app1ClientId = wsApp1.sent.find((m) => m.type === WS_MSG.HELLO).clientId
    const app2ClientId = wsApp2.sent.find((m) => m.type === WS_MSG.HELLO).clientId

    const pairReq = await generateGrantKeyPair()
    const pairApp1 = await generateGrantKeyPair()
    const pairApp2 = await generateGrantKeyPair()
    const reqId = generateGrantReqId()
    const reqNonce = generateGrantNonce()
    const app1Nonce = generateGrantNonce()
    const app2Nonce = generateGrantNonce()
    const commit = await computeGrantCommitment({ reqId, roomId, pubKey: pairReq.publicKeyRaw, nonce: reqNonce })

    // Requester initiates Grant v2 request
    hub.handleClientMessage(reqClientId, {
      type: WS_MSG.E2EE_GRANT_REQ,
      reqId,
      pubKey: pairReq.publicKeyRaw,
      commit,
    })
    assert.ok(wsApp1.sent.some((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === reqId))
    assert.ok(wsApp2.sent.some((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === reqId))

    // Approver 1 claims with offer -> approver 2 receives `claimed_by_other`, requester gets offer
    hub.handleClientMessage(app1ClientId, {
      type: WS_MSG.E2EE_GRANT_OFFER,
      reqId,
      approverPubKey: pairApp1.publicKeyRaw,
      approverNonce: app1Nonce,
    })
    assert.ok(wsReq.sent.some((m) => m.event === EVENTS.E2EE_GRANT_OFFER && m.payload?.approverClientId === app1ClientId))
    assert.ok(
      wsApp2.sent.some(
        (m) => m.event === EVENTS.E2EE_GRANT_CANCEL && m.payload?.reqId === reqId && m.payload?.reason === 'claimed_by_other',
      ),
    )
    assert.equal(
      wsApp1.sent.some((m) => m.event === EVENTS.E2EE_GRANT_CANCEL && m.payload?.reason === 'claimed_by_other'),
      false,
    )

    // Approver 2 sends late offer -> receives `already_claimed`
    hub.handleClientMessage(app2ClientId, {
      type: WS_MSG.E2EE_GRANT_OFFER,
      reqId,
      approverPubKey: pairApp2.publicKeyRaw,
      approverNonce: app2Nonce,
    })
    assert.ok(
      wsApp2.sent.some(
        (m) => m.event === EVENTS.E2EE_GRANT_CANCEL && m.payload?.reqId === reqId && m.payload?.reason === 'already_claimed',
      ),
    )

    // Approver 2 sends reject -> MUST NOT cancel approver 1's active grant or notify requester of reject
    hub.handleClientMessage(app2ClientId, {
      type: WS_MSG.E2EE_GRANT_REJECT,
      reqId,
    })
    assert.equal(wsReq.sent.some((m) => m.event === EVENTS.E2EE_GRANT_REJECT), false)
    assert.equal(hub.e2eeGrants.get(roomId)?.get(reqId)?.offeredByClientId, app1ClientId)

    // Approver 1 can still complete deliver cleanly
    hub.handleClientMessage(app1ClientId, {
      type: WS_MSG.E2EE_GRANT_DELIVER,
      reqId,
      envelope: {
        v: 1,
        reqId,
        approverPubKey: pairApp1.publicKeyRaw,
        iv: 'AAAAAAAAAAAAAAAA',
        ct: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
    })
    assert.ok(wsReq.sent.some((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === reqId))
  } finally {
    hub.shutdown()
  }
})

test('mailer.js enforces concurrency semaphore cap (8) and rejects overflow queue (>50) with MAIL_QUEUE_FULL', async () => {
  let active = 0
  let maxObservedActive = 0
  const pendingReleases = []

  const mailer = createMailer({
    sendEmail: () =>
      new Promise((resolve) => {
        active += 1
        if (active > maxObservedActive) maxObservedActive = active
        pendingReleases.push(() => {
          active -= 1
          resolve({ ok: true })
        })
      }),
  })

  // 8 active + 50 queued = 58 accepted
  const accepted = []
  for (let i = 0; i < 58; i += 1) {
    accepted.push(mailer.sendMail({ to: `u${i}@example.com`, subject: 's', text: 't', html: '<p>t</p>' }))
  }
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(active, 8)
  assert.equal(maxObservedActive, 8)

  // 59th concurrent send MUST reject immediately with MAIL_QUEUE_FULL (503)
  await assert.rejects(
    () => mailer.sendMail({ to: 'overflow@example.com', subject: 's', text: 't', html: '<p>t</p>' }),
    (err) => err?.code === 'MAIL_QUEUE_FULL' && err?.statusCode === 503,
  )

  // Drain all 58 in waves while asserting concurrency NEVER exceeds 8
  while (pendingReleases.length > 0) {
    const batch = pendingReleases.splice(0, pendingReleases.length)
    for (const release of batch) release()
    await new Promise((r) => setTimeout(r, 5))
    assert.ok(maxObservedActive <= 8, `concurrency exceeded 8: ${maxObservedActive}`)
  }
  await Promise.all(accepted)
  assert.equal(active, 0)
  assert.equal(maxObservedActive, 8)
})

test('routes/static.js sets non-immutable Cache-Control on .apk/.dmg/.json and immutable on hashed /assets/*', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-static-cache-'))
  let server = null
  try {
    mkdirSync(join(dir, 'downloads', 'ota'), { recursive: true })
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>')
    writeFileSync(join(dir, 'downloads', 'All-in-One.apk'), Buffer.from('apk-bytes'))
    writeFileSync(join(dir, 'downloads', 'All-in-One.dmg'), Buffer.from('dmg-bytes'))
    writeFileSync(join(dir, 'downloads', 'ota', 'All-in-One-WebBundle.json'), JSON.stringify({ version: '1.0.30' }))
    writeFileSync(join(dir, 'assets', 'index-Ab12Cd34.js'), 'console.log(1)')

    const staticHandler = createStaticHandler({
      staticDir: dir,
      adminDashboardDir: dir,
      relayVersion: '1.0.30',
      publicRelayUrl: '',
      isTrustedProxy: () => false,
    })

    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname
      const handled = await staticHandler.handleStaticRequest(req, res, pathname)
      if (!handled) {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address()

    for (const p of ['/downloads/All-in-One.apk', '/downloads/All-in-One.dmg', '/downloads/ota/All-in-One-WebBundle.json']) {
      const res = await httpRequestRaw({ port, path: p })
      assert.equal(res.status, 200, `expected 200 for ${p}`)
      const cc = String(res.headers['cache-control'] || '')
      assert.equal(cc.includes('immutable'), false, `${p} must NOT be immutable: ${cc}`)
      assert.ok(cc.includes('must-revalidate'), `${p} must revalidate: ${cc}`)
    }

    const hashedRes = await httpRequestRaw({ port, path: '/assets/index-Ab12Cd34.js' })
    assert.equal(hashedRes.status, 200)
    assert.equal(hashedRes.headers['cache-control'], 'public, max-age=31536000, immutable')

    const htmlRes = await httpRequestRaw({ port, path: '/index.html' })
    assert.equal(htmlRes.status, 200)
    assert.equal(htmlRes.headers['cache-control'], 'no-cache, no-store, must-revalidate')
  } finally {
    if (server) {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
