import React from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { bi, getCurrentLang } from '../lib/i18n.js'

/**
 * Granular ErrorBoundary isolating individual UI sections (ChatView, MessageRow, lazy modals)
 * so a rendering bug in a single message or modal never crashes the whole application.
 */
export class SectionErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[AllinOne Section crash: ${this.props.name || 'section'}]`, error, info?.componentStack || '')
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  handleRetry = () => {
    this.setState({ error: null })
    try {
      this.props.onReset?.()
    } catch {}
  }

  render() {
    if (!this.state.error) return this.props.children

    const lang = getCurrentLang()
    const msg = String(this.state.error?.message || this.state.error || bi(lang, '渲染异常', 'Render error'))

    if (this.props.compact) {
      return (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-rose-200/80 bg-rose-50/80 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
          <div className="flex min-w-0 items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {bi(lang, `该内容渲染失败：${msg}`, `Content render failed: ${msg}`)}
            </span>
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2 py-0.5 text-[11px] font-semibold text-rose-600 shadow-2xs dark:bg-rose-950 dark:text-rose-200"
          >
            <RefreshCw className="h-3 w-3" />
            <span>{bi(lang, '重试', 'Retry')}</span>
          </button>
        </div>
      )
    }

    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="w-full max-w-sm rounded-3xl border border-slate-200/80 bg-white p-5 shadow-lg dark:border-slate-800 dark:bg-[#1E2028]">
          <div className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-500">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
            {bi(lang, '模块加载遇到异常', 'Section Error')}
          </h3>
          <p className="mt-1.5 break-all rounded-xl bg-rose-50 px-2.5 py-1.5 font-mono text-[11px] text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {msg}
          </p>
          <div className="mt-3.5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-4 py-2 text-xs font-semibold text-white active:scale-95"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{bi(lang, '重试渲染', 'Retry')}</span>
            </button>
            {this.props.onClose && (
              <button
                type="button"
                onClick={this.props.onClose}
                className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300"
              >
                {bi(lang, '关闭', 'Close')}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}

export function ModalLoadingFallback() {
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/95 shadow-lg dark:bg-[#1E2028]/95">
        <Loader2 className="h-5 w-5 animate-spin text-[#4D6BFE]" />
      </div>
    </div>
  )
}
