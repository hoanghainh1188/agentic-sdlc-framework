#!/bin/sh
# Start-up of the OpenTelemetry Collector (task A08, design/ADR-M35 §2.4).
# Builds the Basic authorization of the Langfuse project from its public and secret key (the
# collector's core distribution has no basicauth extension) and keeps it in this process only:
# never written to a file or printed.
set -eu

: "${LANGFUSE_PUBLIC_KEY:?LANGFUSE_PUBLIC_KEY is required}"
: "${LANGFUSE_SECRET_KEY:?LANGFUSE_SECRET_KEY is required}"
LANGFUSE_OTLP_AUTH="$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
# No pipefail in busybox sh: refuse to start without an authorization instead of sending 401s.
[ -n "$LANGFUSE_OTLP_AUTH" ] || { echo "otel-collector: cannot build the Langfuse authorization" >&2; exit 1; }
export LANGFUSE_OTLP_AUTH
unset LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY

exec /otelcol --config /etc/otelcol/config.yaml
