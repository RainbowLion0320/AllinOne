const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/**
 * Zero-dependency electron-builder `afterSign` hook for Apple macOS Notarization.
 *
 * Supports:
 *  - App Store Connect API Key (recommended for CI):
 *      APPLE_API_KEY_BASE64 (or APPLE_API_KEY_PATH) + APPLE_API_KEY_ID + APPLE_API_ISSUER
 *  - Apple ID + App-Specific Password (fallback):
 *      APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (default: 37FM46Q69N)
 *
 * Gracefully skips notarization on local unsigned / ad-hoc builds so local dev packaging
 * never fails when signing credentials are absent.
 */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const hasDeveloperIdSign = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
  if (!hasDeveloperIdSign) {
    console.log('[notarize] Skipping Apple notarization (ad-hoc / unsigned local build)')
    return
  }

  const apiKeyB64 = String(process.env.APPLE_API_KEY_BASE64 || '').trim()
  const apiKeyPathEnv = String(process.env.APPLE_API_KEY_PATH || '').trim()
  const apiKeyId = String(process.env.APPLE_API_KEY_ID || '').trim()
  const apiIssuer = String(process.env.APPLE_API_ISSUER || '').trim()

  const appleId = String(process.env.APPLE_ID || '').trim()
  const applePassword = String(process.env.APPLE_APP_SPECIFIC_PASSWORD || '').trim()
  const teamId = String(process.env.APPLE_TEAM_ID || '37FM46Q69N').trim()

  const useApiKey = Boolean((apiKeyB64 || apiKeyPathEnv) && apiKeyId && apiIssuer)
  const useAppleId = Boolean(appleId && applePassword && teamId)

  if (!useApiKey && !useAppleId) {
    console.log('[notarize] Skipping Apple notarization (no APPLE_API_KEY_* or APPLE_ID credentials configured)')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  if (!existsSync(appPath)) {
    throw new Error(`[notarize] Expected signed app bundle not found: ${appPath}`)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'allinone-notarize-'))
  const zipPath = join(workDir, `${appName}.zip`)

  try {
    console.log(`[notarize] Archiving ${appPath} for Apple notary service...`)
    execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' })

    const submitArgs = ['notarytool', 'submit', zipPath, '--wait']
    if (useApiKey) {
      let keyFilePath = apiKeyPathEnv
      if (apiKeyB64) {
        keyFilePath = join(workDir, `AuthKey_${apiKeyId}.p8`)
        writeFileSync(keyFilePath, Buffer.from(apiKeyB64.replace(/\s+/g, ''), 'base64'))
        chmodSync(keyFilePath, 0o600)
      }
      submitArgs.push('--key', keyFilePath, '--key-id', apiKeyId, '--issuer', apiIssuer)
    } else {
      submitArgs.push('--apple-id', appleId, '--password', applePassword, '--team-id', teamId)
    }

    console.log('[notarize] Submitting to Apple Notary Service (xcrun notarytool)...')
    execFileSync('xcrun', submitArgs, { stdio: 'inherit' })

    console.log('[notarize] Stapling notarization ticket onto app bundle...')
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
    console.log('[notarize] macOS notarization and stapling verified OK')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
