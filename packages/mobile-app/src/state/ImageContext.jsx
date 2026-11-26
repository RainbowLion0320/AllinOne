import React, { createContext, useContext } from 'react'

const ImageCtx = createContext(null)
const StreamingFlagCtx = createContext(false)

export function ImageContextProvider({ value, children }) {
  return <ImageCtx.Provider value={value}>{children}</ImageCtx.Provider>
}

export function useImageContext() {
  return useContext(ImageCtx)
}

export function StreamingFlagProvider({ streaming = false, children }) {
  return <StreamingFlagCtx.Provider value={Boolean(streaming)}>{children}</StreamingFlagCtx.Provider>
}

export function useStreamingFlag() {
  return useContext(StreamingFlagCtx)
}
