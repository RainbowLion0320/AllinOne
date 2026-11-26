#!/usr/bin/env node
/**
 * Single-source-of-truth version manager & drift checker for the All in One monorepo.
 *
 * Usage:
 *   node scripts/bump-version.mjs --check          Verify all workspace package.json versions match & zero hardcoded literals
 *   node scripts/bump-version.mjs <x.y.z>          Bump root, all workspace package.json files, and package-lock.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, parseSemver } from '../packages/shared/src/semver.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const PACKAGE_PATHS = [
  'package.json',
  'packages/shared/package.json',
  'packages/relay-server/package.json',
  'packages/dsh-mobile-hub/package.json',
  'packages/mobile-app/package.json',
  'packages/desktop-app/package.json',
]

const SOURCE_SCAN_DIRS = [
  'packages/shared/src',
  'packages/relay-server/src',
  'packages/dsh-mobile-hub/src',
  'packages/mobile-app/src',
  'packages/desktop-app/src',
]

const EXTRA_SCAN_FILES = [
  'packages/dsh-mobile-hub/portable-cli.js',
  'packages/mobile-app/vite.config.js',
]

function walkJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      if (dirent.name === 'node_modules' || dirent.name === 'dist' || dirent.name === 'release') continue
      walkJsFiles(full, out)
    } else if (dirent.isFile() && /\.(?:m?js|cjs|jsx)$/.test(dirent.name)) {
      out.push(full)
    }
  }
  return out
}

function checkVersions() {
  const versions = new Map()
  const errors = []

  for (const rel of PACKAGE_PATHS) {
    const full = join(REPO_ROOT, rel)
    if (!existsSync(full)) {
      errors.push(`Missing package manifest: ${rel}`)
      continue
    }
    const pkg = JSON.parse(readFileSync(full, 'utf8'))
    const ver = String(pkg.version || '').trim()
    if (!parseSemver(ver)) {
      errors.push(`Invalid SemVer in ${rel}: "${ver}"`)
      continue
    }
    versions.set(rel, ver)
  }

  const rootVer = versions.get('package.json') || ''
  for (const [rel, ver] of versions.entries()) {
    if (ver !== rootVer) {
      errors.push(`Version drift: ${rel} has "${ver}" but root package.json has "${rootVer}"`)
    }
  }

  // Check release-meta.json androidMinNativeVersion validity
  const metaPath = join(REPO_ROOT, 'release-meta.json')
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      const minVer = String(meta?.androidMinNativeVersion || '').trim()
      if (!parseSemver(minVer)) {
        errors.push(`Invalid androidMinNativeVersion in release-meta.json: "${minVer}"`)
      } else if (rootVer && compareSemver(minVer, rootVer) > 0) {
        errors.push(`release-meta.json androidMinNativeVersion (${minVer}) > current version (${rootVer})`)
      }
    } catch (err) {
      errors.push(`Invalid JSON in release-meta.json: ${err?.message || err}`)
    }
  } else {
    errors.push('Missing release-meta.json')
  }

  // Scan source files for hardcoded app version fallback literals like `|| '1.0.29'`
  const filesToScan = [...EXTRA_SCAN_FILES.map((f) => join(REPO_ROOT, f)).filter(existsSync)]
  for (const d of SOURCE_SCAN_DIRS) {
    walkJsFiles(join(REPO_ROOT, d), filesToScan)
  }

  const HARDCODED_VERSION_RE =
    /(?:__APP_VERSION__|__ALLINONE_VERSION__|initInfo\.version|pkg\.version|bridgeVersion|appVersion)[^\n]{0,80}(?:\|\||\?\?)\s*['"](\d+\.\d+\.\d+)['"]/g

  for (const filePath of filesToScan) {
    const src = readFileSync(filePath, 'utf8')
    for (const match of src.matchAll(HARDCODED_VERSION_RE)) {
      const literal = match[1]
      if (literal === '0.0.0') continue
      const lineNum = src.slice(0, match.index).split('\n').length
      errors.push(
        `Hardcoded version literal "${literal}" in ${relative(REPO_ROOT, filePath)}:${lineNum} (must read dynamically from package.json / build define)`,
      )
    }
  }

  if (errors.length > 0) {
    console.error('[version:check] FAILED:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  console.log(`[version:check] OK — all ${versions.size} workspace manifests aligned at v${rootVer} (0 hardcoded version literals)`)
}

function bumpVersion(nextRaw) {
  const nextVer = String(nextRaw || '').trim().replace(/^v/i, '')
  if (!parseSemver(nextVer)) {
    console.error(`Invalid SemVer target version: "${nextRaw}"`)
    process.exit(1)
  }

  for (const rel of PACKAGE_PATHS) {
    const full = join(REPO_ROOT, rel)
    const pkg = JSON.parse(readFileSync(full, 'utf8'))
    pkg.version = nextVer
    writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }

  const lockPath = join(REPO_ROOT, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.version = nextVer
    if (lock.packages && typeof lock.packages === 'object') {
      if (lock.packages['']) lock.packages[''].version = nextVer
      for (const rel of PACKAGE_PATHS) {
        if (rel === 'package.json') continue
        const wsKey = rel.replace(/\/package\.json$/, '')
        if (lock.packages[wsKey]) {
          lock.packages[wsKey].version = nextVer
        }
      }
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  }

  console.log(`[bump-version] Updated all ${PACKAGE_PATHS.length} package manifests + package-lock.json to v${nextVer}`)
}

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  console.log('Usage:\n  node scripts/bump-version.mjs --check\n  node scripts/bump-version.mjs <x.y.z>')
  process.exit(arg ? 0 : 1)
}
if (arg === '--check') {
  checkVersions()
} else {
  bumpVersion(arg)
  checkVersions()
}
