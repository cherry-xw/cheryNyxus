#!/usr/bin/env bash
# electron:dev wrapper: 自动选最新可用 xrdp display + 移除 ELECTRON_RUN_AS_NODE
# 无 X server 时退出并提示用 web:dev（浏览器开发）
set -euo pipefail

D=""
for n in $(ls /tmp/.X11-unix 2>/dev/null | sed 's/^X//' | sort -rn); do
  if timeout 2 xset -display ":$n" q >/dev/null 2>&1; then D=":$n"; break; fi
done

if [ -z "$D" ]; then
  echo "[electron:dev] 无可用 X display（/tmp/.X11-unix 空或 xset 全失败）。改用 'pnpm web:dev'（浏览器开发）" >&2
  exit 1
fi

echo "[electron:dev] DISPLAY=$D XAUTHORITY=$HOME/.Xauthority"
export DISPLAY="$D" XAUTHORITY="$HOME/.Xauthority"
unset ELECTRON_RUN_AS_NODE
exec vite
