/**
 * All in One — Streamlined v1.x End-to-End Smoke & Security Test Suite (16 modules)
 *
 *  1. Account Bootstrap, Open Registration, Daily Cap, Multi-Tenant Isolation, Device Lifecycle & Portable CLI
 *  2. Live E2EE PC Bridge & 5-App RPC Routing (DSH, Codex, Claude, Antigravity, WorkBuddy)
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
 * 17. Audit Regression Guards (Env Scrubbing, File ACL, UTF-8 Framing, Proxy Idle, IPv6/Spaces, sid Revocation, Caches & Mobile Config)
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
  CTRL_FRAG_LIMIT_CHARS,
  P2P_BULK_LABEL,
  P2P_CTRL_LABEL,
  createCtrlCodec,
  decodeBulkFrame,
  encodeBulkFrame,
  sendWithBackpressure,
} from '../packages/shared/src/p2p-mux.js'
import { createMailer } from '../packages/relay-server/src/mailer.js'
import { sanitizeChildEnv } from '../packages/dsh-mobile-hub/src/helpers/bin-finder.js'
import { P2PBridgeManager } from '../packages/dsh-mobile-hub/src/p2p/manager.js'
import { startStandaloneBridge } from '../packages/dsh-mobile-hub/standalone.js'
import { apply as applyDshPlugin } from '../packages/dsh-mobile-hub/index.js'
import {
  DshAdapter,
  normalizeDeepseekBalanceQuota,
  readDshDeepseekApiKey,
} from '../packages/dsh-mobile-hub/src/adapters/dsh.js'
import { startDshLocalIpcServer } from '../packages/dsh-mobile-hub/src/dsh-local-ipc.js'
import { ensureDshLocalIpcPlugin } from '../packages/dsh-mobile-hub/src/helpers/dsh-ipc-installer.js'
import { autoCompleteHalfInstalledClis, detectHalfInstalledClis } from '../packages/dsh-mobile-hub/src/helpers/env-autofix.js'
import {
  WorkBuddyAdapter,
  cleanWorkbuddyUserText,
  hasStandaloneCodebuddyAuth,
  isSafeWorkbuddyAuthUrl,
  normalizeWorkbuddyCreditsQuota,
  parseWorkbuddyJsonlMessages,
  probeWorkbuddyTranscriptTail,
  readStandaloneCodebuddyCredential,
  readWorkbuddyDbSnapshot,
} from '../packages/dsh-mobile-hub/src/adapters/workbuddy.js'
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
import {
  computeSidebarVendorLayout,
  formatQuotaBadgeText,
  formatQuotaTooltip,
} from '../packages/mobile-app/src/lib/sidebarVendors.js'
import {
  buildHomeQuotaCards,
  extractVendorQuotaDetails,
  formatQuotaResetCountdown,
} from '../packages/mobile-app/src/lib/quotaDashboard.js'
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
  computeGrantCommitment,
  computeGrantPubKeyFp,
  decryptAutoStream,
  decryptBinaryJson,
  decryptChunkedStream,
  decryptGrantPayload,
  decryptJson,
  deflateRawBytes,
  deriveGrantSas,
  encodeE2eeGrantQrUri,
  encodeE2eeQrUri,
  encryptBinaryJson,
  encryptChunkedBytes,
  encryptGrantPayload,
  encryptJson,
  formatE2eeFingerprint,
  generateE2eeKey,
  generateGrantKeyPair,
  generateGrantNonce,
  generateGrantReqId,
  generateGrantSecret,
  inflateRawBytes,
  isCompressibleFile,
  parseE2eeGrantQrInput,
  parseE2eeQrInput,
  parseBinaryE2eeHeader,
} from '../packages/shared/src/e2ee.js'
import { buildAdminOverview } from '../packages/relay-server/src/admin-monitor.js'
import {
  computeResizedDimensions,
  replaceFileExtension,
  shouldAttemptImageCompress,
} from '../packages/mobile-app/src/lib/imageCompress.js'
import { renderQrSvg as renderSharedQrSvg } from '../packages/shared/src/qr-svg.js'
import {
  clearDeviceCredentials,
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
import {
  checkNativeMobileUpdate,
  compareSemver as compareMobileSemver,
  isHotReloadableWebOrigin,
  resolveCurrentAppBaseUrl,
} from '../packages/mobile-app/src/lib/clientHelpers.js'
import {
  buildZipBuffer,
  computeOtaCanonicalPayload,
  packageAndroidOtaBundle,
} from './package-android-ota.mjs'
import {
  extractImageRefsFromText,
  isExternalHttpImageUrl,
  isPrivateOrLoopbackUrl,
  resolveImageSrc,
} from '../packages/mobile-app/src/lib/imageUrls.js'
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

const TOTAL_SUITES = 17
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
        for (const f of ctrlCodec.encode(obj)) {
          ctrlDc.send(Buffer.from(f.buffer, f.byteOffset, f.byteLength))
        }
        return true
      },
      async sendBulkCtrl(inner) {
        const enc = await encryptBinaryJson(e2eeKey, inner, { kind: 'p2p.bulk', roomId })
        assert.equal(peerObj.sendCtrlJson({ type: 'bulk.ctrl', bin: enc.bytes }), true, 'bulk.ctrl send should succeed')
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
        const enc = await encryptBinaryJson(
          e2eeKey,
          { method, params, cid: id, ts: Date.now() },
          { kind: 'rpc.req', roomId },
        )
        const rawRes = await peerObj.sendRawCtrlRpc({ type: 'rpc.req', id, bin: enc.bytes })
        if (rawRes.bin) {
          const dec = await decryptBinaryJson(e2eeKey, rawRes.bin, { kind: 'rpc.res', roomId })
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
            compressed: Boolean(header.e2ee.compressed),
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
              compress: isCompressibleFile(mimeType, filename),
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
      const u8 = Buffer.isBuffer(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : raw instanceof Uint8Array
          ? raw
          : new Uint8Array(raw)
      const msg = ctrlCodec.decode(u8)
      if (!msg) return
      if (msg.type === 'rpc.res') {
        const p = pendingRpcs.get(msg.id)
        if (p) {
          pendingRpcs.delete(msg.id)
          p.resolve(msg)
        }
      } else if (msg.type === 'event' && msg.bin) {
        p2pEvents.push({ ...msg, bridgeId: bid })
      } else if (msg.type === 'bulk.ctrl' && msg.bin) {
        decryptBinaryJson(e2eeKey, msg.bin, { kind: 'p2p.bulk', roomId })
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
    // 1. Account Bootstrap, Open Registration, Daily Cap, Multi-Tenant Isolation, Device Lifecycle & Portable CLI
    // =========================================================================
    const bootBefore = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootBefore.ok, true)
    assert.equal(bootBefore.hasUsers, false, 'Fresh server should report hasUsers=false')
    assert.equal(bootBefore.hasAdmin, false, 'Fresh server should report hasAdmin=false')
    assert.equal(bootBefore.needsBootstrapToken, true, 'Server with ADMIN_BOOTSTRAP_TOKEN must require bootstrapToken')
    assert.equal(bootBefore.openRegistration, true)
    assert.equal(bootBefore.dailyRegistrationLimit, 20, 'Default daily registration limit must be 20')
    assert.equal(bootBefore.dailyRegistrationsUsed, 0)
    assert.equal(bootBefore.dailyRegistrationRemaining, 20)
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
      body: JSON.stringify({ username: 'nobody', password: 'Password123!', bootstrapToken: 'WRONG-TOKEN' }),
    })
    assert.equal(badReg.status, 400, 'First-admin registration with invalid bootstrapToken must fail')

    const smokeAdmin = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'smoke_admin',
        password: SMOKE_ADMIN_PASS,
        bootstrapToken: TEST_BOOTSTRAP_TOKEN,
        deviceName: 'smoke-phone',
      }),
    })).json()
    assert.equal(smokeAdmin.ok, true)
    assert.equal(smokeAdmin.user.role, 'admin')
    assert.ok(smokeAdmin.roomId.startsWith('usr_'))

    const bootAfter = await (await fetch(`${httpBase}/api/account/bootstrap-status`)).json()
    assert.equal(bootAfter.hasUsers, true)
    assert.equal(bootAfter.hasAdmin, true)
    assert.equal(bootAfter.needsBootstrapToken, false)
    assert.equal(bootAfter.dailyRegistrationsUsed, 1)
    assert.equal(bootAfter.dailyRegistrationRemaining, 19)
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

    // Removed legacy invite endpoints must return 404
    assert.equal((await fetch(`${httpBase}/api/admin/invites`, { headers: { Authorization: `Bearer ${loginData.token}` } })).status, 404)
    assert.equal(
      (await fetch(`${httpBase}/api/admin/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ count: 1 }),
      })).status,
      404,
    )
    assert.equal(
      (await fetch(`${httpBase}/api/admin/invites/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
        body: JSON.stringify({ id: 'inv_1' }),
      })).status,
      404,
    )

    // Open registration creates regular free users with isolated rooms; admin routes reject non-admins (403)
    const friendA = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_a', password: 'FriendAPass99!' }),
    })).json()
    assert.equal(friendA.ok, true)
    assert.equal(friendA.user.role, 'user')
    assert.equal(friendA.user.tier, 'free')

    const nonAdminOv = await fetch(`${httpBase}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${friendA.token}` },
    })
    assert.equal(nonAdminOv.status, 403, 'Non-admin user must receive 403 on /api/admin/overview')

    const friendB = await (await fetch(`${httpBase}/api/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'friend_b', password: 'FriendBPass99!' }),
    })).json()
    assert.equal(friendB.ok, true)
    assert.equal(friendB.user.role, 'user')
    assert.notEqual(friendA.roomId, friendB.roomId)

    // Daily registration cap enforcement + first-user auto-admin (no bootstrap token) + concurrent burst race defense
    {
      const capRelay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        jwtSecret: 'smoke-cap-jwt-secret-0123456',
        accountsFile: join(tmpDir, 'cap-accounts.json'),
        stunEnabled: false,
        maxDailyRegistrations: 2,
      })
      const { port: capPort } = await capRelay.start()
      const capBase = `http://127.0.0.1:${capPort}`
      try {
        const capBoot = await (await fetch(`${capBase}/api/account/bootstrap-status`)).json()
        assert.equal(capBoot.hasAdmin, false)
        assert.equal(capBoot.needsBootstrapToken, false)
        assert.equal(capBoot.dailyRegistrationLimit, 2)
        assert.equal(capBoot.dailyRegistrationsUsed, 0)
        assert.equal(capBoot.dailyRegistrationRemaining, 2)

        const firstAutoAdmin = await (await fetch(`${capBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cap_admin', password: 'CapPassword123!' }),
        })).json()
        assert.equal(firstAutoAdmin.ok, true)
        assert.equal(firstAutoAdmin.user.role, 'admin')

        // Fire 4 concurrent open registrations when only 1 daily slot remains -> strictly 1 succeeds, 3 hit 429
        const burstResults = await Promise.all(
          [1, 2, 3, 4].map(async (i) => {
            const r = await fetch(`${capBase}/api/account/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: `cap_user_${i}`, password: 'CapPassword123!' }),
            })
            return { status: r.status, body: await r.json() }
          }),
        )
        const okCount = burstResults.filter((x) => x.status === 200 && x.body.ok === true).length
        const cap429 = burstResults.filter((x) => x.status === 429 && x.body.code === 'DAILY_REGISTRATION_LIMIT')
        assert.equal(okCount, 1, 'Exactly 1 concurrent open registration must fill the last daily slot')
        assert.equal(cap429.length, 3, 'All excess concurrent registrations must fail with 429 DAILY_REGISTRATION_LIMIT')

        const capBootFull = await (await fetch(`${capBase}/api/account/bootstrap-status`)).json()
        assert.equal(capBootFull.dailyRegistrationsUsed, 2)
        assert.equal(capBootFull.dailyRegistrationRemaining, 0)
      } finally {
        await capRelay.close()
      }
    }

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
    pass(1, 'Account bootstrap, open registration, daily cap, multi-tenant isolation, device lifecycle & portable CLI')

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
      assert.equal(statusRes.apps.length, 5)

      const wsRes = await rpc(RPC.WORKSPACES_LIST)
      assert.ok(Array.isArray(wsRes.workspaces))

      const modelsRes = await rpc(RPC.MODELS_LIST)
      for (const app of ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy']) {
        assert.ok(Array.isArray(modelsRes.catalog[app]?.models))
        const appInfo = statusRes.apps.find((a) => a.app === app)
        if (appInfo?.writable || app === 'dsh') {
          assert.ok(modelsRes.catalog[app].models.length > 0)
        }
      }

      const listRes = await rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 40 })
      assert.ok(Array.isArray(listRes.sessions))
      for (const app of ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy']) {
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

      // E2EE RPC.FILE_READ image loading over binary aio-bulk + non-image guardrail
      const filePeer = await cli.connectP2p({ bridgeId: smokeDev.bridgeId, e2eeKey: primaryE2eeKey, roomId: smokeAdmin.roomId })
      const fileRes = await filePeer.sendEncryptedRpc(RPC.FILE_READ, {
        path: 'packages/mobile-app/public/icon-192.png',
        cwd: process.cwd(),
      })
      assert.equal(fileRes.mimeType, 'image/png')
      assert.equal(fileRes.transferMode, 'p2p-bulk')
      assert.equal(fileRes.dataBase64, undefined)
      assert.ok(fileRes.streamId > 0)
      const imgBuf = await filePeer.downloadBulkStream(fileRes.streamId)
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

      // 3e. Malformed HTTP Host crash defense & unauthenticated /api/admin/overview 401
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
      assert.equal((await fetch(`${httpBase}/api/admin/overview`)).status, 401)

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
      const regToctou = await (await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'toctou_u', password: 'InitPassword25!' }),
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
        assert.ok(f instanceof Uint8Array && f.byteLength <= CTRL_FRAG_LIMIT_CHARS)
        reassembled = decCodec.decode(f)
      }
      assert.deepEqual(reassembled, bigCtrl)

      // 4b. Live P2P E2EE enforcement, encrypted streaming events, 5MB PC<->Phone AIO2 bulk & instant revocation
      const p2pDir = join(bridge.orchestrator.inboundDir, 'p2p-bulk-workspace')
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
        const wrongEnc = await encryptBinaryJson(
          generateE2eeKey(),
          { method: RPC.APPS_STATUS, params: {}, cid: 'e2ee-wrong', ts: Date.now() },
          { kind: 'rpc.req', roomId: smokeAdmin.roomId },
        )
        const wrongTry = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-wrong', bin: wrongEnc.bytes })
        assert.equal(wrongTry.error?.code, 'E2EE_KEY_MISMATCH')

        // Valid encrypted FILE_READ + exact ciphertext replay rejection
        const fileReqEnc = await encryptBinaryJson(
          primaryE2eeKey,
          {
            method: RPC.FILE_READ,
            params: { path: 'packages/mobile-app/public/icon-192.png', cwd: process.cwd() },
            cid: 'e2ee-file-1',
            ts: Date.now(),
          },
          { kind: 'rpc.req', roomId: smokeAdmin.roomId },
        )
        const encFileRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-file-1', bin: fileReqEnc.bytes })
        assert.equal(encFileRes.ok, true)
        assert.equal(encFileRes.result, undefined)
        assert.ok(encFileRes.bin instanceof Uint8Array)
        assert.equal(Buffer.from(encFileRes.bin).includes(Buffer.from('image/png')), false)
        const decFileRes = await decryptBinaryJson(primaryE2eeKey, encFileRes.bin, { kind: 'rpc.res', roomId: smokeAdmin.roomId })
        assert.equal(decFileRes.result.mimeType, 'image/png')
        assert.equal(decFileRes.result.transferMode, 'p2p-bulk')

        const replayRes = await peer.sendRawCtrlRpc({ type: 'rpc.req', id: 'e2ee-replay', bin: fileReqEnc.bytes })
        assert.equal(replayRes.error?.code, 'E2EE_REPLAY_DETECTED')

        // Streaming event pushed over P2P aio-ctrl (0 frames via Control Server WS)
        const controlEventsBefore = p2pCli.events.length
        const secretToken = 'ZERO_KNOWLEDGE_SECRET_DELTA_987654'
        bridge.link.pushEvent(EVENTS.STREAM_DELTA, { sessionId: 'codex:s1', delta: secretToken })
        let decEv = null
        for (let i = 0; i < 30 && !decEv; i += 1) {
          for (const e of p2pCli.p2pEvents) {
            if (e.bridgeId !== smokeDev.bridgeId || !e.bin) continue
            try {
              const cand = await decryptBinaryJson(primaryE2eeKey, e.bin, { kind: 'event', roomId: smokeAdmin.roomId })
              if (cand?.event === EVENTS.STREAM_DELTA && cand?.payload?.delta === secretToken) {
                decEv = cand
                break
              }
            } catch {}
          }
          if (!decEv) await new Promise((r) => setTimeout(r, 40))
        }
        assert.ok(decEv, 'Expected encrypted STREAM_DELTA over P2P aio-ctrl')
        assert.equal(p2pCli.events.length, controlEventsBefore, 'Streaming event must not traverse Control WS')
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
          assert.equal((await victimPeer.sendEncryptedRpc(RPC.APPS_STATUS)).apps.length, 5)
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
      const sasV2C = await deriveGrantSas({ requesterPubKey: pairC.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId, requesterNonce: reqNonce1, approverNonce: appNonce1 })
      const sasV2B = await deriveGrantSas({ requesterPubKey: pairC.publicKeyRaw, approverPubKey: pairB.publicKeyRaw, reqId: reqId1, roomId: testRoomId, requesterNonce: reqNonce1, approverNonce: appNonce1 })
      assert.match(sasV2C, /^\d{3}-\d{3}$/)
      assert.equal(sasV2C, sasV2B)

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
        expectedReqId: reqId1,
        expectedApproverPubKey: pairB.publicKeyRaw,
      })
      assert.equal(dec1.keys[0].key, roomKeyA)
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: env1, roomId: testRoomId, expectedReqId: 'deadbeef00000000' }),
        (err) => err?.code === 'E2EE_GRANT_REQID_MISMATCH',
      )
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: env1, roomId: testRoomId, expectedApproverPubKey: pairEvil.publicKeyRaw }),
        /E2EE_GRANT_PUBKEY_MISMATCH|安全码/,
      )
      await assert.rejects(
        () => decryptGrantPayload({ requesterPrivateKey: pairC.privateKey, requesterPubKeyRaw: pairC.publicKeyRaw, envelope: env1, roomId: testRoomId, grantSecret: qrSec1 }),
        /解密授权密钥包失败/,
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
        const liveReqNonce1 = generateGrantNonce()
        const liveCommit1 = await computeGrantCommitment({ reqId: liveReqId1, roomId: smokeAdmin.roomId, pubKey: cPair1.publicKeyRaw, nonce: liveReqNonce1 })
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.req', reqId: liveReqId1, pubKey: cPair1.publicKeyRaw, commit: liveCommit1, wantedKeyId: roomKeyAId }))
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
        phoneB = await openTicketClientWs(httpBase, port, loginData.token, { deviceName: 'iPhone · Safari', clientKind: 'mobile' })
        assert.equal(phoneB.hello.pendingGrants.length, 1)
        assert.equal(phoneB.hello.pendingGrants[0].reqId, liveReqId1)
        assert.equal(phoneB.hello.pendingGrants[0].commit, liveCommit1)

        // Path A: Commit-then-Reveal SAS Push -> Deliver -> Single-use burn
        const bPair1 = await generateGrantKeyPair()
        const liveAppNonce1 = generateGrantNonce()
        phoneB.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId: liveReqId1, approverPubKey: bPair1.publicKeyRaw, approverNonce: liveAppNonce1 }))
        const offerEv = await compC.waitFor((m) => m.event === EVENTS.E2EE_GRANT_OFFER && m.payload?.reqId === liveReqId1)
        assert.equal(offerEv.payload.approverPubKey, bPair1.publicKeyRaw)
        assert.equal(offerEv.payload.approverNonce, liveAppNonce1)
        compC.ws.send(JSON.stringify({ type: 'e2ee.grant.reveal', reqId: liveReqId1, requesterNonce: liveReqNonce1 }))
        const revealEv = await phoneB.waitFor((m) => m.event === EVENTS.E2EE_GRANT_REVEAL && m.payload?.reqId === liveReqId1)
        assert.equal(revealEv.payload.requesterNonce, liveReqNonce1)
        assert.equal(
          await computeGrantCommitment({ reqId: liveReqId1, roomId: smokeAdmin.roomId, pubKey: cPair1.publicKeyRaw, nonce: revealEv.payload.requesterNonce }),
          liveCommit1,
        )

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
          expectedReqId: liveReqId1,
          expectedApproverPubKey: offerEv.payload.approverPubKey,
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
        const liveQrSecret2 = generateGrantSecret()
        const parsedQr2 = parseE2eeGrantQrInput(
          encodeE2eeGrantQrUri({ reqId: liveReqId2, roomId: smokeAdmin.roomId, pubKeyFp: cPair2.publicKeyFp, grantSecret: liveQrSecret2 }),
        )
        assert.equal(parsedQr2.grantSecret, liveQrSecret2)
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
          () => decryptGrantPayload({ requesterPrivateKey: cPair2.privateKey, requesterPubKeyRaw: cPair2.publicKeyRaw, envelope: forgedEnv, roomId: smokeAdmin.roomId, expectedReqId: liveReqId2, grantSecret: liveQrSecret2 }),
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
      const regA = await (await fetch(`${httpBase}/api/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'sess_alice',
          password: 'Password123!',
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
          (await fetch(`${eBase}/api/account/email/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purpose: 'register', email: 'eva@example.com', bootstrapToken: 'WRONG-BOOT' }),
          })).status,
          400,
        )
        assert.equal(smtp.inbox.length, 0)

        // Optional email: bootstrap admin WITHOUT email
        const evaReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'eva', password: 'EvaAdminPassword1!', bootstrapToken: 'email-bootstrap-secret-99' }),
        })).json()
        assert.equal(evaReg.user.email, '')
        assert.equal(evaReg.user.emailVerified, false)

        // Open registration -> SMTP AUTH LOGIN delivery + 429 cooldown + register with verified email
        const regCode = await (await fetch(`${eBase}/api/account/email/send-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose: 'register', email: 'dave@example.com' }),
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
            body: JSON.stringify({ purpose: 'register', email: 'dave@example.com' }),
          })).status,
          429,
        )

        const daveReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.1' },
          body: JSON.stringify({
            username: 'dave',
            password: 'DavePassword123!',
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

        // Post-login email bind + duplicate email rejection + daily registration cap pre-SMTP rejection
        const frankReg = await (await fetch(`${eBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
        })).json()
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
        // Missing or wrong currentPassword must be rejected with 403
        assert.equal(
          (await fetch(`${eBase}/api/account/email/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
            body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode }),
          })).status,
          403,
        )
        assert.equal(
          (await fetch(`${eBase}/api/account/email/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
            body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode, currentPassword: 'WrongPassword!' }),
          })).status,
          403,
        )
        const bindConfirm = await (await fetch(`${eBase}/api/account/email/bind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${frankReg.token}` },
          body: JSON.stringify({ email: 'frank@example.com', code: frankBindCode, currentPassword: 'FrankPassword123!' }),
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
        // Disabling 2FA without currentPassword must be rejected with 403
        assert.equal(
          (await fetch(`${eBase}/api/account/security/2fa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daveNewLogin.token}` },
            body: JSON.stringify({ enabled: false }),
          })).status,
          403,
        )

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
          (await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.77' },
            body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
          })).status,
          429,
        )
        assert.equal(
          (await fetch(`${eBase}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '198.51.100.250' },
            body: JSON.stringify({ username: 'frank', password: 'FrankPassword123!' }),
          })).status,
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
          body: JSON.stringify({ username: 'mon_admin', password: 'Password123!', bootstrapToken: 'mon-owner-secret' }),
        })).json()
        const bobReg = await (await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'mon_bob', password: 'Password123!' }),
        })).json()
        await fetch(`${mBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'mon_carol', password: 'Password123!' }),
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
          body: JSON.stringify({ username: 'stun_admin', password: 'StunPassword123!', bootstrapToken: 'STUN-BOOT-1' }),
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
          body: JSON.stringify({ username: 'quota_admin', password: 'QuotaPassword123!', bootstrapToken: 'QUOTA-BOOT-1' }),
        })).json()
        const qFree = await (await fetch(`${qBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'quota_free', password: 'QuotaPassword123!' }),
        })).json()
        assert.equal(
          (await fetch(`${qBase}/api/admin/users/set-tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${qAdmin.token}` },
            body: JSON.stringify({ userId: qFree.roomId, tier: 'enterprise' }),
          })).status,
          400,
        )

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
          body: JSON.stringify({ username: 'cf_admin', password: 'CfPassword123!', bootstrapToken: 'CF-BOOT-1' }),
        })).json()
        const cfFree = await (await fetch(`${cfBase}/api/account/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'cf_free', password: 'CfPassword123!' }),
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
            body: JSON.stringify({ username: 'fb_admin', password: 'FbPassword123!', bootstrapToken: 'CFB-BOOT-1' }),
          })).json()
          const fbFree = await (await fetch(`${fbBase}/api/account/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'fb_free', password: 'FbPassword123!' }),
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

      // 10b-2. Mobile / Android OTA hot-update checks (remote web hot-reload, Capacitor OTA, staged reuse, minNativeVersion guard & ZIP bundler)
      assert.equal(isHotReloadableWebOrigin({ protocol: 'https:', hostname: '123.206.218.214' }), true)
      assert.equal(isHotReloadableWebOrigin({ protocol: 'https:', hostname: 'localhost' }), false)
      assert.equal(isHotReloadableWebOrigin({ protocol: 'capacitor:', hostname: 'localhost' }), false)
      assert.equal(isHotReloadableWebOrigin({ protocol: 'app:', hostname: 'allinone' }), false)
      assert.equal(
        resolveCurrentAppBaseUrl({ origin: 'https://123.206.218.214', pathname: '/dsh/' }),
        'https://123.206.218.214/dsh',
      )
      assert.equal(
        resolveCurrentAppBaseUrl({ origin: 'https://123.206.218.214', pathname: '/dsh/index.html' }),
        'https://123.206.218.214/dsh',
      )

      // Mode B: Remote-URL WebView APK or Mobile PWA MUST hot-reload in-place (never jump to GitHub download URL)
      {
        let swUpdated = false
        const remoteHot = await checkNativeMobileUpdate({
          currentVersion: '1.0.25',
          baseUrl: 'https://123.206.218.214/dsh',
          token: 'tok-1',
          locationLike: { protocol: 'https:', hostname: '123.206.218.214', origin: 'https://123.206.218.214', pathname: '/dsh/' },
          navigatorLike: {
            serviceWorker: {
              getRegistrations: async () => [{ update: async () => { swUpdated = true }, waiting: null }],
            },
          },
          fetchImpl: async (url) => {
            assert.match(String(url), /^https:\/\/123\.206\.218\.214\/dsh\/api\/health\?_t=/)
            return { ok: true, json: async () => ({ ok: true, version: '1.0.26' }) }
          },
        })
        assert.equal(swUpdated, true)
        assert.equal(remoteHot.status, 'downloaded')
        assert.equal(remoteHot.hotUpdate, true)
        assert.equal(remoteHot.mode, 'web-reload')
        assert.equal(remoteHot.latestVersion, '1.0.26')
        assert.equal(remoteHot.releaseUrl, undefined)
      }

      // Mode A: Bundled-local Capacitor Android APK (`https://localhost`) with native AllinOneUpdater plugin
      {
        const mockSha = 'a'.repeat(64)
        const localLoc = { protocol: 'https:', hostname: 'localhost', origin: 'https://localhost', pathname: '/' }
        const mockFetch = async (url) => {
          const u = String(url)
          if (u.includes('/downloads/ota/All-in-One-WebBundle.json')) {
            return {
              ok: true,
              json: async () => ({
                schema: 1,
                version: '1.0.27',
                minNativeVersion: '1.0.26',
                bundleFile: 'All-in-One-WebBundle.zip',
                sha256: mockSha,
                size: 1_250_000,
                sigAlg: 'SHA256withRSA',
                signature: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
              }),
            }
          }
          if (u.includes('/api/health')) {
            return { ok: true, json: async () => ({ ok: true, version: '1.0.27' }) }
          }
          return {
            ok: true,
            json: async () => ({
              tag_name: 'v1.0.27',
              html_url: 'https://github.com/RainbowLion0320/AllinOne/releases/tag/v1.0.27',
              body: '<!-- android-ota-min-native: 1.0.26 -->',
              assets: [
                {
                  name: 'All-in-One-WebBundle.zip',
                  size: 1_250_000,
                  digest: `sha256:${mockSha}`,
                  browser_download_url: 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-WebBundle.zip',
                },
                {
                  name: 'All-in-One-Android.apk',
                  size: 8_400_000,
                  browser_download_url: 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-Android.apk',
                },
              ],
            }),
          }
        }

        // Prefers signed relay mirror as primary with GitHub fallback when digests match
        const capOta = await checkNativeMobileUpdate({
          currentVersion: '1.0.26',
          nativeVersion: '1.0.26',
          hasNativeOta: true,
          baseUrl: 'https://123.206.218.214/dsh',
          token: 'tok-1',
          locationLike: localLoc,
          fetchImpl: mockFetch,
        })
        assert.equal(capOta.status, 'available')
        assert.equal(capOta.hotUpdate, true)
        assert.equal(capOta.mode, 'capacitor-ota')
        assert.equal(capOta.latestVersion, '1.0.27')
        assert.equal(capOta.downloadUrl, 'https://123.206.218.214/dsh/downloads/ota/All-in-One-WebBundle.zip')
        assert.equal(capOta.fallbackUrl, 'https://github.com/RainbowLion0320/AllinOne/releases/download/v1.0.27/All-in-One-WebBundle.zip')
        assert.equal(capOta.expectedSha256, mockSha)
        assert.equal(capOta.sigAlg, 'SHA256withRSA')

        // Already-staged bundle immediately reports 'downloaded' ready for instant hot restart
        const capStaged = await checkNativeMobileUpdate({
          currentVersion: '1.0.26',
          nativeVersion: '1.0.26',
          stagedVersion: '1.0.27',
          hasNativeOta: true,
          baseUrl: 'https://123.206.218.214/dsh',
          token: 'tok-1',
          locationLike: localLoc,
          fetchImpl: mockFetch,
        })
        assert.equal(capStaged.status, 'downloaded')
        assert.equal(capStaged.hotUpdate, true)
        assert.equal(capStaged.mode, 'capacitor-ota')

        // Enforces minNativeVersion: older native APK shell requires installer upgrade instead of incompatible hot-update
        const capNeedsNative = await checkNativeMobileUpdate({
          currentVersion: '1.0.25',
          nativeVersion: '1.0.25',
          hasNativeOta: true,
          baseUrl: 'https://123.206.218.214/dsh',
          token: 'tok-1',
          locationLike: localLoc,
          fetchImpl: mockFetch,
        })
        assert.equal(capNeedsNative.status, 'available')
        assert.equal(capNeedsNative.hotUpdate, false)
        assert.equal(capNeedsNative.nativeUpgradeRequired, true)
      }

      // Deterministic Android OTA PKZIP packager verification
      {
        const sampleZip = buildZipBuffer([
          { name: 'index.html', data: Buffer.from('<!doctype html><title>OTA</title>') },
          { name: 'assets/app.js', data: Buffer.from('console.log("ok")') },
        ])
        assert.equal(sampleZip.readUInt32LE(0), 0x04034b50) // PKZIP local file header
        assert.equal(sampleZip.readUInt32LE(sampleZip.length - 22), 0x06054b50) // PKZIP EOCD
        assert.equal(
          computeOtaCanonicalPayload({ version: '1.0.26', minNativeVersion: '1.0.26', sha256: 'AB'.repeat(32), size: 42 }),
          `allinone-ota-v1\n1.0.26\n1.0.26\n${'ab'.repeat(32)}\n42`,
        )
        const otaTmpOut = join(tmpDir, 'ota-pack-test')
        const packed = packageAndroidOtaBundle({
          outDir: otaTmpOut,
          version: '1.0.26',
          signWithKeystore: false,
        })
        assert.equal(existsSync(packed.zipPath), true)
        assert.equal(existsSync(packed.manifestPath), true)
        assert.equal(packed.manifest.version, '1.0.26')
        assert.match(packed.manifest.sha256, /^[a-f0-9]{64}$/)
        assert.ok(packed.manifest.size > 1000)
        const actualZipSha = createHash('sha256').update(readFileSync(packed.zipPath)).digest('hex')
        assert.equal(actualZipSha, packed.manifest.sha256)
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
      assert.equal(detectInitialLang(langStorage, { language: 'ja-JP' }), 'en')
      assert.equal(detectInitialLang(langStorage, {}), 'en')
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

      // 11f. Smart sidebar vendor filter bar (activity-sorted top 3 + "..." overflow from 4th vendor)
      const allVendorDefs = [
        { id: 'dsh', label: 'DeepSeek', color: '#4D6BFE' },
        { id: 'codex', label: 'Codex', color: '#6366F1' },
        { id: 'claude', label: 'Claude', color: '#D97757' },
        { id: 'antigravity', label: 'Antigravity', color: '#3186FF' },
        { id: 'workbuddy', label: 'WorkBuddy', color: '#06C798' },
      ]
      const layout5 = computeSidebarVendorLayout({
        vendorTabs: allVendorDefs,
        sessions: [
          { app: 'dsh', updatedAt: 1000 },
          { app: 'workbuddy', updatedAt: 5000, status: 'running' },
          { app: 'codex', updatedAt: 4000 },
          { app: 'antigravity', updatedAt: 3000 },
          { app: 'claude', updatedAt: 2000 },
          { app: 'workbuddy', updatedAt: 1500 },
        ],
        appsStatus: [
          { app: 'codex', available: true, writable: true, quota: { remainingPercent: 45 } },
          { app: 'antigravity', available: true, writable: true, quota: { remainingPercent: 99 } },
          { app: 'dsh', available: true, writable: true },
          { app: 'claude', available: true, writable: true },
          { app: 'workbuddy', available: true, writable: false },
        ],
      })
      assert.equal(layout5.showBar, true)
      assert.deepEqual(layout5.visibleVendors.map((v) => v.id), ['workbuddy', 'codex', 'antigravity'])
      assert.deepEqual(layout5.overflowVendors.map((v) => v.id), ['claude', 'dsh'])
      assert.equal(layout5.visibleVendors[0].sessionCount, 2)
      assert.equal(layout5.visibleVendors[0].hasRunning, true)
      assert.equal(layout5.visibleVendors[1].quota.remainingPercent, 45)

      const layout3 = computeSidebarVendorLayout({
        vendorTabs: allVendorDefs,
        sessions: [
          { app: 'claude', updatedAt: 200 },
          { app: 'codex', updatedAt: 500 },
        ],
        appsStatus: [
          { app: 'workbuddy', available: true, writable: true },
          { app: 'codex', available: true, writable: true },
          { app: 'claude', available: true, writable: true },
        ],
      })
      assert.equal(layout3.showBar, true)
      assert.deepEqual(layout3.visibleVendors.map((v) => v.id), ['codex', 'claude', 'workbuddy'])
      assert.equal(layout3.overflowVendors.length, 0)

      const layout1 = computeSidebarVendorLayout({
        vendorTabs: allVendorDefs,
        sessions: [{ app: 'codex', updatedAt: 100 }],
        appsStatus: [{ app: 'codex', available: true, writable: true, quota: { remainingPercent: 88 } }],
      })
      assert.equal(layout1.showBar, false)
      assert.equal(layout1.soleQuotaTab?.tab?.id, 'codex')
      assert.equal(layout1.soleQuotaTab?.quota?.remainingPercent, 88)

      // Credit-based quota formatting & tooltips (WorkBuddy)
      const wbCreditQuota = {
        windowKind: 'credits',
        remainingPercent: 99,
        creditsRemaining: 791.8,
        creditsTotal: 800,
        planType: '体验版',
        creditGroups: [
          { name: '套餐基础积分', remaining: 491.8, total: 500 },
          { name: '平台奖励积分', remaining: 300, total: 300 },
        ],
      }
      assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: true, lang: 'zh' }), '792')
      assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: false, lang: 'zh' }), '791.8 积分')
      assert.equal(formatQuotaBadgeText(wbCreditQuota, { compact: false, lang: 'zh', showTotal: true }), '791.8 / 800 积分')
      assert.equal(formatQuotaBadgeText({ windowKind: 'credits', creditsRemaining: 1500 }, { compact: true }), '1.5k')
      assert.equal(formatQuotaBadgeText({ windowKind: 'credits', unlimited: true }, { compact: true }), '∞')
      assert.ok(formatQuotaTooltip('WorkBuddy', wbCreditQuota, 'zh').includes('剩余积分 791.8 / 800 (99%)'))
      assert.ok(formatQuotaTooltip('WorkBuddy', wbCreditQuota, 'en').includes('Credits left 791.8 / 800 (99%)'))

      // Home Quota Overview Dashboard (5h short window priority, 7d weekly, credits breakdown & card ordering)
      const nowFixed = 1_795_000_000_000
      assert.equal(formatQuotaResetCountdown(nowFixed + 2 * 3600_000 + 15 * 60_000, { lang: 'zh', now: nowFixed }), '2小时15分后重置')
      assert.equal(formatQuotaResetCountdown(nowFixed + 2 * 3600_000 + 15 * 60_000, { lang: 'en', now: nowFixed }), 'Resets in 2h 15m')
      assert.equal(formatQuotaResetCountdown(nowFixed + 35_000, { lang: 'zh', now: nowFixed }), '即将重置')

      const codexDualDetails = extractVendorQuotaDetails(
        {
          windowKind: 'weekly',
          windowMinutes: 10080,
          remainingPercent: 45,
          usedPercent: 55,
          resetsAt: nowFixed + 3 * 86400_000 + 4 * 3600_000,
          planType: 'plus',
          shortWindow: {
            remainingPercent: 86,
            usedPercent: 14,
            windowMinutes: 300,
            resetsAt: nowFixed + 2 * 3600_000 + 20 * 60_000,
          },
          updatedAt: nowFixed,
        },
        { lang: 'zh', now: nowFixed },
      )
      assert.equal(codexDualDetails?.kind, 'windows')
      assert.equal(codexDualDetails?.planLabel, 'Plus')
      assert.equal(codexDualDetails?.windows.length, 2)
      assert.equal(codexDualDetails?.windows[0].kind, 'short')
      assert.equal(codexDualDetails?.windows[0].label, '5小时额度')
      assert.equal(codexDualDetails?.windows[0].remainingPercent, 86)
      assert.equal(codexDualDetails?.windows[1].kind, 'weekly')
      assert.equal(codexDualDetails?.windows[1].label, '7天周额度')
      assert.equal(codexDualDetails?.windows[1].remainingPercent, 45)
      assert.equal(codexDualDetails?.windows[1].health, 'warning')

      const wbDashDetails = extractVendorQuotaDetails(wbCreditQuota, { lang: 'zh', now: nowFixed })
      assert.equal(wbDashDetails?.kind, 'credits')
      assert.equal(wbDashDetails?.remainingText, '791.8')
      assert.equal(wbDashDetails?.totalText, '800')
      assert.equal(wbDashDetails?.groups.length, 2)

      const homeCards = buildHomeQuotaCards({
        appList: ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy'],
        sessions: [
          { app: 'workbuddy', updatedAt: 500, status: 'running' },
          { app: 'codex', updatedAt: 400, status: 'idle' },
          { app: 'dsh', updatedAt: 900, status: 'idle' },
        ],
        appsStatus: [
          { app: 'dsh', available: true, writable: true, mode: 'dsh-local-ipc' },
          {
            app: 'codex',
            available: true,
            writable: true,
            quota: {
              windowKind: 'weekly',
              remainingPercent: 45,
              shortWindow: { remainingPercent: 86, windowMinutes: 300, resetsAt: nowFixed + 3600_000 },
              resetsAt: nowFixed + 86400_000,
            },
          },
          { app: 'antigravity', available: true, writable: true, quota: { windowKind: 'weekly', remainingPercent: 98, bucketLabel: 'Gemini' } },
          { app: 'workbuddy', available: true, writable: true, quota: wbCreditQuota },
          { app: 'claude', available: false, writable: false },
        ],
        lang: 'zh',
        now: nowFixed,
      })
      assert.deepEqual(homeCards.quotaCards.map((c) => c.app), ['workbuddy', 'codex', 'antigravity'])
      assert.deepEqual(homeCards.otherCards.map((c) => c.app), ['dsh'])
      assert.equal(homeCards.quotaCards[0].runningCount, 1)
    }
    pass(11, 'Frontend guards (React Hooks, i18n parity, deviceStore LRU, scoped sessionCache, drafts & home quota dashboard)')

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
        assert.equal(htmlRes.transferMode, 'p2p-bulk')
        assert.equal(htmlRes.dataBase64, undefined)
        assert.ok(readFileSync(htmlRes._localRealPath, 'utf8').includes('Q4 KPI'))
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
          '3p-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
          '3p-weekly': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
          'gemini-5h': { remaining_fraction: 0.84, reset_time: new Date(Date.now() + 3600_000).toISOString() },
          'gemini-weekly': { remaining_fraction: 0.926, reset_time: futureIso },
        },
      })
      assert.equal(agyQuota.remainingPercent, 93)
      assert.equal(agyQuota.bucketLabel, 'Gemini')
      assert.equal(agyQuota.shortWindow?.remainingPercent, 84)
      assert.equal(agyQuota.pools?.length, 2)
      assert.equal(agyQuota.pools[0].id, 'gemini')
      assert.equal(agyQuota.pools[1].id, '3p')
      assert.equal(agyQuota.pools[1].windows.length, 2)
      assert.equal(agyQuota.pools[1].windows[0].remainingPercent, 100)
      assert.equal(agyQuota.pools[1].windows[0].resetsAt, 0)
      const agy3pOnly = normalizeAntigravityQuota({ quota: { '3p-weekly': { remaining_fraction: 0.5 } } })
      assert.equal(agy3pOnly?.remainingPercent, 50)
      assert.equal(agy3pOnly?.pools?.[0]?.id, '3p')
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
      const proQ = normalizeCodexQuota({
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: futureSec },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: '40189.1284' },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [{ status: 'available', expiresAt: futureSec }],
        },
      })
      assert.equal(proQ.remainingPercent, 82)
      assert.equal(proQ.extraCredits?.balance, 40189.1)
      assert.equal(proQ.resetCredits?.availableCount, 2)
      const proDash = extractVendorQuotaDetails(proQ, { lang: 'zh' })
      assert.equal(proDash?.extraCredits?.balanceText, '40,189')
      assert.equal(proDash?.resetCredits?.availableCount, 2)
      const agyMultiDash = extractVendorQuotaDetails(agyQuota, { lang: 'zh' })
      assert.equal(agyMultiDash?.hasMultiPool, true)
      assert.equal(agyMultiDash?.pools?.length, 2)
      assert.equal(agyMultiDash?.pools[0].label, 'Gemini 模型')
      assert.equal(agyMultiDash?.pools[1].label, 'Claude / GPT 模型')
      assert.equal(agyMultiDash?.pools[1].badge, '含赠送')
      assert.equal(agyMultiDash?.pools[0].windows[0].shortLabel, '5小时')
      assert.equal(agyMultiDash?.pools[0].windows[1].shortLabel, '7天')
      const homeQuotaSrc = readFileSync(join(process.cwd(), 'packages/mobile-app/src/components/HomeQuotaDashboard.jsx'), 'utf8')
      assert.ok(homeQuotaSrc.includes('ConcentricQuotaRings') && homeQuotaSrc.includes('splitOuterInnerWindows'))

      // DeepSeek Harness official balance normalization, .credentials.yaml parser & dashboard rendering
      const fakeDshHome = join(tmpDir, 'fake-dsh-balance-home')
      mkdirSync(fakeDshHome, { recursive: true })
      writeFileSync(
        join(fakeDshHome, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-test-deepseek-key-1234567890\nrecords:\n  other: foo\n',
        'utf8',
      )
      assert.equal(readDshDeepseekApiKey({ dshHome: fakeDshHome, env: {} }), 'sk-test-deepseek-key-1234567890')
      const dshBal = normalizeDeepseekBalanceQuota({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '84.30', granted_balance: '0.00', topped_up_balance: '84.30' },
        ],
      })
      assert.equal(dshBal?.windowKind, 'balance')
      assert.equal(dshBal?.balanceTotal, 84.3)
      assert.equal(dshBal?.currencySymbol, '¥')
      assert.equal(formatQuotaBadgeText(dshBal, { compact: true, lang: 'zh' }), '¥84')
      assert.equal(formatQuotaBadgeText(dshBal, { compact: false, lang: 'zh' }), '¥84.30')
      assert.ok(formatQuotaTooltip('DeepSeek', dshBal, 'zh').includes('余额 ¥84.30'))
      const dshDash = extractVendorQuotaDetails(dshBal, { lang: 'zh' })
      assert.equal(dshDash?.kind, 'balance')
      assert.equal(dshDash?.totalText, '¥84.30')
      assert.equal(dshDash?.toppedUpText, '¥84.30')
      assert.equal(dshDash?.health, 'healthy')
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
      agyTracker.applyAntigravityAcpUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Design', status: 'completed' }, { content: 'UI', status: 'completed' }] }, 400)
      agyTracker.applyAntigravityUserText('Thanks, next question', 500)
      assert.equal(agyTracker.snapshot(), null)

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

    // =========================================================================
    // 17. Audit Regression Guards (Security, Proxy, P2P, Relay, Caches & Mobile)
    // =========================================================================
    {
      // 17a. Child env secret scrubbing
      const scrubbed = sanitizeChildEnv({
        PATH: '/usr/bin',
        ALLINONE_E2EE_KEY: 'secret-e2ee',
        ALLINONE_BRIDGE_SECRET: 'secret-bridge',
        ALLINONE_WEBRTC_PROXY_PORT: '12345',
        ALLINONE_WEBRTC_PROXY_TOKEN: 'secret-proxy',
        ALLINONE_PASSWORD: 'secret-password',
        ELECTRON_RUN_AS_NODE: '1',
      })
      assert.equal(scrubbed.PATH, '/usr/bin')
      for (const k of ['ALLINONE_E2EE_KEY', 'ALLINONE_BRIDGE_SECRET', 'ALLINONE_WEBRTC_PROXY_PORT', 'ALLINONE_WEBRTC_PROXY_TOKEN', 'ALLINONE_PASSWORD', 'ELECTRON_RUN_AS_NODE']) {
        assert.equal(scrubbed[k], undefined, `sanitizeChildEnv must remove ${k}`)
      }

      // 17b. readLocalFile blocks caller-supplied cwd='/' escape, .allinone-bridge & image-mode secrets
      const aclRoot = join(tmpDir, 'acl-guard')
      const safeDir = join(aclRoot, 'project')
      const bridgeSecretDir = join(aclRoot, '.allinone-bridge')
      mkdirSync(safeDir, { recursive: true })
      mkdirSync(bridgeSecretDir, { recursive: true })
      const leakedHtml = join(bridgeSecretDir, 'e2ee-key.html')
      writeFileSync(leakedHtml, '<html>KEY</html>', 'utf8')
      const secretImg = join(bridgeSecretDir, 'qr.png')
      writeFileSync(secretImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      const outsideMd = join(process.cwd(), 'README.md')
      const aclOrch = new MultiAppOrchestrator({ config: { cwd: safeDir }, log: { info() {}, warn() {}, error() {} } })
      aclOrch.listWorkspaces = async () => [{ path: safeDir }]
      await assert.rejects(() => aclOrch.readLocalFile({ path: leakedHtml, cwd: bridgeSecretDir, mode: 'document' }), /敏感目录|凭据/)
      await assert.rejects(() => aclOrch.readLocalFile({ path: secretImg, cwd: bridgeSecretDir, mode: 'image' }), /敏感目录|凭据/)
      await assert.rejects(() => aclOrch.readLocalFile({ path: outsideMd, cwd: '/', mode: 'document' }), /仅允许远程下载/)
      await aclOrch.dispose()

      // 17c. createCtrlCodec binary byte budget on CJK & double-escaped JSON + decryptChunkedStream trailing-data fail-fast
      const utf8Codec = createCtrlCodec()
      const cjkPayload = { type: 'test', body: '中文测试"quoted"\\slash\n'.repeat(3000) }
      const cjkFrames = utf8Codec.encode(cjkPayload)
      assert.ok(cjkFrames.length >= 2, 'Large CJK payload must be fragmented')
      for (const f of cjkFrames) {
        assert.ok(f instanceof Uint8Array && f.byteLength <= CTRL_FRAG_LIMIT_CHARS, 'Every control fragment must be <= 48KB binary bytes')
      }
      let decodedCjk = null
      for (const f of cjkFrames) decodedCjk = utf8Codec.decode(f)
      assert.deepEqual(decodedCjk, cjkPayload)

      const trailKey = generateE2eeKey()
      const encChunks = []
      let encHdr = null
      await encryptChunkedBytes(trailKey, new TextEncoder().encode('hello-aio2'), {
        kind: 'upload',
        roomId: 'usr_trail',
        onHeader: (h) => { encHdr = h },
        onChunk: (c) => { encChunks.push(c) },
      })
      let yieldedAfterGarbage = false
      async function* garbageStream() {
        for (const c of encChunks) yield c
        yield new Uint8Array([1, 2, 3, 4])
        yieldedAfterGarbage = true
        yield new Uint8Array([5, 6, 7, 8])
      }
      await assert.rejects(
        () => decryptChunkedStream(trailKey, garbageStream(), { iv: encHdr.iv, kid: encHdr.kid, kind: 'upload', roomId: 'usr_trail' }),
        (err) => err?.code === 'E2EE_DECRYPT_FAILED',
      )
      assert.equal(yieldedAfterGarbage, false, 'decryptChunkedStream must fail fast on trailing bytes without buffering until EOF')

      // 17d. DesktopWebRtcProxy: peer.close when idle must NOT cold-start worker; closing last peer must keep idleTimer armed
      let idleProxyWinCreates = 0
      const idleIpc = new EventEmitter()
      class IdleTestWin extends EventEmitter {
        constructor() {
          super()
          idleProxyWinCreates += 1
          this._destroyed = false
          this.webContents = Object.assign(new EventEmitter(), {
            send: (_ch, msg) => {
              if (msg?.type === 'peer.offer' && msg?.reqId) {
                setImmediate(() => idleIpc.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'res', reqId: msg.reqId, ok: true, answer: { type: 'answer', sdp: 'v=0\r\n' } }))
              }
            },
          })
        }
        isDestroyed() { return this._destroyed }
        destroy() { if (!this._destroyed) { this._destroyed = true; this.emit('closed') } }
        async loadFile() {
          setImmediate(() => { if (!this._destroyed) idleIpc.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'worker.ready' }) })
        }
      }
      const idleProxy = new DesktopWebRtcProxy({ BrowserWindow: IdleTestWin, ipcMain: idleIpc, srcDir: join(process.cwd(), 'packages/desktop-app/src'), log: { info() {}, warn() {}, error() {} } })
      const { port: ipPort, token: ipToken } = await idleProxy.start()
      try {
        const ipClient = new ElectronWebRtcClient({ port: ipPort, token: ipToken, log: { info() {}, warn() {}, error() {} } })
        await ipClient.sendCommand({ type: 'peer.close', peerId: 'ghost' }, false)
        await ipClient.sendCommand({ type: 'peer.closeAll' }, false)
        await new Promise((r) => setTimeout(r, 40))
        assert.equal(idleProxyWinCreates, 0, 'peer.close/closeAll when idle must never cold-start Chromium worker')
        const p1 = ipClient.createPeer({ iceServers: [] })
        await p1.handleOffer('v=0\r\n')
        assert.equal(idleProxyWinCreates, 1)
        await p1.close()
        await new Promise((r) => setTimeout(r, 40))
        assert.ok(idleProxy.idleTimer, 'Closing last peer must keep idleTimer armed')
        ipClient.dispose()
      } finally {
        await idleProxy.dispose()
      }

      // 17e. Relay: IPv6 single-bracket STUN, URL-decoded spaces static download, aborted WS upgrade survival & empty RESEND_FROM fallback
      const regStaticDir = join(tmpDir, 'static-spaces')
      mkdirSync(join(regStaticDir, 'downloads'), { recursive: true })
      writeFileSync(join(regStaticDir, 'downloads', 'All in One-1.0.13.dmg'), 'dmg-bytes', 'utf8')
      const ipv6Relay = createRelayServer({
        port: 0,
        host: '127.0.0.1',
        stunPort: 0,
        stunHost: '127.0.0.1',
        jwtSecret: 'ipv6-test-secret-0123456789',
        publicRelayUrl: 'https://[2001:db8::1]:8787',
        staticDir: regStaticDir,
        accountsFile: join(tmpDir, 'ipv6-accounts.json'),
      })
      const ipv6Started = await ipv6Relay.start()
      try {
        const dmgRes = await fetch(`http://127.0.0.1:${ipv6Started.port}/downloads/All%20in%20One-1.0.13.dmg`)
        assert.equal(dmgRes.status, 200, 'Static download with URL-encoded spaces must succeed')
        assert.equal(await dmgRes.text(), 'dmg-bytes')

        // Trigger aborted WS upgrade to verify no uncaught socket 'error' crash
        await new Promise((resolveSock) => {
          const s = net.connect(ipv6Started.port, '127.0.0.1', () => {
            s.write('GET /ws/client?ticket=bad HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
            s.resetAndDestroy?.() || s.destroy()
            setTimeout(resolveSock, 40)
          })
          s.on('error', () => resolveSock())
        })
        assert.equal((await (await fetch(`http://127.0.0.1:${ipv6Started.port}/api/health`)).json()).ok, true)

        const iceList = ipv6Relay.hub.getIceServers(null, '')
        assert.ok(iceList.some((x) => String(x.urls).startsWith('stun:[2001:db8::1]:')), 'IPv6 STUN URI must use single brackets')
        assert.ok(!iceList.some((x) => String(x.urls).includes('[[')), 'IPv6 STUN URI must never double-bracket')
      } finally {
        await ipv6Relay.close()
      }

      const prevResendFrom = process.env.RESEND_FROM
      const prevSmtpFrom = process.env.SMTP_FROM
      const prevResendKey = process.env.RESEND_API_KEY
      try {
        process.env.RESEND_API_KEY = 're_test_key'
        process.env.RESEND_FROM = ''
        process.env.SMTP_FROM = 'AllinOne <noreply@example.com>'
        const fallbackMailer = createMailer({})
        assert.equal(fallbackMailer.getProvider(), 'resend', 'Empty RESEND_FROM env must fall back to SMTP_FROM')
      } finally {
        if (prevResendFrom === undefined) delete process.env.RESEND_FROM
        else process.env.RESEND_FROM = prevResendFrom
        if (prevSmtpFrom === undefined) delete process.env.SMTP_FROM
        else process.env.SMTP_FROM = prevSmtpFrom
        if (prevResendKey === undefined) delete process.env.RESEND_API_KEY
        else process.env.RESEND_API_KEY = prevResendKey
      }

      // 17f. P2PBridgeManager sid-based revocation kills peer even when clientId changed
      const sidMgr = new P2PBridgeManager({
        roomId: 'usr_sid_test',
        e2eeKey: generateE2eeKey(),
        getE2eeKeyId: async () => '0000000000000000',
        sendSignal: () => {},
        onRpc: async () => ({}),
        inboundDir: tmpDir,
        log: { info() {}, warn() {}, error() {} },
      })
      let peerClosedBySid = false
      sidMgr.sessions.set('old-client-id', {
        clientId: 'old-client-id',
        authSid: 's_1122334455667788',
        sessionId: 'ps1',
        closed: false,
        activeDownloads: new Map(),
        pendingDownloads: new Map(),
        activeUploads: new Map(),
        peer: { close: async () => { peerClosedBySid = true } },
      })
      sidMgr.revokeClients(['new-client-id-after-ws-reconnect'], { sids: ['s_1122334455667788'] })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(peerClosedBySid, true, 'Revoking by auth sid must kill live P2P peer even after clientId rotation')
      await sidMgr.dispose()

      // 17g. Frontend caches, image extractor, multi-turn Claude TaskCreate & Claude agent-* filter
      await saveCachedSession(
        'codex:capped-meta',
        {
          meta: { app: 'codex', id: 'codex:capped-meta', messages: [{ id: 'dup', role: 'user', text: 'dup' }] },
          messages: Array.from({ length: 130 }, (_, idx) => ({ id: `k-${idx}`, role: 'user', text: `t${idx}`, ts: idx + 1 })),
          hasMore: true,
          nextCursor: 'opaque-1',
        },
        'scope-cap',
      )
      const capRec = await loadCachedSession('codex:capped-meta', 'scope-cap')
      assert.equal(capRec.meta.messages, undefined, 'saveCachedSession must strip meta.messages')
      assert.equal(capRec.truncatedByCap, true)
      const capReconciled = reconcileCachedWithFreshPage(capRec, {
        messages: capRec.messages.slice(-14),
        hasMore: true,
        nextCursor: 'opaque-fresh-2',
      })
      assert.equal(capReconciled.hasMore, true, 'Capped Codex cache must not swallow server hasMore=true')
      assert.equal(capReconciled.nextCursor, 'opaque-fresh-2')

      const imgExtracted = extractImageRefsFromText('See https://example.com/chart.png and file:///Users/alice/out.png')
      assert.equal(imgExtracted.some((r) => r.raw === 's://example.com/chart.png'), false, 'Must not misparse https:// as Windows s:// drive')
      assert.equal(imgExtracted.some((r) => r.raw === 'e:///Users/alice/out.png'), false, 'Must not double-match file:/// as Windows e:/// drive')
      assert.equal(imgExtracted.length, 1)

      const mtClaude = createTaskStateTracker({ steps: [{ id: '1', title: 'Turn 1 A', status: 'done' }, { id: '2', title: 'Turn 1 B', status: 'done' }] })
      mtClaude.applyClaudeTool('TaskCreate', { subject: 'Turn 2 New' }, 50)
      assert.equal(mtClaude.snapshot().steps.length, 3)
      assert.equal(mtClaude.snapshot().steps[2].id, '3', 'Multi-turn TaskCreate must continue sequence without overwriting id 1')
      const stickyAgy = createTaskStateTracker({ mode: 'plan', steps: [] })
      stickyAgy.applyAntigravityUserText('Normal follow-up message', 100)
      assert.equal(stickyAgy.snapshot(), null, 'Normal user turn must clear sticky plan mode with no pending steps')

      const agFilterHome = join(tmpDir, 'claude-agent-filter')
      const agProj = join(agFilterHome, 'projects', 'p1')
      mkdirSync(agProj, { recursive: true })
      for (let i = 0; i < 25; i += 1) {
        writeFileSync(join(agProj, `agent-sub-${i}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `a${i}`, cwd: tmpDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'subagent' } })}\n`)
      }
      writeFileSync(join(agProj, '11111111-2222-3333-4444-555555555555.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'real1', cwd: tmpDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Real user chat' } })}\n`)
      const agAdapter = new ClaudeAdapter({ config: { claudeHome: agFilterHome, claudeDesktopRoots: [], cwd: tmpDir } })
      const agListed = await agAdapter.listSessions({ limit: 20 })
      assert.equal(agListed.length, 1)
      assert.equal(agListed[0].nativeId, '11111111-2222-3333-4444-555555555555')
      assert.ok(agAdapter.trackedListSessions.has('11111111-2222-3333-4444-555555555555'), 'Real session must stay tracked despite >20 agent-*.jsonl files')
      await agAdapter.dispose()

      // 17h. Mobile Capacitor config, Android manifest & sandbox-preview meta CSP
      const capCfg = JSON.parse(readFileSync(join(process.cwd(), 'packages/mobile-app/capacitor.config.json'), 'utf8'))
      assert.equal(capCfg.server?.url, undefined, 'capacitor.config.json must not hardcode placeholder server.url')
      assert.equal(capCfg.android?.adjustMarginsForEdgeToEdge, 'auto')
      const manifestXml = readFileSync(join(process.cwd(), 'packages/mobile-app/android/app/src/main/AndroidManifest.xml'), 'utf8')
      assert.ok(manifestXml.includes('android.permission.ACCESS_NETWORK_STATE'))
      const sandboxHtml = readFileSync(join(process.cwd(), 'packages/mobile-app/public/sandbox-preview.html'), 'utf8')
      assert.ok(sandboxHtml.includes("connect-src 'none'") && sandboxHtml.includes("form-action 'none'"))

      // 17i. Header workspace isolation (no draft fallback when session open), adapter workspace fields & effort slider guard
      const appSrc = readFileSync(join(process.cwd(), 'packages/mobile-app/src/App.jsx'), 'utf8').replace(/\r\n/g, '\n')
      assert.ok(
        appSrc.includes("activeSession\n    ? (activeSession.workspace || '')"),
        'Header currentWorkspaceLabel must strictly read activeSession.workspace when open without falling back to draft workspace',
      )
      for (const adapterFile of ['antigravity.js', 'codex.js', 'dsh.js']) {
        const src = readFileSync(join(process.cwd(), 'packages/dsh-mobile-hub/src/adapters', adapterFile), 'utf8')
        const readBlock = src.slice(src.indexOf('async readSession('))
        assert.ok(readBlock.includes('workspace'), `${adapterFile} readSession must return workspace`)
      }
      const pickerSrc = readFileSync(join(process.cwd(), 'packages/mobile-app/src/components/ModelPickerSheet.jsx'), 'utf8')
      assert.ok(pickerSrc.includes('role="slider"') && pickerSrc.includes('ReasoningEffortSlider'))

      // 17j. Bandwidth optimizations: deflate-raw + binary ctrl framing, zip-bomb cap, 60ms delta coalescing,
      //      SESSION_READ/MODELS_LIST ETag short-circuits, conditional aio-bulk compression & image compress guards
      const bwKey = generateE2eeKey()
      const largeJson = {
        messages: Array.from({ length: 40 }, (_, i) => ({
          id: `m-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: 'All in One WebRTC E2EE compressed payload test — 端到端加密传输压缩测试内容。'.repeat(6),
        })),
      }
      const rawJsonBytes = Buffer.byteLength(JSON.stringify(largeJson), 'utf8')
      const binEnc = await encryptBinaryJson(bwKey, largeJson, { kind: 'rpc.res', roomId: 'usr_bw' })
      assert.ok(binEnc.bytes.byteLength < rawJsonBytes * 0.25, `Binary deflate-raw E2EE must cut repetitive JSON >=75% (got ${binEnc.bytes.byteLength} vs ${rawJsonBytes})`)
      const binDec = await decryptBinaryJson(bwKey, binEnc.bytes, { kind: 'rpc.res', roomId: 'usr_bw' })
      assert.deepEqual(binDec, largeJson)

      // Zip-bomb decompression cap must reject payloads expanding beyond maxBytes
      const bombRaw = new Uint8Array(64 * 1024)
      const bombCompressed = await deflateRawBytes(bombRaw)
      assert.ok(bombCompressed.byteLength < 1024)
      await assert.rejects(
        () => inflateRawBytes(bombCompressed, 8 * 1024),
        (err) => err?.code === 'E2EE_DECRYPT_FAILED',
      )

      // 60ms delta coalescing merges bursts and flushes immediately before STREAM_DONE
      const coalKey = generateE2eeKey()
      const coalMgr = new P2PBridgeManager({
        roomId: 'usr_coal',
        e2eeKey: coalKey,
        getE2eeKeyId: async () => computeE2eeKeyId(coalKey),
        sendSignal: () => {},
        onRpc: async () => ({}),
        inboundDir: tmpDir,
        log: { info() {}, warn() {}, error() {} },
      })
      const coalCodec = createCtrlCodec()
      const capturedCtrlFrames = []
      coalMgr.sessions.set('c-coal', {
        clientId: 'c-coal',
        sessionId: 's-coal',
        closed: false,
        ctrlCodec: createCtrlCodec(),
        activeDownloads: new Map(),
        pendingDownloads: new Map(),
        activeUploads: new Map(),
        peer: {
          isCtrlOpen: () => true,
          sendCtrl: (frame) => {
            const decoded = coalCodec.decode(frame)
            if (decoded) capturedCtrlFrames.push(decoded)
            return true
          },
          close: async () => {},
        },
      })
      for (let i = 0; i < 10; i += 1) {
        coalMgr.broadcastEvent(EVENTS.STREAM_DELTA, { sessionId: 'codex:c1', delta: `t${i}-` })
      }
      coalMgr.broadcastEvent(EVENTS.STREAM_DONE, { sessionId: 'codex:c1', finalText: 'done' })
      await coalMgr._eventQueue
      assert.equal(capturedCtrlFrames.length, 2, '10 rapid deltas + STREAM_DONE must coalesce into exactly 2 frames')
      const ev0 = await decryptBinaryJson(coalKey, capturedCtrlFrames[0].bin, { kind: 'event', roomId: 'usr_coal' })
      const ev1 = await decryptBinaryJson(coalKey, capturedCtrlFrames[1].bin, { kind: 'event', roomId: 'usr_coal' })
      assert.equal(ev0.event, EVENTS.STREAM_DELTA)
      assert.equal(ev0.payload.delta, 't0-t1-t2-t3-t4-t5-t6-t7-t8-t9-')
      assert.equal(ev1.event, EVENTS.STREAM_DONE)
      await coalMgr.dispose()

      // SESSION_READ & MODELS_LIST ETag short-circuits
      const etagOrch = new MultiAppOrchestrator({ config: { cwd: tmpDir }, log: { info() {}, warn() {}, error() {} } })
      let mockMsgText = 'hello-v1'
      etagOrch.readSession = async () => ({
        id: 'codex:e1',
        app: 'codex',
        title: 'ETag Test',
        cwd: tmpDir,
        workspace: 'tmp',
        status: 'idle',
        hasMore: false,
        nextCursor: null,
        totalCount: 1,
        messages: [{ id: 'm1', role: 'user', text: mockMsgText }],
      })
      etagOrch.listModels = async () => ({ codex: { defaultModel: 'gpt-5', models: [{ id: 'gpt-5' }] } })
      const sr1 = await etagOrch.handleRpc(RPC.SESSION_READ, { id: 'codex:e1', limit: 14 })
      assert.ok(sr1.etag && sr1.session?.etag === sr1.etag)
      const sr2 = await etagOrch.handleRpc(RPC.SESSION_READ, { id: 'codex:e1', limit: 14, etag: sr1.etag })
      assert.deepEqual(sr2, { unchanged: true, etag: sr1.etag })
      mockMsgText = 'hello-v2'
      const sr3 = await etagOrch.handleRpc(RPC.SESSION_READ, { id: 'codex:e1', limit: 14, etag: sr1.etag })
      assert.equal(sr3.unchanged, undefined)
      assert.notEqual(sr3.etag, sr1.etag)
      assert.equal(sr3.session.messages[0].text, 'hello-v2')

      const ml1 = await etagOrch.handleRpc(RPC.MODELS_LIST, {})
      assert.ok(ml1.etag && ml1.catalog?.codex)
      const ml2 = await etagOrch.handleRpc(RPC.MODELS_LIST, { etag: ml1.etag })
      assert.deepEqual(ml2, { unchanged: true, etag: ml1.etag })
      await etagOrch.dispose()

      // Conditional aio-bulk compression: compressible HTML shrinks >75%, JPEG/PNG skipped
      assert.equal(isCompressibleFile('text/html; charset=utf-8', 'report.html'), true)
      assert.equal(isCompressibleFile('text/markdown', 'README.md'), true)
      assert.equal(isCompressibleFile('image/jpeg', 'photo.jpg'), false)
      assert.equal(isCompressibleFile('image/png', 'screen.png'), false)
      assert.equal(isCompressibleFile('application/zip', 'archive.zip'), false)
      const bigHtmlBytes = new TextEncoder().encode(`<!doctype html><html><body>${'<section><p>AllinOne Report Row</p></section>\n'.repeat(4000)}</body></html>`)
      const compEnc = await encryptChunkedBytes(bwKey, bigHtmlBytes, { kind: 'upload', roomId: 'usr_bw', compress: true })
      assert.equal(compEnc.compressed, true)
      assert.ok(compEnc.totalBytes < bigHtmlBytes.byteLength * 0.1, `Compressed AIO2 HTML must shrink >90% (got ${compEnc.totalBytes} vs ${bigHtmlBytes.byteLength})`)
      const compPlain = await decryptAutoStream(bwKey, Buffer.concat(compEnc.chunks.map((c) => Buffer.from(c))), {
        iv: compEnc.iv,
        kid: compEnc.kid,
        kind: 'upload',
        roomId: 'usr_bw',
        chunked: true,
        compressed: true,
      })
      assert.equal(Buffer.concat(compPlain.chunks.map((c) => Buffer.from(c))).equals(Buffer.from(bigHtmlBytes)), true)

      // Smart image upload compression guards
      assert.equal(shouldAttemptImageCompress({ type: 'image/jpeg', name: 'big.jpg', size: 3 * 1024 * 1024 }), true)
      assert.equal(shouldAttemptImageCompress({ type: 'image/gif', name: 'anim.gif', size: 2 * 1024 * 1024 }), false)
      assert.equal(shouldAttemptImageCompress({ type: 'image/svg+xml', name: 'vec.svg', size: 500 * 1024 }), false)
      assert.equal(shouldAttemptImageCompress({ type: 'image/png', name: 'tiny.png', size: 80 * 1024 }), false)
      assert.deepEqual(computeResizedDimensions(4032, 3024, 2048), { width: 2048, height: 1536, resized: true })
      assert.deepEqual(computeResizedDimensions(1200, 900, 2048), { width: 1200, height: 900, resized: false })
      assert.equal(replaceFileExtension('IMG_1234.HEIC', '.webp'), 'IMG_1234.webp')

      // v1.0.20 P0/P1 security audit regression guards:
      // 1) Object.prototype pollution blocked in admin-monitor even with crafted __proto__ app entry
      const protoBefore = ({}).available
      const ov = buildAdminOverview({
        hub: {
          getAllBridges: () => [
            {
              roomId: 'usr_evil',
              bridgeId: 'evil-pc',
              online: true,
              platform: 'linux',
              apps: [{ app: '__proto__', available: true, writable: true }, { app: 'codex', available: true, writable: true }],
            },
          ],
          getAllClients: () => [],
          getMetricsSummary: () => ({ onlineBridgeCount: 1, onlineClientCount: 0, totalSignals: 0, totalBridgeConnects: 1, totalClientConnects: 0 }),
          getActivityLog: () => [],
        },
        accounts: {
          listUsersForAdmin: () => [],
          getDailyRegistrationStats: () => ({ date: '2026-11-26', used: 0, limit: 20, remaining: 20, exceeded: false }),
        },
        serverHealth: { ok: true },
      })
      assert.equal(({}).available, protoBefore, 'Object.prototype must never be polluted by bridge.meta.apps')
      assert.equal(ov.distributions.apps.codex?.writable, 1)

      // 2) aio-ctrl type-confusion OOM guard: encode rejects numeric bin, raw wire JSON "bin" without trailer stripped & parseBinaryE2eeHeader rejects numbers
      const tcCodec = createCtrlCodec()
      assert.throws(() => tcCodec.encode({ type: 'rpc.req', id: 'tc-1', bin: 1073741824 }), TypeError)
      const validSinglePrefix = tcCodec.encode({ ok: 1 })[0].subarray(0, 4)
      const evilMetaBytes = new TextEncoder().encode(JSON.stringify({ type: 'rpc.req', id: 'tc-1', bin: 1073741824 }))
      const evilWire = new Uint8Array(4 + 4 + evilMetaBytes.byteLength)
      evilWire.set(validSinglePrefix, 0)
      new DataView(evilWire.buffer).setUint32(4, evilMetaBytes.byteLength, false)
      evilWire.set(evilMetaBytes, 8)
      const tcDecoded = tcCodec.decode(evilWire)
      assert.equal(tcDecoded.bin, undefined, 'JSON numeric "bin" without binary trailer must be stripped')
      assert.equal(parseBinaryE2eeHeader(1073741824), null, 'parseBinaryE2eeHeader must reject numeric inputs without allocating')

      // 3) RPC.SESSION_SEND strips attacker-injected _preMaterialized / _burnedTokens internal fields
      const secOrch = new MultiAppOrchestrator({ config: { cwd: tmpDir }, log: { info() {}, warn() {}, error() {} } })
      let capturedInternalOpts = null
      secOrch.sendMessage = async (pubParams, internalOpts) => {
        capturedInternalOpts = { pubParams, internalOpts }
        return { ok: true, sessionId: 'codex:sec1' }
      }
      await secOrch.handleRpc(
        RPC.SESSION_SEND,
        {
          app: 'codex',
          sessionId: 'codex:sec1',
          text: 'hi',
          wait: true,
          _preMaterialized: [{ localPath: '/etc/passwd', mimeType: 'image/png', filename: 'x.png' }],
          _burnedTokens: [{ token: 'p2p_evil', rec: { localPath: '/etc/passwd' } }],
        },
        { clientId: 'cli-1' },
      )
      assert.equal(capturedInternalOpts.pubParams._preMaterialized, undefined)
      assert.equal(capturedInternalOpts.pubParams._burnedTokens, undefined)
      assert.equal(capturedInternalOpts.internalOpts.clientId, 'cli-1')
      await secOrch.dispose()

      // 4) Remote revocation credential wipe helper clears token & e2eeKeys while keeping account entry
      const revUp = upsertDevice(
        { devices: [], activeDeviceId: null },
        { baseUrl: 'https://relay.example.com', token: 'tok-secret', roomId: 'usr_rev', username: 'alice' },
      )
      const revDevId = revUp.device.id
      const revStateWithKey = upsertDeviceE2eeKey(revUp.state, revDevId, '0123456789abcdef', generateE2eeKey())
      const wipedState = clearDeviceCredentials(revStateWithKey, revDevId)
      const wipedDev = wipedState.devices.find((d) => d.id === revDevId)
      assert.equal(wipedDev.token, '')
      assert.deepEqual(wipedDev.e2eeKeys, {})
      assert.equal(wipedDev.e2eeKey, '')
      assert.equal(wipedDev.username, 'alice')

      // 5) Markdown external image SSRF / SVG data URI defenses
      assert.equal(isExternalHttpImageUrl('https://cdn.example.com/pic.png'), true)
      assert.equal(isExternalHttpImageUrl('blob:https://app.example.com/123'), false)
      assert.equal(isPrivateOrLoopbackUrl('http://127.0.0.1:8787/secret'), true)
      assert.equal(isPrivateOrLoopbackUrl('https://192.168.1.5/admin.png'), true)
      assert.equal(isPrivateOrLoopbackUrl('https://[::ffff:127.0.0.1]/x.png'), true)
      assert.equal(isPrivateOrLoopbackUrl('https://cdn.example.com/ok.png'), false)
      assert.equal(resolveImageSrc('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), '')

      // 6) Electron setWindowOpenHandler must not check non-existent details.frameOrigin (which blocked all target="_blank" links)
      const desktopMainSrc = readFileSync(join(process.cwd(), 'packages/desktop-app/src/main.js'), 'utf8')
      assert.equal(desktopMainSrc.includes('details?.frameOrigin'), false, 'Electron HandlerDetails has no frameOrigin property')
      assert.equal(desktopMainSrc.includes('UPDATE_POLL_INTERVAL_MS'), true, 'Desktop updater must schedule periodic checks')
      assert.equal(compareMobileSemver('1.0.21', '1.0.20'), 1)
      assert.equal(compareMobileSemver('1.0.20', '1.0.20'), 0)
      assert.equal(compareMobileSemver('1.0.19', '1.0.20'), -1)

      // 7) FILE_READ recognizes authoritative Codex/Antigravity/Claude session project roots (not only DSH workspaces)
      const codexProjDir = join(tmpDir, 'codex-real-project')
      const unlinkedDir = join(tmpDir, 'unlinked-random-dir')
      mkdirSync(join(codexProjDir, 'outputs'), { recursive: true })
      mkdirSync(unlinkedDir, { recursive: true })
      const codexDeliverable = join(codexProjDir, 'outputs', 'report.md')
      const unlinkedFile = join(unlinkedDir, 'other.md')
      writeFileSync(codexDeliverable, '# Codex Deliverable\n')
      writeFileSync(unlinkedFile, '# Unlinked\n')
      const rootOrch = new MultiAppOrchestrator({ config: { cwd: join(tmpDir, 'unrelated-bridge-cwd') }, log: { info() {}, warn() {}, error() {} } })
      rootOrch.adapters.codex.readSession = async (sid) => ({ id: `codex:${sid}`, app: 'codex', cwd: codexProjDir, messages: [] })
      rootOrch.adapters.codex.listSessions = async () => [{ id: 'codex:t1', app: 'codex', cwd: codexProjDir, updatedAt: Date.now() }]
      rootOrch.adapters.dsh.listWorkspaces = async () => []
      rootOrch.adapters.claude.listWorkspaces = async () => []
      rootOrch.adapters.dsh.listSessions = async () => []
      rootOrch.adapters.claude.listSessions = async () => []
      rootOrch.adapters.antigravity.listSessions = async () => []
      rootOrch.adapters.workbuddy.listWorkspaces = async () => []
      rootOrch.adapters.workbuddy.listSessions = async () => []
      const okRead = await rootOrch.readLocalFile({ path: 'outputs/report.md', cwd: codexProjDir, mode: 'document', sessionId: 'codex:t1' })
      assert.equal(okRead.filename, 'report.md')
      await assert.rejects(
        () => rootOrch.readLocalFile({ path: unlinkedFile, cwd: unlinkedDir, mode: 'document' }),
        /出于安全限制/,
      )
      await rootOrch.dispose()

      // 8) WorkBuddy 5th-app adapter: SQLite + JSONL parsing, external live sync, readonly/writable CLI stream & security guards
      {
        const wbHome = join(tmpDir, 'mock-wb-home')
        const wbCodeHome = join(tmpDir, 'mock-cb-home')
        const wbProjDir = join(tmpDir, 'mock-wb-proj')
        const wbSessDir = join(wbHome, 'projects', 'mock-wb-proj')
        mkdirSync(wbSessDir, { recursive: true })
        mkdirSync(wbProjDir, { recursive: true })

        const wbSessId = 'wb-sess-001'
        const wbJsonlPath = join(wbSessDir, `${wbSessId}.jsonl`)
        const nowMs = Date.now()
        writeFileSync(
          wbJsonlPath,
          [
            JSON.stringify({ id: 'u1', timestamp: nowMs - 5000, type: 'message', role: 'user', content: [{ type: 'input_text', text: '分析下项目结构' }], sessionId: wbSessId, cwd: wbProjDir }),
            JSON.stringify({ id: 'r1', timestamp: nowMs - 4000, type: 'reasoning', rawContent: [{ type: 'text', text: '先查看目录文件' }], providerData: { model: 'glm-5.3' }, sessionId: wbSessId, cwd: wbProjDir }),
            JSON.stringify({ id: 'fc1', timestamp: nowMs - 3000, type: 'function_call', callId: 'call_1', name: 'Bash', arguments: '{"command":"ls"}', sessionId: wbSessId, cwd: wbProjDir }),
            JSON.stringify({ id: 'fr1', timestamp: nowMs - 2000, type: 'function_call_result', callId: 'call_1', name: 'Bash', status: 'completed', output: { type: 'text', text: 'src/ package.json' }, sessionId: wbSessId, cwd: wbProjDir }),
            JSON.stringify({ id: 'a1', timestamp: nowMs - 1000, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '项目包含 src 和 package.json。' }], providerData: { requestModelId: 'glm-5.3' }, sessionId: wbSessId, cwd: wbProjDir }),
            JSON.stringify({ id: 't1', timestamp: nowMs - 500, type: 'custom-title', customTitle: 'WorkBuddy 实测会话', sessionId: wbSessId }),
          ].join('\n') + '\n',
          'utf8',
        )

        // Populate a real SQLite workbuddy.db when node:sqlite is available
        try {
          const { DatabaseSync } = await import('node:sqlite')
          const db = new DatabaseSync(join(wbHome, 'workbuddy.db'))
          db.exec(`
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT, custom_title TEXT,
              status TEXT NOT NULL DEFAULT 'completed', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              deleted_at INTEGER, model TEXT, mode TEXT, permission_mode TEXT, thought_level TEXT, source_mode TEXT, transport TEXT
            );
            CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL);
          `)
          db.prepare(
            `INSERT INTO sessions (id, cwd, user_id, title, custom_title, status, created_at, updated_at, model, transport)
             VALUES (?, ?, 'u_test', '原标题', 'WorkBuddy 实测会话', 'completed', ?, ?, 'glm-5.3', 'local')`,
          ).run(wbSessId, wbProjDir, nowMs - 5000, nowMs - 500)
          db.prepare('INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?)').run(wbProjDir, nowMs)
          db.close()
          const snap = readWorkbuddyDbSnapshot(wbHome)
          assert.equal(snap.sessionsById.get(wbSessId)?.title, 'WorkBuddy 实测会话')
          assert.ok(snap.workspaces.some((w) => w.path === wbProjDir))
        } catch {}

        // 8a. Read-only mode (no codebuddy CLI)
        const wbEvents = []
        const wbRo = new WorkBuddyAdapter({
          config: {
            workbuddyHome: wbHome,
            codebuddyHome: wbCodeHome,
            workbuddyCliBin: join(tmpDir, 'nonexistent-codebuddy-bin'),
            cwd: wbProjDir,
            workbuddyWatchPollMs: 60,
          },
          log: { info() {}, warn() {}, error() {} },
          emitEvent: (ev, payload) => wbEvents.push({ ev, payload }),
        })
        wbRo.codebuddyBin = ''
        wbRo.probeCliVersion = async () => false
        try {
          const stRo = await wbRo.getStatus()
          assert.equal(stRo.app, 'workbuddy')
          assert.equal(stRo.available, true)
          assert.equal(stRo.writable, false)
          assert.equal(stRo.mode, 'readonly')

          // WorkBuddy Desktop XML wrapper cleanup (<system-reminder>, <user_query>, <image_local_path>, <cb_summary>)
          assert.equal(
            cleanWorkbuddyUserText(
              '<system-reminder data-role="user-context">\nOS: win32\n</system-reminder>\n<system-reminder data-role="additional-data">\n<current_time>now</current_time>\n</system-reminder>\n<user_query>给电脑截个屏发给我</user_query>\n<image_local_path>C:\\a.png</image_local_path>',
            ),
            '给电脑截个屏发给我',
          )
          assert.equal(
            cleanWorkbuddyUserText('<cb_summary>\nSummary of the conversation so far\n</cb_summary>'),
            '',
          )

          const parsed = parseWorkbuddyJsonlMessages(wbJsonlPath)
          assert.equal(parsed.messages.length, 2)
          assert.equal(parsed.messages[0].role, 'user')
          assert.equal(parsed.messages[1].thinking, '先查看目录文件')
          assert.equal(parsed.messages[1].tools?.[0]?.name, 'Bash')
          assert.equal(parsed.messages[1].tools?.[0]?.output, 'src/ package.json')
          assert.equal(parsed.messages[1].text, '项目包含 src 和 package.json。')

          const wbList = await wbRo.listSessions({ limit: 20 })
          assert.equal(wbList.length, 1)
          assert.equal(wbList[0].id, `workbuddy:${wbSessId}`)
          assert.equal(wbList[0].title, 'WorkBuddy 实测会话')
          assert.equal(wbList[0].writable, false)

          const wbRead = await wbRo.readSession(wbSessId)
          assert.equal(wbRead.messages.length, 2)
          assert.equal(wbRead.status, 'idle')

          await assert.rejects(() => wbRo.createSession({ cwd: wbProjDir }), (e) => e.code === 'SESSION_READONLY')
          await assert.rejects(() => wbRo.sendMessage(wbSessId, { text: 'hello' }), (e) => e.code === 'SESSION_READONLY')
          await assert.rejects(() => wbRo.readSession('../../etc/passwd'), /非法的/)

          // External live update detection on WorkBuddy Desktop JSONL append
          appendFileSync(
            wbJsonlPath,
            JSON.stringify({ id: 'u2', timestamp: Date.now(), type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续排查' }], sessionId: wbSessId, cwd: wbProjDir }) + '\n' +
            JSON.stringify({ id: 'fc2', timestamp: Date.now(), type: 'function_call', callId: 'call_2', name: 'Read', arguments: '{"file_path":"package.json"}', sessionId: wbSessId, cwd: wbProjDir }) + '\n',
            'utf8',
          )
          const tailNow = probeWorkbuddyTranscriptTail(wbJsonlPath)
          assert.equal(tailNow.running, true)
          assert.equal(tailNow.lastToolName, 'Read')
          await wbRo.pollExternalSessions()
          const updEv = wbEvents.find((x) => x.ev === EVENTS.SESSION_UPDATED && x.payload?.session?.id === `workbuddy:${wbSessId}`)
          assert.ok(updEv && updEv.payload.historyChanged && updEv.payload.statusChanged && updEv.payload.session.status === 'running')
        } finally {
          await wbRo.dispose()
        }

        // 8b. 1-click auth URL guard, standalone auth detection, env-autofix detection & ACP 1-click login + writable CLI stream
        assert.equal(isSafeWorkbuddyAuthUrl('https://www.codebuddy.cn/oauth/login?state=1'), true)
        assert.equal(isSafeWorkbuddyAuthUrl('https://open.weixin.qq.com/connect/qrconnect?appid=1'), true)
        assert.equal(isSafeWorkbuddyAuthUrl('javascript:alert(1)'), false)
        assert.equal(isSafeWorkbuddyAuthUrl('http://www.codebuddy.cn/login'), false)
        assert.equal(isSafeWorkbuddyAuthUrl('https://evil.example.com/phish'), false)

        const wbAuthDir = join(tmpDir, 'mock-wb-auth')
        mkdirSync(wbAuthDir, { recursive: true })
        writeFileSync(join(wbAuthDir, 'workbuddy-desktop.info'), '{"encrypted":true}', 'utf8')
        assert.equal(hasStandaloneCodebuddyAuth({ authDir: wbAuthDir, env: {} }), false, 'Desktop-encrypted auth must not be counted as standalone CLI auth')
        assert.equal(readStandaloneCodebuddyCredential({ authDir: wbAuthDir, env: {} }), null)

        // Credits normalization (personal + enterprise) & untrusted domain SSRF rejection
        const normPersonal = normalizeWorkbuddyCreditsQuota({
          code: 0,
          data: {
            TotalCredits: '791.8',
            SubscriptionPackageName: '体验版',
            IsPaidUser: false,
            CreditGroups: [
              { Kind: 'plan_base', Name: '套餐基础积分', CycleTotalCapacity: '500', CycleRemainCapacity: '491.8', CycleUsedCapacity: '8.2' },
              { Kind: 'benefit', Name: '平台奖励积分', CycleTotalCapacity: '300', CycleRemainCapacity: '300', CycleUsedCapacity: '0' },
            ],
          },
        })
        assert.equal(normPersonal.windowKind, 'credits')
        assert.equal(normPersonal.creditsRemaining, 791.8)
        assert.equal(normPersonal.creditsTotal, 800)
        assert.equal(normPersonal.remainingPercent, 99)
        assert.equal(normPersonal.planType, '体验版')
        assert.equal(normPersonal.creditGroups.length, 2)

        const normEntUnlim = normalizeWorkbuddyCreditsQuota({ data: { limitNum: -1, credit: 12.5 } }, { isEnterprise: true })
        assert.equal(normEntUnlim.unlimited, true)
        assert.equal(normEntUnlim.remainingPercent, 100)

        const evilAuthDir = join(tmpDir, 'mock-wb-evil-auth')
        mkdirSync(evilAuthDir, { recursive: true })
        writeFileSync(join(evilAuthDir, 'evil.info'), JSON.stringify({ auth: { accessToken: 'tok_1234567890abcdef', domain: '169.254.169.254' }, account: { uid: 'u1' } }), 'utf8')
        assert.equal(readStandaloneCodebuddyCredential({ authDir: evilAuthDir, env: {} }), null, 'Must reject untrusted SSRF auth domain')

        // Verify env-autofix detects half-installed WorkBuddy (native zero-Node installer)
        const wbFakeHome = join(tmpDir, 'wb-autofix-home')
        mkdirSync(join(wbFakeHome, '.workbuddy'), { recursive: true })
        writeFileSync(join(wbFakeHome, '.workbuddy', 'workbuddy.db'), '', 'utf8')
        const wbMissing = detectHalfInstalledClis({
          homeDir: wbFakeHome,
          checkBin: () => null,
          checkSystemApps: false,
        })
        assert.ok(wbMissing.some((m) => m.app === 'workbuddy' && m.steps.some((s) => JSON.stringify(s.args).includes('codebuddy.cn/cli/install'))))

        const mockCliJs = join(tmpDir, 'mock-codebuddy.cjs')
        writeFileSync(
          mockCliJs,
          `
          const fs = require('node:fs');
          const path = require('node:path');
          const args = process.argv.slice(2);
          if (args.includes('--version')) { console.log('2.176.0-mock'); process.exit(0); }
          let buf = '';
          process.stdin.setEncoding('utf8');
          if (args.includes('--acp')) {
            process.stdin.on('data', (c) => {
              buf += c;
              const lines = buf.split('\\n');
              buf = lines.pop();
              for (const raw of lines) {
                if (!raw.trim()) continue;
                const req = JSON.parse(raw);
                if (req.method === 'initialize') {
                  console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, authMethods: [{ id: 'internal' }, { id: 'external' }] } }));
                } else if (req.method === 'authenticate') {
                  console.log(JSON.stringify({ jsonrpc: '2.0', method: '_codebuddy.ai/authUrl', params: { authUrl: 'https://www.codebuddy.cn/oauth/login?state=smoke&m=' + (req.params?.methodId || '') } }));
                  setTimeout(() => {
                    fs.writeFileSync(${JSON.stringify(join(wbAuthDir, 'codebuddy-code.info'))}, '{"ok":true}', 'utf8');
                    console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { _meta: { 'codebuddy.ai/userinfo': { userId: 'u1', userName: 'smoke' } } } }));
                    process.exit(0);
                  }, 150);
                }
              }
            });
            return;
          }
          process.stdin.on('data', (c) => {
            buf += c;
            if (!buf.includes('\\n')) return;
            const line = buf.split('\\n')[0].trim();
            const msg = JSON.parse(line);
            const prompt = msg?.message?.content || '';
            if (prompt.includes('TRIGGER_AUTH_ERR')) {
              console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-err', content: [{ type: 'text', text: 'Authentication required. Please use /login command to sign in to your account' }] } }));
              console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }));
              process.exit(0);
              return;
            }
            console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wb-sess-001', cwd: process.cwd() }));
            console.log(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '思考中' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'README.md' } }] } }));
            console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok-readme' }] } }));
            console.log(JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '已收到:' + prompt + '|cfg=' + (process.env.CODEBUDDY_CONFIG_DIR || '') + '|args=' + args.join(' ') }] } }));
            console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '已收到:' + prompt + '|cfg=' + (process.env.CODEBUDDY_CONFIG_DIR || '') + '|args=' + args.join(' ') }));
            process.exit(0);
          });
          `,
          'utf8',
        )
        const mockCliBin = process.platform === 'win32'
          ? join(tmpDir, 'mock-codebuddy.cmd')
          : join(tmpDir, 'mock-codebuddy.sh')
        if (process.platform === 'win32') {
          writeFileSync(mockCliBin, `@echo off\r\n"${process.execPath}" "${mockCliJs}" %*\r\n`, 'utf8')
        } else {
          writeFileSync(mockCliBin, `#!/bin/sh\nexec "${process.execPath}" "${mockCliJs}" "$@"\n`, { encoding: 'utf8', mode: 0o755 })
        }

        // Mark wb-sess-001 idle again before sending via CLI
        appendFileSync(
          wbJsonlPath,
          JSON.stringify({ id: 'a2', timestamp: Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '排查完成' }], sessionId: wbSessId, cwd: wbProjDir }) + '\n',
          'utf8',
        )

        const rwEvents = []
        const wbRw = new WorkBuddyAdapter({
          config: {
            workbuddyHome: wbHome,
            codebuddyHome: wbCodeHome,
            workbuddyAuthDir: wbAuthDir,
            workbuddyCliBin: mockCliBin,
            cwd: wbProjDir,
            fetchWorkbuddyQuota: async () => normPersonal,
          },
          log: { info() {}, warn() {}, error() {} },
          emitEvent: (ev, payload) => rwEvents.push({ ev, payload }),
        })
        try {
          // Installed CLI but unauthenticated -> setupState='needs_login', writable=false
          const stNeedLogin = await wbRw.getStatus()
          assert.equal(stNeedLogin.cliInstalled, true)
          assert.equal(stNeedLogin.writable, false)
          assert.equal(stNeedLogin.setupState, 'needs_login')

          // 1-click setup triggers ACP authenticate, emits trusted authUrl, then auto-unlocks RW
          const setupRes = await wbRw.runSetup({ action: 'setup', methodId: 'internal' })
          assert.equal(setupRes.ok, true)
          assert.equal(setupRes.status, 'awaiting_login')
          assert.equal(setupRes.authUrl, 'https://www.codebuddy.cn/oauth/login?state=smoke&m=internal')
          for (let i = 0; i < 40; i += 1) {
            const hasAuthEv = rwEvents.some((x) => x.ev === EVENTS.SESSION_UPDATED && x.payload?.authReady && x.payload?.app === 'workbuddy')
            if (wbRw.isCliAuthenticated() && hasAuthEv) break
            await new Promise((r) => setTimeout(r, 50))
          }
          assert.equal(wbRw.isCliAuthenticated(), true)
          assert.ok(rwEvents.some((x) => x.ev === EVENTS.SESSION_UPDATED && x.payload?.authReady && x.payload?.app === 'workbuddy'))

          const stRw = await wbRw.getStatus()
          assert.equal(stRw.writable, true)
          assert.equal(stRw.setupState, 'ready')
          assert.equal(stRw.mode, 'codebuddy-cli-stream')
          assert.equal(stRw.quota?.windowKind, 'credits')
          assert.equal(stRw.quota?.creditsRemaining, 791.8)
          assert.equal(stRw.quota?.creditsTotal, 800)

          // Security guards: reject permission escalation and CLI injection
          await assert.rejects(
            () => wbRw.sendMessage(wbSessId, { text: 'hi', permissionMode: 'bypassPermissions' }),
            /出于安全限制/,
          )
          await assert.rejects(
            () => wbRw.sendMessage(wbSessId, { text: 'hi', model: 'glm-5.3 & calc.exe' }),
            /非法的/,
          )

          const sendRes = await wbRw.sendMessage(wbSessId, {
            text: '继续分析',
            model: 'glm-5.3',
            reasoningEffort: 'high',
          })
          assert.ok(sendRes.finalText.includes('已收到:继续分析'))
          assert.ok(sendRes.finalText.includes(`cfg=${wbHome}`))
          assert.ok(sendRes.finalText.includes(`--resume ${wbSessId}`))
          assert.ok(sendRes.finalText.includes('--model glm-5.3'))
          assert.ok(sendRes.finalText.includes('--effort high'))
          assert.ok(rwEvents.some((x) => x.ev === EVENTS.STREAM_THINKING))
          assert.ok(rwEvents.some((x) => x.ev === EVENTS.STREAM_TOOL_START && x.payload?.tool?.name === 'Read'))
          assert.ok(rwEvents.some((x) => x.ev === EVENTS.STREAM_TOOL_END && x.payload?.output === 'ok-readme'))
          assert.ok(rwEvents.some((x) => x.ev === EVENTS.STREAM_DONE))

          // Friendly Chinese 1-click login prompt when CLI returns Authentication required
          await assert.rejects(
            () => wbRw.sendMessage(wbSessId, { text: 'TRIGGER_AUTH_ERR' }),
            /一键微信扫码登录/,
          )
        } finally {
          await wbRw.dispose()
        }
      }
    }
    pass(17, 'Audit regression guards (env scrubbing, ACL, binary mux, compression, coalescing, ETags, proxy idle & WorkBuddy 5th-app adapter)')

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
