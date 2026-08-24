FROM node:20-alpine AS deps
WORKDIR /app
ARG PNPM_VERSION=10.15.1
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm install --frozen-lockfile=false

FROM node:20-alpine AS build
WORKDIR /app
ARG PNPM_VERSION=10.15.1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm build

FROM node:20-alpine
WORKDIR /app
ARG APP_VERSION=0.3.0
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
ENV TGBOT_URL=http://127.0.0.1:8099
ENV TGBOT_VERSION=1.1.6
ENV WEBHOOK_PORT=8099
ENV HOST=0.0.0.0
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="TFEmby Web"
LABEL org.opencontainers.image.description="Emby media library web UI with integrated Telegram notification bot"
LABEL org.opencontainers.image.version=${APP_VERSION}
LABEL org.opencontainers.image.source="https://github.com/lijingtong666/TFEmby-web"
LABEL io.tfemby.tgbot.version="1.1.6"
RUN apk add --no-cache python3
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/tgbot ./tgbot
COPY --from=build /app/scripts/start-container.sh ./scripts/start-container.sh
RUN chmod +x /app/scripts/start-container.sh
VOLUME ["/data", "/app/tgbot/data"]
EXPOSE 8787 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3).read(); urllib.request.urlopen('http://127.0.0.1:8099/api/status', timeout=3).read()"
CMD ["/app/scripts/start-container.sh"]
