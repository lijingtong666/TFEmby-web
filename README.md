# TG + TMDB + Emby 通知机器人

一个零第三方依赖的本地 Web 管理版 Telegram 通知机器人。它通过 Emby Webhook 获取入库事件，用 TMDB 补充海报、简介、介绍、评分；TMDB 信息不足时可启用豆瓣备用补全，然后推送到 Telegram。

## 启动

本地直接运行：

```bash
python3 app.py
```

打开：

```text
http://127.0.0.1:8099
```

## Docker 部署

直接使用 Docker Hub 镜像：

```bash
docker run -d \
  --name tg-emby-notify \
  --restart unless-stopped \
  -p 8099:8099 \
  -v "$(pwd)/data:/app/data" \
  xiaotong378/tgbot:latest
```

构建并运行默认 Alpine 镜像：

```bash
docker build -t tg-emby-notify:alpine .
docker run -d \
  --name tg-emby-notify \
  --restart unless-stopped \
  -p 8099:8099 \
  -v "$(pwd)/data:/app/data" \
  tg-emby-notify:alpine
```

打开：

```text
http://服务器IP:8099
```

构建 Slim 备用镜像：

```bash
docker build --target runtime-slim -t tg-emby-notify:slim .
```

## Docker Compose 部署

使用 Docker Hub 镜像：

```bash
docker compose -f docker-compose.hub.yml up -d
```

也可以像下面这样直接用环境变量配置，不需要先进入 Web UI：

```yaml
services:
  tg-emby-notify:
    image: xiaotong378/tgbot:latest
    container_name: tg-emby-notify
    restart: unless-stopped
    environment:
      HOST: 0.0.0.0
      PORT: 8099
      TELEGRAM_BOT_TOKEN: "你的 Telegram Bot Token"
      TELEGRAM_CHAT_ID: "123456789,-1001234567890"
      TMDB_API_KEY: "你的 TMDB API Key"
      EMBY_SERVER_URL: "http://192.168.1.51:8096"
      EMBY_API_KEY: "你的 Emby API Key"
      WEBHOOK_HOST: "192.168.1.51"
      WEBHOOK_PORT: 8099
      EMBY_MONITOR_EVENTS: "library.new,item.added,item.created,itemadded"
      ENABLE_COVERS: "true"
      OVERVIEW_MAX_LENGTH: 300
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      NO_PROXY: "localhost,127.0.0.0/8,10.0.0.0/8,172.0.0.0/8,192.168.0.0/16"
      TZ: Asia/Shanghai
    ports:
      - "8099:8099"
    volumes:
      - ./data:/app/data
```

`TELEGRAM_CHAT_ID` 支持逗号分隔的多个会话 ID。环境变量会在容器启动时同步到 `data/config.json`，之后也可以继续在 Web UI 里改。

Telegram 机器人菜单会自动注册以下命令：

- `/recent`：查看最近 10 条入库影视
- `/start`：显示机器人功能
- `/help`：显示使用说明

只有 Web UI 或环境变量中配置的 `TELEGRAM_CHAT_ID` 可以使用这些命令。最近入库列表读取当前容器挂载的 `data/state.json`，升级时请保留 `data` 挂载目录。

本地构建后运行：

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## 多平台镜像

项目提供两种镜像目标：

- `runtime-alpine`：默认小体积镜像，标签 `xiaotong378/tgbot:latest`、`xiaotong378/tgbot:alpine`
- `runtime-slim`：Debian Slim 备用镜像，标签 `xiaotong378/tgbot:slim`

使用 Docker Buildx 一次构建多平台镜像：

```bash
docker buildx create --use
REGISTRY_IMAGE=你的镜像仓库/tg-emby-notify docker buildx bake -f docker-bake.hcl \
  --provenance=false \
  --sbom=false \
  --set "*.platform=linux/amd64,linux/arm64" \
  --set "*.output=type=registry"
```

发布时可通过 `VERSION` 指定版本标签，例如：

```bash
REGISTRY_IMAGE=xiaotong378/tgbot VERSION=1.1.6 docker buildx bake -f docker-bake.hcl \
  --provenance=false \
  --sbom=false \
  --set "*.output=type=registry"
```

需要回退时，将 Compose 中的镜像改为固定版本后重新创建容器：

```yaml
image: xiaotong378/tgbot:1.1.5
```

只在本机测试多平台配置：

```bash
docker buildx bake --set "*.output=type=docker"
```

## 需要填写

- Telegram Bot Token
- Telegram Chat ID
- TMDB API Key
- Emby URL
- Emby API Key
- Emby User ID 可选；如果不填，会尝试使用 Emby 全局最新项目接口
- 对外访问地址可选；Docker/局域网部署时建议填写 `http://服务器IP:8099`
- Webhook 密钥可选；填写后 Emby Webhook URL 需要带 `?token=你的密钥`
- 网络代理可选，支持 HTTP/HTTPS 代理 URL，例如 `http://127.0.0.1:7890`
- 豆瓣备用补全可选

## Emby Webhook

在 Emby Webhook 插件里创建一个 Webhook：

- Method: `POST`
- Content type: `application/json`
- URL: 页面里显示的 `http://你的机器:8099/webhook/emby`

推荐 Body 模板：

```json
{
  "event": "{Event}",
  "item_id": "{ItemId}",
  "item_name": "{ItemName}",
  "item_type": "{ItemType}",
  "series_name": "{SeriesName}",
  "date_added": "{ItemDateAdded}",
  "timestamp": "{Timestamp}"
}
```

如果你的 Emby Webhook 插件变量名不同，也可以直接发送包含项目字段的 JSON；服务端会兼容 `ItemId`、`ItemID`、`item_id`、`Name`、`ItemName`、`Type`、`ItemType` 等常见字段。

入库事件名默认兼容 `library.new`、`item.added`、`item.created`、`itemadded`。如果你的 Emby Webhook 插件事件名不同，可以在 Web UI 的“入库事件名”里追加，或用 `EMBY_MONITOR_EVENTS` 环境变量配置。

如果页面复制出来的是 `127.0.0.1`，不要直接填到 Emby，除非 Emby 和机器人在同一个容器/同一台主机网络命名空间里。通常应该在“对外访问地址”填写机器人服务器的局域网 IP，例如：

```text
http://192.168.1.50:8099
```

排错时可以直接打开：

```text
http://服务器IP:8099/webhook/emby
```

能看到 JSON 提示就说明地址可达；真正入库通知必须由 Emby 用 `POST application/json` 调用。

## 说明

- 配置保存在 `data/config.json`
- 已通知项目保存在 `data/state.json`
- Webhook 是主路径；备用轮询/立即扫描保留用于调试或没有安装 Webhook 插件的场景
- 默认第一次备用扫描只记录现有最新项目，避免刷屏；可在页面打开“首次扫描也推送”
- Telegram 优先发送带海报的 `sendPhoto`，没有海报时发送纯文本消息
- Telegram 内容包含入库时间、入库剧集或电影名称、简介和介绍
