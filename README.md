# DeviantDrop

把 DeviantArt 作品“丢”进 Telegram 的 Bot：在聊天里发一个作品链接，DeviantDrop 就把作品的图片、视频或 GIF 原样回复给你。

[📖 完整文档](https://redtidev1918.github.io/deviantdrop/) · [更新日志](CHANGELOG.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-文档站点-6366f1?style=flat-square)](https://redtidev1918.github.io/deviantdrop/)

> ⚠️ **部署形态**：DeviantArt 会封锁数据中心出口（Cloudflare Workers 与多数云主机被拦）。请把 Bot 跑在 **DeviantArt 放行的出口**（住宅网络或已检测通过的部分 VPS）上——部署步骤见 [docs/VPS.md](docs/VPS.md)。

## 快速部署

```bash
cp .env.example .env    # 填 BOT_TOKEN / WEBHOOK_SECRET / 官方 API 凭据；国内机器填代理
docker compose up -d --build
```

## 支持范围

- 识别消息与 caption 里的作品链接（`https` / `www` / 旧式域名 / fav.me 等），最多同时处理 5 个。
- **网页接口优先**（视频 / GIF / 新作品都能取到），**官方 OAuth API 兜底**。
- 图片 / 多图相册（sendMediaGroup，超过 10 张自动分批）/ GIF / 视频 / 超大图压缩与 document 兜底；Telegram 拉不动 CDN 时自动下载后 multipart 上传。
- `/start` `/help` `/about` 命令；每聊天限流、去重、429/500/503 退避重试。

### 群聊与频道

- Bot 默认开启「群组隐私模式」，此时在群里看不到普通消息（只有命令）。要让它响应群里的作品链接：在 **BotFather** 里 `/mybots` → 选 Bot → **Bot Settings → Group Privacy → Turn off**，然后把 Bot 移出群再拉回（或设为管理员）使设置生效。
- 频道里把 Bot 设为管理员、以「发到频道」的方式发链接即可（`channel_post` 同样处理）。
- 群聊/频道默认**不显示**技术性状态提示（见「回复排版」），caption 更干净。

### 登录与所有者命令

管理命令（`/login`、`/status`）只允许 **Bot 所有者**使用：在 `.env` 设置 `ADMIN_IDS=<你的 Telegram 用户 ID>`。未配置时管理命令一律拒绝；普通使用者白名单（`ALLOWED_USER_IDS`）不是管理员。

**登录一次，多图作品的所有画面（含成熟作品的附加页）都会未打码发送。** 登录同时建立账号授权（OAuth）和网页登录状态（Cookie），二者都立即在服务器生效，**无需手动复制 Cookie、无需改配置、无需重启**。

- **推荐：电脑一键登录（无公网域名也能用）**。在你的电脑上（需装有 Chrome/Edge），于 DeviantDrop 目录运行：
  ```bash
  VPS=root@<你的服务器> npm run login
  ```
  脚本会自动打开 Chrome 进入 DeviantArt 官方登录页：你登录并点「Authorize/允许」，脚本自动把授权和网页登录状态推送到服务器并热生效。DA 的登录页有 AWS WAF 人机校验，用你自己的真实浏览器登录即可正常通过（这也是必须在你电脑上、而不是在服务器上跑浏览器的原因）。Windows/Linux 同样适用；服务器地址可用 `VPS=` 环境变量传入，不传会交互询问。完成后 `/status` 显示 `OAuth: valid`、`Cookie: available`。
- **有公网域名（`PUBLIC_BASE_URL`）**：在 Telegram 私聊发 `/login`，点按钮在浏览器授权即可（仅建立 OAuth；想要附加页也未打码，仍建议用上面的电脑一键登录，它会一并登录网页）。
- **`/status`（所有者私聊）**：查看 Telegram / OAuth / Cookie / TelePress / Cache 状态（不显示任何密钥）。
- `DA_REFRESH_TOKEN` / `DA_COOKIES` 只作为**首次迁移 seed**：启动时写入 `/data/auth/deviantart.json` 与 `/data/auth/deviantart-cookies.json`，之后以这些文件为准（refresh token 轮换即落盘、失效自动标记；Cookie 支持热更新），不再回退读 .env 里的旧值。
- 登录失效时 Bot 所有者收到带「重新登录」按钮的通知（6 小时冷却，恢复后另发一次恢复通知）。

### 回复排版

- 统一排版：`🎨 标题 / 👤 作者 / 🖼 N 个媒体`，外加一个可靠的来源入口（见下）。
- 来源入口**每个作品只有一个、绝不重复**：单图/视频是图片下方的「🔗 在 DeviantArt 打开」内联按钮（按钮在 URL 直传 / file_id 重放 / multipart 上传各路径都可靠）；相册（sendMediaGroup 会静默丢弃按钮）在相册发出后**补发一行**可点击的「🔗 在 DeviantArt 打开」文本，不展开链接预览。
- 技术性状态提示（`⚠️ 已压缩 / 原图暂不可用 / 已作为文件发送` 等）默认只在**私聊**显示便于运营排查；群聊/频道里自动隐藏（对看图的人是噪音，想看原图点来源入口即可）。可用环境变量强制：`CAPTION_NOTES=auto`（默认，私聊显示/群聊隐藏）、`always`（总是显示）、`never`（总是隐藏）。

### TelePress（可选）

超大图集（>10 张）或 Telegram 发送失败时，可借助 [TelePress](https://github.com/redtidev1918/telepress) 生成 Telegraph 页面。未配置 URL 时不启用；配置后默认仅失败兜底（`TELEPRESS_MODE=fallback`），大图集需选择 `large-gallery`，失败绝不影响原生 Telegram 发送。同机部署建议 `TELEPRESS_URL=http://127.0.0.1:<port>` 并在两端配置同一个 `TELEPRESS_API_KEY`。

完整的解析机制、双通道细节、限流策略、部署与排错，请看 **📖 文档站点**：

👉 https://redtidev1918.github.io/deviantdrop/

### 公开预览页

设置 HTTPS `PUBLIC_BASE_URL` 后提供 `/d/:id`，供 Telegram/Discord 读取 OG metadata。只发布匿名 oEmbed 的公开缩略图，不暴露登录后媒体。

完整操作、数据迁移与限制见 [认证与预览指南](docs/AUTH_AND_PREVIEW.md)，审查结论见 [审查记录](docs/FEATURE_AUDIT.md)。
