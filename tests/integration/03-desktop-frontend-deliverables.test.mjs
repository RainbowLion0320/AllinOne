import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { DesktopWebRtcProxy } from '../../packages/desktop-app/src/webrtc-proxy.js'
import { ElectronWebRtcClient } from '../../packages/dsh-mobile-hub/src/p2p/peer-electron.js'
import {
  DesktopBridgeManager,
  loadConfigDecrypted,
  loadConfigWithStatus,
  saveConfigSecure,
} from '../../packages/desktop-app/src/bridge-manager.js'
import {
  DesktopUpdater,
  buildWindowsUpdateScripts,
  compareSemver,
  pickReleaseAsset,
} from '../../packages/desktop-app/src/updater.js'
import { computeDesktopManifestCanonicalPayload } from '../../scripts/sign-desktop-release.mjs'
import {
  buildZipBuffer,
  computeOtaCanonicalPayload,
  packageAndroidOtaBundle,
} from '../../scripts/package-android-ota.mjs'
import { MultiAppOrchestrator } from '../../packages/dsh-mobile-hub/src/orchestrator.js'
import { computeE2eeKeyId, generateE2eeKey } from '../../packages/shared/src/e2ee.js'
import { extractDeliverableRefsFromMessage } from '../../packages/mobile-app/src/lib/deliverableFiles.js'
import {
  computeSidebarVendorLayout,
  formatQuotaBadgeText,
  formatQuotaTooltip,
} from '../../packages/mobile-app/src/lib/sidebarVendors.js'
import {
  buildHomeQuotaCards,
  extractVendorQuotaDetails,
  formatQuotaResetCountdown,
} from '../../packages/mobile-app/src/lib/quotaDashboard.js'
import {
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  saveDeviceState,
  selectDevice,
  upsertDevice,
  upsertDeviceE2eeKey,
} from '../../packages/mobile-app/src/lib/deviceStore.js'
import {
  clearSessionCache,
  formatBytesCompact,
  getSessionCacheStats,
  loadCachedSession,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from '../../packages/mobile-app/src/lib/sessionCache.js'
import {
  checkNativeMobileUpdate,
  isHotReloadableWebOrigin,
  resolveCurrentAppBaseUrl,
} from '../../packages/mobile-app/src/lib/clientHelpers.js'
import { resolveImageSrc } from '../../packages/mobile-app/src/lib/imageUrls.js'
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
} from '../../packages/mobile-app/src/lib/draftStore.js'
import {
  LANG_STORAGE_KEY,
  MESSAGES,
  bi,
  detectInitialLang,
  loadSavedLang,
  normalizeLang,
  saveLang,
  translate,
} from '../../packages/mobile-app/src/lib/i18n.js'
import { createIsolatedRelayEnv, createMockSecretStore, createTempDir } from './harness.mjs'

test('Suite 10: Desktop security (safeStorage), Auto-Updater (Ed25519/SHA-256/TOCTOU/x64 guard), Android OTA & Electron WebRTC Proxy', async () => {
  const temp = createTempDir('allinone-int-03-desktop-')
  const tmpDir = temp.dir
  const mockHttpBase = 'http://127.0.0.1:8787'

  try {
    // 10a. safeStorage encrypted config, locked-keychain decrypt-error & DesktopBridgeManager.setE2eeKey
    const secretStore = createMockSecretStore()
    const lockedStore = {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error('Keychain locked')
      },
      decrypt: () => {
        throw new Error('Keychain locked')
      },
    }
    const deskDir = join(tmpDir, 'desktop-sec')
    mkdirSync(deskDir, { recursive: true })
    const cfgPath = join(deskDir, 'config.json')
    const k1 = generateE2eeKey()
    const k2 = generateE2eeKey()
    saveConfigSecure(
      cfgPath,
      {
        mode: 'account',
        roomId: 'usr_desk',
        bridgeId: 'pc-1',
        bridgeSecret: 'dv_secret',
        serverUrl: mockHttpBase,
        e2eeKey: k1,
        autoStartDisabled: true,
      },
      secretStore,
    )
    const rawDisk = readFileSync(cfgPath, 'utf8')
    assert.equal(rawDisk.includes('dv_secret'), false)
    assert.equal(rawDisk.includes(k1), false)
    const decCfg = loadConfigDecrypted(cfgPath, secretStore)
    assert.equal(decCfg.bridgeSecret, 'dv_secret')
    assert.equal(decCfg.e2eeKey, k1)
    assert.equal(loadConfigWithStatus(cfgPath, lockedStore).status, 'decrypt-error')

    const dm = new DesktopBridgeManager({ secretStore })
    dm.stateDir = deskDir
    dm.configPath = cfgPath
    dm.logPath = join(deskDir, 'desktop-bridge.log')
    dm.enabled = true
    dm.spawnBridgeProcess = async () => {}
    await assert.rejects(() => dm.setE2eeKey('usr_desk', `${k2}=GARBAGE`), /无效的端到端密钥格式/)
    await dm.setE2eeKey('usr_desk', k2)
    const afterKeyCfg = loadConfigDecrypted(cfgPath, secretStore)
    assert.equal(afterKeyCfg.e2eeKey, k2)
    assert.equal(afterKeyCfg.autoStartDisabled, undefined)

    // 10b. DesktopUpdater (semver, platform/arch asset guard, Windows WScript/PS1, Ed25519 manifest, SHA-256, cache reuse & TOCTOU)
    assert.equal(compareSemver('1.0.8', '1.0.7'), 1)
    assert.equal(compareSemver('v1.10.0', '1.9.9'), 1)
    assert.equal(compareSemver('1.0.8', 'v1.0.8'), 0)
    assert.equal(compareSemver('1.0.8', '1.0.8-beta.1'), 1)
    assert.equal(compareSemver('1.0.7', '1.0.8'), -1)

    const sampleAssets = [
      { name: 'All.in.One-1.0.8-arm64.dmg', browser_download_url: 'https://github.com/a/b/All.in.One-1.0.8-arm64.dmg' },
      { name: 'All.in.One.Setup.1.0.8.exe', browser_download_url: 'https://github.com/a/b/All.in.One.Setup.1.0.8.exe' },
    ]
    assert.equal(pickReleaseAsset(sampleAssets, 'win32', 'x64')?.name, 'All.in.One.Setup.1.0.8.exe')
    assert.equal(pickReleaseAsset(sampleAssets, 'darwin', 'arm64')?.name, 'All.in.One-1.0.8-arm64.dmg')
    assert.equal(pickReleaseAsset(sampleAssets, 'darwin', 'x64'), null, 'Intel Mac x64 must never pick arm64 DMG')

    const winScripts = buildWindowsUpdateScripts({
      installerPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\All.in.One.Setup.1.0.8.exe',
      exePath: 'C:\\Users\\张三\\AppData\\Local\\Programs\\all-in-one\\All in One.exe',
      pid: 12345,
      isPackaged: true,
      logPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\last-update.log',
      ps1Path: 'C:\\Users\\张三\\AppData\\Local\\Temp\\apply-update.ps1',
    })
    assert.ok(winScripts.vbsScript.includes('sh.Run cmd, 0, True'))
    assert.ok(
      winScripts.psScript.includes('Get-Process -Id $oldPid') &&
        winScripts.psScript.includes('/S /D=$installDir') &&
        winScripts.psScript.includes('-ArgumentList $nsisArgs'),
    )
    assert.equal(winScripts.psScript.includes('tasklist'), false)

    // Ephemeral Ed25519 keypair for fail-closed DesktopUpdater manifest verification
    const { publicKey: testPubKey, privateKey: testPrivKey } = generateKeyPairSync('ed25519')
    const { privateKey: wrongPrivKey } = generateKeyPairSync('ed25519')
    const testPubB64 = testPubKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const signMockManifest = (version, assets, privKey = testPrivKey) => {
      const payload = computeDesktopManifestCanonicalPayload(version, assets)
      const sig = sign(null, Buffer.from(payload, 'utf8'), privKey).toString('base64')
      return {
        schema: 1,
        version,
        sigAlg: 'Ed25519',
        signature: sig,
        assets,
      }
    }

    const fakePayload = Buffer.alloc(64 * 1024, 0x5a)
    const validSha = createHash('sha256').update(fakePayload).digest('hex')
    const manifestLatest = signMockManifest('1.0.9', [
      { name: 'All.in.One.Setup.1.0.9.exe', sha256: validSha, size: fakePayload.length },
    ])
    const manifestCorrupt = signMockManifest('1.0.10', [
      { name: 'All.in.One.Setup.1.0.10.exe', sha256: '0'.repeat(64), size: fakePayload.length },
    ])
    const manifestNoDigest = signMockManifest('1.0.11', [
      { name: 'All.in.One.Setup.1.0.11.exe', size: fakePayload.length },
    ])
    const manifestBadSig = signMockManifest(
      '1.0.13',
      [{ name: 'All.in.One.Setup.1.0.13.exe', sha256: validSha, size: fakePayload.length }],
      wrongPrivKey,
    )

    let downloadHits = 0
    const mockReleaseServer = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${mockReleaseServer.address().port}`
      if (req.url === '/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.9',
            assets: [
              { name: 'All.in.One.Setup.1.0.9.exe', size: fakePayload.length, digest: `sha256:${validSha}`, browser_download_url: `${base}/bin` },
              { name: 'All-in-One-Desktop-Release.json', size: 256, browser_download_url: `${base}/releases/manifest-latest` },
            ],
          }),
        )
        return
      }
      if (req.url === '/releases/manifest-latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifestLatest))
        return
      }
      if (req.url === '/releases/corrupt') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.10',
            assets: [
              { name: 'All.in.One.Setup.1.0.10.exe', size: fakePayload.length, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: `${base}/bin` },
              { name: 'All-in-One-Desktop-Release.json', size: 256, browser_download_url: `${base}/releases/manifest-corrupt` },
            ],
          }),
        )
        return
      }
      if (req.url === '/releases/manifest-corrupt') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifestCorrupt))
        return
      }
      if (req.url === '/releases/no-digest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.11',
            assets: [
              { name: 'All.in.One.Setup.1.0.11.exe', size: fakePayload.length, browser_download_url: `${base}/bin` },
              { name: 'All-in-One-Desktop-Release.json', size: 256, browser_download_url: `${base}/releases/manifest-no-digest` },
            ],
          }),
        )
        return
      }
      if (req.url === '/releases/manifest-no-digest') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifestNoDigest))
        return
      }
      if (req.url === '/releases/unsigned') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.12',
            assets: [
              { name: 'All.in.One.Setup.1.0.12.exe', size: fakePayload.length, digest: `sha256:${validSha}`, browser_download_url: `${base}/bin` },
            ],
          }),
        )
        return
      }
      if (req.url === '/releases/bad-sig') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.13',
            assets: [
              { name: 'All.in.One.Setup.1.0.13.exe', size: fakePayload.length, digest: `sha256:${validSha}`, browser_download_url: `${base}/bin` },
              { name: 'All-in-One-Desktop-Release.json', size: 256, browser_download_url: `${base}/releases/manifest-bad-sig` },
            ],
          }),
        )
        return
      }
      if (req.url === '/releases/manifest-bad-sig') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifestBadSig))
        return
      }
      if (req.url === '/bin') {
        downloadHits += 1
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fakePayload.length) })
        res.end(fakePayload)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise((r) => mockReleaseServer.listen(0, '127.0.0.1', r))
    const updPort = mockReleaseServer.address().port
    const updDir = join(tmpDir, 'updater-cache')
    try {
      const upd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      assert.equal((await upd.checkForUpdates()).status, 'available')
      const dl = await upd.downloadUpdate()
      assert.equal(dl.status, 'downloaded')
      assert.equal(Buffer.compare(readFileSync(dl.downloadedPath), fakePayload), 0)
      assert.equal(downloadHits, 1)

      // Cached installer reuse
      const updReuse = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      assert.equal((await updReuse.checkForUpdates()).status, 'downloaded')
      assert.equal(downloadHits, 1)

      // Pre-install TOCTOU 1-byte tamper must fail & delete file
      const tampered = Buffer.from(fakePayload)
      tampered[0] ^= 0xff
      writeFileSync(dl.downloadedPath, tampered)
      const instRes = await upd.installAndRestart({ exePath: 'C:\\fake\\All in One.exe', isPackaged: true, onQuit: () => {} })
      assert.equal(instRes.status, 'error')
      assert.match(instRes.error, /SHA-256/)
      assert.equal(existsSync(dl.downloadedPath), false)

      // Corrupt SHA-256 & missing SHA-256 both blocked
      const corruptUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/corrupt`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      assert.equal((await corruptUpd.checkForUpdates()).status, 'available')
      assert.equal((await corruptUpd.downloadUpdate()).status, 'error')
      assert.equal(existsSync(join(updDir, 'All.in.One.Setup.1.0.10.exe')), false)

      const noDigestStrictUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/no-digest`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      assert.equal((await noDigestStrictUpd.checkForUpdates()).status, 'error', 'Signed manifest without asset SHA-256 must fail closed')

      const noDigestUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/no-digest`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
        requireSignature: false,
      })
      assert.equal((await noDigestUpd.checkForUpdates()).status, 'available')
      assert.equal((await noDigestUpd.downloadUpdate()).status, 'error')

      // Fail-closed Ed25519 enforcement: release WITHOUT signed All-in-One-Desktop-Release.json MUST be rejected
      const unsignedUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/unsigned`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      const unsignedCheck = await unsignedUpd.checkForUpdates()
      assert.equal(unsignedCheck.status, 'error', 'Unsigned release without All-in-One-Desktop-Release.json must be rejected fail-closed')
      assert.match(unsignedCheck.error, /Ed25519|签名|signature/i)

      // Wrong Ed25519 signing key MUST also be rejected fail-closed
      const badSigUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/bad-sig`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      const badSigCheck = await badSigUpd.checkForUpdates()
      assert.equal(badSigCheck.status, 'error', 'Release signed with untrusted Ed25519 key must be rejected fail-closed')
      assert.match(badSigCheck.error, /Ed25519|签名|signature/i)

      // Already up-to-date & untrusted host block
      const upToDate = new DesktopUpdater({
        currentVersion: '1.0.9',
        platform: 'win32',
        arch: 'x64',
        downloadDir: updDir,
        apiUrl: `http://127.0.0.1:${updPort}/releases/latest`,
        allowLocalhost: true,
        manifestPublicKey: testPubB64,
      })
      assert.equal((await upToDate.checkForUpdates()).status, 'up-to-date')

      const strictUpd = new DesktopUpdater({
        currentVersion: '1.0.8',
        platform: 'win32',
        downloadDir: updDir,
        allowLocalhost: false,
        manifestPublicKey: testPubB64,
      })
      strictUpd.setState({ status: 'available', assetName: 'evil.exe', downloadUrl: 'https://evil.example.com/evil.exe' })
      const blocked = await strictUpd.downloadUpdate()
      assert.equal(blocked.status, 'error')
      assert.match(blocked.error, /不受信任/)
    } finally {
      try { mockReleaseServer.closeAllConnections?.() } catch {}
      await new Promise((r) => mockReleaseServer.close(r))
    }

    // 10b-2. Mobile / Android OTA hot-update checks (remote web hot-reload, Capacitor OTA, staged reuse, minNativeVersion guard & ZIP bundler)
    assert.equal(isHotReloadableWebOrigin({ protocol: 'https:', hostname: '203.0.113.10' }), true)
    assert.equal(isHotReloadableWebOrigin({ protocol: 'https:', hostname: 'localhost' }), false)
    assert.equal(isHotReloadableWebOrigin({ protocol: 'capacitor:', hostname: 'localhost' }), false)
    assert.equal(isHotReloadableWebOrigin({ protocol: 'app:', hostname: 'allinone' }), false)
    assert.equal(
      resolveCurrentAppBaseUrl({ origin: 'https://203.0.113.10', pathname: '/dsh/' }),
      'https://203.0.113.10/dsh',
    )
    assert.equal(
      resolveCurrentAppBaseUrl({ origin: 'https://203.0.113.10', pathname: '/dsh/index.html' }),
      'https://203.0.113.10/dsh',
    )

    // Mode B: Remote-URL WebView APK or Mobile PWA MUST hot-reload in-place (never jump to GitHub download URL)
    {
      let swUpdated = false
      const remoteHot = await checkNativeMobileUpdate({
        currentVersion: '1.0.25',
        baseUrl: 'https://203.0.113.10/dsh',
        token: 'tok-1',
        locationLike: { protocol: 'https:', hostname: '203.0.113.10', origin: 'https://203.0.113.10', pathname: '/dsh/' },
        navigatorLike: {
          serviceWorker: {
            getRegistrations: async () => [
              {
                update: async () => {
                  swUpdated = true
                },
                waiting: null,
              },
            ],
          },
        },
        fetchImpl: async (url) => {
          assert.match(String(url), /^https:\/\/203\.0\.113\.10\/dsh\/api\/health\?_t=/)
          return { ok: true, json: async () => ({ ok: true, version: '1.0.26' }) }
        },
      })
      assert.equal(swUpdated, true)
      assert.equal(remoteHot.status, 'downloaded')
      assert.equal(remoteHot.hotUpdate, true)
      assert.equal(remoteHot.mode, 'web-reload')
      assert.equal(remoteHot.latestVersion, '1.0.26')
      assert.equal(remoteHot.releaseUrl, undefined)
    }

    // Mode A: Bundled-local Capacitor Android APK (`https://localhost`) with native AllinOneUpdater plugin
    {
      const mockSha = 'a'.repeat(64)
      const localLoc = { protocol: 'https:', hostname: 'localhost', origin: 'https://localhost', pathname: '/' }
      const signedOtaManifest = {
        schema: 1,
        version: '1.0.27',
        minNativeVersion: '1.0.26',
        bundleFile: 'All-in-One-WebBundle.zip',
        sha256: mockSha,
        size: 1_250_000,
        sigAlg: 'SHA256withRSA',
        signature: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
      }
      const mockFetch = async (url) => {
        const u = String(url)
        if (u.includes('All-in-One-WebBundle.json')) {
          return {
            ok: true,
            json: async () => signedOtaManifest,
          }
        }
        if (u.includes('/api/health')) {
          return { ok: true, json: async () => ({ ok: true, version: '1.0.27' }) }
        }
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v1.0.27',
            html_url: 'https://github.com/RainbowLion0320/AllinOne/releases/tag/v1.0.27',
            body: '<!-- android-ota-min-native: 1.0.26 -->',
            assets: [
              {
                name: 'All-in-One-WebBundle.zip',
                size: 1_250_000,
                digest: `sha256:${mockSha}`,
                browser_download_url: 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-WebBundle.zip',
              },
              {
                name: 'All-in-One-WebBundle.json',
                size: 420,
                browser_download_url: 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-WebBundle.json',
              },
              {
                name: 'All-in-One-Android.apk',
                size: 8_400_000,
                browser_download_url: 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-Android.apk',
              },
            ],
          }),
        }
      }

      // Prefers signed relay mirror as primary with GitHub fallback when digests match
      const capOta = await checkNativeMobileUpdate({
        currentVersion: '1.0.26',
        nativeVersion: '1.0.26',
        hasNativeOta: true,
        baseUrl: 'https://203.0.113.10/dsh',
        token: 'tok-1',
        locationLike: localLoc,
        fetchImpl: mockFetch,
      })
      assert.equal(capOta.status, 'available')
      assert.equal(capOta.hotUpdate, true)
      assert.equal(capOta.mode, 'capacitor-ota')
      assert.equal(capOta.latestVersion, '1.0.27')
      assert.equal(capOta.downloadUrl, 'https://203.0.113.10/dsh/downloads/ota/All-in-One-WebBundle.zip')
      assert.equal(capOta.fallbackUrl, 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-WebBundle.zip')
      assert.equal(capOta.expectedSha256, mockSha)
      assert.equal(capOta.sigAlg, 'SHA256withRSA')

      // Already-staged bundle immediately reports 'downloaded' ready for instant hot restart
      const capStaged = await checkNativeMobileUpdate({
        currentVersion: '1.0.26',
        nativeVersion: '1.0.26',
        stagedVersion: '1.0.27',
        hasNativeOta: true,
        baseUrl: 'https://203.0.113.10/dsh',
        token: 'tok-1',
        locationLike: localLoc,
        fetchImpl: mockFetch,
      })
      assert.equal(capStaged.status, 'downloaded')
      assert.equal(capStaged.hotUpdate, true)
      assert.equal(capStaged.mode, 'capacitor-ota')

      // Enforces minNativeVersion: older native APK shell requires installer upgrade instead of incompatible hot-update
      const capNeedsNative = await checkNativeMobileUpdate({
        currentVersion: '1.0.25',
        nativeVersion: '1.0.25',
        hasNativeOta: true,
        baseUrl: 'https://203.0.113.10/dsh',
        token: 'tok-1',
        locationLike: localLoc,
        fetchImpl: mockFetch,
      })
      assert.equal(capNeedsNative.status, 'available')
      assert.equal(capNeedsNative.hotUpdate, false)
      assert.equal(capNeedsNative.nativeUpgradeRequired, true)
    }

    // Deterministic Android OTA PKZIP packager verification
    {
      const sampleZip = buildZipBuffer([
        { name: 'index.html', data: Buffer.from('<!doctype html><title>OTA</title>') },
        { name: 'assets/app.js', data: Buffer.from('console.log("ok")') },
      ])
      assert.equal(sampleZip.readUInt32LE(0), 0x04034b50) // PKZIP local file header
      assert.equal(sampleZip.readUInt32LE(sampleZip.length - 22), 0x06054b50) // PKZIP EOCD
      assert.equal(
        computeOtaCanonicalPayload({ version: '1.0.26', minNativeVersion: '1.0.26', sha256: 'AB'.repeat(32), size: 42 }),
        `allinone-ota-v1\n1.0.26\n1.0.26\n${'ab'.repeat(32)}\n42`,
      )
      const otaTmpOut = join(tmpDir, 'ota-pack-test')
      const packed = packageAndroidOtaBundle({
        outDir: otaTmpOut,
        version: '1.0.26',
        signWithKeystore: false,
        requireSignature: false,
      })
      assert.equal(existsSync(packed.zipPath), true)
      assert.equal(existsSync(packed.manifestPath), true)
      assert.equal(packed.manifest.version, '1.0.26')
      assert.match(packed.manifest.sha256, /^[a-f0-9]{64}$/)
      assert.ok(packed.manifest.size > 1000)
      const actualZipSha = createHash('sha256').update(readFileSync(packed.zipPath)).digest('hex')
      assert.equal(actualZipSha, packed.manifest.sha256)
    }

    // 10c. DesktopWebRtcProxy + ElectronWebRtcClient cold-start concurrency, FIFO framing & worker recovery
    const ipcMain = new EventEmitter()
    const receivedCmds = []
    const receivedBins = []
    let failFirstLoad = true
    let createdWinCount = 0
    class FakeBrowserWindow extends EventEmitter {
      constructor() {
        super()
        createdWinCount += 1
        this._destroyed = false
        const win = this
        this.webContents = Object.assign(new EventEmitter(), {
          send(channel, payload) {
            if (channel === 'webrtc-worker:cmd') {
              receivedCmds.push(payload)
              if (payload.type === 'peer.offer') {
                setTimeout(() => {
                  ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'res', reqId: payload.reqId, ok: true, answer: { type: 'answer', sdp: 'v=0\r\nmock-answer\r\n' } })
                  ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'dc.open', peerId: payload.peerId, role: 'ctrl' })
                  ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'dc.open', peerId: payload.peerId, role: 'bulk' })
                }, 15)
              }
            } else if (channel === 'webrtc-worker:send-binary') {
              receivedBins.push(payload)
            }
          },
        })
      }
      isDestroyed() {
        return this._destroyed
      }
      destroy() {
        if (!this._destroyed) {
          this._destroyed = true
          this.emit('closed')
        }
      }
      async loadFile() {
        if (failFirstLoad) {
          failFirstLoad = false
          throw new Error('simulated worker load error')
        }
        setTimeout(() => {
          if (!this._destroyed) ipcMain.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'worker.ready' })
        }, 25)
      }
    }

    const proxy = new DesktopWebRtcProxy({
      BrowserWindow: FakeBrowserWindow,
      ipcMain,
      srcDir: join(process.cwd(), 'packages/desktop-app/src'),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const { port: pxPort, token: pxToken } = await proxy.start()
    let acceptedSockets = 0
    proxy.server.on('connection', () => {
      acceptedSockets += 1
    })
    try {
      const eClient = new ElectronWebRtcClient({ port: pxPort, token: pxToken, log: { info: () => {}, warn: () => {}, error: () => {} } })
      const badPeer = eClient.createPeer({ iceServers: [] })
      await assert.rejects(() => badPeer.handleOffer('v=0\r\n'), /simulated worker load error/)
      await badPeer.close()
      eClient.dispose()

      const coldClient = new ElectronWebRtcClient({ port: pxPort, token: pxToken, log: { info: () => {}, warn: () => {}, error: () => {} } })
      const socketsBefore = acceptedSockets
      try {
        let ctrlOpened = false
        let bulkOpened = false
        const peer = coldClient.createPeer({
          iceServers: [],
          onCtrlOpen: () => {
            ctrlOpened = true
          },
          onBulkOpen: () => {
            bulkOpened = true
          },
        })
        const offerP = peer.handleOffer('v=0\r\nconcurrent-offer\r\n')
        const icePs = Array.from({ length: 10 }, (_, idx) =>
          peer.addIceCandidate({ candidate: `candidate:${idx} 1 udp 1 127.0.0.1 ${50000 + idx} typ host` }),
        )
        assert.equal((await offerP).type, 'answer')
        await Promise.all(icePs)
        assert.equal(acceptedSockets - socketsBefore, 1, 'Cold concurrent offer + 10 ICE must share 1 loopback socket')
        for (let i = 0; i < 30 && (!ctrlOpened || !bulkOpened); i += 1) await new Promise((r) => setTimeout(r, 10))
        assert.equal(peer.isCtrlOpen() && peer.isBulkOpen(), true)
        const offerIdx = receivedCmds.findIndex((c) => c.type === 'peer.offer' && c.sdp?.includes('concurrent-offer'))
        const firstIceIdx = receivedCmds.findIndex((c) => c.type === 'peer.ice')
        assert.ok(offerIdx >= 0 && firstIceIdx > offerIdx, 'peer.offer must arrive strictly before peer.ice')
        await peer.sendBulk(new Uint8Array([1, 2, 3, 4]))
        for (let i = 0; i < 30 && receivedBins.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
        assert.deepEqual(Buffer.from(receivedBins[0].bytes), Buffer.from([1, 2, 3, 4]))
        await peer.close()
      } finally {
        coldClient.dispose()
      }
      assert.ok(createdWinCount >= 2)
    } finally {
      await proxy.dispose()
    }
  } finally {
    temp.cleanup()
  }
})

test('Suite 11: Frontend guards (React Hooks across src/**/*.{js,jsx}, i18n parity, deviceStore LRU, scoped sessionCache, drafts & home quota dashboard)', async () => {
  const mockHttpBase = 'http://127.0.0.1:8787'

  // 11a. React Rules-of-Hooks static scan across all packages/mobile-app/src/**/*.{js,jsx}
  const scanFrontendSources = (dir) => {
    const out = []
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) out.push(...scanFrontendSources(p))
      else if (ent.name.endsWith('.jsx') || ent.name.endsWith('.js')) out.push(p)
    }
    return out
  }
  const frontendFiles = scanFrontendSources(join(process.cwd(), 'packages/mobile-app/src'))
  assert.ok(frontendFiles.some((f) => f.endsWith('App.jsx')))
  assert.ok(frontendFiles.some((f) => f.endsWith('AppModals.jsx')))
  assert.ok(frontendFiles.some((f) => f.endsWith('useSessionManager.js')))
  assert.ok(frontendFiles.some((f) => f.endsWith('useTransportBridge.js')))

  const violations = []
  for (const f of frontendFiles) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    let curComp = ''
    let compDepth = -1
    let earlyReturnLine = -1
    let depth = 0
    for (let i = 0; i < lines.length; i += 1) {
      const clean = lines[i].replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`|\/\/.*$/g, '')
      if (!curComp) {
        const m = clean.match(
          /^(?:export\s+(?:default\s+)?)?(?:function\s+((?:use)?[A-Z]\w*)|const\s+((?:use)?[A-Z]\w*)\s*=\s*(?:React\.)?memo\s*\(\s*function\s*\w*)/,
        )
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
  assert.deepEqual(violations, [], `React hook violations:\n${violations.join('\n')}`)

  // 11b. Bilingual i18n dictionary parity & formatting
  assert.equal(normalizeLang('zh-CN'), 'zh')
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('fr-FR'), null)
  const langMem = new Map()
  const langStorage = {
    getItem: (k) => (langMem.has(k) ? langMem.get(k) : null),
    setItem: (k, v) => langMem.set(k, String(v)),
  }
  assert.equal(detectInitialLang(langStorage, { language: 'en-US' }), 'en')
  assert.equal(detectInitialLang(langStorage, { language: 'zh-Hans-CN' }), 'zh')
  assert.equal(detectInitialLang(langStorage, { language: 'ja-JP' }), 'en')
  assert.equal(detectInitialLang(langStorage, {}), 'en')
  saveLang('en', langStorage)
  assert.equal(langStorage.getItem(LANG_STORAGE_KEY), 'en')
  assert.equal(loadSavedLang(langStorage), 'en')
  assert.equal(detectInitialLang(langStorage, { language: 'zh-CN' }), 'en')
  assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort(), 'zh/en i18n keys must match exactly')
  assert.equal(translate('zh', 'time.minsAgo', { n: 5 }), '5 分钟前')
  assert.equal(translate('en', 'time.minsAgo', { n: 5 }), '5m ago')
  assert.equal(bi('en', '设置', 'Settings'), 'Settings')
  assert.equal(getDeviceDisplayName(null, null, 'en'), 'No Computer')
  assert.equal(formatBytesCompact(1024 * 1024 * 1024), '1 GB')
  saveLang('zh', langStorage)

  // 11c. Multi-device store (coexistence, loginEmail2fa update, persistence, 16-key LRU keyring)
  const storeMem = new Map()
  const fakeStorage = {
    getItem: (k) => (storeMem.has(k) ? storeMem.get(k) : null),
    setItem: (k, v) => storeMem.set(k, String(v)),
    removeItem: (k) => storeMem.delete(k),
  }
  let dState = loadDeviceState(fakeStorage)
  const rA = upsertDevice(dState, {
    baseUrl: mockHttpBase,
    token: 'tok-a',
    roomId: 'usr_friend_a',
    username: 'friend_a',
    loginEmail2fa: false,
    bridges: [{ hostname: 'mac-a', online: true }],
  })
  dState = rA.state
  const rB = upsertDevice(dState, {
    baseUrl: mockHttpBase,
    token: 'tok-b',
    roomId: 'usr_friend_b',
    username: 'friend_b',
    label: 'Win-B',
    bridges: [],
  })
  dState = rB.state
  assert.equal(dState.devices.length, 2)
  assert.equal(getActiveDevice(dState).id, rB.device.id)
  const refreshedA = upsertDevice(dState, {
    baseUrl: mockHttpBase,
    token: 'tok-a2',
    roomId: 'usr_friend_a',
    username: 'friend_a',
    loginEmail2fa: true,
  })
  assert.equal(refreshedA.isNew, false)
  assert.equal(refreshedA.device.loginEmail2fa, true)
  dState = selectDevice(refreshedA.state, rB.device.id)
  saveDeviceState(dState, fakeStorage)
  assert.equal(loadDeviceState(fakeStorage).activeDeviceId, rB.device.id)

  const addedKids = []
  for (let i = 0; i < 18; i += 1) {
    const k = generateE2eeKey()
    const kid = await computeE2eeKeyId(k)
    addedKids.push(kid)
    dState = upsertDeviceE2eeKey(dState, rA.device.id, kid, k)
  }
  const lruKeys = Object.keys(dState.devices.find((d) => d.id === rA.device.id).e2eeKeys)
  assert.equal(lruKeys.length, 16)
  assert.ok(lruKeys.includes(addedKids[17]) && !lruKeys.includes(addedKids[0]))

  // 11d. Scoped sessionCache isolation, Codex >120 cursor safety & optimistic bubble reconciliation
  await clearSessionCache()
  const scopeA = getCacheScopeKey(dState.devices[0], 'pc-a')
  const scopeB = getCacheScopeKey(dState.devices[1], 'pc-b')
  await saveCachedSession('codex:shared', { messages: [{ id: 'm1', role: 'user', text: 'Mac' }] }, scopeA)
  await saveCachedSession('codex:shared', { messages: [{ id: 'm1', role: 'user', text: 'Win' }] }, scopeB)
  assert.equal((await loadCachedSession('codex:shared', scopeA)).messages[0].text, 'Mac')
  assert.equal((await getSessionCacheStats(scopeA)).sessionCount, 1)
  await clearSessionCache(dState.devices[0].id, { prefix: true })
  assert.equal(await loadCachedSession('codex:shared', scopeA), null)
  assert.equal((await loadCachedSession('codex:shared', scopeB)).messages[0].text, 'Win')

  await saveCachedSession('codex:unbridged', { meta: { app: 'codex' }, messages: [{ id: 'm1', role: 'user', text: 'a', ts: 1 }] }, 'acct25')
  await saveCachedSession('codex:bridged', { meta: { app: 'codex' }, messages: [{ id: 'm2', role: 'user', text: 'b', ts: 2 }] }, 'acct25::pc-1')
  await clearSessionCache('acct25', { prefix: false })
  assert.equal(await loadCachedSession('codex:unbridged', 'acct25'), null)
  assert.ok(await loadCachedSession('codex:bridged', 'acct25::pc-1'))

  const manyCodex = Array.from({ length: 130 }, (_, idx) => ({
    id: `c-${idx}`,
    role: idx % 2 ? 'assistant' : 'user',
    text: `m${idx}`,
    ts: idx + 1,
  }))
  await saveCachedSession(
    'codex:big',
    { meta: { app: 'codex', id: 'codex:big' }, messages: manyCodex, hasMore: false, nextCursor: null },
    'scope-big',
  )
  const cachedBig = await loadCachedSession('codex:big', 'scope-big')
  assert.equal(cachedBig.messages.length, 120)
  assert.equal(cachedBig.nextCursor, null)

  const reconciled = reconcileCachedWithFreshPage(
    {
      messages: [
        { id: 'agy-u-1', role: 'user', text: 'Q1', ts: 1 },
        { id: 'agy-a-2', role: 'assistant', text: 'A1', ts: 2 },
        { id: 'msg-u-99', role: 'user', text: 'Q2', ts: 3 },
        { id: 'msg-a-99', role: 'assistant', text: 'A2', ts: 4 },
      ],
      hasMore: true,
      nextCursor: '1',
      totalCount: 10,
    },
    {
      messages: [
        { id: 'agy-a-2', role: 'assistant', text: 'A1', ts: 2 },
        { id: 'agy-u-3', role: 'user', text: 'Q2', ts: 3 },
        { id: 'agy-a-4', role: 'assistant', text: 'A2', ts: 4 },
      ],
      hasMore: true,
      nextCursor: '2',
      totalCount: 12,
    },
  )
  assert.equal(reconciled.messages.length, 4)
  assert.equal(reconciled.messages[3].id, 'agy-a-4')
  await clearSessionCache()

  dState = removeDevice(dState, rB.device.id)
  assert.equal(dState.devices.length, 1)
  assert.equal(dState.activeDeviceId, rA.device.id)

  // 11e. Per-conversation draft store & image URL policy
  const dkA = makeDraftKey('dev1::pc1', 'codex:a', 'codex')
  const dkB = makeDraftKey('dev1::pc1', 'antigravity:b', 'antigravity')
  saveDraft(dkA, { text: 'Draft A', attachments: [null, { id: 'a1', filename: 'p.png', localPreviewUrl: 'blob:https://x/1' }] })
  saveDraft(dkB, { text: 'Draft B', attachments: [] })
  const loadedA = loadDraft(dkA)
  assert.equal(loadedA.text, 'Draft A')
  assert.equal(loadedA.attachments.length, 1)
  assert.equal(loadedA.attachments[0].localPreviewUrl, undefined)
  clearDraft(dkA)
  assert.equal(loadDraft(dkB).text, 'Draft B')
  saveLastSessionId('dev1::pc1', 'codex:a')
  saveLastWorkspace('dev1::pc1', '/Users/demo/AllinOne')
  assert.equal(loadLastSessionId('dev1::pc1'), 'codex:a')
  assert.equal(loadLastWorkspace('dev1::pc1'), '/Users/demo/AllinOne')
  clearDraftsForScope('dev1')
  assert.equal(loadDraft(dkB).text, '')
  assert.equal(loadLastSessionId('dev1::pc1'), '')
  assert.equal(resolveImageSrc('https://example.com/demo.png'), 'https://example.com/demo.png')
  assert.equal(resolveImageSrc('/tmp/shot.png'), '')

  // 11f. Smart sidebar vendor filter bar (activity-sorted top 3 + "..." overflow from 4th vendor)
  const allVendorDefs = [
    { id: 'dsh', label: 'DeepSeek', color: '#4D6BFE' },
    { id: 'codex', label: 'Codex', color: '#6366F1' },
    { id: 'claude', label: 'Claude', color: '#D97757' },
    { id: 'antigravity', label: 'Antigravity', color: '#3186FF' },
    { id: 'workbuddy', label: 'WorkBuddy', color: '#06C798' },
  ]
  const layout5 = computeSidebarVendorLayout({
    vendorTabs: allVendorDefs,
    sessions: [
      { app: 'dsh', updatedAt: 1000 },
      { app: 'workbuddy', updatedAt: 5000, status: 'running' },
      { app: 'codex', updatedAt: 4000 },
      { app: 'antigravity', updatedAt: 3000 },
      { app: 'claude', updatedAt: 2000 },
      { app: 'workbuddy', updatedAt: 1500 },
    ],
    appsStatus: [
      { app: 'codex', available: true, writable: true, quota: { remainingPercent: 45 } },
      { app: 'antigravity', available: true, writable: true, quota: { remainingPercent: 99 } },
      { app: 'dsh', available: true, writable: true },
      { app: 'claude', available: true, writable: true },
      { app: 'workbuddy', available: true, writable: false },
    ],
  })
  assert.equal(layout5.showBar, true)
  assert.deepEqual(
    layout5.visibleVendors.map((v) => v.id),
    ['workbuddy', 'codex', 'antigravity'],
  )
  assert.deepEqual(
    layout5.overflowVendors.map((v) => v.id),
    ['claude', 'dsh'],
  )
  assert.equal(layout5.visibleVendors[0].sessionCount, 2)
  assert.equal(layout5.visibleVendors[0].hasRunning, true)
  assert.equal(layout5.visibleVendors[1].quota.remainingPercent, 45)

  const layout3 = computeSidebarVendorLayout({
    vendorTabs: allVendorDefs,
    sessions: [
      { app: 'claude', updatedAt: 200 },
      { app: 'codex', updatedAt: 500 },
    ],
    appsStatus: [
      { app: 'workbuddy', available: true, writable: true },
      { app: 'codex', available: true, writable: true },
      { app: 'claude', available: true, writable: true },
    ],
  })
  assert.equal(layout3.showBar, true)
  assert.deepEqual(
    layout3.visibleVendors.map((v) => v.id),
    ['codex', 'claude', 'workbuddy'],
  )
  assert.equal(layout3.overflowVendors.length, 0)

  const layout1 = computeSidebarVendorLayout({
    vendorTabs: allVendorDefs,
    sessions: [{ app: 'codex', updatedAt: 100 }],
    appsStatus: [{ app: 'codex', available: true, writable: true, quota: { remainingPercent: 88 } }],
  })
  assert.equal(layout1.showBar, false)
  assert.equal(layout1.soleQuotaTab?.tab?.id, 'codex')
  assert.equal(layout1.soleQuotaTab?.quota?.remainingPercent, 88)

  // Credit-based quota formatting & tooltips (WorkBuddy)
  const wbCreditQuota = {
    windowKind: 'credits',
    remainingPercent: 99,
    creditsRemaining: 791.8,
    creditsTotal: 800,
    planType: '体验版',
    creditGroups: [
      { name: '套餐基础积分', remaining: 491.8, total: 500 },
      { name: '平台奖励积分', remaining: 300, total: 300 },
    ],
  }
  assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: true, lang: 'zh' }), '792')
  assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: false, lang: 'zh' }), '791.8 积分')
  assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: false, lang: 'zh', showTotal: true }), '791.8 / 800 积分')
  assert.equal(formatQuotaBadgeText({ windowKind: 'credits', creditsRemaining: 1500 }, { compact: true }), '1.5k')
  assert.equal(formatQuotaBadgeText({ windowKind: 'credits', unlimited: true }, { compact: true }), '∞')
  assert.ok(formatQuotaTooltip('WorkBuddy', wbCreditQuota, 'zh').includes('剩余积分 791.8 / 800 (99%)'))
  assert.ok(formatQuotaTooltip('WorkBuddy', wbCreditQuota, 'en').includes('Credits left 791.8 / 800 (99%)'))

  // Home Quota Overview Dashboard (5h short window priority, 7d weekly, credits breakdown & card ordering)
  const nowFixed = 1_795_000_000_000
  assert.equal(formatQuotaResetCountdown(nowFixed + 2 * 3600_000 + 15 * 60_000, { lang: 'zh', now: nowFixed }), '2小时15分后重置')
  assert.equal(formatQuotaResetCountdown(nowFixed + 2 * 3600_000 + 15 * 60_000, { lang: 'en', now: nowFixed }), 'Resets in 2h 15m')
  assert.equal(formatQuotaResetCountdown(nowFixed + 35_000, { lang: 'zh', now: nowFixed }), '即将重置')

  const codexDualDetails = extractVendorQuotaDetails(
    {
      windowKind: 'weekly',
      windowMinutes: 10080,
      remainingPercent: 45,
      usedPercent: 55,
      resetsAt: nowFixed + 3 * 86400_000 + 4 * 3600_000,
      planType: 'plus',
      shortWindow: {
        remainingPercent: 86,
        usedPercent: 14,
        windowMinutes: 300,
        resetsAt: nowFixed + 2 * 3600_000 + 20 * 60_000,
      },
      updatedAt: nowFixed,
    },
    { lang: 'zh', now: nowFixed },
  )
  assert.equal(codexDualDetails?.kind, 'windows')
  assert.equal(codexDualDetails?.planLabel, 'Plus')
  assert.equal(codexDualDetails?.windows.length, 2)
  assert.equal(codexDualDetails?.windows[0].kind, 'short')
  assert.equal(codexDualDetails?.windows[0].label, '5小时额度')
  assert.equal(codexDualDetails?.windows[0].remainingPercent, 86)
  assert.equal(codexDualDetails?.windows[1].kind, 'weekly')
  assert.equal(codexDualDetails?.windows[1].label, '7天周额度')
  assert.equal(codexDualDetails?.windows[1].remainingPercent, 45)
  assert.equal(codexDualDetails?.windows[1].health, 'warning')

  const wbDashDetails = extractVendorQuotaDetails(wbCreditQuota, { lang: 'zh', now: nowFixed })
  assert.equal(wbDashDetails?.kind, 'credits')
  assert.equal(wbDashDetails?.remainingText, '791.8')
  assert.equal(wbDashDetails?.totalText, '800')
  assert.equal(wbDashDetails?.groups.length, 2)

  const homeCards = buildHomeQuotaCards({
    appList: ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy'],
    sessions: [
      { app: 'workbuddy', updatedAt: 500, status: 'running' },
      { app: 'codex', updatedAt: 400, status: 'idle' },
      { app: 'dsh', updatedAt: 900, status: 'idle' },
    ],
    appsStatus: [
      { app: 'dsh', available: true, writable: true, mode: 'dsh-local-ipc' },
      {
        app: 'codex',
        available: true,
        writable: true,
        quota: {
          windowKind: 'weekly',
          remainingPercent: 45,
          shortWindow: { remainingPercent: 86, windowMinutes: 300, resetsAt: nowFixed + 3600_000 },
          resetsAt: nowFixed + 86400_000,
        },
      },
      { app: 'antigravity', available: true, writable: true, quota: { windowKind: 'weekly', remainingPercent: 98, bucketLabel: 'Gemini' } },
      { app: 'workbuddy', available: true, writable: true, quota: wbCreditQuota },
      { app: 'claude', available: false, writable: false },
    ],
    lang: 'zh',
    now: nowFixed,
  })
  assert.deepEqual(
    homeCards.quotaCards.map((c) => c.app),
    ['workbuddy', 'codex', 'antigravity'],
  )
  assert.deepEqual(
    homeCards.otherCards.map((c) => c.app),
    ['dsh'],
  )
  assert.equal(homeCards.quotaCards[0].runningCount, 1)
})

test('Suite 12: Deliverable documents E2EE download, security guards, extractor & sandbox-preview CSP', async () => {
  const staticDir = existsSync(join(process.cwd(), 'packages/mobile-app/dist/sandbox-preview.html'))
    ? undefined
    : join(process.cwd(), 'packages/mobile-app/public')
  const env = await createIsolatedRelayEnv('allinone-int-03-deliverables-', staticDir ? { staticDir } : {})
  const { tmpDir, httpBase } = env

  try {
    const docDir = join(tmpDir, 'deliverables-workspace')
    mkdirSync(docDir, { recursive: true })
    const htmlPath = join(docDir, 'dashboard.html')
    const docxPath = join(docDir, 'weekly-report.docx')
    const xlsxPath = join(docDir, 'budget.xlsx')
    const pptxPath = join(docDir, 'q4-deck.pptx')
    const pdfPath = join(docDir, 'contract.pdf')
    writeFileSync(htmlPath, '<!doctype html><html><body><h1>Q4 KPI</h1></body></html>', 'utf8')
    writeFileSync(docxPath, Buffer.from('PK\x03\x04mock-docx-bytes'))
    writeFileSync(xlsxPath, Buffer.from('PK\x03\x04mock-xlsx-bytes'))
    writeFileSync(pptxPath, Buffer.from('PK\x03\x04mock-pptx-bytes'))
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7 mock-pdf'))

    const docOrch = new MultiAppOrchestrator({ config: { cwd: docDir }, log: { info() {}, warn() {}, error() {} } })
    try {
      let mintedHtmlTicket = null
      const htmlRes = await docOrch.readLocalFile(
        { path: 'dashboard.html', cwd: docDir, mode: 'document' },
        {
          mintDownloadTicket: (t) => {
            mintedHtmlTicket = t
            return 101
          },
        },
      )
      assert.equal(htmlRes.mimeType, 'text/html; charset=utf-8')
      assert.equal(htmlRes.transferMode, 'p2p-bulk')
      assert.equal(htmlRes.dataBase64, undefined)
      assert.equal(htmlRes._localRealPath, undefined)
      assert.equal(htmlRes.streamId, 101)
      assert.ok(readFileSync(mintedHtmlTicket.realPath, 'utf8').includes('Q4 KPI'))
      assert.equal(
        (await docOrch.readLocalFile({ path: `file://${xlsxPath}`, cwd: docDir, mode: 'document' })).mimeType,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      assert.equal(
        (await docOrch.readLocalFile({ path: docxPath, cwd: docDir, mode: 'document' })).mimeType,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      assert.equal(
        (await docOrch.readLocalFile({ path: pptxPath, cwd: docDir, mode: 'document' })).mimeType,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      )
      assert.equal((await docOrch.readLocalFile({ path: pdfPath, cwd: docDir, mode: 'document' })).mimeType, 'application/pdf')

      // Default image mode rejects documents; disallowed extensions, sensitive files & symlinks blocked
      await assert.rejects(() => docOrch.readLocalFile({ path: htmlPath, cwd: docDir }), /仅允许远程预览图片/)
      for (const [name, body] of [['script.js', '1'], ['accounts.json', '{}'], ['.env', 'K=V']]) {
        const fp = join(docDir, name)
        writeFileSync(fp, body)
        await assert.rejects(() => docOrch.readLocalFile({ path: fp, cwd: docDir, mode: 'document' }), /不支持远程下载该格式/)
      }
      const secretTxt = join(docDir, 'secrets.txt')
      writeFileSync(secretTxt, 'secret')
      await assert.rejects(() => docOrch.readLocalFile({ path: secretTxt, cwd: docDir, mode: 'document' }), /敏感目录或凭据文件/)
      mkdirSync(join(docDir, '.ssh'), { recursive: true })
      const sshTxt = join(docDir, '.ssh', 'notes.txt')
      writeFileSync(sshTxt, 'ssh')
      await assert.rejects(() => docOrch.readLocalFile({ path: sshTxt, cwd: docDir, mode: 'document' }), /敏感目录或凭据文件/)
      const keyTarget = join(docDir, 'private.key')
      writeFileSync(keyTarget, 'KEY')
      const fakePdfLink = join(docDir, 'fake-report.pdf')
      symlinkSync(keyTarget, fakePdfLink)
      await assert.rejects(() => docOrch.readLocalFile({ path: fakePdfLink, cwd: docDir, mode: 'document' }), /符号链接指向不允许的格式/)

      // Large deliverable (>10MB) switches cleanly to p2p-bulk
      const hugePpt = join(docDir, 'huge-deck.pptx')
      writeFileSync(hugePpt, Buffer.alloc(10 * 1024 * 1024 + 65536, 0x41))
      let mintedHugeTicket = null
      const hugeRes = await docOrch.readLocalFile(
        { path: hugePpt, cwd: docDir, mode: 'document' },
        {
          mintDownloadTicket: (t) => {
            mintedHugeTicket = t
            return 102
          },
        },
      )
      assert.equal(hugeRes.transferMode, 'p2p-bulk')
      assert.equal(hugeRes._localRealPath, undefined)
      assert.ok(mintedHugeTicket?.realPath)

      // Frontend deliverable extractor
      const extracted = extractDeliverableRefsFromMessage({
        role: 'assistant',
        text: '报告：[Q4汇报.pptx](file:///Users/demo/Desktop/Q4%E6%B1%87%E6%8A%A5.pptx) 与 `./reports/dashboard.html`，忽略 `README.md`、`node_modules/pkg/index.html` 与 https://example.com/public.pdf',
        tools: [{ name: 'write_file', status: 'done', input: { Path: '/Users/demo/Documents/budget-2026.xlsx' } }],
      })
      const names = extracted.map((x) => x.filename)
      assert.ok(names.includes('Q4汇报.pptx') && names.includes('dashboard.html') && names.includes('budget-2026.xlsx'))
      assert.equal(names.includes('README.md') || names.includes('index.html') || names.includes('public.pdf'), false)
      assert.equal(extracted.find((x) => x.filename === 'dashboard.html')?.previewable, true)

      // Sandboxed HTML preview host frame enforces opaque-origin sandbox CSP
      const sandboxRes = await fetch(`${httpBase}/sandbox-preview.html`)
      assert.equal(sandboxRes.status, 200)
      const sCsp = sandboxRes.headers.get('content-security-policy') || ''
      assert.ok(sCsp.includes('sandbox allow-scripts') && sCsp.includes("connect-src 'none'"))
      assert.equal(sCsp.includes('allow-same-origin'), false)
    } finally {
      await docOrch.dispose()
    }
  } finally {
    await env.cleanup()
  }
})
