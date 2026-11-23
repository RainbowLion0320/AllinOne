import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  bi as biHelper,
  detectInitialLang,
  normalizeLang,
  saveLang,
  setCurrentLangCache,
  translate,
} from './i18n.js'

const I18nContext = createContext({
  lang: 'zh',
  isEn: false,
  setLang: () => {},
  toggleLang: () => {},
  t: (key, params) => translate('zh', key, params),
  bi: (zh) => zh,
})

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const initial = detectInitialLang()
    setCurrentLangCache(initial)
    return initial
  })

  useEffect(() => {
    setCurrentLangCache(lang)
    try {
      document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
    } catch {}
    try {
      window.allinoneDesktop?.setLanguage?.(lang)
    } catch {}
  }, [lang])

  const setLang = useCallback((next) => {
    const normalized = normalizeLang(next)
    if (!normalized) return
    saveLang(normalized)
    setLangState(normalized)
  }, [])

  const toggleLang = useCallback(() => {
    setLangState((prev) => {
      const next = prev === 'en' ? 'zh' : 'en'
      saveLang(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      lang,
      isEn: lang === 'en',
      setLang,
      toggleLang,
      t: (key, params) => translate(lang, key, params),
      bi: (zh, en) => biHelper(lang, zh, en),
    }),
    [lang, setLang, toggleLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}
