# TFEmby Web

Emby 影视库 Web UI，支持片库搜索、继续观看、播放历史、最近入库、TMDB/豆瓣榜单、TMDB 求片申请和 Telegram 通知。

## NAS 部署

TFEmby Web 的主要程序文件和默认配置都随 Docker 镜像发布，用户只需要部署容器，不需要创建或编辑 `.env`。首次访问网页时创建管理员账户，再进入“管理后台”配置 Emby、TMDB、豆瓣、Telegram 和 TG 机器人；普通用户之后可以直接使用 Emby 账户登录并自动关联。

镜像 tag 默认使用多架构 `latest`，Docker 会根据 NAS CPU 自动拉取 `amd64` 或 `arm64`。

### Web UI 配置

管理员账户、系统设置和 Emby 关联信息都保存在容器的 `/data` 数据卷里。管理后台可以设置：

- 项目名称和 Emby 服务器地址
- TMDB API Key、Bearer Token、语言和豆瓣数据源
- Telegram Bot Token、Chat ID 和 API 地址
- Emby API Key、Webhook 密钥、监听事件、扫描周期和媒体类型
- 封面、豆瓣兜底、首次扫描通知和代理

`Emby 服务器地址` 建议填写 NAS 局域网 IP 或 Emby 容器所在主机 IP，不要在 Docker 桥接网络里使用 `127.0.0.1` 指向宿主机。

求片功能需要在管理后台配置 TMDB API Key 或 Bearer Token。用户从 TMDB 搜索电影或剧集后提交申请；管理员可查看海报、申请用户和 TMDB ID，并将状态更新为待处理、已接收、已入库或已拒绝。申请记录保存在 `/data/requests.json`。

全网热榜优先使用榜单中的 TMDB 海报。缺少海报时会先按片名和年份从 TMDB 补全，再从管理后台设置的豆瓣 API 或豆瓣电影搜索接口兜底；豆瓣图片由 TFEmby Web 代理并缓存，避免浏览器防盗链导致海报无法显示。

### Telegram 通知

项目已内置 [TGBot](https://github.com/lijingtong666/TGBot) `v1.1.6` 源码，位于 `tgbot/`。Web 服务和机器人服务使用同一个 `xiaotong378/tfembyweb:latest` 镜像，以两个独立容器运行；机器人负责 Emby Webhook、备用入库扫描、TMDB/豆瓣补全、封面、Telegram 入库通知和 `/recent` 最近入库菜单。管理后台会把共用配置同步给机器人，用于发送：

- 用户提交新的求片申请：通知中包含 Emby 用户名、影片名称、电影/剧集类型、年份、TMDB ID 和详情链接
- 管理员更新申请状态
- 机器人检测到 Emby 新入库电影或剧集

机器人原始配置页仍可通过以下地址访问，但日常设置直接在 TFEmby Web 管理后台完成：

```text
http://NAS-IP:8099
```

管理后台可保存机器人全部设置、执行连接测试、查看在线状态、启动或停止备用扫描以及立即扫描。`8099` 配置页没有独立登录保护，只建议在 NAS 局域网访问，不要直接暴露到公网。

### 方式一：Docker

创建内部网络并启动机器人：

```bash
docker network create tfemby-net
docker run -d \
  --name tfemby-tgbot \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8099:8099 \
  -v tfemby-tgbot-data:/app/tgbot/data \
  -e APP_VERSION=1.1.6 \
  -e HOST=0.0.0.0 \
  -e PORT=8099 \
  xiaotong378/tfembyweb:latest \
  python3 /app/tgbot/app.py
```

启动 TFEmby Web：

```bash
docker run -d \
  --name tfemby-web \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  -e TGBOT_URL=http://tfemby-tgbot:8099 \
  xiaotong378/tfembyweb:latest
```

`latest` 是多架构镜像，Docker 会自动选择 `linux/amd64` 或 `linux/arm64`。

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

该命令只需拉取一次 `xiaotong378/tfembyweb:latest`，然后分别启动 Web 与内置机器人两个容器。

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

首次打开后：

```text
创建 TFEmby Web 管理员 -> 管理后台完成系统设置 -> 普通用户使用 Emby 账号登录 -> 自动关联 Emby
```

本地管理员首次登录后，可在左侧账户区域关联自己的 Emby 账户。关联后，“管理后台”会显示 Emby 最近入库的电影和剧集海报。

机器人首次启动后，在 TFEmby Web 管理后台检查 Telegram 与 Emby 配置。使用备用轮询时点击“启动扫描”；使用 Emby Webhook 时，将 Emby 通知地址设置为：

```text
http://NAS-IP:8099/webhook/emby
```

如果在管理后台设置了 Webhook 密钥：

```text
http://NAS-IP:8099/webhook/emby?token=你的密钥
```

### 更新镜像

Docker 方式：

```bash
docker pull xiaotong378/tfembyweb:latest
docker rm -f tfemby-web tfemby-tgbot
docker network create tfemby-net
docker run -d \
  --name tfemby-tgbot \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8099:8099 \
  -v tfemby-tgbot-data:/app/tgbot/data \
  -e APP_VERSION=1.1.6 \
  -e HOST=0.0.0.0 \
  -e PORT=8099 \
  xiaotong378/tfembyweb:latest \
  python3 /app/tgbot/app.py
docker run -d \
  --name tfemby-web \
  --network tfemby-net \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  -e TGBOT_URL=http://tfemby-tgbot:8099 \
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

推送包含两个架构的 `latest`：

```bash
IMAGE=xiaotong378/tfembyweb VERSION=0.2.1 ./scripts/docker-buildx-push.sh
```

生成的 tag：

```text
xiaotong378/tfembyweb:latest
```

本机只构建当前架构：

```bash
./scripts/docker-build-local.sh
```
