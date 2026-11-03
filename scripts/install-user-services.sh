#!/usr/bin/env bash
# Install the user-level systemd units so the stack comes back after a reboot.
#
# User units + linger, not system units: the service runs as the login user, no
# root-owned process, no root-owned files. Linger is what makes the user manager
# start at boot instead of at first login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APP_ENV="${APP_ENV:-$ROOT/.env}"

mkdir -p "$UNIT_DIR"
for unit in "$ROOT"/deploy/systemd/user/*.service; do
  sed "s#__ROOT__#$ROOT#g" "$unit" > "$UNIT_DIR/$(basename "$unit")"
done
echo "units installed to $UNIT_DIR"

# Media mirrors and anything else site-specific live here; systemd reads it via
# EnvironmentFile, and so does scripts/start.sh.
if [[ ! -f "$APP_ENV" ]]; then
  cat > "$APP_ENV" <<EOF
# Read by systemd (EnvironmentFile) and by scripts/start.sh.
ROOM_DATA_DIR=$ROOT/data
ROOM_MEDIA_ROOT=$ROOT/data/rooms
MEDIA_MIRRORS=https://ani-lan.kajimi.cc:8443
ROOM_TRANSCODE_CONCURRENCY=1
ROOM_DISK_RESERVE_MB=2048
EOF
  echo "wrote $APP_ENV"
fi

systemctl --user daemon-reload

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "enabling linger (needs sudo, asks once)"
  sudo loginctl enable-linger "$USER"
fi
echo "linger: $(loginctl show-user "$USER" -p Linger --value)"
