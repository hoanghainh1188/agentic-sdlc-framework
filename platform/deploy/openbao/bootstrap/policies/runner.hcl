# AppRole "runner" (D-03 sections 8 and 8.2). Its own secrets and the GitHub App key; verifies
# Run Contracts. It can NOT read the LiteLLM master key or model provider keys, and it can NOT
# sign. The GitHub App key never enters a sandbox: the sandbox gets only a short-lived,
# single-repo token (task C04, design/ADR-M19).
path "kv/data/runner/*" {
  capabilities = ["read"]
}

path "kv/data/shared/github-app" {
  capabilities = ["read"]
}

path "transit/verify/run-contract" {
  capabilities = ["update"]
}

# Public key only.
path "transit/keys/run-contract" {
  capabilities = ["read"]
}
