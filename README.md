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
- `/start` `/help` `/about` 命令；每聊天限流、去重、429/500/503 退避重试。

完整的解析机制、双通道细节、限流策略、部署与排错，请看 **📖 文档站点**：

👉 https://redtidev1918.github.io/deviantdrop/
