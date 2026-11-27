import React, { createContext, useContext } from 'react'

/**
 * Split into TWO isolated contexts to prevent volatile connection/cache updates
 * (`p2pState`, `p2pTransport`, `connState`, `mediaCacheRev`, `dataSaver`) from
 * cascading re-renders across `ChatView`, `MessageRow`, and `MarkdownView`:
 *
 *  1. `ImageActionsContext`: stable memoized callbacks + session-scoped metadata.
 *  2. `ImageLiveStateContext`: volatile transport/cache state, subscribed ONLY by
 *     leaf media cards (`ChatImageCard`) that react to live transport changes.
 */
const ImageActionsCtx = createContext(null)
const ImageLiveStateCtx = createContext(null)
const StreamingFlagCtx = createContext(false)

export function ImageActionsProvider({ value, children }) {
  return <ImageActionsCtx.Provider value={value}>{children}</ImageActionsCtx.Provider>
}

export function useImageActions() {
  return useContext(ImageActionsCtx)
}

export function ImageLiveStateProvider({ value, children }) {
  return <ImageLiveStateCtx.Provider value={value}>{children}</ImageLiveStateCtx.Provider>
}

export function useImageLiveState() {
  return useContext(ImageLiveStateCtx)
}

export function StreamingFlagProvider({ streaming = false, children }) {
  return <StreamingFlagCtx.Provider value={Boolean(streaming)}>{children}</StreamingFlagCtx.Provider>
}

export function useStreamingFlag() {
  return useContext(StreamingFlagCtx)
}
