import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { I18nProvider } from './lib/i18n.jsx'
import { bi, getCurrentLang } from './lib/i18n.js'

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[AllinOne UI crash]', error, info?.componentStack || '')
  }

  render() {
    if (!this.state.error) return this.props.children
    const lang = getCurrentLang()
    const message = String(this.state.error?.message || this.state.error || bi(lang, '未知界面异常', 'Unknown rendering error'))
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[#F5F8FF] p-6 text-slate-900 dark:bg-[#16171A] dark:text-slate-100">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#1E2028]">
          <h2 className="text-base font-bold">{bi(lang, '界面渲染遇到异常', 'UI Rendering Error')}</h2>
          <p className="mt-2 break-all rounded-xl bg-rose-50 px-3 py-2 font-mono text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {message}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-1 rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white"
            >
              {bi(lang, '重新加载', 'Reload')}
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem('allinone_devices_v2')
                } catch {}
                window.location.reload()
              }}
              className="rounded-2xl border border-slate-200 px-3.5 py-2.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              {bi(lang, '清除登录重试', 'Reset Session & Reload')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

// Synchronously apply saved theme before React mounts to eliminate dark-mode FOUC (CSP-safe)
try {
  const isDark = localStorage.getItem('allinone_dark') === '1'
  document.documentElement.classList.toggle('dark', isDark)
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) {
    themeMeta.setAttribute('content', isDark ? '#03080E' : '#FFFFFF')
  }
} catch {}

// Auto-reload cleanly whenever a newer PWA Service Worker takes control
if ('serviceWorker' in navigator) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
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
