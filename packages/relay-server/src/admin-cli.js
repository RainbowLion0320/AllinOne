#!/usr/bin/env node
/**
 * Server-side Admin CLI for inspecting registered users, daily registration quota & user tiers.
 *
 * Usage:
 *   node packages/relay-server/src/admin-cli.js users
 *   node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountStore, normalizeMaxDailyRegistrations } from './accounts.js'

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

const args = process.argv.slice(2)
const cmd = args[0] || 'help'
const sub = args[1] || ''

const TIER_LABELS = {
  free: 'Free (1 GB/月 · P2P 无限)',
  pro: 'Pro (10 GB/月 · P2P 无限)',
  ultra: 'Ultra (50 GB/月 · P2P 无限)',
  admin: 'Admin (50 GB/月 · 管理员)',
}

if (cmd === 'users') {
  const maxDaily = normalizeMaxDailyRegistrations(process.env.MAX_DAILY_REGISTRATIONS, 20)
  const daily = store.getDailyRegistrationStats(maxDaily)
  const limitLabel = daily.limit > 0 ? String(daily.limit) : '不限'
  console.log(`今日注册: ${daily.used} / ${limitLabel} (${daily.date})`)
  const users = store.listUsers()
  if (users.length === 0) {
    console.log('暂无已注册用户。')
    process.exit(0)
  }
  for (const u of users) {
    const emailPart = u.email ? `  email=${u.email}` : ''
    console.log(`${u.userId}  @${u.username.padEnd(18)}  tier=${(u.tier || 'free').padEnd(5)}  role=${u.role.padEnd(5)}  devices=${u.deviceCount}${emailPart}`)
  }
  process.exit(0)
}

if (cmd === 'user' && sub === 'tier') {
  const target = args[2] || ''
  const nextTier = String(args[3] || '').trim().toLowerCase()
  if (!target || !nextTier) {
    console.error('用法: node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>')
    process.exit(1)
  }
  const found = store.findUserByIdentifier(target)
  if (!found) {
    console.error(`找不到用户: ${target}`)
    process.exit(1)
  }
  const res = store.setUserTier(found.userId, nextTier)
  if (!res.ok) {
    console.error(res.error)
    process.exit(1)
  }
  console.log(`✓ 已将 @${res.user.username} (${res.user.userId}) 等级从 ${res.prevTier} 调整为 ${res.tier} [${TIER_LABELS[res.tier] || res.tier}]`)
  console.log('提示：如通过管理员监控后台 (/admin) 调整可即时生效；使用离线 CLI 调整前请先停止中转服务（避免在线进程退出时 accounts.flush() 覆写磁盘变更），调整后再启动服务。')
  process.exit(0)
}

console.log(`All in One Account Admin CLI

用法:
  node packages/relay-server/src/admin-cli.js users
  node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>
`)
