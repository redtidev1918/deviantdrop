#!/usr/bin/env bash
# VPS 端 Web OAuth 登录（没有公网域名时使用：ssh 隧道 + 本机浏览器）。
#
# 原理：DA 的 redirect 白名单已含 http://127.0.0.1:8787/callback（OAuth 对 localhost 允许 http）。
# 本脚本在 VPS 上启动登录服务（只监听 127.0.0.1:8787），用户在本机用 ssh -L 把 8787 转发进来，
# 浏览器访问的就是 VPS 上的登录服务；授权完成后 refresh token 直接写入容器 volume
# (/data/auth/deviantart.json)，脚本自动 chown 并 restart 容器，30 秒内生效。
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

# VPS 上访问 api.deviantart.com 走 clash 代理（与 Bot 一致的出口）
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:7890}"
export HTTP_PROXY="${HTTP_PROXY:-$HTTPS_PROXY}"

# 容器 volume 里 /data/auth 的宿主路径
AUTH_HOST="$(docker volume inspect deviantdrop_cache --format '{{.Mountpoint}}')/auth"
mkdir -p "$AUTH_HOST"

echo "=============================="
echo " 1) 保持「终端 1」的隧道开着："
echo "    ssh -L 8787:127.0.0.1:8787 root@<VPS>"
echo
echo " 2) 现在在本机浏览器打开："
echo "    http://127.0.0.1:8787"
echo "    完成 DeviantArt 授权（页面显示“登录成功”即可回到这里）"
echo "=============================="

# 前台运行：授权完成后进程自行退出（10 分钟超时）
AUTH_DIR="$AUTH_HOST" node scripts/da-login.mjs "$CID" "$CSEC" 8787

# da-login 以 root 写入，容器内是 node 用户(uid 1000)：改属主后重启让新凭据生效
chown -R 1000:1000 "$AUTH_HOST"
docker compose restart deviantdrop >/dev/null
sleep 3

echo "凭据已写入 $AUTH_HOST/deviantart.json 并生效。"
echo "在 Telegram 对 Bot 发送 /status 可确认 OAuth: valid（valid = 已登录）。"
