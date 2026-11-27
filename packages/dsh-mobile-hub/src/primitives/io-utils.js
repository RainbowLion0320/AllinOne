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
 * Zero-OOM tail reader returning lines plus file metadata (`size`, `mtimeMs`, `truncated`).
 * Reads at most the trailing `maxBytes` bytes and drops the first partial line when seeking mid-file.
 */
export function readTailLinesWithMeta(filePath, maxBytes = 65_536) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) {
      return { lines: [], size: 0, mtimeMs: st.mtimeMs || 0, truncated: false, exists: true }
    }
    fd = openSync(filePath, 'r')
    const len = Math.min(st.size, maxBytes)
    const offset = Math.max(0, st.size - len)
    const buf = Buffer.allocUnsafe(len)
    const bytesRead = readSync(fd, buf, 0, len, offset)
    const raw = buf.subarray(0, bytesRead).toString('utf8')
    const lines = raw.split(/\r?\n/)
    if (offset > 0 && lines.length > 0) lines.shift()
    return {
      lines: lines.filter((l) => l.trim().length > 0),
      size: st.size,
      mtimeMs: st.mtimeMs || 0,
      truncated: offset > 0,
      exists: true,
    }
  } catch {
    return { lines: [], size: 0, mtimeMs: 0, truncated: false, exists: false }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Zero-OOM tail reader for arbitrarily large JSONL transcripts.
 * Reads at most the trailing `maxBytes` bytes and drops the first partial line when seeking mid-file.
 */
export function readTailLinesZeroOom(filePath, maxBytes = 65_536) {
  return readTailLinesWithMeta(filePath, maxBytes).lines
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
    if (st.size <= headBytes + tailBytes) {
      const allLines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
      return { headLines: allLines, tailLines: allLines, size: st.size, mtimeMs: st.mtimeMs || 0 }
    }
    fd = openSync(filePath, 'r')
    const headLen = Math.min(st.size, headBytes)
    const headBuf = Buffer.allocUnsafe(headLen)
    const headRead = readSync(fd, headBuf, 0, headLen, 0)
    const headLines = headBuf.subarray(0, headRead).toString('utf8').split(/\r?\n/)
    if (headLen < st.size && headLines.length > 1) headLines.pop()

    const tailLen = Math.min(st.size, tailBytes)
    const tailOffset = Math.max(0, st.size - tailLen)
    const tailBuf = Buffer.allocUnsafe(tailLen)
    const tailRead = readSync(fd, tailBuf, 0, tailLen, tailOffset)
    const tailLines = tailBuf.subarray(0, tailRead).toString('utf8').split(/\r?\n/)
    if (tailOffset > 0 && tailLines.length > 0) tailLines.shift()
    return {
      headLines: headLines.filter((l) => l.trim().length > 0),
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
 * Safely read a UTF-8 transcript file for full parsing when <= `maxBytes`,
 * or tail-sliced to `tailFallbackBytes` when larger than `maxBytes`.
 */
export function readFileForParseSafe(filePath, maxBytes = 8 * 1024 * 1024, tailFallbackBytes = maxBytes) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) return { raw: '', truncated: false, size: 0, mtimeMs: st.mtimeMs || 0 }
    if (st.size <= maxBytes) {
      return { raw: readFileSync(filePath, 'utf8'), truncated: false, size: st.size, mtimeMs: st.mtimeMs || 0 }
    }
    const tailCap = Math.min(st.size, Math.max(64 * 1024, Number(tailFallbackBytes) || maxBytes))
    const buf = Buffer.allocUnsafe(tailCap)
    const offset = Math.max(0, st.size - tailCap)
    fd = openSync(filePath, 'r')
    const bytesRead = readSync(fd, buf, 0, tailCap, offset)
    let raw = buf.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstNl = raw.indexOf('\n')
      if (firstNl !== -1) raw = raw.slice(firstNl + 1)
    }
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
 * Zero-OOM JSONL parser helper: reads the full file when `<= maxFullBytes`, or reads
 * head metadata lines + tail body lines when larger than `maxFullBytes`.
 */
export function readHeadAndBodyLinesForParse(
  filePath,
  { maxFullBytes = 32 * 1024 * 1024, headBytes = 32 * 1024, tailBytes = 4 * 1024 * 1024 } = {},
) {
  let fd = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) {
      return { headLines: [], bodyLines: [], truncated: false, size: 0, mtimeMs: st.mtimeMs || 0 }
    }
    if (st.size <= maxFullBytes) {
      return {
        headLines: [],
        bodyLines: readFileSync(filePath, 'utf8').split(/\r?\n/),
        truncated: false,
        size: st.size,
        mtimeMs: st.mtimeMs || 0,
      }
    }
    fd = openSync(filePath, 'r')
    const headLen = Math.min(st.size, headBytes)
    const headBuf = Buffer.allocUnsafe(headLen)
    const headRead = readSync(fd, headBuf, 0, headLen, 0)
    const headLines = headBuf.subarray(0, headRead).toString('utf8').split(/\r?\n/)
    if (headLines.length > 1) headLines.pop()

    const tailLen = Math.min(st.size, tailBytes)
    const tailOffset = Math.max(0, st.size - tailLen)
    const tailBuf = Buffer.allocUnsafe(tailLen)
    const tailRead = readSync(fd, tailBuf, 0, tailLen, tailOffset)
    const bodyLines = tailBuf.subarray(0, tailRead).toString('utf8').split(/\r?\n/)
    if (tailOffset > 0 && bodyLines.length > 0) bodyLines.shift()
    return {
      headLines,
      bodyLines,
      truncated: true,
      size: st.size,
      mtimeMs: st.mtimeMs || 0,
    }
  } catch {
    return { headLines: [], bodyLines: [], truncated: false, size: 0, mtimeMs: 0 }
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
    'import json, sqlite3, sys',
    'from pathlib import Path',
    'db_path, sql, params_json, single_flag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
    'uri = Path(db_path).resolve().as_uri() + "?mode=ro"',
    'conn = sqlite3.connect(uri, uri=True, timeout=1.5)',
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
