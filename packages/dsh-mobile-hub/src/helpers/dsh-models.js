import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function unquote(val) {
  const s = String(val || '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Zero-dependency, secret-safe parser for `~/.dsh/profiles/desktop/cordis.patch.yml`.
 * Extracts ONLY model IDs, display names, provider names, and reasoningEfforts rules.
 * Never reads or returns API keys/tokens/headers.
 */
export function parseDshConfiguredModels() {
  const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const patchPath = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')

  const result = {
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4.1-flash',
    defaultEffort: 'max',
    providers: [],
    models: [],
  }

  const applyFallbackModels = () => {
    result.providers = [{ id: 'deepseek', name: 'DeepSeek' }]
    result.models = [
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        provider: 'deepseek',
        providerName: 'DeepSeek',
        efforts: ['off', 'low', 'high', 'max'],
        defaultEffort: 'max',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        provider: 'deepseek',
        providerName: 'DeepSeek',
        efforts: ['off', 'low', 'high', 'max'],
        defaultEffort: 'max',
      },
    ]
    return result
  }

  if (!existsSync(patchPath)) {
    return applyFallbackModels()
  }

  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)

  let section = null // 'default' | 'pi-ai'
  let inProviders = false
  let providersIndent = -1
  let curProvider = null
  let curProviderIndent = -1
  let inModels = false
  let modelsIndent = -1
  let curModel = null
  let inEfforts = false
  let effortsIndent = -1
  let effortChildIndent = -1
  const providerMap = new Map()

  const flushModel = () => {
    if (curModel && curModel.id && curProvider) {
      providerMap.set(curProvider.id, curProvider.displayName || curProvider.id)
      const defaultEffort =
        curProvider.id === result.defaultProvider && curModel.id === result.defaultModel && result.defaultEffort
          ? result.defaultEffort
          : curModel.efforts.includes('high')
            ? 'high'
            : curModel.efforts[curModel.efforts.length - 1] || ''
      result.models.push({
        id: curModel.id,
        name: curModel.name || curModel.id,
        provider: curProvider.id,
        providerName: curProvider.displayName || curProvider.id,
        efforts: curModel.efforts,
        defaultEffort,
      })
    }
    curModel = null
    inEfforts = false
    effortChildIndent = -1
  }

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.search(/\S/)
    const trimmed = rawLine.trim()

    // Detect ONLY top-level (indent === 0) plugin entries inside cordis.patch.yml
    if (indent === 0 && trimmed.startsWith('- ')) {
      flushModel()
      inProviders = false
      inModels = false
      curProvider = null
      curProviderIndent = -1
      if (trimmed.startsWith('- id:')) {
        const idVal = unquote(trimmed.slice(5))
        if (idVal === 'agent-default-model') section = 'default'
        else if (idVal === 'llm-pi-ai') section = 'pi-ai'
        else section = null
      } else {
        section = null
      }
      continue
    }

    if (section === 'default') {
      if (trimmed.startsWith('provider:')) result.defaultProvider = unquote(trimmed.slice(9))
      else if (trimmed.startsWith('model:')) result.defaultModel = unquote(trimmed.slice(6))
      else if (trimmed.startsWith('reasoningEffort:')) result.defaultEffort = unquote(trimmed.slice(16))
      continue
    }

    if (section !== 'pi-ai') continue

    if (!inProviders) {
      if (trimmed === 'providers:') {
        inProviders = true
        providersIndent = indent
      }
      continue
    }

    if (indent <= providersIndent) {
      flushModel()
      inProviders = false
      section = null
      continue
    }

    // Handle reasoningEfforts direct child keys (e.g. off, low, medium, high, xhigh, max)
    if (inEfforts) {
      if (indent > effortsIndent) {
        if (effortChildIndent === -1) effortChildIndent = indent
        if (indent === effortChildIndent) {
          const colon = trimmed.indexOf(':')
          if (colon > 0) {
            const k = unquote(trimmed.slice(0, colon)).toLowerCase()
            if (k && curModel && !curModel.efforts.includes(k)) {
              curModel.efforts.push(k)
            }
          }
        }
        continue
      } else {
        inEfforts = false
        effortChildIndent = -1
      }
    }

    // Provider header (direct child of providers:)
    if (curProviderIndent === -1 || indent === curProviderIndent) {
      if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
        flushModel()
        inModels = false
        curProviderIndent = indent
        const pid = unquote(trimmed.slice(0, -1))
        curProvider = { id: pid, displayName: pid }
        continue
      }
    }

    if (!curProvider) continue

    if (!inModels) {
      if (trimmed.startsWith('displayName:')) {
        curProvider.displayName = unquote(trimmed.slice(12))
      } else if (trimmed === 'models:') {
        inModels = true
        modelsIndent = indent
      }
      continue
    }

    if (indent <= modelsIndent) {
      flushModel()
      inModels = false
      if (trimmed.endsWith(':') && !trimmed.startsWith('-') && indent === curProviderIndent) {
        const pid = unquote(trimmed.slice(0, -1))
        curProvider = { id: pid, displayName: pid }
      }
      continue
    }

    if (trimmed.startsWith('- id:')) {
      flushModel()
      curModel = { id: unquote(trimmed.slice(5)), name: '', efforts: [] }
      continue
    }

    if (curModel) {
      if (trimmed.startsWith('name:')) {
        curModel.name = unquote(trimmed.slice(5))
      } else if (trimmed === 'reasoningEfforts: false') {
        curModel.efforts = []
        inEfforts = false
      } else if (trimmed === 'reasoningEfforts:') {
        inEfforts = true
        effortsIndent = indent
        effortChildIndent = -1
      }
    }
  }

  flushModel()

  // Sort default provider/model to the front for quick mobile selection
  result.models.sort((a, b) => {
    const aDef = a.provider === result.defaultProvider && a.id === result.defaultModel ? 1 : 0
    const bDef = b.provider === result.defaultProvider && b.id === result.defaultModel ? 1 : 0
    if (aDef !== bDef) return bDef - aDef
    const aProv = a.provider === result.defaultProvider ? 1 : 0
    const bProv = b.provider === result.defaultProvider ? 1 : 0
    if (aProv !== bProv) return bProv - aProv
    return 0
  })

  result.providers = [...providerMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => {
      if (a.id === result.defaultProvider) return -1
      if (b.id === result.defaultProvider) return 1
      return 0
    })

  if (result.models.length === 0) {
    return applyFallbackModels()
  }

  return result
}
