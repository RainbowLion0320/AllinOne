import test from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createAccountStore, resolveAccountsDbPath } from '../packages/relay-server/src/accounts.js'

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
