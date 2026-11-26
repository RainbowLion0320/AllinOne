#!/usr/bin/env node
/**
 * Server-side Admin CLI for inspecting registered users, daily registration quota & user tiers.
 * Safely operates on the live SQLite WAL database (`PRAGMA busy_timeout=5000`); the running
 * relay server detects external changes automatically via `PRAGMA data_version`.
 *
 * Usage:
 *   node packages/relay-server/src/admin-cli.js users
 *   node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountStore, normalizeMaxDailyRegistrations } from './accounts.js'
import { loadDotEnv } from './http-utils.js'
import { resolveTurnQuotaConfig } from './turn-meter.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

loadDotEnv(resolve(__dirname, '../.env'))
loadDotEnv(resolve(__dirname, '../../../.env'))

const accountsFile = resolve(process.env.ACCOUNTS_FILE || resolve(__dirname, '../data/accounts.json'))
const store = createAccountStore({ filePath: accountsFile })
const quotaCfg = resolveTurnQuotaConfig({}, process.env)

const formatQuota = (mb) => (mb <= 0 ? '不限' : mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB/月` : `${mb} MB/月`)

const TIER_LABELS = {
  free: `Free (${formatQuota(quotaCfg.freeMb)} · P2P 无限)`,
  pro: `Pro (${formatQuota(quotaCfg.proMb)} · P2P 无限)`,
  ultra: `Ultra (${formatQuota(quotaCfg.ultraMb)} · P2P 无限)`,
  admin: `Admin (${formatQuota(quotaCfg.adminMb)} · 管理员)`,
}

const args = process.argv.slice(2)
const cmd = args[0] || 'help'
const sub = args[1] || ''

try {
  if (cmd === 'users') {
    const maxDaily = normalizeMaxDailyRegistrations(process.env.MAX_DAILY_REGISTRATIONS, 20)
    const daily = store.getDailyRegistrationStats(maxDaily)
    const limitLabel = daily.limit > 0 ? String(daily.limit) : '不限'
    console.log(`数据库: ${store.dbPath} (SQLite WAL)`)
    console.log(`今日注册: ${daily.used} / ${limitLabel} (${daily.date} UTC)`)
    const users = store.listUsers()
    if (users.length === 0) {
      console.log('暂无已注册用户。')
      process.exitCode = 0
    } else {
      for (const u of users) {
        const emailPart = u.email ? `  email=${u.email}` : ''
        console.log(`${u.userId}  @${u.username.padEnd(18)}  tier=${(u.tier || 'free').padEnd(5)}  role=${u.role.padEnd(5)}  devices=${u.deviceCount}${emailPart}`)
      }
      process.exitCode = 0
    }
  } else if (cmd === 'user' && sub === 'tier') {
    const target = args[2] || ''
    const nextTier = String(args[3] || '').trim().toLowerCase()
    if (!target || !nextTier) {
      console.error('用法: node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>')
      process.exitCode = 1
    } else {
      const found = store.findUserByIdentifier(target)
      if (!found) {
        console.error(`找不到用户: ${target}`)
        process.exitCode = 1
      } else {
        const res = store.setUserTier(found.userId, nextTier)
        if (!res.ok) {
          console.error(res.error)
          process.exitCode = 1
        } else {
          console.log(`✓ 已将 @${res.user.username} (${res.user.userId}) 等级从 ${res.prevTier} 调整为 ${res.tier} [${TIER_LABELS[res.tier] || res.tier}]`)
          console.log('✓ SQLite WAL 事务已提交，在线中转服务将在下次请求自动生效（无需重启）。')
          process.exitCode = 0
        }
      }
    }
  } else {
    console.log(`All in One Account Admin CLI

用法:
  node packages/relay-server/src/admin-cli.js users
  node packages/relay-server/src/admin-cli.js user tier <username-or-id> <free|pro|ultra|admin>
`)
  }
} finally {
  store.close()
}
