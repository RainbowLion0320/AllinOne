import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAccountStore } from '../packages/relay-server/src/accounts.js'
import { createRelayServer } from '../packages/relay-server/src/index.js'

const silentLog = { info() {}, warn() {}, error() {} }

async function startMockGithubServer(profileRef) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'POST' && u.pathname === '/login/oauth/access_token') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (body.code === 'bad_code') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad_verification_code', error_description: 'Code expired' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: `gho_mock_${body.code}`, token_type: 'bearer', scope: 'read:user,user:email' }))
      })
      return
    }
    if (req.method === 'GET' && u.pathname === '/user') {
      const authHeader = String(req.headers.authorization || '')
      if (!authHeader.startsWith('Bearer gho_mock_')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'Bad credentials' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: profileRef.current.id, login: profileRef.current.login }))
      return
    }
    if (req.method === 'GET' && u.pathname === '/user/emails') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(profileRef.current.emails || []))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('AccountStore migrates v1 SQLite DB cleanly to v2 with GitHub columns & unique index', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-gh-mig-'))
  try {
    const dbPath = join(dir, 'accounts.db')
    const legacyDb = new DatabaseSync(dbPath)
    legacyDb.exec(`
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL DEFAULT '',
        email_lower TEXT NOT NULL DEFAULT '',
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_verified_at INTEGER NOT NULL DEFAULT 0,
        login_email_2fa INTEGER NOT NULL DEFAULT 0,
        tier TEXT NOT NULL DEFAULT 'free',
        role TEXT NOT NULL DEFAULT 'user',
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL,
        known_login_ips_json TEXT NOT NULL DEFAULT '[]',
        turn_usage_json TEXT NOT NULL DEFAULT '{}',
        devices_json TEXT NOT NULL DEFAULT '[]',
        sessions_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE daily_registrations (
        day_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (
        user_id, username, username_lower, tier, role, password_salt, password_hash, created_at, last_login_at
      ) VALUES ('usr_v1legacy01', 'alice', 'alice', 'admin', 'admin', 'salt', 'hash', 1000, 1000);
      PRAGMA user_version = 1;
    `)
    legacyDb.close()

    const store = createAccountStore({ filePath: dbPath })
    const alice = store.getUserById('usr_v1legacy01')
    assert.ok(alice)
    assert.equal(alice.username, 'alice')
    assert.equal(alice.hasPassword, true)
    assert.equal(alice.githubLinked, false)
    assert.equal(alice.githubLogin, '')

    const linked = store.linkUserGithub('usr_v1legacy01', { githubId: '9001', githubLogin: 'alice-gh' })
    assert.equal(linked.ok, true)
    assert.equal(linked.user.githubLinked, true)
    assert.equal(linked.user.githubLogin, 'alice-gh')
    assert.equal(store.getUserByGithubId('9001')?.userId, 'usr_v1legacy01')

    const unlinked = store.unlinkUserGithub('usr_v1legacy01')
    assert.equal(unlinked.ok, true)
    assert.equal(unlinked.user.githubLinked, false)
    assert.equal(store.getUserByGithubId('9001'), null)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GitHub OAuth end-to-end: signup, re-login, bind, unlink guard, replay & open-redirect defenses', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-gh-e2e-'))
  const profileRef = {
    current: {
      id: 424242,
      login: 'octo-dev',
      emails: [
        { email: '424242+octo-dev@users.noreply.github.com', primary: false, verified: true },
        { email: 'octo@example.com', primary: true, verified: true },
      ],
    },
  }
  const mockGh = await startMockGithubServer(profileRef)
  const relayDisabled = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    stunEnabled: false,
    jwtSecret: 'test-jwt-secret-github-oauth-disabled-0123456789',
    accountsFile: join(dir, 'disabled.db'),
    allowDevSecrets: true,
    log: silentLog,
  })
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    stunEnabled: false,
    jwtSecret: 'test-jwt-secret-github-oauth-enabled-0123456789',
    accountsFile: join(dir, 'accounts.db'),
    allowDevSecrets: true,
    githubClientId: 'gh_client_test_123',
    githubClientSecret: 'gh_secret_test_456',
    githubOAuthBaseUrl: mockGh.baseUrl,
    githubApiBaseUrl: mockGh.baseUrl,
    log: silentLog,
  })

  try {
    // 1. Unconfigured relay cleanly reports githubEnabled=false and returns 503 on start
    const { port: disabledPort } = await relayDisabled.start()
    const bsDisabled = await fetch(`http://127.0.0.1:${disabledPort}/api/account/bootstrap-status`).then((r) => r.json())
    assert.equal(bsDisabled.githubEnabled, false)
    const startDisabled = await fetch(`http://127.0.0.1:${disabledPort}/api/auth/github/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'login' }),
    })
    assert.equal(startDisabled.status, 503)

    // 2. Configured relay reports githubEnabled=true
    const { port } = await relay.start()
    const base = `http://127.0.0.1:${port}`
    const bs = await fetch(`${base}/api/account/bootstrap-status`).then((r) => r.json())
    assert.equal(bs.githubEnabled, true)

    // 3. First user signs up via GitHub OAuth (becomes admin, captures verified email, hasPassword=false)
    const start1 = await fetch(`${base}/api/auth/github/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'login',
        deviceName: 'Windows Desktop',
        clientKind: 'desktop',
        // Attempted open-redirect to foreign origin must be silently dropped (callback renders HTML instead of 302)
        returnUrl: 'https://evil.attacker.example/steal',
      }),
    }).then((r) => r.json())
    assert.equal(start1.ok, true)
    assert.ok(start1.pollToken.startsWith('ghp_'))
    const authUrl1 = new URL(start1.authorizeUrl)
    assert.equal(authUrl1.searchParams.get('client_id'), 'gh_client_test_123')
    const state1 = authUrl1.searchParams.get('state')
    assert.ok(state1 && state1.length >= 32)

    // Poll before callback returns pending
    const pollPending = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollToken: start1.pollToken }),
    }).then((r) => r.json())
    assert.equal(pollPending.status, 'pending')

    // Simulate GitHub callback (must NOT redirect to evil origin)
    const cb1Res = await fetch(`${base}/api/auth/github/callback?code=code_1&state=${encodeURIComponent(state1)}`, {
      redirect: 'manual',
    })
    assert.equal(cb1Res.status, 200)
    const cb1Html = await cb1Res.text()
    assert.match(cb1Html, /GitHub 登录成功/)
    assert.equal(cb1Html.includes('<script'), false)

    // Replay same state must fail with 400
    const cbReplay = await fetch(`${base}/api/auth/github/callback?code=code_1&state=${encodeURIComponent(state1)}`)
    assert.equal(cbReplay.status, 400)

    // Poll retrieves single-use JWT & new admin user
    const pollDone = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollToken: start1.pollToken }),
    }).then((r) => r.json())
    assert.equal(pollDone.ok, true)
    assert.equal(pollDone.status, 'completed')
    assert.equal(pollDone.isNewUser, true)
    assert.equal(pollDone.user.username, 'octo-dev')
    assert.equal(pollDone.user.role, 'admin')
    assert.equal(pollDone.user.email, 'octo@example.com')
    assert.equal(pollDone.user.githubLinked, true)
    assert.equal(pollDone.user.githubLogin, 'octo-dev')
    assert.equal(pollDone.user.hasPassword, false)
    assert.ok(pollDone.token)

    // Replaying same pollToken must fail (strictly single-use)
    const pollReplay = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollToken: start1.pollToken }),
    })
    assert.equal(pollReplay.status, 410)

    // /api/auth/me exposes githubEnabled, githubLinked, githubLogin, hasPassword
    const me1 = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${pollDone.token}` },
    }).then((r) => r.json())
    assert.equal(me1.ok, true)
    assert.equal(me1.githubEnabled, true)
    assert.equal(me1.githubLinked, true)
    assert.equal(me1.githubLogin, 'octo-dev')
    assert.equal(me1.hasPassword, false)

    // OAuth-only account without password cannot unlink GitHub (prevents self-lockout)
    const unlinkBlocked = await fetch(`${base}/api/account/github/unlink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pollDone.token}` },
    })
    assert.equal(unlinkBlocked.status, 400)

    // 4. Existing GitHub user signs in again with renamed GitHub login & valid same-origin returnUrl (302 redirect)
    profileRef.current = { id: 424242, login: 'octo-renamed', emails: [] }
    const start2 = await fetch(`${base}/api/auth/github/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'login', returnUrl: `${base}/` }),
    }).then((r) => r.json())
    const state2 = new URL(start2.authorizeUrl).searchParams.get('state')
    const cb2Res = await fetch(`${base}/api/auth/github/callback?code=code_2&state=${encodeURIComponent(state2)}`, {
      redirect: 'manual',
    })
    assert.equal(cb2Res.status, 302)
    assert.equal(cb2Res.headers.get('location'), `${base}/?oauth=github`)
    const poll2 = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollToken: start2.pollToken }),
    }).then((r) => r.json())
    assert.equal(poll2.isNewUser, false)
    assert.equal(poll2.roomId, pollDone.roomId)
    assert.equal(poll2.user.githubLogin, 'octo-renamed')

    // 5. Existing password user binds a different GitHub account, rejects duplicate bind, and unlinks cleanly
    const regBob = await fetch(`${base}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob_dev', password: 'BobPassword123!' }),
    }).then((r) => r.json())
    assert.equal(regBob.ok, true)

    // Binding already-taken GitHub ID 424242 to Bob must fail cleanly
    const bindDupStart = await fetch(`${base}/api/auth/github/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regBob.token}` },
      body: JSON.stringify({ mode: 'bind' }),
    }).then((r) => r.json())
    const bindDupState = new URL(bindDupStart.authorizeUrl).searchParams.get('state')
    await fetch(`${base}/api/auth/github/callback?code=code_dup&state=${encodeURIComponent(bindDupState)}`)
    // Another user trying to poll Bob's bind handshake must receive 403
    const crossPoll = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pollDone.token}` },
      body: JSON.stringify({ pollToken: bindDupStart.pollToken }),
    })
    assert.equal(crossPoll.status, 403)
    const bindDupPoll = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regBob.token}` },
      body: JSON.stringify({ pollToken: bindDupStart.pollToken }),
    }).then((r) => r.json())
    assert.equal(bindDupPoll.status, 'failed')
    assert.match(bindDupPoll.error, /已绑定到其他/)

    // Binding a fresh GitHub ID 777888 to Bob succeeds, and Bob (hasPassword=true) can unlink
    profileRef.current = { id: 777888, login: 'bob-github', emails: [] }
    const bindOkStart = await fetch(`${base}/api/auth/github/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regBob.token}` },
      body: JSON.stringify({ mode: 'bind' }),
    }).then((r) => r.json())
    const bindOkState = new URL(bindOkStart.authorizeUrl).searchParams.get('state')
    await fetch(`${base}/api/auth/github/callback?code=code_bob&state=${encodeURIComponent(bindOkState)}`)
    const bindOkPoll = await fetch(`${base}/api/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regBob.token}` },
      body: JSON.stringify({ pollToken: bindOkStart.pollToken }),
    }).then((r) => r.json())
    assert.equal(bindOkPoll.ok, true)
    assert.equal(bindOkPoll.mode, 'bind')
    assert.equal(bindOkPoll.user.githubLinked, true)
    assert.equal(bindOkPoll.user.githubLogin, 'bob-github')

    const unlinkBob = await fetch(`${base}/api/account/github/unlink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regBob.token}` },
    }).then((r) => r.json())
    assert.equal(unlinkBob.ok, true)
    assert.equal(unlinkBob.user.githubLinked, false)
  } finally {
    await relayDisabled.close()
    await relay.close()
    await mockGh.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
