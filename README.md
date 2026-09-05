# DeviantDrop

把 DeviantArt 作品“丢”进 Telegram 的 Bot：在聊天里发一个 DeviantArt 单作品链接或 `fav.me` 短链，DeviantDrop 就把作品的图片、视频或 GIF 原样回复给你。运行在 Cloudflare Workers 上，无需自建服务器。

## 支持范围

Bot 会同时检查普通消息和媒体 caption，并识别：

- 明文 `https://`、`http://` 链接；已知 DeviantArt 域名会统一升级为 HTTPS。
- 没有协议的 `www.deviantart.com/...`、旧式 `作者.deviantart.com/...`。
- Telegram `url` entity 和文字背后的 `text_link` 隐藏链接。
- 同一消息中的多个链接；保持出现顺序、删除完全重复项，最多处理 5 个。
- 当前作品页、旧式 `/view/{id}`、`view.php?id=...` 和 `fav.me` 短链。

不处理画廊、收藏夹、标签页、搜索结果、非 DeviantArt 直链、私密或付费作品。每个链接独立处理：一个失败不会阻止后续链接。

## 工作方式

1. 校验 Telegram webhook secret 和可选用户白名单。
2. 从消息正文/caption 及 Telegram entities 中收集、规范化并去重链接。
3. 每条消息只请求一次 DeviantArt 首页，复用匿名 session cookie 和 CSRF token。
4. 解析每个作品的最佳公开媒体：最高分辨率 MP4、完整图片或 GIF。
5. 生成 15 分钟有效的 HMAC 签名媒体 URL。Telegram 经 Worker 流式读取 DeviantArt CDN；Worker 不缓存完整文件，并支持视频 Range 请求。

## 限流与可靠性

不存在合法的“绕过 DeviantArt 限额”。DeviantArt 使用自适应限流；Bot 对网络错误、HTTP 429、500 和 503 最多重试两次并指数退避，同时复用单条消息的 session，避免无意义请求。持续高并发时应接入 Cloudflare Queue，并按 DeviantArt 官方 API/OAuth 规则访问，不能通过轮换 IP 或并发轰炸规避限制。

当前版本为免配置 DeviantArt 凭据，沿用参考项目的网页公开 `_puppy/dadeviation/init` 接口；它不是稳定的官方 API 合约，DeviantArt 改版时可能失效。要求长期生产稳定性或访问用户授权内容时，应注册 DeviantArt 应用并改用 OAuth API，仍须遵守其自适应限流。

Telegram 单会话也可能触发 429；Bot 会读取 `retry_after` 并重试一次。以下情况会直接回复用户可理解的错误：

- 链接不是单作品页，或作品不存在/已删除。
- 作品需要登录、无权访问或 DeviantArt 拒绝请求。
- DeviantArt 限流、超时、服务故障或页面结构变化。
- 媒体超过 Telegram 限制，或 Telegram 无法读取媒体格式。

当前 Telegram Bot API 的图片上限为 10 MB，视频/GIF 为 50 MB。Webhook 采用同步处理以保持最小部署；若实际出现长视频超时、重复投递或并发积压，再增加 Queue 与持久化 `update_id` 去重。

## 部署

要求 Node.js 18+ 和 Cloudflare 账号。

```bash
npm install
npx wrangler login
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npm run deploy
```

`WEBHOOK_SECRET` 只能使用字母、数字、下划线和连字符。可用 `openssl rand -hex 32` 生成。部署后注册 Telegram webhook：

```bash
export BOT_TOKEN='123456789:replace_me'
export WEBHOOK_SECRET='replace_with_a_random_string'
export WORKER_URL='https://deviantdrop.<你的账号>.workers.dev'

curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode 'max_connections=1'
```

Bot 默认允许所有用户。私有 Bot 应配置逗号分隔的 Telegram user id：

```bash
npx wrangler secret put ALLOWED_USER_IDS
```

不要把真实 token 写入 `wrangler.jsonc`、Git 或日志。本地开发时将 `.dev.vars.example` 复制为 `.dev.vars`。

## 验证与排错

```bash
npm run check
curl -fsS https://你的-worker.workers.dev/
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
npx wrangler tail
```

健康检查应返回 `{"ok":true,"service":"deviantdrop"}`。测试覆盖链接实体、多链接/session 复用、图片/视频/GIF 分类、404 用户提示、webhook 鉴权和签名媒体代理。

## 实现来源

- [deviantart-downloader](https://github.com/redtidev1918/deviantart-downloader)：CSRF、作品 ID、cookie 复用、媒体 URL 和失败语义。
- [DAKit](https://github.com/redtidev1918/dakit)：`_puppy/dadeviation/init` 流程、`fav.me`/作品页 URL 兼容。
- [TelePost](https://github.com/redtidev1918/TelePost)：Telegram photo/video/animation 类型映射。
