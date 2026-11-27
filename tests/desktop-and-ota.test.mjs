import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { signDesktopReleaseManifest, verifyDesktopReleaseManifest } from '../scripts/sign-desktop-release.mjs'
import {
  DEFAULT_DESKTOP_MANIFEST_PUBLIC_KEY,
  DesktopUpdater,
  buildWindowsUpdateScripts,
  verifyManifestSignature,
} from '../packages/desktop-app/src/updater.js'
import { resolveSafeDeliverableCwd, resolveSafeDesktopDeliverable } from '../packages/desktop-app/src/safe-paths.js'
import { DesktopBridgeManager } from '../packages/desktop-app/src/bridge-manager.js'
import { buildZipBuffer, computeOtaCanonicalPayload } from '../scripts/package-android-ota.mjs'

test('Desktop Ed25519 release manifest signs, verifies, and rejects tampered assets/versions', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-sign-unit-'))
  try {
    const dmg = join(dir, 'All.in.One-1.0.30-arm64.dmg')
    const exe = join(dir, 'All.in.One.Setup.1.0.30.exe')
    writeFileSync(dmg, Buffer.from('fake-dmg-payload-bytes'))
    writeFileSync(exe, Buffer.from('fake-exe-payload-bytes'))

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const manifest = signDesktopReleaseManifest({
      version: '1.0.30',
      files: [dmg, exe],
      privateKeyPem: privPem,
    })
    assert.equal(manifest.sigAlg, 'Ed25519')
    assert.equal(manifest.assets.length, 2)
    assert.equal(verifyDesktopReleaseManifest(manifest, pubDerB64), true)
    assert.equal(verifyManifestSignature(manifest, pubDerB64), true)
    assert.equal(verifyManifestSignature(manifest, pubPem), true)

    // Tampered version or asset hash MUST fail
    assert.equal(verifyManifestSignature({ ...manifest, version: '1.0.31' }, pubDerB64), false)
    const badAssets = manifest.assets.map((a, i) => (i === 0 ? { ...a, sha256: '0'.repeat(64) } : a))
    assert.equal(verifyManifestSignature({ ...manifest, assets: badAssets }, pubDerB64), false)

    // Wrong public key MUST fail
    const other = generateKeyPairSync('ed25519')
    const otherPub = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    assert.equal(verifyManifestSignature(manifest, otherPub), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows NSIS silent updater script preserves install directory with /D=', () => {
  const { psScript } = buildWindowsUpdateScripts({
    installerPath: 'C:\\Users\\demo\\AppData\\Local\\Temp\\AllInOneSetup.exe',
    exePath: 'D:\\CustomApps\\AllInOne\\All in One.exe',
    pid: 12345,
    isPackaged: true,
    expectedSha256: 'a'.repeat(64),
  })
  assert.ok(psScript.includes('/S /D=$installDir'))
  assert.ok(psScript.includes('D:\\CustomApps\\AllInOne'))
})

test('Android OTA packager produces deterministic PKZIP and canonical payload', () => {
  const z1 = buildZipBuffer([
    { name: 'b.js', data: Buffer.from('console.log(2)') },
    { name: 'index.html', data: Buffer.from('<!doctype html>') },
  ])
  const z2 = buildZipBuffer([
    { name: 'index.html', data: Buffer.from('<!doctype html>') },
    { name: 'b.js', data: Buffer.from('console.log(2)') },
  ])
  assert.equal(Buffer.compare(z1, z2), 0, 'PKZIP output must be byte-identical regardless of entry order')
  assert.equal(
    computeOtaCanonicalPayload({ version: '1.0.30', minNativeVersion: '1.0.26', sha256: 'AA'.repeat(32), size: 99 }),
    `allinone-ota-v1\n1.0.30\n1.0.26\n${'aa'.repeat(32)}\n99`,
  )
})

test('DesktopUpdater exports DEFAULT_DESKTOP_MANIFEST_PUBLIC_KEY and fails closed when manifest is missing or unsigned', async () => {
  assert.equal(typeof DEFAULT_DESKTOP_MANIFEST_PUBLIC_KEY, 'string')
  assert.ok(DEFAULT_DESKTOP_MANIFEST_PUBLIC_KEY.length >= 32)

  const defaultUpdater = new DesktopUpdater({ currentVersion: '1.0.20' })
  assert.equal(defaultUpdater.requireSignature, true)
  assert.equal(defaultUpdater.manifestPublicKey, DEFAULT_DESKTOP_MANIFEST_PUBLIC_KEY)

  const dir = mkdtempSync(join(os.tmpdir(), 'aio-updater-failclosed-'))
  let mode = 'missing-manifest'
  let server = null
  try {
    const dmgFile = join(dir, 'All.in.One-1.0.99-arm64.dmg')
    writeFileSync(dmgFile, Buffer.from('signed-dmg-bytes'))
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const validManifest = signDesktopReleaseManifest({
      version: '1.0.99',
      files: [dmgFile],
      privateKeyPem: privPem,
    })

    server = http.createServer((req, res) => {
      const port = server.address().port
      const base = `http://127.0.0.1:${port}`
      if (req.url === '/release') {
        const assets = [
          {
            name: 'All.in.One-1.0.99-arm64.dmg',
            size: 16,
            browser_download_url: `${base}/dmg`,
            digest: `sha256:${validManifest.assets[0].sha256}`,
          },
        ]
        if (mode !== 'missing-manifest') {
          assets.push({
            name: 'All-in-One-Desktop-Release.json',
            size: 256,
            browser_download_url: `${base}/manifest`,
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ tag_name: 'v1.0.99', assets }))
        return
      }
      if (req.url === '/manifest') {
        const payload =
          mode === 'unsigned-manifest'
            ? { ...validManifest, signature: '' }
            : validManifest
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const apiUrl = `http://127.0.0.1:${server.address().port}/release`

    // 1. Missing manifest -> status === 'error' (fail-closed)
    mode = 'missing-manifest'
    const uMissing = new DesktopUpdater({
      currentVersion: '1.0.20',
      platform: 'darwin',
      arch: 'arm64',
      apiUrl,
      allowLocalhost: true,
      downloadDir: join(dir, 'dl1'),
      manifestPublicKey: pubDerB64,
    })
    const stMissing = await uMissing.checkForUpdates()
    assert.equal(stMissing.status, 'error')
    assert.ok(stMissing.error)

    // 2. Unsigned manifest -> status === 'error' (fail-closed)
    mode = 'unsigned-manifest'
    const uUnsigned = new DesktopUpdater({
      currentVersion: '1.0.20',
      platform: 'darwin',
      arch: 'arm64',
      apiUrl,
      allowLocalhost: true,
      downloadDir: join(dir, 'dl2'),
      manifestPublicKey: pubDerB64,
    })
    const stUnsigned = await uUnsigned.checkForUpdates()
    assert.equal(stUnsigned.status, 'error')

    // 3. Valid Ed25519 signed manifest -> status === 'available'
    mode = 'valid-manifest'
    const uValid = new DesktopUpdater({
      currentVersion: '1.0.20',
      platform: 'darwin',
      arch: 'arm64',
      apiUrl,
      allowLocalhost: true,
      downloadDir: join(dir, 'dl3'),
      manifestPublicKey: pubDerB64,
    })
    const stValid = await uValid.checkForUpdates()
    assert.equal(stValid.status, 'available')
    assert.equal(stValid.expectedSha256, validManifest.assets[0].sha256)
  } finally {
    if (server) await new Promise((r) => server.close(r))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSafeDesktopDeliverable enforces cwd/sensitive-path blocks while allowing workspace, temp, and brain .md', () => {
  const root = mkdtempSync(join(os.tmpdir(), 'aio-safepaths-'))
  try {
    const fakeHome = join(root, 'home', 'alice')
    const fakeTemp = join(root, 'tmp')
    const wsDir = join(fakeHome, 'AllinOne-Workspace')
    const tempSub = join(fakeTemp, 'export-sub')
    const geminiDir = join(fakeHome, '.gemini')
    const brainConv = join(geminiDir, 'antigravity', 'brain', 'conv-123')
    const sshDir = join(fakeHome, '.ssh')

    mkdirSync(wsDir, { recursive: true })
    mkdirSync(tempSub, { recursive: true })
    mkdirSync(brainConv, { recursive: true })
    mkdirSync(sshDir, { recursive: true })

    const wsReport = join(wsDir, 'report.pdf')
    const tmpDoc = join(tempSub, 'summary.md')
    const oauthCreds = join(geminiDir, 'oauth_creds.json')
    const geminiNote = join(geminiDir, 'notes.md')
    const sshKey = join(sshDir, 'id_rsa')
    const sshNote = join(sshDir, 'readme.md')
    const brainMd = join(brainConv, 'walkthrough.md')
    const brainEnv = join(brainConv, '.env')
    const brainEnvTxt = join(brainConv, '.env.txt')
    const brainSettings = join(brainConv, 'settings.json')
    const brainCredsMd = join(brainConv, 'oauth_creds.md')

    for (const f of [
      wsReport,
      tmpDoc,
      oauthCreds,
      geminiNote,
      sshKey,
      sshNote,
      brainMd,
      brainEnv,
      brainEnvTxt,
      brainSettings,
      brainCredsMd,
    ]) {
      writeFileSync(f, 'test-content', 'utf8')
    }

    const opts = { homeDir: fakeHome, tempDir: fakeTemp }

    // Reject cwd='/' and root paths
    assert.equal(resolveSafeDeliverableCwd('/', fakeHome, fakeTemp), '')
    assert.equal(resolveSafeDesktopDeliverable('/etc/passwd', '/', opts).ok, false)

    // Reject sensitive credential dirs (~/.gemini/oauth_creds.json, ~/.ssh/id_rsa, even .md inside them)
    assert.equal(resolveSafeDesktopDeliverable(oauthCreds, wsDir, opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(geminiNote, wsDir, opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(sshKey, wsDir, opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(sshNote, wsDir, opts).ok, false)

    // Allow valid deliverables inside safe workspace and safe temp subdir
    const okWs = resolveSafeDesktopDeliverable(wsReport, wsDir, opts)
    assert.equal(okWs.ok, true)
    assert.equal(okWs.ext, '.pdf')

    const okTmp = resolveSafeDesktopDeliverable(tmpDoc, tempSub, opts)
    assert.equal(okTmp.ok, true)
    assert.equal(okTmp.ext, '.md')

    // Allow read-only .md inside ~/.gemini/antigravity/brain/<conv>/
    const okBrain = resolveSafeDesktopDeliverable(brainMd, '', opts)
    assert.equal(okBrain.ok, true)
    assert.equal(okBrain.ext, '.md')

    // Reject .env, .env.txt, settings.json, and oauth_creds.md inside brain dir
    assert.equal(resolveSafeDesktopDeliverable(brainEnv, '', opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(brainEnvTxt, '', opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(brainSettings, '', opts).ok, false)
    assert.equal(resolveSafeDesktopDeliverable(brainCredsMd, '', opts).ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DesktopBridgeManager syncAccount resets tripped circuit breaker and handleSystemResume does not kill starting bridge', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-bridge-mgr-'))
  try {
    // 1. syncAccount resets tripped circuit breaker state
    const mgr = new DesktopBridgeManager()
    mgr.stateDir = join(dir, 'state')
    mgr.workspaceDir = join(dir, 'ws')
    mgr.configPath = join(mgr.stateDir, 'config.json')
    mgr.logPath = join(mgr.stateDir, 'desktop-bridge.log')

    const now = Date.now()
    mgr.restartAttempts = 5
    mgr.restartTimestamps = [now - 1000, now - 800, now - 600, now - 400, now - 200]
    mgr.authRevoked = true
    mgr.state = 'error'
    mgr.error = 'Restart circuit breaker tripped'

    let spawnCount = 0
    mgr.registerDeviceWithJwt = async () => ({
      roomId: 'usr_cb_reset',
      userId: 'usr_cb_reset',
      username: 'desktop_alice',
      deviceId: 'dev_1',
      bridgeId: 'mac-mini',
      deviceSecret: 'dv_secret_123456',
      label: 'Mac Mini',
    })
    mgr.spawnBridgeProcess = async () => {
      spawnCount += 1
      mgr.state = 'starting'
      mgr.error = ''
    }

    const st = await mgr.syncAccount({
      baseUrl: 'https://relay.example.com',
      token: 'jwt_token_123',
      roomId: 'usr_cb_reset',
      username: 'desktop_alice',
    })
    assert.equal(spawnCount, 1)
    assert.equal(mgr.restartAttempts, 0)
    assert.deepEqual(mgr.restartTimestamps, [])
    assert.equal(mgr.authRevoked, false)
    assert.equal(st.state, 'starting')

    // 2. handleSystemResume does NOT kill a currently 'starting' bridge child
    let killCalls = 0
    let resumeSpawnCalls = 0
    let stdinWrites = 0
    const aliveProc = {
      killed: false,
      exitCode: null,
      stdin: {
        destroyed: false,
        writable: true,
        write: () => {
          stdinWrites += 1
        },
      },
    }
    mgr.proc = aliveProc
    mgr.state = 'starting'
    mgr.killChild = async () => {
      killCalls += 1
    }
    mgr.spawnBridgeProcess = async () => {
      resumeSpawnCalls += 1
    }

    const afterStartingResume = await mgr.handleSystemResume()
    assert.equal(killCalls, 0)
    assert.equal(resumeSpawnCalls, 0)
    assert.equal(stdinWrites, 0)
    assert.equal(mgr.proc, aliveProc)
    assert.equal(afterStartingResume.state, 'starting')

    // When connected, handleSystemResume sends a probe instead of killing/restarting
    mgr.state = 'connected'
    await mgr.handleSystemResume()
    assert.equal(killCalls, 0)
    assert.equal(resumeSpawnCalls, 0)
    assert.equal(stdinWrites, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
