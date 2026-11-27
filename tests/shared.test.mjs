import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compareCodePoint, compareSemver, parseSemver } from '../packages/shared/src/semver.js'
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, SANDBOX_PREVIEW_CSP, WS_MSG } from '../packages/shared/src/protocol.js'
import {
  clearKeyCache,
  computeE2eeKeyId,
  computeGrantCommitment,
  decryptGrantPayload,
  deflateRawBytes,
  deriveGrantSas,
  encryptGrantPayload,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantNonce,
  generateGrantReqId,
  generateGrantSecret,
  inflateRawBytes,
} from '../packages/shared/src/e2ee.js'
import {
  BULK_SLICE_BYTES,
  createBulkWindowController,
  createCtrlCodec,
  createSerializedChannelWriter,
} from '../packages/shared/src/p2p-mux.js'

test('semver comparison handles core, pre-release, and v-prefix', () => {
  assert.equal(compareSemver('1.0.30', '1.0.29'), 1)
  assert.equal(compareSemver('v1.0.29', '1.0.29'), 0)
  assert.equal(compareSemver('1.0.29-alpha.1', '1.0.29'), -1)
  assert.equal(compareSemver('1.0.29-beta.1', '1.0.29-alpha.2'), 1)
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1)
  assert.equal(parseSemver('invalid'), null)
})

test('protocol constants export version, capabilities, WS_MSG, and sandbox CSP', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.ok(PROTOCOL_CAPABILITIES.includes('grant-v2'))
  assert.ok(PROTOCOL_CAPABILITIES.includes('bulk-window-v1'))
  assert.ok(PROTOCOL_CAPABILITIES.includes('event-sync-v1'))
  assert.equal(WS_MSG.P2P_SIGNAL, 'p2p.signal')
  assert.ok(SANDBOX_PREVIEW_CSP.includes("connect-src 'none'"))
})

test('E2EE grant v2 enforces mandatory nonces and binds nonces into HKDF + AAD', async () => {
  const pairReq = await generateGrantKeyPair()
  const pairApp = await generateGrantKeyPair()
  const reqId = generateGrantReqId()
  const roomId = 'usr_unit_room_1'
  const reqNonce = generateGrantNonce()
  const appNonce = generateGrantNonce()

  await assert.rejects(
    () => deriveGrantSas({ requesterPubKey: pairReq.publicKeyRaw, approverPubKey: pairApp.publicKeyRaw, reqId, roomId }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )

  const sasA = await deriveGrantSas({
    requesterPubKey: pairReq.publicKeyRaw,
    approverPubKey: pairApp.publicKeyRaw,
    reqId,
    roomId,
    requesterNonce: reqNonce,
    approverNonce: appNonce,
  })
  const sasB = await deriveGrantSas({
    requesterPubKey: pairReq.publicKeyRaw,
    approverPubKey: pairApp.publicKeyRaw,
    reqId,
    roomId,
    requesterNonce: reqNonce,
    approverNonce: appNonce,
  })
  assert.match(sasA, /^\d{3}-\d{3}$/)
  assert.equal(sasA, sasB)

  const commit = await computeGrantCommitment({ reqId, roomId, pubKey: pairReq.publicKeyRaw, nonce: reqNonce })
  assert.match(commit, /^[0-9a-f]{64}$/)

  const roomKey = generateE2eeKey()
  const env = await encryptGrantPayload({
    approverPrivateKey: pairApp.privateKey,
    approverPubKeyRaw: pairApp.publicKeyRaw,
    requesterPubKeyRaw: pairReq.publicKeyRaw,
    reqId,
    roomId,
    requesterNonce: reqNonce,
    approverNonce: appNonce,
    payload: { keys: [{ keyId: '0123456789abcdef', key: roomKey }] },
  })
  const dec = await decryptGrantPayload({
    requesterPrivateKey: pairReq.privateKey,
    requesterPubKeyRaw: pairReq.publicKeyRaw,
    envelope: env,
    roomId,
    expectedReqId: reqId,
    expectedApproverPubKey: pairApp.publicKeyRaw,
    requesterNonce: reqNonce,
    approverNonce: appNonce,
  })
  assert.equal(dec.keys[0].key, roomKey)

  // Tampered nonce MUST fail decryption
  await assert.rejects(
    () =>
      decryptGrantPayload({
        requesterPrivateKey: pairReq.privateKey,
        requesterPubKeyRaw: pairReq.publicKeyRaw,
        envelope: env,
        roomId,
        expectedReqId: reqId,
        expectedApproverPubKey: pairApp.publicKeyRaw,
        requesterNonce: generateGrantNonce(),
        approverNonce: appNonce,
      }),
    /解密授权密钥包失败/,
  )

  // QR secret binding also rejects missing secret
  const qrSecret = generateGrantSecret()
  const qrEnv = await encryptGrantPayload({
    approverPrivateKey: pairApp.privateKey,
    approverPubKeyRaw: pairApp.publicKeyRaw,
    requesterPubKeyRaw: pairReq.publicKeyRaw,
    reqId,
    roomId,
    grantSecret: qrSecret,
    payload: { keys: [{ keyId: '0123456789abcdef', key: roomKey }] },
  })
  assert.equal(qrEnv.mode, 'qr')
  await assert.rejects(
    () => decryptGrantPayload({ requesterPrivateKey: pairReq.privateKey, requesterPubKeyRaw: pairReq.publicKeyRaw, envelope: qrEnv, roomId, expectedReqId: reqId }),
    /解密授权密钥包失败/,
  )
})

test('p2p-mux serialized writer preserves FIFO order, ctrl codec fragments/reassembles, and bulk window blocks/resumes on credits', async () => {
  const sent = []
  const fakeDc = {
    readyState: 'open',
    bufferedAmount: 0,
    send: (bytes) => sent.push(bytes.length),
  }
  const writer = createSerializedChannelWriter(fakeDc)
  await Promise.all([
    writer.send(new Uint8Array(10)),
    writer.send(new Uint8Array(20)),
    writer.send(new Uint8Array(30)),
  ])
  assert.deepEqual(sent, [10, 20, 30])

  const codec = createCtrlCodec()
  const bigBin = new Uint8Array(120 * 1024)
  for (let i = 0; i < bigBin.length; i += 1) bigBin[i] = i & 0xff
  const frames = codec.encode({ type: 'rpc.res', id: '1', result: { text: 'hello '.repeat(200) }, bin: bigBin })
  assert.ok(frames.length >= 2)
  let unpacked = null
  for (const frame of frames) {
    unpacked = codec.decode(frame)
  }
  assert.ok(unpacked)
  assert.equal(unpacked.id, '1')
  assert.equal(unpacked.result.text, 'hello '.repeat(200))
  assert.equal(unpacked.bin.byteLength, bigBin.byteLength)
  assert.equal(unpacked.bin[12345], bigBin[12345])

  const winSize = Math.max(BULK_SLICE_BYTES, 64 * 1024)
  const win = createBulkWindowController({ initialWindowBytes: winSize, timeoutMs: 2000 })
  await win.consume(winSize)
  let unblocked = false
  const waitP = win.consume(1024).then(() => {
    unblocked = true
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(unblocked, false)
  win.grant(2048)
  await waitP
  assert.equal(unblocked, true)
})

test('pure-JS sha256Sync parity: computeE2eeKeyId matches Node crypto SHA-256 across 10 random keys', async () => {
  clearKeyCache()
  for (let i = 0; i < 10; i += 1) {
    const key = generateE2eeKey()
    const rawKeyBytes = Buffer.from(key, 'base64url')
    const expected = createHash('sha256')
      .update('allinone-e2ee-v1-id:')
      .update(rawKeyBytes)
      .digest('hex')
      .slice(0, 16)
    const actual = await computeE2eeKeyId(key)
    assert.equal(actual, expected, `keyId mismatch on random key #${i}`)
  }
  clearKeyCache()
})

test('compareCodePoint provides locale-independent deterministic UTF-16 code-point ordering', () => {
  // Strictly ASCII code-point order: '-' (45) < '0' (48) < 'A' (65) < 'Z' (90) < '_' (95) < 'a' (97) < 'z' (122)
  assert.equal(compareCodePoint('Z', 'a'), -1)
  assert.equal(compareCodePoint('a', 'Z'), 1)
  assert.equal(compareCodePoint('-', '_'), -1)
  assert.equal(compareCodePoint('0', 'A'), -1)
  assert.equal(compareCodePoint('Z', '_'), -1)
  assert.equal(compareCodePoint('_', 'a'), -1)
  assert.equal(compareCodePoint('same', 'same'), 0)

  const input = ['b.js', 'Z.js', 'a.js', 'A.js', '_init.js', '-flag.js', '01.js']
  const sorted = [...input].sort(compareCodePoint)
  assert.deepEqual(sorted, ['-flag.js', '01.js', 'A.js', 'Z.js', '_init.js', 'a.js', 'b.js'])
})

test('inflateRawBytes enforces hard-cap and clamps invalid/NaN/Infinity maxBytes', async () => {
  // Small payload round-trips cleanly within budget and rejects when exceeding explicit cap
  const smallPlain = new Uint8Array(4096).fill(0x41)
  const smallDeflated = await deflateRawBytes(smallPlain)
  const inflatedOk = await inflateRawBytes(smallDeflated, 4096)
  assert.equal(inflatedOk.byteLength, 4096)
  await assert.rejects(
    () => inflateRawBytes(smallDeflated, 1024),
    (err) => err?.code === 'E2EE_DECRYPT_FAILED',
  )

  // Invalid / NaN / Infinity / non-positive maxBytes clamp to 16 MB default cap (never unbounded)
  const overDefaultPlain = new Uint8Array(17 * 1024 * 1024)
  const overDefaultDeflated = await deflateRawBytes(overDefaultPlain)
  for (const badCap of [Infinity, -Infinity, NaN, 0, -100, 'not-a-number']) {
    await assert.rejects(
      () => inflateRawBytes(overDefaultDeflated, badCap),
      (err) => err?.code === 'E2EE_DECRYPT_FAILED',
      `expected cap=${String(badCap)} to enforce 16 MB fallback cap`,
    )
  }

  // Huge explicit cap (> 64 MB) MUST clamp to the 64 MB hard cap
  const overHardCapPlain = new Uint8Array(65 * 1024 * 1024)
  const overHardCapDeflated = await deflateRawBytes(overHardCapPlain)
  await assert.rejects(
    () => inflateRawBytes(overHardCapDeflated, 128 * 1024 * 1024),
    (err) => err?.code === 'E2EE_DECRYPT_FAILED',
  )
})

test('E2EE grant v2 rejects partial nonces (one nonce without the other)', async () => {
  const pairReq = await generateGrantKeyPair()
  const pairApp = await generateGrantKeyPair()
  const reqId = generateGrantReqId()
  const roomId = 'usr_partial_nonce'
  const reqNonce = generateGrantNonce()
  const appNonce = generateGrantNonce()
  const roomKey = generateE2eeKey()

  // deriveGrantSas rejects single-sided nonces
  await assert.rejects(
    () => deriveGrantSas({ requesterPubKey: pairReq.publicKeyRaw, approverPubKey: pairApp.publicKeyRaw, reqId, roomId, requesterNonce: reqNonce }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )
  await assert.rejects(
    () => deriveGrantSas({ requesterPubKey: pairReq.publicKeyRaw, approverPubKey: pairApp.publicKeyRaw, reqId, roomId, approverNonce: appNonce }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )

  // encryptGrantPayload rejects single-sided nonces
  await assert.rejects(
    () =>
      encryptGrantPayload({
        approverPrivateKey: pairApp.privateKey,
        approverPubKeyRaw: pairApp.publicKeyRaw,
        requesterPubKeyRaw: pairReq.publicKeyRaw,
        reqId,
        roomId,
        requesterNonce: reqNonce,
        payload: { keys: [{ keyId: '0123456789abcdef', key: roomKey }] },
      }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )
  await assert.rejects(
    () =>
      encryptGrantPayload({
        approverPrivateKey: pairApp.privateKey,
        approverPubKeyRaw: pairApp.publicKeyRaw,
        requesterPubKeyRaw: pairReq.publicKeyRaw,
        reqId,
        roomId,
        approverNonce: appNonce,
        payload: { keys: [{ keyId: '0123456789abcdef', key: roomKey }] },
      }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )

  // decryptGrantPayload rejects single-sided nonces
  const validEnv = await encryptGrantPayload({
    approverPrivateKey: pairApp.privateKey,
    approverPubKeyRaw: pairApp.publicKeyRaw,
    requesterPubKeyRaw: pairReq.publicKeyRaw,
    reqId,
    roomId,
    requesterNonce: reqNonce,
    approverNonce: appNonce,
    payload: { keys: [{ keyId: '0123456789abcdef', key: roomKey }] },
  })
  await assert.rejects(
    () =>
      decryptGrantPayload({
        requesterPrivateKey: pairReq.privateKey,
        requesterPubKeyRaw: pairReq.publicKeyRaw,
        envelope: validEnv,
        roomId,
        expectedReqId: reqId,
        requesterNonce: reqNonce,
      }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )
  await assert.rejects(
    () =>
      decryptGrantPayload({
        requesterPrivateKey: pairReq.privateKey,
        requesterPubKeyRaw: pairReq.publicKeyRaw,
        envelope: validEnv,
        roomId,
        expectedReqId: reqId,
        approverNonce: appNonce,
      }),
    (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
  )
})

test('createBulkWindowController recovers immediately from HoL deadlock on front waiter abort or timeout', async () => {
  // Abort case: 20 KB available, waiter[0] needs 100 KB (aborted), waiter[1] needs 10 KB -> wakes immediately
  const winAbort = createBulkWindowController({ initialWindowBytes: BULK_SLICE_BYTES, timeoutMs: 5_000 })
  await winAbort.consume(BULK_SLICE_BYTES - 20 * 1024)
  assert.equal(winAbort.availableBytes, 20 * 1024)

  const ac = new AbortController()
  const w0 = winAbort.consume(100 * 1024, ac.signal)
  let w1Done = false
  const w1 = winAbort.consume(10 * 1024).then(() => {
    w1Done = true
  })

  await new Promise((r) => setTimeout(r, 15))
  assert.equal(w1Done, false, 'waiter[1] must wait behind waiter[0] before abort')

  ac.abort()
  await assert.rejects(w0, (err) => err?.name === 'AbortError')
  await w1
  assert.equal(w1Done, true)
  assert.equal(winAbort.availableBytes, 10 * 1024)

  // Timeout case: front waiter times out -> waiter[1] wakes immediately
  // Keep a ref'd timer alive because createBulkWindowController calls timer.unref()
  const keepAlive = setTimeout(() => {}, 500)
  try {
    const winTimeout = createBulkWindowController({ initialWindowBytes: BULK_SLICE_BYTES, timeoutMs: 35 })
    await winTimeout.consume(BULK_SLICE_BYTES - 20 * 1024)
    const tw0 = winTimeout.consume(100 * 1024)
    let tw1Done = false
    const tw1 = winTimeout.consume(10 * 1024).then(() => {
      tw1Done = true
    })
    await assert.rejects(tw0, /timeout/i)
    await tw1
    assert.equal(tw1Done, true)
    assert.equal(winTimeout.availableBytes, 10 * 1024)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('createCtrlCodec evicts stale/incomplete large assemblies when maxTotalReassemblyBytes is tight', () => {
  const codec = createCtrlCodec({ maxTotalReassemblyBytes: 120 * 1024 })

  const binA = new Uint8Array(100 * 1024).fill(0xaa)
  const framesA = codec.encode({ type: 'rpc.res', id: 'msgA', bin: binA })
  assert.ok(framesA.length >= 3)

  // Feed only first 2 fragments of msgA (~96 KB buffered, incomplete)
  assert.equal(codec.decode(framesA[0]), null)
  assert.equal(codec.decode(framesA[1]), null)

  // Feed ALL fragments of msgB (~100 KB) — must evict incomplete msgA to fit inside 120 KB cap
  const binB = new Uint8Array(100 * 1024).fill(0xbb)
  const framesB = codec.encode({ type: 'rpc.res', id: 'msgB', bin: binB })
  let decodedB = null
  for (const f of framesB) {
    decodedB = codec.decode(f)
  }
  assert.ok(decodedB)
  assert.equal(decodedB.id, 'msgB')
  assert.equal(decodedB.bin.byteLength, binB.byteLength)
  assert.equal(decodedB.bin[0], 0xbb)

  // Final fragment of msgA can no longer complete because msgA was evicted
  assert.equal(codec.decode(framesA[framesA.length - 1]), null)
})

test('createSerializedChannelWriter supports dynamic setChannel/getter binding and propagates close() errors', async () => {
  const log1 = []
  const log2 = []
  const log3 = []
  const makeDc = (bucket) => ({
    readyState: 'open',
    bufferedAmount: 0,
    send: (bytes) => bucket.push(bytes.byteLength),
  })

  let dynamicDc = null
  const writer = createSerializedChannelWriter(() => dynamicDc)
  await assert.rejects(() => writer.send(new Uint8Array(4)), /not bound/)

  dynamicDc = makeDc(log1)
  await writer.send(new Uint8Array(11))
  assert.deepEqual(log1, [11])

  // Switch to direct channel via setChannel(dc)
  writer.setChannel(makeDc(log2))
  await writer.send(new Uint8Array(22))
  assert.deepEqual(log1, [11])
  assert.deepEqual(log2, [22])

  // Switch to another getter via setChannel(fn)
  const dc3 = makeDc(log3)
  writer.setChannel(() => dc3)
  await writer.send(new Uint8Array(33))
  assert.deepEqual(log3, [33])

  // Closing mid-queue rejects queued and future operations cleanly
  let markStarted
  let releaseFirst
  const firstStarted = new Promise((r) => {
    markStarted = r
  })
  const firstGate = new Promise((r) => {
    releaseFirst = r
  })
  const pFirst = writer.enqueue(() => {
    markStarted()
    return firstGate
  })
  const pQueued = writer.send(new Uint8Array(44))
  await firstStarted
  writer.close()
  releaseFirst()
  await pFirst
  await assert.rejects(pQueued, /DataChannel writer closed/)
  await assert.rejects(() => writer.send(new Uint8Array(55)), /DataChannel writer closed/)
  await assert.rejects(() => writer.enqueue(() => {}), /DataChannel writer closed/)
})
