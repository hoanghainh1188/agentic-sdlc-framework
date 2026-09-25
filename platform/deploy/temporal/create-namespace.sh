#!/bin/sh
# One-shot job: wait for the Temporal frontend, then create the namespace (task A02).
# Retention of closed workflows comes from .env (TEMPORAL_NAMESPACE_RETENTION).
# It is unrelated to audit retention, which lives in the platform database.
set -eu

: "${TEMPORAL_ADDRESS:?}" "${TEMPORAL_NAMESPACE:?}" "${TEMPORAL_NAMESPACE_RETENTION:?}"

tries=0
until temporal operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "temporal-namespace: frontend not healthy after 120 s" >&2
    exit 1
  fi
  sleep 2
done

if temporal operator namespace describe --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
  temporal operator namespace update --address "$TEMPORAL_ADDRESS" \
    --namespace "$TEMPORAL_NAMESPACE" --retention "$TEMPORAL_NAMESPACE_RETENTION"
  echo "temporal-namespace: $TEMPORAL_NAMESPACE updated"
else
  temporal operator namespace create --address "$TEMPORAL_ADDRESS" \
    --namespace "$TEMPORAL_NAMESPACE" --retention "$TEMPORAL_NAMESPACE_RETENTION"
  echo "temporal-namespace: $TEMPORAL_NAMESPACE created"
fi
