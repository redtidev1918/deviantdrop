# VPS / 服务器部署手册

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

## 5. 验证与排错

```bash
docker compose logs -f deviantdrop     # 轮询模式会持续 getUpdates
# 给 @DeviantDropBot 发一条 DA 作品页链接实测
```

常见问题：
- `getUpdates 失败: 401` → BOT_TOKEN 无效。
- 报错「连接失败或超时」→ 代理没生效/机场节点全挂：先
  `curl -x http://127.0.0.1:7890 https://www.gstatic.com/generate_204` 验证代理。
- DA 报 403/500 类错误 → 该出口（或该机场节点）被 DA 拦：换节点/换出口后重试。
- 官方凭据填错 → 「凭据无效」；匿名网页路径仅在出口未被 DA 封禁时可用。
