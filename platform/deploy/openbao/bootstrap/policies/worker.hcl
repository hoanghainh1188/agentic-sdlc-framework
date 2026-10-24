# AppRole "worker" (D-03 sections 8 and 8.2). Its own secrets; signs Run Contracts with the
# Transit key. The key never leaves OpenBao: no export, backup, rotation or deletion.
path "kv/data/worker/*" {
  capabilities = ["read"]
}

# The GitHub App key: the worker polls GitHub, posts gate status comments and reads spec files
# (D-03 §5.1, B06, B08; QUESTIONS #42).
path "kv/data/shared/github-app" {
  capabilities = ["read"]
}

# Hands the run's GitHub token to the runner as a single-use wrapping token (QUESTIONS #44,
# design/ADR-M25 §2.11). OpenBao's built-in `default` policy allows this for every token too;
# stated here so the handoff keeps working if the default policy is ever tightened.
path "sys/wrapping/wrap" {
  capabilities = ["update"]
}

path "transit/sign/run-contract" {
  capabilities = ["update"]
}

path "transit/verify/run-contract" {
  capabilities = ["update"]
}

# Public key only.
path "transit/keys/run-contract" {
  capabilities = ["read"]
}

# The short-lived database login of a run's `read_documents` tool (X04 PR 3b, ADR-M89, QUESTIONS
# #535, #537, #541): one role per run, `kdocs-<run_id>`, made and deleted by the worker; its only
# grant is the project's read role (the statement is checked in @sdlc/secrets). Never the
# connection, never `rotate-root`, never another role name.
path "database/roles/kdocs-*" {
  capabilities = ["create", "update", "delete"]
}

path "database/creds/kdocs-*" {
  capabilities = ["read"]
}

# Revokes every login of one run at its end or at a kill (`sudo` is what revoke-prefix needs).
path "sys/leases/revoke-prefix/database/creds/kdocs-*" {
  capabilities = ["update", "sudo"]
}
