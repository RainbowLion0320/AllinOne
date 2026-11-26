import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver } from '../packages/shared/src/semver.js'
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, SANDBOX_PREVIEW_CSP, WS_MSG } from '../packages/shared/src/protocol.js'
import {
  computeGrantCommitment,
  decryptGrantPayload,
  deriveGrantSas,
  encryptGrantPayload,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantNonce,
  generateGrantReqId,
  generateGrantSecret,
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
