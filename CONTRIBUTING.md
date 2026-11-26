# Contributing to All in One

Thanks for your interest in contributing to **All in One**!

## Development Setup

Requirements:
- **Node.js >= 22.13.0**
- **npm >= 10**

```bash
git clone https://github.com/RainbowLion0320/AllinOne.git
cd AllinOne
npm install
npm run build
npm run test:smoke
```

## Workspace Overview

- `packages/shared` — Shared RPC/event protocol, path/ID validation, AES-256-GCM / ECDH E2EE, `AIO-P2P v1` DataChannel multiplexer, and offline QR SVG generator (`protocol.js`, `e2ee.js`, `p2p-mux.js`, `qr-svg.js`)
- `packages/relay-server` — Pure Control Plane HTTP/WS signaling server, built-in stateless STUN (`stun-server.js`), dynamic TURN credentials & 4-tier monthly quota meter (`turn-meter.js`), tiered Cloudflare Realtime TURN provider (`cf-turn.js`), account/2FA store with atomic daily registration cap (`MAX_DAILY_REGISTRATIONS`, default 20/day) & optional `ADMIN_BOOTSTRAP_TOKEN` first-admin bootstrap, on-demand `/admin` monitoring dashboard, and admin CLI
- `packages/dsh-mobile-hub` — Local bridge orchestrator, WebRTC P2P (`werift`) client, agent adapters (`codex`, `claude`, `antigravity`, `dsh`), auto-installed `allinone-dsh-ipc` local IPC plugin, and portable CLI
- `packages/mobile-app` — React + Tailwind + Vite PWA frontend with WebRTC P2P transport & Relay Data-Saver (also bundled into the Electron desktop app)
- `packages/desktop-app` — Electron desktop wrapper with embedded bridge manager, native Chromium `libwebrtc` worker (`webrtc-proxy.js`), OS keychain storage, system tray, and DMG/NSIS packaging

## Useful Commands

```bash
npm run build           # Build portable bridge + frontend dist
npm run test:smoke      # Run full end-to-end smoke & security test suite
npm run start:relay     # Start local relay server on http://127.0.0.1:8787
npm run dev:mobile      # Run Vite dev server (proxies /api and /ws to 8787)
npm run dev:desktop     # Run Electron desktop app locally
```

## Pull Request Guidelines

1. Keep changes focused and well-scoped.
2. **Never commit secrets, personal server URLs/IPs, `.env*` files, local user data (`data/*.json`), or compiled binaries (`.apk`, `.dmg`, `.exe`).**
3. Run `npm run build && npm run test:smoke` locally and ensure all checks pass before opening a PR.
4. Use clear, descriptive commit messages (Conventional Commits style preferred, e.g., `feat(desktop): ...`, `fix(antigravity): ...`).
5. For security-related changes or new protocol endpoints, add corresponding test coverage in `scripts/smoke-test.mjs`.
