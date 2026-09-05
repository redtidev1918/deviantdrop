# VPS / 服务器部署手册

Cloudflare Workers 的出口 IP 被 DeviantArt 全面封锁（网页 403、官方 API 数据面 500），
因此本 Bot 需要跑在 **DeviantArt 放行的出口**上——通常是住宅网络或部分 VPS。
本文是服务器版（Node）的部署步骤。

## 0. 先花 30 秒检测这台机器的出口

```bash
cd deviantart-telegram-worker && npm install
node scripts/detect-da.mjs <client_id> <client_secret>
```

输出解读：

| 结果 | 含义与做法 |
|---|---|
| `官方 API: deviation=200` | API 数据面放行（推荐）。配置 `CLIENT_ID`/`CLIENT_SECRET` 后部署 |
| `匿名网页: init=200` | 网页路径可用，也可不配官方凭据直接跑（自动回退网页路径） |
| 两条都不通 | 该出口被 DA 封锁（云主机常见），换住宅网络或换一家 VPS 再测 |

> 建议挑机器时先用检测脚本试：住宅宽带、部分小型 VPS 通常放行；
> 大型云（Cloudflare Workers / Fly 等）页面与 API 数据面大概率被拦。
> Fly 实测：页面 403，但官方 API 数据面 200——能跑，只是网页路径用不了。

## 1. 部署

需要 Node.js 18+。

```bash
npm install --omit=dev
export BOT_TOKEN='123456789:replace_me'
export WEBHOOK_SECRET="$(openssl rand -hex 32)"   # 只含字母数字
export CLIENT_ID='你的ClientID'                    # 检测为「官方 API 可用」时填
export CLIENT_SECRET='你的ClientSecret'
export ALLOWED_USER_IDS=''                         # 可选：逗号分隔，限制使用者
node src/main.js                                   # 监听 8080（PORT 可改）
```

常驻推荐 systemd（`/etc/systemd/system/deviantdrop.service`）：

```ini
[Unit]
Description=DeviantDrop Telegram bot
After=network.target

[Service]
WorkingDirectory=/opt/deviantdrop
EnvironmentFile=/opt/deviantdrop/.env
ExecStart=/usr/bin/node src/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`.env` 内容即上面那些 `export` 的键值对（`BOT_TOKEN=…` 每行一个，值不加引号包裹的特殊字符需小心；用 `systemctl daemon-reload && systemctl enable --now deviantdrop` 启动）。

## 2. 让 Telegram 能访问（HTTPS）

Telegram webhook 要求公网 HTTPS。可选：

- **Caddy**（自动 TLS，推荐）：`caddy reverse-proxy --from bot.example.com --to 127.0.0.1:8080`
- 或 Nginx + 自己的证书 / Cloudflare Tunnel 指向本机 8080

不需要反代本身做什么转发以外的逻辑。

## 3. 注册 webhook

```bash
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://bot.example.com/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode 'max_connections=1'
```

注册命令菜单（一次性）：

```bash
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '[{"command":"start","description":"开始使用"},{"command":"help","description":"查看用法"},{"command":"about","description":"项目介绍与源码仓库"}]'
```

## 4. 验证

```bash
curl -fsS https://bot.example.com/                       # → {"ok":true,"service":"deviantdrop"}
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

然后给 @DeviantDropBot 发一条作品页链接实测。

## 已知边界

- `fav.me`/`/view` 旧链与 archive.org 未收录的新作品会收到明确的中文提示（官方 API 路径）。
- 官方 API 每应用有配额；access token 与 UUID 映射会在进程内缓存。
- 只跑网页路径时无需官方凭据，但依赖该出口不被 DA 封禁（检测脚本第一项）。
