# 认证、预览和可选 Telegraph 发布

## 首次配置与登录

### 有公网域名（推荐，启用 Telegram 内 `/login` 与预览页）

1. 将域名解析到 VPS，配置 HTTPS 反向代理到 `127.0.0.1:8080`。应用默认仅监听本机；无需公开原始 HTTP 端口。
2. 设置 `PUBLIC_BASE_URL=https://bot.example.com`、`CLIENT_ID`、`CLIENT_SECRET`、`ADMIN_IDS`（Telegram 用户 ID）。未指定管理员且用户白名单为空时，管理命令全部拒绝；不要把普通使用者当作管理员。
3. 在 DeviantArt 应用的 redirect whitelist 加入完整的 `https://bot.example.com/auth/deviantart/callback`。
4. 初次环境配置需重建容器；之后管理员在 **Bot 私聊**发送 `/login`，打开 5 分钟一次性链接，在 DeviantArt 官方站授权。
5. 回调校验 state、浏览器会话、PKCE；保存成功后立即生效，并发一次恢复通知。落盘失败不会显示成功。OAuth 协议见 [官方认证文档](https://deviantart.readme.io/docs/authentication)。

### 只有公网 IP、没有域名（ssh 隧道登录）

DA 应用回调白名单已含 `http://127.0.0.1:8787/callback`（OAuth 对 localhost 允许 http），因此**无需**为登录开放任何公网端口、无需域名：

1. 确保 VPS 上 `.env` 有 `CLIENT_ID`/`CLIENT_SECRET`（凭据在容器里，脚本从 `.env` 读取）。
2. 两个终端：
   ```bash
   # 终端 1：保持打开，建立隧道（把 VPS 的 8787 映射到本机 8787）
   ssh -L 8787:127.0.0.1:8787 root@<VPS-IP>
   # 终端 2：在 VPS 上启动登录服务（10 分钟内有效）
   ssh root@<VPS-IP> 'cd /opt/deviantdrop && ./scripts/vps-login.sh'
   ```
3. 本机浏览器打开 `http://127.0.0.1:8787` → 自动跳到 DeviantArt 授权页 → 授权后重定向回 `127.0.0.1:8787/callback`（经隧道到达 VPS 的登录服务）→ refresh token 原子写入 `deviantdrop_cache` 卷的 `/data/auth/deviantart.json`，脚本自动 `chown 1000:1000` 并 `docker compose restart`，约 30 秒生效。
4. 浏览器需能访问 deviantart.com（国内网络请给浏览器配代理）；授权页在 DeviantArt 官方站完成，应用不代替你登录。

两种方式写的是同一份 `/data/auth/deviantart.json`，之后的轮换/失效处理完全一致。没有公网域名时 `/login` 内按钮与 `/d/:id` 预览页不启用（属可选功能），其余发送功能不受影响。

应用不能代替你在 DeviantArt 完成登录或同意授权。OAuth 也不能取得浏览器 Cookie。

反向代理应关闭 `/auth/` 的带 query access log，避免记录一次性 token/code；可用 `access_log off` 作用于该路径。本站认证响应 `no-store`、`no-referrer`，禁止 iframe。

## Cookie 兼容与热更新

管理员私聊 `/cookies`，打开 5 分钟一次性管理链接，把自己浏览器的 `auth=...; auth_secure=...; userinfo=...` 填入表单并保存。提交校验 Origin 和一次性表单 token，Cookie 不经 Telegram 消息传递；保存为 0600 文件，无需 SSH/SCP 或重启。

也可由受信任运维程序原子替换 Cookie JSON；读取时检查文件变化，新 session 按 Cookie 指纹隔离，旧 session 不会覆盖新 Cookie。明确 401/登录跳转才判定 Cookie 失效；403 或打码可能是权限/限额/出口问题，不会武断地清空 Cookie。失效通知按 OAuth/Cookie 分开冷却 6 小时。

不会反向代理 DeviantArt 登录页，不安装 Playwright/Chromium。OAuth 与 Cookie 独立，更新 OAuth 不代表 Cookie 已恢复。

## 持久化与迁移

| 路径 | 内容 |
| --- | --- |
| `/data/auth/deviantart.json` | 当前 refresh token、状态和更新时间；原子写入，0600 |
| `/data/auth/deviantart-cookies.json` | 当前 Cookie；原子写入，0600 |
| `/data/cache.json` | file_id、限流、通知冷却、preview metadata、Telegraph URL |

复用已有 Docker `cache:/data` 卷，无需创建新的卷。禁止删除卷进行升级。升级前备份整个卷。

access token 和 DA 网页 session 只放内存，旧通用缓存中的 token/session 会在启动时清理。refresh token 刷新串行，避免同时兑换同一个轮换凭据。首次迁移优先旧 `/data/refresh_token`（兼容 `REFRESH_TOKEN_FILE`），再用 `DA_REFRESH_TOKEN`；已有 store 后绝不回退 env。文件损坏视为失效，重新登录；明确 invalid_grant 会清空 token。写盘失败会报错，不假报保存成功。

`DA_COOKIES`、`DA_REFRESH_TOKEN` 兼容为首次 seed；后续更新请使用管理入口。`npm run login` 仅作本地开发辅助，写入本地 CredentialStore，不打印 token，也不自动上传 VPS。

## Preview Fixer

`/d/:id` 提供标题、作者、canonical 原站入口和 OG metadata；正常 Bot 解析顺手记住作品 ID 与来源。Crawler 首次访问补一次匿名 [oEmbed](https://deviantart.readme.io/docs/oembed)，元数据缓存一小时。未知 ID 只做有限的原站 canonical 解析。失败短缓存，避免每次爬取反复请求 DA。

`/d/:id/image` 只代理该 metadata 对应的公开缩略图；不接受任意上游 URL，不要求 Cookie/Referer。CDN 只允许 HTTPS DeviantArt/Wix 域名，每次重定向前校验，阻止重定向 SSRF。网页标题/作者 HTML 转义。

没有公开缩略图时仅提供文字与原站入口，不公开账号才能查看的原图。DA 拒绝匿名 oEmbed 时，本站无法保证图文预览；主 Telegram 媒体发送仍保留。该页面不是作品镜像站。

## Telegram 排版与 TelePress

所有原生媒体使用统一 caption；来源是 `caption_entities/text_link`，长标题截断也保留链接。压缩/预览/文档状态保留到 file_id 回放。单媒体有原站按钮；相册首图有来源 entity，不为单独放原站按钮额外发消息。11 张等尾部单图使用 sendPhoto，sendMediaGroup 始终为 2–10 项。

`TELEPRESS_URL` 未设置时无额外依赖。设置后默认 `TELEPRESS_MODE=fallback`；`large-gallery` 为纯图片 >10 张生成可选图集，`always` 仅明确选择时使用，`off` 完全关闭。视频/GIF 不转 Telegraph。缓存同作品 URL 90 天，重复使用，不反复创建页面。额外 Telegraph 入口才发送按钮消息；配置了公网预览域名时该消息的 link_preview_options 指向本站。

TelePress 发起失败不会影响原生 Telegram 成功结果；Telegram 失败且 TelePress 成功时提供图集入口。可选发布当前限制 50 张/合计 50 MiB，超出跳过可选发布，继续原链路。可选发布需要再下载图片；尚未改成跨服务流式中转。

TelePress 端点是 `POST /publish/gallery`，重复 `files` multipart + title/link，返回 url。两端配置同一个 `TELEPRESS_API_KEY`（Bearer）。服务只绑定回环/内部网络，不能把未设 key 的发布接口直接暴露公网。没有服务 URL、图片托管配置和有效 Telegraph 凭据时，本轮不会代建在线图集。

## 配置变化与模块

新增/完善：`PUBLIC_BASE_URL`、`HTTP_HOST`、`ADMIN_IDS`、`AUTH_DIR`、`TELEPRESS_URL`、`TELEPRESS_API_KEY`、`TELEPRESS_MODE`。保留 `MODE=poll|webhook`、代理、Cookie/OAuth seed 和现有缓存目录配置。`SERVER` 必须显式设置，仓库不再带实际部署地址默认值。

```text
src/
  main.js                  # 生命周期与依赖装配
  index.js                 # 原有 Bot / DA 流程，逐步保留而非重写
  http-server.js           # 流式 HTTP 与请求体上限
  network.js               # 原生 fetch、代理与连接失败回退
  auth/
    atomic-json.js
    credential-store.js
    cookie-store.js
    token.js               # 内存 access token / 串行 refresh
    oauth-login.js
    http-auth.js
    auth-notifier.js
    errors.js
  preview/server.js        # OG、匿名 metadata 与安全媒体代理
  publishing/
    telepress.js
    gallery.js             # 可选策略与发送流程接线
  rendering/caption.js
  storage/cache.js         # 持久缓存，排除凭据
```

具体原实现问题见 [审查记录](FEATURE_AUDIT.md)。验证运行 `npm run check`；测试涵盖真实 HTTP multipart、poll + HTTP、凭据轮换/损坏/热更新、OAuth state/过期/失败、caption/相册、preview/SSRF、TelePress 策略与失败隔离。部署成功不等于用户 OAuth 授权完成；两者分别验收。
