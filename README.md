# TFEmby Web

Emby 影视库 Web UI，支持片库搜索、继续观看、播放历史、最近入库、TMDB/豆瓣榜单、TMDB 求片申请和原生 Telegram 通知。

## NAS 部署

项目文件和默认配置都随 Docker 镜像发布。用户只需要部署一个 `xiaotong378/tfembyweb:latest` 容器，不需要创建或编辑 `.env`，也不需要部署其他 TG 机器人项目。

首次访问网页时创建管理员账户，再进入“管理后台”配置 Emby、TMDB、豆瓣和 Telegram。普通用户之后可以直接使用 Emby 账户登录并自动关联。

镜像支持 `linux/amd64` 和 `linux/arm64`，Docker 会根据 NAS CPU 自动选择架构。

### Web UI 配置

管理员账户、系统设置、Telegram 设置、入库记录和 Emby 关联信息都保存在 `/data` 数据卷中。管理后台可以设置：

- 项目名称和 Emby 服务器地址
- TMDB API Key、Bearer Token、语言和豆瓣数据源
- Telegram Bot Token、Chat ID 和 API 地址
- Telegram 菜单用户 ID 白名单（管理员 Chat ID 默认可用）
- 仅供 Telegram 与 TMDB 使用的 HTTP/HTTPS 代理
- Emby API Key、Webhook 密钥、监听事件、扫描周期和媒体类型
- 通知封面、简介长度、豆瓣兜底和首次扫描通知

`Emby 服务器地址` 建议填写 NAS 局域网 IP 或 Emby 容器所在主机 IP，不要使用 `127.0.0.1` 指向宿主机。

### Telegram 通知

Telegram 通知由 TFEmby Web 自己的 Node 服务直接完成，没有外部机器人镜像或独立机器人进程。支持：

- Emby 新入库电影和剧集通知
- 同批新增剧集合并为季集范围，例如 `S01E01-E16（共 16 集）`
- TMDB 海报，缺失时使用豆瓣或 Emby 海报
- TMDB ID、评分、题材、地区、质量、总大小、年份和入库时间
- 剧情简介、内容分级、别名和 TMDB 详情链接
- 用户求片申请和管理员处理状态通知
- `/recent` 最近入库和 `/help` 帮助菜单
- `/search` 搜索 Emby 片库是否存在，支持片名或 TMDB ID
- `/request` 用户求片，支持片名或 TMDB ID、影片选择和按季申请
- Webhook 与备用定时扫描

剧集支持按季求片。系统会读取 Emby 已有季度并显示“库中存在”，缺少的季度可单独提交。求片通知会包含提交用户、影片名称、电影或剧集类型、申请季度、年份、TMDB ID 和详情链接。

### Emby Webhook

在 Emby 通知设置中填写：

```text
http://NAS-IP:8787/webhook/emby
```

如果在管理后台设置了 Webhook 密钥：

```text
http://NAS-IP:8787/webhook/emby?token=你的密钥
```

Webhook 配置：

- 名称：`TFEmby Web`
- 请求内容类型：`application/json`
- 入库通知事件：`新增媒体 / Item Added`
- 播放通知事件：`播放开始 / Playback Start`

播放开始通知包含 Emby 用户、影片名称、播放设备与客户端、IP 地址、日期时间，并在可用时发送封面和剧情简介。

### Docker

```bash
docker run -d \
  --name tfemby-web \
  --restart unless-stopped \
  -p 8787:8787 \
  -v tfemby-web-data:/data \
  xiaotong378/tfembyweb:latest
```

访问：

```text
http://NAS-IP:8787
```

查看日志：

```bash
docker logs -f tfemby-web
```

### Docker Compose

`docker-compose.yml`：

```yaml
name: tfemby-web

services:
  tfemby-web:
    image: xiaotong378/tfembyweb:latest
    container_name: tfemby-web
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
      - DATA_DIR=/data
    volumes:
      - tfemby-web-data:/data
    restart: unless-stopped

volumes:
  tfemby-web-data:
```

启动：

```bash
docker compose pull
docker compose up -d
```

从旧版双容器部署升级时：

```bash
docker compose down --remove-orphans
docker compose pull
docker compose up -d
```

`down --remove-orphans` 不会删除 Web 数据卷。升级后请在管理后台确认一次 Emby API Key 和通知高级设置。

停止：

```bash
docker compose down
```

## 多架构镜像

发布唯一的多架构 `latest`：

```bash
IMAGE=xiaotong378/tfembyweb VERSION=0.6.3 ./scripts/docker-buildx-push.sh
```

镜像平台：

```text
linux/amd64
linux/arm64
```
