#!/usr/bin/env node
/**
 * Server-side Admin CLI for managing single-use registration invite codes & accounts.
 *
 * Usage:
 *   node packages/relay-server/src/admin-cli.js invite create [--count 3] [--note "给朋友"] [--admin]
 *   node packages/relay-server/src/admin-cli.js invite list
 *   node packages/relay-server/src/admin-cli.js invite revoke <id-or-code>
 *   node packages/relay-server/src/admin-cli.js users
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountStore } from './accounts.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

loadDotEnv(resolve(__dirname, '../.env'))
loadDotEnv(resolve(__dirname, '../../../.env'))

const accountsFile = resolve(process.env.ACCOUNTS_FILE || resolve(__dirname, '../data/accounts.json'))
const store = createAccountStore({ filePath: accountsFile })
const publicUrl = String(process.env.PUBLIC_RELAY_URL || '').trim().replace(/\/+$/, '')

const args = process.argv.slice(2)
const cmd = args[0] || 'help'
const sub = args[1] || ''

function getFlag(name, fallback = '') {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return fallback
}

if (cmd === 'invite' && sub === 'create') {
  const count = Number(getFlag('--count', getFlag('-n', '1'))) || 1
  const note = getFlag('--note', '')
  const grantAdmin = args.includes('--admin')
  const created = store.createInvites({ count, note, createdBy: 'cli', grantAdmin })
  console.log(`\n✓ 已生成 ${created.length} 个一次性邀请码${grantAdmin ? '（含管理员权限）' : ''}：\n`)
  for (const inv of created) {
    const link = publicUrl ? `  ->  ${publicUrl}/?invite=${encodeURIComponent(inv.code)}` : ''
    console.log(`  ${inv.code}${inv.note ? `  (${inv.note})` : ''}${link}`)
  }
  console.log('\n提示：如果中转服务正在运行，通过 App 管理员后台生成无需重启；CLI 修改后请重启中转服务（例如 docker compose restart allinone-relay 或 systemctl restart allinone-relay）使运行中内存生效。\n')
  process.exit(0)
}

if (cmd === 'invite' && sub === 'list') {
  const list = store.listInvites()
  if (list.length === 0) {
    console.log('暂无邀请码记录。')
    process.exit(0)
  }
  for (const inv of list) {
    const usedInfo = inv.status === 'used' ? ` -> @${inv.usedByUsername}` : ''
    const note = inv.note ? ` [${inv.note}]` : ''
    const adminTag = inv.grantAdmin ? ' (ADMIN)' : ''
    console.log(`${inv.code}  ${inv.status.padEnd(7)}  ${inv.id}${adminTag}${note}${usedInfo}`)
  }
  process.exit(0)
}

if (cmd === 'invite' && sub === 'revoke') {
  const target = args[2] || ''
  const res = store.revokeInvite(target)
  if (!res) {
    console.error('找不到指定邀请码。')
    process.exit(1)
  }
  if (!res.ok) {
    console.error(res.error)
    process.exit(1)
  }
  console.log(`✓ 已作废邀请码 ${res.invite.code}`)
  process.exit(0)
}

if (cmd === 'users') {
  const users = store.listUsers()
  if (users.length === 0) {
    console.log('暂无已注册用户。')
    process.exit(0)
  }
  for (const u of users) {
    const emailPart = u.email ? `  email=${u.email}` : ''
    console.log(`${u.userId}  @${u.username.padEnd(18)}  role=${u.role.padEnd(5)}  devices=${u.deviceCount}${emailPart}`)
  }
  process.exit(0)
}

console.log(`All in One Account & Invite Admin CLI

用法:
  node packages/relay-server/src/admin-cli.js invite create [--count 3] [--note "给朋友"] [--admin]
  node packages/relay-server/src/admin-cli.js invite list
  node packages/relay-server/src/admin-cli.js invite revoke <id-or-code>
  node packages/relay-server/src/admin-cli.js users
`)
