import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { APPS, APP_LIST, APP_META, EVENTS } from '../packages/shared/src/protocol.js'
import { assertSafeWorkspaceCwd } from '../packages/dsh-mobile-hub/src/protocol.js'
import { resolveSafeDeliverableCwd, resolveSafeDesktopDeliverable } from '../packages/desktop-app/src/safe-paths.js'
import { MultiAppOrchestrator } from '../packages/dsh-mobile-hub/src/orchestrator.js'
import {
  ZCodeAdapter,
  ensureZCodeManagedAuthStore,
  extractZCodeTaskState,
  hasZCodeStandaloneAuth,
  isSafeZCodeAuthUrl,
  normalizeZCodeBillingQuota,
  normalizeZCodeDbMessages,
  parseZCodeStreamEvent,
  readZCodeQuotaFromLogs,
  resolveEffectiveZCodeMode,
} from '../packages/dsh-mobile-hub/src/adapters/zcode.js'
import { extractVendorQuotaDetails } from '../packages/mobile-app/src/lib/quotaDashboard.js'

function makeTempDir(prefix = 'allinone-zcode-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function createFakeZCodeDb(zcodeHome, workspaceDir) {
  const cliDbDir = join(zcodeHome, 'cli', 'db')
  const v2Dir = join(zcodeHome, 'v2')
  mkdirSync(cliDbDir, { recursive: true })
  mkdirSync(v2Dir, { recursive: true })

  const dbPath = join(cliDbDir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      time_deleted INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      position INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_id, position)
    );
    CREATE TABLE session_target (
      session_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_runtime_presence (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `)

  const now = Date.now()
  const sid = 'sess_11111111-2222-3333-4444-555555555555'
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, path, title, version, time_created, time_updated)
     VALUES (?, 'proj1', 'demo', ?, ?, 'ZCode 实测对话', '4.0.0', ?, ?)`,
  ).run(sid, workspaceDir, workspaceDir, now - 60_000, now - 5_000)

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('msg_1', sid, now - 50_000, now - 50_000, JSON.stringify({ role: 'user', time: { created: now - 50_000 } }), 1)
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('part_1', 'msg_1', sid, now - 50_000, now - 50_000, JSON.stringify({ type: 'text', text: '帮我检查构建状态' }), 1)

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'msg_2',
    sid,
    now - 40_000,
    now - 5_000,
    JSON.stringify({ role: 'assistant', modelID: 'GLM-5.3', time: { created: now - 40_000 } }),
    2,
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('part_2', 'msg_2', sid, now - 39_000, now - 39_000, JSON.stringify({ type: 'reasoning', text: '先检查 package.json' }), 1)
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'part_3',
    'msg_2',
    sid,
    now - 38_000,
    now - 35_000,
    JSON.stringify({
      type: 'tool',
      callId: 'tc_1',
      tool: 'Read',
      state: { status: 'completed', input: { file_path: 'package.json' }, output: '{"name":"demo"}', title: 'Read' },
    }),
    2,
  )
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('part_4', 'msg_2', sid, now - 30_000, now - 5_000, JSON.stringify({ type: 'text', text: '构建配置正常！' }), 3)

  db.prepare(
    `INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
     VALUES (?, '检查依赖', 'completed', 'medium', 0, ?, ?)`,
  ).run(sid, now - 30_000, now - 10_000)
  db.prepare(
    `INSERT INTO session_target (session_id, target_id, objective, status, time_created, time_updated)
     VALUES (?, 'tgt_1', '确保 CI 通过', 'active', ?, ?)`,
  ).run(sid, now - 30_000, now - 10_000)
  db.close()

  const tasksDb = new DatabaseSync(join(v2Dir, 'tasks-index.sqlite'))
  tasksDb.exec(`
    CREATE TABLE tasks (
      workspace_key TEXT, workspace_path TEXT, task_id TEXT, title TEXT,
      task_status TEXT, provider TEXT, mode TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, name TEXT, position INTEGER, pinned INTEGER, deleted INTEGER
    );
    CREATE TABLE project_roots (
      project_id TEXT, root_path TEXT, position INTEGER, is_primary INTEGER
    );
  `)
  tasksDb.prepare(`INSERT INTO projects VALUES ('p1', 'DemoProj', 0, 1, 0)`).run()
  tasksDb.prepare(`INSERT INTO project_roots VALUES ('p1', ?, 0, 1)`).run(workspaceDir)
  tasksDb
    .prepare(`INSERT INTO tasks VALUES (?, ?, ?, 'ZCode 实测对话', 'idle', 'account:bigmodel-individual-coding-plan', 'build', 'GLM-5.3', ?, ?)`)
    .run(workspaceDir, workspaceDir, sid, now - 60_000, now - 5_000)
  tasksDb.close()

  writeFileSync(
    join(v2Dir, 'setting.json'),
    JSON.stringify({
      providerFamilyDomain: 'bigmodel',
      providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } },
      lastActiveWorkspace: { workspacePath: workspaceDir },
    }),
    'utf8',
  )

  return { sid }
}

test('ZCode shared protocol registration & security path guards', () => {
  assert.equal(APPS.ZCODE, 'zcode')
  assert.ok(APP_LIST.includes('zcode'))
  assert.equal(APP_META.zcode.id, 'zcode')
  assert.equal(APP_META.zcode.badge, 'ZCD')

  const fakeHome = makeTempDir('allinone-zcode-home-')
  try {
    mkdirSync(join(fakeHome, '.zcode', 'v2'), { recursive: true })
    mkdirSync(join(fakeHome, '.zcode', 'cli', 'db'), { recursive: true })
    mkdirSync(join(fakeHome, '.zcode', 'workspace', 'default'), { recursive: true })
    writeFileSync(join(fakeHome, '.zcode', 'v2', 'credentials.json'), '{}', 'utf8')
    writeFileSync(join(fakeHome, '.zcode', 'workspace', 'default', 'report.md'), '# ok', 'utf8')

    // assertSafeWorkspaceCwd blocks sensitive ZCode internals but allows ZCode workspace dir
    assert.throws(() => assertSafeWorkspaceCwd(join(fakeHome, '.zcode', 'v2')))
    assert.throws(() => assertSafeWorkspaceCwd(join(fakeHome, '.zcode', 'cli', 'db')))
    const okWs = assertSafeWorkspaceCwd(join(fakeHome, '.zcode', 'workspace', 'default'))
    assert.ok(okWs.endsWith('default'))

    // Desktop safe-paths blocks credentials under ~/.zcode/v2 while allowing ~/.zcode/workspace deliverables
    assert.equal(resolveSafeDeliverableCwd(join(fakeHome, '.zcode', 'v2'), fakeHome), '')
    assert.ok(resolveSafeDeliverableCwd(join(fakeHome, '.zcode', 'workspace', 'default'), fakeHome))
    const blockedCred = resolveSafeDesktopDeliverable(
      join(fakeHome, '.zcode', 'v2', 'credentials.json'),
      join(fakeHome, '.zcode', 'workspace', 'default'),
      { homeDir: fakeHome },
    )
    assert.equal(blockedCred.ok, false)
    const allowedReport = resolveSafeDesktopDeliverable(
      join(fakeHome, '.zcode', 'workspace', 'default', 'report.md'),
      join(fakeHome, '.zcode', 'workspace', 'default'),
      { homeDir: fakeHome },
    )
    assert.equal(allowedReport.ok, true)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('ZCode auth URL allowlist, mode clamping, and standalone auth detection', () => {
  assert.equal(isSafeZCodeAuthUrl('https://open.bigmodel.cn/oauth/authorize?code=1'), true)
  assert.equal(isSafeZCodeAuthUrl('https://z.ai/oauth/login?state=abc'), true)
  assert.equal(isSafeZCodeAuthUrl('https://zcode.z.ai/auth/callback'), true)
  assert.equal(isSafeZCodeAuthUrl('http://open.bigmodel.cn/oauth'), false)
  assert.equal(isSafeZCodeAuthUrl('javascript:alert(1)'), false)
  assert.equal(isSafeZCodeAuthUrl('https://evil.example.com/bigmodel.cn'), false)

  assert.equal(resolveEffectiveZCodeMode('', 'build', 'plan'), 'plan')
  assert.equal(resolveEffectiveZCodeMode('guarded', 'build', null), 'guarded')
  assert.throws(() => resolveEffectiveZCodeMode('yolo', 'build', null))
  assert.throws(() => resolveEffectiveZCodeMode('invalid-mode', 'build', null))

  const dir = makeTempDir('allinone-zcode-auth-')
  const managedDir = join(dir, 'managed-auth')
  try {
    mkdirSync(join(dir, 'v2'), { recursive: true })
    // Desktop-only OAuth credentials without standalone account-provider identity -> not standalone ready
    writeFileSync(
      join(dir, 'v2', 'credentials.json'),
      JSON.stringify({ 'oauth:zai_cn:access_token': 'enc:v2:os:xxx', zcodejwttoken: 'enc:v2:os:yyy' }),
      'utf8',
    )
    assert.equal(hasZCodeStandaloneAuth({ zcodeHome: dir, authDir: managedDir, env: {} }), false)

    // Env API key unlocks standalone auth
    assert.equal(hasZCodeStandaloneAuth({ zcodeHome: dir, authDir: managedDir, env: { BIGMODEL_API_KEY: 'test-key' } }), true)

    // Isolated managed auth store (`ZCODE_CREDENTIAL_SECRET_FILE` + `ZCODE_CREDENTIALS_FILE`) unlocks standalone auth
    const store = ensureZCodeManagedAuthStore(managedDir)
    writeFileSync(
      store.credentialsFile,
      JSON.stringify({ 'account-provider:account:bigmodel-individual-coding-plan:identity': 'enc:v2:env:abc' }),
      'utf8',
    )
    assert.equal(hasZCodeStandaloneAuth({ zcodeHome: dir, authDir: managedDir, env: {} }), true)

    // `provider_config.json` defaultModelSelection written by `zcode login` in `~/.zcode/v2/` also unlocks standalone auth
    const emptyManaged = join(dir, 'empty-managed')
    writeFileSync(
      join(dir, 'v2', 'provider_config.json'),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          defaultModelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' },
        },
      }),
      'utf8',
    )
    assert.equal(hasZCodeStandaloneAuth({ zcodeHome: dir, authDir: emptyManaged, env: {} }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ZCode billing/balance quota normalization & log tail extraction + quotaDashboard daily labels', () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const samplePayload = {
    payload: {
      code: 0,
      data: {
        plans: [
          {
            plan_id: 'zcode-v3-start-plan-0817',
            name: 'ZCode Start Plan',
            status: 'active',
            entitlements: [
              { entitlement_id: 'ent_glm54', show_name: 'GLM-5.4', period: 'daily', grant_units: 3000000 },
              { entitlement_id: 'ent_glm53f', show_name: 'GLM-5.3-Flash', period: 'daily', grant_units: 5000000 },
            ],
          },
        ],
        balances: [
          {
            entitlement_id: 'ent_glm54',
            show_name: 'GLM-5.4',
            total_units: 3000000,
            used_units: 900000,
            remaining_units: 2100000,
            available_units: 2100000,
            period_start: nowSec - 3600,
            period_end: nowSec + 82800,
          },
          {
            entitlement_id: 'ent_glm53f',
            show_name: 'GLM-5.3-Flash',
            total_units: 5000000,
            used_units: 0,
            remaining_units: 5000000,
            available_units: 5000000,
            period_start: nowSec - 3600,
            period_end: nowSec + 82800,
          },
        ],
      },
    },
  }

  const quota = normalizeZCodeBillingQuota(samplePayload, { now: nowSec * 1000 })
  assert.ok(quota)
  assert.equal(quota.planType, 'ZCode Start Plan')
  assert.equal(quota.remainingPercent, 70) // min(70%, 100%)
  assert.equal(quota.pools.length, 2)
  assert.equal(quota.pools[0].label, 'GLM-5.4')
  assert.equal(quota.pools[0].windows[0].kind, 'daily')
  assert.equal(quota.pools[0].windows[0].remainingPercent, 70)

  // Verify HomeQuotaDashboard normalizer renders Daily Window cleanly in zh & en
  const zhDetails = extractVendorQuotaDetails(quota, { lang: 'zh', now: nowSec * 1000 })
  assert.equal(zhDetails.hasMultiPool, true)
  assert.equal(zhDetails.pools[0].windows[0].label, '今日额度')
  const enDetails = extractVendorQuotaDetails(quota, { lang: 'en', now: nowSec * 1000 })
  assert.equal(enDetails.pools[0].windows[0].label, 'Daily Window')

  // Verify readZCodeQuotaFromLogs extracts from ~/.zcode/v2/logs/YYYY-MM-DD.log
  const dir = makeTempDir('allinone-zcode-logs-')
  try {
    mkdirSync(join(dir, 'v2', 'logs'), { recursive: true })
    const logLine = `[2026-11-27 12:48:32.688] [info] [usage-stats] billing/balance 请求完成 ${JSON.stringify(samplePayload)}\n`
    writeFileSync(join(dir, 'v2', 'logs', '2026-11-27.log'), logLine, 'utf8')
    const fromLog = readZCodeQuotaFromLogs(dir, { now: nowSec * 1000 })
    assert.ok(fromLog)
    assert.equal(fromLog.remainingPercent, 70)
    assert.equal(fromLog.pools.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ZCode stream event parser & DB normalizer', () => {
  assert.deepEqual(
    parseZCodeStreamEvent({ type: 'model.streaming', sessionId: 'sess_a', payload: { kind: 'text_delta', delta: 'Hi' } }),
    { kind: 'text_delta', sessionId: 'sess_a', delta: 'Hi' },
  )
  assert.deepEqual(
    parseZCodeStreamEvent({ type: 'model.streaming', sessionId: 'sess_a', payload: { kind: 'reasoning_delta', delta: 'Hmm' } }),
    { kind: 'thinking_delta', sessionId: 'sess_a', delta: 'Hmm' },
  )
  const toolStart = parseZCodeStreamEvent({
    type: 'tool.updated',
    sessionId: 'sess_a',
    payload: { kind: 'started', toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' } },
  })
  assert.equal(toolStart.kind, 'tool_start')
  assert.equal(toolStart.tool.name, 'Bash')

  const toolEnd = parseZCodeStreamEvent({
    type: 'tool.updated',
    sessionId: 'sess_a',
    payload: { kind: 'result', toolCallId: 'c1', result: 'ok' },
  })
  assert.equal(toolEnd.kind, 'tool_end')
  assert.equal(toolEnd.status, 'completed')

  const msgNorm = normalizeZCodeDbMessages(
    [{ id: 'm1', time_created: 1000, data: JSON.stringify({ role: 'user' }) }],
    [{ id: 'p1', message_id: 'm1', data: JSON.stringify({ type: 'text', text: 'hello' }) }],
  )
  assert.equal(msgNorm.messages.length, 1)
  assert.equal(msgNorm.messages[0].text, 'hello')

  const ts = extractZCodeTaskState([{ content: 'Step 1', status: 'in_progress' }], { objective: 'Ship it', status: 'active' }, 'plan')
  assert.equal(ts.mode, 'plan')
  assert.equal(ts.goal.objective, 'Ship it')
  assert.equal(ts.steps.length, 1)
})

test('ZCodeAdapter end-to-end: RO SQLite sync, 1-click setup, RW streaming & orchestrator registration', async () => {
  const tmp = makeTempDir('allinone-zcode-e2e-')
  const wsDir = join(tmp, 'workspace')
  const zcodeHome = join(tmp, '.zcode')
  mkdirSync(wsDir, { recursive: true })
  const { sid } = createFakeZCodeDb(zcodeHome, wsDir)

  const events = []
  const spawnedCalls = []
  let authed = false

  const fakeSpawn = (bin, args, opts) => {
    spawnedCalls.push({ bin, args, opts })
    const proc = new EventEmitter()
    proc.pid = 99999
    proc.stdout = new EventEmitter()
    proc.stdout.setEncoding = () => {}
    proc.stderr = new EventEmitter()
    proc.stderr.setEncoding = () => {}
    proc.kill = () => {}

    if (args.includes('login')) {
      setTimeout(() => {
        proc.stderr.emit('data', 'Open this URL to sign in:\nhttps://open.bigmodel.cn/oauth/zcode?state=test123\n')
      }, 15)
      setTimeout(() => {
        authed = true
        proc.stdout.emit('data', JSON.stringify({ status: 'ready', provider: 'bigmodel' }) + '\n')
        proc.emit('close', 0)
      }, 60)
    } else {
      setTimeout(() => {
        const realSid = 'sess_new_9999'
        proc.stdout.emit('data', JSON.stringify({ type: 'session.created', sessionId: realSid }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'model.streaming', sessionId: realSid, payload: { kind: 'reasoning_delta', delta: '分析中' } }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'tool.updated', sessionId: realSid, payload: { kind: 'started', toolCallId: 't1', toolName: 'Read', input: { path: 'a.js' } } }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'tool.updated', sessionId: realSid, payload: { kind: 'result', toolCallId: 't1', result: 'done' } }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'model.streaming', sessionId: realSid, payload: { kind: 'text_delta', delta: '你好，' } }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'model.streaming', sessionId: realSid, payload: { kind: 'text_delta', delta: 'ZCode 已就绪！' } }) + '\n')
        proc.stdout.emit('data', JSON.stringify({ type: 'result', sessionId: realSid, response: '你好，ZCode 已就绪！' }) + '\n')
        proc.emit('close', 0)
      }, 20)
    }
    return proc
  }

  const adapter = new ZCodeAdapter({
    config: {
      zcodeHome,
      zcodeAuthDir: join(tmp, 'managed-auth'),
      cwd: wsDir,
      zcodeLauncher: { bin: 'node', baseArgs: ['/fake/zcode.cjs'], kind: 'desktop-bundled' },
      checkZCodeAuth: () => authed,
      spawnFn: fakeSpawn,
      fetchZCodeQuota: async () => null,
    },
    emitEvent: (ev, payload) => events.push({ ev, payload }),
  })

  try {
    // 1. Read-only mode before standalone login
    const stRo = await adapter.getStatus()
    assert.equal(stRo.app, 'zcode')
    assert.equal(stRo.available, true)
    assert.equal(stRo.writable, false)
    assert.equal(stRo.setupState, 'needs_login')

    const list = await adapter.listSessions()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, `zcode:${sid}`)
    assert.equal(list[0].title, 'ZCode 实测对话')

    const read = await adapter.readSession(sid)
    assert.equal(read.messages.length, 2)
    assert.equal(read.messages[1].thinking, '先检查 package.json')
    assert.equal(read.messages[1].tools[0].name, 'Read')
    assert.equal(read.taskState.goal.objective, '确保 CI 通过')

    const workspaces = await adapter.listWorkspaces()
    assert.ok(workspaces.some((w) => w.path === wsDir))

    const catalog = await adapter.listModels()
    assert.equal(catalog.app, 'zcode')
    assert.ok(catalog.models.some((m) => m.id === 'GLM-5.3'))

    await assert.rejects(() => adapter.createSession({ cwd: wsDir }), (err) => err.code === 'SESSION_READONLY')

    // 2. 1-click OAuth setup captures validated authorize_url, configures isolated secret file & unlocks RW
    const setupRes = await adapter.runSetup({ action: 'setup', methodId: 'internal' })
    assert.equal(setupRes.ok, true)
    assert.equal(setupRes.status, 'awaiting_login')
    assert.equal(setupRes.authUrl, 'https://open.bigmodel.cn/oauth/zcode?state=test123')
    assert.ok(spawnedCalls[0].opts.env.ZCODE_CREDENTIAL_SECRET_FILE)
    assert.ok(spawnedCalls[0].opts.env.ZCODE_CREDENTIALS_FILE)
    assert.equal(spawnedCalls[0].opts.env.ZCODE_CREDENTIAL_SECRET, undefined)
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(events.some((e) => e.ev === EVENTS.SESSION_UPDATED && e.payload?.authReady && e.payload?.app === 'zcode'))

    // 3. Read-write create + streaming send + Turn 2 --resume
    const stRw = await adapter.getStatus()
    assert.equal(stRw.writable, true)
    assert.equal(stRw.mode, 'zcode-cli-rw')

    const created = await adapter.createSession({ cwd: wsDir, model: 'GLM-5.3-Flash' })
    assert.equal(created.app, 'zcode')
    const turn1 = await adapter.sendMessage(created.nativeId, { text: '你好' })
    assert.equal(turn1.finalText, '你好，ZCode 已就绪！')
    assert.equal(turn1.nativeId, 'sess_new_9999')
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_THINKING && e.payload?.delta === '分析中'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_TOOL_START && e.payload?.tool?.name === 'Read'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_TOOL_END && e.payload?.toolId === 't1'))
    assert.ok(events.some((e) => e.ev === EVENTS.STREAM_DONE && e.payload?.finalText === '你好，ZCode 已就绪！'))

    // Turn 2 on same composite sessionId passes `--resume sess_new_9999`
    await adapter.sendMessage(created.nativeId, { text: '继续' })
    const lastCall = spawnedCalls.at(-1)
    assert.ok(lastCall.args.includes('--resume'))
    assert.ok(lastCall.args.includes('sess_new_9999'))

    // 4. MultiAppOrchestrator wires ZCode adapter cleanly
    const orch = new MultiAppOrchestrator({ config: { cwd: wsDir } })
    assert.ok(orch.enabledApps.includes(APPS.ZCODE))
    assert.ok(orch.getAdapter(APPS.ZCODE) instanceof ZCodeAdapter)
    await orch.dispose()
  } finally {
    await adapter.dispose()
    rmSync(tmp, { recursive: true, force: true })
  }
})
