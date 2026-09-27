# syntax=docker/dockerfile:1
# Image of the runner process (task C04, design/ADR-M25). Build context: the repo root.
#   docker compose -f platform/deploy/docker-compose.yml --profile sandbox build sdlc-runner
# Multi-stage: the build stage compiles the workspace; the runtime stage holds only the runner,
# its production dependencies and git (the runner clones, never the sandbox: QUESTIONS #52). It
# runs as the non-root user "node", contains no secret and reaches Docker only through the
# socket proxy of the profile "sandbox".

FROM node:24.13.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY platform/apps platform/apps
COPY platform/packages platform/packages
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm exec tsc -b platform/apps/runner \
  && pnpm --filter @sdlc/runner deploy --legacy --prod /out

FROM node:24.13.0-bookworm-slim
# git for the clone; ca-certificates for HTTPS to the Git host.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/sdlc-runner/work \
  && chown node:node /var/lib/sdlc-runner/work \
  && chmod 0700 /var/lib/sdlc-runner/work
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER node
CMD ["node", "/app/dist/main.js"]
