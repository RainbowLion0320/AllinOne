(() => {
  'use strict'

  const ADMIN_AUTH_KEY = 'allinone_admin_auth_v1'
  const ADMIN_LOGOUT_FLAG = 'allinone_admin_logged_out'
  const MAIN_DEVICES_KEY = 'allinone_devices_v2'
  const DARK_KEY = 'allinone_dark'
  const LANG_KEY = 'allinone_lang'

  // Dynamically derive subpath mount prefix (works at root `/` or any reverse-proxy subpath like `/sub/admin`)
  const RELAY_BASE_PATH = window.location.pathname
    .replace(/\/admin(?:\/index\.html)?\/?$/i, '')
    .replace(/\/+$/, '')
  const RELAY_BASE_URL = `${window.location.origin}${RELAY_BASE_PATH}`

  const APP_COLORS = {
    dsh: { name: 'DeepSeek', badge: 'DSH', color: '#4D6BFE', bg: 'rgba(77,107,254,0.16)' },
    codex: { name: 'Codex', badge: 'CDX', color: '#10A37F', bg: 'rgba(16,163,127,0.16)' },
    claude: { name: 'Claude', badge: 'CLD', color: '#D97757', bg: 'rgba(217,119,87,0.16)' },
    antigravity: { name: 'Antigravity', badge: 'AGY', color: '#7C5CFF', bg: 'rgba(124,92,255,0.16)' },
    workbuddy: { name: 'WorkBuddy', badge: 'WKB', color: '#06C798', bg: 'rgba(6,199,152,0.16)' },
  }

  const state = {
    token: '',
    tokenSource: '', // 'admin' | 'main_app' | ''
    lang: loadInitialLang(),
    theme: loadInitialTheme(), // 'dark' | 'light'
    activeTab: 'overview', // 'overview' | 'connections' | 'activity'
    data: null,
    loading: false,
    pendingRefresh: false,
    autoRefreshSec: 0, // Default 0 = manual only (zero idle load)
    refreshTimer: null,
    userFilter: 'all', // 'all' | 'online' | 'active' | 'bridge_only' | 'client_only' | 'offline' | 'admin'
    userSearch: '',
    userSort: 'status',
    expandedUsers: new Set(),
    activityFilter: 'all',
    confirmKey: '',
    confirmTimer: null,
    toastTimer: null,
  }

  function loadInitialLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY)
      if (saved === 'en' || saved === 'zh') return saved
    } catch {}
    const langs = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language]
    for (const c of langs) {
      const s = String(c || '').trim().toLowerCase()
      if (s.startsWith('zh')) return 'zh'
      if (s.startsWith('en')) return 'en'
    }
    return 'en'
  }

  function loadInitialTheme() {
    try {
      const saved = localStorage.getItem(DARK_KEY)
      if (saved === '1') return 'dark'
      if (saved === '0') return 'light'
    } catch {}
    return 'dark'
  }

  const bi = (zh, en) => (state.lang === 'en' ? en : zh)

  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function fmtBytes(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  function fmtUptime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return bi(`${d}天 ${h}小时 ${m}分`, `${d}d ${h}h ${m}m`)
    if (h > 0) return bi(`${h}小时 ${m}分`, `${h}h ${m}m`)
    if (m > 0) return bi(`${m}分钟`, `${m}m`)
    return bi(`${s}秒`, `${s}s`)
  }

  function fmtRelative(ts) {
    if (!ts) return bi('从未', 'Never')
    const diff = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000))
    if (diff < 60) return bi('刚刚', 'Just now')
    if (diff < 3600) return bi(`${Math.floor(diff / 60)} 分钟前`, `${Math.floor(diff / 60)}m ago`)
    if (diff < 86400) return bi(`${Math.floor(diff / 3600)} 小时前`, `${Math.floor(diff / 3600)}h ago`)
    if (diff < 86400 * 30) return bi(`${Math.floor(diff / 86400)} 天前`, `${Math.floor(diff / 86400)}d ago`)
    return fmtDateShort(ts)
  }

  function fmtDateShort(ts) {
    if (!ts) return '—'
    try {
      const d = new Date(Number(ts))
      const yyyy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      const hh = String(d.getHours()).padStart(2, '0')
      const mi = String(d.getMinutes()).padStart(2, '0')
      const nowYear = new Date().getFullYear()
      return yyyy === nowYear ? `${mm}-${dd} ${hh}:${mi}` : `${yyyy}-${mm}-${dd} ${hh}:${mi}`
    } catch {
      return '—'
    }
  }

  function fmtClock(ts) {
    if (!ts) return '—'
    try {
      const d = new Date(Number(ts))
      return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((v) => String(v).padStart(2, '0'))
        .join(':')
    } catch {
      return '—'
    }
  }

  function fmtPlatform(p) {
    const s = String(p || '').toLowerCase()
    if (s.includes('darwin') || s.includes('mac')) return 'macOS'
    if (s.startsWith('win') || s === 'windows') return 'Windows'
    if (s.includes('linux')) return 'Linux'
    return p || 'Unknown'
  }

  function fmtClientKind(k) {
    if (k === 'desktop') return bi('桌面端', 'Desktop')
    if (k === 'mobile') return bi('手机端', 'Mobile')
    return bi('网页', 'Web')
  }

  function statusMeta(status) {
    if (status === 'active') {
      return {
        label: bi('活跃使用中', 'Active'),
        pillClass: 'pill-emerald',
        dotClass: 'dot-emerald dot-pulse',
        color: '#10b981',
      }
    }
    if (status === 'bridge_only') {
      return {
        label: bi('电脑待命', 'PC Online'),
        pillClass: 'pill-sky',
        dotClass: 'dot-sky',
        color: '#38bdf8',
      }
    }
    if (status === 'client_only') {
      return {
        label: bi('终端在线', 'Client Online'),
        pillClass: 'pill-amber',
        dotClass: 'dot-amber',
        color: '#f59e0b',
      }
    }
    return {
      label: bi('离线', 'Offline'),
      pillClass: 'pill-muted',
      dotClass: 'dot-muted',
      color: '#64748b',
    }
  }

  function getAppMeta(appId, upper = false) {
    const key = String(appId || '')
    if (Object.hasOwn(APP_COLORS, key)) return APP_COLORS[key]
    return {
      name: key,
      badge: upper ? key.toUpperCase() : key,
      color: '#94a3b8',
      bg: 'rgba(148,163,184,0.14)',
    }
  }

  function fmtQuotaMb(mb) {
    const n = Number(mb)
    if (!Number.isFinite(n) || n <= 0) return bi('无限', 'Unlim')
    if (n >= 1024 && n % 1024 === 0) return `${n / 1024} GB`
    if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
    return `${Math.floor(n)} MB`
  }

  function getTurnQuotaLabels(quotas = null) {
    const freeMb = quotas && quotas.freeMb !== undefined ? Number(quotas.freeMb) : 1024
    const proMb = quotas && quotas.proMb !== undefined ? Number(quotas.proMb) : 10240
    const ultraMb = quotas && quotas.ultraMb !== undefined ? Number(quotas.ultraMb) : 51200
    const adminMb = quotas && quotas.adminMb !== undefined ? Number(quotas.adminMb) : ultraMb
    return {
      free: fmtQuotaMb(freeMb),
      pro: fmtQuotaMb(proMb),
      ultra: fmtQuotaMb(ultraMb),
      admin: fmtQuotaMb(adminMb),
      freeUnlimited: !Number.isFinite(freeMb) || freeMb <= 0,
      proUnlimited: !Number.isFinite(proMb) || proMb <= 0,
      ultraUnlimited: !Number.isFinite(ultraMb) || ultraMb <= 0,
      adminUnlimited: !Number.isFinite(adminMb) || adminMb <= 0,
    }
  }

  function formatTurnLabel(turn) {
    return Number(turn?.port) > 0 ? `STUN+TURN :${turn.port}` : 'CF TURN'
  }

  function fmtDailyRegQuota(dailyReg) {
    if (!dailyReg) return ''
    const used = Number(dailyReg.used) || 0
    const limit = Number(dailyReg.limit) || 0
    return limit > 0 ? `${used} / ${limit}` : bi(`${used} / 不限`, `${used} / Unlim`)
  }

  function showToast(msg) {
    const el = document.getElementById('toast')
    if (!el || !msg) return
    el.textContent = msg
    el.classList.remove('hidden')
    if (state.toastTimer) clearTimeout(state.toastTimer)
    state.toastTimer = setTimeout(() => {
      el.classList.add('hidden')
      state.toastTimer = null
    }, 2400)
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {}
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
    return ok
  }

  function applyTheme() {
    document.documentElement.classList.toggle('light', state.theme === 'light')
    try {
      localStorage.setItem(DARK_KEY, state.theme === 'dark' ? '1' : '0')
    } catch {}
    const label = state.theme === 'dark' ? bi('浅色', 'Light') : bi('深色', 'Dark')
    const b1 = document.getElementById('btn-theme')
    const b2 = document.getElementById('login-theme-btn')
    if (b1) b1.textContent = label
    if (b2) b2.textContent = label
  }

  function applyStaticI18n() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN'
    document.title = bi('All in One · 服务器监控看板', 'All in One · Server Monitor')

    const setText = (id, zh, en) => {
      const el = document.getElementById(id)
      if (el) el.textContent = bi(zh, en)
    }
    const setPh = (id, zh, en) => {
      const el = document.getElementById(id)
      if (el) el.placeholder = bi(zh, en)
    }

    setText('login-title', 'All in One 监控看板', 'All in One Monitor')
    setText('login-subtitle', '服务器全用户在线状态与轻量运维后台', 'Lightweight server & user status dashboard')
    setText('lbl-username', '用户名或邮箱', 'Username or Email')
    setText('lbl-password', '密码', 'Password')
    setText('lbl-twofa', '邮箱 6 位登录验证码', '6-Digit Email Login Code')
    setPh('inp-twofa', '输入 6 位验证码', 'Enter 6-digit code')
    setText('lbl-remember', '在本机浏览器记住管理员登录态', 'Remember admin session on this browser')
    setText('btn-login', '登录监控后台', 'Sign In to Dashboard')
    setText('login-note', '按需拉取 · 无后台轮询 · 零额外常驻进程', 'On-demand · Zero idle polling · Zero extra processes')
    setText('login-back-app', '返回应用', 'Open App')
    setText('login-lang-btn', 'EN', '中文')

    setText('tb-title', 'All in One 监控看板', 'All in One Monitor')
    setText('lbl-refresh', '刷新', 'Refresh')
    setText('btn-lang', 'EN', '中文')
    setText('btn-open-app', '应用', 'App')
    setText('btn-logout', '退出', 'Sign Out')

    const navMap = {
      'tab.overview': ['用户与总览', 'Users & Overview'],
      'tab.connections': ['实时连接', 'Live Connections'],
      'tab.activity': ['事件日志', 'Activity Log'],
    }
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      if (navMap[key]) el.textContent = bi(navMap[key][0], navMap[key][1])
    })

    const sel = document.getElementById('auto-refresh-select')
    if (sel && sel.options.length >= 4) {
      sel.options[0].textContent = bi('自动刷新：关', 'Auto: Off')
      sel.options[1].textContent = bi('每 10 秒', 'Every 10s')
      sel.options[2].textContent = bi('每 30 秒', 'Every 30s')
      sel.options[3].textContent = bi('每 60 秒', 'Every 60s')
    }

    const sortSel = document.getElementById('user-sort')
    if (sortSel && sortSel.options.length >= 4) {
      sortSel.options[0].textContent = bi('在线优先', 'Online First')
      sortSel.options[1].textContent = bi('最近活跃', 'Recent Activity')
      sortSel.options[2].textContent = bi('信令最多', 'Most Signals')
      sortSel.options[3].textContent = bi('最新注册', 'Newest')
    }

    setText('users-section-title', '全部用户状态', 'All Users Status')
    setPh('user-search', '搜索用户名、邮箱、电脑、IP...', 'Search username, email, PC, IP...')
    setText('live-bridges-title', '在线电脑桥接 (PC Bridges)', 'Online PC Bridges')
    setText('live-clients-title', '在线控制终端 (Mobile / Desktop / Web)', 'Online Controlling Terminals')
    setText('activity-title', '近期运行事件（纯内存环形缓存）', 'Recent Activity (In-Memory Ring Buffer)')
    setText(
      'activity-subtitle',
      '仅记录连接与管理元事件，不落盘、不记录任何对话内容（最多保留最近 80 条）',
      'Operational metadata only, zero disk writes, zero chat contents (last 80 events)',
    )
    applyTheme()
    updateIdleBadge()
  }

  function updateIdleBadge() {
    const el = document.getElementById('tb-idle-badge')
    if (!el) return
    if (state.autoRefreshSec > 0) {
      el.className = 'pill pill-sky'
      el.textContent = bi(`自动 ${state.autoRefreshSec}s`, `Auto ${state.autoRefreshSec}s`)
    } else {
      el.className = 'pill pill-emerald'
      el.textContent = bi('按需 · 0 空载', 'On-demand · 0 Idle')
    }
  }

  // ---- Auth Persistence (Never uses URL query params) ----

  function tryLoadSavedToken() {
    try {
      if (sessionStorage.getItem(ADMIN_LOGOUT_FLAG) === '1') return { token: '', source: '' }
    } catch {}

    // 1. Dedicated admin session token
    for (const store of [sessionStorage, localStorage]) {
      try {
        const raw = store.getItem(ADMIN_AUTH_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.token === 'string' && parsed.token) {
            return { token: parsed.token, source: 'admin' }
          }
        }
      } catch {}
    }

    // 2. Seamless same-origin reuse of an already-logged-in admin session in the AllinOne web app
    try {
      const raw = localStorage.getItem(MAIN_DEVICES_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        const list = Array.isArray(parsed?.devices) ? parsed.devices : []
        const active = list.find((d) => d.id === parsed.activeDeviceId)
        const candidates = active ? [active, ...list.filter((d) => d.id !== active.id)] : list
        const targetBase = RELAY_BASE_URL.toLowerCase()
        for (const d of candidates) {
          if (!d?.token) continue
          const isAdm = d.role === 'admin'
          if (!isAdm) continue
          let matchesBase = !d.baseUrl
          if (d.baseUrl) {
            try {
              const u = new URL(d.baseUrl)
              const savedBase = `${u.origin}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
              matchesBase = savedBase === targetBase
            } catch {}
          }
          if (matchesBase) return { token: d.token, source: 'main_app' }
        }
      }
    } catch {}

    return { token: '', source: '' }
  }

  function saveAdminToken(token, remember) {
    try { sessionStorage.removeItem(ADMIN_LOGOUT_FLAG) } catch {}
    const payload = JSON.stringify({ token, savedAt: Date.now() })
    try { sessionStorage.setItem(ADMIN_AUTH_KEY, payload) } catch {}
    try {
      if (remember) localStorage.setItem(ADMIN_AUTH_KEY, payload)
      else localStorage.removeItem(ADMIN_AUTH_KEY)
    } catch {}
  }

  function clearAdminToken() {
    state.token = ''
    state.tokenSource = ''
    state.data = null
    stopAutoRefresh()
    try { sessionStorage.removeItem(ADMIN_AUTH_KEY) } catch {}
    try { localStorage.removeItem(ADMIN_AUTH_KEY) } catch {}
    try { sessionStorage.setItem(ADMIN_LOGOUT_FLAG, '1') } catch {}
  }

  // ---- API Helpers ----

  async function apiFetch(path, { method = 'GET', body = null, auth = true } = {}) {
    const headers = {}
    if (body !== null) headers['Content-Type'] = 'application/json'
    if (auth && state.token) headers.Authorization = `Bearer ${state.token}`
    const cleanPath = String(path || '').startsWith('/') ? path : `/${path}`
    const res = await fetch(`${RELAY_BASE_PATH}${cleanPath}`, {
      method,
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || data.message || `HTTP ${res.status}`)
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  function resetTwofaField() {
    const twofaWrap = document.getElementById('twofa-field')
    const twofaInput = document.getElementById('inp-twofa')
    const twofaHint = document.getElementById('twofa-hint')
    if (twofaWrap) twofaWrap.classList.add('hidden')
    if (twofaInput) twofaInput.value = ''
    if (twofaHint) twofaHint.textContent = ''
  }

  function handleAuthError(err) {
    if (err && (err.status === 401 || err.status === 403)) {
      clearAdminToken()
      showLoginView(
        err.status === 403
          ? bi('当前账号没有管理员权限，请使用管理员账号登录。', 'This account does not have admin privileges.')
          : bi('登录已失效，请重新登录监控后台。', 'Session expired. Please sign in again.'),
      )
      return true
    }
    return false
  }

  function showLoginView(errorMsg = '') {
    stopAutoRefresh()
    resetTwofaField()
    document.getElementById('dashboard-view').classList.add('hidden')
    document.getElementById('login-view').classList.remove('hidden')
    const errEl = document.getElementById('login-error')
    if (errorMsg) {
      errEl.textContent = errorMsg
      errEl.classList.remove('hidden')
    } else {
      errEl.classList.add('hidden')
    }
  }

  function showDashboardView() {
    document.getElementById('login-view').classList.add('hidden')
    document.getElementById('dashboard-view').classList.remove('hidden')
  }

  async function loadOverview({ silent = false, force = false } = {}) {
    if (!state.token) return
    if (state.loading) {
      if (force) state.pendingRefresh = true
      return
    }
    state.loading = true
    state.pendingRefresh = false
    const icon = document.getElementById('refresh-icon')
    if (icon) icon.classList.add('spin')
    const errEl = document.getElementById('global-error')
    if (!silent && errEl) errEl.classList.add('hidden')

    try {
      const overview = await apiFetch('/api/admin/overview')
      state.data = overview
      showDashboardView()
      renderAll()
    } catch (err) {
      if (handleAuthError(err)) return
      if (errEl) {
        errEl.textContent = String(err.message || err)
        errEl.classList.remove('hidden')
      }
    } finally {
      state.loading = false
      if (icon) icon.classList.remove('spin')
      if (state.pendingRefresh && state.token) {
        state.pendingRefresh = false
        void loadOverview({ silent: true, force: false })
      }
    }
  }

  // ---- Auto-Refresh (Tab-visibility aware, default OFF) ----

  function stopAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer)
      state.refreshTimer = null
    }
  }

  function scheduleAutoRefresh() {
    stopAutoRefresh()
    updateIdleBadge()
    if (!state.token || state.autoRefreshSec <= 0) return
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && state.token) {
        void loadOverview({ silent: true })
      }
    }, state.autoRefreshSec * 1000)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.token && state.autoRefreshSec > 0) {
      void loadOverview({ silent: true })
    }
  })

  // ---- 2-Step Inline Confirm Helper ----

  function armConfirm(key) {
    state.confirmKey = key
    if (state.confirmTimer) clearTimeout(state.confirmTimer)
    state.confirmTimer = setTimeout(() => {
      state.confirmKey = ''
      state.confirmTimer = null
      renderAll()
    }, 4000)
    renderAll()
  }

  function clearConfirm() {
    state.confirmKey = ''
    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
      state.confirmTimer = null
    }
  }

  // ---- Renderers ----

  function renderAll() {
    const d = state.data
    if (!d) return

    const srv = d.server || {}
    const sum = d.summary || {}

    const verEl = document.getElementById('tb-version')
    if (verEl && srv.version) verEl.textContent = `v${srv.version}`
    if (d.appMeta && typeof d.appMeta === 'object') {
      for (const [k, meta] of Object.entries(d.appMeta)) {
        if (meta && meta.color) APP_COLORS[k] = meta.color
      }
    }

    const subEl = document.getElementById('tb-subtitle')
    if (subEl) {
      const hostName = srv.host?.hostname || 'control'
      const up = fmtUptime(srv.node?.uptimeSec || 0)
      const rss = fmtBytes(srv.node?.rssBytes || 0)
      const stun = srv.stun || {}
      const turn = srv.turn || {}
      const iceText = turn.enabled
        ? formatTurnLabel(turn)
        : stun.enabled
          ? `STUN UDP :${stun.port || 3478} (${stun.requests || 0})`
          : bi('STUN 关', 'STUN Off')
      const dailyReg = sum.dailyRegistration || srv.config?.dailyRegistration || null
      const regText = dailyReg
        ? bi(`今日注册 ${fmtDailyRegQuota(dailyReg)}`, `Today's Sign-ups ${fmtDailyRegQuota(dailyReg)}`)
        : ''
      subEl.textContent = bi(
        `主机 ${hostName} · 运行 ${up} · 内存 ${rss} · ${iceText}${regText ? ` · ${regText}` : ''} · 纯控制面 (P2P 优先)`,
        `Host ${hostName} · Up ${up} · RSS ${rss} · ${iceText}${regText ? ` · ${regText}` : ''} · Control Plane (P2P-first)`,
      )
    }

    const luEl = document.getElementById('last-updated')
    if (luEl) {
      luEl.textContent = bi(`更新于 ${fmtClock(d.generatedAt)}`, `Updated ${fmtClock(d.generatedAt)}`)
    }

    // Tab counters
    document.getElementById('badge-users').textContent = `${sum.onlineUsers || 0}/${sum.totalUsers || 0}`
    document.getElementById('badge-live').textContent = String((sum.onlineBridges || 0) + (sum.onlineClients || 0))
    document.getElementById('badge-activity').textContent = String((d.activity || []).length)

    renderKpis(d)
    renderInsights(d)
    renderUsersSection(d)
    renderLiveConnections(d)
    renderActivity(d)
  }

  function renderKpis(d) {
    const sum = d.summary || {}
    const dist = d.distributions || {}
    const plat = dist.bridgePlatforms || {}
    const kinds = dist.clientKinds || {}
    const dailyReg = sum.dailyRegistration || d.server?.config?.dailyRegistration || null

    const platSummary = [
      plat.win32 ? `Win ${plat.win32}` : '',
      plat.darwin ? `Mac ${plat.darwin}` : '',
      plat.linux ? `Linux ${plat.linux}` : '',
      plat.other ? `${bi('其他', 'Other')} ${plat.other}` : '',
    ].filter(Boolean).join(' · ') || bi('暂无在线电脑', 'No online PCs')

    const kindSummary = [
      kinds.desktop ? `${bi('桌面', 'Desktop')} ${kinds.desktop}` : '',
      kinds.mobile ? `${bi('手机', 'Mobile')} ${kinds.mobile}` : '',
      kinds.web ? `${bi('网页', 'Web')} ${kinds.web}` : '',
    ].filter(Boolean).join(' · ') || bi('暂无在线终端', 'No active terminals')

    const regMeta = dailyReg
      ? bi(
          ` · 今日注册 ${fmtDailyRegQuota(dailyReg)}${dailyReg.exceeded ? '（已满）' : ''}`,
          ` · Today's Sign-ups ${fmtDailyRegQuota(dailyReg)}${dailyReg.exceeded ? ' (Full)' : ''}`,
        )
      : ''

    const cards = [
      {
        accent: '#10b981',
        label: bi('在线用户 / 注册用户', 'Online / Total Users'),
        pill: sum.activeUsers > 0
          ? `<span class="pill pill-emerald"><span class="dot dot-emerald dot-pulse"></span>${bi(`${sum.activeUsers} 活跃中`, `${sum.activeUsers} active`)}</span>`
          : `<span class="pill pill-subtle">${bi('当前空闲', 'Idle')}</span>`,
        value: sum.onlineUsers || 0,
        total: `/ ${sum.totalUsers || 0}`,
        meta: bi(
          `24h 活跃 ${sum.recent24hUsers || 0} 人 · 离线 ${sum.offlineUsers || 0} 人${regMeta}`,
          `${sum.recent24hUsers || 0} active in 24h · ${sum.offlineUsers || 0} offline${regMeta}`,
        ),
      },
      {
        accent: '#38bdf8',
        label: bi('在线电脑桥接', 'Online PC Bridges'),
        pill: `<span class="pill pill-sky">${bi(`共绑 ${sum.totalBoundDevices || 0} 台`, `${sum.totalBoundDevices || 0} bound`)}</span>`,
        value: sum.onlineBridges || 0,
        total: `/ ${Math.max(sum.totalBoundDevices || 0, sum.onlineBridges || 0)}`,
        meta: platSummary,
      },
      {
        accent: '#4d6bfe',
        label: bi('在线控制终端', 'Active Terminals'),
        pill: `<span class="pill pill-brand">${bi(`累计接入 ${sum.totalClientConnects || 0}`, `${sum.totalClientConnects || 0} connects`)}</span>`,
        value: sum.onlineClients || 0,
        total: '',
        meta: kindSummary,
      },
      {
        accent: '#7c5cff',
        label: bi('本月全服中继流量', 'Monthly TURN Relay'),
        pill: d.server?.turn?.enabled
          ? `<span class="pill pill-emerald"><span class="dot dot-emerald"></span>${esc(formatTurnLabel(d.server.turn))}</span>`
          : d.server?.stun?.enabled
            ? `<span class="pill pill-emerald"><span class="dot dot-emerald"></span>STUN :${esc(d.server.stun.port || 3478)}</span>`
            : `<span class="pill pill-subtle">${bi('STUN 关', 'STUN Off')}</span>`,
        value: fmtBytes(sum.totalTurnUsedBytes || 0),
        total: '',
        meta: bi(
          `P2P 信令 ${sum.totalSignals || 0} 次 · 直连 0 流量 · 仅双对称 NAT 计入`,
          `${sum.totalSignals || 0} P2P signals · Direct P2P is 0 B · Relay only`,
        ),
      },
    ]

    document.getElementById('kpi-grid').innerHTML = cards.map((c) => `
      <div class="kpi-card" style="--accent:${c.accent}">
        <div class="kpi-top">
          <span class="kpi-label">${esc(c.label)}</span>
          ${c.pill}
        </div>
        <div class="kpi-value-row">
          <span class="kpi-value">${esc(c.value)}</span>
          ${c.total ? `<span class="kpi-total">${esc(c.total)}</span>` : ''}
        </div>
        <div class="kpi-meta">${esc(c.meta)}</div>
      </div>
    `).join('')
  }

  function renderDonutSvg(segments, centerVal, centerSub) {
    const r = 44
    const cx = 58
    const cy = 58
    const circ = 2 * Math.PI * r
    const total = segments.reduce((acc, s) => acc + s.value, 0)
    let offset = 0
    const arcs = total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((s) => {
            const len = (s.value / total) * circ
            const dash = `${Math.max(2, len - 1.5)} ${circ}`
            const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="11" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})" />`
            offset += len
            return el
          })
          .join('')
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="11" />`

    return `
      <svg class="donut-svg" viewBox="0 0 116 116" role="img" aria-label="User status distribution">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(148,163,184,0.14)" stroke-width="11" />
        ${arcs}
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="currentColor" font-size="20" font-weight="800" class="num">${esc(centerVal)}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" fill="var(--text-muted)" font-size="10.5" font-weight="600">${esc(centerSub)}</text>
      </svg>
    `
  }

  function renderInsights(d) {
    const sum = d.summary || {}
    const dist = d.distributions || {}
    const us = dist.userStatus || { active: 0, bridgeOnly: 0, clientOnly: 0, offline: 0 }
    const apps = dist.apps || {}
    const srv = d.server || {}
    const host = srv.host || {}
    const node = srv.node || {}
    const feat = srv.features || {}

    // Card 1: User status donut
    const donutSegs = [
      { key: 'active', label: bi('活跃使用中', 'Active (PC+Client)'), value: us.active || 0, color: '#10b981' },
      { key: 'bridge_only', label: bi('仅电脑在线', 'PC Standby'), value: us.bridgeOnly || 0, color: '#38bdf8' },
      { key: 'client_only', label: bi('仅终端在线', 'Client Only'), value: us.clientOnly || 0, color: '#f59e0b' },
      { key: 'offline', label: bi('离线用户', 'Offline'), value: us.offline || 0, color: '#64748b' },
    ]
    const onlinePct = sum.totalUsers > 0 ? Math.round(((sum.onlineUsers || 0) / sum.totalUsers) * 100) : 0
    const donutHtml = `
      <div class="insight-card">
        <div class="insight-head">
          <h3 class="insight-title">${esc(bi('用户在线分布', 'User Presence'))}</h3>
          <span class="pill pill-subtle num">${onlinePct}% ${esc(bi('在线', 'online'))}</span>
        </div>
        <div class="donut-layout">
          ${renderDonutSvg(donutSegs, `${sum.onlineUsers || 0}/${sum.totalUsers || 0}`, bi('在线/总计', 'Online'))}
          <div class="donut-legend">
            ${donutSegs.map((s) => `
              <button type="button" class="legend-item" data-action="filter-users" data-filter="${esc(s.key)}">
                <span class="legend-left">
                  <span class="dot" style="background:${s.color}"></span>
                  <span>${esc(s.label)}</span>
                </span>
                <span class="legend-val">${esc(s.value)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `

    // Card 2: AI Tools readiness across online PCs
    const onlineBridgeBase = Math.max(1, sum.onlineBridges || 0)
    const appOrder = ['codex', 'claude', 'antigravity', 'dsh', 'workbuddy']
    const appBarsHtml = appOrder.map((id) => {
      const meta = APP_COLORS[id]
      const stat = apps[id] || { available: 0, writable: 0 }
      const pct = sum.onlineBridges > 0 ? Math.min(100, Math.round((stat.available / onlineBridgeBase) * 100)) : 0
      return `
        <div class="bar-row">
          <div class="bar-label-row">
            <span class="bar-name">
              <span class="dot" style="background:${meta.color}"></span>
              <span>${esc(meta.name)}</span>
            </span>
            <span class="bar-val">${esc(bi(`${stat.writable} 可写 / ${stat.available} 可用`, `${stat.writable} RW / ${stat.available} avail`))}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${meta.color}"></div>
          </div>
        </div>
      `
    }).join('')

    const toolsCardHtml = `
      <div class="insight-card">
        <div class="insight-head">
          <h3 class="insight-title">${esc(bi('在线电脑 AI 工具就绪', 'AI Tools on Online PCs'))}</h3>
          <span class="pill pill-subtle num">${esc(bi(`${sum.onlineBridges || 0} 台在线`, `${sum.onlineBridges || 0} online`))}</span>
        </div>
        <div class="bar-list">${appBarsHtml}</div>
        <div class="mini-chips">
          <span class="mini-chip">Win: ${esc(dist.bridgePlatforms?.win32 || 0)}</span>
          <span class="mini-chip">macOS: ${esc(dist.bridgePlatforms?.darwin || 0)}</span>
          <span class="mini-chip">Linux: ${esc(dist.bridgePlatforms?.linux || 0)}</span>
          ${dist.bridgePlatforms?.other ? `<span class="mini-chip">${esc(bi('其他', 'Other'))}: ${esc(dist.bridgePlatforms.other)}</span>` : ''}
        </div>
      </div>
    `

    // Card 3: Server Health (On-Demand)
    const dailyReg = sum.dailyRegistration || srv.config?.dailyRegistration || null
    const hostMemPct = Math.min(100, Math.max(0, Number(host.memUsagePct) || 0))
    const heapPct = node.heapTotalBytes > 0
      ? Math.min(100, Math.round((node.heapUsedBytes / node.heapTotalBytes) * 100))
      : 0
    const load1 = Array.isArray(host.loadAvg) ? host.loadAvg[0] : 0
    const loadPct = host.cpuCount > 0 ? Math.min(100, Math.round((load1 / host.cpuCount) * 100)) : 0
    const isWinHost = String(host.platform || '').toLowerCase() === 'win32'
    const loadText = isWinHost
      ? `${host.cpuCount || 1} vCPU (Windows)`
      : `${(host.loadAvg || [0, 0, 0]).join(' / ')} (${host.cpuCount || 1} vCPU)`

    const healthCardHtml = `
      <div class="insight-card">
        <div class="insight-head">
          <h3 class="insight-title">${esc(bi('服务器资源快照（按需）', 'Server Health (On-Demand)'))}</h3>
          <span class="pill pill-emerald mono">${esc(node.version || 'Node')}</span>
        </div>
        <div class="bar-list">
          <div class="bar-row">
            <div class="bar-label-row">
              <span class="bar-name">${esc(bi('宿主机内存', 'Host Memory'))}</span>
              <span class="bar-val">${esc(fmtBytes(host.usedMemBytes))} / ${esc(fmtBytes(host.totalMemBytes))} (${hostMemPct}%)</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${hostMemPct}%;background:${hostMemPct > 85 ? '#f43f5e' : hostMemPct > 70 ? '#f59e0b' : '#4d6bfe'}"></div>
            </div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span class="bar-name">${esc(bi('Relay 进程内存', 'Relay Process'))}</span>
              <span class="bar-val">RSS ${esc(fmtBytes(node.rssBytes))} · Heap ${esc(fmtBytes(node.heapUsedBytes))}</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${heapPct}%;background:#10b981"></div>
            </div>
          </div>

          <div class="bar-row">
            <div class="bar-label-row">
              <span class="bar-name">${esc(bi('CPU 负载 (1/5/15m)', 'CPU Load (1/5/15m)'))}</span>
              <span class="bar-val">${esc(loadText)}</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${isWinHost ? 0 : loadPct}%;background:${loadPct > 85 ? '#f43f5e' : '#38bdf8'}"></div>
            </div>
          </div>
        </div>
        <div class="mini-chips">
          <span class="mini-chip">${esc(srv.turn?.enabled ? formatTurnLabel(srv.turn) : `STUN: ${srv.stun?.enabled ? `UDP ${srv.stun.port || 3478}` : bi('未开启', 'Off')}`)}</span>
          ${srv.turn?.cloudflare?.enabled ? `<span class="mini-chip">CF TURN (${esc((srv.turn.cloudflare.tiers || []).join('/'))}): ${esc(srv.turn.cloudflare.ready ? bi('就绪', 'Ready') : bi('预热中', 'Warming'))}</span>` : ''}
          ${srv.turn?.quotas ? `<span class="mini-chip">Free ${esc(fmtQuotaMb(srv.turn.quotas.freeMb))} · Pro ${esc(fmtQuotaMb(srv.turn.quotas.proMb))} · Ultra/Admin ${esc(fmtQuotaMb(srv.turn.quotas.ultraMb))}</span>` : ''}
          <span class="mini-chip">${esc(bi('邮件服务', 'Mail'))}: ${esc(feat.emailEnabled ? feat.emailProvider.toUpperCase() : bi('未开启', 'Off'))}</span>
          ${dailyReg ? `<span class="mini-chip" style="${dailyReg.exceeded ? 'color:var(--rose-text);border-color:rgba(244,63,94,0.35)' : ''}">${esc(bi(`今日注册 ${fmtDailyRegQuota(dailyReg)}${dailyReg.exceeded ? ' · 已满' : ''}`, `Today's Sign-ups ${fmtDailyRegQuota(dailyReg)}${dailyReg.exceeded ? ' · Full' : ''}`))}</span>` : ''}
          <span class="mini-chip">${esc(bi('系统运行', 'Host Up'))}: ${esc(fmtUptime(host.uptimeSec || 0))}</span>
        </div>
      </div>
    `

    document.getElementById('insights-grid').innerHTML = donutHtml + toolsCardHtml + healthCardHtml
  }

  function getFilteredUsers(users) {
    const q = state.userSearch.trim().toLowerCase()
    const filtered = users.filter((u) => {
      if (state.userFilter === 'online' && u.status === 'offline') return false
      if (state.userFilter === 'active' && u.status !== 'active') return false
      if (state.userFilter === 'bridge_only' && u.status !== 'bridge_only') return false
      if (state.userFilter === 'client_only' && u.status !== 'client_only') return false
      if (state.userFilter === 'offline' && u.status !== 'offline') return false
      if (state.userFilter === 'admin' && u.role !== 'admin') return false
      if (!q) return true
      const hay = [
        u.username,
        u.email,
        u.userId,
        u.role,
        ...(u.devices || []).flatMap((d) => [d.label, d.hostname, d.bridgeId, d.ip, d.platform]),
        ...(u.sessions || []).flatMap((s) => [s.deviceName, s.ip]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })

    const statusRank = { active: 3, bridge_only: 2, client_only: 1, offline: 0 }
    filtered.sort((a, b) => {
      if (state.userSort === 'recent') return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
      if (state.userSort === 'signals') return (b.stats?.signalCount || 0) - (a.stats?.signalCount || 0)
      if (state.userSort === 'newest') return (b.createdAt || 0) - (a.createdAt || 0)
      return (
        statusRank[b.status] - statusRank[a.status] ||
        (b.lastActivityAt || 0) - (a.lastActivityAt || 0) ||
        (b.createdAt || 0) - (a.createdAt || 0)
      )
    })
    return filtered
  }

  function renderUsersSection(d) {
    const allUsers = d.users || []
    const sum = d.summary || {}
    const filtered = getFilteredUsers(allUsers)

    const hintEl = document.getElementById('users-count-hint')
    if (hintEl) {
      hintEl.textContent = bi(
        `显示 ${filtered.length} / ${allUsers.length} 位用户`,
        `Showing ${filtered.length} of ${allUsers.length} users`,
      )
    }

    const expandBtn = document.getElementById('btn-expand-all')
    if (expandBtn) {
      const allOpen = filtered.length > 0 && filtered.every((u) => state.expandedUsers.has(u.userId))
      expandBtn.textContent = allOpen ? bi('收起全部', 'Collapse All') : bi('展开全部', 'Expand All')
    }

    const adminCount = allUsers.filter((u) => u.role === 'admin').length
    const pills = [
      { id: 'all', label: bi('全部', 'All'), count: allUsers.length },
      { id: 'online', label: bi('当前在线', 'Online'), count: sum.onlineUsers || 0 },
      { id: 'active', label: bi('活跃使用中', 'Active'), count: sum.activeUsers || 0 },
      { id: 'bridge_only', label: bi('仅电脑在线', 'PC Only'), count: sum.bridgeOnlyUsers || 0 },
      { id: 'client_only', label: bi('仅终端在线', 'Client Only'), count: sum.clientOnlyUsers || 0 },
      { id: 'offline', label: bi('离线', 'Offline'), count: sum.offlineUsers || 0 },
      { id: 'admin', label: 'Admin', count: adminCount },
    ]

    document.getElementById('user-filter-pills').innerHTML = pills.map((p) => `
      <button type="button" class="filter-pill ${state.userFilter === p.id ? 'active' : ''}" data-action="filter-users" data-filter="${esc(p.id)}">
        <span>${esc(p.label)}</span>
        <span class="filter-count">${esc(p.count)}</span>
      </button>
    `).join('')

    const listEl = document.getElementById('users-list')
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">${esc(allUsers.length === 0 ? bi('服务器暂无已注册账号用户', 'No registered accounts yet') : bi('没有匹配当前筛选条件的用户', 'No users match the current filter'))}</div>`
      return
    }

    listEl.innerHTML = filtered.map((u) => {
      const expanded = state.expandedUsers.has(u.userId)
      const sm = statusMeta(u.status)
      const initial = (u.username || '?').slice(0, 1).toUpperCase()
      const appTags = (u.apps || []).length > 0
        ? u.apps.map((a) => {
            const meta = getAppMeta(a.app, true)
            return `<span class="app-tag" style="color:${meta.color};background:${meta.bg};border-color:${meta.color}40" title="${esc(meta.name || a.app)} (${a.writable ? 'RW' : 'RO'})">${esc(meta.badge)}</span>`
          }).join('')
        : `<span class="muted-text">—</span>`

      const uTier = String(u.tier || (u.role === 'admin' ? 'admin' : 'free')).toLowerCase()
      const tierPillCls =
        uTier === 'admin'
          ? 'pill-brand'
          : uTier === 'ultra'
            ? 'pill-amber'
            : uTier === 'pro'
              ? 'pill-sky'
              : 'pill-subtle'
      const tierLabel =
        uTier === 'admin' ? 'Admin' : uTier === 'ultra' ? 'Ultra' : uTier === 'pro' ? 'Pro' : 'Free'
      const roleBadgeHtml = `<span class="pill ${tierPillCls}">${esc(tierLabel)}</span>${u.isCurrentAdmin ? `<span class="pill pill-subtle">${esc(bi('当前', 'You'))}</span>` : ''}`
      const tq = u.turnQuota || null
      const relaySummaryText = tq
        ? tq.unlimited
          ? bi(`中继 ${fmtBytes(tq.usedBytes)} / 不限`, `Relay ${fmtBytes(tq.usedBytes)} / Unlim`)
          : bi(
              `中继 ${fmtBytes(tq.usedBytes)} / ${fmtBytes(tq.quotaBytes)}${tq.exceeded ? ' · 已达上限' : ''}`,
              `Relay ${fmtBytes(tq.usedBytes)} / ${fmtBytes(tq.quotaBytes)}${tq.exceeded ? ' · Limit' : ''}`,
            )
        : bi(`${u.stats?.signalCount || 0} 次 P2P 信令`, `${u.stats?.signalCount || 0} P2P signals`)

      return `
        <div class="user-row ${expanded ? 'expanded' : ''}">
          <div class="user-summary" role="button" tabindex="0" data-action="toggle-user" data-user-id="${esc(u.userId)}" aria-expanded="${expanded ? 'true' : 'false'}">
            <div class="user-ident">
              <div class="avatar">
                ${esc(initial)}
                <span class="avatar-dot ${sm.dotClass}"></span>
              </div>
              <div class="user-name-wrap">
                <div class="user-name-line">
                  <span class="user-name">@${esc(u.username)}</span>
                  ${roleBadgeHtml}
                </div>
                <div class="user-sub">${esc(u.email || `${bi('注册于', 'Joined')} ${fmtDateShort(u.createdAt)}`)}</div>
              </div>
            </div>

            <div>
              <span class="pill ${sm.pillClass}">
                <span class="dot ${sm.dotClass}"></span>
                <span>${esc(sm.label)}</span>
              </span>
            </div>

            <div class="user-counts">
              <span class="pill ${u.onlineBridgeCount > 0 ? 'pill-sky' : 'pill-subtle'} num">
                ${esc(bi(`电脑 ${u.onlineBridgeCount}/${u.totalDeviceCount}`, `PCs ${u.onlineBridgeCount}/${u.totalDeviceCount}`))}
              </span>
              <span class="pill ${u.onlineClientCount > 0 ? 'pill-emerald' : 'pill-subtle'} num">
                ${esc(bi(`终端 ${u.onlineClientCount}`, `Clients ${u.onlineClientCount}`))}
              </span>
            </div>

            <div class="user-apps">${appTags}</div>

            <div class="user-activity">
              <div>${esc(fmtRelative(u.lastActivityAt))}</div>
              <div class="user-activity-sub" style="${tq?.exceeded ? 'color:#f43f5e;font-weight:600' : ''}">${esc(relaySummaryText)}</div>
            </div>

            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
          </div>

          ${expanded ? renderUserDetail(u) : ''}
        </div>
      `
    }).join('')
  }

  function renderUserDetail(u) {
    const devicesHtml = (u.devices || []).length === 0
      ? `<div class="detail-item"><span class="muted-text">${esc(bi('尚未绑定任何电脑', 'No bound computers'))}</span></div>`
      : u.devices.map((dev) => {
          const confirmId = `disc-bridge:${u.userId}:${dev.bridgeId}`
          const isArmed = state.confirmKey === confirmId
          const appsHtml = (dev.apps || []).filter((a) => a.available).map((a) => {
            const meta = getAppMeta(a.app)
            return `<span class="app-tag" style="color:${meta.color};background:${meta.bg}">${esc(meta.badge)}${a.writable ? '' : '·RO'}</span>`
          }).join(' ')

          return `
            <div class="detail-item">
              <div class="detail-item-main">
                <div class="detail-item-title">
                  <span class="dot ${dev.online ? 'dot-emerald dot-pulse' : 'dot-muted'}"></span>
                  <span>${esc(dev.label || dev.hostname || dev.bridgeId)}</span>
                  <span class="pill pill-subtle">${esc(fmtPlatform(dev.platform))}</span>
                  ${dev.mode ? `<span class="pill pill-subtle mono">${esc(dev.mode)}</span>` : ''}
                </div>
                <div class="detail-item-meta">
                  <span class="mono">${esc(dev.bridgeId)}</span>
                  ${dev.ip ? `<span class="mono">IP: ${esc(dev.ip)}</span>` : ''}
                  <span>${dev.online
                    ? esc(bi(`已在线 ${fmtUptime((Date.now() - dev.connectedAt) / 1000)}`, `Up ${fmtUptime((Date.now() - dev.connectedAt) / 1000)}`))
                    : esc(bi(`上次在线 ${fmtRelative(dev.lastSeenAt)}`, `Last seen ${fmtRelative(dev.lastSeenAt)}`))}</span>
                </div>
                ${appsHtml ? `<div class="detail-item-meta" style="margin-top:6px">${appsHtml}</div>` : ''}
              </div>
              ${dev.online ? `
                <button type="button" class="btn btn-xs ${isArmed ? 'btn-danger-confirm' : 'btn-danger-soft'}"
                  data-action="disconnect-bridge" data-room-id="${esc(u.userId)}" data-bridge-id="${esc(dev.bridgeId)}">
                  ${esc(isArmed ? bi('确认断开?', 'Confirm?') : bi('断开', 'Disconnect'))}
                </button>
              ` : ''}
            </div>
          `
        }).join('')

    const sessionsHtml = (u.sessions || []).length === 0
      ? `<div class="detail-item"><span class="muted-text">${esc(bi('暂无活跃或近期登录终端', 'No active or recent sessions'))}</span></div>`
      : u.sessions.map((s) => {
          const confirmId = `kick-sess:${u.userId}:${s.sid || s.clientId}`
          const isArmed = state.confirmKey === confirmId
          return `
            <div class="detail-item">
              <div class="detail-item-main">
                <div class="detail-item-title">
                  <span class="dot ${s.online ? 'dot-emerald dot-pulse' : 'dot-muted'}"></span>
                  <span>${esc(s.deviceName || 'Web Client')}</span>
                  <span class="pill pill-subtle">${esc(fmtClientKind(s.clientKind))}</span>
                  ${s.connectionCount > 1 ? `<span class="pill pill-brand num">×${esc(s.connectionCount)}</span>` : ''}
                  ${s.isCurrentAdmin ? `<span class="pill pill-emerald">${esc(bi('当前终端', 'Current'))}</span>` : ''}
                </div>
                <div class="detail-item-meta">
                  ${s.ip ? `<span class="mono">IP: ${esc(s.ip)}</span>` : ''}
                  <span>${esc(bi('最近活跃', 'Last seen'))}: ${esc(fmtRelative(s.lastSeenAt))}</span>
                  <span>${esc(bi('登录于', 'Signed in'))}: ${esc(fmtDateShort(s.createdAt))}</span>
                </div>
              </div>
              ${!s.isCurrentAdmin ? `
                <button type="button" class="btn btn-xs ${isArmed ? 'btn-danger-confirm' : 'btn-danger-soft'}"
                  data-action="kick-session" data-user-id="${esc(u.userId)}" data-sid="${esc(s.sid || '')}" data-client-id="${esc(s.clientId || '')}">
                  ${esc(isArmed ? bi('确认踢出?', 'Confirm?') : bi('踢出', 'Kick'))}
                </button>
              ` : ''}
            </div>
          `
        }).join('')

    const revokeKey = `revoke-all:${u.userId}`
    const revokeArmed = state.confirmKey === revokeKey
    const resetKey = `reset-turn:${u.userId}`
    const resetArmed = state.confirmKey === resetKey
    const uTier = String(u.tier || (u.role === 'admin' ? 'admin' : 'free')).toLowerCase()
    const qLabels = getTurnQuotaLabels(state.data?.server?.turn?.quotas || null)
    const tq = u.turnQuota || null
    const quotaText = tq
      ? tq.unlimited
        ? `${fmtBytes(tq.usedBytes)} / ${bi('无限', 'Unlimited')}`
        : `${fmtBytes(tq.usedBytes)} / ${fmtBytes(tq.quotaBytes)} (${tq.pct || 0}%)`
      : '—'

    return `
      <div class="user-detail">
        <div class="detail-columns">
          <div class="detail-box">
            <div class="detail-box-head">
              <span>${esc(bi('绑定的电脑桥接', 'Bound PC Bridges'))} (${esc(u.onlineBridgeCount)}/${esc(u.totalDeviceCount)})</span>
            </div>
            <div class="detail-items">${devicesHtml}</div>
          </div>

          <div class="detail-box">
            <div class="detail-box-head">
              <span>${esc(bi('控制终端会话', 'Controlling Sessions'))} (${esc(u.onlineSessionCount)}/${esc(u.totalSessionCount)})</span>
            </div>
            <div class="detail-items">${sessionsHtml}</div>
          </div>
        </div>

        <div class="detail-footer">
          <div class="detail-meta-list">
            <span class="mono">ID: ${esc(u.userId)}</span>
            <span>${esc(bi('本月中继', 'Monthly Relay'))}: <strong>${esc(quotaText)}</strong></span>
            <span>${esc(bi('注册时间', 'Registered'))}: ${esc(fmtDateShort(u.createdAt))}</span>
            <span>${esc(bi('上次登录', 'Last login'))}: ${esc(fmtDateShort(u.lastLoginAt))}</span>
          </div>
          <div class="inline-pills">
            ${!u.isCurrentAdmin ? `
              <select class="select-compact" data-action="set-user-tier" data-user-id="${esc(u.userId)}" aria-label="${esc(bi('调整用户等级', 'Change user tier'))}">
                <option value="free" ${uTier === 'free' ? 'selected' : ''}>Free (${esc(qLabels.free)})</option>
                <option value="pro" ${uTier === 'pro' ? 'selected' : ''}>Pro (${esc(qLabels.pro)})</option>
                <option value="ultra" ${uTier === 'ultra' ? 'selected' : ''}>Ultra (${esc(qLabels.ultra)})</option>
                <option value="admin" ${uTier === 'admin' ? 'selected' : ''}>Admin (${esc(qLabels.admin)})</option>
              </select>
            ` : ''}
            ${tq && tq.usedBytes > 0 ? `
              <button type="button" class="btn btn-xs ${resetArmed ? 'btn-danger-confirm' : 'btn-ghost'}"
                data-action="reset-turn-usage" data-user-id="${esc(u.userId)}">
                ${esc(resetArmed ? bi('确认清零?', 'Confirm Reset?') : bi('清零中继流量', 'Reset Relay'))}
              </button>
            ` : ''}
            ${!u.isCurrentAdmin ? `
              <button type="button" class="btn btn-xs ${revokeArmed ? 'btn-danger-confirm' : 'btn-danger-soft'}"
                data-action="revoke-all" data-user-id="${esc(u.userId)}">
                ${esc(revokeArmed ? bi('确认强制全端下线?', 'Confirm Force Sign-Out?') : bi('强制全端下线', 'Force Sign-Out All'))}
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `
  }

  function renderLiveConnections(d) {
    const bridges = d.liveBridges || []
    const clients = d.liveClients || []

    document.getElementById('live-bridges-count').textContent = String(bridges.length)
    document.getElementById('live-clients-count').textContent = String(clients.length)

    const bBody = document.getElementById('live-bridges-body')
    if (bridges.length === 0) {
      bBody.innerHTML = `<div class="empty-state">${esc(bi('当前没有在线的电脑桥接', 'No PC bridges currently online'))}</div>`
    } else {
      bBody.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>${esc(bi('所属用户 / 房间', 'Owner'))}</th>
              <th>${esc(bi('电脑名称', 'Computer'))}</th>
              <th>${esc(bi('平台 / 模式', 'OS / Mode'))}</th>
              <th>${esc(bi('就绪工具', 'Tools'))}</th>
              <th>IP</th>
              <th>${esc(bi('在线时长', 'Connected'))}</th>
              <th>${esc(bi('操作', 'Action'))}</th>
            </tr>
          </thead>
          <tbody>
            ${bridges.map((b) => {
              const key = `disc-bridge:${b.roomId}:${b.bridgeId}`
              const armed = state.confirmKey === key
              const appsHtml = (b.apps || []).filter((a) => a.available).map((a) => {
                const m = getAppMeta(a.app)
                return `<span class="app-tag" style="color:${m.color};background:${m.bg}">${esc(m.badge)}</span>`
              }).join(' ') || '<span class="muted-text">—</span>'
              return `
                <tr>
                  <td><strong>${esc(b.ownerLabel)}</strong></td>
                  <td>
                    <div><strong>${esc(b.label || b.hostname)}</strong></div>
                    <div class="muted-text mono">${esc(b.bridgeId)}</div>
                  </td>
                  <td>
                    <span>${esc(fmtPlatform(b.platform))}</span>
                    <span class="pill pill-subtle mono">${esc(b.mode)}</span>
                  </td>
                  <td>${appsHtml}</td>
                  <td class="mono">${esc(b.ip || '—')}</td>
                  <td class="num">${esc(fmtUptime((Date.now() - (b.connectedAt || Date.now())) / 1000))}</td>
                  <td>
                    <button type="button" class="btn btn-xs ${armed ? 'btn-danger-confirm' : 'btn-danger-soft'}"
                      data-action="disconnect-bridge" data-room-id="${esc(b.roomId)}" data-bridge-id="${esc(b.bridgeId)}">
                      ${esc(armed ? bi('确认断开?', 'Confirm?') : bi('断开', 'Disconnect'))}
                    </button>
                  </td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      `
    }

    const cBody = document.getElementById('live-clients-body')
    if (clients.length === 0) {
      cBody.innerHTML = `<div class="empty-state">${esc(bi('当前没有在线的控制终端', 'No controlling terminals currently online'))}</div>`
    } else {
      cBody.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>${esc(bi('所属用户 / 房间', 'Owner'))}</th>
              <th>${esc(bi('终端设备', 'Device'))}</th>
              <th>${esc(bi('类型', 'Kind'))}</th>
              <th>IP</th>
              <th>${esc(bi('在线时长', 'Connected'))}</th>
              <th>${esc(bi('操作', 'Action'))}</th>
            </tr>
          </thead>
          <tbody>
            ${clients.map((c) => {
              const key = `kick-sess:${c.roomId}:${c.sid || c.clientId}`
              const armed = state.confirmKey === key
              return `
                <tr>
                  <td>
                    <strong>${esc(c.ownerLabel)}</strong>
                    ${c.isCurrentAdmin ? ` <span class="pill pill-emerald">${esc(bi('当前', 'You'))}</span>` : ''}
                  </td>
                  <td><strong>${esc(c.deviceName)}</strong></td>
                  <td><span class="pill pill-subtle">${esc(fmtClientKind(c.clientKind))}</span></td>
                  <td class="mono">${esc(c.ip || '—')}</td>
                  <td class="num">${esc(fmtUptime((Date.now() - (c.connectedAt || Date.now())) / 1000))}</td>
                  <td>
                    ${c.isCurrentAdmin
                      ? `<span class="muted-text">${esc(bi('当前会话', 'Current'))}</span>`
                      : `<button type="button" class="btn btn-xs ${armed ? 'btn-danger-confirm' : 'btn-danger-soft'}"
                          data-action="kick-session" data-user-id="${esc(c.roomId)}" data-sid="${esc(c.sid || '')}" data-client-id="${esc(c.clientId || '')}">
                          ${esc(armed ? bi('确认踢出?', 'Confirm?') : bi('踢出', 'Kick'))}
                        </button>`}
                  </td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      `
    }
  }

  function activityMeta(type) {
    switch (type) {
      case 'bridge.online': return { label: bi('电脑上线', 'PC Online'), cls: 'pill-emerald' }
      case 'bridge.offline': return { label: bi('电脑离线', 'PC Offline'), cls: 'pill-muted' }
      case 'client.online': return { label: bi('终端上线', 'Client On'), cls: 'pill-sky' }
      case 'client.offline': return { label: bi('终端断开', 'Client Off'), cls: 'pill-muted' }
      case 'user.register': return { label: bi('新用户注册', 'Registered'), cls: 'pill-brand' }
      case 'user.login': return { label: bi('账号登录', 'Sign In'), cls: 'pill-subtle' }
      case 'admin.kick': return { label: bi('管理操作', 'Admin Kick'), cls: 'pill-rose' }
      case 'admin.tier': return { label: bi('等级变更', 'Tier Change'), cls: 'pill-sky' }
      case 'admin.quota_reset': return { label: bi('流量重置', 'Quota Reset'), cls: 'pill-emerald' }
      case 'turn.quota_exceeded': return { label: bi('中继达上限', 'TURN Limit'), cls: 'pill-rose' }
      default: return { label: type || 'event', cls: 'pill-subtle' }
    }
  }

  function renderActivity(d) {
    const raw = d.activity || []
    const filters = [
      { id: 'all', label: bi('全部', 'All') },
      { id: 'bridge', label: bi('电脑桥接', 'Bridges') },
      { id: 'client', label: bi('控制终端', 'Clients') },
      { id: 'user', label: bi('账号登录', 'Auth') },
      { id: 'turn', label: bi('中继配额', 'TURN') },
      { id: 'admin', label: bi('管理操作', 'Admin') },
    ]

    document.getElementById('activity-filter-pills').innerHTML = filters.map((f) => `
      <button type="button" class="filter-pill ${state.activityFilter === f.id ? 'active' : ''}" data-action="filter-activity" data-filter="${esc(f.id)}">
        ${esc(f.label)}
      </button>
    `).join('')

    const list = state.activityFilter === 'all'
      ? raw
      : raw.filter((item) => String(item.type || '').startsWith(`${state.activityFilter}.`))

    const el = document.getElementById('activity-list')
    if (list.length === 0) {
      el.innerHTML = `<div class="empty-state">${esc(bi('本次服务启动后暂无运行事件', 'No events recorded since server boot'))}</div>`
      return
    }

    el.innerHTML = list.map((item) => {
      const m = activityMeta(item.type)
      return `
        <div class="activity-row">
          <div><span class="pill ${m.cls}">${esc(m.label)}</span></div>
          <div class="activity-main">
            ${item.ownerLabel ? `<strong>${esc(item.ownerLabel)}</strong>` : ''}
            ${item.label && item.label !== item.ownerLabel ? `<span>${esc(item.label)}</span>` : ''}
            ${item.detail ? `<span class="muted-text">${esc(item.detail)}</span>` : ''}
            ${item.ip ? `<span class="pill pill-subtle mono">${esc(item.ip)}</span>` : ''}
          </div>
          <div class="activity-time" title="${esc(fmtDateShort(item.ts))}">
            ${esc(fmtClock(item.ts))} · ${esc(fmtRelative(item.ts))}
          </div>
        </div>
      `
    }).join('')
  }

  function switchTab(tabId) {
    state.activeTab = tabId
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId)
    })
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== `tab-${tabId}`)
    })
  }

  // ---- Event Wiring ----

  function bindEvents() {
    // Reset 2FA challenge field whenever username changes
    const usernameInput = document.getElementById('inp-username')
    if (usernameInput) {
      usernameInput.addEventListener('input', () => {
        resetTwofaField()
      })
    }

    // Login form submit
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const errEl = document.getElementById('login-error')
      const btn = document.getElementById('btn-login')
      errEl.classList.add('hidden')
      btn.disabled = true

      try {
        const remember = document.getElementById('inp-remember').checked
        const username = document.getElementById('inp-username').value.trim()
        const password = document.getElementById('inp-password').value
        const twofaWrap = document.getElementById('twofa-field')
        const twofaInput = document.getElementById('inp-twofa')
        const emailCode = !twofaWrap.classList.contains('hidden') ? twofaInput.value.trim() : ''
        if (!username || !password) throw new Error(bi('请输入管理员账号和密码', 'Please enter username and password'))
        let adminClientUid = ''
        try {
          adminClientUid = String(localStorage.getItem('allinone_admin_client_uid_v1') || '').trim()
          if (!/^[a-zA-Z0-9._-]{8,64}$/.test(adminClientUid)) {
            const buf = new Uint8Array(12)
            crypto.getRandomValues(buf)
            adminClientUid = 'cli_' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
            localStorage.setItem('allinone_admin_client_uid_v1', adminClientUid)
          }
        } catch {}
        const res = await apiFetch('/api/account/login', {
          method: 'POST',
          auth: false,
          body: {
            username,
            password,
            ...(emailCode ? { emailCode } : {}),
            deviceName: 'Admin Monitor',
            clientKind: 'web',
            ...(adminClientUid ? { clientUid: adminClientUid } : {}),
          },
        })
        if (res.user?.role !== 'admin') {
          if (res.token) {
            fetch(`${RELAY_BASE_PATH}/api/auth/logout`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${res.token}` },
              keepalive: true,
            }).catch(() => {})
          }
          throw new Error(bi('该账号不是管理员，无法进入服务器监控看板', 'This account is not an administrator'))
        }
        twofaWrap.classList.add('hidden')
        twofaInput.value = ''
        state.token = res.token
        state.tokenSource = 'admin'
        saveAdminToken(res.token, remember)
        document.getElementById('inp-password').value = ''
        await loadOverview()
        scheduleAutoRefresh()
      } catch (err) {
        if (err?.data?.requires2fa) {
          const twofaWrap = document.getElementById('twofa-field')
          const twofaHint = document.getElementById('twofa-hint')
          const twofaInput = document.getElementById('inp-twofa')
          twofaWrap.classList.remove('hidden')
          twofaHint.textContent =
            err.data.message ||
            bi(`已向 ${err.data.maskedEmail || '绑定邮箱'} 发送 6 位验证码`, `6-digit code sent to ${err.data.maskedEmail || 'your email'}`)
          twofaInput.focus()
          if (err.data.error) {
            errEl.textContent = String(err.data.error)
            errEl.classList.remove('hidden')
          }
        } else {
          errEl.textContent = String(err.message || err)
          errEl.classList.remove('hidden')
        }
      } finally {
        btn.disabled = false
      }
    })

    // Navigation tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    })

    // Manual refresh
    document.getElementById('btn-refresh').addEventListener('click', () => {
      void loadOverview({ force: true })
    })

    // Auto refresh selector
    document.getElementById('auto-refresh-select').addEventListener('change', (e) => {
      state.autoRefreshSec = Math.max(0, Number(e.target.value) || 0)
      scheduleAutoRefresh()
      showToast(
        state.autoRefreshSec > 0
          ? bi(`已开启自动刷新（每 ${state.autoRefreshSec} 秒，切到后台自动暂停）`, `Auto-refresh enabled (${state.autoRefreshSec}s, pauses in background)`)
          : bi('已关闭自动刷新（按需刷新模式）', 'Auto-refresh disabled (on-demand mode)'),
      )
    })

    // Theme & Language toggles
    const toggleTheme = () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark'
      applyTheme()
    }
    const toggleLang = () => {
      state.lang = state.lang === 'zh' ? 'en' : 'zh'
      try { localStorage.setItem(LANG_KEY, state.lang) } catch {}
      applyStaticI18n()
      renderAll()
    }
    document.getElementById('btn-theme').addEventListener('click', toggleTheme)
    document.getElementById('login-theme-btn').addEventListener('click', toggleTheme)
    document.getElementById('btn-lang').addEventListener('click', toggleLang)
    document.getElementById('login-lang-btn').addEventListener('click', toggleLang)

    // Logout (only revoke dedicated admin session server-side; never kick borrowed main-app sessions)
    document.getElementById('btn-logout').addEventListener('click', () => {
      const tok = state.token
      const source = state.tokenSource
      clearAdminToken()
      showLoginView()
      showToast(bi('已退出监控后台', 'Signed out of monitor'))
      if (tok && source === 'admin') {
        fetch(`${RELAY_BASE_PATH}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}` },
          keepalive: true,
        }).catch(() => {})
      }
    })

    // Search & Sort & Expand All
    document.getElementById('user-search').addEventListener('input', (e) => {
      state.userSearch = e.target.value || ''
      if (state.data) renderUsersSection(state.data)
    })

    document.getElementById('user-sort').addEventListener('change', (e) => {
      state.userSort = e.target.value || 'status'
      if (state.data) renderUsersSection(state.data)
    })

    document.getElementById('btn-expand-all').addEventListener('click', () => {
      if (!state.data) return
      const filtered = getFilteredUsers(state.data.users || [])
      const allOpen = filtered.length > 0 && filtered.every((u) => state.expandedUsers.has(u.userId))
      if (allOpen) {
        for (const u of filtered) state.expandedUsers.delete(u.userId)
      } else {
        for (const u of filtered) state.expandedUsers.add(u.userId)
      }
      renderUsersSection(state.data)
    })

    document.getElementById('dashboard-view').addEventListener('change', async (e) => {
      const sel = e.target.closest('select[data-action="set-user-tier"]')
      if (!sel) return
      const userId = sel.dataset.userId || ''
      const tier = String(sel.value || 'free').toLowerCase()
      if (!userId) return
      sel.disabled = true
      try {
        await apiFetch('/api/admin/users/set-tier', {
          method: 'POST',
          body: { userId, tier },
        })
        showToast(bi(`已更新用户等级为 ${tier.toUpperCase()}`, `Updated user tier to ${tier.toUpperCase()}`))
        await loadOverview({ force: true })
      } catch (err) {
        if (handleAuthError(err)) return
        showToast(String(err.message || err))
        await loadOverview({ force: true })
      } finally {
        sel.disabled = false
      }
    })

    // Keyboard toggle for user summary rows (Enter / Space)
    document.getElementById('dashboard-view').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (e.target.closest('select, button, input, a')) return
      const row = e.target.closest('[data-action="toggle-user"]')
      if (!row) return
      e.preventDefault()
      const uid = row.dataset.userId
      if (!uid) return
      if (state.expandedUsers.has(uid)) state.expandedUsers.delete(uid)
      else state.expandedUsers.add(uid)
      renderUsersSection(state.data)
    })

    // Delegated click handler for all dynamic actions (strict CSP compliant)
    document.getElementById('dashboard-view').addEventListener('click', async (e) => {
      const target = e.target.closest('[data-action]')
      if (!target) return
      const action = target.dataset.action

      if (action === 'toggle-user') {
        const uid = target.dataset.userId
        if (!uid) return
        if (state.expandedUsers.has(uid)) state.expandedUsers.delete(uid)
        else state.expandedUsers.add(uid)
        renderUsersSection(state.data)
        return
      }

      if (action === 'filter-users') {
        state.userFilter = target.dataset.filter || 'all'
        if (state.data) renderUsersSection(state.data)
        return
      }

      if (action === 'filter-activity') {
        state.activityFilter = target.dataset.filter || 'all'
        if (state.data) renderActivity(state.data)
        return
      }

      if (action === 'copy-text') {
        const txt = target.dataset.copy || ''
        if (await copyText(txt)) {
          showToast(bi('已复制到剪贴板', 'Copied to clipboard'))
        }
        return
      }

      if (action === 'disconnect-bridge') {
        const roomId = target.dataset.roomId || ''
        const bridgeId = target.dataset.bridgeId || ''
        const key = `disc-bridge:${roomId}:${bridgeId}`
        if (state.confirmKey !== key) {
          armConfirm(key)
          return
        }
        clearConfirm()
        try {
          await apiFetch('/api/admin/bridges/disconnect', {
            method: 'POST',
            body: { roomId, bridgeId },
          })
          showToast(bi(`已断开电脑桥接 ${bridgeId}`, `Disconnected bridge ${bridgeId}`))
          await loadOverview({ force: true })
        } catch (err) {
          if (handleAuthError(err)) return
          showToast(String(err.message || err))
        }
        return
      }

      if (action === 'kick-session') {
        const userId = target.dataset.userId || ''
        const sid = target.dataset.sid || ''
        const clientId = target.dataset.clientId || ''
        const key = `kick-sess:${userId}:${sid || clientId}`
        if (state.confirmKey !== key) {
          armConfirm(key)
          return
        }
        clearConfirm()
        try {
          await apiFetch('/api/admin/users/kick-session', {
            method: 'POST',
            body: { userId, sid, clientId },
          })
          showToast(bi('已踢出该终端会话', 'Terminal session revoked'))
          await loadOverview({ force: true })
        } catch (err) {
          if (handleAuthError(err)) return
          showToast(String(err.message || err))
        }
        return
      }

      if (action === 'revoke-all') {
        const userId = target.dataset.userId || ''
        const key = `revoke-all:${userId}`
        if (state.confirmKey !== key) {
          armConfirm(key)
          return
        }
        clearConfirm()
        try {
          const res = await apiFetch('/api/admin/users/revoke-all', {
            method: 'POST',
            body: { userId },
          })
          showToast(bi(`已强制下线该用户全部终端（踢出 ${res.disconnectedClients || 0} 条在线连接）`, `Signed out all sessions (${res.disconnectedClients || 0} live)`))
          await loadOverview({ force: true })
        } catch (err) {
          if (handleAuthError(err)) return
          showToast(String(err.message || err))
        }
        return
      }

      if (action === 'reset-turn-usage') {
        const userId = target.dataset.userId || ''
        const key = `reset-turn:${userId}`
        if (state.confirmKey !== key) {
          armConfirm(key)
          return
        }
        clearConfirm()
        try {
          await apiFetch('/api/admin/users/reset-turn-usage', {
            method: 'POST',
            body: { userId },
          })
          showToast(bi('已清零该用户本月中继流量', 'Reset user monthly TURN relay usage'))
          await loadOverview({ force: true })
        } catch (err) {
          if (handleAuthError(err)) return
          showToast(String(err.message || err))
        }
        return
      }
    })

    // Keyboard shortcut: press R to refresh when not typing in an input
    window.addEventListener('keydown', (e) => {
      if (!state.token || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = String(document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        void loadOverview({ force: true })
      }
    })
  }

  // ---- Boot ----
  function init() {
    applyStaticI18n()
    bindEvents()
    const saved = tryLoadSavedToken()
    if (saved.token) {
      state.token = saved.token
      state.tokenSource = saved.source
      void loadOverview()
    } else {
      showLoginView()
    }
  }

  init()
})()
