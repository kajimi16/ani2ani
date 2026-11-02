# 部署

## 1. 配置依赖

### 安装

```bash
sudo apt update
sudo apt install -y ffmpeg curl git

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

curl -fsSL -o /tmp/caddy.tgz \
  https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz
sudo tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
```

### 校验

```bash
node -v
npm -v
ffmpeg -version | head -1
caddy version
```

### 端口

```bash
sudo ufw allow 8080/tcp
sudo ufw allow 3478/udp
```

### 默认配置

写在命令前覆盖，例如 `ROOM_MAX_COUNT=40 bash scripts/start.sh`。

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `8080` | 对外 HTTP 端口 |
| `API_PORT` | `8001` | 控制 API，仅回环 |
| `STUN_PORT` | `3478` | STUN，UDP |
| `ROOM_DATA_DIR` | `./data` | 房间与分片目录 |
| `ROOM_MEDIA_ROOT` | `$ROOM_DATA_DIR/rooms` | Caddy 的媒体根，自动推导 |
| `ROOM_DISK_RESERVE_MB` | `2048` | 磁盘保留量 |
| `ROOM_BITRATE_KBPS` | `2500` | 转码码率 |
| `ROOM_MAX_UPLOAD_MB` | `8192` | 单集上限 |
| `ROOM_MAX_COUNT` | `20` | 房间总数上限 |
| `ROOM_CREATE_LIMIT` | `6` | 每 IP 每小时开房数 |
| `ROOM_TRANSCODE_CONCURRENCY` | `2` | 并行转码数 |
| `ROOM_KEEP_SOURCE` | `0` | 保留源文件 |
| `ROOM_HOST_TIMEOUT_S` | `30` | 房主超时 |
| `ROOM_IDLE_HOURS` | `48` | 闲置房间保留 |
| `ROOM_LOW_DISK_GB` | `20` | 低空间阈值 |
| `ROOM_LOW_DISK_IDLE_HOURS` | `6` | 低空间时的保留 |
| `SEGMENT_CACHE_CONTROL` | `public, max-age=31536000, immutable` | 分片缓存策略 |

## 2. 部署

```bash
git clone https://github.com/kajimi16/ani2ani.git
cd ani2ani
npm ci
bash scripts/build-player.sh
bash scripts/start.sh
```

```bash
bash scripts/check-stack.sh
```

11 项全 `ok` 即成功。对外地址在 `start.sh` 输出的 `campus` 行。

## 3. 运行

### 日常

```bash
bash scripts/start.sh          # 启动
bash scripts/stop.sh           # 停止
bash scripts/check-stack.sh    # 自检
```

```bash
curl -s localhost:8080/api/health
curl -s localhost:8080/api/rooms
tail -f logs/control.log
tail -f logs/access.log
```

### 升级

```bash
git pull --ff-only
npm ci
bash scripts/build-player.sh   # 不能省，start.sh 不会重打包
bash scripts/start.sh
```

### 回滚

```bash
git checkout <提交或标签>
npm ci
bash scripts/build-player.sh
bash scripts/start.sh
```

### 换盘

```bash
ROOM_DATA_DIR=/path/to/data bash scripts/start.sh
```

### 重启影响

| 房间状态 | 重启后 |
|---|---|
| 转码中 / 排队中 / 上传中 | 标记失败，需重新上传 |
| 放映中 | 房间与进度保留，观众重连 |
| 已就绪 | 不受影响 |
