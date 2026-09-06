#!/usr/bin/env bash
# 【在本机运行】机场订阅热更新：本机拉取订阅 → 传到服务器 → 控制器热重载（进程不重启）。
#
# 用法：
#   SERVER=root@your-server.example SUB_URL="https://你的机场/订阅?token=xxx" ./scripts/push-clash-config.sh
# 或 export SERVER / SUB_URL 后直接执行。
#
# 为什么在本机拉：部分机场接口对服务器 IP 返回 403/Backend Timeout（nloli.xyz 实测），
# 住宅网络拉取稳定。服务器直拉用 scripts/refresh-clash.sh。
set -euo pipefail

SERVER="${SERVER:-root@your-server.example}"
SUB_URL="${SUB_URL:-${1:-}}"
REMOTE_CFG=/etc/mihomo/config.yaml
TMP=/tmp/clash_sub_new.yaml

if [ -z "$SUB_URL" ]; then
  echo "缺少 SUB_URL（订阅地址）" >&2
  exit 1
fi

echo "== 本机拉取订阅 =="
curl -fsSL -A "clash" -m 60 -o "$TMP" "$SUB_URL"
echo "收到 $(wc -c < "$TMP") 字节，节点数: $(grep -cE '^  - name:' "$TMP" || true)"

echo "== 上传到 $SERVER =="
scp -q "$TMP" "$SERVER:/tmp/clash_sub_new.yaml"

echo "== 服务器上备份并热重载 =="
ssh "$SERVER" "
  cp $REMOTE_CFG \${REMOTE_CFG}.bak.\$(date +%s)
  cp /tmp/clash_sub_new.yaml $REMOTE_CFG
  if curl -fsS -m 10 -X PUT 'http://127.0.0.1:9090/configs?force=true' \
      -H 'Content-Type: application/json' \
      -d '{\"path\":\"$REMOTE_CFG\"}' >/dev/null 2>&1; then
    echo '已通过控制器热重载（进程未重启）'
  else
    systemctl restart clash
    echo '控制器重载不可用，已 systemctl restart clash'
  fi
  sleep 2
  echo -n '代理自检(gstatic): '
  curl -x http://127.0.0.1:7890 -sS -o /dev/null -w '%{http_code}\n' -m 20 https://www.gstatic.com/generate_204 || echo FAIL
"
