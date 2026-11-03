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
| `ROOM_TRANSCODE_CONCURRENCY` | `2` | 并行转码数；**2 vCPU 设 1**（x264 本来就用满全部核心） |
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
systemctl --user start ani2ani-node ani2ani-caddy ani2ani-tunnel
systemctl --user stop ani2ani-node ani2ani-caddy ani2ani-tunnel
systemctl --user restart ani2ani-node
bash scripts/check-stack.sh    # 自检
```

```bash
curl -s localhost:8080/api/health
curl -s localhost:8080/api/rooms
journalctl --user -u ani2ani-node -f      # node 日志（systemd 接管后不再写 logs/control.log）
tail -f logs/access.log                   # Caddy 访问日志
```

### 升级

```bash
git pull --ff-only
npm ci
bash scripts/build-player.sh              # 不能省，重启不会重打包
systemctl --user restart ani2ani-node ani2ani-caddy
```

### 回滚

```bash
git checkout <提交或标签>
npm ci
bash scripts/build-player.sh
systemctl --user restart ani2ani-node ani2ani-caddy
```

### 边缘节点（校外入口）

```bash
# 与校内同步代码（不含 .git / data / node_modules）
rsync -az --delete --exclude '{.git,data*,node_modules,run*,logs*,certs,hls}' \
  ./ root@203.0.113.10:/srv/ani2ani/
```

```bash
# VPS 一次
scp deploy/systemd/ani2ani-edge-caddy.service root@203.0.113.10:/etc/systemd/system/
ssh root@203.0.113.10 'systemctl daemon-reload && systemctl enable --now ani2ani-edge-caddy'
```

```bash
# 校内：建立反向隧道（VPS:18080 → 本机:8080）
systemctl --user enable --now ani2ani-edge-tunnel
systemctl --user status ani2ani-edge-tunnel
```

```bash
curl -sI https://ani2-ext.kajimi.cc/
curl -s https://ani2-ext.kajimi.cc/api/rooms
ssh root@203.0.113.10 'journalctl -u ani2ani-edge-caddy -n 30 --no-pager'
```

VPS 的 `/srv/ani2ani/.env` 只需 `EDGE_SITE` 与 `ACME_EMAIL`，证书由 Caddy 自动申请续期。

### 开机自启

```bash
bash scripts/install-user-services.sh          # 装单元 + 开 linger（会要一次 sudo）
systemctl --user daemon-reload
systemctl --user enable --now ani2ani-node ani2ani-caddy ani2ani-tunnel
```

```bash
systemctl --user status ani2ani-node ani2ani-caddy ani2ani-tunnel
systemctl --user restart ani2ani-node
journalctl --user -u ani2ani-node -f
loginctl show-user "$USER" -p Linger --value
```

```bash
# 系统启动后自动运行，不需要登录；进程崩溃 3 秒后自动拉起
systemctl --user is-enabled ani2ani-node
```

配置在 `.env`（systemd 的 `EnvironmentFile`）。`start.sh` / `stop.sh` 在 systemd
接管后会拒绝执行，避免抢端口。

隧道地址每次重启都会变：

```bash
journalctl --user -u ani2ani-tunnel -n 50 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
```

### 开发栈

```bash
git worktree add --detach ../ani2ani-dev HEAD   # 一次性，scripts/dev-worktree.sh 会自动做
bash scripts/dev-worktree.sh   # 在独立工作区起栈：8081 / 8002 / 3479 / 8444
bash scripts/stop-dev.sh
```

```bash
curl -s localhost:8081/api/health
tail -f logs-dev/control.log
```

数据在 `data-dev/`，pid 在 `run-dev/`。生产 Caddy 每次请求都从 `./web` 读盘，
所以**前端文件必须在独立工作区里改**，否则改动立刻影响 8080；只在主工作区跑
`start-dev.sh` 只能隔离后端。改完确认再重启生产。

### 换盘

```bash
ROOM_DATA_DIR=/path/to/data bash scripts/start.sh
```

### 重启影响

| 房间状态 | 重启后 |
|---|---|
| 转码中 / 排队中 | 标记失败，删除后重传 |
| 上传中 | 已收字节保留，重选同一文件续传 |
| 放映中 | 房间与进度保留，观众重连 |
| 已就绪 | 不受影响 |
