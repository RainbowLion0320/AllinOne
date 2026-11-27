#!/usr/bin/env node
/**
 * Zero-dependency Ed25519 release manifest signer for All in One Desktop installers.
 *
 * Usage:
 *   node scripts/sign-desktop-release.mjs --keygen
 *   node scripts/sign-desktop-release.mjs --version 1.0.30 --out All-in-One-Desktop-Release.json <file1> <file2> ...
 *
 * Reads DESKTOP_UPDATE_ED25519_PRIVATE_KEY (PEM string or base64-encoded PKCS8 PEM).
 * Canonical signed payload:
 *   allinone-desktop-release-v1\n<version>\n<name>:<sha256>:<size>\n... (assets sorted lexicographically by name)
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareCodePoint } from '../packages/shared/src/semver.js'

export function computeDesktopManifestCanonicalPayload(version, assets = []) {
  const cleanVer = String(version || '').trim().replace(/^v/i, '')
  const lines = [...assets]
    .filter((a) => a && a.name && a.sha256)
    .map((a) => ({
      name: String(a.name).trim(),
      sha256: String(a.sha256).trim().toLowerCase(),
      size: Number(a.size) || 0,
    }))
    .sort((a, b) => compareCodePoint(a.name, b.name))
    .map((a) => `${a.name}:${a.sha256}:${a.size}`)
  return `allinone-desktop-release-v1\n${cleanVer}\n${lines.join('\n')}`
}

function parsePrivateKeyInput(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('Missing Ed25519 private key')
  if (trimmed.includes('BEGIN PRIVATE KEY')) {
    return createPrivateKey(trimmed)
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  if (decoded.includes('BEGIN PRIVATE KEY')) {
    return createPrivateKey(decoded)
  }
  return createPrivateKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'pkcs8' })
}

export function signDesktopReleaseManifest({ version, files = [], privateKeyPem }) {
  const cleanVer = String(version || '').trim().replace(/^v/i, '')
  if (!cleanVer) throw new Error('Missing release version')
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No release installer files supplied')
  }
  const assets = files.map((filePath) => {
    const resolved = resolve(filePath)
    if (!existsSync(resolved)) throw new Error(`Release asset not found: ${resolved}`)
    const buf = readFileSync(resolved)
    const st = statSync(resolved)
    return {
      name: basename(resolved),
      sha256: createHash('sha256').update(buf).digest('hex').toLowerCase(),
      size: st.size,
    }
  })
  assets.sort((a, b) => compareCodePoint(a.name, b.name))

  const privKey = parsePrivateKeyInput(privateKeyPem)
  const pubKey = createPublicKey(privKey)
  const payload = computeDesktopManifestCanonicalPayload(cleanVer, assets)
  const sigBuf = sign(null, Buffer.from(payload, 'utf8'), privKey)
  if (!verify(null, Buffer.from(payload, 'utf8'), pubKey, sigBuf)) {
    throw new Error('Self-verification of generated Ed25519 signature failed')
  }

  return {
    schema: 1,
    version: cleanVer,
    sigAlg: 'Ed25519',
    signature: sigBuf.toString('base64'),
    assets,
  }
}

export function verifyDesktopReleaseManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== 'object') return false
  if (manifest.sigAlg !== 'Ed25519' || !manifest.signature || !manifest.version || !Array.isArray(manifest.assets)) {
    return false
  }
  const trimmedPub = String(publicKeyPem || '').trim()
  if (!trimmedPub) return false
  try {
    const pubKey = trimmedPub.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(trimmedPub)
      : createPublicKey({ key: Buffer.from(trimmedPub, 'base64'), format: 'der', type: 'spki' })
    const payload = computeDesktopManifestCanonicalPayload(manifest.version, manifest.assets)
    const sigBuf = Buffer.from(String(manifest.signature).trim(), 'base64')
    if (sigBuf.length !== 64) return false
    return verify(null, Buffer.from(payload, 'utf8'), pubKey, sigBuf)
  } catch {
    return false
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--keygen')) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    console.log('# Store DESKTOP_UPDATE_ED25519_PRIVATE_KEY as a GitHub Actions Secret:')
    console.log(privPem.trim())
    console.log('\n# Pin this SPKI base64 public key in packages/desktop-app/src/updater.js:')
    console.log(pubDerB64)
    process.exit(0)
  }

  let version = ''
  let outPath = 'All-in-One-Desktop-Release.json'
  const files = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--version' && args[i + 1]) {
      version = args[++i]
    } else if (args[i] === '--out' && args[i + 1]) {
      outPath = args[++i]
    } else if (!args[i].startsWith('-')) {
      files.push(args[i])
    }
  }
  const allowUnsigned = args.includes('--allow-unsigned')
  const privKey = String(process.env.DESKTOP_UPDATE_ED25519_PRIVATE_KEY || '').trim()
  if (!privKey) {
    if (allowUnsigned) {
      console.warn('[sign-desktop-release] DESKTOP_UPDATE_ED25519_PRIVATE_KEY is not set; skipping manifest signing (--allow-unsigned).')
      process.exit(0)
    }
    console.error('[sign-desktop-release] ERROR: DESKTOP_UPDATE_ED25519_PRIVATE_KEY is not set (fail-closed). Pass --allow-unsigned only for local unsigned testing.')
    process.exit(1)
  }
  const manifest = signDesktopReleaseManifest({ version, files, privateKeyPem: privKey })
  writeFileSync(resolve(outPath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[sign-desktop-release] Signed ${manifest.assets.length} asset(s) for v${manifest.version} -> ${outPath}`)
}
