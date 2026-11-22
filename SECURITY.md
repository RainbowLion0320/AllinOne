# Security Policy & Threat Model

Because **All in One** allows remote control of AI coding agents running on your personal computers, please carefully review its security architecture and trust boundaries before deploying.

## 1. Trust Boundary & Self-Hosting Requirement

- **Self-hosted only**: The relay server (`@allinone/relay-server`) authenticates clients, isolates tenant rooms, routes RPC/event messages, and temporarily relays uploaded attachments.
- **Transport encryption (TLS), not zero-knowledge E2EE**: All production deployments must terminate **HTTPS / WSS** (e.g., via Caddy or Nginx in `deploy/`). The relay server can inspect payloads passing through it in memory, so **never connect your PC bridge to an untrusted third-party relay server**.
- **Account & Credential Storage**:
  - Account passwords are stored as salted `scrypt` hashes (`N=16384, r=8, p=1`) verified with `crypto.timingSafeEqual`.
  - Per-PC `deviceSecret` values are stored server-side only as salted SHA-256 hashes.
  - Registration invite codes are strictly single-use and burned synchronously on registration.
  - Persistent store files (`accounts.json`, `rooms.json`) are written atomically with `0600` permissions.

## 2. Local Agent Execution Permissions

To provide frictionless remote coding from mobile/desktop clients, adapters default to autonomous execution permissions on the host machine:

| Adapter | Default Permission Setting | How to Restrict |
| :--- | :--- | :--- |
| **Antigravity** (`antigravity.js`) | `autoApprove: true` (`--dangerously-skip-permissions`) | Pass `antigravityAutoApprove: false` in adapter config |
| **Claude Code** (`claude.js`) | `claudePermissionMode: 'acceptEdits'` | Set `claudePermissionMode: 'default'` or `'plan'` in config |
| **DeepSeek Harness** (`dsh.js`) | `permissionPreset: 'danger-full-access'` | Change `permissionPreset` in `cordis.patch.yml` (e.g., `'workspace-write'` or `'read-only'`) |
| **Codex** (`codex.js`) | Uses your local Codex CLI approval/sandbox configuration | Configure sandbox/approval policy in your local `~/.codex/config.toml` |

**Implication**: Anyone who obtains valid credentials for your All in One account can instruct AI agents on your online computers to read, edit, or execute code in your local projects. Protect your account password, restrict who receives invite codes, and keep your relay server locked down.

## 3. Built-In Server & Bridge Defenses

- **Production secret guard**: Refuses to start with `NODE_ENV=production` if `CLIENT_ACCESS_TOKEN` or `BRIDGE_SECRET` is weak or still set to development defaults.
- **One-time WebSocket tickets**: Client WebSocket upgrades prefer short-lived, single-use `/api/ws-ticket` tokens to prevent URL token leakage and replay.
- **Origin allowlist & CORS**: Enforces same-origin / configured `PUBLIC_RELAY_URL` / `ALLOWED_ORIGINS` (plus explicit Capacitor and Electron `app://allinone` origins).
- **SSRF & Path Traversal checks**: Attachment fetch validates target origin against the relay server itself and blocks private/metadata destinations; local file reads enforce canonical path containment (`assertPathWithinDir`) and safe session IDs.
- **Rate limiting**: Applies per-IP rate limiting on authentication and registration endpoints, handling reverse-proxy `X-Forwarded-For` headers safely.
- **Scoped CLI auto-completion**: The PC bridge only invokes official vendor CLI installers (`antigravity.google`, `claude.ai`, `@openai/codex`) when a local half-installed footprint is already present, applies a 6-hour failure cooldown, and can be disabled entirely via `ALLINONE_NO_AUTOFIX=1`.

## 4. Production Hardening Checklist

- [ ] Always run behind HTTPS/WSS (`Caddyfile` or `nginx.conf`).
- [ ] Set strong random values for `CLIENT_ACCESS_TOKEN`, `BRIDGE_SECRET`, and `JWT_SECRET` in `.env` (never commit `.env` to Git).
- [ ] Set `PUBLIC_RELAY_URL` to your exact HTTPS origin.
- [ ] Keep `capacitor.config.json` with `"cleartext": false` and `"allowMixedContent": false` for production mobile builds.
- [ ] Periodically review registered users and revoke unused invite codes via `npm run admin -- invite list` / `npm run admin -- users`.

## 5. Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public issue with exploit details. Instead, use GitHub's [Private Vulnerability Reporting](https://github.com/RainbowLion0320/AllinOne/security/advisories/new) on this repository (or contact the maintainers privately) with:

- A clear description of the vulnerability and affected component(s)
- Minimal reproduction steps or proof of concept
- Suggested remediation if known

We will acknowledge reports promptly and coordinate a fix before public disclosure.
