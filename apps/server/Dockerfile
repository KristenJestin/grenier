# syntax=docker/dockerfile:1
# The Grenier server, run by Bun from its sources (no build step), as a non-root user. Built from
# the root of the repository: `docker build -f apps/server/Dockerfile .`, with its version and
# commit as build arguments (`--build-arg GRENIER_VERSION=1.4.0 --build-arg GRENIER_COMMIT=$(git
# rev-parse --short HEAD)`); both are `unknown` when not given.

FROM oven/bun:1.4.2-slim AS base
WORKDIR /app
# Only the manifests first, so the dependencies stay cached while the sources change.
COPY package.json bun.lock ./
COPY packages/api/package.json packages/api/
COPY apps/server/package.json apps/server/
COPY tools/package.json tools/

# The production dependencies of the workspace. Optional peers are left out: Bun would otherwise
# bring the test runner, an optional peer of Better Auth that the workspace holds for its tests.
FROM base AS dependencies
RUN bun install --frozen-lockfile --production --omit=peer

FROM oven/bun:1.4.2-slim
ARG GRENIER_VERSION=unknown
ARG GRENIER_COMMIT=unknown
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/data/media \
    GRENIER_VERSION=${GRENIER_VERSION} GRENIER_COMMIT=${GRENIER_COMMIT}
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
