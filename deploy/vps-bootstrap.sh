#!/usr/bin/env bash
# 在一台全新的 Debian 上把边缘节点准备好。以 root 运行。
#
#   bash deploy/vps-bootstrap.sh
set -euo pipefail

apt-get update
apt-get install -y curl git rsync ffmpeg ca-certificates

# Node 22
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy（官方 apt 源；边缘节点只需要它）
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
  systemctl disable --now caddy  # 用自己的单元，避免两套配置打架
fi

mkdir -p /srv
if [[ ! -d /srv/ani2ani/.git ]]; then
  git clone --depth 1 https://github.com/kajimi16/ani2ani.git /srv/ani2ani
fi
cd /srv/ani2ani
npm ci
bash scripts/build-player.sh

[[ -f .env ]] || cp deploy/edge.env.example .env
install -m 644 deploy/systemd/ani2ani-edge-caddy.service /etc/systemd/system/ani2ani-edge-caddy.service

echo
echo "下一步：编辑 /srv/ani2ani/.env（EDGE_SITE / ACME_EMAIL），然后"
echo "  systemctl daemon-reload && systemctl enable --now ani2ani-edge-caddy"
