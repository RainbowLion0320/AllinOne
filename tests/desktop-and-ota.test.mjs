import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { signDesktopReleaseManifest, verifyDesktopReleaseManifest } from '../scripts/sign-desktop-release.mjs'
import { buildWindowsUpdateScripts, verifyManifestSignature } from '../packages/desktop-app/src/updater.js'
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
