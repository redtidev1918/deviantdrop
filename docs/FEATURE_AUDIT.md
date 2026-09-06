# 认证、预览与发布改造审查

审查起点：30b7d43，工作区干净，56 项测试通过。粘贴的历史记录不是测试结果的替代。

| 检查项 | 原实现与问题 |
| --- | --- |
| access token 生命周期 | Cache API 缓存，生产缓存会落盘，违反只保留短期访问凭据的目标；最低 TTL 120 秒可能超过真实过期时间 |
| refresh token 轮换 | 收到新 refresh_token 后写 store，但并发请求可能重复兑换旧 token |
| 最新 token 与重启 | /data/auth/deviantart.json；首次迁移优先 env 而非已有轮换文件，可能拿旧 seed |
| invalid 与 stale fallback | 错误归一化把下划线替换后仍匹配 invalid_grant，且忽略 error 字段；损坏 store 会重新 seed |
| 持久化可靠性 | 两个 store 吞掉写盘失败，登录可能假报成功 |
| Cookie 热更新 | getCookies 只读一次；有 set 方法但无生产入口，session:auth 缓存仍会复用旧 cookie |
| poll / HTTP | 已解耦，但 HTTP 默认监听全部接口，未限制请求体，响应全量缓冲媒体 |
| /media | poll 也有；跟随重定向后才验证主机，不能阻止重定向 SSRF |
| caption | 已有 renderer，但长标题截断会丢掉来源链接；回放丢失压缩/预览状态 |
| 相册 | 正常路径仍额外发送来源按钮；11 张分组尾部单张会错误调用 sendMediaGroup |
| /status 与 /login | telepress.mode 是字符串却当函数调用；管理员空列表放行，群聊可泄露一次性登录链接 |
| Web OAuth | state/PKCE/一次性链接已实现，但错误和缺少 code 校验不足，落盘失败仍可能报成功 |
| Preview Fixer | /d/:id 与 metadata 缓存尚未实现 |
| TelePress API | POST /publish/text、/publish/file、/publish/gallery；gallery 收多文件 multipart 并返回 url/files；现有 client 未接入主流程 |
| 测试 | 覆盖基本 store、OAuth、caption、相册与旧链路；缺损坏文件、并发刷新、真实热更新、预览与实际 TelePress 触发测试 |

OAuth 授权无法读取用户浏览器的 DeviantArt Cookie。主方案采用官方 OAuth；Cookie 兼容通过受保护的管理表单更新，不反代登录页，不引入浏览器自动化。

## 完成结果

本轮补齐真实预览/TelePress 接线，修复上述认证、HTTP、caption 与权限问题；69 项测试及 Workers dry-run 通过。TelePress 现有上游鉴权实现经独立 venv 的 33 项测试验证，无需重复修改其业务。生产 OAuth 授权与公网 OG 抓取仍需运营方提供 HTTPS 域名、设置 redirect whitelist 并亲自完成授权。操作与模块/数据路径见 [指南](AUTH_AND_PREVIEW.md)。
