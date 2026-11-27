import React, { useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Presentation,
  Share2,
} from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import {
  canNativeShareFiles,
  fetchE2eeDeliverableFile,
  getCachedDeliverableFile,
  shareDeliverableFile,
  streamExportDeliverableDirect,
  triggerDeliverableDownload,
} from '../lib/e2eeFiles.js'
import { formatBytesCompact } from '../lib/sessionCache.js'
import { useImageActions } from '../state/ImageContext.jsx'

const TONE_STYLES = {
  amber: {
    iconBox: 'bg-amber-50 text-amber-600 border-amber-200/80 dark:bg-amber-950/45 dark:text-amber-300 dark:border-amber-800/60',
    badge: 'bg-amber-100/90 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200',
  },
  rose: {
    iconBox: 'bg-rose-50 text-rose-600 border-rose-200/80 dark:bg-rose-950/45 dark:text-rose-300 dark:border-rose-800/60',
    badge: 'bg-rose-100/90 text-rose-700 dark:bg-rose-900/50 dark:text-rose-200',
  },
  blue: {
    iconBox: 'bg-blue-50 text-blue-600 border-blue-200/80 dark:bg-blue-950/45 dark:text-blue-300 dark:border-blue-800/60',
    badge: 'bg-blue-100/90 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200',
  },
  emerald: {
    iconBox: 'bg-emerald-50 text-emerald-600 border-emerald-200/80 dark:bg-emerald-950/45 dark:text-emerald-300 dark:border-emerald-800/60',
    badge: 'bg-emerald-100/90 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200',
  },
  orange: {
    iconBox: 'bg-orange-50 text-orange-600 border-orange-200/80 dark:bg-orange-950/45 dark:text-orange-300 dark:border-orange-800/60',
    badge: 'bg-orange-100/90 text-orange-700 dark:bg-orange-900/50 dark:text-orange-200',
  },
  indigo: {
    iconBox: 'bg-indigo-50 text-indigo-600 border-indigo-200/80 dark:bg-indigo-950/45 dark:text-indigo-300 dark:border-indigo-800/60',
    badge: 'bg-indigo-100/90 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200',
  },
  violet: {
    iconBox: 'bg-violet-50 text-violet-600 border-violet-200/80 dark:bg-violet-950/45 dark:text-violet-300 dark:border-violet-800/60',
    badge: 'bg-violet-100/90 text-violet-700 dark:bg-violet-900/50 dark:text-violet-200',
  },
  slate: {
    iconBox: 'bg-slate-100 text-slate-600 border-slate-200/80 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700/70',
    badge: 'bg-slate-200/80 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
}

function DeliverableIcon({ kind }) {
  switch (kind) {
    case 'html':
      return <FileCode2 className="h-4.5 w-4.5" />
    case 'excel':
      return <FileSpreadsheet className="h-4.5 w-4.5" />
    case 'ppt':
      return <Presentation className="h-4.5 w-4.5" />
    case 'archive':
      return <FileArchive className="h-4.5 w-4.5" />
    case 'pdf':
    case 'word':
    case 'text':
      return <FileText className="h-4.5 w-4.5" />
    default:
      return <File className="h-4.5 w-4.5" />
  }
}

function DeliverableCard({ file }) {
  const { bi } = useI18n()
  const imageContext = useImageActions()
  const cached = getCachedDeliverableFile(file.path, imageContext)
  const [busyAction, setBusyAction] = useState('') // '' | 'download' | 'preview' | 'share' | 'open'
  const [doneAction, setDoneAction] = useState('')
  const [sizeBytes, setSizeBytes] = useState(cached?.size || 0)
  const [errorMsg, setErrorMsg] = useState('')

  const tone = TONE_STYLES[file.tone] || TONE_STYLES.slate
  const canShare = useMemo(() => canNativeShareFiles(), [])
  const canLocalDesktopOpen = Boolean(
    imageContext?.isLocalDesktopBridge &&
    typeof imageContext?.desktopApi?.openDeliverable === 'function',
  )

  const handleFetchAndRun = async (action) => {
    if (busyAction) return
    setBusyAction(action)
    setErrorMsg('')
    setDoneAction('')
    try {
      // On Android with native streaming export, stream uncached download/share directly to MediaStore (zero JS heap OOM!)
      if (action !== 'preview' && !getCachedDeliverableFile(file.path, imageContext)) {
        const streamed = await streamExportDeliverableDirect(file.path, imageContext, {
          mode: action === 'share' ? 'share' : 'save',
        })
        if (streamed) {
          setDoneAction(action === 'share' ? 'share' : 'download')
          return
        }
      }
      const entry = await fetchE2eeDeliverableFile(file.path, imageContext)
      if (entry.size) setSizeBytes(entry.size)
      if (action === 'preview') {
        const htmlText = await entry.blob.text()
        imageContext?.onOpenHtmlPreview?.({
          html: htmlText,
          filename: entry.filename || file.filename,
          size: entry.size,
          entry,
        })
      } else if (action === 'share') {
        const shared = await shareDeliverableFile(entry)
        if (!shared) {
          await triggerDeliverableDownload(entry)
        }
        setDoneAction('share')
      } else {
        await triggerDeliverableDownload(entry)
        setDoneAction('download')
      }
    } catch (err) {
      setErrorMsg(String(err?.message || err || bi('读取文件失败', 'Failed to fetch file')))
    } finally {
      setBusyAction('')
    }
  }

  const handleDesktopOpen = async (reveal = false) => {
    if (busyAction || !canLocalDesktopOpen) return
    setBusyAction('open')
    setErrorMsg('')
    try {
      const fn = reveal ? imageContext.desktopApi.revealDeliverable : imageContext.desktopApi.openDeliverable
      const res = await fn(file.path, imageContext?.cwd || '')
      if (res && res.ok === false) {
        setErrorMsg(res.error || bi('本机打开失败', 'Failed to open locally'))
      }
    } catch (err) {
      setErrorMsg(String(err?.message || err || bi('本机打开失败', 'Failed to open locally')))
    } finally {
      setBusyAction('')
    }
  }

  const sizeLabel = sizeBytes > 0 ? formatBytesCompact(sizeBytes) : ''

  return (
    <div className="rounded-2xl border border-slate-200/85 bg-white/95 p-2.5 shadow-2xs transition hover:border-slate-300/90 dark:border-slate-700/80 dark:bg-[#1E212B]/95 dark:hover:border-slate-600/80">
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${tone.iconBox}`}
        >
          <DeliverableIcon kind={file.kind} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100"
              title={file.path}
            >
              {file.name}
            </span>
            <span
              className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${tone.badge}`}
            >
              {file.badge}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
            <span className="truncate font-mono" title={file.path}>
              {file.shortPath}
            </span>
            {sizeLabel && (
              <span className="shrink-0 font-medium text-slate-500 dark:text-slate-400">
                · {sizeLabel}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-1.5">
          {file.previewable && imageContext?.onOpenHtmlPreview && (
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void handleFetchAndRun('preview')}
              className="inline-flex items-center gap-1 rounded-xl border border-amber-200/90 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100/80 active:scale-95 disabled:opacity-55 dark:border-amber-800/60 dark:bg-amber-950/45 dark:text-amber-200 dark:hover:bg-amber-900/50"
              title={bi('安全沙盒内预览网页', 'Preview in sandbox')}
            >
              {busyAction === 'preview' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              <span>{bi('预览', 'Preview')}</span>
            </button>
          )}

          {canLocalDesktopOpen ? (
            <>
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void handleDesktopOpen(false)}
                className="inline-flex items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-[#3B59F0] active:scale-95 disabled:opacity-55"
                title={bi('用本机默认应用打开', 'Open with default app')}
              >
                {busyAction === 'open' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                <span>{bi('打开', 'Open')}</span>
              </button>
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void handleDesktopOpen(true)}
                className="flex h-7.5 w-7.5 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 active:scale-95 disabled:opacity-55 dark:border-slate-700 dark:bg-[#252936] dark:text-slate-300 dark:hover:bg-[#2E3342]"
                title={bi('在文件夹中显示', 'Show in folder')}
                aria-label={bi('在文件夹中显示', 'Show in folder')}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              {canShare && (
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => void handleFetchAndRun('share')}
                  className="flex h-7.5 w-7.5 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 active:scale-95 disabled:opacity-55 dark:border-slate-700 dark:bg-[#252936] dark:text-slate-300 dark:hover:bg-[#2E3342]"
                  title={bi('转发 / 用其他应用打开', 'Share / Open with...')}
                  aria-label={bi('转发 / 用其他应用打开', 'Share / Open with...')}
                >
                  {busyAction === 'share' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4D6BFE]" />
                  ) : (
                    <Share2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void handleFetchAndRun('download')}
                className="inline-flex items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-[#3B59F0] active:scale-95 disabled:opacity-55"
                title={bi('P2P 端到端加密直连下载（0 服务器中转）', 'Direct P2P encrypted download (0 server relay)')}
              >
                {busyAction === 'download' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : doneAction === 'download' ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>
                  {busyAction === 'download'
                    ? bi('拉取中', 'Fetching')
                    : doneAction === 'download'
                      ? bi('已保存', 'Saved')
                      : bi('下载', 'Download')}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-rose-200/80 bg-rose-50/90 px-2.5 py-1.5 text-[11.5px] leading-snug text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{errorMsg}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Renders lightweight on-demand E2EE deliverable file cards below assistant messages.
 * Zero automatic file transfer on render — bytes are only fetched when the user taps Download/Preview.
 */
export const ChatDeliverableList = React.memo(function ChatDeliverableList({ files = [] }) {
  if (!Array.isArray(files) || files.length === 0) return null
  return (
    <div className="mt-2.5 space-y-2">
      {files.map((file) => (
        <DeliverableCard key={file.key} file={file} />
      ))}
    </div>
  )
})
