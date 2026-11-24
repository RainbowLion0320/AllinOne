import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'

const DEFAULT_SMTP_TIMEOUT_MS = 15_000

function sanitizeHeaderValue(val) {
  return String(val ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function extractEmailAddress(raw) {
  const clean = sanitizeHeaderValue(raw)
  const angle = clean.match(/<([^<>\s]+@[^<>\s]+)>/)
  if (angle) return angle[1].trim()
  return clean.replace(/^["']|["']$/g, '').trim()
}

function encodeRfc2047(text) {
  const clean = sanitizeHeaderValue(text)
  if (!clean) return ''
  if (/^[\x20-\x7E]+$/.test(clean) && !clean.includes('=?')) return clean
  // RFC 2047: each encoded-word <= 75 chars; 45 UTF-8 bytes -> 60 base64 chars -> 72 total chars
  const MAX_CHUNK_BYTES = 45
  const words = []
  let chunk = ''
  let chunkBytes = 0
  for (const ch of clean) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (chunkBytes + chBytes > MAX_CHUNK_BYTES && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
      chunk = ch
      chunkBytes = chBytes
    } else {
      chunk += ch
      chunkBytes += chBytes
    }
  }
  if (chunk) {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
  }
  return words.join('\r\n ')
}

function formatDisplayName(display) {
  const clean = sanitizeHeaderValue(display)
  if (!clean) return ''
  if (!/^[\x20-\x7E]+$/.test(clean) || clean.includes('=?')) {
    return encodeRfc2047(clean)
  }
  // Quote RFC 5322 specials in ASCII display-name
  if (/[()<>\[\]:;@\\,".]/.test(clean)) {
    return `"${clean.replace(/([\\"])/g, '\\$1')}"`
  }
  return clean
}

function formatFromHeader(rawFrom, fallbackAddr) {
  const clean = sanitizeHeaderValue(rawFrom)
  if (!clean) return `All in One <${fallbackAddr}>`
  const angle = clean.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>$/)
  if (angle) {
    const display = angle[1].trim().replace(/^["']|["']$/g, '')
    const addr = angle[2].trim()
    const formatted = formatDisplayName(display)
    return formatted ? `${formatted} <${addr}>` : `<${addr}>`
  }
  return `<${clean}>`
}

function wrapBase64(str) {
  const b64 = Buffer.from(String(str ?? ''), 'utf8').toString('base64')
  const lines = []
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76))
  }
  return lines.join('\r\n')
}

function dotStuff(mimeText) {
  return mimeText
    .replace(/\r?\n/g, '\r\n')
    .replace(/(^|\r\n)\./g, '$1..')
}

function buildMimeMessage({ fromHeader, toAddr, subject, text, html, hostDomain }) {
  const boundary = `allinone_${randomBytes(12).toString('hex')}`
  const msgId = `<${Date.now()}.${randomBytes(8).toString('hex')}@${hostDomain || 'localhost'}>`
  const headers = [
    `From: ${fromHeader}`,
    `To: <${sanitizeHeaderValue(toAddr)}>`,
    `Subject: ${encodeRfc2047(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(html),
    `--${boundary}--`,
  ]

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`
}

/**
 * Minimal, zero-dependency RFC 5321 SMTP client supporting:
 * - Implicit TLS (port 465, e.g. QQ Mail / 163 Mail / Gmail)
 * - STARTTLS upgrade (port 587)
 * - AUTH LOGIN & AUTH PLAIN
 */
export async function sendViaSmtp({
  host,
  port = 465,
  secure = port === 465,
  starttls = true,
  rejectUnauthorized = true,
  user = '',
  pass = '',
  from = '',
  to,
  subject,
  text,
  html,
  timeoutMs = DEFAULT_SMTP_TIMEOUT_MS,
}) {
  const cleanHost = String(host || '').trim()
  const numericPort = Number(port) || (secure ? 465 : 587)
  const cleanTo = extractEmailAddress(to)
  const envelopeFrom = extractEmailAddress(from || user)
  const fromHeader = formatFromHeader(from || (user ? `All in One <${user}>` : ''), envelopeFrom)

  if (!cleanHost) throw new Error('SMTP_HOST 未配置')
  if (!envelopeFrom) throw new Error('发件邮箱未配置')
  if (!cleanTo) throw new Error('收件邮箱无效')

  let socket = null
  let buffer = ''
  let closedError = null
  let pendingResolve = null
  let pendingReject = null
  let pendingLines = []

  const cleanupSocket = () => {
    if (socket) {
      try { socket.removeAllListeners() } catch {}
      try { socket.destroy() } catch {}
      socket = null
    }
  }

  const failPending = (err) => {
    closedError = err
    if (pendingReject) {
      const rej = pendingReject
      pendingResolve = null
      pendingReject = null
      rej(err)
    }
  }

  const processBuffer = () => {
    while (pendingResolve) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const rawLine = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (!rawLine) continue
      pendingLines.push(rawLine)
      // Final line of an SMTP reply has a space (or EOL) immediately after the 3-digit code
      if (/^\d{3}( |$)/.test(rawLine)) {
        const code = Number(rawLine.slice(0, 3))
        const lines = pendingLines
        pendingLines = []
        const res = pendingResolve
        pendingResolve = null
        pendingReject = null
        res({ code, lines, text: lines.join('\n') })
      }
    }
  }

  const attachSocketListeners = (sock) => {
    sock.setEncoding('utf8')
    sock.setTimeout(timeoutMs)
    sock.on('data', (chunk) => {
      buffer += chunk
      processBuffer()
    })
    sock.on('timeout', () => {
      failPending(new Error('连接邮件服务器超时'))
      try { sock.destroy() } catch {}
    })
    sock.on('error', (err) => {
      failPending(err instanceof Error ? err : new Error(String(err)))
    })
    const handleDisconnect = () => {
      if (!closedError) {
        failPending(new Error('邮件服务器意外断开连接'))
      }
    }
    sock.on('end', handleDisconnect)
    sock.on('close', handleDisconnect)
  }

  const readReply = () => {
    if (closedError) return Promise.reject(closedError)
    return new Promise((resolvePromise, rejectPromise) => {
      pendingResolve = resolvePromise
      pendingReject = rejectPromise
      processBuffer()
    })
  }

  const sendCmd = async (cmd, expectedCodes) => {
    if (!socket || closedError) {
      throw closedError || new Error('SMTP 连接已断开')
    }
    const replyPromise = readReply()
    socket.write(`${cmd}\r\n`)
    const reply = await replyPromise
    if (expectedCodes && !expectedCodes.includes(reply.code)) {
      throw new Error(`SMTP 错误 (${reply.code}): ${reply.lines[reply.lines.length - 1] || reply.text}`)
    }
    return reply
  }

  const connectInitial = () =>
    new Promise((resolvePromise, rejectPromise) => {
      const opts = secure
        ? { host: cleanHost, port: numericPort, servername: cleanHost, rejectUnauthorized }
        : { host: cleanHost, port: numericPort }
      const sock = secure ? tls.connect(opts) : net.connect(opts)
      const onError = (err) => {
        sock.removeAllListeners()
        try { sock.destroy() } catch {}
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      }
      const onTimeout = () => {
        onError(new Error('连接邮件服务器超时'))
      }
      const onReady = () => {
        sock.removeListener('error', onError)
        sock.removeListener('timeout', onTimeout)
        resolvePromise(sock)
      }
      sock.setTimeout(timeoutMs)
      sock.once('error', onError)
      sock.once('timeout', onTimeout)
      sock.once(secure ? 'secureConnect' : 'connect', onReady)
    })

  const upgradeToTls = (plainSocket) =>
    new Promise((resolvePromise, rejectPromise) => {
      plainSocket.removeAllListeners()
      const tlsSock = tls.connect({
        socket: plainSocket,
        servername: cleanHost,
        rejectUnauthorized,
      })
      const onError = (err) => {
        tlsSock.removeAllListeners()
        try { tlsSock.destroy() } catch {}
        rejectPromise(err instanceof Error ? err : new Error(String(err)))
      }
      const onTimeout = () => onError(new Error('SMTP STARTTLS 握手超时'))
      const onReady = () => {
        tlsSock.removeListener('error', onError)
        tlsSock.removeListener('timeout', onTimeout)
        resolvePromise(tlsSock)
      }
      tlsSock.setTimeout(timeoutMs)
      tlsSock.once('error', onError)
      tlsSock.once('timeout', onTimeout)
      tlsSock.once('secureConnect', onReady)
    })

  try {
    socket = await connectInitial()
    attachSocketListeners(socket)

    const greeting = await readReply()
    if (greeting.code !== 220) {
      throw new Error(`SMTP 握手失败 (${greeting.code}): ${greeting.text}`)
    }

    const ehloHost = envelopeFrom.split('@')[1] || 'localhost'
    let ehlo = await sendCmd(`EHLO ${ehloHost}`, [250])

    if (!secure && starttls) {
      if (!ehlo.lines.some((l) => /^250[- ]STARTTLS(?:\s|$)/i.test(l))) {
        throw new Error('SMTP 服务器未提供 STARTTLS，已拒绝降级为明文传输')
      }
      await sendCmd('STARTTLS', [220])
      buffer = ''
      pendingLines = []
      socket = await upgradeToTls(socket)
      attachSocketListeners(socket)
      ehlo = await sendCmd(`EHLO ${ehloHost}`, [250])
    }

    if (user || pass) {
      const authLine = ehlo.lines.find((l) => /^250[- ]AUTH[\s=]/i.test(l)) || ''
      const supportsPlain = /\bPLAIN\b/i.test(authLine)
      const supportsLogin = /\bLOGIN\b/i.test(authLine) || !supportsPlain

      if (supportsLogin) {
        await sendCmd('AUTH LOGIN', [334])
        await sendCmd(Buffer.from(String(user), 'utf8').toString('base64'), [334])
        await sendCmd(Buffer.from(String(pass), 'utf8').toString('base64'), [235])
      } else {
        const plainPayload = Buffer.from(`\0${String(user)}\0${String(pass)}`, 'utf8').toString('base64')
        await sendCmd(`AUTH PLAIN ${plainPayload}`, [235])
      }
    }

    await sendCmd(`MAIL FROM:<${envelopeFrom}>`, [250])
    await sendCmd(`RCPT TO:<${cleanTo}>`, [250, 251])
    await sendCmd('DATA', [354])

    const mime = buildMimeMessage({
      fromHeader,
      toAddr: cleanTo,
      subject,
      text,
      html,
      hostDomain: ehloHost,
    })

    const dataReplyPromise = readReply()
    socket.write(`${dotStuff(mime)}\r\n.\r\n`)
    const dataReply = await dataReplyPromise
    if (dataReply.code !== 250) {
      throw new Error(`SMTP 发送失败 (${dataReply.code}): ${dataReply.text}`)
    }

    try {
      await sendCmd('QUIT', [221, 250])
    } catch {}
    return { ok: true }
  } finally {
    cleanupSocket()
  }
}

async function sendViaResend({ apiKey, from, to, subject, text, html, timeoutMs = DEFAULT_SMTP_TIMEOUT_MS }) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [extractEmailAddress(to)],
        subject: sanitizeHeaderValue(subject),
        text,
        html,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Resend API 错误 (${res.status}): ${detail.slice(0, 200)}`)
    }
    return { ok: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function buildVerificationEmailContent({ code, purpose, username = '' }) {
  const purposeLabel =
    purpose === 'reset'
      ? '重置密码'
      : purpose === 'bind'
        ? '绑定邮箱'
        : purpose === 'login_2fa'
          ? '登录二次验证'
          : '注册账号'

  const subject = `[All in One] 你的${purposeLabel}验证码：${code}`
  const greeting = username ? `你好 @${username}：` : '你好：'
  const text = [
    greeting,
    '',
    `你正在 All in One 进行「${purposeLabel}」操作，本次 6 位验证码为：`,
    '',
    `    ${code}`,
    '',
    '验证码 10 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。',
  ].join('\n')

  const escapedGreeting = greeting
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const html = `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:24px;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1e293b;">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px 24px;border:1px solid #e2e8f0;">
    <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:14px;">All in One</div>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#334155;">${escapedGreeting}</p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155;">你正在进行 <strong>${purposeLabel}</strong> 操作，请在页面中输入下方验证码：</p>
    <div style="text-align:center;margin:20px 0;padding:16px;border-radius:12px;background:#f1f5ff;border:1px solid #dbe4ff;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#3b5bfe;">${code}</span>
    </div>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">验证码 10 分钟内有效，请勿转发或泄露给他人。如果这不是你本人的操作，直接忽略本邮件即可。</p>
  </div>
</body>
</html>`

  return { subject, text, html }
}

function parseBoolEnv(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const lower = String(raw).trim().toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return true
  if (lower === '0' || lower === 'false' || lower === 'no') return false
  return fallback
}

/**
 * Create an optional mailer backed by:
 * 1) Custom `sendEmail` hook (tests)
 * 2) Standard SMTP (QQ / 163 / Gmail / Outlook / self-hosted) via SMTP_HOST + SMTP_USER + SMTP_PASS
 * 3) Resend HTTPS API via RESEND_API_KEY + RESEND_FROM
 */
export function createMailer(options = {}) {
  const customSend = typeof options.sendEmail === 'function' ? options.sendEmail : null

  const smtpHost = String(options.smtpHost ?? process.env.SMTP_HOST ?? '').trim()
  const smtpPort = Number(options.smtpPort ?? process.env.SMTP_PORT ?? 465) || 465
  const smtpSecure = parseBoolEnv(options.smtpSecure ?? process.env.SMTP_SECURE, smtpPort === 465)
  const smtpStarttls = parseBoolEnv(options.smtpStarttls ?? process.env.SMTP_STARTTLS, true)
  const smtpRejectUnauthorized = parseBoolEnv(
    options.smtpRejectUnauthorized ?? process.env.SMTP_TLS_REJECT_UNAUTHORIZED,
    true,
  )
  const smtpUser = String(options.smtpUser ?? process.env.SMTP_USER ?? '').trim()
  const smtpPass = String(options.smtpPass ?? process.env.SMTP_PASS ?? '').trim()
  const smtpFrom = String(
    options.smtpFrom ?? process.env.SMTP_FROM ?? (smtpUser ? `All in One <${smtpUser}>` : ''),
  ).trim()

  const resendApiKey = String(options.resendApiKey ?? process.env.RESEND_API_KEY ?? '').trim()
  const resendFrom = String(options.resendFrom ?? process.env.RESEND_FROM ?? smtpFrom).trim()

  const hasSmtp = Boolean(smtpHost && (smtpUser || smtpFrom) && (smtpPass || options.smtpAllowNoAuth))
  const hasResend = Boolean(resendApiKey && resendFrom)

  function getProvider() {
    if (customSend) return 'custom'
    if (hasSmtp) return 'smtp'
    if (hasResend) return 'resend'
    return 'none'
  }

  function isConfigured() {
    return getProvider() !== 'none'
  }

  async function sendMail({ to, subject, text, html }) {
    const provider = getProvider()
    if (provider === 'none') {
      throw new Error('服务器尚未配置邮件服务（SMTP 或 Resend）')
    }
    if (provider === 'custom') {
      return customSend({ to, subject, text, html })
    }
    if (provider === 'smtp') {
      return sendViaSmtp({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        starttls: smtpStarttls,
        rejectUnauthorized: smtpRejectUnauthorized,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom || `All in One <${smtpUser}>`,
        to,
        subject,
        text,
        html,
      })
    }
    return sendViaResend({
      apiKey: resendApiKey,
      from: resendFrom,
      to,
      subject,
      text,
      html,
    })
  }

  async function sendVerificationCode({ to, code, purpose, username = '' }) {
    const content = buildVerificationEmailContent({ code, purpose, username })
    await sendMail({ to, ...content })
    return { ok: true }
  }

  async function sendLoginAlert({ to, username = '', deviceName = '', ip = '', at = Date.now() }) {
    const safeUser = String(username || '').replace(/[<>]/g, '')
    const safeDevice = String(deviceName || 'Unknown Device').replace(/[<>]/g, '')
    const safeIp = String(ip || 'unknown').replace(/[<>]/g, '')
    const timeStr = new Date(at || Date.now()).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    const subject = `[All in One] 新设备登录提醒 · ${safeDevice}`
    const text = [
      `你好${safeUser ? ` @${safeUser}` : ''}：`,
      '',
      '检测到你的 All in One 账号刚刚在新设备或新网络 IP 上登录：',
      `  • 设备：${safeDevice}`,
      `  • 来源 IP：${safeIp}`,
      `  • 时间：${timeStr}`,
      '',
      '如果这是你本人操作，可直接忽略本邮件。',
      '如非本人操作，请立即打开 All in One →「我的电脑」→「已登录终端」点击「下线其他」，并尽快修改密码。',
    ].join('\n')
    const html = `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:24px;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1e293b;">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:16px;padding:26px 24px;border:1px solid #e2e8f0;">
    <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:12px;">All in One · 安全提醒</div>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#334155;">你好${safeUser ? ` <strong>@${safeUser}</strong>` : ''}，检测到你的账号刚刚在新设备或新网络登录：</p>
    <div style="margin:14px 0;padding:14px 16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;line-height:1.8;color:#334155;">
      <div><strong>设备：</strong>${safeDevice}</div>
      <div><strong>来源 IP：</strong><code>${safeIp}</code></div>
      <div><strong>时间：</strong>${timeStr}</div>
    </div>
    <p style="margin:14px 0 0;font-size:12.5px;line-height:1.6;color:#64748b;">如为本人操作，请忽略此邮件；如非本人操作，请立即在客户端「我的电脑 → 已登录终端」点击<strong>「下线其他」</strong>并修改密码。</p>
  </div>
</body>
</html>`
    await sendMail({ to, subject, text, html })
    return { ok: true }
  }

  return {
    isConfigured,
    getProvider,
    sendMail,
    sendVerificationCode,
    sendLoginAlert,
  }
}
