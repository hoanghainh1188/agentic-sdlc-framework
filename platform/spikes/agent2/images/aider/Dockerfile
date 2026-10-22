# syntax=docker/dockerfile:1
# X01 spike (design/ADR-M68): Aider 0.86.2 in the node24 sandbox image. Thrown away after X01.
# Built by platform/spikes/agent2/build.sh with NODE24 = the node24 image by digest.
#
# - Aider needs Python < 3.13; the base has 3.13, so uv installs a pinned CPython 3.12 (from
#   python-build-standalone) under /opt/python, and Aider goes into its own venv.
# - The dependency set is resolved at build time from requirements.in with a fixed cut-off
#   (`--exclude-newer 2026-10-07`, so the same 108 packages every time) and hashes, then installed
#   with `--require-hashes --no-deps`. The lock is not committed: the repository's Trivy scan would
#   block on the 6 CRITICAL findings Aider pins (ADR-M68 §3.3, results/trivy.json); the spike
#   image is never built or shipped by CI.
# - Aider has no server, and the runner's Docker client has no `exec` (ADR-M25): supervisor.mjs
#   (Node.js, port 8000, the run's SESSION_API_KEY) starts, watches and stops it. The base image's
#   Agent Server is not started.
# - Analytics, update checks and release notes are off (image ENV; the sandbox gets no other env).
ARG NODE24
FROM ${NODE24}

USER root
COPY requirements.in /opt/aider/requirements.in
RUN export UV_PYTHON_INSTALL_DIR=/opt/python UV_CACHE_DIR=/tmp/uv-cache \
  && uv python install 3.12.13 \
  && uv pip compile --python-version 3.12 --python-platform linux --generate-hashes \
       --exclude-newer 2026-10-07T00:00:00Z -q /opt/aider/requirements.in -o /opt/aider/requirements.txt \
  && uv venv --python 3.12.13 /opt/aider/venv \
  && uv pip install --python /opt/aider/venv/bin/python --require-hashes --no-deps \
       -r /opt/aider/requirements.txt \
  && ln -s /opt/aider/venv/bin/aider /usr/local/bin/aider \
  && rm -rf /tmp/uv-cache \
  && aider --version | grep -q '^aider 0.86.2$'
ENV AIDER_ANALYTICS_DISABLE=true \
    AIDER_CHECK_UPDATE=false \
    AIDER_SHOW_RELEASE_NOTES=false \
    AIDER_GITIGNORE=false \
    HF_HUB_OFFLINE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True

COPY supervisor.mjs /opt/sdlc/supervisor.mjs
RUN chmod 0644 /opt/sdlc/supervisor.mjs

USER 10001:10001
ENTRYPOINT ["tini", "--", "node", "/opt/sdlc/supervisor.mjs"]
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8000/alive"]
