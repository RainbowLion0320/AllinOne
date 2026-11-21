# All in One · 多端 AI 编程助手手机远程控台

一套仿 **DeepSeek 手机版** 体验的零侵入远程移动控台（PWA + Capacitor 热更新原生壳 + 自建多租户中转服务器 + PC 桥接器），让你随时随地用手机原生续聊本机 **DeepSeek Harness / Codex / Claude Code / Antigravity** 全部对话。

### 核心特性

- **零侵入纯桥接 · 0 额外 Token 消耗**：不改写提示词、不注入冗余工具，原生复用各客户端本地会话数据库与服务端 Prompt Cache，电脑与手机无缝切换续聊。
- **4 大主流工具统一原生接入**：
  | 应用 | 官方协议接入 | 核心能力 |
  | :--- | :--- | :--- |
  | **DeepSeek Harness** | 原生 Cordis 插件 (`dsh-mobile-hub`) | 全量读写会话、模型与推理强度切换、流式输出、中断 |
  | **Codex** | 官方 `codex app-server --stdio`（读写分离双进程） | 全量读写、每轮自动释放写入锁（不与桌面端冲突）、远程审批 |
  | **Claude Code** | 官方 `claude -p --resume --output-format stream-json` | 全量读写 `~/.claude/projects/` 本地会话、模型切换、中断 |
  | **Antigravity** | 官方 `agy acp --app-data-dir antigravity` 热保活会话池 | 与桌面端共享原生会话与缓存、支持长耗时后台任务与自动回调推送 |
- **多租户房间隔离 + 1 行命令傻瓜分享**：支持多人共享同一台自建中转服务器，每位用户的电脑自动注册独立加密隔离房间（哈希落盘、跨房完全不可见），本地离线生成二维码与 8 位一次性配对码，扫码 3 秒直连。
- **一机控多电脑 · 独立配对一键切换**：一台手机可独立配对并保存多台电脑（各自独立加密房间与隔离本地缓存），随时查看各电脑实时在线状态、自定义备注名（如“公司 Mac / 家里台式机”）并一键切换，同时兼容同房间多 Bridge 严格路由。
- **移动端深度优化**：按项目/时间分组、增量下滑翻页 + IndexedDB 手机缓存（带容量上限与一键清理）、本机截图安全代理预览与双指缩放、一键刷新热更新。

---

## 一、项目结构

```text
AllinOne/
├── packages/
│   ├── shared/          # 统一通信协议与事件定义
│   ├── relay-server/    # 自建中转网关（HTTPS/WSS + 多租户房间隔离 + 静态托管 + 附件与图片代理）
│   ├── dsh-mobile-hub/  # PC 端桥接器（支持 DSH Cordis 插件 / 独立运行 / 单文件便携 CLI）
│   └── mobile-app/      # 手机端前端（React + Tailwind + PWA + Capacitor 原生壳）
├── deploy/              # Dockerfile / docker-compose.yml / Caddyfile / nginx.conf
└── scripts/             # 单文件桥接打包器 (build-portable-bridge.mjs) 与端到端冒烟测试 (smoke-test.mjs)
```

---

## 二、本地快速联调（3 分钟跑通）

```bash
# 1. 安装依赖
npm install

# 2. 打包单文件 PC 桥接器 + 手机端前端
npm run build

# 3. 启动中转服务器（默认 http://127.0.0.1:8787，开发默认密钥 allinone-dev-pass）
npm run start:relay

# 4. 新开终端启动本地桥接
npm run dev:bridge
```

打开浏览器访问 `http://127.0.0.1:8787`（可用 F12 切到手机视图），切到「管理员密码」输入 `allinone-dev-pass` 即可立即体验。

---

## 三、部署到自己的 Linux 服务器（推荐 Docker + Caddy）

```bash
# 1. 拉取代码到你的服务器
git clone <YOUR_REPO_URL> AllinOne
cd AllinOne

# 2. 将 deploy/Caddyfile 中的 ai.yourdomain.com 改为你的真实域名

# 3. 创建 deploy/.env（务必设置高强度随机密钥，切勿提交到 Git）
cat > deploy/.env <<'EOF'
CLIENT_ACCESS_TOKEN=设置一个高强度手机登录密码
BRIDGE_SECRET=设置一个高强度PC桥接密钥
PUBLIC_RELAY_URL=https://ai.yourdomain.com
EOF

# 4. 一键构建并启动
cd deploy
docker compose --env-file .env up -d --build
```

> 提示：本地构建专属 APK / 单文件桥接器时，可在仓库根目录创建 `.env.local`（已被 `.gitignore` 忽略）：
> ```env
> PUBLIC_RELAY_URL=https://ai.yourdomain.com
> VITE_RELAY_URL=https://ai.yourdomain.com
> ```

---

## 四、电脑端连接方式

### 方式 A：1 行傻瓜命令（Windows / macOS / Linux 通用，适合朋友快速使用）

无需 `git clone` 或 `npm install`，自动申请独立隔离房间并在浏览器打开本地离线二维码与 8 位配对码：

- **Windows (PowerShell)**：
  ```powershell
  irm https://ai.yourdomain.com/setup.ps1 | iex
  ```
- **macOS / Linux**：
  ```bash
  curl -fsSL https://ai.yourdomain.com/setup.sh | bash
  ```

### 方式 B：作为插件挂载到 DeepSeek Harness Desktop（开启全量 DSH 读写）

1. 将本机桥接密钥写入独立文件（不进 Git）：
   ```powershell
   New-Item -ItemType Directory -Force "$HOME/.dsh/secrets" | Out-Null
   Set-Content -NoNewline "$HOME/.dsh/secrets/allinone-bridge-secret.txt" "替换成你的BRIDGE_SECRET"
   ```
2. 复制 `packages/dsh-mobile-hub/cordis.patch.example.yml` 为 `packages/dsh-mobile-hub/cordis.patch.yml`（已被 `.gitignore` 忽略），填入你的 `relayUrl` 与 `secretFile`。
3. 在 `<USER_HOME>/.dsh/profiles/desktop/package.json` 的 `dependencies` 中链接 `dsh-mobile-hub` 并加入 `dsh.profile.bundles`，重启 DeepSeek Harness Desktop 即可生效。

---

## 五、安装到手机

- **PWA 免安装（推荐）**：用手机浏览器打开 `https://ai.yourdomain.com`（或直接扫码电脑弹出的配对二维码）→「添加到主屏幕」。
- **Capacitor 原生 Android / iOS 壳**：将 `packages/mobile-app/capacitor.config.json` 中的 `server.url` 改为你的真实服务器地址后执行：
  ```bash
  cd packages/mobile-app
  npm run build
  npx cap sync android
  npx cap open android
  ```

---

## 六、端到端测试

```bash
npm run test:smoke
```
覆盖中转服鉴权、4 大应用状态与模型列表、会话分页读取、本地图片安全代理、以及多租户房间严格隔离验证。
