#!/usr/bin/env node
/**
 * Prepares the Android Capacitor project for building All-in-One-Android.apk:
 *  1. Builds the latest Vite mobile PWA bundle (baking VITE_RELAY_URL if configured)
 *  2. Runs `cap sync android` so Capacitor Gradle bindings and bundled assets stay current
 *  3. Writes the runtime `android/app/src/main/assets/capacitor.config.json`:
 *     - By default omits `server.url` so the APK runs signed bundled local assets at `https://localhost`
 *     - Only enables remote HTTPS UI (`server.url = "<relayUrl>/"`) when explicitly opted in via `ANDROID_REMOTE_UI=1`
 *     Never mutates the tracked `packages/mobile-app/capacitor.config.json` template.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(MOBILE_ROOT, '../..')
const ANDROID_ASSETS_DIR = join(MOBILE_ROOT, 'android', 'app', 'src', 'main', 'assets')
const ANDROID_CAP_CONFIG = join(ANDROID_ASSETS_DIR, 'capacitor.config.json')
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
  execFileSync(process.execPath, [capBin, 'sync', 'android'], {
    cwd: MOBILE_ROOT,
    env,
    stdio: 'inherit',
  })
}

function main() {
  const relayUrl = resolveRelayUrl()
  const buildEnv = {
    ...process.env,
    ...(relayUrl ? { VITE_RELAY_URL: relayUrl } : {}),
  }

  // 1. Build latest web bundle (always baked as offline/local asset)
  runNpmCmd(['run', 'build'], MOBILE_ROOT, buildEnv)

  // 2. Sync Capacitor Android project (updates Gradle bindings & copies dist/ -> assets/public)
  runCapSync(buildEnv)

  // 3. Write clean runtime assets/capacitor.config.json (gitignored)
  // Default to signed bundled local assets; remote HTTPS UI requires explicit ANDROID_REMOTE_UI=1 opt-in.
  const useRemoteUrl =
    String(process.env.ANDROID_REMOTE_UI || '').trim() === '1' &&
    Boolean(relayUrl && /^https:\/\//i.test(relayUrl))
  const runtimeCapConfig = {
    appId: 'com.allinone.dshmobile',
    appName: 'All in One',
    webDir: 'dist',
    server: {
      ...(useRemoteUrl ? { url: `${relayUrl}/` } : {}),
      androidScheme: 'https',
      cleartext: false,
    },
    android: {
      allowMixedContent: false,
      adjustMarginsForEdgeToEdge: 'auto',
    },
    ios: {
      contentInset: 'automatic',
    },
  }

  mkdirSync(ANDROID_ASSETS_DIR, { recursive: true })
  writeFileSync(ANDROID_CAP_CONFIG, `${JSON.stringify(runtimeCapConfig, null, 2)}\n`, 'utf8')

  const pkg = JSON.parse(readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8'))
  console.log(
    `[prepare-android] Ready v${pkg.version}: mode=${useRemoteUrl ? `remote-hot-update (${relayUrl}/)` : 'bundled-local (https://localhost)'}`,
  )
}

main()
