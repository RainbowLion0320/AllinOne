#!/usr/bin/env node
/**
 * All in One — End-to-End Integration & Security Smoke Test Runner.
 *
 * Runs all modular `node:test` suites in `tests/integration/*.test.mjs`.
 *
 * Usage:
 *   node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --filter="Suite 10"
 *   node scripts/smoke-test.mjs --filter=WebRTC
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const INTEGRATION_DIR = join(REPO_ROOT, 'tests', 'integration')

const testFiles = readdirSync(INTEGRATION_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(INTEGRATION_DIR, name))

if (testFiles.length === 0) {
  console.error(`[smoke] No integration test files found in ${INTEGRATION_DIR}`)
  process.exit(1)
}

const nodeArgs = ['--test']
const cliArgs = process.argv.slice(2)
for (let i = 0; i < cliArgs.length; i += 1) {
  const arg = cliArgs[i]
  if (arg.startsWith('--filter=')) {
    const pattern = arg.slice('--filter='.length).trim()
    if (pattern) nodeArgs.push(`--test-name-pattern=${pattern}`)
  } else if (arg === '--filter' && cliArgs[i + 1]) {
    const pattern = String(cliArgs[++i]).trim()
    if (pattern) nodeArgs.push(`--test-name-pattern=${pattern}`)
  } else {
    nodeArgs.push(arg)
  }
}

const child = spawn(process.execPath, [...nodeArgs, ...testFiles], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
