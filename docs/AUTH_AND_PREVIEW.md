# 认证、预览和可选 Telegraph 发布

## 首次配置与登录

### 有公网域名（推荐，启用 Telegram 内 `/login` 与预览页）

1. 将域名解析到 VPS，配置 HTTPS 反向代理到 `127.0.0.1:8080`。应用默认仅监听本机；无需公开原始 HTTP 端口。
2. 设置 `PUBLIC_BASE_URL=https://bot.example.com`、`CLIENT_ID`、`CLIENT_SECRET`、`ADMIN_IDS`（Telegram 用户 ID）。未指定管理员且用户白名单为空时，管理命令全部拒绝；不要把普通使用者当作管理员。
3. 在 DeviantArt 应用的 redirect whitelist 加入完整的 `https://bot.example.com/auth/deviantart/callback`。
4. 初次环境配置需重建容器；之后管理员在 **Bot 私聊**发送 `/login`，打开 5 分钟一次性链接，在 DeviantArt 官方站授权。
5. 回调校验 state、浏览器会话、PKCE；保存成功后立即生效，并发一次恢复通知。落盘失败不会显示成功。OAuth 协议见 [官方认证文档](https://deviantart.readme.io/docs/authentication)。

### 只有公网 IP、没有域名（电脑一键登录，推荐）

无需开放任何公网端口、无需域名、无需手动复制 Cookie、无需重启。DA 应用回调白名单已含 `http://127.0.0.1:8787/callback`。在**你自己的电脑**上（需装有 Chrome/Edge，能访问 deviantart.com），于 DeviantDrop 目录运行：

```bash
VPS=root@<VPS-IP> npm run login        # 等价于 node scripts/dd-login.mjs
```

脚本用 Chrome DevTools Protocol 驱动本机 Chrome：打开 DeviantArt 官方登录页，你登录并点「Authorize/允许」后，脚本在网络层同时捕获 ① OAuth 授权回调的 `code` 和 ② 网页登录 Cookie（`auth/auth_secure/userinfo`），经 ssh 推送到服务器，由 `scripts/dd-exchange.mjs` 用 `CLIENT_SECRET` 换 refresh token 并把 OAuth + Cookie 一起原子落盘，**立即热生效**。

为什么在你电脑上跑浏览器而不是服务器：DA 登录页有 AWS WAF 人机校验（`detectIp`/`validateHostname`），令牌绑定浏览器自身环境；真实浏览器在**真实 DA 域**登录天然通过，而服务器反代登录页或服务器端无头浏览器都会被 WAF 拦、且低内存 VPS 不适合跑 Chromium。脚本零新增依赖（Node ≥22 自带 WebSocket/fetch），浏览器 profile 持久化在 `~/.config/deviantdrop/chrome-login-profile`，登录过 DA 后下次可免登录。

- 链路：`dd-login.mjs`（本机）→ ssh → `scripts/dd-receive.sh`（VPS 宿主）→ `docker cp` + `dd-exchange.mjs`（容器内，以 node 用户写 `/data/auth`）。
- 失败不污染凭据：兑换失败（如 code 过期）直接报错退出，不覆盖现有 token/Cookie。

有公网域名时 `/login` 内按钮仅建立 OAuth；想让成熟作品的**附加页**也未打码，仍需网页登录态，请用上面的电脑一键登录。两种方式写的是同一份 `/data/auth/deviantart.json` 与 `deviantart-cookies.json`，轮换/失效处理一致。

应用不能代替你在 DeviantArt 完成登录或同意授权——浏览器始终在真实 DA 站点完成登录，脚本只读取登录结果。

反向代理应关闭 `/auth/` 的带 query access log，避免记录一次性 token/code；可用 `access_log off` 作用于该路径。本站认证响应 `no-store`、`no-referrer`，禁止 iframe。

## 未打码与网页登录态

成熟（Mature）作品：仅 OAuth 时官方 API 只返回主图、不返回多图附加页，匿名网页接口对原始文件返回 403/打码。**带网页登录 Cookie 请求 `_puppy/dadeviation/init` 时，附加页（`deviation.extended.additionalMedia`）下发的是未打码原始文件签名链接**——媒体下载本身走签名 CDN，无需再带 Cookie。因此一键登录同时建立 OAuth + 网页 Cookie 后，成熟多图作品的所有画面都会未打码发送；没有网页 Cookie 时附加页仍按原策略跳过并提示去作品页查看（不发打码图）。判定逻辑见 `shouldSkipMatureExtras`。

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
