import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  computeE2eeKeyId,
  decryptBinaryJson,
  generateE2eeKey,
} from '../packages/shared/src/e2ee.js'
import {
  createCtrlCodec,
  createSerializedChannelWriter,
} from '../packages/shared/src/p2p-mux.js'
import { BoundedLruMap, FileParseCache } from '../packages/dsh-mobile-hub/src/primitives/lru.js'
import { atomicWriteJsonSync, readHeadAndTailLines, readTailLinesZeroOom } from '../packages/dsh-mobile-hub/src/primitives/io-utils.js'
import { StreamJsonCliRunner } from '../packages/dsh-mobile-hub/src/primitives/stream-json-runner.js'
import { InboundAttachmentStore } from '../packages/dsh-mobile-hub/src/inbound-store.js'
import { APPS, EVENTS, RPC, assertSafeWorkspaceCwd, getDefaultWorkspaceCwd } from '../packages/dsh-mobile-hub/src/protocol.js'
import { MultiAppOrchestrator } from '../packages/dsh-mobile-hub/src/orchestrator.js'
import { AntigravityAdapter } from '../packages/dsh-mobile-hub/src/adapters/antigravity.js'
import { WorkBuddyAdapter } from '../packages/dsh-mobile-hub/src/adapters/workbuddy.js'
import { P2PBridgeManager } from '../packages/dsh-mobile-hub/src/p2p/manager.js'

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

test('getDefaultWorkspaceCwd returns ~/AllinOne-Workspace and passes assertSafeWorkspaceCwd once created while homedir is rejected', () => {
  const home = os.homedir()
  const defaultWs = getDefaultWorkspaceCwd()
  assert.equal(defaultWs, join(home, 'AllinOne-Workspace'))
  assert.throws(() => assertSafeWorkspaceCwd(home))

  const existedBefore = existsSync(defaultWs)
  try {
    if (!existedBefore) mkdirSync(defaultWs, { recursive: true })
    assert.equal(assertSafeWorkspaceCwd(defaultWs, { allowEmpty: false }), defaultWs)
  } finally {
    if (!existedBefore) {
      rmSync(defaultWs, { recursive: true, force: true })
    }
  }
})

test('MultiAppOrchestrator RPC.SESSION_SEND pre-materialization TOCTOU lock returns SESSION_BUSY without emitting STREAM_ERROR', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-orch-toctou-'))
  const events = []
  const orch = new MultiAppOrchestrator({
    onlyDsh: true,
    config: { inboundDir: dir },
    log: { info() {}, warn() {}, error() {} },
    onEvent: (event, payload) => events.push({ event, payload }),
  })
  try {
    let releaseMat
    let matStarted
    const matStartedPromise = new Promise((r) => {
      matStarted = r
    })
    const matGate = new Promise((r) => {
      releaseMat = r
    })
    let sendResolve
    const sendDone = new Promise((r) => {
      sendResolve = r
    })

    orch.materializeAttachments = async () => {
      matStarted()
      await matGate
      return []
    }
    orch.adapters[APPS.DSH].sendMessage = async (sid) => {
      sendResolve()
      return { sessionId: `dsh:${sid}`, nativeId: sid, finalText: 'ok', aborted: false }
    }

    const firstP = orch.handleRpc(RPC.SESSION_SEND, {
      app: APPS.DSH,
      sessionId: 'sess-toctou-1',
      text: 'first',
    })
    await matStartedPromise

    // Concurrent second RPC while first is still awaiting attachment materialization
    await assert.rejects(
      () =>
        orch.handleRpc(RPC.SESSION_SEND, {
          app: APPS.DSH,
          sessionId: 'sess-toctou-1',
          text: 'second',
        }),
      (err) => err?.code === 'SESSION_BUSY',
    )
    assert.equal(events.some((e) => e.event === EVENTS.STREAM_ERROR), false)

    releaseMat()
    const firstRes = await firstP
    assert.deepEqual(firstRes, { accepted: true, sessionId: 'dsh:sess-toctou-1' })
    await sendDone
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(orch._sendingLocks.size, 0)
    assert.equal(events.some((e) => e.event === EVENTS.STREAM_ERROR), false)
  } finally {
    await orch.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AntigravityAdapter rejects inline image attachments > 20 MB via stat without reading file into memory', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-agy-img-'))
  const bigImgPath = join(dir, 'huge-photo.png')
  const adapter = new AntigravityAdapter({
    config: { agyHome: dir, cwd: dir, disableAgyQuotaProbe: true },
    log: { info() {}, warn() {}, error() {} },
    emitEvent: () => {},
  })
  try {
    // Create a 21 MB sparse file with mode 0o000 on POSIX so readFile() would fail EACCES while stat() succeeds
    const fd = openSync(bigImgPath, 'w')
    ftruncateSync(fd, 21 * 1024 * 1024)
    closeSync(fd)
    if (process.platform !== 'win32') chmodSync(bigImgPath, 0o000)

    adapter.checkCliVersion = async () => '1.0.0'
    adapter.isDesktopRunning = async () => false

    await assert.rejects(
      () =>
        adapter.sendMessage('conv-big-image-1', {
          text: 'check this image',
          cwd: dir,
          attachments: [{ localPath: bigImgPath, mimeType: 'image/png', filename: 'huge-photo.png' }],
        }),
      (err) => err?.code === 'IMAGE_TOO_LARGE' && /20 MB/.test(String(err?.message || '')),
    )
    assert.equal(adapter.activeTurns.has('conv-big-image-1'), false)
  } finally {
    if (process.platform !== 'win32' && existsSync(bigImgPath)) {
      try { chmodSync(bigImgPath, 0o600) } catch {}
    }
    await adapter.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WorkBuddyAdapter exposes quotaCacheAt getter/setter tracking quotaManager.fetchedAt', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-wb-quota-'))
  const adapter = new WorkBuddyAdapter({
    config: { workbuddyHome: dir, cwd: dir },
    log: { info() {}, warn() {}, error() {} },
    emitEvent: () => {},
  })
  try {
    assert.equal(adapter.quotaCacheAt, 0)
    adapter.quotaCacheAt = 1700000123456
    assert.equal(adapter.quotaCacheAt, 1700000123456)
    assert.equal(adapter.quotaManager.fetchedAt, 1700000123456)
    adapter.quotaCacheAt = 'invalid'
    assert.equal(adapter.quotaCacheAt, 0)
  } finally {
    adapter.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StreamJsonCliRunner invokes onCleanup once even when spawn fails or stdin.write throws synchronously', async () => {
  // Case 1: spawnFn throws synchronously
  const events1 = []
  let cleanup1 = 0
  const runner1 = new StreamJsonCliRunner({
    app: APPS.CLAUDE,
    displayName: 'Claude',
    idPrefix: 'cl',
    emitEvent: (ev, p) => events1.push({ ev, p }),
    spawnFn: () => {
      throw new Error('spawn ENOENT boom')
    },
    log: { info() {}, warn() {}, error() {} },
  })
  const token1 = runner1.reserveSession('s-spawn-fail')
  await assert.rejects(
    () =>
      runner1.runTurn({
        sessionId: 's-spawn-fail',
        compositeId: 'claude:s-spawn-fail',
        bin: 'claude',
        args: [],
        cwd: os.tmpdir(),
        prompt: 'hi',
        reservationToken: token1,
        onCleanup: () => {
          cleanup1 += 1
        },
      }),
    /spawn ENOENT boom/,
  )
  assert.equal(cleanup1, 1)
  assert.equal(runner1.isSessionBusy('s-spawn-fail'), false)
  assert.ok(events1.some((e) => e.ev === EVENTS.STREAM_ERROR))

  // Case 2: proc.stdin.write throws synchronously
  const events2 = []
  let cleanup2 = 0
  const fakeProc = new EventEmitter()
  fakeProc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  fakeProc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
  fakeProc.stdin = Object.assign(new EventEmitter(), {
    write() {
      throw new Error('EPIPE sync stdin error')
    },
    end() {},
  })
  fakeProc.kill = () => {}

  const runner2 = new StreamJsonCliRunner({
    app: APPS.CLAUDE,
    displayName: 'Claude',
    idPrefix: 'cl',
    emitEvent: (ev, p) => events2.push({ ev, p }),
    spawnFn: () => fakeProc,
    log: { info() {}, warn() {}, error() {} },
  })
  await assert.rejects(
    () =>
      runner2.runTurn({
        sessionId: 's-write-fail',
        compositeId: 'claude:s-write-fail',
        bin: 'claude',
        args: [],
        cwd: os.tmpdir(),
        prompt: 'hi',
        onCleanup: () => {
          cleanup2 += 1
        },
      }),
    /EPIPE sync stdin error/,
  )
  assert.equal(cleanup2, 1)
  assert.equal(runner2.isSessionBusy('s-write-fail'), false)
  assert.ok(events2.some((e) => e.ev === EVENTS.STREAM_ERROR))
  // Late exit/close events must NOT double-run onCleanup
  fakeProc.emit('exit', 1)
  fakeProc.emit('close', 1)
  assert.equal(cleanup2, 1)
})

test('P2PBridgeManager handles frozen sync.sinceSeq replay/dedup, bridgeBootId mismatch sync.reset, and upload cancel cleanup', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'aio-p2p-mgr-'))
  const roomId = 'usr_p2p_unit_1'
  const e2eeKey = generateE2eeKey()
  const keyId = await computeE2eeKeyId(e2eeKey)
  const mgr = new P2PBridgeManager({
    roomId,
    e2eeKey,
    getE2eeKeyId: async () => keyId,
    sendSignal: () => {},
    onRpc: async () => ({ ok: true }),
    inboundDir: dir,
    log: { info() {}, warn() {}, error() {} },
  })

  try {
    // 1. Broadcast replayable events & mutate source payload after broadcast to verify deep-freeze snapshot
    const mutablePayload1 = { session: { id: 'dsh:s1', title: 'initial-1' } }
    const mutablePayload2 = { session: { id: 'dsh:s2', title: 'initial-2' } }
    const mutablePayload3 = { session: { id: 'dsh:s3', title: 'initial-3' } }
    mgr.broadcastEvent(EVENTS.SESSION_UPDATED, mutablePayload1)
    mgr.broadcastEvent(EVENTS.SESSION_UPDATED, mutablePayload2)
    mgr.broadcastEvent(EVENTS.SESSION_UPDATED, mutablePayload3)
    mutablePayload2.session.title = 'MUTATED_AFTER_BROADCAST'
    mutablePayload3.session.title = 'MUTATED_AFTER_BROADCAST'

    // Build mock peer session with real ctrlCodec & serialized writer
    const decoder = createCtrlCodec()
    const receivedCtrl = []
    const fakeCtrlDc = {
      readyState: 'open',
      bufferedAmount: 0,
      send: (bytes) => {
        const msg = decoder.decode(bytes)
        if (msg) receivedCtrl.push(msg)
      },
    }
    const sess = {
      clientId: 'cli_replay_1',
      authSid: 's_1',
      sessionId: 'p2p-sess-1',
      createdAt: Date.now(),
      closed: false,
      offerReady: true,
      transport: 'direct',
      pendingIce: [],
      ctrlCodec: createCtrlCodec(),
      ctrlWriter: createSerializedChannelWriter(fakeCtrlDc),
      bulkWriter: null,
      peer: { isCtrlOpen: () => true, close: async () => {} },
      inFlightRpcs: 0,
      replayingEvents: false,
      pendingLiveEvents: [],
      lastDeliveredSeq: 0,
      replayChain: Promise.resolve(),
      pendingDownloads: new Map(),
      activeDownloads: new Map(),
      activeUploads: new Map(),
    }
    mgr.sessions.set(sess.clientId, sess)

    // 2. bridgeBootId mismatch emits `sync.reset`
    await mgr.handleCtrlMessage(sess, {
      type: 'sync.sinceSeq',
      sinceSeq: 1,
      bridgeBootId: 'stale-boot-id-999',
    })
    await sess.replayChain
    const resetMsg = receivedCtrl.find((m) => m.type === 'sync.reset')
    assert.ok(resetMsg, 'expected sync.reset on mismatched bridgeBootId')
    assert.equal(resetMsg.bridgeBootId, mgr.bridgeBootId)
    assert.equal(resetMsg.eventSeq, 3)

    // 3. Matching bridgeBootId replays seq > 1 in order + buffers concurrent live seq 4 cleanly without dupes
    receivedCtrl.length = 0
    await mgr.handleCtrlMessage(sess, {
      type: 'sync.sinceSeq',
      sinceSeq: 1,
      bridgeBootId: mgr.bridgeBootId,
    })
    mgr.broadcastEvent(EVENTS.STREAM_DONE, { sessionId: 'dsh:s4', finalText: 'live-4' })
    await mgr._eventQueue
    await sess.replayChain

    const eventFrames = receivedCtrl.filter((m) => m.type === 'event')
    const decrypted = []
    for (const f of eventFrames) {
      decrypted.push(await decryptBinaryJson(e2eeKey, f.bin, { kind: 'event', roomId }))
    }
    assert.deepEqual(
      decrypted.map((d) => d.seq),
      [2, 3, 4],
      'replayed + live events must arrive in strict monotonic order without duplicates',
    )
    assert.equal(decrypted[0].payload.session.title, 'initial-2', 'replayed payload must be frozen snapshot')
    assert.equal(decrypted[1].payload.session.title, 'initial-3', 'replayed payload must be frozen snapshot')
    assert.equal(decrypted[2].payload.finalText, 'live-4')

    // Re-requesting sync.sinceSeq=1 on same session must NOT re-emit already-delivered seqs
    const countBefore = receivedCtrl.length
    await mgr.handleCtrlMessage(sess, {
      type: 'sync.sinceSeq',
      sinceSeq: 1,
      bridgeBootId: mgr.bridgeBootId,
    })
    await sess.replayChain
    assert.equal(receivedCtrl.length, countBefore)

    // 4. Upload cancel releases slot immediately and cleans up temp file on disk
    const uploadP = mgr.startBulkUploadReceiver(sess, {
      transferId: 'tr-cancel-1',
      streamId: 77,
      filename: 'cancel-me.bin',
      mimeType: 'application/octet-stream',
      size: 4096,
      e2ee: { iv: 'AAAAAAAAAAAAAAAA', kid: keyId, chunked: true },
    })
    // Wait until upload.ready has been emitted and temp file allocated
    for (let i = 0; i < 40; i += 1) {
      if (readdirSync(dir).length > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(sess.activeUploads.has(77), true)
    assert.equal(readdirSync(dir).length, 1, 'temp upload file should exist before cancel')

    mgr._handleBulkCtrlAction(sess, { action: 'cancel', streamId: 77, direction: 'upload' })
    // Slot MUST be released synchronously upon cancel
    assert.equal(sess.activeUploads.has(77), false)

    await uploadP
    assert.equal(readdirSync(dir).length, 0, 'temp upload file must be deleted after cancel')
    assert.equal(mgr.inboundStore.inFlight.size, 0, 'upload space reservation must be released')
    assert.equal(mgr.inboundStore.inFlightUploadBytes, 0)
  } finally {
    await mgr.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
