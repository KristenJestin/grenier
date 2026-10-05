# syntax=docker/dockerfile:1
# The Grenier server: TanStack Start built by Vite+, run by Node as a non-root user. Built from the
# root of the repository: `docker build -f apps/server/Dockerfile .`

FROM node:24.21.0-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# Only the manifests first, so the dependencies stay cached while the sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/import/package.json apps/import/

# Every dependency, the build tools included, to build the server.
FROM base AS build
RUN pnpm install --frozen-lockfile --filter=. --filter=@grenier/server...
COPY tsconfig.base.json vite.config.ts ./
COPY packages/core/src packages/core/src
COPY packages/mcp/src packages/mcp/src
COPY apps/server apps/server
RUN pnpm --filter @grenier/server build

# The production dependencies of the server and of the packages it runs.
FROM base AS dependencies
RUN pnpm install --frozen-lockfile --prod --filter=@grenier/server...

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/data/media
WORKDIR /app
COPY --from=dependencies /app ./
COPY packages/core/src packages/core/src
COPY packages/mcp/src packages/mcp/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/server/dist apps/server/dist
RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /app/apps/server
EXPOSE 3000
# The migrations run first; the server listens once they have succeeded.
CMD ["node", "src/serve.ts"]
