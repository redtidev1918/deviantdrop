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

### 登录与管理员命令

- **`/login`（管理员）**：在 Telegram 里一键完成 DeviantArt Web OAuth 授权。点按钮在浏览器授权后，refresh token 立即在服务器生效，**无需 SSH / 改 .env / 重启**。需要配置 `PUBLIC_BASE_URL`，并把 `<PUBLIC_BASE_URL>/auth/deviantart/callback` 加入 DA 应用的 redirect 白名单。
  - **没有公网域名？** 用「ssh 隧道 + 本机浏览器」登录，无需开任何端口或域名：两个终端执行（DA 白名单已含 `http://127.0.0.1:8787/callback`）
    ```bash
    # 终端 1（保持打开，建立隧道）
    ssh -L 8787:127.0.0.1:8787 root@<VPS>
    # 终端 2
    ssh root@<VPS> 'cd /opt/deviantdrop && ./scripts/vps-login.sh'
    ```
    然后本机浏览器打开 `http://127.0.0.1:8787` 完成授权即可（浏览器需能访问 deviantart.com）。凭据直接写入服务器并自动重启生效（约 30 秒）。
- **`/cookies`（管理员私聊）**：打开受保护的 Cookie 更新表单，保存后立即生效。OAuth 不会自动读取浏览器 Cookie。
- **`/status`（管理员）**：查看 Telegram / OAuth / Cookie / TelePress / Cache 状态（不显示任何密钥）。
- `DA_REFRESH_TOKEN` / `DA_COOKIES` 只作为**首次迁移 seed**：启动时写入 `/data/auth/deviantart.json` 与 `/data/auth/deviantart-cookies.json`，之后以这些文件为准（refresh token 轮换即落盘、失效自动标记；Cookie 支持热更新），不再回退读 .env 里的旧值。
- 登录失效时管理员收到带「重新登录」按钮的通知（6 小时冷却，恢复后另发一次恢复通知）。

### 回复排版

- 统一排版：`🎨 标题 / 👤 作者 / 🖼 N 个媒体 / ⚠️ 状态说明 / 🔗 来源：DeviantArt`。
- caption 里**不再放裸 URL**：来源链接通过 `caption_entities` 的 `text_link` 精确挂在「DeviantArt」上，中文括号/说明文字不会再破坏链接。
- 单条媒体带「在 DeviantArt 打开」内联按钮；相册（sendMediaGroup 不支持按钮）首图用 text_link，不再额外为发链接而补发消息。

### TelePress（可选）

超大图集（>10 张）或 Telegram 发送失败时，可借助 [TelePress](https://github.com/redtidev1918/telepress) 生成 Telegraph 页面。未配置 URL 时不启用；配置后默认仅失败兜底（`TELEPRESS_MODE=fallback`），大图集需选择 `large-gallery`，失败绝不影响原生 Telegram 发送。同机部署建议 `TELEPRESS_URL=http://127.0.0.1:<port>` 并在两端配置同一个 `TELEPRESS_API_KEY`。

完整的解析机制、双通道细节、限流策略、部署与排错，请看 **📖 文档站点**：

👉 https://redtidev1918.github.io/deviantdrop/

### 公开预览页

设置 HTTPS `PUBLIC_BASE_URL` 后提供 `/d/:id`，供 Telegram/Discord 读取 OG metadata。只发布匿名 oEmbed 的公开缩略图，不暴露登录后媒体。

完整操作、数据迁移与限制见 [认证与预览指南](docs/AUTH_AND_PREVIEW.md)，审查结论见 [审查记录](docs/FEATURE_AUDIT.md)。
