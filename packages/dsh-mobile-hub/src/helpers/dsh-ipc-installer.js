/**
 * Automatic zero-terminal installer for the lightweight `allinone-dsh-ipc` Cordis plugin
 * inside DeepSeek Harness (`~/.dsh/profiles/desktop`).
 *
 * Behavior:
 *  - Clean machine without DeepSeek Harness (`~/.dsh/profiles/desktop/package.json` absent): NO-OP.
 *  - Machine that already has `dsh-mobile-hub` in `dsh.profile.bundles`: leaves it untouched.
 *  - Machine with DeepSeek Harness Desktop installed (Win/Mac/Linux):
 *      1) Writes self-contained, zero-dependency `node_modules/allinone-dsh-ipc/` bundle
 *         (`package.json`, `cordis.patch.yml`, `index.js`) with versioned idempotent updates.
 *      2) Backs up `package.json` once to `package.json.bak-before-allinone` before appending
 *         `"allinone-dsh-ipc"` to `dsh.profile.bundles`.
 *  - Respects `ALLINONE_NO_AUTOFIX=1` opt-out.
 */

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'allinone-dsh-ipc'
const ALLOWED_DSH_PERMISSION_PRESETS = new Set(['read-only', 'workspace-write', 'danger-full-access'])

function atomicWriteTextFileSync(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmpPath, content, 'utf8')
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

function resolvePluginVersion() {
  if (typeof __ALLINONE_VERSION__ === 'string' && __ALLINONE_VERSION__.trim()) {
    return __ALLINONE_VERSION__.trim()
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'))
    if (pkg?.version) return String(pkg.version).trim()
  } catch {}
  return '0.0.0'
}

const PLUGIN_VERSION = resolvePluginVersion()

function buildCordisPatchYml(permissionPreset = '') {
  const cleanPreset = ALLOWED_DSH_PERMISSION_PRESETS.has(permissionPreset) ? permissionPreset : ''
  const lines = [
    '# Managed automatically by All in One Desktop App (authenticated 127.0.0.1 IPC only)',
    '- insert:',
    `    - id: ${PLUGIN_NAME}`,
    `      name: ${PLUGIN_NAME}`,
    '      config:',
  ]
  if (cleanPreset) {
    lines.push(`        permissionPreset: '${cleanPreset}'`)
  } else {
    lines.push("        permissionPreset: 'workspace-write'")
  }
  lines.push('')
  return lines.join('\n')
}

function buildPluginPackageJson() {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      private: true,
      type: 'module',
      description: 'All in One authenticated localhost IPC bridge plugin for DeepSeek Harness',
      main: 'index.js',
      exports: {
        '.': './index.js',
        './package.json': './package.json',
      },
      dsh: {
        bundle: {
          patch: './cordis.patch.yml',
        },
      },
    },
    null,
    2,
  )
}

function resolvePluginCode() {
  if (typeof __ALLINONE_DSH_IPC_PLUGIN_CODE__ === 'string' && __ALLINONE_DSH_IPC_PLUGIN_CODE__.length > 100) {
    return __ALLINONE_DSH_IPC_PLUGIN_CODE__
  }
  // Source/dev fallback: re-export directly from the workspace entry file
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const entryPath = resolve(here, '..', 'dsh-ipc-plugin-entry.js')
    if (existsSync(entryPath)) {
      const url = pathToFileURL(entryPath).href
      return `export { name, inject, apply } from ${JSON.stringify(url)}\n`
    }
  } catch {}
  return ''
}

export function ensureDshLocalIpcPlugin({
  dshHome = '',
  env = process.env,
  permissionPreset = '',
  log = console,
} = {}) {
  const noAutofix = String(env.ALLINONE_NO_AUTOFIX || '').trim()
  if (noAutofix === '1' || noAutofix.toLowerCase() === 'true') {
    return { status: 'skipped-opt-out' }
  }

  const baseDshHome = String(dshHome || env.DSH_HOME || '').trim() || join(os.homedir(), '.dsh')
  const profileDir = join(baseDshHome, 'profiles', 'desktop')
  const pkgPath = join(profileDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { status: 'no-dsh-profile' }
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return { status: 'invalid-package-json' }
  }
  if (!pkg || typeof pkg !== 'object') {
    return { status: 'invalid-package-json' }
  }

  const existingBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  if (existingBundles.includes('dsh-mobile-hub')) {
    return { status: 'already-using-dsh-mobile-hub' }
  }

  const pluginCode = resolvePluginCode()
  if (!pluginCode) {
    return { status: 'plugin-code-unavailable' }
  }

  const pluginDir = join(profileDir, 'node_modules', PLUGIN_NAME)
  const pluginPkgPath = join(pluginDir, 'package.json')
  let currentInstalledVersion = ''
  if (existsSync(pluginPkgPath)) {
    try {
      currentInstalledVersion = String(JSON.parse(readFileSync(pluginPkgPath, 'utf8'))?.version || '')
    } catch {}
  }

  const effectivePreset = String(permissionPreset || env.ALLINONE_DSH_PERMISSION_PRESET || '').trim()
  const cordisPatchYml = buildCordisPatchYml(effectivePreset)
  const cordisPatchPath = join(pluginDir, 'cordis.patch.yml')
  let existingPatchContent = ''
  if (existsSync(cordisPatchPath)) {
    try { existingPatchContent = readFileSync(cordisPatchPath, 'utf8') } catch {}
  }

  const needsFileWrite =
    !existsSync(join(pluginDir, 'index.js')) ||
    !existsSync(cordisPatchPath) ||
    existingPatchContent !== cordisPatchYml ||
    currentInstalledVersion !== PLUGIN_VERSION
  const needsBundleEntry = !existingBundles.includes(PLUGIN_NAME)

  if (!needsFileWrite && !needsBundleEntry) {
    return { status: 'up-to-date', version: PLUGIN_VERSION, pluginDir }
  }

  try {
    mkdirSync(pluginDir, { recursive: true })
    // Write implementation files BEFORE package.json version marker so an interrupted write never leaves a stale "up-to-date" install
    atomicWriteTextFileSync(cordisPatchPath, cordisPatchYml)
    atomicWriteTextFileSync(join(pluginDir, 'index.js'), pluginCode)
    atomicWriteTextFileSync(pluginPkgPath, `${buildPluginPackageJson()}\n`)

    if (needsBundleEntry) {
      const backupPath = join(profileDir, 'package.json.bak-before-allinone')
      if (!existsSync(backupPath)) {
        try { copyFileSync(pkgPath, backupPath) } catch {}
      }
      if (!pkg.dsh || typeof pkg.dsh !== 'object') pkg.dsh = {}
      if (!pkg.dsh.profile || typeof pkg.dsh.profile !== 'object') pkg.dsh.profile = {}
      if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
      pkg.dsh.profile.bundles.push(PLUGIN_NAME)
      atomicWriteTextFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    }

    log.info?.(
      `[allinone] 已自动配置 DeepSeek Harness 本机安全 IPC 插件 (${PLUGIN_NAME} v${PLUGIN_VERSION})；重启一次 DeepSeek Harness 后即可读写操控 DSH 对话`,
    )
    return {
      status: needsBundleEntry ? 'installed' : 'updated',
      version: PLUGIN_VERSION,
      pluginDir,
      restartRequired: true,
    }
  } catch (err) {
    log.warn?.(`[allinone] 自动配置 DeepSeek Harness 本机 IPC 插件失败: ${String(err?.message || err)}`)
    return { status: 'error', error: String(err?.message || err) }
  }
}
