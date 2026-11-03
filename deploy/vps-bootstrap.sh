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

# 代码来自校内工作区，而不是 GitHub：远端可能落后于本地提交，直接 clone
# 会把旧版本部署上去。先 rsync，再执行本脚本：
#   rsync -az --delete --exclude '{.git,data*,node_modules,run*,logs*,certs,hls}' \
#     ./ root@<vps>:/srv/ani2ani/
if [[ ! -f /srv/ani2ani/package.json ]]; then
  echo "先把代码同步到 /srv/ani2ani（见 deploy.md 的 rsync 命令），再运行本脚本" >&2
  exit 1
fi
cd /srv/ani2ani
npm ci
bash scripts/build-player.sh

[[ -f .env ]] || cp deploy/edge.env.example .env
install -m 644 deploy/systemd/ani2ani-edge-caddy.service /etc/systemd/system/ani2ani-edge-caddy.service

echo
echo "下一步：编辑 /srv/ani2ani/.env（EDGE_SITE / ACME_EMAIL），然后"
echo "  systemctl daemon-reload && systemctl enable --now ani2ani-edge-caddy"
