#!/bin/sh
# One-shot job: create the S3 buckets in SeaweedFS (task A02).
#   evidence  Evidence Packs and run logs (D-05 section 6.6). No lifecycle rule here:
#             retention is evidence_retention_days in project config (A05, E05).
#   langfuse  Langfuse event and media uploads (observability profile).
# Buckets in SEAWEEDFS_VERSIONED_BUCKETS get versioning (C06 session 2b, design/ADR-M33 §2.9):
# a delete by the runner's write-only identity leaves a delete marker and keeps the versions.
# Buckets in SEAWEEDFS_LOCKED_BUCKETS (`<bucket>:<GOVERNANCE|COMPLIANCE>:<days>`) get object lock
# with that default retention (task E05, design/ADR-M51): every new version is locked; a locked
# version cannot be deleted through S3 (GOVERNANCE: only an identity with
# BypassGovernanceRetention may). SeaweedFS 4.48 enables the lock on an existing versioned bucket
# (checked live), so the existing bucket `evidence` keeps its name. A locked bucket cannot leave
# versioning or the lock again.
# Runs in the network namespace of the seaweedfs container (A12, design/ADR-M52): the master and the
# filer listen on 127.0.0.1 only, so every address here is 127.0.0.1.
# Safe to re-run: existing buckets are kept; enabling versioning or the lock again changes nothing.
set -eu

: "${SEAWEEDFS_BUCKETS:?}"

tries=0
until echo "cluster.check" | weed shell -master=127.0.0.1:9333 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "seaweedfs-init: master not reachable after 120 s" >&2
    exit 1
  fi
  sleep 2
done

existing="$(echo "s3.bucket.list" | weed shell -master=127.0.0.1:9333 2>/dev/null || true)"
for bucket in $SEAWEEDFS_BUCKETS; do
  if echo "$existing" | grep -qw "$bucket"; then
    echo "seaweedfs-init: bucket $bucket exists"
  else
    echo "s3.bucket.create -name $bucket" | weed shell -master=127.0.0.1:9333
    echo "seaweedfs-init: bucket $bucket created"
  fi
done

for bucket in ${SEAWEEDFS_VERSIONED_BUCKETS:-}; do
  echo "s3.bucket.versioning -name $bucket -enable" | weed shell -master=127.0.0.1:9333 >/dev/null
  state="$(echo "s3.bucket.versioning -name $bucket" | weed shell -master=127.0.0.1:9333 2>/dev/null)"
  case "$state" in
    *'Versioning: Enabled'*) echo "seaweedfs-init: bucket $bucket versioned" ;;
    *)
      echo "seaweedfs-init: versioning of bucket $bucket could not be enabled" >&2
      exit 1
      ;;
  esac
done


# Object lock with a default retention (E05, ADR-M51). `s3.bucket.lock -enable` turns the lock on
# (irreversible); the default retention goes through the S3 API (PutObjectLockConfiguration),
# signed with the admin identity, whose keys reach curl on stdin (`-K -`), never as arguments.
s3_admin() {
  printf 'user = "%s:%s"\n' "$SEAWEEDFS_S3_ACCESS_KEY" "$SEAWEEDFS_S3_SECRET_KEY" |
    curl -sS -f -K - --aws-sigv4 "aws:amz:us-east-1:s3" "$@"
}
for entry in ${SEAWEEDFS_LOCKED_BUCKETS:-}; do
  : "${SEAWEEDFS_S3_ACCESS_KEY:?}" "${SEAWEEDFS_S3_SECRET_KEY:?}"
  bucket="${entry%%:*}"
  rest="${entry#*:}"
  mode="${rest%%:*}"
  days="${rest#*:}"
  case "$mode:$days" in
    GOVERNANCE:[1-9]* | COMPLIANCE:[1-9]*) ;;
    *)
      echo "seaweedfs-init: bad lock setting $entry (bucket:GOVERNANCE|COMPLIANCE:days)" >&2
      exit 1
      ;;
  esac
  echo "s3.bucket.lock -name $bucket -enable" | weed shell -master=127.0.0.1:9333 >/dev/null
  body="<ObjectLockConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>$mode</Mode><Days>$days</Days></DefaultRetention></Rule></ObjectLockConfiguration>"
  md5="$(printf '%s' "$body" | md5sum | cut -d' ' -f1 | xxd -r -p | base64)"
  s3_admin -X PUT -H "Content-MD5: $md5" -H 'Content-Type: application/xml' --data-binary "$body" \
    "http://127.0.0.1:8333/$bucket?object-lock" -o /dev/null ||
    { echo "seaweedfs-init: the lock of bucket $bucket could not be set" >&2; exit 1; }
  state="$(s3_admin "http://127.0.0.1:8333/$bucket?object-lock" 2>/dev/null || true)"
  case "$state" in
    *"<Mode>$mode</Mode><Days>$days</Days>"*) echo "seaweedfs-init: bucket $bucket locked ($mode, $days days)" ;;
    *)
      echo "seaweedfs-init: the lock of bucket $bucket could not be checked" >&2
      exit 1
      ;;
  esac
done
