const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

/**
 * electron-builder afterPack hook:
 * On macOS without an Apple Developer ID certificate (identity: null), Electron's stock
 * executable keeps its stale upstream signature ("Identifier=Electron") which becomes invalid
 * once electron-builder edits Info.plist/resources, causing Gatekeeper to report the app as
 * "damaged and can't be opened" on Apple Silicon.
 *
 * Performing a proper ad-hoc deep re-sign (`codesign --force --deep --sign -`) seals the
 * bundle with a valid signature (`Identifier=com.allinone.desktop`, valid on disk).
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  console.log(`[afterPack] Ad-hoc deep signing macOS bundle: ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('[afterPack] macOS ad-hoc signature verified OK')
}
