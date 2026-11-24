import { APP_LIST } from './protocol.js'

/**
 * Registers Master Orchestrator tools directly into DeepSeek Harness's Cordis `tools` layer.
 * Any DSH conversation (mobile OR desktop) can then inspect and dispatch work to:
 *   - Codex (via official `codex app-server`)
 *   - Claude Code / Desktop Code (via official `claude` CLI)
 *   - Antigravity (official agy acp)
 *   - Other DeepSeek Harness sessions
 */
export function registerDshDispatchTools(ctx, orchestrator, log = console) {
  const tools = ctx?.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    log.warn?.('mobile-hub: ctx.get("tools") unavailable, skipping DSH cross-app dispatch tools')
    return
  }

  const safeRegister = (definition) =>
    ctx.effect(() => {
      try {
        return tools.register(definition)
      } catch (err) {
        log.error?.(`mobile-hub: failed to register DSH tool "${definition.name}": ${String(err)}`)
        return () => {}
      }
    })

  // 1. Inspect all 4 apps status & workspaces
  safeRegister({
    name: 'allinone_apps_status',
    description:
      '查看本机 DeepSeek Harness、Codex、Claude Code、Antigravity 四个 AI 应用的在线可用状态、读写权限以及活跃任务数量。' +
      '在跨应用派单前可先调用本工具确认哪些应用可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { apps: { type: 'array' } },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: (value.apps || [])
            .map((a) => `- **${a.app}**: ${a.available ? '可用' : '不可用'} (${a.mode}) — ${a.detail}`)
            .join('\n'),
        },
      ],
    },
    async execute() {
      const apps = await orchestrator.getAppsStatus()
      return { apps }
    },
  })

  // 2. List sessions across any/all apps
  safeRegister({
    name: 'allinone_list_sessions',
    description:
      '列出本机 DeepSeek Harness / Codex / Claude / Antigravity 的所有对话列表（包含复合 ID、标题、工作目录、最近摘要和运行状态）。' +
      '当用户说“看看 Codex 最近在干嘛”“找到 Claude 里关于 XX 项目的对话”时使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        app: {
          type: 'string',
          enum: ['all', ...APP_LIST],
          description: '要筛选的应用：all（全部）、dsh、codex、claude、antigravity。默认 all。',
        },
        search: {
          type: 'string',
          description: '可选搜索关键词（匹配标题、摘要或工作目录）。',
        },
        limit: {
          type: 'integer',
          description: '返回条数上限，默认 20，最大 60。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { sessions: { type: 'array' } },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.sessions || []).length === 0
              ? '没有找到匹配的会话。'
              : value.sessions
                  .map(
                    (s) =>
                      `- [${s.app}] \`${s.id}\` **${s.title}** (${s.status}) | 目录: ${s.cwd || '-'} | 摘要: ${s.preview || '-'}`,
                  )
                  .join('\n'),
        },
      ],
    },
    async execute(args) {
      const sessions = await orchestrator.listSessions({
        app: args?.app || 'all',
        search: args?.search || '',
        limit: Math.min(Math.max(1, Number(args?.limit || 20)), 60),
      })
      return { sessions }
    },
  })

  // 3. Read recent messages from any app's conversation
  safeRegister({
    name: 'allinone_read_session',
    description:
      '读取指定应用某个对话的最近若干条消息记录（含思考和工具调用摘要），用于汇总上下文或检查进度。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: '复合会话 ID（格式 `<app>:<nativeId>`，例如 `codex:019...`、`claude:uuid`、`antigravity:uuid`）。',
        },
        limit: {
          type: 'integer',
          description: '读取最近多少条消息，默认 12。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { session: { type: 'object' } },
      },
      render: (_args, value) => {
        const s = value.session || {}
        const lines = (s.messages || []).map(
          (m) => `[${m.role}] ${(m.text || '').slice(0, 800)}${m.tools?.length ? ` (工具: ${m.tools.map((t) => t.name).join(', ')})` : ''}`,
        )
        return [
          {
            type: 'text',
            text: `会话 ${s.title || s.id}（${s.app}，目录 ${s.cwd || '-'}）：\n\n${lines.join('\n\n')}`,
          },
        ]
      },
    },
    async execute(args) {
      const session = await orchestrator.readSession({
        id: args.id,
        limit: Math.min(Math.max(1, Number(args?.limit || 12)), 40),
      })
      return { session }
    },
  })

  // 4. Dispatch a task to Codex / Claude / Antigravity / another DSH session
  safeRegister({
    name: 'allinone_dispatch_task',
    description:
      '向指定应用（codex / claude / antigravity / dsh）派发一个任务：可指定已有会话继续聊，或不传 sessionId 自动新建会话。' +
      '设置 wait=true 会等待对方执行完成并直接拿回结果；设置 wait=false 会立即异步派单并返回 taskId（适合并行给多个应用同时派活，再用 allinone_task_status 查进度）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['app', 'prompt'],
      properties: {
        app: {
          type: 'string',
          enum: APP_LIST,
          description: '目标应用：codex、claude、antigravity 或 dsh。',
        },
        prompt: {
          type: 'string',
          description: '发给目标应用的完整指令内容。',
        },
        sessionId: {
          type: 'string',
          description: '可选。要续聊的会话 ID（可以是 `<app>:<id>` 或原生 ID）；留空则新建对话。',
        },
        cwd: {
          type: 'string',
          description: '可选。新建对话时的工作目录绝对路径（例如 `/path/to/your-project`）。',
        },
        title: {
          type: 'string',
          description: '可选。新建对话的显示标题。',
        },
        wait: {
          type: 'boolean',
          description: '是否同步等待完成并返回最终回答。默认 true；并行多派单时传 false。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { task: { type: 'object' } },
      },
      render: (_args, value) => {
        const t = value.task || {}
        const body = t.status === 'completed'
          ? `\n\n结果：\n${(t.result || '').slice(0, 3000)}`
          : t.status === 'error'
            ? `\n\n错误：${t.error}`
            : '\n\n已在后台启动执行，可随时用 allinone_task_status 查询进展。'
        return [
          {
            type: 'text',
            text: `派单任务 ${t.taskId} → [${t.app}] 会话 \`${t.sessionId}\` 状态：${t.status}${body}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const wait = args?.wait !== false
      const task = await orchestrator.dispatchTask({
        app: args.app,
        prompt: args.prompt,
        sessionId: args?.sessionId || '',
        cwd: args?.cwd || exec?.agent?.session?.meta?.cwd || '',
        title: args?.title || '',
        wait,
        issuedBy: `dsh:${exec?.agent?.id || 'master'}`,
      })
      return { task }
    },
  })

  // 5. Check async dispatch task status
  safeRegister({
    name: 'allinone_task_status',
    description: '查询通过 allinone_dispatch_task(wait=false) 派发的后台任务状态和输出结果；不传 taskId 则列出最近全部派单任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: {
          type: 'string',
          description: '可选。具体派单任务 ID。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => {
        if (value.task) {
          const t = value.task
          return [
            {
              type: 'text',
              text: `任务 ${t.taskId} [${t.app} / ${t.sessionId}] 状态：${t.status}\n${t.result || t.error || '执行中…'}`,
            },
          ]
        }
        const list = value.tasks || []
        return [
          {
            type: 'text',
            text:
              list.length === 0
                ? '当前没有跨应用派单记录。'
                : list.map((t) => `- ${t.taskId} [${t.app}] ${t.status} · ${t.prompt.slice(0, 50)}`).join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      if (args?.taskId) {
        return { task: orchestrator.getDispatchStatus(args.taskId) }
      }
      return { tasks: orchestrator.listDispatches({ limit: 20 }) }
    },
  })

  // 6. Interrupt a running session in any app
  safeRegister({
    name: 'allinone_interrupt_session',
    description: '中断指定应用正在运行的某个对话任务（例如卡住或需要调整方向时）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: '复合会话 ID（`<app>:<nativeId>`）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.interrupted ? `已发送中断指令到 ${value.sessionId}` : `目标会话当前未在运行：${value.sessionId}`,
        },
      ],
    },
    async execute(args) {
      return orchestrator.interruptSession({ id: args.id })
    },
  })
}
