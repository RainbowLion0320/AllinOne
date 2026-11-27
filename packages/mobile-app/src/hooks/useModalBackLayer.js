import { useEffect, useRef } from 'react'

/**
 * Unified Escape-key and Android hardware back-button (`allinone:backbutton`) layer stack.
 *
 * Every modal, sheet, fullscreen viewer, and nested overlay (including `PlanDocModal` and
 * `QrScannerModal`) registers itself with a numeric `priority` (higher closes first; ties
 * break by most-recently opened). When Escape or Android Back fires, ONLY the topmost
 * active layer closes.
 */

const layers = []
let seqCounter = 0
let globalAttached = false

function handleTopLayerDismiss(e) {
  if (layers.length === 0) return false
  let topIdx = -1
  let top = null
  for (let i = 0; i < layers.length; i += 1) {
    const item = layers[i]
    if (!top || item.priority > top.priority || (item.priority === top.priority && item.seq > top.seq)) {
      top = item
      topIdx = i
    }
  }
  if (!top || topIdx < 0) return false
  try {
    const handled = top.onClose?.(e)
    if (handled === false) return false
  } catch {}
  return true
}

function onGlobalKeyDown(e) {
  if (e.key !== 'Escape') return
  if (e.defaultPrevented) return
  if (handleTopLayerDismiss(e)) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}

function onGlobalBackButton(e) {
  if (e.defaultPrevented) return
  if (handleTopLayerDismiss(e)) {
    e.preventDefault()
  }
}

function syncGlobalListeners() {
  if (typeof window === 'undefined') return
  if (layers.length > 0 && !globalAttached) {
    globalAttached = true
    window.addEventListener('keydown', onGlobalKeyDown, true)
    window.addEventListener('allinone:backbutton', onGlobalBackButton)
  } else if (layers.length === 0 && globalAttached) {
    globalAttached = false
    window.removeEventListener('keydown', onGlobalKeyDown, true)
    window.removeEventListener('allinone:backbutton', onGlobalBackButton)
  }
}

export const BACK_LAYER_PRIORITY = Object.freeze({
  ACTIVE_SESSION: 10,
  DRAWER: 20,
  MODAL: 40,
  NESTED_MODAL: 60,
  GRANT_POPUP: 70,
  SCANNER: 80,
  PLAN_DOC: 92,
  HTML_PREVIEW: 95,
  LIGHTBOX: 96,
})

/**
 * Register a dismissible overlay/layer onto the unified Escape + Android Back stack.
 * Set `allowEscape = false` when the layer should only respond to Android hardware back
 * (e.g., returning from an active chat session to the Home dashboard).
 */
export function useRegisterBackLayer(active, onClose, priority = BACK_LAYER_PRIORITY.MODAL, { allowEscape = true } = {}) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return undefined
    const entry = {
      seq: ++seqCounter,
      priority,
      onClose: (ev) => {
        if (!allowEscape && ev?.type === 'keydown') return false
        return onCloseRef.current?.(ev)
      },
    }
    layers.push(entry)
    syncGlobalListeners()
    return () => {
      const idx = layers.indexOf(entry)
      if (idx !== -1) layers.splice(idx, 1)
      syncGlobalListeners()
    }
  }, [active, priority, allowEscape])
}

/**
 * Unified App-level modal/drawer back stack + Desktop Cmd/Ctrl shortcuts.
 */
export function useModalBackLayer({
  activeDevice,
  openNewChatModal,
  activeSessionRef,
  selectedDraftCwdRef,
  drawerOpen,
  setDrawerOpen,
  deviceSwitcherOpen,
  setDeviceSwitcherOpen,
  settingsOpen,
  setSettingsOpen,
  newChatOpen,
  setNewChatOpen,
  e2eeModalOpen,
  closeE2eeModal,
  modelPickerOpen,
  setModelPickerOpen,
  pendingGrantPopup,
  closePendingGrantPopup,
  lightboxState,
  closeLightbox,
  htmlPreviewState,
  closeHtmlPreview,
  hasActiveSession,
  returnToHome,
}) {
  useRegisterBackLayer(Boolean(hasActiveSession), returnToHome, BACK_LAYER_PRIORITY.ACTIVE_SESSION, {
    allowEscape: false,
  })
  useRegisterBackLayer(Boolean(drawerOpen), () => setDrawerOpen(false), BACK_LAYER_PRIORITY.DRAWER)
  useRegisterBackLayer(Boolean(deviceSwitcherOpen), () => setDeviceSwitcherOpen(false), BACK_LAYER_PRIORITY.MODAL)
  useRegisterBackLayer(Boolean(settingsOpen), () => setSettingsOpen(false), BACK_LAYER_PRIORITY.MODAL + 1)
  useRegisterBackLayer(Boolean(newChatOpen), () => setNewChatOpen(false), BACK_LAYER_PRIORITY.MODAL + 2)
  useRegisterBackLayer(Boolean(e2eeModalOpen), closeE2eeModal, BACK_LAYER_PRIORITY.MODAL + 3)
  useRegisterBackLayer(Boolean(modelPickerOpen), () => setModelPickerOpen(false), BACK_LAYER_PRIORITY.MODAL + 4)
  useRegisterBackLayer(Boolean(pendingGrantPopup), closePendingGrantPopup, BACK_LAYER_PRIORITY.GRANT_POPUP)
  useRegisterBackLayer(Boolean(htmlPreviewState), closeHtmlPreview, BACK_LAYER_PRIORITY.HTML_PREVIEW)
  useRegisterBackLayer(Boolean(lightboxState), closeLightbox, BACK_LAYER_PRIORITY.LIGHTBOX)

  // Desktop keyboard shortcuts (Cmd/Ctrl+N new chat, Cmd/Ctrl+K switch computer, Cmd/Ctrl+, settings)
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.shiftKey || e.altKey || !activeDevice) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        openNewChatModal(activeSessionRef.current?.cwd || selectedDraftCwdRef.current || '')
      } else if (k === 'k') {
        e.preventDefault()
        setDeviceSwitcherOpen((v) => !v)
      } else if (k === ',') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDevice, openNewChatModal, activeSessionRef, selectedDraftCwdRef, setDeviceSwitcherOpen, setSettingsOpen])
}
