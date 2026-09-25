#!/bin/sh
# One-shot job: create the S3 buckets in SeaweedFS (task A02).
#   evidence  Evidence Packs and run logs (D-05 section 6.6). No lifecycle rule here:
#             retention is evidence_retention_days in project config (A05, E05).
#   langfuse  Langfuse event and media uploads (observability profile).
# Safe to re-run: existing buckets are kept.
set -eu

: "${SEAWEEDFS_BUCKETS:?}"

tries=0
until echo "cluster.check" | weed shell -master=seaweedfs:9333 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "seaweedfs-init: master not reachable after 120 s" >&2
    exit 1
  fi
  sleep 2
done

existing="$(echo "s3.bucket.list" | weed shell -master=seaweedfs:9333 2>/dev/null || true)"
for bucket in $SEAWEEDFS_BUCKETS; do
  if echo "$existing" | grep -qw "$bucket"; then
    echo "seaweedfs-init: bucket $bucket exists"
  else
    echo "s3.bucket.create -name $bucket" | weed shell -master=seaweedfs:9333
    echo "seaweedfs-init: bucket $bucket created"
  fi
done
