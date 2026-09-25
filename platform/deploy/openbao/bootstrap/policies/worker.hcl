# AppRole "worker" (D-03 sections 8 and 8.2). Its own secrets; signs Run Contracts with the
# Transit key. The key never leaves OpenBao: no export, backup, rotation or deletion.
path "kv/data/worker/*" {
  capabilities = ["read"]
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
