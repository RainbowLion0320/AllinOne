#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${ALLINONE_SERVER:-https://your-relay.example.com}"
SERVER_URL="${SERVER_URL%/}"
if [[ ! "${SERVER_URL}" =~ ^https?://[A-Za-z0-9._:/\[\]-]+$ ]] || [[ "${SERVER_URL}" =~ ^https?://your-relay\.example\.com(/|$) ]]; then
  echo "[!] Invalid or placeholder ALLINONE_SERVER URL: ${SERVER_URL}"
  echo "    Please set ALLINONE_SERVER to your real relay server URL (e.g. https://ai.example.com)."
  exit 1
fi
INSTALL_DIR="${HOME}/.allinone-bridge"
BRIDGE_FILE="${INSTALL_DIR}/allinone-bridge.mjs"
DOWNLOAD_URL="${SERVER_URL}/downloads/allinone-bridge.mjs"

echo ""
echo "=========================================================="
echo "  All in One - PC Bridge Quick Setup (macOS / Linux)"
echo "=========================================================="
echo "  Server: ${SERVER_URL}"
echo ""

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.volta/bin:${HOME}/.bun/bin:${PATH}"
if [ -d "${HOME}/.nvm/versions/node" ]; then
  LATEST_NVM_BIN="$(ls -d "${HOME}/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "${LATEST_NVM_BIN}" ]; then
    export PATH="${LATEST_NVM_BIN}:${PATH}"
  fi
fi

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.nvm/current/bin/node"; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${NODE_BIN}" ]; then
  echo "[!] Node.js v22+ (Node 22 LTS recommended) not found. Please install it from https://nodejs.org/ (or brew install node) and re-run."
  exit 1
fi

NODE_VER="$("${NODE_BIN}" -v)"
NODE_MAJOR="$(echo "${NODE_VER}" | sed -E 's/^v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "[!] Found Node.js ${NODE_VER}, but Node.js v22+ (Node 22 LTS recommended) is required. Please upgrade Node.js."
  exit 1
fi
echo "[1/3] Node.js ready: ${NODE_VER} (${NODE_BIN})"

mkdir -p "${INSTALL_DIR}"
chmod 700 "${INSTALL_DIR}" 2>/dev/null || true

echo "[2/3] Downloading portable bridge bundle..."
BRIDGE_TMP="${BRIDGE_FILE}.tmp.$$"
trap 'rm -f "${BRIDGE_TMP}" 2>/dev/null || true' EXIT
curl --proto '=https,http' --proto-redir '=https,http' -fsSL "${DOWNLOAD_URL}" -o "${BRIDGE_TMP}"
chmod 600 "${BRIDGE_TMP}" 2>/dev/null || true
mv -f "${BRIDGE_TMP}" "${BRIDGE_FILE}"
trap - EXIT

START_SH="${INSTALL_DIR}/start.sh"
printf -v Q_NODE_BIN '%q' "${NODE_BIN}"
printf -v Q_BRIDGE_FILE '%q' "${BRIDGE_FILE}"
printf -v Q_SERVER_URL '%q' "${SERVER_URL}"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.volta/bin:${HOME}/.bun/bin:${PATH}"'
  printf 'exec %s %s --server %s "$@"\n' "${Q_NODE_BIN}" "${Q_BRIDGE_FILE}" "${Q_SERVER_URL}"
} > "${START_SH}"
chmod +x "${START_SH}"

if [ "$(uname -s)" = "Darwin" ] && [ -d "${HOME}/Desktop" ]; then
  CMD_FILE="${HOME}/Desktop/All-in-One-Bridge.command"
  cp "${START_SH}" "${CMD_FILE}"
  chmod +x "${CMD_FILE}"
  echo "[3/3] Created Desktop launcher: ${CMD_FILE}"
else
  echo "[3/3] Created launcher: ${START_SH}"
fi

echo ""
echo "Starting All in One PC Bridge (sign in with your account to bind this PC)..."
echo ""
if [ -t 0 ]; then
  exec "${NODE_BIN}" "${BRIDGE_FILE}" --server "${SERVER_URL}"
elif [ -r /dev/tty ]; then
  exec "${NODE_BIN}" "${BRIDGE_FILE}" --server "${SERVER_URL}" </dev/tty
else
  exec "${NODE_BIN}" "${BRIDGE_FILE}" --server "${SERVER_URL}"
fi
