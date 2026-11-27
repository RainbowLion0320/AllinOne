import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { I18nProvider } from './lib/i18n.jsx'
import { bi, getCurrentLang } from './lib/i18n.js'

const CHUNK_RELOAD_GUARD_KEY = 'allinone_chunk_reload_at'
const CHUNK_RELOAD_COOLDOWN_MS = 30_000
const DEVICES_STORAGE_KEY = 'allinone_devices_v2'

function deleteIndexedDbSafe(name) {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve()
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

function clearVolatileCachesOnly() {
  try {
    localStorage.removeItem('allinone_composer_drafts_v1')
    localStorage.removeItem('allinone_last_session_v1')
    localStorage.removeItem('allinone_last_workspace_v1')
  } catch {}
  return Promise.race([
    Promise.all([
      deleteIndexedDbSafe('allinone_session_cache_v2'),
      deleteIndexedDbSafe('allinone_media_cache_v1'),
    ]),
    new Promise((resolve) => setTimeout(resolve, 600)),
  ])
}

function signOutKeepE2eeKeys() {
  try {
    const raw = localStorage.getItem(DEVICES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.devices)) {
        const sanitized = {
          ...parsed,
          devices: parsed.devices.map((d) => (d && typeof d === 'object' ? { ...d, token: '' } : d)),
        }
        localStorage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(sanitized))
      }
    }
  } catch {}
  return clearVolatileCachesOnly()
}

function clearEverythingIncludingE2eeKeys() {
  try {
    localStorage.removeItem(DEVICES_STORAGE_KEY)
  } catch {}
  return clearVolatileCachesOnly()
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      error: null,
      showResetConfirm: false,
      wipeE2eeConfirmed: false,
    }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[AllinOne UI crash]', error, info?.componentStack || '')
  }

  handleReloadPreservingKeys = () => {
    clearVolatileCachesOnly().finally(() => {
      window.location.reload()
    })
  }

  handleResetConfirmAction = () => {
    const work = this.state.wipeE2eeConfirmed
      ? clearEverythingIncludingE2eeKeys()
      : signOutKeepE2eeKeys()
    work.finally(() => {
      window.location.reload()
    })
  }

  render() {
    if (!this.state.error) return this.props.children
    const lang = getCurrentLang()
    const message = String(
      this.state.error?.message || this.state.error || bi(lang, '未知界面异常', 'Unknown rendering error'),
    )
    const { showResetConfirm, wipeE2eeConfirmed } = this.state

    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[#F5F8FF] p-6 text-slate-900 dark:bg-[#16171A] dark:text-slate-100">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#1E2028]">
          <h2 className="text-base font-bold">{bi(lang, '界面渲染遇到异常', 'UI Rendering Error')}</h2>
          <p className="mt-2 break-all rounded-xl bg-rose-50 px-3 py-2 font-mono text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {message}
          </p>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
            {bi(
              lang,
              '点击“重新加载应用”仅清理临时界面缓存，您的登录状态与端到端加密（E2EE）密钥将完整保留。',
              'Reloading clears only volatile UI caches. Your login session and end-to-end encryption (E2EE) keys remain intact.',
            )}
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={this.handleReloadPreservingKeys}
              className="w-full rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white transition hover:bg-[#3B59ED] active:scale-[0.99]"
            >
              {bi(lang, '重新加载应用', 'Reload App')}
            </button>

            {!showResetConfirm ? (
              <button
                type="button"
                onClick={() => this.setState({ showResetConfirm: true, wipeE2eeConfirmed: false })}
                className="w-full rounded-2xl border border-slate-200 px-3.5 py-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/70"
              >
                {bi(lang, '清除缓存并退出（保留加密密钥）', 'Reset Cache & Sign Out (Keep E2EE Keys)')}
              </button>
            ) : (
              <div className="mt-1 rounded-2xl border border-amber-300/80 bg-amber-50/70 p-3.5 text-left dark:border-amber-800/70 dark:bg-amber-950/30">
                <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                  {bi(lang, '确认清除缓存并退出登录？', 'Confirm Reset Cache & Sign Out?')}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-300/90">
                  {bi(
                    lang,
                    '默认仅退出登录并清理本地缓存，会完整保留已同步的端到端加密密钥（allinone_devices_v2），重新登录后无需再次扫码。',
                    'By default this signs you out and clears local caches while preserving your synced E2EE room keys so you will not need to re-scan.',
                  )}
                </p>

                <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-xl border border-rose-200/80 bg-white/80 p-2 text-[11px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                  <input
                    type="checkbox"
                    checked={wipeE2eeConfirmed}
                    onChange={(e) => this.setState({ wipeE2eeConfirmed: e.target.checked })}
                    className="mt-0.5 shrink-0 accent-rose-600"
                  />
                  <span>
                    {bi(
                      lang,
                      '同时彻底抹除本地端到端加密密钥（不可恢复！仅当其他设备有备份密钥时勾选）',
                      'Also permanently erase local E2EE keys (irreversible! Only check if backed up on another device)',
                    )}
                  </span>
                </label>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => this.setState({ showResetConfirm: false, wipeE2eeConfirmed: false })}
                    className="flex-1 rounded-xl border border-slate-200 bg-white py-2 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-[#232631] dark:text-slate-300"
                  >
                    {bi(lang, '取消', 'Cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={this.handleResetConfirmAction}
                    className={`flex-1 rounded-xl py-2 text-xs font-semibold text-white ${
                      wipeE2eeConfirmed ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'
                    }`}
                  >
                    {wipeE2eeConfirmed
                      ? bi(lang, '确认抹除密钥并重置', 'Erase Keys & Reset')
                      : bi(lang, '退出并保留密钥', 'Sign Out (Keep Keys)')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}

// Auto-recover from stale lazy-chunk hash mismatches after a new Web/PWA deploy (one-shot guarded)
window.addEventListener('vite:preloadError', (event) => {
  try {
    const lastReloadAt = Number(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) || 0)
    const now = Date.now()
    if (!lastReloadAt || now - lastReloadAt > CHUNK_RELOAD_COOLDOWN_MS) {
      sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now))
      event.preventDefault?.()
      window.location.reload()
    }
  } catch {
    event.preventDefault?.()
    window.location.reload()
  }
})

// Synchronously apply saved theme before React mounts to eliminate dark-mode FOUC (CSP-safe)
try {
  const isDark = localStorage.getItem('allinone_dark') === '1'
  document.documentElement.classList.toggle('dark', isDark)
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) {
    themeMeta.setAttribute('content', isDark ? '#03080E' : '#FFFFFF')
  }
} catch {}

// Strip one-time hot-reload cache-busting query param so the address bar stays clean
try {
  const url = new URL(window.location.href)
  if (url.searchParams.has('_r')) {
    url.searchParams.delete('_r')
    window.history.replaceState(null, '', url.toString())
  }
} catch {}

// Auto-reload cleanly whenever a newer PWA Service Worker takes control
if ('serviceWorker' in navigator) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || window.__allinoneHotReloading) return
    reloading = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </I18nProvider>
  </React.StrictMode>,
)
