#!/usr/bin/env bash
# 服务器端：接收本机一键登录器推来的 base64 登录结果，拷进容器兑换并热落盘。
# 由本机 dd-login.mjs 通过 ssh 调用，通常不手动执行。
# 用法： echo '<base64>' | scripts/dd-receive.sh   （或参数传入）
set -eu
cd "$(dirname "$0")/.."

CONTAINER="$(docker compose ps -q deviantdrop 2>/dev/null || true)"
[ -n "$CONTAINER" ] || { echo "错误：找不到 deviantdrop 容器（先 docker compose up -d）" >&2; exit 1; }

# 先从 stdin/参数读完 base64（docker compose exec 会占用 stdin，必须提前读取）。
B64="${1:-$(cat)}"
[ -n "$B64" ] || { echo "错误：没有收到登录数据" >&2; exit 1; }

# 兑换脚本拷进容器（镜像不含 scripts/），以 node 用户跑，直接热写 /data/auth。
docker exec -u 0 "$CONTAINER" mkdir -p /app/scripts
docker cp scripts/dd-exchange.mjs "$CONTAINER":/app/scripts/dd-exchange.mjs
docker exec -u 0 "$CONTAINER" chown node:node /app/scripts/dd-exchange.mjs
# B64 作为单参数传入（纯 base64，无引号转义问题）
docker compose exec -T deviantdrop node /app/scripts/dd-exchange.mjs "$B64"
