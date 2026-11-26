import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { BoundedLruMap, FileParseCache } from '../packages/dsh-mobile-hub/src/primitives/lru.js'
import { atomicWriteJsonSync, readHeadAndTailLines, readTailLinesZeroOom } from '../packages/dsh-mobile-hub/src/primitives/io-utils.js'
import { InboundAttachmentStore } from '../packages/dsh-mobile-hub/src/inbound-store.js'
import { assertSafeWorkspaceCwd } from '../packages/dsh-mobile-hub/src/protocol.js'

test('BoundedLruMap evicts oldest entries and refreshes recency on get()', () => {
  const m = new BoundedLruMap(2)
  m.set('a', 1)
  m.set('b', 2)
  assert.equal(m.get('a'), 1) // refresh 'a'
  m.set('c', 3) // evicts 'b'
  assert.equal(m.has('b'), false)
  assert.equal(m.get('a'), 1)
  assert.equal(m.get('c'), 3)
})

test('FileParseCache enforces byte budget and invalidates on mtime/size change', () => {
  const cache = new FileParseCache({ maxEntries: 4, maxBytes: 1024 * 1024 })
  cache.set('/tmp/f1', 1, 50, { ok: 1 }, 400 * 1024)
  assert.deepEqual(cache.get('/tmp/f1', 1, 50), { ok: 1 })
  assert.equal(cache.get('/tmp/f1', 2, 50), undefined)
  cache.set('/tmp/f2', 1, 50, { ok: 2 }, 400 * 1024)
  cache.set('/tmp/f3', 1, 50, { ok: 3 }, 400 * 1024)
  assert.equal(cache.get('/tmp/f1', 1, 50), undefined) // evicted by 1 MB budget
  assert.deepEqual(cache.get('/tmp/f2', 1, 50), { ok: 2 })
  assert.deepEqual(cache.get('/tmp/f3', 1, 50), { ok: 3 })
})

test('readTailLinesZeroOom and readHeadAndTailLines read slices without full-file OOM', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-io-unit-'))
  try {
    const f = join(dir, 'big.jsonl')
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(80) }))
    writeFileSync(f, `${lines.join('\n')}\n`, 'utf8')
    const tail = readTailLinesZeroOom(f, 1024)
    assert.ok(tail.length >= 5 && tail.length < 50)
    assert.equal(JSON.parse(tail[tail.length - 1]).n, 499)

    const { headLines, tailLines } = readHeadAndTailLines(f, 1024, 1024)
    assert.ok(headLines.length >= 5)
    assert.ok(tailLines.length >= 5)
    assert.equal(JSON.parse(headLines[0]).n, 0)
    assert.equal(JSON.parse(tailLines[tailLines.length - 1]).n, 499)

    const jPath = join(dir, 'state.json')
    atomicWriteJsonSync(jPath, { hello: 'world', n: 42 })
    const parsed = JSON.parse(readTailLinesZeroOom(jPath, 4096).join('\n'))
    assert.deepEqual(parsed, { hello: 'world', n: 42 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('InboundAttachmentStore enforces byte quotas, size=0 bypass guard, and single-use p2p tokens', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-inbound-unit-'))
  try {
    const store = new InboundAttachmentStore({ inboundDir: dir, maxDiskBytes: 2048 })
    const res1 = store.reserveUploadSpace('u1', 1024)
    assert.equal(res1.ok, true)
    const { localPath, safeName } = store.allocateFilePath('shot.png')
    store.attachLocalPath('u1', localPath)
    writeFileSync(localPath, Buffer.alloc(1024, 1))
    assert.equal(store.updateWrittenAndCheckQuota('u1', 1024), true)
    store.releaseUploadSpace('u1')

    const token = store.registerUpload({
      clientId: 'cli_a',
      localPath,
      filename: safeName,
      mimeType: 'image/png',
      size: 1024,
    })
    assert.ok(token.startsWith('p2p_'))

    // Cross-client attempt MUST reject in strict mode without burning token for real owner
    assert.throws(
      () => store.materializeAttachments([{ p2pToken: token }], { clientId: 'cli_b', strict: true }),
      (err) => err?.code === 'ATTACHMENT_EXPIRED',
    )

    // Real owner consumes token once; replay MUST fail
    const burned = []
    const mat = store.materializeAttachments([{ p2pToken: token }], { clientId: 'cli_a', strict: true, _burnedOut: burned })
    assert.equal(mat.length, 1)
    assert.equal(mat[0].localPath, localPath)
    assert.throws(
      () => store.materializeAttachments([{ p2pToken: token }], { clientId: 'cli_a', strict: true }),
      (err) => err?.code === 'ATTACHMENT_EXPIRED',
    )

    // Restoring burned tokens on RPC failure lets caller retry cleanly
    store.restoreTokens(burned)
    const matRetry = store.materializeAttachments([{ p2pToken: token }], { clientId: 'cli_a', strict: true })
    assert.equal(matRetry.length, 1)

    // Size=0 under-reporting bypass MUST be caught live during writes
    const resZero = store.reserveUploadSpace('u2', 0)
    assert.equal(resZero.ok, false) // 1024 on disk + 1MB unknown floor > 2048 quota
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assertSafeWorkspaceCwd blocks exact home directory and sensitive dot-folders', () => {
  const home = os.homedir()
  assert.throws(() => assertSafeWorkspaceCwd(home))
  assert.throws(() => assertSafeWorkspaceCwd(join(home, '.ssh')))
  assert.throws(() => assertSafeWorkspaceCwd(join(home, '.allinone-bridge')))
  assert.throws(() => assertSafeWorkspaceCwd(join(home, '.claude')))
  assert.throws(() => assertSafeWorkspaceCwd(join(home, '.codex')))
  assert.throws(() => assertSafeWorkspaceCwd(join(home, '.gemini')))
})
