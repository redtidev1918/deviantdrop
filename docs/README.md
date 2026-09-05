# DeviantDrop

把 DeviantArt 作品“丢”进 Telegram 的 Bot：在聊天里发一个 DeviantArt 单作品链接，DeviantDrop 就把作品的图片、视频或 GIF 原样回复给你。

> ⚠️ **部署形态**：DeviantArt 会封锁数据中心出口（Cloudflare Workers 与多数云主机的页面/API 数据面均被拦，见 [docs/VPS.md](VPS.md) 的检测结论）。请把 Bot 跑在 **DeviantArt 放行的出口**（住宅网络或已检测通过的部分 VPS）上——Node 版部署步骤见 [docs/VPS.md](VPS.md)。本仓库同时保留 Workers 形态代码，仅适合自建/未被封禁的出口。

## 支持范围

Bot 会同时检查普通消息和媒体 caption，并识别：

- 明文 `https://`、`http://` 链接；已知 DeviantArt 域名会统一升级为 HTTPS。
- 没有协议的 `www.deviantart.com/...`、旧式 `作者.deviantart.com/...`。
- Telegram `url` entity 和文字背后的 `text_link` 隐藏链接。
- 同一消息中的多个链接；保持出现顺序、删除完全重复项，最多处理 5 个。
- 当前作品页（`作者.deviantart.com/art|journal/标题-数字id`）。

解析是双通道的：
1. **网页接口优先**——出口能被 DeviantArt 放行时（住宅网络，或国内服务器经机场代理），直接走网页作品接口，**新作品、视频/GIF 都能取到**，无需任何存档；
2. **官方接口兜底**——网页不可达但配置了官方 API 凭据时，走「官方 OAuth API + [archive.org](https://web.archive.org) 存档映射 UUID」（新作品若无存档快照会收到明确中文提示）。

无法定位作品页的旧式链接（`fav.me`、`/view/{id}`、`view.php?id=`）两类通道都不支持，会提示改用完整作品页网址。私密/付费/需登录作品同样会提示。

不处理画廊、收藏夹、标签页、搜索结果、非 DeviantArt 直链。每个链接独立处理：一个失败不会阻止后续链接。

## 命令与交互

- `/start`、`/help`：查看用法。
- `/about`：项目介绍与源码仓库（github.com/redtidev1918/deviantdrop，聊天里直接可点）。
- 图片/视频的 caption 里带 DeviantArt 链接同样会被解析下载；不带 caption 的图片、贴纸等消息会被静默忽略。
- 每条媒体回复的 caption 都会附带原作品页链接（Telegram 自动使其可点击），方便回原页查看或确认作者。
- 下载/解析期间会先回一条自动删除的「处理中」提示（多链接时带进度 `⏳ 第 x/N 个`），完成后提示自动消失。
- 转发自 Bot 自己的消息会被忽略，不会把 caption 里的来源链接再重复下载一遍。

## 工作方式

1. 接入消息：webhook 校验 secret / 长轮询拉取（`MODE=poll`，免公网入口），并检查可选用户白名单。
2. 从消息正文/caption 及 Telegram entities 中收集、规范化并去重链接（单条最多 5 个）。
3. 逐链接解析（双通道）：
   - **网页通道**：匿名会话（CSRF/cookie，消息内复用 + 跨消息缓存）请求网页作品接口，返回最高清晰度 MP4/图片/GIF（含视频）；
   - **官方通道**（网页不可达时的兜底）：`client_credentials` 换 token → 数字 id 经 archive.org 存档映射为 UUID（长期缓存）→ 调官方 API 取媒体。
4. 先回一条自动删除的「处理中」提示并随进度更新，然后发送媒体（媒体 caption 带原作品页链接）。
5. 媒体送达：webhook 模式经 15 分钟 HMAC 签名代理流式转发（支持 Range）；轮询模式直接把带 token 的 CDN 地址交给 Telegram 下载。

## 限流与可靠性

不存在合法的“绕过 DeviantArt 限额”。官方 API 按应用配额与自适应限流；Bot 对网络错误、HTTP 429、500 和 503 会退避重试，token 与 UUID 映射在消息之间缓存复用，显著降低请求总量。持续高并发时应接入 Cloudflare Queue，不能通过轮换 IP 或并发轰炸规避限制。

DA 网页面（含网页作品接口）对其认为是数据中心的出口 IP 段返回 403，Cloudflare Workers 与多数云主机都被封锁；官方 OAuth API 与媒体 CDN（wixmp）相对放行。配置官方 API 凭据后，网页通道被封时 Bot 会自动改用官方通道兜底。

Telegram 单会话也可能触发 429；Bot 会读取 `retry_after` 并重试一次。以下情况会直接回复用户可理解的错误：

- 链接不是单作品页，或作品不存在/已删除。
- 作品需要登录、无权访问或 DeviantArt 拒绝请求。
- DeviantArt 限流、超时、服务故障或页面结构变化。
- 媒体超过 Telegram 限制，或 Telegram 无法读取媒体格式。

当前 Telegram Bot API 的图片上限为 10 MB，视频/GIF 为 50 MB。Webhook 采用同步处理以保持最小部署；若实际出现长视频超时、重复投递或并发积压，再增加 Queue 与持久化 `update_id` 去重。

Bot 内置了防滥用/防重复（常量在 `src/index.js` 顶部，可直接调）：

- 每聊天限流：每个聊天每分钟最多处理 15 个作品链接，超出会收到中文提示并跳过。
- Telegram 超时重试同一个 update 不会重复发送（90 秒去重窗口）；中途被掐断的重试仍会重新处理，宁重复不丢消息。
- 相册消息（media_group）里多张照片都带链接时，只处理第一条。
- 去重与限流基于 Cloudflare Cache API 的默认命名空间：无需额外绑定，代价是读改写非原子（尽力而为），且纯 Node 测试环境自动停用这些保护。

## 部署

Bot 必须跑在 **DeviantArt 放行的出口**上（DA 封锁数据中心出口；国内服务器需经
clash/mihomo 等代理，实测机场出口可用）。完整步骤见 **[docs/VPS.md](VPS.md)**，
推荐两种方式：

**Docker Compose（推荐）**

```bash
cp .env.example .env    # 填 BOT_TOKEN / WEBHOOK_SECRET / 官方 API 凭据；国内机器填 HTTP(S)_PROXY
docker compose up -d --build
```

**直接 Node 运行**

```bash
npm install --omit=dev
export BOT_TOKEN=... WEBHOOK_SECRET=... CLIENT_ID=... CLIENT_SECRET=...
export MODE=poll HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890
node src/main.js
```

要点：

- **MODE=poll（默认）**：getUpdates 长轮询，无需公网地址/域名/证书；`MODE=webhook` 需要 HTTPS 反代并注册 setWebhook（见 docs）。
- **DeviantArt 官方 API 凭据（必需）**：在 [deviantart.com/developers](https://www.deviantart.com/developers/) 注册 Confidential 应用拿 Client ID/Secret，填进 `.env`/环境变量（不要入库）。
- 国内服务器出口代理：`.env` 中 `HTTP_PROXY=http://127.0.0.1:7890`（指向本机 clash）；订阅热更新见 `scripts/refresh-clash.sh`。
- 先跑 `npm run detect`（`scripts/detect-da.mjs`）确认出口可用。
- 命令菜单（`/start /help /about`）注册：见 docs/VPS.md。

> 早期 Cloudflare Workers 形态代码仍在仓库中（wrangler.jsonc 等），仅适合未被 DA
> 封禁的自建出口，不建议继续使用。
## 验证与排错

```bash
docker compose logs -f deviantdrop          # 轮询模式持续 getUpdates
node scripts/detect-da.mjs <client_id> <client_secret>   # 出口放行检测
npm run check                               # 本地 12 项测试 + 语法检查
```

> 早期 Cloudflare Workers 形态代码仍在仓库中（wrangler.jsonc 等），仅适合未被 DA
> 封禁的自建出口，不建议继续使用。

## 实现来源

- [deviantart-downloader](https://github.com/redtidev1918/deviantart-downloader)：CSRF、作品 ID、cookie 复用、媒体 URL 和失败语义。
- [DAKit](https://github.com/redtidev1918/dakit)：`_puppy/dadeviation/init` 流程、`fav.me`/作品页 URL 兼容。
- [TelePost](https://github.com/redtidev1918/TelePost)：Telegram photo/video/animation 类型映射。
