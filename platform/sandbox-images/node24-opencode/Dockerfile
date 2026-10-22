# syntax=docker/dockerfile:1
# Sandbox image "node24-opencode" (task X03, design/ADR-M68 §5, ADR-M88 §2.2): the node24 image
# (the Node.js toolchain) plus OpenCode 1.18.35, the second agent. Build it FROM node24 by digest:
#   NODE24=<node24 by digest> platform/sandbox-images/build.sh node24-opencode
# A project uses it through its configuration, always by digest:
#   sandbox:
#     images:
#       opencode: localhost:5000/sdlc/sandbox-node24-opencode@sha256:<digest printed by build.sh>
#
# - The binary comes from the npm platform package (one Bun-compiled executable), checked against
#   the registry's sha512 integrity for this exact version (QUESTIONS #524). The licences of its
#   dependency tree are checked at the same Git tag in CI (licences.mjs), because Trivy cannot see
#   inside the binary.
# - ripgrep from Debian: OpenCode downloads one at run time when none is on PATH, and the sandbox
#   has no way out.
# - entry.sh makes the runner's per-run SESSION_API_KEY the server password and starts
#   `opencode serve` on port 8000, like the Agent Server (ADR-M29 §2.3). The model key never comes
#   from the environment: the adapter sets it through the server API.
# - Auto-update, the models list fetch, LSP downloads, sharing, default plugins and the Claude
#   Code compatibility (reading ~/.claude) are off. The configuration file below allows no
#   provider except LiteLLM and denies web fetches; the adapter sets the rest per run.
ARG NODE24
FROM ${NODE24}

USER root
ARG TARGETARCH
RUN apt-get update -qq \
  && apt-get install -y --no-install-recommends ripgrep=14.1.1-1+b4 \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    arm64) pkg=opencode-linux-arm64; sri='5IgrvyoxQc3altzqsGPM5Aigf/uzC/pMFG2Kt4w8vJEtJKKem4Hl9wEVmsZxMYFZDzyx7e0MuBkOAzt6AD++1A==' ;; \
    amd64) pkg=opencode-linux-x64; sri='xs/DPt8bK6NTWHpOlVJDWC/P3BnAuAQFHwa+mjrbxhDGd0Pi/GGWGjh4Sr4cpv6KwvfUKVoLKfHc/J8Nnz0XMg==' ;; \
    *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/oc.tgz "https://registry.npmjs.org/$pkg/-/$pkg-1.18.35.tgz"; \
  test "$(openssl dgst -sha512 -binary /tmp/oc.tgz | base64 -w0)" = "$sri"; \
  mkdir -p /tmp/oc && tar -xzf /tmp/oc.tgz -C /tmp/oc; \
  install -m 0755 /tmp/oc/package/bin/opencode /usr/local/bin/opencode; \
  rm -rf /tmp/oc /tmp/oc.tgz; \
  test "$(HOME=/tmp opencode --version)" = 1.18.35
COPY --chmod=0755 entry.sh /opt/sdlc/entry.sh
COPY --chmod=0644 opencode.json /opt/sdlc/opencode.json
ENV OPENCODE_CONFIG=/opt/sdlc/opencode.json \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_SHARE=true \
    OPENCODE_DISABLE_TERMINAL_TITLE=true

# ADR-M68 §7: the adapter that drives this image's agent server, and its version. The runner
# refuses a run whose agent names another adapter (`adapter_mismatch`).
LABEL sdlc.agent.adapter=opencode \
      sdlc.agent.version=1.18.35

USER 10001:10001
ENTRYPOINT ["tini", "--", "/opt/sdlc/entry.sh"]
CMD []
# OpenCode answers once it listens; every route needs the password, so any HTTP answer counts.
HEALTHCHECK --interval=2s --timeout=3s --start-period=3s --retries=60 \
  CMD ["sh", "-c", "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/global/health)\" != 000"]
