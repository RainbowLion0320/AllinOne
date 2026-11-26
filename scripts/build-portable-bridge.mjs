/**
 * Bundles `packages/dsh-mobile-hub/portable-cli.js` (+ `ws`, `werift`, and `@allinone/shared`)
 * into a single self-contained zero-install Node.js file at
 * `packages/mobile-app/public/downloads/allinone-bridge.mjs`.
 *
 * Optionally reads `PUBLIC_RELAY_URL` / `ALLINONE_SERVER` from environment or local `.env.local`
 * (gitignored) so self-hosted builds bake their own default server URL without touching Git source.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')
const entryPoint = resolve(rootDir, 'packages/dsh-mobile-hub/portable-cli.js')
const dshIpcPluginEntry = resolve(rootDir, 'packages/dsh-mobile-hub/src/dsh-ipc-plugin-entry.js')
const outFile = resolve(rootDir, 'packages/mobile-app/public/downloads/allinone-bridge.mjs')

function readLocalEnvValue(key) {
  if (process.env[key]) return process.env[key]
  for (const name of ['.env.local', '.env']) {
    const p = resolve(rootDir, name)
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

const rootPkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'))
const appVersion = String(rootPkg.version || '0.0.0').trim()

const defaultServer = (
  readLocalEnvValue('PUBLIC_RELAY_URL') ||
  readLocalEnvValue('ALLINONE_SERVER') ||
  'http://127.0.0.1:8787'
).replace(/\/+$/, '')

mkdirSync(dirname(outFile), { recursive: true })

// First bundle the zero-dependency DeepSeek Harness local IPC Cordis plugin so the portable
// bridge / Desktop App can auto-install it into `~/.dsh/profiles/desktop` with zero external deps.
const dshPluginBuild = await esbuild.build({
  entryPoints: [dshIpcPluginEntry],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  external: ['node:*'],
})
const dshIpcPluginCode = dshPluginBuild.outputFiles?.[0]?.text || ''

await esbuild.build({
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  external: ['node:*', 'bufferutil', 'utf-8-validate'],
  define: {
    __ALLINONE_VERSION__: JSON.stringify(appVersion),
    __ALLINONE_DEFAULT_SERVER__: JSON.stringify(defaultServer),
    __ALLINONE_DSH_IPC_PLUGIN_CODE__: JSON.stringify(dshIpcPluginCode),
  },
  banner: {
    js: [
      'import { createRequire as __allinoneCreateRequire } from "node:module";',
      'const require = __allinoneCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})

const bytes = statSync(outFile).size
console.log(`[build:bridge] Built ${outFile} (${(bytes / 1024).toFixed(1)} KB, defaultServer=${defaultServer})`)
