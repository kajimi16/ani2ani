#!/usr/bin/env bash
# 把本地转好的集推到放映服务器，并等它被发现。
#
#   bash scripts/push-episode.sh <房间id> <集id> <本地产物目录> <user@server:路径>
#
# 例：bash scripts/push-episode.sh 4z2wrw7k e01 ./out/ep01 root@1.2.3.4:/srv/ani2ani
#
# 服务端每 30 秒扫描 data/rooms/<房间>/ep/，发现新的 hls/index.m3u8 就自动登记。
set -euo pipefail

ROOM="${1:?用法: push-episode.sh <房间id> <集id> <产物目录> <user@server:项目路径>}"
EPISODE="${2:?缺少集 id}"
LOCAL="${3:?缺少本地产物目录}"
REMOTE="${4:?缺少远端，形如 root@host:/srv/ani2ani}"

[[ -d "$LOCAL/hls" ]] || { echo "本地目录里没有 hls/: $LOCAL" >&2; exit 1; }

HOSTPART="${REMOTE%%:*}"          # user@host
BASEPATH="${REMOTE#*:}"           # /srv/ani2ani
EPDIR="${BASEPATH%/}/data/rooms/${ROOM}/ep"
STAGE="${EPDIR}/.incoming-${EPISODE}"

# 先传到隐藏目录再改名：扫描器只认不带点的目录，所以传输中途不会被登记成
# 「就绪」，避免观众拿到一半的清单后在后面的分片上 404。
echo "推送 ${LOCAL} -> ${HOSTPART}:${STAGE}"
ssh "$HOSTPART" "mkdir -p '$EPDIR' && rm -rf '$STAGE' && mkdir -p '$STAGE'"
rsync -a --delete --info=progress2 "$LOCAL/" "${HOSTPART}:${STAGE}/"
ssh "$HOSTPART" "rm -rf '$EPDIR/${EPISODE}' && mv '$STAGE' '$EPDIR/${EPISODE}'"

echo "已推送。服务端会在 30 秒内自动登记这一集，随后刷新房间页即可看到。"
