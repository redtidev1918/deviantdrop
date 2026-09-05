#!/usr/bin/env bash
# 给 mihomo(clash) 挂上 metacubexd WebUI，并配置 external-ui。
# 安全姿势：不开放公网端口，本地经 SSH 隧道访问：
#   ssh -L 9090:127.0.0.1:9090 root@<服务器>
#   http://127.0.0.1:9090/ui
set -euo pipefail

CFG=/etc/mihomo/config.yaml
UI_DIR=/etc/mihomo/ui

if ! command -v unzip >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq unzip
fi

if [ ! -f "$UI_DIR/index.html" ]; then
  echo "下载 metacubexd ..."
  TMPZ=$(mktemp)
  curl -fsSL --retry 2 -m 240 -o "$TMPZ" \
    "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip" \
  || curl -fsSL --retry 2 -m 240 -o "$TMPZ" \
    "https://ghfast.top/https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"
  mkdir -p "$UI_DIR"
  unzip -qo "$TMPZ" -d "$UI_DIR"
  rm -f "$TMPZ"
  if [ -d "$UI_DIR/metacubexd-gh-pages" ]; then
    mv "$UI_DIR/metacubexd-gh-pages"/* "$UI_DIR/"
    rmdir "$UI_DIR/metacubexd-gh-pages"
  fi
  echo "UI 文件就绪: $UI_DIR"
fi

if ! grep -q "external-ui:" "$CFG"; then
  cp "$CFG" "${CFG}.bak.webui.$(date +%s)"
  printf 'external-ui: %s\n' "$UI_DIR" >> "$CFG"
  echo "已注入 external-ui 配置"
fi

systemctl restart clash
sleep 2
echo "完成。本地访问：ssh -L 9090:127.0.0.1:9090 root@<服务器> 后打开 http://127.0.0.1:9090/ui"
