#!/usr/bin/env bash
# 在 VPS 上热更新 Telegram bot token —— 不重启容器，也不碰 .env。
#
# 为什么需要这个包装脚本：/data 是 Docker named volume，宿主机看不到 /data/secrets；
# 而容器里已经有 node 和 dd-token.mjs。所以默认在容器内执行，把 token 原子写进
# /data/secrets/telegram-bot-token，运行中的服务会自行发现、getMe 验证、只重建
# Telegram 入口。
#
# 用法：
#   ./scripts/set-telegram-token.sh              # 等价于 set telegram（隐藏输入）
#   ./scripts/set-telegram-token.sh set telegram
#   ./scripts/set-telegram-token.sh status       # 只读：当前来源/状态
#
# 环境变量：
#   DD_CONTAINER   容器名（默认 deviantdrop-deviantdrop-1）
set -euo pipefail

container=${DD_CONTAINER:-deviantdrop-deviantdrop-1}
here=$(cd "$(dirname "$0")" && pwd)

# 无参数时默认走 set telegram：日常操作只需要记住一条命令。
args=("$@")
if [ ${#args[@]} -eq 0 ]; then
  args=(set telegram)
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
  # -t 只在真的有 TTY 时加：否则隐藏输入和管道输入都会被 docker 拒绝。
  exec_args=(-i)
  if [ -t 0 ] && [ -t 1 ]; then exec_args=(-it); fi
  exec docker exec "${exec_args[@]}" "$container" node scripts/dd-token.mjs "${args[@]}"
fi

echo "容器 ${container} 未在运行：改用本机 node（需要能写到 BOT_TOKEN_FILE）" >&2
exec node "${here}/dd-token.mjs" "${args[@]}"
