#!/usr/bin/env bash
# clash (mihomo) 订阅热更新：在服务器上执行，无需重启即可换配置。
#
# 用法：
#   SUB_URL="https://你的机场/订阅?token=xxx" ./scripts/refresh-clash.sh
# 或先 export SUB_URL=... 再执行。
#
# 说明：
#   - 配置目录 /etc/mihomo/config.yaml，重载走 mihomo 控制器 API（不改进程、不掉连接）。
#   - 若机场接口在服务器上拉不到（403/超时，见 README 检测），就在能拉到的机器上
#     拉好后 `scp config.yaml root@服务器:/tmp/ && 服务器上执行本脚本的本地安装分支`，
#     或直接 cp 到 /etc/mihomo/config.yaml 后 systemctl restart clash。
set -euo pipefail

SUB_URL="${SUB_URL:-${1:-}}"
CFG=/etc/mihomo/config.yaml
TMP=/tmp/clash_sub_new.yaml

if [ -z "$SUB_URL" ]; then
  echo "缺少 SUB_URL（订阅地址）" >&2
  exit 1
fi
echo "拉取订阅: ${SUB_URL//[?&]token=*/[token=***]}"
curl -fsSL -A "clash" -m 60 -o "$TMP" "$SUB_URL"
echo "收到 $(wc -c < "$TMP") 字节，节点数: $(grep -cE '^  - name:' "$TMP" || true)"
cp "$CFG" "${CFG}.bak.$(date +%s)"
cp "$TMP" "$CFG"

# 热重载（控制器 9090；mihomo 支持 force 重载）
if curl -fsS -m 10 -X PUT "http://127.0.0.1:9090/configs?force=true" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"$CFG\"}" >/dev/null 2>&1; then
  echo "已通过控制器热重载（进程未重启）"
else
  systemctl restart clash
  echo "控制器重载不可用，已 systemctl restart clash"
fi
sleep 2
echo "检查代理: $(curl -x http://127.0.0.1:7890 -sS -o /dev/null -w '%{http_code}' -m 20 https://www.gstatic.com/generate_204 || true)"
