#!/usr/bin/env node
/**
 * Packages `packages/mobile-app/dist/` into a compact, deterministic PKZIP archive
 * (`packages/mobile-app/release/All-in-One-WebBundle.zip`) and manifest JSON
 * (`packages/mobile-app/release/All-in-One-WebBundle.json`) for zero-knowledge
 * in-app Android OTA hot-updates.
 *
 * When ANDROID_KEYSTORE_PATH is set (CI release builds), cryptographically signs the
 * canonical OTA payload using the EXACT SAME Android release keystore that signs the APK,
 * so AllinOneUpdaterPlugin can verify bundles against the APK's own signing certificate
 * even when served from a fast regional relay mirror.
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DEFAULT_DIST_DIR = join(REPO_ROOT, 'packages', 'mobile-app', 'dist')
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'packages', 'mobile-app', 'release')
const DEFAULT_MIN_NATIVE_VERSION = '1.0.26'

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Pure-Node deterministic PKZIP builder compatible with Java `ZipInputStream` and standard unzip.
 * Each entry: `{ name: 'path/to/file', data: Buffer }`.
 */
export function buildZipBuffer(entries) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of sorted) {
    const cleanName = String(entry.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
    if (!cleanName || cleanName.includes('..') || cleanName.includes('\0')) {
      throw new Error(`Unsafe zip entry name: ${entry.name}`)
    }
    const nameBuf = Buffer.from(cleanName, 'utf8')
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const deflated = deflateRawSync(rawBuf, { level: 9 })
    const useDeflate = deflated.length < rawBuf.length
    const method = useDeflate ? 8 : 0
    const payload = useDeflate ? deflated : rawBuf
    const checksum = crc32(rawBuf)
    const flags = 0x0800 // UTF-8 filename encoding

    // Local file header (30 bytes + filename + payload)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed: 2.0
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10) // mod time (deterministic)
    localHeader.writeUInt16LE(0x21, 12) // mod date (1980-01-01, deterministic)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra len

    localParts.push(localHeader, nameBuf, payload)

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x21, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra len
    centralHeader.writeUInt16LE(0, 32) // comment len
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDirBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(centralDirBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirBuf, eocd])
}

export function computeOtaCanonicalPayload({ version, minNativeVersion = '', sha256, size }) {
  return `allinone-ota-v1\n${String(version || '').trim()}\n${String(minNativeVersion || '').trim()}\n${String(sha256 || '').trim().toLowerCase()}\n${Number(size) || 0}`
}

function collectDistFiles(rootDir) {
  const entries = []
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name)
      const rel = relative(rootDir, full).replace(/\\/g, '/')
      // Exclude PC bridge downloads & shell installers not used inside the Android WebView
      if (rel === 'downloads' || rel.startsWith('downloads/')) continue
      if (rel === 'setup.ps1' || rel === 'setup.sh') continue
      if (rel.endsWith('.map')) continue
      if (dirent.isDirectory()) {
        walk(full)
      } else if (dirent.isFile()) {
        entries.push({ name: rel, data: readFileSync(full) })
      }
    }
  }
  walk(rootDir)
  return entries
}

const JAVA_SIGNER_SOURCE = `
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.util.Base64;

class SignOtaPayload {
    public static void main(String[] args) throws Exception {
        String ksPath = System.getenv("ANDROID_KEYSTORE_PATH");
        String ksPass = System.getenv("ANDROID_KEYSTORE_PASSWORD");
        String alias = System.getenv("ANDROID_KEY_ALIAS");
        String keyPass = System.getenv("ANDROID_KEY_PASSWORD");
        String payload = System.getenv("OTA_SIGN_PAYLOAD");
        if (alias == null || alias.isEmpty()) alias = "allinone";
        if (keyPass == null || keyPass.isEmpty()) keyPass = ksPass;
        if (ksPath == null || ksPath.isEmpty() || ksPass == null || payload == null) {
            throw new IllegalArgumentException("Missing keystore environment variables");
        }
        KeyStore ks = KeyStore.getInstance(new File(ksPath), ksPass.toCharArray());
        Key key = ks.getKey(alias, keyPass.toCharArray());
        if (!(key instanceof PrivateKey)) {
            throw new IllegalStateException("Keystore entry is not a PrivateKey: " + alias);
        }
        Certificate cert = ks.getCertificate(alias);
        if (cert == null) {
            throw new IllegalStateException("Keystore entry missing certificate: " + alias);
        }
        PrivateKey priv = (PrivateKey) key;
        String keyAlg = priv.getAlgorithm().toUpperCase();
        String sigAlg = keyAlg.contains("EC") ? "SHA256withECDSA" : "SHA256withRSA";
        byte[] data = payload.getBytes(StandardCharsets.UTF_8);

        Signature signer = Signature.getInstance(sigAlg);
        signer.initSign(priv);
        signer.update(data);
        byte[] sig = signer.sign();

        Signature verifier = Signature.getInstance(sigAlg);
        verifier.initVerify(cert.getPublicKey());
        verifier.update(data);
        if (!verifier.verify(sig)) {
            throw new SecurityException("Self-verification of generated OTA signature failed");
        }
        String b64 = Base64.getEncoder().encodeToString(sig);
        System.out.print("{\\"sigAlg\\":\\"" + sigAlg + "\\",\\"signature\\":\\"" + b64 + "\\"}");
    }
}
`

function signOtaPayloadWithKeystore(payload) {
  const ksPath = String(process.env.ANDROID_KEYSTORE_PATH || '').trim()
  const ksPass = String(process.env.ANDROID_KEYSTORE_PASSWORD || '')
  if (!ksPath || !existsSync(ksPath) || !ksPass) {
    return { sigAlg: '', signature: '' }
  }
  const tmpJava = join(os.tmpdir(), `SignOtaPayload-${process.pid}-${randomBytes(4).toString('hex')}.java`)
  writeFileSync(tmpJava, JAVA_SIGNER_SOURCE, 'utf8')
  try {
    const out = execFileSync('java', [tmpJava], {
      env: { ...process.env, OTA_SIGN_PAYLOAD: payload },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim()
    const parsed = JSON.parse(out)
    if (!parsed?.sigAlg || !parsed?.signature) {
      throw new Error('Unexpected signer output')
    }
    return { sigAlg: parsed.sigAlg, signature: parsed.signature }
  } finally {
    try {
      unlinkSync(tmpJava)
    } catch {}
  }
}

export function packageAndroidOtaBundle({
  distDir = DEFAULT_DIST_DIR,
  outDir = DEFAULT_OUT_DIR,
  version = '',
  minNativeVersion = process.env.ANDROID_MIN_NATIVE_VERSION || DEFAULT_MIN_NATIVE_VERSION,
  signWithKeystore = true,
} = {}) {
  if (!existsSync(distDir)) {
    throw new Error(`dist directory not found: ${distDir}`)
  }
  const resolvedVersion =
    String(version || '').trim().replace(/^v/i, '') ||
    JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'mobile-app', 'package.json'), 'utf8')).version

  const entries = collectDistFiles(distDir)
  if (!entries.some((e) => e.name === 'index.html')) {
    throw new Error(`dist directory is missing index.html: ${distDir}`)
  }

  const zipBuf = buildZipBuffer(entries)
  const sha256 = createHash('sha256').update(zipBuf).digest('hex').toLowerCase()
  const size = zipBuf.length

  mkdirSync(outDir, { recursive: true })
  const zipName = 'All-in-One-WebBundle.zip'
  const manifestName = 'All-in-One-WebBundle.json'
  const zipPath = join(outDir, zipName)
  const manifestPath = join(outDir, manifestName)
  writeFileSync(zipPath, zipBuf)

  const payload = computeOtaCanonicalPayload({
    version: resolvedVersion,
    minNativeVersion,
    sha256,
    size,
  })
  const { sigAlg, signature } = signWithKeystore ? signOtaPayloadWithKeystore(payload) : { sigAlg: '', signature: '' }

  const manifest = {
    schema: 1,
    version: resolvedVersion,
    minNativeVersion: String(minNativeVersion || '').trim(),
    bundleFile: zipName,
    sha256,
    size,
    ...(sigAlg && signature ? { sigAlg, signature } : {}),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { zipPath, manifestPath, manifest, fileCount: entries.length }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const result = packageAndroidOtaBundle()
  const kb = (result.manifest.size / 1024).toFixed(1)
  console.log(
    `[package-android-ota] Built ${result.zipPath} (v${result.manifest.version}, ${result.fileCount} files, ${kb} KB, sha256=${result.manifest.sha256.slice(0, 12)}..., signed=${result.manifest.signature ? result.manifest.sigAlg : 'no'})`,
  )
}
