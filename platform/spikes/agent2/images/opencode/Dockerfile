# syntax=docker/dockerfile:1
# X01 spike (design/ADR-M68): OpenCode 1.18.35 in the node24 sandbox image. Thrown away after X01.
# Built by platform/spikes/agent2/build.sh with NODE24 = the node24 image by digest.
#
# - The binary comes from the npm platform package (a single Bun-compiled executable), checked
#   against the registry's sha512 integrity for this exact version.
# - ripgrep from Debian: OpenCode downloads one at run time when none is on PATH, and the sandbox
#   has no way out.
# - entry.sh maps the runner's SESSION_API_KEY to OpenCode's server password and starts
#   `opencode serve` on port 8000, like the Agent Server (ADR-M29 §2.3). The model key never comes
#   from the environment: the runner sets it through the server API.
# - Auto-update, model list fetch, LSP downloads, sharing and default plugins are off.
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
  cp /tmp/oc/package/package.json /usr/local/share/opencode-package.json; \
  rm -rf /tmp/oc /tmp/oc.tgz; \
  HOME=/tmp opencode --version | grep -q '^1\.18\.35$'
COPY entry.sh /opt/sdlc/entry.sh
COPY opencode.json /opt/sdlc/opencode.json
RUN chmod 0755 /opt/sdlc/entry.sh && chmod 0644 /opt/sdlc/opencode.json
ENV OPENCODE_CONFIG=/opt/sdlc/opencode.json \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_SHARE=true \
    OPENCODE_DISABLE_TERMINAL_TITLE=true

USER 10001:10001
ENTRYPOINT ["tini", "--", "/opt/sdlc/entry.sh"]
HEALTHCHECK --interval=2s --timeout=3s --start-period=3s --retries=60 \
  CMD ["sh", "-c", "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/doc)\" != 000"]
