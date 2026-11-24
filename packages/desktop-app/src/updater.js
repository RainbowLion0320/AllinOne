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
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_GITHUB_REPO = 'RainbowLion0320/AllinOne'
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

export function parseSemver(raw) {
  const clean = String(raw || '').trim().replace(/^v/i, '')
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || '',
  }
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre.localeCompare(pb.pre)
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
}) {
  const safePid = Number(pid) || 0
  const escPs = (s) => String(s || '').replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')
  const escVbs = (s) => String(s || '').replace(/"/g, '""')
  const resolvedInstaller = resolve(installerPath)
  const resolvedExe = resolve(exePath)
  const resolvedLog = logPath ? resolve(logPath) : ''
  const resolvedPs1 = ps1Path ? resolve(ps1Path) : ''

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$oldPid = ${safePid}`,
    `$installer = '${escPs(resolvedInstaller)}'`,
    `$exePath = '${escPs(resolvedExe)}'`,
    `$relaunch = ${isPackaged ? 1 : 0}`,
    `$logPath = '${escPs(resolvedLog)}'`,
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
    'if (-not $exited) {',
    '  Write-UpdLog ("Old process still running after 30s (PID=" + $oldPid + "); launching interactive installer instead of /S")',
    '  Start-Process -FilePath $installer',
    '} else {',
    '  Start-Sleep -Milliseconds 800',
    '  Write-UpdLog ("Running silent NSIS installer: " + $installer)',
    '  $proc = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden',
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
    this.getLang = typeof getLang === 'function' ? getLang : () => 'zh'
    this.abortController = null
    this._installing = false
    this._downloadSeq = 0

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
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'installing') {
      return this.getState()
    }

    if (!silent) {
      this.setState({ status: 'checking', error: '' })
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let res
      try {
        res = await fetch(this.apiUrl, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `AllInOne-Desktop/${this.currentVersion}`,
          },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) {
        throw new Error(this.bi(`GitHub API 返回 HTTP ${res.status}`, `GitHub API returned HTTP ${res.status}`))
      }
      const release = await res.json()
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

      const expectedSha256 = parseExpectedSha256(asset.digest)
      const safeName = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const cachedPath = join(this.downloadDir, safeName)

      // Reuse already-downloaded file if digest policy + size + SHA-256 match
      const digestAllowed = !this.requireSha256 || Boolean(expectedSha256)
      if (digestAllowed && existsSync(cachedPath)) {
        try {
          const st = statSync(cachedPath)
          const sizeOk = !asset.size || st.size === asset.size
          const hashOk = !expectedSha256 || (await sha256File(cachedPath)) === expectedSha256
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
      if (silent) {
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

      try { unlinkSync(finalPath) } catch {}
      renameSync(partPath, finalPath)

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
        const stamp = Date.now()
        const ps1Path = join(this.downloadDir, `apply-update-${stamp}.ps1`)
        const vbsPath = join(this.downloadDir, `apply-update-${stamp}.vbs`)
        const logPath = join(this.downloadDir, 'last-update.log')
        const { psScript, vbsScript } = buildWindowsUpdateScripts({
          installerPath,
          exePath,
          pid,
          isPackaged,
          logPath,
          ps1Path,
        })

        try {
          // UTF-8 BOM for PowerShell 5.1 Unicode paths; UTF-16LE BOM for VBScript Unicode paths
          writeFileSync(ps1Path, `\uFEFF${psScript}`, 'utf8')
          const wscriptExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')

          if (existsSync(wscriptExe)) {
            writeFileSync(vbsPath, `\uFEFF${vbsScript}`, 'utf16le')
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
          const helperPath = join(this.downloadDir, `apply-update-${Date.now()}.sh`)
          const esc = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
          const script = [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            `OLD_PID=${Number(pid) || 0}`,
            `DMG=${esc(resolve(installerPath))}`,
            `TARGET_APP=${esc(appBundle)}`,
            'WAITED=0',
            'while [ "$OLD_PID" -gt 0 ] && kill -0 "$OLD_PID" 2>/dev/null; do',
            '  WAITED=$((WAITED + 1))',
            '  if [ "$WAITED" -ge 60 ]; then',
            '    open "$DMG"',
            '    exit 1',
            '  fi',
            '  sleep 0.5',
            'done',
            'MNT="$(mktemp -d /tmp/allinone-upd-XXXXXX)"',
            'cleanup() {',
            '  if [ -n "${MNT:-}" ] && [ -d "$MNT" ]; then',
            '    hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true',
            '    rmdir "$MNT" 2>/dev/null || true',
            '  fi',
            '  rm -f "$0" 2>/dev/null || true',
            '}',
            'trap cleanup EXIT',
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
            'mv "$TARGET_APP" "$BACKUP"',
            'if ditto "$SRC_APP" "$TARGET_APP"; then',
            '  xattr -cr "$TARGET_APP" 2>/dev/null || true',
            '  rm -rf "$BACKUP"',
            '  open "$TARGET_APP"',
            'else',
            '  rm -rf "$TARGET_APP" 2>/dev/null || true',
            '  mv "$BACKUP" "$TARGET_APP"',
            '  open "$DMG"',
            'fi',
          ].join('\n')
          try {
            writeFileSync(helperPath, script, 'utf8')
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
