# syntax=docker/dockerfile:1
# Sandbox image "node24" (task C04, design/ADR-M25 §2.9, QUESTIONS #59 option A): the pinned
# OpenHands Agent Server (ADR-M10 §2.1) plus the toolchain of Node.js projects such as the sample
# repo pilot-order-inventory (Vue + NestJS, D-09 §5). Build and push: platform/sandbox-images/build.sh.
# A project uses it through its configuration, always by digest:
#   sandbox:
#     image: localhost:5000/sdlc/sandbox-node24@sha256:<digest printed by build.sh>
#
# Image contract (ADR-M25 §2.3): /workspace owned by 10001:10001, a HEALTHCHECK that passes when
# the Agent Server is ready, user 10001. The runner adds the hardening (read-only root, no
# capabilities, per-run internal network) and the package proxy address; nothing secret is baked in.
FROM ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7

USER root
# Node.js 24 and corepack come with the pinned base image (Node 24.21.0, corepack 0.36.0 in
# 1.48.0). The build fails if a new base ever ships another Node major.
# - `corepack enable pnpm` installs the pnpm shim. Corepack downloads the pnpm version that a
#   project pins in `packageManager` through COREPACK_NPM_REGISTRY, which the runner sets to the
#   package proxy (Verdaccio) at run time; the sandbox has no other way out.
# - COREPACK_HOME and the npm cache live on the sandbox's tmpfs: the root filesystem is read-only.
# - The base image's empty /workspace/project is removed: the workspace is the repository itself.
# - Chromium and the VS Code server are removed. The browser tool is not allowed at L2 (ADR-M10
#   §4.1) and VS Code is disabled in every sandbox (OH_ENABLE_VSCODE=false, ADR-M25 §2.4). They
#   carried most CRITICAL findings of the base image and most GPL/LGPL packages (Harry,
#   2026-09-27, C04 session 3). Two findings without a fix stay listed in .trivyignore.
# - The Agent Server keeps its own state (conversations, bash events) under the relative path
#   `workspace/…` of its working directory by default. The runner starts the sandbox in
#   /workspace, which is the repository, so the state would show up as changed files. The OH_*
#   paths below move it to the home tmpfs.
RUN node --version | grep -Eq '^v24\.' \
  && dpkg --purge chromium chromium-common \
  && rm -rf /openhands/.openvscode-server \
  && corepack enable pnpm \
  && rm -rf /workspace/project \
  && chown 10001:10001 /workspace \
  && chmod 0755 /workspace
ENV COREPACK_HOME=/tmp/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    OH_CONVERSATIONS_PATH=/home/openhands/.openhands/conversations \
    OH_BASH_EVENTS_DIR=/home/openhands/.openhands/bash_events \
    OH_WORKSPACE_PATH=/workspace \
    CHROME_BIN= \
    PUPPETEER_EXECUTABLE_PATH=

USER 10001:10001
# The Agent Server answers /ready once it can take a conversation (ADR-M10 §2.2: 4.5–6.8 s).
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=60 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8000/ready"]
