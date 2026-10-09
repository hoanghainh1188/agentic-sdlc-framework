# Policy "backup": the AppRole of the backup job (task A10 PR 2, design/ADR-M63 §5, QUESTIONS #328).
# Only the Raft snapshot: the encrypted storage of OpenBao, useless without two key shares.
# No KV, no Transit, no other sys/ path.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
