import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

import { APPS, APP_LIST, APP_META, EVENTS } from '../packages/shared/src/protocol.js'
import { assertSafeWorkspaceCwd } from '../packages/dsh-mobile-hub/src/protocol.js'
import { SENSITIVE_HOME_SUBDIRS } from '../packages/desktop-app/src/safe-paths.js'
import { MultiAppOrchestrator } from '../packages/dsh-mobile-hub/src/orchestrator.js'
import { getDatabaseSync } from '../packages/dsh-mobile-hub/src/primitives/io-utils.js'
import {
  KimiAdapter,
  assertLoopbackControlUrl,
  formatKimiModelName,
  normalizeKimiControlMessages,
  normalizeKimiThinkingLevel,
  normalizeKimiWireJsonl,
  readKimiQuotaFromLogs,
  stripKimiInjectedPromptBlocks,
} from '../packages/dsh-mobile-hub/src/adapters/kimi.js'

test('protocol & safe-paths register Kimi and block sensitive Kimi dirs', () => {
  assert.equal(APPS.KIMI, 'kimi')
  assert.ok(APP_LIST.includes('kimi'))
  assert.equal(APP_META.kimi.name, 'Kimi')
  assert.equal(APP_META.kimi.badge, 'KMI')
  assert.equal(APP_META.kimi.color, '#0A84FF')

  assert.ok(SENSITIVE_HOME_SUBDIRS.includes('.kimi'))
  assert.ok(SENSITIVE_HOME_SUBDIRS.includes('.kimi-webbridge'))
  assert.ok(SENSITIVE_HOME_SUBDIRS.includes('.kimi-work'))

  assert.throws(() => assertSafeWorkspaceCwd(join(homedir(), '.kimi')), /安全限制/)
  assert.throws(() => assertSafeWorkspaceCwd(join(homedir(), '.kimi-work')), /安全限制/)
  assert.throws(
    () => assertSafeWorkspaceCwd(join(homedir(), 'AppData', 'Roaming', 'kimi-desktop', 'daimon-share')),
    /安全限制/,
  )
})

test('assertLoopbackControlUrl enforces localhost/loopback WebSocket endpoints only', () => {
  assert.equal(assertLoopbackControlUrl('ws://127.0.0.1:11247/control'), 'ws://127.0.0.1:11247/control')
  assert.equal(assertLoopbackControlUrl('ws://localhost:11247/control'), 'ws://localhost:11247/control')
  assert.equal(assertLoopbackControlUrl('ws://[::1]:11247/control'), 'ws://[::1]:11247/control')

  assert.throws(() => assertLoopbackControlUrl('ws://192.168.1.20:11247/control'), /安全限制/)
  assert.throws(() => assertLoopbackControlUrl('wss://evil.example.com/control'), /安全限制/)
  assert.throws(() => assertLoopbackControlUrl('http://127.0.0.1:11247/control'), /协议不受支持/)
})

test('formatKimiModelName & normalizeKimiThinkingLevel normalize models and efforts', () => {
  assert.equal(formatKimiModelName('k3-agent'), 'Kimi K3 Agent')
  assert.equal(formatKimiModelName('k3d1-agent'), 'Kimi K3.1 Agent')
  assert.equal(formatKimiModelName('k2d8-preview'), 'Kimi K2.8 Preview')
  assert.equal(formatKimiModelName('k4d2-pro'), 'Kimi K4.2 Pro')
  assert.equal(formatKimiModelName('custom-id', 'Custom Display'), 'Custom Display')

  assert.equal(normalizeKimiThinkingLevel('high', ['low', 'high', 'max']), 'high')
  assert.equal(normalizeKimiThinkingLevel('medium', ['low', 'high', 'max']), 'high')
  assert.equal(normalizeKimiThinkingLevel('xhigh', ['low', 'high', 'max']), 'max')
  assert.equal(normalizeKimiThinkingLevel('disabled', ['low', 'high', 'max']), 'low')
  assert.equal(normalizeKimiThinkingLevel('off', ['off', 'low', 'high']), 'off')
})

test('readKimiQuotaFromLogs extracts live omniRatio, resetAt, and plan tier', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-log-'))
  try {
    writeFileSync(
      join(dir, 'main.log'),
      [
        '[2026-11-27 17:09:13.902] [info]  [SubscriptionManager]  refresh: calling getSubscription',
        '[2026-11-27 17:09:13.972] [info]  [SubscriptionManager]  refreshed(sub): level=10 isMember=false omniRatio=0.124 exhausted=false resetAt=2026-11-30T02:52:53.450Z',
        '[2026-11-27 17:12:29.159] [info]  [SubscriptionManager]  refreshed(sub): level=20 isMember=true omniRatio=0.025800000876188278 exhausted=false resetAt=2026-11-30T02:52:53.450Z',
      ].join('\n'),
      'utf8',
    )
    const quota = readKimiQuotaFromLogs(dir)
    assert.ok(quota)
    assert.equal(quota.planType, 'Member')
    assert.equal(quota.remainingPercent, 97)
    assert.equal(quota.usedPercent, 3)
    assert.equal(quota.windowKind, 'weekly')
    assert.equal(quota.resetsAt, Date.parse('2026-11-30T02:52:53.450Z'))

    // Exhausted case clamps remainingPercent to 0
    writeFileSync(
      join(dir, 'main.log'),
      '[2026-11-27 17:20:00.000] [info]  [SubscriptionManager]  refreshed(sub): level=10 isMember=false omniRatio=0.98 exhausted=true resetAt=2026-11-30T02:52:53.450Z\n',
      'utf8',
    )
    const exhaustedQuota = readKimiQuotaFromLogs(dir)
    assert.equal(exhaustedQuota.remainingPercent, 0)
    assert.equal(exhaustedQuota.planType, 'Free')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalizeKimiControlMessages & normalizeKimiWireJsonl clean system blocks and preserve reasoning/tools', () => {
  assert.equal(
    stripKimiInjectedPromptBlocks('<system>\nsecret\n</system>\n<system-reminder>\ndate\n</system-reminder>\nHello Kimi'),
    'Hello Kimi',
  )

  const ctrlMsgs = normalizeKimiControlMessages([
    {
      id: '0:user:0',
      role: 'user',
      parts: [{ kind: 'text', text: '<system-reminder>ignore</system-reminder>\nBuild a chart' }],
      createdAt: '2026-11-27T09:00:00.000Z',
    },
    {
      id: '0:assistant:0',
      role: 'assistant',
      status: 'complete',
      parts: [
        { kind: 'reasoning', text: 'Inspecting files first.' },
        { kind: 'tool-call', toolCallId: 'tc-1', toolName: 'Read', args: '{"path":"app.js"}' },
        { kind: 'tool-result', toolCallId: 'tc-1', summary: 'Read 12 lines' },
        { kind: 'text', text: 'Chart is ready!' },
      ],
      createdAt: '2026-11-27T09:00:05.000Z',
    },
  ])
  assert.equal(ctrlMsgs.length, 2)
  assert.equal(ctrlMsgs[0].text, 'Build a chart')
  assert.equal(ctrlMsgs[1].thinking, 'Inspecting files first.')
  assert.equal(ctrlMsgs[1].text, 'Chart is ready!')
  assert.equal(ctrlMsgs[1].tools.length, 1)
  assert.equal(ctrlMsgs[1].tools[0].name, 'Read')
  assert.equal(ctrlMsgs[1].tools[0].status, 'completed')
  assert.equal(ctrlMsgs[1].tools[0].output, 'Read 12 lines')

  const wireJsonl = [
    JSON.stringify({
      type: 'agent.message.appended',
      message: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system>\nppt rules\n</system>\nhello' }],
        },
      },
    }),
    JSON.stringify({
      type: 'agent.message.appended',
      message: {
        message: {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Greeting back.' },
            { type: 'text', text: 'Hello there!' },
          ],
          toolCalls: [{ id: 't1', function: { name: 'Glob', arguments: '{"pattern":"*.js"}' } }],
        },
      },
    }),
    JSON.stringify({
      type: 'agent.message.appended',
      message: {
        message: {
          role: 'tool',
          toolCallId: 't1',
          content: [{ type: 'text', text: 'index.js' }],
        },
      },
    }),
  ].join('\n')

  const wireMsgs = normalizeKimiWireJsonl(wireJsonl)
  assert.equal(wireMsgs.length, 2)
  assert.equal(wireMsgs[0].text, 'hello')
  assert.equal(wireMsgs[1].thinking, 'Greeting back.')
  assert.equal(wireMsgs[1].text, 'Hello there!')
  assert.equal(wireMsgs[1].tools[0].output, 'index.js')
})

test('KimiAdapter E2E over mock Control WebSocket (status, models, sessions, send/stream, cancel, approvals)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-e2e-'))
  const dataDir = join(root, 'daimon-share', 'daimon')
  const logsDir = join(root, 'logs')
  const projDir = join(root, 'my-project')
  mkdirSync(join(dataDir, 'agents', 'main'), { recursive: true })
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(projDir, { recursive: true })

  writeFileSync(
    join(logsDir, 'main.log'),
    '[2026-11-27 17:12:29.159] [info]  [SubscriptionManager]  refreshed(sub): level=10 isMember=false omniRatio=0.05 exhausted=false resetAt=2026-11-30T02:52:53.450Z\n',
    'utf8',
  )

  const expectedToken = 'test-loopback-token-123'
  let authHeaderSeen = ''
  let lastSendParams = null
  let lastCancelParams = null
  let lastRespondParams = null
  let createdConvKey = ''

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/control' })
  await new Promise((resolve) => wss.once('listening', resolve))
  const port = wss.address().port

  writeFileSync(
    join(dataDir, 'agents', 'main', 'runner.state.json'),
    JSON.stringify({
      pid: process.pid,
      control: {
        endpoint: {
          url: `ws://127.0.0.1:${port}/control`,
          auth: { mode: 'loopback-dev-token', token: expectedToken },
        },
      },
    }),
    'utf8',
  )

  const convId = '11111111-2222-3333-4444-555555555555'
  const convKey = `agent:main:main:conversation:${convId}`
  let currentServerWs = null

  wss.on('connection', (ws, req) => {
    currentServerWs = ws
    authHeaderSeen = String(req.headers.authorization || '')
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'models.list') {
        reply({
          current: 'k3-agent',
          models: [
            { id: 'k3-agent', alias: 'k3-agent', label: 'k3-agent', providerId: 'daimon-kimi-code' },
            { id: 'k3d1-agent', alias: 'k3d1-agent', label: 'k3d1-agent', providerId: 'daimon-kimi-code' },
          ],
        })
      } else if (msg.method === 'conversations.getKimiModelList') {
        reply({
          provider: 'daimon-kimi-code',
          models: [
            { model: 'k3-agent', supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
            { model: 'k3d1-agent', supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
          ],
        })
      } else if (msg.method === 'workspace.getRoot') {
        reply({ endpointPath: projDir })
      } else if (msg.method === 'workspace.listProjects') {
        reply({ projects: [] })
      } else if (msg.method === 'conversations.list') {
        reply({
          conversations: [
            {
              conversationId: convId,
              conversationKey: convKey,
              title: 'Initial Kimi Chat',
              workspacePath: projDir,
              firstUserText: 'hi',
              createdAt: '2026-11-27T09:00:00.000Z',
              updatedAt: '2026-11-27T09:01:00.000Z',
              extra: { runtimePreferences: { modelAlias: 'k3-agent', thinkingLevel: 'high' } },
            },
          ],
        })
      } else if (msg.method === 'conversations.getMessages') {
        reply({
          messages: [
            { id: '0:user:0', role: 'user', parts: [{ kind: 'text', text: 'hi' }], createdAt: '2026-11-27T09:00:00.000Z' },
            { id: '0:assistant:0', role: 'assistant', parts: [{ kind: 'text', text: 'hello from kimi' }], createdAt: '2026-11-27T09:00:02.000Z' },
          ],
        })
      } else if (msg.method === 'conversations.goal.get') {
        reply({ goal: null })
      } else if (msg.method === 'conversations.create') {
        const newId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        createdConvKey = `agent:main:main:conversation:${newId}`
        reply({
          conversation: {
            conversationId: newId,
            conversationKey: createdConvKey,
            title: '',
            workspacePath: msg.params.workspacePath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        })
      } else if (msg.method === 'conversations.rename' || msg.method === 'conversations.setModel' || msg.method === 'conversations.setThinking') {
        reply({ ok: true })
      } else if (msg.method === 'conversations.send') {
        lastSendParams = msg.params
        const turnId = 'turn-42'
        reply({ accepted: true, turnId })
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'conversations.message.delta',
              params: {
                conversationKey: msg.params.conversationKey,
                turnId,
                messageId: 'm1',
                partIndex: 0,
                partKind: 'reasoning',
                append: 'Thinking...',
              },
            }),
          )
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'conversations.message.snapshot',
              params: {
                conversationKey: msg.params.conversationKey,
                turnId,
                message: {
                  id: 'm1',
                  role: 'assistant',
                  parts: [
                    { kind: 'reasoning', text: 'Thinking...' },
                    { kind: 'tool-call', toolCallId: 'tc-9', toolName: 'Bash', args: '{"command":"echo ok"}' },
                    { kind: 'tool-result', toolCallId: 'tc-9', summary: 'ok' },
                    { kind: 'text', text: 'Done!' },
                  ],
                },
              },
            }),
          )
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'conversations.message.complete',
              params: {
                conversationKey: msg.params.conversationKey,
                turnId,
                message: {
                  id: 'm1',
                  role: 'assistant',
                  parts: [
                    { kind: 'reasoning', text: 'Thinking...' },
                    { kind: 'text', text: 'Done!' },
                  ],
                },
              },
            }),
          )
        }, 20)
      } else if (msg.method === 'conversations.cancel') {
        lastCancelParams = msg.params
        reply({ cancelled: true })
      } else if (msg.method === 'interaction.respond') {
        lastRespondParams = msg.params
        reply({ ok: true })
      }
    })
  })

  const events = []
  const approvals = []
  const adapter = new KimiAdapter({
    config: { kimiDataDir: dataDir },
    emitEvent: (ev, payload) => events.push({ ev, payload }),
    onApprovalRequest: (req) => approvals.push(req),
  })

  try {
    const status = await adapter.getStatus({ forceQuota: true })
    assert.equal(status.available, true)
    assert.equal(status.writable, true)
    assert.equal(status.mode, 'kimi-control-ws')
    assert.equal(status.quota.remainingPercent, 95)
    assert.equal(authHeaderSeen, `Bearer ${expectedToken}`)

    const catalog = await adapter.listModels()
    assert.equal(catalog.defaultModel, 'k3-agent')
    assert.equal(catalog.supportsMidChatSwitch, true)
    assert.equal(catalog.models.length, 2)
    assert.equal(catalog.models[0].name, 'Kimi K3 Agent')

    const workspaces = await adapter.listWorkspaces()
    assert.ok(workspaces.some((w) => w.path === projDir))

    const sessions = await adapter.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, `kimi:${convId}`)
    assert.equal(sessions[0].writable, true)

    const detail = await adapter.readSession(convId)
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[1].text, 'hello from kimi')

    const created = await adapter.createSession({
      cwd: projDir,
      title: 'My Test Chat',
      model: 'k3d1-agent',
      reasoningEffort: 'max',
    })
    assert.equal(created.app, 'kimi')
    assert.equal(created.title, 'My Test Chat')
    assert.ok(createdConvKey.endsWith(created.nativeId))

    const sendRes = await adapter.sendMessage(created.nativeId, {
      text: 'Inspect this',
      attachments: [{ localPath: join(projDir, 'photo.png'), mimeType: 'image/png' }],
      model: 'k3d1-agent',
      reasoningEffort: 'max',
      taskMode: 'plan',
    })
    assert.equal(sendRes.finalText, 'Done!')
    assert.equal(sendRes.aborted, false)
    assert.equal(lastSendParams.modelAlias, 'k3d1-agent')
    assert.equal(lastSendParams.thinkingLevel, 'max')
    assert.equal(lastSendParams.planMode, true)
    assert.ok(lastSendParams.text.includes('photo.png'))
    assert.equal(lastSendParams.attachments, undefined)

    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_THINKING && e.payload.delta === 'Thinking...'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_TOOL_START && e.payload.tool.name === 'Bash'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_TOOL_END && e.payload.tool.status === 'completed'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_DELTA && e.payload.delta === 'Done!'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_DONE && e.payload.text === 'Done!'))

    // Interrupt RPC
    const intRes = await adapter.interrupt(created.nativeId)
    assert.equal(intRes.interrupted, true)
    assert.equal(lastCancelParams.conversationKey, createdConvKey)

    // Interactive approval flow
    currentServerWs.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'interaction.pending',
        params: {
          interaction: {
            interactionId: 'int-77',
            kind: 'permission',
            conversationKey: createdConvKey,
            title: 'Allow Bash?',
            options: [
              { optionId: 'allow_once', label: 'Allow once' },
              { optionId: 'deny', label: 'Deny' },
            ],
          },
        },
      }),
    )
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].id, 'int-77')
    await adapter.resolveApproval('int-77', 'allow_once')
    assert.deepEqual(lastRespondParams, { interactionId: 'int-77', optionId: 'allow_once' })
  } finally {
    adapter.dispose()
    await new Promise((resolve) => wss.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('KimiAdapter falls back to read-only SQLite + wire.jsonl when Kimi Desktop is closed', async () => {
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync) return

  const root = mkdtempSync(join(tmpdir(), 'kimi-offline-'))
  const dataDir = join(root, 'daimon-share', 'daimon')
  const sqlDir = join(dataDir, 'agents', 'main', 'sessions', 'hosted-logical')
  const wireDir = join(dataDir, 'runtime', 'kimi-code', 'conv-1')
  mkdirSync(sqlDir, { recursive: true })
  mkdirSync(wireDir, { recursive: true })

  const wirePath = join(wireDir, 'wire.jsonl')
  writeFileSync(
    wirePath,
    [
      JSON.stringify({
        type: 'agent.message.appended',
        time: 1795770447118,
        message: { message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\nOffline question' }] } },
      }),
      JSON.stringify({
        type: 'agent.message.appended',
        time: 1795770450650,
        message: { message: { role: 'assistant', content: [{ type: 'text', text: 'Offline answer' }] } },
      }),
    ].join('\n'),
    'utf8',
  )

  const dbPath = join(sqlDir, 'conversations.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE conversations (
      conversation_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      title TEXT,
      workspace_path TEXT,
      kernel_records_path TEXT,
      first_user_text TEXT,
      first_assistant_text TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      archived_at_ms INTEGER,
      extra_json TEXT
    );
  `)
  const convId = '99999999-8888-7777-6666-555555555555'
  db.prepare(
    `INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    `agent:main:main:conversation:${convId}`,
    convId,
    'agent:main:main',
    'Offline Chat',
    root,
    wirePath,
    'Offline question',
    'Offline answer',
    1795770447000,
    1795770450000,
    JSON.stringify({ runtimePreferences: { modelAlias: 'k3-agent', thinkingLevel: 'high' } }),
  )
  db.close()

  const adapter = new KimiAdapter({ config: { kimiDataDir: dataDir } })
  try {
    const status = await adapter.getStatus()
    assert.equal(status.available, true)
    assert.equal(status.writable, false)
    assert.equal(status.mode, 'kimi-desktop-ro')

    const sessions = await adapter.listSessions()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].title, 'Offline Chat')
    assert.equal(sessions[0].writable, false)
    assert.equal(sessions[0].source, 'kimi-desktop')

    const detail = await adapter.readSession(convId)
    assert.equal(detail.writable, false)
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.messages[0].text, 'Offline question')
    assert.equal(detail.messages[1].text, 'Offline answer')
  } finally {
    adapter.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('MultiAppOrchestrator registers KimiAdapter cleanly', () => {
  const orch = new MultiAppOrchestrator({ config: {} })
  try {
    assert.ok(orch.enabledApps.includes(APPS.KIMI))
    assert.equal(orch.getAdapter(APPS.KIMI).app, 'kimi')
  } finally {
    orch.dispose?.()
  }
})
