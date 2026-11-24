/**
 * Shared helpers for normalizing interactive approval & multi-question prompts
 * across Codex, DeepSeek Harness (DSH), Claude Code, and Antigravity (ACP).
 *
 * Zero external dependencies so this module can be bundled into both the
 * standalone portable bridge and the `allinone-dsh-ipc` Cordis plugin.
 */

/**
 * Normalize `resolveApproval` argument supporting both legacy string decision
 * (`'accept'`) and structured payloads (`{ decision, answers }`).
 */
export function normalizeResolvePayload(decisionOrPayload) {
  if (decisionOrPayload && typeof decisionOrPayload === 'object' && !Array.isArray(decisionOrPayload)) {
    const decision = String(decisionOrPayload.decision || '').trim()
    const rawAnswers =
      decisionOrPayload.answers && typeof decisionOrPayload.answers === 'object'
        ? decisionOrPayload.answers
        : {}
    const answers = {}
    for (const [k, v] of Object.entries(rawAnswers)) {
      answers[k] = normalizeSingleAnswer(v)
    }
    return { decision, answers }
  }
  return {
    decision: String(decisionOrPayload || '').trim(),
    answers: {},
  }
}

export function normalizeSingleAnswer(val) {
  if (val == null) return { selected: [], custom: '', combined: [] }
  if (typeof val === 'string') {
    const s = val.trim()
    return { selected: s ? [s] : [], custom: '', combined: s ? [s] : [] }
  }
  if (Array.isArray(val)) {
    const selected = val.map((x) => String(x ?? '').trim()).filter(Boolean)
    return { selected, custom: '', combined: [...selected] }
  }
  if (typeof val === 'object') {
    const selected = Array.isArray(val.selected)
      ? val.selected.map((x) => String(x ?? '').trim()).filter(Boolean)
      : []
    const custom = typeof val.custom === 'string' ? val.custom.trim() : ''
    const combined = [...selected]
    if (custom && !combined.includes(custom)) {
      combined.push(custom)
    }
    return { selected, custom, combined }
  }
  const s = String(val).trim()
  return { selected: s ? [s] : [], custom: '', combined: s ? [s] : [] }
}

/**
 * Convert an MCP / ACP JSON Schema form (`requestedSchema`) into our unified
 * `questions[]` array for the interactive mobile/desktop prompt card.
 */
export function elicitationSchemaToQuestions(requestedSchema, fallbackMessage = '') {
  const schema = requestedSchema && typeof requestedSchema === 'object' ? requestedSchema : {}
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : [])
  const entries = Object.entries(props)

  if (entries.length === 0) {
    return [
      {
        id: 'response',
        header: '',
        question: String(fallbackMessage || '请输入回复').trim(),
        description: '',
        multiSelect: false,
        allowOther: true,
        inputType: 'text',
        required: true,
        options: [],
      },
    ]
  }

  return entries.map(([key, prop]) => {
    const p = prop && typeof prop === 'object' ? prop : {}
    const title = String(p.title || key).trim()
    const description = String(p.description || '').trim()
    const required = requiredSet.has(key)

    // 1. Boolean -> Yes/No choice
    if (p.type === 'boolean') {
      return {
        id: key,
        header: title !== key ? title : '',
        question: description || title,
        description: description && title ? title : '',
        multiSelect: false,
        allowOther: false,
        inputType: 'boolean',
        required,
        defaultValue: typeof p.default === 'boolean' ? String(p.default) : undefined,
        options: [
          { value: 'true', label: '是 (Yes)' },
          { value: 'false', label: '否 (No)' },
        ],
      }
    }

    // 2. Multi-select array enum (`items.anyOf` or `items.enum`)
    if (p.type === 'array' && p.items && typeof p.items === 'object') {
      const options = []
      if (Array.isArray(p.items.anyOf)) {
        for (const opt of p.items.anyOf) {
          if (opt && opt.const !== undefined) {
            options.push({
              value: String(opt.const),
              label: String(opt.title || opt.const),
              description: opt.description ? String(opt.description) : '',
            })
          }
        }
      } else if (Array.isArray(p.items.enum)) {
        for (const val of p.items.enum) {
          options.push({ value: String(val), label: String(val), description: '' })
        }
      }
      if (options.length > 0) {
        return {
          id: key,
          header: title,
          question: description || title,
          description: '',
          multiSelect: true,
          allowOther: false,
          inputType: 'select',
          required,
          defaultValue: Array.isArray(p.default) ? p.default.map(String) : undefined,
          options,
        }
      }
    }

    // 3. Single-select string enum (`oneOf` or `enum` + optional `enumNames`)
    if (Array.isArray(p.oneOf) && p.oneOf.length > 0) {
      const options = p.oneOf
        .filter((opt) => opt && opt.const !== undefined)
        .map((opt) => ({
          value: String(opt.const),
          label: String(opt.title || opt.const),
          description: opt.description ? String(opt.description) : '',
        }))
      if (options.length > 0) {
        return {
          id: key,
          header: title,
          question: description || title,
          description: '',
          multiSelect: false,
          allowOther: false,
          inputType: 'select',
          required,
          defaultValue: p.default !== undefined && p.default !== null ? String(p.default) : undefined,
          options,
        }
      }
    }

    if (Array.isArray(p.enum) && p.enum.length > 0) {
      const enumNames = Array.isArray(p.enumNames) ? p.enumNames : []
      const options = p.enum.map((val, idx) => ({
        value: String(val),
        label: String(enumNames[idx] || val),
        description: '',
      }))
      return {
        id: key,
        header: title,
        question: description || title,
        description: '',
        multiSelect: false,
        allowOther: false,
        inputType: 'select',
        required,
        defaultValue: p.default !== undefined && p.default !== null ? String(p.default) : undefined,
        options,
      }
    }

    // 4. Number / Integer
    if (p.type === 'number' || p.type === 'integer') {
      return {
        id: key,
        header: title,
        question: description || title,
        description: '',
        multiSelect: false,
        allowOther: true,
        inputType: 'number',
        required,
        defaultValue: p.default !== undefined && p.default !== null ? String(p.default) : undefined,
        options: [],
      }
    }

    // 5. Free-form text
    return {
      id: key,
      header: title,
      question: description || title,
      description: '',
      multiSelect: false,
      allowOther: true,
      inputType: 'text',
      required,
      defaultValue: typeof p.default === 'string' ? p.default : undefined,
      options: [],
    }
  })
}

/**
 * Convert user answers back into strongly-typed JSON Schema `content` object
 * matching MCP `CreateElicitationResult.content` and ACP `ElicitationAcceptAction.content`.
 */
export function answersToElicitationContent(requestedSchema, answersMap = {}) {
  const schema = requestedSchema && typeof requestedSchema === 'object' ? requestedSchema : {}
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const entries = Object.entries(props)
  const content = {}

  if (entries.length === 0) {
    const ans = normalizeSingleAnswer(answersMap.response)
    if (ans.combined.length > 0) content.response = ans.combined.join(', ')
    return content
  }

  for (const [key, prop] of entries) {
    const p = prop && typeof prop === 'object' ? prop : {}
    const ans = normalizeSingleAnswer(answersMap[key])
    if (ans.combined.length === 0) {
      if (p.default !== undefined && p.default !== null) {
        content[key] = p.default
      }
      continue
    }

    if (p.type === 'boolean') {
      const raw = String(ans.selected[0] ?? ans.custom ?? '').toLowerCase()
      if (raw === 'true' || raw === '1' || raw === 'yes' || raw === '是') {
        content[key] = true
      } else if (raw === 'false' || raw === '0' || raw === 'no' || raw === '否') {
        content[key] = false
      }
      continue
    }

    if (p.type === 'array') {
      content[key] = ans.combined
      continue
    }

    if (p.type === 'integer' || p.type === 'number') {
      const raw = ans.custom || ans.selected[0] || ''
      const n = p.type === 'integer' ? parseInt(raw, 10) : Number(raw)
      if (Number.isFinite(n)) content[key] = n
      continue
    }

    // String (enum or free text)
    content[key] = ans.selected[0] || ans.custom || ''
  }

  return content
}

/**
 * Format Codex `item/permissions/requestApproval` profile into concise readable text.
 */
export function formatPermissionProfileDetail(permissions, reason = '') {
  const lines = []
  if (reason) lines.push(String(reason).trim())
  if (permissions && typeof permissions === 'object') {
    if (permissions.network?.enabled) {
      lines.push('网络访问：允许联网')
    }
    const fs = permissions.fileSystem
    if (fs && typeof fs === 'object') {
      if (Array.isArray(fs.entries) && fs.entries.length > 0) {
        for (const e of fs.entries.slice(0, 8)) {
          const p = e?.path?.path || e?.path?.pattern || e?.path?.value?.kind || JSON.stringify(e?.path || '')
          lines.push(`文件系统 (${e?.access || 'access'}): ${p}`)
        }
      }
      if (Array.isArray(fs.read) && fs.read.length > 0) {
        lines.push(`读取路径: ${fs.read.join(', ')}`)
      }
      if (Array.isArray(fs.write) && fs.write.length > 0) {
        lines.push(`写入路径: ${fs.write.join(', ')}`)
      }
    }
  }
  return lines.filter(Boolean).join('\n') || '请求附加权限'
}
