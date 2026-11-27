import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeE2eeKeyId,
  decryptBinaryJson,
  encryptChunkedBytes,
  generateE2eeKey,
} from '../packages/shared/src/e2ee.js'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  createCtrlCodec,
  encodeBulkFrame,
} from '../packages/shared/src/p2p-mux.js'
import {
  appendStreamDelta,
  appendStreamThinking,
  clearAllStreamErrors,
  clearAllStreams,
  clearStreamError,
  failStream,
  finishStream,
  getRawStream,
  isStreamActive,
  startStream,
  streamToolEnd,
  streamToolStart,
  subscribeStream,
  subscribeStreamActive,
} from '../packages/mobile-app/src/state/streamingStore.js'
import { mergeUnflushedOptimisticTail } from '../packages/mobile-app/src/lib/sessionCache.js'
import { checkNativeMobileUpdate } from '../packages/mobile-app/src/lib/clientHelpers.js'
import {
  acquireBlobUrl,
  clearE2eeMediaCache,
  getCachedE2eeImageUrl,
  invalidateCachedE2eeImageUrl,
  loadE2eeImageUrl,
  releaseBlobUrl,
} from '../packages/mobile-app/src/lib/e2eeMedia.js'
import { P2PPeerSession } from '../packages/mobile-app/src/lib/p2pClient.js'

test('streamingStore handles active turn delta/thinking/tool updates and failStream/clearStreamError/clearAllStreamErrors', async () => {
  clearAllStreams()
  const sid1 = 'dsh:stream-unit-1'
  const sid2 = 'dsh:stream-unit-2'
  let sessionNotifies = 0
  let activeNotifies = 0
  const unsubSession = subscribeStream(sid1, () => {
    sessionNotifies += 1
  })
  const unsubActive = subscribeStreamActive(sid1, () => {
    activeNotifies += 1
  })

  try {
    startStream(sid1)
    assert.equal(isStreamActive(sid1), true)
    assert.equal(activeNotifies, 1)

    appendStreamThinking(sid1, 'Thinking step 1...')
    appendStreamDelta(sid1, 'Hello ')
    appendStreamDelta(sid1, 'world!')
    streamToolStart(sid1, { id: 't1', name: 'bash', input: { cmd: 'ls' } })
    streamToolEnd(sid1, 't1', 'completed', 'file.txt')

    const snap = getRawStream(sid1)
    assert.equal(snap.active, true)
    assert.equal(snap.thinking, 'Thinking step 1...')
    assert.equal(snap.text, 'Hello world!')
    assert.equal(snap.tools.length, 1)
    assert.equal(snap.tools[0].status, 'completed')
    assert.equal(snap.tools[0].output, 'file.txt')
    assert.ok(sessionNotifies >= 3)

    // failStream sets error while preserving partial text/thinking/tools by default
    failStream(sid1, 'Network interrupted')
    assert.equal(isStreamActive(sid1), false)
    assert.equal(getRawStream(sid1).error, 'Network interrupted')
    assert.equal(getRawStream(sid1).text, 'Hello world!')
    assert.equal(activeNotifies, 2)

    // clearStreamError removes inactive failed entry cleanly
    clearStreamError(sid1)
    assert.equal(getRawStream(sid1), null)

    // clearAllStreamErrors clears errors across multiple failed sessions without touching active ones
    startStream(sid1)
    failStream(sid1, 'Err 1')
    startStream(sid2)
    failStream(sid2, 'Err 2')
    startStream('dsh:stream-active-3')
    appendStreamDelta('dsh:stream-active-3', 'still running')

    clearAllStreamErrors()
    assert.equal(getRawStream(sid1), null)
    assert.equal(getRawStream(sid2), null)
    assert.equal(isStreamActive('dsh:stream-active-3'), true)

    const finished = finishStream('dsh:stream-active-3')
    assert.equal(finished.text, 'still running')
    assert.equal(getRawStream('dsh:stream-active-3'), null)
  } finally {
    unsubSession()
    unsubActive()
    clearAllStreams()
  }
})

test('sessionCache mergeUnflushedOptimisticTail preserves unflushed optimistic reply and drops it once remote catches up', () => {
  const now = 1_700_000_100_000
  const persistedOld = [
    { id: 'srv-1', role: 'user', text: 'Earlier prompt', ts: now - 60_000 },
    { id: 'srv-2', role: 'assistant', text: 'Earlier answer', ts: now - 55_000 },
  ]
  const optimisticTail = [
    { id: 'msg-u-101', role: 'user', text: 'Run the build', ts: now - 5_000 },
    { id: 'msg-a-102', role: 'assistant', text: 'Build succeeded with 0 warnings.', ts: now - 2_000 },
  ]
  const currentUiMessages = [...persistedOld, ...optimisticTail]

  // Remote PC hasn't flushed the latest turn yet -> preserve optimistic tail
  const preserved = mergeUnflushedOptimisticTail(persistedOld, currentUiMessages, { now })
  assert.equal(preserved.preservedOptimistic, true)
  assert.equal(preserved.messages.length, 4)
  assert.equal(preserved.messages[3].id, 'msg-a-102')

  // Remote PC flushed user turn only -> preserve only assistant optimistic reply
  const halfFlushed = [...persistedOld, { id: 'srv-3', role: 'user', text: 'Run the build', ts: now - 4_900 }]
  const partial = mergeUnflushedOptimisticTail(halfFlushed, currentUiMessages, { now })
  assert.equal(partial.preservedOptimistic, true)
  assert.deepEqual(
    partial.messages.map((m) => m.id),
    ['srv-1', 'srv-2', 'srv-3', 'msg-a-102'],
  )

  // Remote PC catches up with both messages -> drop optimistic tail cleanly
  const fullyFlushed = [
    ...halfFlushed,
    { id: 'srv-4', role: 'assistant', text: 'Build succeeded with 0 warnings.', ts: now - 1_900 },
  ]
  const caughtUp = mergeUnflushedOptimisticTail(fullyFlushed, currentUiMessages, { now })
  assert.equal(caughtUp.preservedOptimistic, false)
  assert.deepEqual(
    caughtUp.messages.map((m) => m.id),
    ['srv-1', 'srv-2', 'srv-3', 'srv-4'],
  )

  // Stale optimistic tail beyond maxAgeMs is dropped
  const expired = mergeUnflushedOptimisticTail(persistedOld, currentUiMessages, {
    now: now + 120_000,
    maxAgeMs: 90_000,
  })
  assert.equal(expired.preservedOptimistic, false)
  assert.equal(expired.messages.length, 2)
})

test('clientHelpers checkNativeMobileUpdate invokes fetchManifestImpl to bypass WebView CORS for GitHub WebBundle manifest', async () => {
  const bundleSha = 'ab'.repeat(32)
  const manifestUrl = 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.30/All-in-One-WebBundle.json'
  const bundleUrl = 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.30/All-in-One-WebBundle.zip'

  const fetchCalls = []
  const manifestFetcherCalls = []

  const fetchImpl = async (url) => {
    fetchCalls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => '' },
      json: async () => ({
        tag_name: 'v1.0.30',
        html_url: 'https://github.com/RainbowLion0320/AllinOne/releases/tag/v1.0.30',
        body: '<!-- android-ota-min-native: 1.0.26 -->',
        assets: [
          {
            name: 'All-in-One-WebBundle.zip',
            size: 123456,
            digest: `sha256:${bundleSha}`,
            browser_download_url: bundleUrl,
          },
          {
            name: 'All-in-One-WebBundle.json',
            size: 420,
            browser_download_url: manifestUrl,
          },
        ],
      }),
    }
  }

  const fetchManifestImpl = async (url) => {
    manifestFetcherCalls.push(url)
    return {
      status: 200,
      body: JSON.stringify({
        version: '1.0.30',
        minNativeVersion: '1.0.26',
        sha256: bundleSha,
        size: 123456,
        sigAlg: 'SHA256withRSA',
        signature: 'ZmFrZS1zaWduYXR1cmUtYnl0ZXMtMTIzNDU2Nzg5MA==',
      }),
    }
  }

  const res = await checkNativeMobileUpdate({
    currentVersion: '1.0.28',
    nativeVersion: '1.0.28',
    hasNativeOta: true,
    locationLike: { protocol: 'https:', hostname: 'localhost' },
    fetchImpl,
    fetchManifestImpl,
  })

  assert.deepEqual(manifestFetcherCalls, [manifestUrl], 'native fetchManifestImpl must be used for WebBundle manifest')
  assert.equal(
    fetchCalls.includes(manifestUrl),
    false,
    'browser fetchImpl must NOT be called for All-in-One-WebBundle.json when fetchManifestImpl is provided',
  )
  assert.equal(res.status, 'available')
  assert.equal(res.hotUpdate, true)
  assert.equal(res.mode, 'capacitor-ota')
  assert.equal(res.latestVersion, '1.0.30')
  assert.equal(res.downloadUrl, bundleUrl)
  assert.equal(res.expectedSha256, bundleSha)
  assert.equal(res.sigAlg, 'SHA256withRSA')
  assert.equal(res.signature, 'ZmFrZS1zaWduYXR1cmUtYnl0ZXMtMTIzNDU2Nzg5MA==')
})

test('e2eeMedia ref-counted acquireBlobUrl/releaseBlobUrl protects mounted Blob URLs from LRU eviction and defers revoke', async () => {
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  let seq = 0
  const created = []
  const revoked = []

  URL.createObjectURL = () => {
    const u = `blob:mock-media-${++seq}`
    created.push(u)
    return u
  }
  URL.revokeObjectURL = (u) => {
    revoked.push(u)
  }

  await clearE2eeMediaCache()
  try {
    let streamSeq = 1
    const fakeClient = {
      rpc: async () => ({
        mimeType: 'image/png',
        transferMode: 'p2p-bulk',
        streamId: streamSeq++,
        size: 4,
      }),
      downloadP2pBulk: async () => ({
        blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      }),
    }
    const baseCtx = { roomId: 'usr_media', bridgeId: 'pc1', cwd: '/ws', e2eeKeyId: '0123456789abcdef', client: fakeClient }

    // Load first image and hold an active mount reference on it
    const pinnedUrl = await loadE2eeImageUrl({ path: '/ws/img-0.png' }, baseCtx)
    acquireBlobUrl(pinnedUrl)

    // Load 55 more images (exceeds MAX_BLOB_CACHE = 48)
    const unpinnedUrl = await loadE2eeImageUrl({ path: '/ws/img-1.png' }, baseCtx)
    for (let i = 2; i <= 55; i += 1) {
      await loadE2eeImageUrl({ path: `/ws/img-${i}.png` }, baseCtx)
    }

    // Pinned URL MUST still be cached and NOT revoked, whereas unpinned oldest URL WAS evicted and revoked
    assert.equal(getCachedE2eeImageUrl({ path: '/ws/img-0.png' }, baseCtx), pinnedUrl)
    assert.equal(revoked.includes(pinnedUrl), false, 'actively held Blob URL must not be revoked on LRU eviction')
    assert.equal(revoked.includes(unpinnedUrl), true, 'unreferenced oldest Blob URL should be evicted and revoked')

    // Invalidating while still held removes from cache map but defers URL.revokeObjectURL until releaseBlobUrl
    invalidateCachedE2eeImageUrl({ path: '/ws/img-0.png' }, baseCtx)
    assert.equal(getCachedE2eeImageUrl({ path: '/ws/img-0.png' }, baseCtx), '')
    assert.equal(revoked.includes(pinnedUrl), false, 'revocation must defer while refcount > 0')

    releaseBlobUrl(pinnedUrl)
    assert.equal(revoked.includes(pinnedUrl), true, 'releaseBlobUrl must revoke immediately once refcount reaches 0')
  } finally {
    await clearE2eeMediaCache()
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  }
})

test('p2pClient P2PPeerSession enforces post-consumption window grants and 24 MB bounded async byte queue cap', async () => {
  const roomId = 'usr_p2p_client'
  const e2eeKey = generateE2eeKey()
  const keyId = await computeE2eeKeyId(e2eeKey)

  const ctrlDecoder = createCtrlCodec()
  const sentBulkCtrls = []
  let ctrlDecodeChain = Promise.resolve()

  const fakeCtrlDc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (bytes) => {
      const msg = ctrlDecoder.decode(bytes)
      if (msg?.type === 'bulk.ctrl' && msg.bin) {
        const snap = msg.bin
        ctrlDecodeChain = ctrlDecodeChain.then(async () => {
          const inner = await decryptBinaryJson(e2eeKey, snap, { kind: 'p2p.bulk', roomId })
          sentBulkCtrls.push(inner)
        })
      }
    },
  }
  const fakeBulkDc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: () => {},
  }

  const session = new P2PPeerSession({
    bridgeId: 'pc1',
    roomId,
    getE2eeContext: () => ({ ready: true, key: e2eeKey, keyId }),
    sendSignal: () => {},
  })
  session.ctrlDc = fakeCtrlDc
  session.bulkDc = fakeBulkDc
  session.state = 'connected'

  try {
    // 1. Window grants are emitted ONLY AFTER consumption (>= 256 KB), never merely on network arrival
    const plain = new Uint8Array(320 * 1024)
    for (let i = 0; i < plain.length; i += 1) plain[i] = i & 0xff
    const encrypted = await encryptChunkedBytes(e2eeKey, plain, {
      kind: 'upload',
      roomId,
      chunkSize: 128 * 1024,
      compress: false,
    })

    const receivedPlain = []
    const dlPromise = session.downloadBulkStream(42, {
      mimeType: 'application/octet-stream',
      size: plain.byteLength,
      onPlainChunk: async (chunk) => {
        receivedPlain.push(chunk)
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    await ctrlDecodeChain
    assert.ok(sentBulkCtrls.some((c) => c.action === 'pull' && c.streamId === 42))

    // Feed all encrypted AIOB frames BEFORE sending download.header (nothing is consuming queue yet)
    let seq = 0
    for (const chunk of encrypted.chunks) {
      for (let off = 0; off < chunk.byteLength; off += BULK_SLICE_BYTES) {
        const slice = chunk.subarray(off, Math.min(chunk.byteLength, off + BULK_SLICE_BYTES))
        session._handleBulkBytes(encodeBulkFrame(42, seq++, slice, 0))
      }
    }
    session._handleBulkBytes(encodeBulkFrame(42, seq++, new Uint8Array(0), BULK_FLAG_EOF))
    await ctrlDecodeChain
    assert.equal(
      sentBulkCtrls.filter((c) => c.action === 'window' && c.streamId === 42).length,
      0,
      'window grant MUST NOT fire before buffered bytes are actually consumed',
    )

    // Now deliver download.header so decryptAutoStream consumes the queued chunks
    session._handleBulkCtrl({
      action: 'download.header',
      streamId: 42,
      e2ee: { v: encrypted.v, kid: encrypted.kid, iv: encrypted.iv, chunked: true },
      size: plain.byteLength,
    })
    const dlRes = await dlPromise
    await ctrlDecodeChain

    assert.equal(dlRes.size, plain.byteLength)
    const totalPlain = receivedPlain.reduce((acc, c) => acc + c.byteLength, 0)
    assert.equal(totalPlain, plain.byteLength)
    const windowGrants = sentBulkCtrls.filter((c) => c.action === 'window' && c.streamId === 42)
    assert.ok(windowGrants.length >= 1, 'window grant must be sent after >= 256 KB consumed')
    assert.ok(windowGrants[0].bytes >= 256 * 1024)

    // 2. Bounded queue (24 MB cap): unconsumed flood > 24 MB aborts download cleanly and sends cancel
    const overflowPromise = session.downloadBulkStream(99, {
      mimeType: 'application/octet-stream',
      size: 30 * 1024 * 1024,
    })
    await new Promise((r) => setTimeout(r, 10))
    const oneMb = new Uint8Array(1024 * 1024)
    for (let i = 0; i < 25; i += 1) {
      session._handleBulkBytes(encodeBulkFrame(99, i, oneMb, 0))
    }
    await assert.rejects(overflowPromise, /安全上限|safety limit/i)
    await new Promise((r) => setTimeout(r, 20))
    await ctrlDecodeChain
    assert.equal(session._activeDownloads.has(99), false)
    assert.ok(
      sentBulkCtrls.some((c) => c.action === 'cancel' && c.streamId === 99 && c.direction === 'download'),
      'overflow abort must notify peer with cancel',
    )
  } finally {
    await session.close(false)
  }
})
