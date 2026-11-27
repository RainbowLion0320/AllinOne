import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { DesktopWebRtcProxy } from '../../packages/desktop-app/src/webrtc-proxy.js'
import { ElectronWebRtcClient } from '../../packages/dsh-mobile-hub/src/p2p/peer-electron.js'
import { createRelayServer } from '../../packages/relay-server/src/index.js'
import { createMailer } from '../../packages/relay-server/src/mailer.js'
import { buildAdminOverview } from '../../packages/relay-server/src/admin-monitor.js'
import { CTRL_FRAG_LIMIT_BYTES, createCtrlCodec } from '../../packages/shared/src/p2p-mux.js'
import { sanitizeChildEnv } from '../../packages/dsh-mobile-hub/src/helpers/bin-finder.js'
import { P2PBridgeManager } from '../../packages/dsh-mobile-hub/src/p2p/manager.js'
import { apply as applyDshPlugin } from '../../packages/dsh-mobile-hub/index.js'
import {
  DshAdapter,
  normalizeDeepseekBalanceQuota,
  readDshDeepseekApiKey,
} from '../../packages/dsh-mobile-hub/src/adapters/dsh.js'
import { startDshLocalIpcServer } from '../../packages/dsh-mobile-hub/src/dsh-local-ipc.js'
import { ensureDshLocalIpcPlugin } from '../../packages/dsh-mobile-hub/src/helpers/dsh-ipc-installer.js'
import { autoCompleteHalfInstalledClis, detectHalfInstalledClis } from '../../packages/dsh-mobile-hub/src/helpers/env-autofix.js'
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
} from '../../packages/dsh-mobile-hub/src/adapters/workbuddy.js'
import {
  AntigravityAdapter,
  normalizeAntigravityQuota,
  parseAgyTranscriptContent,
} from '../../packages/dsh-mobile-hub/src/adapters/antigravity.js'
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
} from '../../packages/dsh-mobile-hub/src/adapters/codex.js'
import {
  createTaskStateTracker,
  normalizeStepStatus,
  normalizeTaskMode,
  normalizeTaskState,
} from '../../packages/dsh-mobile-hub/src/helpers/task-state.js'
import {
  ClaudeAdapter,
  normalizeClaudeQuota,
  probeClaudeExternalStatus,
  probeClaudeTranscriptTail,
} from '../../packages/dsh-mobile-hub/src/adapters/claude.js'
import { MultiAppOrchestrator } from '../../packages/dsh-mobile-hub/src/orchestrator.js'
import { RelayBridgeLink } from '../../packages/dsh-mobile-hub/src/ws-client.js'
import {
  answersToElicitationContent,
  elicitationSchemaToQuestions,
} from '../../packages/dsh-mobile-hub/src/helpers/interactive-schema.js'
import { EVENTS, RPC } from '../../packages/shared/src/protocol.js'
import {
  computeE2eeKeyId,
  decryptAutoStream,
  decryptBinaryJson,
  decryptChunkedStream,
  deflateRawBytes,
  encryptBinaryJson,
  encryptChunkedBytes,
  generateE2eeKey,
  inflateRawBytes,
  isCompressibleFile,
  parseBinaryE2eeHeader,
} from '../../packages/shared/src/e2ee.js'
import { formatQuotaBadgeText, formatQuotaTooltip } from '../../packages/mobile-app/src/lib/sidebarVendors.js'
import { extractVendorQuotaDetails } from '../../packages/mobile-app/src/lib/quotaDashboard.js'
import {
  computeResizedDimensions,
  replaceFileExtension,
  shouldAttemptImageCompress,
} from '../../packages/mobile-app/src/lib/imageCompress.js'
import { clearDeviceCredentials, upsertDevice, upsertDeviceE2eeKey } from '../../packages/mobile-app/src/lib/deviceStore.js'
import { loadCachedSession, reconcileCachedWithFreshPage, saveCachedSession } from '../../packages/mobile-app/src/lib/sessionCache.js'
import { compareSemver as compareMobileSemver } from '../../packages/mobile-app/src/lib/clientHelpers.js'
import {
  extractImageRefsFromText,
  isExternalHttpImageUrl,
  isPrivateOrLoopbackUrl,
  resolveImageSrc,
} from '../../packages/mobile-app/src/lib/imageUrls.js'
import { createTempDir } from './harness.mjs'

test('Suite 13: DSH Cordis plugin, authenticated IPC, auto-installer, two-way prompt sync & CLI auto-fix guard', async () => {
  const temp = createTempDir('allinone-int-04-dsh-')
  const tmpDir = temp.dir

  try {
    // 13a. DSH Cordis plugin registers all 6 Master Dispatch tools
    const registeredTools = []
    const effects = []
    applyDshPlugin(
      {
        agents: { get: () => undefined },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        get: (name) =>
          name === 'tools'
            ? {
                register: (def) => {
                  registeredTools.push(def.name)
                  return () => {}
                },
              }
            : undefined,
        effect: (fn) => {
          const clean = fn()
          if (typeof clean === 'function') effects.push(clean)
        },
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
      const session = {
        id: sid,
        meta: { cwd },
        get seq() {
          return seqCounter
        },
        ownEvents: () => events,
      }
      const agent = {
        id: sid,
        session,
        followup: (userMsg) => {
          const promptText = userMsg?.content?.[0]?.text || ''
          events.push({ seq: ++seqCounter, type: 'user/message', data: { message: userMsg }, timestamp: Date.now() })
          events.push({
            seq: ++seqCounter,
            type: 'user/message',
            data: {
              id: `sys-${seqCounter}`,
              role: 'user',
              source: { kind: 'runtime-context' },
              content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }],
            },
            timestamp: Date.now(),
          })
          events.push({
            seq: ++seqCounter,
            type: 'user/message',
            data: {
              id: `sys-${seqCounter}`,
              role: 'user',
              source: { kind: 'skill-catalog' },
              content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }],
            },
            timestamp: Date.now(),
          })
          idlePromise = new Promise((r) => {
            idleResolve = r
            setTimeout(() => {
              events.push({
                seq: ++seqCounter,
                type: 'assistant/message',
                data: {
                  message: {
                    id: `a-${seqCounter}`,
                    content: [
                      { type: 'thinking', thinking: 'Checking IPC...' },
                      { type: 'text', text: `DSH IPC Reply to: ${promptText}` },
                    ],
                  },
                },
                timestamp: Date.now(),
              })
              r()
            }, 60)
          })
        },
        whenIdle: () => idlePromise,
        abort: async () => {
          idleResolve?.()
        },
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
        if (name === 'sessionTitle') {
          return {
            get: (s) => ({ title: mockSessions.get(s?.id)?.title || s?.id }),
            rename: (s, t) => {
              const row = mockSessions.get(s?.id)
              if (row) row.title = t
            },
          }
        }
        return undefined
      },
    }
    let ipcSrv = null
    const liveDsh = new DshAdapter({
      ctx: mockDshCtx,
      config: { dshHome: ipcDshHome, cwd: process.cwd() },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      emitEvent: (ev, p) => ipcSrv?.emitEvent(ev, p),
    })
    const receivedEvents = []
    const standaloneDsh = new DshAdapter({
      ctx: null,
      config: { dshHome: ipcDshHome, cwd: process.cwd() },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      emitEvent: (ev, p) => receivedEvents.push({ ev, p }),
    })
    try {
      assert.equal((await standaloneDsh.getStatus()).mode, 'standalone-readonly')
      ipcSrv = await startDshLocalIpcServer({ dshAdapter: liveDsh, dshHome: ipcDshHome, log: { info: () => {}, warn: () => {}, error: () => {} } })
      assert.equal((await fetch(`http://127.0.0.1:${ipcSrv.port}/health`)).status, 401)
      assert.equal(
        (await fetch(`http://127.0.0.1:${ipcSrv.port}/health`, { headers: { Authorization: `Bearer ${ipcSrv.token}`, Origin: 'https://evil.example' } }))
          .status,
        403,
      )
      assert.equal((await standaloneDsh.getStatus()).mode, 'dsh-local-ipc')

      const created = await standaloneDsh.createSession({ cwd: process.cwd(), title: 'IPC Chat' })
      const reply = await standaloneDsh.sendMessage(created.nativeId, { text: 'Hello DSH!' })
      assert.ok(reply.finalText.includes('DSH IPC Reply to: Hello DSH!'))
      await new Promise((r) => setTimeout(r, 60))
      const evTypes = receivedEvents.map((e) => e.ev)
      assert.ok(
        evTypes.includes(EVENTS.STREAM_START) &&
          evTypes.includes(EVENTS.STREAM_THINKING) &&
          evTypes.includes(EVENTS.STREAM_DELTA) &&
          evTypes.includes(EVENTS.STREAM_DONE),
      )

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
    writeFileSync(
      join(fakeProfileDir, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2),
    )
    assert.equal(
      ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: { ALLINONE_NO_AUTOFIX: '1' }, log: { info: () => {}, warn: () => {} } }).status,
      'skipped-opt-out',
    )
    assert.equal(ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status, 'installed')
    assert.equal(ensureDshLocalIpcPlugin({ dshHome: fakeDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status, 'up-to-date')

    const hubDshHome = join(tmpDir, 'hub-dsh-home')
    mkdirSync(join(hubDshHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(hubDshHome, 'profiles', 'desktop', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-mobile-hub'] } } }))
    assert.equal(
      ensureDshLocalIpcPlugin({ dshHome: hubDshHome, env: {}, log: { info: () => {}, warn: () => {} } }).status,
      'already-using-dsh-mobile-hub',
    )

    // 13d. DSH two-way prompt & approval sync (downstream Desktop cancel on remote answer + parent abort propagation)
    const syncCards = []
    const syncEvents = []
    const syncListeners = new Map()
    const dshSync = new DshAdapter({
      ctx: {
        agents: {},
        on: (n, fn) => {
          syncListeners.set(n, fn)
          return () => syncListeners.delete(n)
        },
      },
      config: { dshHome: join(tmpDir, 'dsh-sync') },
      log: { info() {}, warn() {}, error() {} },
      emitEvent: (ev, payload) => syncEvents.push({ ev, payload }),
      onApprovalRequest: (card) => syncCards.push(card),
    })
    try {
      const parentAc1 = new AbortController()
      const req1 = {
        agent: { id: 's1', session: { id: 's1' } },
        signal: parentAc1.signal,
        wait: { callId: 'c1' },
        questions: [{ id: 'q1', question: 'Confirm?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }
      const order = []
      let desktopSig1 = null
      const p1 = syncListeners
        .get('user-questions/request')(req1, () =>
          new Promise((_, reject) => {
            desktopSig1 = req1.signal
            desktopSig1.addEventListener(
              'abort',
              () => {
                order.push('desktop-cancel')
                reject(new Error('cancelled'))
              },
              { once: true },
            )
          }),
        )
        .then((r) => {
          order.push('tool-resolved')
          return r
        })
      await new Promise((r) => setTimeout(r, 15))
      assert.ok(desktopSig1 && desktopSig1 !== parentAc1.signal)
      // BaseAdapter.setTimeout unrefs its 50ms cancel-flush timer; keep a ref'd guard active while awaiting p1
      const keepAlive = setTimeout(() => {}, 5_000)
      try {
        await dshSync.resolveApproval(syncCards.pop().id, { decision: 'submit', answers: { q1: { selected: ['Yes'] } } })
        assert.deepEqual(await p1, { answers: [{ id: 'q1', selected: ['Yes'] }] })
      } finally {
        clearTimeout(keepAlive)
      }
      assert.deepEqual(order, ['desktop-cancel', 'tool-resolved'])
      assert.equal(desktopSig1.aborted, true)
      assert.equal(parentAc1.signal.aborted, false)
      assert.equal(req1.signal, parentAc1.signal)

      const parentAc2 = new AbortController()
      const req2 = { agent: { id: 's2', session: { id: 's2', meta: { cwd: tmpDir } } }, signal: parentAc2.signal, toolName: 'bash', reason: 'build' }
      let desktopSig2 = null
      const p2 = syncListeners.get('approval/request')(req2, () =>
        new Promise((_, reject) => {
          desktopSig2 = req2.signal
          desktopSig2.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
      )
      await new Promise((r) => setTimeout(r, 15))
      await dshSync.resolveApproval(syncCards.pop().id, 'allowed-once')
      assert.equal(await p2, 'allowed-once')
      assert.equal(desktopSig2.aborted, true)
      assert.equal(parentAc2.signal.aborted, false)

      const parentAc3 = new AbortController()
      const req3 = { agent: { id: 's3', session: { id: 's3' } }, signal: parentAc3.signal, questions: [{ id: 'q3', question: 'Abort?', options: [{ label: 'A' }] }] }
      let desktopSig3 = null
      const p3 = syncListeners.get('user-questions/request')(req3, () =>
        new Promise(() => {
          desktopSig3 = req3.signal
        }),
      )
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
    const missing = detectHalfInstalledClis({
      homeDir: partialHome,
      platform: 'darwin',
      env: {},
      checkBin: (n) => (n.includes('npm') ? '/usr/local/bin/npm' : null),
      checkSystemApps: false,
    })
    assert.deepEqual(
      missing.map((m) => m.app).sort(),
      ['antigravity', 'claude', 'codex'],
    )
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
  } finally {
    temp.cleanup()
  }
})

test('Suite 14: Interactive multi-question Q&A & approvals across Codex, DSH (+IPC), Antigravity ACP, Claude & Orchestrator', async () => {
  const temp = createTempDir('allinone-int-04-qna-')
  const tmpDir = temp.dir

  try {
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
      const cdx = new CodexAdapter({
        config: { codexHome: join(tmpDir, 'codex-qna') },
        log: { warn() {}, log() {} },
        emitEvent: (ev, p) => events.push({ ev, p }),
        onApprovalRequest: (r) => cards.push(r),
      })
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

      cdx.handleServerRequest(writer, {
        id: 102,
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thr-qna-1', reason: 'net', permissions: { network: { enabled: true } } },
      })
      await cdx.resolveApproval(cards[1].id, 'acceptForSession')
      assert.deepEqual(sent[1].result, { permissions: { network: { enabled: true } }, scope: 'session' })

      cdx.handleServerRequest(writer, {
        id: 103,
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr-qna-1',
          serverName: 'gh',
          mode: 'form',
          message: 'Repo',
          requestedSchema: { type: 'object', properties: { vis: { type: 'string', enum: ['public', 'private'] } } },
        },
      })
      await cdx.resolveApproval(cards[2].id, { decision: 'submit', answers: { vis: { selected: ['private'] } } })
      assert.deepEqual(sent[2].result, { action: 'accept', content: { vis: 'private' } })

      cdx.handleServerRequest(writer, {
        id: 104,
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thr-qna-1', serverName: 'oauth', mode: 'url', message: 'Auth', url: 'https://example.com/auth' },
      })
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
        ctx: {
          agents: {},
          get: (k) => (k === 'agents' || k === 'sessionController' ? {} : null),
          on: (e, fn) => {
            hooks.set(e, fn)
            return () => hooks.delete(e)
          },
        },
        config: { dshHome: ipcQnaHome },
        log: { info() {}, warn() {}, error() {} },
        emitEvent: (ev, p) => {
          liveEvents.push({ ev, p })
          ipcQnaSrv?.emitEvent?.(ev, p)
        },
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
        await dshStandalone.resolveApproval(pending[0].id, {
          decision: 'submit',
          answers: { q1: { selected: ['Staging'] }, q2: { selected: ['Cache'], custom: 'Edge' } },
        })
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
      const agy = new AntigravityAdapter({
        config: { agyHome: join(tmpDir, 'agy-qna'), agyAutoApprove: false },
        log: { warn() {}, log() {} },
        onApprovalRequest: (r) => cards.push(r),
      })
      try {
        const entry = { sessionId: 'agy-1', cwd: tmpDir, lastActivityAt: 0 }
        const client = { sendRaw: (obj) => sent.push(obj) }
        agy.handleServerRequest(entry, client, {
          id: 201,
          method: 'elicitation/create',
          params: {
            sessionId: 'agy-1',
            mode: 'form',
            message: 'Channel',
            requestedSchema: { type: 'object', properties: { ch: { type: 'string', oneOf: [{ const: 'stable', title: 'Stable' }] } } },
          },
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
      await cld.resolveApproval(cards[0].id, {
        decision: 'submit',
        answers: {
          [cards[0].questions[0].id]: { selected: ['JWT'] },
          [cards[0].questions[1].id]: { selected: ['Web', 'Android'] },
        },
      })
      assert.deepEqual(written[0].response.response.updatedInput.answers, { 'Which auth?': 'JWT', 'Platforms?': 'Web, Android' })

      cld.handleControlRequest(proc, 'cld-s1', 'claude:cld-s1', tmpDir, {
        type: 'control_request',
        request_id: 'req-plan-2',
        request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. Edit' } },
      })
      await cld.resolveApproval(cards[1].id, 'allow')
      assert.equal(written[1].response.response.behavior, 'allow')

      cld.handleControlRequest(proc, 'cld-s1', 'claude:cld-s1', tmpDir, {
        type: 'control_request',
        request_id: 'req-bash-3',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/demo' } },
      })
      await cld.resolveApproval(cards[2].id, 'deny')
      assert.equal(written[2].response.response.behavior, 'deny')
    }

    // 14f. MultiAppOrchestrator RPC.APPROVAL_LIST + RPC.APPROVAL_RESOLVE
    {
      const orchEvents = []
      const orch = new MultiAppOrchestrator({ config: { cwd: tmpDir }, log: { info() {}, warn() {}, error() {} }, onEvent: (ev, p) => orchEvents.push({ ev, p }) })
      try {
        const mockWriter = {
          sent: [],
          sendRaw(obj) {
            this.sent.push(obj)
          },
        }
        orch.adapters.codex.handleServerRequest(mockWriter, {
          id: 301,
          method: 'item/tool/requestUserInput',
          params: { threadId: 'orch-1', questions: [{ id: 'env', question: 'Env?', options: [{ label: 'prod' }] }] },
        })
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
  } finally {
    temp.cleanup()
  }
})

test('Suite 15: Adapter resilience, external watchers (Antigravity/Codex/Claude), async Q&A & weekly quotas', async () => {
  const temp = createTempDir('allinone-int-04-resilience-')
  const tmpDir = temp.dir

  try {
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
    writeFileSync(
      doneFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
    )
    assert.equal(probeCodexRolloutStatus(doneFile).running, false)
    writeFileSync(
      abortedFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`,
    )
    assert.equal(probeCodexRolloutStatus(abortedFile).running, false)

    const bigPayload = 'A'.repeat(90 * 1024)
    writeFileSync(
      giantFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: bigPayload } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count' } })}\n`,
    )
    assert.equal(probeCodexRolloutStatus(giantFile).running, true)
    assert.equal(probeCodexRolloutStatus(giantFile, { now: Date.now() + 30 * 60_000, maxIdleMs: 20 * 60_000 }).running, false)

    const cdxWatchEvents = []
    const cdxWatch = new CodexAdapter({
      config: { watchPollIntervalMs: 160 },
      log: { info() {}, warn() {}, debug() {} },
      emitEvent: (ev, p) => cdxWatchEvents.push({ ev, p }),
    })
    try {
      cdxWatch.rememberWatchedSession('thr-open', { path: doneFile, title: 'Open', cwd: cdxDir })
      cdxWatch.rememberTrackedListSession('thr-side', { path: abortedFile, title: 'Side', cwd: cdxDir })
      await new Promise((r) => setTimeout(r, 50))
      writeFileSync(
        doneFile,
        `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } })}\n`,
      )
      writeFileSync(abortedFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started' } })}\n`)
      for (let i = 0; i < 20; i += 1) {
        if (
          cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-open' && e.p?.session?.status === 'running') &&
          cdxWatchEvents.some((e) => e.p?.session?.nativeId === 'thr-side' && e.p?.session?.status === 'running')
        ) {
          break
        }
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
    writeFileSync(
      asyncRollout,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: callId, delivery: 'async', content: [{ type: 'Text', text: '口味？' }], questions: [{ title: '口味？', options: ['香辣', '清淡'] }] } } })}\n`,
    )
    assert.equal(extractPendingCodexAsyncQuestionFromRollout(asyncRollout)?.id, callId)
    appendFileSync(
      asyncRollout,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u-r', content: [{ type: 'text', text: replyWire }] } } })}\n`,
    )
    assert.equal(extractPendingCodexAsyncQuestionFromRollout(asyncRollout), null)

    const asyncCards = []
    const steered = []
    const cdxAsync = new CodexAdapter({ config: {}, log: { info() {}, warn() {}, error() {} }, onApprovalRequest: (c) => asyncCards.push(c) })
    try {
      cdxAsync.activeTurns.set('thr-live', {
        writer: {
          rpc: async (m, p) => {
            steered.push({ m, p })
            return { ok: true }
          },
        },
        turnId: 'turn-1',
        cwd: tmpDir,
        textBuffer: '',
        aborted: false,
        settled: false,
      })
      cdxAsync.handleNotification('item/completed', {
        threadId: 'thr-live',
        item: { type: 'agentMessage', id: 'call_steer', delivery: 'async', text: 'Pick', questions: [{ title: 'Pick', options: ['Spicy'] }] },
      })
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
    writeFileSync(
      join(acctDir, `local_${sessUuid}.json`),
      JSON.stringify({
        sessionId: `local_${sessUuid}`,
        cliSessionId: cliSid,
        title: 'Cowork Live',
        isArchived: false,
        userSelectedFolders: [wsDir],
        folderMountNames: { [wsDir]: 'CivilizationVI' },
        createdAt: Date.now() - 60_000,
        lastActivityAt: Date.now() - 5_000,
      }),
    )
    writeFileSync(
      join(acctDir, 'local_archived-1111-2222-3333-444444444444.json'),
      JSON.stringify({ sessionId: 'local_archived-1111-2222-3333-444444444444', title: 'Archived', isArchived: true }),
    )
    writeFileSync(
      join(sessDir, '.claude', 'projects', 'session', `${cliSid}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run solver' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__workspace__bash', input: { command: 'python run.py' } }] } })}\n`,
    )
    const auditJsonl = join(sessDir, 'audit.jsonl')
    writeFileSync(
      auditJsonl,
      `${JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: 'system', subtype: 'permission_request', uuid: 'perm-1', tool_name: 'mcp__cowork__dir', timestamp: new Date().toISOString() })}\n`,
    )
    writeFileSync(
      join(sessDir, '.claude', 'sessions', '999999.json'),
      JSON.stringify({ pid: 999999, sessionId: cliSid, status: 'busy', updatedAt: Date.now(), statusUpdatedAt: Date.now() }),
    )

    const cliProjDir = join(claudeHome, 'projects', 'demo-proj')
    mkdirSync(cliProjDir, { recursive: true })
    const codeCliId = '11111111-2222-3333-4444-555555555555'
    writeFileSync(
      join(cliProjDir, `${codeCliId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'cu1', cwd: wsDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } })}\n`,
    )
    const codeAcctDir = join(claudeRoot, 'claude-code-sessions', 'org-1', 'acct-1')
    mkdirSync(codeAcctDir, { recursive: true })
    writeFileSync(
      join(codeAcctDir, 'local_aaaa1111-2222-3333-4444-555555555555.json'),
      JSON.stringify({
        sessionId: 'local_aaaa1111-2222-3333-4444-555555555555',
        cliSessionId: codeCliId,
        title: 'Desktop Code Enriched',
        cwd: wsDir,
        createdAt: Date.now() - 30_000,
        lastActivityAt: Date.now() - 10_000,
      }),
    )

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
      appendFileSync(
        auditJsonl,
        `${JSON.stringify({ type: 'system', subtype: 'permission_response', uuid: 'perm-1', granted: true, timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: 'result', subtype: 'success', timestamp: new Date().toISOString() })}\n`,
      )
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
    assert.ok(agyMultiDash?.pools[0].windows[1].shortResetText)
    const homeQuotaSrc = readFileSync(join(process.cwd(), 'packages/mobile-app/src/components/HomeQuotaDashboard.jsx'), 'utf8')
    assert.ok(homeQuotaSrc.includes('function QuotaRing(') && homeQuotaSrc.includes('function QuotaRingItem('))
    assert.equal(homeQuotaSrc.includes('ConcentricQuotaRings'), false)

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
      balance_infos: [{ currency: 'CNY', total_balance: '84.30', granted_balance: '0.00', topped_up_balance: '84.30' }],
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
    const plusQ = normalizeCodexQuota({
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: futureSec },
        secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: futureSec },
      },
    })
    assert.equal(plusQ.remainingPercent, 36)
    assert.equal(plusQ.shortWindow?.remainingPercent, 90)
    assert.equal(normalizeClaudeQuota({ rateLimitType: 'seven_day', utilization: 0.27, resetsAt: futureSec }).remainingPercent, 73)
    assert.equal(normalizeClaudeQuota({ rateLimitType: 'seven_day', status: 'allowed' }), null)

    const zkLink = new RelayBridgeLink({
      relayUrl: 'ws://127.0.0.1:8787/ws/bridge',
      bridgeId: 'zk-pc',
      roomId: 'usr_zk',
      secret: 'sec',
      e2eeKey: generateE2eeKey(),
      onRpc: async () => ({}),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    zkLink.sendBridgeMeta = async () => {}
    zkLink.setAppsMeta([{ app: 'codex', available: true, writable: true, quota: proQ }])
    assert.equal(zkLink.metaApps[0].quota, undefined, 'Plaintext bridge.meta.apps must never include quota')
  } finally {
    temp.cleanup()
  }
})

test('Suite 16: Unified Plan/Goal/Steps live sync & interactive taskMode forwarding', async () => {
  const temp = createTempDir('allinone-int-04-plan-')
  const tmpDir = temp.dir

  try {
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
      JSON.stringify({
        type: 'USER_INPUT',
        step_index: 0,
        created_at: '2026-11-25T08:00:00Z',
        content: '<USER_REQUEST>/goal Refactor WebRTC pipeline and verify tests</USER_REQUEST>',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: '2026-11-25T08:00:05Z',
        content: 'Working on it',
        tool_calls: [
          {
            id: 'tc-1',
            name: 'update_steps',
            args: { steps: JSON.stringify([{ title: 'Inspect adapters', status: 'done' }, { title: 'Wire sync', status: 'in_progress' }]) },
          },
          { id: 'tc-2', name: 'update_focus', args: { focus: JSON.stringify('Wiring Plan/Goal sync') } },
          {
            id: 'tc-3',
            name: 'write_file',
            args: {
              Path: JSON.stringify('C:/Users/Test/.gemini/antigravity/brain/conv-1/implementation_plan.md'),
              ArtifactMetadata: JSON.stringify({ UserFacing: true, Summary: 'Plan', RequestFeedback: true }),
            },
          },
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
    agyTracker.applyAntigravityAcpUpdate(
      { sessionUpdate: 'plan', entries: [{ content: 'Design', status: 'completed' }, { content: 'UI', status: 'in_progress' }] },
      200,
    )
    assert.equal(agyTracker.snapshot().mode, 'plan')
    assert.equal(agyTracker.snapshot().steps[0].status, 'done')
    agyTracker.applyAntigravityAcpUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, 300)
    assert.equal(agyTracker.snapshot().mode, null)
    agyTracker.applyAntigravityAcpUpdate(
      { sessionUpdate: 'plan', entries: [{ content: 'Design', status: 'completed' }, { content: 'UI', status: 'completed' }] },
      400,
    )
    agyTracker.applyAntigravityUserText('Thanks, next question', 500)
    assert.equal(agyTracker.snapshot(), null)

    // Codex rollout plan/steps + ThreadGoal tracker
    const cdxRolloutPath = join(tmpDir, 'codex-plan-rollout.jsonl')
    writeFileSync(
      cdxRolloutPath,
      [
        JSON.stringify({ timestamp: '2026-11-25T08:10:00Z', type: 'event_msg', payload: { type: 'task_started', collaboration_mode_kind: 'plan' } }),
        JSON.stringify({
          timestamp: '2026-11-25T08:10:03Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            arguments: JSON.stringify({
              explanation: 'Drafting steps',
              plan: [{ step: 'Audit', status: 'completed' }, { step: 'Ship', status: 'in_progress' }],
            }),
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T08:10:08Z',
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'Plan', id: 'p-1', text: '# Codex Plan\n1. Audit' } },
        }),
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
              {
                type: 'tool_use',
                id: 'tu-todo',
                name: 'TodoWrite',
                input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Patch', status: 'in_progress', activeForm: 'Writing patch' }] },
              },
              { type: 'tool_use', id: 'tu-exit', name: 'ExitPlanMode', input: { plan: '## Claude Plan' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-11-25T08:20:05Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-exit', content: 'Approved', is_error: false }] },
        }),
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
  } finally {
    temp.cleanup()
  }
})

test('Suite 17: Audit regression guards (env scrubbing, ACL, binary mux, compression, coalescing, ETags, proxy idle & WorkBuddy 5th-app adapter)', async () => {
  const temp = createTempDir('allinone-int-04-audit-')
  const tmpDir = temp.dir

  try {
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
    for (const k of [
      'ALLINONE_E2EE_KEY',
      'ALLINONE_BRIDGE_SECRET',
      'ALLINONE_WEBRTC_PROXY_PORT',
      'ALLINONE_WEBRTC_PROXY_TOKEN',
      'ALLINONE_PASSWORD',
      'ELECTRON_RUN_AS_NODE',
    ]) {
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
      assert.ok(f instanceof Uint8Array && f.byteLength <= CTRL_FRAG_LIMIT_BYTES, 'Every control fragment must be <= 48KB binary bytes')
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
      onHeader: (h) => {
        encHdr = h
      },
      onChunk: (c) => {
        encChunks.push(c)
      },
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
              setImmediate(() =>
                idleIpc.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'res', reqId: msg.reqId, ok: true, answer: { type: 'answer', sdp: 'v=0\r\n' } }),
              )
            }
          },
        })
      }
      isDestroyed() {
        return this._destroyed
      }
      destroy() {
        if (!this._destroyed) {
          this._destroyed = true
          this.emit('closed')
        }
      }
      async loadFile() {
        setImmediate(() => {
          if (!this._destroyed) idleIpc.emit('webrtc-worker:control', { sender: this.webContents }, { type: 'worker.ready' })
        })
      }
    }
    const idleProxy = new DesktopWebRtcProxy({
      BrowserWindow: IdleTestWin,
      ipcMain: idleIpc,
      srcDir: join(process.cwd(), 'packages/desktop-app/src'),
      log: { info() {}, warn() {}, error() {} },
    })
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
      peer: {
        close: async () => {
          peerClosedBySid = true
        },
      },
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
      writeFileSync(
        join(agProj, `agent-sub-${i}.jsonl`),
        `${JSON.stringify({ type: 'user', uuid: `a${i}`, cwd: tmpDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'subagent' } })}\n`,
      )
    }
    writeFileSync(
      join(agProj, '11111111-2222-3333-4444-555555555555.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'real1', cwd: tmpDir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Real user chat' } })}\n`,
    )
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
    assert.ok(
      binEnc.bytes.byteLength < rawJsonBytes * 0.25,
      `Binary deflate-raw E2EE must cut repetitive JSON >=75% (got ${binEnc.bytes.byteLength} vs ${rawJsonBytes})`,
    )
    const binDec = await decryptBinaryJson(bwKey, binEnc.bytes, { kind: 'rpc.res', roomId: 'usr_bw' })
    assert.deepEqual(binDec, largeJson)

    // Zip-bomb decompression cap must reject payloads expanding beyond maxBytes
    const bombRaw = new Uint8Array(64 * 1024)
    const bombCompressed = await deflateRawBytes(bombRaw)
    assert.ok(bombCompressed.byteLength < 1024)
    await assert.rejects(() => inflateRawBytes(bombCompressed, 8 * 1024), (err) => err?.code === 'E2EE_DECRYPT_FAILED')

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
      replayingEvents: false,
      pendingLiveEvents: [],
      lastDeliveredSeq: 0,
      ctrlCodec: createCtrlCodec(),
      ctrlWriter: {
        send: async (frame) => {
          const decoded = coalCodec.decode(frame)
          if (decoded) capturedCtrlFrames.push(decoded)
        },
      },
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
    const bigHtmlBytes = new TextEncoder().encode(
      `<!doctype html><html><body>${'<section><p>AllinOne Report Row</p></section>\n'.repeat(4000)}</body></html>`,
    )
    const compEnc = await encryptChunkedBytes(bwKey, bigHtmlBytes, { kind: 'upload', roomId: 'usr_bw', compress: true })
    assert.equal(compEnc.compressed, true)
    assert.ok(
      compEnc.totalBytes < bigHtmlBytes.byteLength * 0.1,
      `Compressed AIO2 HTML must shrink >90% (got ${compEnc.totalBytes} vs ${bigHtmlBytes.byteLength})`,
    )
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
    const protoBefore = {}.available
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
    assert.equal({}.available, protoBefore, 'Object.prototype must never be polluted by bridge.meta.apps')
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
    await assert.rejects(() => rootOrch.readLocalFile({ path: unlinkedFile, cwd: unlinkedDir, mode: 'document' }), /出于安全限制/)
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
        assert.equal(cleanWorkbuddyUserText('<cb_summary>\nSummary of the conversation so far\n</cb_summary>'), '')

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
          JSON.stringify({ id: 'u2', timestamp: Date.now(), type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续排查' }], sessionId: wbSessId, cwd: wbProjDir }) +
            '\n' +
            JSON.stringify({ id: 'fc2', timestamp: Date.now(), type: 'function_call', callId: 'call_2', name: 'Read', arguments: '{"file_path":"package.json"}', sessionId: wbSessId, cwd: wbProjDir }) +
            '\n',
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
      assert.equal(
        hasStandaloneCodebuddyAuth({ authDir: wbAuthDir, env: {} }),
        false,
        'Desktop-encrypted auth must not be counted as standalone CLI auth',
      )
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
      writeFileSync(
        join(evilAuthDir, 'evil.info'),
        JSON.stringify({ auth: { accessToken: 'tok_1234567890abcdef', domain: '169.254.169.254' }, account: { uid: 'u1' } }),
        'utf8',
      )
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
      assert.ok(
        wbMissing.some(
          (m) =>
            m.app === 'workbuddy' &&
            m.steps.some(
              (s) =>
                s.kind === 'remote-script' &&
                s.requiresConfirmation === true &&
                String(s.scriptUrl || '').includes('codebuddy.cn/cli/install'),
            ),
        ),
      )

      const mockCliJs = join(tmpDir, 'mock-codebuddy.cjs')
      writeFileSync(
        mockCliJs,
        `
        const fs = require('node:fs');
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
      const mockCliBin = process.platform === 'win32' ? join(tmpDir, 'mock-codebuddy.cmd') : join(tmpDir, 'mock-codebuddy.sh')
      if (process.platform === 'win32') {
        writeFileSync(mockCliBin, `@echo off\r\n"${process.execPath}" "${mockCliJs}" %*\r\n`, 'utf8')
      } else {
        writeFileSync(mockCliBin, `#!/bin/sh\nexec "${process.execPath}" "${mockCliJs}" "$@"\n`, { encoding: 'utf8', mode: 0o755 })
      }

      // Mark wb-sess-001 idle again before sending via CLI
      appendFileSync(
        wbJsonlPath,
        JSON.stringify({
          id: 'a2',
          timestamp: Date.now(),
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '排查完成' }],
          sessionId: wbSessId,
          cwd: wbProjDir,
        }) + '\n',
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
        await assert.rejects(() => wbRw.sendMessage(wbSessId, { text: 'hi', permissionMode: 'bypassPermissions' }), /出于安全限制/)
        await assert.rejects(() => wbRw.sendMessage(wbSessId, { text: 'hi', model: 'glm-5.3 & calc.exe' }), /非法的/)

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
        await assert.rejects(() => wbRw.sendMessage(wbSessId, { text: 'TRIGGER_AUTH_ERR' }), /一键微信扫码登录/)
      } finally {
        await wbRw.dispose()
      }
    }
  } finally {
    temp.cleanup()
  }
})
