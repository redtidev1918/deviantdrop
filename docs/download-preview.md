## 获取与部署

DeviantDrop 是 Telegram Bot 服务，**不发安装包**，也不需要克隆仓库即可部署。发布产物只有发版元数据。

```bash
cp .env.example .env    # 填 BOT_TOKEN / WEBHOOK_SECRET / 官方 API 凭据；国内机器填代理
docker compose up -d --build
```

> ⚠️ **出口要求**：DeviantArt 会封锁数据中心出口（Cloudflare Workers 与多数云主机被拦）。
> Bot 必须跑在 **DeviantArt 放行的出口**（住宅网络或已检测通过的部分 VPS）上。

- 完整部署步骤与出口检测结论：[部署（VPS / Docker / Node）](/VPS.md)
- 认证与会话：[/AUTH_AND_PREVIEW.md](/AUTH_AND_PREVIEW.md)
