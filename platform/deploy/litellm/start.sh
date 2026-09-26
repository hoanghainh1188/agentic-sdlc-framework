#!/bin/sh
# Start-up of LiteLLM (task C03, design/ADR-M24 section 2.1).
#
# - Compose profile "models" (the server): the OpenBao Agent sidecar has rendered
#   /run/litellm/config.yaml, with the provider keys, the master key and the salt key from
#   OpenBao. LiteLLM uses it, and the development keys from .env are dropped.
# - Without the profile (development only): config.yaml, with no models; the master key and the
#   salt key come from .env. LiteLLM refuses to start without a master key.
set -eu

rendered=/run/litellm/config.yaml

if [ -s "$rendered" ]; then
  unset LITELLM_MASTER_KEY LITELLM_SALT_KEY
  exec litellm --config "$rendered" "$@"
fi

if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "litellm: no rendered configuration (Compose profile models) and no LITELLM_MASTER_KEY" >&2
  echo "litellm: set LITELLM_MASTER_KEY in .env (development only) or start with --profile models" >&2
  exit 1
fi
exec litellm --config /app/config.yaml "$@"
