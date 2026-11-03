#!/usr/bin/env bash
# 在快机器上把片子转成 HLS，产物可直接 rsync 到放映服务器。
#
#   bash scripts/build-episode.sh 片源.mkv 输出目录 [码率kbps]
#
# 输出目录里会有 hls/（清单 + 分片）、poster.jpg、episode.json。
# ffmpeg 参数与 src/transcode.js 完全一致；改那边就要改这里。
set -euo pipefail

SOURCE="${1:?用法: build-episode.sh <片源> <输出目录> [码率kbps]}"
OUTDIR="${2:?用法: build-episode.sh <片源> <输出目录> [码率kbps]}"
BITRATE="${3:-2500}"
SEGMENT_SECONDS=4
MAXRATE=$((BITRATE * 112 / 100))
BUFSIZE=$((BITRATE * 2))

[[ -f "$SOURCE" ]] || { echo "找不到片源: $SOURCE" >&2; exit 1; }

HLS="$OUTDIR/hls"
rm -rf "$OUTDIR"
mkdir -p "$HLS"

echo "转码中: $(basename "$SOURCE") @ ${BITRATE}k"
ffmpeg -hide_banner -nostdin -y -i "$SOURCE" \
  -map 0:v:0 -map 0:a:0? -sn -dn \
  -vf "scale='min(1280,iw)':-2" \
  -c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p \
  -b:v "${BITRATE}k" -maxrate "${MAXRATE}k" -bufsize "${BUFSIZE}k" \
  -g $((SEGMENT_SECONDS * 25)) -keyint_min $((SEGMENT_SECONDS * 25)) -sc_threshold 0 \
  -force_key_frames "expr:gte(t,n_forced*${SEGMENT_SECONDS})" \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time "$SEGMENT_SECONDS" -hls_list_size 0 -hls_flags independent_segments \
  -hls_segment_filename "$HLS/seg_%04d.ts" \
  "$HLS/index.m3u8"

# 封面：第二个分片的首帧（避开可能存在的黑场开场）
SEG="$HLS/seg_0001.ts"
[[ -f "$SEG" ]] || SEG="$HLS/seg_0000.ts"
ffmpeg -v error -y -i "$SEG" -frames:v 1 -vf "scale=w=min(640\,iw):h=-2" -q:v 4 "$OUTDIR/poster.jpg"

SEGMENTS=$(find "$HLS" -name 'seg_*.ts' | wc -l)
DURATION=$(awk '/^#EXTINF:/{gsub(/#EXTINF:/,""); s+=$1} END{printf "%d", s}' "$HLS/index.m3u8")
SIZE=$(find "$HLS" -name 'seg_*.ts' -printf '%s\n' | awk '{s+=$1} END{printf "%.1f", s/1048576}')

python3 - "$OUTDIR/episode.json" "$(basename "$SOURCE")" "$DURATION" "$SEGMENTS" <<'PY'
import json, sys
path, name, duration, segments = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
json.dump({"name": name, "durationSec": duration, "segments": segments}, open(path, "w"), ensure_ascii=False)
PY

echo "完成: ${SEGMENTS} 分片 / $((DURATION / 60)) 分钟 / ${SIZE} MiB"
echo "上传: bash scripts/push-episode.sh <房间id> <集id> $OUTDIR <user@server>"
