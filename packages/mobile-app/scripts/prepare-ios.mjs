#!/usr/bin/env node
/**
 * Prepares the iOS Capacitor (Swift Package Manager) project for Xcode / App Store Connect builds:
 *  1. Builds the latest Vite mobile bundle with `CAPACITOR_BUILD=1` (baking VITE_RELAY_URL if configured)
 *  2. Runs `capacitor sync ios` (SPM auto-detected via CapApp-SPM/Package.swift, zero CocoaPods needed)
 *  3. Strips PC-only downloads, shell installers, OS metadata, source maps, and Web PWA Service Workers
 *  4. Writes a strictly bundled-local `ios/App/App/capacitor.config.json` (App Store Guideline 2.5.2 compliant:
 *     zero remote JS execution, zero OTA code download).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(MOBILE_ROOT, '../..')
const IOS_APP_DIR = join(MOBILE_ROOT, 'ios', 'App', 'App')
const IOS_CAP_CONFIG = join(IOS_APP_DIR, 'capacitor.config.json')
const PLACEHOLDER_HOST_RE = /^https?:\/\/your-relay\.example\.com(?:\/|$)/i

function readLocalEnvValue(key) {
  if (process.env[key]) return process.env[key]
  for (const name of ['.env.local', '.env']) {
    const p = join(REPO_ROOT, name)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (val) return val
    }
  }
  return ''
}

function resolveRelayUrl() {
  const raw = String(
    readLocalEnvValue('PUBLIC_RELAY_URL') ||
      readLocalEnvValue('VITE_RELAY_URL') ||
      readLocalEnvValue('ALLINONE_SERVER') ||
      '',
  )
    .trim()
    .replace(/\/+$/, '')
  if (!raw || PLACEHOLDER_HOST_RE.test(raw)) return ''
  return raw
}

function runNpmCmd(args, cwd, env) {
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], {
      cwd,
      env,
      stdio: 'inherit',
    })
  } else {
    execFileSync('npm', args, { cwd, env, stdio: 'inherit' })
  }
}

function runCapSync(env) {
  const capBin = join(REPO_ROOT, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')
  execFileSync(process.execPath, [capBin, 'sync', 'ios'], {
    cwd: MOBILE_ROOT,
    env,
    stdio: 'inherit',
  })
}

function main() {
  const relayUrl = resolveRelayUrl()
  const buildEnv = {
    ...process.env,
    CAPACITOR_BUILD: '1',
    ...(relayUrl ? { VITE_RELAY_URL: relayUrl } : {}),
  }

  // 1. Build latest web bundle without VitePWA Service Worker (strictly bundled local assets for App Store)
  runNpmCmd(['run', 'build'], MOBILE_ROOT, buildEnv)

  // 2. Sync Capacitor iOS SPM project (copies dist/ -> ios/App/App/public)
  runCapSync(buildEnv)

  // 2b. Strip PC-only downloads, shell installers, OS metadata, source maps & Web PWA Service Workers
  const iosPublicDir = join(IOS_APP_DIR, 'public')
  if (existsSync(iosPublicDir)) {
    for (const rel of [
      'downloads',
      'setup.sh',
      'setup.ps1',
      'sw.js',
      'registerSW.js',
      'manifest.webmanifest',
      '.DS_Store',
    ]) {
      const target = join(iosPublicDir, rel)
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true })
      }
    }
    const pruneDir = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.name === '.DS_Store' || /^workbox-.*\.js$/.test(entry.name) || entry.name.endsWith('.map')) {
          rmSync(full, { recursive: true, force: true })
          continue
        }
        if (entry.isDirectory()) {
          pruneDir(full)
        }
      }
    }
    pruneDir(iosPublicDir)
  }

  // 3. Write clean runtime ios/App/App/capacitor.config.json (gitignored)
  // Always strictly bundled local assets (never remote server.url on iOS — App Store Guideline 2.5.2).
  const runtimeCapConfig = {
    appId: 'com.allinone.dshmobile',
    appName: 'All in One',
    webDir: 'dist',
    server: {
      iosScheme: 'capacitor',
      cleartext: false,
    },
    ios: {
      contentInset: 'automatic',
      preferredContentMode: 'mobile',
      scrollEnabled: true,
    },
  }

  mkdirSync(IOS_APP_DIR, { recursive: true })
  writeFileSync(IOS_CAP_CONFIG, `${JSON.stringify(runtimeCapConfig, null, 2)}\n`, 'utf8')

  const pkg = JSON.parse(readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8'))
  console.log(`[prepare-ios] Ready v${pkg.version}: mode=bundled-local (capacitor://localhost, SPM)`)
}

main()
