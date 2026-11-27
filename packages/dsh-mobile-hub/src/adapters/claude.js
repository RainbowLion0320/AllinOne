import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { APPS, EVENTS, assertPathWithinDir, assertSafeCliToken, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { parseDshConfiguredModels } from '../helpers/dsh-models.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, getClaudeCandidates, killProcessTree, spawnCrossPlatform } from '../helpers/bin-finder.js'
import { createTaskStateTracker, normalizeTaskMode } from '../helpers/task-state.js'
import { BaseAdapter } from './base-adapter.js'
import {
  isPidAlive,
  readHeadAndBodyLinesForParse,
  readHeadAndTailLines,
  readTailLinesWithMeta,
} from '../primitives/io-utils.js'
import { QuotaCacheManager } from '../primitives/quota-cache.js'
import { SessionExternalWatcher } from '../primitives/session-watcher.js'
import { StreamJsonCliRunner } from '../primitives/stream-json-runner.js'

const CLAUDE_EXTERNAL_MAX_IDLE_MS = 15 * 60_000
const CLAUDE_WATCH_POLL_MS = 2_000
const CLAUDE_WATCH_TTL_MS = 10 * 60_000
const CLAUDE_LIST_WATCH_TTL_MS = 10 * 60_000
const CLAUDE_LIST_DISCOVERY_INTERVAL_MS = 30_000
const CLAUDE_TRACKED_LIST_LIMIT = 20
const CLAUDE_TAIL_PROBE_BYTES = 64 * 1024
const CLAUDE_TAIL_PROBE_MAX_BYTES = 512 * 1024

const ALLOWED_CLAUDE_PERMISSION_MODES = Object.freeze([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
])

const CLAUDE_PERMISSION_MODE_RANK = Object.freeze({
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  bypassPermissions: 4,
})

function resolveEffectiveClaudePermissionMode(requestedMode, hostConfiguredMode, effectiveTaskMode) {
  const hostMode = ALLOWED_CLAUDE_PERMISSION_MODES.includes(hostConfiguredMode)
    ? hostConfiguredMode
    : 'acceptEdits'
  const rawReq = String(requestedMode ?? '').trim()
  if (!rawReq) {
    if (effectiveTaskMode === 'plan') return 'plan'
    return hostMode
  }
  if (!ALLOWED_CLAUDE_PERMISSION_MODES.includes(rawReq)) {
    throw new Error('非法的 permissionMode 参数值')
  }
  const reqRank = CLAUDE_PERMISSION_MODE_RANK[rawReq]
  const hostRank = CLAUDE_PERMISSION_MODE_RANK[hostMode]
  if (reqRank > hostRank) {
    throw new Error(`出于安全限制，不允许远程将 Claude 权限模式从 ${hostMode} 提升至 ${rawReq}`)
  }
  return rawReq
}

function getClaudeHome(configuredHome = '') {
  const custom = String(configuredHome || '').trim()
  return custom || join(homedir(), '.claude')
}

/**
 * Discover existing Claude Desktop user-data roots across Windows (standard, Claude-3p,
 * Microsoft Store MSIX packages), macOS, and Linux.
 */
export function getClaudeDesktopRoots({
  configuredRoots = null,
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const candidates = []
  if (Array.isArray(configuredRoots)) {
    for (const r of configuredRoots) {
      if (typeof r === 'string' && r.trim()) candidates.push(r.trim())
    }
  } else {
    const envCustom = String(env.ALLINONE_CLAUDE_DESKTOP_DIRS || '').trim()
    if (envCustom) {
      for (const part of envCustom.split(platform === 'win32' ? ';' : ':')) {
        if (part.trim()) candidates.push(part.trim())
      }
    }
    if (platform === 'win32') {
      const localApp = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
      candidates.push(
        join(localApp, 'Claude-3p'),
        join(appData, 'Claude'),
        join(localApp, 'Claude'),
        join(appData, 'Claude-3p'),
        join(localApp, 'Claude-Data'),
      )
      const packagesDir = join(localApp, 'Packages')
      if (existsSync(packagesDir)) {
        try {
          for (const pkgName of readdirSync(packagesDir)) {
            if (!/^(Claude_|AnthropicPBC\.Claude_)/i.test(pkgName)) continue
            const localCache = join(packagesDir, pkgName, 'LocalCache')
            candidates.push(
              join(localCache, 'Roaming', 'Claude'),
              join(localCache, 'Local', 'Claude'),
              join(localCache, 'Roaming', 'Claude-3p'),
              join(localCache, 'Local', 'Claude-3p'),
            )
          }
        } catch {}
      }
    } else if (platform === 'darwin') {
      candidates.push(
        join(home, 'Library', 'Application Support', 'Claude'),
        join(home, 'Library', 'Application Support', 'Claude-3p'),
      )
    } else {
      const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
      candidates.push(join(xdg, 'Claude'), join(xdg, 'Claude-3p'))
    }
  }

  const seen = new Set()
  const out = []
  for (const dir of candidates) {
    if (!dir) continue
    let resolved
    try {
      resolved = resolve(dir)
    } catch {
      continue
    }
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(resolved)) out.push(resolved)
  }
  return out
}

/**
 * Zero-OOM tail probe for Claude Desktop `audit.jsonl` or Claude Code CLI `.jsonl`.
 * Detects externally active turns, active tool name, and pending desktop permission prompts.
 */
export function probeClaudeTranscriptTail(filePath, { now = Date.now(), maxIdleMs = CLAUDE_EXTERNAL_MAX_IDLE_MS } = {}) {
  const empty = {
    exists: false,
    size: 0,
    mtimeMs: 0,
    running: false,
    waitingPermission: false,
    permissionTool: '',
    lastToolName: '',
    lastTextPreview: '',
  }
  if (!filePath) return empty

  let tail = readTailLinesWithMeta(filePath, CLAUDE_TAIL_PROBE_BYTES)
  if (!tail.exists) return empty

  const parseTail = (lines) => {
    let signal = 'unknown' // 'active' | 'idle' | 'unknown'
    let seenSignal = false
    const pendingPerm = new Map() // uuid -> toolName
    let lastToolName = ''
    let lastTextPreview = ''

    for (const line of lines) {
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const type = String(obj.type || '')
      const subtype = String(obj.subtype || '')

      if (type === 'result') {
        signal = 'idle'
        seenSignal = true
        pendingPerm.clear()
        continue
      }

      if (type === 'command_lifecycle') {
        const state = String(obj.state || '').toLowerCase()
        if (state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'aborted' || state === 'error') {
          signal = 'idle'
          seenSignal = true
          pendingPerm.clear()
        } else if (state === 'queued' || state === 'started' || state === 'running') {
          signal = 'active'
          seenSignal = true
        }
        continue
      }

      if (type === 'system') {
        if (subtype === 'status') {
          const stVal = String(obj.status || '').toLowerCase()
          if (stVal === 'idle' || stVal === 'completed' || stVal === 'done') {
            signal = 'idle'
            seenSignal = true
          } else if (stVal) {
            signal = 'active'
            seenSignal = true
          }
        } else if (subtype === 'permission_request') {
          const uid = String(obj.uuid || obj.request_id || '')
          const tName = String(obj.tool_name || obj.toolName || 'tool')
          if (uid) pendingPerm.set(uid, tName)
          lastToolName = tName
          signal = 'active'
          seenSignal = true
        } else if (subtype === 'permission_response') {
          const uid = String(obj.uuid || obj.request_id || '')
          if (uid) pendingPerm.delete(uid)
          else pendingPerm.clear()
          signal = 'active'
          seenSignal = true
        } else if (subtype === 'init') {
          signal = 'active'
          seenSignal = true
        }
        continue
      }

      if (type === 'tool_progress') {
        if (obj.tool_name) lastToolName = String(obj.tool_name)
        signal = 'active'
        seenSignal = true
        continue
      }

      if (type === 'assistant') {
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
        let hasToolUse = false
        for (const b of blocks) {
          if (b?.type === 'tool_use') {
            hasToolUse = true
            if (b.name) lastToolName = String(b.name)
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            lastTextPreview = b.text.trim()
          }
        }
        if (hasToolUse) {
          signal = 'active'
          seenSignal = true
        } else if (obj.message?.stop_reason === 'end_turn') {
          signal = 'idle'
          seenSignal = true
        }
        continue
      }

      if (type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
          // Tool result just fed back to model -> model is about to respond
          signal = 'active'
          seenSignal = true
        } else {
          const txt = extractTextFromContent(content).trim()
          if (txt) {
            signal = 'active'
            seenSignal = true
          }
        }
      }
    }

    const permEntries = [...pendingPerm.values()]
    return {
      signal,
      seenSignal,
      waitingPermission: permEntries.length > 0,
      permissionTool: permEntries.length > 0 ? permEntries[permEntries.length - 1] : '',
      lastToolName,
      lastTextPreview,
    }
  }

  let parsed = parseTail(tail.lines)
  if (!parsed.seenSignal && tail.size > CLAUDE_TAIL_PROBE_BYTES) {
    const bigger = readTailLinesWithMeta(filePath, CLAUDE_TAIL_PROBE_MAX_BYTES)
    if (bigger.exists) {
      tail = bigger
      parsed = parseTail(bigger.lines)
    }
  }

  const fresh = now - tail.mtimeMs <= maxIdleMs
  const running = parsed.signal === 'active' && fresh
  return {
    exists: true,
    size: tail.size,
    mtimeMs: tail.mtimeMs,
    running,
    waitingPermission: running && parsed.waitingPermission,
    permissionTool: running && parsed.waitingPermission ? parsed.permissionTool : '',
    lastToolName: parsed.lastToolName,
    lastTextPreview: parsed.lastTextPreview,
  }
}

/**
 * Inspect `<claudeConfigDir>/sessions/<pid>.json` files written by live Claude Desktop
 * or Claude Code CLI processes and verify OS process liveness.
 */
function probePidSessionsDir(sessionsDir, { targetSessionId = '', checkPidAlive = isPidAlive } = {}) {
  if (!sessionsDir || !existsSync(sessionsDir)) return null
  let best = null
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue
      let data
      try {
        data = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
      } catch {
        continue
      }
      if (!data || typeof data !== 'object') continue
      const sid = String(data.sessionId || '').trim()
      if (targetSessionId && sid && sid !== targetSessionId) continue
      const pid = Number(data.pid || 0)
      if (!checkPidAlive(pid)) continue
      const status = String(data.status || '').toLowerCase()
      const busy = status === 'busy' || status === 'running' || status === 'thinking'
      const updatedAt = toEpochMs(data.statusUpdatedAt || data.updatedAt || data.startedAt || 0)
      if (!best || (busy && !best.busy) || (busy === best.busy && updatedAt > best.updatedAt)) {
        best = { alive: true, busy, status, pid, sessionId: sid, updatedAt }
      }
    }
  } catch {}
  return best
}

/**
 * Combine authoritative live PID status with zero-OOM transcript tail probing.
 */
export function probeClaudeExternalStatus({
  pidSessionsDir = '',
  targetCliSessionId = '',
  auditPath = '',
  transcriptPath = '',
  now = Date.now(),
  maxIdleMs = CLAUDE_EXTERNAL_MAX_IDLE_MS,
  checkPidAlive = isPidAlive,
} = {}) {
  const pidInfo = probePidSessionsDir(pidSessionsDir, {
    targetSessionId: targetCliSessionId,
    checkPidAlive,
  })
  const probeFile = auditPath && existsSync(auditPath) ? auditPath : transcriptPath
  const tail = probeFile ? probeClaudeTranscriptTail(probeFile, { now, maxIdleMs }) : null

  let running = false
  if (pidInfo?.alive) {
    if (pidInfo.busy) {
      running = true
    } else if (tail?.running && tail.mtimeMs > (pidInfo.updatedAt || 0) + 1_000) {
      running = true
    }
  } else if (tail?.running) {
    running = true
  }

  return {
    running,
    pidAlive: Boolean(pidInfo?.alive),
    pidStatus: pidInfo?.status || '',
    pid: pidInfo?.pid || 0,
    waitingPermission: Boolean(running && tail?.waitingPermission),
    permissionTool: running && tail?.waitingPermission ? tail.permissionTool : '',
    lastToolName: tail?.lastToolName || '',
    lastTextPreview: tail?.lastTextPreview || '',
    size: tail?.size || 0,
    mtimeMs: Math.max(tail?.mtimeMs || 0, pidInfo?.updatedAt || 0),
  }
}

function readSpacesMap(accountDir) {
  const map = new Map()
  const spacesPath = join(accountDir, 'spaces.json')
  if (!existsSync(spacesPath)) return map
  try {
    const parsed = JSON.parse(readFileSync(spacesPath, 'utf8'))
    const spaces = Array.isArray(parsed?.spaces) ? parsed.spaces : Array.isArray(parsed) ? parsed : []
    for (const sp of spaces) {
      if (!sp?.id) continue
      const folders = Array.isArray(sp.folders)
        ? sp.folders.map((f) => (typeof f === 'string' ? f : f?.path)).filter((p) => typeof p === 'string' && p.trim())
        : []
      map.set(String(sp.id), {
        name: String(sp.name || '').trim(),
        folders,
      })
    }
  } catch {}
  return map
}

function findDesktopProjectJsonl(sessDir, cliSessionId) {
  if (!sessDir) return ''
  const projRoot = join(sessDir, '.claude', 'projects')
  if (!existsSync(projRoot)) return ''
  try {
    const subdirs = readdirSync(projRoot)
    if (cliSessionId) {
      for (const sub of subdirs) {
        const subDir = join(projRoot, sub)
        let st
        try { st = statSync(subDir) } catch { continue }
        if (!st.isDirectory()) continue
        const exact = join(subDir, `${cliSessionId}.jsonl`)
        if (existsSync(exact)) {
          return assertPathWithinDir(exact, projRoot, 'Claude Desktop session transcript')
        }
      }
    }
    // Fallback: newest non-agent jsonl inside session's own isolated projects dir
    let newest = ''
    let newestMtime = 0
    for (const sub of subdirs) {
      const subDir = join(projRoot, sub)
      let st
      try { st = statSync(subDir) } catch { continue }
      if (!st.isDirectory()) continue
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
        const cand = join(subDir, f)
        try {
          const fst = statSync(cand)
          if (fst.mtimeMs >= newestMtime) {
            newestMtime = fst.mtimeMs
            newest = assertPathWithinDir(cand, projRoot, 'Claude Desktop session transcript')
          }
        } catch {}
      }
    }
    return newest
  } catch {
    return ''
  }
}

/**
 * Scan Claude Desktop `local-agent-mode-sessions` (Cowork) and `claude-code-sessions` (Desktop Code)
 * across all discovered desktop data roots.
 */
export function scanClaudeDesktopSessions(desktopRoots = [], { findCliSessionFile = null } = {}) {
  const entries = []
  const seenKeys = new Set()
  const workspaces = []
  const seenWs = new Set()

  const cleanWorkspaceName = (rawName, fallbackPath = '') => {
    const n = String(rawName || '').trim()
    if (n && !/[\\/]/.test(n)) return n
    if (fallbackPath) return basename(fallbackPath) || fallbackPath
    return n ? basename(n) || n : ''
  }

  const addWorkspace = (dirPath, nameHint = '', source = 'claude-desktop') => {
    const clean = String(dirPath || '').trim()
    if (!clean || !existsSync(clean)) return
    const k = clean.toLowerCase()
    if (seenWs.has(k)) return
    seenWs.add(k)
    workspaces.push({
      name: cleanWorkspaceName(nameHint, clean),
      path: clean,
      source,
    })
  }

  const stores = [
    { dirName: 'local-agent-mode-sessions', source: 'claude-desktop-cowork', defaultWritable: false },
    { dirName: 'claude-code-sessions', source: 'claude-desktop-code', defaultWritable: true },
  ]

  for (const root of desktopRoots) {
    for (const store of stores) {
      const storeDir = join(root, store.dirName)
      if (!existsSync(storeDir)) continue
      let orgDirs
      try { orgDirs = readdirSync(storeDir) } catch { continue }
      for (const org of orgDirs) {
        const orgDir = join(storeDir, org)
        let orgSt
        try { orgSt = statSync(orgDir) } catch { continue }
        if (!orgSt.isDirectory()) continue
        let acctDirs
        try { acctDirs = readdirSync(orgDir) } catch { continue }
        for (const acct of acctDirs) {
          const accountDir = join(orgDir, acct)
          let acctSt
          try { acctSt = statSync(accountDir) } catch { continue }
          if (!acctSt.isDirectory()) continue

          const spacesMap = readSpacesMap(accountDir)
          for (const sp of spacesMap.values()) {
            for (const f of sp.folders) addWorkspace(f, sp.name, 'claude-desktop')
          }

          let files
          try { files = readdirSync(accountDir) } catch { continue }
          for (const fname of files) {
            if (!fname.startsWith('local_') || !fname.endsWith('.json')) continue
            const metaPath = join(accountDir, fname)
            let meta
            try {
              meta = JSON.parse(readFileSync(metaPath, 'utf8'))
            } catch {
              continue
            }
            if (!meta || typeof meta !== 'object') continue
            if (meta.isArchived === true) continue

            const desktopSessionId = String(meta.sessionId || basename(fname, '.json')).trim()
            if (!desktopSessionId) continue
            try {
              assertSafeSessionId(desktopSessionId, 'Claude Desktop sessionId')
            } catch {
              continue
            }

            const cliSessionId = String(meta.cliSessionId || '').trim()
            const uuidPart = desktopSessionId.startsWith('local_')
              ? desktopSessionId.slice('local_'.length)
              : desktopSessionId

            const candidateDirs = [
              join(accountDir, uuidPart.slice(0, 8)),
              join(accountDir, desktopSessionId),
              join(accountDir, uuidPart),
            ]
            let sessDir = ''
            for (const cand of candidateDirs) {
              if (existsSync(cand)) {
                try {
                  if (statSync(cand).isDirectory()) {
                    sessDir = assertPathWithinDir(cand, accountDir, 'Claude Desktop session dir')
                    break
                  }
                } catch {}
              }
            }

            const auditPath = sessDir && existsSync(join(sessDir, 'audit.jsonl'))
              ? join(sessDir, 'audit.jsonl')
              : ''
            let projJsonlPath = findDesktopProjectJsonl(sessDir, cliSessionId)
            let linkedCliFile = ''
            if (store.source === 'claude-desktop-code' && cliSessionId && typeof findCliSessionFile === 'function') {
              try {
                linkedCliFile = findCliSessionFile(cliSessionId) || ''
              } catch {}
            }
            if (!projJsonlPath && linkedCliFile) {
              projJsonlPath = linkedCliFile
            }
            if (!projJsonlPath && !auditPath) continue

            const pidSessionsDir = sessDir ? join(sessDir, '.claude', 'sessions') : ''
            const selectedFolders = Array.isArray(meta.userSelectedFolders)
              ? meta.userSelectedFolders.filter((p) => typeof p === 'string' && p.trim())
              : []
            const spaceInfo = meta.spaceId ? spacesMap.get(String(meta.spaceId)) : null
            const rawMetaCwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : ''
            const isInternalOutputsCwd = /local-agent-mode-sessions[\\/].*[\\/](outputs|host-cwd)$/i.test(rawMetaCwd)
            const cwd =
              selectedFolders[0] ||
              spaceInfo?.folders?.[0] ||
              (!isInternalOutputsCwd ? rawMetaCwd : '') ||
              ''
            for (const f of selectedFolders) {
              const mountName = meta.folderMountNames?.[f] || ''
              addWorkspace(f, mountName, 'claude-desktop')
            }

            const workspace =
              cleanWorkspaceName((cwd && meta.folderMountNames?.[cwd]) || spaceInfo?.name, cwd) ||
              'Claude Desktop'

            const initialMsg = String(meta.initialMessage || '').replace(/\s+/g, ' ').trim()
            const title =
              String(meta.title || '').trim() ||
              initialMsg.slice(0, 56) ||
              desktopSessionId

            let metaMtimeMs = 0
            try { metaMtimeMs = statSync(metaPath).mtimeMs } catch {}
            let projMtimeMs = 0
            try { if (projJsonlPath) projMtimeMs = statSync(projJsonlPath).mtimeMs } catch {}
            let auditMtimeMs = 0
            try { if (auditPath) auditMtimeMs = statSync(auditPath).mtimeMs } catch {}

            const createdAt = toEpochMs(meta.createdAt || metaMtimeMs || Date.now())
            const updatedAt = Math.max(
              toEpochMs(meta.lastActivityAt || 0),
              projMtimeMs,
              auditMtimeMs,
              createdAt,
            )

            // Desktop Code sessions with a standard ~/.claude/projects transcript use cliSessionId
            // so they merge cleanly with CLI sessions and stay natively writable.
            const nativeId =
              store.source === 'claude-desktop-code' && linkedCliFile && cliSessionId
                ? cliSessionId
                : desktopSessionId
            const dedupeKey = `${store.source}:${nativeId}`
            if (seenKeys.has(dedupeKey)) continue
            seenKeys.add(dedupeKey)

            entries.push({
              nativeId,
              desktopSessionId,
              cliSessionId,
              source: store.source,
              writable: store.source === 'claude-desktop-code' ? Boolean(linkedCliFile) : store.defaultWritable,
              title,
              initialMessage: initialMsg,
              model: String(meta.model || '').trim(),
              cwd,
              workspace,
              createdAt,
              updatedAt,
              sessDir,
              auditPath,
              projJsonlPath,
              pidSessionsDir,
            })
          }
        }
      }
    }
  }

  return { entries, workspaces }
}

function findClaudeCommand(configured) {
  const candidates = getClaudeCandidates(homedir(), process.platform, process.env, configured)
  if (process.platform === 'win32') {
    return findExecutable(['claude.exe', 'claude.cmd', 'claude'], candidates) || 'claude.exe'
  }
  return findExecutable(['claude'], candidates) || 'claude'
}

function spawnClaude(bin, args, options = {}) {
  return spawnCrossPlatform(bin, args, options)
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function scanClaudeSessionSummary(filePath, fallbackProjectName) {
  let st
  try {
    st = statSync(filePath)
  } catch {
    return null
  }
  const sessionId = basename(filePath, '.jsonl')
  if (sessionId.startsWith('agent-')) return null // skip internal subagent sidecar logs

  const ht = readHeadAndTailLines(filePath)
  const lines = ht.headLines === ht.tailLines ? ht.headLines : [...ht.headLines, ...ht.tailLines]

  let cwd = ''
  let aiTitle = ''
  let firstUserText = ''
  let lastPrompt = ''
  let lastAssistantText = ''
  let model = ''
  let createdAt = st.birthtimeMs || st.mtimeMs

  for (const line of lines) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd.length > 0) cwd = obj.cwd
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
      aiTitle = obj.aiTitle.trim()
    }
    if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string' && obj.lastPrompt.trim()) {
      lastPrompt = obj.lastPrompt.trim()
    }
    if (obj.type === 'user' && !obj.isMeta && !obj.isSidechain) {
      const txt = extractTextFromContent(obj.message?.content).trim()
      if (txt && !txt.startsWith('<command-name>') && !firstUserText) {
        firstUserText = txt
        if (obj.timestamp) createdAt = toEpochMs(obj.timestamp) || createdAt
      }
    }
    if (obj.type === 'assistant' && !obj.isSidechain) {
      if (obj.message?.model) model = obj.message.model
      const txt = extractTextFromContent(obj.message?.content).trim()
      if (txt) lastAssistantText = txt
    }
  }

  if (!firstUserText && !aiTitle && !lastPrompt && !lastAssistantText) return null

  const title = aiTitle || firstUserText.replace(/\s+/g, ' ').slice(0, 56) || lastPrompt.slice(0, 56) || sessionId
  const preview = (lastAssistantText || lastPrompt || firstUserText).replace(/\s+/g, ' ').slice(0, 120)

  return {
    id: makeCompositeId(APPS.CLAUDE, sessionId),
    app: APPS.CLAUDE,
    nativeId: sessionId,
    title,
    preview,
    cwd,
    workspace: cwd ? basename(cwd) : fallbackProjectName,
    model,
    status: 'idle',
    writable: true,
    filePath,
    createdAt: toEpochMs(createdAt),
    updatedAt: st.mtimeMs,
  }
}

const CLAUDE_MAX_FULL_PARSE_BYTES = 32 * 1024 * 1024
const CLAUDE_TAIL_FALLBACK_BYTES = 4 * 1024 * 1024

function parseClaudeJsonlMessages(filePath, parseCache = null) {
  const doParse = () => {
    const { headLines, bodyLines } = readHeadAndBodyLinesForParse(filePath, {
      maxFullBytes: CLAUDE_MAX_FULL_PARSE_BYTES,
      tailBytes: CLAUDE_TAIL_FALLBACK_BYTES,
    })
    const messages = []
    const toolIndex = new Map()
    const exitPlanToolIds = new Set()
    const seenUserUuids = new Set()
    const taskTracker = createTaskStateTracker()
    let cwd = ''
    let title = ''
    let model = ''

    for (const line of headLines) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
      if (!model && obj.type === 'assistant' && obj.message?.model) model = obj.message.model
    }

    const pushUserMessage = (uuid, text, images, ts) => {
      if (uuid) {
        if (seenUserUuids.has(uuid)) return
        seenUserUuids.add(uuid)
      }
      const prev = messages[messages.length - 1]
      // Claude Desktop audit.jsonl echoes queued desktop_app user prompts right before CLI intake
      if (
        prev?.role === 'user' &&
        prev.text === text &&
        (!images?.length && !prev.images?.length) &&
        Math.abs((ts || 0) - (prev.ts || 0)) < 10_000
      ) {
        return
      }
      if (!title && text) title = text.slice(0, 56)
      messages.push({
        id: uuid || `cld-u-${messages.length}`,
        role: 'user',
        text,
        ...(images?.length > 0 ? { images } : {}),
        ts,
      })
    }

    for (const line of bodyLines) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
      if (obj.isSidechain) continue

      const ts = toEpochMs(obj.timestamp || obj._audit_timestamp || Date.now())

      if (typeof obj.permissionMode === 'string') {
        if (obj.permissionMode === 'plan') taskTracker.setMode('plan', ts)
        else if (taskTracker.snapshot()?.mode === 'plan') taskTracker.setMode(null, ts)
      }

      if (obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          let hasText = false
          const textParts = []
          const images = []
          for (const b of content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              const target = toolIndex.get(b.tool_use_id)
              if (target) {
                target.status = b.is_error ? 'error' : 'completed'
                const resText = extractTextFromContent(b.content) || (typeof b.content === 'string' ? b.content : '')
                target.output = resText.slice(0, 800)
              }
              if (exitPlanToolIds.has(b.tool_use_id) && !b.is_error) {
                taskTracker.setMode(null, ts)
              }
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              hasText = true
              textParts.push(b.text)
            } else if (b?.type === 'image') {
              if (b.source?.type === 'base64' && b.source?.data) {
                images.push({
                  url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`,
                  name: 'image',
                })
              } else if (b.source?.url) {
                images.push({ url: b.source.url, name: 'image' })
              }
            }
          }
          if (hasText || images.length > 0) {
            pushUserMessage(obj.uuid, textParts.join('\n').trim(), images, ts)
          }
        } else if (typeof content === 'string' && content.trim()) {
          pushUserMessage(obj.uuid, content.trim(), [], ts)
        }
        continue
      }

      if (obj.type === 'assistant') {
        if (obj.message?.model) model = obj.message.model
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
        const thinkingParts = []
        const textParts = []
        const tools = []

        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'thinking' && b.thinking) thinkingParts.push(b.thinking)
          else if (b.type === 'text' && b.text) textParts.push(b.text)
          else if (b.type === 'tool_use') {
            const toolObj = {
              id: b.id || `cld-t-${messages.length}-${tools.length}`,
              name: b.name || 'tool',
              input: b.input ?? {},
              status: 'completed',
              output: '',
            }
            if (toolObj.name === 'ExitPlanMode') {
              exitPlanToolIds.add(toolObj.id)
            }
            taskTracker.applyClaudeTool(toolObj.name, toolObj.input, ts)
            tools.push(toolObj)
            toolIndex.set(toolObj.id, toolObj)
          }
        }

        if (textParts.length > 0 || thinkingParts.length > 0 || tools.length > 0) {
          messages.push({
            id: obj.uuid || `cld-a-${messages.length}`,
            role: 'assistant',
            text: textParts.join('\n').trim(),
            thinking: thinkingParts.join('\n').trim() || undefined,
            tools: tools.length > 0 ? tools : undefined,
            ts,
          })
        }
      }
    }

    return {
      messages: mergeAndCompactMessages(messages),
      cwd,
      title,
      model,
      taskState: taskTracker.snapshot(),
    }
  }
  return parseCache ? parseCache.getOrParse(filePath, doParse) : doParse()
}

/**
 * Normalize a Claude Code `rate_limit_event` payload (`rate_limit_info`) into a uniform
 * E2EE quota descriptor when a numeric utilization percentage is provided.
 */
export function normalizeClaudeQuota(rateLimitInfo, now = Date.now()) {
  if (!rateLimitInfo || typeof rateLimitInfo !== 'object') return null
  const rawUtil = rateLimitInfo.utilization ?? rateLimitInfo.usedPercent ?? rateLimitInfo.used_percent
  if (typeof rawUtil !== 'number' || !Number.isFinite(rawUtil)) return null
  const pct = rawUtil >= 0 && rawUtil <= 1 ? rawUtil * 100 : rawUtil
  const usedPercent = Math.max(0, Math.min(100, Math.round(pct)))
  const resetsAt = toEpochMs(rateLimitInfo.resetsAt ?? rateLimitInfo.resets_at ?? 0)
  if (resetsAt > 0 && now > resetsAt + 60_000) return null
  const rawType = String(rateLimitInfo.rateLimitType || rateLimitInfo.rate_limit_type || '').toLowerCase()
  const isWeekly = rawType.includes('seven_day') || rawType.includes('weekly') || rawType.includes('7d')
  return {
    remainingPercent: 100 - usedPercent,
    usedPercent,
    windowKind: isWeekly ? 'weekly' : 'session',
    windowMinutes: isWeekly ? 10080 : 300,
    resetsAt,
    updatedAt: now,
  }
}

function getClaudeQuotaCachePath() {
  const base = String(process.env.ALLINONE_HOME || '').trim() || join(homedir(), '.allinone-bridge')
  return join(base, 'claude-quota-cache.json')
}

function isValidClaudeQuotaWindow(q, now = Date.now()) {
  return Boolean(
    q &&
    typeof q === 'object' &&
    typeof q.remainingPercent === 'number' &&
    Number.isFinite(q.remainingPercent) &&
    (!q.resetsAt || now <= q.resetsAt + 60_000),
  )
}

function parseClaudeDiskQuotaBundle(raw, now = Date.now()) {
  const src = raw?.quota && typeof raw.quota === 'object' ? raw.quota : raw
  if (!src || typeof src !== 'object') return null
  const weekly = isValidClaudeQuotaWindow(src.weekly, now) ? src.weekly : null
  const short = isValidClaudeQuotaWindow(src.short, now) ? src.short : null
  if (!weekly && !short) return null
  return { weekly, short }
}

function sweepStaleClaudeSettingsFiles(dir, maxAgeMs = 10 * 60_000) {
  try {
    if (!dir || !existsSync(dir)) return
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('allinone-claude-settings-') || !name.endsWith('.json')) continue
      const fp = join(dir, name)
      try {
        const st = statSync(fp)
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) unlinkSync(fp)
      } catch {}
    }
  } catch {}
}

/**
 * Claude Code / Claude Desktop (Cowork + Desktop Code) Sessions Adapter.
 * - Claude Code CLI & Desktop Code sessions: full read/write streaming via `StreamJsonCliRunner` + external running-state sync.
 * - Claude Desktop Cowork (`local-agent-mode-sessions`) sessions: full history reading + real-time live progress/status sync (read-only mirror).
 */
export class ClaudeAdapter extends BaseAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest }) {
    super(APPS.CLAUDE, {
      config,
      log,
      emitEvent,
      onApprovalRequest,
      capabilities: {
        supportsWorkspaces: true,
        supportsApproval: true,
        supportsMidChatSwitch: true,
        supportsQuota: true,
      },
    })
    this.configuredBin = config.claudeBin
    this.claudeBin = findClaudeCommand(this.configuredBin)
    this.claudeHome = getClaudeHome(config.claudeHome)
    this.configuredDesktopRoots = Array.isArray(config.claudeDesktopRoots) ? config.claudeDesktopRoots : null
    this.defaultCwd = config.cwd || process.cwd()
    const rawHostPerm = String(config.claudePermissionMode || 'acceptEdits').trim()
    this.permissionMode = ALLOWED_CLAUDE_PERMISSION_MODES.includes(rawHostPerm) ? rawHostPerm : 'acceptEdits'
    this.externalMaxIdleMs = Number(config.claudeExternalMaxIdleMs) || CLAUDE_EXTERNAL_MAX_IDLE_MS
    this.watchPollMs = Number(config.claudeWatchPollMs) || CLAUDE_WATCH_POLL_MS
    this.checkPidAlive = typeof config.checkPidAlive === 'function' ? config.checkPidAlive : isPidAlive

    const stateBase =
      String(config.stateDir || process.env.ALLINONE_HOME || '').trim() || join(homedir(), '.allinone-bridge')
    this.tempSettingsDir = join(stateBase, 'tmp-claude')
    sweepStaleClaudeSettingsFiles(this.tempSettingsDir)

    this.runner = new StreamJsonCliRunner({
      app: APPS.CLAUDE,
      displayName: 'Claude',
      idPrefix: 'cld',
      emitEvent: this.emitEvent,
      onApprovalRequest: this.onApprovalRequest,
      sessionTaskStates: this.sessionTaskStates,
      spawnFn: spawnClaude,
      extractToolOutput: extractTextFromContent,
      log: this.log,
    })
    this.activeProcs = this.runner.activeProcs
    this.pendingControlRequests = this.runner.pendingControlRequests

    this.quotaCachePath = config.claudeQuotaCachePath || getClaudeQuotaCachePath()
    this.quotaManager = new QuotaCacheManager({
      app: APPS.CLAUDE,
      diskCachePath: this.quotaCachePath,
      diskTtlMs: 7 * 24 * 60 * 60_000,
      emitEvent: this.emitEvent,
      parseDisk: (raw, now) => parseClaudeDiskQuotaBundle(raw, now),
      isValid: (bundle, now) =>
        Boolean(bundle && (isValidClaudeQuotaWindow(bundle.weekly, now) || isValidClaudeQuotaWindow(bundle.short, now))),
    })
    this.weeklyQuota = this.quotaManager.quota?.weekly || null
    this.shortQuota = this.quotaManager.quota?.short || null
    this.desktopEntriesById = new Map() // nativeId -> desktop entry descriptor

    this.watcher = new SessionExternalWatcher({
      pollMs: this.watchPollMs,
      maxWatched: 8,
      maxTracked: CLAUDE_TRACKED_LIST_LIMIT,
      watchTtlMs: CLAUDE_WATCH_TTL_MS,
      listWatchTtlMs: CLAUDE_LIST_WATCH_TTL_MS,
      onPoll: (ctx) => this._pollExternalSessions(ctx),
    })
    this.watchedSessions = this.watcher.watched
    this.trackedListSessions = this.watcher.tracked
    this.lastListDiscoveryAt = 0
  }

  get lastClientListAt() {
    return this.watcher.lastClientListAt
  }

  set lastClientListAt(val) {
    this.watcher.lastClientListAt = Number(val) || 0
  }

  getDesktopRoots() {
    return getClaudeDesktopRoots({ configuredRoots: this.configuredDesktopRoots })
  }

  refreshDesktopIndex() {
    const roots = this.getDesktopRoots()
    const scanned = scanClaudeDesktopSessions(roots, {
      findCliSessionFile: (id) => this.findCliSessionFile(id),
    })
    const nextMap = new Map()
    for (const entry of scanned.entries) {
      nextMap.set(entry.nativeId, entry)
    }
    this.desktopEntriesById = nextMap
    return scanned
  }

  async listWorkspaces() {
    const { workspaces } = this.refreshDesktopIndex()
    return workspaces
  }

  refreshBinary() {
    this.claudeBin = findClaudeCommand(this.configuredBin)
    return this.claudeBin
  }

  async listModels() {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
    const baseModels = [
      { id: 'default', name: '默认模型 (Auto)', efforts, defaultEffort: 'high' },
      { id: 'opus', name: 'Claude Opus (Alias)', efforts, defaultEffort: 'high' },
      { id: 'sonnet', name: 'Claude Sonnet (Alias)', efforts, defaultEffort: 'medium' },
      { id: 'haiku', name: 'Claude Haiku (Alias)', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    ]
    const seen = new Set(baseModels.map((m) => m.id))
    // Enrich with real claude-* model IDs configured in the user's local gateway
    try {
      const dshCatalog = parseDshConfiguredModels()
      for (const m of dshCatalog.models || []) {
        if (!/^claude-/i.test(m.id) || seen.has(m.id)) continue
        seen.add(m.id)
        baseModels.push({
          id: m.id,
          name: m.name || m.id,
          efforts: m.efforts?.length ? m.efforts.filter((e) => e !== 'off') : efforts,
          defaultEffort: m.defaultEffort && m.defaultEffort !== 'off' ? m.defaultEffort : 'high',
        })
      }
    } catch {}
    return {
      app: APPS.CLAUDE,
      defaultModel: 'default',
      defaultEffort: 'high',
      supportsMidChatSwitch: true,
      models: baseModels,
    }
  }

  findCliSessionFile(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    const projectsDir = join(this.claudeHome, 'projects')
    if (!existsSync(projectsDir)) return null
    for (const proj of readdirSync(projectsDir)) {
      const projDir = join(projectsDir, proj)
      let st
      try { st = statSync(projDir) } catch { continue }
      if (!st.isDirectory()) continue
      const candidate = assertPathWithinDir(join(projDir, `${sessionId}.jsonl`), projDir, 'Claude session file')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  findSessionFile(sessionId) {
    const cliFile = this.findCliSessionFile(sessionId)
    if (cliFile) return cliFile
    const desktop = this.resolveDesktopEntry(sessionId)
    return desktop?.projJsonlPath || desktop?.auditPath || null
  }

  resolveDesktopEntry(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    let entry = this.desktopEntriesById.get(sessionId) || null
    if (!entry || (entry.projJsonlPath && !existsSync(entry.projJsonlPath)) || (entry.auditPath && !existsSync(entry.auditPath))) {
      this.refreshDesktopIndex()
      entry = this.desktopEntriesById.get(sessionId) || null
    }
    return entry
  }

  probeEntryExternalStatus(entry, now = Date.now()) {
    if (!entry) return null
    if (entry.source === 'claude-desktop-cowork' || entry.source === 'claude-desktop-code') {
      return probeClaudeExternalStatus({
        pidSessionsDir: entry.pidSessionsDir || join(this.claudeHome, 'sessions'),
        targetCliSessionId: entry.cliSessionId || entry.nativeId,
        auditPath: entry.auditPath || '',
        transcriptPath: entry.projJsonlPath || '',
        now,
        maxIdleMs: this.externalMaxIdleMs,
        checkPidAlive: this.checkPidAlive,
      })
    }
    return probeClaudeExternalStatus({
      pidSessionsDir: join(this.claudeHome, 'sessions'),
      targetCliSessionId: entry.nativeId,
      transcriptPath: entry.filePath || '',
      now,
      maxIdleMs: this.externalMaxIdleMs,
      checkPidAlive: this.checkPidAlive,
    })
  }

  buildWatchPayload(meta, probe, running) {
    const updatedAt = Math.max(meta.updatedAt || 0, Math.round(probe?.mtimeMs || 0))
    const preview =
      (probe?.lastTextPreview ? probe.lastTextPreview.replace(/\s+/g, ' ').slice(0, 120) : '') ||
      (running && probe?.lastToolName ? `正在调用 ${probe.lastToolName}…` : '') ||
      meta.preview ||
      ''
    return {
      id: makeCompositeId(APPS.CLAUDE, meta.nativeId),
      app: APPS.CLAUDE,
      nativeId: meta.nativeId,
      title: meta.title || meta.nativeId,
      preview,
      cwd: meta.cwd || '',
      workspace: meta.workspace || (meta.cwd ? basename(meta.cwd) : 'Claude'),
      model: meta.model || 'default',
      source: meta.source || 'claude-code',
      writable: meta.writable !== false,
      status: running ? 'running' : 'idle',
      ...(meta.taskState !== undefined ? { taskState: meta.taskState } : {}),
      syncState: {
        externalRunning: Boolean(running),
        source: meta.source || 'claude-code',
        ...(probe?.waitingPermission ? { waitingPermission: true, permissionTool: probe.permissionTool || '' } : {}),
      },
      updatedAt,
    }
  }

  ensureWatchTimer() {
    this.watcher.ensureRunning()
  }

  rememberWatchedSession(nativeId, descriptor) {
    this.watcher.rememberWatched(nativeId, descriptor)
  }

  rememberTrackedListSession(nativeId, descriptor) {
    this.watcher.rememberTracked(nativeId, descriptor)
  }

  async pollExternalSessions() {
    return this.watcher.tick()
  }

  async _pollExternalSessions({ now, watched, tracked, isListExpired }) {
    const emittedIds = new Set()

    // 1. Poll opened / watched Claude sessions (capped LRU max 8)
    for (const [nativeId, entry] of [...watched.entries()]) {
      if (this.activeProcs.has(nativeId)) continue
      const probe = this.probeEntryExternalStatus(entry, now)
      if (!probe) continue
      let projSize = entry.projSize || 0
      let projMtime = entry.projMtime || 0
      if (entry.projJsonlPath) {
        try {
          const st = statSync(entry.projJsonlPath)
          projSize = st.size
          projMtime = st.mtimeMs
        } catch {}
      }
      const historyChanged =
        probe.size !== entry.size ||
        probe.mtimeMs > (entry.mtimeMs || 0) + 10 ||
        projSize !== (entry.projSize || 0) ||
        projMtime > (entry.projMtime || 0) + 10
      const statusChanged =
        Boolean(probe.running) !== Boolean(entry.externalRunning) ||
        Boolean(probe.waitingPermission) !== Boolean(entry.waitingPermission)

      if (historyChanged || statusChanged) {
        entry.size = probe.size
        entry.mtimeMs = probe.mtimeMs
        entry.projSize = projSize
        entry.projMtime = projMtime
        entry.externalRunning = probe.running
        entry.waitingPermission = probe.waitingPermission
        entry.updatedAt = Math.max(entry.updatedAt || 0, Math.round(probe.mtimeMs || 0), Math.round(projMtime || 0))
        if (historyChanged) {
          const targetFile = entry.projJsonlPath || entry.filePath || entry.auditPath || ''
          if (targetFile && existsSync(targetFile)) {
            try {
              entry.taskState = parseClaudeJsonlMessages(targetFile, this.parseCache).taskState || null
              this.sessionTaskStates.set(nativeId, entry.taskState)
            } catch {}
          }
        }
        if (probe.running) entry.lastSeenAt = now
        emittedIds.add(nativeId)
        this.emitEvent(EVENTS.SESSION_UPDATED, {
          historyChanged,
          statusChanged,
          externalUpdate: true,
          session: this.buildWatchPayload(entry, probe, probe.running),
        })
      } else if (!probe.running && now - (entry.lastSeenAt || 0) > CLAUDE_WATCH_TTL_MS) {
        watched.delete(nativeId)
      }
    }

    // 2. Poll sidebar tracked sessions for running <-> idle flips
    const listExpired = isListExpired(now)
    if (listExpired) {
      tracked.clear()
    } else {
      for (const [nativeId, entry] of [...tracked.entries()]) {
        if (emittedIds.has(nativeId) || this.activeProcs.has(nativeId)) continue
        const probe = this.probeEntryExternalStatus(entry, now)
        if (!probe) continue
        const statusChanged =
          Boolean(probe.running) !== Boolean(entry.externalRunning) ||
          Boolean(probe.waitingPermission) !== Boolean(entry.waitingPermission)
        if (statusChanged) {
          entry.size = probe.size
          entry.mtimeMs = probe.mtimeMs
          entry.externalRunning = probe.running
          entry.waitingPermission = probe.waitingPermission
          entry.updatedAt = Math.max(entry.updatedAt || 0, Math.round(probe.mtimeMs || 0))
          emittedIds.add(nativeId)
          this.emitEvent(EVENTS.SESSION_UPDATED, {
            historyChanged: false,
            statusChanged: true,
            externalUpdate: true,
            session: this.buildWatchPayload(entry, probe, probe.running),
          })
        }
      }
    }

    // 3. Throttled discovery of newly started Claude Desktop sessions (only check recent mtimes)
    if (!listExpired && tracked.size > 0 && now - this.lastListDiscoveryAt >= CLAUDE_LIST_DISCOVERY_INTERVAL_MS) {
      this.lastListDiscoveryAt = now
      try {
        const { entries } = this.refreshDesktopIndex()
        const recentWindowMs = this.externalMaxIdleMs + 60_000
        for (const dEntry of entries) {
          if (emittedIds.has(dEntry.nativeId) || this.activeProcs.has(dEntry.nativeId)) continue
          const prev = tracked.get(dEntry.nativeId)
          // Skip probing old untouched desktop sessions that aren't already tracked
          if (!prev && dEntry.updatedAt && now - dEntry.updatedAt > recentWindowMs) continue
          const probe = this.probeEntryExternalStatus(dEntry, now)
          const prevRunning = Boolean(prev?.externalRunning)
          const isRunning = Boolean(probe?.running)
          if ((!prev && isRunning) || (prev && prevRunning !== isRunning)) {
            const trackedObj = {
              ...dEntry,
              preview: dEntry.initialMessage.slice(0, 120),
              size: probe?.size || 0,
              mtimeMs: probe?.mtimeMs || 0,
              externalRunning: isRunning,
              waitingPermission: Boolean(probe?.waitingPermission),
            }
            this.rememberTrackedListSession(dEntry.nativeId, trackedObj)
            this.emitEvent(EVENTS.SESSION_UPDATED, {
              historyChanged: false,
              statusChanged: true,
              externalUpdate: true,
              session: this.buildWatchPayload(trackedObj, probe, isRunning),
            })
          }
        }
      } catch {}
    }
  }

  recordRateLimitInfo(info) {
    const parsed = normalizeClaudeQuota(info)
    if (!parsed) return
    if (parsed.windowKind === 'weekly') {
      this.weeklyQuota = parsed
    } else {
      this.shortQuota = parsed
    }
    this.quotaManager.set(
      { weekly: this.weeklyQuota || null, short: this.shortQuota || null },
      { persist: true, emit: false },
    )
    const combined = this.getCachedQuota()
    if (combined) {
      this.emitEvent(EVENTS.BRIDGE_STATUS, {
        type: 'quota.updated',
        app: APPS.CLAUDE,
        quota: combined,
      })
    }
  }

  getCachedQuota(now = Date.now()) {
    const valid = (q) => q && (!q.resetsAt || now <= q.resetsAt + 60_000)
    const weekly = valid(this.weeklyQuota) ? this.weeklyQuota : null
    const shortWin = valid(this.shortQuota) ? this.shortQuota : null
    if (!weekly && !shortWin) return null
    if (weekly) {
      return shortWin
        ? {
            ...weekly,
            shortWindow: {
              remainingPercent: shortWin.remainingPercent,
              usedPercent: shortWin.usedPercent,
              windowMinutes: shortWin.windowMinutes,
              resetsAt: shortWin.resetsAt,
            },
          }
        : weekly
    }
    return shortWin
  }

  async getStatus() {
    this.claudeBin = findClaudeCommand(this.configuredBin)
    const projectsExists = existsSync(join(this.claudeHome, 'projects'))
    const desktopScanned = this.refreshDesktopIndex()
    const desktopCount = desktopScanned.entries.length
    const cliAvailable = await new Promise((resolvePromise) => {
      let settled = false
      const done = (val) => {
        if (settled) return
        settled = true
        this.clearTrackedTimer(timer)
        resolvePromise(val)
      }
      let proc = null
      const timer = this.setTimeout(() => {
        if (proc) killProcessTree(proc, { force: true })
        done(false)
      }, 6_000)
      try {
        proc = spawnClaude(this.claudeBin, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        this.trackChildProcess(proc)
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', (code) => done(code === 0 ? out.trim() : false))
        proc.on('error', () => done(false))
      } catch {
        done(false)
      }
    })

    const desktopSuffix = desktopCount > 0 ? ` + ${desktopCount} 条 Claude Desktop 本地会话实时同步` : ''
    const quota = this.getCachedQuota()
    return {
      app: APPS.CLAUDE,
      available: Boolean(cliAvailable) || projectsExists || desktopCount > 0,
      writable: Boolean(cliAvailable),
      mode: cliAvailable ? 'claude-cli-stream' : 'readonly',
      detail: cliAvailable
        ? `已连接本地 ${cliAvailable}（Claude Code 可读写流式续聊${desktopSuffix}；纯云端网页 Chat 暂不支持）`
        : desktopCount > 0
          ? `未检测到 claude CLI，已接入 ${desktopCount} 条 Claude Desktop 本地会话实时监控`
          : '未检测到 claude CLI，仅支持历史只读',
      activeCount: this.activeProcs.size,
      ...(quota ? { quota } : {}),
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const now = Date.now()
    const projectsDir = join(this.claudeHome, 'projects')
    const results = []
    const seen = new Set()
    const desktopCodeByCliId = new Map()

    // 1. Scan Claude Desktop sessions (`local-agent-mode-sessions` + `claude-code-sessions`)
    const { entries: desktopEntries } = this.refreshDesktopIndex()
    for (const dEntry of desktopEntries) {
      if (dEntry.source === 'claude-desktop-code' && dEntry.writable) {
        desktopCodeByCliId.set(dEntry.nativeId, dEntry)
        continue
      }
      const probe = this.probeEntryExternalStatus(dEntry, now)
      const isRunning = Boolean(probe?.running)
      const updatedAt = Math.max(dEntry.updatedAt || 0, Math.round(probe?.mtimeMs || 0))
      const preview =
        (probe?.lastTextPreview ? probe.lastTextPreview.replace(/\s+/g, ' ').slice(0, 120) : '') ||
        (isRunning && probe?.lastToolName ? `正在调用 ${probe.lastToolName}…` : '') ||
        dEntry.initialMessage.slice(0, 120)
      const item = {
        id: makeCompositeId(APPS.CLAUDE, dEntry.nativeId),
        app: APPS.CLAUDE,
        nativeId: dEntry.nativeId,
        title: dEntry.title,
        preview,
        cwd: dEntry.cwd,
        workspace: dEntry.workspace,
        model: dEntry.model || 'default',
        source: dEntry.source,
        writable: dEntry.writable,
        status: isRunning ? 'running' : 'idle',
        syncState: {
          externalRunning: isRunning,
          source: dEntry.source,
          ...(probe?.waitingPermission ? { waitingPermission: true, permissionTool: probe.permissionTool || '' } : {}),
        },
        createdAt: dEntry.createdAt,
        updatedAt,
      }
      seen.add(dEntry.nativeId)
      results.push(item)
      if (!search) {
        this.rememberTrackedListSession(dEntry.nativeId, {
          ...dEntry,
          preview,
          updatedAt,
          size: probe?.size || 0,
          mtimeMs: probe?.mtimeMs || 0,
          externalRunning: isRunning,
          waitingPermission: Boolean(probe?.waitingPermission),
        })
      }
    }

    // 2. Include freshly created CLI sessions not yet written to disk
    for (const pending of this.pendingCreated.values()) {
      if (seen.has(pending.nativeId)) continue
      seen.add(pending.nativeId)
      results.push({
        ...pending,
        source: 'claude-code',
        status: this.activeProcs.has(pending.nativeId) ? 'running' : 'idle',
      })
    }

    // 3. Scan Claude Code CLI sessions (`~/.claude/projects/<proj>/*.jsonl`)
    if (existsSync(projectsDir)) {
      const allFiles = []
      for (const proj of readdirSync(projectsDir)) {
        const pDir = join(projectsDir, proj)
        let stat
        try { stat = statSync(pDir) } catch { continue }
        if (!stat.isDirectory()) continue
        for (const f of readdirSync(pDir)) {
          if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
          const fp = join(pDir, f)
          try {
            const fst = statSync(fp)
            allFiles.push({ fp, proj, mtimeMs: fst.mtimeMs })
          } catch {}
        }
      }
      allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

      // Scan most recent 150 user session files for crisp latency
      let acceptedCount = 0
      for (let i = 0; i < Math.min(allFiles.length, 150); i += 1) {
        const entry = allFiles[i]
        const summary = scanClaudeSessionSummary(entry.fp, entry.proj)
        if (!summary || seen.has(summary.nativeId)) continue
        seen.add(summary.nativeId)
        const sessionIdx = acceptedCount++
        const desktopCodeMeta = desktopCodeByCliId.get(summary.nativeId)
        if (desktopCodeMeta) {
          if (desktopCodeMeta.title) summary.title = desktopCodeMeta.title
          if (desktopCodeMeta.cwd && !summary.cwd) summary.cwd = desktopCodeMeta.cwd
          if (desktopCodeMeta.workspace) summary.workspace = desktopCodeMeta.workspace
          summary.source = 'claude-desktop-code'
        } else {
          summary.source = 'claude-code'
        }
        const isLocalActive = this.activeProcs.has(summary.nativeId)
        let probe = null
        let externalRunning = false
        if (!isLocalActive && (sessionIdx < CLAUDE_TRACKED_LIST_LIMIT || now - (summary.updatedAt || 0) <= this.externalMaxIdleMs + 5 * 60_000)) {
          probe = probeClaudeExternalStatus({
            pidSessionsDir: join(this.claudeHome, 'sessions'),
            targetCliSessionId: summary.nativeId,
            transcriptPath: entry.fp,
            now,
            maxIdleMs: this.externalMaxIdleMs,
            checkPidAlive: this.checkPidAlive,
          })
          externalRunning = Boolean(probe?.running)
          if (probe?.mtimeMs > (summary.updatedAt || 0)) {
            summary.updatedAt = Math.round(probe.mtimeMs)
          }
        }
        delete summary.filePath
        if (isLocalActive) {
          summary.status = 'running'
          summary.syncState = { externalRunning: false, source: summary.source }
        } else if (externalRunning) {
          summary.status = 'running'
          summary.syncState = { externalRunning: true, source: summary.source }
        }
        if (!search && sessionIdx < CLAUDE_TRACKED_LIST_LIMIT) {
          this.rememberTrackedListSession(summary.nativeId, {
            ...summary,
            filePath: entry.fp,
            size: probe?.size || 0,
            mtimeMs: probe?.mtimeMs || 0,
            externalRunning,
            waitingPermission: false,
          })
        }
        results.push(summary)
      }
    }

    this.lastClientListAt = now
    this.lastListDiscoveryAt = now

    let filtered = results
    const q = String(search || '').trim().toLowerCase()
    if (q) {
      filtered = results.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.workspace.toLowerCase().includes(q),
      )
    }
    filtered.sort((a, b) => b.updatedAt - a.updatedAt)
    return filtered.slice(0, limit)
  }

  async readSession(sessionId, { limit = 25, cursor = null } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    const now = Date.now()
    const desktopEntry = this.resolveDesktopEntry(sessionId)
    const cliFile = this.findCliSessionFile(sessionId)
    const isDesktopCowork = Boolean(desktopEntry && desktopEntry.source === 'claude-desktop-cowork')

    // Choose primary transcript: prefer native .claude/projects/*.jsonl, fall back to audit.jsonl
    let transcriptFile = ''
    if (isDesktopCowork) {
      transcriptFile = desktopEntry.projJsonlPath || desktopEntry.auditPath || ''
    } else {
      transcriptFile = cliFile || desktopEntry?.projJsonlPath || desktopEntry?.auditPath || ''
    }

    if (!transcriptFile) {
      const pending = this.pendingCreated.get(sessionId)
      if (pending) {
        return {
          ...pending,
          source: 'claude-code',
          messages: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        }
      }
      throw new Error(`找不到 Claude 会话：${sessionId}`)
    }

    let parsed = parseClaudeJsonlMessages(transcriptFile, this.parseCache)
    if (
      parsed.messages.length === 0 &&
      desktopEntry?.auditPath &&
      desktopEntry.auditPath !== transcriptFile &&
      existsSync(desktopEntry.auditPath)
    ) {
      parsed = parseClaudeJsonlMessages(desktopEntry.auditPath, this.parseCache)
    }

    const activeProc = this.activeProcs.get(sessionId)
    const isLocalActive = Boolean(activeProc)
    const taskState =
      isLocalActive && activeProc?.taskTracker
        ? activeProc.taskTracker.snapshot()
        : parsed.taskState || null
    this.sessionTaskStates.set(sessionId, taskState)
    const probeTarget = desktopEntry || {
      nativeId: sessionId,
      source: 'claude-code',
      filePath: transcriptFile,
    }
    const probe = !isLocalActive ? this.probeEntryExternalStatus(probeTarget, now) : null
    const externalRunning = Boolean(!isLocalActive && probe?.running)

    let projSize = 0
    let projMtime = 0
    if (desktopEntry?.projJsonlPath) {
      try {
        const st = statSync(desktopEntry.projJsonlPath)
        projSize = st.size
        projMtime = st.mtimeMs
      } catch {}
    }

    const source = desktopEntry?.source || 'claude-code'
    const writable = desktopEntry ? desktopEntry.writable : true
    const title = desktopEntry?.title || parsed.title || sessionId
    const cwd = desktopEntry?.cwd || parsed.cwd || ''
    const workspace = desktopEntry?.workspace || (cwd ? basename(cwd) : 'Claude')
    const pref = this.sessionPrefs.get(sessionId)
    const model = pref?.model || desktopEntry?.model || parsed.model || 'default'
    const updatedAt = Math.max(desktopEntry?.updatedAt || 0, Math.round(probe?.mtimeMs || 0), Math.round(projMtime || 0))

    // Register lightweight external watcher when opening Desktop or externally active sessions
    if (isDesktopCowork || externalRunning) {
      this.rememberWatchedSession(sessionId, {
        ...(desktopEntry || {}),
        nativeId: sessionId,
        filePath: transcriptFile,
        title,
        cwd,
        workspace,
        model,
        source,
        writable,
        updatedAt,
        size: probe?.size || 0,
        mtimeMs: probe?.mtimeMs || 0,
        projSize,
        projMtime,
        externalRunning,
        waitingPermission: Boolean(probe?.waitingPermission),
      })
    }

    const total = parsed.messages.length
    const pageSize = Math.max(10, Math.min(Number(limit) || 25, 200))
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)

    return {
      id: makeCompositeId(APPS.CLAUDE, sessionId),
      app: APPS.CLAUDE,
      nativeId: sessionId,
      title,
      cwd,
      workspace,
      model,
      reasoningEffort: pref?.reasoningEffort || '',
      source,
      writable,
      status: isLocalActive || externalRunning ? 'running' : 'idle',
      taskState,
      syncState: {
        externalRunning,
        source,
        ...(probe?.waitingPermission ? { waitingPermission: true, permissionTool: probe.permissionTool || '' } : {}),
      },
      messages: parsed.messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
      updatedAt,
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    const sessionId = randomUUID()
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    if (model || reasoningEffort) {
      this.sessionPrefs.set(sessionId, { model: model || 'default', reasoningEffort: reasoningEffort || '' })
    }
    const summary = {
      id: makeCompositeId(APPS.CLAUDE, sessionId),
      app: APPS.CLAUDE,
      nativeId: sessionId,
      title: title || '新 Claude Code 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd),
      model: model || 'default',
      reasoningEffort: reasoningEffort || '',
      source: 'claude-code',
      status: 'idle',
      writable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], permissionMode, taskMode, model, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    let effectiveTaskMode = normalizeTaskMode(taskMode)
    const reservationToken = this.runner.reserveSession(
      sessionId,
      '该 Claude 会话正在运行中，请等待完成或先点击停止。',
    )

    let targetCwd
    let prompt
    let effectivePermissionMode
    let args
    let tempSettingsPath = ''
    const cleanupTempSettings = () => {
      if (!tempSettingsPath) return
      const p = tempSettingsPath
      tempSettingsPath = ''
      try { unlinkSync(p) } catch {}
    }

    try {
      const desktopEntry = this.resolveDesktopEntry(sessionId)
      if (desktopEntry && desktopEntry.writable === false) {
        const err = new Error(
          '该对话来自 Claude Desktop (Cowork)，为避免与桌面端冲突或破坏签名日志，手机端仅提供实时监控与只读同步。如需手机接管写代码，可在同目录新建一条 Claude Code 对话。',
        )
        err.code = 'SESSION_READONLY'
        throw err
      }

      const existingFile = this.findCliSessionFile(sessionId)
      if (existingFile) {
        const extProbe = probeClaudeExternalStatus({
          pidSessionsDir: join(this.claudeHome, 'sessions'),
          targetCliSessionId: sessionId,
          transcriptPath: existingFile,
          maxIdleMs: this.externalMaxIdleMs,
          checkPidAlive: this.checkPidAlive,
        })
        if (extProbe.running) {
          const err = new Error('该 Claude 会话正在电脑端运行中（手机端实时同步中），请等待电脑端完成后再发消息。')
          err.code = 'SESSION_BUSY'
          throw err
        }
      }
      targetCwd = String(cwd || '').trim()
      if (!targetCwd && existingFile) {
        const sum = scanClaudeSessionSummary(existingFile, '')
        targetCwd = sum?.cwd || ''
      }
      if (!targetCwd) {
        targetCwd = this.pendingCreated.get(sessionId)?.cwd || this.defaultCwd
      }
      if (!existsSync(targetCwd)) targetCwd = this.defaultCwd

      prompt = String(text || '').trim()
      if (!effectiveTaskMode && prompt) {
        const planMatch = /^\/plan(?:\s+([\s\S]*))?$/i.exec(prompt)
        if (planMatch) {
          effectiveTaskMode = 'plan'
          const rest = String(planMatch[1] || '').trim()
          if (rest) prompt = rest
        }
      }
      if (attachments.length > 0) {
        const lines = attachments.map((a) => `- 附件文件：${a.localPath || a.filename}`)
        prompt = `${prompt}\n\n[手机端上传的附件，可直接读取]\n${lines.join('\n')}`
      }
      if (!prompt) throw new Error('消息内容不能为空')

      const pref = this.sessionPrefs.get(sessionId)
      const effectiveModel = assertSafeCliToken(model || pref?.model || '', 'model')
      const effectiveEffort = assertSafeCliToken(reasoningEffort || pref?.reasoningEffort || '', 'reasoningEffort')
      effectivePermissionMode = resolveEffectiveClaudePermissionMode(
        permissionMode,
        this.permissionMode,
        effectiveTaskMode,
      )
      if (effectiveModel || effectiveEffort) {
        this.sessionPrefs.set(sessionId, { model: effectiveModel || 'default', reasoningEffort: effectiveEffort || '' })
      }

      args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-prompt-tool',
        'stdio',
        '--permission-mode',
        effectivePermissionMode,
      ]
      if (effectiveModel && effectiveModel !== 'default') {
        args.push('--model', effectiveModel)
      }
      if (effectiveEffort && effectiveEffort !== 'off') {
        args.push('--effort', effectiveEffort)
      }
      // Preserve live Windows/OS ANTHROPIC_BASE_URL & credentials over any stale ~/.claude/settings.json proxy
      // Security: write ephemeral 0o600 temp file inside private 0o700 stateDir instead of world-shared os.tmpdir()
      const envOverride = {}
      if (process.env.ANTHROPIC_BASE_URL) envOverride.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
      if (process.env.ANTHROPIC_AUTH_TOKEN) envOverride.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
      if (process.env.ANTHROPIC_API_KEY) envOverride.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
      if (Object.keys(envOverride).length > 0) {
        mkdirSync(this.tempSettingsDir, { recursive: true, mode: 0o700 })
        try { chmodSync(this.tempSettingsDir, 0o700) } catch {}
        tempSettingsPath = join(this.tempSettingsDir, `allinone-claude-settings-${process.pid}-${randomUUID()}.json`)
        writeFileSync(tempSettingsPath, JSON.stringify({ env: envOverride }), { encoding: 'utf8', mode: 0o600 })
        try { chmodSync(tempSettingsPath, 0o600) } catch {}
        args.push('--settings', tempSettingsPath)
      }
      if (existingFile) {
        args.push('--resume', sessionId)
      } else {
        args.push('--session-id', sessionId)
      }
    } catch (preErr) {
      cleanupTempSettings()
      this.runner.releaseReservation(sessionId, reservationToken)
      throw preErr
    }

    const compositeId = makeCompositeId(APPS.CLAUDE, sessionId)
    return this.runner.runTurn({
      sessionId,
      compositeId,
      bin: this.claudeBin,
      args,
      cwd: targetCwd,
      prompt,
      effectivePermissionMode,
      reservationToken,
      onRateLimit: (info) => this.recordRateLimitInfo(info),
      onCleanup: cleanupTempSettings,
      onSessionPersisted: (sid, completed) => {
        if (completed || this.findSessionFile(sid)) {
          this.pendingCreated.delete(sid)
        }
      },
    })
  }

  handleControlRequest(proc, sessionId, compositeId, cwd, obj) {
    return this.runner.handleControlRequest(proc, sessionId, compositeId, cwd, obj)
  }

  async resolveApproval(approvalId, decisionOrPayload) {
    return this.runner.resolveApproval(approvalId, decisionOrPayload)
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    return this.runner.interrupt(sessionId)
  }

  async dispose() {
    this.quotaManager.dispose()
    this.watcher.dispose()
    this.runner.dispose()
    this.disposeBase()
  }
}
