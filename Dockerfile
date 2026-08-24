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
ARG APP_VERSION=0.1.1
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="TFEmby Web"
LABEL org.opencontainers.image.description="Emby media library web UI with TMDB and Douban charts"
LABEL org.opencontainers.image.version=${APP_VERSION}
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
