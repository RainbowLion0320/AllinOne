import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)

let _cachedDatabaseSync = undefined

/**
 * Lazily load Node 22+ built-in `node:sqlite` (`DatabaseSync`) when available.
 * Returns `null` cleanly under Electron runtimes where `node:sqlite` is absent.
 */
export function getDatabaseSync() {
  if (_cachedDatabaseSync !== undefined) return _cachedDatabaseSync
  try {
    const mod = require('node:sqlite')
    _cachedDatabaseSync = mod?.DatabaseSync || null
  } catch {
    _cachedDatabaseSync = null
  }
  return _cachedDatabaseSync
}

/**
 * Cross-platform PID liveness probe (`process.kill(pid, 0)`).
 */
export function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Zero-OOM tail reader for arbitrarily large JSONL transcripts.
 * Reads at most the trailing `maxBytes` bytes and drops the first partial line when seeking mid-file.
 */
export function readTailLinesZeroOom(filePath, maxBytes = 65_536) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) return []
    const len = Math.min(st.size, maxBytes)
    const offset = Math.max(0, st.size - len)
    const buf = Buffer.allocUnsafe(len)
    fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buf, 0, len, offset)
    const raw = buf.subarray(0, bytesRead).toString('utf8')
    const lines = raw.split(/\r?\n/)
    if (offset > 0 && lines.length > 0) lines.shift()
    return lines.filter((l) => l.trim().length > 0)
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Zero-OOM head + tail line reader for extracting metadata (cwd/title) from the head
 * and latest status/preview from the tail without loading multi-hundred-MB files.
 */
export function readHeadAndTailLines(filePath, headBytes = 32_768, tailBytes = 32_768) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) return { headLines: [], tailLines: [], size: 0, mtimeMs: st.mtimeMs || 0 }
    fd = openSync(filePath, 'r')
    const headLen = Math.min(st.size, headBytes)
    const headBuf = Buffer.allocUnsafe(headLen)
    const headRead = readSync(fd, headBuf, 0, headLen, 0)
    const headRaw = headBuf.subarray(0, headRead).toString('utf8')
    const headLines = headRaw.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (st.size <= headBytes) {
      return { headLines, tailLines: headLines, size: st.size, mtimeMs: st.mtimeMs || 0 }
    }
    const tailLen = Math.min(st.size, tailBytes)
    const tailOffset = Math.max(0, st.size - tailLen)
    const tailBuf = Buffer.allocUnsafe(tailLen)
    const tailRead = readSync(fd, tailBuf, 0, tailLen, tailOffset)
    const tailRaw = tailBuf.subarray(0, tailRead).toString('utf8')
    const tailLines = tailRaw.split(/\r?\n/)
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift()
    return {
      headLines,
      tailLines: tailLines.filter((l) => l.trim().length > 0),
      size: st.size,
      mtimeMs: st.mtimeMs || 0,
    }
  } catch {
    return { headLines: [], tailLines: [], size: 0, mtimeMs: 0 }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Safely read a UTF-8 transcript file up to `maxBytes` (tail-sliced when larger than cap).
 */
export function readFileForParseSafe(filePath, maxBytes = 8 * 1024 * 1024) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) return { raw: '', truncated: false, size: 0, mtimeMs: st.mtimeMs || 0 }
    if (st.size <= maxBytes) {
      return { raw: readFileSync(filePath, 'utf8'), truncated: false, size: st.size, mtimeMs: st.mtimeMs || 0 }
    }
    const buf = Buffer.allocUnsafe(maxBytes)
    const offset = st.size - maxBytes
    fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buf, 0, maxBytes, offset)
    let raw = buf.subarray(0, bytesRead).toString('utf8')
    const firstNl = raw.indexOf('\n')
    if (firstNl !== -1) raw = raw.slice(firstNl + 1)
    return { raw, truncated: true, size: st.size, mtimeMs: st.mtimeMs || 0 }
  } catch {
    return { raw: '', truncated: false, size: 0, mtimeMs: 0 }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Atomic JSON file write (`tmp -> chmod -> rename`) preventing torn reads/writes on crash.
 */
export function atomicWriteJsonSync(filePath, data, { mode = 0o600 } = {}) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const payload = JSON.stringify(data)
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode })
  try { chmodSync(tmpPath, mode) } catch {}
  try {
    renameSync(tmpPath, filePath)
  } catch {
    try {
      writeFileSync(filePath, payload, { encoding: 'utf8', mode })
    } finally {
      try { unlinkSync(tmpPath) } catch {}
    }
  }
  try { chmodSync(filePath, mode) } catch {}
}

/**
 * Execute an inline Python read-only SQLite query script (non-blocking async fallback
 * for Electron or runtimes lacking `node:sqlite`).
 */
export function runPythonSqliteJson(pyCode, args = [], fallbackValue = null, timeoutMs = 3_000) {
  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'python', prefix: [] },
        { cmd: 'py', prefix: ['-3'] },
        { cmd: 'python3', prefix: [] },
      ]
    : [
        { cmd: 'python3', prefix: [] },
        { cmd: 'python', prefix: [] },
      ]

  const tryNext = (idx) => {
    if (idx >= candidates.length) return Promise.resolve(fallbackValue)
    const { cmd, prefix } = candidates[idx]
    return new Promise((resolvePromise) => {
      execFile(
        cmd,
        [...prefix, '-c', pyCode, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) {
            if (err.code === 'ENOENT') {
              resolvePromise(tryNext(idx + 1))
              return
            }
            resolvePromise(fallbackValue)
            return
          }
          try {
            resolvePromise(JSON.parse(String(stdout || '').trim() || 'null') ?? fallbackValue)
          } catch {
            resolvePromise(fallbackValue)
          }
        },
      )
    })
  }
  return tryNext(0)
}

/**
 * Unified read-only SQLite query helper: uses Node 22+ built-in `node:sqlite` when available,
 * and falls back cleanly to async Python `sqlite3` under Electron.
 */
export async function queryReadOnlySqlite(
  dbPath,
  { sql, params = [], single = false, fallbackValue = null, timeoutMs = 3_000 } = {},
) {
  if (!dbPath || !existsSync(dbPath)) return fallbackValue
  const DatabaseSync = getDatabaseSync()
  if (DatabaseSync) {
    let db = null
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const stmt = db.prepare(sql)
      return single ? (stmt.get(...params) ?? fallbackValue) : stmt.all(...params)
    } catch {
      // Fall through to Python sqlite3 fallback (e.g. WAL / lock edge cases)
    } finally {
      try { db?.close() } catch {}
    }
  }

  const pyCode = [
    'import sqlite3, json, sys',
    'db_path, sql, params_json, single_flag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
    'conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.5)',
    'conn.row_factory = sqlite3.Row',
    'try:',
    '  cur = conn.execute(sql, json.loads(params_json))',
    '  if single_flag == "1":',
    '    row = cur.fetchone()',
    '    print(json.dumps(dict(row) if row is not None else None))',
    '  else:',
    '    print(json.dumps([dict(r) for r in cur.fetchall()]))',
    'finally:',
    '  conn.close()',
  ].join('\n')

  return runPythonSqliteJson(
    pyCode,
    [dbPath, sql, JSON.stringify(params), single ? '1' : '0'],
    fallbackValue,
    timeoutMs,
  )
}
