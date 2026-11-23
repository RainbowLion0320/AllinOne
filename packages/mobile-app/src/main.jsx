import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

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
    const message = String(this.state.error?.message || this.state.error || '未知界面异常')
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[#F5F8FF] p-6 text-slate-900 dark:bg-[#16171A] dark:text-slate-100">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#1E2028]">
          <h2 className="text-base font-bold">界面渲染遇到异常</h2>
          <p className="mt-2 break-all rounded-xl bg-rose-50 px-3 py-2 font-mono text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {message}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-1 rounded-2xl bg-[#4D6BFE] py-2.5 text-xs font-semibold text-white"
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem('allinone_devices_v2')
                  localStorage.removeItem('allinone_dsh_auth_v1')
                } catch {}
                window.location.reload()
              }}
              className="rounded-2xl border border-slate-200 px-3.5 py-2.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              清除登录重试
            </button>
          </div>
        </div>
      </div>
    )
  }
}

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
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)
