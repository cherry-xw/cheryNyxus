#!/usr/bin/env sh
set -eu

root=${CHERY_MANAGER_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
unit="$unit_dir/cherynyxus-manager.service"

case "${1:-}" in
  install)
    mkdir -p "$unit_dir"
    cat > "$unit" <<EOF
[Unit]
Description=CheryNyxus local manager
After=network.target

[Service]
Type=simple
WorkingDirectory=$root
ExecStart=$(command -v node) $root/manager/dist/index.js
Environment=CHERY_DIR=$root
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now cherynyxus-manager.service
    echo "已安装并启动用户级 systemd 服务：$unit"
    ;;
  uninstall)
    systemctl --user disable --now cherynyxus-manager.service 2>/dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload
    echo "已卸载用户级 systemd 服务"
    ;;
  *)
    echo "用法：$0 install|uninstall" >&2
    exit 2
    ;;
esac
