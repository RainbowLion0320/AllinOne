#!/usr/bin/env node
/**
 * Keeps `packages/desktop-app/release/` clean with ONLY the latest final installer(s).
 *
 * Usage:
 *   node scripts/clean-release.mjs --all    # Wipe entire release/ before a new build (removes old versions)
 *   node scripts/clean-release.mjs --prune  # Keep only final .exe/.dmg/.AppImage installers; remove unpacked/temp files
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RELEASE_DIR = join(resolve(__dirname, '..'), 'release')

const KEEP_INSTALLER_RE = /\.(exe|dmg|AppImage)$/i
const args = new Set(process.argv.slice(2))

if (!existsSync(RELEASE_DIR)) {
  process.exit(0)
}

if (args.has('--all')) {
  for (const name of readdirSync(RELEASE_DIR)) {
    rmSync(join(RELEASE_DIR, name), { recursive: true, force: true })
  }
  console.log('[desktop:clean] Cleared old release/ directory')
  process.exit(0)
}

if (args.has('--prune')) {
  let removed = 0
  for (const name of readdirSync(RELEASE_DIR)) {
    if (KEEP_INSTALLER_RE.test(name) && !name.includes('__uninstaller')) continue
    rmSync(join(RELEASE_DIR, name), { recursive: true, force: true })
    removed += 1
  }
  console.log(`[desktop:clean] Pruned ${removed} intermediate item(s); release/ now contains only final installers`)
}
