import { randomInt } from 'node:crypto'
import { validateEmail, validatePassword, validateUsername } from '../accounts.js'
import { parseClientDeviceInfo } from '../hub.js'
import { maskEmailAddress, readJsonObjectBody, sendJson, sendRouteError } from '../http-utils.js'

/**
 * Account, Authentication, Email OTP, 2FA, Password & Session management routes:
 * `/api/account/*` (excluding bound device CRUD) and `/api/auth/*`.
 */
export function createAuthRoutes({
  auth,
  accounts,
  hub,
  mailer,
  emailCodes,
  outboundEmailGate,
  ipDailyRegLimiter,
  adminBootstrapToken,
  maxDailyRegistrations,
  extractBearer,
  checkUserActionRateLimit,
  getClientIp,
  getMergedAccountDevices,
  getMergedClientSessions,
  buildUserTurnQuota,
  resolveIceServers,
  observeRequestHost = () => '',
  log = console,
}) {
  function shouldSendSecurityEmail(userId, kind, ip = '') {
    return outboundEmailGate.tryConsume({ userId, kind, ip })
  }

  /**
   * Enforce optional Email 2FA challenge/send/verify/consume flow for login endpoints.
   * Returns `true` if login may proceed; returns `false` if an HTTP response was already sent.
   */
  async function handleOptionalEmail2fa(res, { user, emailCode, ip, accountRateKey }) {
    if (!user?.loginEmail2fa) {
      return true
    }
    // Fail-closed: never silently bypass enabled 2FA if mailer is unavailable or misconfigured
    if (!mailer.isConfigured() || !user.email || !user.emailVerified) {
      sendJson(res, 503, { ok: false, error: '服务器邮件服务异常，暂无法完成邮箱二次验证' })
      return false
    }
    const cleanCode = String(emailCode || '').trim()
    const maskedEmail = maskEmailAddress(user.email)
    if (!cleanCode) {
      const issued = emailCodes.issueCode({
        purpose: 'login_2fa',
        email: user.email,
        ip,
        userId: user.userId,
      })
      if (!issued.ok) {
        if (issued.retryAfterSec) {
          sendJson(res, 200, {
            ok: false,
            requires2fa: true,
            maskedEmail,
            cooldownSec: issued.retryAfterSec,
            message: `验证码已发送至 ${maskedEmail}，请直接输入或 ${issued.retryAfterSec} 秒后重发`,
          })
          return false
        }
        sendJson(res, 429, { ok: false, error: issued.error })
        return false
      }
      try {
        await mailer.sendVerificationCode({
          to: user.email,
          code: issued.code,
          purpose: 'login_2fa',
          username: user.username,
        })
      } catch (mailErr) {
        issued.rollback?.()
        log.error?.(`[relay] Failed to send login 2FA email for @${user.username}:`, { error: mailErr?.message || String(mailErr) })
        const status = mailErr?.statusCode === 503 ? 503 : 502
        sendJson(res, status, { ok: false, error: '发送登录验证码失败，请稍后重试或联系管理员检查邮件服务配置' })
        return false
      }
      sendJson(res, 200, {
        ok: false,
        requires2fa: true,
        maskedEmail,
        cooldownSec: issued.cooldownSec,
        message: `已向 ${maskedEmail} 发送 6 位登录验证码`,
      })
      return false
    }
    const check2fa = emailCodes.verifyCode({
      purpose: 'login_2fa',
      email: user.email,
      code: cleanCode,
      userId: user.userId,
      consume: false,
    })
    if (!check2fa.ok) {
      auth.recordFailure(ip)
      auth.recordAccountFailure(accountRateKey, ip)
      sendJson(res, 401, {
        ok: false,
        requires2fa: true,
        maskedEmail,
        error: check2fa.error,
      })
      return false
    }
    emailCodes.consumeCode({ purpose: 'login_2fa', email: user.email })
    return true
  }

  async function handleAuthRoute(req, res, pathname, urlObj) {
    // Account bootstrap check (O(1) daily reg count + soft per-IP throttle)
    if (pathname === '/api/account/bootstrap-status' && req.method === 'GET') {
      const ip = getClientIp(req)
      if (!checkUserActionRateLimit('bootstrap', ip, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      const hasAdmin = accounts.hasAnyUser()
      const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
      sendJson(res, 200, {
        ok: true,
        hasAdmin,
        hasUsers: hasAdmin,
        userCount: accounts.getUserCount(),
        needsBootstrapToken: !hasAdmin && Boolean(adminBootstrapToken),
        emailEnabled: mailer.isConfigured(),
        openRegistration: true,
        dailyRegistrationLimit: maxDailyRegistrations,
        dailyRegistrationsUsed: dailyStats.used,
        dailyRegistrationRemaining: dailyStats.remaining,
      })
      return true
    }

    // Send 6-digit email verification code for register binding, post-login bind, or password reset
    if (pathname === '/api/account/email/send-code' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const purpose = String(body.purpose || '').trim()
        if (purpose !== 'register' && purpose !== 'bind' && purpose !== 'reset') {
          sendJson(res, 400, { ok: false, error: '不支持的验证码用途' })
          return true
        }
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return true
        }

        let targetUserId = ''
        let targetUsername = ''
        let shouldDeliver = true

        if (purpose === 'register') {
          if (accounts.hasAnyUser()) {
            const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
            if (dailyStats.exceeded) {
              sendJson(res, 429, {
                ok: false,
                code: 'DAILY_REGISTRATION_LIMIT',
                error: `今日新用户注册名额已满（每日上限 ${dailyStats.limit} 人），请明天再试`,
              })
              return true
            }
          } else if (adminBootstrapToken) {
            const bootstrapToken = String(body.bootstrapToken || '').trim()
            if (!auth.verifyAdminBootstrapToken(bootstrapToken)) {
              auth.recordFailure(ip)
              sendJson(res, 400, { ok: false, error: '管理员初始化密钥无效' })
              return true
            }
          }
          if (accounts.isEmailTaken(eCheck.email)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return true
          }
        } else if (purpose === 'bind') {
          const payload = auth.verifySessionToken(extractBearer(req))
          if (!payload || !String(payload.room || '').startsWith('usr_')) {
            sendJson(res, 401, { ok: false, error: '请先登录账号后再绑定邮箱' })
            return true
          }
          if (!checkUserActionRateLimit('write', payload.room, 60)) {
            sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
            return true
          }
          const curUser = accounts.getUserById(payload.room)
          if (!curUser) {
            sendJson(res, 401, { ok: false, error: '账号不存在' })
            return true
          }
          if (accounts.isEmailTaken(eCheck.email, payload.room)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return true
          }
          if (curUser.email && curUser.email.toLowerCase() === eCheck.emailLower && curUser.emailVerified) {
            sendJson(res, 400, { ok: false, error: '当前账号已绑定该邮箱' })
            return true
          }
          targetUserId = payload.room
          targetUsername = curUser.username
        } else if (purpose === 'reset') {
          const matchedUser = accounts.getUserByEmail(eCheck.email)
          if (!matchedUser || !matchedUser.emailVerified) {
            shouldDeliver = false
          } else {
            targetUserId = matchedUser.userId
            targetUsername = matchedUser.username
          }
        }

        if (!shouldDeliver) {
          const ipCheck = emailCodes.checkIpSendLimit(ip)
          if (!ipCheck.ok) {
            sendJson(res, 429, { ok: false, error: ipCheck.error })
            return true
          }
          const cfg = emailCodes.getConfig()
          await new Promise((r) => setTimeout(r, 40 + randomInt(0, 60)))
          sendJson(res, 200, {
            ok: true,
            cooldownSec: cfg.cooldownSec,
            expiresInSec: cfg.expiresInSec,
            message: '如果该邮箱已绑定账号，验证码已发送（10 分钟内有效）',
          })
          return true
        }

        const issued = emailCodes.issueCode({
          purpose,
          email: eCheck.email,
          ip,
          userId: targetUserId,
        })
        if (!issued.ok) {
          if (purpose === 'reset' && issued.retryAfterSec) {
            const cfg = emailCodes.getConfig()
            await new Promise((r) => setTimeout(r, 40 + randomInt(0, 60)))
            sendJson(res, 200, {
              ok: true,
              cooldownSec: cfg.cooldownSec,
              expiresInSec: cfg.expiresInSec,
              message: '如果该邮箱已绑定账号，验证码已发送（10 分钟内有效）',
            })
            return true
          }
          sendJson(res, 429, {
            ok: false,
            error: issued.error,
            ...(issued.retryAfterSec ? { retryAfterSec: issued.retryAfterSec } : {}),
          })
          return true
        }

        try {
          await mailer.sendVerificationCode({
            to: eCheck.email,
            code: issued.code,
            purpose,
            username: targetUsername,
          })
        } catch (err) {
          issued.rollback()
          log.error(`[relay] Failed to send ${purpose} verification email:`, { error: err?.message || String(err) })
          const status = err?.statusCode === 503 ? 503 : 502
          sendJson(res, status, { ok: false, error: '验证码发送失败，请稍后重试或检查邮件服务配置' })
          return true
        }

        sendJson(res, 200, {
          ok: true,
          cooldownSec: issued.cooldownSec,
          expiresInSec: issued.expiresInSec,
          message:
            purpose === 'reset'
              ? '如果该邮箱已绑定账号，验证码已发送（10 分钟内有效）'
              : '验证码已发送至邮箱（10 分钟内有效）',
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Account registration:
    // 1. Validate username/password/bootstrap/availability BEFORE consuming email OTP (no premature OTP burn)
    // 2. Atomically reserve per-IP daily quota BEFORE async scrypt (rolling back on failure)
    if (pathname === '/api/account/register' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      let ipReservation = null
      let registrationCommitted = false
      try {
        const body = await readJsonObjectBody(req)
        const bootstrapToken = String(body.bootstrapToken || '').trim()
        const hadExistingUsers = accounts.hasAnyUser()

        // Validate username & password & bootstrap rules BEFORE checking/consuming email OTP
        const uCheck = validateUsername(body.username)
        if (!uCheck.ok) {
          sendJson(res, 400, { ok: false, error: uCheck.error })
          return true
        }
        const pCheck = validatePassword(body.password)
        if (!pCheck.ok) {
          sendJson(res, 400, { ok: false, error: pCheck.error })
          return true
        }

        if (hadExistingUsers) {
          const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
          if (dailyStats.exceeded) {
            sendJson(res, 429, {
              ok: false,
              code: 'DAILY_REGISTRATION_LIMIT',
              error: `今日新用户注册名额已满（每日上限 ${dailyStats.limit} 人），请明天再试`,
            })
            return true
          }
        } else if (adminBootstrapToken && !auth.verifyAdminBootstrapToken(bootstrapToken)) {
          auth.recordFailure(ip)
          sendJson(res, 400, { ok: false, error: '管理员初始化密钥无效' })
          return true
        }

        if (accounts.isUsernameTaken(uCheck.username)) {
          sendJson(res, 400, { ok: false, error: '该用户名已被注册，请换一个用户名' })
          return true
        }

        const rawEmail = String(body.email || '').trim()
        let verifiedEmail = ''
        let emailCheck = null
        if (rawEmail) {
          if (!mailer.isConfigured()) {
            sendJson(res, 400, { ok: false, error: '服务器尚未开启邮箱验证，请留空邮箱直接注册' })
            return true
          }
          emailCheck = validateEmail(rawEmail)
          if (!emailCheck.ok) {
            sendJson(res, 400, { ok: false, error: emailCheck.error })
            return true
          }
          if (accounts.isEmailTaken(emailCheck.email)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return true
          }
        }

        // Atomically reserve per-IP daily slot BEFORE consuming OTP and BEFORE async scrypt
        if (hadExistingUsers) {
          const resv = ipDailyRegLimiter.tryReserve(ip)
          if (!resv.ok) {
            sendJson(res, 429, {
              ok: false,
              code: 'IP_DAILY_REGISTRATION_LIMIT',
              error: `当前网络今日注册次数已达上限（每日每 IP 最多 ${ipDailyRegLimiter.limit} 个账号），请明天再试`,
            })
            return true
          }
          ipReservation = resv
        }

        if (emailCheck) {
          // Consume OTP atomically right before async scrypt (prevents concurrent OTP replay)
          const codeCheck = emailCodes.verifyCode({
            purpose: 'register',
            email: emailCheck.email,
            code: body.emailCode,
            consume: true,
          })
          if (!codeCheck.ok) {
            auth.recordFailure(ip)
            sendJson(res, 400, { ok: false, error: codeCheck.error })
            return true
          }
          verifiedEmail = emailCheck.email
        }

        const result = await accounts.registerUserAsync({
          username: uCheck.username,
          password: pCheck.password,
          bootstrapToken,
          expectedBootstrapToken: adminBootstrapToken,
          email: verifiedEmail,
          emailVerified: Boolean(verifiedEmail),
          maxDailyRegistrations,
        })
        if (!result.ok) {
          const statusCode = result.statusCode || 400
          if (statusCode !== 429) auth.recordFailure(ip)
          sendJson(res, statusCode, {
            ok: false,
            ...(result.code ? { code: result.code } : {}),
            error: result.error,
          })
          return true
        }

        registrationCommitted = true
        const user = result.user
        observeRequestHost(req, user.userId)
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        const sid = auth.generateSessionId()
        const onlineSids = new Set(hub.getClientList(user.userId).map((c) => c.sid).filter(Boolean))
        accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
          onlineSids,
        })
        hub.recordActivity({
          type: 'user.register',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: devInfo.deviceName,
          ip,
        })
        const token = auth.signSessionToken(
          user.userId,
          devInfo.deviceName,
          user.userId,
          user.tokenVersion,
          { role: user.role, username: user.username, sid },
        )
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: user.userId,
          user,
          devices: [],
          bridges: [],
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      } finally {
        if (!registrationCommitted && ipReservation) {
          ipReservation.release()
        }
      }
      return true
    }

    // Bind or replace verified email for an authenticated account
    if (pathname === '/api/account/email/bind' && req.method === 'POST') {
      const bearerToken = extractBearer(req)
      const payload = auth.verifySessionToken(bearerToken)
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return true
      }
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip) || !auth.checkAccountRateLimit(payload.room, ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const currentPassword = String(body.currentPassword ?? '')
        if (!currentPassword) {
          sendJson(res, 403, { ok: false, error: '绑定或更换邮箱需要验证当前密码' })
          return true
        }
        const pwValid = await accounts.verifyUserPasswordAsync(payload.room, currentPassword)
        if (!pwValid) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(payload.room, ip)
          sendJson(res, 403, { ok: false, error: '绑定或更换邮箱需要验证当前密码' })
          return true
        }
        if (!auth.verifySessionToken(bearerToken)) {
          sendJson(res, 401, { ok: false, error: '会话已失效，请重新登录' })
          return true
        }
        auth.clearAccountFailure(payload.room, ip)
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return true
        }
        const codeCheck = emailCodes.verifyCode({
          purpose: 'bind',
          email: eCheck.email,
          code: body.code,
          userId: payload.room,
          consume: false,
        })
        if (!codeCheck.ok) {
          sendJson(res, 400, { ok: false, error: codeCheck.error })
          return true
        }
        const prevUser = accounts.getUserById(payload.room)
        const prevEmail = prevUser?.email && prevUser.emailVerified ? prevUser.email : ''
        const updated = accounts.setUserEmail(payload.room, eCheck.email, { verified: true })
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return true
        }
        emailCodes.consumeCode({ purpose: 'bind', email: eCheck.email })
        if (prevEmail && prevEmail.toLowerCase() !== eCheck.emailLower && shouldSendSecurityEmail(payload.room, 'email_change', ip)) {
          mailer
            .sendSecurityNotice({
              to: prevEmail,
              username: updated.user.username,
              title: '账号绑定邮箱已变更',
              summary: `你的 All in One 账号绑定邮箱已更换为 ${maskEmailAddress(eCheck.email)}。如非本人操作，请立即修改密码并强制下线所有设备。`,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              log.warn(`[relay] Failed to send email-change security notice for @${updated.user.username}: ${String(err?.message || err)}`)
            })
        }
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Self-service password reset using verified email OTP:
    // - Rate-limited by composite `(ip, normalizedEmail)` so attackers cannot lock out victims from another IP
    // - Recorded and rejected uniformly whether the email exists or not (zero 429/400 or error-text enumeration oracle)
    if (pathname === '/api/account/password/reset' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return true
        }
        const pCheck = validatePassword(body.newPassword)
        if (!pCheck.ok) {
          sendJson(res, 400, { ok: false, error: pCheck.error })
          return true
        }
        const cleanCode = String(body.code || '').trim()
        if (!/^\d{6}$/.test(cleanCode)) {
          sendJson(res, 400, { ok: false, error: '请输入 6 位数字邮箱验证码' })
          return true
        }
        if (!auth.checkResetRateLimit(ip, eCheck.emailLower)) {
          sendJson(res, 429, { ok: false, error: '验证尝试过于频繁，请 15 分钟后再试' })
          return true
        }
        const matchedUser = accounts.getUserByEmail(eCheck.email)
        // Consume OTP atomically BEFORE async scrypt to prevent parallel OTP replay
        const codeCheck =
          matchedUser && matchedUser.emailVerified
            ? emailCodes.verifyCode({
                purpose: 'reset',
                email: eCheck.email,
                code: cleanCode,
                userId: matchedUser.userId,
                consume: true,
              })
            : { ok: false }
        if (!codeCheck.ok || !matchedUser || !matchedUser.emailVerified) {
          auth.recordFailure(ip)
          auth.recordResetFailure(ip, eCheck.emailLower)
          sendJson(res, 400, { ok: false, error: '邮箱验证码无效或已过期' })
          return true
        }
        const reset = await accounts.resetPasswordByEmailAsync(eCheck.email, pCheck.password)
        if (!reset.ok) {
          auth.recordFailure(ip)
          auth.recordResetFailure(ip, eCheck.emailLower)
          sendJson(res, 400, { ok: false, error: '邮箱验证码无效或已过期' })
          return true
        }
        // Clear ONLY the (ip, email) reset bucket — never reset the IP-wide failure counter
        auth.clearResetFailure(ip, eCheck.emailLower)
        hub.disconnectRoomClients(reset.user.userId, 4401, 'Password reset')
        sendJson(res, 200, {
          ok: true,
          username: reset.user.username,
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Toggle optional email login 2FA for authenticated account
    if (pathname === '/api/account/security/2fa' && req.method === 'POST') {
      const bearerToken = extractBearer(req)
      const payload = auth.verifySessionToken(bearerToken)
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      const ip = getClientIp(req)
      try {
        const body = await readJsonObjectBody(req)
        const nextEnabled = Boolean(body.enabled)
        if (nextEnabled && !mailer.isConfigured()) {
          sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP），无法开启邮箱二次验证' })
          return true
        }
        const prevUser = accounts.getUserById(payload.room)
        if (nextEnabled === false) {
          if (!auth.checkRateLimit(ip) || !auth.checkAccountRateLimit(payload.room, ip)) {
            sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' })
            return true
          }
          const currentPassword = String(body.currentPassword ?? '')
          if (!currentPassword) {
            sendJson(res, 403, { ok: false, error: '关闭邮箱二次验证需要验证当前密码' })
            return true
          }
          const pwValid = await accounts.verifyUserPasswordAsync(payload.room, currentPassword)
          if (!pwValid) {
            auth.recordFailure(ip)
            auth.recordAccountFailure(payload.room, ip)
            sendJson(res, 403, { ok: false, error: '关闭邮箱二次验证需要验证当前密码' })
            return true
          }
          if (!auth.verifySessionToken(bearerToken)) {
            sendJson(res, 401, { ok: false, error: '会话已失效，请重新登录' })
            return true
          }
          auth.clearAccountFailure(payload.room, ip)
        }
        const updated = accounts.setLoginEmail2fa(payload.room, nextEnabled)
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return true
        }
        if (
          nextEnabled === false &&
          prevUser?.loginEmail2fa &&
          mailer.isConfigured() &&
          updated.user?.email &&
          updated.user?.emailVerified &&
          shouldSendSecurityEmail(payload.room, '2fa_disabled', ip)
        ) {
          mailer
            .sendSecurityNotice({
              to: updated.user.email,
              username: updated.user.username,
              title: '邮箱登录二次验证已关闭',
              summary: '你的 All in One 账号刚刚关闭了邮箱登录二次验证（2FA）。如非本人操作，请立即修改密码、重新开启二次验证并下线所有其他设备。',
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              log.warn(`[relay] Failed to send 2FA-disabled security notice for @${updated.user.username}: ${String(err?.message || err)}`)
            })
        }
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Account mobile/web login -> room-scoped JWT + optional email 2FA + new-device alert
    if (pathname === '/api/account/login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const identifier = String(body.username || '').trim()
        const accountRateKey = accounts.resolveAccountKey(identifier)
        if (accountRateKey && !auth.checkAccountRateLimit(accountRateKey, ip)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return true
        }
        const verified = await accounts.authenticateUserAsync(identifier, body.password, { recordLogin: false })
        if (!verified) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordAccountFailure(accountRateKey, ip)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return true
        }
        let { user } = verified

        if (!(await handleOptionalEmail2fa(res, { user, emailCode: body.emailCode, ip, accountRateKey }))) {
          return true
        }

        // Clear ONLY the (account, ip) bucket — never reset the global IP failure counter
        if (accountRateKey) auth.clearAccountFailure(accountRateKey, ip)
        observeRequestHost(req, user.userId)
        user = accounts.markUserLogin(user.userId) || user
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        const { isNewContext } = accounts.checkAndRememberLoginContext(user.userId, {
          deviceName: devInfo.deviceName,
          ip,
          clientUid: body.clientUid || '',
          skipSave: true,
        })
        const sid = auth.generateSessionId()
        const onlineSids = new Set(hub.getClientList(user.userId).map((c) => c.sid).filter(Boolean))
        const recorded = accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
          onlineSids,
        })
        for (const oldSid of recorded?.replacedSids || []) {
          hub.disconnectClient(user.userId, { sid: oldSid }, 4401, 'Replaced by new sign-in on same device')
        }
        if (isNewContext && mailer.isConfigured() && user.email && user.emailVerified && shouldSendSecurityEmail(user.userId, 'login_alert', ip)) {
          mailer
            .sendLoginAlert({
              to: user.email,
              username: user.username,
              deviceName: devInfo.deviceName,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              log.warn(`[relay] Failed to send login alert email for @${user.username}: ${String(err?.message || err)}`)
            })
        }
        hub.recordActivity({
          type: 'user.login',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: devInfo.deviceName,
          ip,
        })
        const token = auth.signSessionToken(
          user.userId,
          devInfo.deviceName,
          user.userId,
          user.tokenVersion,
          { role: user.role, username: user.username, sid },
        )
        const bridges = hub.getBridgeList(user.userId)
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: user.userId,
          user,
          devices: getMergedAccountDevices(user.userId, bridges),
          bridges,
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // PC Bridge account login -> issues a per-PC `deviceSecret`
    if (pathname === '/api/account/device-login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const identifier = String(body.username || '').trim()
        const accountRateKey = accounts.resolveAccountKey(identifier)
        if (accountRateKey && !auth.checkAccountRateLimit(accountRateKey, ip)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return true
        }
        const verified = await accounts.authenticateUserAsync(identifier, body.password, { recordLogin: false })
        if (!verified) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordAccountFailure(accountRateKey, ip)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return true
        }
        const { user } = verified

        if (!(await handleOptionalEmail2fa(res, { user, emailCode: body.emailCode, ip, accountRateKey }))) {
          return true
        }

        // Clear ONLY the (account, ip) bucket — never reset the global IP failure counter
        if (accountRateKey) auth.clearAccountFailure(accountRateKey, ip)
        observeRequestHost(req, user.userId)
        let bound
        try {
          bound = accounts.bindDevice({
            userId: user.userId,
            label: body.label || body.hostname || 'My PC',
            hostname: body.hostname || body.label || 'My-PC',
            platform: body.platform || 'unknown',
            bridgeId: body.bridgeId || '',
          })
        } catch (bindErr) {
          if (bindErr?.code === 'MAX_DEVICES_EXCEEDED') {
            sendJson(res, 400, { ok: false, error: String(bindErr.message) })
            return true
          }
          throw bindErr
        }
        if (!bound) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return true
        }
        accounts.markUserLogin(user.userId)
        const deviceLabel = bound.label || bound.hostname || 'My PC'
        const { isNewContext } = accounts.checkAndRememberLoginContext(user.userId, {
          deviceName: deviceLabel,
          ip,
        })
        if (isNewContext && mailer.isConfigured() && user.email && user.emailVerified && shouldSendSecurityEmail(user.userId, 'login_alert', ip)) {
          mailer
            .sendLoginAlert({
              to: user.email,
              username: user.username,
              deviceName: deviceLabel,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              log.warn(`[relay] Failed to send device-login alert email for @${user.username}: ${String(err?.message || err)}`)
            })
        }
        hub.recordActivity({
          type: 'user.login',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: `PC bind: ${deviceLabel}`,
          ip,
        })
        hub.broadcastRoomDevices(user.userId)
        sendJson(res, 200, { ok: true, ...bound })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Change account password (kicks OTHER clients while keeping caller connected)
    if (pathname === '/api/account/password' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return true
      }
      const bearerToken = extractBearer(req)
      const payload = auth.verifySessionToken(bearerToken)
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return true
      }
      if (!auth.checkAccountRateLimit(payload.room, ip)) {
        sendJson(res, 429, { ok: false, error: '该账号尝试次数过多，请 15 分钟后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const changed = await accounts.changePasswordAsync(
          payload.room,
          body.currentPassword,
          body.newPassword,
          { validateSession: () => Boolean(auth.verifySessionToken(bearerToken)) },
        )
        if (!changed.ok) {
          if (changed.code === 'stale_session') {
            sendJson(res, 401, { ok: false, error: changed.error })
            return true
          }
          if (changed.error === '当前密码不正确') {
            auth.recordFailure(ip)
            auth.recordAccountFailure(payload.room, ip)
          }
          sendJson(res, 400, { ok: false, error: changed.error })
          return true
        }
        // Clear ONLY the (account, ip) bucket — never reset the global IP failure counter
        auth.clearAccountFailure(payload.room, ip)
        const currentClientId = String(body.currentClientId || '').trim()
        const devInfo = parseClientDeviceInfo(
          body.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body.clientKind || '',
        )
        const newSid = auth.generateSessionId()
        accounts.recordUserSession(changed.user.userId, {
          sid: newSid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
        })
        hub.disconnectOtherRoomClients(
          payload.room,
          { keepClientId: currentClientId, keepSid: payload.sid || '', newSidForKept: newSid },
          4401,
          'Password changed',
        )
        const freshToken = auth.signSessionToken(
          changed.user.userId,
          devInfo.deviceName,
          changed.user.userId,
          changed.user.tokenVersion,
          { role: changed.user.role, username: changed.user.username, sid: newSid },
        )
        sendJson(res, 200, { ok: true, token: freshToken, user: changed.user })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Issue a 30-second single-use WebSocket handshake ticket
    if (pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('ws-ticket', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req, 16 * 1024)
        observeRequestHost(req, payload.room)
        const devInfo = parseClientDeviceInfo(
          body?.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body?.clientKind || '',
        )
        const onlineSids = new Set(hub.getClientList(payload.room).map((c) => c.sid).filter(Boolean))
        accounts.touchUserSession(payload.room, payload.sid, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip: getClientIp(req),
          clientUid: body?.clientUid || '',
          onlineSids,
        })
        const { ticket, expiresAt } = auth.issueWsTicket(payload, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
        })
        sendJson(res, 200, { ok: true, ticket, expiresAt })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // List all active & logged-in controlling devices
    if (pathname === '/api/auth/sessions' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('read', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      const currentClientId = String(urlObj.searchParams.get('clientId') || '').trim()
      const merged = getMergedClientSessions(payload.room, {
        currentSid: payload.sid || '',
        currentClientId,
      })
      sendJson(res, 200, {
        ok: true,
        roomId: payload.room,
        currentSid: payload.sid || '',
        ...merged,
      })
      return true
    }

    // Sign out current session
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      const revokedPermanent = payload.sid ? accounts.revokeUserSession(payload.room, payload.sid) : false
      const kickedConnections = payload.sid
        ? hub.disconnectClient(payload.room, { sid: payload.sid }, 4401, 'Signed out')
        : 0
      sendJson(res, 200, { ok: true, revokedPermanent, kickedConnections })
      return true
    }

    // Kick / revoke a single logged-in client device
    if (pathname === '/api/auth/sessions/revoke' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const targetSid = String(body.sid || '').trim()
        const targetClientId = String(body.clientId || '').trim()
        const currentClientId = String(body.currentClientId || '').trim()
        if (!targetSid && !targetClientId) {
          sendJson(res, 400, { ok: false, error: '缺少目标会话标识' })
          return true
        }
        if (targetSid) {
          const liveMatch = hub.getClientList(payload.room).some((c) => c.sid === targetSid)
          const knownSid = accounts.hasUserSession(payload.room, targetSid) || liveMatch
          if (targetSid.length > 64 || !knownSid) {
            sendJson(res, 404, { ok: false, error: '目标会话不存在或已失效' })
            return true
          }
        }
        if ((targetSid && payload.sid && targetSid === payload.sid) || (targetClientId && currentClientId && targetClientId === currentClientId)) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前本机设备，如需退出请使用退出登录' })
          return true
        }
        const revokedPermanent = targetSid ? accounts.revokeUserSession(payload.room, targetSid) : false
        const kickedConnections = hub.disconnectClient(
          payload.room,
          { clientId: targetClientId, sid: targetSid },
          4401,
          'Session revoked by user',
        )
        const merged = getMergedClientSessions(payload.room, {
          currentSid: payload.sid || '',
          currentClientId,
        })
        sendJson(res, 200, {
          ok: true,
          revokedPermanent,
          kickedConnections,
          ...merged,
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Revoke EVERY other device/token while keeping caller logged in
    if (pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      try {
        const body = await readJsonObjectBody(req)
        const currentClientId = String(body.currentClientId || '').trim()
        const targetRoom = payload.room
        const ip = getClientIp(req)
        const devInfo = parseClientDeviceInfo(
          body.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body.clientKind || '',
        )
        const revoked = accounts.revokeUserTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return true
        }
        const newSid = auth.generateSessionId()
        const acctUser = accounts.getUserById(targetRoom)
        accounts.recordUserSession(targetRoom, {
          sid: newSid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
        })
        const freshToken = auth.signSessionToken(
          targetRoom,
          devInfo.deviceName,
          targetRoom,
          revoked.tokenVersion,
          { role: acctUser?.role || payload.role || 'user', username: acctUser?.username || payload.uname || '', sid: newSid },
        )
        const kickedConnections = hub.disconnectOtherRoomClients(
          targetRoom,
          { keepClientId: currentClientId, keepSid: payload.sid || '', newSidForKept: newSid },
          4401,
          'Signed out from another device',
        )
        const merged = getMergedClientSessions(targetRoom, {
          currentSid: newSid,
          currentClientId,
        })
        sendJson(res, 200, {
          ok: true,
          token: freshToken,
          sid: newSid,
          tokenVersion: revoked.tokenVersion,
          kickedConnections,
          ...merged,
        })
      } catch (err) {
        sendRouteError(res, err, log, pathname)
      }
      return true
    }

    // Revoke ALL active sessions for the authenticated account
    if (pathname === '/api/auth/sessions/revoke-all' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return true
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return true
      }
      const revoked = accounts.revokeUserTokens(payload.room)
      if (!revoked) {
        sendJson(res, 404, { ok: false, error: '账号不存在' })
        return true
      }
      const disconnectedClients = hub.disconnectRoomClients(payload.room, 4401, 'All sessions revoked')
      sendJson(res, 200, {
        ok: true,
        roomId: revoked.roomId,
        tokenVersion: revoked.tokenVersion,
        disconnectedClients,
      })
      return true
    }

    // Verify existing session token & return profile + ICE servers
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return true
      }
      if (!checkUserActionRateLimit('me', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return true
      }
      const acctUser = accounts.getUserById(payload.room)
      if (!acctUser) {
        sendJson(res, 401, { ok: false, error: '账号不存在' })
        return true
      }
      observeRequestHost(req, payload.room)
      const bridges = hub.getBridgeList(payload.room)
      const clientSessions = getMergedClientSessions(payload.room, { currentSid: payload.sid || '' })
      sendJson(res, 200, {
        ok: true,
        user: { ...payload, role: acctUser.role, tier: acctUser.tier },
        roomId: payload.room,
        username: acctUser.username,
        email: acctUser.email || '',
        emailVerified: Boolean(acctUser.emailVerified),
        loginEmail2fa: Boolean(acctUser.loginEmail2fa),
        emailEnabled: mailer.isConfigured(),
        role: acctUser.role,
        tier: acctUser.tier,
        turnQuota: buildUserTurnQuota(payload.room),
        mode: 'p2p-only',
        iceServers: resolveIceServers(req, payload.room),
        label: `@${acctUser.username}`,
        devices: getMergedAccountDevices(payload.room, bridges),
        bridges,
        clientSessions,
      })
      return true
    }

    return false
  }

  return { handleAuthRoute }
}
