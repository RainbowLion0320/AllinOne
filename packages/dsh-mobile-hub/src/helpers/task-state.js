import { basename } from 'node:path'

const MAX_STEPS = 40
const MAX_TITLE_LEN = 200
const MAX_FOCUS_LEN = 240
const MAX_PLAN_CONTENT_LEN = 30_000

const VALID_MODES = new Set(['plan', 'goal'])
const VALID_GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'complete', 'limited'])

/**
 * Normalize tool-specific step status strings into a unified 5-state enum.
 * @param {any} raw
 * @returns {'pending' | 'in_progress' | 'done' | 'failed' | 'skipped'}
 */
export function normalizeStepStatus(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (!s) return 'pending'
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'finished' || s === 'success') {
    return 'done'
  }
  if (s === 'in_progress' || s === 'inprogress' || s === 'running' || s === 'active' || s === 'working') {
    return 'in_progress'
  }
  if (s === 'failed' || s === 'error') {
    return 'failed'
  }
  if (s === 'skipped' || s === 'cancelled' || s === 'canceled') {
    return 'skipped'
  }
  return 'pending'
}

/**
 * Normalize Codex / generic goal status into unified status enum.
 * @param {any} raw
 * @returns {'active' | 'paused' | 'blocked' | 'complete' | 'limited'}
 */
export function normalizeGoalStatus(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (s === 'complete' || s === 'completed' || s === 'done') return 'complete'
  if (s === 'paused') return 'paused'
  if (s === 'blocked') return 'blocked'
  if (s === 'usagelimited' || s === 'budgetlimited' || s === 'limited') return 'limited'
  return 'active'
}

/**
 * Safely parse JSON when an adapter or transcript stores tool arguments as a JSON string.
 * @param {any} raw
 * @returns {any}
 */
export function parseMaybeJson(raw) {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (
    !trimmed ||
    (trimmed[0] !== '{' &&
      trimmed[0] !== '[' &&
      !(trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"'))
  ) {
    return raw
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

/**
 * Normalize any tool's step/todo array (or JSON-stringified array) into uniform step entries.
 * @param {any} raw
 * @returns {Array<{ id?: string, title: string, status: 'pending'|'in_progress'|'done'|'failed'|'skipped' }>}
 */
export function normalizeStepsList(raw) {
  const parsed = parseMaybeJson(raw)
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const title = String(
      item.title ??
        item.step ??
        item.content ??
        item.subject ??
        item.activeForm ??
        item.name ??
        item.text ??
        '',
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE_LEN)
    if (!title) continue
    const status = normalizeStepStatus(item.status ?? item.state)
    const entry = { title, status }
    if (item.id !== undefined && item.id !== null && String(item.id).trim()) {
      entry.id = String(item.id).trim().slice(0, 80)
    }
    out.push(entry)
    if (out.length >= MAX_STEPS) break
  }
  return out
}

/**
 * Normalize a taskState object into the canonical protocol shape, or return `null` when empty.
 * @param {any} raw
 */
export function normalizeTaskState(raw) {
  if (!raw || typeof raw !== 'object') return null

  const modeRaw = String(raw.mode || '')
    .trim()
    .toLowerCase()
  const mode = VALID_MODES.has(modeRaw) ? modeRaw : null

  const focus = String(raw.focus || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FOCUS_LEN)

  const steps = normalizeStepsList(raw.steps)

  let goal = null
  if (raw.goal && typeof raw.goal === 'object') {
    const objective = String(raw.goal.objective || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400)
    if (objective) {
      const st = normalizeGoalStatus(raw.goal.status)
      goal = {
        objective,
        status: VALID_GOAL_STATUSES.has(st) ? st : 'active',
      }
    }
  }

  let planDoc = null
  if (raw.planDoc && typeof raw.planDoc === 'object') {
    const path = String(raw.planDoc.path || '').trim()
    const content = typeof raw.planDoc.content === 'string'
      ? raw.planDoc.content.trim().slice(0, MAX_PLAN_CONTENT_LEN)
      : ''
    const title = String(raw.planDoc.title || (path ? basename(path) : '') || 'Plan')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)
    if (path || content) {
      planDoc = {
        title,
        ...(path ? { path } : {}),
        ...(content ? { content } : {}),
      }
    }
  }

  if (!mode && !focus && !goal && steps.length === 0 && !planDoc) {
    return null
  }

  const updatedAt = Number(raw.updatedAt || 0)
  return {
    mode,
    focus,
    ...(goal ? { goal } : {}),
    steps,
    ...(planDoc ? { planDoc } : {}),
    ...(updatedAt > 0 ? { updatedAt } : {}),
  }
}

function isMarkdownPlanPath(rawPath) {
  const clean = String(rawPath || '').replace(/\\/g, '/').trim()
  if (!clean || !/\.md$/i.test(clean)) return false
  const lower = clean.toLowerCase()
  const name = basename(lower)
  if (lower.includes('/.gemini/antigravity/brain/')) {
    return /plan|task|walkthrough|spec|design|proposal/i.test(name)
  }
  if (lower.includes('/.claude/plans/')) {
    return true
  }
  return false
}

/**
 * Stateful unified taskState tracker shared between history parsers and live streaming adapters.
 * Guarantees identical normalization regardless of whether data comes from disk logs or live RPC/ACP streams.
 */
export function createTaskStateTracker(initial = null) {
  const seed = normalizeTaskState(initial)
  const state = {
    mode: seed?.mode || null,
    focus: seed?.focus || '',
    goal: seed?.goal ? { ...seed.goal } : null,
    steps: seed?.steps ? seed.steps.map((s) => ({ ...s })) : [],
    planDoc: seed?.planDoc ? { ...seed.planDoc } : null,
    updatedAt: seed?.updatedAt || 0,
  }
  let claudeTaskSeq = 0
  for (const s of state.steps) {
    const num = Number(s?.id)
    if (Number.isInteger(num) && num > claudeTaskSeq) {
      claudeTaskSeq = num
    }
  }
  let lastSig = ''

  const touch = (ts) => {
    const n = Number(ts || 0)
    state.updatedAt = n > 0 ? Math.max(state.updatedAt, n) : Date.now()
  }

  const snapshot = () => normalizeTaskState(state)

  const signature = () => {
    const snap = snapshot()
    if (!snap) return ''
    const { updatedAt: _drop, ...stable } = snap
    return JSON.stringify(stable)
  }

  const consumeChanged = () => {
    const nextSig = signature()
    if (nextSig === lastSig) return { changed: false, taskState: snapshot() }
    lastSig = nextSig
    return { changed: true, taskState: snapshot() }
  }

  const setMode = (mode, ts) => {
    const clean = String(mode || '').trim().toLowerCase()
    const next = VALID_MODES.has(clean) ? clean : null
    if (state.mode !== next) {
      state.mode = next
      touch(ts)
      return true
    }
    return false
  }

  const setFocus = (focus, ts) => {
    const clean = String(focus || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FOCUS_LEN)
    if (clean && state.focus !== clean) {
      state.focus = clean
      touch(ts)
      return true
    }
    return false
  }

  const setSteps = (rawSteps, ts) => {
    const normalized = normalizeStepsList(rawSteps)
    state.steps = normalized
    // Clear stale focus once every step in the checklist has finished
    if (normalized.length > 0 && normalized.every((s) => s.status === 'done' || s.status === 'skipped')) {
      state.focus = ''
    }
    touch(ts)
    return true
  }

  const setGoal = (rawGoal, ts) => {
    if (!rawGoal || typeof rawGoal !== 'object') return false
    const objective = String(rawGoal.objective || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    if (!objective) return false
    const status = normalizeGoalStatus(rawGoal.status)
    state.goal = { objective, status }
    if (status === 'complete') {
      if (state.mode === 'goal') state.mode = null
    } else if (!state.mode || state.mode === 'goal') {
      state.mode = 'goal'
    }
    touch(ts)
    return true
  }

  const clearGoal = (ts) => {
    if (!state.goal && state.mode !== 'goal') return false
    state.goal = null
    if (state.mode === 'goal') state.mode = null
    touch(ts)
    return true
  }

  const setPlanDoc = (doc, ts) => {
    if (!doc || typeof doc !== 'object') return false
    const path = String(doc.path || '').trim()
    const content = typeof doc.content === 'string' ? doc.content.trim().slice(0, MAX_PLAN_CONTENT_LEN) : ''
    if (!path && !content) return false
    const title = String(doc.title || (path ? basename(path) : 'Plan')).replace(/\s+/g, ' ').trim().slice(0, 140)
    state.planDoc = {
      title,
      ...(path ? { path } : {}),
      ...(content ? { content } : {}),
    }
    touch(ts)
    return true
  }

  /** Antigravity user prompt cues (`/plan ...`, `/goal ...`), plus stale finished-checklist reset on new normal turns. */
  const applyAntigravityUserText = (rawText, ts) => {
    const text = String(rawText || '').trim()
    if (!text) return false
    if (/^\/plan(?:\s|$)/i.test(text)) {
      return setMode('plan', ts)
    }
    const goalMatch = text.match(/^\/goal(?:\s+([\s\S]+))?$/i)
    if (goalMatch) {
      const objective = String(goalMatch[1] || '').replace(/\s+/g, ' ').trim()
      if (objective) {
        return setGoal({ objective, status: 'active' }, ts)
      }
      return setMode('goal', ts)
    }
    // New normal user turn: clear sticky plan mode (when no unfinished steps remain), completed steps & stale focus/planDoc
    let changed = false
    const allStepsFinished = state.steps.length > 0 && state.steps.every((s) => s.status === 'done' || s.status === 'skipped')
    if (allStepsFinished) {
      state.steps = []
      changed = true
    }
    if (state.mode === 'plan' && state.steps.length === 0) {
      state.mode = null
      changed = true
    }
    if (state.focus) {
      state.focus = ''
      changed = true
    }
    if (state.mode !== 'plan' && state.planDoc) {
      state.planDoc = null
      changed = true
    }
    if (changed) touch(ts)
    return changed
  }

  /** Antigravity tool call (`update_steps`, `update_focus`, artifact `write_file` / `edit_file`). */
  const applyAntigravityTool = (toolName, rawInput, ts) => {
    const name = String(toolName || '').trim().toLowerCase()
    const input = parseMaybeJson(rawInput)
    const obj = input && typeof input === 'object' ? input : {}

    if (name === 'update_steps' || name === 'default_api:update_steps') {
      if (obj.steps !== undefined) {
        return setSteps(obj.steps, ts)
      }
      return false
    }
    if (name === 'update_focus' || name === 'default_api:update_focus') {
      const focusVal = parseMaybeJson(obj.focus)
      if (typeof focusVal === 'string') {
        return setFocus(focusVal, ts)
      }
      return false
    }
    if (name === 'write_file' || name === 'edit_file' || name === 'default_api:write_file' || name === 'default_api:edit_file') {
      const rawPathVal = parseMaybeJson(obj.Path ?? obj.path)
      const targetPath = typeof rawPathVal === 'string' ? rawPathVal.trim() : ''
      const artMetaRaw = parseMaybeJson(obj.ArtifactMetadata ?? obj.artifactMetadata)
      const artMeta = artMetaRaw && typeof artMetaRaw === 'object' ? artMetaRaw : null
      if (targetPath && (artMeta?.UserFacing === true || isMarkdownPlanPath(targetPath))) {
        const lower = targetPath.toLowerCase()
        if (/\.md$/i.test(lower)) {
          return setPlanDoc({ title: basename(targetPath), path: targetPath }, ts)
        }
      }
    }
    return false
  }

  /** Antigravity live ACP `session/update` payload. */
  const applyAntigravityAcpUpdate = (update, ts) => {
    if (!update || typeof update !== 'object') return false
    const kind = String(update.sessionUpdate || '')
    if (kind === 'plan' && Array.isArray(update.entries)) {
      return setSteps(update.entries, ts)
    }
    if (kind === 'current_mode_update') {
      const modeId = String(update.currentModeId || '').trim().toLowerCase()
      if (modeId === 'plan') return setMode('plan', ts)
      if (state.mode === 'plan') return setMode(null, ts)
      return false
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      return applyAntigravityTool(update.name || update.title, update.args ?? update.rawInput, ts)
    }
    return false
  }

  /** Codex `update_plan` / `turn/plan/updated` / `thread/goal/*` / `collaboration_mode_kind` / `PlanThreadItem`. */
  const applyCodexPlanUpdate = (payload, ts) => {
    const obj = parseMaybeJson(payload)
    if (!obj || typeof obj !== 'object') return false
    let changed = false
    if (Array.isArray(obj.plan)) {
      setSteps(obj.plan, ts)
      changed = true
    }
    if (typeof obj.explanation === 'string' && obj.explanation.trim()) {
      if (setFocus(obj.explanation, ts)) changed = true
    }
    return changed
  }

  const applyCodexTurnMode = (modeKind, turnTrigger = '', ts) => {
    const kind = String(modeKind || '').trim().toLowerCase()
    const trig = String(turnTrigger || '').trim().toLowerCase()
    let changed = false
    if (kind === 'plan') {
      if (setMode('plan', ts)) changed = true
    } else if (kind === 'default') {
      if (state.mode === 'plan') {
        if (setMode(null, ts)) changed = true
      }
    }
    if (trig === 'goal' && !state.mode) {
      if (setMode('goal', ts)) changed = true
    }
    return changed
  }

  const applyCodexPlanItem = (item, ts) => {
    if (!item || typeof item !== 'object') return false
    const text = String(item.text || '').trim()
    if (!text) return false
    return setPlanDoc({ title: 'Codex Plan', content: text }, ts)
  }

  /** Claude Code `TodoWrite`, `TaskCreate`, `TaskUpdate`, `EnterPlanMode`, `ExitPlanMode`, plan file writes. */
  const applyClaudeTool = (toolName, rawInput, ts) => {
    const name = String(toolName || '').trim()
    const input = parseMaybeJson(rawInput)
    const obj = input && typeof input === 'object' ? input : {}

    if (name === 'TodoWrite') {
      if (Array.isArray(obj.todos)) {
        setSteps(obj.todos, ts)
        const active = obj.todos.find(
          (t) => t && normalizeStepStatus(t.status) === 'in_progress' && typeof t.activeForm === 'string' && t.activeForm.trim(),
        )
        if (active) setFocus(active.activeForm, ts)
        return true
      }
      return false
    }

    if (name === 'TaskCreate') {
      const title = String(obj.subject || obj.title || obj.description || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_LEN)
      if (!title) return false
      claudeTaskSeq += 1
      const id = String(obj.id || obj.taskId || claudeTaskSeq)
      const existing = state.steps.find((s) => s.id === id)
      if (existing) {
        existing.title = title
      } else if (state.steps.length < MAX_STEPS) {
        state.steps.push({ id, title, status: 'pending' })
      }
      if (typeof obj.activeForm === 'string' && obj.activeForm.trim() && !state.focus) {
        setFocus(obj.activeForm, ts)
      }
      touch(ts)
      return true
    }

    if (name === 'TaskUpdate') {
      const taskId = String(obj.taskId || obj.id || '').trim()
      if (!taskId) return false
      const rawStatus = String(obj.status || '').trim().toLowerCase()
      const idx = state.steps.findIndex((s) => s.id === taskId)
      if (rawStatus === 'deleted') {
        if (idx !== -1) {
          state.steps.splice(idx, 1)
          touch(ts)
          return true
        }
        return false
      }
      if (idx !== -1) {
        if (obj.subject || obj.title) {
          state.steps[idx].title = String(obj.subject || obj.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN)
        }
        if (rawStatus) {
          state.steps[idx].status = normalizeStepStatus(rawStatus)
        }
        if (rawStatus === 'in_progress' && typeof obj.activeForm === 'string' && obj.activeForm.trim()) {
          setFocus(obj.activeForm, ts)
        }
        touch(ts)
        return true
      }
      return false
    }

    if (name === 'EnterPlanMode') {
      return setMode('plan', ts)
    }

    if (name === 'ExitPlanMode') {
      let changed = false
      if (typeof obj.plan === 'string' && obj.plan.trim()) {
        if (setPlanDoc({ title: 'Claude Plan', content: obj.plan }, ts)) changed = true
      }
      return changed
    }

    if (name === 'Write' || name === 'Edit') {
      const fp = String(obj.file_path || obj.path || '').trim()
      if (fp && isMarkdownPlanPath(fp)) {
        return setPlanDoc({ title: basename(fp), path: fp }, ts)
      }
    }

    return false
  }

  /** Generic DeepSeek Harness tool fallback (only activates if DSH uses a recognized todo/plan tool). */
  const applyDshTool = (toolName, rawInput, ts) => {
    const name = String(toolName || '').trim()
    const lower = name.toLowerCase()
    if (lower === 'todowrite' || lower === 'todo_write') {
      return applyClaudeTool('TodoWrite', rawInput, ts)
    }
    if (lower === 'update_steps' || lower === 'update_focus') {
      return applyAntigravityTool(lower, rawInput, ts)
    }
    if (lower === 'update_plan') {
      return applyCodexPlanUpdate(rawInput, ts)
    }
    return false
  }

  // Initialize baseline signature from seed
  lastSig = signature()

  return {
    snapshot,
    signature,
    consumeChanged,
    setMode,
    setFocus,
    setSteps,
    setGoal,
    clearGoal,
    setPlanDoc,
    applyAntigravityUserText,
    applyAntigravityTool,
    applyAntigravityAcpUpdate,
    applyCodexPlanUpdate,
    applyCodexTurnMode,
    applyCodexPlanItem,
    applyClaudeTool,
    applyDshTool,
  }
}

/**
 * Normalize an incoming `taskMode` RPC field from mobile/desktop Composer.
 * @param {any} raw
 * @returns {'' | 'plan' | 'goal'}
 */
export function normalizeTaskMode(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return VALID_MODES.has(s) ? s : ''
}
