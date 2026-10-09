#!/bin/sh
# Runs INSIDE the backup-agent container (Compose profile "backup", task A10 PR 2,
# design/ADR-M63 §5): logs in with the AppRole "backup" from its volume and writes OpenBao's Raft
# snapshot to stdout. The snapshot is OpenBao's encrypted storage; backup.sh encrypts it again
# with age before it touches a disk. The token stays in this process and is revoked at the end.
set -eu

[ -s /openbao/approle/role_id ] && [ -s /openbao/approle/secret_id ] ||
  { echo "snapshot: no backup AppRole credentials (pnpm openbao:bootstrap backup-credentials)" >&2; exit 1; }
role_id="$(cat /openbao/approle/role_id)"
BAO_TOKEN="$(bao write -field=token auth/approle/login role_id="$role_id" secret_id=- </openbao/approle/secret_id)" ||
  { echo "snapshot: AppRole login failed (secret ID expired? runbook T11 section 6)" >&2; exit 1; }
export BAO_TOKEN
trap 'bao token revoke -self >/dev/null 2>&1 || true; rm -f /tmp/openbao.snap' EXIT
bao operator raft snapshot save /tmp/openbao.snap >/dev/null
[ -s /tmp/openbao.snap ] || { echo "snapshot: empty snapshot" >&2; exit 1; }
cat /tmp/openbao.snap
