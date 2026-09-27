# syntax=docker/dockerfile:1
# Image of the worker process (task B06, design/ADR-M27 section 2.5). Build context: the repo root.
#   docker compose -f platform/deploy/docker-compose.yml --profile platform build sdlc-worker
# Multi-stage: the build stage compiles the workspace; the runtime stage holds only the worker and its
# production dependencies, runs as the non-root user "node" and contains no secret.

FROM node:24.13.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY platform/apps platform/apps
COPY platform/packages platform/packages
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm exec tsc -b platform/apps/worker \
  && pnpm --filter @sdlc/worker deploy --legacy --prod /out

FROM node:24.13.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER node
CMD ["node", "/app/dist/main.js"]
