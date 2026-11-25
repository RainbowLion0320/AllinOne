/**
 * All in One — Streamlined v1.x End-to-End Smoke & Security Test Suite (16 modules)
 *
 *  1. Account Bootstrap, Single-Use Invites, Multi-Tenant Isolation, Device Lifecycle & Portable CLI
 *  2. Live E2EE PC Bridge & 4-App RPC Routing (DSH, Codex, Claude, Antigravity)
 *  3. Core Control Plane & Bridge Security Hardening
 *  4. Full-Duplex Zero-Knowledge E2EE & Direct WebRTC P2P (`aio-ctrl` + `aio-bulk` + Instant Revocation)
 *  5. Zero-Knowledge Device-to-Device Key Grant (ECDH P-256 + SAS + Reverse-QR) & QR Scan Nudge
 *  6. Active Client Sessions Monitor, Live Push, Single Kick & Token Rotation
 *  7. Zero-Dep SMTP Mailer, Optional Email Binding, Password Reset, New-IP Alert, Login 2FA & Rate Limits
 *  8. Admin Monitoring Dashboard (`/admin` & `/api/admin/overview`)
 *  9. Built-in RFC 5389 STUN, Coturn 4-Tier Metering/Quotas & Tiered Cloudflare Realtime TURN
 * 10. Desktop App Security (`safeStorage`), Auto-Updater & Electron WebRTC Proxy
 * 11. Frontend Static Guards (React Hooks), Bilingual i18n, Multi-Device Store, Scoped Cache & Drafts
 * 12. Deliverable Documents E2EE Download, Security Guards & Sandbox HTML Preview
 * 13. DSH Cordis Plugin, Authenticated Local IPC, Auto-Installer, Two-Way Prompt Sync & CLI Auto-Fix Guard
 * 14. Interactive Multi-Question Q&A & Approvals Across All 4 Adapters & Orchestrator
 * 15. Adapter Resilience, External Watchers & Subscription Weekly Quotas
 * 16. Unified Plan / Goal / Steps Live Sync & Interactive `taskMode` Forwarding
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { RTCIceCandidate, RTCPeerConnection } from 'werift'
import { DesktopWebRtcProxy } from '../packages/desktop-app/src/webrtc-proxy.js'
import { ElectronWebRtcClient } from '../packages/dsh-mobile-hub/src/p2p/peer-electron.js'
import {
  buildTurnCredentials,
  createRelayServer,
  normalizeCloudflareIceResponse,
  parseCfTurnTiers,
} from '../packages/relay-server/src/index.js'
import {
  buildTurnQuotaSnapshot,
  getTurnQuotaBytesForTier,
  parseCoturnUsageLine,
  resolveTurnQuotaConfig,
} from '../packages/relay-server/src/turn-meter.js'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  P2P_BULK_LABEL,
  P2P_CTRL_LABEL,
  createCtrlCodec,
  decodeBulkFrame,
  encodeBulkFrame,
  sendWithBackpressure,
} from '../packages/shared/src/p2p-mux.js'
import { startStandaloneBridge } from '../packages/dsh-mobile-hub/standalone.js'
import { apply as applyDshPlugin } from '../packages/dsh-mobile-hub/index.js'
import { DshAdapter } from '../packages/dsh-mobile-hub/src/adapters/dsh.js'
import { startDshLocalIpcServer } from '../packages/dsh-mobile-hub/src/dsh-local-ipc.js'
import { ensureDshLocalIpcPlugin } from '../packages/dsh-mobile-hub/src/helpers/dsh-ipc-installer.js'
import { autoCompleteHalfInstalledClis, detectHalfInstalledClis } from '../packages/dsh-mobile-hub/src/helpers/env-autofix.js'
import {
  AntigravityAdapter,
  normalizeAntigravityQuota,
  parseAgyTranscriptContent,
} from '../packages/dsh-mobile-hub/src/adapters/antigravity.js'
import {
  CodexAdapter,
  buildCodexQuestionReplyText,
  extractCodexTaskStateFromRollout,
  extractPendingCodexAsyncQuestionFromRollout,
  formatCodexQuestionReplyForDisplay,
  normalizeCodexAsyncQuestionCard,
  normalizeCodexQuota,
  normalizeCodexTurns,
  parseCodexQuestionReply,
  probeCodexRolloutStatus,
  readCodexRolloutTail,
} from '../packages/dsh-mobile-hub/src/adapters/codex.js'
import {
  createTaskStateTracker,
  normalizeStepStatus,
  normalizeTaskMode,
  normalizeTaskState,
} from '../packages/dsh-mobile-hub/src/helpers/task-state.js'
import {
  ClaudeAdapter,
  normalizeClaudeQuota,
  probeClaudeExternalStatus,
  probeClaudeTranscriptTail,
} from '../packages/dsh-mobile-hub/src/adapters/claude.js'
import { MultiAppOrchestrator } from '../packages/dsh-mobile-hub/src/orchestrator.js'
import { extractDeliverableRefsFromMessage } from '../packages/mobile-app/src/lib/deliverableFiles.js'
import { RelayBridgeLink } from '../packages/dsh-mobile-hub/src/ws-client.js'
import {
  parseCompositeId as hubParseCompositeId,
  toEpochMs as hubToEpochMs,
} from '../packages/dsh-mobile-hub/src/protocol.js'
import {
  answersToElicitationContent,
  elicitationSchemaToQuestions,
} from '../packages/dsh-mobile-hub/src/helpers/interactive-schema.js'
import { EVENTS, RPC, parseCompositeId, toEpochMs } from '../packages/shared/src/protocol.js'
import {
  base64UrlToBytes,
  computeE2eeKeyId,
  computeGrantPubKeyFp,
  decryptAutoStream,
  decryptGrantPayload,
  decryptJson,
  deriveGrantSas,
  encodeE2eeGrantQrUri,
  encodeE2eeQrUri,
  encryptChunkedBytes,
  encryptGrantPayload,
  encryptJson,
  formatE2eeFingerprint,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantReqId,
  parseE2eeGrantQrInput,
  parseE2eeQrInput,
} from '../packages/shared/src/e2ee.js'
import { renderQrSvg as renderSharedQrSvg } from '../packages/shared/src/qr-svg.js'
import {
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  saveDeviceState,
  selectDevice,
  upsertDevice,
  upsertDeviceE2eeKey,
} from '../packages/mobile-app/src/lib/deviceStore.js'
import {
  clearSessionCache,
  formatBytesCompact,
  getSessionCacheStats,
  loadCachedSession,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from '../packages/mobile-app/src/lib/sessionCache.js'
import { resolveImageSrc } from '../packages/mobile-app/src/lib/imageUrls.js'
import {
  clearDraft,
  clearDraftsForScope,
  loadDraft,
  loadLastSessionId,
  loadLastWorkspace,
  makeDraftKey,
  saveDraft,
  saveLastSessionId,
  saveLastWorkspace,
} from '../packages/mobile-app/src/lib/draftStore.js'
import {
  DesktopUpdater,
  buildWindowsUpdateScripts,
  compareSemver,
  pickReleaseAsset,
} from '../packages/desktop-app/src/updater.js'
import {
  DesktopBridgeManager,
  loadConfigDecrypted,
  loadConfigWithStatus,
  saveConfigSecure,
} from '../packages/desktop-app/src/bridge-manager.js'
import {
  LANG_STORAGE_KEY,
  MESSAGES,
  bi,
  detectInitialLang,
  loadSavedLang,
  normalizeLang,
  saveLang,
  translate,
} from '../packages/mobile-app/src/lib/i18n.js'

const TOTAL_SUITES = 16
const TEST_BOOTSTRAP_TOKEN = 'smoke-bootstrap-token-123'
const SMOKE_ADMIN_PASS = 'SmokeAdminPass99!'

function pass(step, message) {
  console.log(`[smoke] ${step}/${TOTAL_SUITES} ${message} OK`)
}

function createSmokeByteQueue() {
  const chunks = []
  let waiter = null
  let ended = false
  let error = null
  return {
    push(u8) {
      if (ended || error || !u8?.byteLength) return
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: u8, done: false })
      } else {
        chunks.push(u8)
      }
    },
    end() {
      if (ended || error) return
      ended = true
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: undefined, done: true })
      }
    },
    fail(err) {
      if (ended || error) return
      error = err || new Error('aborted')
      if (waiter) {
        const w = waiter
        waiter = null
        w.reject(error)
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (chunks.length > 0) return Promise.resolve({ value: chunks.shift(), done: false })
            if (error) return Promise.reject(error)
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject }
            })
          },
        }
      },
    },
  }
}

function createMockSecretStore() {
  return {
    isAvailable: () => true,
    encrypt: (plain) => `enc_v1:${Buffer.from(String(plain), 'utf8').toString('base64')}`,
    decrypt: (enc) => {
      if (!String(enc || '').startsWith('enc_v1:')) throw new Error('bad cipher')
      return Buffer.from(enc.slice(7), 'base64').toString('utf8')
    },
  }
}

async function createMockSmtpServer() {
  const inbox = []
  const server = net.createServer((sock) => {
    let buf = ''
    let state = 'cmd'
    let cur = { authUser: '', authPass: '', mailFrom: '', rcptTo: '', rawData: '' }
    sock.write('220 mock-smtp.local ESMTP Ready\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      while (true) {
        if (state === 'data') {
          const endIdx = buf.indexOf('\r\n.\r\n')
          if (endIdx === -1) break
          cur.rawData = buf.slice(0, endIdx)
          buf = buf.slice(endIdx + 5)
          const b64Match = cur.rawData.match(
            /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/,
          )
          const decodedText = b64Match
            ? Buffer.from(b64Match[1].replace(/\r?\n/g, ''), 'base64').toString('utf8')
            : cur.rawData
          const codeMatch = decodedText.match(/\b(\d{6})\b/)
          inbox.push({ ...cur, decodedText, code: codeMatch ? codeMatch[1] : '' })
          cur = { authUser: cur.authUser, authPass: cur.authPass, mailFrom: '', rcptTo: '', rawData: '' }
          state = 'cmd'
          sock.write('250 2.0.0 OK queued\r\n')
          continue
        }
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (state === 'auth_user') {
          cur.authUser = Buffer.from(line, 'base64').toString('utf8')
          state = 'auth_pass'
          sock.write('334 UGFzc3dvcmQ6\r\n')
        } else if (state === 'auth_pass') {
          cur.authPass = Buffer.from(line, 'base64').toString('utf8')
          state = 'cmd'
          sock.write('235 2.7.0 Authentication successful\r\n')
        } else if (/^EHLO /i.test(line)) {
          sock.write('250-mock-smtp.local\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n')
        } else if (/^AUTH LOGIN$/i.test(line)) {
          state = 'auth_user'
          sock.write('334 VXNlcm5hbWU6\r\n')
        } else if (/^MAIL FROM:/i.test(line)) {
          cur.mailFrom = line.slice(10).trim()
          sock.write('250 OK\r\n')
        } else if (/^RCPT TO:/i.test(line)) {
          cur.rcptTo = line.slice(8).trim()
          sock.write('250 OK\r\n')
        } else if (/^DATA$/i.test(line)) {
          state = 'data'
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (/^QUIT$/i.test(line)) {
          sock.write('221 Bye\r\n')
          sock.end()
        } else {
          sock.write('250 OK\r\n')
        }
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    inbox,
    close: () => new Promise((r) => server.close(r)),
  }
}

function connectMockBridgeWs(port, { roomId, deviceSecret, bridgeId, hostname = 'mock-pc', platform = 'darwin', apps = [], keyId = '0123456789abcdef' }) {
  return new Promise((resolveBr, rejectBr) => {
    const qs = new URLSearchParams({ roomId, bridgeId, hostname, platform, mode: 'desktop' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?${qs.toString()}`, {
      headers: { 'X-Room-Id': roomId, 'X-Bridge-Secret': deviceSecret },
    })
    let closedCode = null
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'bridge.meta', meta: { apps, e2ee: { enabled: true, v: 1, keyId } } }))
      resolveBr({ ws, getClosedCode: () => closedCode })
    })
    ws.on('close', (code) => { closedCode = code })
    ws.on('error', rejectBr)
  })
}

async function openTicketClientWs(httpBase, port, token, { deviceName = 'smoke-client', clientKind = 'web' } = {}) {
  const ticketRes = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceName, clientKind }),
  })).json()
  assert.equal(ticketRes.ok, true, 'POST /api/auth/ws-ticket should succeed')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
  const inbox = []
  const events = []
  const p2pEvents = []
  const waiters = []
  const peers = new Map()
  let hello = null
  let closedCode = null

  const waitNext = (pred, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error('Timed out waiting for WS message'))
      }, timeoutMs)
      waiters.push({ pred, resolve, timer })
    })

  const waitFor = (pred, timeoutMs = 4000) => {
    const existing = inbox.find(pred)
    if (existing) return Promise.resolve(existing)
    return waitNext(pred, timeoutMs)
  }

  await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      inbox.push(msg)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0]
          clearTimeout(w.timer)
          w.resolve(msg)
        }
      }
      if (msg.type === 'hello') {
        hello = msg
        resolve()
        return
      }
      if (msg.type === 'p2p.signal') {
        const p = peers.get(String(msg.bridgeId || ''))
        if (p) void p.handleSignal(msg)
        return
      }
      if (msg.type === 'p2p.signal.error') {
        const p = peers.get(String(msg.bridgeId || ''))
        if (p) p.handleSignalError(msg)
        return
      }
      if (msg.type === 'event') {
        events.push(msg)
      }
    })
    ws.on('close', (code) => { closedCode = code })
    ws.on('error', reject)
  })

  let reqSeq = 1
  let uploadStreamSeq = 1

  const connectP2p = async ({ bridgeId, e2eeKey, roomId }) => {
    const bid = String(bridgeId || hello?.bridges?.[0]?.bridgeId || '')
    const existing = peers.get(bid)
    if (existing && !existing.closed) {
      await existing.ready
      return existing
    }

    const sessionId = `smoke-p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const pc = new RTCPeerConnection({ iceServers: [] })
    const ctrlDc = pc.createDataChannel(P2P_CTRL_LABEL, { ordered: true })
    const bulkDc = pc.createDataChannel(P2P_BULK_LABEL, { ordered: true })
    const ctrlCodec = createCtrlCodec()
    const pendingRpcs = new Map()
    const activeDownloads = new Map()
    const activeUploads = new Map()
    const remoteIceQueue = []
    let remoteDescSet = false
    let resolveReady
    let rejectReady
    const ready = new Promise((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    ready.catch(() => {})

    const peerObj = {
      bridgeId: bid,
      sessionId,
      pc,
      ctrlDc,
      bulkDc,
      ready,
      closed: false,
      e2eeKey,
      roomId,
      sendCtrlJson(obj) {
        if (peerObj.closed || ctrlDc.readyState !== 'open') return false
        for (const f of ctrlCodec.encode(obj)) ctrlDc.send(f)
        return true
      },
      async sendBulkCtrl(inner) {
        const e2ee = await encryptJson(e2eeKey, inner, { kind: 'p2p.bulk', roomId })
        assert.equal(peerObj.sendCtrlJson({ type: 'bulk.ctrl', e2ee }), true, 'bulk.ctrl send should succeed')
      },
      async close() {
        if (peerObj.closed) return
        peerObj.closed = true
        rejectReady(new Error('P2P closed'))
        for (const p of pendingRpcs.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('P2P closed'))
        }
        pendingRpcs.clear()
        for (const dl of activeDownloads.values()) {
          dl.headerReject?.(new Error('P2P closed'))
          dl.queue.fail(new Error('P2P closed'))
        }
        activeDownloads.clear()
        for (const up of activeUploads.values()) {
          up.readyReject?.(new Error('P2P closed'))
          up.doneReject?.(new Error('P2P closed'))
        }
        activeUploads.clear()
        try { ctrlDc.close() } catch {}
        try { bulkDc.close() } catch {}
        try { await pc.close() } catch {}
      },
      handleSignalError(msg) {
        if (msg.sessionId && msg.sessionId !== sessionId) return
        const err = new Error(msg.message || msg.code || 'P2P signal error')
        err.code = msg.code || 'BRIDGE_OFFLINE'
        rejectReady(err)
        void peerObj.close()
      },
      async handleSignal(msg) {
        if (peerObj.closed || (msg.sessionId && msg.sessionId !== sessionId)) return
        let inner
        try {
          inner = await decryptJson(e2eeKey, msg.e2ee, { kind: 'p2p.signal', roomId })
        } catch {
          return
        }
        if (inner.kind === 'answer' && inner.sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp: inner.sdp })
          remoteDescSet = true
          while (remoteIceQueue.length > 0) {
            await pc.addIceCandidate(new RTCIceCandidate(remoteIceQueue.shift())).catch(() => {})
          }
        } else if (inner.kind === 'ice' && inner.candidate) {
          if (!remoteDescSet) remoteIceQueue.push(inner.candidate)
          else await pc.addIceCandidate(new RTCIceCandidate(inner.candidate)).catch(() => {})
        } else if (inner.kind === 'close') {
          await peerObj.close()
        }
      },
      async sendRawCtrlRpc(frame) {
        await ready
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRpcs.delete(frame.id)
            reject(new Error(`Raw P2P RPC timeout: ${frame.id}`))
          }, 15_000)
          pendingRpcs.set(frame.id, {
            resolve: (m) => { clearTimeout(timer); resolve(m) },
            reject: (e) => { clearTimeout(timer); reject(e) },
            timer,
          })
          if (!peerObj.sendCtrlJson(frame)) {
            clearTimeout(timer)
            pendingRpcs.delete(frame.id)
            reject(new Error('P2P channel closed'))
          }
        })
      },
      async sendEncryptedRpc(method, params = {}) {
        const id = `t-${reqSeq++}`
        const env = await encryptJson(
          e2eeKey,
          { method, params, cid: id, ts: Date.now() },
          { kind: 'rpc.req', roomId },
        )
        const rawRes = await peerObj.sendRawCtrlRpc({ type: 'rpc.req', id, e2ee: env })
        if (rawRes.e2ee) {
          const dec = await decryptJson(e2eeKey, rawRes.e2ee, { kind: 'rpc.res', roomId })
          assert.equal(dec.cid, id, 'Decrypted RPC response cid must match request id')
          if (dec.ok) return dec.result
          const err = new Error(dec.error?.message || 'RPC error')
          err.code = dec.error?.code || 'RPC_ERROR'
          throw err
        }
        const err = new Error(rawRes.error?.message || 'RPC error')
        err.code = rawRes.error?.code || 'RPC_ERROR'
        throw err
      },
      async downloadBulkStream(streamId) {
        await ready
        const queue = createSmokeByteQueue()
        let headerResolve
        let headerReject
        const headerPromise = new Promise((res, rej) => {
          headerResolve = res
          headerReject = rej
        })
        activeDownloads.set(streamId, { queue, headerResolve, headerReject })
        try {
          await peerObj.sendBulkCtrl({ action: 'pull', streamId })
          const header = await headerPromise
          const dec = await decryptAutoStream(e2eeKey, queue.iterable, {
            iv: header.e2ee.iv,
            kid: header.e2ee.kid || '',
            kind: 'upload',
            roomId,
            chunked: Boolean(header.e2ee.chunked),
          })
          return Buffer.concat((dec.chunks || []).map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
        } finally {
          activeDownloads.delete(streamId)
        }
      },
      async uploadFileBulk(buf, { filename = 'upload.bin', mimeType = 'application/octet-stream' } = {}) {
        await ready
        const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        const transferId = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const streamId = uploadStreamSeq++
        let readyResolve
        let readyReject
        let doneResolve
        let doneReject
        const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej })
        const donePromise = new Promise((res, rej) => { doneResolve = res; doneReject = rej })
        activeUploads.set(transferId, { streamId, readyResolve, readyReject, doneResolve, doneReject })
        try {
          let seq = 0
          await encryptChunkedBytes(
            e2eeKey,
            {
              totalSize: raw.length,
              readSlice: async (offset, len) => new Uint8Array(raw.buffer, raw.byteOffset + offset, len),
            },
            {
              kind: 'upload',
              roomId,
              onHeader: async (e2eeMeta) => {
                await peerObj.sendBulkCtrl({
                  action: 'upload.start',
                  transferId,
                  streamId,
                  filename,
                  mimeType,
                  size: raw.length,
                  e2ee: e2eeMeta,
                })
                await readyPromise
              },
              onChunk: async (cipherChunk) => {
                for (let off = 0; off < cipherChunk.byteLength; off += BULK_SLICE_BYTES) {
                  const slice = cipherChunk.subarray(off, Math.min(cipherChunk.byteLength, off + BULK_SLICE_BYTES))
                  const f = encodeBulkFrame(streamId, seq++, slice, 0)
                  await sendWithBackpressure(bulkDc, Buffer.from(f.buffer, f.byteOffset, f.byteLength))
                }
              },
            },
          )
          const eofF = encodeBulkFrame(streamId, seq++, new Uint8Array(0), BULK_FLAG_EOF)
          await sendWithBackpressure(bulkDc, Buffer.from(eofF.buffer, eofF.byteOffset, eofF.byteLength))
          return await donePromise
        } finally {
          activeUploads.delete(transferId)
        }
      },
    }

    const checkOpen = () => {
      if (ctrlDc.readyState === 'open' && bulkDc.readyState === 'open') resolveReady(peerObj)
    }
    ctrlDc.stateChanged.subscribe((st) => {
      if (st === 'open') checkOpen()
      if (st === 'closed' || st === 'closing') void peerObj.close()
    })
    bulkDc.stateChanged.subscribe((st) => {
      if (st === 'open') checkOpen()
      if (st === 'closed' || st === 'closing') void peerObj.close()
    })
    ctrlDc.onMessage.subscribe((raw) => {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      const msg = ctrlCodec.decode(text)
      if (!msg) return
      if (msg.type === 'rpc.res') {
        const p = pendingRpcs.get(msg.id)
        if (p) {
          pendingRpcs.delete(msg.id)
          p.resolve(msg)
        }
      } else if (msg.type === 'event' && msg.e2ee) {
        p2pEvents.push({ ...msg, bridgeId: bid })
      } else if (msg.type === 'bulk.ctrl' && msg.e2ee) {
        decryptJson(e2eeKey, msg.e2ee, { kind: 'p2p.bulk', roomId })
          .then((inner) => {
            if (inner.action === 'download.header') {
              activeDownloads.get(Number(inner.streamId))?.headerResolve?.(inner)
            } else if (inner.action === 'download.error') {
              const dl = activeDownloads.get(Number(inner.streamId))
              const err = new Error(inner.message || 'download error')
              dl?.headerReject?.(err)
              dl?.queue?.fail(err)
            } else if (inner.action === 'upload.ready') {
              activeUploads.get(String(inner.transferId))?.readyResolve?.(inner)
            } else if (inner.action === 'upload.done') {
              activeUploads.get(String(inner.transferId))?.doneResolve?.(inner)
            } else if (inner.action === 'upload.error') {
              const up = activeUploads.get(String(inner.transferId))
              const err = new Error(inner.message || 'upload error')
              up?.readyReject?.(err)
              up?.doneReject?.(err)
            }
          })
          .catch(() => {})
      }
    })
    bulkDc.onMessage.subscribe((raw) => {
      const u8 = Buffer.isBuffer(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw)
      const frame = decodeBulkFrame(u8)
      if (!frame) return
      const dl = activeDownloads.get(frame.streamId)
      if (!dl) return
      if (frame.payload.byteLength > 0) dl.queue.push(frame.payload)
      if (frame.eof) dl.queue.end()
    })

    const localIceQueue = []
    let offerSent = false
    pc.onIceCandidate.subscribe(async (cand) => {
      if (!cand || peerObj.closed || ws.readyState !== WebSocket.OPEN) return
      const cObj = { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex }
      if (!offerSent) {
        localIceQueue.push(cObj)
        return
      }
      const e2ee = await encryptJson(e2eeKey, { kind: 'ice', candidate: cObj }, { kind: 'p2p.signal', roomId })
      if (!peerObj.closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee }))
      }
    })
    pc.connectionStateChange.subscribe((st) => {
      if (st === 'failed' || st === 'closed') void peerObj.close()
    })

    peers.set(bid, peerObj)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const offerEnc = await encryptJson(e2eeKey, { kind: 'offer', sdp: offer.sdp }, { kind: 'p2p.signal', roomId })
    ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee: offerEnc }))
    offerSent = true
    while (localIceQueue.length > 0 && !peerObj.closed && ws.readyState === WebSocket.OPEN) {
      const cObj = localIceQueue.shift()
      const e2ee = await encryptJson(e2eeKey, { kind: 'ice', candidate: cObj }, { kind: 'p2p.signal', roomId })
      if (!peerObj.closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee }))
      }
    }

    const timeout = setTimeout(() => {
      rejectReady(new Error(`P2P connect timeout to bridge ${bid}`))
      void peerObj.close()
    }, 10_000)
    try {
      await ready
    } finally {
      clearTimeout(timeout)
    }
    return peerObj
  }

  const sendEncryptedRpc = async (method, params = {}, { e2eeKey, roomId, bridgeId = '' } = {}) => {
    const peer = await connectP2p({ bridgeId, e2eeKey, roomId })
    return peer.sendEncryptedRpc(method, params)
  }

  const closeAll = async () => {
    for (const p of peers.values()) await p.close()
    peers.clear()
    try { ws.close() } catch {}
  }

  return {
    ws,
    hello,
    inbox,
    events,
    p2pEvents,
    waitFor,
    waitNext,
    connectP2p,
    sendEncryptedRpc,
    closeAll,
    getClosedCode: () => closedCode,
  }
}

async function main() {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'allinone-smoke-'))
  const accountsFile = join(tmpDir, 'accounts.json')
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    jwtSecret: 'smoke-test-jwt-secret-0123456789',
    adminBootstrapToken: TEST_BOOTSTRAP_TOKEN,
    accountsFile,
    stunEnabled: false,
  })
  const { port } = await relay.start()
  const httpBase = `http://127.0.0.1:${port}`
  const wsBridgeUrl = `ws://127.0.0.1:${port}/ws/bridge`

  let bridge = null

  try {
    // =========================================================================
    // 1. Account Bootstrap, Single-Use Invites, Multi-Tenant Isolation, Device Lifecycle & Portable CLI
    // =========================================================================
    const bootBefore = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootBefore.ok, true)
    assert.equal(bootBefore.hasUsers, false, 'Fresh server should report hasUsers=false')
    assert.equal(bootBefore.emailEnabled, false, 'Unconfigured relay must report emailEnabled=false')

    const noEmailSendRes = await fetch(`${httpBase}/api/account/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'reset', email: 'test@example.com' }),
    })
    assert.equal(noEmailSendRes.status, 503, 'Unconfigured relay must reject send-code with 503')

    const badReg = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'Password123!', inviteCode: 'INV-AAAA-BBBB' }),
    })
    assert.equal(badReg.status, 400, 'Registration with invalid invite code must fail')

    const smokeAdmin = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'smoke_admin',
        password: SMOKE_ADMIN_PASS,
        inviteCode: TEST_BOOTSTRAP_TOKEN,
        deviceName: 'smoke-phone',
      }),
    })).json()
    assert.equal(smokeAdmin.ok, true)
    assert.equal(smokeAdmin.user.role, 'admin')
    assert.ok(smokeAdmin.roomId.startsWith('usr_'))

    const bootAfter = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootAfter.hasUsers, true)
    const secondBootTry = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'intruder', password: 'Password123!', inviteCode: TEST_BOOTSTRAP_TOKEN }),
    })
    assert.equal(secondBootTry.status, 400, 'ADMIN_BOOTSTRAP_TOKEN must only work for the first user')
    assert.equal(readFileSync(accountsFile, 'utf8').includes(SMOKE_ADMIN_PASS), false, 'accounts.json must never store plaintext password')

    // Login & wrong-password rejection
    const loginRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'smoke-phone' }),
    })
    assert.equal(loginRes.status, 200)
    const loginData = await loginRes.json()
    assert.equal(loginData.ok, true)
    assert.ok(loginData.token)

    const badPassRes = await fetch(`${httpBase}/api/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'smoke_admin', password: 'wrong-password' }),
    })
    assert.equal(badPassRes.status, 401)

    // Public /api/health zero-leakage & security headers
    const pubHealthRes = await fetch(`${httpBase}/api/health`)
    const pubHealth = await pubHealthRes.json()
    assert.equal(pubHealth.ok, true)
    assert.equal(pubHealth.bridges, undefined)
    assert.equal(pubHealth.onlineBridges, undefined)
    assert.equal(pubHealth.clients, undefined)
    assert.equal(pubHealth.rooms, undefined)
    assert.equal(pubHealthRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(pubHealthRes.headers.get('x-frame-options'), 'DENY')
    assert.equal(pubHealthRes.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(String(pubHealthRes.headers.get('permissions-policy') || '').includes('camera=(self)'))

    // Single-use invites, non-admin 403 & invite revocation
    const invBatch = await (await fetch(`${httpBase}/api/admin/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ count: 3, note: 'multi-tenant' }),
    })).json()
    assert.equal(invBatch.ok, true)
    assert.equal(invBatch.invites.length, 3)
    assert.match(invBatch.invites[0].code, /^INV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)

    const friendA = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_a', password: 'FriendAPass99!', inviteCode: invBatch.invites[0].code.toLowerCase() }),
    })).json()
    assert.equal(friendA.ok, true)
    assert.equal(friendA.user.role, 'user')

    const reuseInv = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'reuse_try', password: 'Password123!', inviteCode: invBatch.invites[0].code }),
    })
    assert.equal(reuseInv.status, 400, 'Single-use invite must reject a 2nd user')

    const nonAdminInv = await fetch(`${httpBase}/api/admin/invites`, {
      headers: { Authorization: `Bearer ${friendA.token}` },
    })
    assert.equal(nonAdminInv.status, 403, 'Non-admin user must receive 403 on /api/admin/invites')

    const friendB = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_b', password: 'FriendBPass99!', inviteCode: invBatch.invites[1].code }),
    })).json()
    assert.equal(friendB.ok, true)
    assert.notEqual(friendA.roomId, friendB.roomId)

    const revokedInv = await (await fetch(`${httpBase}/api/admin/invites/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ id: invBatch.invites[2].id }),
    })).json()
    assert.equal(revokedInv.invite.status, 'revoked')
    const revokedTry = await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'charlie', password: 'Password123!', inviteCode: invBatch.invites[2].code }),
    })
    assert.equal(revokedTry.status, 400, 'Revoked invite code must be rejected')

    // Device registration (`app://allinone` CORS), `device-login`, rename, unbind & multi-tenant bridge isolation
    const smokeDevRes = await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginData.token}`,
        Origin: 'app://allinone',
      },
      body: JSON.stringify({ label: 'Smoke-PC-1', hostname: 'smoke-pc', platform: process.platform }),
    })
    assert.equal(smokeDevRes.status, 200)
    assert.equal(smokeDevRes.headers.get('access-control-allow-origin'), 'app://allinone')
    const smokeDev = await smokeDevRes.json()
    assert.equal(smokeDev.ok, true)
    assert.ok(smokeDev.deviceSecret.startsWith('dv_'))
    assert.equal(readFileSync(accountsFile, 'utf8').includes(smokeDev.deviceSecret), false, 'accounts.json must never store plaintext deviceSecret')

    const tempPc = await (await fetch(`${httpBase}/api/account/device-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'smoke_admin',
        password: SMOKE_ADMIN_PASS,
        label: 'Temp-Desktop',
        hostname: 'TEMP-WIN',
        platform: 'win32',
      }),
    })).json()
    assert.equal(tempPc.ok, true)
    const renamedPc = await (await fetch(`${httpBase}/api/account/devices/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ deviceId: tempPc.deviceId, label: 'Home-Workstation' }),
    })).json()
    assert.equal(renamedPc.device.label, 'Home-Workstation')

    const removedPc = await (await fetch(`${httpBase}/api/account/devices/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ deviceId: tempPc.deviceId }),
    })).json()
    assert.equal(removedPc.ok, true)
    const statusAfterRemove = await fetch(`${httpBase}/api/account/device-status`, {
      headers: { 'X-Room-Id': tempPc.roomId, 'X-Bridge-Secret': tempPc.deviceSecret },
    })
    assert.equal(statusAfterRemove.status, 401, 'Unbound PC deviceSecret must immediately return 401')

    // Multi-tenant isolation using a lightweight mock bridge for Friend A
    const friendDevA = await (await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${friendA.token}` },
      body: JSON.stringify({ label: 'Friend-A-PC', hostname: 'friend-a-pc', platform: 'darwin' }),
    })).json()
    const friendBrA = await connectMockBridgeWs(port, {
      roomId: friendA.roomId,
      deviceSecret: friendDevA.deviceSecret,
      bridgeId: friendDevA.bridgeId,
      hostname: 'friend-a-pc',
      platform: 'darwin',
    })
    try {
      for (let i = 0; i < 30; i += 1) {
        if (relay.hub.getBridgeList(friendA.roomId).some((b) => b.online && b.e2ee?.enabled)) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.equal(relay.hub.getBridgeList(friendA.roomId).length, 1)
      assert.equal(relay.hub.getBridgeList(friendB.roomId).length, 0, 'Friend B must never see Friend A bridges')
      const meA = await (await fetch(`${httpBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${friendA.token}` },
      })).json()
      assert.equal(meA.username, 'friend_a')
      assert.equal(meA.bridges.length, 1)
      assert.equal(meA.bridges[0].online, true)
      const wsA = await openTicketClientWs(httpBase, port, friendA.token, { deviceName: 'friend-a-phone' })
      assert.equal(wsA.hello.roomId, friendA.roomId)
      assert.equal(wsA.hello.bridges[0].bridgeId, friendDevA.bridgeId)
      await wsA.closeAll()
    } finally {
      try { friendBrA.ws.close() } catch {}
    }

    // Portable single-file CLI bundle smoke check (never persists password; auto-generates mandatory e2eeKey)
    const bundlePath = join(process.cwd(), 'packages/mobile-app/public/downloads/allinone-bridge.mjs')
    if (existsSync(bundlePath)) {
      const cliStateDir = join(tmpDir, 'portable-account-home')
      const childEnv = { ...process.env, ALLINONE_NO_AUTOFIX: '1' }
      delete childEnv.ALLINONE_E2EE_KEY
      delete childEnv.ALLINONE_BRIDGE_SECRET
      const child = spawn(
        process.execPath,
        [
          bundlePath,
          '--server', httpBase,
          '--state-dir', cliStateDir,
          '--name', 'FriendB-Mac',
          '--username', 'friend_b',
          '--password', 'FriendBPass99!',
          '--no-browser',
        ],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      try {
        let out = ''
        child.stdout.on('data', (d) => { out += String(d) })
        child.stderr.on('data', (d) => { out += String(d) })
        for (let i = 0; i < 60; i += 1) {
          if (existsSync(join(cliStateDir, 'config.json')) && out.includes('已加密连接到中转服务器')) break
          await new Promise((r) => setTimeout(r, 100))
        }
        assert.ok(out.includes('已加密连接到中转服务器'), `Portable CLI should connect (${out.slice(0, 300)})`)
        const cfgRaw = readFileSync(join(cliStateDir, 'config.json'), 'utf8')
        assert.equal(cfgRaw.includes('FriendBPass99!'), false, 'PC config.json must never store account password')
        assert.ok(cfgRaw.includes('"mode": "account"'))
        assert.ok(cfgRaw.includes('"e2eeKey"'), 'PC config.json must auto-generate mandatory e2eeKey')
      } finally {
        try { child.kill() } catch {}
      }
    }
    pass(1, 'Account bootstrap, single-use invites, multi-tenant isolation, device lifecycle & portable CLI')

    // =========================================================================
    // 2. Live E2EE PC Bridge, Multi-PC Presence & 4-App RPC Routing
    // =========================================================================
    const primaryE2eeKey = generateE2eeKey()
    const primaryE2eeKeyId = await computeE2eeKeyId(primaryE2eeKey)
    bridge = startStandaloneBridge({
      relayUrl: wsBridgeUrl,
      secret: smokeDev.deviceSecret,
      roomId: smokeAdmin.roomId,
      bridgeId: smokeDev.bridgeId,
      e2eeKey: primaryE2eeKey,
      inboundDir: join(tmpDir, 'bridge-inbound'),
    })
    for (let i = 0; i < 50; i += 1) {
      if (relay.hub.getBridgeList(smokeAdmin.roomId).some((b) => b.online && b.e2ee?.enabled)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const primaryBridgeMeta = relay.hub.getBridgeList(smokeAdmin.roomId).find((b) => b.bridgeId === smokeDev.bridgeId)
    assert.ok(primaryBridgeMeta?.online && primaryBridgeMeta.e2ee?.enabled)
    assert.equal(primaryBridgeMeta.e2ee.keyId, primaryE2eeKeyId)
    assert.equal(JSON.stringify(primaryBridgeMeta).includes(primaryE2eeKey), false, 'Relay must never receive raw e2eeKey')

    const adminHealth = await (await fetch(`${httpBase}/api/health`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    })).json()
    assert.equal(adminHealth.roomId, smokeAdmin.roomId)
    assert.ok(adminHealth.onlineBridges >= 1)

    // Register & connect a 2nd lightweight bridge to verify multi-PC discovery & strict bridgeId targeting
    const smokeDev2 = await (await fetch(`${httpBase}/api/account/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ label: 'Smoke-PC-2', hostname: 'smoke-pc-2', platform: 'darwin' }),
    })).json()
    const mockBr2 = await connectMockBridgeWs(port, {
      roomId: smokeAdmin.roomId,
      deviceSecret: smokeDev2.deviceSecret,
      bridgeId: smokeDev2.bridgeId,
      hostname: 'smoke-pc-2',
      platform: 'darwin',
    })

    const cli = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'smoke-phone' })
    try {
      assert.equal(cli.hello.bridges.length, 2, 'Account room must support multiple simultaneous online E2EE bridges')
      const rpc = (method, params = {}) =>
        cli.sendEncryptedRpc(method, params, {
          e2eeKey: primaryE2eeKey,
          roomId: smokeAdmin.roomId,
          bridgeId: smokeDev.bridgeId,
        })

      // Offline bridgeId must fail strictly with BRIDGE_OFFLINE
      await assert.rejects(
        () =>
          cli.sendEncryptedRpc(RPC.APPS_STATUS, {}, {
            e2eeKey: primaryE2eeKey,
            roomId: smokeAdmin.roomId,
            bridgeId: 'offline-pc-999',
          }),
        (err) => err.code === 'BRIDGE_OFFLINE',
      )

      const statusRes = await rpc(RPC.APPS_STATUS)
      assert.equal(statusRes.apps.length, 4)

      const wsRes = await rpc(RPC.WORKSPACES_LIST)
      assert.ok(Array.isArray(wsRes.workspaces))

      const modelsRes = await rpc(RPC.MODELS_LIST)
      for (const app of ['dsh', 'codex', 'claude', 'antigravity']) {
        assert.ok(Array.isArray(modelsRes.catalog[app]?.models))
        const appInfo = statusRes.apps.find((a) => a.app === app)
        if (appInfo?.writable || app === 'dsh') {
          assert.ok(modelsRes.catalog[app].models.length > 0)
        }
      }

      const listRes = await rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 40 })
      assert.ok(Array.isArray(listRes.sessions))
      for (const app of ['dsh', 'codex', 'claude', 'antigravity']) {
        const sample = listRes.sessions.find((s) => s.app === app)
        if (!sample) continue
        const readRes = await rpc(RPC.SESSION_READ, { id: sample.id, limit: 10 })
        assert.equal(readRes.session.app, app)
        assert.ok(Array.isArray(readRes.session.messages))
        if (readRes.session.hasMore && readRes.session.nextCursor) {
          const olderRes = await rpc(RPC.SESSION_READ, { id: sample.id, limit: 10, cursor: readRes.session.nextCursor })
          assert.ok(Array.isArray(olderRes.session.messages))
        }
      }

      // E2EE RPC.FILE_READ image loading + non-image guardrail
      const fileRes = await rpc(RPC.FILE_READ, {
        path: 'packages/mobile-app/public/icon-192.png',
        cwd: process.cwd(),
      })
      assert.equal(fileRes.mimeType, 'image/png')
      const imgBuf = Buffer.from(fileRes.dataBase64, 'base64')
      assert.ok(imgBuf.length > 1000 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50)
      await assert.rejects(
        () => rpc(RPC.FILE_READ, { path: 'package.json', cwd: process.cwd() }),
        /出于安全限制/,
      )
    } finally {
      await cli.closeAll()
      try { mockBr2.ws.close() } catch {}
    }
    pass(2, 'Live E2EE PC Bridge, multi-PC routing & 4-app RPCs (apps, models, sessions, E2EE FILE_READ)')

    // =========================================================================
    // 3. Core Control Plane & Bridge Security Hardening
    // =========================================================================
    {
      // 3a. Production weak JWT_SECRET refusal
      assert.throws(
        () =>
          createRelayServer({
            port: 0,
            host: '127.0.0.1',
            nodeEnv: 'production',
            jwtSecret: 'too-short',
            accountsFile: join(tmpDir, 'prod-accounts.json'),
          }),
        /Refusing to start in production/,
      )

      // 3b. Strict CORS allowlist
      const evilCorsRes = await fetch(`${httpBase}/api/health`, { headers: { Origin: 'https://evil.example.com' } })
      assert.equal(evilCorsRes.headers.get('access-control-allow-origin'), null)
      const evilPreflight = await fetch(`${httpBase}/api/auth/me`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com' },
      })
      assert.equal(evilPreflight.status, 403)
      const capCorsRes = await fetch(`${httpBase}/api/health`, { headers: { Origin: 'https://localhost' } })
      assert.equal(capCorsRes.headers.get('access-control-allow-origin'), 'https://localhost')

      // 3c. Single-use WS ticket, CSWSH evil Origin block & ticket replay rejection
      const ticketRes = await (await fetch(`${httpBase}/api/auth/ws-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginData.token}` },
      })).json()
      assert.ok(ticketRes.ticket.startsWith('tk_'))

      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`, {
              headers: { Origin: 'https://evil.example.com' },
            })
            ws.on('open', () => { ws.close(); resolve() })
            ws.on('error', reject)
          }),
        'Evil Origin WS upgrade must be rejected',
      )

      const validTicketWs = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
      await new Promise((resolve, reject) => {
        validTicketWs.on('message', (raw) => { if (JSON.parse(String(raw)).type === 'hello') resolve() })
        validTicketWs.on('error', reject)
      })
      validTicketWs.close()

      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
            ws.on('open', () => { ws.close(); resolve() })
            ws.on('error', reject)
          }),
        'Reusing a single-use WS ticket must be rejected',
      )

      // 3d. Bridge WS header-only auth, mandatory E2EE enforcement (4008) & RelayBridgeLink 401 clean stop
      await assert.rejects(
        () =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `ws://127.0.0.1:${port}/ws/bridge?room=${encodeURIComponent(smokeAdmin.roomId)}&secret=${encodeURIComponent(smokeDev.deviceSecret)}`,
            )
            ws.on('open', () => { ws.close(); resolve() })
            ws.on('error', reject)
          }),
        'Bridge WS must reject ?secret= in query string',
      )

      const nonE2eeCloseCode = await new Promise((resolveCode, rejectCode) => {
        const qs = new URLSearchParams({ roomId: smokeAdmin.roomId, bridgeId: smokeDev2.bridgeId, hostname: 'plain', platform: 'darwin' })
        const rawBr = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?${qs.toString()}`, {
          headers: { 'X-Room-Id': smokeAdmin.roomId, 'X-Bridge-Secret': smokeDev2.deviceSecret },
        })
        rawBr.on('open', () => { rawBr.send(JSON.stringify({ type: 'bridge.meta', meta: { apps: [] } })) })
        rawBr.on('close', (code) => resolveCode(code))
        rawBr.on('error', rejectCode)
      })
      assert.equal(nonE2eeCloseCode, 4008, 'Bridge sending bridge.meta without E2EE must close with 4008')

      const unauthStates = []
      const badBridge = new RelayBridgeLink({
        relayUrl: wsBridgeUrl,
        bridgeId: 'revoked-pc',
        roomId: 'usr_nonexistent_room',
        secret: 'invalid-secret-xyz',
        e2eeKey: generateE2eeKey(),
        onRpc: async () => ({}),
        log: { info: () => {}, warn: () => {}, error: () => {} },
        onState: (st, detail) => unauthStates.push({ st, detail }),
      })
      badBridge.start()
      const unauthDeadline = Date.now() + 5_000
      while (Date.now() < unauthDeadline && !unauthStates.some((x) => x.st === 'unauthorized')) {
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(unauthStates.some((x) => x.st === 'unauthorized'))
      assert.equal(badBridge.reconnectTimer, null, 'Unauthorized bridge must not schedule reconnect')
      badBridge.stop()

      // 3e. Malformed HTTP Host crash defense & unauthenticated /api/admin/invites 401
      const badHostStatus = await new Promise((resolveStatus, rejectStatus) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.write('GET /api/health HTTP/1.1\r\nHost: bad:port\r\nConnection: close\r\n\r\n')
        })
        let resp = ''
        sock.on('data', (c) => { resp += c.toString('utf8') })
        sock.on('end', () => resolveStatus(resp.split('\r\n')[0] || ''))
        sock.on('error', rejectStatus)
      })
      assert.match(badHostStatus, /400/)
      assert.equal((await (await fetch(`${httpBase}/api/health`)).json()).ok, true)
      assert.equal((await fetch(`${httpBase}/api/admin/invites`)).status, 401)

      // 3f. SSRF, forged p2pToken, symlink bypass, session ID path traversal & CLI arg injection
      let attackerHits = 0
      const attackerServer = http.createServer((_req, res) => { attackerHits += 1; res.writeHead(200); res.end('nope') })
      await new Promise((r) => attackerServer.listen(0, '127.0.0.1', r))
      try {
        const matResult = await bridge.orchestrator.materializeAttachments([
          { url: `http://127.0.0.1:${attackerServer.address().port}/steal`, filename: 'evil.txt', mimeType: 'text/plain' },
          { localPath: '/etc/passwd', filename: 'passwd', mimeType: 'text/plain' },
          { p2pToken: 'p2p_forged_token', filename: 'forged.txt', mimeType: 'text/plain' },
        ])
        assert.equal(matResult.length, 0)
        assert.equal(attackerHits, 0)
      } finally {
        await new Promise((r) => attackerServer.close(r))
      }

      const symlinkPath = join(tmpDir, 'disguised-secret.png')
      symlinkSync(join(process.cwd(), 'package.json'), symlinkPath)
      await assert.rejects(() => bridge.orchestrator.readLocalFile({ path: symlinkPath }), /出于安全限制/)

      await assert.rejects(() => bridge.orchestrator.readSession({ id: 'dsh:../../etc/passwd' }), /非法的/)
      await assert.rejects(() => bridge.orchestrator.readSession({ id: 'claude:../../etc/passwd' }), /非法的/)
      await assert.rejects(() => bridge.orchestrator.readSession({ id: 'antigravity:../../etc/passwd' }), /非法的/)
      await assert.rejects(() => bridge.orchestrator.sendMessage({ id: 'claude:--malicious-flag', text: 'hi' }), /非法的/)
      await assert.rejects(() => bridge.orchestrator.sendMessage({ id: 'claude:safe-id-1', text: 'hi', model: 'opus & calc.exe' }), /非法的/)

      // 3g. X-Forwarded-For spoofing resistance (uses rightmost trusted-proxy IP)
      for (let i = 0; i < 15; i += 1) {
        const r = await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.${i + 1}, 203.0.113.9` },
          body: JSON.stringify({ username: `nonexistent_user_${i}`, password: 'bad-password' }),
        })
        assert.equal(r.status, 401)
      }
      const throttled = await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9, 203.0.113.9' },
        body: JSON.stringify({ username: 'nonexistent_user_16', password: 'bad-password' }),
      })
      assert.equal(throttled.status, 429)

      // 3h. changePasswordAsync TOCTOU protection against concurrent revoke-all
      const invToctou = await (await fetch(`${httpBase}/api/admin/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ note: 'toctou' }),
      })).json()
      const regToctou = await (await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'toctou_u', password: 'InitPassword25!', inviteCode: invToctou.invites[0].code }),
      })).json()
      const [pwRaceRes, revokeRaceRes] = await Promise.all([
        fetch(`${httpBase}/api/account/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regToctou.token}` },
          body: JSON.stringify({ currentPassword: 'InitPassword25!', newPassword: 'HijackPassword25!' }),
        }),
        new Promise((resolveRev) =>
          setTimeout(() => {
            resolveRev(
              fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regToctou.token}` },
                body: JSON.stringify({}),
              }),
            )
          }, 5),
        ),
      ])
      if (revokeRaceRes.status === 200) {
        assert.equal(pwRaceRes.status, 401)
        const verifyOrig = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'toctou_u', password: 'InitPassword25!' }),
        })).json()
        assert.equal(verifyOrig.ok, true)
      }
    }
    pass(3, 'Core security hardening (JWT, CORS/CSWSH, E2EE 4008, 401 stop, SSRF/symlink/traversal, XFF & TOCTOU)')

    // =========================================================================
    // 4. Full-Duplex Zero-Knowledge E2EE & Direct WebRTC P2P (`aio-ctrl` + `aio-bulk` + Instant Revocation)
    // =========================================================================
    {
      // 4a. Crypto, Base64URL strictness, QR (including Version 11+), protocol parity & 48KB SCTP ctrl fragmentation
      const unitKey = generateE2eeKey()
      const unitKeyId = await computeE2eeKeyId(unitKey)
      assert.match(unitKeyId, /^[0-9a-f]{16}$/)
      assert.match(formatE2eeFingerprint(unitKeyId), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

      const qrUri = encodeE2eeQrUri({ key: unitKey, roomId: smokeAdmin.roomId })
      assert.ok(qrUri.startsWith('allinone-e2ee://v1?'))
      const parsedQr = parseE2eeQrInput(qrUri)
      assert.equal(parsedQr.key, unitKey)
      assert.equal(parsedQr.roomId, smokeAdmin.roomId)
      assert.equal(parsedQr.isUri, true)
      assert.equal(parseE2eeQrInput(unitKey).key, unitKey)
      assert.ok(renderSharedQrSvg(qrUri).includes('<svg xmlns="http://www.w3.org/2000/svg"'))
      assert.ok(renderSharedQrSvg(`https://example.com/${'a'.repeat(240)}`).startsWith('<svg'))

      assert.equal(base64UrlToBytes(`${unitKey}=GARBAGE`), null)
      assert.equal(base64UrlToBytes(`${unitKey}==`), null)
      assert.equal(base64UrlToBytes('===='), null)
      assert.equal(base64UrlToBytes('abcd efgh'), null)

      assert.equal(toEpochMs(new Date('invalid')), 0)
      assert.deepEqual(parseCompositeId({ app: 'codex', sessionId: 'thr-1' }), { app: 'codex', sessionId: 'thr-1' })
      assert.equal(hubToEpochMs(new Date('invalid')), 0)
      assert.equal(hubToEpochMs(-123), 0)
      assert.notEqual(hubToEpochMs('2026'), 2026000)
      assert.deepEqual(hubParseCompositeId({ app: 'codex', sessionId: 'thr-2' }), { app: 'codex', sessionId: 'thr-2' })

      const sampleEnv = await encryptJson(unitKey, { secret: 'hello-e2ee' }, { kind: 'rpc.req', roomId: smokeAdmin.roomId })
      assert.equal((await decryptJson(unitKey, sampleEnv, { kind: 'rpc.req', roomId: smokeAdmin.roomId })).secret, 'hello-e2ee')
      await assert.rejects(() => decryptJson(unitKey, sampleEnv, { kind: 'rpc.res', roomId: smokeAdmin.roomId }), /解密失败/)
      await assert.rejects(() => decryptJson(unitKey, sampleEnv, { kind: 'rpc.req', roomId: 'usr_other' }), /解密失败/)
      const tamperedCt = (sampleEnv.ct[0] === 'A' ? 'B' : 'A') + sampleEnv.ct.slice(1)
      await assert.rejects(() => decryptJson(unitKey, { ...sampleEnv, ct: tamperedCt }, { kind: 'rpc.req', roomId: smokeAdmin.roomId }), /解密失败/)

      const encCodec = createCtrlCodec()
      const decCodec = createCtrlCodec()
      const bigCtrl = { type: 'rpc.res', id: 'frag-1', blob: 'X'.repeat(150 * 1024) }
      const frames = encCodec.encode(bigCtrl)
      assert.ok(frames.length >= 4)
      let reassembled = null
      for (const f of frames) {
        assert.ok(f.length <= 49 * 1024)
        reassembled = decCodec.decode(f)
      }
      assert.deepEqual(reassembled, bigCtrl)

      // 4b. Live P2P E2EE enforcement, encrypted streaming events, 5MB PC<->Phone AIO2 bulk & instant revocation
      const p2pDir = join(tmpDir, 'p2p-bulk-workspace')
      mkdirSync(p2pDir, { recursive: true })
      const bigPdfBuf = Buffer.alloc(5 * 1024 * 1024 + 200_000)
      for (let i = 0; i < bigPdfBuf.length; i += 1) bigPdfBuf[i] = (i * 31 + 17) & 0xff
      const bigPdfPath = join(p2pDir, 'annual-report.pdf')
      writeFileSync(bigPdfPath, bigPdfBuf)
      const expectedPdfSha = createHash('sha256').update(bigPdfBuf).digest('hex')

      const p2pCli = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'p2p-bulk-phone' })
      try {
        const peer = await p2pCli.connectP2p({
          bridgeId: smokeDev.bridgeId,
          e2eeKey: primaryE2eeKey,
          roomId: smokeAdmin.roomId,
        })

        // Plaintext RPC -> E2EE_KEY_REQUIRED
        const plainTry = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-plain', method: RPC.APPS_STATUS, params: {} })
        assert.equal(plainTry.error?.code, 'E2EE_KEY_REQUIRED')

        // Wrong key -> E2EE_KEY_MISMATCH
        const wrongEnv = await encryptJson(
          generateE2eeKey(),
          { method: RPC.APPS_STATUS, params: {}, cid: 'e2ee-wrong', ts: Date.now() },
          { kind: 'rpc.req', roomId: smokeAdmin.roomId },
        )
        const wrongTry = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-wrong', e2ee: wrongEnv })
        assert.equal(wrongTry.error?.code, 'E2EE_KEY_MISMATCH')

        // Valid encrypted FILE_READ + exact ciphertext replay rejection
        const fileReqEnv = await encryptJson(
          primaryE2eeKey,
          {
            method: RPC.FILE_READ,
            params: { path: 'packages/mobile-app/public/icon-192.png', cwd: process.cwd() },
            cid: 'e2ee-file-1',
            ts: Date.now(),
          },
          { kind: 'rpc.req', roomId: smokeAdmin.roomId },
        )
        const encFileRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-file-1', e2ee: fileReqEnv })
        assert.equal(encFileRes.ok, true)
        assert.equal(encFileRes.result, undefined)
        assert.equal(JSON.stringify(encFileRes).includes('image/png'), false)
        const decFileRes = await decryptJson(primaryE2eeKey, encFileRes.e2ee, { kind: 'rpc.res', roomId: smokeAdmin.roomId })
        assert.equal(decFileRes.result.mimeType, 'image/png')

        const replayRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-replay', e2ee: fileReqEnv })
        assert.equal(replayRes.error?.code, 'E2EE_REPLAY_DETECTED')

        // Streaming event pushed over P2P aio-ctrl (0 frames via Control Server WS)
        const controlEventsBefore = p2pCli.events.length
        const secretToken = 'ZERO_KNOWLEDGE_SECRET_DELTA_987654'
        bridge.link.pushEvent(EVENTS.STREAM_DELTA, { sessionId: 'codex:s1', delta: secretToken })
        for (let i = 0; i < 30; i += 1) {
          if (p2pCli.p2pEvents.some((e) => e.bridgeId === smokeDev.bridgeId && e.e2ee?.ct)) break
          await new Promise((r) => setTimeout(r, 40))
        }
        const encEv = p2pCli.p2pEvents.find((e) => e.bridgeId === smokeDev.bridgeId && e.e2ee?.ct)
        assert.ok(encEv)
        assert.equal(p2pCli.events.length, controlEventsBefore, 'Streaming event must not traverse Control WS')
        const decEv = await decryptJson(primaryE2eeKey, encEv.e2ee, { kind: 'event', roomId: smokeAdmin.roomId })
        assert.equal(decEv.event, EVENTS.STREAM_DELTA)
        assert.equal(decEv.payload.delta, secretToken)

        // 5.2MB PC -> Phone AIO2 bulk download
        const metaRes = await peer.sendEncryptedRpc(RPC.FILE_READ, { path: bigPdfPath, cwd: p2pDir, mode: 'document' })
        assert.equal(metaRes.transferMode, 'p2p-bulk')
        assert.equal(metaRes._localRealPath, undefined)
        const downloadedBuf = await peer.downloadBulkStream(metaRes.streamId)
        assert.equal(downloadedBuf.length, bigPdfBuf.length)
        assert.equal(createHash('sha256').update(downloadedBuf).digest('hex'), expectedPdfSha)

        // 5.1MB Phone -> PC AIO2 bulk upload + client-scoped single-use p2pToken
        const bigUpBuf = Buffer.alloc(5 * 1024 * 1024 + 100_000)
        for (let i = 0; i < bigUpBuf.length; i += 1) bigUpBuf[i] = (i * 19 + 7) & 0xff
        const expectedUpSha = createHash('sha256').update(bigUpBuf).digest('hex')

        const upDone = await peer.uploadFileBulk(bigUpBuf, {
          filename: 'phone-capture.bin',
          mimeType: 'application/octet-stream',
        })
        assert.ok(upDone.p2pToken?.startsWith('p2p_'))
        assert.equal(upDone.size, bigUpBuf.length)

        // Cross-client hijack rejected
        const stolenMat = await bridge.orchestrator.materializeAttachments(
          [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
          { clientId: 'attacker-client-id' },
        )
        assert.equal(stolenMat.length, 0)

        // Legitimate client materializes exact 5.1MB file, then single-use replay is rejected
        const okMat = await bridge.orchestrator.materializeAttachments(
          [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
          { clientId: p2pCli.hello.clientId },
        )
        assert.equal(okMat.length, 1)
        assert.equal(createHash('sha256').update(readFileSync(okMat[0].localPath)).digest('hex'), expectedUpSha)
        const replayMat = await bridge.orchestrator.materializeAttachments(
          [{ id: upDone.p2pToken, p2pToken: upDone.p2pToken, filename: 'phone-capture.bin' }],
          { clientId: p2pCli.hello.clientId },
        )
        assert.equal(replayMat.length, 0)

        // Instant revocation (client.revoked): revoking a live P2P session destroys DataChannel in <1s
        const kickLogin = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'smoke_admin', password: SMOKE_ADMIN_PASS, deviceName: 'victim-phone' }),
        })).json()
        const victimCli = await openTicketClientWs(httpBase, port, kickLogin.token, { deviceName: 'victim-phone' })
        try {
          const victimPeer = await victimCli.connectP2p({
            bridgeId: smokeDev.bridgeId,
            e2eeKey: primaryE2eeKey,
            roomId: smokeAdmin.roomId,
          })
          assert.equal((await victimPeer.sendEncryptedRpc(RPC.APPS_STATUS)).apps.length, 4)
          assert.ok(bridge.link.p2p.sessions.has(victimCli.hello.clientId))

          const kickStarted = Date.now()
          const kickRes = await (await fetch(`${httpBase}/api/auth/sessions/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
            body: JSON.stringify({ sid: victimCli.hello.sid, clientId: victimCli.hello.clientId }),
          })).json()
          assert.equal(kickRes.ok, true)

          for (let i = 0; i < 50; i += 1) {
            if (!bridge.link.p2p.sessions.has(victimCli.hello.clientId)) break
            await new Promise((r) => setTimeout(r, 20))
          }
          assert.equal(bridge.link.p2p.sessions.has(victimCli.hello.clientId), false)
          assert.ok(Date.now() - kickStarted < 1000)
          assert.ok(bridge.link.p2p.revokedClients.has(victimCli.hello.clientId))
        } finally {
          await victimCli.closeAll()
        }
      } finally {
        await p2pCli.closeAll()
      }
    }
    pass(4, 'Full-duplex ZK E2EE & WebRTC P2P (replay/wrong-key defense, 5MB AIO2 bulk, 48KB frag & instant revocation)')

    // =========================================================================
    // 5. Zero-Knowledge Device-to-Device Key Grant (ECDH P-256 + SAS + Reverse-QR) & QR Scan Nudge
    // =========================================================================
    {
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
      assert.deepEqual(parseE2eeGrantQrInput(grantUri), { reqId: reqId1, roomId: testRoomId, pubKeyFp: pairC.publicKeyFp })

      const sasFromC = await deriveGrantSas({ requesterPubKey: pairC.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId })
      const sasFromB = await deriveGrantSas({ requesterPubKey: pairC.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId })
      assert.match(sasFromC, /^\d{3}-\d{3}$/)
      assert.equal(sasFromC, sasFromB)
      assert.notEqual(
        await deriveGrantSas({ requesterPubKey: pairEvil.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId }),
        sasFromC,
      )

      const env1 = await encryptGrantPayload({
        approverPrivateKey: pairB.privateKey,
        approverPubKeyRaw: pairB.publicKeyRaw,
        requesterPubKeyRaw: pairC.publicKeyRaw,
        reqId: reqId1,
        roomId: testRoomId,
        payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
      })
      assert.equal(JSON.stringify(env1).includes(roomKeyA), false)
      const dec1 = await decryptGrantPayload({
        requesterPrivateKey: pairC.privateKey,
        requesterPubKeyRaw: pairC.publicKeyRaw,
        envelope: env1,
        roomId: testRoomId,
        expectedApproverPubKey: pairB.publicKeyRaw,
      })
      assert.equal(dec1.keys[0].key, roomKeyA)
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: env1, roomId: testRoomId, expectedApproverPubKey: pairEvil.publicKeyRaw }),
        /E2EE_GRANT_PUBKEY_MISMATCH|安全码/,
      )
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: env1, roomId: 'usr_wrong' }),
        /解密授权密钥包失败/,
      )
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: { ...env1, ct: `${env1.ct.slice(0, -2)}AA` }, roomId: testRoomId }),
        /解密授权密钥包失败/,
      )

      // Live Relay signaling on primary relay (`smoke_admin` PC & Phone vs isolated `friend_b`)
      const compC = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'Windows Desktop', clientKind: 'desktop' })
      const mallory = await openTicketClientWs(httpBase, port, friendB.token, { deviceName: 'Other-Account', clientKind: 'web' })
      let phoneB = null
      try {
        const cPair1 = await generateGrantKeyPair()
        const liveReqId1 = generateGrantReqId()
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId1, pubKey: cPair1.publicKeyRaw, wantedKeyId: roomKeyAId }))
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

        // Phone B connects late -> receives pending grant in hello frame
        phoneB = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'iPhone · Safari', clientKind: 'mobile' })
        assert.equal(phoneB.hello.pendingGrants.length, 1)
        assert.equal(phoneB.hello.pendingGrants[0].reqId, liveReqId1)

        // Path A: SAS Push -> Deliver -> Single-use burn
        const bPair1 = await generateGrantKeyPair()
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId: liveReqId1, approverPubKey: bPair1.publicKeyRaw }))
        const offerEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_OFFER && m.payload?.reqId === liveReqId1)
        assert.equal(offerEv.payload.approverPubKey, bPair1.publicKeyRaw)

        const liveEnv1 = await encryptGrantPayload({
          approverPrivateKey: bPair1.privateKey,
          approverPubKeyRaw: bPair1.publicKeyRaw,
          requesterPubKeyRaw: cPair1.publicKeyRaw,
          reqId: liveReqId1,
          roomId: smokeAdmin.roomId,
          payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
        })
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
        const deliverEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId1)
        const unlocked1 = await decryptGrantPayload({
          requesterPrivateKey: cPair1.privateKey,
          requesterPubKeyRaw: cPair1.publicKeyRaw,
          envelope: deliverEv.payload.envelope,
          roomId: smokeAdmin.roomId,
          expectedApproverPubKey: offerEv.payload.approverPubKey,
        })
        assert.equal(unlocked1.keys[0].key, roomKeyA)

        // Burned reqId ignores replay
        const deliverBefore = compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId1, envelope: liveEnv1 }))
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(compC.inbox.filter((m) => m.event === EVENTS.E2EE_GRANT_DELIVER).length, deliverBefore)

        // Path B: Reverse-QR out-of-band 1-tap delivery
        const cPair2 = await generateGrantKeyPair()
        const liveReqId2 = generateGrantReqId()
        const parsedQr2 = parseE2eeGrantQrInput(encodeE2eeGrantQrUri({ reqId: liveReqId2, roomId: smokeAdmin.roomId, pubKeyFp: cPair2.publicKeyFp }))
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId2, pubKey: cPair2.publicKeyRaw }))
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
          payload: { keys: [{ keyId: roomKeyAId, key: roomKeyA }], preferredKeyId: roomKeyAId },
        })
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId: liveReqId2, envelope: liveEnv2 }))
        const deliverEv2 = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_DELIVER && m.payload?.reqId === liveReqId2)
        const unlocked2 = await decryptGrantPayload({
          requesterPrivateKey: cPair2.privateKey,
          requesterPubKeyRaw: cPair2.publicKeyRaw,
          envelope: deliverEv2.payload.envelope,
          roomId: smokeAdmin.roomId,
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
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId3, pubKey: cPair3.publicKeyRaw }))
        await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REQUEST && m.payload?.reqId === liveReqId3)
        phoneB.ws.close()
        const nudgeDone = await compC.waitFor((m) => m.event === EVENTS.E2EE_QR_NUDGE && m.payload?.action === 'done')
        assert.equal(nudgeDone.payload.requesterClientId, phoneB.hello.clientId)

        // Open fresh Phone B briefly to observe compC disconnect auto-cancel
        const phoneB2 = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'Android App', clientKind: 'mobile' })
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
    }
    pass(5, 'Zero-Knowledge Device-to-Device Key Grant (ECDH P-256, SAS, Reverse-QR, MITM defense) & QR Scan Nudge')

    // =========================================================================
    // 6. Active Client Sessions Monitor, Live WS Push, Per-Device Kick, Revoke-Others & Revoke-All
    // =========================================================================
    {
      const invSess = await (await fetch(`${httpBase}/api/admin/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ note: 'sessions-test' }),
      })).json()
      const regA = await (await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'sess_alice',
          password: 'Password123!',
          inviteCode: invSess.invites[0].code,
          deviceName: 'Windows Desktop',
          clientKind: 'desktop',
        }),
      })).json()
      const loginB = await (await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sess_alice', password: 'Password123!', deviceName: 'Android App', clientKind: 'mobile' }),
      })).json()
      const loginC = await (await fetch(`${httpBase}/api/account/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sess_alice', password: 'Password123!', deviceName: 'macOS · Chrome', clientKind: 'web' }),
      })).json()

      const cliA = await openTicketClientWs(httpBase, port, regA.token, { deviceName: 'Windows Desktop', clientKind: 'desktop' })
      const cliB = await openTicketClientWs(httpBase, port, loginB.token, { deviceName: 'Android App', clientKind: 'mobile' })
      const cliC = await openTicketClientWs(httpBase, port, loginC.token, { deviceName: 'macOS · Chrome', clientKind: 'web' })
      try {
        assert.equal(cliA.hello.onlineClientCount, 1)
        await cliA.waitFor((m) => m.event === 'clients.status' && m.payload?.onlineCount === 3)

        const sessList = await (await fetch(`${httpBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${regA.token}` },
        })).json()
        assert.equal(sessList.onlineCount, 3)
        assert.equal(sessList.totalCount, 3)
        assert.equal(sessList.sessions.find((s) => s.isCurrent)?.deviceName, 'Windows Desktop')
        const sessB = sessList.sessions.find((s) => s.deviceName === 'Android App')
        assert.ok(sessB?.sid)

        // Single-device kick closes Device B with 4401 and invalidates its token
        const kickB = await (await fetch(`${httpBase}/api/auth/sessions/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regA.token}` },
          body: JSON.stringify({ sid: sessB.sid, clientId: sessB.clientId, currentClientId: cliA.hello.clientId }),
        })).json()
        assert.equal(kickB.revokedPermanent, true)
        assert.equal(kickB.onlineCount, 2)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(cliB.getClosedCode(), 4401)
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${loginB.token}` } })).status, 401)

        // Revoke-others kicks Device C with 4401 and rotates Device A token cleanly
        const kickOthers = await (await fetch(`${httpBase}/api/auth/sessions/revoke-others`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regA.token}` },
          body: JSON.stringify({ currentClientId: cliA.hello.clientId, deviceName: 'Windows Desktop', clientKind: 'desktop' }),
        })).json()
        assert.ok(kickOthers.token && kickOthers.token !== regA.token)
        assert.equal(kickOthers.onlineCount, 1)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(cliC.getClosedCode(), 4401)
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${loginC.token}` } })).status, 401)

        const aFresh = await (await fetch(`${httpBase}/api/auth/sessions?clientId=${encodeURIComponent(cliA.hello.clientId)}`, {
          headers: { Authorization: `Bearer ${kickOthers.token}` },
        })).json()
        assert.equal(aFresh.onlineCount, 1)
        assert.equal(aFresh.sessions[0]?.isCurrent, true)

        // Revoke-all kicks remaining Device A with 4401 and invalidates rotated token; re-login recovers
        const revokeAll = await (await fetch(`${httpBase}/api/auth/sessions/revoke-all`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kickOthers.token}` },
        })).json()
        assert.equal(revokeAll.disconnectedClients, 1)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(cliA.getClosedCode(), 4401)
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${kickOthers.token}` } })).status, 401)

        const reLogin = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Android App',
            clientKind: 'mobile',
            clientUid: 'cli_phone_stable_01',
          }),
        })).json()
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${reLogin.token}` } })).status, 200)

        // Same clientUid re-login replaces & revokes previous session in-place (zero duplicate rows across IP switches)
        const reLogin2 = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Android App',
            clientKind: 'mobile',
            clientUid: 'cli_phone_stable_01',
          }),
        })).json()
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${reLogin.token}` } })).status, 401)
        const dedupSess = await (await fetch(`${httpBase}/api/auth/sessions`, {
          headers: { Authorization: `Bearer ${reLogin2.token}` },
        })).json()
        assert.equal(dedupSess.totalCount, 1)

        // Named desktop PC re-login (even after storage wipe / new clientUid) sweeps offline ghost for same machine
        const pcLogin1 = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Windows Desktop · Work37',
            clientKind: 'desktop',
            clientUid: 'cli_pc_work37_old',
          }),
        })).json()
        const pcLogin2 = await (await fetch(`${httpBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'sess_alice',
            password: 'Password123!',
            deviceName: 'Windows Desktop · Work37',
            clientKind: 'desktop',
            clientUid: 'cli_pc_work37_reinstall',
          }),
        })).json()
        assert.equal((await fetch(`${httpBase}/api/auth/me`, { headers: { Authorization: `Bearer ${pcLogin1.token}` } })).status, 401)
        const dedupAfterPc = await (await fetch(`${httpBase}/api/auth/sessions`, {
          headers: { Authorization: `Bearer ${pcLogin2.token}` },
        })).json()
        assert.equal(dedupAfterPc.totalCount, 2)

        // Same PC (hostname + platform) rebinding without explicit bridgeId updates in-place & keeps custom label
        const pcBind1 = await (await fetch(`${httpBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
          body: JSON.stringify({ label: 'Work37', hostname: 'Work37', platform: 'win32' }),
        })).json()
        await fetch(`${httpBase}/api/account/devices/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
          body: JSON.stringify({ deviceId: pcBind1.deviceId, label: 'My Custom Work PC' }),
        })
        const pcBind2 = await (await fetch(`${httpBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcLogin2.token}` },
          body: JSON.stringify({ label: 'Work37', hostname: 'Work37', platform: 'win32' }),
        })).json()
        assert.equal(pcBind2.deviceId, pcBind1.deviceId)
        assert.equal(pcBind2.bridgeId, pcBind1.bridgeId)
        assert.equal(pcBind2.label, 'My Custom Work PC')
        assert.equal(pcBind2.devices.length, 1)
      } finally {
        await cliA.closeAll()
        await cliB.closeAll()
        await cliC.closeAll()
      }
    }
    pass(6, 'Active client sessions monitor, device/session dedup, live push, per-device kick & revoke-all')

    // =========================================================================
    // 7. Zero-Dep SMTP Mailer, Optional Email Bind, Password Reset, New-IP Alert, Login 2FA & Rate Limits
    // =========================================================================
    {
      const smtp = await createMockSmtpServer()
      const secStaticDir = join(tmpDir, 'email-static')
      mkdirSync(secStaticDir, { recursive: true })
      writeFileSync(join(secStaticDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8')

      const emailRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'email-jwt-secret-0123456789',
        adminBootstrapToken: 'email-bootstrap-secret-99',
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

        // Optional email: bootstrap admin WITHOUT email
        const evaReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'eva', password: 'EvaAdminPassword1!', inviteCode: 'email-bootstrap-secret-99' }),
        })).json()
        assert.equal(evaReg.user.email, '')
        assert.equal(evaReg.user.emailVerified, false)

        const invBatch = await (await fetch(`${eBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${evaReg.token}` },
          body: JSON.stringify({ count: 2, note: 'email-test' }),
        })).json()
        const [inv1, inv2] = invBatch.invites

        // Invalid invite must NEVER consume SMTP quota
        assert.equal(
          (await fetch(`${eBase}/api/account/email/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: 'INV-FAKE-0000' }),
          })).status,
          400,
        )
        assert.equal(smtp.inbox.length, 0)

        // Valid invite -> SMTP AUTH LOGIN delivery + 429 cooldown + register with verified email
        const regCode = await (await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: inv1.code }),
        })).json()
        assert.equal(regCode.ok, true)
        assert.equal(smtp.inbox.length, 1)
        assert.equal(smtp.inbox[0].authUser, 'noreply@example.com')
        assert.equal(smtp.inbox[0].authPass, 'smtp-auth-secret')
        assert.match(smtp.inbox[0].code, /^\d{6}$/)

        assert.equal(
          (await fetch(`${eBase}/api/account/email/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purpose: 'register', email: 'dave@example.com', inviteCode: inv1.code }),
          })).status,
          429,
        )

        const daveReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({
            username: 'dave',
            password: 'DavePassword123!',
            inviteCode: inv1.code,
            email: 'dave@example.com',
            emailCode: smtp.inbox[0].code,
            deviceName: 'MacBook-Pro',
          }),
        })).json()
        assert.equal(daveReg.user.emailVerified, true)

        // Case-insensitive email login & device-login + New-IP security alert email
        const daveLogin = await (await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.77' },
          body: JSON.stringify({ username: 'DAVE@Example.com', password: 'DavePassword123!', deviceName: 'Unknown-Browser' }),
        })).json()
        assert.equal(daveLogin.user.username, 'dave')
        await new Promise((r) => setTimeout(r, 120))
        assert.equal(smtp.inbox.length, 2, 'New-IP login must send a security alert email')
        assert.ok(smtp.inbox[1].decodedText.includes('203.0.113.77') && smtp.inbox[1].decodedText.includes('Unknown-Browser'))

        const daveDevLogin = await (await fetch(`${eBase}/api/account/device-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave@example.com', password: 'DavePassword123!', label: 'Dave-PC' }),
        })).json()
        assert.equal(daveDevLogin.username, 'dave')

        // Post-login email bind + duplicate email rejection
        const frankReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!', inviteCode: inv2.code }),
        })).json()
        assert.equal(
          (await fetch(`${eBase}/api/account/email/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
            body: JSON.stringify({ purpose: 'bind', email: 'dave@example.com' }),
          })).status,
          400,
        )
        const bindSend = await (await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ purpose: 'bind', email: 'frank@example.com' }),
        })).json()
        assert.equal(bindSend.ok, true)
        const frankBindCode = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<frank@example.com>' && m.code)?.code
        assert.match(String(frankBindCode || ''), /^\d{6}$/)
        const bindConfirm = await (await fetch(`${eBase}/api/account/email/bind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode }),
        })).json()
        assert.equal(bindConfirm.ok, true)
        assert.equal(bindConfirm.user.emailVerified, true)

        // Password reset: unbound email sends 0 SMTP; bound email resets & revokes old JWT
        const beforeResetCount = smtp.inbox.length
        const unknownReset = await (await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'reset', email: 'nobody@example.com' }),
        })).json()
        assert.equal(unknownReset.ok, true)
        assert.equal(smtp.inbox.length, beforeResetCount)

        await new Promise((r) => setTimeout(r, 350))
        const resetSend = await (await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'reset', email: 'dave@example.com' }),
        })).json()
        assert.equal(resetSend.ok, true)
        const resetCode = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<dave@example.com>' && m.code)?.code
        assert.match(String(resetCode || ''), /^\d{6}$/)
        const resetRes = await (await fetch(`${eBase}/api/account/password/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'dave@example.com', code: resetCode, newPassword: 'DaveNewPassword99!' }),
        })).json()
        assert.equal(resetRes.username, 'dave')
        assert.equal((await fetch(`${eBase}/api/auth/me`, { headers: { Authorization: `Bearer ${daveLogin.token}` } })).status, 401)
        assert.equal(
          (await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
            body: JSON.stringify({ username: 'dave', password: 'DavePassword123!' }),
          })).status,
          401,
        )

        // Optional Email Login 2FA
        const daveNewLogin = await (await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!' }),
        })).json()
        const en2fa = await (await fetch(`${eBase}/api/account/security/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daveNewLogin.token}` },
          body: JSON.stringify({ enabled: true }),
        })).json()
        assert.equal(en2fa.user.loginEmail2fa, true)

        await new Promise((r) => setTimeout(r, 350))
        const step1 = await (await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!' }),
        })).json()
        assert.equal(step1.ok, false)
        assert.equal(step1.requires2fa, true)
        assert.ok(step1.maskedEmail.includes('@example.com'))
        const otp2fa = [...smtp.inbox].reverse().find((m) => m.rcptTo === '<dave@example.com>' && m.code)?.code
        assert.match(String(otp2fa || ''), /^\d{6}$/)
        assert.equal(
          (await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
            body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!', emailCode: '000000' }),
          })).status,
          401,
        )
        const ok2fa = await (await fetch(`${eBase}/api/account/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({ username: 'dave', password: 'DaveNewPassword99!', emailCode: otp2fa }),
        })).json()
        assert.equal(ok2fa.ok, true)

        // Distributed multi-IP per-account brute-force lockout (10 bad IPs -> 11th blocked with 429)
        for (let i = 1; i <= 10; i += 1) {
          const r = await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${10 + i}` },
            body: JSON.stringify({ username: 'frank', password: `WrongPass-${i}!` }),
          })
          assert.equal(r.status, 401)
        }
        assert.equal(
          (await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.250' },
            body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
          })).status,
          429,
        )

        // /ws/bridge auth failure rate-limiting isolated per (ip, roomId)
        let bridge429 = false
        for (let i = 0; i < 16; i += 1) {
          const status = await new Promise((resolveStatus) => {
            const ws = new WebSocket(`ws://127.0.0.1:${ePort}/ws/bridge?roomId=usr_bogus00000000&bridgeId=stale-pc`, {
              headers: { 'X-Real-IP': '198.51.100.222', 'X-Room-Id': 'usr_bogus00000000', 'X-Bridge-Secret': 'wrong' },
            })
            ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
            ws.on('open', () => { ws.close(); resolveStatus(101) })
            ws.on('error', () => {})
          })
          if (status === 429) { bridge429 = true; break }
        }
        assert.equal(bridge429, true)

        const validDev = await (await fetch(`${eBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${evaReg.token}` },
          body: JSON.stringify({ label: 'Nat-Safe-PC', hostname: 'Nat-Safe-PC', platform: 'win32' }),
        })).json()
        const sameIpValidStatus = await new Promise((resolveStatus) => {
          const ws = new WebSocket(`ws://127.0.0.1:${ePort}/ws/bridge?roomId=${validDev.roomId}&bridgeId=${validDev.bridgeId}`, {
            headers: { 'X-Real-IP': '198.51.100.222', 'X-Room-Id': validDev.roomId, 'X-Bridge-Secret': validDev.deviceSecret },
          })
          ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
          ws.on('open', () => { ws.close(); resolveStatus(101) })
          ws.on('error', () => {})
        })
        assert.equal(sameIpValidStatus, 101, 'Bogus room 429 must never block a valid usr_* bridge on same IP')
      } finally {
        await emailRelay.close()
        await smtp.close()
      }
    }
    pass(7, 'Zero-dep SMTP mailer, email bind/reset, new-IP alert, login 2FA, CSP & distributed rate limits')

    // =========================================================================
    // 8. Admin Monitoring Dashboard (`/admin`, `/api/admin/overview`, Disconnect & Force Sign-Out)
    // =========================================================================
    {
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

        const admReg = await (await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'mon_admin', password: 'Password123!', inviteCode: 'mon-owner-secret' }),
        })).json()
        const invRes = await (await fetch(`${mBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ count: 2, note: 'monitor' }),
        })).json()
        const bobReg = await (await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'mon_bob', password: 'Password123!', inviteCode: invRes.invites[0].code }),
        })).json()
        await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'mon_carol', password: 'Password123!', inviteCode: invRes.invites[1].code }),
        })
        assert.equal((await fetch(`${mBase}/api/admin/overview`, { headers: { Authorization: `Bearer ${bobReg.token}` } })).status, 403)

        const bobPc = await (await fetch(`${mBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobReg.token}` },
          body: JSON.stringify({ label: 'Bob-MacBook', hostname: 'bob-mbp', platform: 'darwin' }),
        })).json()
        const admPc = await (await fetch(`${mBase}/api/account/devices/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ label: 'Admin-WinPC', hostname: 'admin-pc', platform: 'win32' }),
        })).json()

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

        const ovRaw = await (await fetch(`${mBase}/api/admin/overview`, {
          headers: { Authorization: `Bearer ${admReg.token}` },
        })).text()
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
        assert.equal(ov.distributions.apps.codex.writable, 1)
        assert.equal(ov.distributions.apps.antigravity.writable, 1)
        assert.equal(ov.distributions.bridgePlatforms.darwin, 1)
        assert.equal(ov.distributions.bridgePlatforms.win32, 1)
        assert.ok(ov.server.node.rssBytes > 0 && ov.server.host.totalMemBytes > 0 && ov.activity.length >= 4)

        // Prevent self-lockout, disconnect Bob's bridge (4000) & force sign-out Bob (4401)
        assert.equal(
          (await fetch(`${mBase}/api/admin/users/revoke-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
            body: JSON.stringify({ userId: admReg.roomId }),
          })).status,
          400,
        )
        await fetch(`${mBase}/api/admin/bridges/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ roomId: bobReg.roomId, bridgeId: bobPc.bridgeId }),
        })
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(bobBr.getClosedCode(), 4000)

        const kickBob = await (await fetch(`${mBase}/api/admin/users/revoke-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admReg.token}` },
          body: JSON.stringify({ userId: bobReg.roomId }),
        })).json()
        assert.equal(kickBob.disconnectedClients, 1)
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(bobCli.getClosedCode(), 4401)
        assert.equal((await fetch(`${mBase}/api/auth/me`, { headers: { Authorization: `Bearer ${bobReg.token}` } })).status, 401)
      } finally {
        for (const fn of mClosers) { try { await fn() } catch {} }
        await monRelay.close()
      }
    }
    pass(8, 'Admin monitoring dashboard (/admin, /api/admin/overview, disconnect & force sign-out)')

    // =========================================================================
    // 9. Built-in RFC 5389 STUN, Coturn 4-Tier Metering/Quotas & Tiered Cloudflare Realtime TURN
    // =========================================================================
    {
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
            udp.once('message', (msg) => { clearTimeout(t); resolve(msg) })
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

        const sAdmin = await (await fetch(`${sBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'stun_admin', password: 'StunPassword123!', inviteCode: 'STUN-BOOT-1' }),
        })).json()
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
      const unitCreds = buildTurnCredentials({ secret: 'super-secret-turn-key-123456', userId: 'usr_abc123', ttlSec: 3600, nowSec: fixedNow })
      assert.equal(unitCreds.username, `${fixedNow + 3600}:usr_abc123`)
      assert.equal(unitCreds.credential, createHmac('sha1', 'super-secret-turn-key-123456').update(unitCreds.username).digest('base64'))

      assert.deepEqual(
        parseCoturnUsageLine('4: : session 001000000000000002: usage: realm=<allinone>, username=<1795581100:usr_meter1>, rp=21, rb=2606, sp=19, sb=2528'),
        { userId: 'usr_meter1', rb: 2606, sb: 2528, billedBytes: 2567 },
      )
      assert.equal(parseCoturnUsageLine('4: : session 001: peer usage: realm=<allinone>, username=<1795581100:usr_meter1>, rp=1, rb=999, sp=1, sb=999'), null)
      assert.equal(parseCoturnUsageLine('4: : session 001: usage: realm=<allinone>, username=<1795581100:live_e2e_probe>, rp=1, rb=999, sp=1, sb=999'), null)

      const defaultCfg = resolveTurnQuotaConfig({}, {})
      assert.equal(defaultCfg.freeMb, 1024)
      assert.equal(defaultCfg.proMb, 10240)
      assert.equal(defaultCfg.ultraMb, 51200)
      assert.equal(getTurnQuotaBytesForTier('admin', defaultCfg), getTurnQuotaBytesForTier('ultra', defaultCfg))
      const unlimSnap = buildTurnQuotaSnapshot({ tier: 'ultra', month: '2026-11', usedBytes: 999_999_999, config: resolveTurnQuotaConfig({ turnQuotaUltraMb: 0 }, {}) })
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
        const qAdmin = await (await fetch(`${qBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'quota_admin', password: 'QuotaPassword123!', inviteCode: 'QUOTA-BOOT-1' }),
        })).json()
        assert.equal(
          (await fetch(`${qBase}/api/admin/invites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
            body: JSON.stringify({ count: 1, tier: 'enterprise' }),
          })).status,
          400,
        )
        const invFree = await (await fetch(`${qBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
          body: JSON.stringify({ count: 1, tier: 'free' }),
        })).json()
        const qFree = await (await fetch(`${qBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'quota_free', password: 'QuotaPassword123!', inviteCode: invFree.invites[0].code }),
        })).json()

        // Non-admin blocked from tier/reset routes
        assert.equal(
          (await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qFree.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'ultra' }),
          })).status,
          403,
        )
        assert.equal(
          (await fetch(`${qBase}/api/admin/users/reset-turn-usage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qFree.token}` },
            body: JSON.stringify({ userId: qFree.roomId }),
          })).status,
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
          const ultraRes = await (await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'ultra' }),
          })).json()
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
        res.end(JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: `cf_u_${cfHits}`, credential: `cf_c_${cfHits}` },
          ],
        }))
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
        const cfAdmin = await (await fetch(`${cfBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cf_admin', password: 'CfPassword123!', inviteCode: 'CF-BOOT-1' }),
        })).json()
        const invCf = await (await fetch(`${cfBase}/api/admin/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfAdmin.token}` },
          body: JSON.stringify({ count: 1, tier: 'free' }),
        })).json()
        const cfFree = await (await fetch(`${cfBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cf_free', password: 'CfPassword123!', inviteCode: invCf.invites[0].code }),
        })).json()

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
          const fbAdmin = await (await fetch(`${fbBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fb_admin', password: 'FbPassword123!', inviteCode: 'CFB-BOOT-1' }),
          })).json()
          const fbInv = await (await fetch(`${fbBase}/api/admin/invites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fbAdmin.token}` },
            body: JSON.stringify({ count: 1, tier: 'free' }),
          })).json()
          const fbFree = await (await fetch(`${fbBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fb_free', password: 'FbPassword123!', inviteCode: fbInv.invites[0].code }),
          })).json()
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
    }
    pass(9, 'Built-in RFC 5389 STUN, Coturn 4-tier TURN metering/quotas & tiered Cloudflare TURN fallback')

    // =========================================================================
    // 10. Desktop App Security (`safeStorage`), Auto-Updater & Electron WebRTC Proxy
    // =========================================================================
    {
      // 10a. safeStorage encrypted config, locked-keychain decrypt-error & DesktopBridgeManager.setE2eeKey
      const secretStore = createMockSecretStore()
      const lockedStore = {
        isAvailable: () => true,
        encrypt: () => { throw new Error('Keychain locked') },
        decrypt: () => { throw new Error('Keychain locked') },
      }
      const deskDir = join(tmpDir, 'desktop-sec')
      mkdirSync(deskDir, { recursive: true })
      const cfgPath = join(deskDir, 'config.json')
      const k1 = generateE2eeKey()
      const k2 = generateE2eeKey()
      saveConfigSecure(cfgPath, { mode: 'account', roomId: 'usr_desk', bridgeId: 'pc-1', bridgeSecret: 'dv_secret', serverUrl: httpBase, e2eeKey: k1, autoStartDisabled: true }, secretStore)
      const rawDisk = readFileSync(cfgPath, 'utf8')
      assert.equal(rawDisk.includes('dv_secret'), false)
      assert.equal(rawDisk.includes(k1), false)
      const decCfg = loadConfigDecrypted(cfgPath, secretStore)
      assert.equal(decCfg.bridgeSecret, 'dv_secret')
      assert.equal(decCfg.e2eeKey, k1)
      assert.equal(loadConfigWithStatus(cfgPath, lockedStore).status, 'decrypt-error')

      const dm = new DesktopBridgeManager({ secretStore })
      dm.stateDir = deskDir
      dm.configPath = cfgPath
      dm.logPath = join(deskDir, 'desktop-bridge.log')
      dm.enabled = true
      dm.spawnBridgeProcess = async () => {}
      await assert.rejects(() => dm.setE2eeKey('usr_desk', `${k2}=GARBAGE`), /无效的端到端密钥格式/)
      await dm.setE2eeKey('usr_desk', k2)
      const afterKeyCfg = loadConfigDecrypted(cfgPath, secretStore)
      assert.equal(afterKeyCfg.e2eeKey, k2)
      assert.equal(afterKeyCfg.autoStartDisabled, undefined)

      // 10b. DesktopUpdater (semver, platform/arch asset guard, Windows WScript/PS1, SHA-256, cache reuse & TOCTOU)
      assert.equal(compareSemver('1.0.8', '1.0.7'), 1)
      assert.equal(compareSemver('v1.10.0', '1.9.9'), 1)
      assert.equal(compareSemver('1.0.8', 'v1.0.8'), 0)
      assert.equal(compareSemver('1.0.8', '1.0.8-beta.1'), 1)
      assert.equal(compareSemver('1.0.7', '1.0.8'), -1)

      const sampleAssets = [
        { name: 'All.in.One-1.0.8-arm64.dmg', browser_download_url: 'https://github.com/a/b/All.in.One-1.0.8-arm64.dmg' },
        { name: 'All.in.One.Setup.1.0.8.exe', browser_download_url: 'https://github.com/a/b/All.in.One.Setup.1.0.8.exe' },
      ]
      assert.equal(pickReleaseAsset(sampleAssets, 'win32', 'x64')?.name, 'All.in.One.Setup.1.0.8.exe')
      assert.equal(pickReleaseAsset(sampleAssets, 'darwin', 'arm64')?.name, 'All.in.One-1.0.8-arm64.dmg')
      assert.equal(pickReleaseAsset(sampleAssets, 'darwin', 'x64'), null, 'Intel Mac x64 must never pick arm64 DMG')

      const winScripts = buildWindowsUpdateScripts({
        installerPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\All.in.One.Setup.1.0.8.exe',
        exePath: 'C:\\Users\\张三\\AppData\\Local\\Programs\\all-in-one\\All in One.exe',
        pid: 12345,
        isPackaged: true,
        logPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\last-update.log',
        ps1Path: 'C:\\Users\\张三\\AppData\\Local\\Temp\\apply-update.ps1',
      })
      assert.ok(winScripts.vbsScript.includes('sh.Run cmd, 0, True'))
      assert.ok(winScripts.psScript.includes('Get-Process -Id $oldPid') && winScripts.psScript.includes('ArgumentList "/S"'))
      assert.equal(winScripts.psScript.includes('tasklist'), false)

      const fakePayload = Buffer.alloc(64 * 1024, 0x5a)
      const validSha = createHash('sha256').update(fakePayload).digest('hex')
      let downloadHits = 0
      const mockReleaseServer = http.createServer((req, res) => {
        const base = `http://127.0.0.1:${mockReleaseServer.address().port}`
        if (req.url === '/releases/latest') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v1.0.9',
            assets: [{ name: 'All.in.One.Setup.1.0.9.exe', size: fakePayload.length, digest: `sha256:${validSha}`, browser_download_url: `${base}/bin` }],
          }))
          return
        }
        if (req.url === '/releases/corrupt') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v1.0.10',
            assets: [{ name: 'All.in.One.Setup.1.0.10.exe', size: fakePayload.length, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: `${base}/bin` }],
          }))
          return
        }
        if (req.url === '/releases/no-digest') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            tag_name: 'v1.0.11',
            assets: [{ name: 'All.in.One.Setup.1.0.11.exe', size: fakePayload.length, browser_download_url: `${base}/bin` }],
          }))
          return
        }
        if (req.url === '/bin') {
          downloadHits += 1
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fakePayload.length) })
          res.end(fakePayload)
          return
        }
        res.writeHead(404)
        res.end('not found')
      })
      await new Promise((r) => mockReleaseServer.listen(0, '127.0.0.1', r))
      const updPort = mockReleaseServer.address().port
      const updDir = join(tmpDir, 'updater-cache')
      try {
        const upd = new DesktopUpdater({ currentVersion: '1.0.8', platform: 'win32', arch: 'x64', downloadDir: updDir, apiUrl: `http://127.0.0.1:${updPort}/releases/latest`, allowLocalhost: true })
        assert.equal((await upd.checkForUpdates()).status, 'available')
        const dl = await upd.downloadUpdate()
        assert.equal(dl.status, 'downloaded')
        assert.equal(Buffer.compare(readFileSync(dl.downloadedPath), fakePayload), 0)
        assert.equal(downloadHits, 1)

        // Cached installer reuse
        const updReuse = new DesktopUpdater({ currentVersion: '1.0.8', platform: 'win32', arch: 'x64', downloadDir: updDir, apiUrl: `http://127.0.0.1:${updPort}/releases/latest`, allowLocalhost: true })
        assert.equal((await updReuse.checkForUpdates()).status, 'downloaded')
        assert.equal(downloadHits, 1)

        // Pre-install TOCTOU 1-byte tamper must fail & delete file
        const tampered = Buffer.from(fakePayload)
        tampered[0] ^= 0xff
        writeFileSync(dl.downloadedPath, tampered)
        const instRes = await upd.installAndRestart({ exePath: 'C:\\fake\\All in One.exe', isPackaged: true, onQuit: () => {} })
        assert.equal(instRes.status, 'error')
        assert.match(instRes.error, /SHA-256/)
        assert.equal(existsSync(dl.downloadedPath), false)

        // Corrupt SHA-256 & missing SHA-256 both blocked
        const corruptUpd = new DesktopUpdater({ currentVersion: '1.0.8', platform: 'win32', arch: 'x64', downloadDir: updDir, apiUrl: `http://127.0.0.1:${updPort}/releases/corrupt`, allowLocalhost: true })
        await corruptUpd.checkForUpdates()
        assert.equal((await corruptUpd.downloadUpdate()).status, 'error')
        assert.equal(existsSync(join(updDir, 'All.in.One.Setup.1.0.10.exe')), false)

        const noDigestUpd = new DesktopUpdater({ currentVersion: '1.0.8', platform: 'win32', arch: 'x64', downloadDir: updDir, apiUrl: `http://127.0.0.1:${updPort}/releases/no-digest`, allowLocalhost: true })
        await noDigestUpd.checkForUpdates()
        assert.equal((await noDigestUpd.downloadUpdate()).status, 'error')

        // Already up-to-date & untrusted host block
        const upToDate = new DesktopUpdater({ currentVersion: '1.0.9', platform: 'win32', arch: 'x64', downloadDir: updDir, apiUrl: `http://127.0.0.1:${updPort}/releases/latest`, allowLocalhost: true })
        assert.equal((await upToDate.checkForUpdates()).status, 'up-to-date')

        const strictUpd = new DesktopUpdater({ currentVersion: '1.0.8', platform: 'win32', downloadDir: updDir, allowLocalhost: false })
        strictUpd.setState({ status: 'available', assetName: 'evil.exe', downloadUrl: 'https://evil.example.com/evil.exe' })
        const blocked = await strictUpd.downloadUpdate()
        assert.equal(blocked.status, 'error')
        assert.match(blocked.error, /不受信任/)
      } finally {
        try { mockReleaseServer.closeAllConnections?.() } catch {}
        await new Promise((r) => mockReleaseServer.close(r))
      }

      // 10c. DesktopWebRtcProxy + ElectronWebRtcClient cold-start concurrency, FIFO framing & worker recovery
      const ipcMain = new EventEmitter()
      const receivedCmds = []
      const receivedBins = []
      let failFirstLoad = true
      let createdWinCount = 0
      class FakeBrowserWindow extends EventEmitter {
        constructor() {
          super()
          createdWinCount += 1
          this._destroyed = false
          const win = this
          this.webContents = Object.assign(new EventEmitter(), {
            send(channel, payload) {
              if (channel === 'webrtc-worker:cmd') {
                receivedCmds.push(payload)
                if (payload.type === 'peer.offer') {
                  setTimeout(() => {
                    ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'res', reqId: payload.reqId, ok: true, answer: { type: 'answer', sdp: 'v=0\r\nmock-answer\r\n' } })
                    ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'dc.open', peerId: payload.peerId, role: 'ctrl' })
                    ipcMain.emit('webrtc-worker:control', { sender: win.webContents }, { type: 'dc.open', peerId: payload.peerId, role: 'bulk' })
                  }, 15)
                }
              } else if (channel === 'webrtc-worker:send-binary') {
                receivedBins.push(payload)
              }
            },
          })
        }
        isDestroyed() { return this._destroyed }
        destroy() { if (!this._destroyed) { this._destroyed = true; this.emit('closed') } }
        async loadFile() {
          if (failFirstLoad) { failFirstLoad = false; throw new Error('simulated worker load error') }
          setTimeout(() => { if (!this._destroyed) ipcMain.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'worker.ready' }) }, 25)
        }
      }

      const proxy = new DesktopWebRtcProxy({
        BrowserWindow: FakeBrowserWindow,
        ipcMain,
        srcDir: join(process.cwd(), 'packages/desktop-app/src'),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      const { port: pxPort, token: pxToken } = await proxy.start()
      let acceptedSockets = 0
      proxy.server.on('connection', () => { acceptedSockets += 1 })
      try {
        const eClient = new ElectronWebRtcClient({ port: pxPort, token: pxToken, log: { info: () => {}, warn: () => {}, error: () => {} } })
        const badPeer = eClient.createPeer({ iceServers: [] })
        await assert.rejects(() => badPeer.handleOffer('v=0\r\n'), /simulated worker load error/)
        await badPeer.close()
        eClient.dispose()

        const coldClient = new ElectronWebRtcClient({ port: pxPort, token: pxToken, log: { info: () => {}, warn: () => {}, error: () => {} } })
        const socketsBefore = acceptedSockets
        try {
          let ctrlOpened = false
          let bulkOpened = false
          const peer = coldClient.createPeer({ iceServers: [], onCtrlOpen: () => { ctrlOpened = true }, onBulkOpen: () => { bulkOpened = true } })
          const offerP = peer.handleOffer('v=0\r\nconcurrent-offer\r\n')
          const icePs = Array.from({ length: 10 }, (_, idx) => peer.addIceCandidate({ candidate: `candidate:${idx} 1 udp 1 127.0.0.1 ${50000 + idx} typ host` }))
          assert.equal((await offerP).type, 'answer')
          await Promise.all(icePs)
          assert.equal(acceptedSockets - socketsBefore, 1, 'Cold concurrent offer + 10 ICE must share 1 loopback socket')
          for (let i = 0; i < 30 && (!ctrlOpened || !bulkOpened); i += 1) await new Promise((r) => setTimeout(r, 10))
          assert.equal(peer.isCtrlOpen() && peer.isBulkOpen(), true)
          const offerIdx = receivedCmds.findIndex((c) => c.type === 'peer.offer' && c.sdp?.includes('concurrent-offer'))
          const firstIceIdx = receivedCmds.findIndex((c) => c.type === 'peer.ice')
          assert.ok(offerIdx >= 0 && firstIceIdx > offerIdx, 'peer.offer must arrive strictly before peer.ice')
          await peer.sendBulk(new Uint8Array([1, 2, 3, 4]))
          for (let i = 0; i < 30 && receivedBins.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
          assert.deepEqual(Buffer.from(receivedBins[0].bytes), Buffer.from([1, 2, 3, 4]))
          await peer.close()
        } finally {
          coldClient.dispose()
        }
        assert.ok(createdWinCount >= 2)
      } finally {
        await proxy.dispose()
      }
    }
    pass(10, 'Desktop security (safeStorage), Auto-Updater (SHA-256/TOCTOU/x64 guard) & Electron WebRTC Proxy')

    // =========================================================================
    // 11. Frontend Static Guards (React Hooks), Bilingual i18n, Multi-Device Store, Scoped Cache & Drafts
    // =========================================================================
    {
      // 11a. React Rules-of-Hooks static scan across all JSX components
      const scanJsx = (dir) => {
        const out = []
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name)
          if (ent.isDirectory()) out.push(...scanJsx(p))
          else if (ent.name.endsWith('.jsx')) out.push(p)
        }
        return out
      }
      const violations = []
      for (const f of scanJsx(join(process.cwd(), 'packages/mobile-app/src'))) {
        const lines = readFileSync(f, 'utf8').split(/\r?\n/)
        let curComp = ''
        let compDepth = -1
        let earlyReturnLine = -1
        let depth = 0
        for (let i = 0; i < lines.length; i += 1) {
          const clean = lines[i].replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`|\/\/.*$/g, '')
          if (!curComp) {
            const m = clean.match(/^(?:export\s+)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=\s*(?:React\.)?memo\s*\(\s*function\s*\w*)/)
            if (m) { curComp = m[1] || m[2]; compDepth = depth; earlyReturnLine = -1 }
          }
          if (curComp && depth === compDepth + 1) {
            if (/^\s*if\s*\(/.test(clean) && (/\breturn\b/.test(clean) || (lines[i + 1] && /^\s+return\b/.test(lines[i + 1])))) {
              if (earlyReturnLine === -1) earlyReturnLine = i + 1
            }
            if (earlyReturnLine !== -1 && /\buse(State|Effect|Memo|Callback|Ref|LayoutEffect|Context|Reducer)\s*\(/.test(clean)) {
              violations.push(`${f}:${i + 1} (${curComp}) hook after early return at L${earlyReturnLine}`)
            }
          }
          for (const ch of clean) {
            if (ch === '{') depth += 1
            else if (ch === '}') {
              depth -= 1
              if (curComp && depth === compDepth) { curComp = ''; compDepth = -1; earlyReturnLine = -1 }
            }
          }
        }
      }
      assert.deepEqual(violations, [], `React hook violations:\n${violations.join('\n')}`)

      // 11b. Bilingual i18n dictionary parity & formatting
      assert.equal(normalizeLang('zh-CN'), 'zh')
      assert.equal(normalizeLang('en-US'), 'en')
      assert.equal(normalizeLang('fr-FR'), null)
      const langMem = new Map()
      const langStorage = { getItem: (k) => (langMem.has(k) ? langMem.get(k) : null), setItem: (k, v) => langMem.set(k, String(v)) }
      assert.equal(detectInitialLang(langStorage, { language: 'en-US' }), 'en')
      assert.equal(detectInitialLang(langStorage, { language: 'zh-Hans-CN' }), 'zh')
      saveLang('en', langStorage)
      assert.equal(langStorage.getItem(LANG_STORAGE_KEY), 'en')
      assert.equal(loadSavedLang(langStorage), 'en')
      assert.equal(detectInitialLang(langStorage, { language: 'zh-CN' }), 'en')
      assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort(), 'zh/en i18n keys must match exactly')
      assert.equal(translate('zh', 'time.minsAgo', { n: 5 }), '5 分钟前')
      assert.equal(translate('en', 'time.minsAgo', { n: 5 }), '5m ago')
      assert.equal(bi('en', '设置', 'Settings'), 'Settings')
      assert.equal(getDeviceDisplayName(null, null, 'en'), 'No Computer')
      assert.equal(formatBytesCompact(1024 * 1024 * 1024), '1 GB')
      saveLang('zh', langStorage)

      // 11c. Multi-device store (coexistence, loginEmail2fa update, persistence, 16-key LRU keyring)
      const storeMem = new Map()
      const fakeStorage = { getItem: (k) => (storeMem.has(k) ? storeMem.get(k) : null), setItem: (k, v) => storeMem.set(k, String(v)), removeItem: (k) => storeMem.delete(k) }
      let dState = loadDeviceState(fakeStorage)
      const rA = upsertDevice(dState, { baseUrl: httpBase, token: 'tok-a', roomId: friendA.roomId, username: 'friend_a', loginEmail2fa: false, bridges: [{ hostname: 'mac-a', online: true }] })
      dState = rA.state
      const rB = upsertDevice(dState, { baseUrl: httpBase, token: 'tok-b', roomId: friendB.roomId, username: 'friend_b', label: 'Win-B', bridges: [] })
      dState = rB.state
      assert.equal(dState.devices.length, 2)
      assert.equal(getActiveDevice(dState).id, rB.device.id)
      const refreshedA = upsertDevice(dState, { baseUrl: httpBase, token: 'tok-a2', roomId: friendA.roomId, username: 'friend_a', loginEmail2fa: true })
      assert.equal(refreshedA.isNew, false)
      assert.equal(refreshedA.device.loginEmail2fa, true)
      dState = selectDevice(refreshedA.state, rB.device.id)
      saveDeviceState(dState, fakeStorage)
      assert.equal(loadDeviceState(fakeStorage).activeDeviceId, rB.device.id)

      const addedKids = []
      for (let i = 0; i < 18; i += 1) {
        const k = generateE2eeKey()
        const kid = await computeE2eeKeyId(k)
        addedKids.push(kid)
        dState = upsertDeviceE2eeKey(dState, rA.device.id, kid, k)
      }
      const lruKeys = Object.keys(dState.devices.find((d) => d.id === rA.device.id).e2eeKeys)
      assert.equal(lruKeys.length, 16)
      assert.ok(lruKeys.includes(addedKids[17]) && !lruKeys.includes(addedKids[0]))

      // 11d. Scoped sessionCache isolation, Codex >120 cursor safety & optimistic bubble reconciliation
      await clearSessionCache()
      const scopeA = getCacheScopeKey(dState.devices[0], 'pc-a')
      const scopeB = getCacheScopeKey(dState.devices[1], 'pc-b')
      await saveCachedSession('codex:shared', { messages: [{ id: 'm1', role: 'user', text: 'Mac' }] }, scopeA)
      await saveCachedSession('codex:shared', { messages: [{ id: 'm1', role: 'user', text: 'Win' }] }, scopeB)
      assert.equal((await loadCachedSession('codex:shared', scopeA)).messages[0].text, 'Mac')
      assert.equal((await getSessionCacheStats(scopeA)).sessionCount, 1)
      await clearSessionCache(dState.devices[0].id, { prefix: true })
      assert.equal(await loadCachedSession('codex:shared', scopeA), null)
      assert.equal((await loadCachedSession('codex:shared', scopeB)).messages[0].text, 'Win')

      await saveCachedSession('codex:unbridged', { meta: { app: 'codex' }, messages: [{ id: 'm1', role: 'user', text: 'a', ts: 1 }] }, 'acct25')
      await saveCachedSession('codex:bridged', { meta: { app: 'codex' }, messages: [{ id: 'm2', role: 'user', text: 'b', ts: 2 }] }, 'acct25::pc-1')
      await clearSessionCache('acct25', { prefix: false })
      assert.equal(await loadCachedSession('codex:unbridged', 'acct25'), null)
      assert.ok(await loadCachedSession('codex:bridged', 'acct25::pc-1'))

      const manyCodex = Array.from({ length: 130 }, (_, idx) => ({ id: `c-${idx}`, role: idx % 2 ? 'assistant' : 'user', text: `m${idx}`, ts: idx + 1 }))
      await saveCachedSession('codex:big', { meta: { app: 'codex', id: 'codex:big' }, messages: manyCodex, hasMore: false, nextCursor: null }, 'scope-big')
      const cachedBig = await loadCachedSession('codex:big', 'scope-big')
      assert.equal(cachedBig.messages.length, 120)
      assert.equal(cachedBig.nextCursor, null)

      const reconciled = reconcileCachedWithFreshPage(
        {
          messages: [
            { id: 'agy-u-1', role: 'user', text: 'Q1', ts: 1 },
            { id: 'agy-a-2', role: 'assistant', text: 'A1', ts: 2 },
            { id: 'msg-u-99', role: 'user', text: 'Q2', ts: 3 },
            { id: 'msg-a-99', role: 'assistant', text: 'A2', ts: 4 },
          ],
          hasMore: true,
          nextCursor: '1',
          totalCount: 10,
        },
        {
          messages: [
            { id: 'agy-a-2', role: 'assistant', text: 'A1', ts: 2 },
            { id: 'agy-u-3', role: 'user', text: 'Q2', ts: 3 },
            { id: 'agy-a-4', role: 'assistant', text: 'A2', ts: 4 },
          ],
          hasMore: true,
          nextCursor: '2',
          totalCount: 12,
        },
      )
      assert.equal(reconciled.messages.length, 4)
      assert.equal(reconciled.messages[3].id, 'agy-a-4')
      await clearSessionCache()

      dState = removeDevice(dState, rB.device.id)
      assert.equal(dState.devices.length, 1)
      assert.equal(dState.activeDeviceId, rA.device.id)

      // 11e. Per-conversation draft store & image URL policy
      const dkA = makeDraftKey('dev1::pc1', 'codex:a', 'codex')
      const dkB = makeDraftKey('dev1::pc1', 'antigravity:b', 'antigravity')
      saveDraft(dkA, { text: 'Draft A', attachments: [null, { id: 'a1', filename: 'p.png', localPreviewUrl: 'blob:https://x/1' }] })
      saveDraft(dkB, { text: 'Draft B', attachments: [] })
      const loadedA = loadDraft(dkA)
      assert.equal(loadedA.text, 'Draft A')
      assert.equal(loadedA.attachments.length, 1)
      assert.equal(loadedA.attachments[0].localPreviewUrl, undefined)
      clearDraft(dkA)
      assert.equal(loadDraft(dkB).text, 'Draft B')
      saveLastSessionId('dev1::pc1', 'codex:a')
      saveLastWorkspace('dev1::pc1', '/Users/demo/AllinOne')
      assert.equal(loadLastSessionId('dev1::pc1'), 'codex:a')
      assert.equal(loadLastWorkspace('dev1::pc1'), '/Users/demo/AllinOne')
      clearDraftsForScope('dev1')
      assert.equal(loadDraft(dkB).text, '')
      assert.equal(loadLastSessionId('dev1::pc1'), '')
      assert.equal(resolveImageSrc('https://example.com/demo.png'), 'https://example.com/demo.png')
      assert.equal(resolveImageSrc('/tmp/shot.png'), '')
    }
    pass(11, 'Frontend guards (React Hooks, i18n parity, deviceStore LRU, scoped sessionCache & drafts)')

    // =========================================================================
    // 12. Deliverable Documents E2EE Download, Security Guards & Sandbox HTML Preview
    // =========================================================================
    {
      const docDir = join(tmpDir, 'deliverables-workspace')
      mkdirSync(docDir, { recursive: true })
      const htmlPath = join(docDir, 'dashboard.html')
      const docxPath = join(docDir, 'weekly-report.docx')
      const xlsxPath = join(docDir, 'budget.xlsx')
      const pptxPath = join(docDir, 'q4-deck.pptx')
      const pdfPath = join(docDir, 'contract.pdf')
      writeFileSync(htmlPath, '<!doctype html><html><body><h1>Q4 KPI</h1></body></html>', 'utf8')
      writeFileSync(docxPath, Buffer.from('PK\x03\x04mock-docx-bytes'))
      writeFileSync(xlsxPath, Buffer.from('PK\x03\x04mock-xlsx-bytes'))
      writeFileSync(pptxPath, Buffer.from('PK\x03\x04mock-pptx-bytes'))
      writeFileSync(pdfPath, Buffer.from('%PDF-1.7 mock-pdf'))

      const docOrch = new MultiAppOrchestrator({ config: { cwd: docDir }, log: { info() {}, warn() {}, error() {} } })
      try {
        const htmlRes = await docOrch.readLocalFile({ path: 'dashboard.html', cwd: docDir, mode: 'document' })
        assert.equal(htmlRes.mimeType, 'text/html; charset=utf-8')
        assert.ok(Buffer.from(htmlRes.dataBase64, 'base64').toString('utf8').includes('Q4 KPI'))
        assert.equal((await docOrch.readLocalFile({ path: `file://${xlsxPath}`, cwd: docDir, mode: 'document' })).mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        assert.equal((await docOrch.readLocalFile({ path: docxPath, cwd: docDir, mode: 'document' })).mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        assert.equal((await docOrch.readLocalFile({ path: pptxPath, cwd: docDir, mode: 'document' })).mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
        assert.equal((await docOrch.readLocalFile({ path: pdfPath, cwd: docDir, mode: 'document' })).mimeType, 'application/pdf')

        // Default image mode rejects documents; disallowed extensions, sensitive files & symlinks blocked
        await assert.rejects(() => docOrch.readLocalFile({ path: htmlPath, cwd: docDir }), /仅允许远程预览图片/)
        for (const [name, body] of [['script.js', '1'], ['accounts.json', '{}'], ['.env', 'K=V']]) {
          const fp = join(docDir, name)
          writeFileSync(fp, body)
          await assert.rejects(() => docOrch.readLocalFile({ path: fp, cwd: docDir, mode: 'document' }), /不支持远程下载该格式/)
        }
        const secretTxt = join(docDir, 'secrets.txt')
        writeFileSync(secretTxt, 'secret')
        await assert.rejects(() => docOrch.readLocalFile({ path: secretTxt, cwd: docDir, mode: 'document' }), /敏感目录或凭据文件/)
        mkdirSync(join(docDir, '.ssh'), { recursive: true })
        const sshTxt = join(docDir, '.ssh', 'notes.txt')
        writeFileSync(sshTxt, 'ssh')
        await assert.rejects(() => docOrch.readLocalFile({ path: sshTxt, cwd: docDir, mode: 'document' }), /敏感目录或凭据文件/)
        const keyTarget = join(docDir, 'private.key')
        writeFileSync(keyTarget, 'KEY')
        const fakePdfLink = join(docDir, 'fake-report.pdf')
        symlinkSync(keyTarget, fakePdfLink)
        await assert.rejects(() => docOrch.readLocalFile({ path: fakePdfLink, cwd: docDir, mode: 'document' }), /符号链接指向不允许的格式/)

        // Large deliverable (>10MB) switches cleanly to p2p-bulk
        const hugePpt = join(docDir, 'huge-deck.pptx')
        writeFileSync(hugePpt, Buffer.alloc(10 * 1024 * 1024 + 65536, 0x41))
        const hugeRes = await docOrch.readLocalFile({ path: hugePpt, cwd: docDir, mode: 'document' })
        assert.equal(hugeRes.transferMode, 'p2p-bulk')
        assert.ok(hugeRes._localRealPath)

        // Frontend deliverable extractor
        const extracted = extractDeliverableRefsFromMessage({
          role: 'assistant',
          text: '报告：[Q4汇报.pptx](file:///Users/demo/Desktop/Q4%E6%B1%87%E6%8A%A5.pptx) 与 `./reports/dashboard.html`，忽略 `README.md`、`node_modules/pkg/index.html` 与 https://example.com/public.pdf',
          tools: [{ name: 'write_file', status: 'done', input: { Path: '/Users/demo/Documents/budget-2026.xlsx' } }],
        })
        const names = extracted.map((x) => x.filename)
        assert.ok(names.includes('Q4汇报.pptx') && names.includes('dashboard.html') && names.includes('budget-2026.xlsx'))
        assert.equal(names.includes('README.md') || names.includes('index.html') || names.includes('public.pdf'), false)
        assert.equal(extracted.find((x) => x.filename === 'dashboard.html')?.previewable, true)

        // Sandboxed HTML preview host frame enforces opaque-origin sandbox CSP
        const sandboxRes = await fetch(`${httpBase}/sandbox-preview.html`)
        assert.equal(sandboxRes.status, 200)
        const sCsp = sandboxRes.headers.get('content-security-policy') || ''
        assert.ok(sCsp.includes('sandbox allow-scripts') && sCsp.includes("connect-src 'none'"))
        assert.equal(sCsp.includes('allow-same-origin'), false)
      } finally {
        await docOrch.dispose()
      }
    }
    pass(12, 'Deliverable documents E2EE download, security guards, extractor & sandbox-preview CSP')

    // =========================================================================
    // 13. DSH Cordis Plugin, Authenticated Local IPC, Auto-Installer, Two-Way Prompt Sync & CLI Auto-Fix Guard
    // =========================================================================
    {
      // 13a. DSH Cordis plugin registers all 6 Master Dispatch tools
      const registeredTools = []
      const effects = []
      applyDshPlugin(
        {
          agents: { get: () => undefined },
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          get: (name) => (name === 'tools' ? { register: (def) => { registeredTools.push(def.name); return () => {} } } : undefined),
          effect: (fn) => { const clean = fn(); if (typeof clean === 'function') effects.push(clean) },
        },
        { enableDispatchTools: true, enableLocalIpc: false },
      )
      assert.deepEqual(registeredTools.sort(), [
        'allinone_apps_status',
        'allinone_dispatch_task',
        'allinone_interrupt_session',
        'allinone_list_sessions',
        'allinone_read_session',
        'allinone_task_status',
      ])
      for (const fn of effects) await fn()

      // 13b. Authenticated loopback IPC bridge (401/403 security, RO<->RW discovery, SSE stream & system-msg filter)
      const ipcDshHome = join(tmpDir, 'dsh-ipc-home')
      mkdirSync(join(ipcDshHome, 'storages'), { recursive: true })
      const mockSessions = new Map()
      let seqCounter = 1
      const createMockAgent = (sid, cwd) => {
        const events = []
        let idleResolve = null
        let idlePromise = Promise.resolve()
        const session = { id: sid, meta: { cwd }, get seq() { return seqCounter }, ownEvents: () => events }
        const agent = {
          id: sid,
          session,
          followup: (userMsg) => {
            const promptText = userMsg?.content?.[0]?.text || ''
            events.push({ seq: ++seqCounter, type: 'user/message', data: { message: userMsg }, timestamp: Date.now() })
            events.push({ seq: ++seqCounter, type: 'user/message', data: { id: `sys-${seqCounter}`, role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }] }, timestamp: Date.now() })
            events.push({ seq: ++seqCounter, type: 'user/message', data: { id: `sys-${seqCounter}`, role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] }, timestamp: Date.now() })
            idlePromise = new Promise((r) => {
              idleResolve = r
              setTimeout(() => {
                events.push({
                  seq: ++seqCounter,
                  type: 'assistant/message',
                  data: { message: { id: `a-${seqCounter}`, content: [{ type: 'thinking', thinking: 'Checking IPC...' }, { type: 'text', text: `DSH IPC Reply to: ${promptText}` }] } },
                  timestamp: Date.now(),
                })
                r()
              }, 60)
            })
          },
          whenIdle: () => idlePromise,
          abort: async () => { idleResolve?.() },
        }
        mockSessions.set(sid, { agent, session, title: sid })
        return agent
      }
      const mockDshCtx = {
        agents: {
          get: (sid) => mockSessions.get(sid)?.agent,
          create: async ({ sessionId, meta }) => ({ agent: createMockAgent(sessionId, meta?.cwd || process.cwd()), dispose: async () => {} }),
        },
        get: (name) => {
          if (name === 'sessions') return { get: (sid) => mockSessions.get(sid)?.session, values: () => [...mockSessions.values()].map((x) => x.session) }
          if (name === 'sessionTitle') return { get: (s) => ({ title: mockSessions.get(s?.id)?.title || s?.id }), rename: (s, t) => { const row = mockSessions.get(s?.id); if (row) row.title = t } }
          return undefined
        },
      }
      let ipcSrv = null
      const liveDsh = new DshAdapter({ ctx: mockDshCtx, config: { dshHome: ipcDshHome, cwd: process.cwd() }, log: { info: () => {}, warn: () => {}, error: () => {} }, emitEvent: (ev, p) => ipcSrv?.emitEvent(ev, p) })
      const receivedEvents = []
      const standaloneDsh = new DshAdapter({ ctx: null, config: { dshHome: ipcDshHome, cwd: process.cwd() }, log: { info: () => {}, warn: () => {}, error: () => {} }, emitEvent: (ev, p) => receivedEvents.push({ ev, p }) })
      try {
        assert.equal((await standaloneDsh.getStatus()).mode, 'standalone-readonly')
        ipcSrv = await startDshLocalIpcServer({ dshAdapter: liveDsh, dshHome: ipcDshHome, log: { info: () => {}, warn: () => {}, error: () => {} } })
        assert.equal((await fetch(`http://127.0.0.1:${ipcSrv.port}/health`)).status, 401)
        assert.equal((await fetch(`http://127.0.0.1:${ipcSrv.port}/health`, { headers: { Authorization: `Bearer ${ipcSrv.token}`, Origin: 'https://evil.example' } })).status, 403)
        assert.equal((await standaloneDsh.getStatus()).mode, 'dsh-local-ipc')

        const created = await standaloneDsh.createSession({ cwd: process.cwd(), title: 'IPC Chat' })
        const reply = await standaloneDsh.sendMessage(created.nativeId, { text: 'Hello DSH!' })
        assert.ok(reply.finalText.includes('DSH IPC Reply to: Hello DSH!'))
        await new Promise((r) => setTimeout(r, 60))
        const evTypes = receivedEvents.map((e) => e.ev)
        assert.ok(evTypes.includes(EVENTS.STREAM_START) && evTypes.includes(EVENTS.STREAM_THINKING) && evTypes.includes(EVENTS.STREAM_DELTA) && evTypes.includes(EVENTS.STREAM_DONE))

        const readBack = await standaloneDsh.readSession(created.nativeId)
        assert.equal(readBack.messages.filter((m) => m.role === 'user').length, 1, 'Synthetic runtime/skill messages must be filtered')

        await ipcSrv.close()
        ipcSrv = null
        assert.equal((await standaloneDsh.getStatus()).mode, 'standalone-readonly')
      } finally {
        await standaloneDsh.dispose()
        if (ipcSrv) await ipcSrv.close()
        await liveDsh.dispose()
      }

      // 13c. DSH IPC auto-installer idempotency & opt-out
      assert.equal(ensureDshLocalIpcPlugin({ dshHome: join(tmpDir, 'no-dsh'), env: {}, log: { info: () => {}, warn: () => {} } }).status, 'no-dsh-profile')
      const fakeDshHome = join(tmpDir, 'fake-dsh-install')
      const fakeProfileDir = join(fakeDshHome, 'profiles', 'desktop')
      mkdirSync(fakeProfileDir, { recursive: true })
      writeFileSync(join(fakeProfileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
      assert.equal(ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: { ALLINONE_NO_AUTOFIX: '1' }, log: { info: () => {}, warn: () => {} } }).status, 'skipped-opt-out')
      assert.equal(ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status, 'installed')
      assert.equal(ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status, 'up-to-date')

      const hubDshHome = join(tmpDir, 'hub-dsh-home')
      mkdirSync(join(hubDshHome, 'profiles', 'desktop'), { recursive: true })
      writeFileSync(join(hubDshHome, 'profiles', 'desktop', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-mobile-hub'] } } }))
      assert.equal(ensureDshLocalIpcPlugin({ dshHome: hubDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status, 'already-using-dsh-mobile-hub')

      // 13d. DSH two-way prompt & approval sync (downstream Desktop cancel on remote answer + parent abort propagation)
      const syncCards = []
      const syncEvents = []
      const syncListeners = new Map()
      const dshSync = new DshAdapter({
        ctx: { agents: {}, on: (n, fn) => { syncListeners.set(n, fn); return () => syncListeners.delete(n) } },
        config: { dshHome: join(tmpDir, 'dsh-sync') },
        log: { info() {}, warn() {}, error() {} },
        emitEvent: (ev, payload) => syncEvents.push({ ev, payload }),
        onApprovalRequest: (card) => syncCards.push(card),
      })
      try {
        const parentAc1 = new AbortController()
        const req1 = { agent: { id: 's1', session: { id: 's1' } }, signal: parentAc1.signal, wait: { callId: 'c1' }, questions: [{ id: 'q1', question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }] }] }
        const order = []
        let desktopSig1 = null
        const p1 = syncListeners.get('user-questions/request')(req1, () => new Promise((_, reject) => {
          desktopSig1 = req1.signal
          desktopSig1.addEventListener('abort', () => { order.push('desktop-cancel'); reject(new Error('cancelled')) }, { once: true })
        })).then((r) => { order.push('tool-resolved'); return r })
        await new Promise((r) => setTimeout(r, 15))
        assert.ok(desktopSig1 && desktopSig1 !== parentAc1.signal)
        await dshSync.resolveApproval(syncCards.pop().id, { decision: 'submit', answers: { q1: { selected: ['Yes'] } } })
        assert.deepEqual(await p1, { answers: [{ id: 'q1', selected: ['Yes'] }] })
        assert.deepEqual(order, ['desktop-cancel', 'tool-resolved'])
        assert.equal(desktopSig1.aborted, true)
        assert.equal(parentAc1.signal.aborted, false)
        assert.equal(req1.signal, parentAc1.signal)

        const parentAc2 = new AbortController()
        const req2 = { agent: { id: 's2', session: { id: 's2', meta: { cwd: tmpDir } } }, signal: parentAc2.signal, toolName: 'bash', reason: 'build' }
        let desktopSig2 = null
        const p2 = syncListeners.get('approval/request')(req2, () => new Promise((_, reject) => {
          desktopSig2 = req2.signal
          desktopSig2.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }))
        await new Promise((r) => setTimeout(r, 15))
        await dshSync.resolveApproval(syncCards.pop().id, 'allowed-once')
        assert.equal(await p2, 'allowed-once')
        assert.equal(desktopSig2.aborted, true)
        assert.equal(parentAc2.signal.aborted, false)

        const parentAc3 = new AbortController()
        const req3 = { agent: { id: 's3', session: { id: 's3' } }, signal: parentAc3.signal, questions: [{ id: 'q3', question: 'Abort?', options: [{ label: 'A' }] }] }
        let desktopSig3 = null
        const p3 = syncListeners.get('user-questions/request')(req3, () => new Promise(() => { desktopSig3 = req3.signal }))
        await new Promise((r) => setTimeout(r, 15))
        const card3 = syncCards.pop()
        parentAc3.abort(new Error('turn stopped'))
        await assert.rejects(() => p3, /turn stopped/)
        assert.equal(desktopSig3.aborted, true)
        assert.ok(syncEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.payload?.id === card3.id))
      } finally {
        await dshSync.dispose()
      }

      // 13e. Half-installed CLI auto-completion detector & opt-out guard
      const emptyHome = join(tmpDir, 'fake-home-empty')
      mkdirSync(emptyHome, { recursive: true })
      assert.equal(detectHalfInstalledClis({ homeDir: emptyHome, platform: 'darwin', env: {}, checkBin: () => null, checkSystemApps: false }).length, 0)

      const partialHome = join(tmpDir, 'fake-home-partial')
      mkdirSync(join(partialHome, '.gemini', 'antigravity'), { recursive: true })
      mkdirSync(join(partialHome, '.claude', 'projects'), { recursive: true })
      mkdirSync(join(partialHome, '.codex', 'sessions'), { recursive: true })
      const missing = detectHalfInstalledClis({ homeDir: partialHome, platform: 'darwin', env: {}, checkBin: (n) => (n.includes('npm') ? '/usr/local/bin/npm' : null), checkSystemApps: false })
      assert.deepEqual(missing.map((m) => m.app).sort(), ['antigravity', 'claude', 'codex'])
      assert.equal(detectHalfInstalledClis({ homeDir: partialHome, platform: 'darwin', env: {}, checkBin: () => '/usr/local/bin/mock', checkSystemApps: false }).length, 0)

      const prevOptOut = process.env.ALLINONE_NO_AUTOFIX
      process.env.ALLINONE_NO_AUTOFIX = '1'
      try {
        const res = await autoCompleteHalfInstalledClis({ stateDir: join(tmpDir, 'autofix-optout') })
        assert.equal(res.skipped, true)
        assert.equal(res.reason, 'disabled')
      } finally {
        if (prevOptOut === undefined) delete process.env.ALLINONE_NO_AUTOFIX
        else process.env.ALLINONE_NO_AUTOFIX = prevOptOut
      }
    }
    pass(13, 'DSH Cordis plugin, authenticated IPC, auto-installer, two-way prompt sync & CLI auto-fix guard')

    // =========================================================================
    // 14. Interactive Multi-Question Q&A & Approvals Across All 4 Adapters & Orchestrator
    // =========================================================================
    {
      // 14a. JSON Schema elicitation normalization & serialization
      const testSchema = {
        type: 'object',
        required: ['framework', 'port'],
        properties: {
          framework: { type: 'string', title: 'Framework', oneOf: [{ const: 'react', title: 'React' }, { const: 'vue', title: 'Vue' }] },
          features: { type: 'array', title: 'Features', items: { anyOf: [{ const: 'i18n', title: 'i18n' }, { const: 'pwa', title: 'PWA' }] } },
          useTs: { type: 'boolean', title: 'TypeScript', default: true },
          port: { type: 'integer', title: 'Port' },
          note: { type: 'string', title: 'Note' },
        },
      }
      const qs = elicitationSchemaToQuestions(testSchema, 'Fallback')
      assert.equal(qs.length, 5)
      assert.equal(qs[1].multiSelect, true)
      assert.deepEqual(
        answersToElicitationContent(testSchema, {
          framework: { selected: ['react'] },
          features: { selected: ['i18n', 'pwa'] },
          useTs: { selected: ['false'] },
          port: { custom: '8080' },
          note: { custom: 'Ship fast' },
        }),
        { framework: 'react', features: ['i18n', 'pwa'], useTs: false, port: 8080, note: 'Ship fast' },
      )

      // 14b. CodexAdapter: requestUserInput + permissions + mcpServer/elicitation (form & url)
      {
        const cards = []
        const events = []
        const sent = []
        const writer = { sendRaw: (obj) => sent.push(obj) }
        const cdx = new CodexAdapter({ config: { codexHome: join(tmpDir, 'codex-qna') }, log: { warn() {}, log() {} }, emitEvent: (ev, p) => events.push({ ev, p }), onApprovalRequest: (r) => cards.push(r) })
        cdx.handleServerRequest(writer, {
          id: 101,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thr-qna-1',
            questions: [
              { id: 'db', header: 'DB', question: 'Which DB?', options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }], isOther: true },
              { id: 'branch', header: 'Branch', question: 'Branch?', options: [], isOther: true },
            ],
          },
        })
        await cdx.resolveApproval(cards[0].id, { decision: 'submit', answers: { db: { selected: ['PostgreSQL'] }, branch: { custom: 'feat/qna' } } })
        assert.deepEqual(sent[0].result, { answers: { db: { answers: ['PostgreSQL'] }, branch: { answers: ['feat/qna'] } } })

        cdx.handleServerRequest(writer, { id: 102, method: 'item/permissions/requestApproval', params: { threadId: 'thr-qna-1', reason: 'net', permissions: { network: { enabled: true } } } })
        await cdx.resolveApproval(cards[1].id, 'acceptForSession')
        assert.deepEqual(sent[1].result, { permissions: { network: { enabled: true } }, scope: 'session' })

        cdx.handleServerRequest(writer, { id: 103, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-qna-1', serverName: 'gh', mode: 'form', message: 'Repo', requestedSchema: { type: 'object', properties: { vis: { type: 'string', enum: ['public', 'private'] } } } } })
        await cdx.resolveApproval(cards[2].id, { decision: 'submit', answers: { vis: { selected: ['private'] } } })
        assert.deepEqual(sent[2].result, { action: 'accept', content: { vis: 'private' } })

        cdx.handleServerRequest(writer, { id: 104, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-qna-1', serverName: 'oauth', mode: 'url', message: 'Auth', url: 'https://example.com/auth' } })
        await cdx.resolveApproval(cards[3].id, 'decline')
        assert.deepEqual(sent[3].result, { action: 'decline' })
        assert.equal(events.filter((e) => e.ev === EVENTS.APPROVAL_RESOLVED).length, 4)
      }

      // 14c. DshAdapter Cordis waterfall hooks + IPC + desktop-first race
      {
        const ipcQnaHome = join(tmpDir, 'dsh-qna-ipc')
        mkdirSync(ipcQnaHome, { recursive: true })
        const hooks = new Map()
        const liveEvents = []
        let ipcQnaSrv = null
        const dshLive = new DshAdapter({
          ctx: { agents: {}, get: (k) => (k === 'agents' || k === 'sessionController' ? {} : null), on: (e, fn) => { hooks.set(e, fn); return () => hooks.delete(e) } },
          config: { dshHome: ipcQnaHome },
          log: { info() {}, warn() {}, error() {} },
          emitEvent: (ev, p) => { liveEvents.push({ ev, p }); ipcQnaSrv?.emitEvent?.(ev, p) },
          onApprovalRequest: (r) => ipcQnaSrv?.emitEvent?.(EVENTS.APPROVAL_REQUEST, r),
        })
        const dshStandalone = new DshAdapter({ ctx: null, config: { dshHome: ipcQnaHome }, log: { info() {}, warn() {}, error() {} } })
        try {
          ipcQnaSrv = await startDshLocalIpcServer({ dshAdapter: dshLive, dshHome: ipcQnaHome, log: { info() {}, warn() {}, error() {} } })
          const uqP = hooks.get('user-questions/request')(
            {
              agent: { session: { id: 'dsh-q1' } },
              questions: [
                { id: 'q1', question: 'Target?', options: [{ label: 'Staging' }, { label: 'Prod' }] },
                { id: 'q2', question: 'Extras?', multiSelect: true, options: [{ label: 'Cache' }] },
              ],
            },
            () => Promise.reject(Object.assign(new Error('No UI'), { code: 'NO_PROVIDER' })),
          )
          const pending = await dshStandalone.listPendingApprovals()
          assert.equal(pending.length, 1)
          await dshStandalone.resolveApproval(pending[0].id, { decision: 'submit', answers: { q1: { selected: ['Staging'] }, q2: { selected: ['Cache'], custom: 'Edge' } } })
          assert.deepEqual(await uqP, { answers: [{ id: 'q1', selected: ['Staging'] }, { id: 'q2', selected: ['Cache'], custom: 'Edge' }] })

          const raceRes = await hooks.get('user-questions/request')(
            { agent: { session: { id: 'dsh-q2' } }, questions: [{ id: 'c', question: 'Go?', options: [{ label: 'Yes' }] }] },
            () => new Promise((r) => setTimeout(() => r({ answers: [{ id: 'c', selected: ['Yes'] }] }), 20)),
          )
          assert.deepEqual(raceRes, { answers: [{ id: 'c', selected: ['Yes'] }] })
          assert.ok(liveEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED && e.p?.decision === 'desktop'))
        } finally {
          await dshStandalone.dispose()
          await dshLive.dispose()
          if (ipcQnaSrv) await ipcQnaSrv.close()
        }
      }

      // 14d. AntigravityAdapter: elicitation/create + session/request_permission
      {
        const cards = []
        const sent = []
        const agy = new AntigravityAdapter({ config: { agyHome: join(tmpDir, 'agy-qna'), agyAutoApprove: false }, log: { warn() {}, log() {} }, onApprovalRequest: (r) => cards.push(r) })
        try {
          const entry = { sessionId: 'agy-1', cwd: tmpDir, lastActivityAt: 0 }
          const client = { sendRaw: (obj) => sent.push(obj) }
          agy.handleServerRequest(entry, client, {
            id: 201,
            method: 'elicitation/create',
            params: { sessionId: 'agy-1', mode: 'form', message: 'Channel', requestedSchema: { type: 'object', properties: { ch: { type: 'string', oneOf: [{ const: 'stable', title: 'Stable' }] } } } },
          })
          await agy.resolveApproval(cards[0].id, { decision: 'submit', answers: { ch: { selected: ['stable'] } } })
          assert.deepEqual(sent[0].result, { action: 'accept', content: { ch: 'stable' } })

          agy.handleServerRequest(entry, client, {
            id: 202,
            method: 'session/request_permission',
            params: { sessionId: 'agy-1', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] },
          })
          await agy.resolveApproval(cards[1].id, 'allow_once')
          assert.deepEqual(sent[1].result, { outcome: { outcome: 'selected', optionId: 'allow_once' } })
        } finally {
          await agy.dispose()
        }
      }

      // 14e. ClaudeAdapter: AskUserQuestion, ExitPlanMode & Bash control_request/control_response
      {
        const cards = []
        const written = []
        const proc = { stdin: { writable: true, write: (c) => written.push(JSON.parse(String(c).trim())) } }
        const cld = new ClaudeAdapter({ config: { claudeHome: join(tmpDir, 'claude-qna') }, log: { warn() {}, log() {} }, onApprovalRequest: (r) => cards.push(r) })
        cld.handleControlRequest(proc, 'cld-s1', 'claude:cld-s1', tmpDir, {
          type: 'control_request',
          request_id: 'req-ask-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: {
              questions: [
                { header: 'Auth', question: 'Which auth?', multiSelect: false, options: [{ label: 'JWT' }, { label: 'OAuth' }] },
                { header: 'Targets', question: 'Platforms?', multiSelect: true, options: [{ label: 'Web' }, { label: 'Android' }] },
              ],
            },
          },
        })
        await cld.resolveApproval(cards[0].id, { decision: 'submit', answers: { [cards[0].questions[0].id]: { selected: ['JWT'] }, [cards[0].questions[1].id]: { selected: ['Web', 'Android'] } } })
        assert.deepEqual(written[0].response.response.updatedInput.answers, { 'Which auth?': 'JWT', 'Platforms?': 'Web, Android' })

        cld.handleControlRequest(proc, 'cld-s1', 'claude:cld-s1', tmpDir, { type: 'control_request', request_id: 'req-plan-2', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. Edit' } } })
        await cld.resolveApproval(cards[1].id, 'allow')
        assert.equal(written[1].response.response.behavior, 'allow')

        cld.handleControlRequest(proc, 'cld-s1', 'claude:cld-s1', tmpDir, { type: 'control_request', request_id: 'req-bash-3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/demo' } } })
        await cld.resolveApproval(cards[2].id, 'deny')
        assert.equal(written[2].response.response.behavior, 'deny')
      }

      // 14f. MultiAppOrchestrator RPC.APPROVAL_LIST + RPC.APPROVAL_RESOLVE
      {
        const orchEvents = []
        const orch = new MultiAppOrchestrator({ config: { cwd: tmpDir }, log: { info() {}, warn() {}, error() {} }, onEvent: (ev, p) => orchEvents.push({ ev, p }) })
        try {
          const mockWriter = { sent: [], sendRaw(obj) { this.sent.push(obj) } }
          orch.adapters.codex.handleServerRequest(mockWriter, { id: 301, method: 'item/tool/requestUserInput', params: { threadId: 'orch-1', questions: [{ id: 'env', question: 'Env?', options: [{ label: 'prod' }] }] } })
          const listed = await orch.handleRpc(RPC.APPROVAL_LIST, {})
          assert.equal(listed.approvals.length, 1)
          const res = await orch.handleRpc(RPC.APPROVAL_RESOLVE, { id: listed.approvals[0].id, decision: 'submit', answers: { env: { selected: ['prod'] } } })
          assert.equal(res.resolved, true)
          assert.equal((await orch.handleRpc(RPC.APPROVAL_LIST, {})).approvals.length, 0)
          assert.ok(orchEvents.some((e) => e.ev === EVENTS.APPROVAL_RESOLVED))
        } finally {
          await orch.dispose()
        }
      }
    }
    pass(14, 'Interactive multi-question Q&A & approvals across Codex, DSH (+IPC), Antigravity ACP, Claude & Orchestrator')

    // =========================================================================
    // 15. Adapter Resilience, External Watchers & Subscription Weekly Quotas
    // =========================================================================
    {
      // 15a. Antigravity: split-brain transcript branch IDs, live external watcher & Gemini-only weekly quota
      const splitJsonl = [
        JSON.stringify({ step_index: 10, type: 'USER_INPUT', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nTrunk Q\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 11, type: 'PLANNER_RESPONSE', created_at: '2026-11-21T10:00:05Z', content: 'Trunk A' }),
        JSON.stringify({ step_index: 12, type: 'USER_INPUT', created_at: '2026-11-21T11:00:00Z', content: '<USER_REQUEST>\nBranch Q\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 13, type: 'PLANNER_RESPONSE', created_at: '2026-11-21T11:00:05Z', content: 'Branch A' }),
        JSON.stringify({ step_index: 12, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: '<USER_REQUEST>\nFresh Q\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 13, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T10:00:05Z', content: 'Fresh A' }),
      ].join('\n')
      const parsedSplit = parseAgyTranscriptContent(splitJsonl)
      assert.equal(parsedSplit.messages.length, 6)
      assert.equal(new Set(parsedSplit.messages.map((m) => m.id)).size, 6)
      assert.equal(parsedSplit.messages[4].id, 'agy-u-b1-12')
      assert.equal(parsedSplit.divergence.lastFromStep, 13)

      const fakeAgyHome = join(tmpDir, 'fake-agy-home')
      const fakeConvId = '11111111-2222-3333-4444-555555555555'
      const fakeLogDir = join(fakeAgyHome, 'brain', fakeConvId, '.system_generated', 'logs')
      mkdirSync(fakeLogDir, { recursive: true })
      const fakeTranscriptPath = join(fakeLogDir, 'transcript.jsonl')
      writeFileSync(fakeTranscriptPath, `${JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: 'hi' })}\n`)
      const agyWatchEvents = []
      const agyQuotaCachePath = join(tmpDir, 'agy-quota-cache.json')
      const futureIso = new Date(Date.now() + 5 * 86400 * 1000).toISOString()
      const agyQuota = normalizeAntigravityQuota({
        quota: {
          '3p-weekly': { remaining_fraction: 0 },
          'gemini-5h': { remaining_fraction: 0.84, reset_time: new Date(Date.now() + 3600_000).toISOString() },
          'gemini-weekly': { remaining_fraction: 0.926, reset_time: futureIso },
        },
      })
      assert.equal(agyQuota.remainingPercent, 93)
      assert.equal(agyQuota.bucketLabel, 'Gemini')
      assert.equal(agyQuota.shortWindow?.remainingPercent, 84)
      assert.equal(normalizeAntigravityQuota({ quota: { '3p-weekly': { remaining_fraction: 0.5 } } }), null)
      assert.equal(normalizeAntigravityQuota({ quota: { 'gemini-weekly': { remaining_fraction: 0.9, disabled: true } } }), null)
      assert.equal(normalizeAntigravityQuota({ quota: { 'gemini-weekly': { remaining_fraction: 0.5, reset_time: new Date(Date.now() - 10 * 60_000).toISOString() } } }), null)
      writeFileSync(agyQuotaCachePath, JSON.stringify(agyQuota), 'utf8')

      const agyWatch = new AntigravityAdapter({
        config: { agyHome: fakeAgyHome, watchPollIntervalMs: 180, agyQuotaCachePath, disableAgyQuotaProbe: true },
        log: { warn() {}, log() {} },
        emitEvent: (ev, p) => agyWatchEvents.push({ ev, p }),
      })
      try {
        assert.equal((await agyWatch.getStatus()).quota?.remainingPercent, 93)
        await agyWatch.readSession(fakeConvId, { limit: 15 })
        await new Promise((r) => setTimeout(r, 60))
        writeFileSync(
          fakeTranscriptPath,
          [
            JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T10:00:00Z', content: 'hi' }),
            JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T10:00:02Z', content: 'desktop reply' }),
          ].join('\n') + '\n',
        )
        for (let i = 0; i < 25; i += 1) {
          if (agyWatchEvents.some((e) => e.ev === EVENTS.SESSION_UPDATED && e.p?.historyChanged)) break
          await new Promise((r) => setTimeout(r, 80))
        }
        assert.ok(agyWatchEvents.some((e) => e.ev === EVENTS.SESSION_UPDATED && e.p?.historyChanged && e.p?.session?.nativeId === fakeConvId))
      } finally {
        await agyWatch.dispose()
      }

      // 15b. Codex: autonomous multi-milestone turns, giant rollout tail, external watcher, async questions & quota
      const autoMsgs = normalizeCodexTurns([
        {
          id: 'auto-1',
          startedAt: Date.now(),
          items: [
            { id: 'c1', type: 'commandExecution', command: 'echo 1', status: 'completed', aggregatedOutput: '1' },
            { id: 'a1', type: 'agentMessage', text: 'Milestone 1' },
            { id: 'c2', type: 'commandExecution', command: 'echo 2', status: 'completed', aggregatedOutput: '2' },
            { id: 'a2', type: 'agentMessage', text: 'Milestone 2' },
          ],
        },
      ])
      assert.equal(autoMsgs.length, 2)
      assert.notEqual(autoMsgs[0].branchEpoch, autoMsgs[1].branchEpoch)

      const cdxDir = join(tmpDir, 'codex-watch')
      mkdirSync(cdxDir, { recursive: true })
      const fakeRollout = join(cdxDir, 'rollout-giant.jsonl')
      writeFileSync(
        fakeRollout,
        [
          '{corrupt-line',
          JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'Start' }] } }),
          JSON.stringify({ timestamp: '2026-11-23T10:01:00Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: 'ls' } }),
          JSON.stringify({ timestamp: '2026-11-23T10:02:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'Done' }] } }),
        ].join('\n'),
      )
      const tailMsgs = readCodexRolloutTail(`\\\\?\\${fakeRollout}`, { limit: 10 })
      assert.equal(tailMsgs.length, 2)
      assert.equal(tailMsgs[1].toolCount, 1)

      const emptyFile = join(cdxDir, 'empty.jsonl')
      const doneFile = join(cdxDir, 'done.jsonl')
      const abortedFile = join(cdxDir, 'aborted.jsonl')
      const giantFile = join(cdxDir, 'giant.jsonl')
      writeFileSync(emptyFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'e' } })}\n`)
      assert.equal(probeCodexRolloutStatus(emptyFile).running, false)
      writeFileSync(doneFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`)
      assert.equal(probeCodexRolloutStatus(doneFile).running, false)
      writeFileSync(abortedFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`)
      assert.equal(probeCodexRolloutStatus(abortedFile).running, false)

      const bigPayload = 'A'.repeat(90 * 1024)
      writeFileSync(giantFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: bigPayload } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count' } })}\n`)
      assert.equal(probeCodexRolloutStatus(giantFile).running, true)
      assert.equal(probeCodexRolloutStatus(giantFile, { now: Date.now() + 30 * 60_000, maxIdleMs: 20 * 60_000 }).running, false)

      const cdxWatchEvents = []
      const cdxWatch = new CodexAdapter({ config: { watchPollIntervalMs: 160 }, log: { info() {}, warn() {}, debug() {} }, emitEvent: (ev, p) => cdxWatchEvents.push({ ev, p }) })
      try {
        cdxWatch.rememberWatchedSession('thr-open', { path: doneFile, title: 'Open', cwd: cdxDir })
        cdxWatch.rememberTrackedListSession('thr-side', { path: abortedFile, title: 'Side', cwd: cdxDir })
        await new Promise((r) => setTimeout(r, 50))
        writeFileSync(doneFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } })}\n`)
        writeFileSync(abortedFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`)
        for (let i = 0; i < 20; i += 1) {
          if (
            cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-open' && e.p?.session?.status === 'running') &&
            cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-side' && e.p?.session?.status === 'running')
          ) break
          await new Promise((r) => setTimeout(r, 80))
        }
        assert.ok(cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-open' && e.p?.session?.syncState?.externalRunning === true))
        assert.ok(cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-side' && e.p?.session?.status === 'running'))

        writeFileSync(doneFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`)
        for (let i = 0; i < 20; i += 1) {
          if (cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-open' && e.p?.session?.status === 'idle')) break
          await new Promise((r) => setTimeout(r, 80))
        }
        assert.ok(cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-open' && e.p?.session?.status === 'idle'))
      } finally {
        await cdxWatch.dispose()
      }

      // Codex async questions (`request_user_input_async`), `turn/steer`, rollout extraction & pretty display
      const callId = 'call_async_15'
      const qCard = normalizeCodexAsyncQuestionCard('thr-a', { id: callId, delivery: 'async', questions: [{ title: '口味？', options: ['香辣', '清淡'] }] })
      assert.equal(qCard.id, `cdx-aq-${callId}`)
      assert.equal(normalizeCodexAsyncQuestionCard('thr-a', { id: callId, questions: [{ title: 'Q', options: ['A'] }] }, { externalRunning: true }).readOnlyHint, 'desktop-running')
      const replyWire = buildCodexQuestionReplyText(callId, qCard.questions, { q_0: { selected: ['香辣'] } })
      assert.equal(parseCodexQuestionReply(replyWire).callIds.has(callId), true)
      assert.equal(formatCodexQuestionReplyForDisplay(replyWire), '已选择：香辣')

      const asyncRollout = join(cdxDir, 'rollout-async.jsonl')
      writeFileSync(asyncRollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: callId, delivery: 'async', content: [{ type: 'Text', text: '口味？' }], questions: [{ title: '口味？', options: ['香辣', '清淡'] }] } } })}\n`)
      assert.equal(extractPendingCodexAsyncQuestionFromRollout(asyncRollout)?.id, callId)
      appendFileSync(asyncRollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u-r', content: [{ type: 'text', text: replyWire }] } } })}\n`)
      assert.equal(extractPendingCodexAsyncQuestionFromRollout(asyncRollout), null)

      const asyncCards = []
      const steered = []
      const cdxAsync = new CodexAdapter({ config: {}, log: { info() {}, warn() {}, error() {} }, onApprovalRequest: (c) => asyncCards.push(c) })
      try {
        cdxAsync.activeTurns.set('thr-live', { writer: { rpc: async (m, p) => { steered.push({ m, p }); return { ok: true } } }, turnId: 'turn-1', cwd: tmpDir, textBuffer: '', aborted: false, settled: false })
        cdxAsync.handleNotification('item/completed', { threadId: 'thr-live', item: { type: 'agentMessage', id: 'call_steer', delivery: 'async', text: 'Pick', questions: [{ title: 'Pick', options: ['Spicy'] }] } })
        const sr = await cdxAsync.resolveApproval(asyncCards[0].id, { decision: 'submit', answers: { q_0: { selected: ['Spicy'] } } })
        assert.equal(sr.steered, true)
        assert.equal(steered[0].m, 'turn/steer')
        cdxAsync.activeTurns.delete('thr-live')
        cdxAsync.registerAsyncQuestionPrompt('thr-idle', { id: 'call_skip', questions: [{ title: 'Opt?', options: ['A'] }] })
        await cdxAsync.resolveApproval(asyncCards.find((c) => c.callId === 'call_skip').id, { decision: 'cancel', answers: {} })
        assert.equal(cdxAsync.dismissedAsyncQuestions.has('call_skip'), true)
      } finally {
        await cdxAsync.dispose()
      }

      // 15c. Claude Desktop (Cowork + Desktop Code) discovery, watcher & read-only guard
      const claudeRoot = join(tmpDir, 'claude-desktop')
      const claudeHome = join(tmpDir, 'claude-home')
      const wsDir = join(tmpDir, 'ws-civ6')
      mkdirSync(wsDir, { recursive: true })
      const acctDir = join(claudeRoot, 'local-agent-mode-sessions', 'org-1', 'acct-1')
      const sessUuid = '5931e05f-6a35-4063-8476-8b305db38304'
      const cliSid = 'fe312cf1-0b14-48b9-a991-7198d20c17d4'
      const sessDir = join(acctDir, '5931e05f')
      mkdirSync(join(sessDir, '.claude', 'projects', 'session'), { recursive: true })
      mkdirSync(join(sessDir, '.claude', 'sessions'), { recursive: true })
      writeFileSync(join(acctDir, 'spaces.json'), JSON.stringify({ spaces: [{ id: 'sp-1', name: 'Civ6Space', folders: [{ path: wsDir }] }] }))
      writeFileSync(join(acctDir, `local_${sessUuid}.json`), JSON.stringify({ sessionId: `local_${sessUuid}`, cliSessionId: cliSid, title: 'Cowork Live', isArchived: false, userSelectedFolders: [wsDir], folderMountNames: { [wsDir]: 'CivilizationVI' }, createdAt: Date.now() - 60_000, lastActivityAt: Date.now() - 5_000 }))
      writeFileSync(join(acctDir, 'local_archived-1111-2222-3333-444444444444.json'), JSON.stringify({ sessionId: 'local_archived-1111-2222-3333-444444444444', title: 'Archived', isArchived: true }))
      writeFileSync(join(sessDir, '.claude', 'projects', 'session', `${cliSid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run solver' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__workspace__bash', input: { command: 'python run.py' } }] } })}\n`)
      const auditJsonl = join(sessDir, 'audit.jsonl')
      writeFileSync(auditJsonl, `${JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: 'system', subtype: 'permission_request', uuid: 'perm-1', tool_name: 'mcp__cowork__dir', timestamp: new Date().toISOString() })}\n`)
      writeFileSync(join(sessDir, '.claude', 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: cliSid, status: 'busy', updatedAt: Date.now(), statusUpdatedAt: Date.now() }))

      const cliProjDir = join(claudeHome, 'projects', 'demo-proj')
      mkdirSync(cliProjDir, { recursive: true })
      const codeCliId = '11111111-2222-3333-4444-555555555555'
      writeFileSync(join(cliProjDir, `${codeCliId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'cu1', cwd: wsDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } })}\n`)
      const codeAcctDir = join(claudeRoot, 'claude-code-sessions', 'org-1', 'acct-1')
      mkdirSync(codeAcctDir, { recursive: true })
      writeFileSync(join(codeAcctDir, 'local_aaaa1111-2222-3333-4444-555555555555.json'), JSON.stringify({ sessionId: 'local_aaaa1111-2222-3333-4444-555555555555', cliSessionId: codeCliId, title: 'Desktop Code Enriched', cwd: wsDir, createdAt: Date.now() - 30_000, lastActivityAt: Date.now() - 10_000 }))

      assert.equal(probeClaudeTranscriptTail(auditJsonl).waitingPermission, true)
      const extEvents = []
      let fakePidAlive = true
      const claudeDesk = new ClaudeAdapter({
        config: { claudeHome, claudeDesktopRoots: [claudeRoot], claudeWatchPollMs: 120, checkPidAlive: (pid) => pid === 999999 && fakePidAlive },
        emitEvent: (ev, p) => extEvents.push({ ev, p }),
      })
      try {
        const listed = await claudeDesk.listSessions({ limit: 20 })
        assert.equal(listed.length, 2)
        const cowork = listed.find((s) => s.nativeId === `local_${sessUuid}`)
        assert.equal(cowork.source, 'claude-desktop-cowork')
        assert.equal(cowork.writable, false)
        assert.equal(cowork.syncState?.waitingPermission, true)
        assert.equal(listed.find((s) => s.nativeId === codeCliId)?.source, 'claude-desktop-code')
        assert.ok((await claudeDesk.listWorkspaces()).some((w) => w.path === wsDir))
        await assert.rejects(() => claudeDesk.sendMessage(`local_${sessUuid}`, { text: 'no' }), (err) => err?.code === 'SESSION_READONLY')
        await claudeDesk.readSession(`local_${sessUuid}`, { limit: 20 })

        fakePidAlive = false
        appendFileSync(auditJsonl, `${JSON.stringify({ type: 'system', subtype: 'permission_response', uuid: 'perm-1', granted: true, timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: 'result', subtype: 'success', timestamp: new Date().toISOString() })}\n`)
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline && !extEvents.some((e) => e.p?.session?.nativeId === `local_${sessUuid}` && e.p?.session?.status === 'idle')) {
          await new Promise((r) => setTimeout(r, 60))
        }
        const doneEv = extEvents.find((e) => e.p?.session?.nativeId === `local_${sessUuid}` && e.p?.session?.status === 'idle')
        assert.ok(doneEv && doneEv.p.session.syncState?.waitingPermission === undefined)
      } finally {
        await claudeDesk.dispose()
      }
      assert.equal(probeClaudeExternalStatus({ auditPath: auditJsonl }).running, false)

      // 15d. Subscription weekly quota normalization (Codex Pro/Plus + Claude) & ZK Relay stripping
      const futureSec = Math.floor(Date.now() / 1000) + 3 * 86400
      const proQ = normalizeCodexQuota({ rateLimits: { planType: 'pro', primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: futureSec }, secondary: null } })
      assert.equal(proQ.remainingPercent, 82)
      const plusQ = normalizeCodexQuota({ rateLimits: { planType: 'plus', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: futureSec }, secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: futureSec } } })
      assert.equal(plusQ.remainingPercent, 36)
      assert.equal(plusQ.shortWindow?.remainingPercent, 90)
      assert.equal(normalizeClaudeQuota({ rateLimitType: 'seven_day', utilization: 0.27, resetsAt: futureSec }).remainingPercent, 73)
      assert.equal(normalizeClaudeQuota({ rateLimitType: 'seven_day', status: 'allowed' }), null)

      const zkLink = new RelayBridgeLink({ relayUrl: wsBridgeUrl, bridgeId: 'zk-pc', roomId: 'usr_zk', secret: 'sec', e2eeKey: generateE2eeKey(), onRpc: async () => ({}), log: { info: () => {}, warn: () => {}, error: () => {} } })
      zkLink.sendBridgeMeta = async () => {}
      zkLink.setAppsMeta([{ app: 'codex', available: true, writable: true, quota: proQ }])
      assert.equal(zkLink.metaApps[0].quota, undefined, 'Plaintext bridge.meta.apps must never include quota')
    }
    pass(15, 'Adapter resilience, external watchers (Antigravity/Codex/Claude), async Q&A & weekly quotas')

    // =========================================================================
    // 16. Unified Plan / Goal / Steps Live Sync & Interactive `taskMode` Forwarding
    // =========================================================================
    {
      assert.equal(EVENTS.STREAM_TASK_STATE, 'stream.task_state')
      assert.equal(normalizeTaskState({ mode: null, focus: '', steps: [] }), null)
      assert.equal(normalizeStepStatus('inProgress'), 'in_progress')
      assert.equal(normalizeStepStatus('completed'), 'done')
      assert.equal(normalizeStepStatus('cancelled'), 'skipped')
      assert.equal(normalizeTaskMode('PLAN'), 'plan')
      assert.equal(normalizeTaskMode('goal'), 'goal')
      assert.equal(normalizeTaskMode('unknown'), '')

      // Antigravity transcript.jsonl + JSON-stringified tool args + ACP live updates
      const agyTranscript = [
        JSON.stringify({ type: 'USER_INPUT', step_index: 0, created_at: '2026-11-25T08:00:00Z', content: '<USER_REQUEST>/goal Refactor WebRTC pipeline and verify tests</USER_REQUEST>' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          step_index: 1,
          created_at: '2026-11-25T08:00:05Z',
          content: 'Working on it',
          tool_calls: [
            { id: 'tc-1', name: 'update_steps', args: { steps: JSON.stringify([{ title: 'Inspect adapters', status: 'done' }, { title: 'Wire sync', status: 'in_progress' }]) } },
            { id: 'tc-2', name: 'update_focus', args: { focus: JSON.stringify('Wiring Plan/Goal sync') } },
            { id: 'tc-3', name: 'write_file', args: { Path: JSON.stringify('C:/Users/Test/.gemini/antigravity/brain/conv-1/implementation_plan.md'), ArtifactMetadata: JSON.stringify({ UserFacing: true, Summary: 'Plan', RequestFeedback: true }) } },
          ],
        }),
      ].join('\n')
      const agyParsed = parseAgyTranscriptContent(agyTranscript)
      assert.equal(agyParsed.taskState.mode, 'goal')
      assert.equal(agyParsed.taskState.goal?.objective, 'Refactor WebRTC pipeline and verify tests')
      assert.equal(agyParsed.taskState.focus, 'Wiring Plan/Goal sync')
      assert.equal(agyParsed.taskState.steps.length, 2)
      assert.equal(agyParsed.taskState.planDoc?.title, 'implementation_plan.md')

      const agyTracker = createTaskStateTracker()
      agyTracker.applyAntigravityAcpUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, 100)
      agyTracker.applyAntigravityAcpUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Design', status: 'completed' }, { content: 'UI', status: 'in_progress' }] }, 200)
      assert.equal(agyTracker.snapshot().mode, 'plan')
      assert.equal(agyTracker.snapshot().steps[0].status, 'done')
      agyTracker.applyAntigravityAcpUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, 300)
      assert.equal(agyTracker.snapshot().mode, null)

      // Codex rollout plan/steps + ThreadGoal tracker
      const cdxRolloutPath = join(tmpDir, 'codex-plan-rollout.jsonl')
      writeFileSync(
        cdxRolloutPath,
        [
          JSON.stringify({ timestamp: '2026-11-25T08:10:00Z', type: 'event_msg', payload: { type: 'task_started', collaboration_mode_kind: 'plan' } }),
          JSON.stringify({ timestamp: '2026-11-25T08:10:03Z', type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ explanation: 'Drafting steps', plan: [{ step: 'Audit', status: 'completed' }, { step: 'Ship', status: 'in_progress' }] }) } }),
          JSON.stringify({ timestamp: '2026-11-25T08:10:08Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Plan', id: 'p-1', text: '# Codex Plan\n1. Audit' } } }),
        ].join('\n') + '\n',
      )
      const cdxTask = extractCodexTaskStateFromRollout(cdxRolloutPath)
      assert.equal(cdxTask.mode, 'plan')
      assert.equal(cdxTask.focus, 'Drafting steps')
      assert.ok(cdxTask.planDoc?.content.includes('# Codex Plan'))
      const cdxGoal = createTaskStateTracker(cdxTask)
      cdxGoal.setGoal({ objective: 'Keep CI green', status: 'active' }, 500)
      assert.equal(cdxGoal.snapshot().goal?.objective, 'Keep CI green')
      cdxGoal.clearGoal(600)
      assert.equal(cdxGoal.snapshot().goal, undefined)

      // Claude Code JSONL (`EnterPlanMode`, `TodoWrite`, `ExitPlanMode`) + `TaskCreate`/`TaskUpdate`
      const cldTaskHome = join(tmpDir, 'claude-task-home')
      const cldProjDir = join(cldTaskHome, 'projects', 'demo-proj')
      mkdirSync(cldProjDir, { recursive: true })
      const cldSid = 'aaaaaaaa-1111-2222-3333-444444444444'
      writeFileSync(
        join(cldProjDir, `${cldSid}.jsonl`),
        [
          JSON.stringify({ type: 'user', uuid: 'u1', cwd: tmpDir, timestamp: '2026-11-25T08:20:00Z', message: { role: 'user', content: 'Plan it' } }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-11-25T08:20:02Z',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu-enter', name: 'EnterPlanMode', input: {} },
                { type: 'tool_use', id: 'tu-todo', name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Patch', status: 'in_progress', activeForm: 'Writing patch' }] } },
                { type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode', input: { plan: '## Claude Plan' } },
              ],
            },
          }),
          JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-11-25T08:20:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-exit', content: 'Approved', is_error: false }] } }),
        ].join('\n') + '\n',
      )
      const cldTaskAdapter = new ClaudeAdapter({ config: { claudeHome: cldTaskHome, claudeDesktopRoots: [], cwd: tmpDir } })
      const cldRead = await cldTaskAdapter.readSession(cldSid)
      assert.equal(cldRead.taskState.mode, null)
      assert.equal(cldRead.taskState.focus, 'Writing patch')
      assert.ok(cldRead.taskState.planDoc?.content.includes('Claude Plan'))
      await cldTaskAdapter.dispose()

      const taskTracker = createTaskStateTracker()
      taskTracker.applyClaudeTool('TaskCreate', { subject: 'Task One' }, 10)
      taskTracker.applyClaudeTool('TaskCreate', { subject: 'Task Two' }, 20)
      taskTracker.applyClaudeTool('TaskUpdate', { taskId: '1', status: 'completed' }, 30)
      taskTracker.applyClaudeTool('TaskUpdate', { taskId: '2', status: 'deleted' }, 40)
      assert.deepEqual(taskTracker.snapshot().steps, [{ id: '1', title: 'Task One', status: 'done' }])

      // MultiAppOrchestrator forwards `taskMode` cleanly
      let capturedSend = null
      const orchTask = new MultiAppOrchestrator({ config: { cwd: tmpDir } })
      orchTask.adapters.claude.sendMessage = async (sid, opts) => {
        capturedSend = { sid, opts }
        return { sessionId: `claude:${sid}`, nativeId: sid, finalText: 'ok', aborted: false }
      }
      await orchTask.sendMessage({ id: 'claude:test-plan-1', text: 'Design API', taskMode: 'plan' })
      assert.equal(capturedSend?.opts?.taskMode, 'plan')
      await orchTask.dispose()
    }
    pass(16, 'Unified Plan/Goal/Steps live sync & interactive taskMode forwarding')

    console.log(`\nALL ${TOTAL_SUITES} SMOKE TEST SUITES PASSED!`)
  } finally {
    if (bridge) await bridge.stop()
    await relay.close()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error('[smoke] FAILED:', err)
    process.exit(1)
  })
