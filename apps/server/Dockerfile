# syntax=docker/dockerfile:1
# The Grenier server: built and run by Bun, as a non-root user. Built from the root of the
# repository: `docker build -f apps/server/Dockerfile .`

FROM oven/bun:1.4.2-slim AS base
WORKDIR /app
# Only the manifests first, so the dependencies stay cached while the sources change.
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY apps/server/package.json apps/server/
COPY tools/package.json tools/

# Every dependency, the build tools included, to build the server.
FROM base AS build
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/api/src packages/api/src
COPY apps/server apps/server
RUN cd apps/server && bun run build

# The production dependencies of the workspace.
FROM base AS dependencies
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/data/media
WORKDIR /app
COPY --from=dependencies /app ./
COPY packages/api/src packages/api/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/server/dist apps/server/dist
RUN mkdir -p /data/media && chown bun:bun /data/media
USER bun
WORKDIR /app/apps/server
EXPOSE 3000
# The migrations run first; the server listens once they have succeeded.
CMD ["bun", "src/serve.ts"]
