# Security Policy & Threat Model

Because **All in One** allows remote control of AI coding agents running on your personal computers, please carefully review its security architecture and trust boundaries before deploying.

## 1. Trust Boundary & Zero-Knowledge End-to-End Encryption (E2EE)

- **Zero-Knowledge E2EE (AES-256-GCM) + WebRTC P2P-First (`AIO-P2P v1`) & Optional Encrypted TURN Fallback**:
  - Each computer bridge automatically generates a random **256-bit room key** locally (protected on Desktop via macOS Keychain / Windows DPAPI `safeStorage`, and `0600` config permissions on CLI). The raw key is **never sent to or stored on the server**.
  - The HTTP/WebSocket server operates strictly as a **Pure Control Plane + Stateless RFC 5389 STUN (`UDP 3478`)**: it handles authentication, device presence, and unicast E2EE WebRTC signaling (`p2p.signal`), and carries **zero bytes** of chat, RPC, image, or file payloads (no `/api/uploads` storage and no HTTP/WebSocket data-plane relay).
  - All WebRTC DataChannels (`aio-ctrl` and `aio-bulk`) layer mandatory application-level **AES-256-GCM** encryption on top of WebRTC DTLS — using fresh 96-bit random IVs, 128-bit auth tags, AAD context binding (`version | kind | roomId | keyId`), request/response correlation IDs, 10-minute IV replay protection, and AIO2 4 MB chunked streaming encryption for large files.
  - **Optional Encrypted TURN Fallback (`⚡ Relay`) & Per-User Quota Metering**:
    - Direct peer-to-peer WebRTC (`⚡ P2P`) is always preferred (0 bytes through server/TURN, permanently unlimited). For restrictive double-symmetric NATs where UDP hole punching cannot succeed, operators may optionally enable self-hosted `coturn` (via short-lived RFC HMAC-SHA1 credentials derived from `TURN_SECRET`; the shared secret is never exposed to clients) and/or tiered **Cloudflare Realtime TURN** (`CF_TURN_*`, e.g., routing `free` accounts onto Cloudflare's 1 TB/month pool while `pro`/`ultra`/`admin` use self-hosted `coturn`).
    - **Ciphertext-only guarantee over TURN**: Even when packets traverse a self-hosted or Cloudflare TURN relay, they remain strictly **DTLS + AES-256-GCM double-encrypted** using the client-only 256-bit room key. Neither the control-plane server nor any TURN relay ever possesses the E2EE key or can inspect, modify, or forge chat messages, source code, tool calls, or files.
    - **Per-user monthly TURN quota enforcement & Relay Data-Saver**: When `TURN_LOG_FILE` is configured, `turn-meter.js` incrementally parses `coturn` session usage logs to meter per-user monthly TURN bytes across 4 tiers (`free` 1 GB / `pro` 10 GB / `ultra` 50 GB / `admin` 50 GB by default, where `admin` strictly matches `ultra`; `0` = unlimited). Once a user reaches their monthly TURN cap, the server simply omits TURN credentials (direct P2P remains permanently unlimited). Over relayed connections, clients also engage **Relay Data-Saver** (tap-to-load images) to minimize relayed bandwidth.
  - Revoking a device session immediately sends a `client.revoked` control message to every online PC bridge in the account room, tearing down the revoked device's WebRTC DataChannels within milliseconds and blacklisting its `clientId`.
  - New mobile/web clients sync the 256-bit key locally via an offline SVG QR code (`allinone-e2ee://v1?...`) or `ECDH P-256` + 6-digit SAS verification; key rotation on the Desktop App immediately revokes lost devices without affecting local chat history.
- **Transport encryption (TLS)**: All production deployments must still terminate **HTTPS / WSS** (e.g., via Caddy or Nginx in `deploy/`) to protect authentication flows, metadata, and transport integrity.
- **Account & Credential Storage**:
  - Account passwords are stored as salted `scrypt` hashes (`N=16384, r=8, p=1`) verified with `crypto.timingSafeEqual`.
  - Per-PC `deviceSecret` values are stored server-side only as salted SHA-256 hashes.
  - Registration invite codes are strictly single-use and burned synchronously on registration.
  - Persistent store files (`accounts.json`) are written atomically with `0600` permissions.

## 2. Local Agent Execution Permissions

To provide frictionless remote coding from mobile/desktop clients, adapters default to autonomous execution permissions on the host machine:

| Adapter | Default Permission Setting | How to Restrict |
| :--- | :--- | :--- |
| **Antigravity** (`antigravity.js`) | `autoApprove: true` (`--dangerously-skip-permissions`) | Pass `agyAutoApprove: false` in `dsh-mobile-hub` adapter config |
| **Claude Code** (`claude.js`) | `claudePermissionMode: 'acceptEdits'` | Set `claudePermissionMode: 'default'` or `'plan'` in config |
| **DeepSeek Harness** (`dsh.js`) | `permissionPreset: 'danger-full-access'` | Change `permissionPreset` in `cordis.patch.yml` (e.g., `'workspace-write'` or `'read-only'`); note that the auto-installed `allinone-dsh-ipc` plugin manages `~/.dsh/profiles/desktop/node_modules/allinone-dsh-ipc/cordis.patch.yml` unless `ALLINONE_NO_AUTOFIX=1` is set |
| **Codex** (`codex.js`) | Uses your local Codex CLI approval/sandbox configuration | Configure sandbox/approval policy in your local `~/.codex/config.toml` |

**Implication**: Anyone who obtains valid credentials for your All in One account can instruct AI agents on your online computers to read, edit, or execute code in your local projects. Protect your account password, restrict who receives invite codes, and keep your relay server locked down.

## 3. Built-In Server & Bridge Defenses

- **Production secret guard**: Refuses to start with `NODE_ENV=production` if `JWT_SECRET` is missing or shorter than 16 characters.
- **Mandatory one-time WebSocket tickets**: Client WebSocket upgrades strictly require short-lived, single-use `/api/auth/ws-ticket` tickets (no master JWTs in URLs).
- **Origin allowlist & CORS**: Enforces same-origin / configured `PUBLIC_RELAY_URL` / `ALLOWED_ORIGINS` (plus explicit Capacitor and Electron `app://allinone` origins).
- **Opaque P2P Attachment Tokens & Path Traversal checks**: Inbound phone-to-PC attachments arrive exclusively over E2EE WebRTC `aio-bulk` into `0700`/`0600` local storage and are minted as single-use, client-scoped opaque `p2pToken` handles (`materializeAttachments()` strictly rejects caller-supplied `localPath`, arbitrary URLs, cross-client tokens, and replays); agent session and transcript reads enforce canonical path containment (`assertPathWithinDir`) and safe session IDs, while `RPC.FILE_READ` validates allowed extensions, blocks sensitive directories/credentials, checks canonical `realpathSync` targets, and streams files > 128 KB directly over `aio-bulk`.
- **Rate limiting**: Applies per-IP, per-account, and per-(IP, roomId) rate limiting on authentication and bridge endpoints, handling reverse-proxy `X-Forwarded-For` headers safely.
- **Scoped CLI auto-completion**: The PC bridge only invokes official vendor CLI installers (`antigravity.google`, `claude.ai`, `@openai/codex`) when a local half-installed footprint is already present, applies a 6-hour failure cooldown, and can be disabled entirely via `ALLINONE_NO_AUTOFIX=1`.

## 4. Production Hardening Checklist

- [ ] Always run behind HTTPS/WSS (`Caddyfile` or `nginx.conf`).
- [ ] Set a strong random `JWT_SECRET` (>= 32 hex chars, e.g., `openssl rand -hex 32`) in `.env` (never commit `.env` to Git).
- [ ] Set `PUBLIC_RELAY_URL` to your exact HTTPS origin.
- [ ] Keep `capacitor.config.json` with `"cleartext": false` and `"allowMixedContent": false` for production mobile builds.
- [ ] If enabling self-hosted `coturn` or Cloudflare TURN, keep `TURN_SECRET` / `CF_TURN_API_TOKEN` exclusively in `0600` `.env`, and configure `coturn` `denied-peer-ip` rules to block loopback and private RFC 1918/link-local ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`).
- [ ] Periodically review registered users, tiers, and unused invite codes via `npm run admin -- invite list` / `npm run admin -- users`.

## 5. Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue with exploit details. Instead, use GitHub's [Private Vulnerability Reporting](https://github.com/RainbowLion0320/AllinOne/security/advisories/new) on this repository (or contact the maintainers privately) with:

- A clear description of the vulnerability and affected component(s)
- Minimal reproduction steps or proof of concept
- Suggested remediation if known

We will acknowledge reports promptly and coordinate a fix before public disclosure.
