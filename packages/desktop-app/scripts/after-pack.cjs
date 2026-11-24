const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

const KEEP_MAC_LPROJ = new Set(['en.lproj', 'en_GB.lproj', 'zh_CN.lproj', 'zh_TW.lproj'])
const KEEP_PAK_LOCALES = new Set(['en-US.pak', 'en-GB.pak', 'zh-CN.pak', 'zh-TW.pak'])

function dirSizeBytes(targetPath) {
  let total = 0
  try {
    const st = statSync(targetPath)
    if (st.isFile()) return st.size
    if (st.isDirectory()) {
      for (const entry of readdirSync(targetPath)) {
        total += dirSizeBytes(join(targetPath, entry))
      }
    }
  } catch {}
  return total
}

function pruneDirectoryEntries(dir, shouldRemove) {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 }
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    if (!shouldRemove(name)) continue
    const full = join(dir, name)
    bytes += dirSizeBytes(full)
    rmSync(full, { recursive: true, force: true })
    removed += 1
  }
  return { removed, bytes }
}

/**
 * electron-builder afterPack hook:
 * 1. Prunes 50+ unused Chromium locale packs (keeping en/en_GB/zh_CN/zh_TW) on macOS, Windows,
 *    and Linux to shrink installer download size & unpacked footprint with zero functional impact.
 * 2. On macOS without an Apple Developer ID certificate (identity: null), performs a proper
 *    ad-hoc deep re-sign (`codesign --force --deep --sign -`) AFTER pruning so the bundle has a
 *    clean, valid signature (`Identifier=com.allinone.desktop`).
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const appName = context.packager.appInfo.productFilename

  // 1. Prune unused Chromium locales (safe across all platforms)
  let totalRemoved = 0
  let totalBytes = 0
  if (platform === 'darwin') {
    const appPath = join(context.appOutDir, `${appName}.app`)
    const macLocaleDirs = [
      join(appPath, 'Contents', 'Resources'),
      join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'),
    ]
    for (const dir of macLocaleDirs) {
      const res = pruneDirectoryEntries(dir, (name) => name.endsWith('.lproj') && !KEEP_MAC_LPROJ.has(name))
      totalRemoved += res.removed
      totalBytes += res.bytes
    }
  } else {
    const localesDir = join(context.appOutDir, 'locales')
    const res = pruneDirectoryEntries(localesDir, (name) => name.endsWith('.pak') && !KEEP_PAK_LOCALES.has(name))
    totalRemoved += res.removed
    totalBytes += res.bytes
  }
  if (totalRemoved > 0) {
    console.log(
      `[afterPack] Pruned ${totalRemoved} unused locale pack(s), saved ${(totalBytes / 1024 / 1024).toFixed(1)} MB unpacked`,
    )
  }

  // 2. Ad-hoc deep re-sign macOS bundle when no Developer ID signing cert is configured (or identity: null)
  if (platform !== 'darwin') return
  if (
    context?.packager?.platformSpecificBuildOptions?.identity !== null &&
    (process.env.CSC_LINK || process.env.CSC_NAME)
  ) {
    return
  }

  const appPath = join(context.appOutDir, `${appName}.app`)
  console.log(`[afterPack] Ad-hoc deep signing macOS bundle: ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('[afterPack] macOS ad-hoc signature verified OK')
}
