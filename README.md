# TFEmby Web

Emby 影视库 Web UI，支持片库搜索、继续观看、播放历史、最近入库、TMDB/豆瓣榜单、TMDB 求片申请和 Telegram 通知。

## NAS 部署

TFEmby Web 的主要程序文件都随 Docker 镜像发布，用户只需要部署容器。首次访问网页时创建管理员账户；普通用户可以直接用 Emby 账户登录，登录成功后会自动关联 Emby。

镜像 tag 默认使用多架构 `latest`，Docker 会根据 NAS CPU 自动拉取 `amd64` 或 `arm64`。

### 准备环境变量

复制一份环境变量文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
EMBY_SERVER_URL=http://你的-emby-ip:8096
DATA_DIR=/data
TMDB_API_KEY=
TMDB_BEARER_TOKEN=
DOUBAN_API_BASE=
TELEGRAM_BOT_TOKEN=从-BotFather-获取
TELEGRAM_CHAT_ID=接收通知的会话ID
TGBOT_PORT=8099
PUBLIC_TGBOT_URL=http://你的-NAS-IP:8099
TGBOT_WEBHOOK_SECRET=
EMBY_API_KEY=
EMBY_USER_ID=
WEB_PORT=8787
IMAGE=xiaotong378/tfembyweb:latest
```

`EMBY_SERVER_URL` 建议填写 NAS 局域网 IP 或 Emby 容器所在主机 IP，不要在 Docker 桥接网络里使用 `127.0.0.1` 指向宿主机。管理员账户和 Emby 关联信息保存在容器的 `/data` 数据卷里。

求片功能需要配置 `TMDB_API_KEY` 或 `TMDB_BEARER_TOKEN`。用户从 TMDB 搜索电影或剧集后提交申请；管理员可在“管理后台”查看海报、申请用户和 TMDB ID，并将状态更新为待处理、已接收、已入库或已拒绝。申请记录保存在 `/data/requests.json`。

全网热榜优先使用榜单中的 TMDB 海报。缺少海报时会先按片名和年份从 TMDB 补全，再从 `DOUBAN_API_BASE/search` 或豆瓣电影搜索接口兜底；豆瓣图片由 TFEmby Web 代理并缓存，避免浏览器防盗链导致海报无法显示。

### Telegram 通知

部署会同时使用 `xiaotong378/tgbot:1.1.5`。该镜像支持 `amd64` 和 `arm64`，负责 Emby Webhook、备用入库扫描、TMDB/豆瓣补全、封面和 Telegram 入库通知。TFEmby Web 使用相同的 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID` 发送：

- 用户提交新的求片申请：通知中包含 Emby 用户名、影片名称、电影/剧集类型、年份、TMDB ID 和详情链接
- 管理员更新申请状态
- 机器人检测到 Emby 新入库电影或剧集

机器人配置页：

```text
http://NAS-IP:8099
```

管理后台可查看机器人在线状态、测试 TG 通知、启动或停止备用扫描以及立即扫描。`8099` 配置页没有独立登录保护，只建议在 NAS 局域网访问，不要直接暴露到公网。

### 方式一：Docker

创建内部网络并启动机器人：

```bash
docker network create tfemby-net
docker run -d \
  --name tfemby-tgbot \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8099:8099 \
  -v tfemby-tgbot-data:/app/data \
  --env-file .env \
  -e PUBLIC_BASE_URL=http://你的-NAS-IP:8099 \
  xiaotong378/tgbot:1.1.5
```

启动 TFEmby Web：

```bash
docker run -d \
  --name tfemby-web \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  --env-file .env \
  -e TGBOT_URL=http://tfemby-tgbot:8099 \
  xiaotong378/tfembyweb:latest
```

指定 `arm64` 镜像：

```bash
docker run -d \
  --name tfemby-web \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  --env-file .env \
  xiaotong378/tfembyweb:0.1.1-arm64
```

指定 `amd64` 镜像：

```bash
docker run -d \
  --name tfemby-web \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  --env-file .env \
  xiaotong378/tfembyweb:0.1.1-amd64
```

查看日志：

```bash
docker logs -f tfemby-web
```

停止并删除：

```bash
docker rm -f tfemby-web
```

### 方式二：Docker Compose

启动：

```bash
docker compose -f docker-compose.nas.yml up -d
```

该命令会自动拉取并启动 TFEmby Web 与 `xiaotong378/tgbot:1.1.5` 两个容器。

查看日志：

```bash
docker compose -f docker-compose.nas.yml logs -f
```

停止：

```bash
docker compose -f docker-compose.nas.yml down
```

访问：

```text
http://NAS-IP:8787
```

如果 `.env` 中修改了 `WEB_PORT`，访问端口跟随 `WEB_PORT`。

首次打开后：

```text
创建 TFEmby Web 管理员 -> 普通用户使用 Emby 账号登录 -> 自动关联 Emby
```

本地管理员首次登录后，可在左侧账户区域关联自己的 Emby 账户。关联后，“管理后台”会显示 Emby 最近入库的电影和剧集海报。

机器人首次启动后，访问 `http://NAS-IP:8099` 检查 Telegram 与 Emby 配置。使用备用轮询时点击“启动备用轮询”；使用 Emby Webhook 时，将 Emby 通知地址设置为：

```text
http://NAS-IP:8099/webhook/emby
```

如果设置了 `TGBOT_WEBHOOK_SECRET`：

```text
http://NAS-IP:8099/webhook/emby?token=你的密钥
```

### 更新镜像

Docker 方式：

```bash
docker pull xiaotong378/tfembyweb:latest
docker rm -f tfemby-web
docker run -d \
  --name tfemby-web \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  --env-file .env \
  xiaotong378/tfembyweb:latest
```

Docker Compose 方式：

```bash
docker compose -f docker-compose.nas.yml pull
docker compose -f docker-compose.nas.yml up -d
```

## 多架构镜像

镜像支持：

```text
linux/amd64
linux/arm64
```

推送多架构 manifest 以及两个架构独立 tag：

```bash
IMAGE=xiaotong378/tfembyweb VERSION=0.1.1 ./scripts/docker-buildx-push.sh
```

生成的 tag：

```text
xiaotong378/tfembyweb:latest
xiaotong378/tfembyweb:0.1.1
xiaotong378/tfembyweb:0.1.1-amd64
xiaotong378/tfembyweb:0.1.1-arm64
```

本机只构建当前架构：

```bash
./scripts/docker-build-local.sh
```
