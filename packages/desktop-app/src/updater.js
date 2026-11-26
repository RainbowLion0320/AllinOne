/**
 * Built-in Zero-Dependency Desktop Auto-Updater for All in One (Windows NSIS & macOS DMG).
 *
 * Works cleanly with unsigned / ad-hoc signed open-source GitHub Releases:
 *  - Checks https://api.github.com/repos/<repo>/releases/latest
 *  - Streams the platform-matched installer (.exe / .dmg) with live progress & AbortController cancel
 *  - Cryptographically verifies GitHub's SHA-256 asset digest before allowing installation
 *  - Performs true 1-click in-place upgrade + automatic relaunch on BOTH Windows (NSIS /S)
 *    and macOS (hdiutil mount + ditto replace + xattr -cr + open), preserving all user data
 */

import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { compareSemver, parseSemver } from '@allinone/shared/semver'

export { compareSemver }

const DEFAULT_GITHUB_REPO = 'RainbowLion0320/AllinOne'
const DESKTOP_MANIFEST_NAME = 'All-in-One-Desktop-Release.json'
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

export function computeDesktopManifestPayload(version, assets = []) {
  const cleanVer = String(version || '').trim().replace(/^v/i, '')
  const lines = [...assets]
    .filter((a) => a && a.name && a.sha256)
    .map((a) => ({
      name: String(a.name).trim(),
      sha256: String(a.sha256).trim().toLowerCase(),
      size: Number(a.size) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}:${a.sha256}:${a.size}`)
  return `allinone-desktop-release-v1\n${cleanVer}\n${lines.join('\n')}`
}

export function verifyManifestSignature(manifest, publicKeyPem) {
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
    const payload = computeDesktopManifestPayload(manifest.version, manifest.assets)
    const sigBuf = Buffer.from(String(manifest.signature).trim(), 'base64')
    if (sigBuf.length !== 64) return false
    return verify(null, Buffer.from(payload, 'utf8'), pubKey, sigBuf)
  } catch {
    return false
  }
}

export function pickReleaseAsset(assets = [], platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets)) return null
  const list = assets.filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')

  if (platform === 'win32') {
    return (
      list.find((a) => /\.exe$/i.test(a.name) && /setup/i.test(a.name)) ||
      list.find((a) => /\.exe$/i.test(a.name)) ||
      null
    )
  }
  if (platform === 'darwin') {
    const preferArm = arch === 'arm64'
    return (
      list.find(
        (a) =>
          /\.dmg$/i.test(a.name) &&
          (preferArm ? /arm64|aarch64/i.test(a.name) : /x64|x86_64|intel/i.test(a.name)),
      ) ||
      list.find(
        (a) =>
          /\.dmg$/i.test(a.name) &&
          (/universal/i.test(a.name) || !/arm64|aarch64|x64|x86_64|intel/i.test(a.name)),
      ) ||
      null
    )
  }
  return list.find((a) => /\.AppImage$/i.test(a.name)) || null
}

function isAllowedDownloadUrl(rawUrl, allowLocalhost = false) {
  try {
    const u = new URL(rawUrl)
    if (allowLocalhost && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.protocol === 'http:') {
      return true
    }
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    if (ALLOWED_DOWNLOAD_HOSTS.has(host)) return true
    if (host.endsWith('.githubusercontent.com') || host.endsWith('.github.com')) return true
    return false
  } catch {
    return false
  }
}

function parseExpectedSha256(digest) {
  const raw = String(digest || '').trim()
  const m = raw.match(/^sha256:([a-f0-9]{64})$/i)
  return m ? m[1].toLowerCase() : ''
}

function sha256File(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex').toLowerCase()))
    stream.on('error', rejectHash)
  })
}

function resolveMacAppBundlePath(exePath) {
  // e.g. /Applications/All in One.app/Contents/MacOS/All in One -> /Applications/All in One.app
  const str = String(exePath || '')
  const marker = '.app/Contents/'
  const idx = str.lastIndexOf(marker)
  if (idx === -1) return ''
  return str.slice(0, idx + 4)
}

function isWritableDir(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function buildWindowsUpdateScripts({
  installerPath,
  exePath,
  pid = 0,
  isPackaged = false,
  logPath = '',
  ps1Path = '',
  expectedSha256 = '',
}) {
  const safePid = Number(pid) || 0
  const escPs = (s) => String(s || '').replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')
  const escVbs = (s) => String(s || '').replace(/"/g, '""')
  const resolvedInstaller = resolve(installerPath)
  const resolvedExe = resolve(exePath)
  const resolvedInstallDir = isPackaged && resolvedExe ? dirname(resolvedExe) : ''
  const resolvedLog = logPath ? resolve(logPath) : ''
  const resolvedPs1 = ps1Path ? resolve(ps1Path) : ''
  const cleanSha = /^[a-f0-9]{64}$/i.test(String(expectedSha256 || '').trim())
    ? String(expectedSha256).trim().toLowerCase()
    : ''

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$oldPid = ${safePid}`,
    `$installer = '${escPs(resolvedInstaller)}'`,
    `$exePath = '${escPs(resolvedExe)}'`,
    `$installDir = '${escPs(resolvedInstallDir)}'`,
    `$relaunch = ${isPackaged ? 1 : 0}`,
    `$logPath = '${escPs(resolvedLog)}'`,
    `$expectedSha = '${cleanSha}'`,
    'function Write-UpdLog([string]$msg) {',
    '  if (-not $logPath) { return }',
    '  try { Add-Content -LiteralPath $logPath -Value ("[" + (Get-Date -Format "o") + "] " + $msg) -Encoding UTF8 } catch {}',
    '}',
    'Write-UpdLog ("Waiting for PID " + $oldPid)',
    '$exited = $false',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  $mainAlive = if ($oldPid -gt 0) { Get-Process -Id $oldPid -ErrorAction SilentlyContinue } else { $null }',
    '  $sameExe = if ($relaunch -eq 1 -and $exePath) {',
    '    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exePath }',
    '  } else { $null }',
    '  if (-not $mainAlive -and -not $sameExe) {',
    '    $exited = $true',
    '    break',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'if ($expectedSha) {',
    "  $actualSha = ''",
    '  try { $actualSha = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() } catch {}',
    '  if ($actualSha -ne $expectedSha) {',
    '    Write-UpdLog ("Pre-exec SHA-256 verification failed (expected=" + $expectedSha + " actual=" + $actualSha + "); aborting")',
    '    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue',
    '    if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }',
    '    exit 1',
    '  }',
    '}',
    'if (-not $exited) {',
    '  Write-UpdLog ("Old process still running after 30s (PID=" + $oldPid + "); launching interactive installer instead of /S")',
    '  Start-Process -FilePath $installer',
    '} else {',
    '  Start-Sleep -Milliseconds 800',
    '  Write-UpdLog ("Running silent NSIS installer: " + $installer)',
    '  $nsisArgs = if ($installDir) { "/S /D=$installDir" } else { "/S" }',
    '  $proc = Start-Process -FilePath $installer -ArgumentList $nsisArgs -Wait -PassThru -WindowStyle Hidden',
    '  $exitCode = if ($null -ne $proc) { $proc.ExitCode } else { -1 }',
    '  Write-UpdLog ("Installer exited with code " + $exitCode)',
    '  if ($exitCode -ne 0) {',
    '    Start-Process -FilePath $installer',
    '  } elseif ($relaunch -eq 1 -and $exePath -and (Test-Path -LiteralPath $exePath)) {',
    '    Start-Sleep -Milliseconds 800',
    '    Write-UpdLog ("Relaunching: " + $exePath)',
    '    Start-Process -FilePath $exePath',
    '  }',
    '}',
    'if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }',
  ].join('\r\n')

  const vbsScript = [
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'psExe = sh.ExpandEnvironmentStrings("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")',
    'If Not fso.FileExists(psExe) Then psExe = "powershell.exe"',
    `cmd = """" & psExe & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & "${escVbs(resolvedPs1)}" & """"`,
    'On Error Resume Next',
    'sh.Run cmd, 0, True',
    `fso.DeleteFile "${escVbs(resolvedPs1)}", True`,
    'fso.DeleteFile WScript.ScriptFullName, True',
  ].join('\r\n')

  return { psScript, vbsScript }
}

export class DesktopUpdater extends EventEmitter {
  constructor({
    currentVersion = '0.0.0',
    repo = DEFAULT_GITHUB_REPO,
    platform = process.platform,
    arch = process.arch,
    downloadDir = join(os.tmpdir(), 'allinone-updates'),
    apiUrl = '',
    allowLocalhost = false,
    requireSha256 = true,
    manifestPublicKey = '',
    requireSignature = false,
    getLang = () => 'zh',
  } = {}) {
    super()
    this.currentVersion = String(currentVersion || '0.0.0').replace(/^v/i, '')
    this.repo = repo
    this.platform = platform
    this.arch = arch
    this.downloadDir = downloadDir
    this.apiUrl = apiUrl || `https://api.github.com/repos/${repo}/releases/latest`
    this.allowLocalhost = allowLocalhost
    this.requireSha256 = requireSha256 !== false
    this.manifestPublicKey = String(manifestPublicKey || '').trim()
    this.requireSignature = Boolean(requireSignature || this.manifestPublicKey)
    this.getLang = typeof getLang === 'function' ? getLang : () => 'zh'
    this.abortController = null
    this.isChecking = false
    this._installing = false
    this._downloadSeq = 0
    this._releaseEtag = ''
    this._cachedRelease = null

    this.state = {
      status: 'idle', // 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
      currentVersion: this.currentVersion,
      latestVersion: '',
      releaseUrl: `https://github.com/${repo}/releases/latest`,
      releaseNotes: '',
      publishedAt: '',
      assetName: '',
      assetSize: 0,
      downloadUrl: '',
      expectedSha256: '',
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 0,
      downloadedPath: '',
      checkedAt: 0,
      error: '',
    }
  }

  bi(zh, en) {
    return String(this.getLang?.() || '').toLowerCase().startsWith('en') ? en : zh
  }

  getState() {
    return { ...this.state }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.getState())
    return this.getState()
  }

  async checkForUpdates({ silent = false } = {}) {
    const isBusy = () =>
      this.state.status === 'downloading' || this.state.status === 'installing' || this._installing
    if (this.isChecking || this.state.status === 'checking' || isBusy()) {
      return this.getState()
    }

    this.isChecking = true
    if (!silent) {
      this.setState({ status: 'checking', error: '' })
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let res
      try {
        const headers = {
          Accept: 'application/vnd.github+json',
          'User-Agent': `AllInOne-Desktop/${this.currentVersion}`,
        }
        if (this._releaseEtag && this._cachedRelease) {
          headers['If-None-Match'] = this._releaseEtag
        }
        res = await fetch(this.apiUrl, {
          headers,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (isBusy()) return this.getState()

      let release = null
      if (res.status === 304 && this._cachedRelease) {
        release = this._cachedRelease
      } else {
        if (!res.ok) {
          throw new Error(this.bi(`GitHub API 返回 HTTP ${res.status}`, `GitHub API returned HTTP ${res.status}`))
        }
        release = await res.json()
        const nextEtag = res.headers?.get?.('etag') || ''
        if (nextEtag && release) {
          this._releaseEtag = nextEtag
          this._cachedRelease = release
        }
      }
      if (isBusy()) return this.getState()
      const latestVersion = String(release.tag_name || '').trim().replace(/^v/i, '')
      if (!parseSemver(latestVersion)) {
        throw new Error(this.bi(`无法解析远端版本号: ${release.tag_name || '(空)'}`, `Invalid remote version tag: ${release.tag_name || '(empty)'}`))
      }

      const releaseUrl = String(release.html_url || `https://github.com/${this.repo}/releases/latest`)
      const releaseNotes = String(release.body || '').trim().slice(0, 1200)
      const publishedAt = String(release.published_at || '')
      const hasNewer = compareSemver(latestVersion, this.currentVersion) > 0

      if (!hasNewer) {
        return this.setState({
          status: 'up-to-date',
          latestVersion,
          releaseUrl,
          releaseNotes,
          publishedAt,
          checkedAt: Date.now(),
          error: '',
        })
      }

      const asset = pickReleaseAsset(release.assets, this.platform, this.arch)
      if (!asset) {
        return this.setState({
          status: 'available',
          latestVersion,
          releaseUrl,
          releaseNotes,
          publishedAt,
          assetName: '',
          assetSize: 0,
          downloadUrl: '',
          expectedSha256: '',
          downloadedPath: '',
          checkedAt: Date.now(),
          error: '',
        })
      }

      let expectedSha256 = parseExpectedSha256(asset.digest)
      if (this.manifestPublicKey) {
        const manifestAsset = (Array.isArray(release.assets) ? release.assets : []).find(
          (a) => a && a.name === DESKTOP_MANIFEST_NAME && isAllowedDownloadUrl(a.browser_download_url, this.allowLocalhost),
        )
        let manifestOk = false
        if (manifestAsset) {
          try {
            const mCtrl = new AbortController()
            const mTimer = setTimeout(() => mCtrl.abort(), 10_000)
            try {
              const mRes = await fetch(manifestAsset.browser_download_url, {
                headers: { 'User-Agent': `AllInOne-Desktop/${this.currentVersion}` },
                signal: mCtrl.signal,
              })
              if (mRes.ok) {
                const manifest = await mRes.json().catch(() => null)
                if (
                  manifest &&
                  String(manifest.version || '').trim().replace(/^v/i, '') === latestVersion &&
                  verifyManifestSignature(manifest, this.manifestPublicKey)
                ) {
                  const mEntry = manifest.assets.find((a) => a && a.name === asset.name)
                  if (mEntry && /^[a-f0-9]{64}$/i.test(String(mEntry.sha256 || ''))) {
                    const signedSha = String(mEntry.sha256).toLowerCase()
                    if (!expectedSha256 || expectedSha256 === signedSha) {
                      expectedSha256 = signedSha
                      manifestOk = true
                    }
                  }
                }
              }
            } finally {
              clearTimeout(mTimer)
            }
          } catch {}
        }
        if (this.requireSignature && !manifestOk) {
          throw new Error(
            this.bi(
              '远端安装包缺少有效的 Ed25519 发布签名，已阻止自动更新',
              'Remote release is missing a valid Ed25519 manifest signature; update blocked for security.',
            ),
          )
        }
      }
      const safeName = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const cachedPath = join(this.downloadDir, safeName)

      // Reuse already-downloaded file if digest policy + size + SHA-256 match
      const digestAllowed = !this.requireSha256 || Boolean(expectedSha256)
      if (digestAllowed && existsSync(cachedPath)) {
        try {
          const st = statSync(cachedPath)
          const sizeOk = !asset.size || st.size === asset.size
          const hashOk = !expectedSha256 || (await sha256File(cachedPath)) === expectedSha256
          if (isBusy()) return this.getState()
          if (sizeOk && hashOk) {
            return this.setState({
              status: 'downloaded',
              latestVersion,
              releaseUrl,
              releaseNotes,
              publishedAt,
              assetName: asset.name,
              assetSize: Number(asset.size) || st.size,
              downloadUrl: asset.browser_download_url,
              expectedSha256,
              downloadedBytes: st.size,
              totalBytes: Number(asset.size) || st.size,
              percent: 100,
              downloadedPath: cachedPath,
              checkedAt: Date.now(),
              error: '',
            })
          }
        } catch {}
      }

      if (isBusy()) return this.getState()

      return this.setState({
        status: 'available',
        latestVersion,
        releaseUrl,
        releaseNotes,
        publishedAt,
        assetName: asset.name,
        assetSize: Number(asset.size) || 0,
        downloadUrl: asset.browser_download_url,
        expectedSha256,
        downloadedBytes: 0,
        totalBytes: Number(asset.size) || 0,
        percent: 0,
        downloadedPath: '',
        checkedAt: Date.now(),
        error: '',
      })
    } catch (err) {
      if (silent || isBusy()) {
        return this.getState()
      }
      const msg = err?.name === 'AbortError'
        ? this.bi('检查更新超时，请稍后重试或检查网络', 'Update check timed out. Please check your network and retry.')
        : String(err?.message || err || this.bi('检查更新失败', 'Failed to check for updates'))
      return this.setState({
        status: 'error',
        checkedAt: Date.now(),
        error: msg,
      })
    } finally {
      this.isChecking = false
    }
  }

  async downloadUpdate() {
    if (this.state.status === 'downloading' || this.state.status === 'installing' || this._installing) {
      return this.getState()
    }
    if (this.state.status === 'downloaded' && this.state.downloadedPath && existsSync(this.state.downloadedPath)) {
      return this.getState()
    }
    const { downloadUrl, assetName, assetSize, expectedSha256 } = this.state
    if (!downloadUrl || !assetName) {
      return this.setState({
        status: 'error',
        error: this.bi(
          '当前版本暂无匹配此系统的自动安装包，请前往 GitHub Releases 手动下载',
          'No matching installer for this platform. Please download manually from GitHub Releases.',
        ),
      })
    }
    if (!isAllowedDownloadUrl(downloadUrl, this.allowLocalhost)) {
      return this.setState({
        status: 'error',
        error: this.bi('拒绝从不受信任的下载地址拉取安装包', 'Blocked download from untrusted host'),
      })
    }
    if (this.requireSha256 && !expectedSha256) {
      return this.setState({
        status: 'error',
        error: this.bi(
          '安装包缺少官方 SHA-256 校验摘要，出于安全已阻止自动更新，请前往 GitHub Releases 手动核验下载',
          'Installer is missing an official SHA-256 digest. Automatic update blocked for security; please verify on GitHub Releases.',
        ),
      })
    }

    mkdirSync(this.downloadDir, { recursive: true })
    try { chmodSync(this.downloadDir, 0o700) } catch {}
    const safeName = assetName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const finalPath = join(this.downloadDir, safeName)
    const myDownloadSeq = ++this._downloadSeq
    const partPath = `${finalPath}.${process.pid}.${Date.now()}.${myDownloadSeq}.part`

    const controller = new AbortController()
    this.abortController = controller

    this.setState({
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: assetSize || 0,
      percent: 0,
      downloadedPath: '',
      error: '',
    })

    try {
      const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': `AllInOne-Desktop/${this.currentVersion}` },
        redirect: 'follow',
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(this.bi(`下载安装包失败 (HTTP ${res.status})`, `Installer download failed (HTTP ${res.status})`))
      }
      if (res.url && !isAllowedDownloadUrl(res.url, this.allowLocalhost)) {
        throw new Error(this.bi('下载重定向到了不受信任的域名', 'Download redirected to an untrusted host'))
      }

      const contentLen = Number(res.headers.get('content-length') || 0)
      const totalBytes = contentLen || assetSize || 0
      const hash = createHash('sha256')
      const out = createWriteStream(partPath)
      let streamError = null
      let streamClosed = false
      const closePromise = new Promise((resolveClose) => {
        out.once('close', () => {
          streamClosed = true
          resolveClose()
        })
      })
      out.on('error', (err) => {
        streamError = err
      })

      const waitForDrain = () =>
        new Promise((resolveDrain, rejectDrain) => {
          if (streamError) return rejectDrain(streamError)
          if (streamClosed || out.destroyed) {
            return rejectDrain(new Error('Write stream closed before drain'))
          }
          const cleanup = () => {
            out.removeListener('drain', onDrain)
            out.removeListener('error', onErr)
            out.removeListener('close', onClose)
          }
          const onDrain = () => {
            cleanup()
            resolveDrain()
          }
          const onErr = (err) => {
            cleanup()
            rejectDrain(err)
          }
          const onClose = () => {
            cleanup()
            rejectDrain(streamError || new Error('Write stream closed before drain'))
          }
          out.once('drain', onDrain)
          out.once('error', onErr)
          out.once('close', onClose)
        })

      const closeAndUnlinkPart = async () => {
        try {
          if (!streamClosed) {
            out.destroy()
            await Promise.race([closePromise, new Promise((r) => setTimeout(r, 2000))])
          }
        } catch {}
        try {
          if (existsSync(partPath)) unlinkSync(partPath)
        } catch {}
      }

      let downloadedBytes = 0
      let lastEmitAt = 0

      try {
        const reader = res.body?.getReader?.()
        if (!reader) throw new Error('当前环境不支持流式下载')
        while (true) {
          if (streamError) throw streamError
          if (myDownloadSeq !== this._downloadSeq) {
            const abortErr = new Error('Download cancelled')
            abortErr.name = 'AbortError'
            throw abortErr
          }
          const { done, value } = await reader.read()
          if (done) break
          if (streamError) throw streamError
          const chunk = Buffer.from(value)
          hash.update(chunk)
          if (!out.write(chunk)) {
            await waitForDrain()
          }
          downloadedBytes += chunk.length
          const now = Date.now()
          if (
            myDownloadSeq === this._downloadSeq &&
            (now - lastEmitAt >= 180 || (totalBytes > 0 && downloadedBytes >= totalBytes))
          ) {
            lastEmitAt = now
            const percent = totalBytes > 0 ? Math.min(99, Math.floor((downloadedBytes * 100) / totalBytes)) : 0
            this.setState({
              status: 'downloading',
              downloadedBytes,
              totalBytes,
              percent,
            })
          }
        }
        if (streamError) throw streamError
        await new Promise((resolveEnd, rejectEnd) => {
          if (streamError) return rejectEnd(streamError)
          const cleanup = () => {
            out.removeListener('finish', onFinish)
            out.removeListener('error', onErr)
            out.removeListener('close', onClose)
          }
          const onFinish = () => {
            cleanup()
            resolveEnd()
          }
          const onErr = (err) => {
            cleanup()
            rejectEnd(err)
          }
          const onClose = () => {
            cleanup()
            if (streamError) rejectEnd(streamError)
            else resolveEnd()
          }
          out.once('finish', onFinish)
          out.once('error', onErr)
          out.once('close', onClose)
          out.end()
        })
        if (!streamClosed) {
          await Promise.race([closePromise, new Promise((r) => setTimeout(r, 2000))])
        }
      } catch (streamErr) {
        try { await res.body?.cancel?.() } catch {}
        await closeAndUnlinkPart()
        throw streamErr
      }

      if (myDownloadSeq !== this._downloadSeq) {
        await closeAndUnlinkPart()
        return this.getState()
      }

      if (contentLen > 0 && downloadedBytes !== contentLen) {
        await closeAndUnlinkPart()
        throw new Error(
          this.bi(
            `安装包下载不完整（预期 ${contentLen} 字节，实际 ${downloadedBytes} 字节），请重试下载`,
            `Incomplete installer download (expected ${contentLen} bytes, received ${downloadedBytes} bytes). Please retry.`,
          ),
        )
      }

      const actualSha256 = hash.digest('hex').toLowerCase()
      if (expectedSha256 && actualSha256 !== expectedSha256) {
        await closeAndUnlinkPart()
        throw new Error(this.bi('安装包 SHA-256 校验失败，已自动丢弃，请重试下载', 'Installer SHA-256 verification failed. Discarded corrupted file, please retry.'))
      }

      try {
        try { unlinkSync(finalPath) } catch {}
        renameSync(partPath, finalPath)
      } catch (renameErr) {
        await closeAndUnlinkPart()
        throw renameErr
      }

      // Prune stale installers & leftover updater helper scripts in downloadDir
      try {
        const keepName = basename(finalPath)
        for (const entry of readdirSync(this.downloadDir)) {
          if (entry === keepName || entry === 'last-update.log') continue
          if (/\.(?:dmg|exe|AppImage|part|ps1|vbs|sh)$/i.test(entry)) {
            try { unlinkSync(join(this.downloadDir, entry)) } catch {}
          }
        }
      } catch {}

      if (myDownloadSeq !== this._downloadSeq) {
        return this.getState()
      }

      return this.setState({
        status: 'downloaded',
        downloadedBytes,
        totalBytes: totalBytes || downloadedBytes,
        percent: 100,
        downloadedPath: finalPath,
        error: '',
      })
    } catch (err) {
      if (myDownloadSeq !== this._downloadSeq) {
        return this.getState()
      }
      if (err?.name === 'AbortError') {
        return this.setState({
          status: 'available',
          downloadedBytes: 0,
          percent: 0,
          error: '',
        })
      }
      return this.setState({
        status: 'error',
        error: String(err?.message || err || '下载更新失败'),
      })
    } finally {
      if (this.abortController === controller) {
        this.abortController = null
      }
    }
  }

  cancelDownload() {
    this._downloadSeq += 1
    if (this.abortController) {
      try { this.abortController.abort() } catch {}
      this.abortController = null
    }
    if (this.state.status === 'downloading') {
      return this.setState({
        status: 'available',
        downloadedBytes: 0,
        percent: 0,
        error: '',
      })
    }
    return this.getState()
  }

  /**
   * Launches an OS-native in-place silent update & automatic relaunch helper, then triggers `onQuit`.
   */
  async installAndRestart({
    exePath = process.execPath,
    pid = process.pid,
    isPackaged = false,
    openExternalPath = null,
    onQuit = null,
  } = {}) {
    if (this._installing || this.state.status === 'installing') {
      return this.getState()
    }
    this._installing = true

    try {
      const installerPath = this.state.downloadedPath
      if (!installerPath || !existsSync(installerPath)) {
        return this.setState({
          status: 'error',
          error: this.bi('安装包文件不存在，请重新下载', 'Installer file missing. Please download again.'),
        })
      }

      // Re-verify SHA-256 right before execution to defeat local file tampering (TOCTOU)
      const expectedSha256 = String(this.state.expectedSha256 || '').trim().toLowerCase()
      if (this.requireSha256 && !expectedSha256) {
        return this.setState({
          status: 'error',
          error: this.bi('安装包缺少 SHA-256 摘要，已取消安装', 'Installer missing SHA-256 digest; installation aborted.'),
        })
      }

      this.setState({ status: 'installing', error: '' })

      if (expectedSha256) {
        const currentSha = await sha256File(installerPath).catch(() => '')
        if (!currentSha || currentSha !== expectedSha256) {
          try { unlinkSync(installerPath) } catch {}
          return this.setState({
            status: 'error',
            downloadedPath: '',
            error: this.bi(
              '安装前复核 SHA-256 校验失败，文件可能已被篡改，已删除并中止安装',
              'Pre-install SHA-256 verification failed. File discarded for security.',
            ),
          })
        }
      }

      const spawnDetachedHelper = (cmd, args, options) =>
        new Promise((resolveSpawn, rejectSpawn) => {
          const child = spawn(cmd, args, options)
          let settled = false
          child.on('error', (err) => {
            if (!settled) {
              settled = true
              rejectSpawn(err)
              return
            }
            this._installing = false
            this.setState({
              status: 'error',
              error: this.bi(
                `启动安装助手失败: ${String(err?.message || err)}`,
                `Failed to launch update helper: ${String(err?.message || err)}`,
              ),
            })
          })
          child.once('spawn', () => {
            if (!settled) {
              settled = true
              child.unref()
              resolveSpawn(child)
            }
          })
        })

      if (this.platform === 'win32') {
        mkdirSync(this.downloadDir, { recursive: true })
        try { chmodSync(this.downloadDir, 0o700) } catch {}
        const randId = randomBytes(6).toString('hex')
        const ps1Path = join(this.downloadDir, `apply-update-${randId}.ps1`)
        const vbsPath = join(this.downloadDir, `apply-update-${randId}.vbs`)
        const logPath = join(this.downloadDir, 'last-update.log')
        const { psScript, vbsScript } = buildWindowsUpdateScripts({
          installerPath,
          exePath,
          pid,
          isPackaged,
          logPath,
          ps1Path,
          expectedSha256,
        })

        try {
          // UTF-8 BOM for PowerShell 5.1 Unicode paths; UTF-16LE BOM for VBScript Unicode paths
          writeFileSync(ps1Path, `\uFEFF${psScript}`, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
          const wscriptExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')

          if (existsSync(wscriptExe)) {
            writeFileSync(vbsPath, `\uFEFF${vbsScript}`, { encoding: 'utf16le', mode: 0o700, flag: 'wx' })
            await spawnDetachedHelper(wscriptExe, ['//B', '//Nologo', vbsPath], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            })
          } else {
            const psExe = join(
              process.env.SystemRoot || 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            )
            await spawnDetachedHelper(
              existsSync(psExe) ? psExe : 'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
              {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              },
            )
          }
        } catch (err) {
          try { if (existsSync(ps1Path)) unlinkSync(ps1Path) } catch {}
          try { if (existsSync(vbsPath)) unlinkSync(vbsPath) } catch {}
          return this.setState({
            status: 'error',
            error: this.bi(
              `启动安装程序失败: ${String(err?.message || err)}`,
              `Failed to launch installer: ${String(err?.message || err)}`,
            ),
          })
        }

        if (typeof onQuit === 'function') await onQuit()
        return this.getState()
      }

      if (this.platform === 'darwin') {
        const appBundle = isPackaged ? resolveMacAppBundlePath(exePath) : ''
        const canSelfReplace = Boolean(
          appBundle &&
          existsSync(appBundle) &&
          !appBundle.startsWith('/Volumes/') &&
          isWritableDir(dirname(appBundle)),
        )

        if (canSelfReplace) {
          mkdirSync(this.downloadDir, { recursive: true })
          try { chmodSync(this.downloadDir, 0o700) } catch {}
          const helperPath = join(this.downloadDir, `apply-update-${randomBytes(6).toString('hex')}.sh`)
          const esc = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
          const cleanSha = /^[a-f0-9]{64}$/i.test(expectedSha256) ? expectedSha256.toLowerCase() : ''
          const script = [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            `OLD_PID=${Number(pid) || 0}`,
            `DMG=${esc(resolve(installerPath))}`,
            `TARGET_APP=${esc(appBundle)}`,
            `EXPECTED_SHA=${esc(cleanSha)}`,
            'MNT=""',
            'cleanup() {',
            '  if [ -n "${MNT:-}" ] && [ -d "$MNT" ]; then',
            '    hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true',
            '    rmdir "$MNT" 2>/dev/null || true',
            '  fi',
            '  rm -f "$0" 2>/dev/null || true',
            '}',
            'trap cleanup EXIT',
            'verify_dmg_sha() {',
            '  if [ -n "$EXPECTED_SHA" ]; then',
            '    ACTUAL_SHA="$(shasum -a 256 "$DMG" 2>/dev/null | awk \'{print tolower($1)}\')"',
            '    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then',
            '      rm -f "$DMG" 2>/dev/null || true',
            '      exit 1',
            '    fi',
            '  fi',
            '}',
            'WAITED=0',
            'while [ "$OLD_PID" -gt 0 ] && kill -0 "$OLD_PID" 2>/dev/null; do',
            '  WAITED=$((WAITED + 1))',
            '  if [ "$WAITED" -ge 60 ]; then',
            '    verify_dmg_sha',
            '    open "$DMG"',
            '    exit 1',
            '  fi',
            '  sleep 0.5',
            'done',
            'verify_dmg_sha',
            'MNT="$(mktemp -d /tmp/allinone-upd-XXXXXX)"',
            'if ! hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null 2>&1; then',
            '  open "$DMG"',
            '  exit 1',
            'fi',
            'SRC_APP=""',
            'while IFS= read -r cand; do',
            '  if [ -n "$cand" ]; then',
            '    SRC_APP="$cand"',
            '    break',
            '  fi',
            'done <<< "$(find "$MNT" -maxdepth 2 -name "*.app" -print 2>/dev/null || true)"',
            'if [ -z "$SRC_APP" ]; then open "$DMG"; exit 1; fi',
            'BACKUP="${TARGET_APP}.bak.$$"',
            'if ! mv "$TARGET_APP" "$BACKUP"; then',
            '  open "$DMG"',
            '  exit 1',
            'fi',
            'if ditto "$SRC_APP" "$TARGET_APP"; then',
            '  xattr -cr "$TARGET_APP" 2>/dev/null || true',
            '  rm -rf "$BACKUP" 2>/dev/null || true',
            '  open "$TARGET_APP"',
            'else',
            '  rm -rf "$TARGET_APP" 2>/dev/null || true',
            '  mv "$BACKUP" "$TARGET_APP" || true',
            '  open "$DMG"',
            'fi',
          ].join('\n')
          try {
            writeFileSync(helperPath, script, { encoding: 'utf8', mode: 0o700, flag: 'wx' })
            try { chmodSync(helperPath, 0o700) } catch {}
            await spawnDetachedHelper('/bin/bash', [helperPath], {
              detached: true,
              stdio: 'ignore',
            })
          } catch (err) {
            try { if (existsSync(helperPath)) unlinkSync(helperPath) } catch {}
            return this.setState({
              status: 'error',
              error: this.bi(
                `启动 macOS 安装助手失败: ${String(err?.message || err)}`,
                `Failed to launch macOS update helper: ${String(err?.message || err)}`,
              ),
            })
          }
          if (typeof onQuit === 'function') await onQuit()
          return this.getState()
        }

        // Fallback: open DMG directly in Finder
        if (typeof openExternalPath === 'function') {
          await openExternalPath(installerPath)
        }
        return this.setState({ status: 'downloaded' })
      }

      if (typeof openExternalPath === 'function') {
        await openExternalPath(installerPath)
      }
      return this.setState({ status: 'downloaded' })
    } catch (err) {
      return this.setState({
        status: 'error',
        error: String(err?.message || err || this.bi('安装更新失败', 'Failed to install update')),
      })
    } finally {
      if (this.state.status !== 'installing') {
        this._installing = false
      }
    }
  }
}
