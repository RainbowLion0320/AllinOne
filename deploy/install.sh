#!/usr/bin/env bash
# ==============================================================================
# All in One — One-Click Self-Hosted Relay Installer (Linux / Docker)
#
# Quick start:
#   curl -fsSL https://raw.githubusercontent.com/RainbowLion0320/AllinOne/main/deploy/install.sh | bash
#
# Non-interactive examples:
#   curl -fsSL .../install.sh | bash -s -- --domain ai.example.com --yes
#   curl -fsSL .../install.sh | bash -s -- --ip 203.0.113.10 --yes
#   curl -fsSL .../install.sh | bash -s -- --mode proxy --port 8787 --public-url https://ai.example.com --yes
#   curl -fsSL .../install.sh | bash -s -- --upgrade
# ==============================================================================

set -euo pipefail

REPO_URL="${ALLINONE_REPO_URL:-https://github.com/RainbowLion0320/AllinOne.git}"
DEFAULT_IMAGE="ghcr.io/rainbowlion0320/allinone-relay:latest"
IMAGE="${ALLINONE_IMAGE:-$DEFAULT_IMAGE}"
INSTALL_DIR="${ALLINONE_DIR:-}"
MODE="${ALLINONE_MODE:-}"
DOMAIN="${ALLINONE_DOMAIN:-}"
PUBLIC_IP="${ALLINONE_IP:-}"
LISTEN_PORT="${ALLINONE_PORT:-8787}"
PUBLIC_URL="${ALLINONE_PUBLIC_URL:-}"
FORCE_BUILD="${ALLINONE_BUILD:-0}"
UPGRADE_ONLY=0
NONINTERACTIVE="${ALLINONE_NONINTERACTIVE:-0}"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_DIM='\033[2m'
  C_BLUE='\033[38;5;75m'
  C_GREEN='\033[38;5;78m'
  C_YELLOW='\033[38;5;221m'
  C_RED='\033[38;5;203m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_BLUE='' C_GREEN='' C_YELLOW='' C_RED=''
fi

info()  { printf "${C_BLUE}[INFO]${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN}[ OK ]${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}[WARN]${C_RESET} %s\n" "$*"; }
err()   { printf "${C_RED}[ERR ]${C_RESET} %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
All in One — One-Click Self-Hosted Relay Installer

Usage:
  install.sh [options]

Options:
  --dir <path>         Install directory (default: /opt/allinone or ~/allinone)
  --mode <mode>        Deploy mode: domain | ip | proxy
  --domain <host>      Domain name for automatic Let's Encrypt HTTPS (implies --mode domain)
  --ip <ipv4>          Public IPv4 for Let's Encrypt short-lived IP HTTPS (implies --mode ip)
  --port <port>        Local bind port in proxy mode (default: 8787)
  --public-url <url>   External HTTPS URL in proxy mode (e.g. https://ai.example.com)
  --image <ref>        Custom Docker image (default: ghcr.io/rainbowlion0320/allinone-relay:latest)
  --build              Build Docker image locally from source instead of pulling GHCR
  --upgrade            Pull latest image (or rebuild) and restart without changing config
  -y, --yes            Non-interactive mode (accept defaults)
  -h, --help           Show this help message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)        INSTALL_DIR="$2"; shift 2 ;;
    --mode)       MODE="$2"; shift 2 ;;
    --domain)     DOMAIN="$2"; MODE="domain"; shift 2 ;;
    --ip)         PUBLIC_IP="$2"; MODE="ip"; shift 2 ;;
    --port)       LISTEN_PORT="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --image)      IMAGE="$2"; shift 2 ;;
    --build)      FORCE_BUILD=1; shift ;;
    --upgrade)    UPGRADE_ONLY=1; shift ;;
    -y|--yes)     NONINTERACTIVE=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "未知参数: $1（使用 --help 查看用法）" ;;
  esac
done

# Helper: read interactively even when executed via `curl ... | bash`
can_prompt() {
  [ "$NONINTERACTIVE" != "1" ] && { [ -t 0 ] || [ -r /dev/tty ]; }
}

prompt_input() {
  local label="$1"
  local default_val="${2:-}"
  local reply=""
  if ! can_prompt; then
    printf '%s' "$default_val"
    return 0
  fi
  if [ -n "$default_val" ]; then
    printf "%b%s%b [%s]: " "$C_BOLD" "$label" "$C_RESET" "$default_val" >/dev/tty
  else
    printf "%b%s%b: " "$C_BOLD" "$label" "$C_RESET" >/dev/tty
  fi
  IFS= read -r reply </dev/tty || reply=""
  reply="${reply//$'\r'/}"
  if [ -z "$reply" ]; then
    printf '%s' "$default_val"
  else
    printf '%s' "$reply"
  fi
}

prompt_secret() {
  local label="$1"
  local reply=""
  if ! can_prompt; then
    printf ''
    return 0
  fi
  printf "%b%s%b: " "$C_BOLD" "$label" "$C_RESET" >/dev/tty
  IFS= read -rs reply </dev/tty || reply=""
  printf "\n" >/dev/tty
  reply="${reply//$'\r'/}"
  printf '%s' "$reply"
}

prompt_confirm() {
  local label="$1"
  local default_yn="${2:-n}"
  local hint="y/N"
  [ "$default_yn" = "y" ] && hint="Y/n"
  if ! can_prompt; then
    [ "$default_yn" = "y" ] && return 0 || return 1
  fi
  local reply=""
  printf "%b%s%b [%s]: " "$C_BOLD" "$label" "$C_RESET" "$hint" >/dev/tty
  IFS= read -r reply </dev/tty || reply=""
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]' | tr -d '\r ')"
  if [ -z "$reply" ]; then
    [ "$default_yn" = "y" ] && return 0 || return 1
  fi
  [ "$reply" = "y" ] || [ "$reply" = "yes" ]
}

# Privilege helper
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# Resolve default install directory
if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -eq 0 ] || [ -w /opt ] 2>/dev/null; then
    INSTALL_DIR="/opt/allinone"
  else
    INSTALL_DIR="$HOME/allinone"
  fi
fi

# Strip scheme/path/spaces from domain or IP
clean_host() {
  printf '%s' "$1" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s#^https?://##i; s#/.*$##; s/:.*$//'
}

validate_domain() {
  local d="$1"
  printf '%s' "$d" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
}

validate_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  local IFS=.
  local a b c d
  read -r a b c d <<<"$ip"
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ]
}

detect_public_ip() {
  local ip=""
  for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://ip.sb"; do
    ip="$(curl -4 -fsS --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if validate_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  done
  printf ''
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else
    date +%s%N | sha256sum | awk '{print $1}'
  fi
}

read_env_val() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [ -z "$line" ] && return 0
  local val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf '%s' "$val"
}

collect_custom_env_lines() {
  local file="$1"
  [ -f "$file" ] || return 0
  local line trimmed
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      ""|\
      "# Generated by All in One install.sh"|\
      "# Preserved custom settings"|\
      ALLINONE_IMAGE=*|\
      JWT_SECRET=*|\
      PUBLIC_RELAY_URL=*|\
      SMTP_HOST=*|\
      SMTP_PORT=*|\
      SMTP_SECURE=*|\
      SMTP_USER=*|\
      SMTP_PASS=*|\
      SMTP_FROM=*)
        continue
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$file"
  return 0
}

# Detect / install Docker and Docker Compose
DOCKER_CMD=()
COMPOSE_CMD=()

setup_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "未检测到 Docker。"
    if prompt_confirm "是否自动安装官方 Docker 引擎？" "y"; then
      info "正在安装 Docker（官方 get.docker.com 脚本）..."
      curl -fsSL https://get.docker.com | $SUDO sh
      if command -v systemctl >/dev/null 2>&1; then
        $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
      fi
      ok "Docker 安装完成。"
    else
      die "请先安装 Docker（https://docs.docker.com/engine/install/）后重试。"
    fi
  fi

  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER_CMD=($SUDO docker)
  else
    die "无法连接 Docker 守护进程，请确认 docker 服务已启动（如：sudo systemctl start docker）。"
  fi

  if "${DOCKER_CMD[@]}" compose version >/dev/null 2>&1; then
    COMPOSE_CMD=("${DOCKER_CMD[@]}" compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    if [ "${DOCKER_CMD[0]}" = "sudo" ]; then
      COMPOSE_CMD=($SUDO docker-compose)
    else
      COMPOSE_CMD=(docker-compose)
    fi
  else
    die "未检测到 Docker Compose 插件（docker compose）。请安装 docker-compose-plugin 后重试。"
  fi
}

wait_relay_healthy() {
  local tries=30
  local i
  for i in $(seq 1 "$tries"); do
    if "${DOCKER_CMD[@]}" exec allinone-relay node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

build_local_image() {
  info "正在从源码本地构建镜像（tag: ${IMAGE}）..."
  if ! command -v git >/dev/null 2>&1; then
    die "本地构建需要 git，请先安装 git（例如 apt install -y git / yum install -y git）。"
  fi
  local src_dir="${INSTALL_DIR}/src"
  if [ -d "${src_dir}/.git" ]; then
    git -C "$src_dir" pull --ff-only
  else
    rm -rf "$src_dir"
    git clone --depth 1 "$REPO_URL" "$src_dir"
  fi
  "${DOCKER_CMD[@]}" build -f "${src_dir}/deploy/Dockerfile" -t "$IMAGE" "$src_dir"
  ok "本地镜像构建完成：${IMAGE}"
}

prepare_image() {
  if [ "$FORCE_BUILD" = "1" ]; then
    build_local_image
    return 0
  fi

  info "正在拉取预构建镜像：${IMAGE} ..."
  if "${DOCKER_CMD[@]}" pull "$IMAGE"; then
    ok "镜像拉取成功。"
    return 0
  fi

  warn "无法直接拉取 ${IMAGE}（可能网络受限或镜像尚未公开）。"
  if [ "$NONINTERACTIVE" = "1" ] || prompt_confirm "是否自动拉取源码并在本机 Docker 构建镜像？" "y"; then
    build_local_image
  else
    die "已取消。你也可以指定国内镜像地址：ALLINONE_IMAGE=... 或追加 --build 参数本地构建。"
  fi
}

write_compose_with_caddy() {
  cat > "${INSTALL_DIR}/docker-compose.yml" <<'EOF'
services:
  allinone-relay:
    image: ${ALLINONE_IMAGE:-ghcr.io/rainbowlion0320/allinone-relay:latest}
    container_name: allinone-relay
    restart: unless-stopped
    # 自动透传同目录 .env 中的全部配置（JWT_SECRET / PUBLIC_RELAY_URL / ALLOWED_ORIGINS /
    # ADMIN_BOOTSTRAP_TOKEN / ICE_SERVERS / STUN_PORT / TURN_* / CF_TURN_* / SMTP_* / RESEND_*）
    env_file:
      - .env
    environment:
      PORT: 8787
      HOST: 0.0.0.0
      STUN_PORT: ${STUN_PORT:-3478}
    volumes:
      - relay_data:/app/packages/relay-server/data
      # 若启用自建 coturn 按用户配额计量（TURN_LOG_FILE=/var/log/coturn/turn.log），取消下方只读挂载注释：
      # - /var/log/coturn/turn.log:/var/log/coturn/turn.log:ro
    ports:
      - "127.0.0.1:8787:8787"
      # 内置无状态 STUN (RFC 5389)；若同机运行 coturn 占用 UDP 3478，请注释本行并在 .env 中设 STUN_PORT=off
      - "${STUN_HOST_PORT:-3478}:${STUN_HOST_PORT:-3478}/udp"

  caddy:
    image: caddy:2-alpine
    container_name: allinone-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - allinone-relay

volumes:
  relay_data:
  caddy_data:
  caddy_config:
EOF
}

write_compose_relay_only() {
  local port="$1"
  cat > "${INSTALL_DIR}/docker-compose.yml" <<EOF
services:
  allinone-relay:
    image: \${ALLINONE_IMAGE:-ghcr.io/rainbowlion0320/allinone-relay:latest}
    container_name: allinone-relay
    restart: unless-stopped
    # 自动透传同目录 .env 中的全部配置（JWT_SECRET / PUBLIC_RELAY_URL / ALLOWED_ORIGINS /
    # ADMIN_BOOTSTRAP_TOKEN / ICE_SERVERS / STUN_PORT / TURN_* / CF_TURN_* / SMTP_* / RESEND_*）
    env_file:
      - .env
    environment:
      PORT: 8787
      HOST: 0.0.0.0
      STUN_PORT: \${STUN_PORT:-3478}
    volumes:
      - relay_data:/app/packages/relay-server/data
      # 若启用自建 coturn 按用户配额计量（TURN_LOG_FILE=/var/log/coturn/turn.log），取消下方只读挂载注释：
      # - /var/log/coturn/turn.log:/var/log/coturn/turn.log:ro
    ports:
      - "127.0.0.1:${port}:8787"
      # 内置无状态 STUN (RFC 5389)；若同机运行 coturn 占用 UDP 3478，请注释本行并在 .env 中设 STUN_PORT=off
      - "\${STUN_HOST_PORT:-3478}:\${STUN_HOST_PORT:-3478}/udp"

volumes:
  relay_data:
EOF
}

write_caddyfile_domain() {
  local domain="$1"
  cat > "${INSTALL_DIR}/Caddyfile" <<EOF
${domain} {
    encode gzip zstd

    reverse_proxy allinone-relay:8787 {
        flush_interval -1
        header_up X-Real-IP {remote_host}
    }
}
EOF
}

write_caddyfile_ip() {
  local ip="$1"
  cat > "${INSTALL_DIR}/Caddyfile" <<EOF
${ip} {
    tls {
        issuer acme {
            profile shortlived
        }
    }
    encode gzip zstd

    reverse_proxy allinone-relay:8787 {
        flush_interval -1
        header_up X-Real-IP {remote_host}
    }
}
EOF
}

print_banner() {
  printf "\n"
  printf "${C_BLUE}${C_BOLD}==============================================================${C_RESET}\n"
  printf "${C_BOLD}   All in One — 私有化零知识中转服务器一键部署${C_RESET}\n"
  printf "${C_DIM}   Mandatory AES-256-GCM E2EE · Multi-Agent Remote Relay${C_RESET}\n"
  printf "${C_BLUE}${C_BOLD}==============================================================${C_RESET}\n\n"
}

main() {
  print_banner
  setup_docker

  mkdir -p "$INSTALL_DIR"
  local env_file="${INSTALL_DIR}/.env"
  local compose_file="${INSTALL_DIR}/docker-compose.yml"

  # Handle existing installation (Upgrade vs Reconfigure)
  if [ -f "$env_file" ] && [ -f "$compose_file" ]; then
    if [ "$UPGRADE_ONLY" = "1" ]; then
      info "检测到已有部署（${INSTALL_DIR}），执行无损升级..."
    elif can_prompt && [ -z "$MODE" ]; then
      printf "检测到已有部署目录：%s\n" "$INSTALL_DIR"
      printf "  1) 仅拉取最新镜像并无损升级（保留配置、证书与数据）\n"
      printf "  2) 重新配置域名 / IP / 邮箱参数\n"
      local action
      action="$(prompt_input "请选择操作 (1/2)" "1")"
      if [ "$action" = "1" ]; then
        UPGRADE_ONLY=1
      fi
    else
      if [ -z "$MODE" ]; then
        UPGRADE_ONLY=1
      fi
    fi
  fi

  if [ "$UPGRADE_ONLY" = "1" ]; then
    [ -f "$compose_file" ] || die "未找到 ${compose_file}，无法升级；请先运行首次部署。"
    local saved_image
    saved_image="$(read_env_val "$env_file" "ALLINONE_IMAGE")"
    [ -n "$saved_image" ] && IMAGE="$saved_image"
    prepare_image
    (cd "$INSTALL_DIR" && "${COMPOSE_CMD[@]}" --env-file "$env_file" up -d)
    info "等待服务健康检查..."
    wait_relay_healthy || die "服务启动超时，请运行：cd ${INSTALL_DIR} && docker compose logs --tail=50"
    ok "All in One 已无损升级并重启成功！"
    local saved_url
    saved_url="$(read_env_val "$env_file" "PUBLIC_RELAY_URL")"
    [ -n "$saved_url" ] && printf "访问地址：%s\n" "$saved_url"
    exit 0
  fi

  # Step 1: Choose deployment mode
  if [ -z "$MODE" ]; then
    printf "${C_BOLD}步骤 1/3 · 选择部署方式${C_RESET}\n"
    printf "  1) 自有域名 + Caddy 自动申请免费 HTTPS 证书 ${C_GREEN}（推荐）${C_RESET}\n"
    printf "  2) 纯公网 IP + Let's Encrypt 正规 HTTPS 证书 ${C_DIM}（免域名，需开放 80/443）${C_RESET}\n"
    printf "  3) 仅启动中转容器 ${C_DIM}（不占 80/443，适合已有 Nginx / 宝塔 / 1Panel / Cloudflare Tunnel）${C_RESET}\n\n"
    local choice
    choice="$(prompt_input "请输入选项 (1/2/3)" "1")"
    case "$choice" in
      1|domain) MODE="domain" ;;
      2|ip)     MODE="ip" ;;
      3|proxy)  MODE="proxy" ;;
      *)        die "无效选项：$choice" ;;
    esac
  fi

  local existing_url
  existing_url="$(read_env_val "$env_file" "PUBLIC_RELAY_URL")"
  local existing_host=""
  [ -n "$existing_url" ] && existing_host="$(clean_host "$existing_url")"

  case "$MODE" in
    domain)
      if [ -z "$DOMAIN" ]; then
        DOMAIN="$(prompt_input "请输入已解析到本机公网 IP 的域名（如 ai.yourdomain.com）" "$existing_host")"
      fi
      DOMAIN="$(clean_host "$DOMAIN")"
      validate_domain "$DOMAIN" || die "域名格式无效：'${DOMAIN}'（示例：ai.yourdomain.com）"
      PUBLIC_URL="https://${DOMAIN}"
      write_caddyfile_domain "$DOMAIN"
      write_compose_with_caddy
      ;;
    ip)
      if [ -z "$PUBLIC_IP" ]; then
        info "正在自动探测本机公网 IPv4..."
        local detected_ip
        detected_ip="$(detect_public_ip)"
        [ -z "$detected_ip" ] && detected_ip="$existing_host"
        PUBLIC_IP="$(prompt_input "请确认本机公网 IPv4 地址" "$detected_ip")"
      fi
      PUBLIC_IP="$(clean_host "$PUBLIC_IP")"
      validate_ipv4 "$PUBLIC_IP" || die "IPv4 地址格式无效：'${PUBLIC_IP}'"
      PUBLIC_URL="https://${PUBLIC_IP}"
      write_caddyfile_ip "$PUBLIC_IP"
      write_compose_with_caddy
      ;;
    proxy)
      if can_prompt && [ -z "${ALLINONE_PORT:-}" ]; then
        LISTEN_PORT="$(prompt_input "本地监听端口（仅绑定 127.0.0.1）" "$LISTEN_PORT")"
      fi
      printf '%s' "$LISTEN_PORT" | grep -Eq '^[0-9]+$' && [ "$LISTEN_PORT" -ge 1 ] && [ "$LISTEN_PORT" -le 65535 ] \
        || die "端口号无效：'${LISTEN_PORT}'"
      if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL="$(prompt_input "外部访问地址（可选，用于自动生成邀请链接和一键接入脚本，如 https://ai.yourdomain.com）" "$existing_url")"
      fi
      PUBLIC_URL="${PUBLIC_URL%/}"
      write_compose_relay_only "$LISTEN_PORT"
      ;;
    *)
      die "不支持的部署模式：${MODE}（可选：domain | ip | proxy）"
      ;;
  esac

  # Step 2: Generate / preserve JWT_SECRET & optional SMTP
  printf "\n${C_BOLD}步骤 2/3 · 安全密钥与邮箱 2FA（可选）${C_RESET}\n"
  local jwt_secret
  jwt_secret="$(read_env_val "$env_file" "JWT_SECRET")"
  if [ -z "$jwt_secret" ] || [ "${#jwt_secret}" -lt 32 ]; then
    jwt_secret="$(generate_secret)"
    ok "已自动生成 256-bit 强随机 JWT_SECRET。"
  else
    ok "已复用现有 JWT_SECRET（保持旧登录态有效）。"
  fi

  local smtp_host smtp_port smtp_secure smtp_user smtp_pass smtp_from
  smtp_host="$(read_env_val "$env_file" "SMTP_HOST")"
  smtp_port="$(read_env_val "$env_file" "SMTP_PORT")"
  smtp_secure="$(read_env_val "$env_file" "SMTP_SECURE")"
  smtp_user="$(read_env_val "$env_file" "SMTP_USER")"
  smtp_pass="$(read_env_val "$env_file" "SMTP_PASS")"
  smtp_from="$(read_env_val "$env_file" "SMTP_FROM")"

  if prompt_confirm "是否现在配置邮箱 2FA 验证与自助找回密码（QQ / 163 / Gmail SMTP）？" "n"; then
    printf "  1) QQ 邮箱 (smtp.qq.com:465)\n"
    printf "  2) 163 邮箱 (smtp.163.com:465)\n"
    printf "  3) Gmail (smtp.gmail.com:465)\n"
    printf "  4) 自定义 SMTP\n"
    local mail_choice
    mail_choice="$(prompt_input "选择邮箱服务商 (1-4)" "1")"
    case "$mail_choice" in
      1) smtp_host="smtp.qq.com"; smtp_port="465"; smtp_secure="true" ;;
      2) smtp_host="smtp.163.com"; smtp_port="465"; smtp_secure="true" ;;
      3) smtp_host="smtp.gmail.com"; smtp_port="465"; smtp_secure="true" ;;
      *)
        smtp_host="$(prompt_input "SMTP 主机地址" "${smtp_host:-smtp.example.com}")"
        smtp_port="$(prompt_input "SMTP 端口" "${smtp_port:-465}")"
        smtp_secure="$(prompt_input "是否启用 SSL/TLS (true/false)" "${smtp_secure:-true}")"
        ;;
    esac
    smtp_user="$(prompt_input "发信邮箱账号" "$smtp_user")"
    local new_pass
    new_pass="$(prompt_secret "SMTP 授权码 / 应用专用密码（输入不回显）")"
    [ -n "$new_pass" ] && smtp_pass="$new_pass"
    if [ -n "$smtp_user" ]; then
      smtp_from="All in One <${smtp_user}>"
    fi
  fi

  # Write .env with strict 0600 permissions while preserving any existing custom keys
  # (e.g. TURN_*, CF_TURN_*, STUN_PORT, STUN_HOST_PORT, ICE_SERVERS, RESEND_*, ALLOWED_ORIGINS, ADMIN_BOOTSTRAP_TOKEN)
  local custom_env_lines=""
  custom_env_lines="$(collect_custom_env_lines "$env_file")"
  local tmp_env="${env_file}.tmp.$$"
  umask 077
  cat > "$tmp_env" <<EOF
# Generated by All in One install.sh
ALLINONE_IMAGE=${IMAGE}
JWT_SECRET=${jwt_secret}
PUBLIC_RELAY_URL=${PUBLIC_URL}
SMTP_HOST=${smtp_host}
SMTP_PORT=${smtp_port:-465}
SMTP_SECURE=${smtp_secure}
SMTP_USER=${smtp_user}
SMTP_PASS=${smtp_pass}
SMTP_FROM=${smtp_from}
EOF
  if [ -n "$custom_env_lines" ]; then
    {
      printf '\n# Preserved custom settings\n'
      printf '%s\n' "$custom_env_lines"
    } >> "$tmp_env"
  fi
  chmod 600 "$tmp_env"
  mv -f "$tmp_env" "$env_file"
  ok "已写入加密配置文件：${env_file} (权限 600)"
  if [ -n "$custom_env_lines" ]; then
    info "已保留原有 .env 中的自定义配置项（如 TURN_* / CF_TURN_* / STUN_PORT / RESEND_* 等）。"
  fi

  # Step 3: Pull / build image, start services, create first admin invite
  printf "\n${C_BOLD}步骤 3/3 · 拉取镜像并启动服务${C_RESET}\n"
  prepare_image

  info "正在启动容器..."
  (cd "$INSTALL_DIR" && "${COMPOSE_CMD[@]}" --env-file "$env_file" up -d)

  info "等待中转服务健康检查通过..."
  if ! wait_relay_healthy; then
    err "中转服务未在预期时间内就绪，最近日志如下："
    (cd "$INSTALL_DIR" && "${COMPOSE_CMD[@]}" logs --tail=40 allinone-relay) || true
    exit 1
  fi
  ok "中转服务已健康运行！"

  # Auto-create first admin invite code on fresh deployment
  local invite_code=""
  local users_out
  users_out="$("${DOCKER_CMD[@]}" exec allinone-relay node packages/relay-server/src/admin-cli.js users 2>/dev/null || true)"
  if printf '%s' "$users_out" | grep -q "暂无已注册用户"; then
    info "首次部署检测到尚无账号，正在自动生成首个管理员邀请码..."
    local cli_out
    cli_out="$("${DOCKER_CMD[@]}" exec allinone-relay node packages/relay-server/src/admin-cli.js invite create --count 1 --admin --note "owner")"
    invite_code="$(printf '%s' "$cli_out" | grep -Eo 'INV-[A-Z0-9-]+' | head -n 1 || true)"
    (cd "$INSTALL_DIR" && "${COMPOSE_CMD[@]}" --env-file "$env_file" restart allinone-relay >/dev/null)
    wait_relay_healthy || true
  fi

  # Final summary
  local display_url="${PUBLIC_URL:-http://127.0.0.1:${LISTEN_PORT}}"
  printf "\n"
  printf "${C_GREEN}${C_BOLD}==============================================================${C_RESET}\n"
  printf "${C_GREEN}${C_BOLD}   🎉 All in One 私有化中转部署完成！${C_RESET}\n"
  printf "${C_GREEN}${C_BOLD}==============================================================${C_RESET}\n\n"
  printf "  ${C_BOLD}部署目录：${C_RESET}%s\n" "$INSTALL_DIR"
  printf "  ${C_BOLD}服务器地址：${C_RESET}%s\n" "$display_url"
  printf "  ${C_BOLD}监控看板：${C_RESET}%s/admin\n" "$display_url"
  if [ -n "$invite_code" ]; then
    printf "\n  ${C_YELLOW}${C_BOLD}首个管理员邀请码（一次性）：${C_RESET}${C_BOLD}%s${C_RESET}\n" "$invite_code"
    if [ -n "$PUBLIC_URL" ]; then
      printf "  ${C_BOLD}快速注册链接：${C_RESET}%s/?invite=%s\n" "$PUBLIC_URL" "$invite_code"
    fi
  fi

  if [ "$MODE" = "ip" ]; then
    printf "\n  ${C_YELLOW}提示：${C_RESET}Caddy 正在向 Let's Encrypt 申请纯 IP 短周期 HTTPS 证书（约 10~30 秒），\n"
    printf "  请确保云厂商防火墙 / 安全组已放行 TCP 80、TCP 443 以及 UDP 3478（STUN / TURN 穿透）端口。\n"
  elif [ "$MODE" = "domain" ]; then
    printf "\n  ${C_YELLOW}提示：${C_RESET}Caddy 正在为 %s 自动申请 Let's Encrypt HTTPS 证书（约 10~30 秒），\n" "$DOMAIN"
    printf "  请确保 DNS A 记录已指向本机，且防火墙 / 安全组已放行 TCP 80 / 443 与 UDP 3478（STUN / TURN 穿透）。\n"
  elif [ "$MODE" = "proxy" ]; then
    printf "\n  ${C_YELLOW}反向代理配置参考（Nginx）：${C_RESET}\n"
    printf "    location / {\n"
    printf "      proxy_pass http://127.0.0.1:%s;\n" "$LISTEN_PORT"
    printf "      proxy_http_version 1.1;\n"
    printf "      proxy_set_header Upgrade \$http_upgrade;\n"
    printf "      proxy_set_header Connection \"upgrade\";\n"
    printf "      proxy_set_header Host \$host;\n"
    printf "      proxy_set_header X-Real-IP \$remote_addr;\n"
    printf "      proxy_read_timeout 3600s;\n"
    printf "    }\n"
    printf "\n  ${C_YELLOW}提示：${C_RESET}请确保防火墙 / 安全组已放行 UDP 3478 端口（内置 STUN / 可选 TURN 穿透）。\n"
  fi

  printf "\n  ${C_BOLD}常用管理命令：${C_RESET}\n"
  printf "    查看日志：   cd %s && docker compose logs -f\n" "$INSTALL_DIR"
  printf "    一键升级：   curl -fsSL https://raw.githubusercontent.com/RainbowLion0320/AllinOne/main/deploy/install.sh | bash -s -- --upgrade\n"
  printf "    生成新码：   docker exec allinone-relay node packages/relay-server/src/admin-cli.js invite create --count 3\n"
  printf "    停止卸载：   cd %s && docker compose down -v\n\n" "$INSTALL_DIR"
}

main "$@"
