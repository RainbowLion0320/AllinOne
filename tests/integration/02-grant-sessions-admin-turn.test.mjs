import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import dgram from 'node:dgram'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  buildTurnCredentials,
  createRelayServer,
  normalizeCloudflareIceResponse,
  parseCfTurnTiers,
} from '../../packages/relay-server/src/index.js'
import {
  buildTurnQuotaSnapshot,
  getTurnQuotaBytesForTier,
  parseCoturnUsageLine,
  resolveTurnQuotaConfig,
} from '../../packages/relay-server/src/turn-meter.js'
import { EVENTS } from '../../packages/shared/src/protocol.js'
import {
  computeE2eeKeyId,
  computeGrantCommitment,
  computeGrantPubKeyFp,
  decryptGrantPayload,
  deriveGrantSas,
  encodeE2eeGrantQrUri,
  encryptGrantPayload,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantNonce,
  generateGrantReqId,
  generateGrantSecret,
  parseE2eeGrantQrInput,
} from '../../packages/shared/src/e2ee.js'
import {
  SMOKE_ADMIN_PASS,
  TEST_BOOTSTRAP_TOKEN,
  connectMockBridgeWs,
  createIsolatedRelayEnv,
  createMockSmtpServer,
  createTempDir,
  openTicketClientWs,
} from './harness.mjs'

test('Suite 5: Zero-Knowledge Device-to-Device Key Grant (ECDH P-256, SAS, Reverse-QR, MITM defense) & QR Scan Nudge', async () => {
  const env = await createIsolatedRelayEnv('allinone-int-02-grant-')
  const { port, httpBase } = env

  try {
    const smokeAdmin = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'grant_admin',
          password: SMOKE_ADMIN_PASS,
          bootstrapToken: TEST_BOOTSTRAP_TOKEN,
          deviceName: 'grant-phone',
        }),
      })
    ).json()
    assert.equal(smokeAdmin.ok, true)

    const friendB = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'grant_other', password: 'FriendBPass99!' }),
      })
    ).json()
    assert.equal(friendB.ok, true)

    const roomKeyA = generateE2eeKey()
    const roomKeyAId = await computeE2eeKeyId(roomKeyA)
    const pairC = await generateGrantKeyPair()
    const pairB = await generateGrantKeyPair()
    const pairEvil = await generateGrantKeyPair()
    const reqId1 = generateGrantReqId()
    const testRoomId = 'usr_grant_crypto_unit'

    assert.equal(pairC.publicKeyFp.length, 16)
    assert.equal(await computeGrantPubKeyFp(pairC.publicKeyRaw), pairC.publicKeyFp)
    const grantUri = encodeE2eeGrantQrUri({ reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp })
    assert.deepEqual(parseE2eeGrantQrInput(grantUri), { reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp, grantSecret: '' })

    // v2 Commit-then-Reveal SAS + out-of-band QR grantSecret cryptographic checks
    const qrSec1 = generateGrantSecret()
    const grantUriV2 = encodeE2eeGrantQrUri({ reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp, grantSecret: qrSec1 })
    assert.deepEqual(parseE2eeGrantQrInput(grantUriV2), { reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp, grantSecret: qrSec1 })
    const reqNonce1 = generateGrantNonce()
    const appNonce1 = generateGrantNonce()
    const commit1 = await computeGrantCommitment({ reqId: reqId1, roomId: testRoomId, pubKey: pairC.publicKeyRaw, nonce: reqNonce1 })
    assert.match(commit1, /^[0-9a-f]{64}$/)
    assert.notEqual(
      await computeGrantCommitment({ reqId: reqId1, roomId: testRoomId, pubKey: pairC.publicKeyRaw, nonce: generateGrantNonce() }),
      commit1,
    )
    const sasV2C = await deriveGrantSas({
      requesterPubKey: pairC.publicKeyRaw,
      approverPubKey: pairB.publicKeyRaw,
      reqId: reqId1,
      roomId: testRoomId,
      requesterNonce: reqNonce1,
      approverNonce: appNonce1,
    })
    const sasV2B = await deriveGrantSas({
      requesterPubKey: pairC.publicKeyRaw,
      approverPubKey: pairB.publicKeyRaw,
      reqId: reqId1,
      roomId: testRoomId,
      requesterNonce: reqNonce1,
      approverNonce: appNonce1,
    })
    assert.match(sasV2C, /^\d{3}-\d{3}$/)
    assert.equal(sasV2C, sasV2B)

    // v2 Commit-then-Reveal SAS enforces mandatory nonces (missing nonces MUST throw)
    await assert.rejects(
      () => deriveGrantSas({ requesterPubKey: pairC.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId }),
      (err) => err?.code === 'E2EE_GRANT_NONCE_REQUIRED',
    )
    assert.notEqual(
      await deriveGrantSas({
        requesterPubKey: pairEvil.publicKeyRaw,
        approverPubKey: pairB.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
        requesterNonce: reqNonce1,
        approverNonce: appNonce1,
      }),
      sasV2C,
    )

    const env1 = await encryptGrantPayload({
      approverPrivateKey: pairB.privateKey,
      approverPubKeyRaw: pairB.publicKeyRaw,
      requesterPubKeyRaw: pairC.publicKeyRaw,
      reqId: reqId1,
      roomId: testRoomId,
      requesterNonce: reqNonce1,
      approverNonce: appNonce1,
      payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
    })
    assert.equal(JSON.stringify(env1).includes(roomKeyA), false)
    const dec1 = await decryptGrantPayload({
      requesterPrivateKey: pairC.privateKey,
      requesterPubKeyRaw: pairC.publicKeyRaw,
      envelope: env1,
      roomId: testRoomId,
      expectedReqId: reqId1,
      expectedApproverPubKey: pairB.publicKeyRaw,
      requesterNonce: reqNonce1,
      approverNonce: appNonce1,
    })
    assert.equal(dec1.keys[0].key, roomKeyA)
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: testRoomId,
          expectedReqId: 'deadbeef00000000',
          requesterNonce: reqNonce1,
          approverNonce: appNonce1,
        }),
      (err) => err?.code === 'E2EE_GRANT_REQID_MISMATCH',
    )
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: testRoomId,
          expectedApproverPubKey: pairEvil.publicKeyRaw,
          requesterNonce: reqNonce1,
          approverNonce: appNonce1,
        }),
      /E2EE_GRANT_PUBKEY_MISMATCH|安全码/,
    )
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: testRoomId,
          grantSecret: qrSec1,
          requesterNonce: reqNonce1,
          approverNonce: appNonce1,
        }),
      /解密授权密钥包失败/,
    )
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: 'usr_wrong',
          requesterNonce: reqNonce1,
          approverNonce: appNonce1,
        }),
      /解密授权密钥包失败/,
    )
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: { ...env1, ct: `${env1.ct.slice(0, -2)}AA` },
          roomId: testRoomId,
          requesterNonce: reqNonce1,
          approverNonce: appNonce1,
        }),
      /解密授权密钥包失败/,
    )
    await assert.rejects(
      () =>
        decryptGrantPayload({
          requesterPrivateKey: pairC.privateKey,
          requesterPubKeyRaw: pairC.publicKeyRaw,
          envelope: env1,
          roomId: testRoomId,
          requesterNonce: generateGrantNonce(),
          approverNonce: appNonce1,
        }),
      /解密授权密钥包失败/,
    )

    // Live Relay signaling on isolated relay (`grant_admin` PC & Phone vs isolated `grant_other`)
    const compC = await openTicketClientWs(httpBase, port, smokeAdmin.token, { deviceName: 'Windows Desktop', clientKind: 'desktop' })
    const mallory = await openTicketClientWs(httpBase, port, friendB.token, { deviceName: 'Other-Account', clientKind: 'web' })
    let phoneB = null
    try {
      const cPair1 = await generateGrantKeyPair()
      const liveReqId1 = generateGrantReqId()
      const liveReqNonce1 = generateGrantNonce()
      const liveCommit1 = await computeGrantCommitment({
        reqId: liveReqId1,
        roomId: smokeAdmin.roomId,
        pubKey: cPair1.publicKeyRaw,
        nonce: liveReqNonce1,
      })
      compC.ws.send(
        JSON.stringify({
          type: 'e2ee.grant.req',
          reqId: liveReqId1,
          pubKey: cPair1.publicKeyRaw,
          commit: liveCommit1,
          wantedKeyId: roomKeyAId,
        }),
      )
      await new Promise((r) => setTimeout(r, 60))

      // Cross-account Mallory sees 0 grants and forged reject/offer are silently ignored
      assert.equal(mallory.hello.pendingGrants.length, 0)
      mallory.ws.send(JSON.stringify({ type: 'e2ee.grant.list', id: 'm-list' }))
      const mList = await mallory.waitFor((m) => m.type === 'e2ee.grant.list.res' && m.id === 'm-list')
      assert.equal(mList.grants.length, 0)
      mallory.ws.send(JSON.stringify({ type: 'e2ee.grant.reject', reqId: liveReqId1 }))
      mallory.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId: liveReqId1, approverPubKey: pairEvil.publicKeyRaw }))
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(compC.inbox.some((m) => m.event === EVENTS.E2EE_GRANT_REJECT || m.event === EVENTS.E2EE_GRANT_OFFER), false)

      // Phone B connects late -> receives pending grant (including commit) in hello frame
      phoneB = await openTicketClientWs(httpBase, port, smokeAdmin.token, { deviceName: 'iPhone · Safari', clientKind: 'mobile' })
      assert.equal(phoneB.hello.pendingGrants.length, 1)
      assert.equal(phoneB.hello.pendingGrants[0].reqId, liveReqId1)
      assert.equal(phoneB.hello.pendingGrants[0].commit, liveCommit1)

      // Path A: Commit-then-Reveal SAS Push -> Deliver -> Single-use burn
      const bPair1 = await generateGrantKeyPair()
      const liveAppNonce1 = generateGrantNonce()
      phoneB.ws.send(
        JSON.stringify({
          type: 'e2ee.grant.offer',
          reqId: liveReqId1,
          approverPubKey: bPair1.publicKeyRaw,
          approverNonce: liveAppNonce1,
        }),
      )
      const offerEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_OFFER && m.payload?.reqId === liveReqId1)
      assert.equal(offerEv.payload.approverPubKey, bPair1.publicKeyRaw)
      assert.equal(offerEv.payload.approverNonce, liveAppNonce1)
      compC.ws.send(JSON.stringify({ type: 'e2ee.grant.reveal', reqId: liveReqId1, requesterNonce: liveReqNonce1 }))
      const revealEv = await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REVEAL && m.payload?.reqId === liveReqId1)
      assert.equal(revealEv.payload.requesterNonce, liveReqNonce1)
      assert.equal(
        await computeGrantCommitment({
          reqId: liveReqId1,
          roomId: smokeAdmin.roomId,
          pubKey: cPair1.publicKeyRaw,
          nonce: revealEv.payload.requesterNonce,
        }),
        liveCommit1,
      )

      const liveEnv1 = await encryptGrantPayload({
        approverPrivateKey: bPair1.privateKey,
        approverPubKeyRaw: bPair1.publicKeyRaw,
        requesterPubKeyRaw: cPair1.publicKeyRaw,
        reqId: liveReqId1,
        roomId: smokeAdmin.roomId,
        requesterNonce: liveReqNonce1,
        approverNonce: liveAppNonce1,
        payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
      })
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
      const deliverEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId1)
      const unlocked1 = await decryptGrantPayload({
        requesterPrivateKey: cPair1.privateKey,
        requesterPubKeyRaw: cPair1.publicKeyRaw,
        envelope: deliverEv.payload.envelope,
        roomId: smokeAdmin.roomId,
        expectedReqId: liveReqId1,
        expectedApproverPubKey: offerEv.payload.approverPubKey,
        requesterNonce: liveReqNonce1,
        approverNonce: liveAppNonce1,
      })
      assert.equal(unlocked1.keys[0].key, roomKeyA)

      // Burned reqId ignores replay
      const deliverBefore = compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length, deliverBefore)

      // Path B: Reverse-QR out-of-band 1-tap delivery bound to 128-bit grantSecret
      const cPair2 = await generateGrantKeyPair()
      const liveReqId2 = generateGrantReqId()
      const liveReqNonce2 = generateGrantNonce()
      const liveCommit2 = await computeGrantCommitment({
        reqId: liveReqId2,
        roomId: smokeAdmin.roomId,
        pubKey: cPair2.publicKeyRaw,
        nonce: liveReqNonce2,
      })
      const liveQrSecret2 = generateGrantSecret()
      const parsedQr2 = parseE2eeGrantQrInput(
        encodeE2eeGrantQrUri({
          reqId: liveReqId2,
          roomId: smokeAdmin.roomId,
          pubKeyFp: cPair2.publicKeyFp,
          grantSecret: liveQrSecret2,
        }),
      )
      assert.equal(parsedQr2.grantSecret, liveQrSecret2)
      compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId2, pubKey: cPair2.publicKeyRaw, commit: liveCommit2 }))
      await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === liveReqId2)

      phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.list', id: 'b-list-2' }))
      const bList2 = await phoneB.waitFor((m) => m.type === 'e2ee.grant.list.res' && m.id === 'b-list-2')
      const found2 = bList2.grants.find((g) => g.reqId === parsedQr2.reqId)
      assert.equal(await computeGrantPubKeyFp(found2.pubKey), parsedQr2.pubKeyFp)

      const bPair2 = await generateGrantKeyPair()
      const liveEnv2 = await encryptGrantPayload({
        approverPrivateKey: bPair2.privateKey,
        approverPubKeyRaw: bPair2.publicKeyRaw,
        requesterPubKeyRaw: found2.pubKey,
        reqId: liveReqId2,
        roomId: smokeAdmin.roomId,
        grantSecret: parsedQr2.grantSecret,
        payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
      })
      assert.equal(liveEnv2.mode, 'qr')
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId2, envelope: liveEnv2 }))
      const deliverEv2 = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId2)
      // Relay-forged delivery without grantSecret must fail decryption
      const forgedEnv = await encryptGrantPayload({
        approverPrivateKey: pairEvil.privateKey,
        approverPubKeyRaw: pairEvil.publicKeyRaw,
        requesterPubKeyRaw: cPair2.publicKeyRaw,
        reqId: liveReqId2,
        roomId: smokeAdmin.roomId,
        payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }] },
      })
      await assert.rejects(
        () =>
          decryptGrantPayload({
            requesterPrivateKey: cPair2.privateKey,
            requesterPubKeyRaw: cPair2.publicKeyRaw,
            envelope: forgedEnv,
            roomId: smokeAdmin.roomId,
            expectedReqId: liveReqId2,
            grantSecret: liveQrSecret2,
          }),
        /解密授权密钥包失败/,
      )
      const unlocked2 = await decryptGrantPayload({
        requesterPrivateKey: cPair2.privateKey,
        requesterPubKeyRaw: cPair2.publicKeyRaw,
        envelope: deliverEv2.payload.envelope,
        roomId: smokeAdmin.roomId,
        expectedReqId: liveReqId2,
        grantSecret: liveQrSecret2,
      })
      assert.equal(unlocked2.keys[0].key, roomKeyA)

      // Mobile-to-Desktop E2EE QR Scan Nudge (same-room delivery, rate limit, room isolation & disconnect cleanup)
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: '0123456789abcdef' }))
      const nudgeScan = await compC.waitFor((m) => m.event === EVENTS.E2EE_QR_NUDGE && m.payload?.action === 'scanning')
      assert.equal(nudgeScan.payload.deviceName, 'iPhone · Safari')
      assert.equal(nudgeScan.payload.wantedKeyId, '0123456789abcdef')

      // Rapid duplicate & invalid hex ignored; sender & other account receive 0
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: '0123456789abcdef' }))
      phoneB.ws.send(JSON.stringify({ type: 'e2ee.qr.nudge', action: 'scanning', wantedKeyId: 'not-valid-hex!' }))
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(compC.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE && e.payload?.action === 'scanning').length, 1)
      assert.equal(phoneB.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE).length, 0)
      assert.equal(mallory.events.filter((e) => e.event === EVENTS.E2EE_QR_NUDGE).length, 0)

      // Disconnect auto-cancel for pending grant + disconnect `done` nudge
      const cPair3 = await generateGrantKeyPair()
      const liveReqId3 = generateGrantReqId()
      const liveReqNonce3 = generateGrantNonce()
      const liveCommit3 = await computeGrantCommitment({
        reqId: liveReqId3,
        roomId: smokeAdmin.roomId,
        pubKey: cPair3.publicKeyRaw,
        nonce: liveReqNonce3,
      })
      compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId3, pubKey: cPair3.publicKeyRaw, commit: liveCommit3 }))
      await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === liveReqId3)
      phoneB.ws.close()
      const nudgeDone = await compC.waitFor((m) => m.event === EVENTS.E2EE_QR_NUDGE && m.payload?.action === 'done')
      assert.equal(nudgeDone.payload.requesterClientId, phoneB.hello.clientId)

      // Open fresh Phone B briefly to observe compC disconnect auto-cancel
      const phoneB2 = await openTicketClientWs(httpBase, port, smokeAdmin.token, { deviceName: 'Android App', clientKind: 'mobile' })
      try {
        compC.ws.close()
        const cancelEv3 = await phoneB2.waitFor((m) => m.event === EVENTS.E2EE_GRANT_CANCEL && m.payload?.reqId === liveReqId3)
        assert.equal(cancelEv3.payload.reason, 'disconnected')
      } finally {
        await phoneB2.closeAll()
      }
    } finally {
      await compC.closeAll()
      await mallory.closeAll()
      if (phoneB) await phoneB.closeAll()
    }
  } finally {
    await env.cleanup()
  }
})

test('Suite 6: Active client sessions monitor, device/session dedup, live push, per-device kick & revoke-all', async () => {
  const env = await createIsolatedRelayEnv('allinone-int-02-sessions-', { adminBootstrapToken: '' })
  const { port, httpBase } = env

  try {
    const regA = await (
      await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'sess_alice',
          password: 'Password123!',
          deviceName: 'Windows Desktop',
          clientKind: 'desktop',
        }),
      })
    ).json()
    const loginB = await (
      await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sess_alice', password: 'Password123!', deviceName: 'Android App', clientKind: 'mobile' }),
      })
    ).json()
    const loginC = await (
      await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sess_alice', password: 'Password123!', deviceName: 'macOS · Chrome', clientKind: 'web' }),
      })
    ).json()

    const cliA = await openTicketClientWs(httpBase, port, regA.token, { deviceName: 'Windows Desktop', clientKind: 'desktop' })
    const cliB = await openTicketClientWs(httpBase, port, loginB.token, { deviceName: 'Android App', clientKind: 'mobile' })
    const cliC = await openTicketClientWs(httpBase, port, loginC.token, { deviceName: 'macOS · Chrome', clientKind: 'web' })
    try {
      assert.equal(cliA.hello.onlineClientCount, 1)
      await cliA.waitFor((m) => m.event === 'clients.status' && m.payload?.onlineCount === 3)

      const sessList = await (
        await fetch(`${httpBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${regA.token}` },
        })
      ).json()
      assert.equal(sessList.onlineCount, 3)
      assert.equal(sessList.totalCount, 3)
      assert.equal(sessList.sessions.find((s) => s.isCurrent)?.deviceName, 'Windows Desktop')
      const sessB = sessList.sessions.find((s) => s.deviceName === 'Android App')
      assert.ok(sessB?.sid)

      // Single-device kick closes Device B with 4401 and invalidates its token
      const kickB = await (
        await fetch(`${httpBase}/api/auth/sessions/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regA.token}` },
          body: JSON.stringify({ sid: sessB.sid, clientId: sessB.clientId, currentClientId: cliA.hello.clientId }),
        })
      ).json()
      assert.equal(kickB.revokedPermanent, true)
      assert.equal(kickB.onlineCount, 2)
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(cliB.getClosedCode(), 4401)
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${loginB.token}` } })).status, 401)

      // Revoke-others kicks Device C with 4401 and rotates Device A token cleanly
      const kickOthers = await (
        await fetch(`${httpBase}/api/auth/sessions/revoke-others`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regA.token}` },
          body: JSON.stringify({ currentClientId: cliA.hello.clientId, deviceName: 'Windows Desktop', clientKind: 'desktop' }),
        })
      ).json()
      assert.ok(kickOthers.token && kickOthers.token !== regA.token)
      assert.equal(kickOthers.onlineCount, 1)
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(cliC.getClosedCode(), 4401)
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${loginC.token}` } })).status, 401)

      const aFresh = await (
        await fetch(`${httpBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${kickOthers.token}` },
        })
      ).json()
      assert.equal(aFresh.onlineCount, 1)
      assert.equal(aFresh.sessions[0]?.isCurrent, true)

      // Revoke-all kicks remaining Device A with 4401 and invalidates rotated token; re-login recovers
      const revokeAll = await (
        await fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kickOthers.token}` },
        })
      ).json()
      assert.equal(revokeAll.disconnectedClients, 1)
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(cliA.getClosedCode(), 4401)
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${kickOthers.token}` } })).status, 401)

      const reLogin = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Android App',
            clientKind: 'mobile',
            clientUid: 'cli_phone_stable_01',
          }),
        })
      ).json()
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${reLogin.token}` } })).status, 200)

      // Same clientUid re-login replaces & revokes previous session in-place (zero duplicate rows across IP switches)
      const reLogin2 = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Android App',
            clientKind: 'mobile',
            clientUid: 'cli_phone_stable_01',
          }),
        })
      ).json()
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${reLogin.token}` } })).status, 401)
      const dedupSess = await (
        await fetch(`${httpBase}/api/auth/sessions`, {
          headers: { Authorization: `Bearer ${reLogin2.token}` },
        })
      ).json()
      assert.equal(dedupSess.totalCount, 1)

      // Named desktop PC re-login (even after storage wipe / new clientUid) sweeps offline ghost for same machine
      const pcLogin1 = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Windows Desktop · Work37',
            clientKind: 'desktop',
            clientUid: 'cli_pc_work37_old',
          }),
        })
      ).json()
      const pcLogin2 = await (
        await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Windows Desktop · Work37',
            clientKind: 'desktop',
            clientUid: 'cli_pc_work37_reinstall',
          }),
        })
      ).json()
      assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${pcLogin1.token}` } })).status, 401)
      const dedupAfterPc = await (
        await fetch(`${httpBase}/api/auth/sessions`, {
          headers: { Authorization: `Bearer ${pcLogin2.token}` },
        })
      ).json()
      assert.equal(dedupAfterPc.totalCount, 2)

      // Same PC (hostname + platform) rebinding without explicit bridgeId updates in-place & keeps custom label
      const pcBind1 = await (
        await fetch(`${httpBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
          body: JSON.stringify({ label: 'Work37', hostname: 'Work37', platform: 'win32' }),
        })
      ).json()
      await fetch(`${httpBase}/api/account/devices/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
        body: JSON.stringify({ deviceId: pcBind1.deviceId, label: 'My Custom Work PC' }),
      })
      const pcBind2 = await (
        await fetch(`${httpBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
          body: JSON.stringify({ label: 'Work37', hostname: 'Work37', platform: 'win32' }),
        })
      ).json()
      assert.equal(pcBind2.deviceId, pcBind1.deviceId)
      assert.equal(pcBind2.bridgeId, pcBind1.bridgeId)
      assert.equal(pcBind2.label, 'My Custom Work PC')
      assert.equal(pcBind2.devices.length, 1)
    } finally {
      await cliA.closeAll()
      await cliB.closeAll()
      await cliC.closeAll()
    }
  } finally {
    await env.cleanup()
  }
})

test('Suite 7: Zero-dep SMTP mailer, email bind/reset, new-IP alert, login 2FA, CSP & distributed rate limits', async () => {
  const temp = createTempDir('allinone-int-02-smtp-')
  const tmpDir = temp.dir
  const smtp = await createMockSmtpServer()
  const secStaticDir = join(tmpDir, 'email-static')
  mkdirSync(secStaticDir, { recursive: true })
  writeFileSync(join(secStaticDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8')

  const emailRelay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    jwtSecret: 'email-jwt-secret-0123456789',
    adminBootstrapToken: 'email-bootstrap-secret-99',
    maxDailyRegistrations: 3,
    staticDir: secStaticDir,
    stunEnabled: false,
    accountsFile: join(tmpDir, 'email-accounts.json'),
    smtpHost: '127.0.0.1',
    smtpPort: smtp.port,
    smtpSecure: false,
    smtpStarttls: false,
    smtpUser: 'noreply@example.com',
    smtpPass: 'smtp-auth-secret',
    smtpFrom: 'All in One <noreply@example.com>',
    emailCodeOptions: { cooldownMs: 300 },
  })
  try {
    const { port: ePort } = await emailRelay.start()
    const eBase = `http://127.0.0.1:${ePort}`

    // Strict HTML CSP header
    const htmlRes = await fetch(`${eBase}/`)
    const csp = htmlRes.headers.get('content-security-policy') || ''
    assert.ok(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"))
    assert.equal(csp.includes('unsafe-eval'), false)

    const bsEmail = await (await fetch(`${eBase}/api/account/bootstrap-status`)).json()
    assert.equal(bsEmail.emailEnabled, true)

    // Invalid bootstrapToken must NEVER consume SMTP quota while 0 users exist
    assert.equal(
      (
        await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'register', email: 'eva@example.com', bootstrapToken: 'WRONG-BOOT' }),
        })
      ).status,
      400,
    )
    assert.equal(smtp.inbox.length, 0)

    // Optional email: bootstrap admin WITHOUT email
    const evaReg = await (
      await fetch(`${eBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'eva', password: 'EvaAdminPassword1!', bootstrapToken: 'email-bootstrap-secret-99' }),
      })
    ).json()
    assert.equal(evaReg.user.email, '')
    assert.equal(evaReg.user.emailVerified, false)

    // Open registration -> SMTP AUTH LOGIN delivery + 429 cooldown + register with verified email
    const regCode = await (
      await fetch(`${eBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'register', email: 'dave@example.com' }),
      })
    ).json()
    assert.equal(regCode.ok, true)
    assert.equal(smtp.inbox.length, 1)
    assert.equal(smtp.inbox[0].authUser, 'noreply@example.com')
    assert.equal(smtp.inbox[0].authPass, 'smtp-auth-secret')
    assert.match(smtp.inbox[0].code, /^\d{6}$/)

    assert.equal(
      (
        await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'register', email: 'dave@example.com' }),
        })
      ).status,
      429,
    )

    const daveReg = await (
      await fetch(`${eBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
        body: JSON.stringify({
          username: 'dave',
          password: 'DavePassword123!',
          email: 'dave@example.com',
          emailCode: smtp.inbox[0].code,
          deviceName: 'MacBook-Pro',
        }),
      })
    ).json()
    assert.equal(daveReg.user.emailVerified, true)

    // Case-insensitive email login & device-login + New-IP security alert email
    const daveLogin = await (
      await fetch(`${eBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
        body: JSON.stringify({ username: 'DAVE@Example.com', password: 'DavePassword123!', deviceName: 'Unknown-Browser' }),
      })
    ).json()
    assert.equal(daveLogin.user.username, 'dave')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(smtp.inbox.length, 2, 'New-IP login must send a security alert email')
    assert.ok(smtp.inbox[1].decodedText.includes('203.0.113.77') && smtp.inbox[1].decodedText.includes('Unknown-Browser'))

    const daveDevLogin = await (
      await fetch(`${eBase}/api/account/device-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
        body: JSON.stringify({ username: 'dave@example.com', password: 'DavePassword123!', label: 'Dave-PC' }),
      })
    ).json()
    assert.equal(daveDevLogin.username, 'dave')

    // Post-login email bind + duplicate email rejection + daily registration cap pre-SMTP rejection
    const frankReg = await (
      await fetch(`${eBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
      })
    ).json()
    assert.equal(frankReg.ok, true)

    // Daily cap (3/3) reached: register send-code must reject with 429 before touching SMTP
    const inboxCountBeforeCap = smtp.inbox.length
    const cappedSendRes = await fetch(`${eBase}/api/account/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'register', email: 'capped@example.com' }),
    })
    assert.equal(cappedSendRes.status, 429, 'Daily registration cap must block register send-code with 429')
    assert.equal((await cappedSendRes.json()).code, 'DAILY_REGISTRATION_LIMIT')
    assert.equal(smtp.inbox.length, inboxCountBeforeCap, 'Capped register send-code must not consume SMTP quota')
    assert.equal(
      (
        await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ purpose: 'bind', email: 'dave@example.com' }),
        })
      ).status,
      400,
    )
    const bindSend = await (
      await fetch(`${eBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
        body: JSON.stringify({ purpose: 'bind', email: 'frank@example.com' }),
      })
    ).json()
    assert.equal(bindSend.ok, true)
    const frankBindCode = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<frank@example.com>' && m.code)?.code
    assert.match(String(frankBindCode || ''), /^\d{6}$/)
    // Missing or wrong currentPassword must be rejected with 403
    assert.equal(
      (
        await fetch(`${eBase}/api/account/email/bind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode }),
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(`${eBase}/api/account/email/bind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode, currentPassword: 'WrongPassword!' }),
        })
      ).status,
      403,
    )
    const bindConfirm = await (
      await fetch(`${eBase}/api/account/email/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
        body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode, currentPassword: 'FrankPassword123!' }),
      })
    ).json()
    assert.equal(bindConfirm.ok, true)
    assert.equal(bindConfirm.user.emailVerified, true)

    // Password reset: unbound email sends 0 SMTP; bound email resets & revokes old JWT
    const beforeResetCount = smtp.inbox.length
    const unknownReset = await (
      await fetch(`${eBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'reset', email: 'nobody@example.com' }),
      })
    ).json()
    assert.equal(unknownReset.ok, true)
    assert.equal(smtp.inbox.length, beforeResetCount)

    await new Promise((r) => setTimeout(r, 350))
    const resetSend = await (
      await fetch(`${eBase}/api/account/email/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'reset', email: 'dave@example.com' }),
      })
    ).json()
    assert.equal(resetSend.ok, true)
    const resetCode = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<dave@example.com>' && m.code)?.code
    assert.match(String(resetCode || ''), /^\d{6}$/)
    const resetRes = await (
      await fetch(`${eBase}/api/account/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dave@example.com', code: resetCode, newPassword: 'DaveNewPassword99!' }),
      })
    ).json()
    assert.equal(resetRes.username, 'dave')
    assert.equal((await fetch(`${eBase}/api/auth/me`, { headers: { Authorization: `Bearer ${daveLogin.token}` } })).status, 401)
    assert.equal(
      (
        await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave', password: 'DavePassword123!' }),
        })
      ).status,
      401,
    )

    // Optional Email Login 2FA
    const daveNewLogin = await (
      await fetch(`${eBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
        body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!' }),
      })
    ).json()
    const en2fa = await (
      await fetch(`${eBase}/api/account/security/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daveNewLogin.token}` },
        body: JSON.stringify({ enabled: true }),
      })
    ).json()
    assert.equal(en2fa.user.loginEmail2fa, true)
    // Disabling 2FA without currentPassword must be rejected with 403
    assert.equal(
      (
        await fetch(`${eBase}/api/account/security/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daveNewLogin.token}` },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
      403,
    )

    await new Promise((r) => setTimeout(r, 350))
    const step1 = await (
      await fetch(`${eBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
        body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!' }),
      })
    ).json()
    assert.equal(step1.ok, false)
    assert.equal(step1.requires2fa, true)
    assert.ok(step1.maskedEmail.includes('@example.com'))
    const otp2fa = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<dave@example.com>' && m.code)?.code
    assert.match(String(otp2fa || ''), /^\d{6}$/)
    assert.equal(
      (
        await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!', emailCode: '000000' }),
        })
      ).status,
      401,
    )
    const ok2fa = await (
      await fetch(`${eBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
        body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!', emailCode: otp2fa }),
      })
    ).json()
    assert.equal(ok2fa.ok, true)

    // Per-(account, ip) brute-force lockout: 10 failures from attacker IP lock out that IP (429),
    // without allowing unauthenticated remote lockout DoS against the victim's own IP (200)
    for (let i = 1; i <= 10; i += 1) {
      const r = await fetch(`${eBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.77' },
        body: JSON.stringify({ username: 'frank', password: `WrongPass-${i}!` }),
      })
      assert.equal(r.status, 401)
    }
    assert.equal(
      (
        await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.77' },
          body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
        })
      ).status,
      429,
    )
    assert.equal(
      (
        await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.250' },
          body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
        })
      ).status,
      200,
    )

    // /ws/bridge auth failure rate-limiting isolated per (ip, roomId)
    let bridge429 = false
    for (let i = 0; i < 16; i += 1) {
      const status = await new Promise((resolveStatus) => {
        const ws = new WebSocket(`ws://127.0.0.1:${ePort}/ws/bridge?roomId=usr_bogus00000000&bridgeId=stale-pc`, {
          headers: { 'X-Real-IP': '198.51.100.222', 'X-Room-Id': 'usr_bogus00000000', 'X-Bridge-Secret': 'wrong' },
        })
        ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
        ws.on('open', () => {
          ws.close()
          resolveStatus(101)
        })
        ws.on('error', () => {})
      })
      if (status === 429) {
        bridge429 = true
        break
      }
    }
    assert.equal(bridge429, true)

    const validDev = await (
      await fetch(`${eBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${evaReg.token}` },
        body: JSON.stringify({ label: 'Nat-Safe-PC', hostname: 'Nat-Safe-PC', platform: 'win32' }),
      })
    ).json()
    const sameIpValidStatus = await new Promise((resolveStatus) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ePort}/ws/bridge?roomId=${validDev.roomId}&bridgeId=${validDev.bridgeId}`, {
        headers: { 'X-Real-IP': '198.51.100.222', 'X-Room-Id': validDev.roomId, 'X-Bridge-Secret': validDev.deviceSecret },
      })
      ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
      ws.on('open', () => {
        ws.close()
        resolveStatus(101)
      })
      ws.on('error', () => {})
    })
    assert.equal(sameIpValidStatus, 101, 'Bogus room 429 must never block a valid usr_* bridge on same IP')
  } finally {
    await emailRelay.close()
    await smtp.close()
    temp.cleanup()
  }
})

test('Suite 8: Admin monitoring dashboard (/admin, /api/admin/overview, disconnect & force sign-out)', async () => {
  const temp = createTempDir('allinone-int-02-admin-')
  const tmpDir = temp.dir
  const monRelay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    jwtSecret: 'mon-jwt-secret-0123456789',
    adminBootstrapToken: 'mon-owner-secret',
    accountsFile: join(tmpDir, 'mon-accounts.json'),
    stunEnabled: false,
  })
  const { port: mPort } = await monRelay.start()
  const mBase = `http://127.0.0.1:${mPort}`
  const mClosers = []
  try {
    // Subpath-safe /admin & /admin/ HTML + CSP + assets + 404
    const adminHtmlRes = await fetch(`${mBase}/admin`)
    assert.equal(adminHtmlRes.status, 200)
    assert.match(String(adminHtmlRes.headers.get('cache-control') || ''), /no-store/)
    assert.match(String(adminHtmlRes.headers.get('content-security-policy') || ''), /script-src 'self'/)
    const adminHtml = await adminHtmlRes.text()
    assert.ok(adminHtml.includes('src="admin/app.js"') && adminHtml.includes('href="admin/styles.css"'))
    assert.equal(adminHtml.includes('href="/admin/'), false)

    const adminSlashHtml = await (await fetch(`${mBase}/admin/`)).text()
    assert.ok(adminSlashHtml.includes('src="./app.js"') && adminSlashHtml.includes('href="./styles.css"'))
    assert.equal((await fetch(`${mBase}/admin/app.js`)).status, 200)
    assert.equal((await fetch(`${mBase}/admin/styles.css`)).status, 200)
    assert.equal((await fetch(`${mBase}/admin/does-not-exist`)).status, 404)
    assert.equal((await fetch(`${mBase}/api/admin/overview`)).status, 401)

    const admReg = await (
      await fetch(`${mBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'mon_admin', password: 'Password123!', bootstrapToken: 'mon-owner-secret' }),
      })
    ).json()
    const bobReg = await (
      await fetch(`${mBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'mon_bob', password: 'Password123!' }),
      })
    ).json()
    await fetch(`${mBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mon_carol', password: 'Password123!' }),
    })
    assert.equal((await fetch(`${mBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${bobReg.token}` } })).status, 403)

    const bobPc = await (
      await fetch(`${mBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobReg.token}` },
        body: JSON.stringify({ label: 'Bob-MacBook', hostname: 'bob-mbp', platform: 'darwin' }),
      })
    ).json()
    const admPc = await (
      await fetch(`${mBase}/api/account/devices/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
        body: JSON.stringify({ label: 'Admin-WinPC', hostname: 'admin-pc', platform: 'win32' }),
      })
    ).json()

    const bobBr = await connectMockBridgeWs(mPort, {
      roomId: bobReg.roomId,
      deviceSecret: bobPc.deviceSecret,
      bridgeId: bobPc.bridgeId,
      hostname: 'bob-mbp',
      platform: 'darwin',
      apps: [{ app: 'codex', available: true, writable: true }, { app: 'claude', available: true, writable: true }],
    })
    mClosers.push(() => bobBr.ws.close())
    const admBr = await connectMockBridgeWs(mPort, {
      roomId: admReg.roomId,
      deviceSecret: admPc.deviceSecret,
      bridgeId: admPc.bridgeId,
      hostname: 'admin-pc',
      platform: 'win32',
      apps: [{ app: 'antigravity', available: true, writable: true }],
    })
    mClosers.push(() => admBr.ws.close())
    const bobCli = await openTicketClientWs(mBase, mPort, bobReg.token, { deviceName: 'iPhone · Safari', clientKind: 'mobile' })
    mClosers.push(() => bobCli.closeAll())
    await new Promise((r) => setTimeout(r, 80))

    const ovRaw = await (
      await fetch(`${mBase}/api/admin/overview`, {
        headers: { Authorization: `Bearer ${admReg.token}` },
      })
    ).text()
    assert.equal(ovRaw.includes('passwordHash'), false)
    assert.equal(ovRaw.includes('secretHash'), false)
    assert.equal(ovRaw.includes(bobPc.deviceSecret), false)
    const ov = JSON.parse(ovRaw)
    assert.equal(ov.summary.totalUsers, 3)
    assert.equal(ov.summary.activeUsers, 1)
    assert.equal(ov.summary.bridgeOnlyUsers, 1)
    assert.equal(ov.summary.offlineUsers, 1)
    assert.equal(ov.summary.onlineBridges, 2)
    assert.equal(ov.summary.onlineClients, 1)
    assert.equal(ov.summary.dailyRegistration.used, 3)
    assert.equal(ov.summary.dailyRegistration.limit, 20)
    assert.equal(ov.server.config.openRegistration, true)
    assert.equal(ov.distributions.apps.codex.writable, 1)
    assert.equal(ov.distributions.apps.antigravity.writable, 1)
    assert.equal(ov.distributions.bridgePlatforms.darwin, 1)
    assert.equal(ov.distributions.bridgePlatforms.win32, 1)
    assert.ok(ov.server.node.rssBytes > 0 && ov.server.host.totalMemBytes > 0 && ov.activity.length >= 4)

    // Prevent self-lockout, disconnect Bob's bridge (4000) & force sign-out Bob (4401)
    assert.equal(
      (
        await fetch(`${mBase}/api/admin/users/revoke-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ userId: admReg.roomId }),
        })
      ).status,
      400,
    )
    await fetch(`${mBase}/api/admin/bridges/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
      body: JSON.stringify({ roomId: bobReg.roomId, bridgeId: bobPc.bridgeId }),
    })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(bobBr.getClosedCode(), 4000)

    const kickBob = await (
      await fetch(`${mBase}/api/admin/users/revoke-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
        body: JSON.stringify({ userId: bobReg.roomId }),
      })
    ).json()
    assert.equal(kickBob.disconnectedClients, 1)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(bobCli.getClosedCode(), 4401)
    assert.equal((await fetch(`${mBase}/api/auth/me`, { headers: { Authorization: `Bearer ${bobReg.token}` } })).status, 401)
  } finally {
    for (const fn of mClosers) {
      try {
        await fn()
      } catch {}
    }
    await monRelay.close()
    temp.cleanup()
  }
})

test('Suite 9: Built-in RFC 5389 STUN, Coturn 4-tier TURN metering/quotas & tiered Cloudflare TURN fallback', async () => {
  const temp = createTempDir('allinone-int-02-turn-')
  const tmpDir = temp.dir

  try {
    // 9a. Built-in stateless UDP RFC 5389 STUN server & hello.iceServers priority
    const stunRelay = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'smoke-stun-secret-123456',
      adminBootstrapToken: 'STUN-BOOT-1',
      accountsFile: join(tmpDir, 'stun-accounts.json'),
      publicRelayUrl: 'https://stun-host.example.com',
      stunEnabled: true,
      stunPort: 0,
    })
    const { port: sPort, stunPort } = await stunRelay.start()
    const sBase = `http://127.0.0.1:${sPort}`
    try {
      assert.ok(stunPort > 0)
      const udp = dgram.createSocket('udp4')
      try {
        await new Promise((r) => udp.bind(0, '127.0.0.1', r))
        const localUdpPort = udp.address().port
        const req = Buffer.alloc(20)
        req.writeUInt16BE(0x0001, 0)
        req.writeUInt16BE(0, 2)
        req.writeUInt32BE(0x2112a442, 4)
        for (let i = 0; i < 12; i += 1) req[8 + i] = i + 1
        const resp = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('STUN timeout')), 3000)
          udp.once('message', (msg) => {
            clearTimeout(t)
            resolve(msg)
          })
          udp.send(req, stunPort, '127.0.0.1')
        })
        assert.equal(resp.readUInt16BE(0), 0x0101)
        assert.equal(resp.readUInt32BE(4), 0x2112a442)
        assert.ok(resp.subarray(8, 20).equals(req.subarray(8, 20)))
        assert.equal(resp.readUInt16BE(20), 0x0020)
        assert.equal(resp.readUInt16BE(26) ^ 0x2112, localUdpPort)
        assert.equal([resp[28] ^ 0x21, resp[29] ^ 0x12, resp[30] ^ 0xa4, resp[31] ^ 0x42].join('.'), '127.0.0.1')
      } finally {
        udp.close()
      }

      const sAdmin = await (
        await fetch(`${sBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'stun_admin', password: 'StunPassword123!', bootstrapToken: 'STUN-BOOT-1' }),
        })
      ).json()
      const sCli = await openTicketClientWs(sBase, sPort, sAdmin.token, { deviceName: 'stun-check' })
      try {
        assert.equal(sCli.hello.mode, 'p2p-only')
        assert.equal(sCli.hello.protocolVersion, 1)
        assert.ok(sCli.hello.iceServers.some((s) => String(s.urls || '').includes(`stun:stun-host.example.com:${stunPort}`)))
      } finally {
        await sCli.closeAll()
      }
      const sOv = await (await fetch(`${sBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${sAdmin.token}` } })).json()
      assert.equal(sOv.server.mode, 'p2p-only')
      assert.equal(sOv.server.stun.enabled, true)
      assert.ok(sOv.server.stun.requests >= 1)
    } finally {
      await stunRelay.close()
    }

    // 9b. Dynamic HMAC-SHA1 TURN credentials, coturn log parser & 4-tier quota enforcement
    const fixedNow = 1_750_000_000
    const unitCreds = buildTurnCredentials({
      secret: 'super-secret-turn-key-123456',
      userId: 'usr_abc123',
      ttlSec: 3600,
      nowSec: fixedNow,
    })
    assert.equal(unitCreds.username, `${fixedNow + 3600}:usr_abc123`)
    assert.equal(unitCreds.credential, createHmac('sha1', 'super-secret-turn-key-123456').update(unitCreds.username).digest('base64'))

    assert.deepEqual(
      parseCoturnUsageLine('4: : session 001000000000000002: usage: realm=<allinone>, username=<1795581100:usr_meter1>, rp=21, rb=2606, sp=19, sb=2528'),
      { userId: 'usr_meter1', rb: 2606, sb: 2528, billedBytes: 2567 },
    )
    assert.equal(
      parseCoturnUsageLine('4: : session 001: peer usage: realm=<allinone>, username=<1795581100:usr_meter1>, rp=1, rb=999, sp=1, sb=999'),
      null,
    )
    assert.equal(
      parseCoturnUsageLine('4: : session 001: usage: realm=<allinone>, username=<1795581100:live_e2e_probe>, rp=1, rb=999, sp=1, sb=999'),
      null,
    )

    const defaultCfg = resolveTurnQuotaConfig({}, {})
    assert.equal(defaultCfg.freeMb, 1024)
    assert.equal(defaultCfg.proMb, 10240)
    assert.equal(defaultCfg.ultraMb, 51200)
    assert.equal(getTurnQuotaBytesForTier('admin', defaultCfg), getTurnQuotaBytesForTier('ultra', defaultCfg))
    const unlimSnap = buildTurnQuotaSnapshot({
      tier: 'ultra',
      month: '2026-11',
      usedBytes: 999_999_999,
      config: resolveTurnQuotaConfig({ turnQuotaUltraMb: 0 }, {}),
    })
    assert.equal(unlimSnap.unlimited, true)
    assert.equal(unlimSnap.exceeded, false)

    const quotaDir = join(tmpDir, 'turn-quota-e2e')
    mkdirSync(quotaDir, { recursive: true })
    const fakeTurnLog = join(quotaDir, 'turn.log')
    writeFileSync(fakeTurnLog, '', 'utf8')
    const turnSecret = 'smoke-quota-turn-secret-998877'
    const qRelay = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'smoke-quota-jwt-secret-123456',
      adminBootstrapToken: 'QUOTA-BOOT-1',
      accountsFile: join(quotaDir, 'accounts.json'),
      publicRelayUrl: 'https://quota.example.com',
      stunEnabled: false,
      turnSecret,
      turnHost: 'quota.example.com',
      turnPort: 3478,
      turnTtlSec: 600,
      turnLogFile: fakeTurnLog,
      turnMeterPollMs: 300,
      turnQuotaFreeMb: 1,
      turnQuotaProMb: 10,
      turnQuotaUltraMb: 50,
    })
    const { port: qPort } = await qRelay.start()
    const qBase = `http://127.0.0.1:${qPort}`
    try {
      const qAdmin = await (
        await fetch(`${qBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'quota_admin', password: 'QuotaPassword123!', bootstrapToken: 'QUOTA-BOOT-1' }),
        })
      ).json()
      const qFree = await (
        await fetch(`${qBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'quota_free', password: 'QuotaPassword123!' }),
        })
      ).json()
      assert.equal(
        (
          await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'enterprise' }),
          })
        ).status,
        400,
      )

      // Non-admin blocked from tier/reset routes
      assert.equal(
        (
          await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qFree.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'ultra' }),
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await fetch(`${qBase}/api/admin/users/reset-turn-usage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qFree.token}` },
            body: JSON.stringify({ userId: qFree.roomId }),
          })
        ).status,
        403,
      )

      // Exact 3-entry ICE ordering, RFC HMAC-SHA1 verification & zero turnSecret leakage
      const adminMe = await (await fetch(`${qBase}/api/auth/me`, { headers: { Authorization: `Bearer ${qAdmin.token}` } })).json()
      assert.equal(adminMe.tier, 'admin')
      assert.equal(adminMe.turnQuota.quotaBytes, 50 * 1024 * 1024)
      assert.equal(adminMe.iceServers.length, 3)
      assert.equal(adminMe.iceServers[0].urls, 'stun:quota.example.com:3478')
      assert.equal(adminMe.iceServers[1].urls, 'turn:quota.example.com:3478?transport=udp')
      assert.equal(adminMe.iceServers[2].urls, 'turn:quota.example.com:3478?transport=tcp')
      assert.equal(
        adminMe.iceServers[1].credential,
        createHmac('sha1', turnSecret).update(adminMe.iceServers[1].username).digest('base64'),
      )
      assert.equal(JSON.stringify(adminMe.iceServers).includes(turnSecret), false)
      const qOvRaw = await (await fetch(`${qBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${qAdmin.token}` } })).text()
      assert.equal(qOvRaw.includes(turnSecret), false)

      const qCli = await openTicketClientWs(qBase, qPort, qFree.token, { deviceName: 'quota-phone' })
      try {
        assert.equal(qCli.hello.turnQuota.tier, 'free')
        assert.equal(qCli.hello.iceServers.length, 3)

        const overP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        appendFileSync(
          fakeTurnLog,
          [
            `10: : session 001: peer usage: realm=<allinone>, username=<1795581100:${qFree.roomId}>, rp=500, rb=50000000, sp=500, sb=50000000`,
            `11: : session 001: usage: realm=<allinone>, username=<1795581100:${qFree.roomId}>, rp=800, rb=1200000, sp=800, sb=1200000`,
            '',
          ].join('\n'),
          'utf8',
        )
        const overMsg = await overP
        assert.equal(overMsg.quotaExceeded, true)
        assert.equal(overMsg.turnQuota.usedBytes, 1_200_000)
        assert.equal(overMsg.iceServers.length, 1)
        assert.ok(overMsg.iceServers[0].urls.startsWith('stun:'))

        const freeMeOver = await (await fetch(`${qBase}/api/auth/me`, { headers: { Authorization: `Bearer ${qFree.token}` } })).json()
        assert.equal(freeMeOver.iceServers.length, 1)

        // Upgrade free -> pro -> ultra -> downgrade free -> reset usage -> promote admin (immediate JWT unlock!)
        const proP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        await fetch(`${qBase}/api/admin/users/set-tier`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
          body: JSON.stringify({ userId: qFree.roomId, tier: 'pro' }),
        })
        const proMsg = await proP
        assert.equal(proMsg.quotaExceeded, false)
        assert.equal(proMsg.iceServers.length, 3)

        const ultraP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        const ultraRes = await (
          await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'ultra' }),
          })
        ).json()
        assert.equal(ultraRes.turnQuota.quotaBytes, adminMe.turnQuota.quotaBytes)
        await ultraP

        const downP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        await fetch(`${qBase}/api/admin/users/set-tier`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
          body: JSON.stringify({ userId: qFree.roomId, tier: 'free' }),
        })
        assert.equal((await downP).iceServers.length, 1)

        const resetP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        await fetch(`${qBase}/api/admin/users/reset-turn-usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
          body: JSON.stringify({ userId: qFree.roomId }),
        })
        const resetMsg = await resetP
        assert.equal(resetMsg.turnQuota.usedBytes, 0)
        assert.equal(resetMsg.iceServers.length, 3)

        const promoP = qCli.waitNext((m) => m.type === 'ice.update', 5000)
        await fetch(`${qBase}/api/admin/users/set-tier`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
          body: JSON.stringify({ userId: qFree.roomId, tier: 'admin' }),
        })
        await promoP
        assert.equal((await fetch(`${qBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${qFree.token}` } })).status, 200)
        const promotedMe = await (await fetch(`${qBase}/api/auth/me`, { headers: { Authorization: `Bearer ${qFree.token}` } })).json()
        assert.equal(promotedMe.role, 'admin')
        assert.equal(promotedMe.user.role, 'admin')
      } finally {
        await qCli.closeAll()
      }
    } finally {
      await qRelay.close()
    }

    // 9c. Tiered Cloudflare Realtime TURN (free -> CF pool + domestic STUN; pro/admin -> coturn; outage fallback)
    assert.deepEqual([...parseCfTurnTiers('')], ['free'])
    assert.deepEqual([...parseCfTurnTiers('free, pro, invalid')].sort(), ['free', 'pro'])
    const cfNorm = normalizeCloudflareIceResponse({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
      ],
    })
    assert.equal(cfNorm.stunServers.length, 1)
    assert.equal(cfNorm.turnServers.length, 1)

    let cfFailMode = false
    let cfHits = 0
    const cfApiToken = 'cf-super-secret-api-token-xyz987'
    const cfTokenId = 'cf-turn-key-id-001'
    const mockCfServer = http.createServer((req, res) => {
      cfHits += 1
      assert.equal(req.url, `/v1/turn/keys/${cfTokenId}/credentials/generate-ice-servers`)
      assert.equal(req.headers.authorization, `Bearer ${cfApiToken}`)
      if (cfFailMode) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'simulated cf outage' }))
        return
      }
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
              username: `cf_u_${cfHits}`,
              credential: `cf_c_${cfHits}`,
            },
          ],
        }),
      )
    })
    await new Promise((r) => mockCfServer.listen(0, '127.0.0.1', r))
    const mockCfPort = mockCfServer.address().port
    const cfRelay = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'smoke-cf-jwt-secret-123456',
      adminBootstrapToken: 'CF-BOOT-1',
      accountsFile: join(tmpDir, 'cf-accounts.json'),
      publicRelayUrl: 'https://domestic.example.com',
      stunEnabled: false,
      turnSecret: 'smoke-domestic-turn-secret-12345',
      turnHost: 'domestic.example.com',
      turnPort: 3478,
      cfTurnTokenId: cfTokenId,
      cfTurnApiToken: cfApiToken,
      cfTurnApiBase: `http://127.0.0.1:${mockCfPort}`,
      cfTurnTiers: 'free',
      cfTurnTtlSec: 3600,
    })
    const { port: cfPort } = await cfRelay.start()
    const cfBase = `http://127.0.0.1:${cfPort}`
    try {
      assert.ok(cfHits >= 1)
      const cfAdmin = await (
        await fetch(`${cfBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cf_admin', password: 'CfPassword123!', bootstrapToken: 'CF-BOOT-1' }),
        })
      ).json()
      const cfFree = await (
        await fetch(`${cfBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cf_free', password: 'CfPassword123!' }),
        })
      ).json()

      const freeMe = await (await fetch(`${cfBase}/api/auth/me`, { headers: { Authorization: `Bearer ${cfFree.token}` } })).json()
      assert.equal(freeMe.turnQuota.provider, 'cloudflare')
      assert.equal(freeMe.iceServers[0].urls, 'stun:domestic.example.com:3478')
      assert.ok(JSON.stringify(freeMe.iceServers).includes('turn.cloudflare.com'))
      assert.equal(JSON.stringify(freeMe.iceServers).includes('turn:domestic.example.com'), false)

      const adminMe = await (await fetch(`${cfBase}/api/auth/me`, { headers: { Authorization: `Bearer ${cfAdmin.token}` } })).json()
      assert.equal(adminMe.turnQuota.provider, 'self-hosted')
      assert.ok(JSON.stringify(adminMe.iceServers).includes('turn:domestic.example.com:3478'))

      await fetch(`${cfBase}/api/admin/users/set-tier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfAdmin.token}` },
        body: JSON.stringify({ userId: cfFree.roomId, tier: 'pro' }),
      })
      const proMe = await (await fetch(`${cfBase}/api/auth/me`, { headers: { Authorization: `Bearer ${cfFree.token}` } })).json()
      assert.equal(proMe.turnQuota.provider, 'self-hosted')

      const ovRaw = await (await fetch(`${cfBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${cfAdmin.token}` } })).text()
      assert.equal(ovRaw.includes(cfApiToken), false)
      const ov = JSON.parse(ovRaw)
      assert.equal(ov.server.turn.cloudflare.enabled, true)
      assert.equal(ov.server.turn.cloudflare.ready, true)

      // CF outage fallback -> self-hosted coturn
      cfFailMode = true
      const fbRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'smoke-cfb-jwt-secret-123456',
        adminBootstrapToken: 'CFB-BOOT-1',
        accountsFile: join(tmpDir, 'cfb-accounts.json'),
        publicRelayUrl: 'https://domestic.example.com',
        stunEnabled: false,
        turnSecret: 'smoke-domestic-turn-secret-12345',
        turnHost: 'domestic.example.com',
        turnPort: 3478,
        cfTurnTokenId: cfTokenId,
        cfTurnApiToken: cfApiToken,
        cfTurnApiBase: `http://127.0.0.1:${mockCfPort}`,
        cfTurnTiers: 'free',
      })
      const { port: fbPort } = await fbRelay.start()
      const fbBase = `http://127.0.0.1:${fbPort}`
      try {
        const fbAdmin = await (
          await fetch(`${fbBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fb_admin', password: 'FbPassword123!', bootstrapToken: 'CFB-BOOT-1' }),
          })
        ).json()
        assert.equal(fbAdmin.ok, true)
        assert.equal(fbAdmin.user.role, 'admin')
        const fbFree = await (
          await fetch(`${fbBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fb_free', password: 'FbPassword123!' }),
          })
        ).json()
        const fbMe = await (await fetch(`${fbBase}/api/auth/me`, { headers: { Authorization: `Bearer ${fbFree.token}` } })).json()
        assert.equal(fbMe.turnQuota.provider, 'self-hosted')
        assert.ok(JSON.stringify(fbMe.iceServers).includes('turn:domestic.example.com:3478'))
      } finally {
        await fbRelay.close()
      }
    } finally {
      await cfRelay.close()
      await new Promise((r) => mockCfServer.close(r))
    }
  } finally {
    temp.cleanup()
  }
})
