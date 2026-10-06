# syntax=docker/dockerfile:1
# The Grenier server, run by Bun from its sources (no build step), as a non-root user. Built from
# the root of the repository: `docker build -f apps/server/Dockerfile .`

FROM oven/bun:1.4.2-slim AS base
WORKDIR /app
# Only the manifests first, so the dependencies stay cached while the sources change.
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY apps/server/package.json apps/server/
COPY tools/package.json tools/

# The production dependencies of the workspace.
FROM base AS dependencies
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/data/media
WORKDIR /app
COPY --from=dependencies /app ./
COPY packages/api/src packages/api/src
COPY apps/server/src apps/server/src
RUN mkdir -p /data/media && chown bun:bun /data/media
USER bun
WORKDIR /app/apps/server
EXPOSE 3000
# The migrations run first; the server listens once they have succeeded.
CMD ["bun", "src/serve.ts"]
