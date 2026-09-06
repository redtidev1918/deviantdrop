#!/usr/bin/env bash
# VPS 端 Web OAuth 登录（没有公网域名时使用：ssh 隧道 + 本机浏览器）。
#
# 原理：DA 的 redirect 白名单已含 http://127.0.0.1:8787/callback（OAuth 对 localhost 允许 http）。
# 登录服务跑在容器内（compose 是 network_mode: host，容器里的 127.0.0.1 就是宿主 127.0.0.1），
# 因此用户本机 ssh -L 转发到 VPS 的 8787 即到达容器里的登录服务；依赖（undici）直接复用镜像。
# 授权完成后 refresh token 原子写入容器 volume /data/auth/deviantart.json（进程即 node 用户，
# 属主天然正确），脚本 restart 容器让 Bot 重新加载凭据，约 30 秒生效。
#
# 用法（两个终端）：
#   终端 1（保持打开，建立隧道）： ssh -L 8787:127.0.0.1:8787 root@<VPS>
#   终端 2：                      ssh root@<VPS> 'cd /opt/deviantdrop && ./scripts/vps-login.sh'
#   然后在本机浏览器打开 http://127.0.0.1:8787 完成 DeviantArt 授权。
#   注意：你的浏览器需要能访问 deviantart.com（国内网络请给浏览器配代理）。
#
# 参数：CLIENT_ID CLIENT_SECRET 可省略，自动从 .env 读取。
set -eu
cd "$(dirname "$0")/.."

CID="${1:-$(sed -n 's/^CLIENT_ID=//p' .env 2>/dev/null || true)}"
CSEC="${2:-$(sed -n 's/^CLIENT_SECRET=//p' .env 2>/dev/null || true)}"
[ -n "$CID" ] || { echo "错误：缺少 CLIENT_ID（请传参或写入 .env）"; exit 1; }

CONTAINER="$(docker compose ps -q deviantdrop)"
[ -n "$CONTAINER" ] || { echo "错误：找不到 deviantdrop 容器（先 docker compose up -d）"; exit 1; }

echo "=============================="
echo " 1) 保持「终端 1」的隧道开着："
echo "    ssh -L 8787:127.0.0.1:8787 root@<VPS>"
echo
echo " 2) 现在在本机浏览器打开："
echo "    http://127.0.0.1:8787"
echo "    完成 DeviantArt 授权（页面显示“DeviantArt 登录成功”即可回到这里）"
echo "=============================="

# 把最新登录脚本拷进容器（镜像不含 scripts/，容器重建后此处重新拷贝）并前台运行：
# 授权完成（或 10 分钟超时）后进程退出。容器内以 node 用户跑，直接写 /data/auth。
docker exec -u 0 "$CONTAINER" mkdir -p /app/scripts
docker cp scripts/da-login.mjs "$CONTAINER":/app/scripts/da-login.mjs
docker compose exec -T deviantdrop env AUTH_DIR=/data/auth node /app/scripts/da-login.mjs "$CID" "$CSEC" 8787

# 重启让 Bot 进程重新加载凭据
docker compose restart deviantdrop >/dev/null
sleep 3

echo "凭据已写入 /data/auth/deviantart.json 并生效。"
echo "在 Telegram 对 Bot 发送 /status 可确认 OAuth: valid（valid = 已登录）。"
