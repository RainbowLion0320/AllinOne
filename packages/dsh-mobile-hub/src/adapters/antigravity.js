import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { APPS, EVENTS, assertPathWithinDir, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { createFileParseCache, mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, getAgyCandidates, killProcessTree, spawnCrossPlatform } from '../helpers/bin-finder.js'
import {
  answersToElicitationContent,
  elicitationSchemaToQuestions,
  normalizeResolvePayload,
} from '../helpers/interactive-schema.js'
import { createTaskStateTracker, normalizeTaskMode } from '../helpers/task-state.js'
import { BaseAdapter } from './base-adapter.js'
import { atomicWriteJsonSync, queryReadOnlySqlite } from '../primitives/io-utils.js'
import { JsonRpcStdioClient } from '../primitives/json-rpc-stdio.js'
import { BoundedLruMap } from '../primitives/lru.js'

const AGY_APP_DATA_DIR = 'antigravity'
const transcriptCache = createFileParseCache(16)
const WARM_IDLE_CLOSE_MS = 45_000             // Release SQLite WAL promptly once truly idle (no bg tasks)
const WARM_IDLE_EXCESS_CLOSE_MS = 25_000      // Tighter idle close when >3 warm sessions exist
const WARM_BUSY_HARD_CAP_MS = 2 * 60 * 60_000 // Allow background tasks up to 2 hours
const MAX_IDLE_WARM_SESSIONS = 3
const WATCH_POLL_INTERVAL_MS = 2_000          // Lightweight active-session external sync poll
const WATCH_TTL_MS = 15 * 60_000              // Stop watching inactive sessions after 15 min
const MAX_WATCHED_SESSIONS = 3
const DESKTOP_PROC_CACHE_TTL_MS = 10_000
const AGY_QUOTA_CACHE_TTL_MS = 3 * 60_000
const AGY_QUOTA_PROBE_TIMEOUT_MS = 12_000

let desktopProcCache = { running: false, checkedAt: 0 }

/**
 * Normalize an official Antigravity CLI `statusLine` JSON payload into a uniform E2EE quota object.
 * Keeps `gemini-weekly` as the primary sidebar ring metric (with `gemini-5h` in `shortWindow`),
 * and ALSO preserves all active model pools (`Gemini` + `3p` Claude/GPT 5h & weekly buckets)
 * in `pools` for the rich Home Quota Overview Dashboard.
 */
export function normalizeAntigravityQuota(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null
  const buckets = payload.quota && typeof payload.quota === 'object' ? payload.quota : payload
  if (!buckets || typeof buckets !== 'object') return null

  const parseBucket = (b, defaultMinutes) => {
    if (!b || typeof b !== 'object' || b.disabled === true) return null
    const rawFrac = b.remaining_fraction ?? b.remainingFraction
    if (typeof rawFrac !== 'number' || !Number.isFinite(rawFrac)) return null
    const pct = rawFrac >= 0 && rawFrac <= 1 ? rawFrac * 100 : rawFrac
    const remainingPercent = Math.max(0, Math.min(100, Math.round(pct)))
    const rawResetTime = b.reset_time || b.resetTime || 0
    let resetsAt = toEpochMs(rawResetTime)
    // Antigravity emits epoch 0 ("1970-01-01T00:00:00Z") + reset_in_seconds=0 when a bucket is unused at 100%
    if (resetsAt <= 86_400_000) {
      resetsAt = 0
    }
    const resetInSec = Number(b.reset_in_seconds ?? b.resetInSeconds ?? 0)
    if (!resetsAt && Number.isFinite(resetInSec) && resetInSec > 0) {
      resetsAt = now + Math.round(resetInSec * 1000)
    }
    if (resetsAt > 0 && now > resetsAt + 60_000) return null
    return {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      windowMinutes: defaultMinutes,
      resetsAt,
    }
  }

  const geminiWeekly = parseBucket(buckets['gemini-weekly'], 10080)
  const geminiShort = parseBucket(buckets['gemini-5h'], 300)
  const thirdPartyWeekly = parseBucket(buckets['3p-weekly'], 10080)
  const thirdPartyShort = parseBucket(buckets['3p-5h'], 300)

  const pools = []
  const geminiWindows = []
  if (geminiShort) geminiWindows.push({ id: 'short', kind: 'short', ...geminiShort })
  if (geminiWeekly) geminiWindows.push({ id: 'weekly', kind: 'weekly', ...geminiWeekly })
  if (geminiWindows.length > 0) {
    pools.push({
      id: 'gemini',
      label: 'Gemini Models',
      labelZh: 'Gemini 模型',
      windows: geminiWindows,
    })
  }

  const thirdPartyWindows = []
  if (thirdPartyShort) thirdPartyWindows.push({ id: 'short', kind: 'short', ...thirdPartyShort })
  if (thirdPartyWeekly) thirdPartyWindows.push({ id: 'weekly', kind: 'weekly', ...thirdPartyWeekly })
  if (thirdPartyWindows.length > 0) {
    pools.push({
      id: '3p',
      label: 'Claude & GPT',
      labelZh: 'Claude / GPT 模型',
      windows: thirdPartyWindows,
    })
  }

  const primary = geminiWeekly || geminiShort || thirdPartyWeekly || thirdPartyShort
  if (!primary) return null
  const primaryIsWeekly = primary === geminiWeekly || primary === thirdPartyWeekly
  const primaryShort =
    primary === geminiWeekly ? geminiShort : primary === thirdPartyWeekly ? thirdPartyShort : null
  const primaryBucketLabel = primary === geminiWeekly || primary === geminiShort ? 'Gemini' : 'Claude / GPT'
  const planType = String(payload.plan_tier || payload.planTier || '').trim()

  return {
    remainingPercent: primary.remainingPercent,
    usedPercent: primary.usedPercent,
    windowKind: primaryIsWeekly ? 'weekly' : 'session',
    windowMinutes: primary.windowMinutes,
    resetsAt: primary.resetsAt,
    bucketLabel: primaryBucketLabel,
    ...(planType ? { planType } : {}),
    ...(primaryShort ? { shortWindow: primaryShort } : {}),
    ...(pools.length > 0 ? { pools } : {}),
    updatedAt: now,
  }
}

function getAgyQuotaCachePath() {
  const base = String(process.env.ALLINONE_HOME || '').trim() || join(homedir(), '.allinone-bridge')
  return join(base, 'agy-quota-cache.json')
}

function readDiskAgyQuota(cachePath, now = Date.now()) {
  try {
    if (!cachePath || !existsSync(cachePath)) return null
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (!raw || typeof raw.remainingPercent !== 'number' || !Number.isFinite(raw.remainingPercent)) return null
    if (raw.resetsAt > 0 && now > raw.resetsAt + 60_000) return null
    return raw
  } catch {
    return null
  }
}

function writeDiskAgyQuota(cachePath, quota) {
  if (!cachePath || !quota) return
  try {
    atomicWriteJsonSync(cachePath, quota, { mode: 0o600 })
  } catch {}
}

/**
 * Fetch official Gemini weekly quota via Antigravity CLI's documented `--settings` `statusLine` JSON hook.
 * Runs `agy` briefly in a hidden pseudo-terminal without touching user's settings.json, terminates
 * immediately once the quota JSON arrives, and cleans up all temporary files.
 */
function fetchAntigravityQuotaViaStatusLine(agyBin, { timeoutMs = AGY_QUOTA_PROBE_TIMEOUT_MS, onSpawn } = {}) {
  if (!agyBin) return Promise.resolve(null)
  let workDir = ''
  try {
    workDir = mkdtempSync(join(tmpdir(), 'allinone-agy-quota-'))
  } catch {
    return Promise.resolve(null)
  }

  const captureJs = join(workDir, 'capture.mjs')
  const outJson = join(workDir, 'quota.json')
  const settingsJson = join(workDir, 'settings.json')

  const cleanup = () => {
    try { rmSync(workDir, { recursive: true, force: true }) } catch {}
  }

  try {
    writeFileSync(
      captureJs,
      [
        "import fs from 'node:fs'",
        "let s = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (d) => { s += d })",
        "process.stdin.on('end', () => {",
        '  try {',
        '    const o = JSON.parse(s)',
        '    if (o && o.quota && Object.keys(o.quota).length > 0) {',
        `      const tmp = ${JSON.stringify(outJson)} + '.tmp'`,
        "      fs.writeFileSync(tmp, s, 'utf8')",
        `      fs.renameSync(tmp, ${JSON.stringify(outJson)})`,
        '    }',
        '  } catch {}',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )

    let wrapperCmd = ''
    if (process.platform === 'win32') {
      const wrapperBat = join(workDir, 'capture.cmd')
      writeFileSync(
        wrapperBat,
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${captureJs}"\r\n`,
        'utf8',
      )
      wrapperCmd = wrapperBat
    } else {
      const wrapperSh = join(workDir, 'capture.sh')
      writeFileSync(
        wrapperSh,
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(captureJs)}\n`,
        { encoding: 'utf8', mode: 0o700 },
      )
      wrapperCmd = wrapperSh
    }

    writeFileSync(
      settingsJson,
      JSON.stringify({ statusLine: { type: 'command', command: wrapperCmd, enabled: true } }),
      'utf8',
    )
  } catch {
    cleanup()
    return Promise.resolve(null)
  }

  return new Promise((resolvePromise) => {
    let settled = false
    let proc = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      let result = null
      try {
        if (existsSync(outJson)) {
          const parsed = JSON.parse(readFileSync(outJson, 'utf8'))
          result = normalizeAntigravityQuota(parsed)
        }
      } catch {}
      cleanup()
      resolvePromise(result)
    }

    const hardTimer = setTimeout(() => {
      killProcessTree(proc, { force: true })
      finish()
    }, timeoutMs + 3_000)
    hardTimer.unref?.()

    try {
      if (process.platform === 'win32') {
        const ps1Path = join(workDir, 'run-pty.ps1')
        const ps1Body = [
          'param([string]$AgyBin, [string]$SettingsPath, [string]$OutPath, [int]$TimeoutMs)',
          'Add-Type -TypeDefinition @"',
          'using System;',
          'using System.Runtime.InteropServices;',
          'using System.Threading;',
          'using System.IO;',
          'public class AllInOneAgyConPty {',
          '  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }',
          '  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }',
          '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {',
          '    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;',
          '    public int dwX; public int dwY; public int dwXSize; public int dwYSize;',
          '    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;',
          '    public int dwFlags; public short wShowWindow; public short cbReserved2;',
          '    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;',
          '  }',
          '  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr sa, int size);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);',
          '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);',
          '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr hFile, byte[] buf, int toRead, out int read, IntPtr ov);',
          '  public static void Run(string cmdLine, string watchFile, int timeoutMs) {',
          '    IntPtr inR, inW, outR, outW, hPC;',
          '    if (!CreatePipe(out inR, out inW, IntPtr.Zero, 0)) return;',
          '    if (!CreatePipe(out outR, out outW, IntPtr.Zero, 0)) { CloseHandle(inR); CloseHandle(inW); return; }',
          '    COORD sz = new COORD { X = 120, Y = 30 };',
          '    if (CreatePseudoConsole(sz, inR, outW, 0, out hPC) != 0) { CloseHandle(inR); CloseHandle(inW); CloseHandle(outR); CloseHandle(outW); return; }',
          '    CloseHandle(inR); CloseHandle(outW);',
          '    Thread drain = new Thread(() => { byte[] b = new byte[4096]; int n; while (ReadFile(outR, b, b.Length, out n, IntPtr.Zero) && n > 0) {} });',
          '    drain.IsBackground = true; drain.Start();',
          '    IntPtr lpSize = IntPtr.Zero;',
          '    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);',
          '    IntPtr attrList = Marshal.AllocHGlobal(lpSize);',
          '    InitializeProcThreadAttributeList(attrList, 1, 0, ref lpSize);',
          '    UpdateProcThreadAttribute(attrList, 0, (IntPtr)0x00020016, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);',
          '    STARTUPINFOEX si = new STARTUPINFOEX();',
          '    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));',
          '    si.lpAttributeList = attrList;',
          '    PROCESS_INFORMATION pi;',
          '    if (CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x08000000, IntPtr.Zero, null, ref si, out pi)) {',
          '      int waited = 0;',
          '      while (waited < timeoutMs && !File.Exists(watchFile)) { Thread.Sleep(150); waited += 150; }',
          '      TerminateProcess(pi.hProcess, 0);',
          '      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);',
          '    }',
          '    DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList);',
          '    ClosePseudoConsole(hPC); CloseHandle(inW); CloseHandle(outR);',
          '  }',
          '}',
          '"@',
          '$cmd = "`"$AgyBin`" --settings `"$SettingsPath`""',
          '[AllInOneAgyConPty]::Run($cmd, $OutPath, $TimeoutMs)',
        ].join('\r\n')
        writeFileSync(ps1Path, ps1Body, 'utf8')
        proc = spawnCrossPlatform(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, agyBin, settingsJson, outJson, String(timeoutMs)],
          { stdio: 'ignore', windowsHide: true },
        )
      } else {
        const pyBin = findExecutable(['python3', 'python']) || 'python3'
        const pyRunner = join(workDir, 'run-pty.py')
        writeFileSync(
          pyRunner,
          [
            'import os, pty, select, signal, subprocess, sys, time',
            'def _on_term(_sig, _frame): raise SystemExit(0)',
            'signal.signal(signal.SIGTERM, _on_term)',
            'signal.signal(signal.SIGINT, _on_term)',
            'agy_bin, settings_path, out_path, timeout_ms = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])',
            'master_fd, slave_fd = pty.openpty()',
            'proc = subprocess.Popen([agy_bin, "--settings", settings_path], stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True, start_new_session=True)',
            'os.close(slave_fd)',
            'deadline = time.monotonic() + (timeout_ms / 1000.0)',
            'try:',
            '  while time.monotonic() < deadline and not os.path.exists(out_path) and proc.poll() is None:',
            '    r, _, _ = select.select([master_fd], [], [], 0.15)',
            '    if r:',
            '      try: os.read(master_fd, 4096)',
            '      except OSError: break',
            'finally:',
            '  try: os.killpg(proc.pid, signal.SIGTERM)',
            '  except Exception:',
            '    try: proc.terminate()',
            '    except Exception: pass',
            '  try: proc.wait(timeout=1.5)',
            '  except Exception:',
            '    try: os.killpg(proc.pid, signal.SIGKILL)',
            '    except Exception:',
            '      try: proc.kill()',
            '      except Exception: pass',
            '  try: os.close(master_fd)',
            '  except Exception: pass',
            '',
          ].join('\n'),
          'utf8',
        )
        proc = spawnCrossPlatform(
          pyBin,
          [pyRunner, agyBin, settingsJson, outJson, String(timeoutMs)],
          { stdio: 'ignore' },
        )
      }
      onSpawn?.(proc)
      proc.on('close', finish)
      proc.on('error', finish)
    } catch {
      finish()
    }
  })
}

function getTranscriptPathSafe(agyHome, conversationId) {
  const safeId = assertSafeSessionId(conversationId, 'Antigravity conversationId')
  const brainDir = join(agyHome, 'brain')
  return assertPathWithinDir(
    join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl'),
    brainDir,
    'Antigravity transcript',
  )
}

function getTranscriptFingerprint(agyHome, conversationId) {
  if (!conversationId) return { mtimeMs: 0, size: 0 }
  try {
    const st = statSync(getTranscriptPathSafe(agyHome, conversationId))
    return { mtimeMs: st.mtimeMs || 0, size: st.size || 0 }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

async function isAntigravityDesktopRunning(force = false) {
  const now = Date.now()
  if (!force && now - desktopProcCache.checkedAt < DESKTOP_PROC_CACHE_TTL_MS) {
    return desktopProcCache.running
  }
  const running = await new Promise((resolvePromise) => {
    let settled = false
    const done = (val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(Boolean(val))
    }
    let proc = null
    const timer = setTimeout(() => {
      if (proc) killProcessTree(proc, { force: true })
      done(false)
    }, 1_500)
    timer.unref?.()
    try {
      if (process.platform === 'win32') {
        proc = spawnCrossPlatform('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', () => done(/Antigravity\.exe/i.test(out)))
        proc.on('error', () => done(false))
      } else {
        const pattern = process.platform === 'darwin'
          ? 'Antigravity\\.app/Contents/'
          : 'antigravity.*language_server|/antigravity/antigravity'
        proc = spawnCrossPlatform('pgrep', ['-f', pattern], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', (code) => done(code === 0 && out.trim().length > 0))
        proc.on('error', () => done(false))
      }
    } catch {
      done(false)
    }
  })
  desktopProcCache = { running, checkedAt: Date.now() }
  return running
}

function computeAgyExternalRunning({ selfActive, desktopRunning, status, notFullyIdle, mtimeMs = 0, now = Date.now() }) {
  if (selfActive || !desktopRunning) return false
  if (status === 'CASCADE_RUN_STATUS_RUNNING') return true
  const recentlyModified = mtimeMs > 0 && now - mtimeMs < 90_000
  return Boolean(notFullyIdle && recentlyModified)
}

const AGY_SQLITE_PY_SCRIPT = [
  'import base64, json, pathlib, sqlite3, sys',
  'req = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))',
  'con = sqlite3.connect(pathlib.Path(req["dbPath"]).resolve().as_uri() + "?mode=ro", uri=True, timeout=2.0)',
  'try:',
  '    con.row_factory = sqlite3.Row',
  '    cur = con.execute(req["sql"], req.get("params") or [])',
  '    if req.get("single"):',
  '        row = cur.fetchone()',
  '        out = dict(row) if row else None',
  '    else:',
  '        out = [dict(r) for r in cur.fetchall()]',
  '    print(json.dumps(out))',
  'finally:',
  '    con.close()',
].join('\n')

/**
 * Shared read-only SQLite query helper for Antigravity's `conversation_summaries.db`.
 * Delegates to unified `queryReadOnlySqlite` (`node:sqlite` + Python `sqlite3` Electron fallback).
 */
async function runAgySqliteQuery(dbPath, { sql, params = [], single = false, fallbackValue = null }) {
  return queryReadOnlySqlite(dbPath, { sql, params, single, fallbackValue, timeoutMs: 3_000 })
}

async function queryAgyConversationState(dbPath, conversationId) {
  if (!conversationId) return null
  const row = await runAgySqliteQuery(dbPath, {
    sql: 'SELECT title, workspace_uris, status, not_fully_idle, step_count FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
    params: [conversationId],
    single: true,
    fallbackValue: null,
  })
  if (!row) return null
  return {
    title: String(row.title || '').trim(),
    cwd: parseWorkspaceUri(row.workspace_uris),
    status: String(row.status || ''),
    notFullyIdle: Boolean(row.not_fully_idle),
    stepCount: Number(row.step_count || 0),
  }
}

async function queryAgySummaryById(dbPath, conversationId) {
  if (!conversationId) return null
  return runAgySqliteQuery(dbPath, {
    sql: `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
          FROM conversation_summaries
          WHERE conversation_id = ? LIMIT 1`,
    params: [conversationId],
    single: true,
    fallbackValue: null,
  })
}

function getAgyHome() {
  return join(homedir(), '.gemini', AGY_APP_DATA_DIR)
}

function findAgyBinary(configuredBin) {
  const candidates = getAgyCandidates(homedir(), process.platform, process.env, configuredBin)
  if (process.platform === 'win32') {
    return findExecutable(['agy.exe', 'agy.cmd', 'agy'], candidates) || 'agy.exe'
  }
  return findExecutable(['agy'], candidates) || 'agy'
}

export function parseWorkspaceUri(raw) {
  if (!raw || typeof raw !== 'string') return ''
  let first = raw.trim()
  if (first.startsWith('[')) {
    try {
      const arr = JSON.parse(first)
      first = Array.isArray(arr) && arr[0] ? String(arr[0]) : ''
    } catch {}
  } else if (first.includes(',')) {
    first = first.split(',')[0].trim()
  }
  if (/^file:\/\//i.test(first)) {
    try {
      let decoded = decodeURIComponent(first.replace(/^file:\/\/(?:localhost)?/i, ''))
      if (process.platform === 'win32') {
        if (/^\/[a-zA-Z]:/.test(decoded)) decoded = decoded.slice(1)
        return decoded.replace(/\//g, '\\')
      }
      return decoded
    } catch {}
  }
  return first
}

/**
 * Query Antigravity's local SQLite conversation index read-only (top-level chats only).
 */
async function queryAgySummariesDb(dbPath, limit = 80, search = '') {
  let sql = `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
             FROM conversation_summaries
             WHERE nesting_depth = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = '')`
  const params = []
  if (search) {
    sql += ` AND (title LIKE ? OR preview LIKE ? OR workspace_uris LIKE ?)`
    const pattern = `%${search}%`
    params.push(pattern, pattern, pattern)
  }
  sql += ` ORDER BY last_modified_time DESC LIMIT ?`
  params.push(Number(limit) || 80)

  const rows = await runAgySqliteQuery(dbPath, {
    sql,
    params,
    single: false,
    fallbackValue: [],
  })
  return Array.isArray(rows) ? rows : []
}

/**
 * Parse an Antigravity `transcript.jsonl` payload safely.
 * Detects `step_index` regressions (split-brain writes when Antigravity Desktop resumes from
 * stale in-memory state after an external `agy acp` turn), isolates branch epochs so consecutive
 * assistant turns never fuse across branches, and guarantees globally unique message/tool IDs.
 */
export function parseAgyTranscriptContent(raw) {
  const messages = []
  const usedIds = new Set()
  const taskTracker = createTaskStateTracker()
  let maxStepIndex = -1
  let latestStepIndex = -1
  let branchEpoch = 0
  let divergence = null

  const lines = String(raw || '').split(/\r?\n/)
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const rawStep = obj.step_index
    const stepNum = rawStep !== undefined && rawStep !== null && Number.isFinite(Number(rawStep))
      ? Number(rawStep)
      : null
    const ts = toEpochMs(obj.created_at || Date.now())

    if (stepNum !== null) {
      if (maxStepIndex >= 0 && stepNum < maxStepIndex) {
        branchEpoch += 1
        divergence = {
          count: (divergence?.count || 0) + 1,
          lastFromStep: maxStepIndex,
          lastToStep: stepNum,
          lastAt: ts,
        }
        maxStepIndex = stepNum
      } else if (stepNum > maxStepIndex) {
        maxStepIndex = stepNum
      }
      latestStepIndex = stepNum
    }

    const mediaImages = Array.isArray(obj.media)
      ? obj.media
          .filter((m) => m && m.uri && (!m.mime_type || String(m.mime_type).startsWith('image/')))
          .map((m) => ({ path: m.uri, name: basename(String(m.uri)) }))
      : []

    const makeUniqueId = (roleChar) => {
      const stepPart = stepNum !== null ? String(stepNum) : String(messages.length)
      const baseId = branchEpoch > 0 ? `agy-${roleChar}-b${branchEpoch}-${stepPart}` : `agy-${roleChar}-${stepPart}`
      let candidate = baseId
      if (usedIds.has(candidate)) {
        candidate = `${baseId}-l${lineIdx}`
      }
      usedIds.add(candidate)
      return candidate
    }

    if (obj.type === 'USER_INPUT') {
      let text = String(obj.content || '').trim()
      // Unwrap Antigravity's internal <USER_REQUEST> wrapper if present in raw transcript logs
      const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
      if (reqMatch) text = reqMatch[1].trim()
      if (text) taskTracker.applyAntigravityUserText(text, ts)
      if (text || mediaImages.length > 0) {
        messages.push({
          id: makeUniqueId('u'),
          role: 'user',
          text,
          ...(mediaImages.length > 0 ? { images: mediaImages } : {}),
          branchEpoch,
          ts,
        })
      }
    } else if (obj.type === 'PLANNER_RESPONSE') {
      const text = String(obj.content || '').trim()
      const thinking = String(obj.thinking || '').trim()
      const tools = Array.isArray(obj.tool_calls)
        ? obj.tool_calls.map((tc, idx) => {
            const toolName = tc.name || tc.tool || 'tool'
            const toolInput = tc.args ?? tc.arguments ?? {}
            taskTracker.applyAntigravityTool(toolName, toolInput, ts)
            return {
              id: tc.id || (branchEpoch > 0 ? `agy-t-b${branchEpoch}-${obj.step_index}-${idx}` : `agy-t-${obj.step_index}-${idx}`),
              name: toolName,
              input: toolInput,
              status: 'completed',
              output: '',
            }
          })
        : []
      if (text || thinking || tools.length > 0 || mediaImages.length > 0) {
        messages.push({
          id: makeUniqueId('a'),
          role: 'assistant',
          text,
          thinking: thinking || undefined,
          tools: tools.length > 0 ? tools : undefined,
          ...(mediaImages.length > 0 ? { images: mediaImages } : {}),
          branchEpoch,
          ts,
        })
      }
    }
  }

  return {
    messages: mergeAndCompactMessages(messages),
    divergence,
    latestStepIndex,
    branchEpoch,
    taskState: taskTracker.snapshot(),
  }
}

const AGY_MAX_FULL_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const AGY_TAIL_TRANSCRIPT_BYTES = 4 * 1024 * 1024

function parseDesktopTranscript(conversationId, agyHome = getAgyHome()) {
  const transcriptPath = getTranscriptPathSafe(agyHome, conversationId)
  if (!existsSync(transcriptPath)) {
    return { messages: [], divergence: null, latestStepIndex: -1, branchEpoch: 0, taskState: null }
  }
  return transcriptCache.getOrParse(transcriptPath, () => {
    const st = statSync(transcriptPath)
    if (st.size > AGY_MAX_FULL_TRANSCRIPT_BYTES) {
      const fd = openSync(transcriptPath, 'r')
      try {
        const readLen = Math.min(st.size, AGY_TAIL_TRANSCRIPT_BYTES)
        const startOffset = Math.max(0, st.size - readLen)
        const buf = Buffer.alloc(readLen)
        const bytesRead = readSync(fd, buf, 0, readLen, startOffset)
        const rawTail = buf.subarray(0, bytesRead).toString('utf8')
        const firstNl = startOffset > 0 ? rawTail.indexOf('\n') : -1
        const safeTail = firstNl !== -1 ? rawTail.slice(firstNl + 1) : rawTail
        return parseAgyTranscriptContent(safeTail)
      } finally {
        closeSync(fd)
      }
    }
    const raw = readFileSync(transcriptPath, 'utf8')
    return parseAgyTranscriptContent(raw)
  })
}

function extractAcpText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content.text === 'string') return content.text
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c?.type === 'text' && typeof c.text === 'string') return c.text
        if (c?.content?.type === 'text' && typeof c.content.text === 'string') return c.content.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Warm-pooled Agent Client Protocol (ACP) JSON-RPC client for official `agy acp`.
 * Uses `--app-data-dir antigravity` so mobile and Antigravity Desktop share the EXACT SAME
 * conversation store, trajectory UUIDs, and server-side prompt cache (`cachedReadTokens`)
 * with ZERO handoff prompts and ZERO extra tokens.
 *
 * Keeps the ACP worker alive while background tasks / subagents / timers are active
 * (`not_fully_idle = 1`) so reactive wakeups complete uninterrupted and stream live to mobile!
 */
class AgyAcpClient {
  constructor({ agyBin, cwd, autoApprove = true, log = console, onSessionUpdate, onServerRequest, onExit }) {
    this.agyBin = agyBin
    this.cwd = cwd
    this.autoApprove = autoApprove
    this.log = log
    this.onSessionUpdate = onSessionUpdate || null
    this.onServerRequest = onServerRequest || null
    this.onExit = onExit || null
    this.transport = null
  }

  get proc() {
    return this.transport?.proc || null
  }

  get closing() {
    return Boolean(this.transport?.closing)
  }

  isAlive() {
    return Boolean(this.transport?.isAlive())
  }

  setSessionUpdateHandler(fn) {
    this.onSessionUpdate = fn || null
  }

  setServerRequestHandler(fn) {
    this.onServerRequest = fn || null
  }

  touchSlidingTimeouts() {
    this.transport?.touchSlidingTimeouts()
  }

  async start() {
    const args = ['acp', '--app-data-dir', AGY_APP_DATA_DIR]
    if (this.autoApprove) args.push('--dangerously-skip-permissions')

    this.transport = new JsonRpcStdioClient({
      bin: this.agyBin,
      args,
      cwd: this.cwd,
      label: 'Antigravity ACP',
      maxStderrChars: 4096,
      log: this.log,
      onNotification: (method, params) => {
        if (method === 'session/update') {
          this.onSessionUpdate?.(params || {})
        }
      },
      onServerRequest: (_t, msg) => {
        if (this.onServerRequest) {
          this.onServerRequest(this, msg)
          return
        }
        if (msg.method === 'session/request_permission' && this.autoApprove) {
          const opts = msg.params?.options || []
          const allow = opts.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') || opts[0]
          this.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } },
          })
        } else {
          this.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
          })
        }
      },
      onExit: ({ code }) => {
        try { this.onExit?.(code, this) } catch {}
      },
    })
    this.transport.spawnProcess()

    await this.rpc(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
      25_000,
    )
  }

  sendRaw(obj) {
    if (!this.transport) throw new Error('agy acp 未运行')
    this.transport.sendRaw(obj)
  }

  notify(method, params = {}) {
    this.transport?.notify(method, params)
  }

  rpc(method, params = {}, timeoutMs = 600_000, { sliding = false } = {}) {
    if (!this.transport) return Promise.reject(new Error('agy acp 未运行'))
    return this.transport.callRaw(method, params, timeoutMs, { sliding })
  }

  async close(sessionId) {
    if (!this.transport) return
    await this.transport.closeGracefully({
      graceMs: 500,
      forceAfterMs: 400,
      preClose: sessionId ? () => this.rpc('session/close', { sessionId }, 3_000).catch(() => {}) : null,
    })
  }

  killImmediate() {
    this.transport?.killImmediate('agy acp disposed')
  }
}

/**
 * Zero-invasion Antigravity Adapter backed by official `agy acp --app-data-dir antigravity`.
 */
export class AntigravityAdapter extends BaseAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest }) {
    super(APPS.ANTIGRAVITY, {
      config,
      log,
      emitEvent,
      onApprovalRequest,
      capabilities: {
        supportsApproval: true,
        supportsMidChatSwitch: true,
        supportsQuota: true,
      },
    })
    this.agyHome = String(config.agyHome || '').trim() || getAgyHome()
    this.configuredBin = config.agyBin
    this.agyBin = findAgyBinary(this.configuredBin)
    this.defaultCwd = config.cwd || process.cwd()
    this.autoApprove = config.agyAutoApprove !== false
    this.pendingServerRequests = new Map() // approvalId -> { client, rpcId, method, sessionId, params }
    this.activeTurns = new Map() // conversationId -> { client, aborted }
    this.warmSessions = new Map() // conversationId -> warm entry keeping background tasks alive
    this.startingWarmSessions = new Map() // conversationId -> Promise<entry> deduplicating concurrent acquireWarmSession
    this.startingClients = new Set() // in-flight AgyAcpClient instances before warmSessions registration
    this.bridgeWrittenSessions = new BoundedLruMap(128) // conversationId -> { writtenAt, stepCount }
    this.watchedSessions = new BoundedLruMap(MAX_WATCHED_SESSIONS)
    this.watchPollIntervalMs = Math.max(200, Number(config.watchPollIntervalMs) || WATCH_POLL_INTERVAL_MS)
    this.watchTimer = null
    this.watchPollInFlight = false
    this.reapingInFlight = false
    this.cliVersionCache = null
    this.modelsCache = null
    this.modelsCacheAt = 0
    this.quotaCachePath = config.agyQuotaCachePath || getAgyQuotaCachePath()
    this.quotaCache = readDiskAgyQuota(this.quotaCachePath)
    this.quotaCacheAt = this.quotaCache?.updatedAt || 0
    this.quotaRefreshInFlight = null
    this.activeQuotaProcs = new Set()
    this.disableQuotaProbe = Boolean(config.disableAgyQuotaProbe)
    this.reaperTimer = null
  }

  refreshBinary() {
    this.agyBin = findAgyBinary(this.configuredBin)
    this.cliVersionCache = null
    this.modelsCache = null
    this.modelsCacheAt = 0
    return this.agyBin
  }

  parseModelPairs(pairs = []) {
    const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
    const familyMap = new Map()
    const familyOrder = []

    for (const { id: rawId, label: rawLabel } of pairs) {
      const id = String(rawId || '').trim()
      if (!id) continue
      const label = String(rawLabel || '').trim()
      const m = id.match(/^(.+)-(low|medium|high|xhigh|max)$/i)
      if (m) {
        const baseId = m[1]
        const eff = m[2].toLowerCase()
        const cleanName = (label || baseId).replace(/\s*\((Low|Medium|High|XHigh|Max)\)\s*$/i, '').trim()
        let entry = familyMap.get(baseId)
        if (!entry) {
          entry = { id: baseId, name: cleanName, efforts: [], effortModelIds: {}, defaultEffort: '' }
          familyMap.set(baseId, entry)
          familyOrder.push(baseId)
        }
        if (!entry.efforts.includes(eff)) entry.efforts.push(eff)
        entry.effortModelIds[eff] = id
      } else {
        if (!familyMap.has(id)) {
          familyMap.set(id, { id, name: label || id, efforts: [], effortModelIds: {}, defaultEffort: '' })
          familyOrder.push(id)
        }
      }
    }

    return familyOrder.map((key) => {
      const e = familyMap.get(key)
      e.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
      e.defaultEffort = e.efforts.includes('high')
        ? 'high'
        : e.efforts.includes('medium')
          ? 'medium'
          : e.efforts[0] || ''
      return e
    })
  }

  async listModelsViaAcpFallback() {
    if (this.disposed) return []
    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: this.defaultCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })
    this.startingClients.add(client)
    let sessionId = ''
    try {
      await client.start()
      if (this.disposed) return []
      const res = await client.rpc('session/new', { cwd: this.defaultCwd, mcpServers: [] }, 15_000)
      if (this.disposed) return []
      sessionId = res?.sessionId || ''
      const raw = res?.models?.availableModels || res?.availableModels || []
      return raw
        .map((m) => ({
          id: m?.modelId || m?.id || '',
          label: m?.name || m?.displayName || m?.modelId || '',
        }))
        .filter((x) => x.id)
    } catch (err) {
      if (!this.disposed) {
        this.log.warn?.(`mobile-hub: agy ACP model fallback failed: ${String(err?.message || err)}`)
      }
      return []
    } finally {
      this.startingClients.delete(client)
      await client.close(sessionId).catch(() => {})
    }
  }

  async listModels() {
    if (this.modelsCache && this.modelsCache.models?.length > 0 && Date.now() - this.modelsCacheAt < 5 * 60_000) {
      return this.modelsCache
    }
    const cliVer = await this.checkCliVersion()
    if (!cliVer) {
      return {
        app: APPS.ANTIGRAVITY,
        defaultModel: '',
        defaultEffort: '',
        supportsMidChatSwitch: false,
        models: [],
        hint: process.platform === 'win32'
          ? '需先安装 Antigravity CLI (irm https://antigravity.google/cli/install.ps1 | iex)'
          : '需先安装 Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash)',
      }
    }

    const rawText = await new Promise((resolvePromise) => {
      let settled = false
      const done = (val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(val)
      }
      let proc = null
      const timer = setTimeout(() => {
        if (proc) killProcessTree(proc, { force: true })
        done('')
      }, 15_000)
      timer.unref?.()
      try {
        proc = spawnCrossPlatform(this.agyBin, ['models'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        this.trackChildProcess(proc)
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', () => done(out))
        proc.on('error', () => done(''))
      } catch {
        done('')
      }
    })

    const cliPairs = []
    for (const rawLine of rawText.split(/\r?\n/)) {
      // Strip any ANSI escape codes or carriage-return spinner fragments
      const cleaned = rawLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\r').pop() || ''
      const trimmed = cleaned.trim()
      if (!trimmed || /^fetching\b/i.test(trimmed)) continue
      const cols = trimmed.includes('\t')
        ? trimmed.split('\t').map((s) => s.trim()).filter(Boolean)
        : trimmed.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
      if (cols.length >= 2 && /^[a-z0-9._-]+$/i.test(cols[0])) {
        cliPairs.push({ id: cols[0], label: cols.slice(1).join(' ') })
      }
    }

    let models = this.parseModelPairs(cliPairs)
    if (models.length === 0) {
      // Fallback: query models directly from Desktop's shared `--app-data-dir antigravity` ACP auth!
      const acpPairs = await this.listModelsViaAcpFallback()
      models = this.parseModelPairs(acpPairs)
    }

    const catalog = {
      app: APPS.ANTIGRAVITY,
      defaultModel: models[0]?.id || '',
      defaultEffort: models[0]?.defaultEffort || '',
      supportsMidChatSwitch: models.length > 0,
      models,
    }
    if (models.length > 0) {
      this.modelsCache = catalog
      this.modelsCacheAt = Date.now()
    }
    return catalog
  }

  async resolveAcpModelId(model, reasoningEffort) {
    if (!model) return ''
    try {
      const catalog = await this.listModels()
      const matched = catalog.models.find((m) => m.id === model)
      if (matched && reasoningEffort && matched.effortModelIds?.[reasoningEffort]) {
        return matched.effortModelIds[reasoningEffort]
      }
      if (matched && matched.defaultEffort && matched.effortModelIds?.[matched.defaultEffort]) {
        return matched.effortModelIds[matched.defaultEffort]
      }
    } catch {}
    return model
  }

  async checkCliVersion() {
    if (this.cliVersionCache) return this.cliVersionCache
    this.agyBin = findAgyBinary(this.configuredBin)
    const ver = await new Promise((resolvePromise) => {
      let settled = false
      const done = (val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(val)
      }
      let proc = null
      const timer = setTimeout(() => {
        if (proc) killProcessTree(proc, { force: true })
        done('')
      }, 6_000)
      timer.unref?.()
      try {
        proc = spawnCrossPlatform(this.agyBin, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        this.trackChildProcess(proc)
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', (code) => done(code === 0 ? out.trim() : ''))
        proc.on('error', () => done(''))
      } catch {
        done('')
      }
    })
    if (ver) this.cliVersionCache = ver
    return ver
  }

  getValidQuota(now = Date.now()) {
    if (!this.quotaCache) return null
    if (this.quotaCache.resetsAt > 0 && now > this.quotaCache.resetsAt + 60_000) {
      this.quotaCache = null
      return null
    }
    return this.quotaCache
  }

  refreshQuotaInBackground({ force = false } = {}) {
    if (this.disposed || this.disableQuotaProbe) return Promise.resolve(this.getValidQuota())
    const now = Date.now()
    if (!force && this.quotaCache && Array.isArray(this.quotaCache.pools) && this.quotaCacheAt > 0 && now - this.quotaCacheAt < AGY_QUOTA_CACHE_TTL_MS) {
      return Promise.resolve(this.getValidQuota(now))
    }
    if (this.quotaRefreshInFlight) return this.quotaRefreshInFlight
    const bin = this.agyBin || findAgyBinary(this.configuredBin)
    if (!bin) return Promise.resolve(this.getValidQuota(now))

    let spawnedProc = null
    const p = fetchAntigravityQuotaViaStatusLine(bin, {
      onSpawn: (proc) => {
        spawnedProc = proc
        if (this.disposed) {
          killProcessTree(proc, { force: true })
          return
        }
        this.activeQuotaProcs.add(proc)
      },
    })
      .then((fresh) => {
        if (this.disposed) return null
        this.quotaCacheAt = Date.now()
        if (fresh) {
          this.quotaCache = fresh
          writeDiskAgyQuota(this.quotaCachePath, fresh)
          this.emitEvent(EVENTS.BRIDGE_STATUS, {
            type: 'quota.updated',
            app: APPS.ANTIGRAVITY,
            quota: fresh,
          })
        }
        return this.getValidQuota()
      })
      .catch(() => this.getValidQuota())
      .finally(() => {
        if (spawnedProc) this.activeQuotaProcs.delete(spawnedProc)
        if (this.quotaRefreshInFlight === p) {
          this.quotaRefreshInFlight = null
        }
      })
    this.quotaRefreshInFlight = p
    return p
  }

  async getStatus(opts = {}) {
    const dbExists = existsSync(join(this.agyHome, 'conversation_summaries.db'))
    const cliVer = await this.checkCliVersion()
    const writable = Boolean(cliVer)
    const quota = this.getValidQuota()
    if (writable) {
      // Refresh Gemini weekly + 5h quota non-blockingly in background; emits E2EE BRIDGE_STATUS once ready
      void this.refreshQuotaInBackground({ force: Boolean(opts?.forceQuota) })
    }
    return {
      app: APPS.ANTIGRAVITY,
      available: dbExists || writable,
      writable,
      mode: writable ? 'agy-acp-shared' : 'desktop-history-readonly',
      detail: writable
        ? `已直连 Antigravity 官方 ACP (v${cliVer})，与桌面端原生共享同一会话与缓存（零额外 Token）`
        : '仅支持 Antigravity 桌面端历史浏览；安装官方 Antigravity CLI (`agy`) 后即可原位续聊',
      activeCount: this.activeTurns.size,
      ...(quota ? { quota } : {}),
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const results = []
    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const [cliVer, rows, desktopRunning] = await Promise.all([
      this.checkCliVersion(),
      queryAgySummariesDb(dbPath, limit, search),
      isAntigravityDesktopRunning(),
    ])
    const cliReady = Boolean(cliVer)
    const seen = new Set()
    const now = Date.now()

    for (const r of rows) {
      seen.add(r.conversation_id)
      const cwd = parseWorkspaceUri(r.workspace_uris)
      const pref = this.sessionPrefs.get(r.conversation_id)
      const warmEntry = this.warmSessions.get(r.conversation_id)
      const selfActive = this.activeTurns.has(r.conversation_id) || Boolean(warmEntry?.wakeup)
      let mtimeMs = toEpochMs(r.last_modified_time)
      if (!selfActive && desktopRunning && Boolean(r.not_fully_idle)) {
        const fp = getTranscriptFingerprint(this.agyHome, r.conversation_id)
        if (fp.mtimeMs > mtimeMs) mtimeMs = fp.mtimeMs
      }
      const externalRunning = computeAgyExternalRunning({
        selfActive,
        desktopRunning,
        status: String(r.status || ''),
        notFullyIdle: Boolean(r.not_fully_idle),
        mtimeMs,
        now,
      })
      results.push({
        id: makeCompositeId(APPS.ANTIGRAVITY, r.conversation_id),
        app: APPS.ANTIGRAVITY,
        nativeId: r.conversation_id,
        title: (r.title && r.title.trim()) || (r.preview && r.preview.trim().slice(0, 56)) || r.conversation_id,
        preview: String(r.preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        cwd,
        workspace: cwd ? basename(cwd) : 'Antigravity',
        model: pref?.model || '',
        reasoningEffort: pref?.reasoningEffort || '',
        status: selfActive || externalRunning ? 'running' : 'idle',
        syncState: { externalRunning },
        writable: cliReady,
        createdAt: toEpochMs(r.last_modified_time),
        updatedAt: toEpochMs(r.last_modified_time),
      })
    }

    // Include brand-new mobile-created ACP conversations not yet indexed into conversation_summaries.db
    for (const pending of this.pendingCreated.values()) {
      if (seen.has(pending.nativeId)) {
        this.pendingCreated.delete(pending.nativeId)
        continue
      }
      if (search) {
        const q = search.toLowerCase()
        const hay = `${pending.title} ${pending.cwd}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      results.push({
        ...pending,
        status: this.activeTurns.has(pending.nativeId) ? 'running' : 'idle',
        syncState: { externalRunning: false },
      })
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt)
    return results.slice(0, limit)
  }

  async readSession(conversationId, { limit = 25, cursor = null } = {}) {
    conversationId = assertSafeSessionId(conversationId, 'Antigravity conversationId')
    const cliReady = Boolean(await this.checkCliVersion())
    const pageSize = Math.max(10, Math.min(Number(limit) || 25, 200))

    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const [meta, desktopRunning] = await Promise.all([
      queryAgySummaryById(dbPath, conversationId),
      isAntigravityDesktopRunning(),
    ])
    const pending = this.pendingCreated.get(conversationId)
    const parsed = parseDesktopTranscript(conversationId, this.agyHome)
    const messages = parsed.messages
    const cwd = parseWorkspaceUri(meta?.workspace_uris) || pending?.cwd || ''
    const pref = this.sessionPrefs.get(conversationId)
    const fp = getTranscriptFingerprint(this.agyHome, conversationId)

    const warmEntry = this.warmSessions.get(conversationId)
    const selfActive = this.activeTurns.has(conversationId) || Boolean(warmEntry?.wakeup)
    const externalRunning = computeAgyExternalRunning({
      selfActive,
      desktopRunning,
      status: String(meta?.status || ''),
      notFullyIdle: Boolean(meta?.not_fully_idle),
      mtimeMs: fp.mtimeMs,
    })
    const bridgeWritten = this.bridgeWrittenSessions.get(conversationId) || null
    const bridgeWrittenWithDesktopOpen = Boolean(bridgeWritten && desktopRunning)
    const diverged = Boolean(parsed.divergence)

    let syncWarning = ''
    if (diverged) {
      syncWarning =
        '检测到该对话曾发生桌面端与远程端双写分叉（已保留双方完整记录）。如需切回 Antigravity 桌面端续聊，请先重启桌面端以避免旧内存再次覆盖。'
    } else if (bridgeWrittenWithDesktopOpen) {
      syncWarning =
        '已通过 All in One 续聊本对话。Antigravity 桌面端不会热重载外部写入，如需切回桌面端继续聊，请先重启 Antigravity 桌面端。'
    }

    const title = meta?.title || pending?.title || conversationId
    const status = selfActive || externalRunning ? 'running' : 'idle'

    this.watchSession(conversationId, {
      title,
      cwd,
      cliReady,
      fp,
      status: String(meta?.status || ''),
      notFullyIdle: Boolean(meta?.not_fully_idle),
      stepCount: Number(meta?.step_count || 0),
      externalRunning,
    })

    const total = messages.length
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)

    const liveTaskState = selfActive && warmEntry?.taskTracker ? warmEntry.taskTracker.snapshot() : null
    const taskState = liveTaskState || parsed.taskState || null

    return {
      id: makeCompositeId(APPS.ANTIGRAVITY, conversationId),
      app: APPS.ANTIGRAVITY,
      nativeId: conversationId,
      title,
      cwd,
      workspace: cwd ? basename(cwd) : 'Antigravity',
      model: pref?.model || '',
      reasoningEffort: pref?.reasoningEffort || '',
      writable: cliReady,
      status,
      taskState,
      syncState: {
        externalRunning,
        desktopRunning,
        diverged,
        divergence: parsed.divergence,
        bridgeWrittenWithDesktopOpen,
        latestStepIndex: parsed.latestStepIndex,
      },
      ...(syncWarning ? { syncWarning } : {}),
      messages: messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
    }
  }

  watchSession(conversationId, snapshot = {}) {
    if (!conversationId) return
    const fp = snapshot.fp || getTranscriptFingerprint(this.agyHome, conversationId)
    const existing = this.watchedSessions.get(conversationId)
    this.watchedSessions.delete(conversationId)
    this.watchedSessions.set(conversationId, {
      conversationId,
      lastSeenAt: Date.now(),
      mtimeMs: fp.mtimeMs,
      size: fp.size,
      status: snapshot.status ?? existing?.status ?? '',
      notFullyIdle: snapshot.notFullyIdle ?? existing?.notFullyIdle ?? false,
      stepCount: snapshot.stepCount ?? existing?.stepCount ?? 0,
      externalRunning: snapshot.externalRunning ?? existing?.externalRunning ?? false,
      title: snapshot.title || existing?.title || conversationId,
      cwd: snapshot.cwd || existing?.cwd || '',
      cliReady: snapshot.cliReady ?? existing?.cliReady ?? true,
    })
    while (this.watchedSessions.size > MAX_WATCHED_SESSIONS) {
      const oldest = this.watchedSessions.keys().next().value
      if (!oldest) break
      this.watchedSessions.delete(oldest)
    }
    this.ensureWatcherRunning()
  }

  updateWatchSnapshot(conversationId, { fp = null, dbState = null } = {}) {
    const w = this.watchedSessions.get(conversationId)
    if (!w) return
    const nextFp = fp || getTranscriptFingerprint(this.agyHome, conversationId)
    w.mtimeMs = nextFp.mtimeMs
    w.size = nextFp.size
    if (dbState) {
      w.status = String(dbState.status || '')
      w.notFullyIdle = Boolean(dbState.notFullyIdle)
      w.stepCount = Number(dbState.stepCount || 0)
    }
    w.lastSeenAt = Date.now()
  }

  ensureWatcherRunning() {
    if (this.disposed || this.watchTimer || this.watchedSessions.size === 0) return
    this.watchTimer = setInterval(() => {
      void this.pollWatchedSessions().catch(() => {})
    }, this.watchPollIntervalMs)
    this.watchTimer.unref?.()
  }

  async pollWatchedSessions() {
    if (this.watchPollInFlight) return
    if (this.watchedSessions.size === 0) {
      if (this.watchTimer) {
        clearInterval(this.watchTimer)
        this.watchTimer = null
      }
      return
    }
    this.watchPollInFlight = true
    try {
      const now = Date.now()
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      const desktopRunning = await isAntigravityDesktopRunning()
      for (const [sid, w] of [...this.watchedSessions.entries()]) {
        if (now - w.lastSeenAt > WATCH_TTL_MS) {
          this.watchedSessions.delete(sid)
          continue
        }
        if (this.activeTurns.has(sid) || this.warmSessions.get(sid)?.wakeup) {
          // Bridge is actively streaming this session itself; keep snapshot aligned without echoing
          const curFp = getTranscriptFingerprint(this.agyHome, sid)
          w.mtimeMs = curFp.mtimeMs
          w.size = curFp.size
          w.externalRunning = false
          continue
        }

        const curFp = getTranscriptFingerprint(this.agyHome, sid)
        const dbState = await queryAgyConversationState(dbPath, sid)
        const nextStatus = String(dbState?.status || '')
        const nextNotIdle = Boolean(dbState?.notFullyIdle)
        const nextStepCount = Number(dbState?.stepCount || 0)
        const nextTitle = dbState?.title || w.title
        const nextCwd = dbState?.cwd || w.cwd
        const externalRunning = computeAgyExternalRunning({
          selfActive: false,
          desktopRunning,
          status: nextStatus,
          notFullyIdle: nextNotIdle,
          mtimeMs: curFp.mtimeMs,
          now,
        })

        const fileChanged = curFp.size !== w.size || curFp.mtimeMs !== w.mtimeMs
        const metaChanged = nextTitle !== w.title || nextCwd !== w.cwd
        const statusChanged =
          nextStatus !== w.status ||
          nextNotIdle !== w.notFullyIdle ||
          nextStepCount !== w.stepCount ||
          externalRunning !== Boolean(w.externalRunning)

        if (!fileChanged && !statusChanged && !metaChanged) continue

        w.mtimeMs = curFp.mtimeMs
        w.size = curFp.size
        w.status = nextStatus
        w.notFullyIdle = nextNotIdle
        w.stepCount = nextStepCount
        w.externalRunning = externalRunning
        w.title = nextTitle
        w.cwd = nextCwd

        const pref = this.sessionPrefs.get(sid)
        const latestTaskState = fileChanged ? parseDesktopTranscript(sid, this.agyHome).taskState : undefined
        this.emitEvent(EVENTS.SESSION_UPDATED, {
          historyChanged: fileChanged,
          statusChanged,
          externalUpdate: true,
          session: {
            id: makeCompositeId(APPS.ANTIGRAVITY, sid),
            app: APPS.ANTIGRAVITY,
            nativeId: sid,
            title: w.title,
            cwd: w.cwd,
            workspace: w.cwd ? basename(w.cwd) : 'Antigravity',
            model: pref?.model || '',
            reasoningEffort: pref?.reasoningEffort || '',
            status: externalRunning ? 'running' : 'idle',
            ...(latestTaskState !== undefined ? { taskState: latestTaskState } : {}),
            syncState: { externalRunning },
            writable: w.cliReady,
            updatedAt: curFp.mtimeMs || now,
          },
        })
      }

      if (this.watchedSessions.size === 0 && this.watchTimer) {
        clearInterval(this.watchTimer)
        this.watchTimer = null
      }
    } finally {
      this.watchPollInFlight = false
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
    const cliVer = await this.checkCliVersion()
    if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
    if (!cliVer) {
      throw new Error(
        process.platform === 'win32'
          ? '本机未检测到 Antigravity CLI（请运行 irm https://antigravity.google/cli/install.ps1 | iex 安装）'
          : '本机未检测到 Antigravity CLI（请运行 curl -fsSL https://antigravity.google/cli/install.sh | bash 安装）',
      )
    }
    const targetCwd = String(cwd || '').trim() && existsSync(String(cwd).trim())
      ? String(cwd).trim()
      : this.defaultCwd

    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: targetCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })
    this.startingClients.add(client)

    let sessionId = ''
    const entry = this.registerWarmSession('', targetCwd, client, { starting: true, addToMap: false })
    try {
      await client.start()
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      const res = await client.rpc('session/new', { cwd: targetCwd, mcpServers: [] }, 25_000)
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      sessionId = res?.sessionId || ''
      if (!sessionId) throw new Error('Antigravity ACP 未返回有效 sessionId')

      entry.sessionId = sessionId
      entry.currentModeId = String(res?.modes?.currentModeId || 'default')
      entry.taskTracker = createTaskStateTracker(entry.currentModeId === 'plan' ? { mode: 'plan' } : null)
      entry.lastActivityAt = Date.now()

      if (model || reasoningEffort) {
        this.sessionPrefs.set(sessionId, { model: model || '', reasoningEffort: reasoningEffort || '' })
        const resolvedModel = await this.resolveAcpModelId(model, reasoningEffort)
        if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
        if (resolvedModel) {
          await client.rpc('session/set_model', { sessionId, modelId: resolvedModel }, 10_000).catch((err) => {
            this.log.warn?.(`mobile-hub: agy session/set_model(${resolvedModel}) failed: ${String(err?.message || err)}`)
          })
          if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
        }
      }
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      entry.starting = false
      entry.lastActivityAt = Date.now()
      this.warmSessions.set(sessionId, entry)
      this.ensureReaperRunning()
    } catch (err) {
      entry.starting = false
      if (sessionId && this.warmSessions.get(sessionId) === entry) {
        this.warmSessions.delete(sessionId)
      }
      await client.close(sessionId).catch(() => {})
      throw err
    } finally {
      this.startingClients.delete(client)
    }

    const now = Date.now()
    const summary = {
      id: makeCompositeId(APPS.ANTIGRAVITY, sessionId),
      app: APPS.ANTIGRAVITY,
      nativeId: sessionId,
      title: title || '新 Antigravity 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd),
      model: model || '',
      reasoningEffort: reasoningEffort || '',
      status: 'idle',
      writable: true,
      createdAt: now,
      updatedAt: now,
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  registerWarmSession(sessionId, cwd, client, { starting = false, addToMap = true } = {}) {
    const fp = getTranscriptFingerprint(this.agyHome, sessionId)
    const entry = {
      sessionId,
      cwd,
      client,
      starting: Boolean(starting),
      fgTurn: null,
      wakeup: null,
      currentModeId: 'default',
      taskTracker: null,
      lastActivityAt: Date.now(),
      lastTranscriptMtimeMs: fp.mtimeMs,
      lastTranscriptSize: fp.size,
      lastStepCount: 0,
      sawBackgroundTask: false,
    }
    client.setSessionUpdateHandler((params) => this.handleWarmSessionUpdate(entry, params))
    client.setServerRequestHandler((c, msg) => this.handleServerRequest(entry, c, msg))
    client.onExit = () => {
      this.clearPendingForClient(client)
      if (entry.wakeup?.settleTimer) clearTimeout(entry.wakeup.settleTimer)
      if (entry.wakeup) {
        const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          nativeId: entry.sessionId,
          finalText: entry.wakeup.finalText.trim(),
          aborted: false,
        })
        entry.wakeup = null
      }
      if (entry.sessionId && this.warmSessions.get(entry.sessionId) === entry) {
        this.warmSessions.delete(entry.sessionId)
      }
    }
    if (addToMap && sessionId) this.warmSessions.set(sessionId, entry)
    return entry
  }

  ensureReaperRunning() {
    if (this.disposed || this.reaperTimer) return
    this.reaperTimer = setInterval(() => {
      void this.reapIdleSessions().catch(() => {})
    }, 30_000)
    this.reaperTimer.unref?.()
  }

  hasPendingServerRequest(sessionId) {
    for (const item of this.pendingServerRequests.values()) {
      if (item.sessionId === sessionId) return true
    }
    return false
  }

  isWarmEntrySafeToClose(sid, expectedEntry = null) {
    const cur = this.warmSessions.get(sid)
    if (!cur) return false
    if (expectedEntry && cur !== expectedEntry) return false
    if (cur.starting || cur.fgTurn || cur.wakeup || this.activeTurns.has(sid)) return false
    if (this.startingWarmSessions.has(sid) || this.hasPendingServerRequest(sid)) return false
    return true
  }

  async closeWarmSession(sessionId, expectedEntry = null) {
    const entry = this.warmSessions.get(sessionId)
    if (!entry) return
    if (expectedEntry && entry !== expectedEntry) return
    this.warmSessions.delete(sessionId)
    if (entry.wakeup?.settleTimer) {
      clearTimeout(entry.wakeup.settleTimer)
      entry.wakeup.settleTimer = null
    }
    await entry.client.close(sessionId).catch(() => {})
  }

  async reapIdleSessions() {
    if (this.reapingInFlight) return
    if (this.warmSessions.size === 0) {
      if (this.reaperTimer) {
        clearInterval(this.reaperTimer)
        this.reaperTimer = null
      }
      return
    }

    this.reapingInFlight = true
    try {
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      const now = Date.now()
      const idleCandidates = []

      for (const [sid, entry] of [...this.warmSessions.entries()]) {
        if (entry.starting) continue
        if (!entry.client.isAlive()) {
          if (this.warmSessions.get(sid) === entry) this.warmSessions.delete(sid)
          continue
        }
        if (entry.fgTurn || entry.wakeup || this.activeTurns.has(sid) || this.hasPendingServerRequest(sid)) continue

        const idleMs = now - entry.lastActivityAt
        if (idleMs < 20_000) continue // Grace window for SQLite summary write flush

        const dbState = await queryAgyConversationState(dbPath, sid)
        // Re-verify after async DB query before making any close decision
        if (!this.isWarmEntrySafeToClose(sid, entry)) continue
        const busyInDb = Boolean(dbState?.notFullyIdle || dbState?.status === 'CASCADE_RUN_STATUS_RUNNING')
        if (busyInDb) {
          // NEVER kill active background tasks / subagents / timers unless exceeding 2h safety cap
          if (idleMs >= WARM_BUSY_HARD_CAP_MS && this.isWarmEntrySafeToClose(sid, entry)) {
            this.log.warn?.(`mobile-hub: closing agy warm session ${sid} after 2h safety cap`)
            await this.closeWarmSession(sid, entry)
          }
          continue
        }
        idleCandidates.push({ sid, entry, idleMs })
      }

      idleCandidates.sort((a, b) => b.idleMs - a.idleMs)
      const ttlMs = idleCandidates.length > MAX_IDLE_WARM_SESSIONS ? WARM_IDLE_EXCESS_CLOSE_MS : WARM_IDLE_CLOSE_MS
      for (const { sid, entry, idleMs } of idleCandidates) {
        if (idleMs >= ttlMs && this.isWarmEntrySafeToClose(sid, entry)) {
          await this.closeWarmSession(sid, entry)
        }
      }
    } finally {
      this.reapingInFlight = false
    }
  }

  finalizeWakeupTurn(entry) {
    if (!entry.wakeup) return
    const wk = entry.wakeup
    entry.wakeup = null
    if (wk.settleTimer) clearTimeout(wk.settleTimer)
    entry.lastActivityAt = Date.now()
    const fp = getTranscriptFingerprint(this.agyHome, entry.sessionId)
    entry.lastTranscriptMtimeMs = fp.mtimeMs
    entry.lastTranscriptSize = fp.size
    this.bridgeWrittenSessions.set(entry.sessionId, { writtenAt: Date.now(), stepCount: entry.lastStepCount || 0 })
    this.updateWatchSnapshot(entry.sessionId, { fp })
    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
    this.emitEvent(EVENTS.STREAM_DONE, {
      sessionId: compositeId,
      app: APPS.ANTIGRAVITY,
      nativeId: entry.sessionId,
      finalText: wk.finalText.trim(),
      aborted: false,
    })
  }

  scheduleWakeupSettle(entry) {
    if (this.disposed) return
    const wk = entry.wakeup
    if (!wk) return
    if (wk.settleTimer) clearTimeout(wk.settleTimer)
    wk.settleTimer = setTimeout(async () => {
      try {
        if (this.disposed || entry.wakeup !== wk || entry.fgTurn) return
        if (this.hasPendingServerRequest(entry.sessionId)) {
          this.scheduleWakeupSettle(entry)
          return
        }
        const dbPath = join(this.agyHome, 'conversation_summaries.db')
        const dbState = await queryAgyConversationState(dbPath, entry.sessionId)
        // Re-check state after async await before finalizing
        if (this.disposed || entry.wakeup !== wk || entry.fgTurn) return
        if (this.hasPendingServerRequest(entry.sessionId)) {
          this.scheduleWakeupSettle(entry)
          return
        }
        const stillRunning = dbState?.status === 'CASCADE_RUN_STATUS_RUNNING'
        const silentMs = Date.now() - entry.lastActivityAt
        if (!stillRunning || silentMs >= 12_000) {
          this.finalizeWakeupTurn(entry)
        } else {
          this.scheduleWakeupSettle(entry)
        }
      } catch (err) {
        this.log.warn?.(`mobile-hub: agy wakeup settle error (${entry.sessionId}): ${String(err?.message || err)}`)
      }
    }, 2_500)
    wk.settleTimer.unref?.()
  }

  handleWarmSessionUpdate(entry, params) {
    if (!entry.sessionId) return
    entry.lastActivityAt = Date.now()

    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
    const u = params?.update || {}
    const kind = u.sessionUpdate

    // Track real-time plan / steps / focus / mode updates from ACP (works for both foreground & wakeup turns)
    if (!entry.taskTracker) {
      entry.taskTracker = createTaskStateTracker()
    }
    if (kind === 'current_mode_update' && u.currentModeId) {
      entry.currentModeId = String(u.currentModeId)
    }
    if (entry.taskTracker.applyAntigravityAcpUpdate(u, Date.now())) {
      const diff = entry.taskTracker.consumeChanged()
      if (diff.changed) {
        this.emitEvent(EVENTS.STREAM_TASK_STATE, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          taskState: diff.taskState,
        })
      }
    }
    if (kind === 'plan' || kind === 'current_mode_update') {
      return
    }

    // Detect background task / subagent / schedule launches so we keep the ACP worker warm
    const rawToolName = String(u.name || u.title || '').toLowerCase()
    if (
      rawToolName === 'invoke_subagent' ||
      rawToolName === 'schedule' ||
      rawToolName === 'run_workflow' ||
      rawToolName === 'swarm'
    ) {
      entry.sawBackgroundTask = true
    }

    // Determine target stream state: active foreground `session/prompt` OR spontaneous reactive wakeup!
    let target = entry.fgTurn
    const isWakeup = !target
    if (isWakeup) {
      if (kind === 'turn_complete' || kind === 'done') {
        this.finalizeWakeupTurn(entry)
        return
      }
      if (
        kind !== 'agent_message_chunk' &&
        kind !== 'agent_thought_chunk' &&
        kind !== 'tool_call' &&
        kind !== 'tool_call_update'
      ) {
        return
      }
      if (!entry.wakeup) {
        entry.wakeup = {
          finalText: '',
          seenToolStarts: new Set(),
          seenToolEnds: new Set(),
          settleTimer: null,
          startedAt: Date.now(),
        }
        this.emitEvent(EVENTS.STREAM_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          nativeId: entry.sessionId,
        })
      }
      target = entry.wakeup
      this.scheduleWakeupSettle(entry)
    }

    if (kind === 'agent_message_chunk') {
      const delta = extractAcpText(u.content)
      if (delta) {
        target.finalText += delta
        this.emitEvent(EVENTS.STREAM_DELTA, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          delta,
        })
      }
      return
    }

    if (kind === 'agent_thought_chunk') {
      const delta = extractAcpText(u.content)
      if (delta) {
        this.emitEvent(EVENTS.STREAM_THINKING, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          delta,
        })
      }
      return
    }

    if (kind === 'tool_call') {
      const toolId = u.toolCallId || `agy-tool-${Date.now()}`
      if (!target.seenToolStarts.has(toolId)) {
        target.seenToolStarts.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          tool: {
            id: toolId,
            name: u.name || u.title || 'tool',
            input: u.args ?? u.rawInput ?? {},
          },
        })
      }
      return
    }

    if (kind === 'tool_call_update') {
      const toolId = u.toolCallId
      if (!toolId) return
      if (!target.seenToolStarts.has(toolId)) {
        target.seenToolStarts.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          tool: {
            id: toolId,
            name: u.name || u.title || 'tool',
            input: u.args ?? u.rawInput ?? {},
          },
        })
      }
      const outStr = extractAcpText(u.content) ||
        (typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput) : '')
      if (/running as a background task|background task with task id/i.test(String(outStr))) {
        entry.sawBackgroundTask = true
      }
      if ((u.status === 'completed' || u.status === 'failed' || u.status === 'error') && !target.seenToolEnds.has(toolId)) {
        target.seenToolEnds.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_END, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          toolId,
          status: u.status === 'failed' || u.status === 'error' ? 'error' : 'completed',
          output: String(outStr || '').slice(0, 3000),
        })
      }
    }
  }

  async acquireWarmSession(sessionId, targetCwd) {
    const inflight = this.startingWarmSessions.get(sessionId)
    if (inflight) {
      return inflight
    }
    const promise = this._acquireWarmSessionInternal(sessionId, targetCwd).finally(() => {
      if (this.startingWarmSessions.get(sessionId) === promise) {
        this.startingWarmSessions.delete(sessionId)
      }
    })
    this.startingWarmSessions.set(sessionId, promise)
    return promise
  }

  async _acquireWarmSessionInternal(sessionId, targetCwd) {
    if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const existing = this.warmSessions.get(sessionId)
    if (existing && !existing.starting && existing.client.isAlive()) {
      const dbState = await queryAgyConversationState(dbPath, sessionId)
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      const curFp = getTranscriptFingerprint(this.agyHome, sessionId)
      const busyInDb = Boolean(dbState?.notFullyIdle || dbState?.status === 'CASCADE_RUN_STATUS_RUNNING')
      const curStepCount = Number(dbState?.stepCount || 0)

      // Exact disk change check (including 0 -> >0 transitions on Turn 1): if Antigravity Desktop
      // wrote even a single step since our ACP worker's last write, close the stale ACP process
      // and resume fresh from disk so mobile NEVER runs on stale context!
      const fileChanged =
        curFp.size !== existing.lastTranscriptSize ||
        curFp.mtimeMs !== existing.lastTranscriptMtimeMs ||
        (curStepCount > 0 && curStepCount !== existing.lastStepCount)

      const desktopModified = !existing.wakeup && !existing.sawBackgroundTask && fileChanged

      if (!desktopModified && !(busyInDb && fileChanged)) {
        existing.lastActivityAt = Date.now()
        return existing
      }
      await this.closeWarmSession(sessionId, existing)
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
    } else if (existing && !existing.starting) {
      this.warmSessions.delete(sessionId)
    }

    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: targetCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })
    this.startingClients.add(client)
    const entry = this.registerWarmSession(sessionId, targetCwd, client, { starting: true, addToMap: false })
    try {
      await client.start()
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      const resumeRes = await client.rpc('session/resume', { sessionId, cwd: targetCwd, mcpServers: [] }, 30_000)
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      entry.currentModeId = String(resumeRes?.modes?.currentModeId || 'default')
      const diskTaskState = parseDesktopTranscript(sessionId, this.agyHome).taskState
      entry.taskTracker = createTaskStateTracker(diskTaskState)
      if (entry.currentModeId === 'plan') {
        entry.taskTracker.setMode('plan')
      }
      entry.taskTracker.consumeChanged()
      const [fp, dbState] = await Promise.all([
        Promise.resolve(getTranscriptFingerprint(this.agyHome, sessionId)),
        queryAgyConversationState(dbPath, sessionId),
      ])
      if (this.disposed) throw new Error('AntigravityAdapter 已销毁')
      entry.lastTranscriptMtimeMs = fp.mtimeMs
      entry.lastTranscriptSize = fp.size
      entry.lastStepCount = Number(dbState?.stepCount || 0)
      entry.lastActivityAt = Date.now()
      entry.starting = false
      this.warmSessions.set(sessionId, entry)
      this.ensureReaperRunning()
      return entry
    } catch (err) {
      entry.starting = false
      if (this.warmSessions.get(sessionId) === entry) {
        this.warmSessions.delete(sessionId)
      }
      await client.close(sessionId).catch(() => {})
      throw err
    } finally {
      this.startingClients.delete(client)
    }
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], taskMode, model, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Antigravity conversationId')
    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, sessionId)
    const effectiveTaskMode = normalizeTaskMode(taskMode)

    if (this.activeTurns.has(sessionId)) {
      const err = new Error('该 Antigravity 对话正在运行中，请等待完成或先点击停止。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    // Synchronously reserve activeTurns BEFORE any await to eliminate TOCTOU races
    const turnState = { client: null, aborted: false }
    this.activeTurns.set(sessionId, turnState)

    let entry = null
    let fgTurn = null
    let failedHard = false
    try {
      const cliVer = await this.checkCliVersion()
      if (!cliVer) {
        throw new Error(
          process.platform === 'win32'
            ? '本机未检测到 Antigravity CLI（请运行 irm https://antigravity.google/cli/install.ps1 | iex 安装）'
            : '本机未检测到 Antigravity CLI（请运行 curl -fsSL https://antigravity.google/cli/install.sh | bash 安装）',
        )
      }

      // Guard against concurrent split-brain writes when Antigravity Desktop is actively executing this exact turn!
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      const existingWarm = this.warmSessions.get(sessionId)
      if (!existingWarm?.wakeup && !existingWarm?.sawBackgroundTask) {
        const [dbState, desktopRunning] = await Promise.all([
          queryAgyConversationState(dbPath, sessionId),
          isAntigravityDesktopRunning(true),
        ])
        const fp = getTranscriptFingerprint(this.agyHome, sessionId)
        const bridgeWrite = this.bridgeWrittenSessions.get(sessionId)
        const writtenByExternal = !bridgeWrite || fp.mtimeMs > bridgeWrite.writtenAt + 1_500
        const recentlyWritten = fp.mtimeMs > 0 && Date.now() - fp.mtimeMs < 90_000
        const desktopActivelyRunning =
          desktopRunning &&
          writtenByExternal &&
          recentlyWritten &&
          (dbState?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(dbState?.notFullyIdle))
        if (desktopActivelyRunning) {
          throw new Error(
            'Antigravity 桌面端正在处理当前对话，请等待桌面端本轮回复完成后再发送（All in One 会自动实时同步进度），避免双端同时写入导致记录分叉。',
          )
        }
      }

      // Resolve real workspace directory from Desktop summary DB (single-row lookup, no 200-row cutoff) or pending map
      let targetCwd = String(cwd || '').trim()
      if (!targetCwd) {
        const pending = this.pendingCreated.get(sessionId)
        targetCwd = pending?.cwd || ''
      }
      if (!targetCwd) {
        const meta = await queryAgySummaryById(dbPath, sessionId)
        targetCwd = parseWorkspaceUri(meta?.workspace_uris) || ''
      }
      if (!targetCwd || !existsSync(targetCwd)) targetCwd = this.defaultCwd

      // Build native ACP multimodal prompt (ZERO injected wrapper text!)
      const promptBlocks = []
      const fileLines = []
      for (const att of attachments) {
        if (att.localPath && existsSync(att.localPath) && String(att.mimeType || '').startsWith('image/')) {
          try {
            const b64 = readFileSync(att.localPath).toString('base64')
            promptBlocks.push({
              type: 'image',
              data: b64,
              mimeType: att.mimeType || 'image/png',
            })
            continue
          } catch {}
        }
        if (att.localPath || att.filename) {
          fileLines.push(`- 附件：${att.localPath || att.filename}`)
        }
      }

      let promptText = String(text || '').trim()
      if (fileLines.length > 0) {
        promptText = `${promptText}${promptText ? '\n\n' : ''}${fileLines.join('\n')}`
      }
      if (promptText) {
        promptBlocks.unshift({ type: 'text', text: promptText })
      }
      if (promptBlocks.length === 0) {
        throw new Error('消息内容不能为空')
      }

      if (turnState.aborted) {
        return { sessionId: compositeId, nativeId: sessionId, finalText: '', aborted: true, usage: null }
      }

      const pref = this.sessionPrefs.get(sessionId)
      const effectiveModel = model || pref?.model || ''
      const effectiveEffort = reasoningEffort !== undefined ? reasoningEffort : pref?.reasoningEffort || ''
      if (effectiveModel || effectiveEffort) {
        this.sessionPrefs.set(sessionId, { model: effectiveModel, reasoningEffort: effectiveEffort })
      }

      entry = await this.acquireWarmSession(sessionId, targetCwd)
      turnState.client = entry.client
      if (turnState.aborted) {
        return { sessionId: compositeId, nativeId: sessionId, finalText: '', aborted: true, usage: null }
      }
      // If a spontaneous wakeup was still finalizing, close its bubble cleanly before starting user's new turn
      if (entry.wakeup) {
        this.finalizeWakeupTurn(entry)
      }

      fgTurn = {
        finalText: '',
        seenToolStarts: new Set(),
        seenToolEnds: new Set(),
        aborted: false,
      }
      entry.fgTurn = fgTurn

      this.emitEvent(EVENTS.STREAM_START, {
        sessionId: compositeId,
        app: APPS.ANTIGRAVITY,
        nativeId: sessionId,
      })

      if (effectiveModel) {
        const resolvedModel = await this.resolveAcpModelId(effectiveModel, effectiveEffort)
        if (resolvedModel) {
          await entry.client.rpc('session/set_model', { sessionId, modelId: resolvedModel }, 10_000).catch((err) => {
            this.log.warn?.(`mobile-hub: agy session/set_model(${resolvedModel}) failed: ${String(err?.message || err)}`)
          })
        }
      }

      // Sync interactive Plan / Goal mode cleanly via native ACP `session/set_mode` + `/goal` slash trigger
      if (!entry.taskTracker) {
        entry.taskTracker = createTaskStateTracker(parseDesktopTranscript(sessionId, this.agyHome).taskState)
      }
      const setPromptTextBlock = (nextText) => {
        const textBlock = promptBlocks.find((b) => b?.type === 'text')
        if (textBlock) textBlock.text = nextText
        else promptBlocks.unshift({ type: 'text', text: nextText })
      }
      const isExplicitPlanSlash = /^\/plan(?:\s|$)/i.test(promptText || '')
      if (effectiveTaskMode === 'plan') {
        try {
          await entry.client.rpc('session/set_mode', { sessionId, modeId: 'plan' }, 8_000)
          entry.currentModeId = 'plan'
        } catch (modeErr) {
          this.log.warn?.(`mobile-hub: agy session/set_mode(plan) fallback to /plan: ${String(modeErr?.message || modeErr)}`)
          if (promptText && !isExplicitPlanSlash) {
            promptText = `/plan ${promptText}`
            setPromptTextBlock(promptText)
          }
        }
        entry.taskTracker.setMode('plan', Date.now())
      } else {
        // Exit sticky ACP plan mode back to default when subsequent turn is not plan mode
        if (entry.currentModeId === 'plan' && !isExplicitPlanSlash) {
          await entry.client.rpc('session/set_mode', { sessionId, modeId: 'default' }, 8_000).catch(() => {})
          entry.currentModeId = 'default'
          entry.taskTracker.setMode(null, Date.now())
        }
        if (effectiveTaskMode === 'goal') {
          if (promptText && !/^\/goal(?:\s|$)/i.test(promptText)) {
            promptText = `/goal ${promptText}`
            setPromptTextBlock(promptText)
          }
          entry.taskTracker.applyAntigravityUserText(promptText || '/goal', Date.now())
        } else if (promptText) {
          // Forward native slash commands (/plan, /goal, /compact, etc.) verbatim to agy acp
          entry.taskTracker.applyAntigravityUserText(promptText, Date.now())
        }
      }
      const initTaskDiff = entry.taskTracker.consumeChanged()
      if (initTaskDiff.changed) {
        this.emitEvent(EVENTS.STREAM_TASK_STATE, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          taskState: initTaskDiff.taskState,
        })
      }

      if (turnState.aborted) {
        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          nativeId: sessionId,
          finalText: '',
          aborted: true,
        })
        return { sessionId: compositeId, nativeId: sessionId, finalText: '', aborted: true, usage: null }
      }

      // Sliding 15-min inactivity timeout (resets on every session/update chunk!)
      let promptRes
      try {
        promptRes = await entry.client.rpc(
          'session/prompt',
          { sessionId, prompt: promptBlocks },
          15 * 60_000,
          { sliding: true },
        )
      } catch (promptErr) {
        entry.client.notify('session/cancel', { sessionId })
        failedHard = true
        throw promptErr
      }

      const aborted = turnState.aborted || promptRes?.stopReason === 'cancelled'
      const cleanFinal = fgTurn.finalText.trim()
      this.pendingCreated.delete(sessionId)

      this.emitEvent(EVENTS.STREAM_DONE, {
        sessionId: compositeId,
        app: APPS.ANTIGRAVITY,
        nativeId: sessionId,
        finalText: cleanFinal,
        aborted,
      })

      return {
        sessionId: compositeId,
        nativeId: sessionId,
        finalText: cleanFinal,
        aborted,
        usage: promptRes?.usage || null,
      }
    } catch (err) {
      failedHard = failedHard || !entry?.client?.isAlive()
      if (!err?._streamErrorEmitted) {
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          message: String(err?.message || err),
        })
      }
      throw err
    } finally {
      if (this.activeTurns.get(sessionId) === turnState) {
        this.activeTurns.delete(sessionId)
      }
      if (entry) {
        if (fgTurn && entry.fgTurn === fgTurn) {
          entry.fgTurn = null
        }
        entry.lastActivityAt = Date.now()
        const dbPath = join(this.agyHome, 'conversation_summaries.db')
        const snapNow = async () => {
          const fp = getTranscriptFingerprint(this.agyHome, sessionId)
          const dbState = await queryAgyConversationState(dbPath, sessionId).catch(() => null)
          entry.lastTranscriptMtimeMs = fp.mtimeMs
          entry.lastTranscriptSize = fp.size
          if (dbState?.stepCount) entry.lastStepCount = Number(dbState.stepCount)
          this.bridgeWrittenSessions.set(sessionId, {
            writtenAt: Date.now(),
            stepCount: Number(dbState?.stepCount || entry.lastStepCount || 0),
          })
          this.updateWatchSnapshot(sessionId, { fp, dbState })
        }
        await snapNow()
        if (this.disposed) {
          await this.closeWarmSession(sessionId, entry)
        } else {
          // Re-snapshot shortly after turn end to capture trailing SQLite/transcript flush & refresh Gemini quota
          const settleSnap = setTimeout(() => {
            if (!this.disposed) {
              void snapNow().catch(() => {})
              void this.refreshQuotaInBackground({ force: true })
            }
          }, 450)
          settleSnap.unref?.()

          if (failedHard) {
            await this.closeWarmSession(sessionId, entry)
          } else {
            // Keep warm ACP worker alive so background tasks / subagents / timers NEVER get canceled on turn end!
            this.ensureReaperRunning()
          }
        }
      }
    }
  }

  clearPendingForClient(client) {
    for (const [aprId, item] of this.pendingServerRequests.entries()) {
      if (item.client === client) {
        this.pendingServerRequests.delete(aprId)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: aprId,
          app: APPS.ANTIGRAVITY,
          sessionId: item.sessionId ? makeCompositeId(APPS.ANTIGRAVITY, item.sessionId) : '',
          decision: 'cancel',
        })
      }
    }
  }

  handleServerRequest(entry, client, msg) {
    const method = msg.method
    const params = msg.params || {}
    const sid = String(params.sessionId || entry?.sessionId || '').trim()
    const compositeId = sid ? makeCompositeId(APPS.ANTIGRAVITY, sid) : ''
    if (entry) entry.lastActivityAt = Date.now()

    if (method === 'elicitation/create') {
      const aprId = `agy-q-${randomUUID().slice(0, 10)}`
      const isUrlMode = params.mode === 'url'
      const questions = isUrlMode
        ? []
        : elicitationSchemaToQuestions(params.requestedSchema, params.message || '请做出选择')

      this.pendingServerRequests.set(aprId, {
        client,
        rpcId: msg.id,
        method,
        sessionId: sid,
        params,
        questions,
      })

      this.onApprovalRequest({
        id: aprId,
        app: APPS.ANTIGRAVITY,
        sessionId: compositeId,
        kind: isUrlMode ? 'url_elicitation' : 'question',
        title: 'Antigravity 需要你做选择',
        detail: String(params.message || '').trim(),
        ...(isUrlMode && params.url ? { url: String(params.url) } : {}),
        ...(isUrlMode
          ? {
              options: [
                { value: 'accept', label: '确认继续', style: 'primary' },
                { value: 'decline', label: '拒绝', style: 'danger' },
              ],
            }
          : { questions }),
        createdAt: Date.now(),
      })
      return
    }

    if (method === 'session/request_permission') {
      const rawOpts = Array.isArray(params.options) ? params.options : []
      if (this.autoApprove) {
        const allow = rawOpts.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') || rawOpts[0]
        try {
          client.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } },
          })
        } catch {}
        return
      }

      const aprId = `agy-apr-${randomUUID().slice(0, 10)}`
      this.pendingServerRequests.set(aprId, {
        client,
        rpcId: msg.id,
        method,
        sessionId: sid,
        params,
      })

      const options = rawOpts.map((o) => ({
        value: String(o.optionId || o.name || ''),
        label: String(o.name || o.optionId || ''),
        style:
          o.kind === 'reject_once' || o.kind === 'reject_always'
            ? 'danger'
            : o.kind === 'allow_once'
              ? 'primary'
              : 'secondary',
      }))
      const tc = params.toolCall || {}
      const detail =
        extractAcpText(tc.content) ||
        (tc.rawInput ? (typeof tc.rawInput === 'string' ? tc.rawInput : JSON.stringify(tc.rawInput, null, 2)) : '') ||
        tc.title ||
        '请求执行操作'

      this.onApprovalRequest({
        id: aprId,
        app: APPS.ANTIGRAVITY,
        sessionId: compositeId,
        kind: 'command',
        title: tc.title ? `Antigravity 请求：${tc.title}` : 'Antigravity 请求授权',
        detail: String(detail).slice(0, 1200),
        cwd: entry?.cwd || '',
        options,
        createdAt: Date.now(),
      })
      return
    }

    try {
      client.sendRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported client method: ${method}` },
      })
    } catch {}
  }

  async resolveApproval(approvalId, decisionOrPayload) {
    const item = this.pendingServerRequests.get(approvalId)
    if (!item) return { resolved: false, reason: 'approval not found' }
    this.pendingServerRequests.delete(approvalId)

    const { decision, answers } = normalizeResolvePayload(decisionOrPayload)

    const sendAcpReply = (payloadObj) => {
      try {
        item.client.sendRaw(payloadObj)
      } catch (err) {
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: approvalId,
          app: APPS.ANTIGRAVITY,
          decision: 'cancel',
        })
        const transportErr = new Error(String(err?.message || 'Antigravity ACP 进程已退出，审批请求已失效'))
        transportErr.code = 'APPROVAL_TRANSPORT_CLOSED'
        throw transportErr
      }
    }

    if (item.method === 'elicitation/create') {
      const action = decision === 'decline' ? 'decline' : decision === 'cancel' ? 'cancel' : 'accept'
      const result = action === 'accept'
        ? item.params?.mode === 'url'
          ? { action: 'accept' }
          : { action: 'accept', content: answersToElicitationContent(item.params?.requestedSchema, answers) }
        : { action }
      sendAcpReply({
        jsonrpc: '2.0',
        id: item.rpcId,
        result,
      })
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.ANTIGRAVITY,
        decision: action,
      })
      return { resolved: true, id: approvalId, decision: action }
    }

    if (item.method === 'session/request_permission') {
      const outcome =
        !decision || decision === 'cancel'
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: decision }
      sendAcpReply({
        jsonrpc: '2.0',
        id: item.rpcId,
        result: { outcome },
      })
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.ANTIGRAVITY,
        decision: decision || 'cancel',
      })
      return { resolved: true, id: approvalId, decision: decision || 'cancel' }
    }

    return { resolved: false, reason: `unsupported method: ${item.method}` }
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Antigravity conversationId')
    for (const [aprId, item] of this.pendingServerRequests.entries()) {
      if (item.sessionId === sessionId) {
        this.pendingServerRequests.delete(aprId)
        try {
          if (item.method === 'elicitation/create') {
            item.client.sendRaw({ jsonrpc: '2.0', id: item.rpcId, result: { action: 'cancel' } })
          } else if (item.method === 'session/request_permission') {
            item.client.sendRaw({ jsonrpc: '2.0', id: item.rpcId, result: { outcome: { outcome: 'cancelled' } } })
          }
        } catch {}
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: aprId,
          app: APPS.ANTIGRAVITY,
          sessionId: makeCompositeId(APPS.ANTIGRAVITY, sessionId),
          decision: 'cancel',
        })
      }
    }
    const active = this.activeTurns.get(sessionId)
    if (active) {
      active.aborted = true
      active.client?.notify('session/cancel', { sessionId })
      return { interrupted: true, sessionId }
    }
    const warm = this.warmSessions.get(sessionId)
    if (warm?.client?.isAlive()) {
      warm.client.notify('session/cancel', { sessionId })
      return { interrupted: true, sessionId }
    }
    return { interrupted: false, sessionId }
  }

  async dispose() {
    this.disposed = true
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = null
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
    this.watchedSessions.clear()
    this.startingWarmSessions.clear()
    for (const proc of this.activeQuotaProcs) {
      killProcessTree(proc, { force: true })
    }
    this.activeQuotaProcs.clear()
    for (const client of this.startingClients) {
      client?.killImmediate()
    }
    this.startingClients.clear()
    for (const active of this.activeTurns.values()) {
      active.client?.killImmediate()
    }
    this.activeTurns.clear()
    for (const entry of this.warmSessions.values()) {
      if (entry.wakeup?.settleTimer) clearTimeout(entry.wakeup.settleTimer)
      entry.wakeup = null
      entry.client?.killImmediate()
    }
    this.warmSessions.clear()
    this.disposeBase()
  }
}
