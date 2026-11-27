import React, { useEffect, useState } from 'react'
import { Settings, X } from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import { AccountSection } from './settings/AccountSection.jsx'
import { AppearanceDesktopSection } from './settings/AppearanceDesktopSection.jsx'
import { NetworkStorageSection } from './settings/NetworkStorageSection.jsx'
import { AboutUpdatesSection } from './settings/AboutUpdatesSection.jsx'

export function SettingsModal({
  open,
  onClose,
  activeDevice = null,
  activeDeviceName = '',
  isAdmin = false,
  emailEnabled = false,
  githubEnabled = false,
  connState = 'disconnected',
  bridgeOnline = false,
  clientSessions = null,
  onlineClientCount = 0,
  onRefreshClientSessions = null,
  onRevokeClientSession = null,
  onRevokeOtherClientSessions = null,
  darkMode = false,
  onToggleDark,
  cacheScope = '',
  desktopApi = null,
  desktopBridge = null,
  onToggleDesktopBridge = null,
  onToggleDesktopAutoLaunch = null,
  onOpenDesktopLog = null,
  updateState = null,
  otaInfo = null,
  onResetOtaBundle = null,
  onCheckUpdate = null,
  onDownloadUpdate = null,
  onCancelUpdate = null,
  onInstallUpdate = null,
  onSendBindEmailCode = null,
  onBindAccountEmail = null,
  onToggleLogin2fa = null,
  onGithubLinked = null,
  onUnlinkGithub = null,
  onDeleteAccount = null,
  turnQuota = null,
  dataSaver = true,
  onToggleDataSaver = null,
  onRemoveDevice = null,
}) {
  const { bi, t } = useI18n()
  const [openHelpKey, setOpenHelpKey] = useState('')

  useEffect(() => {
    if (!open) setOpenHelpKey('')
  }, [open])

  if (!open) return null

  const toggleHelp = (key) => {
    setOpenHelpKey((cur) => (cur === key ? '' : key))
  }

  const appVersion =
    desktopApi?.version ||
    (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) ||
    ''

  const displayUser = activeDevice?.username
    ? `@${activeDevice.username}`
    : activeDeviceName || bi('本地设备', 'Local Device')
  const rawServerBase = String(activeDevice?.baseUrl || '').trim()
  const serverDisplay = /^http:\/\//i.test(rawServerBase)
    ? rawServerBase
    : rawServerBase.replace(/^https:\/\//i, '')

  return (
    <div
      className="animate-backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="animate-sheet-in pb-safe flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl bg-[#F8F9FC] shadow-2xl sm:rounded-3xl dark:bg-[#1B1D23]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200/80 px-4 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Settings className="h-3.5 w-3.5" />
            </div>
            <h2 className="text-[15px] font-bold text-slate-900 dark:text-white">{t('common.settings')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={bi('关闭设置', 'Close settings')}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
          <AccountSection
            open={open}
            activeDevice={activeDevice}
            displayUser={displayUser}
            serverDisplay={serverDisplay}
            isAdmin={isAdmin}
            emailEnabled={emailEnabled}
            githubEnabled={githubEnabled}
            connState={connState}
            bridgeOnline={bridgeOnline}
            turnQuota={turnQuota}
            clientSessions={clientSessions}
            onlineClientCount={onlineClientCount}
            openHelpKey={openHelpKey}
            toggleHelp={toggleHelp}
            onRefreshClientSessions={onRefreshClientSessions}
            onRevokeClientSession={onRevokeClientSession}
            onRevokeOtherClientSessions={onRevokeOtherClientSessions}
            onSendBindEmailCode={onSendBindEmailCode}
            onBindAccountEmail={onBindAccountEmail}
            onToggleLogin2fa={onToggleLogin2fa}
            onGithubLinked={onGithubLinked}
            onUnlinkGithub={onUnlinkGithub}
            onDeleteAccount={onDeleteAccount}
            onClose={onClose}
          />

          <AppearanceDesktopSection
            darkMode={darkMode}
            onToggleDark={onToggleDark}
            desktopApi={desktopApi}
            desktopBridge={desktopBridge}
            onToggleDesktopBridge={onToggleDesktopBridge}
            onToggleDesktopAutoLaunch={onToggleDesktopAutoLaunch}
            onOpenDesktopLog={onOpenDesktopLog}
            isAdmin={isAdmin}
            activeDevice={activeDevice}
            onClose={onClose}
          />

          <NetworkStorageSection
            open={open}
            activeDevice={activeDevice}
            cacheScope={cacheScope}
            turnQuota={turnQuota}
            dataSaver={dataSaver}
            onToggleDataSaver={onToggleDataSaver}
            openHelpKey={openHelpKey}
            toggleHelp={toggleHelp}
          />

          <AboutUpdatesSection
            open={open}
            appVersion={appVersion}
            otaInfo={otaInfo}
            updateState={updateState}
            onResetOtaBundle={onResetOtaBundle}
            onCheckUpdate={onCheckUpdate}
            onDownloadUpdate={onDownloadUpdate}
            onCancelUpdate={onCancelUpdate}
            onInstallUpdate={onInstallUpdate}
            activeDevice={activeDevice}
            displayUser={displayUser}
            onRemoveDevice={onRemoveDevice}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  )
}
