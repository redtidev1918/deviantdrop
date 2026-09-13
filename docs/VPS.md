# VPS / 服务器部署手册

**语言 / Language:** 中文 · [English](/en/VPS.md)

Cloudflare Workers 的出口被 DeviantArt 全面封锁，因此 Bot 跑在普通服务器上。
本手册面向**国内服务器**（实测阿里云直连 deviantart.com 不可达），要点：
出口必须走代理（clash/mihomo），且代理出口（机场）需要能被 DeviantArt 放行。

> 2026-09 实测结论：阿里云直连 DA 超时（被墙）；经机场（HK）出口 DA 官方 API
> 数据面与网页均为 200。Cloudflare Workers/Fly 出口则被 DA 按数据中心 IP 拦截。

## 0. 30 秒检测你的出口可用性

```bash
cd deviantart-telegram-worker && npm install --omit=dev
node scripts/detect-da.mjs <client_id> <client_secret>
```

直连不通（国内被墙）就先用代理再测；机场出口下官方 API 数据面通常 200。

## 1. 国内网络代理（clash/mihomo）

服务器已有系统级 clash（`/usr/local/bin/clash -d /etc/mihomo`，systemd 托管，
mixed-port 7890 绑定 127.0.0.1）时的日常操作：

- **订阅热更新**（不重启、不掉连接）：

  ```bash
  SUB_URL="https://你的机场/订阅" ./scripts/refresh-clash.sh
  ```

  若机场接口在该服务器上拉不到（403/Backend Timeout），就在能拉到的机器上拉好再传：
  `scp sub.yaml root@服务器:/tmp/ && scp 后 ssh 里 cp 覆盖 /etc/mihomo/config.yaml && systemctl restart clash`。
- **WebUI（本地浏览器访问，不开公网端口）**：把 9090 经 SSH 隧道映射到本机：

  ```bash
  ssh -L 9090:127.0.0.1:9090 root@服务器
  # 浏览器打开 http://127.0.0.1:9090/ui （mihomo 需配置 external-ui，见 scripts/setup-clash-webui.sh）
  ```

  不装 WebUI 也可以直接查/切节点：`curl http://127.0.0.1:9090/proxies`、
  `curl -X PUT "http://127.0.0.1:9090/proxies/%F0%9F%8E%AF%20%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9/delay?timeout=4000&url=http://www.gstatic.com/generate_204"`。

## 2. 部署（推荐 docker compose）

```bash
cp .env.example .env        # 填入 BOT_TOKEN / WEBHOOK_SECRET / CLIENT_ID / CLIENT_SECRET
# 国内出口必须让 Bot 走代理：
#   HTTP_PROXY=http://127.0.0.1:7890  HTTPS_PROXY=http://127.0.0.1:7890  （compose 用 network_mode: host 直连）
docker compose up -d --build
docker compose logs -f deviantdrop
```

也可以不装 docker，直接：

```bash
export BOT_TOKEN=... WEBHOOK_SECRET=... CLIENT_ID=... CLIENT_SECRET=...
export MODE=poll HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890
node src/main.js            # 默认 MODE=poll：getUpdates 长轮询，无需公网入口
```

## 3. 接入方式：轮询 or Webhook

- **`MODE=poll`（默认，推荐国内服务器）**：主动向 Telegram 拉消息，不需要公网
  HTTPS、域名或证书；本机也无须开任何入站端口。媒体直接以（带 token 的）CDN URL
  交给 Telegram 下载。
- **`MODE=webhook`**：Bot 起 HTTP 服务，需要公网 HTTPS 反代（Caddy/Nginx/CF Tunnel）
  指向 `127.0.0.1:8080`，并注册 webhook：

  ```bash
  curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
    --data-urlencode "url=https://bot.example.com/webhook" \
    --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message"]'
  ```

> 二选一即可，别同时开。切换轮询↔webhook 前先 `deleteWebhook` 或停掉轮询进程。

## 4. 命令菜单（一次性）

```bash
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '[{"command":"start","description":"开始使用"},{"command":"help","description":"查看用法"},{"command":"about","description":"项目介绍与源码仓库"}]'
```

## 4.5 一键登录（OAuth + 网页扩展会话）

登录一次，Bot 同时拿到 DeviantArt 官方 API 授权（OAuth，内容访问主认证层）和网页扩展会话
（Cookie，只用于官方 API 不提供的多图附加页）。成熟作品的主图靠 OAuth 就能未打码发送；
网页扩展会话失效只影响部分多图作品的附加页，不会让成熟作品整体失败。两者都在服务器立即
生效，无需手动复制 Cookie、无需重启。

在**你自己的电脑**上（需装 Chrome/Edge、能访问 deviantart.com），进入 DeviantDrop 目录：

```bash
VPS=root@<你的服务器> npm run login     # 等价于 node scripts/dd-login.mjs
```

脚本自动打开 Chrome 进入 DeviantArt 官方登录页 → 你登录并点「Authorize/允许」→ 页面显示
「登录成功」。脚本经 Chrome DevTools Protocol 同时捕获 OAuth 授权码与网页登录 Cookie，
经 ssh 推送到服务器、在容器内兑换并热落盘 `/data/auth/`。完成后 Telegram 私聊 `/status`
应显示 `OAuth API: ✅ valid`、`Multi-image web expansion: ✅ valid`。

> 为什么浏览器跑在你电脑上、而不是服务器：DA 登录页的 AWS WAF 人机校验令牌绑定浏览器自身
> 环境（`detectIp`/`validateHostname`），真实浏览器在真实 DA 域登录天然通过；服务器反代登录页
> 或服务器端无头浏览器都会被拦，且低内存 VPS 不适合跑 Chromium。脚本零新增 npm 依赖
> （Node ≥22 自带 WebSocket/fetch）。链路：本机 `dd-login.mjs` → ssh → VPS 宿主
> `scripts/dd-receive.sh` → 容器内 `dd-exchange.mjs`（以 node 用户写 `/data/auth`）。

## 4.6 登录 DeviantArt（有公网域名时的 Telegram 内按钮）

配置 `PUBLIC_BASE_URL`（HTTPS 域名反代到 `127.0.0.1:8080`），把 `<域名>/auth/deviantart/callback`
加进 DA 应用白名单，然后在 Bot 私聊发 `/login` 点按钮授权，秒级生效、无需重启。

注意：Telegram 内按钮走的是纯 OAuth，**只建立账号授权，不含网页 Cookie**——想让成熟作品的
附加页也未打码，请用 4.5 的电脑一键登录（它同时登录网页）。细节见 [docs/AUTH_AND_PREVIEW.md](AUTH_AND_PREVIEW.md)。

### 首次部署用 `.env` seed（一次性）

没有执行上面任一流程前，可把已有 refresh token 写进 `.env` 的 `DA_REFRESH_TOKEN` 作为首次迁移来源；
容器首次启动会把它落盘到 `/data/auth/deviantart.json`，之后不再读回 `.env`。

> 原图下载仍受 DeviantArt 免费账号每日额度限制；登录解决的是“登录态 / 打码”，不是额度。

## 4.7 推送即部署（可选）

在 GitHub 仓库 Settings → Secrets and variables → Actions 里添加三个 secret：

- `VPS_HOST` = `your-server.example`
- `VPS_USER` = `root`
- `VPS_SSH_KEY` = 部署用私钥内容（推荐单独生成一把）

生成专用部署密钥（在能访问 VPS 的机器上）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/deviantdrop_deploy -N ""
ssh-copy-id -i ~/.ssh/deviantdrop_deploy.pub root@your-server.example
cat ~/.ssh/deviantdrop_deploy        # 内容贴进 VPS_SSH_KEY
```

之后 main 上的 `src/`、`scripts/`、`package*.json`、`Dockerfile`、`docker-compose.yml` 任一变化，GitHub Actions 会自动 `git pull + docker compose up -d --build`，无需手动部署。

## 5. 验证与排错

```bash
docker compose logs -f deviantdrop     # 轮询模式会持续 getUpdates
# 给 @DeviantDropBot 发一条 DA 作品页链接实测
```

常见问题：
- `getUpdates 失败: 401` → BOT_TOKEN 无效或被吊销。见下面「降级模式」：服务不会退出，
  `/health` 会直接说明原因。

### 降级模式与故障域（2026-09 生产故障后固化）

以前的实现里 `getUpdates` 收到 401 就 `process.exit(1)`，配合 compose 的
`restart: unless-stopped` 会变成无限重启循环（实测 1144 次重启），期间 `/health` 也
恒返回 `{ok:true}`，无法判断到底哪一环坏了。现在入口链路按故障域隔离：

```text
telegram_ingress  取更新（poll/webhook）—— 关键域
telegram_auth     Bot 凭据是否被接受 —— 关键域
telegram_bot      启动时 getMe 读回的 Bot 身份 —— 信息
deviantart_auth   DA 抓取/登录 —— 非关键域，失败绝不影响 /start 等命令回复
http_server       /health 是否在监听 —— 关键域
```

规则：

- **关键域失败不会让进程退出。** 401 会退避重试（5s→10s→20s→40s→60s 封顶），
  进程保持存活，`/health` 保持可读，方便直接看到原因。
- **非关键域失败不影响命令回复。** `/start`、`/help`、非法文本提示、`/health` 都不依赖
  DeviantArt 登录状态。
- **`/health` 说真话。** 返回 `status: ok|degraded`、`degraded: [...域]`、
  `components` 各域状态、`counters` 计数，以及最近 40 条结构化事件。

排障先看一条命令：

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool
docker compose logs deviantdrop | grep '\[evt\]' | tail -40
```

事件日志每个阶段一行 JSON，字段固定，`docker logs | grep '\[evt\]'` 即可区分：

```text
runtime_started             进程启动（含版本、mode、哪些变量已配置；不含任何 secret）
telegram_webhook_state      poll 启动时读回 webhook 状态
telegram_webhook_cleared    poll 模式摘掉残留 webhook（否则 getUpdates 会 409）
telegram_ingress_unauthorized / _conflict / _error
update_received             update 真的从 Telegram 到达了入口
update_accepted             / update_rejected（带 reason）/ update_failed
da_fetch_started / da_fetch_ok / da_fetch_failed
tg_send_started / tg_send_ok / tg_send_failed / tg_send_rejected
```

所有字段写出前经过统一脱敏（token / cookie / secret 命名的键与 token 形态的值都会被替换），
所以日志可以直接贴进 issue。**任何 secret 都不允许写进日志。**

### poll 与 webhook 互斥

`MODE=poll` 时服务启动会先 `getWebhookInfo`，若存在残留 webhook 就显式 `deleteWebhook`
（`drop_pending_updates: false`，不丢更新）。残留 webhook 与「另起一个 poller」都会让
`getUpdates` 返回 409，表现同样是「Bot 完全不回复」。`MODE=webhook` 时反过来只读回状态，
绝不改动 webhook（webhook 只能由 `MODE=webhook` 的实例负责）。

### Bot Token 被吊销后如何恢复（运行时热更新，不需要重启）

Token 被吊销（`getMe` 返回 401）时服务进入降级模式并持续重试。此时**必须重新签发 token**：
在 Telegram 里找 @BotFather → `/mybots` → 选该 Bot → API Token → 重新生成。

拿到新 token 后，在 VPS 上**一条命令**完成恢复——不重启容器、不改 `.env`：

```bash
cd /opt/deviantdrop && ./scripts/set-telegram-token.sh
# 隐藏输入新 token（不回显、不进 shell 历史、不进 argv）
```

等 1~2 秒，`/health` 会自己从 `degraded` 变 `ok`：

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool | head -20
```

运行中发生的事情（每一步都有 `[evt]` 事件与计数器，日志里不会出现 token）：

```text
secret_reload_detected     发现运行时 secret 文件变化
secret_reload_validating   用 getMe 验证候选 token
secret_reload_applied      验证通过 → 提交 → 只重建 Telegram 入口
telegram_credential_swapped / telegram_ingress_restarted / telegram_auth_recovered
```

**Token 的第一事实来源是文件，不是 `.env`**：

```text
/data/secrets/telegram-bot-token   （目录 0700，文件 0600）
    >  BOT_TOKEN 环境变量（仅首次 bootstrap / fallback）
```

- 文件存在就用文件；不存在才用 `.env` 里的 `BOT_TOKEN`；
- 路径可用 `BOT_TOKEN_FILE` 覆盖（默认 `/data/secrets/telegram-bot-token`）；
- **绝不监听 `.env`**：`.env` 是部署层输入，容器环境变量也无法在运行时修改；
- 第一次使用 `set-telegram-token.sh` 后，来源会自动从 `env` 迁移到 `file`，
  之后 `.env` 里的旧 `BOT_TOKEN` 就不再被读取。

`/health` 里的 `runtime_secrets.telegram_bot_token` 会说明来源与状态（**只有元数据，没有值**）：

```json
{"source": "file", "reloadable": true, "state": "loaded",
 "last_reload": "2026-09-13T07:00:09.402Z", "last_validation": "ok",
 "bot_id": 123456, "bot_username": "your_bot"}
```

#### 安全与失败语义

- **写错了 token 不会弄坏现有凭据**：候选值必须先通过 `getMe`，失败则保留当前值，
  `/health` 保持 `ok`，只记 `secret_reload_rejected`；
- **网络问题不算 token 错**：429 / 5xx / 超时 / DNS 一律记 `secret_reload_deferred`
  并退避重试同一个候选值，不会因为一次抖动把正确的新 token 判死；
- **删掉 secret 文件不等于撤销凭据**：继续使用最后一次已验证的 token，
  只把 `source` 标成 `stale`（要真正撤销请在 BotFather 里吊销）；
- **热更新永远不会让进程退出**：文件损坏、权限错误、目录顶替文件、Telegram 超时
  都只是可恢复事件，不会 `process.exit()`，更不会造成重启循环。

#### 仍然保留的兜底路径

如果连 `/health` 都读不到（例如容器根本起不来），退回原来的 `.env` + 重建容器：

```bash
read -rs NEW_TOKEN
sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=${NEW_TOKEN}|" /opt/deviantdrop/.env
unset NEW_TOKEN
cd /opt/deviantdrop && docker compose up -d --force-recreate
```

`.env` 只放在 VPS 上、权限 0600，绝不提交进仓库：**历史上正是一次 token 被提交到公开仓库
导致凭据泄露并被利用**，泄露过的 token 一律视为已吊销，不要尝试复用。

- 报错「连接失败或超时」→ 代理没生效/机场节点全挂：先
  `curl -x http://127.0.0.1:7890 https://www.gstatic.com/generate_204` 验证代理。
- DA 报 403/500 类错误 → 该出口（或该机场节点）被 DA 拦：换节点/换出口后重试。
- 官方凭据填错 → 「凭据无效」；匿名网页路径仅在出口未被 DA 封禁时可用。

### 上传与群聊诊断

- Node 原生 `fetch` 与原生 `FormData` 必须配套使用；代理通过 `dispatcher` 指定。混用独立版本的 `undici.fetch` 可能发送纯文本 `[object FormData]`，导致 Telegram 报缺少 photo/media。
- 相册必须使用 `sendMediaGroup`；给多条 `sendPhoto` 添加 `media_group_id` 不会合并成相册。
- 群话题回复保留 `message_thread_id`，频道的 `channel_post` 同样处理。设置了 `ALLOWED_USER_IDS` 时仍按发送者用户 ID 授权，匿名管理员/频道身份不能冒充获准用户。
- **群里收不到普通链接**：先确认 Bot 的「群组隐私模式」已在 BotFather 关闭（`/mybots` → Bot Settings → Group Privacy → Turn off），再把 Bot 移出群重新拉回或设为管理员。隐私模式开着时 Telegram 不向 Bot 投递群里的非命令消息，`getMe` 的 `can_read_all_group_messages` 会是 `false`。
- 群聊/频道默认隐藏技术性 ⚠️ 状态提示（`CAPTION_NOTES=auto`）；要在所有聊天都显示设 `CAPTION_NOTES=always`，全关设 `never`。
- 日志没有对应 `[upd]` 时检查 Telegram 投递及是否有其他轮询实例；有 `[upd]` 时检查发送权限与错误日志。不能仅凭 `/about` 到达就认定普通链接也已投递。
- `npm test` 包含本地真实 HTTP multipart 序列化和轮询相册测试，不会向真实 Telegram 聊天发送消息。

Docker Compose 使用独立的 `cache` 卷保存 file_id 缓存，更新容器不会清空。旧部署如有 `/tmp/deviantdrop-cache.json`，升级前备份并迁移到卷内 `/data/cache.json`；不要运行 `docker compose down -v`，该命令会删除缓存卷。
