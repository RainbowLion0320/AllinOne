import React, { Suspense } from 'react'
import { SectionErrorBoundary, ModalLoadingFallback } from './SectionErrorBoundary.jsx'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

const DeviceSwitcherModal = React.lazy(() =>
  import('./DeviceSwitcherModal.jsx').then((m) => ({ default: m.DeviceSwitcherModal })),
)
const NewChatModal = React.lazy(() =>
  import('./NewChatModal.jsx').then((m) => ({ default: m.NewChatModal })),
)
const ModelPickerSheet = React.lazy(() =>
  import('./ModelPickerSheet.jsx').then((m) => ({ default: m.ModelPickerSheet })),
)
const SettingsModal = React.lazy(() =>
  import('./SettingsModal.jsx').then((m) => ({ default: m.SettingsModal })),
)
const E2eeSyncModal = React.lazy(() =>
  import('./E2eeSyncModal.jsx').then((m) => ({ default: m.E2eeSyncModal })),
)
const E2eeGrantApproveModal = React.lazy(() =>
  import('./E2eeGrantApproveModal.jsx').then((m) => ({ default: m.E2eeGrantApproveModal })),
)
const ImageLightbox = React.lazy(() =>
  import('./ImageLightbox.jsx').then((m) => ({ default: m.ImageLightbox })),
)
const HtmlPreviewModal = React.lazy(() =>
  import('./HtmlPreviewModal.jsx').then((m) => ({ default: m.HtmlPreviewModal })),
)

export function AppModals({
  // Device Switcher
  deviceSwitcherOpen,
  onCloseDeviceSwitcher,
  devices,
  activeDevice,
  activeBridgeId,
  connState,
  accountDevices,
  onSelectDevice,
  onAddDevice,
  onRemoveDevice,
  onSyncDeviceMeta,
  onRenameAccountDevice,
  onRemoveAccountDevice,
  onRefreshAccountDevices,
  // New Chat
  newChatOpen,
  cacheScope,
  newChatCwd,
  newChatApp,
  onCloseNewChat,
  effectiveWorkspaces,
  appsStatus,
  modelsCatalog,
  workbuddySetup,
  onSetupWorkbuddy,
  zcodeSetup,
  onSetupZcode,
  onCreateSession,
  // Model Picker
  modelPickerOpen,
  activeApp,
  activeCatalog,
  loadingModels,
  activeModelPref,
  onCloseModelPicker,
  onApplyModelPref,
  // Settings
  settingsOpen,
  onCloseSettings,
  activeDeviceName,
  isAdmin,
  serverEmailEnabled,
  serverGithubEnabled,
  bridgeOnline,
  clientSessions,
  onlineClientCount,
  onRefreshClientSessions,
  onRevokeClientSession,
  onRevokeOtherClientSessions,
  darkMode,
  onToggleDark,
  desktopApi,
  desktopBridge,
  setDesktopBridge,
  updateState,
  setUpdateState,
  otaInfo,
  onResetOtaBundle,
  canCheckMobileUpdate,
  nativeOtaPlugin,
  onCheckNativeMobileUpdate,
  onDownloadMobileUpdate,
  onCancelMobileUpdate,
  onInstallMobileUpdate,
  onSendBindEmailCode,
  onBindAccountEmail,
  onToggleLoginEmail2fa,
  onGithubLinked,
  onUnlinkGithub,
  turnQuota,
  dataSaver,
  onToggleDataSaver,
  // E2EE Sync & Grant Approve
  e2eeModal,
  onCloseE2eeModal,
  activeBridge,
  e2eeLocked,
  activeBridgeE2ee,
  client,
  onImportE2eeKey,
  onImportE2eeKeyring,
  onScanGrantQr,
  onRotateDesktopE2eeKey,
  pendingGrantPopup,
  onClosePendingGrant,
  // Media & Preview
  lightboxState,
  onMediaCached,
  onCloseLightbox,
  htmlPreviewState,
  onCloseHtmlPreview,
  showToast,
}) {
  const hasAnyModalOpen = Boolean(
    deviceSwitcherOpen ||
      newChatOpen ||
      modelPickerOpen ||
      settingsOpen ||
      e2eeModal.open ||
      pendingGrantPopup ||
      lightboxState ||
      htmlPreviewState,
  )
  if (!hasAnyModalOpen) return null

  const modalResetKey = [
    deviceSwitcherOpen ? 'ds' : '',
    newChatOpen ? 'nc' : '',
    modelPickerOpen ? 'mp' : '',
    settingsOpen ? 'st' : '',
    e2eeModal.open ? `e2:${e2eeModal.tab}` : '',
    pendingGrantPopup?.reqId || '',
    lightboxState ? 'lb' : '',
    htmlPreviewState ? 'hp' : '',
  ].join('|')

  const closeAllOnBoundaryError = () => {
    if (htmlPreviewState) onCloseHtmlPreview()
    else if (lightboxState) onCloseLightbox()
    else if (pendingGrantPopup) onClosePendingGrant()
    else if (modelPickerOpen) onCloseModelPicker()
    else if (e2eeModal.open) onCloseE2eeModal()
    else if (newChatOpen) onCloseNewChat()
    else if (settingsOpen) onCloseSettings()
    else if (deviceSwitcherOpen) onCloseDeviceSwitcher()
  }

  return (
    <SectionErrorBoundary name="modals" resetKey={modalResetKey} onClose={closeAllOnBoundaryError}>
      <Suspense fallback={<ModalLoadingFallback />}>
        {deviceSwitcherOpen && (
          <DeviceSwitcherModal
            open={deviceSwitcherOpen}
            onClose={onCloseDeviceSwitcher}
            devices={devices}
            activeDeviceId={activeDevice?.id}
            activeBridgeId={activeBridgeId || activeDevice?.selectedBridgeId || ''}
            activeConnState={connState}
            accountDevices={accountDevices}
            onSelectDevice={onSelectDevice}
            onAddDevice={onAddDevice}
            onRemoveDevice={onRemoveDevice}
            onSyncDeviceMeta={onSyncDeviceMeta}
            onRenameAccountDevice={onRenameAccountDevice}
            onRemoveAccountDevice={onRemoveAccountDevice}
            onRefreshAccountDevices={onRefreshAccountDevices}
          />
        )}

        {newChatOpen && (
          <NewChatModal
            open={newChatOpen}
            scopeKey={cacheScope}
            initialCwd={newChatCwd}
            initialApp={newChatApp}
            onClose={onCloseNewChat}
            workspaces={effectiveWorkspaces}
            appsStatus={appsStatus}
            modelsCatalog={modelsCatalog}
            workbuddySetup={workbuddySetup}
            onSetupWorkbuddy={onSetupWorkbuddy}
            zcodeSetup={zcodeSetup}
            onSetupZcode={onSetupZcode}
            onCreate={onCreateSession}
          />
        )}

        {modelPickerOpen && (
          <ModelPickerSheet
            open={modelPickerOpen}
            app={activeApp}
            catalog={activeCatalog}
            loading={loadingModels}
            value={activeModelPref}
            onClose={onCloseModelPicker}
            onApply={onApplyModelPref}
          />
        )}

        {settingsOpen && (
          <SettingsModal
            open={settingsOpen}
            onClose={onCloseSettings}
            activeDevice={activeDevice}
            activeDeviceName={activeDeviceName}
            isAdmin={isAdmin}
            emailEnabled={serverEmailEnabled}
            githubEnabled={serverGithubEnabled}
            connState={connState}
            bridgeOnline={bridgeOnline}
            clientSessions={clientSessions}
            onlineClientCount={onlineClientCount}
            onRefreshClientSessions={onRefreshClientSessions}
            onRevokeClientSession={onRevokeClientSession}
            onRevokeOtherClientSessions={onRevokeOtherClientSessions}
            darkMode={darkMode}
            onToggleDark={onToggleDark}
            cacheScope={cacheScope}
            desktopApi={desktopApi}
            desktopBridge={desktopBridge}
            onToggleDesktopBridge={
              desktopApi
                ? () => {
                    desktopApi.toggleBridge?.().then((st) => st && setDesktopBridge(st)).catch(() => {})
                  }
                : null
            }
            onToggleDesktopAutoLaunch={
              desktopApi
                ? () => {
                    desktopApi.toggleAutoLaunch?.().then((st) => st && setDesktopBridge(st)).catch(() => {})
                  }
                : null
            }
            onOpenDesktopLog={desktopApi ? () => { void desktopApi.openLog?.() } : null}
            updateState={updateState}
            otaInfo={otaInfo}
            onResetOtaBundle={onResetOtaBundle}
            onCheckUpdate={
              desktopApi
                ? () => { void desktopApi.checkForUpdates?.().then((st) => st && setUpdateState(st)) }
                : canCheckMobileUpdate
                  ? () => { void onCheckNativeMobileUpdate({ silent: false }) }
                  : null
            }
            onDownloadUpdate={
              desktopApi
                ? () => { void desktopApi.downloadUpdate?.().then((st) => st && setUpdateState(st)) }
                : nativeOtaPlugin
                  ? () => { void onDownloadMobileUpdate() }
                  : null
            }
            onCancelUpdate={
              desktopApi
                ? () => { void desktopApi.cancelUpdateDownload?.().then((st) => st && setUpdateState(st)) }
                : nativeOtaPlugin
                  ? () => { void onCancelMobileUpdate() }
                  : null
            }
            onInstallUpdate={
              desktopApi
                ? () => { void desktopApi.installUpdate?.().then((st) => st && setUpdateState(st)) }
                : canCheckMobileUpdate
                  ? () => { void onInstallMobileUpdate() }
                  : null
            }
            onSendBindEmailCode={onSendBindEmailCode}
            onBindAccountEmail={onBindAccountEmail}
            onToggleLogin2fa={onToggleLoginEmail2fa}
            onGithubLinked={onGithubLinked}
            onUnlinkGithub={onUnlinkGithub}
            turnQuota={turnQuota}
            dataSaver={dataSaver}
            onToggleDataSaver={onToggleDataSaver}
            onRemoveDevice={onRemoveDevice}
          />
        )}

        {e2eeModal.open && (
          <E2eeSyncModal
            open={e2eeModal.open}
            onClose={onCloseE2eeModal}
            roomId={activeDevice?.roomId || ''}
            username={activeDevice?.username || ''}
            bridgeName={activeDeviceName}
            bridgeE2ee={activeBridge?.e2ee || null}
            isBridgeLocked={e2eeLocked}
            activeKey={activeBridgeE2ee.shareableKey}
            activeKeyId={activeBridgeE2ee.shareableKeyId}
            isDesktopApp={Boolean(desktopApi)}
            client={client}
            initialTab={e2eeModal.tab}
            autoOpenScanner={e2eeModal.autoOpenScanner}
            onImportKey={onImportE2eeKey}
            onImportKeyring={onImportE2eeKeyring}
            onScanGrantQr={onScanGrantQr}
            onRotateDesktopKey={desktopApi ? onRotateDesktopE2eeKey : null}
          />
        )}

        {pendingGrantPopup && (
          <E2eeGrantApproveModal
            open={Boolean(pendingGrantPopup)}
            grant={pendingGrantPopup}
            e2eeKeys={activeDevice?.e2eeKeys || {}}
            preferredKeyId={activeBridgeE2ee.shareableKeyId || ''}
            client={client}
            onNotify={showToast}
            onDone={(g) => {
              showToast(
                biLang(
                  getCurrentLang(),
                  `已安全授权「${g?.deviceName || '新设备'}」同步端到端密钥`,
                  `Authorized ${g?.deviceName || 'new device'} via zero-knowledge E2EE handoff`,
                ),
              )
            }}
            onClose={onClosePendingGrant}
          />
        )}

        {lightboxState && (
          <ImageLightbox
            state={lightboxState}
            onMediaCached={onMediaCached}
            onClose={onCloseLightbox}
          />
        )}

        {htmlPreviewState && (
          <HtmlPreviewModal
            state={htmlPreviewState}
            onClose={onCloseHtmlPreview}
          />
        )}
      </Suspense>
    </SectionErrorBoundary>
  )
}
